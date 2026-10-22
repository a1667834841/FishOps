/**
 * 页面内单次只读执行运行时（MAIN world），聊天与 MTOP 共用文档锁。
 *
 * 职责只有一个：把 host 已授权的 `request-step` 变成“最多一次”真实平台请求，并在请求真实终结后
 * 返回归一化结果或脱敏错误。约束：
 * - 执行锁挂在文档 `scope` 上而不是本实例上，因此 SW/native 连接重建不会清掉在途步骤；旧步骤未终结
 *   时新步骤被拒绝，绝不发出第二个请求。
 * - `request.context.documentId` 必须与本 runtime 绑定的一致；派发前、返回前都核验账号。
 * - 单次只调用一次注入的 `fetch`，不自动重试，不创建定时探测；读超时只结束等待，不改写网络事实。
 * - 正文超过 1 MiB 时取消读取并等待取消真正完成，再终结为失败。
 * - 锁内只保存归一化结果或脱敏错误，绝不保存 cookie、token 或原始响应正文。
 * - `fetch` settle 只说明响应头已到达，不代表正文已终结；HTTP 状态必须等正文读完（或取消失败
 *   时保持失败关闭）后才可判定，否则会提前释放文档锁。
 * - 失败关闭后：同一在途步骤的重投只复用原 Promise（不执行、不终结），新步骤明确未派发，
 *   避免 host 误判旧槽已释放。
 * - 聊天同步只终结能证明“平台请求未派出”或“平台已给出明确判定”的失败；其余保持失败关闭，
 *   不释放文档锁，也不把终止未知的请求变成可重放。
 *
 * 页面被替换/销毁的竞态由后续 Chrome 适配层负责；本模块只陈述 fetch 是否 settle 这一 JS 事实，
 * 不声称平台请求已完成。
 */
import { isStepWire, type StepWire } from '../../../packages/protocol/src/step.ts'
import { isChatSyncPageParams, validateResult, type ChatSyncPageParams, type ChatSyncPageResult } from '../../../packages/protocol/src/chat-sync.ts'
import type { ErrorCode } from '../../../packages/protocol/src/index.ts'
import { ApiError } from './errors.ts'
import type { ChatWriteResult } from './chat-write-transport.ts'
import { ItemNormalizationError, normalizeDetail, normalizeSearch, normalizeSuggest } from './modules/items.ts'
import { installPageLock } from './page-lock.ts'
import { buildReadRequest, classifyReadResponse, type ReadMethod, type ReadRequest } from './platform/mtop.ts'
import { extractToken } from './platform/sign.ts'
import {
  runPublishPrepare,
  runPublishSubmit,
  runPublishMyItems,
  type PublishPageExecutorDeps,
} from './publish-page-executor.ts'
import { type PublishMethod } from '../../../packages/protocol/src/publish.ts'
import { locateSlider, sliderDialogVisible } from './slider-plan.ts'

type RequestStep = Extract<StepWire, { kind: 'request-step' }>
/** 单步终结结果；`terminal` 只表示 JS 侧执行已终结，不等同 HTTP 等待超时。 */
export type PageRuntimeStepResult = Extract<StepWire, { kind: 'step-result' }>

/** `Response.body.getReader()` 的最小接口；真实 `ReadableStream` 与测试替身都满足。 */
export interface PageResponseReader {
  read(): Promise<{ done: boolean; value?: unknown }>
  cancel(reason?: unknown): Promise<void>
}

export interface PageResponseBody {
  getReader(): PageResponseReader
}

/** 真实 `fetch` 响应的最小子集；字段足够读取状态、流式正文与文本回退。 */
export interface PageResponseLike {
  status: number
  body?: PageResponseBody | null
  text(): Promise<string>
}

/** 运行时固定使用的 fetch 参数：POST、带 cookie、禁止跟随重定向。 */
export interface PageFetchInit {
  method: 'POST'
  headers: Record<string, string>
  body: string
  credentials: 'include'
  redirect: 'error'
}

export type PageFetch = (url: string, init: PageFetchInit) => Promise<PageResponseLike>

