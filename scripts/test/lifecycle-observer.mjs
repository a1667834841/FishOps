/**
 * 只读生命周期观察器（chrome-lifecycle 专项）。
 *
 * 目的：在真实已安装部署上观察 native host 的「在线 → 离线 → 恢复」三阶段，
 * 并验证恢复后 baseline 已入库事件的 seq 仍在历史中、账号没有切换。
 *
 * 硬性边界：
 * - 只做 loopback HTTP 轮询（system.status / events.list），不发起任何闲鱼平台请求；
 * - 只读：不停止 Service Worker、不操作浏览器、不改注册、不读写 cookie；
 * - 账号与 token 只在内存中比较 / 鉴权，绝不写入报告或日志；
 * - 未知异常归一为固定分类字符串，不记录可能含 token 的原始 message。
 *
 * 「离线」只认连接拒绝（ECONNREFUSED）。401、403、非法 JSON、结构非法、
 * EXTENSION_OFFLINE 等都不算离线：否则鉴权或协议故障会被伪装成生命周期通过。
 */
import { execFileSync } from 'node:child_process'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'
import { isCursor } from '../../packages/protocol/src/index.ts'

/** loopback 主机固定值：绝不从配置读取 host，避免把请求发到非本机地址。 */
export const LOOPBACK_HOST = '127.0.0.1'

/** 每个阶段的默认超时（毫秒）：等待人工停止 / 重开浏览器需要较长窗口。 */
export const DEFAULT_PHASE_TIMEOUT_MS = 180_000
/** 默认轮询间隔（毫秒）。 */
export const DEFAULT_POLL_INTERVAL_MS = 1_000
/** 单次 HTTP 请求超时（毫秒）。 */
export const DEFAULT_HTTP_TIMEOUT_MS = 5_000
/** events.list 单页上限（契约范围 1～500）。 */
export const EVENTS_PAGE_LIMIT = 500
/** 历史分页防御上限：超过即明确失败，不静默截断。 */
export const MAX_EVENT_PAGES = 20

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 只保留固定形态的分类串，杜绝把外部文本（可能含凭据）写进报告。 */
function sanitizeReason(value) {
  return typeof value === 'string' && /^[a-z0-9-]{1,64}$/.test(value) ? value : 'unknown'
}

/** 把任意采样结果压缩为可安全记录的阶段描述。 */
function describeSample(sample) {
  if (!isRecord(sample)) return 'unknown'
  if (sample.kind === 'online') return 'online'
  if (sample.kind === 'offline') return 'offline'
  if (sample.kind === 'error') return `error:${sanitizeReason(sample.reason)}`
  return 'unknown'
}

/** 遍历错误链，判断是否为连接拒绝（只有这一种情况算离线）。 */
function isConnectionRefused(error) {
  const seen = new Set()
  const stack = [error]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!isRecord(current) && typeof current !== 'function') continue
    if (seen.has(current)) continue
    seen.add(current)
    if (current.code === 'ECONNREFUSED' || current.errno === 'ECONNREFUSED') return true
    if (current.cause) stack.push(current.cause)
    if (Array.isArray(current.errors)) stack.push(...current.errors)
  }
  return false
}

/** 请求超时 / 主动中止：属于明确失败，不是离线。 */
function isTimeoutLike(error) {
  return isRecord(error) && (error.name === 'AbortError' || error.name === 'TimeoutError')
}

function defaultSleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

/** 校验配置里的 port 并固定 loopback 地址；非法 port 直接拒绝。 */
export function resolveLoopbackBaseUrl(config) {
  const port = isRecord(config) ? config.port : undefined
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'invalid-port' }
  }
  return { baseUrl: `http://${LOOPBACK_HOST}:${port}`, port }
}

/** 只有显式启用 FISHOPS_LIVE_SMOKE=1 才允许读取已安装配置。 */
export function shouldRunLive(env = process.env) {
  return env.FISHOPS_LIVE_SMOKE === '1'
}

