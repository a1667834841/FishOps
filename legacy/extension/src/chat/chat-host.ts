/**
 * MAIN world 聊天 host（P5 只读）。
 *
 * 组装三件事，全部只读：
 * 1. 一组 {@link ChatWebSocketMonitorHandlers}：交给 `installChatWebSocketMonitor` 安装到页面，
 *    使 WebSocket 监听与页面其它逻辑解耦、可单测；
 * 2. {@link ChatSocketTransport}：复用目标连接发送白名单只读 LWP 请求（供 history 拉取）；
 * 3. 把实时原始消息 / 连接状态上报给 background（经 P1 bridge 的 `CHAT_SOCKET_EVENT`）。
 *
 * 本文件不接触 `window`；页面挂载与上报通道由 `content/chat-main.ts` 完成，便于 Node 单测。
 */
import { CHAT_SOCKET_MAX_RAW_LENGTH, type ChatSocketEventPayload } from '@fishops/shared'
import { ChatSocketTransport } from './socket-transport'
import { ChatReadSocketTransport } from './read-transport'
import type { ChatSocketStatus, ChatWebSocketMonitorHandlers, WebSocketLike } from './websocket'

export interface ChatHostOptions {
  /** 上报一条 socket 事件给 background。 */
  report: (payload: ChatSocketEventPayload) => void
  /** 时间源，便于测试。 */
  now?: () => number
  /** LWP 请求超时（毫秒）。 */
  timeoutMs?: number
  /** 计时器注入，便于测试。 */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

export interface ChatHost {
  readonly transport: ChatSocketTransport
  readonly readTransport: ChatReadSocketTransport
  /** 读取当前 transport 复用连接的真实状态；未捕获连接时返回 null。 */
  getSocketStatus(): ChatSocketStatus | null
  /** 传给 `installChatWebSocketMonitor` 的只读监听回调。 */
  readonly handlers: ChatWebSocketMonitorHandlers
  /** 记录 monitor 检测到的目标 socket，供 transport 复用。 */
  attachSocket(socket: WebSocketLike): void
  /** 处理一条 socket 原始文本：优先喂给只读 transport，否则作为实时消息上报。 */
  handleSocketMessage(raw: string): void
  /** 上报连接状态。 */
  reportStatus(status: ChatSocketStatus): void
  /** 释放 transport（monitor 的释放由 installed.dispose 负责）。 */
  dispose(): void
}

/** 状态 → background 可识别的 socket 事件名（connecting 由 background 默认值表示）。 */
function statusToEvent(status: ChatSocketStatus): ChatSocketEventPayload['event'] | null {
  switch (status) {
    case 'open':
      return 'open'
    case 'closed':
      return 'close'
    case 'error':
      return 'error'
    case 'connecting':
    default:
      return null
  }
}

/** 创建 MAIN world 聊天 host。 */
export function createChatHost(options: ChatHostOptions): ChatHost {
  const now = options.now ?? (() => Date.now())
  let socket: WebSocketLike | null = null
  let connectedAt = now()

  const transport = new ChatSocketTransport({
    getSocket: () => socket,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.setTimer === undefined ? {} : { setTimer: options.setTimer }),
    ...(options.clearTimer === undefined ? {} : { clearTimer: options.clearTimer }),
  })

  const readTransport = new ChatReadSocketTransport({ getSocket: () => socket })

  const reportStatus = (status: ChatSocketStatus): void => {
    const event = statusToEvent(status)
    if (!event) return
    options.report({ event, at: now() })
  }

  const handleSocketMessage = (raw: string): void => {
    // 先尝试作为 LWP 响应消化（history 请求）；命中则不再上报。
    if (transport.handleMessage(raw) || readTransport.handleMessage(raw)) return
    // 实时消息：仅在长度受限时上报原文，超限帧直接丢弃，避免拖垮 background。
    const tooLarge = raw.length > CHAT_SOCKET_MAX_RAW_LENGTH
    options.report({
      event: 'message',
      connectedAt,
      ...(tooLarge ? {} : { raw }),
      at: now(),
    })
  }

  const handlers: ChatWebSocketMonitorHandlers = {
    onMessage: handleSocketMessage,
    onOpen: () => {
      connectedAt = now()
      reportStatus('open')
    },
    onClose: (info) =>
      options.report({
        event: 'close',
        code: info.code,
        ...(info.reason ? { reason: info.reason } : {}),
        at: now(),
      }),
    onError: () => reportStatus('error'),
    onSocket: (detected) => {
      if (socket !== detected) connectedAt = now()
      socket = detected
    },
  }

  return {
    transport,
    readTransport,
    getSocketStatus: () => {
      if (!socket) return null
      if (socket.readyState === 1) return 'open'
      if (socket.readyState === 0) return 'connecting'
      return 'closed'
    },
    handlers,
    attachSocket: (next) => {
      if (socket !== next) connectedAt = now()
      socket = next
    },
    handleSocketMessage,
    reportStatus,
    dispose: () => {
      transport.dispose()
      readTransport.dispose()
    },
  }
}
