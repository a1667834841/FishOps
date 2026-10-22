import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isChatMessage, normalizeChatParams } from './chat.ts'

const message = () => ({ sourceId: 'source', sessionId: 'session', senderId: 'sender', text: '', sentAt: 0 })
const bad = (method: string, value: unknown) => assert.throws(() => normalizeChatParams(method, value), { code: 'BAD_REQUEST' })

test('消息严格验证，不生成来源 ID，接受正文和时间边界', () => {
  assert.equal(isChatMessage(message()), true)
  assert.equal(isChatMessage({ ...message(), sourceId: 's'.repeat(128), text: 'a'.repeat(20000), sentAt: Number.MAX_SAFE_INTEGER }), true)
  for (const field of ['sourceId', 'sessionId', 'senderId', 'itemId', 'peerUserId']) {
    for (const value of ['', '  ', 'x'.repeat(129), 1, null, undefined]) {
      assert.equal(isChatMessage({ ...message(), [field]: value }), false, `${field}: ${String(value)}`)
    }
  }
  for (const sentAt of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) {
    assert.equal(isChatMessage({ ...message(), sentAt }), false)
  }
  for (const value of [null, [], { ...message(), text: 'a'.repeat(20001) }, { ...message(), token: 'secret' }, Object.create(message())]) {
    assert.equal(isChatMessage(value), false)
  }
  assert.equal(isChatMessage({ ...message(), text: '😀'.repeat(10000) }), true)
  assert.equal(isChatMessage({ ...message(), text: '\u0000'.repeat(20000) }), false, 'JSON 转义后超过 64KiB')
  assert.equal(isChatMessage({ ...message(), text: '中'.repeat(20000) }), true)
})

test('单消息 JSON 字节上限包含字段开销且严格接受等号边界', () => {
  const overhead = new TextEncoder().encode(JSON.stringify(message())).length
  const text = '\u0000'.repeat(9000) + '中'.repeat(3000)
  const base = { ...message(), text }
  const size = new TextEncoder().encode(JSON.stringify(base)).length
  const exact = { ...base, text: text + 'a'.repeat(65536 - size) }
  assert.ok(overhead > 0)
  assert.equal(isChatMessage(exact), true)
  assert.equal(isChatMessage({ ...exact, text: exact.text + 'a' }), false)
})

test('消息查询规范化默认值，sessionId 或 tag 至少一个，不改变输入', () => {
  const input = { sessionId: ' session ', tag: '任务', afterSeq: '9223372036854775807', limit: 500 }
  assert.deepEqual(normalizeChatParams('chat.messages', input), { ...input, sessionId: 'session' })
  assert.equal(input.sessionId, ' session ')
  assert.deepEqual(normalizeChatParams('chat.messages', { tag: '任务' }), { tag: '任务', afterSeq: '0', limit: 100 })
  bad('chat.messages', {})
  bad('chat.messages', { sessionId: ' ' })
})

test('会话分页使用本地 afterId，updatedAfter 仅筛选', () => {
  assert.deepEqual(normalizeChatParams('chat.conversations', {}), { afterId: '0', limit: 100 })
  assert.deepEqual(normalizeChatParams('chat.conversations', { afterId: '42', updatedAfter: 0, itemId: ' i ' }), { afterId: '42', limit: 100, updatedAfter: 0, itemId: 'i' })
  for (const updatedAfter of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) bad('chat.conversations', { updatedAfter })
})

test('查询拒绝非法游标、超限、未知字段及空白 ID', () => {
  for (const [method, cursor] of [['chat.messages', 'afterSeq'], ['chat.conversations', 'afterId']]) {
    for (const value of ['01', '-1', '1.0', ' 1', '9223372036854775808', '', 1, null]) bad(method!, { sessionId: 's', [cursor!]: value })
  }
  for (const method of ['chat.messages', 'chat.conversations']) {
    for (const limit of [0, 501, 1.5, NaN, '1']) bad(method, { tag: 't', limit })
    for (const tag of ['', ' ', 'a'.repeat(129)]) bad(method, { tag })
    bad(method, { tag: 't', accountId: 'other' })
    for (const value of [null, [], Object.create({ tag: 't' })]) bad(method, value)
  }
  bad('chat.conversations', { itemId: ' ' })
})

test('同步只验证显式会话及调度选项，不发请求', () => {
  assert.deepEqual(normalizeChatParams('chat.sync', {}), { maxWaitMs: 120000 })
  assert.deepEqual(normalizeChatParams('chat.sync', { sessionId: ' s ', maxWaitMs: 600000, minIntervalMs: 0, tag: '任务' }), { sessionId: 's', maxWaitMs: 600000, minIntervalMs: 0, tag: '任务' })
  for (const value of [{ sessionId: ' ' }, { sessionId: 's'.repeat(129) }, { maxWaitMs: 0 }, { maxWaitMs: 600001 }, { minIntervalMs: -1 }, { minIntervalMs: 600001 }, { limit: 10 }]) bad('chat.sync', value)
  assert.throws(() => normalizeChatParams('unknown', {}), { code: 'NOT_FOUND' })
})

test('本地聊天查询注册公共协议，显式同步未提前注册', async () => {
  const { METHODS, validateParams } = await import('./index.ts')
  assert.ok(METHODS.includes('chat.messages'))
  assert.ok(METHODS.includes('chat.conversations'))
  assert.deepEqual(validateParams('chat.messages', { sessionId: 's' }), { sessionId: 's', afterSeq: '0', limit: 100 })
  assert.deepEqual(validateParams('chat.conversations', {}), { afterId: '0', limit: 100 })
  assert.throws(() => validateParams('chat.messages', {}))
  assert.deepEqual(validateParams('chat.sync', {}), { limit: 20, maxWaitMs: 120000 })
})
