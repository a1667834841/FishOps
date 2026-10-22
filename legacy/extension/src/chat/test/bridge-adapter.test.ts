/**
 * bridge-adapter.ts 单元测试：P1 兼容命令处理与事件队列（纯 Node）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatBridgeAdapter, ChatBridgeCommands, ChatBridgeEvents } from '../bridge-adapter'
import { ChatHistoryClient, type ChatTransport } from '../history'
import { ChatStore } from '../store'
import type { ChatMessage, Conversation } from '../../../../shared/types/chat'
import { INITIAL_CURSOR, type LwpRequest, type LwpResponse } from '../../../../shared/chat/index'

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

// ---------------- CHAT_GET_MESSAGES 分页（窗口内最近 N + before 游标） ----------------

/** 造一批可预测的历史消息；groupSize>1 时若干条共享同一 createAt。 */
function seedHistory(store: ChatStore, sessionId: string, count: number, groupSize = 1): void {
  const messages: ChatMessage[] = Array.from({ length: count }, (_, index) => ({
    id: '',
    cid: `${sessionId}@goofish`,
    sessionId,
    messageId: `m${String(index + 1).padStart(3, '0')}`,
    senderId: '999',
    senderName: '买家',
    receiverId: '111',
    direction: 'in',
    kind: 'text',
    contentType: 1,
    content: `消息${index + 1}`,
    createAt: 1000 + Math.floor(index / groupSize),
    source: 'history',
  }))
  store.upsertMessages(messages)
}

test('CHAT_GET_MESSAGES：asc + limit 保持旧语义（从最早端取 N 条），兼容旧调用方', async () => {
  const adapter = makeAdapter()
  const store = (adapter as unknown as { store: ChatStore }).store
  seedHistory(store, '123', 25)

  const res = await adapter.handleCommand({
    kind: 'command',
    requestId: 'page-asc',
    type: ChatBridgeCommands.CHAT_GET_MESSAGES,
    payload: { sessionId: '123', order: 'asc', limit: 10 },
  })
  assert.equal(res.ok, true)
  const result = res.result as { messages: ChatMessage[]; hasMore?: boolean }
  // desc/limit 才是「最近 N 条」；asc/limit 属旧契约，仍取最早 N 条（reply-runtime 依赖）。
  assert.deepEqual(
    result.messages.map((m) => m.messageId),
    Array.from({ length: 10 }, (_, i) => `m${String(i + 1).padStart(3, '0')}`),
  )
  assert.equal(result.hasMore, undefined, 'asc + limit 保持旧形状，不新增 hasMore')
})

test('CHAT_GET_MESSAGES：desc + limit 取最近 N 条并返回 hasMore', async () => {
  const adapter = makeAdapter()
  const store = (adapter as unknown as { store: ChatStore }).store
  seedHistory(store, '123', 25)

  const res = await adapter.handleCommand({
    kind: 'command',
    requestId: 'page-desc',
    type: ChatBridgeCommands.CHAT_GET_MESSAGES,
    payload: { sessionId: '123', order: 'desc', limit: 10 },
  })
  assert.equal(res.ok, true)
  const result = res.result as { messages: ChatMessage[]; hasMore?: boolean }
  assert.deepEqual(
    result.messages.map((m) => m.messageId),
    Array.from({ length: 10 }, (_, i) => `m${String(25 - i).padStart(3, '0')}`),
  )
  assert.equal(result.hasMore, true)
})

test('CHAT_GET_MESSAGES：before 游标向前翻页不重复；非法游标返回 INVALID_PAYLOAD', async () => {
  const adapter = makeAdapter()
  const store = (adapter as unknown as { store: ChatStore }).store
  seedHistory(store, '123', 25)

  const first = await adapter.handleCommand({
    kind: 'command',
    requestId: 'page-a',
    type: ChatBridgeCommands.CHAT_GET_MESSAGES,
    payload: { sessionId: '123', order: 'desc', limit: 10 },
  })
  const firstMessages = (first.result as { messages: ChatMessage[] }).messages
  const oldest = firstMessages[firstMessages.length - 1]

  const second = await adapter.handleCommand({
    kind: 'command',
    requestId: 'page-b',
    type: ChatBridgeCommands.CHAT_GET_MESSAGES,
    payload: {
      sessionId: '123',
      order: 'asc',
      limit: 10,
      before: { createAt: oldest.createAt, messageId: oldest.messageId, id: oldest.id },
    },
  })
  assert.equal(second.ok, true)
  const secondResult = second.result as { messages: ChatMessage[]; hasMore?: boolean }
  assert.deepEqual(
    secondResult.messages.map((m) => m.messageId),
    Array.from({ length: 10 }, (_, i) => `m${String(i + 6).padStart(3, '0')}`),
  )
  // 与第一页无交集（不重复）。
  const overlap = secondResult.messages.filter((m) => firstMessages.some((f) => f.id === m.id))
  assert.deepEqual(overlap, [])
  assert.equal(secondResult.hasMore, true)

  for (const bad of [{}, { createAt: 1, messageId: 'm1' }, { createAt: 1, messageId: 'm1', id: '' }]) {
    const res = await adapter.handleCommand({
      kind: 'command',
      requestId: 'page-bad',
      type: ChatBridgeCommands.CHAT_GET_MESSAGES,
      payload: { sessionId: '123', limit: 10, before: bad },
    })
    assert.equal(res.ok, false)
    assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  }
})

