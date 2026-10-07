/**
 * 采集控制器单测（全部 mock，无真实网络）：
 * - create → 入队异步执行 → progress → complete 全流程与搜索节流（基础间隔 + 随机增量，首页立即）；
 * - 统一采集队列：同一时间单任务，前一任务结束后调度下一项；
 * - 断点续采；
 * - inflight 暂停 / 取消的竞态保护（取消绝不写成 completed）；
 * - 请求失败（单页失败继续 / 全部失败置 failed / 风控暂停）；
 * - 平台不可用的初始化错误；
 * - 去重 / 过滤 / 入库；详情图片规范化去重与详情失败统计；
 * - 重启后 pending 重新入队。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryTaskStore, TaskManager } from '../../../../shared/task/index'
import type { Task } from '../../../../shared/task/index'
import { MemoryProductRepository } from '../../../../shared/capture/product-repository'
import {
  CaptureController,
  DEFAULT_CAPTURE_INTERVAL_MS,
  DEFAULT_CAPTURE_JITTER_MS,
  MIN_CAPTURE_INTERVAL_MS,
  resolveCaptureBaseIntervalMs,
  resolveCaptureJitterMs,
} from '../controller'
import { PlatformError } from '../../platform/errors'
import type { CaptureCheckpoint, CaptureResult } from '../../../../shared/types/capture'
import { emptyCaptureStats } from '../../../../shared/types/capture'
import { MockPlatform, makeClock, makeListItem, makePage } from './fixtures'

function checkpointOf(task: Task): CaptureCheckpoint {
  return (task.meta as { capture: CaptureCheckpoint }).capture
}

function resultOf(task: Task): CaptureResult {
  return task.result as unknown as CaptureResult
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/** 轮询任务直到满足条件，返回该快照。 */
async function waitForTask(
  controller: CaptureController,
  id: string,
  predicate: (task: Task) => boolean,
  timeoutMs = 2000,
): Promise<Task> {
  const start = Date.now()
  for (;;) {
    const task = await controller.get(id)
    if (task && predicate(task)) return task
    if (Date.now() - start > timeoutMs) throw new Error('waitForTask 超时')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function makeController(options: {
  getCurrentUserId?: () => Promise<string | undefined> | string | undefined
  random?: () => number
  minIntervalMs?: number
  intervalJitterMs?: number
  syncProducts?: import('../controller').CaptureControllerDeps['syncProducts']
} = {}) {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = new MemoryProductRepository()
  const platform = new MockPlatform()
  const clock = makeClock()
  const controller = new CaptureController({
    tasks,
    platform,
    repository,
    syncProducts: options.syncProducts,
    now: clock.now,
    sleep: clock.sleep,
    // 默认固定随机源，便于对搜索节流做确定性断言。
    random: options.random ?? (() => 0),
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    ...(options.intervalJitterMs === undefined ? {} : { intervalJitterMs: options.intervalJitterMs }),
    ...(options.getCurrentUserId ? { getCurrentUserId: options.getCurrentUserId } : {}),
  })
  return { store, tasks, repository, platform, clock, controller }
}

test('同一采集任务跨小时保留同商品多条快照，同小时重复跳过', async () => {
  const tasks = new TaskManager({ store: new MemoryTaskStore() })
  const repository = new MemoryProductRepository()
  const platform = new MockPlatform()
  let clock = Date.parse('2026-10-05T10:00:00+08:00')
  platform.search = async ({ pageNumber }) => {
    clock = Date.parse(`2026-10-05T${pageNumber === 3 ? '11' : '10'}:00:00+08:00`)
    return makePage([makeListItem({ itemId: 'hour_A' })])
  }
  const observed: import('../../../../shared/types/product').Product[] = []
  const controller = new CaptureController({ tasks, repository, platform, now: () => clock, sleep: async () => {}, syncProducts: async (_ids, _keep, products) => { observed.push(...products); return { createdCount: products.length, skippedCount: 0 } } })
  const task = await controller.create({ keyword: '手机', pages: 3 })
  await controller.start(task.id)
  const done = await waitForTask(controller, task.id, (current) => current.status === 'completed')
  assert.equal(observed.length, 2)
  assert.equal(resultOf(done).duplicates, 1)
  assert.equal(checkpointOf(done).capturedRecords!.length, 2)
})

test('搜索节流默认参数与规整', () => {
  assert.equal(DEFAULT_CAPTURE_INTERVAL_MS, 500)
  assert.equal(DEFAULT_CAPTURE_JITTER_MS, 500)
  assert.equal(MIN_CAPTURE_INTERVAL_MS, 1500)
  assert.equal(resolveCaptureBaseIntervalMs(undefined), 500)
  assert.equal(resolveCaptureBaseIntervalMs(300), 300)
  assert.equal(resolveCaptureBaseIntervalMs(-1), 500)
  assert.equal(resolveCaptureBaseIntervalMs(Number.NaN), 500)
  assert.equal(resolveCaptureJitterMs(undefined), 500)
  assert.equal(resolveCaptureJitterMs(0), 0)
  assert.equal(resolveCaptureJitterMs(-5), 500)
})

test('create -> 入队异步执行 -> complete：串行分页、搜索节流、断点推进、事件', async () => {
  const { tasks, repository, platform, clock, controller } = makeController()
  for (let page = 1; page <= 3; page += 1) {
    platform.pages.set(page, makePage([makeListItem({ itemId: `i${page}a`, wantCnt: 5 }), makeListItem({ itemId: `i${page}b`, wantCnt: 9 })]))
  }
  const events: string[] = []
  tasks.subscribe((event) => events.push(`${event.eventType}:${event.task.status}:${event.task.progress}`))

  const created = await controller.create({ keyword: 'iPhone', pages: 3 })
  assert.equal(created.status, 'pending')
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'completed')

  assert.equal(done.status, 'completed')
  assert.equal(done.progress, 100)
  assert.deepEqual(platform.searchCalls, [1, 2, 3])
  // 3 页之间 2 次等待，随机源固定为 0 → 每次恰为基础间隔 500ms（首页不等待）。
  assert.equal(clock.sleeps.length, 2)
  assert.ok(
    clock.sleeps.every((wait) => wait === DEFAULT_CAPTURE_INTERVAL_MS),
    JSON.stringify(clock.sleeps),
  )

  const result = resultOf(done)
  assert.equal(result.fetched, 6)
  assert.equal(result.valid, 6)
  assert.equal(result.stored, 6)
  assert.equal(result.pagesCompleted, 3)
  assert.equal(result.nextPage, 4)
  assert.equal(checkpointOf(done).nextPage, 4)
  assert.equal(await repository.count(), 6)
  // startedAt / endedAt 可支持前端展示耗时。
  assert.equal(typeof done.startedAt, 'number')
  assert.equal(typeof done.endedAt, 'number')
  assert.equal(result.startedAt, done.startedAt)
  assert.equal(typeof result.endedAt, 'number')

  assert.ok(events.some((entry) => entry.includes('running')), events.join(','))
  assert.ok(events[events.length - 1]!.includes('completed'), events.join(','))
})

test('搜索节流：基础间隔 + 均匀随机增量取用 payload / 控制器配置', async () => {
  const tasks = new TaskManager({ store: new MemoryTaskStore() })
  const platform = new MockPlatform()
  const clock = makeClock()
  const controller = new CaptureController({
    tasks,
    platform,
    repository: new MemoryProductRepository(),
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5, // floor(0.5 * (100 + 1)) = 50
    minIntervalMs: 200,
    intervalJitterMs: 100,
  })
  for (let page = 1; page <= 3; page += 1) {
    platform.pages.set(page, makePage([makeListItem({ itemId: `p${page}` })]))
  }
  const created = await controller.create({ keyword: 'k', pages: 3 })
  await controller.start(created.id)
  await waitForTask(controller, created.id, (task) => task.status === 'completed')

  assert.deepEqual(clock.sleeps, [250, 250])
  assert.deepEqual(platform.searchCalls, [1, 2, 3])
})

test('统一采集队列：同一时间单任务，前一任务完成后调度下一项', async () => {
  const { platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'A' })]))

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  platform.hooks.set(1, () => gate)

  const first = await controller.create({ keyword: 'first', pages: 1 })
  await controller.start(first.id)
  await waitFor(() => platform.searchCalls.includes(1))

  // 第二个任务入队，但同一时间只能执行一个：前一个卡住时它必须等待。
  const second = await controller.create({ keyword: 'second', pages: 1 })
  await controller.start(second.id)
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(platform.searchCalls.length, 1)
  assert.equal((await controller.get(second.id))!.status, 'pending')

  release()
  await waitForTask(controller, first.id, (task) => task.status === 'completed')
  await waitForTask(controller, second.id, (task) => task.status === 'completed')
  assert.deepEqual(platform.searchCalls, [1, 1])
})

