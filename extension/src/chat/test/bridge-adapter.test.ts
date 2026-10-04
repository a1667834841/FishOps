/**
 * bridge-adapter.ts 单元测试：P1 兼容命令处理与事件队列（纯 Node）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatBridgeAdapter, ChatBridgeCommands, ChatBridgeEvents } from '../bridge-adapter'
import { ChatStore } from '../store'
import type { Conversation } from '../../../../shared/types/chat'

import { ChatSync } from '../sync'

const b64 = (text: string): string => Buffer.from(text, 'utf-8').toString('base64')

function realtimePayload(sessionId: string, text: string, messageId: string): string {
  return JSON.stringify({
    code: 200,
    body: {
      content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text } })) } },
      extension: { senderUserId: '999', reminderUrl: `https://x?sid=${sessionId}&peerUserId=999` },
      createAt: 1000,
      messageId,
    },
  })
}

function makeAdapter(markRead?: (request: { lwp: string; body: unknown[] }) => Promise<{ code?: number }>): ChatBridgeAdapter {
  const store = new ChatStore()
  const sync = new ChatSync({ store })
  let counter = 0
  return new ChatBridgeAdapter({
    sync,
    store,
    ...(markRead
      ? {
          readTransport: {
            markRead: async (sessionId: string, messageId: string) => {
              const response = await markRead({
                lwp: '/r/Conversation/clearRedPoint',
                body: [[{ cid: `${sessionId}@goofish`, messageId }]],
              })
              return { code: response.code }
            },
          },
        }
      : {}),
    now: () => 1000,
    genEventId: () => `e${++counter}`,
  })
}

test('CHAT_MARK_READ：使用缓存服务端 messageId 构造精确 clearRedPoint body，服务器成功后更新未读', async () => {
  const requests: Array<{ lwp: string; body: unknown[] }> = []
  const adapter = makeAdapter(async (request) => {
    requests.push(request)
    return { code: 200 }
  })
  adapter.ingestRealtime(realtimePayload('123', '你好', 'server-message-1'))
  // 补入后台已同步会话，才能执行该会话已读。
  adapter.ingestRealtime(realtimePayload('123', '再见', 'server-message-2'))
  const store = (adapter as unknown as { store: ChatStore }).store
  store.upsertConversations([{ sessionId: '123', cid: '123@goofish', peerUserName: '买家', lastMessage: '再见', lastMessageTime: 2, unreadCount: 1, sortIndex: 2, visible: true } satisfies Conversation])
  const response = await adapter.handleCommand({
    kind: 'command', requestId: 'read-1', type: 'CHAT_MARK_READ',
    payload: { sessionId: '123' },
  })
  assert.equal(response.ok, true)
  assert.equal((response.result as { ok: boolean }).ok, true)
  const updated = (adapter as unknown as { store: ChatStore }).store.getConversation('123')
  assert.equal(updated?.unreadCount, 0)
  assert.deepEqual(requests, [{
    lwp: '/r/Conversation/clearRedPoint',
    body: [[{ cid: '123@goofish', messageId: 'server-message-2' }]],
  }])
})

test('CHAT_MARK_READ：平台失败保留未读数且不广播更新', async () => {
  const adapter = makeAdapter(async () => ({ code: 500 }))
  adapter.ingestRealtime(realtimePayload('123', '你好', 'server-message'))
  const store = (adapter as unknown as { store: ChatStore }).store
  store.upsertConversations([{ sessionId: '123', cid: '123@goofish', peerUserName: '买家', lastMessage: '你好', lastMessageTime: 1, unreadCount: 3, sortIndex: 1, visible: true }])
  const response = await adapter.handleCommand({ kind: 'command', requestId: 'read-fail', type: 'CHAT_MARK_READ', payload: { sessionId: '123' } })
  assert.equal(response.ok, true)
  assert.equal((response.result as { ok: boolean }).ok, false)
  assert.equal(store.getConversation('123')?.unreadCount, 3)
  assert.equal(adapter.drainEvents().some((event) => event.type === ChatBridgeEvents.CHAT_CONVERSATION_UPDATED), false)
})

test('CHAT_MARK_READ：缺少写 transport 时失败而不伪报成功', async () => {
  const adapter = makeAdapter()
  const store = (adapter as unknown as { store: ChatStore }).store
  store.upsertConversations([{ sessionId: '123', cid: '123@goofish', peerUserName: '买家', lastMessage: '', lastMessageTime: 1, unreadCount: 1, sortIndex: 1, visible: true }])
  const response = await adapter.handleCommand({
    kind: 'command', requestId: 'read-2', type: 'CHAT_MARK_READ',
    payload: { sessionId: '123' },
  })
  assert.equal(response.ok, true)
  assert.equal((response.result as { ok: boolean }).ok, false)
})

test('CHAT_MARK_READ：ACK 延迟期间新入站到达，只确认原水位、不清新消息未读', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const requests: Array<{ lwp: string; body: unknown[] }> = []
  const adapter = makeAdapter(async (request) => {
    requests.push(request)
    await gate
    return { code: 200 }
  })
  adapter.ingestRealtime(realtimePayload('123', '第一条', 'server-message-1'))
  const store = (adapter as unknown as { store: ChatStore }).store
  store.upsertConversations([{ sessionId: '123', cid: '123@goofish', peerUserName: '买家', lastMessage: '第一条', lastMessageTime: 1, unreadCount: 1, sortIndex: 1, visible: true }])

  const pending = adapter.handleCommand({
    kind: 'command', requestId: 'read-ack', type: 'CHAT_MARK_READ', payload: { sessionId: '123' },
  })
  // 等待请求发出（ACK 仍未返回）。
  await Promise.resolve()

  // ACK 延迟期间：新入站消息到达，未读 +1。
  adapter.ingestRealtime(realtimePayload('123', '第二条', 'server-message-2'))
  const before = store.getConversation('123')
  assert.ok(before)
  store.upsertConversations([{ ...before, unreadCount: 2 }])

  release()
  const response = await pending
  assert.equal(response.ok, true)
  assert.equal((response.result as { ok: boolean }).ok, true)
  // 仅对发送请求时的原水位（server-message-1）发 clearRedPoint。
  assert.deepEqual(requests[0]?.body, [[{ cid: '123@goofish', messageId: 'server-message-1' }]])
  // ACK 返回时最新入站已是 server-message-2，不等于原水位 → 不清新消息未读。
  assert.equal(store.getConversation('123')?.unreadCount, 2)
})

test('CHAT_STATUS 返回计数', async () => {
  const adapter = makeAdapter()
  const res = await adapter.handleCommand({ kind: 'command', requestId: 'r1', type: ChatBridgeCommands.CHAT_STATUS })
  assert.equal(res.ok, true)
  assert.deepEqual(res.result, { socketStatus: 'connecting', sessionCount: 0, messageCount: 0 })
})

test('CHAT_GET_MESSAGES：缺少 sessionId 返回 INVALID_PAYLOAD', async () => {
  const adapter = makeAdapter()
  const res = await adapter.handleCommand({
    kind: 'command',
    requestId: 'r2',
    type: ChatBridgeCommands.CHAT_GET_MESSAGES,
    payload: {},
  })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
})

test('未知命令返回 UNKNOWN_COMMAND', async () => {
  const adapter = makeAdapter()
  const res = await adapter.handleCommand({ kind: 'command', requestId: 'r3', type: 'NOPE' })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'UNKNOWN_COMMAND')
})

test('ingestRealtime 排队事件且负载不含正文', () => {
  const adapter = makeAdapter()
  const result = adapter.ingestRealtime(realtimePayload('123', '机密内容', 'm1'))
  assert.equal(result.ok, true)
  const events = adapter.drainEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].type, ChatBridgeEvents.CHAT_MESSAGE_INGESTED)
  assert.equal(events[0].kind, 'event')
  // 事件负载必须可序列化且不包含聊天正文
  const serialized = JSON.stringify(events[0].payload)
  assert.equal(serialized.includes('机密内容'), false)
  // drain 后清空
  assert.deepEqual(adapter.drainEvents(), [])
})

test('reportSocketStatus 排队状态事件', () => {
  const adapter = makeAdapter()
  adapter.reportSocketStatus('open')
  const events = adapter.drainEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].type, ChatBridgeEvents.CHAT_SOCKET_STATUS)
  assert.deepEqual(events[0].payload, { status: 'open' })
})
