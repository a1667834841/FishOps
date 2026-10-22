import { CHAT_NOTICE } from './chat-notice.ts'
import { createChatCollector } from './chat-collector.ts'
import { createChatPageSource } from './chat-page-source.ts'
import { createChromePageContext } from './page-context.ts'
import type { NativeBridge } from './connection.ts'
import type { PageBootstrapScripting } from './page-bootstrap.ts'

/** 通知只定位 Chrome 主文档；首次安装扫描已有页面，所有采集只读页面本地队列。 */
export function installChatWakeup(bridge: NativeBridge, scripting: PageBootstrapScripting): void {
  const active = new Map<string, { dirty: boolean }>()
  const validUrl = (value: string) => {
    try {
      const url = new URL(value)
      return url.origin === 'https://www.goofish.com' && !url.username && !url.password
    } catch { return false }
  }
  const context = createChromePageContext(async () => {
    const cookie = await chrome.cookies.get({ url: 'https://www.goofish.com/', name: 'unb' })
    return cookie?.value || null
  }, async () => [], async () => [])

  function wake(tabId: number, documentId: string): void {
    const key = `${tabId}:${documentId}`
    const existing = active.get(key)
    if (existing) { existing.dirty = true; return }
    const state = { dirty: false }
    active.set(key, state)
    void (async () => {
      const expected = await context.bind(tabId)
      if (expected.documentId !== documentId) return
      const collector = createChatCollector({
        source: createChatPageSource({ context, scripting }, expected),
        persist: message => bridge.ingestChatMessage(expected.accountId, message),
        gap: occurrence => bridge.reportChatGap(expected.accountId, 'PAGE_GAP', occurrence),
      })
      let more: boolean
      do {
        state.dirty = false
        more = false
        for (let batch = 0; batch < 10; batch++) {
          more = await collector.collect() === 100
          if (!more) break
        }
        // 满批意味着可能仍有消息；让出事件循环后继续，不依赖页面再次通知。
        // 同时保留采集期间的通知，即使本轮返回短批次也必须再读一次。
        if (more || state.dirty) await new Promise<void>(resolve => setTimeout(resolve, 0))
      } while (more || state.dirty)
    })().catch(() => { console.warn('页面聊天采集未完成') }).finally(() => active.delete(key))
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).length !== 1 || message.kind !== CHAT_NOTICE ||
      sender.id !== chrome.runtime.id || sender.frameId !== 0 || typeof sender.documentId !== 'string' || !sender.documentId.trim() ||
      !Number.isSafeInteger(sender.tab?.id) || sender.tab!.id! < 0 || !validUrl(sender.url ?? '')) return
    wake(sender.tab!.id!, sender.documentId)
  })

  // SW 重建可能错过 content 首次通知；仅扫描已有主站 tab，不打开页面或建立连接。
  void (async () => {
    const tabs = await chrome.tabs.query({ url: 'https://www.goofish.com/*' })
    await Promise.all(tabs.map(async tab => {
      if (!Number.isSafeInteger(tab.id) || tab.id! < 0) return
      try {
        const frame = await chrome.webNavigation.getFrame({ tabId: tab.id!, frameId: 0 })
        if (frame?.documentId && validUrl(frame.url)) wake(tab.id!, frame.documentId)
      } catch { console.warn('页面聊天恢复未完成') }
    }))
  })().catch(() => { console.warn('页面聊天恢复未完成') })
}
