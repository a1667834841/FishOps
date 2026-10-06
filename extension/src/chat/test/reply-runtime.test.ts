/**
 * reply-runtime.ts 单测：P6 命令路由、建议默认不发送、显式发送、自动模式、AI 暂停、来源策略联动。
 * 使用假 transport / 假 fetch / 内存配置，绝不发送真实消息、绝不访问真实 AI。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, createCommand, EventTypes } from '@fishops/shared'
import type { ChatMessage } from '../../../../shared/types/chat'
import {
  DEFAULT_REPLY_GLOBAL_CONFIG,
  type KeywordReplyRule,
  type ReplyGlobalConfig,
  type ReplyRule,
} from '../../../../shared/types/reply'
import type { LwpRequest, LwpResponse } from '../../../../shared/chat/index'
import { handleCommand } from '../../background/message-router'
import { AiChatService } from '../ai-service'
import { MemoryReplyConfigStore } from '../reply-config'
import { createReplyRuntime, type ReplyIncomingSource } from '../../background/reply-runtime'
import { ChatMessageSender } from '../send-client'
import type { ChatSendTransport } from '../send-transport'
import { ChatStore } from '../store'

class FakeTransport implements ChatSendTransport {
  readonly sent: LwpRequest[] = []
  send(request: LwpRequest): Promise<LwpResponse> {
    this.sent.push(request)
    return Promise.resolve({ code: 200, headers: { mid: request.headers.mid }, body: {} })
  }
}

function keywordRule(patch: Partial<KeywordReplyRule> = {}): KeywordReplyRule {
  return { id: 'r1', type: 'keyword', name: '价格', enabled: true, priority: 1, pattern: '多少钱', reply: '亲，可以谈', ...patch }
}

function chatMessage(patch: Partial<ReplyIncomingSource> = {}): ReplyIncomingSource {
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

interface Setup {
  transport: FakeTransport
  runtime: ReturnType<typeof createReplyRuntime>
  store: MemoryReplyConfigStore
  sentCount(): number
}

function setup(options: {
  global?: Partial<ReplyGlobalConfig>
  rules?: ReplyRule[]
  messages?: ChatMessage[]
  aiConfigured?: boolean
} = {}): Setup {
  const transport = new FakeTransport()
  const store = new MemoryReplyConfigStore({
    global: { ...DEFAULT_REPLY_GLOBAL_CONFIG, enabled: true, ...options.global },
    rules: options.rules ?? [keywordRule()],
    aiProvider: options.aiConfigured
      ? { apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', model: 'm', timeoutMs: 1000 }
      : undefined,
  })
  const sender = new ChatMessageSender({ transport, midFactory: () => 'MID', uuidFactory: () => 'UUID' })
  const ai = new AiChatService({
    loadProvider: () => store.loadAiProvider(),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ model: 'm', choices: [{ message: { content: 'AI 建议内容' } }] }) }),
  })
  const messages = options.messages ?? [chatMessage()]
  const messageStore = new ChatStore()
  messageStore.upsertMessages(messages)
  const runtime = createReplyRuntime({
    configStore: store,
    sender,
    ai,
    getMessages: async (sessionId, query) => messageStore.getMessages(sessionId, query),
    myUserId: 'me',
    now: () => 5000,
    sleep: async () => {},
  })
  return { transport, runtime, store, sentCount: () => transport.sent.length }
}

function longHistory(): ChatMessage[] {
  return Array.from({ length: 401 }, (_, index) => chatMessage({
    id: `m${index + 1}`,
    messageId: `m${index + 1}`,
    createAt: index + 1,
  }))
}

for (const messageId of [undefined, 'm401', 'm1', 'm250', 'missing']) {
  test(`长会话建议：真实 ChatStore 定位 ${messageId ?? '最新入站'}`, async () => {
    const s = setup({ messages: longHistory() })
    const response = await s.runtime.handleCommand(createCommand(CommandTypes.CHAT_GET_REPLY_SUGGESTION, {
      sessionId: 's1', ...(messageId === undefined ? {} : { messageId }),
    }))
    const result = response.result as { ok: boolean; code?: string; suggestion?: { messageId: string } }
    if (messageId === 'missing') {
      assert.equal(result.ok, false)
      assert.equal(result.code, 'NO_MESSAGE')
    } else {
      assert.equal(result.ok, true)
      assert.equal(result.suggestion?.messageId, messageId ?? 'm401')
    }
    assert.equal(s.sentCount(), 0)
  })
}

test('长会话建议：超过 200 条连续出站及空白入站不遮蔽最近有效入站', async () => {
  const messages = longHistory().map((m, index) => index >= 150 ? { ...m, direction: 'out' as const } : m)
  messages.push(chatMessage({ messageId: 'blank', createAt: 1000, content: '  ' }))
  const s = setup({ messages })
  const response = await s.runtime.handleCommand(createCommand(CommandTypes.CHAT_GET_REPLY_SUGGESTION, { sessionId: 's1' }))
  const result = response.result as { ok: boolean; suggestion?: { messageId: string } }
  assert.equal(result.ok, true)
  assert.equal(result.suggestion?.messageId, 'm150')
  assert.equal(s.sentCount(), 0)
})

for (const messageId of [undefined, 'm401', 'm1', 'missing']) {
  test(`长会话采用建议：安全发送替身推断 ${messageId ?? '最新入站'} 的收件人`, async () => {
    const messages = longHistory().map((m, index) => ({ ...m, senderId: `peer${index + 1}` }))
    const s = setup({ messages })
    const response = await s.runtime.handleCommand(createCommand(CommandTypes.CHAT_APPLY_REPLY, {
      sessionId: 's1', content: '测试回复', ...(messageId === undefined ? {} : { messageId }),
    }))
    assert.equal(response.ok, messageId !== 'missing')
    assert.equal(s.sentCount(), messageId === 'missing' ? 0 : 1)
    if (messageId !== 'missing') {
      assert.equal((response.result as { receiverId: string }).receiverId, `peer${(messageId ?? 'm401').slice(1)}`)
    }
  })
}

test('长会话采用建议：显式收件人不受不存在的消息 ID 影响', async () => {
  const s = setup({ messages: longHistory() })
  const response = await s.runtime.handleCommand(createCommand(CommandTypes.CHAT_APPLY_REPLY, {
    sessionId: 's1', content: '测试回复', receiverId: 'explicit-peer', messageId: 'missing',
  }))
  assert.equal(response.ok, true)
  assert.equal((response.result as { receiverId: string }).receiverId, 'explicit-peer')
  assert.equal(s.sentCount(), 1)
})

test('状态：默认建议模式、规则数与 AI 配置布尔', async () => {
  const { runtime } = setup({ aiConfigured: true })
  await runtime.init()
  const status = runtime.getStatus()
  assert.equal(status.enabled, true)
  assert.equal(status.mode, 'suggest')
  assert.equal(status.rulesCount, 1)
  assert.equal(status.aiConfigured, true)
})

test('CHAT_GET_REPLY_SUGGESTION：关键词建议，默认建议模式绝不发送', async () => {
  const s = setup()
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_GET_REPLY_SUGGESTION, { sessionId: 's1' }),
  )
  assert.equal(response.ok, true)
  const result = response.result as { ok: boolean; suggestion?: { content: string; ruleType: string } }
  assert.equal(result.ok, true)
  assert.equal(result.suggestion?.content, '亲，可以谈')
  assert.equal(result.suggestion?.ruleType, 'keyword')
  // 关键：建议不发送。
  assert.equal(s.sentCount(), 0)
})

test('CHAT_GET_REPLY_SUGGESTION：AI 规则走 AI 服务返回建议', async () => {
  const s = setup({ rules: [{ id: 'ai', type: 'ai', name: 'AI', enabled: true, priority: 1 }], aiConfigured: true })
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_GET_REPLY_SUGGESTION, { sessionId: 's1' }),
  )
  const result = response.result as { ok: boolean; suggestion?: { content: string; ruleType: string } }
  assert.equal(result.ok, true)
  assert.equal(result.suggestion?.content, 'AI 建议内容')
  assert.equal(result.suggestion?.ruleType, 'ai')
  assert.equal(s.sentCount(), 0)
})

test('CHAT_GET_REPLY_SUGGESTION：总开关关闭（enabled=false）仍可生成建议，且不发送、不消费配额', async () => {
  const s = setup({ global: { enabled: false } })
  const before = s.runtime.getStatus().processedCount
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_GET_REPLY_SUGGESTION, { sessionId: 's1', respectPause: false }),
  )
  assert.equal(response.ok, true)
  const result = response.result as { ok: boolean; suggestion?: { content: string } }
  assert.equal(result.ok, true)
  assert.equal(result.suggestion?.content, '亲，可以谈')
  // 关键：建议不发送、不记账（不消费自动回复配额）。
  assert.equal(s.sentCount(), 0)
  assert.equal(s.runtime.getStatus().processedCount, before)
  assert.equal(s.runtime.getStatus().enabled, false)
})

test('CHAT_GET_REPLY_SUGGESTION：无规则但已配 AI → 默认 AI 建议（不发送）', async () => {
  const s = setup({ global: { enabled: false }, rules: [], aiConfigured: true })
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_GET_REPLY_SUGGESTION, { sessionId: 's1' }),
  )
  const result = response.result as { ok: boolean; suggestion?: { content: string; ruleType: string; ruleId: string } }
  assert.equal(result.ok, true)
  assert.equal(result.suggestion?.content, 'AI 建议内容')
  assert.equal(result.suggestion?.ruleType, 'ai')
  assert.equal(s.sentCount(), 0)
})

test('CHAT_GET_REPLY_SUGGESTION：无规则且未配 AI → NO_MATCH', async () => {
  const s = setup({ global: { enabled: false }, rules: [] })
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_GET_REPLY_SUGGESTION, { sessionId: 's1' }),
  )
  const result = response.result as { ok: boolean; code?: string }
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NO_MATCH')
  assert.equal(s.sentCount(), 0)
})

test('自动回复总开关关闭：实时消息不自动发送（disabled）', async () => {
  const s = setup({ global: { enabled: false, mode: 'auto' } })
  await s.runtime.init()
  const decision = await s.runtime.handleIncomingMessage(chatMessage())
  assert.equal(decision.kind, 'skip')
  assert.equal(decision.reason, 'disabled')
  assert.equal(s.sentCount(), 0)
})

test('CHAT_SEND_MESSAGE：显式发送一次并回 messageId 与事件', async () => {
  const s = setup()
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '你好' }),
  )
  assert.equal(response.ok, true)
  assert.equal(s.sentCount(), 1)
  const events = s.runtime.drainEvents()
  assert.ok(events.some((e) => e.type === EventTypes.CHAT_MESSAGE_SENT))
})

test('CHAT_SEND_MESSAGE：非法负载被拒，不发送', async () => {
  const s = setup()
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_SEND_MESSAGE, { sessionId: 's1', receiverId: 'peer', content: '' }),
  )
  assert.equal(response.ok, false)
  assert.equal(s.sentCount(), 0)
})

test('CHAT_APPLY_REPLY：从会话消息推断接收者并发送', async () => {
  const s = setup()
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_APPLY_REPLY, { sessionId: 's1', content: '好的', messageId: 'msg1' }),
  )
  assert.equal(response.ok, true)
  const request = s.transport.sent[0]
  const receivers = request.body[1] as { actualReceivers: string[] }
  assert.deepEqual(receivers.actualReceivers, ['peer@goofish', 'me@goofish'])
})

test('CHAT_RULES_GET/SET：写入规则与全局配置并回读', async () => {
  const s = setup()
  const setResponse = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_RULES_SET, {
      global: { enabled: false, mode: 'manual' },
      rules: [keywordRule({ id: 'r2', pattern: '发货' })],
    }),
  )
  assert.equal(setResponse.ok, true)
  const status = s.runtime.getStatus()
  assert.equal(status.enabled, false)
  assert.equal(status.mode, 'manual')

  const getResponse = await s.runtime.handleCommand(createCommand(CommandTypes.CHAT_RULES_GET, {}))
  const result = getResponse.result as { global: ReplyGlobalConfig; rules: KeywordReplyRule[] }
  assert.equal(result.rules.length, 1)
  assert.equal(result.rules[0].id, 'r2')
  assert.ok(s.runtime.drainEvents().some((e) => e.type === EventTypes.CHAT_RULES_UPDATED))
})

test('CHAT_RULES_SET：规则携带 API key 被拒（敏感字段）', async () => {
  const s = setup()
  const dirty = { ...keywordRule(), aiApiKey: 'sk-should-not-persist' }
  const response = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_RULES_SET, { rules: [dirty] as never }),
  )
  assert.equal(response.ok, false)
})

test('CHAT_AUTO_REPLY_STATUS / CHAT_RULES_GET：仅接受空对象负载', async () => {
  const s = setup()
  const ok = await s.runtime.handleCommand(createCommand(CommandTypes.CHAT_AUTO_REPLY_STATUS, {}))
  assert.equal(ok.ok, true)
  const bad = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_AUTO_REPLY_STATUS, { extra: 1 } as never),
  )
  assert.equal(bad.ok, false)
})

test('CHAT_AI_PAUSE_SET：手动暂停/恢复并广播事件', async () => {
  const s = setup()
  const paused = await s.runtime.handleCommand(
    createCommand(CommandTypes.CHAT_AI_PAUSE_SET, { paused: true, durationMs: 60000, reason: 'manual' }),
  )
  assert.equal(paused.ok, true)
  assert.equal(s.runtime.getStatus().aiPaused, true)
  const resumed = await s.runtime.handleCommand(createCommand(CommandTypes.CHAT_AI_PAUSE_SET, { paused: false }))
  assert.equal(resumed.ok, true)
  assert.equal(s.runtime.getStatus().aiPaused, false)
  assert.ok(s.runtime.drainEvents().some((e) => e.type === EventTypes.CHAT_AI_PAUSE_CHANGED))
})

test('自动模式：handleIncomingMessage 触发一次发送并记事件', async () => {
  const s = setup({ global: { mode: 'auto' } })
  await s.runtime.init()
  const decision = await s.runtime.handleIncomingMessage(chatMessage())
  assert.equal(decision.kind, 'auto')
  assert.equal(s.sentCount(), 1)
  const events = s.runtime.drainEvents()
  assert.ok(events.some((e) => e.type === EventTypes.CHAT_AUTO_REPLY_TRIGGERED))
  assert.ok(events.some((e) => e.type === EventTypes.CHAT_MESSAGE_SENT))
})

test('非 Web 端 out 消息触发 AI 暂停（决定被暂停拦截）', async () => {
  const s = setup()
  await s.runtime.init()
  const decision = await s.runtime.handleIncomingMessage(chatMessage({ direction: 'out', senderId: 'me', platform: 'android' }))
  assert.equal(decision.kind, 'skip')
  assert.equal(decision.reason, 'ai-paused')
  assert.equal(s.runtime.getStatus().aiPaused, true)
  assert.ok(s.runtime.drainEvents().some((e) => e.type === EventTypes.CHAT_AI_PAUSE_CHANGED))
})

test('reloadConfig：迁移后刷新内存配置并广播 CHAT_RULES_UPDATED', async () => {
  const s = setup()
  await s.runtime.init()
  assert.equal(s.runtime.getStatus().rulesCount, 1)

  // 模拟迁移写入：规则变为 2 条（禁用），全局切 manual。
  await s.store.saveRules([
    { ...keywordRule({ id: 'r9', pattern: '发货' }), enabled: false },
    keywordRule({ id: 'r10' }),
  ])
  await s.store.saveGlobalConfig({ ...DEFAULT_REPLY_GLOBAL_CONFIG, enabled: false, mode: 'manual' })

  await s.runtime.reloadConfig()
  const status = s.runtime.getStatus()
  assert.equal(status.rulesCount, 2)
  assert.equal(status.mode, 'manual')
  assert.equal(status.enabled, false)
  assert.ok(s.runtime.drainEvents().some((e) => e.type === EventTypes.CHAT_RULES_UPDATED))
})

test('message-router：P6 命令路由到 reply deps；未接线回 INTERNAL', async () => {
  const command = createCommand(CommandTypes.CHAT_AUTO_REPLY_STATUS, {})
  const baseDeps = {
    now: () => 1,
    workerStartedAt: 1,
    incrementPingCount: async () => 1,
    broadcast: () => 0,
    subscribe: (e: string[]) => e,
    unsubscribe: (e: string[]) => e,
  }
  const routed = await handleCommand(command, {
    ...baseDeps,
    reply: {
      handleCommand: async () => ({
        kind: 'response',
        protocol: 1,
        requestId: command.requestId,
        type: command.type,
        ok: true,
        result: { routed: true },
        respondedAt: 1,
      }),
    },
  } as never)
  assert.equal(routed.ok, true)
  assert.deepEqual(routed.result, { routed: true })

  // 未接线时回 INTERNAL，而不是 UNKNOWN_COMMAND。
  const noReply = await handleCommand(command, { ...baseDeps } as never)
  assert.equal(noReply.ok, false)
  assert.equal(noReply.error?.code, 'INTERNAL')
})
