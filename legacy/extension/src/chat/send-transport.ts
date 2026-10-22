/**
 * P6 发送 socket transport（MAIN world，独立于 P5 只读 transport）。
 *
 * 作用：复用页面**已建立**的闲鱼聊天 WebSocket，发送一条发送类 LWP 请求
 * （`/r/MessageSend/sendByReceiverScope`）并按 `headers.mid` 关联响应。
 *
 * 安全边界（P6 唯一「写 socket 发送聊天消息」的位置，必须收得很紧）：
 * - **独立白名单**：只允许发送路由；**不修改、不放宽** P5 `ChatSocketTransport` 的只读白名单；
 * - 发送前用 {@link validateSendLwpRequest} 深度校验信封（字段、cid、contentType、actualReceivers 双方）；
 * - 按 `headers.mid` 关联响应；超时 10 秒（{@link SEND_TIMEOUT_MS}）；
 * - 不打印消息正文、不访问网络、不直连闲鱼 API。
 *
 * 本文件不直接访问 `window`/`WebSocket` 全局，socket 由外部 `getSocket` 注入，可在 Node 中单测。
 */
import type { LwpRequest, LwpResponse } from '../../../shared/chat/index'
import { SEND_TIMEOUT_MS } from '../../../shared/types/reply'
import type { SendMessageErrorCode } from '../../../shared/types/reply'
import { validateSendLwpRequest } from './send-protocol'
import { parseLwpResponse } from './socket-transport'
import type { WebSocketLike } from './websocket'

/** transport 结构化错误码（与发送错误码共用一套，便于上层归一）。 */
export type ChatSendTransportErrorCode = Extract<
  SendMessageErrorCode,
  'ROUTE_NOT_ALLOWED' | 'INVALID_INPUT' | 'DUPLICATE_MID' | 'NO_SOCKET' | 'SEND_FAILED' | 'TIMEOUT'
>

/** transport 结构化错误（不逃逸到全局）。 */
export class ChatSendTransportError extends Error {
  readonly code: ChatSendTransportErrorCode
  constructor(code: ChatSendTransportErrorCode, message: string) {
    super(message)
    this.name = 'ChatSendTransportError'
    this.code = code
  }
}

/** 计时器句柄（兼容浏览器 number 与 Node Timeout）。 */
type TimerHandle = ReturnType<typeof setTimeout>

export interface ChatSendSocketTransportDeps {
  /** 取当前目标 WebSocket；未连接时返回 null。 */
  getSocket: () => WebSocketLike | null
  /** 默认超时（毫秒），缺省 10 秒。 */
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

/** 发送 transport 接口（供 sender 注入，便于测试）。 */
export interface ChatSendTransport {
  send(request: LwpRequest, options?: { timeoutMs?: number }): Promise<LwpResponse>
}

/** 发送 socket transport。 */
export class ChatSendSocketTransport implements ChatSendTransport {
  private readonly deps: ChatSendSocketTransportDeps
  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void
  private readonly pending = new Map<string, PendingEntry>()
  private disposed = false

  constructor(deps: ChatSendSocketTransportDeps) {
    this.deps = deps
    this.timeoutMs = deps.timeoutMs ?? SEND_TIMEOUT_MS
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle))
  }

  /** 当前挂起请求数（诊断/测试用）。 */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * 发送一条发送类 LWP 请求并等待按 mid 关联的响应。
   * 非发送路由 / 非标准信封 / 无可用 socket 都以结构化错误 reject。
   */
  send(request: LwpRequest, options: { timeoutMs?: number } = {}): Promise<LwpResponse> {
    if (this.disposed) {
      return Promise.reject(new ChatSendTransportError('NO_SOCKET', 'transport 已释放'))
    }

    const invalid = validateSendLwpRequest(request)
    if (invalid) return Promise.reject(new ChatSendTransportError(invalid.code, invalid.message))

    const mid = request.headers.mid
    if (this.pending.has(mid)) {
      return Promise.reject(new ChatSendTransportError('DUPLICATE_MID', `mid 重复: ${mid}`))
    }

    const socket = this.deps.getSocket()
    if (!socket || (socket.readyState !== undefined && socket.readyState !== 1) || typeof socket.send !== 'function') {
      return Promise.reject(new ChatSendTransportError('NO_SOCKET', '目标聊天 WebSocket 尚未建立'))
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    return new Promise<LwpResponse>((resolve, reject) => {
      const handle = this.setTimer(() => {
        this.pending.delete(mid)
        reject(new ChatSendTransportError('TIMEOUT', `发送超时(${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(mid, { resolve, reject, handle })

      try {
        socket.send!(JSON.stringify(request))
      } catch (error) {
        this.clearTimer(handle)
        this.pending.delete(mid)
        reject(new ChatSendTransportError('SEND_FAILED', `WebSocket 发送失败: ${String(error)}`))
      }
    })
  }

  /**
   * 处理一条来自 WebSocket 的原始文本。
   * 命中挂起请求的 mid 时 resolve 并返回 true；否则返回 false（调用方当实时消息处理）。
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
      entry.reject(new ChatSendTransportError('NO_SOCKET', `transport 已释放，请求 ${mid} 取消`))
    }
    this.pending.clear()
  }
}

// ---------------- 跨 world 调用约定（MAIN world host ↔ background） ----------------

/**
 * MAIN world 暴露给 background（`chrome.scripting.executeScript`）的发送 host 键名。
 * 与只读的 `__FISHOPS_CHAT_TRANSPORT__` 相互独立，host 只暴露 send，不暴露 socket / 凭据。
 */
export const CHAT_SEND_HOST_KEY = '__FISHOPS_CHAT_SEND__'

/** background 注入调用 MAIN world 发送 host 的统一返回结构。 */
export type ChatSendHostResponse =
  | { ok: true; response: LwpResponse }
  | { ok: false; error: { code: string; message: string } }
