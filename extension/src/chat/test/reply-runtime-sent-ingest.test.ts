/**
 * 复现 / 回归：发送成功后必须把「已确认发出」的消息写入 P5 `ChatStore`，
 * 并 emit `CHAT_MESSAGE_INGESTED` / `CHAT_CONVERSATION_UPDATED`，使 UI 无需同步历史即可读到新消息。
 *
 * 覆盖：
 * - 显式 `CHAT_SEND_MESSAGE` / `CHAT_APPLY_REPLY` 与自动 `auto` 三条发送路径；
 * - 会话摘要更新且保留既有头像 / 昵称 / 未读；
 * - 失败 / 超时（未确认成功）绝不写入、绝不伪造 INGESTED 事件；
 * - 以发送 uuid 为去重键，重复入库只更新不新增。
 *
 * 全部使用假 transport，绝不发送真实消息。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, createCommand, EventTypes } from '@fishops/shared'
import type { LwpRequest, LwpResponse } from '../../../../shared/chat/index'
import type { Conversation } from '../../../../shared/types/chat'
import {
  DEFAULT_REPLY_GLOBAL_CONFIG,
  type KeywordReplyRule,
  type ReplyGlobalConfig,
  type ReplyRule,
  type SendMessageResult,
} from '../../../../shared/types/reply'
import { createReplyRuntime, type ReplyIncomingSource } from '../../background/reply-runtime'
import { AiChatService } from '../ai-service'
import { MemoryReplyConfigStore } from '../reply-config'
import { ChatMessageSender } from '../send-client'
import { ChatSendTransportError, type ChatSendTransport } from '../send-transport'
import { ChatStore } from '../store'

class FakeTransport implements ChatSendTransport {
  readonly sent: LwpRequest[] = []
  responder: (request: LwpRequest) => LwpResponse = () => ({ code: 200, body: {} })
  send(request: LwpRequest): Promise<LwpResponse> {
    this.sent.push(request)
    try {
      return Promise.resolve(this.responder(request))
    } catch (error) {
      return Promise.reject(error)
    }
  }
}

function keywordRule(patch: Partial<KeywordReplyRule> = {}): KeywordReplyRule {
  return { id: 'r1', type: 'keyword', name: '价格', enabled: true, priority: 1, pattern: '多少钱', reply: '亲，可以谈', ...patch }
}

function incomingMessage(patch: Partial<ReplyIncomingSource> = {}): ReplyIncomingSource {
  return {
    id: 'k1',
    messageId: 'msg1',
    sessionId: 's1',
    cid: 's1@goofish',
    senderId: 'peer',
    senderName: '买家',
    receiverId: 'me',
    direction: 'in',
    kind: 'text',
    contentType: 1,
    content: '这个多少钱',
    createAt: 1000,
    source: 'realtime',
    ...patch,
  }
}

function conversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    sessionId: 's1',
    cid: 's1@goofish',
    peerUserId: 'peer',
    peerUserName: '买家',
    peerAvatarUrl: 'https://img.example.com/a.png',
    lastMessage: '旧消息',
    lastMessageTime: 1,
    unreadCount: 2,
    sortIndex: 1,
    visible: true,
    ...patch,
  }
}

interface Setup {
  store: ChatStore
  transport: FakeTransport
  runtime: ReturnType<typeof createReplyRuntime>
  sentCount(): number
}

function setup(options: {
  global?: Partial<ReplyGlobalConfig>
  rules?: ReplyRule[]
  now?: number
  uuidFactory?: () => string
} = {}): Setup {
  const store = new ChatStore()
  const transport = new FakeTransport()
  const configStore = new MemoryReplyConfigStore({
    global: { ...DEFAULT_REPLY_GLOBAL_CONFIG, enabled: true, ...options.global },
    rules: options.rules ?? [keywordRule()],
  })
  let seq = 0
  const now = options.now ?? 5000
  const sender = new ChatMessageSender({
    transport,
    midFactory: () => `MID-${++seq}`,
    uuidFactory: options.uuidFactory ?? (() => `UUID-${++seq}`),
    now: () => now,
  })
  const ai = new AiChatService({ loadProvider: async () => ({ apiKey: '', baseUrl: '', model: '', timeoutMs: 1000 }) })
  const runtime = createReplyRuntime({
    configStore,
    sender,
    ai,
    getMessages: async (sessionId, query) => store.getMessages(sessionId, query),
    sentMessageStore: store,
    myUserId: 'me',
    now: () => now,
    sleep: async () => {},
  })
  return { store, transport, runtime, sentCount: () => transport.sent.length }
}

test('CHAT_SEND_MESSAGE：成功后写入 store，UI 无需同步历史即可读到本账号消息', async () => {
  const s = setup()
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  assert.equal(response.ok, true)

  const messages = s.store.getMessages('s1')
  assert.equal(messages.length, 1)
  const message = messages[0]
  assert.equal(message.direction, 'out')
  assert.equal(message.content, '你好')
  assert.equal(message.senderId, 'me')
  assert.equal(message.receiverId, 'peer')
  assert.equal(message.sessionId, 's1')
  assert.equal(message.cid, 's1@goofish')
  assert.equal(message.createAt, 5000)
  assert.equal(message.messageId, 'UUID-1')
  // 本地确认回显标记：仅内存暂存，待权威历史覆盖后替换。
  assert.equal(message.pendingEcho, true)
})

test('CHAT_SEND_MESSAGE：emit CHAT_MESSAGE_INGESTED 与 CHAT_CONVERSATION_UPDATED', async () => {
  const s = setup()
  await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  const events = s.runtime.drainEvents()
  const ingested = events.find((e) => e.type === EventTypes.CHAT_MESSAGE_INGESTED)
  const updated = events.find((e) => e.type === EventTypes.CHAT_CONVERSATION_UPDATED)
  assert.ok(ingested, '应发出 CHAT_MESSAGE_INGESTED')
  assert.ok(updated, '应发出 CHAT_CONVERSATION_UPDATED')
  assert.deepEqual((ingested?.payload as { added: number; updated: number; kind: string }), {
    kind: 'message',
    added: 1,
    updated: 0,
  })
})

test('CHAT_SEND_MESSAGE：更新会话摘要，且保留既有头像 / 昵称 / 未读', async () => {
  const s = setup()
  s.store.upsertConversations([conversation()])
  const before = s.store.getConversation('s1')

  await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )

  const after = s.store.getConversation('s1')
  assert.ok(after)
  assert.equal(after.lastMessage, '你好')
  assert.equal(after.lastMessageTime, 5000)
  assert.equal(after.sortIndex, 5000)
  // 既有字段必须保留（尤其是头像）。
  assert.equal(after.peerAvatarUrl, before?.peerAvatarUrl)
  assert.equal(after.peerUserName, before?.peerUserName)
  assert.equal(after.peerUserId, before?.peerUserId)
  assert.equal(after.unreadCount, before?.unreadCount)
})

test('CHAT_SEND_MESSAGE：会话不存在时新建会话（头像未知保持 undefined）', async () => {
  const s = setup()
  await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's9', receiverId: 'peer9', content: '在的' }),
  )
  const conv = s.store.getConversation('s9')
  assert.ok(conv)
  assert.equal(conv.peerUserId, 'peer9')
  assert.equal(conv.lastMessage, '在的')
  assert.equal(conv.peerAvatarUrl, undefined)
  assert.equal(conv.visible, true)
})

test('CHAT_APPLY_REPLY：采用建议发送后同样入库（从消息推断接收者）', async () => {
  const s = setup()
  s.store.upsertMessages([incomingMessage()])

  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_APPLY_REPLY, { sessionId: 's1', content: '好的', messageId: 'msg1' }),
  )
  assert.equal(response.ok, true)

  const out = s.store.getMessages('s1').find((m) => m.direction === 'out')
  assert.ok(out, 'apply 发送的 out 消息应入库')
  assert.equal(out.content, '好的')
  assert.equal(out.receiverId, 'peer')
  assert.equal(out.senderId, 'me')
})

test('auto：自动回复发送成功后入库并 emit INGESTED', async () => {
  const s = setup({ global: { mode: 'auto' } })
  await s.runtime.init()
  const decision = await s.runtime.handleIncomingMessage(incomingMessage())
  assert.equal(decision.kind, 'auto')

  const out = s.store.getMessages('s1').find((m) => m.direction === 'out')
  assert.ok(out, '自动回复的 out 消息应入库')
  assert.equal(out.content, '亲，可以谈')
  assert.equal(out.receiverId, 'peer')
  assert.ok(s.runtime.drainEvents().some((e) => e.type === EventTypes.CHAT_MESSAGE_INGESTED))
})

test('发送失败（服务端错误码）：绝不写入、绝不伪造 INGESTED', async () => {
  const s = setup()
  s.transport.responder = () => ({ code: 500, message: 'boom' })

  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  assert.equal((response.result as SendMessageResult).ok, false)
  assert.equal(s.store.getMessages('s1').length, 0)
  assert.equal(s.store.getConversation('s1'), undefined)

  const events = s.runtime.drainEvents()
  assert.ok(!events.some((e) => e.type === EventTypes.CHAT_MESSAGE_INGESTED))
  assert.ok(!events.some((e) => e.type === EventTypes.CHAT_CONVERSATION_UPDATED))
  assert.ok(events.some((e) => e.type === EventTypes.CHAT_MESSAGE_SENT))
})

test('发送超时（结果未知）：绝不写入、绝不伪造成功', async () => {
  const s = setup()
  s.transport.responder = () => {
    throw new ChatSendTransportError('TIMEOUT', '发送超时(10000ms)')
  }

  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  const result = response.result as SendMessageResult
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'TIMEOUT')
  assert.equal(s.store.getMessages('s1').length, 0)
  assert.equal(s.store.getConversation('s1'), undefined)
  assert.ok(!s.runtime.drainEvents().some((e) => e.type === EventTypes.CHAT_MESSAGE_INGESTED))
})

test('去重：同一 uuid 重复入库只更新不新增', async () => {
  const s = setup({ uuidFactory: () => 'UUID-FIXED' })
  await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  s.runtime.drainEvents()
  await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )

  assert.equal(s.store.getMessages('s1').length, 1)
  const ingested = s.runtime
    .drainEvents()
    .find((e) => e.type === EventTypes.CHAT_MESSAGE_INGESTED)
  assert.deepEqual(ingested?.payload as { added: number; updated: number }, { kind: 'message', added: 0, updated: 1 })
})

test('未注入 sentMessageStore：退化为旧行为（不写 store，但仍发 CHAT_MESSAGE_SENT）', async () => {
  const store = new ChatStore()
  const transport = new FakeTransport()
  const configStore = new MemoryReplyConfigStore({
    global: { ...DEFAULT_REPLY_GLOBAL_CONFIG, enabled: true },
    rules: [keywordRule()],
  })
  const sender = new ChatMessageSender({ transport, midFactory: () => 'MID', uuidFactory: () => 'UUID' })
  const ai = new AiChatService({ loadProvider: async () => ({ apiKey: '', baseUrl: '', model: '', timeoutMs: 1000 }) })
  const runtime = createReplyRuntime({
    configStore,
    sender,
    ai,
    getMessages: async () => [],
    myUserId: 'me',
    now: () => 5000,
    sleep: async () => {},
  })

  await runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  assert.equal(store.getMessages('s1').length, 0)
  assert.ok(runtime.drainEvents().some((e) => e.type === EventTypes.CHAT_MESSAGE_SENT))
})
