/**
 * 运行时协议（P8）安全回归：新增命令/事件已登记、负载校验严格、不引入隐藏字段。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandTypes,
  EventTypes,
  isChatRuntimePreparePayload,
  isEmptyPayload,
} from '@fishops/shared'
import { isTrustedChatContentSource } from '../chat-source'
import { isExtensionPageSender } from '../sender-policy'

test('RUNTIME_STATUS / CHAT_RUNTIME_PREPARE 已登记为命令类型', () => {
  assert.equal(CommandTypes.RUNTIME_STATUS, 'RUNTIME_STATUS')
  assert.equal(CommandTypes.CHAT_RUNTIME_PREPARE, 'CHAT_RUNTIME_PREPARE')
  assert.equal(EventTypes.RUNTIME_STATUS_CHANGED, 'RUNTIME_STATUS_CHANGED')
})

test('CHAT_RUNTIME_PREPARE 负载校验：只允许 purpose / force', () => {
  assert.equal(isChatRuntimePreparePayload({}), true)
  assert.equal(isChatRuntimePreparePayload({ purpose: 'chat' }), true)
  assert.equal(isChatRuntimePreparePayload({ purpose: 'platform', force: true }), true)
  // 非法 purpose。
  assert.equal(isChatRuntimePreparePayload({ purpose: 'other' }), false)
  // 非法 force 类型。
  assert.equal(isChatRuntimePreparePayload({ force: 'yes' }), false)
  // 隐藏字段：拒绝，避免绕过后续校验。
  assert.equal(isChatRuntimePreparePayload({ purpose: 'chat', secret: 'x' }), false)
  // 非对象。
  assert.equal(isChatRuntimePreparePayload(null), false)
  assert.equal(isChatRuntimePreparePayload('chat'), false)
})

test('RUNTIME_STATUS 负载必须是空对象', () => {
  assert.equal(isEmptyPayload({}), true)
  assert.equal(isEmptyPayload({ anything: 1 }), false)
})

// ---- 来源安全回归：content script 与扩展内页严格区分 ----

test('CHAT_SOCKET_EVENT：只接受 goofish content script，不接受扩展内页 / 非 goofish', () => {
  const id = 'ext-id'
  assert.equal(
    isTrustedChatContentSource({ id, tab: { id: 1 }, url: 'https://www.goofish.com/im' }, id),
    true,
  )
  // 扩展内页（chrome-extension://）不能伪造 socket 事件。
  assert.equal(
    isTrustedChatContentSource(
      { id, tab: { id: 1 }, url: 'chrome-extension://ext-id/workbench.html' },
      id,
    ),
    false,
  )
  // 其它扩展 id / 无 tab / 非 goofish 页面。
  assert.equal(
    isTrustedChatContentSource({ id: 'other', tab: { id: 1 }, url: 'https://www.goofish.com/im' }, id),
    false,
  )
  assert.equal(isTrustedChatContentSource({ id, url: 'https://www.goofish.com/im' }, id), false)
  assert.equal(isTrustedChatContentSource({ id, tab: { id: 1 }, url: 'https://example.com/' }, id), false)
})

test('普通命令 / 订阅：只接受扩展内页，拒绝 content script', () => {
  const id = 'ext-id'
  assert.equal(isExtensionPageSender({ id, url: `chrome-extension://${id}/workbench.html` }, id), true)
  assert.equal(isExtensionPageSender({ id, origin: `chrome-extension://${id}` }, id), true)
  // content script 的 sender.id 同为扩展 id，但 url/origin 是宿主页面，必须拒绝。
  assert.equal(
    isExtensionPageSender({ id, url: 'https://www.goofish.com/im', tab: { id: 1 } }, id),
    false,
  )
  assert.equal(
    isExtensionPageSender({ id: 'other', url: `chrome-extension://${id}/workbench.html` }, id),
    false,
  )
  assert.equal(isExtensionPageSender(undefined, id), false)
})
