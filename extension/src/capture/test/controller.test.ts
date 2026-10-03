/**
 * 采集控制器单测（全部 mock，无真实网络）：
 * - create → progress → pause/resume → complete 全流程与限速；
 * - 断点续采；
 * - inflight 暂停 / 取消的竞态保护（取消绝不写成 completed）；
 * - 请求失败（单页失败继续 / 全部失败置 failed / 风控暂停）；
 * - 平台不可用的初始化错误；
 * - 去重 / 过滤 / 入库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryTaskStore, TaskManager } from '../../../../shared/task/index'
import type { Task } from '../../../../shared/task/index'
import { MemoryProductRepository } from '../../../../shared/capture/product-repository'
import { CaptureController, MIN_CAPTURE_INTERVAL_MS, resolveCaptureIntervalMs } from '../controller'
import { PlatformError } from '../../platform/errors'
import type { CaptureCheckpoint, CaptureResult } from '../../../../shared/types/capture'
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

function makeController(options: {
  getCurrentUserId?: () => Promise<string | undefined> | string | undefined
} = {}) {
  const tasks = new TaskManager({ store: new MemoryTaskStore() })
  const repository = new MemoryProductRepository()
  const platform = new MockPlatform()
  const clock = makeClock()
  const controller = new CaptureController({
    tasks,
    platform,
    repository,
    now: clock.now,
    sleep: clock.sleep,
    ...(options.getCurrentUserId ? { getCurrentUserId: options.getCurrentUserId } : {}),
  })
  return { tasks, repository, platform, clock, controller }
}

test('限速间隔下限为 1500ms', () => {
  assert.equal(MIN_CAPTURE_INTERVAL_MS, 1500)
  assert.equal(resolveCaptureIntervalMs(undefined), 1500)
  assert.equal(resolveCaptureIntervalMs(500), 1500)
  assert.equal(resolveCaptureIntervalMs(3000), 3000)
})

test('create -> progress -> complete：串行分页、限速、断点推进、事件', async () => {
  const { tasks, repository, platform, clock, controller } = makeController()
  for (let page = 1; page <= 3; page += 1) {
    platform.pages.set(page, makePage([makeListItem({ itemId: `i${page}a`, wantCnt: 5 }), makeListItem({ itemId: `i${page}b`, wantCnt: 9 })]))
  }
  const events: string[] = []
  tasks.subscribe((event) => events.push(`${event.eventType}:${event.task.status}:${event.task.progress}`))

  const created = await controller.create({ keyword: 'iPhone', pages: 3 })
  assert.equal(created.status, 'pending')
  const done = await controller.start(created.id)

  assert.equal(done.status, 'completed')
  assert.equal(done.progress, 100)
  assert.deepEqual(platform.searchCalls, [1, 2, 3])
  // 3 页之间 2 次等待，且均不低于 1500ms
  assert.equal(clock.sleeps.length, 2)
  assert.ok(clock.sleeps.every((wait) => wait >= MIN_CAPTURE_INTERVAL_MS), JSON.stringify(clock.sleeps))

  const result = resultOf(done)
  assert.equal(result.fetched, 6)
  assert.equal(result.valid, 6)
  assert.equal(result.pagesCompleted, 3)
  assert.equal(result.nextPage, 4)
  assert.equal(checkpointOf(done).nextPage, 4)
  assert.equal(await repository.count(), 6)

  assert.ok(events.some((entry) => entry.includes('running')), events.join(','))
  assert.ok(events[events.length - 1]!.includes('completed'), events.join(','))
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
  const runPromise = controller.start(created.id)
  await waitFor(() => platform.searchCalls.includes(2))

  const paused = await controller.pause(created.id, '手动暂停')
  assert.equal(paused.status, 'paused')
  release()
  const afterPause = await runPromise

  assert.equal(afterPause.status, 'paused')
  assert.equal(checkpointOf(afterPause).nextPage, 2) // 断点未推进
  assert.equal(checkpointOf(afterPause).pagesCompleted, 1)
  assert.equal(await repository.count(), 1) // 仅第 1 页入库

  const resumed = await controller.resume(created.id)
  assert.equal(resumed.status, 'completed')
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
  const runPromise = controller.start(created.id)
  await waitFor(() => platform.searchCalls.includes(1))

  const cancelled = await controller.cancel(created.id, '用户取消')
  assert.equal(cancelled.status, 'cancelled')
  release()

  const final = await runPromise
  assert.equal(final.status, 'cancelled')
  assert.notEqual(final.status, 'completed')
  assert.equal(await repository.count(), 0)
  assert.ok(final.progress < 100)
})

test('请求失败：单页失败继续采集，结果记录 failed', async () => {
  const { platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'a' })]))
  platform.pages.set(3, makePage([makeListItem({ itemId: 'c' })]))
  platform.errors.set(2, new Error('network boom'))

  const created = await controller.create({ keyword: 'k', pages: 3 })
  const done = await controller.start(created.id)

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
  const done = await controller.start(created.id)

  assert.equal(done.status, 'failed')
  assert.match(done.error ?? '', /boom/)
})

test('风控 / 验证码：暂停任务并保留断点，等待人工处理', async () => {
  const { platform, controller } = makeController()
  platform.errors.set(1, new PlatformError('captcha', '触发风控，需要滑块验证'))

  const created = await controller.create({ keyword: 'k', pages: 3 })
  const done = await controller.start(created.id)

  assert.equal(done.status, 'paused')
  assert.equal(checkpointOf(done).nextPage, 1)
  assert.match(String(done.meta?.['pauseReason'] ?? ''), /captcha/)
})

test('平台不可用：初始化错误而非假成功', async () => {
  const { platform, controller } = makeController()
  platform.available = false

  const created = await controller.create({ keyword: 'k', pages: 1 })
  const done = await controller.start(created.id)

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
  const done = await controller.start(created.id)

  assert.equal(done.status, 'completed')
  const result = resultOf(done)
  assert.equal(result.fetched, 5)
  assert.equal(result.filtered, 3)
  assert.equal(result.duplicates, 1)
  assert.equal(result.valid, 1)
  assert.equal(await repository.count(), 1)
  assert.equal((await repository.getSnapshots('A')).length, 1)
})

test('详情采集为可选：开启后合并详情字段并复用限速', async () => {
  const { repository, platform, controller } = makeController()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'A' })]))

  const created = await controller.create({ keyword: 'k', pages: 1, fetchDetail: true })
  const done = await controller.start(created.id)

  assert.equal(done.status, 'completed')
  assert.deepEqual(platform.detailCalls, ['A'])
  const page = await repository.list({ source: 'all' })
  const product = page.products.find((p) => p.itemId === 'A')!
  assert.equal(product.browseCnt, 11)
  assert.equal(product.sellerId, 'sid-1')
})

test('归属安全：当前账号无法确认时绝不标 my_published，归属计入未确认统计', async () => {
  const { repository, platform, controller } = makeController({
    getCurrentUserId: async () => {
      throw new Error('currentUserId unavailable')
    },
  })
  platform.pages.set(1, makePage([makeListItem({ itemId: 'x', sellerId: 'some_seller' })]))

  const created = await controller.create({ keyword: 'k', pages: 1 })
  const done = await controller.start(created.id)

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
  const done = await controller.start(created.id)

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
  const done = await controller.start(created.id)

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

  // 第二次：同一 itemId，但账号不可用、卖家缺失 → 归属未确认
  accountAvailable = false
  platform.pages.set(1, makePage([makeListItem({ itemId: 'mine_x' })]))
  const second = await controller.create({ keyword: 'k', pages: 1 })
  await controller.start(second.id)

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
  const done = await controller.start(created.id)

  const p = (await repository.list({ source: 'all' })).products.find((item) => item.itemId === 'A')!
  assert.equal(p.sellerId, me) // 详情优先覆盖搜索项
  assert.equal(p.source, 'my_published')
  assert.equal(p.accountId, me)
  assert.equal(resultOf(done).ownershipUnconfirmed, 0)
})
