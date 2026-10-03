/**
 * 只读 LWP transport（P5）。
 *
 * 作用：在 goofish 页面 MAIN world 里，复用页面**已建立**的聊天 WebSocket，
 * 发送两类「只读」LWP 请求并等待响应，供 `ChatHistoryClient` 拉取会话/历史：
 * - `/r/Conversation/listNewestPagination`
 * - `/r/MessageManager/listUserMessages`
 *
 * 安全边界（本模块是 P5 唯一的「写 socket」位置，必须收得很紧）：
 * - **严格路由白名单**：只允许上面两条路由，其它一律拒绝，绝不把外部 payload 原样发送；
 * - 请求必须是标准 LWP 信封（仅 `lwp` / `headers.mid` / `body` 三个字段，body 为数组），
 *   任何多余字段都会被拒绝；
 * - 按 `headers.mid` 关联响应；超时 15 秒（{@link LWP_REQUEST_TIMEOUT_MS}）；
 * - 不实现 sender、不发送任何聊天消息（发送属 P6，本模块不存在相关代码）。
 *
 * 本文件不直接访问 `window` / `WebSocket` 全局，socket 由外部通过 `getSocket` 注入，
 * 因此可在 Node 中做纯逻辑单测。
 */
import {
  isRecord,
  LWP_REQUEST_TIMEOUT_MS,
  LWP_ROUTES,
  type LwpRequest,
  type LwpResponse,
} from '../../../shared/chat/index'
import type { ChatTransport } from './history'
import type { WebSocketLike } from './websocket'

/** 允许发送的 LWP 只读路由白名单。 */
export const ALLOWED_LWP_ROUTES: readonly string[] = [LWP_ROUTES.listConversations, LWP_ROUTES.listMessages]

/** 是否属于白名单只读路由。 */
export function isAllowedLwpRoute(lwp: unknown): boolean {
  return typeof lwp === 'string' && ALLOWED_LWP_ROUTES.includes(lwp)
}

/** transport 结构化错误码。 */
export type ChatSocketTransportErrorCode =
  | 'ROUTE_NOT_ALLOWED'
  | 'INVALID_REQUEST'
  | 'DUPLICATE_MID'
  | 'NO_SOCKET'
  | 'SEND_FAILED'
  | 'TIMEOUT'

/** transport 结构化错误（不逃逸到全局，由 ChatHistoryClient 归一）。 */
export class ChatSocketTransportError extends Error {
  readonly code: ChatSocketTransportErrorCode
  constructor(code: ChatSocketTransportErrorCode, message: string) {
    super(message)
    this.name = 'ChatSocketTransportError'
    this.code = code
  }
}

/**
 * 校验一个 LWP 请求是否允许发送。
 * 返回 null 表示通过；否则返回错误（拒绝原因）。
 */
export function validateAllowedLwpRequest(request: unknown): ChatSocketTransportError | null {
  if (!isRecord(request)) return new ChatSocketTransportError('INVALID_REQUEST', '请求不是对象')

  const keys = Object.keys(request)
  if (keys.length !== 3 || !keys.every((key) => key === 'lwp' || key === 'headers' || key === 'body')) {
    return new ChatSocketTransportError('INVALID_REQUEST', 'LWP 请求只允许 lwp / headers / body 三个字段')
  }
  if (!isAllowedLwpRoute(request['lwp'])) {
    return new ChatSocketTransportError('ROUTE_NOT_ALLOWED', `非白名单 LWP 路由: ${String(request['lwp'])}`)
  }
  const headers = request['headers']
  if (!isRecord(headers) || Object.keys(headers).length !== 1 || typeof headers['mid'] !== 'string' || headers['mid'].length === 0) {
    return new ChatSocketTransportError('INVALID_REQUEST', 'headers 必须且只能包含非空字符串 mid')
  }
  if (!Array.isArray(request['body'])) {
    return new ChatSocketTransportError('INVALID_REQUEST', 'body 必须是数组')
  }
  const body = request['body']
  if (body.length > 5) return new ChatSocketTransportError('INVALID_REQUEST', 'body 参数数量超出只读协议范围')
  if (request['lwp'] === LWP_ROUTES.listConversations) {
    if (body.length !== 2 || !isSafePageCursor(body[0]) || !isPositivePageSize(body[1])) {
      return new ChatSocketTransportError('INVALID_REQUEST', '会话列表参数非法')
    }
  } else if (request['lwp'] === LWP_ROUTES.listMessages) {
    if (
      body.length !== 5 ||
      typeof body[0] !== 'string' ||
      !body[0].endsWith('@goofish') ||
      body[1] !== false ||
      !isSafePageCursor(body[2]) ||
      !isPositivePageSize(body[3]) ||
      body[4] !== false
    ) {
      return new ChatSocketTransportError('INVALID_REQUEST', '消息历史参数非法')
    }
  }
  return null
}

/** 计时器句柄（兼容浏览器 number 与 Node Timeout）。 */
type TimerHandle = ReturnType<typeof setTimeout>