/** 读取已安装部署的 config.json；FISHOPS_HOME 优先，与 host 保持一致。 */
export function resolveInstalledHome(env = process.env) {
  return env.FISHOPS_HOME ? resolve(env.FISHOPS_HOME) : join(homedir(), 'Library', 'Application Support', 'FishOps')
}

/**
 * 校验 system.status 响应结构，返回账号标识（仅内存比较用）或错误分类。
 * 结构不符一律报错，不把畸形响应解释为「离线」或「在线」。
 */
function readStatusPayload(body) {
  if (!isRecord(body)) return { error: 'invalid-envelope' }
  if (body.ok !== true) {
    const code = isRecord(body.error) && typeof body.error.code === 'string' ? body.error.code : ''
    if (code === 'EXTENSION_OFFLINE') return { error: 'extension-offline' }
    return { error: 'status-not-ok' }
  }
  const data = body.data
  if (!isRecord(data)) return { error: 'invalid-status' }
  if (!isRecord(data.page) || typeof data.page.present !== 'boolean') return { error: 'invalid-status' }
  if (!('chatReady' in data)) return { error: 'invalid-status' }
  if (data.account !== null) {
    if (!isRecord(data.account) || typeof data.account.userId !== 'string' || data.account.userId.length === 0) {
      return { error: 'invalid-status' }
    }
  }
  // 结构先校验通过，再判定扩展连接；结构残缺不算「扩展离线」。
  if (data.nativeConnected !== true) return { error: 'extension-offline' }
  return { accountId: data.account === null ? null : data.account.userId }
}

/** 校验 events.list 分页结构，返回 seq 列表与游标。 */
function readEventsPayload(body) {
  if (!isRecord(body)) return { error: 'invalid-events-envelope' }
  if (body.ok !== true) return { error: 'events-not-ok' }
  const data = body.data
  if (!isRecord(data) || !Array.isArray(data.items)) return { error: 'invalid-events' }
  const seqs = []
  for (const item of data.items) {
    if (!isRecord(item) || !isCursor(item.seq)) return { error: 'invalid-events' }
    seqs.push(item.seq)
  }
  if (typeof data.hasMore !== 'boolean' || !isCursor(data.nextAfterSeq)) return { error: 'invalid-events' }
  const hasMore = data.hasMore
  const nextAfterSeq = typeof data.nextAfterSeq === 'string' ? data.nextAfterSeq : ''
  if (hasMore && nextAfterSeq.length === 0) return { error: 'invalid-events' }
  return { seqs, hasMore, nextAfterSeq }
}

/**
 * 创建一个只读 HTTP probe。
 *
 * @param {object} options
 * @param {string} options.baseUrl 形如 `http://127.0.0.1:<port>`，由 resolveLoopbackBaseUrl 产出
 * @param {string} options.token Bearer token，只用于请求头，绝不记录
 * @param {typeof fetch} [options.fetchImpl] 测试注入用
 * @param {number} [options.timeoutMs] 单次请求超时
 * @returns {() => Promise<{kind:'online',accountId:string|null,seqs:string[]}|{kind:'offline',reason:string}|{kind:'error',reason:string}>}
 */