test('CHAT_GET_MESSAGES：未带 limit 的旧调用方仍拿到 { messages } 原形状', async () => {
  const adapter = makeAdapter()
  const store = (adapter as unknown as { store: ChatStore }).store
  seedHistory(store, '123', 3)
  const res = await adapter.handleCommand({
    kind: 'command',
    requestId: 'legacy',
    type: ChatBridgeCommands.CHAT_GET_MESSAGES,
    payload: { sessionId: '123', order: 'asc' },
  })
  assert.equal(res.ok, true)
  const result = res.result as { messages: ChatMessage[]; hasMore?: boolean }
  assert.equal(result.messages.length, 3)
  assert.equal(result.hasMore, undefined, '无 limit 时不返回 hasMore，保持向后兼容')
})

// ---------------- CHAT_SYNC_HISTORY 游标透传 ----------------

function makeHistoryAdapter(responder: (request: LwpRequest) => LwpResponse): ChatBridgeAdapter {
  const store = new ChatStore()
  const transport: ChatTransport = { send: async (request) => responder(request) }
  const sync = new ChatSync({ store, history: new ChatHistoryClient({ transport, myUserId: '111' }), sleep: async () => {} })
  return new ChatBridgeAdapter({ sync, store, now: () => 1000, genEventId: () => 'e1' })
}

function historyModel(messageId: string, createAt: number): unknown {
  return {
    message: {
      messageId,
      cid: '123@goofish',
      createAt,
      content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text: messageId } })) } },
      extension: { senderUserId: '999', reminderTitle: '买家' },
    },
  }
}

test('CHAT_SYNC_HISTORY：透传 cursor 并返回 nextCursor/hasMore', async () => {
  const anchors: unknown[] = []
  const adapter = makeHistoryAdapter((request) => {
    anchors.push(request.body[2])
    if (request.body[2] === INITIAL_CURSOR) {
      return { code: 200, body: { userMessageModels: [historyModel('h1', 2000)], nextCursor: 1500 } }
    }
    return { code: 200, body: { userMessageModels: [historyModel('h2', 1000)], nextCursor: 0 } }
  })

  const first = await adapter.handleCommand({
    kind: 'command',
    requestId: 'sync-1',
    type: ChatBridgeCommands.CHAT_SYNC_HISTORY,
    payload: { sessionId: '123', pages: 1, count: 1 },
  })
  assert.equal(first.ok, true)
  const r1 = first.result as { ok: boolean; added: number; hasMore?: boolean; nextCursor?: number }
  assert.equal(r1.ok, true)
  assert.equal(r1.added, 1)
  assert.equal(r1.hasMore, true)
  assert.equal(r1.nextCursor, 1500)
  assert.deepEqual(anchors, [INITIAL_CURSOR], '不传 cursor 时从最新一页开始（既有行为）')

  const second = await adapter.handleCommand({
    kind: 'command',
    requestId: 'sync-2',
    type: ChatBridgeCommands.CHAT_SYNC_HISTORY,
    payload: { sessionId: '123', pages: 1, count: 1, cursor: 1500 },
  })
  assert.equal(second.ok, true)
  const r2 = second.result as { ok: boolean; hasMore?: boolean; nextCursor?: number }
  assert.equal(r2.ok, true)
  assert.equal(r2.hasMore, false)
  assert.equal(r2.nextCursor, undefined)
  assert.deepEqual(anchors, [INITIAL_CURSOR, 1500], '第二跳必须带上上一页返回的游标')
})

test('会话列表仅暴露当前账号资料，旧缓存待重新同步，封面通过 Bridge 传递', async () => {
  const store = new ChatStore()
  const sync = new ChatSync({ store }, { myUserId: 'old' })
  const adapter = new ChatBridgeAdapter({ store, sync, myUserId: 'old' })
  const base: Conversation = { sessionId: 'a', cid: 'a@goofish', peerUserName: '买家',
    lastMessage: '', lastMessageTime: 1, sortIndex: 1, unreadCount: 0, visible: true }
  store.upsertConversations([{ ...base, accountUserId: 'old', itemId: '11', itemCoverUrl: 'https://img.alicdn.com/a.jpg' },
    { ...base, sessionId: 'legacy' }, { ...base, sessionId: 'b', accountUserId: 'new', itemId: '22', itemCoverUrl: 'https://img.alicdn.com/b.jpg' }])
  const command = { kind: 'command' as const, requestId: 'list-account', type: 'CHAT_LIST_CONVERSATIONS' }
  const first = await adapter.handleCommand(command)
  assert.deepEqual((first.result as { conversations: Conversation[] }).conversations.map(c => c.sessionId), ['a'])
  sync.setMyUserId('new')
  adapter.setMyUserId('new')
  const second = await adapter.handleCommand(command)
  const rows = (second.result as { conversations: Conversation[] }).conversations
  assert.deepEqual(rows.map(c => c.sessionId), ['b'])
  assert.equal(rows[0]?.itemCoverUrl, 'https://img.alicdn.com/b.jpg')
})
