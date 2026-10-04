/**
 * session-persistence.ts 单元测试：去重、字段白名单（不存 raw/base64）与容量上限。
 * 纯 Node，使用内存 fake storage。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatMessage, Conversation } from '../../../../shared/types/chat'
import {
  CHAT_CONVERSATIONS_KEY,
  CHAT_MESSAGES_KEY,
  SessionChatPersistence,
  type StorageAreaLike,
} from '../session-persistence'
import { ChatStore } from '../store'

function fakeStorage(): StorageAreaLike & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    async get(key) {
      return data.has(key) ? { [key]: data.get(key) } : {}
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value)
    },
  }
}

function msg(messageId: string, createAt: number, content: string): ChatMessage {
  return {
    id: `mid:${messageId}`,
    messageId,
    sessionId: 's1',
    cid: 's1@goofish',
    senderId: '1',
    senderName: 'a',
    receiverId: '2',
    direction: 'in',
    kind: 'text',
    contentType: 1,
    content,
    createAt,
    source: 'realtime',
  }
}

function conv(sessionId: string, sortIndex: number): Conversation {
  return {
    sessionId,
    cid: `${sessionId}@goofish`,
    peerUserName: '买家',
    lastMessage: 'hi',
    lastMessageTime: sortIndex,
    unreadCount: 0,
    sortIndex,
    visible: true,
  }
}

test('消息 upsert：相同 messageId 去重并覆盖内容', async () => {
  const storage = fakeStorage()
  const persistence = new SessionChatPersistence(storage)
  await persistence.saveMessages([msg('m1', 1, '旧')])
  await persistence.saveMessages([msg('m1', 1, '新')])
  const loaded = await persistence.loadMessages()
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].content, '新')
})

test('字段白名单：额外字段（如 rawBase64）不写入存储', async () => {
  const storage = fakeStorage()
  const persistence = new SessionChatPersistence(storage)
  const dirty = { ...msg('m1', 1, 'hi'), rawBase64: 'AAAA', cookie: 'session=secret' } as ChatMessage
  await persistence.saveMessages([dirty])
  const loaded = await persistence.loadMessages()
  assert.equal('rawBase64' in loaded[0], false)
  assert.equal('cookie' in loaded[0], false)
  assert.equal(JSON.stringify(storage.data.get(CHAT_MESSAGES_KEY)).includes('secret'), false)
})

test('容量上限：只保留最新的 maxMessages 条', async () => {
  const storage = fakeStorage()
  const persistence = new SessionChatPersistence(storage, { maxMessages: 2 })
  await persistence.saveMessages([msg('m1', 1, 'a'), msg('m2', 2, 'b'), msg('m3', 3, 'c')])
  const loaded = await persistence.loadMessages()
  assert.deepEqual(
    loaded.map((m) => m.createAt),
    [2, 3],
  )
})

test('字段白名单：保留 senderAvatarUrl，保存/加载不丢头像', async () => {
  const storage = fakeStorage()
  const persistence = new SessionChatPersistence(storage)
  const withAvatar: ChatMessage = {
    ...msg('m1', 1, 'hi'),
    senderAvatarUrl: 'https://img.example.com/sender.png',
  }
  await persistence.saveMessages([withAvatar])
  const loaded = await persistence.loadMessages()
  assert.equal(loaded[0].senderAvatarUrl, 'https://img.example.com/sender.png')
})

test('回归：ChatStore.init 从持久化恢复后消息头像不丢', async () => {
  const storage = fakeStorage()
  const persistence = new SessionChatPersistence(storage)
  const store = new ChatStore(persistence)
  store.upsertMessages([
    { ...msg('m1', 1, 'hi'), senderAvatarUrl: 'https://img.example.com/sender.png' },
  ])
  await store.flush()

  const restored = new ChatStore(persistence)
  await restored.init()
  const [message] = restored.getMessages('s1')
  assert.equal(message.senderAvatarUrl, 'https://img.example.com/sender.png')
})

test('会话 upsert：去重并按上限截断', async () => {
  const storage = fakeStorage()
  const persistence = new SessionChatPersistence(storage, { maxConversations: 1 })
  await persistence.saveConversations([conv('s1', 1), conv('s2', 2)])
  await persistence.saveConversations([conv('s1', 3)])
  const loaded = await persistence.loadConversations()
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].sessionId, 's1')
  assert.equal(loaded[0].sortIndex, 3)
  assert.ok(storage.data.has(CHAT_CONVERSATIONS_KEY))
})
