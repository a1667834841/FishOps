/**
 * goofish 页面 MAIN world 聊天只读入口（P5）。
 *
 * 由 manifest 以 `world: "MAIN"`、`run_at: "document_start"` 注入 goofish 页面：
 * 1. 安装 `installChatWebSocketMonitor`，只读监听目标聊天 WebSocket（不 send、不改变页面行为）；
 * 2. 把原始消息 / 连接状态经 P1 bridge（`window.postMessage` → ISOLATED content → background）
 *    以 `CHAT_SOCKET_EVENT` 命令上报；
 * 3. 把只读 LWP transport 挂到 `window.__FISHOPS_CHAT_TRANSPORT__`，供 background 经
 *    `chrome.scripting.executeScript` 拉取会话/历史（严格白名单，只读两条路由）。
 *
 * 安全：不发送聊天消息、不实现 sender、不打印聊天正文；上报负载只含原始文本（受长度限制）。
 */
import { createCommand, type ChatSocketEventPayload } from '@fishops/shared'
import { wrapPageMessage } from '../../bridge/postmessage-protocol'
import { createChatHost } from '../chat/chat-host'
import { createChatSendHost, installChatSendHost } from '../chat/send-host'
import {
  CHAT_TRANSPORT_HOST_KEY,
  ChatSocketTransportError,
  type ChatTransportHostResponse,
} from '../chat/socket-transport'
import { installChatWebSocketMonitor, type WebSocketLike } from '../chat/websocket'

const LOG_PREFIX = '[FishOps:Chat:MAIN]'

/** 经 P1 bridge 把 socket 事件上报给 background（复用既有 postMessage 协议，不新建通道）。 */
function reportSocketEvent(payload: ChatSocketEventPayload): void {
  try {
    window.postMessage(wrapPageMessage(createCommand('CHAT_SOCKET_EVENT', payload)), window.location.origin)
  } catch {
    // 页面消息通道异常时静默处理，绝不影响页面自身逻辑。
  }
}

/** 组装并安装聊天 host。导出以便在测试/复用场景下注入 mock window。 */
export function installChatHost(win: Window): void {
  let targetSocket: WebSocketLike | null = null
  const host = createChatHost({ report: reportSocketEvent })
  const sendHost = createChatSendHost({ getSocket: () => targetSocket })

  // 发送响应先交给 P6 transport，未命中再进入 P5 只读解析。
  const handlers = {
    ...host.handlers,
    onSocket: (socket: WebSocketLike) => {
      targetSocket = socket
      host.handlers.onSocket?.(socket)
    },
    onMessage: (raw: string, socket: WebSocketLike) => {
      targetSocket = socket
      if (!sendHost.handleMessage(raw)) host.handleSocketMessage(raw)
    },
  }

  // 只读监听 + P6 发送响应复用同一条 WebSocket；失败不影响页面。
  const installed = installChatWebSocketMonitor(handlers)
  if (!installed) {
    console.warn(LOG_PREFIX, '当前环境没有 WebSocket，聊天实时监听未安装')
  }

  // 挂载只读 LWP transport host：只暴露 send，不暴露 socket / 凭据。
  const transportHost = {
    async send(request: unknown, timeoutMs: number): Promise<ChatTransportHostResponse> {
      try {
        const response = await host.transport.send(request as never, { timeoutMs })
        return { ok: true, response }
      } catch (error) {
        const code = error instanceof ChatSocketTransportError ? error.code : 'SEND_FAILED'
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: { code, message } }
      }
    },
  }
  ;(win as unknown as Record<string, unknown>)[CHAT_TRANSPORT_HOST_KEY] = transportHost
  installChatSendHost(win, sendHost)

  console.info(LOG_PREFIX, '聊天 host 已安装（只读监听 + 只读 LWP + 发送 transport）')
}

installChatHost(window)
