/**
 * ISOLATED world content script：页面侧 ↔ 扩展 background 的桥。
 *
 * 链路：MAIN world / 页面 → window.postMessage(PageBridgeEnvelope) → 本脚本 →
 *       chrome.runtime.sendMessage → background → 回程。
 *
 * 安全边界（重要）：
 * 本桥运行在普通网页上下文可触达的位置，若把任意 `CommandEnvelope` 转发给 background，
 * 页面就能借扩展权限调用 `PLATFORM_CALL` / `CHAT_GET_MESSAGES` / `PUBLISH` 等高权限命令。
 * 因此这里**只放行** goofish 页面 MAIN world 主动上报的受限 `CHAT_SOCKET_EVENT`：
 * - 校验 `event.source === window`、`event.origin` 与页面同源、页面 host 属于 goofish；
 * - 校验包裹信封与命令类型（必须是 CHAT_SOCKET_EVENT）；
 * - 对 payload 做运行时结构校验（`isChatSocketEventPayload`，含长度上限）。
 *
 * Workbench 若以扩展内页（chrome-extension://）打开会直接使用 chrome.runtime，
 * 不经过本桥；本桥仅用于 goofish 页面的只读 socket 上报。
 */
import {
  CommandTypes,
  isChatSocketEventPayload,
  isCommandEnvelope,
  isResponseEnvelope,
  type CommandEnvelope,
} from '@fishops/shared'
import { unwrapPageMessage, wrapPageMessage } from '../../bridge/postmessage-protocol'

const LOG_PREFIX = '[FishOps:Bridge:ISOLATED]'

const GOOFISH_HOST = 'goofish.com'

/** 页面 host 是否属于 goofish（含子域），且可被解析。 */
function isGoofishLocation(href: string): boolean {
  try {
    const { hostname } = new URL(href)
    return hostname === GOOFISH_HOST || hostname.endsWith('.' + GOOFISH_HOST)
  } catch {
    return false
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  // 只接受本窗口、同源的页面消息，拒绝 iframe / 其它 origin 的注入。
  if (event.source !== window) return
  if (event.origin !== window.location.origin) return
  if (!isGoofishLocation(window.location.href)) return

  const envelope = unwrapPageMessage(event.data)
  if (!envelope) return

  const message = envelope.message
  if (!isCommandEnvelope(message)) return

  // 仅放行页面上报的受限 socket 事件；其它命令一律不转发（防止权限提升）。
  if (message.type !== CommandTypes.CHAT_SOCKET_EVENT) return
  if (!isChatSocketEventPayload(message.payload)) return

  void forwardCommand(message)
})

async function forwardCommand(command: CommandEnvelope): Promise<void> {
  try {
    const response: unknown = await chrome.runtime.sendMessage(command)
    if (!isResponseEnvelope(response)) {
      console.warn(LOG_PREFIX, 'background 返回了非法响应', response)
      return
    }
    window.postMessage(wrapPageMessage(response), window.location.origin)
  } catch (error) {
    console.error(LOG_PREFIX, '转发命令失败', error)
  }
}

console.info(LOG_PREFIX, 'isolated bridge 已加载（仅放行 CHAT_SOCKET_EVENT）')
