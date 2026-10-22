import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeChatSyncInput } from './chat-sync-input.ts'
test('公共同步单页默认值和凭证参数严格规范化', () => {
  assert.deepEqual(normalizeChatSyncInput({}), { limit: 20, maxWaitMs: 120000 })
  assert.deepEqual(normalizeChatSyncInput({ sessionId: 's', cursor: 'opaque_cursor', limit: 100, minIntervalMs: 0 }), { sessionId: 's', cursor: 'opaque_cursor', limit: 100, maxWaitMs: 120000, minIntervalMs: 0 })
  for (const value of [null, [], { anchor: '123' }, { cursor: '' }, { cursor: 'x=' }, { sessionId: ' ' }, { limit: 101 }, { maxWaitMs: 0 }, { minIntervalMs: -1 }]) assert.throws(() => normalizeChatSyncInput(value))
})

test('拒绝访问器和隐藏字段，不执行调用者getter', () => {
  let called = false
  const input = { get limit() { called = true; return 20 } }
  assert.throws(() => normalizeChatSyncInput(input))
  assert.equal(called, false)
  assert.throws(() => normalizeChatSyncInput(Object.defineProperty({}, 'token', { value: 'secret' })))
})
test('平台会话后缀在绑定同步范围前归一化，其他域与空白拒绝', () => {
  assert.equal(normalizeChatSyncInput({ sessionId: 'c@goofish' }).sessionId, 'c')
  for (const sessionId of ['c@other', 'c@@goofish', 'c d', ' c']) {
    assert.throws(() => normalizeChatSyncInput({ sessionId }), { code: 'BAD_REQUEST' })
  }
})
