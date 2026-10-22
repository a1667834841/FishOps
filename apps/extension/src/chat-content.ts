import { CHAT_NOTICE } from './chat-notice.ts'

// MAIN 通知不携带数据；不接受子 frame、其他 origin 或任意方法转发。
let pending = false
window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== 'https://www.goofish.com' || event.data !== CHAT_NOTICE || pending) return
  pending = true
  setTimeout(() => {
    pending = false
    void chrome.runtime.sendMessage({ kind: CHAT_NOTICE }).catch(() => {})
  }, 100)
})
// SW 可能先于 content script 启动；一次本地唤醒补齐首次队列，不产生平台请求。
void chrome.runtime.sendMessage({ kind: CHAT_NOTICE }).catch(() => {})
