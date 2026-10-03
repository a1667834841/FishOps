/**
 * 命令与长连接的来源策略（background）。
 *
 * 关键安全前提：content script 的 `sender.id` 同样等于本扩展 id，
 * 仅校验 `sender.id === chrome.runtime.id` 无法区分「扩展内页」与「注入到网页的 content script」，
 * 会造成 content script（乃至被注入页面）借扩展权限调用高权限命令（PLATFORM_CALL /
 * CHAT_GET_MESSAGES / PUBLISH 等）。因此本模块把两类来源严格区分：
 *
 * - 扩展内页（Workbench，`chrome-extension://<本扩展 ID>/...`）：可调用普通 Workbench 命令，
 *   也可建立事件订阅长连接；
 * - goofish content script：**只**允许上报受限的 CHAT_SOCKET_EVENT（由 chat-source 单独校验），
 *   不接受任何普通命令，也不允许建立订阅长连接（防止事件泄露到页面）。
 */

/** `chrome.runtime.MessageSender` 的最小子集（`port.sender` 可能为空）。 */
export interface MessageSenderLike {
  /** 发送方扩展 id。 */
  id?: string
  /** 发送方页面 URL（由浏览器填写，无法伪造）。 */
  url?: string
  /** 发送方页面的 origin（扩展页为 `chrome-extension://<id>`）。 */
  origin?: string
  /**
   * 发送方所在 tab。
   *
   * 注意：**扩展内页在 tab 中打开时同样会带 tab**（`tab.url` 即扩展页 URL），
   * 因此不能用「有无 tab」来区分扩展内页与 content script。
   */
  tab?: { id?: number; url?: string } | undefined
}

/** 本扩展页面的 URL 前缀，例如 `chrome-extension://<id>/`。 */
export function extensionPageUrlPrefix(extensionId: string): string {
  return `chrome-extension://${extensionId}/`
}

/**
 * 是否为「本扩展内页」来源。
 *
 * 判定要求：
 * 1. `sender.id` 等于本扩展 id；
 * 2. `sender.url` 以 `chrome-extension://<本扩展 id>/` 开头（少数上下文只带 origin 时回退到同源判断）。
 *
 * 关键：**不能用「是否携带 `sender.tab`」来区分扩展内页与 content script**。
 * 真实 Chrome 中，通过 `chrome-extension://<id>/workbench.html` 打开的扩展内页位于 tab 内，
 * `sender.tab` 会被填充（`tab.url` 同为扩展页 URL）；用 tab 判定会把扩展内页误拒为 content script，
 * 导致命令无响应（`The message port closed before a response was received`）。
 *
 * 安全性由 url / origin 保证：content script 的 `sender.url` / `sender.origin` 是宿主页面
 * （`https://www.goofish.com/...`），由浏览器填写、无法伪造，因此只有本扩展页面
 * 才会以 `chrome-extension://<本扩展 id>/` 作为 url/origin。
 */
export function isExtensionPageSender(
  sender: MessageSenderLike | undefined,
  extensionId: string,
): boolean {
  if (!sender) return false
  if (sender.id !== extensionId) return false
  if (typeof sender.url === 'string' && sender.url.startsWith(extensionPageUrlPrefix(extensionId))) {
    return true
  }
  // 少数上下文可能只暴露 origin（不带路径），同样只接受本扩展来源。
  return sender.origin === `chrome-extension://${extensionId}`
}