test('start 只等待持久化并异步执行；resume 先持久化 pending 再异步执行', async () => {
  const { platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'A' })]))
  platform.pages.set(2, makePage([makeListItem({ itemId: 'B' })]))

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  platform.hooks.set(2, () => gate)

  const created = await controller.create({ keyword: 'k', pages: 2 })
  const started = await controller.start(created.id)
  // start 立即返回，未等到整轮采集结束。
  assert.notEqual(started.status, 'completed')
  await waitFor(() => platform.searchCalls.includes(2))

  const firstRunStartedAt = (await controller.get(created.id))!.startedAt
  const paused = await controller.pause(created.id, '暂停')
  assert.equal(paused.status, 'paused')
  release()
  await new Promise((resolve) => setTimeout(resolve, 10))

  const resumed = await controller.resume(created.id)
  // resume 只等待 paused → pending 持久化；真正出队执行时才转 running。
  assert.equal(resumed.status, 'pending')
  assert.equal(resumed.startedAt, firstRunStartedAt) // 保留首次 startedAt
  const done = await waitForTask(controller, created.id, (task) => task.status === 'completed')
  assert.equal(checkpointOf(done).nextPage, 3)
  assert.equal(done.startedAt, firstRunStartedAt)
})

test('暂停 + 断点续采：inflight 期间暂停不推进断点，恢复后续采', async () => {
  const { repository, platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'p1' })]))
  platform.pages.set(2, makePage([makeListItem({ itemId: 'p2' })]))
  platform.pages.set(3, makePage([makeListItem({ itemId: 'p3' })]))

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  platform.hooks.set(2, () => gate)

  const created = await controller.create({ keyword: 'k', pages: 3 })
  await controller.start(created.id)
  await waitFor(() => platform.searchCalls.includes(2))

  const paused = await controller.pause(created.id, '手动暂停')
  assert.equal(paused.status, 'paused')
  release()
  await new Promise((resolve) => setTimeout(resolve, 10))

  const afterPause = await controller.get(created.id)
  assert.equal(afterPause!.status, 'paused')
  assert.equal(checkpointOf(afterPause!).nextPage, 2) // 断点未推进
  assert.equal(checkpointOf(afterPause!).pagesCompleted, 1)
  assert.equal(await repository.count(), 1) // 仅第 1 页入库

  await controller.resume(created.id)
  const resumed = await waitForTask(controller, created.id, (task) => task.status === 'completed')
  assert.equal(checkpointOf(resumed).nextPage, 4)
  assert.equal(await repository.count(), 3)
  assert.deepEqual(platform.searchCalls, [1, 2, 2, 3])
})

