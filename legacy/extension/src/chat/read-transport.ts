/** 闲鱼会话已读的独立受控写 transport；不扩展历史读取白名单。 */
import { createLwpRequest, generateMid, LWP_REQUEST_TIMEOUT_MS, LWP_ROUTES, toFullCid, type LwpResponse } from '../../../shared/chat/index'

export interface ChatReadTransport {
  markRead(sessionId: string, messageId: string): Promise<LwpResponse>
}

const ID_MAX = 256

export function isServerMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ID_MAX && !/^uuid:|^fp:/i.test(value)
}

export function createChatReadRequest(sessionId: string, messageId: string, mid: string) {
  if (typeof sessionId !== 'string' || !/^[^@\s]{1,128}$/.test(sessionId) || !isServerMessageId(messageId)) {
    throw new Error('已读请求参数非法')
  }
return createLwpRequest(LWP_ROUTES.clearRedPoint, [[{ cid: toFullCid(sessionId), messageId }]], mid)
}

export interface ChatReadSocket {
  readyState?: number
  send?: (data: string) => void
}

export interface ChatReadTransportOptions {
  getSocket: () => ChatReadSocket | null
  midFactory?: () => string
  timeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

interface PendingRead {
  resolve: (response: LwpResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** 独立已读 socket transport，拥有独立且只含 clearRedPoint 的写路由白名单。 */
export class ChatReadSocketTransport implements ChatReadTransport {
  private readonly pending = new Map<string, PendingRead>()
  private readonly options: ChatReadTransportOptions

  constructor(options: ChatReadTransportOptions) { this.options = options }

  markRead(sessionId: string, messageId: string): Promise<LwpResponse> {
    const socket = this.options.getSocket()
    if (!socket || (socket.readyState !== undefined && socket.readyState !== 1) || typeof socket.send !== 'function') {
      return Promise.reject(new Error('聊天 WebSocket 未连接'))
    }
    if (!isServerMessageId(messageId)) return Promise.reject(new Error('缺少有效的服务端 messageId'))
    // 平台 LWP 使用数字请求 ID 加空格标志；自定义 read- 前缀不符合原生请求格式。
    const mid = this.options.midFactory?.() ?? generateMid()
    if (this.pending.has(mid)) return Promise.reject(new Error('已读请求 mid 重复'))
    const request = createChatReadRequest(sessionId, messageId, mid)
    const timeoutMs = this.options.timeoutMs ?? LWP_REQUEST_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      const timer = (this.options.setTimer ?? ((fn, ms) => setTimeout(fn, ms)))(() => {
        this.pending.delete(mid)
        reject(new Error('平台已读请求超时'))
      }, timeoutMs)
      this.pending.set(mid, { resolve, reject, timer })
      try { socket.send!(JSON.stringify(request)) } catch (error) {
        ;(this.options.clearTimer ?? clearTimeout)(timer)
        this.pending.delete(mid)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  dispose(): void {
    for (const [mid, pending] of this.pending) {
      (this.options.clearTimer ?? clearTimeout)(pending.timer)
      pending.reject(new Error(`已读请求 ${mid} 已取消`))
    }
    this.pending.clear()
  }

  handleMessage(raw: string): boolean {
    let response: unknown
    try { response = JSON.parse(raw) } catch { return false }
    if (!isPlainRecord(response) || !isPlainRecord(response['headers']) || typeof response['headers']['mid'] !== 'string') return false
    const mid = response['headers']['mid'] as string
    const pending = this.pending.get(mid)
    if (!pending) return false
    this.pending.delete(mid)
    ;(this.options.clearTimer ?? clearTimeout)(pending.timer)
    pending.resolve(response as LwpResponse)
    return true
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
