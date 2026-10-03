/**
 * P8 接入回归：显式发送前调用运行时就绪准备（ensureReady），自动模式 / 实时消息绝不触发。
 * 使用假 transport，不发送真实消息。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, createCommand } from '@fishops/shared'
import type { LwpRequest, LwpResponse } from '../../../../shared/chat/index'
import { DEFAULT_REPLY_GLOBAL_CONFIG, type KeywordReplyRule } from '../../../../shared/types/reply'
import type { ChatMessage } from '../../../../shared/types/chat'
import { AiChatService } from '../ai-service'
import { MemoryReplyConfigStore } from '../reply-config'
import { ChatMessageSender } from '../send-client'
import type { ChatSendTransport } from '../send-transport'
import { createReplyRuntime, type ReplyIncomingSource } from '../../background/reply-runtime'

class FakeTransport implements ChatSendTransport {
  readonly sent: LwpRequest[] = []
  send(request: LwpRequest): Promise<LwpResponse> {
    this.sent.push(request)
    return Promise.resolve({ code: 200, headers: { mid: request.headers.mid }, body: {} })
  }
}

function rule(): KeywordReplyRule {
  return { id: 'r1', type: 'keyword', name: '价格', enabled: true, priority: 1, pattern: '多少钱', reply: '亲，可以谈' }
}

function inbound(patch: Partial<ReplyIncomingSource> = {}): ReplyIncomingSource {
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

function setup(options: {
  mode?: 'manual' | 'suggest' | 'auto'
  ensureReady?: () => Promise<{ ok: boolean; category?: 'host-unavailable' | 'unauthorized' | 'captcha'; message?: string }>
  resolveMyUserId?: () => Promise<
    | { ok: true; userId: string; fromCache: boolean }
    | { ok: false; category: 'unauthorized' | 'captcha' | 'api'; message: string; retCode?: string }
  >
  messages?: ChatMessage[]
} = {}) {
  const transport = new FakeTransport()
  const store = new MemoryReplyConfigStore({
    global: { ...DEFAULT_REPLY_GLOBAL_CONFIG, enabled: true, mode: options.mode ?? 'suggest' },
    rules: [rule()],
  })
  const sender = new ChatMessageSender({ transport, midFactory: () => 'MID', uuidFactory: () => 'UUID' })
  const ai = new AiChatService({ loadProvider: () => store.loadAiProvider() })
  let readyCalls = 0
  const runtime = createReplyRuntime({
    configStore: store,
    sender,
    ai,
    getMessages: async () => options.messages ?? [inbound()],
    myUserId: 'me',
    now: () => 5000,
    sleep: async () => {},
    ensureReady: async () => {
      readyCalls += 1
      return options.ensureReady ? options.ensureReady() : { ok: true }
    },
    ...(options.resolveMyUserId === undefined ? {} : { resolveMyUserId: options.resolveMyUserId }),
  })
  return { runtime, transport, sentCount: () => transport.sent.length, readyCalls: () => readyCalls }
}

test('CHAT_SEND_MESSAGE：先 ensureReady 一次，再发送一次', async () => {
  const s = setup()
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  assert.equal(response.ok, true)
  assert.equal(s.readyCalls(), 1)
  assert.equal(s.sentCount(), 1)
})

test('CHAT_APPLY_REPLY：先 ensureReady 一次，再发送一次', async () => {
  const s = setup()
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_APPLY_REPLY, { sessionId: 's1', content: '你好', receiverId: 'peer' }),
  )
  assert.equal(response.ok, true)
  assert.equal(s.readyCalls(), 1)
  assert.equal(s.sentCount(), 1)
})

test('ensureReady 失败：返回结构化 PLATFORM_ERROR，不发送', async () => {
  const s = setup({ ensureReady: async () => ({ ok: false, category: 'captcha', message: '需要验证码' }) })
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'PLATFORM_ERROR')
  assert.equal(response.error?.category, 'captcha')
  assert.equal(s.sentCount(), 0)
})

test('resolveMyUserId 失败：透传类别并提示，不发送', async () => {
  const s = setup({
    resolveMyUserId: async () => ({ ok: false, category: 'unauthorized', message: '未登录' }),
  })
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'PLATFORM_ERROR')
  assert.equal(response.error?.category, 'unauthorized')
  assert.equal(s.sentCount(), 0)
})

test('resolveMyUserId 失败：透传 retCode（不丢诊断码），不发送', async () => {
  const s = setup({
    resolveMyUserId: async () => ({ ok: false, category: 'api', message: '闲鱼接口返回业务错误', retCode: 'FAIL_SYS_ILLEGAL_ACCESS' }),
  })
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'PLATFORM_ERROR')
  assert.equal(response.error?.category, 'api')
  assert.equal(response.error?.retCode, 'FAIL_SYS_ILLEGAL_ACCESS')
  assert.equal(s.sentCount(), 0)
})

test('自动模式实时消息：不调用 ensureReady（不自动准备、不自动发送）', async () => {
  const s = setup({ mode: 'auto' })
  await s.runtime.init()
  const decision = await s.runtime.handleIncomingMessage(inbound())
  assert.equal(decision.kind, 'auto')
  assert.equal(s.readyCalls(), 0)
})

test('建议模式实时消息：同样不触发 ensureReady', async () => {
  const s = setup({ mode: 'suggest' })
  await s.runtime.init()
  await s.runtime.handleIncomingMessage(inbound())
  assert.equal(s.readyCalls(), 0)
})
