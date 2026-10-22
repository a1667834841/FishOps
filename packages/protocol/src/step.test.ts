import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPageWire, isResolvedPage, isStepWire } from './step.ts'
import { encodePublishMyItemsCursor } from './publish.ts'

const step = { kind: 'request-step', id: 'step-1', requestId: 'req-1', method: 'item.detail', params: { itemId: '123' }, context: { accountId: 'a', tabId: 1, documentId: 'doc-1' } }
test('内部单步绑定账号与文档，只接受单次只读业务参数', () => {
  assert.equal(isStepWire(step), true)
  for (const patch of [{ method: 'chat.send' }, { params: { itemId: '123', maxWaitMs: 1 } }, { id: '' }, { params: {} }, { extra: true }]) {
    assert.equal(isStepWire({ ...step, ...patch }), false)
  }
  for (const context of [{ accountId: 'a', tabId: -1, documentId: 'd' }, { accountId: 'a', tabId: 1 }, { accountId: '', tabId: 1, documentId: 'd' }]) {
    assert.equal(isStepWire({ ...step, context }), false)
  }
})
test('结果必须有终结标记，失败不允许正文或未知错误码', () => {
  assert.equal(isStepWire({ kind: 'step-result', id: 's', terminal: true, ok: true, data: {} }), true)
  const failure = { kind: 'step-result', id: 's', terminal: true, ok: false, error: { code: 'PAGE_NOT_READY', message: '页面已变化', phase: 'read', retryable: false } }
  assert.equal(isStepWire(failure), true)
  assert.equal(isStepWire({ ...failure, terminal: false }), false)
  assert.equal(isStepWire({ ...failure, data: {} }), false)
  assert.equal(isStepWire({ ...failure, error: { code: 'WHATEVER', message: 'bad' } }), false)
})

test('页面定位帧只接受固定字段与脱敏原因', () => {
  const request = { kind: 'resolve-page', id: 'page-1', accountId: 'account-1' }
  assert.equal(isPageWire(request), true)
  for (const patch of [{ accountId: '' }, { extra: true }, { id: '' }]) {
    assert.equal(isPageWire({ ...request, ...patch }), false)
  }
  const success = { kind: 'page-context', id: 'page-1', context: { tabId: 7, documentId: 'doc-1' } }
  assert.equal(isPageWire(success), true)
  assert.equal(isPageWire({ ...success, reason: 'PAGE_NOT_READY' }), false)
  for (const context of [
    { tabId: -1, documentId: 'doc-1' },
    { tabId: 7, documentId: '' },
    { tabId: 7, documentId: ' doc-1' },
    { tabId: 7, documentId: 'doc-1', url: 'https://www.goofish.com/' },
  ]) assert.equal(isPageWire({ ...success, context }), false)
  for (const reason of ['PAGE_NOT_READY', 'LOGIN_REQUIRED', 'ACCOUNT_CHANGED']) {
    assert.equal(isPageWire({ kind: 'page-context', id: 'page-1', context: null, reason }), true)
  }
  assert.equal(isPageWire({ kind: 'page-context', id: 'page-1', context: null, reason: 'INTERNAL' }), false)
  assert.equal(isPageWire({ kind: 'page-context', id: 'page-1', context: null, url: 'https://www.goofish.com/' }), false)
})

test('扩展返回的固定页面严格核验，未知字段不进入单步上下文', () => {
  assert.equal(isResolvedPage({ tabId: 7, documentId: 'doc-1' }), true)
  for (const value of [
    null,
    { tabId: 7, documentId: 'doc-1', url: 'https://www.goofish.com/' },
    { tabId: -1, documentId: 'doc-1' },
    { tabId: 7, documentId: 'doc 1' },
  ]) assert.equal(isResolvedPage(value), false)
})

