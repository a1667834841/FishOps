import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PLATFORM_CHANNEL, PlatformMethods } from '../protocol'
import type { PlatformCallRequest, PlatformMethod } from '../protocol'
import { createRuntimeHost } from '../runtime-host'
import type { MtopClient } from '../xianyu/mtop-client'
import type { AuthService } from '../xianyu/auth'

function makeHost() {
  const clientCalls: Array<{ apiType: string; data: unknown }> = []

  const client = {
    requestRaw: async (apiType: string, data: unknown) => {
      clientCalls.push({ apiType, data })
      return { ret: ['SUCCESS::x'], data: { apiType, echo: data } }
    },
    search: async () => ({}),
    fetchItemDetail: async () => ({}),
    suggest: async (inputWords: string) => [`${inputWords}-1`, `${inputWords}-2`],
  } as unknown as MtopClient

  const auth: AuthService = {
    hasToken: () => true,
    getToken: () => 'tok',
    getAuthState: () => ({ loggedIn: true, hasToken: true }),
    getCurrentUserId: async () => '42',
  }

  return { host: createRuntimeHost({ client, auth, now: () => 123 }), clientCalls }
}

function makeRequest(method: string, params: unknown): PlatformCallRequest {
  return {
    channel: PLATFORM_CHANNEL,
    kind: 'platform-call',
    method: method as PlatformMethod,
    params: params as never,
    callId: 'call_1',
  }
}

test('ping：返回 MAIN world host 标识与时间', async () => {
  const { host } = makeHost()
  assert.deepEqual(await host.handle(PlatformMethods.PING, {}), {
    pong: true,
    host: 'main-world',
    now: 123,
  })
})

test('search：调用 requestRaw(search) 并返回原始 JSON', async () => {
  const { host, clientCalls } = makeHost()
  const result = await host.handle(PlatformMethods.SEARCH, { keyword: 'iPhone', pageNumber: 3 })

  assert.equal(clientCalls.length, 1)
  assert.equal(clientCalls[0]!.apiType, 'search')
  assert.equal((clientCalls[0]!.data as { keyword: string }).keyword, 'iPhone')
  assert.equal((clientCalls[0]!.data as { pageNumber: number }).pageNumber, 3)
  assert.deepEqual((result as { ret: string[] }).ret, ['SUCCESS::x'])
})

test('search：缺少 keyword 时 handleCall 返回结构化失败', async () => {
  const { host } = makeHost()
  const response = await host.handleCall(makeRequest(PlatformMethods.SEARCH, {}))
  assert.equal(response.ok, false)
  if (!response.ok) {
    assert.equal(response.error.category, 'unknown')
    assert.equal(response.callId, 'call_1')
  }
})

test('detail：调用 requestRaw(detail) 并透传 itemId', async () => {
  const { host, clientCalls } = makeHost()
  await host.handle(PlatformMethods.DETAIL, { itemId: 'abc' })
  assert.deepEqual(clientCalls[0], { apiType: 'detail', data: { itemId: 'abc' } })
})

test('suggest：返回词列表', async () => {
  const { host } = makeHost()
  assert.deepEqual(await host.handle(PlatformMethods.SUGGEST, { inputWords: '车' }), ['车-1', '车-2'])
})

test('authState / currentUserId：委托给 auth 服务', async () => {
  const { host } = makeHost()
  assert.deepEqual(await host.handle(PlatformMethods.AUTH_STATE, {}), {
    loggedIn: true,
    hasToken: true,
  })
  assert.deepEqual(await host.handle(PlatformMethods.CURRENT_USER_ID, {}), { userId: '42' })
})

test('handleCall：未知方法返回失败响应', async () => {
  const { host } = makeHost()
  const response = await host.handleCall(makeRequest('platform.unknown', {}))
  assert.equal(response.ok, false)
  if (!response.ok) assert.equal(response.error.category, 'unknown')
})

test('handleUnknown：非平台消息返回 null，平台消息返回响应', async () => {
  const { host } = makeHost()
  assert.equal(await host.handleUnknown({ kind: 'command', type: 'PING' }), null)
  assert.equal(await host.handleUnknown('noise'), null)

  const response = await host.handleUnknown(makeRequest(PlatformMethods.PING, {}))
  assert.equal(response?.ok, true)
})

test('handleCall：成功响应带 channel 与 callId', async () => {
  const { host } = makeHost()
  const response = await host.handleCall(makeRequest(PlatformMethods.PING, {}))
  assert.equal(response.channel, PLATFORM_CHANNEL)
  assert.equal(response.kind, 'platform-result')
  assert.equal(response.callId, 'call_1')
})
