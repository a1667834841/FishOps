import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlatformError } from '../errors'
import { PLATFORM_CHANNEL, PlatformMethods } from '../protocol'
import {
  createChromeScriptExecutor,
  createPlatformHostClient,
  invokeRuntimeHostInPage,
  readTrustedUserIdInPage,
  tabResolverFromManager,
} from '../host-client'
import type { PlatformScriptExecutor, ScriptingApi, ScriptingInjection } from '../host-client'

function successResponse(method: string, result: unknown) {
  return { channel: PLATFORM_CHANNEL, kind: 'platform-result', method, callId: 'c1', ok: true, result }
}

function failureResponse(method: string, error: { category: string; message: string; retCode?: string }) {
  return { channel: PLATFORM_CHANNEL, kind: 'platform-result', method, callId: 'c1', ok: false, error }
}

const stubExecutor: PlatformScriptExecutor = {
  async execute() {
    return undefined
  },
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (error) {
    return error
  }
  return undefined
}

test('createPlatformHostClient.call：解包成功响应', async () => {
  const executor: PlatformScriptExecutor = {
    async execute(_tabId, method) {
      return successResponse(method, { pong: true, host: 'main-world', now: 1 })
    },
  }
  const client = createPlatformHostClient({ executor, resolveTabId: async () => 5 })
  assert.deepEqual(await client.ping(), { pong: true, host: 'main-world', now: 1 })
})

test('createPlatformHostClient.call：失败响应转为 PlatformError', async () => {
  const executor: PlatformScriptExecutor = {
    async execute(_tabId, method) {
      return failureResponse(method, { category: 'captcha', message: '需要验证' })
    },
  }
  const client = createPlatformHostClient({ executor, resolveTabId: async () => 5 })
  const error = await captureError(() => client.ping())
  assert.ok(error instanceof PlatformError)
  assert.equal(error.category, 'captcha')
})

test('createPlatformHostClient.call：无可用 tab 时抛出结构化 host-unavailable', async () => {
  const client = createPlatformHostClient({ executor: stubExecutor, resolveTabId: async () => null })
  const error = await captureError(() => client.ping())
  assert.ok(error instanceof PlatformError)
  assert.equal(error.category, 'host-unavailable')
})

test('createPlatformHostClient.call：执行器异常被归一为 host-unavailable', async () => {
  const executor: PlatformScriptExecutor = {
    async execute() {
      throw new Error('tab 已关闭')
    },
  }
  const client = createPlatformHostClient({ executor, resolveTabId: async () => 5 })
  const error = await captureError(() => client.ping())
  assert.ok(error instanceof PlatformError)
  assert.equal(error.category, 'host-unavailable')
  assert.equal(error.message, 'tab 已关闭')
})

test('createPlatformHostClient.callRaw：字符串方法白名单校验 + 透传', async () => {
  const calls: Array<[number, string, unknown]> = []
  const executor: PlatformScriptExecutor = {
    async execute(tabId, method, params) {
      calls.push([tabId, method, params])
      return successResponse(method, { ok: true })
    },
  }
  const client = createPlatformHostClient({ executor, resolveTabId: async () => 9 })

  assert.deepEqual(await client.callRaw(PlatformMethods.SEARCH, { keyword: 'x' }), { ok: true })
  assert.deepEqual(calls[0], [9, PlatformMethods.SEARCH, { keyword: 'x' }])

  const error = await captureError(() => client.callRaw('platform.not-exist', {}))
  assert.ok(error instanceof PlatformError)
  assert.equal(error.category, 'unknown')
})

test('createChromeScriptExecutor：以 MAIN world 注入并透传调用参数', async () => {
  const injections: Array<Parameters<ScriptingApi['executeScript']>[0]> = []
  const scripting: ScriptingApi = {
    async executeScript(injection) {
      injections.push(injection)
      return [{ result: successResponse('platform.ping', { pong: true }) }]
    },
  }
  const executor = createChromeScriptExecutor(scripting)
  const result = await executor.execute(7, PlatformMethods.PING, { a: 1 })

  assert.deepEqual(result, successResponse('platform.ping', { pong: true }))
  const injection = injections[0]!
  assert.equal(injection.world, 'MAIN')
  assert.equal(injection.target.tabId, 7)
  assert.equal(injection.args[0], PlatformMethods.PING)
  assert.equal(typeof injection.args[1], 'string')
  assert.deepEqual(injection.args[2], { a: 1 })
  assert.equal(typeof injection.func, 'function')
})

