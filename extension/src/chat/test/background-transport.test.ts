/**
 * background-transport.ts 单元测试：background 侧只读 transport 的校验与错误归一。
 * 使用 mock executor，不注入真实 chrome.scripting、不连网络。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLwpRequest, LWP_ROUTES, type LwpRequest, type LwpResponse } from '../../../../shared/chat/index'
import { createBackgroundChatTransport, type ChatScriptExecutor } from '../background-transport'
import { ChatSocketTransportError } from '../socket-transport'

const req = (mid: string) => createLwpRequest(LWP_ROUTES.listMessages, ['1@goofish', false, 0, 20, false], mid)

test('成功：返回 MAIN world 的 LwpResponse', async () => {
  const calls: Array<{ tabId: number; request: LwpRequest; timeoutMs: number }> = []
  const executor: ChatScriptExecutor = {
    async execute(tabId, request, timeoutMs) {
      calls.push({ tabId, request, timeoutMs })
      return { ok: true, response: { code: 200, headers: { mid: request.headers.mid }, body: { userMessageModels: [] } } }
    },
  }
  const transport = createBackgroundChatTransport({ executor, resolveTabId: async () => 7 })
  const response = await transport.send(req('m1'), { timeoutMs: 15000 })
  assert.equal(response.code, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].tabId, 7)
  assert.equal(calls[0].timeoutMs, 15000)
})

test('非白名单路由被拒绝，且不调用 executor', async () => {
  let called = false
  const executor: ChatScriptExecutor = {
    async execute() {
      called = true
      return { ok: true, response: { code: 200 } }
    },
  }
  const transport = createBackgroundChatTransport({ executor, resolveTabId: async () => 7 })
  await assert.rejects(
    () => transport.send(createLwpRequest('/r/Other/route', [], 'm')),
    (error: unknown) => error instanceof ChatSocketTransportError && error.code === 'ROUTE_NOT_ALLOWED',
  )
  assert.equal(called, false)
})

test('无可用 tab 时 reject NO_SOCKET，且不调用 executor', async () => {
  let called = false
  const executor: ChatScriptExecutor = {
    async execute() {
      called = true
      return null
    },
  }
  const transport = createBackgroundChatTransport({ executor, resolveTabId: async () => null })
  await assert.rejects(
    () => transport.send(req('m')),
    (error: unknown) => error instanceof ChatSocketTransportError && error.code === 'NO_SOCKET',
  )
  assert.equal(called, false)
})

test('MAIN world 返回 ok:false 时归一为结构化错误', async () => {
  const executor: ChatScriptExecutor = {
    async execute() {
      return { ok: false, error: { code: 'TIMEOUT', message: 'LWP 超时' } }
    },
  }
  const transport = createBackgroundChatTransport({ executor, resolveTabId: async () => 7 })
  await assert.rejects(
    () => transport.send(req('m')),
    (error: unknown) => error instanceof ChatSocketTransportError && error.code === 'TIMEOUT',
  )
})

test('executor 抛错时归一为 NO_SOCKET', async () => {
  const executor: ChatScriptExecutor = {
    async execute() {
      throw new Error('未找到注入目标')
    },
  }
  const transport = createBackgroundChatTransport({ executor, resolveTabId: async () => 7 })
  await assert.rejects(
    () => transport.send(req('m')),
    (error: unknown) => error instanceof ChatSocketTransportError && error.code === 'NO_SOCKET',
  )
})

test('兼容：MAIN world 直接返回 LwpResponse', async () => {
  const executor: ChatScriptExecutor = {
    async execute() {
      const response: LwpResponse = { code: 0, headers: { mid: 'm' }, body: {} }
      return response
    },
  }
  const transport = createBackgroundChatTransport({ executor, resolveTabId: async () => 7 })
  const response = await transport.send(req('m'))
  assert.equal(response.code, 0)
})
