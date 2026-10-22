import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isChatWire } from './chat-wire.ts'
const message = { sourceId: 'm', sessionId: 's', senderId: 'u', text: '消息', sentAt: 1 }
test('交付帧严格校验账号、来源消息与未知字段', () => {
  const delivery = { kind: 'chat-delivery', accountId: 'a', message }
  assert.equal(isChatWire(delivery), true)
  for (const value of [{ ...delivery, accountId: '' }, { ...delivery, token: 'forbidden' }, { ...delivery, message: { ...message, sourceId: '' } }, { ...delivery, message: { ...message, extra: true } }]) assert.equal(isChatWire(value), false)
})
test('ACK必须引用账号、来源和已持久事件的正游标', () => {
  const ack = { kind: 'chat-ack', accountId: 'a', sourceId: 'm', eventSeq: '9223372036854775807' }
  assert.equal(isChatWire(ack), true)
  for (const eventSeq of ['0', '01', '-1', '9223372036854775808', 1]) assert.equal(isChatWire({ ...ack, eventSeq }), false)
  assert.equal(isChatWire({ ...ack, sourceId: ' ' }), false)
  assert.equal(isChatWire({ ...ack, extra: true }), false)
})
test('缺口帧只接受固定原因与账号字段',()=>{
  for(const reason of ['OUTBOX_CAPACITY','PAGE_GAP'])assert.equal(isChatWire({kind:'chat-gap',accountId:'a',reason}),true)
  for(const frame of [{kind:'chat-gap',accountId:'a',reason:'unknown'},{kind:'chat-gap',accountId:'',reason:'PAGE_GAP'},{kind:'chat-gap',accountId:'a',reason:'PAGE_GAP',message:'private'}])assert.equal(isChatWire(frame),false)
})

test('缺口事件绑定外层账号和原因，旧帧仍兼容', () => {
  const occurrence = { accountId: 'a', reason: 'OUTBOX_CAPACITY', occurrenceId: 'a8123490-1111-4111-8111-123456789abc', generation: 1, scope: { scope: 'session', sessionId: 's' } }
  const frame = { kind: 'chat-gap', accountId: 'a', reason: 'OUTBOX_CAPACITY', occurrence }
  assert.equal(isChatWire(frame), true)
  assert.equal(isChatWire({ ...frame, accountId: 'b' }), false)
  assert.equal(isChatWire({ ...frame, reason: 'PAGE_GAP' }), false)
  assert.equal(isChatWire({ ...frame, occurrence: { ...occurrence, generation: -1 } }), false)
})
