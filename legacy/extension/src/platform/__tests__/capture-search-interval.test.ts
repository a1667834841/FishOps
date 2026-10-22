/**
 * 采集搜索专用间隔的真实接线测试。
 *
 * 覆盖真实调用链：runtime-host → mtop-client（含内部专用限速器）→ transport。
 * 验证：采集搜索携带专用间隔时按「基础间隔」节流而非全局固定 1500ms；
 * 非采集搜索 / 详情等请求继续使用全局 1500ms 限速（非采集行为不变）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlatformMethods } from '../protocol'
import { createRuntimeHost } from '../runtime-host'
import { createRateLimiter } from '../rate-limit'
import { createMtopClient } from '../xianyu/mtop-client'
import type { MtopTransport, MtopTransportRequest } from '../xianyu/mtop-client'
import type { AuthService } from '../xianyu/auth'
import { MemoryTaskStore, TaskManager } from '../../../../shared/task/index'
import { MemoryProductRepository } from '../../../../shared/capture/product-repository'
import { CaptureController } from '../../capture/controller'
import type { CapturePlatform } from '../../capture/controller'

function makeClock() {
  let time = 0
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      if (ms > 0) sleeps.push(ms)
      time += Math.max(0, ms)
    },
  }
}

function makeTransport(): { transport: MtopTransport; calls: MtopTransportRequest[] } {
  const calls: MtopTransportRequest[] = []
  return {
    calls,
    transport: {
      async send(request: MtopTransportRequest): Promise<unknown> {
        calls.push(request)
        return { ret: ['SUCCESS::x'], data: {} }
      },
    },
  }
}

function makeHost() {
  const clock = makeClock()
  const { transport } = makeTransport()
  const globalLimiter = createRateLimiter({ minIntervalMs: 1500, now: clock.now, sleep: clock.sleep })
  const client = createMtopClient({
    transport,
    getToken: () => 'tok',
    rateLimiter: globalLimiter,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0,
  })
  const auth: AuthService = {
    hasToken: () => true,
    getToken: () => 'tok',
    getAuthState: () => ({ loggedIn: true, hasToken: true }),
    getCurrentUserId: async () => '1',
  }
  return { host: createRuntimeHost({ client, auth }), clock }
}

test('采集搜索携带专用间隔 → 真实链路按基础间隔节流，而非固定 1500ms', async () => {
  const { host, clock } = makeHost()
  await host.handle(PlatformMethods.SEARCH, {
    keyword: 'a',
    pageNumber: 1,
    minIntervalMs: 500,
    intervalJitterMs: 0,
  })
  await host.handle(PlatformMethods.SEARCH, {
    keyword: 'b',
    pageNumber: 2,
    minIntervalMs: 500,
    intervalJitterMs: 0,
  })
  assert.deepEqual(clock.sleeps, [500])
})

test('采集搜索专用间隔叠加随机增量（随机源固定为 0 → 无增量）', async () => {
  const { host, clock } = makeHost()
  await host.handle(PlatformMethods.SEARCH, { keyword: 'a', minIntervalMs: 400, intervalJitterMs: 200 })
  await host.handle(PlatformMethods.SEARCH, { keyword: 'b', minIntervalMs: 400, intervalJitterMs: 200 })
  // random()=0 → 增量 0。
  assert.deepEqual(clock.sleeps, [400])
})

test('非采集搜索（未携带间隔）保持全局 1500ms', async () => {
  const { host, clock } = makeHost()
  await host.handle(PlatformMethods.SEARCH, { keyword: 'a' })
  await host.handle(PlatformMethods.SEARCH, { keyword: 'b' })
  assert.deepEqual(clock.sleeps, [1500])
})

test('详情等非搜索请求保持全局 1500ms 限速', async () => {
  const { host, clock } = makeHost()
  await host.handle(PlatformMethods.DETAIL, { itemId: 'a' })
  await host.handle(PlatformMethods.DETAIL, { itemId: 'b' })
  assert.deepEqual(clock.sleeps, [1500])
})

test('采集搜索专用限速与详情全局限速互不干扰', async () => {
  const { host, clock } = makeHost()
  await host.handle(PlatformMethods.SEARCH, { keyword: 'a', minIntervalMs: 500, intervalJitterMs: 0 })
  await host.handle(PlatformMethods.DETAIL, { itemId: 'a' }) // 全局首次，无需等待
  await host.handle(PlatformMethods.SEARCH, { keyword: 'b', minIntervalMs: 500, intervalJitterMs: 0 })
  // 仅搜索专用限速器在第二次搜索时等待 500；详情未占用搜索限速器。
  assert.deepEqual(clock.sleeps, [500])
})

test('采集搜索传 0/0：绕开全局 1500ms，platform 层不产生任何 sleep（首请求立即）', async () => {
  const { host, clock } = makeHost()
  await host.handle(PlatformMethods.SEARCH, { keyword: 'a', minIntervalMs: 0, intervalJitterMs: 0 })
  await host.handle(PlatformMethods.SEARCH, { keyword: 'b', minIntervalMs: 0, intervalJitterMs: 0 })
  assert.deepEqual(clock.sleeps, [])
})

test('端到端：controller 等待恰好一次，platform 搜索不再二次 sleep', async () => {
  const clock = makeClock()
  const { transport } = makeTransport()
  const globalLimiter = createRateLimiter({ minIntervalMs: 1500, now: clock.now, sleep: clock.sleep })
  const client = createMtopClient({
    transport,
    getToken: () => 'tok',
    rateLimiter: globalLimiter,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0,
  })
  const auth: AuthService = {
    hasToken: () => true,
    getToken: () => 'tok',
    getAuthState: () => ({ loggedIn: true, hasToken: true }),
    getCurrentUserId: async () => '1',
  }
  const host = createRuntimeHost({ client, auth })

  // 与 background 的 capturePlatform.search 一致：底层固定传 0/0，节奏完全由 controller pacer 负责。
  const platform: CapturePlatform = {
    isAvailable: () => true,
    search: (params) =>
      host.handle(PlatformMethods.SEARCH, {
        keyword: params.keyword,
        pageNumber: params.pageNumber,
        rowsPerPage: params.rowsPerPage,
        minIntervalMs: 0,
        intervalJitterMs: 0,
      }),
    detail: (itemId) => host.handle(PlatformMethods.DETAIL, { itemId }),
    suggest: async () => [],
  }

  const tasks = new TaskManager({ store: new MemoryTaskStore() })
  const controller = new CaptureController({
    tasks,
    platform,
    repository: new MemoryProductRepository(),
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0,
  })

  const created = await controller.create({ keyword: 'k', pages: 3 })
  await controller.start(created.id)
  for (let i = 0; i < 500; i += 1) {
    const task = await controller.get(created.id)
    if (task?.status === 'completed') break
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  assert.equal((await controller.get(created.id))?.status, 'completed')

  // 3 页 → controller pacer 仅 2 次等待（各 base 500 + 随机 0）；platform 0/0 不产生任何 sleep。
  assert.deepEqual(clock.sleeps, [500, 500])
})
