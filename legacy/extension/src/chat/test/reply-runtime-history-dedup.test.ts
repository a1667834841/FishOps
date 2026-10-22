/**
 * 回归：本地发送回显与后续权威历史同步（服务端 messageId 与发送 uuid 不同源）合并，不产生重复。
 *
 * 链路：reply-runtime 发送成功（写 pendingEcho 回显，uuid 作本地 id）
 *      → ChatSync.syncHistory 写入服务端历史 out 消息（messageId `msg_xxx`）
 *      → store 按时间边界剔除回显，仅保留权威版本。
 *
 * 全程假 transport，绝不发送真实消息、绝不访问网络。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, createCommand } from '@fishops/shared'
import type { LwpRequest, LwpResponse } from '../../../../shared/chat/index'
import { DEFAULT_REPLY_GLOBAL_CONFIG, type SendMessageResult } from '../../../../shared/types/reply'
import { createReplyRuntime } from '../../background/reply-runtime'
import { AiChatService } from '../ai-service'
import { ChatHistoryClient, type ChatTransport } from '../history'
import { MemoryReplyConfigStore } from '../reply-config'
import { ChatMessageSender } from '../send-client'
import type { ChatSendTransport } from '../send-transport'
import { ChatStore } from '../store'
import { ChatSync } from '../sync'

const b64 = (text: string): string => Buffer.from(text, 'utf-8').toString('base64')

class FakeSendTransport implements ChatSendTransport {
  send(request: LwpRequest): Promise<LwpResponse> {
    return Promise.resolve({ code: 200, headers: { mid: request.headers.mid }, body: {} })
  }
}

class FakeHistoryTransport implements ChatTransport {
  private readonly responder: (request: LwpRequest) => LwpResponse
  constructor(responder: (request: LwpRequest) => LwpResponse) {
    this.responder = responder
  }
  async send(request: LwpRequest): Promise<LwpResponse> {
    return this.responder(request)
  }
}

/** 历史消息模型：senderId 与 myUserId 一致 → direction 'out'。 */
function historyOutModel(messageId: string, createAt: number, text: string): unknown {
  return {
    message: {
      messageId,
      cid: '123@goofish',
      createAt,
      content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text } })) } },
      extension: { senderUserId: 'me', reminderTitle: '我' },
    },
  }
}

interface Setup {
  store: ChatStore
  reply: ReturnType<typeof createReplyRuntime>
}

function setup(): Setup {
  const store = new ChatStore()
  const configStore = new MemoryReplyConfigStore({
    global: { ...DEFAULT_REPLY_GLOBAL_CONFIG, enabled: true },
    rules: [],
  })
  const sender = new ChatMessageSender({
    transport: new FakeSendTransport(),
    midFactory: () => 'MID',
    uuidFactory: () => 'UUID-LOCAL',
    now: () => 1500,
  })
  const ai = new AiChatService({ loadProvider: async () => ({ apiKey: '', baseUrl: '', model: '', timeoutMs: 1000 }) })
  const reply = createReplyRuntime({
    configStore,
    sender,
    ai,
    getMessages: async (sessionId, options) => store.getMessages(sessionId, options),
    sentMessageStore: store,
    myUserId: 'me',
    now: () => 1500,
    sleep: async () => {},
  })
  return { store, reply }
}

test('发送回显 + 历史同步（不同 server messageId）：合并为权威版本，不重复', async () => {
  const { store, reply } = setup()

  const sendResponse = await reply.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: '123', receiverId: 'peer', content: '你好' }),
  )
  assert.equal((sendResponse.result as SendMessageResult).ok, true)
  assert.equal(store.getMessages('123').length, 1)
  assert.equal(store.getMessages('123')[0].messageId, 'UUID-LOCAL')
  assert.equal(store.getMessages('123')[0].pendingEcho, true)

  const history = new ChatHistoryClient({
    transport: new FakeHistoryTransport(() => ({
      code: 200,
      body: { userMessageModels: [historyOutModel('msg_server_1', 2000, '你好')], nextCursor: 0 },
    })),
    myUserId: 'me',
  })
  const sync = new ChatSync({ store, history })
  const result = await sync.syncHistory('123')
  assert.equal(result.ok, true)

  const messages = store.getMessages('123')
  assert.equal(messages.length, 1, '历史同步后不应与本地回显重复')
  assert.equal(messages[0].messageId, 'msg_server_1')
  assert.notEqual(messages[0].pendingEcho, true)
})

test('历史边界未覆盖回显（历史更早）：保留本地回显，不误删未同步新消息', async () => {
  const { store, reply } = setup()

  await reply.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: '123', receiverId: 'peer', content: '你好' }),
  )

  const history = new ChatHistoryClient({
    transport: new FakeHistoryTransport(() => ({
      code: 200,
      body: { userMessageModels: [historyOutModel('msg_server_old', 1000, '早前消息')], nextCursor: 0 },
    })),
    myUserId: 'me',
  })
  const sync = new ChatSync({ store, history })
  await sync.syncHistory('123')

  const messages = store.getMessages('123')
  assert.equal(messages.length, 2, '回显晚于历史边界，应保留')
  assert.ok(messages.some((m) => m.pendingEcho === true && m.messageId === 'UUID-LOCAL'))
  assert.ok(messages.some((m) => m.messageId === 'msg_server_old'))
})

test('重复同步历史：已剔除回显后不再变化（幂等）', async () => {
  const { store, reply } = setup()
  await reply.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: '123', receiverId: 'peer', content: '你好' }),
  )

  const historyTransport = new FakeHistoryTransport(() => ({
    code: 200,
    body: { userMessageModels: [historyOutModel('msg_server_1', 2000, '你好')], nextCursor: 0 },
  }))
  const sync = new ChatSync({ store, history: new ChatHistoryClient({ transport: historyTransport, myUserId: 'me' }) })

  await sync.syncHistory('123')
  await sync.syncHistory('123')

  assert.equal(store.getMessages('123').length, 1)
  assert.equal(store.getMessages('123')[0].messageId, 'msg_server_1')
})