export interface ChatSocketTransportDeps {
  /** 取当前目标 WebSocket；未连接时返回 null。 */
  getSocket: () => WebSocketLike | null
  /** 默认超时（毫秒），缺省 15 秒。 */
  timeoutMs?: number
  /** 计时器注入，便于测试；默认使用全局 setTimeout / clearTimeout。 */
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

interface PendingEntry {
  resolve: (response: LwpResponse) => void
  reject: (error: unknown) => void
  handle: TimerHandle
}

/** 只读 LWP transport。 */
function isSafePageCursor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositivePageSize(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 500
}

export class ChatSocketTransport implements ChatTransport {
  private readonly deps: ChatSocketTransportDeps
  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void
  private readonly pending = new Map<string, PendingEntry>()
  private disposed = false

  constructor(deps: ChatSocketTransportDeps) {
    this.deps = deps
    this.timeoutMs = deps.timeoutMs ?? LWP_REQUEST_TIMEOUT_MS
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle))
  }

  /** 当前挂起请求数（诊断/测试用）。 */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * 发送一条白名单只读 LWP 请求并等待按 mid 关联的响应。
   * 任何非白名单路由 / 非标准信封 / 无可用 socket 都以结构化错误 reject。
   */
  send(request: LwpRequest, options: { timeoutMs?: number } = {}): Promise<LwpResponse> {
    if (this.disposed) {
      return Promise.reject(new ChatSocketTransportError('NO_SOCKET', 'transport 已释放'))
    }

    const invalid = validateAllowedLwpRequest(request)
    if (invalid) return Promise.reject(invalid)

    const mid = request.headers.mid
    if (this.pending.has(mid)) {
      return Promise.reject(new ChatSocketTransportError('DUPLICATE_MID', `mid 重复: ${mid}`))
    }

    const socket = this.deps.getSocket()
    if (!socket || (socket.readyState !== undefined && socket.readyState !== 1) || typeof socket.send !== 'function') {
      return Promise.reject(new ChatSocketTransportError('NO_SOCKET', '目标聊天 WebSocket 尚未建立'))
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    return new Promise<LwpResponse>((resolve, reject) => {
      const handle = this.setTimer(() => {
        this.pending.delete(mid)
        reject(new ChatSocketTransportError('TIMEOUT', `LWP 请求超时(${timeoutMs}ms): ${request.lwp}`))
      }, timeoutMs)
      this.pending.set(mid, { resolve, reject, handle })

      try {
        // 仅发送白名单信封：request 已通过字段白名单校验，此处序列化即原始只读请求。
        socket.send!(JSON.stringify(request))
      } catch (error) {
        this.clearTimer(handle)
        this.pending.delete(mid)
        reject(new ChatSocketTransportError('SEND_FAILED', `WebSocket 发送失败: ${String(error)}`))
      }
    })
  }

  /**
   * 处理一条来自 WebSocket 的原始文本消息。
   * 若其 `headers.mid` 命中挂起请求，则 resolve 并返回 true；否则返回 false（调用方应把它当实时消息处理）。
   */
  handleMessage(rawText: string): boolean {
    const parsed = parseLwpResponse(rawText)
    if (!parsed) return false
    const mid = parsed.headers?.mid
    if (typeof mid !== 'string') return false
    const entry = this.pending.get(mid)
    if (!entry) return false
    this.clearTimer(entry.handle)
    this.pending.delete(mid)
    entry.resolve(parsed)
    return true
  }

  /** 释放：拒绝所有挂起请求。 */
  dispose(): void {
    this.disposed = true
    for (const [mid, entry] of this.pending) {
      this.clearTimer(entry.handle)
      entry.reject(new ChatSocketTransportError('NO_SOCKET', `transport 已释放，请求 ${mid} 取消`))
    }
    this.pending.clear()
  }
}

/**
 * 把原始文本解析为 LWP 响应（仅当是 JSON 对象且带 headers.mid）。
 * 不是合法结构时返回 null（例如实时聊天消息帧）。
 */
export function parseLwpResponse(rawText: unknown): LwpResponse | null {
  if (typeof rawText !== 'string' || rawText.length === 0) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const headers = parsed['headers']
  if (!isRecord(headers) || typeof headers['mid'] !== 'string') return null
  return parsed as LwpResponse
}

// ---------------- 跨 world 调用约定（MAIN world host ↔ background） ----------------

/**
 * MAIN world 暴露给 background（`chrome.scripting.executeScript`）的 transport host 键名。
 * 两边必须保持一致；host 只暴露 send，不暴露 socket 或任何凭据。
 */
export const CHAT_TRANSPORT_HOST_KEY = '__FISHOPS_CHAT_TRANSPORT__'

/** background 注入调用 MAIN world transport 的统一返回结构。 */
export type ChatTransportHostResponse =
  | { ok: true; response: LwpResponse }
  | { ok: false; error: { code: string; message: string } }
