import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSyncCursorCodec, type SyncCursor } from './sync-cursor.ts'
const value: SyncCursor = { version: 1, accountId: 'test-account', mode: 'messages', sessionId: 's', anchor: '9007199254740991', limit: 20, tabId: 1, documentId: 'd', runId: 'r', expiresAt: 2000 }
const expected = { accountId: value.accountId, mode: value.mode, sessionId: value.sessionId, limit: value.limit }
test('加密续页可重启恢复，不暴露账号与平台anchor', () => {
  const codec = createSyncCursorCodec('test-secret-123456', () => 1000), token = codec.encode(value)
  assert.deepEqual(createSyncCursorCodec('test-secret-123456', () => 1000).decode(token, expected), value)
  assert.ok(!Buffer.from(token, 'base64url').toString().includes('test-account'))
})
test('篡改、过期、错账号、错模式和错部署均拒绝', () => {
  const codec = createSyncCursorCodec('test-secret-123456', () => 1000), token = codec.encode(value)
  for (const invalid of ['', token + '=', token.slice(0, 20) + '!' + token.slice(21)]) assert.throws(() => codec.decode(invalid, expected), /SYNC_CURSOR_INVALID/)
  assert.throws(() => codec.decode(token, { ...expected, accountId: 'other' }))
  assert.throws(() => codec.decode(token, { ...expected, limit: 10 }))
  assert.throws(() => createSyncCursorCodec('different-secret-1234', () => 1000).decode(token, expected))
  assert.throws(() => createSyncCursorCodec('test-secret-123456', () => 2000).decode(token, expected))
  assert.throws(() => codec.encode({ ...value, anchor: '9007199254740992' }))
})