export function createHttpProbe(options) {
  const baseUrl = options.baseUrl
  const token = options.token
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS

  /** 发起一次 POST 并分类结果；失败只返回固定分类，不回传原始异常。 */
  async function requestJson(method, params) {
    let response
    try {
      response = await fetchImpl(`${baseUrl}/v1/${method}`, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      if (isConnectionRefused(error)) return { failure: { kind: 'offline', reason: 'connection-refused' } }
      if (isTimeoutLike(error)) return { failure: { kind: 'error', reason: 'http-timeout' } }
      return { failure: { kind: 'error', reason: 'network-error' } }
    }
    if (response.status === 401) return { failure: { kind: 'error', reason: 'unauthorized' } }
    if (response.status === 403) return { failure: { kind: 'error', reason: 'forbidden' } }
    if (!response.ok) return { failure: { kind: 'error', reason: `http-${response.status}` } }
    let body
    try {
      body = await response.json()
    } catch {
      return { failure: { kind: 'error', reason: 'invalid-json' } }
    }
    return { body }
  }

  /** 采集完整 events 历史（分页），用于验证 baseline seq 是否仍在。 */
  async function collectSeqs() {
    const seqs = []
    let afterSeq = '0'
    for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
      const result = await requestJson('events.list', { afterSeq, limit: EVENTS_PAGE_LIMIT })
      if (result.failure) return { failure: result.failure }
      const parsed = readEventsPayload(result.body)
      if (parsed.error) return { failure: { kind: 'error', reason: parsed.error } }
      seqs.push(...parsed.seqs)
      if (!parsed.hasMore) return { seqs }
      if (parsed.nextAfterSeq === afterSeq) return { failure: { kind: 'error', reason: 'invalid-events-cursor' } }
      afterSeq = parsed.nextAfterSeq
    }
    return { failure: { kind: 'error', reason: 'events-page-limit' } }
  }

  return async function sample() {
    const statusResult = await requestJson('system.status', {})
    if (statusResult.failure) return statusResult.failure
    const status = readStatusPayload(statusResult.body)
    if (status.error) return { kind: 'error', reason: status.error }
    const history = await collectSeqs()
    if (history.failure) return history.failure
    return { kind: 'online', accountId: status.accountId ?? null, seqs: history.seqs ?? [] }
  }
}

/** 轮询直到谓词命中或阶段超时；probe 抛错时归一为 error 采样，不携带原始异常。 */
async function waitForSample(probe, predicate, options) {
  const { now, sleep, timeoutMs, pollIntervalMs } = options
  const startedAt = now()
  let attempts = 0
  let sample = { kind: 'error', reason: 'probe-not-run' }
  for (;;) {
    try {
      sample = await probe()
    } catch {
      sample = { kind: 'error', reason: 'probe-failed' }
    }
    attempts += 1
    if (predicate(sample)) return { matched: true, sample, attempts }
    if (now() - startedAt >= timeoutMs) return { matched: false, sample, attempts }
    await sleep(pollIntervalMs)
  }
}

/**
 * 校验调用方显式接入的浏览器关闭/重开动作。
 *
 * 自动门禁不得因为安装了 Ego 就擅自关闭用户浏览器。只有显式提供生命周期触发命令时，
 * 才在 baseline 之后执行一次；命令通过环境变量接收隔离 home 与端口，但不接收 token。
 * 触发器必须自行完成“关闭”和“重新打开”，脚本只观察结果，不把超时当成离线证明。
 */
export function resolveLifecycleTrigger(env = process.env) {
  const raw = env.FISHOPS_LIFECYCLE_TRIGGER
  if (raw === undefined || raw === '') return null
  if (raw.length > 4096 || raw.includes('\0')) throw new Error('生命周期触发命令非法')
  return raw
}

/**
 * 执行只读生命周期观察。
 *
 * 通过条件（缺一不可）：baseline 在线且至少有一条真实事件 → 观察到连接拒绝 → 恢复在线
 * 且 baseline 事件 seq 全部仍在历史中 → 账号未切换。仅两次在线不构成通过。
 *
 * @param {object} options
 * @param {Function} options.probe 返回 LifecycleSample 的函数
 * @param {number} [options.phaseTimeoutMs] 每阶段超时
 * @param {number} [options.pollIntervalMs] 轮询间隔
 * @param {Function} [options.now] 时间源，默认 Date.now
 * @param {Function} [options.sleep] 休眠实现，默认 setTimeout
 * @param {Function} [options.onPhase] 阶段完成回调（CLI 打脱敏进度）
 * @returns {Promise<object>} 脱敏报告（不含账号、token、原始异常）
 */
