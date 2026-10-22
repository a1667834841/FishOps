/**
 * 采集运行时（background 接线）协议级单测（全 mock，无真实网络）：
 * CAPTURE_* / TASK_LIST / PRODUCT_LIST 命令、schema 校验、TASK_CHANGED 事件、
 * 平台不可用的初始化错误、启动恢复不自动续跑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CommandTypes, EventTypes } from '@fishops/shared'
import type { CommandEnvelope, TaskChangedPayload } from '@fishops/shared'
import { MemoryTaskStore, TaskManager } from '../../../../shared/task/index'
import type { Task, TaskFilter } from '../../../../shared/task/index'
import { MemoryProductRepository } from '../../../../shared/capture/product-repository'
import type { Product } from '../../../../shared/types/product'
import type { CaptureCheckpoint } from '../../../../shared/types/capture'
import { createCaptureRuntime, type CaptureEventEnvelope } from '../../background/capture-runtime'
import { MockPlatform, makeListItem, makePage } from './fixtures'

function cmd(type: string, payload: unknown): CommandEnvelope {
  return {
    kind: 'command',
    protocol: 1,
    requestId: `req_${Math.random().toString(36).slice(2)}`,
    type,
    payload,
    sentAt: Date.now(),
  }
}

function setup(options: {
  available?: boolean
  store?: MemoryTaskStore
  syncProducts?: import('../controller').CaptureControllerDeps['syncProducts']
  getCurrentUserId?: () => Promise<string | undefined> | string | undefined
} = {}) {
  const store = options.store ?? new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = new MemoryProductRepository()
  const platform = new MockPlatform()
  if (options.available === false) platform.available = false
  const events: CaptureEventEnvelope[] = []
  const runtime = createCaptureRuntime({
    platform,
    repository,
    tasks,
    sleep: async () => {}, // 跳过真实限速等待
    onEvent: (event) => events.push(event),
    getCurrentUserId: options.getCurrentUserId,
    syncProducts: options.syncProducts,
  })
  return { store, tasks, repository, platform, events, runtime }
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function changedPayload(event: CaptureEventEnvelope): TaskChangedPayload {
  return event.payload as TaskChangedPayload
}

test('CAPTURE_CREATE 负载非法返回 INVALID_PAYLOAD，且不创建任务', async () => {
  const { runtime, tasks } = setup()
  const response = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_CREATE, { keyword: '' }))
  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'INVALID_PAYLOAD')
  assert.equal((await tasks.list({ type: 'capture' } as TaskFilter)).length, 0)
})

test('平台不可用：返回 PLATFORM_ERROR(host-unavailable)，不创建任务、不假成功', async () => {
  const { runtime, tasks, platform } = setup({ available: false })
  assert.equal(runtime.isPlatformReady(), false)
  const response = await runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 1 }),
  )
  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'PLATFORM_ERROR')
  assert.equal(response.error?.category, 'host-unavailable')
  assert.equal((await tasks.list()).length, 0)
  assert.equal(platform.searchCalls.length, 0)
})

test('CAPTURE_CREATE → TASK_CHANGED → TASK_LIST / CAPTURE_GET / PRODUCT_LIST', async () => {
  const { runtime, platform, events } = setup()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'A' }), makeListItem({ itemId: 'B' })]))

  const createRes = await runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 1 }),
  )
  assert.equal(createRes.ok, true)
  const created = createRes.result as { task: Task }
  assert.equal(created.task.status, 'pending')
  assert.equal(created.task.type, 'capture')

  await waitFor(() =>
    events.some(
      (event) =>
        event.type === EventTypes.TASK_CHANGED &&
        changedPayload(event).task.id === created.task.id &&
        changedPayload(event).task.status === 'completed',
    ),
  )
  const completedEvent = events.find(
    (event) =>
      event.type === EventTypes.TASK_CHANGED && changedPayload(event).task.status === 'completed',
  )!
  assert.equal(changedPayload(completedEvent).eventType, 'updated')

  const listRes = await runtime.handleCommand(cmd(CommandTypes.TASK_LIST, { type: 'capture' }))
  assert.equal(listRes.ok, true)
  assert.equal((listRes.result as { tasks: Task[] }).tasks.length, 1)

  const getRes = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_GET, { id: created.task.id }))
  assert.equal(getRes.ok, true)
  assert.equal((getRes.result as { task: Task }).task.id, created.task.id)

  const productRes = await runtime.handleCommand(cmd(CommandTypes.PRODUCT_LIST, { source: 'all' }))
  assert.equal(productRes.ok, true)
  assert.equal((productRes.result as { total: number }).total, 2)
})

test('CAPTURE_GET 未知任务返回 INVALID_PAYLOAD', async () => {
  const { runtime } = setup()
  const response = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_GET, { id: 'nope' }))
  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'INVALID_PAYLOAD')
})

test('CAPTURE_CREATE：intervalJitterMs 非负有限数校验', async () => {
  const { runtime, tasks } = setup()
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 'x']) {
    const response = await runtime.handleCommand(
      cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', intervalJitterMs: bad }),
    )
    assert.equal(response.ok, false, `intervalJitterMs=${String(bad)} 应被拒绝`)
    assert.equal(response.error?.code, 'INVALID_PAYLOAD')
  }
  assert.equal((await tasks.list()).length, 0)
  const okResponse = await runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', intervalJitterMs: 0 }),
  )
  assert.equal(okResponse.ok, true)
})

test('CAPTURE_PAUSE / CAPTURE_RESUME：断点续采（resume 只持久化 running，异步续采）', async () => {
  const { runtime, platform, events } = setup()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'p1' })]))
  platform.pages.set(2, makePage([makeListItem({ itemId: 'p2' })]))

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  platform.hooks.set(2, () => gate)

  const createRes = await runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 2 }),
  )
  const id = (createRes.result as { task: Task }).task.id
  await waitFor(() => platform.searchCalls.includes(2))

  const pauseRes = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_PAUSE, { id, reason: '暂停' }))
  assert.equal(pauseRes.ok, true)
  assert.equal((pauseRes.result as { task: Task }).task.status, 'paused')

  release()
  // 等待后台旧 run 退出（释放 subsequent 采集）
  await new Promise((resolve) => setTimeout(resolve, 10))

  const resumeRes = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_RESUME, { id }))
  assert.equal(resumeRes.ok, true)
  // resume 只等待持久化，返回时已置 pending 重新排队，整轮采集仍在后台异步执行。
  assert.equal((resumeRes.result as { task: Task }).task.status, 'pending')

  await waitFor(() =>
    events.some(
      (event) =>
        event.type === EventTypes.TASK_CHANGED &&
        changedPayload(event).task.id === id &&
        changedPayload(event).task.status === 'completed',
    ),
  )
  const getRes = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_GET, { id }))
  const resumed = (getRes.result as { task: Task }).task
  assert.equal(resumed.status, 'completed')
  assert.equal((resumed.meta as { capture: CaptureCheckpoint }).capture.nextPage, 3)
})

test('CAPTURE_CANCEL：inflight 取消后任务保持 cancelled', async () => {
  const { runtime, platform } = setup()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'c1' })]))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  platform.hooks.set(1, () => gate)

  const createRes = await runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 1 }),
  )
  const id = (createRes.result as { task: Task }).task.id
  await waitFor(() => platform.searchCalls.includes(1))

  const cancelRes = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_CANCEL, { id, reason: '取消' }))
  assert.equal(cancelRes.ok, true)
  assert.equal((cancelRes.result as { task: Task }).task.status, 'cancelled')

  release()
  const getRes = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_GET, { id }))
  await waitFor(() => {
    const task = (getRes.result as { task: Task }).task
    return task.status === 'cancelled'
  })
  // 再取一次（等待后台 run 结束后）
  await new Promise((resolve) => setTimeout(resolve, 10))
  const finalRes = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_GET, { id }))
  assert.equal((finalRes.result as { task: Task }).task.status, 'cancelled')
})

test('启动恢复：running 任务恢复为 paused 且不自动续跑', async () => {
  const store = new MemoryTaskStore()
  const writer = new TaskManager({ store })
  const checkpoint: CaptureCheckpoint = {
    keyword: 'x',
    startPage: 1,
    totalPages: 3,
    nextPage: 2,
    pagesCompleted: 1,
    stats: { fetched: 2, valid: 2, filtered: 0, duplicates: 0, failed: 0 },
  }
  const created = await writer.create({
    type: 'capture',
    payload: { keyword: 'x', pages: 3 },
    meta: { capture: checkpoint },
  })
  await writer.start(created.id)
  await writer.updateProgress(created.id, 40, { capture: checkpoint })

  // 模拟 Service Worker 重启：新运行时在共享 store 上 init → 恢复
  const { runtime, platform } = setup({ store })
  await runtime.init()

  const reader = new TaskManager({ store })
  const [task] = await reader.list({ type: 'capture' })
  assert.equal(task!.status, 'paused')
  assert.equal((task!.meta as { capture: CaptureCheckpoint }).capture.nextPage, 2)
  // 未自动执行任何搜索
  assert.equal(platform.searchCalls.length, 0)
})

test('采集商品来源隔离: 搜索采集竞品标记为 captured_search，匹配账号归入 my_published，绝不冒充', async () => {
  const myUserId = 'user_me_888'
  const otherUserId = 'user_competitor_999'

  const { runtime, platform, events } = setup({
    getCurrentUserId: async () => myUserId,
  })

  // 模拟搜索结果：一个卖家是当前用户，另一个是外部竞品卖家
  platform.pages.set(
    1,
    makePage([
      makeListItem({ itemId: 'my_prod', sellerId: myUserId }),
      makeListItem({ itemId: 'comp_prod', sellerId: otherUserId }),
    ]),
  )

  const createRes = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 1 }))
  assert.equal(createRes.ok, true)
  const created = (createRes.result as { task: Task }).task

  await waitFor(() =>
    events.some(
      (event) =>
        event.type === EventTypes.TASK_CHANGED &&
        changedPayload(event).task.id === created.id &&
        changedPayload(event).task.status === 'completed',
    ),
  )

  // 1. PRODUCT_LIST 不指定 source（全量）：共 2 条，且各自来源标记正确
  const allRes = await runtime.handleCommand(cmd(CommandTypes.PRODUCT_LIST, { source: 'all' }))
  assert.equal(allRes.ok, true)
  const allProducts = (allRes.result as { products: Product[]; total: number }).products
  assert.equal(allProducts.length, 2)
  const myItem = allProducts.find((p) => p.itemId === 'my_prod')
  const compItem = allProducts.find((p) => p.itemId === 'comp_prod')
  assert.equal(myItem?.source, 'my_published')
  assert.equal(myItem?.accountId, myUserId)
  assert.equal(compItem?.source, 'captured_search')

  // 2. PRODUCT_LIST 仅查询当前账号发布商品 (my_published)：只有 my_prod，竞品 comp_prod 绝不混入冒充！
  const myRes = await runtime.handleCommand(cmd(CommandTypes.PRODUCT_LIST, { source: 'my_published' }))
  assert.equal(myRes.ok, true)
  const myProducts = (myRes.result as { products: Product[]; total: number }).products
  assert.equal(myProducts.length, 1)
  assert.equal(myProducts[0].itemId, 'my_prod')

  // 3. PRODUCT_LIST 查询搜索采集竞品 (captured_search)：只有 comp_prod
  const compRes = await runtime.handleCommand(cmd(CommandTypes.PRODUCT_LIST, { source: 'captured_search' }))
  assert.equal(compRes.ok, true)
  const compProducts = (compRes.result as { products: Product[]; total: number }).products
  assert.equal(compProducts.length, 1)
  assert.equal(compProducts[0].itemId, 'comp_prod')
})

test('回归: PRODUCT_LIST 缺省 source 安全默认 my_published，竞品绝不混入', async () => {
  const myUserId = 'user_me_888'
  const otherUserId = 'user_competitor_999'
  const { runtime, platform, events } = setup({ getCurrentUserId: async () => myUserId })

  platform.pages.set(
    1,
    makePage([
      makeListItem({ itemId: 'my_prod', sellerId: myUserId }),
      makeListItem({ itemId: 'comp_prod', sellerId: otherUserId }),
    ]),
  )
  const createRes = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 1 }))
  const created = (createRes.result as { task: Task }).task
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === EventTypes.TASK_CHANGED &&
        changedPayload(event).task.id === created.id &&
        changedPayload(event).task.status === 'completed',
    ),
  )

  // 缺省（不传 source）安全默认为 my_published：竞品绝不冒充自有商品
  const defaultRes = await runtime.handleCommand(cmd(CommandTypes.PRODUCT_LIST, {}))
  const defaultProducts = (defaultRes.result as { products: Product[]; total: number }).products
  assert.equal(defaultProducts.length, 1)
  assert.equal(defaultProducts[0].itemId, 'my_prod')

  // 只有在显式 source: 'all' 时才能拿到全量
  const allRes = await runtime.handleCommand(cmd(CommandTypes.PRODUCT_LIST, { source: 'all' }))
  assert.equal((allRes.result as { total: number }).total, 2)
})

test('回归: 后续未确认归属采集不得覆盖已确认的 my_published', async () => {
  const myUserId = 'user_me_888'
  let accountAvailable = true
  const { runtime, platform, events } = setup({
    getCurrentUserId: async () => {
      if (!accountAvailable) throw new Error('currentUserId unavailable')
      return myUserId
    },
  })

  // 第一次：确认商品归属当前账号 → my_published
  platform.pages.set(1, makePage([makeListItem({ itemId: 'mine_prod', sellerId: myUserId })]))
  const first = (await runtime.handleCommand(cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 1 })))
    .result as { task: Task }
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === EventTypes.TASK_CHANGED &&
        changedPayload(event).task.id === first.task.id &&
        changedPayload(event).task.status === 'completed',
    ),
  )

  // 第二次：同一 itemId，但账号不可用、卖家缺失 → 归属未确认，绝不降级覆盖 my_published
  accountAvailable = false
  platform.pages.set(1, makePage([makeListItem({ itemId: 'mine_prod' })]))
  const second = (await runtime.handleCommand(cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 1 })))
    .result as { task: Task }
  await waitFor(() =>
    events.some(
      (event) =>
        event.type === EventTypes.TASK_CHANGED &&
        changedPayload(event).task.id === second.task.id &&
        changedPayload(event).task.status === 'completed',
    ),
  )

  const mineRes = await runtime.handleCommand(cmd(CommandTypes.PRODUCT_LIST, { source: 'my_published' }))
  const mineProducts = (mineRes.result as { products: Product[]; total: number }).products
  assert.equal(mineProducts.length, 1)
  assert.equal(mineProducts[0].itemId, 'mine_prod')

  const compRes = await runtime.handleCommand(cmd(CommandTypes.PRODUCT_LIST, { source: 'captured_search' }))
  assert.equal((compRes.result as { total: number }).total, 0)
})

test('回归: 埋点 user_id 是当前账号、卖家 seller_id 不同 → 绝不误标 my_published', async () => {
  const myUserId = 'user_me_888'
  const otherSellerId = 'seller_competitor_999'

  const { runtime, platform, events } = setup({ getCurrentUserId: async () => myUserId })

  platform.pages.set(
    1,
    makePage([
      // 埋点 user_id = 当前账号，但真实卖家是别人
      makeListItem({ itemId: 'comp_prod', sellerId: otherSellerId, clickParamUserId: myUserId }),
      // 只有埋点 user_id = 当前账号，无任何明确卖家字段
      makeListItem({ itemId: 'no_seller_prod', clickParamUserId: myUserId }),
    ]),
  )

  const createRes = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 1 }))
  assert.equal(createRes.ok, true)
  const created = (createRes.result as { task: Task }).task

  await waitFor(() =>
    events.some(
      (event) =>
        event.type === EventTypes.TASK_CHANGED &&
        changedPayload(event).task.id === created.id &&
        changedPayload(event).task.status === 'completed',
    ),
  )

  const allRes = await runtime.handleCommand(cmd(CommandTypes.PRODUCT_LIST, { source: 'all' }))
  const allProducts = (allRes.result as { products: Product[]; total: number }).products
  const compItem = allProducts.find((p) => p.itemId === 'comp_prod')
  const noSellerItem = allProducts.find((p) => p.itemId === 'no_seller_prod')

  // 卖家是别人：sellerId 取真实卖家，而不是埋点 user_id
  assert.equal(compItem?.sellerId, otherSellerId)
  assert.equal(compItem?.source, 'captured_search')
  assert.equal(compItem?.accountId, undefined)
  // 卖家身份无法确认：sellerId 留空，绝不因 user_id 命中当前账号而冒充 my_published
  assert.equal(noSellerItem?.sellerId, undefined)
  assert.equal(noSellerItem?.source, 'captured_search')

  // my_published 严格为空：绝不冒充
  const myRes = await runtime.handleCommand(cmd(CommandTypes.PRODUCT_LIST, { source: 'my_published' }))
  assert.equal((myRes.result as { total: number }).total, 0)

  // 账号已知，但卖家身份无法确认的那一条计入「归属未确认」
  const getRes = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_GET, { id: created.id }))
  const task = (getRes.result as { task: Task }).task
  assert.equal((task.result as { ownershipUnconfirmed?: number } | undefined)?.ownershipUnconfirmed, 1)
})


test('回归：采集完成前必须把已入库商品同步到飞书', async () => {
  const repository = new MemoryProductRepository()
  const tasks = new TaskManager({ store: new MemoryTaskStore() })
  const platform = new MockPlatform()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'sync_A' })]))
  const synced: string[][] = []
  let terminal: Task | null = null
  const deps = {
    platform, repository, tasks, sleep: async () => {},
    onEvent: (event: CaptureEventEnvelope) => {
      const task = changedPayload(event).task
      if (task.status === 'completed' || task.status === 'failed') terminal = task
    },
    syncProducts: async (itemIds: string[]) => {
      assert.ok((await repository.list({ source: 'all' })).products.find((p) => p.itemId === itemIds[0]))
      synced.push(itemIds)
      return { createdCount: itemIds.length, skippedCount: 0 }
    },
  }
  const runtime = createCaptureRuntime(deps)
  const response = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 1 }))
  const id = (response.result as { task: Task }).task.id
  await waitFor(() => terminal !== null)
  terminal = await tasks.getById(id)
  assert.equal(terminal?.status, 'completed')
  assert.deepEqual(synced, [['sync_A']])
})

test('飞书同步失败保留本地数据和断点，恢复后只重试同步', async () => {
  const repository = new MemoryProductRepository()
  const tasks = new TaskManager({ store: new MemoryTaskStore() })
  const platform = new MockPlatform()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'retry_A' })]))
  const events: CaptureEventEnvelope[] = []
  let fail = true
  let attempts = 0
  const runtime = createCaptureRuntime({
    platform, repository, tasks, sleep: async () => {},
    onEvent: (event) => { events.push(event) },
    syncProducts: async (ids) => {
      attempts += 1
      assert.deepEqual(ids, ['retry_A'])
      if (fail) throw new Error('飞书未配置')
      return { createdCount: 1, skippedCount: 0 }
    },
  })
  const response = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 1 }))
  const id = (response.result as { task: Task }).task.id
  await waitFor(() => events.some((event) => changedPayload(event).task.status === 'paused'))
  assert.ok((await repository.list({ source: 'all' })).products.find((p) => p.itemId === 'retry_A'))
  const paused = await tasks.getById(id)
  assert.match(String(paused?.meta?.['pauseReason']), /飞书同步失败.*飞书未配置/)
  assert.equal((paused?.meta?.['capture'] as CaptureCheckpoint).nextPage, 2)
  fail = false
  await runtime.handleCommand(cmd(CommandTypes.CAPTURE_RESUME, { id }))
  await waitFor(() => events.some((event) => changedPayload(event).task.status === 'completed'))
  assert.equal(attempts, 2)
  assert.deepEqual(platform.searchCalls, [1])
  assert.deepEqual((await tasks.getById(id))?.result?.['feishuSync'], { createdCount: 1, skippedCount: 0 })
})

test('跨日覆盖本地商品并重启 Worker 后，恢复同步仍读取原任务关键字与完整快照', async () => {
  const repository = new MemoryProductRepository()
  const store = new MemoryTaskStore()
  const platform = new MockPlatform()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'frozen_A', priceText: '10' })]))
  const capturedAt = Date.parse('2026-10-04T23:30:00+08:00')
  let clock = capturedAt
  let fail = true
  let attempts = 0
  const events: CaptureEventEnvelope[] = []
  const deps = {
    platform, repository, now: () => clock, sleep: async () => {},
    onEvent: (event: CaptureEventEnvelope) => { events.push(event) },
    syncProducts: async (_ids: string[], _keepGoing: () => Promise<boolean>, products: readonly import('../../../../shared/types/product').Product[]) => {
      attempts += 1
      assert.equal(products.length, 1)
      assert.equal(products[0]!.captureKeyword, '原关键字')
      assert.equal(products[0]!.captureTimeMs, capturedAt)
      assert.equal(products[0]!.priceNumber, 10)
      if (fail) throw new Error('飞书暂不可用')
      return { createdCount: 1, skippedCount: 0 }
    },
  }
  const tasks = new TaskManager({ store })
  const runtime = createCaptureRuntime({ ...deps, tasks })
  const response = await runtime.handleCommand(cmd(CommandTypes.CAPTURE_CREATE, { keyword: '原关键字', pages: 1 }))
  const id = (response.result as { task: Task }).task.id
  await waitFor(() => events.some((event) => changedPayload(event).task.status === 'paused'))
  const original = (await repository.list({ source: 'all' })).products[0]!
  clock = Date.parse('2026-10-05T12:30:00+08:00')
  await repository.upsertProducts([{ ...original, captureKeyword: '新关键字', captureTimeMs: clock, desc: '新描述', priceNumber: 99 }], clock)
  fail = false
  const restarted = createCaptureRuntime({ ...deps, tasks: new TaskManager({ store }) })
  await restarted.init()
  await restarted.handleCommand(cmd(CommandTypes.CAPTURE_RESUME, { id }))
  await waitFor(() => events.some((event) => changedPayload(event).task.status === 'completed'))
  assert.equal(attempts, 2)
  assert.deepEqual(platform.searchCalls, [1])
  assert.equal((await repository.list({ source: 'all' })).products[0]!.captureKeyword, '新关键字')
})


test('采集控制命令拒绝分析任务：状态、结果、进度、元数据及副作用不变', async (t) => {
  for (const status of ['pending', 'running', 'paused'] as const) {
    for (const type of [CommandTypes.CAPTURE_PAUSE, CommandTypes.CAPTURE_RESUME, CommandTypes.CAPTURE_CANCEL]) {
      await t.test(`${status}/${type}`, async () => {
        let syncCalls = 0
        const { runtime, store, tasks, repository, platform, events } = setup({
          syncProducts: async () => { syncCalls += 1; return { createdCount: 0, skippedCount: 0 } },
        })
        // 先初始化再创建分析任务，隔离启动恢复行为，只验证控制命令。
        await runtime.init()
        const created = await tasks.create({ type: 'analysis', payload: { ruleId: 'synthetic', dataSourceType: 'feishu' }, meta: { marker: '保留断点' } })
        if (status !== 'pending') await tasks.start(created.id)
        if (status === 'paused') await tasks.pause(created.id)
        if (status !== 'pending') await tasks.updateProgress(created.id, 37)
        const before: Task = { ...(await tasks.getById(created.id))!, result: { summary: '保留结果' } }
        await store.save(before)
        events.length = 0
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const response = await runtime.handleCommand(cmd(type, { id: created.id }))
          assert.equal(response.ok, false)
          assert.equal(response.error?.code, 'INVALID_PAYLOAD')
          assert.match(response.error!.message, /任务类型不匹配.*capture.*analysis/)
        }
        assert.deepEqual(await tasks.getById(created.id), before)
        assert.deepEqual(events, [])
        assert.deepEqual(platform.searchCalls, [])
        assert.deepEqual(platform.detailCalls, [])
        assert.equal(syncCalls, 0)
        assert.equal(await repository.count(), 0)
      })
    }
  }
})