/** 页面运行时的全部外部依赖；生产由 Chrome 适配层注入，测试注入替身。 */
export interface PageRuntimeDeps {
  /** 复用页面已观察连接的单页读取；必须返回已归一化结果，不走 MTOP。 */
  chatSyncPage?: (params: ChatSyncPageParams, accountId: string, mid: string) => Promise<ChatSyncPageResult>
  /** 复用页面已观察连接发送文本；不得创建连接或经过 MTOP。 */
  chatSend?: (params: { sessionId: string; receiverId: string; text: string }, accountId: string, mid: string) => Promise<ChatWriteResult>
  /** 发布页面执行依赖；只在 MAIN world 内注入官方 MTOP 请求函数。 */
  publish?: Omit<PublishPageExecutorDeps, 'readAccountId' | 'now'>
  /** 目标文档的全局对象；文档锁必须挂在它上面才能跨 runtime 重建复用。 */
  scope: Record<string, unknown>
  /**
   * 检测页面是否正在展示平台人机验证（baxia 滑块、punish iframe 等）。
   * 平台触发验证时接口常常只表现为超时，必须借页面证据把失败改判为 RISK_BLOCKED，
   * 让 Host 持久化风控信号并停止调度。缺省时使用 DOM 检测。
   */
  detectRiskChallenge?: () => boolean
  /**
   * 尝试自动完成页面上的滑块验证；返回是否解除。
   *
   * 由 SW 侧用 `chrome.debugger` 在目标标签页派发真实鼠标事件；本模块只负责
   * 「定位 → 请求拖动 → 轮询弹窗是否消失」的编排，不自己合成事件。
   * 不注入或返回 false 时保持既有停机语义，回落人工验证。
   */
  solveSlider?: () => Promise<boolean>
  /** 本 runtime 绑定的 Chrome documentId；与请求上下文不一致时拒绝执行。 */
  documentId: string
  /** 读取当前登录账号 id；无法确认时返回 null。 */
  readAccountId: () => string | null | Promise<string | null>
  /** 读取 `document.cookie`；调用方必须在 MAIN world 同步取值。 */
  readCookie: () => string | Promise<string>
  /** 真实网络请求实现；本模块只调用一次，不重试。 */
  fetch: PageFetch
  /** 毫秒时间源；用于 MTOP 签名时间戳，测试可固定。 */
  now: () => number
  /** 只读请求等待上限；超时只结束等待，不释放文档锁或宣称平台请求已终结。 */
  readTimeoutMs?: number
}

export interface PageRuntimeStatus {
  documentId: string
  activeStepId: string | null
  completed: number
}

export interface PageRuntime {
  /** 返回文档锁状态，供连接重建时核对是否仍有在途步骤。 */
  status(): PageRuntimeStatus
  /** 执行单个 request-step；返回结果只在平台请求真实终结后产生。 */
  execute(request: unknown): Promise<PageRuntimeStepResult>
  /** 页面文档销毁时显式结束失败关闭等待；正常调用不需要主动释放。 */
  dispose(): void
}

/** 与 native 帧一致的单帧正文上限。 */
const MAX_BODY_BYTES = 1024 * 1024
/** 只读请求默认等待上限；超时后锁继续占用，直到真实终结或文档销毁。 */
const DEFAULT_READ_TIMEOUT_MS = 60_000
/** 文档级“失败关闭”标记：取消失败时写入，跨 runtime 重建仍然生效。 */
const POISON_KEY = '__fishopsPageRuntimePoisonV1__'
const NETWORK_MESSAGE = '平台请求未完成或网络中断，无法确认结果'
const LOGIN_MESSAGE = '需要登录闲鱼账号或登录状态已失效，请先登录后重试'
const ACCOUNT_MESSAGE = '执行账号已变化或无法确认，本步骤结果不返回'

type PoisonState = { poisoned: true; stepId: string; reason: string }

function failure(id: string, error: ApiError): PageRuntimeStepResult {
  return { kind: 'step-result', id, terminal: true, ok: false, error: error.toWire() }
}

function readPoison(scope: Record<string, unknown>): PoisonState | null {
  const value = scope[POISON_KEY]
  if (typeof value !== 'object' || value === null) return null
  const state = value as Partial<PoisonState>
  return state.poisoned === true ? (state as PoisonState) : null
}

/**
 * 写入文档级失败关闭标记。
 *
 * 正文流取消未确认或聊天读取无法确认终结时，“读取已停止”不等于“网络已终结”，因此必须让锁继续占用并
 * 阻止后续新步骤派发，直到页面重新加载。标记挂文档全局，runtime 重建不会清除。
 */
