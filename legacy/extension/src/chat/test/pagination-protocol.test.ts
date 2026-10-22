/**
 * 分页协议校验单元测试（shared/events/codec.ts）。
 *
 * 背景：`isChatGetMessagesPayload` / `isChatSyncHistoryPayload` / `isMessageCursor`
 * 目前只是协议层导出，没有运行时调用方，因此这里用单测锁定边界行为，
 * 防止后续放宽校验（尤其是 before 游标与分页尺寸）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isChatGetMessagesPayload, isChatSyncHistoryPayload, isMessageCursor } from '@fishops/shared'

test('isMessageCursor：只接受完整排序键（有限 createAt + string messageId + 非空 id）', () => {
  assert.equal(isMessageCursor({ createAt: 1000, messageId: 'm1', id: 'k1' }), true)
  // messageId 允许为空串（指纹消息）；id 是去重键，必须非空。
  assert.equal(isMessageCursor({ createAt: 1000, messageId: '', id: 'k1' }), true)
  assert.equal(isMessageCursor({ createAt: 1000, messageId: 'm1', id: '' }), false)
  assert.equal(isMessageCursor({ createAt: Number.NaN, messageId: 'm1', id: 'k1' }), false)
  assert.equal(isMessageCursor({ createAt: Number.POSITIVE_INFINITY, messageId: 'm1', id: 'k1' }), false)
  assert.equal(isMessageCursor({ createAt: '1000', messageId: 'm1', id: 'k1' }), false)
  assert.equal(isMessageCursor({ createAt: 1000, id: 'k1' }), false)
  assert.equal(isMessageCursor({ createAt: 1000, messageId: 'm1' }), false)
  assert.equal(isMessageCursor(null), false)
  assert.equal(isMessageCursor('m1'), false)
})

test('isChatGetMessagesPayload：before 可选，但非法游标必须拒绝', () => {
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a' }), true)
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', order: 'desc', limit: 10 }), true)
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', before: { createAt: 1000, messageId: 'm1', id: 'k1' } }), true)
  // 非法游标（缺字段 / 空 id / 非数字）
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', before: {} }), false)
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', before: { createAt: 1000, messageId: 'm1', id: '' } }), false)
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', before: { createAt: 'x', messageId: 'm1', id: 'k1' } }), false)
  // 原有安全校验不得放宽：sessionId 必填非空、order 枚举受限
  assert.equal(isChatGetMessagesPayload({}), false)
  assert.equal(isChatGetMessagesPayload({ sessionId: '' }), false)
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', order: 'sideways' }), false)
})

test('isChatGetMessagesPayload：limit 保持旧契约（只要求有限数字），不再收紧为 1..200', () => {
  // 旧调用方（reply-runtime 等）可能传 0 / 负数 / 小数 / 大于 200 的值；本次只收紧新增字段，不动旧契约。
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', limit: undefined }), true)
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', limit: 0 }), true)
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', limit: 1 }), true)
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', limit: 1.5 }), true)
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', limit: 200 }), true)
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', limit: 500 }), true)
  // 负数保持旧契约合法（只校验有限性，不校验符号）。
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', limit: -10 }), true)
  // 仍然拒绝非数字与非有限数。
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', limit: Number.NaN }), false)
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', limit: Number.POSITIVE_INFINITY }), false)
  assert.equal(isChatGetMessagesPayload({ sessionId: 'a', limit: '10' }), false)
})

test('isChatSyncHistoryPayload：pages/count 保持旧契约，cursor 为严格正 safe integer', () => {
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a' }), true)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', pages: 1, count: 10 }), true)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', cursor: 1 }), true)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', cursor: 1500 }), true)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', cursor: Number.MAX_SAFE_INTEGER }), true)
  // 旧契约：pages/count 不收紧为 1..200。
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', pages: 0 }), true)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', count: 0 }), true)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', count: 201 }), true)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', pages: 2.5 }), true)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', count: Number.NaN }), false)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', pages: '1' }), false)
  // cursor 必须为严格正 safe integer：0、负数、小数、超界与非数字一律拒绝。
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', cursor: 0 }), false)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', cursor: -1 }), false)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', cursor: 1.5 }), false)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', cursor: Number.MAX_SAFE_INTEGER + 1 }), false)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', cursor: Number.NaN }), false)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', cursor: Number.POSITIVE_INFINITY }), false)
  assert.equal(isChatSyncHistoryPayload({ sessionId: 'a', cursor: '1500' }), false)
  // sessionId 仍必填
  assert.equal(isChatSyncHistoryPayload({ pages: 1 }), false)
})