export async function observeLifecycle(options) {
  const probe = options.probe
  if (typeof probe !== 'function') throw new TypeError('probe 必须是函数')
  const now = options.now ?? (() => Date.now())
  const sleep = options.sleep ?? defaultSleep
  const phaseTimeoutMs = options.phaseTimeoutMs ?? DEFAULT_PHASE_TIMEOUT_MS
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const onPhase = typeof options.onPhase === 'function' ? options.onPhase : null
  const beforeOffline = typeof options.beforeOffline === 'function' ? options.beforeOffline : null
  const startedAt = now()
  const phases = []

  /** 记录一个阶段；只写入分类与计数，不写入账号或原始响应。 */
  function record(phase, outcome, attempts, detail = {}) {
    const entry = { phase, outcome, attempts, elapsedMs: now() - startedAt, ...detail }
    phases.push(entry)
    if (onPhase) onPhase(entry)
    return entry
  }

  /** 组装最终报告。 */
  function finish(status, reason, extra = {}) {
    return { status, reason, phases, durationMs: now() - startedAt, ...extra }
  }

  const baseline = await waitForSample(probe, (sample) => sample.kind === 'online', {
    now,
    sleep,
    timeoutMs: phaseTimeoutMs,
    pollIntervalMs,
  })
  if (!baseline.matched) {
    record('baseline', 'timeout', baseline.attempts, { lastObserved: describeSample(baseline.sample) })
    return finish('failed', 'baseline-timeout')
  }
  record('baseline', 'online', baseline.attempts, { eventCount: baseline.sample.seqs.length })
  // 没有真实历史事件就无法验证「恢复后历史仍在」；这是环境阻碍，不能空集通过。
  if (baseline.sample.seqs.length === 0) {
    return finish('blocked', 'no-baseline-events')
  }

  if (beforeOffline) {
    try {
      const triggered = await beforeOffline()
      if (triggered === false) return finish('blocked', 'lifecycle-trigger-unavailable')
    } catch {
      return finish('blocked', 'lifecycle-trigger-failed')
    }
  }

  const offline = await waitForSample(probe, (sample) => sample.kind === 'offline', {
    now,
    sleep,
    timeoutMs: phaseTimeoutMs,
    pollIntervalMs,
  })
  if (!offline.matched) {
    record('offline', 'timeout', offline.attempts, { lastObserved: describeSample(offline.sample) })
    return finish('failed', 'never-offline')
  }
  record('offline', 'disconnected', offline.attempts, { reason: sanitizeReason(offline.sample.reason) })

  const recovery = await waitForSample(probe, (sample) => sample.kind === 'online', {
    now,
    sleep,
    timeoutMs: phaseTimeoutMs,
    pollIntervalMs,
  })
  if (!recovery.matched) {
    record('recovery', 'timeout', recovery.attempts, { lastObserved: describeSample(recovery.sample) })
    return finish('failed', 'recovery-timeout')
  }

  const baselineSeqs = new Set(baseline.sample.seqs)
  const recoverySeqs = new Set(recovery.sample.seqs)
  const missingEventCount = [...baselineSeqs].filter((seq) => !recoverySeqs.has(seq)).length
  const accountStable = recovery.sample.accountId === baseline.sample.accountId
  record('recovery', 'online', recovery.attempts, {
    eventCount: recovery.sample.seqs.length,
    historyVerified: missingEventCount === 0,
    accountStable,
  })
  if (missingEventCount > 0) {
    return finish('failed', 'history-lost', { baselineEventCount: baselineSeqs.size, missingEventCount, accountStable })
  }
  if (!accountStable) {
    return finish('failed', 'account-changed', { baselineEventCount: baselineSeqs.size, missingEventCount: 0, accountStable })
  }
  return finish('passed', 'lifecycle-verified', {
    baselineEventCount: baselineSeqs.size,
    missingEventCount: 0,
    historyVerified: true,
    accountStable: true,
  })
}

