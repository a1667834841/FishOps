import type { OutboxStorage, OutboxState } from './chat-outbox.ts'

const KEY = 'fishops.chat.outbox.v1'
/** 只使用扩展本地存储，消息不进入 sync，也不暴露给 content script。 */
export function createChromeChatStorage(): OutboxStorage {
  let initialized: Promise<void> | undefined
  const ready = () => initialized ??= chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  return {
    async read() {
      await ready()
      const value = await chrome.storage.local.get(KEY)
      return value[KEY]
    },
    async write(value: OutboxState) {
      await ready()
      await chrome.storage.local.set({ [KEY]: value })
    },
  }
}