test('inflight 取消：任务保持 cancelled，绝不写成 completed，结果丢弃', async () => {
  const { repository, platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'c1' })]))

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  platform.hooks.set(1, () => gate)

  const created = await controller.create({ keyword: 'k', pages: 1 })
  await controller.start(created.id)
  await waitFor(() => platform.searchCalls.includes(1))

  const cancelled = await controller.cancel(created.id, '用户取消')
  assert.equal(cancelled.status, 'cancelled')
  release()
  await new Promise((resolve) => setTimeout(resolve, 10))

  const final = await controller.get(created.id)
  assert.equal(final!.status, 'cancelled')
  assert.notEqual(final!.status, 'completed')
  assert.equal(await repository.count(), 0)
  assert.ok(final!.progress < 100)
})

test('请求失败：单页失败继续采集，结果记录 failed', async () => {
  const { platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'a' })]))
  platform.pages.set(3, makePage([makeListItem({ itemId: 'c' })]))
  platform.errors.set(2, new Error('network boom'))

  const created = await controller.create({ keyword: 'k', pages: 3 })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'completed')

  assert.equal(done.status, 'completed')
  assert.deepEqual(platform.searchCalls, [1, 2, 3])
  const result = resultOf(done)
  assert.equal(result.failed, 1)
  assert.equal(result.valid, 2)
  assert.equal(result.pagesCompleted, 2)
})