/** 采集来源信息（commit / dirty），失败时降级为 unknown，不阻断观察。 */
function readSource(root) {
  const source = { node: process.version, commit: 'unknown', dirty: null }
  try {
    source.commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    source.dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0
  } catch {
    // 非 git 环境不影响只读观察。
  }
  return source
}

/** CLI 主流程；返回进程退出码。passed=0、failed=1、blocked=2。 */
async function runCli() {
  const root = resolve(import.meta.dirname, '../..')
  const env = process.env
  if (!shouldRunLive(env)) {
    console.error('需要显式设置 FISHOPS_LIVE_SMOKE=1 才读取已安装部署；未执行生命周期观察。')
    return 2
  }
  const home = resolveInstalledHome(env)
  const source = readSource(root)
  let config
  try {
    config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
  } catch {
    console.error('读取已安装 config.json 失败；请确认部署归属与本机路径。')
    return 2
  }
  const target = resolveLoopbackBaseUrl(config)
  if (target.error) {
    console.error('配置中的 port 非法；只允许 1～65535 的整数。')
    return 2
  }
  if (typeof config.token !== 'string' || config.token.length === 0) {
    console.error('配置中的 token 非法；不输出任何凭据。')
    return 2
  }

  let trigger
  try {
    trigger = resolveLifecycleTrigger(env)
  } catch {
    console.error('生命周期触发命令非法；未执行浏览器操作。')
    return 2
  }
  /** 触发命令只在显式配置时执行；环境不传 token，避免子进程读取凭据。 */
  async function runTrigger() {
    if (!trigger) return true
    const child = spawn('/bin/sh', ['-c', trigger], {
      cwd: root,
      env: { ...env, FISHOPS_LIFECYCLE_HOME: home, FISHOPS_LIFECYCLE_PORT: String(target.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', value => { if (output.length < 4096) output += value })
    child.stderr.on('data', value => { if (output.length < 4096) output += value })
    const code = await new Promise(resolve => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        resolve(124)
      }, 60_000)
      child.once('error', () => { clearTimeout(timer); resolve(1) })
      child.once('close', value => { clearTimeout(timer); resolve(value ?? 1) })
    })
    if (code !== 0) {
      process.stderr.write(`[lifecycle] trigger:failed:${code}\n`)
      return false
    }
    return true
  }

  console.error(`观察 ${target.baseUrl}（只读轮询）。请按阶段提示停止 / 重开浏览器。`)
  const report = await observeLifecycle({
    probe: createHttpProbe({ baseUrl: target.baseUrl, token: config.token }),
    beforeOffline: trigger ? runTrigger : undefined,
    onPhase: (entry) => console.error(`[lifecycle] ${entry.phase}:${entry.outcome} @${entry.elapsedMs}ms`),
  })

  const dir = join(root, '.test-results', `chrome-lifecycle-${Date.now()}-${process.pid}`)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const output = {
    ...source,
    at: new Date().toISOString(),
    scope: trigger
      ? '真实已安装部署只读生命周期观察；关闭/重开由显式 FISHOPS_LIFECYCLE_TRIGGER 触发'
      : '真实已安装部署只读生命周期观察；停止或重开浏览器由人工触发，脚本不操作浏览器',
    target: `http://${LOOPBACK_HOST}:${target.port}`,
    notCovered: ['自然休眠时长', '一小时静默观察', '登录退出变化'],
    ...report,
  }
  const reportPath = join(dir, 'report.json')
  await writeFile(reportPath, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ status: report.status, reason: report.reason, phases: report.phases, reportPath }))
  return report.status === 'passed' ? 0 : report.status === 'blocked' ? 2 : 1
}

const isMainModule = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMainModule) {
  process.exitCode = await runCli()
}
