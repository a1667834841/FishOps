import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AccountTracker } from '../account.ts'
import { NativeBridge } from '../connection.ts'
import { ChatOutbox, type OutboxState } from '../chat-outbox.ts'
import { FakeEnv, settle } from './fakes.ts'

const message = { sourceId: 'source', sessionId: 'session', senderId: 'sender', text: '私密正文', sentAt: 0 }
const ack = { kind: 'chat-ack', accountId: 'a', sourceId: 'source', eventSeq: '1' }
function fixture() {
  const env = new FakeEnv({ cookies: { unb: 'a' } })
  let state: OutboxState | undefined
  let fail = false
  let hold: Promise<void> | undefined
  const outbox = new ChatOutbox({ read: async () => state, write: async value => {
    if (hold) await hold
    if (fail) throw new Error('私密正文 token account')
    state = structuredClone(value)
  } })
  const account = new AccountTracker(env)
  const bridge = new NativeBridge({ env, account, outbox, dispatch: async () => ({}) })
  return { env, account, outbox, bridge, fail: () => { fail = true }, hold: (promise: Promise<void>) => { hold = promise } }
}
const deliveries = (f: ReturnType<typeof fixture>, port = 0) => f.env.ports[port]!.outbound.filter((v: any) => v.kind === 'chat-delivery')

test('先持久化再投递，ACK 删除持久记录，日志不包含秘密', async () => {
  const f = fixture()
  f.bridge.start(); await settle()
  let release!: () => void
  f.hold(new Promise<void>(resolve => { release = resolve }))
  const ingest = f.bridge.ingestChatMessage('a', message)
  await settle(); assert.equal(deliveries(f).length, 0)
  release(); await ingest
  assert.equal(deliveries(f).length, 1)
  assert.equal((await f.outbox.snapshot('a')).entries.length, 1)
  f.env.ports[0]!.emitMessage(ack); await settle()
  assert.equal((await f.outbox.snapshot('a')).entries.length, 0)
  assert.ok(!f.env.logs.join('').includes(message.text))
  f.bridge.stop()
})

test('断线重连重投当前账号快照，旧 Port ACK 不删除消息', async () => {
  const f = fixture()
  f.bridge.start(); await settle()
  await f.bridge.ingestChatMessage('a', message)
  const old = f.env.ports[0]!
  old.emitDisconnect(); f.bridge.ensureConnected(); await settle()
  assert.equal(deliveries(f, 1).length, 1)
  old.emitMessage(ack); await settle()
  assert.equal((await f.outbox.snapshot('a')).entries.length, 1)
  f.env.ports[1]!.emitMessage(ack); await settle()
  assert.equal((await f.outbox.snapshot('a')).entries.length, 0)
  f.bridge.stop()
})

test('ACK 读取账号期间连接代次改变，不删除旧消息', async () => {
  const f = fixture()
  f.bridge.start(); await settle()
  await f.bridge.ingestChatMessage('a', message)
  const read = f.account.read.bind(f.account)
  let release!: () => void
  let block = true
  f.account.read = async () => {
    if (block) { block = false; await new Promise<void>(resolve => { release = resolve }) }
    return read()
  }
  f.env.ports[0]!.emitMessage(ack); await settle()
  f.env.ports[0]!.emitDisconnect(); f.bridge.ensureConnected(); await settle()
  release(); await settle()
  assert.equal((await f.outbox.snapshot('a')).entries.length, 1)
  f.bridge.stop()
})

test('账号不匹配及非法消息拒绝，错误账号 ACK 不删除', async () => {
  const f = fixture()
  f.bridge.start(); await settle()
  await assert.rejects(f.bridge.ingestChatMessage('b', message), { code: 'ACCOUNT_CHANGED' })
  await assert.rejects(f.bridge.ingestChatMessage('a', { ...message, sourceId: ' ' }), { code: 'BAD_REQUEST' })
  assert.equal(deliveries(f).length, 0)
  await f.bridge.ingestChatMessage('a', message)
  f.env.ports[0]!.emitMessage({ ...ack, accountId: 'b' }); await settle()
  assert.equal((await f.outbox.snapshot('a')).entries.length, 1)
  f.bridge.stop()
})

test('存储失败不发送，固定分类日志不包含原始异常', async () => {
  const f = fixture()
  f.bridge.start(); await settle(); f.fail()
  await assert.rejects(f.bridge.ingestChatMessage('a', message), { code: 'INTERNAL' })
  assert.equal(deliveries(f).length, 0)
  assert.equal((await f.outbox.snapshot('a')).entries.length, 0)
  assert.ok(f.env.logs.includes('warn:聊天交付处理失败'))
  assert.ok(!f.env.logs.join('').includes('token'))
  f.bridge.stop()
})

test('并发接收按入队顺序持久化投递，切换账号不重标旧记录', async () => {
  const f = fixture()
  f.bridge.start(); await settle()
  await Promise.all([
    f.bridge.ingestChatMessage('a', message),
    f.bridge.ingestChatMessage('a', { ...message, sourceId: 'second' }),
  ])
  const ids = deliveries(f).map((v: any) => v.message.sourceId)
  assert.equal(ids.indexOf('source'), 0)
  assert.ok(ids.indexOf('second') > ids.indexOf('source'))
  f.env.setCookie('unb', 'b')
  await f.account.read(); await settle()
  assert.equal((await f.outbox.snapshot('b')).entries.length, 0)
  assert.equal((await f.outbox.snapshot('a')).entries.length, 2)
  f.env.ports[0]!.emitMessage(ack); await settle()
  assert.equal((await f.outbox.snapshot('a')).entries.length, 2)
  f.bridge.stop()
})

