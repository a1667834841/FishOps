import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isChatSyncPageParams, isChatSyncConversation, isChatSyncPageResult, validateResult } from './chat-sync.ts'
const params = { mode: 'messages', sessionId: 's', anchor: '100', limit: 2 }
const message = { sourceId: 'm', sessionId: 's', senderId: 'u', text: '消息', sentAt: 1 }
const page = { mode: 'messages', messages: [message], hasMore: true, nextAnchor: '99', unsupportedCount: 0 }
const conversation = { sessionId: 's', peerUserId: null, itemId: null, updatedAt: 0, sortIndex: '100' }

test('单页参数判别、游标和limit严格验证', () => {
  assert.equal(isChatSyncPageParams(params), true)
  assert.equal(isChatSyncPageParams({ mode: 'conversations', anchor: '9007199254740991', limit: 100 }), true)
  for (const patch of [{ anchor: '01' }, { anchor: '-1' }, { anchor: '9007199254740992' }, { anchor: 1 }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { sessionId: '' }, { sessionId: 'x'.repeat(129) }, { tag: 'host-only' }]) assert.equal(isChatSyncPageParams({ ...params, ...patch }), false)
  assert.equal(isChatSyncPageParams({ mode: 'conversations', anchor: '0', limit: 1, sessionId: 's' }), false)
})
test('会话字段必填、未知关联null、整数边界与未知字段', () => {
  assert.equal(isChatSyncConversation(conversation), true)
  for (const patch of [{ updatedAt: -1 }, { updatedAt: Infinity }, { sortIndex: '01' }, { itemId: undefined }, { peerUserId: '' }, { token: 'forbidden' }]) assert.equal(isChatSyncConversation({ ...conversation, ...patch }), false)
  const { itemId, ...missing } = conversation
  assert.equal(isChatSyncConversation(missing), false)
})
test('两类结果严格判别，末页与续页约束，unsupportedCount显式保留', () => {
  assert.equal(validateResult(params, page), true)
  assert.equal(validateResult(params, { ...page, unsupportedCount: 1 }), true)
  assert.equal(validateResult({ mode: 'conversations', anchor: '100', limit: 1 }, { mode: 'conversations', conversations: [conversation], hasMore: false, nextAnchor: null, unsupportedCount: 0 }), true)
  for (const patch of [{ hasMore: 1 }, { hasMore: false }, { nextAnchor: null }, { nextAnchor: '01' }, { unsupportedCount: -1 }, { unsupportedCount: 1.1 }, { messages: [{ ...message, tag: 'fake' }] }, { conversations: [] }]) assert.equal(isChatSyncPageResult({ ...page, ...patch }), false)
  const { unsupportedCount, ...missing } = page
  assert.equal(isChatSyncPageResult(missing), false)
  assert.equal(isChatSyncPageResult({ ...page, hasMore: false, nextAnchor: null }), true)
})
test('请求关联验证拒绝不进展游标、错模式、错会话与超请求limit', () => {
  for (const nextAnchor of ['100', '101']) assert.equal(validateResult(params, { ...page, nextAnchor }), false)
  assert.equal(validateResult(params, { ...page, messages: [{ ...message, sessionId: 'other' }] }), false)
  assert.equal(validateResult({ ...params, limit: 1 }, { ...page, unsupportedCount: 1 }), false)
  assert.equal(validateResult({ ...params, anchor: '0' }, { ...page, nextAnchor: '0' }), false)
  assert.equal(validateResult({ mode: 'conversations', anchor: '100', limit: 2 }, page), false)
})
test('集合条数与512KiB UTF-8输出限制，不静默截断', () => {
  assert.equal(isChatSyncPageResult({ ...page, messages: Array(101).fill(message) }), false)
  assert.equal(isChatSyncPageResult({ ...page, messages: Array(100).fill(message) }), true)
  assert.equal(isChatSyncPageResult({ ...page, messages: Array(10).fill({ ...message, text: '中'.repeat(20000) }) }), false)
  assert.equal(isChatSyncPageResult({ ...page, messages: Array(8).fill({ ...message, text: '中'.repeat(20000) }) }), true)
})
test('拒绝访问器、隐藏字段、稀疏集合和非纯对象', () => {
  const getter = { ...page }
  Object.defineProperty(getter, 'messages', { enumerable: true, get() { throw new Error('不能执行') } })
  assert.equal(isChatSyncPageResult(getter), false)
  assert.equal(isChatSyncPageResult({ ...page, messages: Array(1) }), false)
  assert.equal(isChatSyncPageResult(Object.assign(Object.create({}), page)), false)
  const hidden = { ...page }; Object.defineProperty(hidden, 'secret', { value: 1 })
  assert.equal(isChatSyncPageResult(hidden), false)
  assert.equal(isChatSyncPageResult({ ...page, [Symbol('secret')]: 1 }), false)
})