test('请求失败：所有页面都失败时任务置 failed（不假成功）', async () => {
  const { platform, controller } = makeController()
  platform.errors.set(1, new Error('boom 1'))
  platform.errors.set(2, new Error('boom 2'))

  const created = await controller.create({ keyword: 'k', pages: 2 })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'failed')

  assert.equal(done.status, 'failed')
  assert.match(done.error ?? '', /boom/)
})

test('风控 / 验证码：暂停任务并保留断点，等待人工处理', async () => {
  const { platform, controller } = makeController()
  platform.errors.set(1, new PlatformError('captcha', '触发风控，需要滑块验证'))

  const created = await controller.create({ keyword: 'k', pages: 3 })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'paused')

  assert.equal(done.status, 'paused')
  assert.equal(checkpointOf(done).nextPage, 1)
  assert.match(String(done.meta?.['pauseReason'] ?? ''), /captcha/)
})

test('平台不可用：初始化错误而非假成功', async () => {
  const { platform, controller } = makeController()
  platform.available = false

  const created = await controller.create({ keyword: 'k', pages: 1 })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'failed')

  assert.equal(done.status, 'failed')
  assert.match(done.error ?? '', /平台层未就绪/)
})

test('去重 / 过滤 / 入库：同一页内 itemId 去重 + 过滤条件 + 快照', async () => {
  const { repository, platform, controller } = makeController()
  platform.pages.set(
    1,
    makePage([
      makeListItem({ itemId: 'A', wantCnt: 10, priceText: '¥50', freeShip: true }),
      makeListItem({ itemId: 'A', wantCnt: 10, priceText: '¥50', freeShip: true }),
      makeListItem({ itemId: 'B', wantCnt: 1, priceText: '¥50' }),
      makeListItem({ itemId: 'C', wantCnt: 10, priceText: '¥500' }),
      makeListItem({ itemId: 'D', wantCnt: 10, priceText: '¥50' }),
    ]),
  )

  const created = await controller.create({
    keyword: 'k',
    pages: 1,
    filter: { minWantCnt: 5, maxPrice: 100, onlyFreeShip: true },
  })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'completed')

  assert.equal(done.status, 'completed')
  const result = resultOf(done)
  assert.equal(result.fetched, 5)
  assert.equal(result.filtered, 3)
  assert.equal(result.duplicates, 1)
  assert.equal(result.valid, 1)
  assert.equal(result.stored, 1)
  assert.equal(await repository.count(), 1)
  assert.equal((await repository.getSnapshots('A')).length, 1)
})

test('重启后 pending 重新入队：requeuePending 触发执行', async () => {
  const { platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'A' })]))

  // 模拟：任务已创建（pending 持久化）但 Service Worker 重启，未执行。
  const created = await controller.create({ keyword: 'k', pages: 1 })
  await controller.requeuePending()

  const done = await waitForTask(controller, created.id, (task) => task.status === 'completed')
  assert.equal(resultOf(done).stored, 1)
})

test('详情采集为可选：开启后合并详情字段并复用旧限速', async () => {
  const { repository, platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'A' })]))

  const created = await controller.create({ keyword: 'k', pages: 1, fetchDetail: true })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'completed')

  assert.equal(done.status, 'completed')
  assert.deepEqual(platform.detailCalls, ['A'])
  assert.equal(resultOf(done).detailFailed, 0)
  const page = await repository.list({ source: 'all' })
  const product = page.products.find((p) => p.itemId === 'A')!
  assert.equal(product.browseCnt, 11)
  assert.equal(product.sellerId, 'sid-1')
})

test('详情图片全量规范化去重保序，且不覆盖已有图片集合', async () => {
  const { repository, platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'A' })]))
  platform.detailPayload = {
    data: {
      itemDO: {
        // 含协议相对、重复、空值；应全量规范化、去重保序。
        imageInfos: [{ url: '//img.example/a.jpg' }, { url: '//img.example/a.jpg' }, { url: 'https://img.example/b.jpg' }, { url: '' }],
      },
    },
  }

  const created = await controller.create({ keyword: 'k', pages: 1, fetchDetail: true })
  await controller.start(created.id)
  await waitForTask(controller, created.id, (task) => task.status === 'completed')

  const product = (await repository.list({ source: 'all' })).products.find((p) => p.itemId === 'A')!
  assert.deepEqual(product.images, ['https://img.example/a.jpg', 'https://img.example/b.jpg'])
  // 封面字段来自搜索归一化，详情不改写。
  assert.equal(product.coverUrl, 'https://img.example.com/a.jpg')
})

