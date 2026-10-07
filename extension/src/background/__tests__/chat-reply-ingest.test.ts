/** 真实后台接线 + store/runtime 回归；回复依赖为禁止外发的替身。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatRuntime } from '../chat-runtime'
import { createChatReplyIngestor } from '../chat-reply-ingest'

const sender = { id: 'ext', tab: { id: 1 }, url: 'https://www.goofish.com/im' }
function frame(id: string, time = 200, from = 'peer', platform?: string) {
  return { event: 'message' as const, at: 300, raw: JSON.stringify({ body: {
    extension: { senderUserId: from, sessionId: 's', _platform: platform },
    content: { custom: { contentType: 1, summary: '测试' } },
    messageId: id, createAt: time,
  } }) }
}
async function harness(myUserId: string | null = 'me') {
  const chat = createChatRuntime({ ...(myUserId ? { myUserId } : {}) })
  await chat.init()
  const seen: Array<{ messageId: string; platform?: string; direction: string }> = []
  let fail = false
  let blocked: Promise<void> | undefined
  let broadcasts = 0
  const ingest = createChatReplyIngestor({
    extensionId: 'ext', liveSince: 100,
    getChatRuntime: async () => chat,
    getReplyRuntime: async () => ({ handleIncomingMessage: async m => {
      seen.push(m)
      if (blocked) await blocked
      if (fail) throw new Error('安全替身失败')
    } }),
    flushChatEvents: () => {}, flushReplyEvents: () => { broadcasts++ },
    onReplyError: () => {},
  })
  return { chat, seen, ingest, setFail: (v: boolean) => { fail = v },
    setBlocked: (v: Promise<void>) => { blocked = v }, broadcasts: () => broadcasts }
}

test('可信新消息只触发一次；缓存重放、启动前历史与不可信来源不触发', async () => {
  const h = await harness()
  assert.equal(await h.ingest.handle(frame('new'), sender), true)
  await h.ingest.handle(frame('new'), sender)
  await h.ingest.handle(frame('old', 99), sender)
  assert.equal(await h.ingest.handle(frame('fake'), { ...sender, id: 'other' }), false)
  await h.ingest.drainReplies()
  assert.deepEqual(h.seen.map(m => m.messageId), ['new'])
  assert.equal(h.chat.getStore().messageCount, 2)
})

test('无可靠当前账号不触发；平台与方向保留到回复入口', async () => {
  const unknown = await harness(null)
  await unknown.ingest.handle(frame('unknown'), sender)
  await unknown.ingest.drainReplies()
  assert.equal(unknown.seen.length, 0)
  const h = await harness()
  await h.ingest.handle(frame('mobile', 200, 'me', 'android'), sender)
  await h.ingest.handle(frame('web', 201, 'me', 'web'), sender)
  await h.ingest.drainReplies()
  assert.deepEqual(h.seen.map(m => [m.platform, m.direction]), [['android', 'out'], ['web', 'out']])
})

test('回复在途不阻塞后续聊天入库；异常后继续并广播事件', async () => {
  const h = await harness()
  let unblock!: () => void
  h.setBlocked(new Promise(resolve => { unblock = resolve }))
  h.setFail(true)
  await h.ingest.handle(frame('one'), sender)
  await h.ingest.handle(frame('two'), sender)
  assert.equal(h.chat.getStore().messageCount, 2)
  unblock()
  await h.ingest.drainReplies()
  h.setFail(false)
  await h.ingest.handle(frame('three'), sender)
  await h.ingest.drainReplies()
  assert.deepEqual(h.seen.map(m => m.messageId), ['one', 'two', 'three'])
  assert.equal(h.broadcasts(), 3)
})

// 接入真实回复引擎，transport 只计数，不连接平台或 LLM。
import { EventTypes } from '@fishops/shared'
import { DEFAULT_REPLY_GLOBAL_CONFIG } from '../../../../shared/types/reply'
import { MemoryReplyConfigStore } from '../../chat/reply-config'
import { ChatMessageSender } from '../../chat/send-client'
import { AiChatService } from '../../chat/ai-service'
import { createReplyRuntime } from '../reply-runtime'

for (const enabled of [true, false]) test(`后台接线 + 真实回复运行时：enabled=${enabled}，自动规则及暂停事件`, async () => {
  const chat = createChatRuntime({ myUserId: 'me' })
  await chat.init()
  let sends = 0
  const events: string[] = []
  const reply = createReplyRuntime({
    configStore: new MemoryReplyConfigStore({
      global: { ...DEFAULT_REPLY_GLOBAL_CONFIG, enabled, mode: 'auto', defaultDelay: 0 },
      rules: [{ id: 'keyword', type: 'keyword', name: '测试', enabled: true, priority: 1,
        pattern: '^测试$', reply: '安全测试回复', delay: 0 }],
    }),
    sender: new ChatMessageSender({ transport: { send: async request => {
      sends++
      return { code: 200, headers: { mid: request.headers.mid }, body: {} }
    } }, midFactory: () => 'mid', uuidFactory: () => 'uuid', now: () => 300 }),
    ai: new AiChatService({ loadProvider: async () => ({ apiKey: '', baseUrl: '', model: '', timeoutMs: 1000 }) }),
    getMessages: async (id, options) => chat.getStore().getMessages(id, options),
    myUserId: 'me', now: () => 300, sleep: async () => {},
  })
  const ingest = createChatReplyIngestor({
    extensionId: 'ext', liveSince: 100, getChatRuntime: async () => chat, getReplyRuntime: async () => reply,
    flushChatEvents: () => { chat.drainEvents() },
    flushReplyEvents: () => { events.push(...reply.drainEvents().map(e => e.type)) }, onReplyError: () => assert.fail('回复失败'),
  })
  await ingest.handle(frame('new'), sender)
  await ingest.handle(frame('new'), sender)
  await ingest.handle(frame('old', 99), sender)
  const nonMatching = frame('no-match')
  nonMatching.raw = nonMatching.raw.replace('测试', '无匹配')
  await ingest.handle(nonMatching, sender)
  await ingest.drainReplies()
  assert.equal(sends, enabled ? 1 : 0)
  assert.equal(events.includes(EventTypes.CHAT_AUTO_REPLY_TRIGGERED), enabled)
  await ingest.handle(frame('web', 200, 'me', 'web'), sender)
  await ingest.handle(frame('unknown', 200, 'me'), sender)
  await ingest.drainReplies()
  assert.equal(reply.getStatus().aiPaused, false)
  await ingest.handle(frame('mobile', 200, 'me', 'android'), sender)
  await ingest.drainReplies()
  assert.equal(reply.getStatus().aiPaused, true)
  assert.ok(events.includes(EventTypes.CHAT_AI_PAUSE_CHANGED))
  assert.equal(sends, enabled ? 1 : 0)
})

test('非法负载、心跳、未来时间不触发；启动边界的新消息正常处理', async () => {
  const h = await harness()
  assert.equal(await h.ingest.handle({ event: 'message', raw: 'x', at: 'bad' }, sender), false)
  for (const connectedAt of [NaN, Infinity, -1, '100', 400]) {
    assert.equal(await h.ingest.handle({ ...frame('invalid-boundary'), connectedAt }, sender), false)
  }
  await h.ingest.handle({ event: 'open', at: 300 }, sender)
  await h.ingest.handle({ event: 'message', at: 300, raw: JSON.stringify({ code: 200 }) }, sender)
  await h.ingest.handle(frame('future', 301), sender)
  await h.ingest.handle(frame('boundary', 100), sender)
  await h.ingest.drainReplies()
  assert.deepEqual(h.seen.map(m => m.messageId), ['boundary'])
})

test('同批 sync 重复和已同步历史只入库，不触发重复回复', async () => {
  const h = await harness()
  const record = (id: string) => ({ '1': {
    '10': { senderUserId: 'peer', reminderContent: '测试', reminderUrl: 'https://x?sid=s' },
    '2': 'me@goofish', '3': id, '5': 200,
  } })
  h.chat.getStore().upsertMessages([{
    id: 'known', messageId: 'known', sessionId: 's', cid: 's', senderId: 'peer', senderName: '', receiverId: 'me',
    direction: 'in', kind: 'text', contentType: 101, content: '测试', createAt: 200, source: 'history',
  }])
  await h.ingest.handle({ event: 'message', at: 300, raw: JSON.stringify({ body: { syncPushPackage: { data: [
    { data: record('known') }, { data: record('fresh') }, { data: record('fresh') },
  ] } } }) }, sender)
  await h.ingest.drainReplies()
  assert.deepEqual(h.seen.map(m => m.messageId), ['fresh'])
})

test('Service Worker 唤醒沿用宿主连接边界，不丢弃新入站；连接前补推不回复', async () => {
  const chat = createChatRuntime({ myUserId: 'me' })
  await chat.init()
  const seen: string[] = []
  const ingest = createChatReplyIngestor({
    extensionId: 'ext', liveSince: 250, getChatRuntime: async () => chat,
    getReplyRuntime: async () => ({ handleIncomingMessage: async m => { seen.push(m.messageId) } }),
    flushChatEvents: () => {}, flushReplyEvents: () => {}, onReplyError: () => assert.fail(),
  })
  await ingest.handle({ ...frame('wake', 200), connectedAt: 100 }, sender)
  await ingest.handle({ ...frame('replay', 99), connectedAt: 100 }, sender)
  await ingest.drainReplies()
  assert.deepEqual(seen, ['wake'])
  assert.equal(await ingest.handle({ ...frame('bad'), connectedAt: 400 }, sender), false)
})