function markPoisoned(scope: Record<string, unknown>, stepId: string): void {
  if (readPoison(scope)) return
  const state: PoisonState = Object.freeze({
    poisoned: true,
    stepId,
    reason: '平台只读请求未确认终结',
  })
  Object.defineProperty(scope, POISON_KEY, { value: state, configurable: false, writable: false })
}

function poisonError(): ApiError {
  return new ApiError('RESULT_UNKNOWN', '前一次平台响应未确认终结，文档已停止派发新步骤，需重新加载页面', {
    phase: 'read',
    retryable: false,
  })
}

function rejectedError(status: unknown): ApiError {
  const shown = typeof status === 'number' && Number.isInteger(status) ? String(status) : '未知'
  return new ApiError('PLATFORM_REJECTED', `闲鱼接口返回 HTTP ${shown}，本次请求未成功`, { phase: 'read', retryable: false })
}

function tooLarge(): ApiError {
  return new ApiError(
    'PAYLOAD_TOO_LARGE',
    `平台响应正文超过 ${MAX_BODY_BYTES} 字节上限，已停止读取`,
    { phase: 'read', retryable: false },
  )
}

/**
 * 聊天同步唯一允许终结（并释放文档锁）的错误码。
 *
 * 这些码只可能表示两种情况：平台请求尚未派出（页面/连接不可用、参数无效），或平台已给出明确判定
 * （风控、登录失效、明确拒绝）。两者都不存在“已派发但终结未确认”的在途请求，所以终结不会把未知请求变成可重放。
 */
const CHAT_SYNC_TERMINAL_CODES: ReadonlySet<string> = new Set(['PAGE_NOT_READY', 'BAD_REQUEST', 'RISK_BLOCKED', 'LOGIN_REQUIRED', 'PLATFORM_REJECTED'])
/** 页面内诊断开关；只记录固定阶段与分类，不写正文、参数、连接或凭据。 */
const CHAT_SYNC_DIAG = false

/** 聊天同步停止分类的固定文案；平台/传输原文一律不带出页面。 */
const CHAT_SYNC_MESSAGES: Readonly<Record<string, string>> = {
  PAGE_NOT_READY: '页面聊天同步尚不可用或结果无效',
  BAD_REQUEST: '聊天同步页参数无效',
  RISK_BLOCKED: '平台已触发风控，聊天同步停止',
  LOGIN_REQUIRED: LOGIN_MESSAGE,
  PLATFORM_REJECTED: '平台已明确拒绝聊天同步请求',
}

/** 从聊天失败里取出可安全终结的错误码；无法判定时返回 null 交给调用方保持失败关闭。 */
function chatSyncFailureCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && CHAT_SYNC_TERMINAL_CODES.has(code) ? code : null
}

/** 构造固定文案的聊天同步失败；输入码只允许来自 {@link CHAT_SYNC_TERMINAL_CODES}。 */
function chatSyncFailure(code: string): ApiError {
  return new ApiError(code as ErrorCode, CHAT_SYNC_MESSAGES[code] ?? '聊天同步未完成', { phase: 'read', retryable: false })
}

function decodeChunks(chunks: readonly Uint8Array[]): string {
  const decoder = new TextDecoder('utf-8')
  let text = ''
  // stream 模式处理跨分片的多字节字符；结尾再 flush 一次补齐残留字节。
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true })
  return text + decoder.decode()
}

/** 只允许从 cookie 中本地解析 token；token 与原 cookie 串都不进入返回值。 */
function tokenOf(cookie: unknown): string | null {
  if (typeof cookie !== 'string' || cookie.length === 0) return null
  const token = extractToken(cookie)
  return token === null || token.length === 0 ? null : token
}

function normalizePayload(method: ReadMethod, payload: unknown): unknown {
  try {
    if (method === 'item.detail') return normalizeDetail(payload)
    if (method === 'search.suggest') return normalizeSuggest(payload)
    return normalizeSearch(payload)
  } catch (error) {
    if (error instanceof ItemNormalizationError) {
      // 结构不完整说明平台响应不可用；固定文案，不回传原始正文或字段值。
      throw new ApiError('PLATFORM_REJECTED', '闲鱼返回的响应结构不完整，无法读取结果', { phase: 'read', retryable: false })
    }
    throw error
  }
}