test('详情地区兼容 prov：列表无地区时用详情省份回填', async () => {
  const { repository, platform, controller } = makeController()
  // 列表项无地区（area 为空）。
  platform.pages.set(1, makePage([makeListItem({ itemId: 'prov_item', sellerCity: '' })]))
  platform.detailPayload = { data: { itemDO: { prov: '浙江省' } } }

  const created = await controller.create({ keyword: 'k', pages: 1, fetchDetail: true })
  await controller.start(created.id)
  await waitForTask(controller, created.id, (task) => task.status === 'completed')

  const product = (await repository.list({ source: 'all' })).products.find((p) => p.itemId === 'prov_item')!
  assert.equal(product.sellerCity, '浙江省')
})

test('重采稀疏响应：第二次缺少卖家字段不清空首次已采的卖家 / 地区', async () => {
  const { repository, platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'sparse', sellerNick: '张三', sellerCity: '上海' })]))
  const first = await controller.create({ keyword: 'k', pages: 1 })
  await controller.start(first.id)
  await waitForTask(controller, first.id, (task) => task.status === 'completed')

  // 第二次同 itemId，但平台本次未返回卖家昵称 / 地区。
  platform.pages.set(1, makePage([makeListItem({ itemId: 'sparse', sellerNick: '', sellerCity: '' })]))
  const second = await controller.create({ keyword: 'k', pages: 1 })
  await controller.start(second.id)
  await waitForTask(controller, second.id, (task) => task.status === 'completed')

  const [product] = (await repository.list({ source: 'all' })).products
  assert.equal(product!.sellerNick, '张三')
  assert.equal(product!.sellerCity, '上海')
})

test('详情失败：计入 detailFailed，且不影响列表商品入库', async () => {
  const { repository, platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'A' })]))
  platform.detailError = new Error('detail boom')

  const created = await controller.create({ keyword: 'k', pages: 1, fetchDetail: true })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'completed')

  const result = resultOf(done)
  assert.equal(result.detailFailed, 1)
  assert.equal(result.failed, 1)
  assert.equal(result.stored, 1)
  assert.equal(await repository.count(), 1)
})

test('归属安全：当前账号无法确认时绝不标 my_published，归属计入未确认统计', async () => {
  const { repository, platform, controller } = makeController({
    getCurrentUserId: async () => {
      throw new Error('currentUserId unavailable')
    },
  })
  platform.pages.set(1, makePage([makeListItem({ itemId: 'x', sellerId: 'some_seller' })]))

  const created = await controller.create({ keyword: 'k', pages: 1 })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'completed')

  assert.equal(done.status, 'completed')
  assert.equal(resultOf(done).ownershipUnconfirmed, 1)
  const [p] = (await repository.list({ source: 'all' })).products
  assert.equal(p!.source, 'captured_search')
  assert.equal(p!.status, 'unconfirmed')
  assert.equal(p!.accountId, undefined)
})

test('归属安全：卖家身份无法确认时即使账号已知也不标 my_published，计入未确认', async () => {
  const { repository, platform, controller } = makeController({ getCurrentUserId: async () => 'me_1' })
  // 只有埋点 user_id（当前账号），没有任何明确卖家字段
  platform.pages.set(1, makePage([makeListItem({ itemId: 'no_seller', clickParamUserId: 'me_1' })]))

  const created = await controller.create({ keyword: 'k', pages: 1 })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'completed')

  assert.equal(resultOf(done).ownershipUnconfirmed, 1)
  const [p] = (await repository.list({ source: 'all' })).products
  assert.equal(p!.sellerId, undefined)
  assert.equal(p!.source, 'captured_search')
  assert.equal(p!.accountId, undefined)
})

test('归属安全：能确认卖家即当前账号 → my_published，不计入未确认', async () => {
  const me = 'me_777'
  const { repository, platform, controller } = makeController({ getCurrentUserId: async () => me })
  platform.pages.set(1, makePage([makeListItem({ itemId: 'mine', sellerId: me })]))

  const created = await controller.create({ keyword: 'k', pages: 1 })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'completed')

  assert.equal(resultOf(done).ownershipUnconfirmed, 0)
  const [p] = (await repository.list({ source: 'all' })).products
  assert.equal(p!.source, 'my_published')
  assert.equal(p!.status, 'published')
  assert.equal(p!.accountId, me)
})

