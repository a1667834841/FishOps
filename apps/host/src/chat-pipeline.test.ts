import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createPageChat } from '../../extension/src/page-chat.ts'
import { createChatCollector } from '../../extension/src/chat-collector.ts'
import { ChatOutbox, type OutboxState } from '../../extension/src/chat-outbox.ts'
import { NativeBridge } from './bridge.ts'
import { HostDatabase } from './database.ts'
import { HostServer } from './server.ts'
import { encodeFrame, FrameDecoder } from './framing.ts'

test('页面推送经持久队列、native提交ACK到HTTP查询，重投不重复', async t => {
  let sends = 0
  class Socket extends EventTarget { send() { sends++ } }
  const scope = { WebSocket: Socket as unknown as typeof WebSocket }
  const page = createPageChat(scope, () => 'account')
  t.after(() => page.dispose())
  const socket = new scope.WebSocket('wss://wss-goofish.dingtalk.com/')
  const raw = JSON.stringify({ body: { syncPushPackage: { data: [{ data: { '1': { '2': 'session@goofish', '3': 'platform-id', '5': 100, '10': { senderUserId: 'peer', reminderContent: '测试消息' } } } }] } } })
  socket.dispatchEvent(new MessageEvent('message', { data: raw }))
  let saved: OutboxState | undefined
  const storage = { read: async () => saved, write: async (state: OutboxState) => { saved = structuredClone(state) } }
  const box = new ChatOutbox(storage)
  const collector = createChatCollector({ source: { peek: async () => ({ messages: page.peek('account'), syncRequired: page.status().syncRequired }), acknowledge: async ids => { page.ack('account', ids) } }, persist: async message => { await box.enqueue({ accountId: 'account', sourceId: message.sourceId, payload: message }) }, gap: async () => assert.fail() })
  assert.equal(await collector.collect(), 1)
  assert.equal(page.status().queued, 0)
  const restored = new ChatOutbox(storage)
  const db = new HostDatabase(':memory:'); t.after(() => db.close())
  const input = new PassThrough(), output = new PassThrough(), decoder = new FrameDecoder(), replies: any[] = []
  output.on('data', chunk => replies.push(...decoder.push(chunk)))
  const bridge = new NativeBridge(input, output, () => {}, 1000, () => assert.fail('通道不应失败'), (account, message) => db.ingestChatMessage(account, message))
  t.after(() => bridge.close())
  input.write(encodeFrame({ kind: 'hello', protocolVersion: 1, extensionVersion: 'test', account: { userId: 'account', nick: '测试' } }))
  const pending = (await restored.snapshot('account')).entries[0]
  const delivery = { kind: 'chat-delivery' as const, accountId: 'account', message: pending.payload as any }
  input.write(encodeFrame(delivery)); input.write(encodeFrame(delivery))
  assert.deepEqual(replies[0], replies[1])
  await restored.acknowledge('account', replies[0].sourceId)
  assert.equal((await new ChatOutbox(storage).snapshot('account')).entries.length, 0)
  const server = new HostServer(0, 'test-token', bridge, db); const port = await server.listen(); t.after(() => server.close())
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat.messages`, { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ sessionId: 'session' }) })
  const result = await response.json() as any
  assert.equal(response.status, 200); assert.equal(result.data.items.length, 1)
  assert.equal(result.data.items[0].sourceId, 'platform-id')
  assert.equal(db.events({ types: ['chat.message'] }, 'account').items.length, 1)
  assert.equal(sends, 0, '被动接收不能发送任何平台数据')
})

test('持久容量缺口经真实帧进入生产落库函数，重建重投不重复事件', async t => {
  const { ChatGapLedger } = await import('./chat-gap-ledger.ts')
  const { persistChatGapOccurrence } = await import('./main.ts')
  let saved: OutboxState = { version: 1, entries: Array.from({ length: 1000 }, (_, n) => ({ accountId: 'account', sourceId: String(n), payload: { sourceId: String(n), sessionId: 's', senderId: 'peer', text: '测试', sentAt: 1 } })), gaps: [] }
  const storage = { read: async () => structuredClone(saved), write: async (value: OutboxState) => { saved = structuredClone(value) } }
  const lost = { accountId: 'account', sourceId: 'lost', payload: { sourceId: 'lost', sessionId: 's', senderId: 'peer', text: '测试', sentAt: 1 } }
  assert.equal(await new ChatOutbox(storage).enqueue(lost), 'gap')
  const db = new HostDatabase(':memory:'); t.after(() => db.close())
  const ledger = new ChatGapLedger(db)
  for (let n = 0; n < 2; n++) {
    const input = new PassThrough(), output = new PassThrough()
    const bridge = new NativeBridge(input, output, () => {}, 1000, () => assert.fail('合法缺口不能关闭通道'), undefined, (_account, _reason, occurrence) => {
      assert.ok(occurrence)
      persistChatGapOccurrence(db, ledger, occurrence)
    })
    t.after(() => { bridge.close(); input.destroy(); output.destroy() })
    input.write(encodeFrame({ kind: 'hello', protocolVersion: 1, extensionVersion: 'test', account: { userId: 'account', nick: '测试' } }))
    const occurrence = (await new ChatOutbox(storage).gapOccurrences('account'))[0]
    input.write(encodeFrame({ kind: 'chat-gap', accountId: 'account', reason: 'OUTBOX_CAPACITY', occurrence }))
    assert.equal(bridge.ready, true)
    bridge.close()
  }
  assert.equal(ledger.snapshot('account').lines[0].generation, 1)
  assert.equal(db.events({ types: ['chat.gap'] }, 'account').items.length, 1)
  assert.equal(db.events({ types: ['chat.gap'] }, 'other').items.length, 0)
  assert.equal(saved.entries.length, 1000)
})

test('缺口事件提交失败时账本一同回滚，恢复后可安全重投', async t => {
  const { ChatGapLedger } = await import('./chat-gap-ledger.ts')
  const { persistChatGapOccurrence } = await import('./main.ts')
  const db = new HostDatabase(':memory:'); t.after(() => db.close())
  const ledger = new ChatGapLedger(db)
  const occurrence = { accountId: 'account', reason: 'OUTBOX_CAPACITY' as const, occurrenceId: 'failure-1', generation: 1, scope: { scope: 'session' as const, sessionId: 's' } }
  const original = db.event
  db.event = () => { throw new Error('模拟事件落库失败') }
  assert.throws(() => persistChatGapOccurrence(db, ledger, occurrence), /模拟事件落库失败/)
  assert.equal(ledger.snapshot('account').lines.length, 0)
  db.event = original
  assert.equal(persistChatGapOccurrence(db, ledger, occurrence), true)
  assert.equal(persistChatGapOccurrence(db, ledger, occurrence), false)
  assert.equal(ledger.snapshot('account').lines[0].generation, 1)
  assert.equal(db.events({ types: ['chat.gap'] }, 'account').items.length, 1)
})