test('非法 ACK 不删除消息，握手重投读取失败被捕获', async () => {
  const f = fixture()
  f.bridge.start(); await settle()
  await f.bridge.ingestChatMessage('a', message)
  f.env.ports[0]!.emitMessage({ ...ack, eventSeq: '01' }); await settle()
  assert.equal((await f.outbox.snapshot('a')).entries.length, 1)
  f.bridge.stop()

  const env = new FakeEnv({ cookies: { unb: 'a' } })
  const outbox = new ChatOutbox({ read: async () => { throw new Error('secret') }, write: async () => {} })
  const bridge = new NativeBridge({ env, outbox, account: new AccountTracker(env), dispatch: async () => ({}) })
  bridge.start(); await settle()
  assert.equal(bridge.connected, true)
  assert.ok(env.logs.includes('warn:聊天交付处理失败'))
  assert.ok(!env.logs.join('').includes('secret'))
  bridge.stop()
})

test('容量溢出先通知缺口再拒绝接收，已存消息仍投递且重连不清除缺口', async () => {
  const env = new FakeEnv({ cookies: { unb: 'a' } })
  let saved: OutboxState = { version: 1, entries: Array.from({ length: 1000 }, (_, n) => ({
    accountId: 'a', sourceId: String(n), payload: { ...message, sourceId: String(n) },
  })), gaps: [] }
  const outbox = new ChatOutbox({ read: async () => saved, write: async state => { saved = structuredClone(state) } })
  const bridge = new NativeBridge({ env, outbox, account: new AccountTracker(env), dispatch: async () => ({}) })
  bridge.start(); await settle(20)
  await assert.rejects(bridge.ingestChatMessage('a', message), { code: 'INTERNAL', message: '聊天队列容量不足，消息未持久保存' })
  const frames = env.ports[0]!.outbound as Array<{ kind: string; accountId?: string; reason?: string }>
  const gapIndex = frames.findIndex(frame => frame.kind === 'chat-gap')
  assert.ok(gapIndex >= 0)
  assert.equal(frames[gapIndex].accountId, 'a')
  assert.equal(frames[gapIndex].reason, 'OUTBOX_CAPACITY')
  assert.ok(!frames.some((frame: any) => frame.kind === 'chat-gap' && !frame.occurrence))
  assert.ok(frames.slice(gapIndex + 1).some(frame => frame.kind === 'chat-delivery'))
  assert.equal(saved.entries.length, 1000)
  assert.ok(!saved.entries.some(entry => entry.sourceId === message.sourceId))
  const occurrence = (await outbox.gapOccurrences('a'))[0]
  assert.ok(occurrence)
  assert.ok(env.ports[0]!.outbound.some((frame: any) => frame.kind === 'chat-gap' && frame.occurrence?.occurrenceId === occurrence.occurrenceId))
  env.ports[0]!.emitDisconnect(); bridge.ensureConnected(); await settle(20)
  assert.ok(env.ports[1]!.outbound.some((frame: any) => frame.kind === 'chat-gap'))
  assert.ok(env.ports[1]!.outbound.some((frame: any) => frame.kind === 'chat-gap' && frame.occurrence?.occurrenceId === occurrence.occurrenceId && frame.occurrence.generation === occurrence.generation))
  assert.equal((await outbox.snapshot('a')).syncRequired, true)
  bridge.stop()
})

test('同来源冲突不假成功、不覆盖或发送新正文', async () => {
  const f = fixture()
  f.bridge.start(); await settle()
  await f.bridge.ingestChatMessage('a', message)
  const count = deliveries(f).length
  await assert.rejects(f.bridge.ingestChatMessage('a', { ...message, text: '冲突正文' }), { code: 'INTERNAL' })
  assert.equal(deliveries(f).length, count)
  assert.deepEqual((await f.outbox.snapshot('a')).entries[0]!.payload, message)
  f.bridge.stop()
})

test('页面缺口先持久化后通知，重连保留原因；错账号和存储失败不通知', async () => {
  const f = fixture()
  f.bridge.start(); await settle()
  await assert.rejects(f.bridge.reportChatGap('b'), { code: 'ACCOUNT_CHANGED' })
  let release!: () => void
  f.hold(new Promise<void>(resolve => { release = resolve }))
  const pending = f.bridge.reportChatGap('a', 'PAGE_GAP')
  await settle()
  assert.ok(!f.env.ports[0]!.outbound.some((v: any) => v.kind === 'chat-gap'))
  release(); await pending
  assert.equal((await f.outbox.snapshot('a')).gapReason, 'PAGE_GAP')
  assert.deepEqual(f.env.ports[0]!.outbound.at(-1), { kind: 'chat-gap', accountId: 'a', reason: 'PAGE_GAP' })
  f.env.ports[0]!.emitDisconnect(); f.bridge.ensureConnected(); await settle()
  assert.ok(f.env.ports[1]!.outbound.some((v: any) => v.kind === 'chat-gap' && v.reason === 'PAGE_GAP'))
  f.bridge.stop()
  const failed = fixture()
  failed.bridge.start(); await settle(); failed.fail()
  await assert.rejects(failed.bridge.reportChatGap('a'), { code: 'INTERNAL' })
  assert.ok(!failed.env.ports[0]!.outbound.some((v: any) => v.kind === 'chat-gap'))
  failed.bridge.stop()
})
