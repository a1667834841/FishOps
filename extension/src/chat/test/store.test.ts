/**
 * store.ts 单元测试：去重、排序、会话隔离、持久化接口（纯 Node）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatMessage, Conversation } from '../../../../shared/types/chat'
import { ChatStore, MemoryChatPersistence } from '../store'

function msg(partial: Partial<ChatMessage> & { sessionId: string; createAt: number }): ChatMessage {
  return {
    id: '',
    messageId: '',
    senderId: '999',
    senderName: '买家',
    receiverId: '111',
    direction: 'in',
    kind: 'text',
    contentType: 1,
    content: '',
    source: 'history',
    cid: `${partial.sessionId}@goofish`,
    ...partial,
  }
}

function conv(sessionId: string, sortIndex: number, lastMessageTime = sortIndex): Conversation {
  return {
    sessionId,
    cid: `${sessionId}@goofish`,
    peerUserName: `用户${sessionId}`,
    lastMessage: 'hi',
    lastMessageTime,
    unreadCount: 0,
    sortIndex,
    visible: true,
  }
}

test('去重：相同 messageId 只保留一条', () => {
  const store = new ChatStore()
  const first = store.upsertMessages([msg({ sessionId: '1', createAt: 100, messageId: 'm1', content: '旧' })])
  const second = store.upsertMessages([msg({ sessionId: '1', createAt: 100, messageId: 'm1', content: '新' })])
  assert.deepEqual(first, { added: 1, updated: 0 })
  assert.deepEqual(second, { added: 0, updated: 1 })
  assert.equal(store.messageCount, 1)
  assert.equal(store.getMessages('1')[0].content, '新')
})

test('去重：无 messageId 时用指纹（会话+发送者+时间+内容）', () => {
  const store = new ChatStore()
  store.upsertMessages([msg({ sessionId: '1', createAt: 100, content: 'same' })])
  store.upsertMessages([msg({ sessionId: '1', createAt: 100, content: 'same' })])
  assert.equal(store.messageCount, 1)
  store.upsertMessages([msg({ sessionId: '1', createAt: 100, content: 'different' })])
  assert.equal(store.messageCount, 2)
})

test('排序：默认按 createAt 升序，desc 反向', () => {
  const store = new ChatStore()
  store.upsertMessages([
    msg({ sessionId: '1', createAt: 300, messageId: 'c' }),
    msg({ sessionId: '1', createAt: 100, messageId: 'a' }),
    msg({ sessionId: '1', createAt: 200, messageId: 'b' }),
  ])
  assert.deepEqual(
    store.getMessages('1').map((m) => m.messageId),
    ['a', 'b', 'c'],
  )
  assert.deepEqual(
    store.getMessages('1', { order: 'desc', limit: 2 }).map((m) => m.messageId),
    ['c', 'b'],
  )
})

test('会话隔离：按 sessionId 查询互不串扰', () => {
  const store = new ChatStore()
  store.upsertMessages([
    msg({ sessionId: '1', createAt: 100, messageId: 'a1' }),
    msg({ sessionId: '2', createAt: 200, messageId: 'b1' }),
  ])
  assert.deepEqual(
    store.getMessages('1').map((m) => m.messageId),
    ['a1'],
  )
  assert.deepEqual(
    store.getMessages('2').map((m) => m.messageId),
    ['b1'],
  )
  assert.equal(store.getMessages('3').length, 0)
  assert.equal(store.messageCount, 2)
})

test('会话：upsert 与按 sortIndex 降序排列', () => {
  const store = new ChatStore()
  const r1 = store.upsertConversations([conv('1', 100), conv('2', 300)])
  assert.deepEqual(r1, { added: 2, updated: 0 })
  const r2 = store.upsertConversations([conv('1', 400)])
  assert.deepEqual(r2, { added: 0, updated: 1 })
  assert.deepEqual(
    store.listConversations().map((c) => c.sessionId),
    ['1', '2'],
  )
  assert.equal(store.sessionCount, 2)
})

test('持久化接口：init 从持久化实现载入', async () => {
  const persistence = new MemoryChatPersistence()
  const store1 = new ChatStore(persistence)
  store1.upsertMessages([msg({ sessionId: '1', createAt: 100, messageId: 'm1', content: 'persisted' })])
  store1.upsertConversations([conv('1', 100)])
  // 等待异步 flush 完成
  await new Promise((resolve) => setTimeout(resolve, 0))

  const store2 = new ChatStore(persistence)
  await store2.init()
  assert.equal(store2.messageCount, 1)
  assert.equal(store2.getMessages('1')[0].content, 'persisted')
  assert.equal(store2.sessionCount, 1)
})

test('compareMessages 稳定：同一 createAt 按 messageId 排序', () => {
  const store = new ChatStore()
  store.upsertMessages([
    msg({ sessionId: '1', createAt: 100, messageId: 'z' }),
    msg({ sessionId: '1', createAt: 100, messageId: 'a' }),
  ])
  assert.deepEqual(
    store.getMessages('1').map((m) => m.messageId),
    ['a', 'z'],
  )
})
