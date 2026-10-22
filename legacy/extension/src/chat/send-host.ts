/**
 * MAIN world 发送 host（P6）。
 *
 * 与只读 `chat-host.ts` 对称，但只负责「发送」：
 * - 组装 {@link ChatSendSocketTransport}，复用页面已建立的聊天 WebSocket；
 * - 把 transport 挂到 `window.__FISHOPS_CHAT_SEND__`，供 background 经
 *   `chrome.scripting.executeScript({ world: 'MAIN' })` 调用。
 *
 * 安全：host 只暴露 `send`，不暴露 socket、不暴露凭据；仅接受发送白名单信封。
 */
import type { LwpRequest } from '../../../shared/chat/index'
import {
  CHAT_SEND_HOST_KEY,
  ChatSendSocketTransport,
  ChatSendTransportError,
  type ChatSendHostResponse,
} from './send-transport'
import type { WebSocketLike } from './websocket'

export interface ChatSendHostOptions {
  /** 取目标 WebSocket（通常来自 P5 的 WebSocket 监听）。 */
  getSocket: () => WebSocketLike | null
  /** 发送超时（毫秒）。 */
  timeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

export interface ChatSendHost {
  readonly transport: ChatSendSocketTransport
  /** 处理一条原始文本：命中发送响应返回 true，否则 false（交给只读/实时链路）。 */
  handleMessage(raw: string): boolean
  dispose(): void
}

/** 创建 MAIN world 发送 host。 */
export function createChatSendHost(options: ChatSendHostOptions): ChatSendHost {
  const transport = new ChatSendSocketTransport({
    getSocket: options.getSocket,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
    ...(options.clearTimer === undefined ? {} : { clearTimer: options.clearTimer }),
  })
  return {
    transport,
    handleMessage: (raw) => transport.handleMessage(raw),
    dispose: () => transport.dispose(),
  }
}

/**
 * 把发送 host 挂到页面全局（`window.__FISHOPS_CHAT_SEND__`）。
 * 只暴露 `send(request, timeoutMs)`；payload 由 transport 再次校验后才会落 socket。
 */
export function installChatSendHost(win: unknown, host: ChatSendHost): void {
  const target = win as Record<string, unknown>
  target[CHAT_SEND_HOST_KEY] = {
    async send(request: unknown, timeoutMs: number): Promise<ChatSendHostResponse> {
      try {
        const response = await host.transport.send(request as LwpRequest, { timeoutMs })
        return { ok: true, response }
      } catch (error) {
        const code = error instanceof ChatSendTransportError ? error.code : 'SEND_FAILED'
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: { code, message } }
      }
    },
  }
}
