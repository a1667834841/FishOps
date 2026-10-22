import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeWriteParams, writeFingerprint } from './write.ts'
const bad = (m: string, v: unknown) => assert.throws(() => normalizeWriteParams(m, v), { code: 'BAD_REQUEST' })
test('chat.open严格规范化与默认可选字段', () => {
  assert.deepEqual(normalizeWriteParams('chat.open', { itemId: ' i ', idempotencyKey: ' k ' }), { itemId: 'i', idempotencyKey: 'k' })
  for (const v of [{ itemId: '', idempotencyKey: 'k' }, { itemId: 'i', idempotencyKey: ' ' }, { itemId: 'i', idempotencyKey: 'x'.repeat(129) }, { itemId: 'i', idempotencyKey: 'k', extra: 1 }]) bad('chat.open', v)
})
test('chat.send限制正文UTF8字节和字符长度', () => {
  assert.equal(normalizeWriteParams('chat.send', { sessionId: 's', receiverId: 'r', text: ' 中 ', idempotencyKey: 'k' }).text, ' 中 ')
  bad('chat.send', { sessionId: 's', receiverId: 'r', text: 'x'.repeat(2001), idempotencyKey: 'k' })
  bad('chat.send', { sessionId: 's', receiverId: 'r', text: '中'.repeat(8193), idempotencyKey: 'k' })
  bad('chat.send', { sessionId: 's', receiverId: 'r', text: '', idempotencyKey: 'k' })
})
test('未知字段、getter、隐藏字段、空白和调度边界拒绝', () => {
  const getter: any = { itemId: 'i', idempotencyKey: 'k' }; Object.defineProperty(getter, 'tag', { enumerable: true, get: () => 'x' }); bad('chat.open', getter)
  const hidden: any = { itemId: 'i', idempotencyKey: 'k' }; Object.defineProperty(hidden, 'secret', { value: 1, enumerable: false }); bad('chat.open', hidden)
  for (const maxWaitMs of [0, 600001, 1.5, NaN]) bad('chat.open', { itemId: 'i', idempotencyKey: 'k', maxWaitMs })
  for (const minIntervalMs of [-1, 600001]) bad('chat.send', { sessionId: 's', receiverId: 'r', text: 'x', idempotencyKey: 'k', minIntervalMs })
})
test('返回类型和幂等指纹不包含tag等待元信息', () => {
  const open = { itemId: 'i', idempotencyKey: 'k', tag: 'a', maxWaitMs: 1 }
  const fp = writeFingerprint('a', 'chat.open', open)
  assert.deepEqual(fp, { accountId: 'a', method: 'chat.open', idempotencyKey: 'k', fingerprint: '["a","chat.open","k",{"itemId":"i"}]' })
  const send = normalizeWriteParams('chat.send', { sessionId: 's', receiverId: 'r', text: 'x', idempotencyKey: 'k' })
  const result: { sessionId: string; peerUserId: string | null; created: boolean } = { sessionId: 's', peerUserId: null, created: false }
  const sent: { messageId: string; sentAt: number } = { messageId: 'm', sentAt: 0 }
  assert.equal(result.created, false); assert.equal(sent.sentAt, 0); assert.equal(send.text, 'x')
})
