/** 页面通知仅是唤醒提示，不传输正文；实际消息仍从固定文档读取并验证。 */
export const CHAT_NOTICE = 'fishops.chat.available.v1'

/** 限制通知风暴；只通知本页面，不触发平台网络。 */
export function createChatNotice(notify: () => void, schedule: (callback: () => void) => void) {
  let pending = false, stopped = false
  return {
    signal() {
      if (pending || stopped) return
      pending = true
      schedule(() => {
        pending = false
        if (!stopped) notify()
      })
    },
    dispose() { stopped = true },
  }
}
