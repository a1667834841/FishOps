import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseChatFrame } from '../chat-parser.ts'

// 沿用 legacy parser.test.ts 的 syncPushPackage 结构，标识和正文均为合成值。
const message = (id = 'platform-message-1') => ({ '1': {
  '2': 'session-fixture@goofish', '3': id, '5': 1700000000000,
  '10': { senderUserId: 'sender-fixture', reminderContent: '测试消息',
    reminderUrl: 'https://www.goofish.com/im?sid=session-fixture&itemId=item-fixture', token: 'must-not-leak' },
} })
const frame = (items: unknown[]) => JSON.stringify({ body: { syncPushPackage: { data: items.map(data => ({ data })) } } })
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')
const error = (raw: unknown, code: string) => assert.deepEqual(parseChatFrame(raw), { kind: 'error', code })

// 测试编码器只生成 fixmap/str16/float64，独立于生产解码器。
function pack(value: any): Buffer {
  if (typeof value === 'string') {
    const bytes = Buffer.from(value), head = Buffer.alloc(3); head[0] = 0xda; head.writeUInt16BE(bytes.length, 1)
    return Buffer.concat([head, bytes])
  }
  if (typeof value === 'number') { const bytes = Buffer.alloc(9); bytes[0] = 0xcb; bytes.writeDoubleBE(value, 1); return bytes }
  const entries = Object.entries(value)
  return Buffer.concat([Buffer.from([0x80 | entries.length]), ...entries.flatMap(([k, v]) => [pack(k), pack(v)])])
}

test('对象、base64 JSON、MessagePack 多条消息与白名单输出', () => {
  const result = parseChatFrame(frame([message(), b64(message('platform-message-2')), pack(message('platform-message-3')).toString('base64')]))
  assert.equal(result.kind, 'messages')
  if (result.kind !== 'messages') return
  assert.equal(result.messages.length, 3)
  assert.deepEqual(result.messages[0], { sourceId: 'platform-message-1', sessionId: 'session-fixture',
    senderId: 'sender-fixture', text: '测试消息', sentAt: 1700000000000, itemId: 'item-fixture' })
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
})
test('编码文本优先使用 6/3/5，不伪造正文', () => {
  const data: any = message()
  data['1']['6'] = { '3': { '5': JSON.stringify({ contentType: 1, text: { text: '完整文本' } }) } }
  const result = parseChatFrame(frame([b64(data)]))
  assert.equal(result.kind, 'messages')
  if (result.kind === 'messages') assert.equal(result.messages[0].text, '完整文本')
})
test('重复同消息去重，冲突内容与缺 sourceId 整帧失败', () => {
  const result = parseChatFrame(frame([message(), message()]))
  assert.equal(result.kind, 'messages'); if (result.kind === 'messages') assert.equal(result.messages.length, 1)
  const missing: any = message(); delete missing['1']['3']
  error(frame([message(), missing]), 'MISSING_SOURCE_ID')
  const conflict = message(); conflict['1']['10'].reminderContent = '冲突'
  error(frame([message(), conflict]), 'CONFLICTING_MESSAGE')
})
test('空、坏、超限、深嵌套、超量与不支持编码明确分类', () => {
  error(null, 'NOT_STRING'); error(' ', 'EMPTY_INPUT'); error('{', 'INVALID_JSON')
  error('中'.repeat(90000), 'FRAME_TOO_LARGE')
  error(frame(Array.from({ length: 101 }, () => message())), 'LIMIT_EXCEEDED')
  error(frame(['!!!']), 'INVALID_ENCODING')
  error(frame([Buffer.from([0xc7, 0, 0]).toString('base64')]), 'UNSUPPORTED_ENCODING')
  error(JSON.stringify({ x: JSON.parse('['.repeat(20) + '0' + ']'.repeat(20)) }), 'LIMIT_EXCEEDED')
  error(frame([{}]), 'INVALID_MESSAGE')
  error(JSON.stringify({ body: { syncPushPackage: {} } }), 'INVALID_MESSAGE')
})
test('未知控制帧和明确空推送 ignored，消息结构缺字段不能空成功', () => {
  assert.deepEqual(parseChatFrame('{"code":200}'), { kind: 'ignored' })
  assert.deepEqual(parseChatFrame(frame([])), { kind: 'ignored' })
  const data: any = message(); delete data['1']['5']
  error(frame([data]), 'INVALID_MESSAGE')
})

test('MessagePack 截断、尾随字节与深层 base64 JSON 不静默成功', () => {
  const bytes = pack(message())
  error(frame([bytes.subarray(0, bytes.length - 1).toString('base64')]), 'INVALID_ENCODING')
  error(frame([Buffer.concat([bytes, Buffer.from([0])]).toString('base64')]), 'INVALID_ENCODING')
  error(frame([b64(JSON.parse('['.repeat(20) + '0' + ']'.repeat(20)))]), 'LIMIT_EXCEEDED')
})
test('来源 ID 必须为稳定字符串，正文超限与不支持图片正文明确失败', () => {
  const numeric: any = message(); numeric['1']['3'] = 123
  error(frame([numeric]), 'MISSING_SOURCE_ID')
  const long = message(); long['1']['10'].reminderContent = 'x'.repeat(20001)
  error(frame([long]), 'INVALID_MESSAGE')
  const image: any = message(); image['1']['6'] = { '3': { '5': '{"contentType":2,"image":{}}' } }
  error(frame([image]), 'INVALID_MESSAGE')
})

test('诊断只返回固定阶段，不改变失败结果或暴露输入', () => {
  const stages: string[] = []
  assert.deepEqual(parseChatFrame(frame([{}]), stage => stages.push(stage)), { kind: 'error', code: 'INVALID_MESSAGE' })
  assert.equal(stages[0], 'ROOT_SHAPE_1_absent_2_absent_3_absent_4_absent_5_absent_6_absent_10_absent')
  assert.ok(stages.includes('ROOT_SHAPE_KEYS_EMPTY'))
  assert.ok(stages.includes('ROOT_KEY_CLASS_NONNUMERIC_0_-1_0'))
  assert.equal(stages.at(-1), 'MESSAGE_ROOT_UNKNOWN')
  assert.deepEqual(parseChatFrame(frame([{ '1': {} }]), () => { throw new Error('诊断自身失败') }), { kind: 'error', code: 'INVALID_MESSAGE' })
})

test('未知结构诊断不输出业务键名或字段值，仍保持失败', () => {
  const stages: string[] = []
  const result = parseChatFrame(frame([{ 'account-secret-key': 'token-secret-value', '2': 'private-message' }]), stage => stages.push(stage))
  assert.deepEqual(result, { kind: 'error', code: 'INVALID_MESSAGE' })
  assert.ok(stages.some(stage => stage.includes('2_string')))
  assert.equal(JSON.stringify(stages).includes('secret'), false)
  assert.equal(JSON.stringify(stages).includes('private'), false)
})