test('归属安全：后续未确认归属采集不得把已确认的 my_published 降级覆盖', async () => {
  const me = 'me_777'
  let accountAvailable = true
  const { repository, platform, controller } = makeController({
    getCurrentUserId: async () => {
      if (!accountAvailable) throw new Error('currentUserId unavailable')
      return me
    },
  })

  // 第一次：确认归属当前账号
  platform.pages.set(1, makePage([makeListItem({ itemId: 'mine_x', sellerId: me })]))
  const first = await controller.create({ keyword: 'k', pages: 1 })
  await controller.start(first.id)
  await waitForTask(controller, first.id, (task) => task.status === 'completed')

  // 第二次：同一 itemId，但账号不可用、卖家缺失 → 归属未确认
  accountAvailable = false
  platform.pages.set(1, makePage([makeListItem({ itemId: 'mine_x' })]))
  const second = await controller.create({ keyword: 'k', pages: 1 })
  await controller.start(second.id)
  await waitForTask(controller, second.id, (task) => task.status === 'completed')

  const mine = await repository.list({ source: 'my_published' })
  assert.equal(mine.total, 1)
  assert.equal(mine.products[0].itemId, 'mine_x')
  assert.equal((await repository.list({ source: 'captured_search' })).total, 0)
})

test('详情 sellerDO.sellerId 优先并参与归属判定', async () => {
  const me = 'me_777'
  const { repository, platform, controller } = makeController({ getCurrentUserId: async () => me })
  // 搜索项的卖家字段不是当前账号
  platform.pages.set(1, makePage([makeListItem({ itemId: 'A', sellerId: 'search_seller_other' })]))
  // 详情返回的卖家 ID 才权威，应覆盖搜索项
  platform.detailPayload = {
    data: {
      itemDO: { browseCnt: 1 },
      sellerDO: { sellerId: me, nick: '我' },
    },
  }

  const created = await controller.create({ keyword: 'k', pages: 1, fetchDetail: true })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'completed')

  const p = (await repository.list({ source: 'all' })).products.find((item) => item.itemId === 'A')!
  assert.equal(p.sellerId, me) // 详情优先覆盖搜索项
  assert.equal(p.source, 'my_published')
  assert.equal(p.accountId, me)
  assert.equal(resultOf(done).ownershipUnconfirmed, 0)
})

test('暂停发生在节流等待期间：及时释放执行槽，后续任务继续执行', async () => {
  const tasks = new TaskManager({ store: new MemoryTaskStore() })
  const repository = new MemoryProductRepository()
  const platform = new MockPlatform()
  // 用一个永不自行完成的 sleep 模拟“卡在节流等待中”。
  let releaseSleep: (() => void) | null = null
  const sleep = (): Promise<void> =>
    new Promise<void>((resolve) => {
      releaseSleep = resolve
    })
  const controller = new CaptureController({
    tasks,
    platform,
    repository,
    now: () => 0,
    sleep,
    random: () => 0,
  })
  platform.pages.set(1, makePage([makeListItem({ itemId: 'A1' })]))
  platform.pages.set(2, makePage([makeListItem({ itemId: 'A2' })]))

  const first = await controller.create({ keyword: 'A', pages: 2 })
  await controller.start(first.id)
  await waitFor(() => releaseSleep !== null)
  assert.deepEqual(platform.searchCalls, [1])

  // 第二个任务入队，但执行槽被 A 占用。
  const second = await controller.create({ keyword: 'B', pages: 1 })
  await controller.start(second.id)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(platform.searchCalls.length, 1)

  // 暂停 A：即使 sleep 仍挂起，也应立即释放执行槽，让 B 执行。
  const paused = await controller.pause(first.id, '暂停等待中')
  assert.equal(paused.status, 'paused')
  const doneB = await waitForTask(controller, second.id, (task) => task.status === 'completed')
  assert.equal(doneB.status, 'completed')

  const aTask = await controller.get(first.id)
  assert.equal(aTask!.status, 'paused')
  assert.equal(checkpointOf(aTask!).nextPage, 2) // 第 2 页未执行，断点未推进
})

