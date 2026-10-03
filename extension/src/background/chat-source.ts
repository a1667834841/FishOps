/**
 * 聊天 socket 上报的来源校验（P5）。
 *
 * `CHAT_SOCKET_EVENT` 只允许来自本扩展、且来自 goofish 页面 content script 的消息，
 * 避免扩展内页（Workbench）或其它来源伪造原始 WebSocket 数据。抽成纯函数便于单测。
 */
import { isGoofishUrl } from './tab-manager'

/** `chrome.runtime.MessageSender` 的最小子集。 */
export interface ChatMessageSenderLike {
  /** 发送方扩展 id（必须等于本扩展）。 */
  id?: string
  /** 发送方页面 URL（content script 通常有）。 */
  url?: string
  /** 发送方所在 tab（content script 一定存在）。 */
  tab?: { id?: number; url?: string } | undefined
}

/** 是否为可信的 goofish content script 来源。 */
export function isTrustedChatContentSource(sender: ChatMessageSenderLike, extensionId: string): boolean {
  if (sender.id !== extensionId) return false
  if (sender.tab?.id === undefined) return false
  return isGoofishUrl(sender.url ?? sender.tab.url)
}
