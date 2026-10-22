/** 分层验证：每次生成新报告，不把只读冒烟标成完整生命周期 E2E。 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_ROOT = resolve(import.meta.dirname, '..')
const LIVE_SMOKE_COMMAND = 'test:browser-smoke'
const CHAT_SYNC_STATUS_COMMAND = 'test:chat-sync-status-behavior'
const LIFECYCLE_REASON = '未提供 FISHOPS_LIFECYCLE_TRIGGER，不能自动完成隔离浏览器关闭重开'
const SKIPPED_SMOKE_REASON = '前序本地检查失败，未运行真实只读冒烟；禁止复用旧产物冒充通过'
export const VERIFICATION_MODES = ['verify', 'regression', 'e2e', 'full']

/** 返回指定模式必须先完成的本地检查，真实只读冒烟始终排在这些检查之后。 */
export function getLocalSteps(mode) {
  if (!VERIFICATION_MODES.includes(mode)) throw new Error('验证模式错误')
  if (mode === 'e2e') return ['typecheck', 'test:unit', 'test:integration']
  if (mode === 'full' || mode === 'regression') {
    return ['typecheck', 'test:unit', 'test:integration', 'build', 'test:artifacts', 'test:install']
  }
  return ['typecheck', 'test:unit', 'test:integration']
}