test('恢复排队：另一任务运行中，resume 的任务保持 pending，不并发执行', async () => {
  const { tasks, platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'X' })]))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  platform.hooks.set(1, () => gate)

  const a = await controller.create({ keyword: 'A', pages: 1 })
  await controller.start(a.id)
  await waitFor(() => platform.searchCalls.includes(1))

  // 构造一个 paused 任务。
  const b = await controller.create({ keyword: 'B', pages: 1 })
  await tasks.start(b.id)
  await tasks.pause(b.id)

  const resumed = await controller.resume(b.id)
  assert.equal(resumed.status, 'pending') // 等待仍 pending，出队才 running
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal((await controller.get(b.id))!.status, 'pending')
  assert.equal(platform.searchCalls.length, 1, 'B 不得与 A 并发')

  release()
  await waitForTask(controller, a.id, (task) => task.status === 'completed')
  await waitForTask(controller, b.id, (task) => task.status === 'completed')
})

test('取消 inflight 的验证码错误：任务保持 cancelled，不被改写成 paused', async () => {
  const { platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'X' })]))
  platform.errors.set(1, new PlatformError('captcha', '需要滑块验证'))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  platform.hooks.set(1, () => gate)

  const a = await controller.create({ keyword: 'A', pages: 1 })
  await controller.start(a.id)
  await waitFor(() => platform.searchCalls.includes(1))

  // 请求仍 inflight 时取消；随后请求抛 captcha，但不得把 cancelled 改写为 paused。
  const cancelled = await controller.cancel(a.id, '用户取消')
  assert.equal(cancelled.status, 'cancelled')
  release()
  await new Promise((resolve) => setTimeout(resolve, 20))

  const task = await controller.get(a.id)
  assert.equal(task!.status, 'cancelled')
  assert.equal(task!.meta?.['pauseReason'], undefined)
})

test('跨轮次去重：断点已含 storedIds 时恢复不重复入库、不重复计数 stored，统计跨轮次保持', async () => {
  const { tasks, repository, platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'X' })]))

  const created = await controller.create({ keyword: 'k', pages: 1 })
  // 手工构造「上一轮已入库 X 但断点未推进」的断点。
  await tasks.start(created.id)
  const checkpoint: CaptureCheckpoint = {
    keyword: 'k',
    startPage: 1,
    totalPages: 1,
    nextPage: 1,
    pagesCompleted: 0,
    stats: { ...emptyCaptureStats(), stored: 1, pageFailed: 1, detailFailed: 2, failed: 3 },
    storedIds: ['X'],
  }
  await tasks.updateProgress(created.id, 0, { capture: checkpoint })
  await tasks.pause(created.id)

  await controller.resume(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'completed')

  const result = resultOf(done)
  assert.equal(result.duplicates, 1) // 已入库 X 计入重复，不再 valid
  assert.equal(result.valid, 0)
  assert.equal(result.stored, 1) // 不重复计数
  assert.equal(result.failed, 3) // pageFailed(1) + detailFailed(2)，跨轮次保持
  assert.equal(result.detailFailed, 2)
  assert.equal(await repository.count(), 0) // 本轮无新入库
})

test('requeuePending 按 createdAt 升序重新入队', async () => {
  const { tasks, platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'i' })]))

  // 直接创建两个 pending 任务，保证 createdAt 递增。
  const first = await tasks.create({ type: 'capture', payload: { keyword: 'first', pages: 1 } })
  await new Promise((resolve) => setTimeout(resolve, 3))
  const second = await tasks.create({ type: 'capture', payload: { keyword: 'second', pages: 1 } })

  await controller.requeuePending()
  await waitForTask(controller, first.id, (task) => task.status === 'completed')
  await waitForTask(controller, second.id, (task) => task.status === 'completed')

  // 按 createdAt 升序：first 先执行。
  assert.deepEqual(platform.searchKeywords, ['first', 'second'])
})

test('详情首图补封面：列表无封面时用详情首图回填', async () => {
  const { repository, platform, controller } = makeController()
  // 列表项无封面（picUrl 为空）。
  platform.pages.set(1, makePage([makeListItem({ itemId: 'no_cover', picUrl: '' })]))
  platform.detailPayload = {
    data: {
      itemDO: {
        imageInfos: [{ url: '//img.example.com/first.jpg' }, { url: '//img.example.com/second.jpg' }],
      },
    },
  }

  const created = await controller.create({ keyword: 'k', pages: 1, fetchDetail: true })
  await controller.start(created.id)
  await waitForTask(controller, created.id, (task) => task.status === 'completed')

  const product = (await repository.list({ source: 'all' })).products.find((p) => p.itemId === 'no_cover')!
  // 列表无封面 → 详情首图回填封面（避免有图无封面）。
  assert.equal(product.coverUrl, 'https://img.example.com/first.jpg')
  assert.deepEqual(product.images, ['https://img.example.com/first.jpg', 'https://img.example.com/second.jpg'])
})

