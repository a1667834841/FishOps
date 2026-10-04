import type { ChatSocketStatus } from './websocket'

/** 读取 MAIN world 的连接快照，补偿 background 重启或 bridge 未就绪时丢失的事件。 */
export function probeChatSocketInPage(): ChatSocketStatus | null {
  const page = globalThis as {
    __FISHOPS_CHAT_TRANSPORT__?: { getSocketStatus?: () => unknown }
  }
  const status = page.__FISHOPS_CHAT_TRANSPORT__?.getSocketStatus?.()
  return status === 'open' || status === 'connecting' || status === 'closed' || status === 'error'
    ? status
    : null
}
