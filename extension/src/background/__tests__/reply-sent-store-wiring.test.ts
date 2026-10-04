/**
 * 生产接线回归：`index.ts` 组装时把 P5 `ChatRuntime.getStore()` 作为 `sentMessageStore` 注入 P6 `reply-runtime`。
 *
 * 本测试不依赖 chrome，直接复现该接线链：
 * createChatRuntime().getStore() → createReplyRuntime({ sentMessageStore, getMessages }) →
 * 发送成功后写入**同一份** store，UI 通过 P5 `CHAT_GET_MESSAGES` 立即读到，无需同步历史。
 *
 * 全程使用假 transport，绝不发送真实消息。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, createCommand, EventTypes } from '@fishops/shared'
import type { LwpRequest, LwpResponse } from '../../../../shared/chat/index'
import type { ChatMessage } from '../../../../shared/types/chat'
import { DEFAULT_REPLY_GLOBAL_CONFIG, type SendMessageResult } from '../../../../shared/types/reply'
import { AiChatService } from '../../chat/ai-service'
import { MemoryReplyConfigStore } from '../../chat/reply-config'
import { ChatMessageSender } from '../../chat/send-client'
import type { ChatSendTransport } from '../../chat/send-transport'
import type { ChatStore } from '../../chat/store'
import { createChatRuntime } from '../chat-runtime'
import { createReplyRuntime } from '../reply-runtime'

class FakeTransport implements ChatSendTransport {
  send(request: LwpRequest): Promise<LwpResponse> {
    return Promise.resolve({ code: 200, headers: { mid: request.headers.mid }, body: {} })
  }
}

function buildReplyRuntime(store: ChatStore) {
  const transport = new FakeTransport()
  const configStore = new MemoryReplyConfigStore({
    global: { ...DEFAULT_REPLY_GLOBAL_CONFIG, enabled: true },
    rules: [],
  })
  const sender = new ChatMessageSender({ transport, midFactory: () => 'MID', uuidFactory: () => 'UUID-1', now: () => 5000 })
  const ai = new AiChatService({ loadProvider: async () => ({ apiKey: '', baseUrl: '', model: '', timeoutMs: 1000 }) })
  return createReplyRuntime({
    configStore,
    sender,
    ai,
    getMessages: async (sessionId, options) => store.getMessages(sessionId, options),
    sentMessageStore: store,
    myUserId: 'me',
    now: () => 5000,
    sleep: async () => {},
  })
}

test('getStore：返回内部同一 store 实例（稳定引用）', async () => {
  const chatRuntime = createChatRuntime({ myUserId: 'me' })
  await chatRuntime.init()
  assert.equal(chatRuntime.getStore(), chatRuntime.getStore())
})

test('生产接线：P6 发送写入 P5 store，UI 经 CHAT_GET_MESSAGES 立即可读（无需同步历史）', async () => {
  const chatRuntime = createChatRuntime({ myUserId: 'me' })
  await chatRuntime.init()
  const store = chatRuntime.getStore()
  const reply = buildReplyRuntime(store)

  const sendResponse = await reply.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  assert.equal((sendResponse.result as SendMessageResult).ok, true)

  // P6 直接可见。
  assert.equal(store.getMessages('s1').length, 1)

  // 模拟 UI 读取链路：P5 命令读到同一份缓存。
  const readResponse = await chatRuntime.handleCommand(createCommand(CommandTypes.CHAT_GET_MESSAGES, { sessionId: 's1' }))
  assert.equal(readResponse.ok, true)
  const messages = (readResponse.result as { messages: ChatMessage[] }).messages
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content, '你好')
  assert.equal(messages[0].direction, 'out')
  assert.equal(messages[0].senderId, 'me')
  assert.equal(messages[0].receiverId, 'peer')

  // 会话摘要同步更新（供 CHAT_LIST_CONVERSATIONS 展示）。
  const listResponse = await chatRuntime.handleCommand(createCommand(CommandTypes.CHAT_LIST_CONVERSATIONS, {}))
  const conversations = (listResponse.result as { conversations: Array<{ sessionId: string; lastMessage: string }> }).conversations
  assert.equal(conversations.find((c) => c.sessionId === 's1')?.lastMessage, '你好')
})

test('生产接线：发送成功后 emit CHAT_MESSAGE_INGESTED 与 CHAT_CONVERSATION_UPDATED', async () => {
  const chatRuntime = createChatRuntime({ myUserId: 'me' })
  await chatRuntime.init()
  const reply = buildReplyRuntime(chatRuntime.getStore())

  await reply.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  const types = reply.drainEvents().map((e) => e.type)
  assert.ok(types.includes(EventTypes.CHAT_MESSAGE_INGESTED))
  assert.ok(types.includes(EventTypes.CHAT_CONVERSATION_UPDATED))
})

test('生产接线：发送失败不污染 P5 store', async () => {
  const chatRuntime = createChatRuntime({ myUserId: 'me' })
  await chatRuntime.init()
  const store = chatRuntime.getStore()
  const transport: ChatSendTransport = {
    send: () => Promise.resolve({ code: 500, message: 'boom' }),
  }
  const configStore = new MemoryReplyConfigStore({
    global: { ...DEFAULT_REPLY_GLOBAL_CONFIG, enabled: true },
    rules: [],
  })
  const sender = new ChatMessageSender({ transport, midFactory: () => 'MID', uuidFactory: () => 'UUID-1', now: () => 5000 })
  const ai = new AiChatService({ loadProvider: async () => ({ apiKey: '', baseUrl: '', model: '', timeoutMs: 1000 }) })
  const reply = createReplyRuntime({
    configStore,
    sender,
    ai,
    getMessages: async (sessionId, options) => store.getMessages(sessionId, options),
    sentMessageStore: store,
    myUserId: 'me',
    now: () => 5000,
    sleep: async () => {},
  })

  const response = await reply.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  assert.equal((response.result as SendMessageResult).ok, false)
  assert.equal(store.getMessages('s1').length, 0)
  assert.ok(!reply.drainEvents().some((e) => e.type === EventTypes.CHAT_MESSAGE_INGESTED))
})