function idOf(request: unknown): string {
  if (typeof request === 'object' && request !== null) {
    const id = (request as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0 && id.length <= 128) return id
  }
  return 'invalid-step'
}

/** 锁自身拒绝（旧步骤在途、步骤冲突、容量满）不泄露内部细节，只按是否在途分类。 */
function lockFailure(error: unknown, activeStepId: string | null): ApiError {
  if (error instanceof ApiError) return error
  if (activeStepId !== null) {
    return new ApiError('PAGE_NOT_READY', '页面正在执行其它平台步骤，本次步骤未派发', { phase: 'read', retryable: false })
  }
  return new ApiError('BAD_REQUEST', '步骤标识与已执行步骤冲突，本次步骤未派发', { phase: 'read', retryable: false })
}

/**
 * 创建页面内单次网络执行运行时。
 *
 * @param deps 见 {@link PageRuntimeDeps}；`scope` 与 `documentId` 决定文档锁归属。
 * @returns 提供只读 `status` 与单步 `execute` 的运行时。同一 `scope` 重复创建会复用原文档锁。
 */
/** 默认 DOM 检测：只看可见的 baxia 弹窗或 punish/验证码 iframe，不读取页面内容。 */
function defaultRiskChallenge(scope: Record<string, unknown>): boolean {
  const doc = (scope as { document?: { querySelectorAll?: (s: string) => ArrayLike<{ offsetWidth?: number; offsetHeight?: number }> } }).document
  if (!doc || typeof doc.querySelectorAll !== 'function') return false
  const nodes = doc.querySelectorAll('.baxia-dialog, iframe[src*="punish"], iframe[src*="captcha"], #nocaptcha')
  for (let i = 0; i < nodes.length; i++) { const n = nodes[i]!; if ((n.offsetWidth ?? 0) > 0 || (n.offsetHeight ?? 0) > 0) return true }
  return false
}

/**
 * 从文档 scope 取滑块 DOM 读取面。
 *
 * 只取 `querySelector`，不取整个 document，避免把页面对象带进返回值；
 * `locateSlider` / `sliderDialogVisible` 自己会校验形状。
 */
function sliderDomOf(scope: Record<string, unknown>): Parameters<typeof locateSlider>[0] | null {
  const doc = (scope as { document?: unknown }).document
  if (typeof doc !== 'object' || doc === null) return null
  const candidate = doc as { querySelector?: unknown }
  if (typeof candidate.querySelector !== 'function') return null
  return candidate as Parameters<typeof locateSlider>[0]
}

/** 滑块自动处理的固定结论；`attempted` 用于区分「没试」与「试过没成」。 */
type SliderOutcome = { attempted: false } | { attempted: true; passed: boolean }

/**
 * 尝试自动完成滑块验证，并返回是否真正解除。
 *
 * 编排顺序固定：先确认弹窗仍在 → 定位滑块 → 请求 SW 派发拖动 → 轮询弹窗消失。
 * 任一步骤不满足都返回 `attempted:false` 或 `passed:false`，绝不猜测成功。
 * 拖动成功后弹窗消失需要时间，因此给一个有界等待窗口；超时按未通过处理。
 */
async function trySolveSlider(
  deps: PageRuntimeDeps,
  scope: Record<string, unknown>,
  wait: (ms: number) => Promise<void>,
): Promise<SliderOutcome> {
  if (typeof deps.solveSlider !== 'function') return { attempted: false }
  const dom = sliderDomOf(scope)
  if (!dom) return { attempted: false }
  // 只处理滑块类：拿不到拖动计划说明是短信/扫码/人脸等类型，直接回落人工。
  if (!locateSlider(dom)) return { attempted: false }
  let passed = false
  try {
    passed = await deps.solveSlider() === true
  } catch {
    return { attempted: true, passed: false }
  }
  if (!passed) return { attempted: true, passed: false }
  // 有界轮询：平台通过后弹窗有收起动画，立即判断会误判为失败。
  for (let round = 0; round < 10; round += 1) {
    if (!sliderDialogVisible(dom)) return { attempted: true, passed: true }
    await wait(200)
  }
  return { attempted: true, passed: false }
}

