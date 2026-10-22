/**
 * P3 平台命令路由测试（无 chrome 依赖）。
 *
 * 验证 Workbench 的平台命令经 P1 message-router 走通，并且：
 * - 复用 P1 信封（CommandEnvelope / ResponseEnvelope）与负载校验；
 * - 未知平台方法被白名单拒绝；
 * - 平台错误（未接线 / tab 不可用 / 未登录 / 风控）转为结构化 PLATFORM_ERROR；
 * - 现有 PING 不回归。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CommandTypes,
  createCommand,
  isPlatformCallPayload,
  isPlatformPingPayload,
  type CommandEnvelope,
} from '@fishops/shared'
import { PlatformError } from '../errors'
import { PlatformMethods } from '../protocol'
import {
  handleCommand,
  type PlatformRouterDeps,
  type RouterDeps,
} from '../../background/message-router'

/** 构造路由依赖；platform 缺省表示“平台层未接线”。 */
function createDeps(platform?: () => PlatformRouterDeps | null): RouterDeps {
  return {
    now: () => 1000,
    workerStartedAt: 500,
    incrementPingCount: async () => 1,
    broadcast: () => 0,
    subscribe: (events) => events,
    unsubscribe: (events) => events,
    ...(platform ? { platform } : {}),
  }
}

/** 构造裸露命令信封（用于非法负载场景）。 */
function rawCommand(type: string, payload: unknown): CommandEnvelope {
  return { kind: 'command', protocol: 1, requestId: 'req_raw', type, payload, sentAt: 0 }
}

function okPlatform(overrides: Partial<PlatformRouterDeps> = {}): () => PlatformRouterDeps {
  return () => ({
    async call() {
      throw new Error('未预期的 call')
    },
    async ping() {
      throw new Error('未预期的 ping')
    },
    ...overrides,
  })
}

test('PLATFORM_CALL：成功调用并透传平台结果', async () => {
  let called: [string, unknown] | null = null
  const deps = createDeps(
    okPlatform({
      async call(method, params) {
        called = [method, params]
        return { items: [1, 2] }
      },
    }),
  )

  const response = await handleCommand(
    createCommand(CommandTypes.PLATFORM_CALL, {
      method: PlatformMethods.SEARCH,
      params: { keyword: 'iPhone 17' },
    }),
    deps,
  )

  assert.equal(response.ok, true)
  assert.deepEqual(response.result, { items: [1, 2] })
  assert.deepEqual(called, [PlatformMethods.SEARCH, { keyword: 'iPhone 17' }])
})

test('PLATFORM_CALL：未知平台方法被白名单拒绝', async () => {
  const deps = createDeps(okPlatform())
  const response = await handleCommand(
    createCommand(CommandTypes.PLATFORM_CALL, { method: 'platform.not-exist', params: {} }),
    deps,
  )

  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'INVALID_PAYLOAD')
})

test('PLATFORM_CALL：非法负载被拒绝', async () => {
  const deps = createDeps(okPlatform())
  const response = await handleCommand(rawCommand(CommandTypes.PLATFORM_CALL, { method: 123 }), deps)

  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'INVALID_PAYLOAD')
})

test('PLATFORM_CALL：平台错误转为带类别的 PLATFORM_ERROR', async () => {
  const deps = createDeps(
    okPlatform({
      async call() {
        throw new PlatformError('captcha', '请求被风控拦截', { retCode: 'FAIL_SYS_USER_VALIDATE' })
      },
    }),
  )
  const response = await handleCommand(
    createCommand(CommandTypes.PLATFORM_CALL, {
      method: PlatformMethods.SEARCH,
      params: { keyword: 'x' },
    }),
    deps,
  )

  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'PLATFORM_ERROR')
  assert.equal(response.error?.category, 'captcha')
  assert.equal(response.error?.retCode, 'FAIL_SYS_USER_VALIDATE')
})

test('PLATFORM_CALL：未接线时返回 host-unavailable', async () => {
  const response = await handleCommand(
    createCommand(CommandTypes.PLATFORM_CALL, { method: PlatformMethods.PING, params: {} }),
    createDeps(() => null),
  )

  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'PLATFORM_ERROR')
  assert.equal(response.error?.category, 'host-unavailable')
})

test('PLATFORM_CALL：deps 未提供 platform 时同样返回 host-unavailable', async () => {
  const response = await handleCommand(
    createCommand(CommandTypes.PLATFORM_CALL, { method: PlatformMethods.PING, params: {} }),
    createDeps(),
  )

  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'PLATFORM_ERROR')
  assert.equal(response.error?.category, 'host-unavailable')
})

test('PLATFORM_PING：返回 host ping 结果', async () => {
  const deps = createDeps(
    okPlatform({
      async ping() {
        return { pong: true, host: 'main-world', now: 42 }
      },
    }),
  )
  const response = await handleCommand(createCommand(CommandTypes.PLATFORM_PING, {}), deps)

  assert.equal(response.ok, true)
  assert.deepEqual(response.result, { pong: true, host: 'main-world', now: 42 })
})

test('PLATFORM_PING：非法负载被拒绝', async () => {
  const response = await handleCommand(rawCommand(CommandTypes.PLATFORM_PING, null), createDeps(okPlatform()))

  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'INVALID_PAYLOAD')
})

test('PING：平台命令接入后 PING 仍走原路径（不回归）', async () => {
  const response = await handleCommand(
    createCommand(CommandTypes.PING, { clientTime: 1, nonce: 'n' }),
    createDeps(),
  )

  assert.equal(response.ok, true)
  assert.equal((response.result as { pong: boolean }).pong, true)
})

test('isPlatformCallPayload / isPlatformPingPayload：结构校验', () => {
  assert.equal(isPlatformCallPayload({ method: 'platform.ping', params: {} }), true)
  assert.equal(isPlatformCallPayload({ method: 1, params: {} }), false)
  assert.equal(isPlatformCallPayload({ method: 'platform.ping' }), false)
  assert.equal(isPlatformPingPayload({}), true)
  assert.equal(isPlatformPingPayload(null), false)
})