test('聊天单页步骤复用固定上下文，参数按模式严格验证', () => {
  const chat = { ...step, method: 'chat.sync.page', params: { mode: 'conversations', anchor: '100', limit: 20 } }
  assert.equal(isStepWire(chat), true)
  assert.equal(isStepWire({ ...chat, params: { mode: 'messages', sessionId: 's', anchor: '100', limit: 1 } }), true)
  for (const params of [
    { mode: 'messages', anchor: '100', limit: 1 },
    { mode: 'conversations', anchor: '01', limit: 1 },
    { mode: 'conversations', anchor: '100', limit: 101 },
    { mode: 'conversations', anchor: '100', limit: 1, tag: 'forged' },
    { keyword: '手机' },
  ]) assert.equal(isStepWire({ ...chat, params }), false)
  for (const context of [
    { ...step.context, accountId: '' }, { ...step.context, tabId: -1 },
    { ...step.context, documentId: '' }, { ...step.context, url: 'https://www.goofish.com/' },
  ]) assert.equal(isStepWire({ ...chat, context }), false)
  assert.equal(isStepWire({ ...chat, method: 'chat.send' }), false)
  assert.equal(isStepWire({ ...chat, extra: true }), false)
  assert.equal(isStepWire(step), true)
  assert.equal(isStepWire({ ...step, method: 'search.items', params: { keyword: '手机' } }), true)
  assert.equal(isStepWire({ ...step, method: 'search.suggest', params: { keyword: '手机' } }), true)
})

test('发布单步严格绑定固定上下文，不接受客户端伪造账号、payload 或未知字段', () => {
  const confirm = { imageNoQr: true, addressConfirmed: true }
  const prepare = { source: { itemId: 'source-1' }, seller: { addressRef: 'addr-1' }, confirm }
  const nextPage = encodePublishMyItemsCursor({ groupId: 14645107, pageNumber: 2, pageSize: 20 })
  assert.equal(isStepWire({ ...step, method: 'publish.prepare', params: prepare }), true)
  assert.equal(isStepWire({ ...step, method: 'publish.submit', params: { prepareToken: 'p', prepareRef: 'prep.authority-1', draftFingerprint: 'f', confirm } }), true)
  assert.equal(isStepWire({ ...step, method: 'publish.myItems', params: { limit: 20 } }), true)
  assert.equal(isStepWire({ ...step, method: 'publish.myItems', params: { limit: 200, nextPage } }), true)
  for (const [method, params] of [
    ['publish.prepare', { ...prepare, accountId: 'forged' }],
    ['publish.prepare', { ...prepare, payload: {} }],
    ['publish.prepare', { ...prepare, maxWaitMs: 1000 }],
    ['publish.prepare', { ...prepare, tag: 'tag' }],
    ['publish.prepare', { ...prepare, idempotencyKey: '' }],
    ['publish.prepare', { ...prepare, confirm: { imageNoQr: false, addressConfirmed: true } }],
    ['publish.submit', { prepareToken: 'p', prepareRef: 'prep.authority-1', draftFingerprint: 'f', idempotencyKey: 'k', confirm, transportData: {} }],
    ['publish.submit', { prepareToken: 'p', draftFingerprint: 'f', idempotencyKey: 'k', confirm }],
    ['publish.submit', { prepareToken: 'p', idempotencyKey: 'k', confirm }],
    ['publish.submit', { prepareToken: 'p', prepareRef: 'prep.authority-1', draftFingerprint: 'f', confirm, minIntervalMs: 100 }],
    ['publish.myItems', { limit: 0 }],
    ['publish.myItems', { limit: 20, cursor: 'raw' }],
    ['publish.myItems', { limit: 20, nextPage: '' }],
    ['publish.myItems', { limit: 20, nextPage: 'cursor-2' }],
    ['publish.myItems', { limit: 20, nextPage: 'v1.****' }],
    ['publish.myItems', { limit: 20, pageNumber: 2 }],
    ['publish.myItems', { limit: 20, groupId: 14645107 }],
    ['publish.myItems', { limit: 20, pageSize: 20 }],
    ['publish.myItems', { limit: 20, maxWaitMs: 1 }],
  ] as const) assert.equal(isStepWire({ ...step, method, params }), false)
})
