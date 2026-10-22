/**
 * my-user-id 单测（P8）：成功 TTL、失败退避、显式（force）重试、并发去重、不退避死循环。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlatformError } from '../../platform/errors'
import { createMyUserIdResolver } from '../my-user-id'

function clock() {
  let current = 1000
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

test('成功缓存 5 分钟 TTL：TTL 内命中缓存，不重复请求', async () => {
  const time = clock()
  let calls = 0
  const resolver = createMyUserIdResolver({
    fetch: async () => {
      calls += 1
      return 'user-1'
    },
    now: time.now,
    successTtlMs: 5 * 60 * 1000,
  })

  const first = await resolver.get()
  assert.equal(first.ok, true)
  assert.equal(first.ok && first.userId, 'user-1')
  assert.equal(calls, 1)

  // TTL 内再次获取：命中缓存。
  time.advance(60 * 1000)
  const second = await resolver.get()
  assert.equal(second.ok, true)
  assert.equal(second.ok && second.fromCache, true)
  assert.equal(calls, 1)

  // 超过 TTL：重新请求。
  time.advance(5 * 60 * 1000)
  await resolver.get()
  assert.equal(calls, 2)
})

test('失败不永久缓存：退避窗口内不重试，force 可重试一次', async () => {
  const time = clock()
  let calls = 0
  const resolver = createMyUserIdResolver({
    fetch: async () => {
      calls += 1
      throw new PlatformError('host-unavailable', '无 goofish tab')
    },
    now: time.now,
    initialBackoffMs: 5000,
  })

  const first = await resolver.get()
  assert.equal(first.ok, false)
  assert.equal(first.ok === false ? first.category : '', 'host-unavailable')
  assert.equal(calls, 1)

  // 退避窗口内非强制：不重复请求。
  time.advance(1000)
  await resolver.get()
  assert.equal(calls, 1)

  // 显式发送（force）：忽略退避再试一次。
  await resolver.get({ force: true })
  assert.equal(calls, 2)

  // 再 force 一次：仍然只各发一次（无内部循环）。
  await resolver.get({ force: true })
  assert.equal(calls, 3)

  // peek 不暴露用户 ID 值，只给状态。
  const peek = resolver.peek()
  assert.equal(peek.hasUserId, false)
  assert.equal(peek.failing, true)
})

test('退避指数增长，成功后重置', async () => {
  const time = clock()
  let calls = 0
  let fail = true
  const resolver = createMyUserIdResolver({
    fetch: async () => {
      calls += 1
      if (fail) throw new PlatformError('network', '网络错误')
      return 'user-2'
    },
    now: time.now,
    initialBackoffMs: 5000,
    maxBackoffMs: 60000,
  })

  await resolver.get()
  assert.equal(calls, 1)
  // 第二次失败后，退避应延长（首次 5000 → 10000）。
  await resolver.get({ force: true })
  assert.equal(calls, 2)
  // 退避未到 10000 时非强制不再请求。
  time.advance(6000)
  await resolver.get()
  assert.equal(calls, 2)

  // 成功获取后重置退避与失败状态。
  fail = false
  const ok = await resolver.get({ force: true })
  assert.equal(ok.ok, true)
  assert.equal(resolver.peek().failing, false)
})

test('并发去重：并发请求只触发一次 fetch', async () => {
  let calls = 0
  let release!: (value: string) => void
  const gate = new Promise<string>((resolve) => {
    release = resolve
  })
  const resolver = createMyUserIdResolver({
    fetch: async () => {
      calls += 1
      return gate
    },
  })

  const all = Promise.all([resolver.get(), resolver.get(), resolver.get()])
  await Promise.resolve()
  assert.equal(calls, 1)
  release('user-3')
  const results = await all
  for (const result of results) {
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.userId, 'user-3')
  }
})

test('失败透传 retCode（不丢 MTOP 诊断码），peek 也可见', async () => {
  const time = clock()
  const resolver = createMyUserIdResolver({
    fetch: async () => {
      throw new PlatformError('api', '闲鱼接口返回业务错误', { retCode: 'FAIL_SYS_ILLEGAL_ACCESS' })
    },
    now: time.now,
  })

  const result = await resolver.get()
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.category : '', 'api')
  assert.equal(result.ok === false ? result.retCode : undefined, 'FAIL_SYS_ILLEGAL_ACCESS')
  assert.equal(resolver.peek().retCode, 'FAIL_SYS_ILLEGAL_ACCESS')

  // 退避窗口内命中的失败结果同样带 retCode。
  const cached = await resolver.get()
  assert.equal(cached.ok === false ? cached.retCode : undefined, 'FAIL_SYS_ILLEGAL_ACCESS')
})

test('返回空 userId 视为失败（unknown），不缓存为成功', async () => {
  const resolver = createMyUserIdResolver({ fetch: async () => '' })
  const result = await resolver.get()
  assert.equal(result.ok, false)
  assert.equal(resolver.peek().hasUserId, false)
})