export function createPageRuntime(deps: PageRuntimeDeps): PageRuntime {
  if (!deps || typeof deps !== 'object') throw new Error('页面运行时依赖无效')
  if (typeof deps.documentId !== 'string' || deps.documentId.length === 0) {
    throw new Error('页面运行时缺少 documentId')
  }
  if (!deps.scope || typeof deps.scope !== 'object') throw new Error('页面运行时缺少文档 scope')
  for (const name of ['readAccountId', 'readCookie', 'fetch', 'now'] as const) {
    if (typeof deps[name] !== 'function') throw new Error(`页面运行时缺少依赖：${name}`)
  }
  // 锁挂文档全局：runtime 重建或 SW 重连都不会清掉在途步骤。
  const lock = installPageLock(deps.scope, deps.documentId)
  /** 当前在途步骤的标签页；只用于把 CDP 会话限定到本步骤定位的页面。 */
  let activeTabId: number | null = null
  const readTimeoutMs=deps.readTimeoutMs??DEFAULT_READ_TIMEOUT_MS
  if(!Number.isSafeInteger(readTimeoutMs)||readTimeoutMs<=0)throw new Error('页面运行时读取超时无效')

  /** 有界等待；只用于滑块弹窗收起动画观察，不参与任何平台请求节奏。 */
  function sleep(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const handle = setTimeout(resolve, ms)
      if (typeof handle === 'object' && handle !== null && typeof handle.unref === 'function') handle.unref()
    })
  }

  async function requireAccount(expected: string): Promise<void> {
    let current: string | null
    try {
      current = await deps.readAccountId()
    } catch {
      throw new ApiError('ACCOUNT_CHANGED', ACCOUNT_MESSAGE, { phase: 'read', retryable: false })
    }
    if (current !== expected) {
      throw new ApiError('ACCOUNT_CHANGED', ACCOUNT_MESSAGE, { phase: 'read', retryable: false })
    }
  }

  async function readFallbackText(response: PageResponseLike): Promise<string> {
    let text: string
    try {
      text = await response.text()
    } catch {
      throw new ApiError('TIMEOUT', NETWORK_MESSAGE, { phase: 'read', retryable: false })
    }
    if (typeof text !== 'string') {
      throw new ApiError('INTERNAL', '响应正文格式无法读取', { phase: 'read', retryable: false })
    }
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw tooLarge()
    return text
  }

  /**
   * 流式读取正文并在超限时先取消、等取消完成，再终结。
   *
   * 只有读完整（`done`）或取消确认成功时，才能认为该响应在 JS 侧已经终结；取消本身失败时，
   * 不能把“停止读取”当成“网络终结”，必须保持锁占用并写入文档级失败关闭标记。
   */
  async function readBodyText(response: PageResponseLike, stepId: string): Promise<string> {
    const body = response.body
    if (!body || typeof body.getReader !== 'function') return readFallbackText(response)
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      let step: { done: boolean; value?: unknown }
      try {
        step = await reader.read()
      } catch {
        throw new ApiError('TIMEOUT', NETWORK_MESSAGE, { phase: 'read', retryable: false })
      }
      if (step.done) break
      const chunk = step.value
      if (!(chunk instanceof Uint8Array)) {
        throw new ApiError('INTERNAL', '响应正文格式无法读取', { phase: 'read', retryable: false })
      }
      total += chunk.byteLength
      if (total > MAX_BODY_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // 取消失败不重试，也不伪造终结：写入失败关闭标记并让本次步骤永不 settle，
          // 文档锁继续占用，后续新步骤一律被拒绝，直到页面重新加载。
          try {
            markPoisoned(deps.scope, stepId)
          } catch {
            // 连标记都写不进时同样不能放行：不能证明请求已终结就保持锁占用。
          }
          return await new Promise<never>(() => {})
        }
        throw tooLarge()
      }
      chunks.push(chunk)
    }
    return decodeChunks(chunks)
  }

  function parsePayload(text: string): unknown {
    try {
      return JSON.parse(text) as unknown
    } catch {
      // 非 JSON 正文通常是网关拦截页；交给文本特征分类，绝不当作成功响应。
      return text
    }
  }

  /** 只负责一次 fetch；reject 表示 JS 侧已终结，但不代表平台请求已完成。 */
  async function fetchOnce(built: ReadRequest): Promise<PageResponseLike> {
    try {
      return await deps.fetch(built.url, {
        method: 'POST',
        headers: built.headers,
        body: built.body,
        credentials: built.credentials,
        redirect: 'error',
      })
    } catch {
      // fetch reject 只证明 JS 侧已终结；平台是否已收到请求无法确认，不能宣称成功。
      throw new ApiError('TIMEOUT', NETWORK_MESSAGE, { phase: 'read', retryable: false })
    }
  }

  async function dispatch(request: RequestStep): Promise<unknown> {
    await requireAccount(request.context.accountId)
    if (request.method === 'chat.sync.page') {
      if (!deps.chatSyncPage || !isChatSyncPageParams(request.params)) {
        throw new ApiError('PAGE_NOT_READY', '页面聊天同步尚不可用', { phase: 'read', retryable: false })
      }
      try {
        const data = await deps.chatSyncPage(request.params, request.context.accountId, request.id)
        if (readPoison(deps.scope)) return await new Promise<never>(() => {})
        await requireAccount(request.context.accountId)
        if (!validateResult(request.params, data)) {
          if (CHAT_SYNC_DIAG) console.warn('[fishops-chat-sync] invalid-result')
          throw chatSyncFailure('PAGE_NOT_READY')
        }
        return data
      } catch (error) {
        // 未派发或平台已明确判定时立即终结：这类失败没有未确认终结的在途请求，可以安全释放文档锁。
        const code = chatSyncFailureCode(error)
        if (CHAT_SYNC_DIAG) console.warn('[fishops-chat-sync] terminal', chatSyncFailureCode(error) ?? 'unknown')
        if (code !== null) throw chatSyncFailure(code)
        // 其余（超时、账号变化、未知错误）无法证明页面连接上的请求终结；跨 runtime 重建也不能重发。
        try { markPoisoned(deps.scope, request.id) } catch {}
        await riskStop(request.id, 'read')
        return await new Promise<never>(() => {})
      }
    }
    if ((request.method as string) === 'chat.send') {
      if (!deps.chatSend || !request.params || typeof request.params !== 'object') {
        throw new ApiError('PAGE_NOT_READY', '页面聊天发送尚不可用', { phase: 'write', retryable: false })
      }
      const params = request.params as Record<string, unknown>
      if (typeof params.sessionId !== 'string' || typeof params.receiverId !== 'string' || typeof params.text !== 'string' || Object.keys(params).some(key => !['sessionId', 'receiverId', 'text'].includes(key))) {
        throw new ApiError('BAD_REQUEST', '聊天发送参数无效', { phase: 'write', retryable: false })
      }
      try {
        const result = await deps.chatSend({ sessionId: params.sessionId, receiverId: params.receiverId, text: params.text }, request.context.accountId, request.id)
        await requireAccount(request.context.accountId)
        return result
      } catch (error) {
        // 无 socket 且尚未派发时允许稍后重新定位；其余写失败均保留失败关闭状态。
        if ((error instanceof ApiError && error.code === 'PAGE_NOT_READY') ||
          (error as { code?: unknown })?.code === 'PAGE_NOT_READY') throw new ApiError('PAGE_NOT_READY', '页面聊天发送尚不可用', { phase: 'write', retryable: false })
        if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'PAGE_NOT_READY') {
          throw new ApiError('PAGE_NOT_READY', '聊天页面或连接不可用', { phase: 'write', retryable: false })
        }
        try { markPoisoned(deps.scope, request.id) } catch {}
        await riskStop(request.id, 'write')
        return await new Promise<never>(() => {})
      }
    }
    if (request.method === 'publish.prepare' || request.method === 'publish.submit' || request.method === 'publish.myItems') {
      if (!deps.publish) {
        throw new ApiError('PAGE_NOT_READY', '发布页面执行器尚不可用', { phase: 'read', retryable: false })
      }
      const publishDeps: PublishPageExecutorDeps = {
        ...deps.publish,
        readAccountId: deps.readAccountId,
        now: deps.now,
      }
      const method = request.method as PublishMethod
      let outcome
      try {
        outcome = method === 'publish.prepare'
          ? await runPublishPrepare(request.params, request.context.accountId, publishDeps)
          : method === 'publish.submit'
            ? await runPublishSubmit(request.params, request.context.accountId, publishDeps)
            : await runPublishMyItems(request.params, request.context.accountId, publishDeps)
      } catch {
        try { markPoisoned(deps.scope, request.id) } catch {}
        await riskStop(request.id, method === 'publish.submit' ? 'write' : 'read')
        return await new Promise<never>(() => {})
      }
      if (!outcome.ok) {
        const code = outcome.error.code
        // 官方 SDK 已返回明确风控/登录响应时保留停止分类，供 Host 持久化
        // risk.signal；不能吞成超时，否则 Agent 无法观察到平台停止要求。
        if (code === 'BAD_REQUEST' || code === 'PAGE_NOT_READY' ||
          code === 'RISK_BLOCKED' || code === 'LOGIN_REQUIRED' ||
          code === 'PLATFORM_REJECTED') throw outcome.error
        try { markPoisoned(deps.scope, request.id) } catch {}
        await riskStop(request.id, method === 'publish.submit' ? 'write' : 'read')
        return await new Promise<never>(() => {})
      }
      await requireAccount(request.context.accountId)
      return outcome.result
    }
    let cookie: unknown
    try {
      cookie = await deps.readCookie()
    } catch {
      throw new ApiError('LOGIN_REQUIRED', LOGIN_MESSAGE, { phase: 'read', retryable: false })
    }
    const token = tokenOf(cookie)
    if (token === null) {
      throw new ApiError('LOGIN_REQUIRED', LOGIN_MESSAGE, { phase: 'read', retryable: false })
    }
    const built = buildReadRequest(request.method, request.params, token, String(Math.trunc(deps.now())))
    const response = await fetchOnce(built)
    // fetch settle 只保证响应头到达；必须先等正文真实终结，才能判定状态并释放文档锁。
    const text = await readBodyText(response, request.id)
    if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      throw rejectedError(response.status)
    }
    const payload = parsePayload(text)
    const platformError = classifyReadResponse(payload)
    if (platformError) throw platformError
    const data = normalizePayload(request.method as ReadMethod, payload)
    // 归一化后再核验：请求期间账号被切换时丢弃结果，绝不返回旧账号数据。
    await requireAccount(request.context.accountId)
    return data
  }

  /** 锁内执行只产出归一化结果或脱敏错误；锁历史和缓存都不会保存原始响应。 */
  /** 锁内只包真实网络步骤；调用方等待超时不能提前释放文档锁。 */
  async function runStep(request: RequestStep): Promise<PageRuntimeStepResult> {
    activeTabId = request.context.tabId
    try {
      const data = await dispatch(request)
      return { kind: 'step-result', id: request.id, terminal: true, ok: true, data }
    } catch (error) {
      activeTabId = null
      const apiError = ApiError.from(error, 'INTERNAL')
      // 已是登录/风控等停止分类时保持原样；其余失败若页面可见验证弹窗，先尝试自动滑块。
      if (apiError.code !== 'RISK_BLOCKED' && apiError.code !== 'LOGIN_REQUIRED' && riskChallengeVisible()) {
        const slider = await trySolveSlider(deps, deps.scope, sleep)
        // 自动滑块只可能解除弹窗，不能证明失败的业务步骤已成功；仍按风控停止，
        // 但文案区分「已自动通过，可重试」与「仍需人工」，避免调用方误判为同一状态。
        if (slider.attempted && slider.passed) {
          return failure(request.id, new ApiError('RISK_BLOCKED', '平台人机验证已自动通过，本步骤未重发，请以新幂等语义重试', { phase: apiError.phase ?? 'read', retryable: false }))
        }
        return failure(request.id, new ApiError('RISK_BLOCKED', '页面出现平台人机验证，已停止，需要人工完成验证', { phase: apiError.phase ?? 'read', retryable: false }))
      }
      return failure(request.id, apiError)
    } finally { activeTabId = null }
  }
  /**
   * 在途结果未知时页面已 poison（锁不释放、不会重放）；若此时页面可见人机验证，
   * 直接以 RISK_BLOCKED 终结本步骤，让 Host 记录风控而不是长时间挂起成超时。
   */
  async function riskStop(stepId: string, phase: 'read' | 'write'): Promise<void> {
    if (!riskChallengeVisible()) return
    // 结果未知的步骤已 poison，绝不能因为自动滑块成功就当作可重放；
    // 这里仍然尝试自动解除，只为减少人工介入，成功后依旧以 RISK_BLOCKED 停止。
    const slider = await trySolveSlider(deps, deps.scope, sleep)
    if (slider.attempted && slider.passed) {
      throw new ApiError('RISK_BLOCKED', '平台人机验证已自动通过，本步骤结果仍未确认，请重新加载页面后以新幂等语义重试', { phase, retryable: false })
    }
    throw new ApiError('RISK_BLOCKED', '页面出现平台人机验证，已停止，需要人工完成验证', { phase, retryable: false })
  }
  function riskChallengeVisible(): boolean {
    try { return deps.detectRiskChallenge ? deps.detectRiskChallenge() === true : defaultRiskChallenge(deps.scope) } catch { return false }
  }

  return {
    status: () => lock.status(),
    dispose: () => lock.dispose?.(),
    async execute(request) {
      const isLocalChatSend = typeof request === 'object' && request !== null &&
        (request as { kind?: unknown }).kind === 'request-step' && (request as { method?: unknown }).method === 'chat.send'
      if ((!isStepWire(request) && !isLocalChatSend) || (request as { kind?: unknown }).kind !== 'request-step') {
        return failure(idOf(request), new ApiError('BAD_REQUEST', '单步参数无效'))
      }
      const runtimeRequest = request as RequestStep
      if (runtimeRequest.context.documentId !== deps.documentId) {
        return failure(runtimeRequest.id, new ApiError('PAGE_NOT_READY', '执行文档已变化', { phase: 'read', retryable: false }))
      }
      // 指纹只取决于单步内容，因此跨 runtime 的同一请求会命中锁内同一个 Promise。
      const fingerprint = JSON.stringify(runtimeRequest)
      const poison = readPoison(deps.scope)
      if (poison) {
        if (poison.stepId !== runtimeRequest.id) {
          // 新步骤明确未派发；原在途步骤仍占用文档锁，不能被当成旧槽已释放。
          return failure(runtimeRequest.id, poisonError())
        }
        try {
          // 同一在途步骤只能取回锁内原始 Promise：不执行、不返回 terminal 结果，
          // 否则 host 会误判平台槽位已释放并重新派发。
          const value = await lock.run(runtimeRequest.id, fingerprint, () => new Promise<never>(() => {}))
          return value as PageRuntimeStepResult
        } catch {
          // 文档销毁会结束原锁等待；此时原步骤仍不能伪造 terminal，继续返回失败关闭。
          return failure(runtimeRequest.id, poisonError())
        }
      }
      try {
        let timer: ReturnType<typeof setTimeout>|undefined
        const timeout=new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>{
            if ((runtimeRequest.method === 'chat.sync.page' || (runtimeRequest.method as string) === 'chat.send') && lock.status().activeStepId === runtimeRequest.id) {
              try { markPoisoned(deps.scope, runtimeRequest.id) } catch {}
            }
            reject(new ApiError('TIMEOUT',NETWORK_MESSAGE,{phase:'read',retryable:false}))
          },readTimeoutMs)
        })
        // 超时只结束本次等待；锁内真实步骤继续执行，直到平台响应终结。
        const value = await Promise.race([lock.run(runtimeRequest.id, fingerprint, () => runStep(runtimeRequest)),timeout])
          .finally(()=>{if(timer!==undefined)clearTimeout(timer)})
        const result = value as PageRuntimeStepResult
        if (result.ok) {
          // 命中锁内历史结果的重投同样要核验账号，避免账号切换后回放旧账号数据。
          try {
            await requireAccount(runtimeRequest.context.accountId)
          } catch (error) {
            return failure(runtimeRequest.id, ApiError.from(error, 'ACCOUNT_CHANGED'))
          }
        }
        return result
      } catch (error) {
        // 等待超时是当前调用的失败；锁冲突仍按 PAGE_NOT_READY/BAD_REQUEST 分类。
        if(readPoison(deps.scope))return failure(runtimeRequest.id,poisonError())
        const apiError=error instanceof ApiError?error:lockFailure(error,lock.status().activeStepId)
        return failure(runtimeRequest.id, apiError)
      }
    },
  }
}