test('失败统计及时持久化：全部页面失败的任务 meta.capture.stats 可见失败计数', async () => {
  const { platform, controller } = makeController()
  platform.errors.set(1, new Error('boom 1'))
  platform.errors.set(2, new Error('boom 2'))

  const created = await controller.create({ keyword: 'k', pages: 2 })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'failed')

  const stats = checkpointOf(done).stats
  assert.equal(stats.pageFailed, 2)
  assert.equal(stats.failed, 2)
})

test('暂停（验证码）时失败统计及时持久化：meta.capture.stats 可见失败计数', async () => {
  const { platform, controller } = makeController()
  platform.errors.set(1, new PlatformError('captcha', '需要滑块验证'))

  const created = await controller.create({ keyword: 'k', pages: 3 })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'paused')

  const stats = checkpointOf(done).stats
  assert.equal(stats.pageFailed, 1)
  assert.equal(stats.failed, 1)
  assert.match(String(done.meta?.['pauseReason'] ?? ''), /captcha/)
})

test('详情失败统计及时持久化：meta.capture.stats 可见 detailFailed', async () => {
  const { platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'A' })]))
  platform.detailError = new Error('detail boom')

  const created = await controller.create({ keyword: 'k', pages: 1, fetchDetail: true })
  await controller.start(created.id)
  const done = await waitForTask(controller, created.id, (task) => task.status === 'completed')

  const stats = checkpointOf(done).stats
  assert.equal(stats.detailFailed, 1)
  assert.equal(stats.failed, 1)
})


test('控制器拒绝跨类型操作：原任务不变且无采集副作用', async (t) => {
  for (const type of ['analysis', 'publish'] as const) {
    for (const status of ['pending', 'running', 'paused'] as const) {
      for (const action of ['start', 'resume', 'pause', 'cancel'] as const) {
        await t.test(`${type}/${status}/${action}`, async () => {
          let syncCalls = 0
          const { tasks, repository, platform, controller } = makeController({
            syncProducts: async () => { syncCalls += 1; return { createdCount: 0, skippedCount: 0 } },
          })
          const task = await tasks.create({ type, payload: { ruleId: 'synthetic' }, meta: { marker: '保留' } })
          if (status !== 'pending') await tasks.start(task.id)
          if (status === 'paused') await tasks.pause(task.id)
          if (status !== 'pending') await tasks.updateProgress(task.id, 37)
          const before = await tasks.getById(task.id)
          const changes: Task[] = []
          tasks.subscribe((event) => changes.push(event.task))
          // 再次调用仍应拒绝，且不能通过旧任务的状态走幂等成功路径。
          for (let attempt = 0; attempt < 2; attempt += 1) {
            await assert.rejects(controller[action](task.id), /任务类型不匹配.*capture/)
          }
          assert.deepEqual(await tasks.getById(task.id), before)
          assert.deepEqual(changes, [])
          assert.deepEqual(platform.searchCalls, [])
          assert.deepEqual(platform.detailCalls, [])
          assert.equal(syncCalls, 0)
          assert.equal(await repository.count(), 0)
        })
      }
    }
  }
})

test('队列出队前复验任务类型，跳过错误类型并继续正常调度', async () => {
  const { store, tasks, platform, controller } = makeController()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  platform.hooks.set(1, () => gate)
  const first = await controller.create({ keyword: 'first', pages: 1 })
  await controller.start(first.id)
  await waitFor(() => platform.searchCalls.length === 1)
  const queued = await controller.create({ keyword: 'wrong-type', pages: 1 })
  await controller.start(queued.id)
  // 模拟队列等待期间存储返回了非采集任务；不得流转状态或执行搜索。
  const replacement: Task = { ...(await tasks.getById(queued.id))!, type: 'analysis', result: { summary: '保留结果' } }
  await store.save(replacement)
  const next = await controller.create({ keyword: 'next', pages: 1 })
  await controller.start(next.id)
  release()
  await waitForTask(controller, next.id, (task) => task.status === 'completed')
  assert.deepEqual(await tasks.getById(queued.id), replacement)
  assert.deepEqual(platform.searchKeywords, ['first', 'next'])
})