test('readTrustedUserIdInPage：解析受信 unb / havana hid，非法与缺失返回 null', () => {
  const havana = Buffer.from(JSON.stringify({ hid: 4188939592, sg: 'x', token: 'y' })).toString('base64')
  assert.deepEqual(readTrustedUserIdInPage('a=1; unb=4188939592; b=2'), { userId: '4188939592' })
  assert.deepEqual(readTrustedUserIdInPage(`_m_h5_tk=tok_1; havana_lgc2_77=${havana}`), { userId: '4188939592' })
  assert.deepEqual(readTrustedUserIdInPage('a=1'), { userId: null })
  assert.deepEqual(readTrustedUserIdInPage('unb=peer@goofish'), { userId: null })
  assert.deepEqual(readTrustedUserIdInPage('havana_lgc2_77=@@@'), { userId: null })
})

test('createChromeScriptExecutor.readUserId：注入自包含 cookie 读取（0 参数）并返回 userId', async () => {
  const injections: ScriptingInjection[] = []
  const scripting: ScriptingApi = {
    async executeScript(injection) {
      injections.push(injection)
      return [{ result: { userId: '4188939592' } }]
    },
  }
  const executor = createChromeScriptExecutor(scripting)
  assert.equal(await executor.readUserId?.(7), '4188939592')

  const injection = injections[0]!
  assert.equal(injection.world, 'MAIN')
  assert.equal(injection.target.tabId, 7)
  assert.deepEqual(injection.args, [])
  // 注入函数必须是自包含的 cookie 读取（可序列化）。
  assert.equal(injection.func, readTrustedUserIdInPage)
})

test('createPlatformHostClient：CURRENT_USER_ID 优先自包含 cookie 读取，不调用页面 host', async () => {
  let hostCalls = 0
  const executor: PlatformScriptExecutor = {
    async execute(_tabId, method) {
      hostCalls += 1
      return successResponse(method, { userId: 'from-stale-host' })
    },
    async readUserId() {
      return '4188939592'
    },
  }
  const client = createPlatformHostClient({ executor, resolveTabId: async () => 5 })
  assert.deepEqual(await client.call(PlatformMethods.CURRENT_USER_ID, {}), { userId: '4188939592' })
  assert.equal(hostCalls, 0)
})

test('createPlatformHostClient：无受信 cookie 时 CURRENT_USER_ID 回退页面 host', async () => {
  let hostCalls = 0
  const executor: PlatformScriptExecutor = {
    async execute(_tabId, method) {
      hostCalls += 1
      return successResponse(method, { userId: null })
    },
    async readUserId() {
      return null
    },
  }
  const client = createPlatformHostClient({ executor, resolveTabId: async () => 5 })
  assert.deepEqual(await client.call(PlatformMethods.CURRENT_USER_ID, {}), { userId: null })
  assert.equal(hostCalls, 1)
})

test('invokeRuntimeHostInPage：无 host 时 reject', async () => {
  const globalObject = globalThis as { __FISHOPS_PLATFORM_HOST__?: unknown }
  delete globalObject.__FISHOPS_PLATFORM_HOST__
  await assert.rejects(() => invokeRuntimeHostInPage('platform.ping', 'c', {}))
})

test('invokeRuntimeHostInPage：优先使用 handleCall 并构造平台信封', async () => {
  const globalObject = globalThis as { __FISHOPS_PLATFORM_HOST__?: unknown }
  const calls: unknown[] = []
  globalObject.__FISHOPS_PLATFORM_HOST__ = {
    handleCall: async (request: unknown) => {
      calls.push(request)
      return { ok: true }
    },
    handle: async () => ({ ok: 'fallback' }),
  }

  try {
    const result = await invokeRuntimeHostInPage('platform.ping', 'call_9', { a: 1 })
    assert.deepEqual(result, { ok: true })
    assert.deepEqual(calls[0], {
      channel: PLATFORM_CHANNEL,
      kind: 'platform-call',
      method: 'platform.ping',
      params: { a: 1 },
      callId: 'call_9',
    })
  } finally {
    delete globalObject.__FISHOPS_PLATFORM_HOST__
  }
})

test('tabResolverFromManager：返回 tab id 或缺省 null', async () => {
  const resolve = tabResolverFromManager({ ensureGoofishTab: async () => ({ tab: { id: 3 } }) })
  assert.equal(await resolve(), 3)

  const resolveNull = tabResolverFromManager({ ensureGoofishTab: async () => ({ tab: {} }) })
  assert.equal(await resolveNull(), null)
})