/** 对落盘日志做保守脱敏，避免 Bearer token、cookie 或常见密钥字段泄露。 */
export function redactLog(value) {
  return String(value)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[已脱敏]')
    .replace(/("(?:authorization|token|password|secret|cookie)"\s*:\s*")[^"]*(")/gi, '$1[已脱敏]$2')
    .replace(/\b(authorization|token|password|secret|cookie)=([^\s&]+)/gi, '$1=[已脱敏]')
    .replace(/\b(authorization|token|password|secret|cookie)\s*:\s*(?!Bearer\b)([^\s,}]+)/gi, '$1: [已脱敏]')
}

/**
 * 执行一次分层验证。
 * runCommand 供编排测试注入假命令，默认通过当前 Node 启动 npm run。
 */
export async function runVerification({
  mode,
  env = process.env,
  root = DEFAULT_ROOT,
  resultRoot = join(root, '.test-results'),
  runCommand,
  log = console.log,
  now = () => new Date(),
} = {}) {
  if (!VERIFICATION_MODES.includes(mode)) throw new Error('验证模式错误')

  const dir = join(
    resultRoot,
    `${now().toISOString().replaceAll(':', '-')}-${process.pid}-${randomUUID().slice(0, 8)}`,
  )
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const results = []
  const execute = runCommand ?? ((name, context) => runNpmCommand(name, context))
  // 本地门禁必须使用测试自身创建的隔离目录和默认 host 名，不能继承真实部署验收变量。
  // 真实冒烟则保留调用方显式提供的 FISHOPS_HOME/FISHOPS_EXTENSION_DIST。
  const localEnv = { ...env }
  for (const key of ['FISHOPS_HOST_NAME', 'FISHOPS_HOME', 'FISHOPS_EXTENSION_DIST', 'FISHOPS_NATIVE_MANIFEST_DIR']) delete localEnv[key]
  localEnv.FISHOPS_LIVE_SMOKE = '0'

  for (const name of getLocalSteps(mode)) {
    if (name === 'test:artifacts' && results.some((item) => item.name === 'build' && item.status === 'failed')) {
      results.push({ name, status: 'blocked', reason: '本次构建失败，不使用旧产物验收' })
      continue
    }

    log(`开始：${name}`)
    const started = Date.now()
    const result = await execute(name, { cwd: root, env: localEnv })
    await writeFile(join(dir, `${name.replaceAll(':', '-')}.log`), redactLog(result.output), {
      mode: 0o600,
    })
    results.push({
      name,
      status: result.code === 0 ? 'passed' : 'failed',
      exitCode: result.code,
      durationMs: Date.now() - started,
    })
    log(`${result.code === 0 ? '通过' : '失败'}：${name}`)
  }

  if (mode === 'e2e' || mode === 'full') {
    const localFailure = results.some((item) => item.status === 'failed')
    if (localFailure) {
      results.push({ name: 'chrome-live-smoke', status: 'blocked', reason: SKIPPED_SMOKE_REASON })
    } else if (!env.FISHOPS_HOME || !env.FISHOPS_EXTENSION_DIST) {
      results.push({ name: 'chrome-live-smoke', status: 'blocked', reason: '必须显式指定 FISHOPS_HOME 和 FISHOPS_EXTENSION_DIST；未读取默认部署、未运行真实请求' })
    } else {
      // 显式隔离验收前重新构建并安装同一产物，避免本地 build 更新默认 dist 后让已加载的 SW 身份过期。
      const liveConfigured = Boolean(env.FISHOPS_HOME && env.FISHOPS_EXTENSION_DIST)
      if (liveConfigured) {
        let installedHostName
        let liveEnv = { ...env, FISHOPS_LIVE_SMOKE: '1' }
        try {
          const install = JSON.parse(await readFile(join(env.FISHOPS_HOME, 'install.json'), 'utf8'))
          installedHostName = install.hostName
          if (!env.FISHOPS_NATIVE_MANIFEST_DIR && install.nativeManifestPath) {
            liveEnv = { ...liveEnv, FISHOPS_NATIVE_MANIFEST_DIR: resolve(dirname(install.nativeManifestPath)) }
          }
        } catch {}
        liveEnv = { ...liveEnv, ...(installedHostName ? { FISHOPS_HOST_NAME: installedHostName } : {}) }
        const preparedBuild = await execute('build', { cwd: root, env: liveEnv })
        const preparedInstall = preparedBuild.code === 0
          ? await execute('host:install', { cwd: root, env: liveEnv })
          : { code: 1, output: '隔离部署构建失败' }
        if (preparedBuild.code !== 0 || preparedInstall.code !== 0) {
          await writeFile(join(dir, 'live-build.log'), redactLog(preparedBuild.output ?? ''), { mode: 0o600 })
          await writeFile(join(dir, 'live-install.log'), redactLog(preparedInstall.output ?? ''), { mode: 0o600 })
          results.push({ name: 'chrome-live-smoke', status: 'blocked', reason: '隔离部署重建或安装失败，未读取旧运行产物' })
          results.push({ name: 'chrome-lifecycle', status: 'blocked', reason: LIFECYCLE_REASON })
          const git = readGitInfo(root)
          const report = { mode, node: process.version, commit: git.commit, dirty: git.dirty, createdAt: now().toISOString(), results, exitCode: 2 }
          await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
          await writeFile(join(dir, 'summary.md'), `# 验证结果\n\n${results.map((item) => `- ${item.name}: ${item.status}${item.reason ? `，${item.reason}` : ''}`).join('\n')}\n`, { mode: 0o600 })
          log(`报告：${dir}`)
          return { dir, report }
        }
      }
      log(`开始：${LIVE_SMOKE_COMMAND}`)
      const started = Date.now()
      // 真实只读入口要求显式开关；只在已启用 e2e/full 时注入，避免 CI 读取本机部署。
      const result = await execute(LIVE_SMOKE_COMMAND, { cwd: root, env: { ...env, FISHOPS_LIVE_SMOKE: '1' } })
      await writeFile(
        join(dir, `${LIVE_SMOKE_COMMAND.replaceAll(':', '-')}.log`),
        redactLog(result.output),
        { mode: 0o600 },
      )
      let status = result.code === 0 ? 'passed' : result.code === 2 ? 'blocked' : 'failed'
      let exitCode = result.code
      let reason = status === 'blocked'
        ? '真实只读冒烟未执行或环境受阻（退出码 2）'
        : status === 'failed'
          ? '真实只读冒烟断言失败（退出码 1）'
          : undefined
      // 隔离安装会重写扩展产物，已加载的 SW 不会自动换成新 buildId。
      // 重新加载扩展属于部署动作，不是业务重试；仅在显式允许时执行一次，随后只重新执行只读冒烟。
      if (status === 'failed' && env.FISHOPS_BROWSER_RELOAD === '1') {
        log('重载扩展：chrome-smoke-reload')
        const reload = await execute('test:ego-extension-reload', { cwd: root, env: { ...env, FISHOPS_LIVE_SMOKE: '1' } })
        if (reload.code === 0) {
          log(`重新执行：${LIVE_SMOKE_COMMAND}`)
          const retried = await execute(LIVE_SMOKE_COMMAND, { cwd: root, env: { ...env, FISHOPS_LIVE_SMOKE: '1' } })
          if (retried.code === 0) {
            status = 'passed'
            exitCode = 0
            reason = undefined
          } else {
            results.push({ name: 'chrome-smoke-reload', command: 'test:ego-extension-reload', status: 'passed', exitCode: 0 })
          }
          await writeFile(join(dir, 'test-browser-smoke-retry.log'), redactLog(retried.output), { mode: 0o600 })
        } else {
          results.push({ name: 'chrome-smoke-reload', command: 'test:ego-extension-reload', status: 'failed', exitCode: reload.code, reason: '扩展重载失败，未继续重试业务冒烟' })
          reason = '扩展重载失败，不能把旧运行身份当作新构建'
        }
      }
      results.push({
        name: 'chrome-live-smoke',
        command: LIVE_SMOKE_COMMAND,
        status,
        exitCode,
        durationMs: Date.now() - started,
        ...(reason ? { reason } : {}),
      })
      log(`${status === 'passed' ? '通过' : status === 'blocked' ? '受阻' : '失败'}：chrome-live-smoke`)
      if (status === 'passed' && env.FISHOPS_HOME && env.FISHOPS_EXTENSION_DIST) {
        log(`开始：${CHAT_SYNC_STATUS_COMMAND}`)
        const statusStarted = Date.now()
        const statusResult = await execute(CHAT_SYNC_STATUS_COMMAND, { cwd: root, env: { ...env, FISHOPS_LIVE_SMOKE: '1' } })
        results.push({ name: CHAT_SYNC_STATUS_COMMAND, status: statusResult.code === 0 ? 'passed' : 'failed', exitCode: statusResult.code, durationMs: Date.now() - statusStarted })
      }
    }

    // 关闭重开、SW 自然休眠等生命周期仍未隔离验证，成功只读冒烟也不能返回 0。
    if (env.FISHOPS_LIFECYCLE_TRIGGER) {
      log('开始：chrome-lifecycle')
      const lifecycleStarted = Date.now()
      const lifecycle = await execute('test:lifecycle-observe', {
        cwd: root,
        env: { ...env, FISHOPS_LIVE_SMOKE: '1' },
      })
      const lifecycleStatus = lifecycle.code === 0 ? 'passed' : lifecycle.code === 2 ? 'blocked' : 'failed'
      results.push({
        name: 'chrome-lifecycle',
        command: 'test:lifecycle-observe',
        status: lifecycleStatus,
        exitCode: lifecycle.code,
        durationMs: Date.now() - lifecycleStarted,
        ...(lifecycleStatus === 'blocked'
          ? { reason: '生命周期观察环境受阻或触发失败（退出码 2）' }
          : lifecycleStatus === 'failed'
            ? { reason: '生命周期观察或历史/账号断言失败（退出码 1）' }
            : {}),
      })
      log(`${lifecycleStatus === 'passed' ? '通过' : lifecycleStatus === 'blocked' ? '受阻' : '失败'}：chrome-lifecycle`)
    } else {
      // 未提供显式浏览器重开触发器时，不能把已有历史报告冒充本次完整验收。
      results.push({ name: 'chrome-lifecycle', status: 'blocked', reason: LIFECYCLE_REASON })
    }
  }

  const exitCode = results.some((item) => item.status === 'failed')
    ? 1
    : results.some((item) => item.status === 'blocked')
      ? 2
      : 0
  const git = readGitInfo(root)
  const report = {
    mode,
    node: process.version,
    commit: git.commit,
    dirty: git.dirty,
    createdAt: now().toISOString(),
    results,
    exitCode,
  }
  await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  await writeFile(
    join(dir, 'summary.md'),
    `# 验证结果\n\n${results
      .map((item) => `- ${item.name}: ${item.status}${item.reason ? `，${item.reason}` : ''}`)
      .join('\n')}\n`,
    { mode: 0o600 },
  )
  log(`报告：${dir}`)
  return { dir, report }
}

function runNpmCommand(name, { cwd, env }) {
  return new Promise((resolveCommand) => {
    let output = ''
    let settled = false
    let timedOut = false
    let force
    const child = spawn(process.execPath, [join(resolveNpmBin(), 'npm-cli.js'), 'run', name], {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (value) => {
      output += value
    })
    child.stderr.on('data', (value) => {
      output += value
    })
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(force)
      resolveCommand({ code: timedOut ? 124 : (code ?? 1), output })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child, 'SIGTERM')
      force = setTimeout(() => killGroup(child, 'SIGKILL'), 5000)
    }, 120000)
    child.once('error', (error) => {
      output += `\n无法启动 ${name}：${error.code ?? 'UNKNOWN'}`
      finish(1)
    })
    child.once('close', (code) => finish(code))
  })
}

function resolveNpmBin() {
  return resolve(process.execPath, '../../lib/node_modules/npm/bin')
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

function readGitInfo(root) {
  try {
    return {
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
    }
  } catch {
    return { commit: 'unknown', dirty: null }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  await import('./check-runtime.mjs')
  if (process.exitCode) process.exit(process.exitCode)
  try {
    const { report } = await runVerification({ mode: process.argv[2] ?? 'verify' })
    process.exitCode = report.exitCode
  } catch (error) {
    console.error(error instanceof Error ? error.message : '验证编排失败')
    process.exitCode = 1
  }
}
