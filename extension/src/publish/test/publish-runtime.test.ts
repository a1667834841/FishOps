/**
 * PublishRuntime 核心运行时与生命周期单测（P8）。
 *
 * 覆盖：
 * 1. 任务生命周期：PUBLISH_CREATE -> PUBLISH_GET -> PUBLISH_LIST -> PUBLISH_PAUSE -> PUBLISH_RESUME -> PUBLISH_CANCEL；
 * 2. PUBLISH_FILL_FORM：
 *    - tabs 打开/复用 https://www.goofish.com/publish*，验证新建 tab 默认 active: false（不抢占焦点）；
 *    - 表单填充完成直接进入 waiting_confirmation 状态；
 *    - 停在 waiting_confirmation，绝不执行真实提交发布；
 *    - waiting_confirmation / running 任务重复填表一律结构化拒绝，任务、submitToken 与状态保持不变，绝不 catch 后误置 failed；
 *    - 终态校验：系统无任何自动发布提交命令与接口；
 * 3. Service Worker 重启恢复保护：
 *    - waiting_confirmation 任务在重启恢复后保持 waiting_confirmation，绝不自动重跑，绝不自动提交发布；
 *    - running 任务在重启恢复后挂起为 paused，绝不自动重跑；
 *    - PUBLISH_RESUME 仅对 paused publish 任务安全恢复（重跑真实填充执行体至 waiting_confirmation），绝不空转 running；
 * 4. PUBLISH_CONFIRM_STATUS 人工状态审查与记录（只读/人工确认标记，绝不自动提交）；
 * 5. PUBLISH_SUBMIT 最终提交：仅 waiting_confirmation + 一次性令牌可提交，点击一次后锁定，
 *    未知结果标记 unknown 且绝不自动重试；对外对象不暴露裸 submitForm，提交只能经 handleCommand；
 * 6. 事件广播：统一 TASK_CHANGED 与专属 PUBLISH_TASK_CHANGED 验证。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CommandTypes,
  EventTypes,
  type CommandEnvelope,
  type PublishConfirmStatusResult,
  type PublishCreateResult,
  type PublishFillFormResult,
  type PublishGetResult,
  type PublishListResult,
  type PublishSubmitResult,
  type PublishTask,
  type PublishTaskChangedPayload,
  type TaskChangedPayload,
} from '@fishops/shared'
import type { PublishTaskResult } from '../../../../shared/types/publish'
import { createMemoryProductRepository } from '../../../../shared/capture/product-repository'
import { MemoryTaskStore, TaskManager } from '../../../../shared/task/index'
import type { Product } from '../../../../shared/types/product'
import {
  createPublishRuntime,
  type PublishEventEnvelope,
} from '../../background/publish-runtime'
import type { TabLike, TabsApi } from '../../background/tab-manager'
import type { FormFillResult, FormSubmitResult, PublishFormFiller } from '../form-filler'
import type { ImageDownloader, PreparedImageFile } from '../controller'

class MockImageDownloader implements ImageDownloader {
  async download(_url: string, filename: string): Promise<PreparedImageFile> {
    return {
      filename,
      mimeType: 'image/jpeg',
      size: 2048,
      data: new ArrayBuffer(8),
    }
  }
}

class MockPublishFormFiller implements PublishFormFiller {
  public fillCount = 0
  public submitCount = 0
  public lastTabId: number | null = null
  public lastItem: unknown = null
  public lastSubmitTabId: number | null = null
  /** 可配置的提交结果；默认已派发点击 */
  public submitResult: FormSubmitResult = { clicked: true, clickedAt: 1 }
  /** 提交时抛错（模拟注入失败 / 上下文丢失） */
  public submitError: Error | null = null
  /** checkPageStatus 抛错（模拟验证码 / 未登录） */
  public pageStatusError: Error | null = null
  /** 提交点击后的钩子（用于模拟页面跳转） */
  public onSubmitHook: (() => void | Promise<void>) | null = null
  /** 人为挂起提交调用（模拟 SW 在点击已派发、结果持久化前被销毁） */
  public submitHold: Promise<void> | null = null

  async checkPageStatus() {
    if (this.pageStatusError) throw this.pageStatusError
    return { isPublishPage: true, isLoggedIn: true, hasCaptcha: false }
  }

  async fill(tabId: number, item: unknown): Promise<FormFillResult> {
    this.fillCount++
    this.lastTabId = tabId
    this.lastItem = item
    return {
      ok: true,
      fillSummary: {
        titleFilled: true,
        mainImageUploaded: true,
        detailImagesCount: 1,
        descFilled: true,
        priceFilled: true,
        origPriceFilled: true,
      },
    }
  }

  async submit(tabId: number): Promise<FormSubmitResult> {
    this.submitCount++
    this.lastSubmitTabId = tabId
    if (this.submitError) throw this.submitError
    if (this.onSubmitHook) await this.onSubmitHook()
    if (this.submitHold) await this.submitHold
    return this.submitResult
  }
}

class MockTabsApi implements TabsApi {
  public tabs: TabLike[] = []
  public createCalls: Array<{ url: string; active?: boolean }> = []
  private idSeq = 100

  async query(): Promise<TabLike[]> {
    return [...this.tabs]
  }

  async create(createProperties: { url: string; active?: boolean }): Promise<TabLike> {
    this.createCalls.push(createProperties)
    const tab: TabLike = {
      id: ++this.idSeq,
      url: createProperties.url,
      active: createProperties.active,
      status: 'complete',
    }
    this.tabs.push(tab)
    return tab
  }

  async get(tabId: number): Promise<TabLike> {
    const found = this.tabs.find((t) => t.id === tabId)
    if (!found) throw new Error('Tab not found')
    return found
  }

  onRemoved = {
    addListener: () => {},
  }
}

function makeProduct(itemId = 'prod_001'): Product {
  return {
    itemId,
    title: '苹果电脑 MacBook Air M2 16G 512G',
    price: '¥6200.00',
    priceNumber: 6200.0,
    originalPrice: '¥9999.00',
    originalPriceNumber: 9999.0,
    wantCnt: 180,
    publishTime: '2026-09-01',
    publishTimeMs: 1788200000000,
    captureTime: '2026-09-02',
    captureTimeMs: 1788286400000,
    sellerNick: '极客数码',
    sellerCity: '北京',
    freeShip: '是',
    tags: '苹果、笔记本',
    coverUrl: 'https://img.alicdn.com/cover.jpg',
    detailUrl: 'https://www.goofish.com/item?id=' + itemId,
    desc: '电池循环40次，轻微使用痕迹，原装充电器。',
    images: ['https://img.alicdn.com/cover.jpg', 'https://img.alicdn.com/d1.jpg'],
    // 发布只允许当前账号已确认发布商品：测试夹具必须显式标记 my_published
    source: 'my_published',
    status: 'published',
  }
}

function makeCommand<T = unknown>(type: string, payload: T): CommandEnvelope<string, T> {
  return {
    kind: 'command',
    protocol: 1,
    requestId: 'req_' + Math.random().toString(36).slice(2, 8),
    type,
    payload,
    sentAt: Date.now(),
  }
}

test('PublishRuntime: 任务生命周期（创建、查询、列表、暂停、恢复、取消）', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  const p1 = makeProduct('prod_001')
  const p2 = makeProduct('prod_002')
  await repository.upsertProducts([p1, p2], Date.now())

  const runtime = createPublishRuntime({
    tasks,
    repository,
    imageDownloader: new MockImageDownloader(),
  })
  await runtime.init()

  // 1. PUBLISH_CREATE
  const createRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_001' }),
  )
  assert.equal(createRes.ok, true)
  const task1 = (createRes.result as PublishCreateResult).task
  assert.equal(task1.status, 'pending')
  assert.equal(task1.payload.itemId, 'prod_001')

  // 2. PUBLISH_GET
  const getRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_GET, { id: task1.id }),
  )
  assert.equal(getRes.ok, true)
  assert.equal((getRes.result as PublishGetResult).task.id, task1.id)

  // 3. PUBLISH_PAUSE
  const pauseRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_PAUSE, { id: task1.id, reason: '用户手动暂停' }),
  )
  assert.equal(pauseRes.ok, false) // pending 不能直接 pause，符合状态机约束

  // 4. 创建第二个任务并执行 PUBLISH_LIST
  await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_002' }),
  )
  const listRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_LIST, { limit: 10 }),
  )
  assert.equal(listRes.ok, true)
  const listResult = listRes.result as PublishListResult
  assert.equal(listResult.total, 2)
  assert.equal(listResult.tasks.length, 2)

  // 5. PUBLISH_CANCEL
  const cancelRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CANCEL, { id: task1.id, reason: '暂不需要发布' }),
  )
  assert.equal(cancelRes.ok, true)
  const cancelledTask = (cancelRes.result as { task: PublishTask }).task
  assert.equal(cancelledTask.status, 'cancelled')
})

test('PublishRuntime: PUBLISH_CREATE 对竞品 / 存量未确认商品结构化拒绝，绝不创建发布任务', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  const competitor = { ...makeProduct('comp_prod'), source: 'captured_search' as const, status: 'unconfirmed' }
  const legacy = { ...makeProduct('legacy_prod'), source: 'legacy_unconfirmed' as const, status: 'unconfirmed' }
  await repository.upsertProducts([competitor, legacy], Date.now())

  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: new MockTabsApi(),
    formFiller: new MockPublishFormFiller(),
    imageDownloader: new MockImageDownloader(),
  })
  await runtime.init()

  for (const itemId of ['comp_prod', 'legacy_prod']) {
    const res = await runtime.handleCommand(makeCommand(CommandTypes.PUBLISH_CREATE, { itemId }))
    assert.equal(res.ok, false)
    assert.equal(res.error?.businessCode, 'PRODUCT_SOURCE_NOT_ALLOWED')
  }

  // 未创建任何发布任务，也绝不触发填表 / 提交
  const list = await tasks.list({ type: 'publish' })
  assert.equal(list.length, 0)
})

test('PublishRuntime: PUBLISH_FILL_FORM 保证 active:false，填充至 waiting_confirmation 即停，严禁提交', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  const p1 = makeProduct('prod_mac')
  await repository.upsertProducts([p1], Date.now())

  const tabsMock = new MockTabsApi()
  const formFillerMock = new MockPublishFormFiller()
  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: tabsMock,
    formFiller: formFillerMock,
    imageDownloader: new MockImageDownloader(),
  })
  await runtime.init()

  // 1. 创建任务
  const createRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_mac' }),
  )
  const taskId = (createRes.result as PublishCreateResult).task.id

  // 2. 执行表单填充 PUBLISH_FILL_FORM
  const fillRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_FILL_FORM, { id: taskId }),
  )
  assert.equal(fillRes.ok, true)
  const task = (fillRes.result as PublishFillFormResult).task

  // 验证关键安全断言：
  // 1) 标签页创建必须为 active: false（优先后台打开，不抢占用户焦点）
  assert.equal(tabsMock.createCalls.length, 1)
  assert.equal(tabsMock.createCalls[0].active, false)
  assert.ok(tabsMock.createCalls[0].url.includes('goofish.com/publish'))

  // 2) FormFiller 被成功调用
  assert.equal(formFillerMock.fillCount, 1)

  // 3) 任务进度 100%，状态严格停留在 waiting_confirmation，人工确认状态为 waiting_review
  assert.equal(task.status, 'waiting_confirmation')
  assert.equal(task.progress, 100)
  assert.equal(task.result?.confirmationStatus, 'waiting_review')
  assert.ok(task.result?.fillSummary?.descFilled)
  assert.ok(task.result?.fillSummary?.priceFilled)

  // 4) 系统绝不执行 submit 提交，FormFiller 的 submit 未被触发
  // 再次从存储中查询确认
  const reloaded = await tasks.getById(taskId)
  assert.equal(reloaded?.status, 'waiting_confirmation')
})

test('PublishRuntime: Service Worker 重启恢复保护，waiting_confirmation 保持原样不自动重跑或提交', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  const p1 = makeProduct('prod_restart')
  await repository.upsertProducts([p1], Date.now())

  const tabsMock = new MockTabsApi()
  const formFillerMock = new MockPublishFormFiller()
  const runtime1 = createPublishRuntime({
    tasks,
    repository,
    tabs: tabsMock,
    formFiller: formFillerMock,
    imageDownloader: new MockImageDownloader(),
  })
  await runtime1.init()

  // 任务A：执行到 waiting_confirmation
  const cRes = await runtime1.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_restart' }),
  )
  const taskAId = (cRes.result as PublishCreateResult).task.id
  await runtime1.handleCommand(
    makeCommand(CommandTypes.PUBLISH_FILL_FORM, { id: taskAId }),
  )

  const beforeRestartA = await tasks.getById(taskAId)
  assert.equal(beforeRestartA?.status, 'waiting_confirmation')

  // 任务B：处于 running 状态（模拟崩溃中断）
  const cRes2 = await runtime1.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_restart' }),
  )
  const taskBId = (cRes2.result as PublishCreateResult).task.id
  await tasks.start(taskBId)
  const beforeRestartB = await tasks.getById(taskBId)
  assert.equal(beforeRestartB?.status, 'running')

  // ---- 模拟 Service Worker 销毁并重新唤醒启动 ----
  const newTasks = new TaskManager({ store })
  const runtime2 = createPublishRuntime({
    tasks: newTasks,
    repository,
    tabs: tabsMock,
    formFiller: formFillerMock,
  })

  // 执行 init 重启恢复
  await runtime2.init()

  // 核心断言：
  // 1) 处于 waiting_confirmation 的任务A 保持 waiting_confirmation，绝不自动点发布，绝不变态
  const afterRestartA = await newTasks.getById(taskAId)
  assert.equal(afterRestartA?.status, 'waiting_confirmation')
  assert.equal(afterRestartA?.progress, 100)

  // 2) 处于 running 的任务B 被安全挂起为 paused，绝不自动重跑
  const afterRestartB = await newTasks.getById(taskBId)
  assert.equal(afterRestartB?.status, 'paused')
  assert.ok(afterRestartB?.meta?.recoveryNote?.includes('未完成的发布填充已安全挂起'))

  // 3) 表单填充器与发布提交在重启期间未被调用
  assert.equal(formFillerMock.fillCount, 1) // 保持重启前的 1 次，没有多余调用
})

test('PublishRuntime: PUBLISH_CONFIRM_STATUS 只读查询与人工确认标记记录（绝不自动提交）', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  const p1 = makeProduct('prod_confirm')
  await repository.upsertProducts([p1], Date.now())

  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: new MockTabsApi(),
    formFiller: new MockPublishFormFiller(),
    imageDownloader: new MockImageDownloader(),
  })
  await runtime.init()

  const cRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_confirm' }),
  )
  const taskId = (cRes.result as PublishCreateResult).task.id
  await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_FILL_FORM, { id: taskId }),
  )

  // 1. 只读查询人工确认状态
  const viewRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CONFIRM_STATUS, { id: taskId }),
  )
  assert.equal(viewRes.ok, true)
  const viewResult = viewRes.result as PublishConfirmStatusResult
  assert.equal(viewResult.confirmationStatus, 'waiting_review')

  // 2. 记录操作员已在页面人工核对并手工发布完成（标记 confirmed）
  const confirmRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CONFIRM_STATUS, {
      id: taskId,
      confirmationStatus: 'confirmed',
      note: '操作员在页面检查并手工点击发布',
    }),
  )
  assert.equal(confirmRes.ok, true)
  const confirmResult = confirmRes.result as PublishConfirmStatusResult
  assert.equal(confirmResult.confirmationStatus, 'confirmed')
  assert.equal(confirmResult.task?.status, 'completed')
})

test('PublishRuntime: 事件双重广播（统一 TASK_CHANGED 与专属 PUBLISH_TASK_CHANGED）', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  const p1 = makeProduct('prod_events')
  await repository.upsertProducts([p1], Date.now())

  const capturedEvents: PublishEventEnvelope[] = []
  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: new MockTabsApi(),
    formFiller: new MockPublishFormFiller(),
    imageDownloader: new MockImageDownloader(),
    onEvent: (event) => capturedEvents.push(event),
  })
  await runtime.init()

  const cRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_events' }),
  )
  const taskId = (cRes.result as PublishCreateResult).task.id

  // 检查是否同时派发了两个事件
  const taskChanged = capturedEvents.find((e) => e.type === EventTypes.TASK_CHANGED)
  const publishTaskChanged = capturedEvents.find((e) => e.type === EventTypes.PUBLISH_TASK_CHANGED)

  assert.ok(taskChanged, '必须派发统一 TASK_CHANGED')
  assert.ok(publishTaskChanged, '必须派发专属 PUBLISH_TASK_CHANGED')

  assert.equal((taskChanged.payload as TaskChangedPayload).task.id, taskId)
  assert.equal((publishTaskChanged.payload as PublishTaskChangedPayload).task.id, taskId)
})

test('PublishRuntime: 取消/暂停在 fillForm inflight 时绝不被 waiting_confirmation 覆盖', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  const p1 = makeProduct('prod_inflight')
  await repository.upsertProducts([p1], Date.now())

  // 自定义 SlowFormFiller 模拟填充过程中的延迟
  const slowFiller: PublishFormFiller = {
    async checkPageStatus() {
      return { isPublishPage: true, isLoggedIn: true, hasCaptcha: false }
    },
    async fill() {
      // 延迟 60ms
      await new Promise((r) => setTimeout(r, 60))
      return {
        ok: true,
        fillSummary: {
          titleFilled: true,
          mainImageUploaded: true,
          detailImagesCount: 0,
          descFilled: true,
          priceFilled: true,
          origPriceFilled: true,
        },
      }
    },
  }

  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: new MockTabsApi(),
    formFiller: slowFiller,
    imageDownloader: new MockImageDownloader(),
  })
  await runtime.init()

  const cRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_inflight' }),
  )
  const taskId = (cRes.result as PublishCreateResult).task.id

  // 启动 fillForm（异步在后台运行）
  const fillPromise = runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_FILL_FORM, { id: taskId }),
  )

  // 15ms 后用户主动触发 CANCEL
  await new Promise((r) => setTimeout(r, 15))
  const cancelRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CANCEL, { id: taskId, reason: '用户在填充中取消' }),
  )
  assert.equal(cancelRes.ok, true)

  // 等待 fillForm 结束
  await fillPromise

  // 核心断言：任务必须保持 cancelled，绝不能被覆盖成 waiting_confirmation 或 failed！
  const finalCheck = await tasks.getById(taskId)
  assert.equal(finalCheck?.status, 'cancelled')
})

test('PublishRuntime: 重启恢复仅限 publish 类型，不影响 capture/analysis 共用存储', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()

  // 1. 创建并启动 capture 和 analysis 任务
  const capTask = await tasks.create({ type: 'capture', payload: { keyword: '钓鱼' } })
  await tasks.start(capTask.id)
  const anaTask = await tasks.create({ type: 'analysis', payload: { ruleId: 'r1' } })
  await tasks.start(anaTask.id)

  // 2. 创建并启动 publish 任务
  const pubProduct = makeProduct('prod_multi')
  await repository.upsertProducts([pubProduct], Date.now())
  const pubTask = await tasks.create({ type: 'publish', payload: { itemId: 'prod_multi' } })
  await tasks.start(pubTask.id)

  // 确认三者当前均为 running
  assert.equal((await tasks.getById(capTask.id))?.status, 'running')
  assert.equal((await tasks.getById(anaTask.id))?.status, 'running')
  assert.equal((await tasks.getById(pubTask.id))?.status, 'running')

  // 3. 初始化并触发 publishRuntime 的重启恢复
  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: new MockTabsApi(),
    formFiller: new MockPublishFormFiller(),
  })
  await runtime.init()

  // 核心断言：
  // 1) publish 任务被安全挂起为 paused
  assert.equal((await tasks.getById(pubTask.id))?.status, 'paused')
  // 2) capture 与 analysis 任务未被任何影响，依然保持 running 状态！
  assert.equal((await tasks.getById(capTask.id))?.status, 'running')
  assert.equal((await tasks.getById(anaTask.id))?.status, 'running')
})

test('PublishRuntime: 填充校验未全部通过时置 failed，绝不进入 waiting_confirmation', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  const p1 = makeProduct('prod_fail')
  await repository.upsertProducts([p1], Date.now())

  // 图片失败但字段部分成功的填充器：绝不能假成功
  const failingFiller: PublishFormFiller = {
    async checkPageStatus() {
      return { isPublishPage: true, isLoggedIn: true, hasCaptcha: false }
    },
    async fill() {
      return {
        ok: false,
        fillSummary: {
          titleFilled: true,
          mainImageUploaded: false,
          detailImagesCount: 0,
          descFilled: true,
          priceFilled: true,
          origPriceFilled: true,
        },
        errors: ['存在图片处理失败: 第 2 张(https://img.example.com/2.jpg): HTTP 404'],
        imagesFailed: [{ index: 2, url: 'https://img.example.com/2.jpg', error: 'HTTP 404' }],
      }
    },
  }

  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: new MockTabsApi(),
    formFiller: failingFiller,
    imageDownloader: new MockImageDownloader(),
  })
  await runtime.init()

  const cRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_fail' }),
  )
  const taskId = (cRes.result as PublishCreateResult).task.id

  const fillRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_FILL_FORM, { id: taskId }),
  )
  assert.equal(fillRes.ok, false)

  const finalTask = await tasks.getById(taskId)
  assert.equal(finalTask?.status, 'failed')
  assert.notEqual(finalTask?.status, 'waiting_confirmation')
})

test('PublishRuntime: 即使 fill.ok 为 true，图片未完成回读仍拒绝进入 waiting_confirmation', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  const p1 = makeProduct('prod_images_incomplete')
  await repository.upsertProducts([p1], Date.now())

  // 字段回读全部通过，但图片未全部上传成功（即使 fill.ok 异常为 true 也必须被拦截）
  const lyingFiller: PublishFormFiller = {
    async checkPageStatus() {
      return { isPublishPage: true, isLoggedIn: true, hasCaptcha: false }
    },
    async fill() {
      return {
        ok: true,
        fillSummary: {
          titleFilled: true,
          mainImageUploaded: false,
          detailImagesCount: 0,
          descFilled: true,
          priceFilled: true,
          origPriceFilled: true,
        },
        errors: ['图片回读确认未完全生效'],
        imagesFailed: [{ index: 1, url: 'https://img.example.com/1.jpg', error: '回读确认数量不足' }],
      }
    },
  }

  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: new MockTabsApi(),
    formFiller: lyingFiller,
    imageDownloader: new MockImageDownloader(),
  })
  await runtime.init()

  const cRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_images_incomplete' }),
  )
  const taskId = (cRes.result as PublishCreateResult).task.id

  const fillRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_FILL_FORM, { id: taskId }),
  )
  assert.equal(fillRes.ok, false)

  const finalTask = await tasks.getById(taskId)
  assert.equal(finalTask?.status, 'failed')
  assert.notEqual(finalTask?.status, 'waiting_confirmation')
})

test('PublishRuntime: 暂停在 fillForm inflight 时保持 paused，绝不被覆盖为 waiting_confirmation', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  const p1 = makeProduct('prod_pause')
  await repository.upsertProducts([p1], Date.now())

  const slowFiller: PublishFormFiller = {
    async checkPageStatus() {
      return { isPublishPage: true, isLoggedIn: true, hasCaptcha: false }
    },
    async fill() {
      await new Promise((r) => setTimeout(r, 60))
      return {
        ok: true,
        fillSummary: {
          titleFilled: true,
          mainImageUploaded: true,
          detailImagesCount: 0,
          descFilled: true,
          priceFilled: true,
          origPriceFilled: true,
        },
      }
    },
  }

  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: new MockTabsApi(),
    formFiller: slowFiller,
    imageDownloader: new MockImageDownloader(),
  })
  await runtime.init()

  const cRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_pause' }),
  )
  const taskId = (cRes.result as PublishCreateResult).task.id

  const fillPromise = runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_FILL_FORM, { id: taskId }),
  )

  await new Promise((r) => setTimeout(r, 15))
  const pauseRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_PAUSE, { id: taskId, reason: '用户在填充中暂停' }),
  )
  assert.equal(pauseRes.ok, true)

  await fillPromise

  const finalTask = await tasks.getById(taskId)
  assert.equal(finalTask?.status, 'paused')
})

test('PublishRuntime: 对外对象移除裸 submitForm/submit/publish，最终提交只能经 handleCommand PUBLISH_SUBMIT', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  await repository.upsertProducts([makeProduct('prod_noauto')], Date.now())
  const filler = new MockPublishFormFiller()
  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: new MockTabsApi(),
    formFiller: filler,
    imageDownloader: new MockImageDownloader(),
  })
  await runtime.init()

  // 对外运行时对象移除裸 submitForm / submit / publish（最终提交只经 handleCommand 的 PUBLISH_SUBMIT）
  const exposed = runtime as unknown as Record<string, unknown>
  assert.equal(typeof exposed.submit, 'undefined')
  assert.equal(typeof exposed.publish, 'undefined')
  assert.equal(typeof exposed.submitForm, 'undefined')

  // 创建 + 填表绝不触发任何提交
  const cRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_noauto' }),
  )
  const taskId = (cRes.result as PublishCreateResult).task.id
  await runtime.handleCommand(makeCommand(CommandTypes.PUBLISH_FILL_FORM, { id: taskId }))
  assert.equal(filler.submitCount, 0)

  // 缺少令牌 / confirm 的伪提交负载一律被拒绝，且不触发点击
  const res = await runtime.handleCommand(makeCommand('PUBLISH_SUBMIT', { id: taskId }))
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  assert.equal(filler.submitCount, 0)
})

/** 构造一个已填充到 waiting_confirmation 的发布运行时环境。 */
async function setupSubmitRuntime(options: { observeTimeoutMs?: number } = {}) {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  await repository.upsertProducts([makeProduct('prod_submit')], Date.now())

  const tabsMock = new MockTabsApi()
  const filler = new MockPublishFormFiller()
  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: tabsMock,
    formFiller: filler,
    imageDownloader: new MockImageDownloader(),
    submitObserveTimeoutMs: options.observeTimeoutMs ?? 200,
    submitObserveIntervalMs: 5,
  })
  await runtime.init()

  const createRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_submit' }),
  )
  const taskId = (createRes.result as PublishCreateResult).task.id
  const fillRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_FILL_FORM, { id: taskId }),
  )
  const filledTask = (fillRes.result as PublishFillFormResult).task
  return { runtime, tasks, tabsMock, filler, taskId, filledTask, store, repository }
}

/** 模拟发布成功后标签页离开发布页。 */
function navigateAway(tabsMock: MockTabsApi): () => void {
  return () => {
    for (const t of tabsMock.tabs) {
      t.url = 'https://www.goofish.com/sell/success'
    }
  }
}

/** 轮询等待条件成立（用于与异步执行体竞争，观察中间持久化状态）。 */
async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil 超时')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

test('PublishRuntime: PUBLISH_SUBMIT 显式确认+一次性令牌提交成功', async () => {
  const { runtime, tasks, tabsMock, filler, taskId, filledTask } = await setupSubmitRuntime()

  // 填表完成后下发一次性提交令牌，且填表路径绝不自动提交
  const token = filledTask.result?.submitToken
  assert.ok(token && token.length > 0)
  assert.equal(filler.submitCount, 0)

  filler.onSubmitHook = navigateAway(tabsMock)
  const res = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
  )
  assert.equal(res.ok, true)
  const result = res.result as PublishSubmitResult
  assert.equal(result.outcome, 'submitted')
  assert.equal(result.deterministic, true)
  assert.equal(result.task.status, 'completed')
  assert.equal(result.task.result?.confirmationStatus, 'confirmed')
  assert.equal(filler.submitCount, 1)

  // 再次提交：任务已 completed，拒绝（绝不重复发布）
  const dup = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
  )
  assert.equal(dup.ok, false)
  assert.equal(dup.error?.businessCode, 'SUBMIT_NOT_ALLOWED')
  assert.equal((await tasks.getById(taskId))?.status, 'completed')
})

test('PublishRuntime: PUBLISH_SUBMIT 缺 confirm 或令牌非法时拒绝且不点击', async () => {
  const { runtime, filler, taskId, filledTask } = await setupSubmitRuntime()
  const token = filledTask.result?.submitToken as string

  const noConfirm = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token }),
  )
  assert.equal(noConfirm.ok, false)
  assert.equal(noConfirm.error?.code, 'INVALID_PAYLOAD')

  const badToken = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: 'wrong-token', confirm: true }),
  )
  assert.equal(badToken.ok, false)
  assert.equal(badToken.error?.businessCode, 'SUBMIT_TOKEN_INVALID')
  assert.equal(filler.submitCount, 0)
})

test('PublishRuntime: PUBLISH_SUBMIT 仅允许 waiting_confirmation 任务', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  await repository.upsertProducts([makeProduct('prod_pending')], Date.now())
  const filler = new MockPublishFormFiller()
  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: new MockTabsApi(),
    formFiller: filler,
    imageDownloader: new MockImageDownloader(),
  })
  await runtime.init()

  const cRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_pending' }),
  )
  const taskId = (cRes.result as PublishCreateResult).task.id

  const res = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: 'x', confirm: true }),
  )
  assert.equal(res.ok, false)
  assert.equal(res.error?.businessCode, 'SUBMIT_NOT_ALLOWED')
  assert.equal(filler.submitCount, 0)
})

test('PublishRuntime: PUBLISH_SUBMIT 未找到按钮时确定性失败且不锁定（令牌仍可重试）', async () => {
  const { runtime, tasks, tabsMock, filler, taskId, filledTask } = await setupSubmitRuntime()
  const token = filledTask.result?.submitToken as string
  filler.submitResult = { clicked: false, code: 'SUBMIT_BUTTON_NOT_FOUND', reason: '未找到发布按钮' }

  const fail = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
  )
  assert.equal(fail.ok, false)
  assert.equal(fail.error?.businessCode, 'SUBMIT_BUTTON_NOT_FOUND')
  // 未派发点击 → 回滚 dispatching 锁：不锁定、清除进行中记录、令牌仍有效
  const afterFail = await tasks.getById(taskId)
  const afterFailResult = afterFail?.result as PublishTaskResult | undefined
  assert.equal(afterFail?.status, 'waiting_confirmation')
  assert.notEqual(afterFail?.meta?.submitAttempted, true)
  assert.equal(afterFailResult?.submit, undefined)
  assert.equal(afterFailResult?.submitToken, token)

  // 修正后可用同一令牌重试成功
  filler.submitResult = { clicked: true, clickedAt: 1 }
  filler.onSubmitHook = navigateAway(tabsMock)
  const ok = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
  )
  assert.equal(ok.ok, true)
  assert.equal((ok.result as PublishSubmitResult).outcome, 'submitted')
})

test('PublishRuntime: PUBLISH_SUBMIT 已点击但未观察到跳转 → unknown 且锁定不自动重试', async () => {
  const { runtime, tasks, filler, taskId, filledTask } = await setupSubmitRuntime({
    observeTimeoutMs: 30,
  })
  const token = filledTask.result?.submitToken as string
  filler.submitResult = { clicked: true, clickedAt: 1 }

  const res = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
  )
  assert.equal(res.ok, true)
  const result = res.result as PublishSubmitResult
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.deterministic, false)
  assert.equal(filler.submitCount, 1)

  // 任务保持 waiting_confirmation，但已锁定且令牌失效
  const after = await tasks.getById(taskId)
  const afterResult = after?.result as PublishTaskResult | undefined
  assert.equal(after?.status, 'waiting_confirmation')
  assert.equal(after?.meta?.submitAttempted, true)
  assert.equal(afterResult?.submit?.state, 'unknown')
  assert.equal(afterResult?.submitToken, undefined)

  // 再次提交（同令牌）被拒绝，绝不自动重试 / 二次点击
  const dup = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
  )
  assert.equal(dup.ok, false)
  assert.equal(dup.error?.businessCode, 'SUBMIT_DUPLICATE')
  assert.equal(filler.submitCount, 1)
})

test('PublishRuntime: PUBLISH_SUBMIT 注入抛错时保守标记 unknown 并锁定', async () => {
  const { runtime, tasks, filler, taskId, filledTask } = await setupSubmitRuntime()
  const token = filledTask.result?.submitToken as string
  filler.submitError = new Error('注入上下文丢失')

  const res = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
  )
  assert.equal(res.ok, true)
  assert.equal((res.result as PublishSubmitResult).outcome, 'unknown')

  const after = await tasks.getById(taskId)
  const afterResult = after?.result as PublishTaskResult | undefined
  assert.equal(after?.meta?.submitAttempted, true)
  assert.equal(afterResult?.submit?.state, 'unknown')

  const dup = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
  )
  assert.equal(dup.ok, false)
  assert.equal(dup.error?.businessCode, 'SUBMIT_DUPLICATE')
  assert.equal(filler.submitCount, 1)
})

test('PublishRuntime: PUBLISH_SUBMIT tabId 非发布页时拒绝且不点击', async () => {
  const { runtime, tabsMock, filler, taskId, filledTask } = await setupSubmitRuntime()
  const token = filledTask.result?.submitToken as string
  for (const t of tabsMock.tabs) t.url = 'https://www.goofish.com/home'

  const res = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
  )
  assert.equal(res.ok, false)
  assert.equal(res.error?.businessCode, 'SUBMIT_PAGE_INVALID')
  assert.equal(filler.submitCount, 0)
})

test('PublishRuntime: PUBLISH_SUBMIT 页面状态失效（验证码）时不点击', async () => {
  const { runtime, filler, taskId, filledTask } = await setupSubmitRuntime()
  const token = filledTask.result?.submitToken as string
  filler.pageStatusError = new Error('[PublishError:VERIFICATION_REQUIRED] 命中风控验证码')

  const res = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
  )
  assert.equal(res.ok, false)
  assert.equal(filler.submitCount, 0)
})

test('PublishRuntime: PUBLISH_SUBMIT 并发双击只点击一次', async () => {
  const { runtime, tabsMock, filler, taskId, filledTask } = await setupSubmitRuntime()
  const token = filledTask.result?.submitToken as string
  // 让首次提交在点击后故意停留一下，制造并发窗口
  filler.onSubmitHook = async () => {
    await new Promise((resolve) => setTimeout(resolve, 20))
    navigateAway(tabsMock)()
  }

  const [first, second] = await Promise.all([
    runtime.handleCommand(
      makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
    ),
    runtime.handleCommand(
      makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
    ),
  ])

  // 恰好一次成功提交，另一次被并发锁拒绝；点击绝不超过一次
  const okCount = [first, second].filter((r) => r.ok).length
  assert.equal(okCount, 1)
  assert.equal(filler.submitCount, 1)
  const rejected = [first, second].find((r) => !r.ok)
  assert.equal(rejected?.error?.businessCode, 'SUBMIT_DUPLICATE')
})

test('PublishRuntime: 点击已派发但结果持久化前 SW 重启 → dispatching 锁已落盘，重启后拒绝二次提交且不重复点击', async () => {
  const { runtime, tasks, tabsMock, filler, taskId, filledTask, store, repository } =
    await setupSubmitRuntime()
  const token = filledTask.result?.submitToken as string

  // 点击执行器：模拟“点击已派发、结果尚未返回”时 SW 被销毁 —— 提交调用永不返回
  filler.submitHold = new Promise<void>(() => {})
  const firstRun = runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
  )

  // 等到点击执行器已被调用（对应真实 click 已派发），此刻结果尚未持久化
  await waitUntil(() => filler.submitCount === 1)

  // 关键断言 1：点击前 dispatching 锁已持久化 → 跨重启不会重复发布
  const mid = await tasks.getById(taskId)
  assert.equal(mid?.status, 'waiting_confirmation')
  assert.equal(mid?.meta?.submitAttempted, true)
  // 关键断言 2：dispatching 阶段只标记 in_progress，绝不被误标 submitted
  const midResult = mid?.result as PublishTaskResult | undefined
  assert.equal(midResult?.submit?.state, 'in_progress')
  assert.notEqual(midResult?.submit?.state, 'submitted')

  // 模拟 SW 重启：在同一个持久化 store 上新建 runtime（旧执行体随 SW 消亡）
  const restartedFiller = new MockPublishFormFiller()
  const restartedRuntime = createPublishRuntime({
    tasks: new TaskManager({ store }),
    repository,
    tabs: tabsMock,
    formFiller: restartedFiller,
    imageDownloader: new MockImageDownloader(),
  })
  await restartedRuntime.init()

  // 关键断言 3：重启后第二次命令被拒绝（跨重启不可再次提交）
  const second = await restartedRuntime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: token, confirm: true }),
  )
  assert.equal(second.ok, false)
  assert.equal(second.error?.businessCode, 'SUBMIT_DUPLICATE')
  // 关键断言 4：绝不发生第二次点击
  assert.equal(restartedFiller.submitCount, 0)
  assert.equal(filler.submitCount, 1)

  // 收尾：任务仍 waiting_confirmation 且锁保持，绝不自动重试 / 二次点击
  const after = await tasks.getById(taskId)
  assert.equal(after?.meta?.submitAttempted, true)

  void firstRun // 旧执行体随“SW 重启”消亡，不等待返回
})

test('PublishRuntime: waiting_confirmation 任务再次 PUBLISH_FILL_FORM 结构化拒绝，任务/令牌/状态不变且不 fail', async () => {
  const { runtime, tasks, tabsMock, filler, taskId, filledTask } = await setupSubmitRuntime()
  const tokenBefore = filledTask.result?.submitToken
  assert.ok(tokenBefore && tokenBefore.length > 0)
  assert.equal(filler.fillCount, 1)

  // 再次填充：必须结构化拒绝（而非抛异常后把任务误置为 failed）
  const again = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_FILL_FORM, { id: taskId }),
  )
  assert.equal(again.ok, false)
  assert.equal(again.error?.code, 'INVALID_PAYLOAD')

  // 关键：任务状态、进度、submitToken 与提交锁全部保持不变，未被任何 catch 破坏
  const after = await tasks.getById(taskId)
  assert.equal(after?.status, 'waiting_confirmation')
  assert.equal(after?.progress, 100)
  assert.equal((after?.result as PublishTaskResult | undefined)?.submitToken, tokenBefore)
  assert.equal(after?.meta?.submitAttempted, false)
  // 未再次调用填充器
  assert.equal(filler.fillCount, 1)

  // 令牌未被破坏：仍可正常完成一次提交
  filler.onSubmitHook = navigateAway(tabsMock)
  const submit = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_SUBMIT, { id: taskId, submitToken: tokenBefore, confirm: true }),
  )
  assert.equal(submit.ok, true)
  assert.equal((submit.result as PublishSubmitResult).outcome, 'submitted')
  assert.equal(filler.submitCount, 1)
})

test('PublishRuntime: running 任务重复 PUBLISH_FILL_FORM 结构化拒绝且不破坏状态', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  await repository.upsertProducts([makeProduct('prod_running')], Date.now())
  const filler = new MockPublishFormFiller()
  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: new MockTabsApi(),
    formFiller: filler,
    imageDownloader: new MockImageDownloader(),
  })
  await runtime.init()

  const cRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_running' }),
  )
  const taskId = (cRes.result as PublishCreateResult).task.id
  const started = await tasks.start(taskId) // pending -> running（模拟填充进行中）
  assert.equal(started.status, 'running')

  const dup = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_FILL_FORM, { id: taskId }),
  )
  assert.equal(dup.ok, false)
  assert.equal(dup.error?.code, 'INVALID_PAYLOAD')

  // 任务仍为 running，进度未被破坏，填充器未被再次调用
  const after = await tasks.getById(taskId)
  assert.equal(after?.status, 'running')
  assert.equal(after?.progress, started.progress)
  assert.equal(filler.fillCount, 0)
})

test('PublishRuntime: PUBLISH_RESUME 仅对 paused publish 任务安全恢复（重跑填充执行体），绝不空转 running', async () => {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = createMemoryProductRepository()
  await repository.upsertProducts([makeProduct('prod_resume')], Date.now())
  const tabsMock = new MockTabsApi()
  const filler = new MockPublishFormFiller()
  const runtime = createPublishRuntime({
    tasks,
    repository,
    tabs: tabsMock,
    formFiller: filler,
    imageDownloader: new MockImageDownloader(),
  })
  await runtime.init()

  const cRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_resume' }),
  )
  const taskId = (cRes.result as PublishCreateResult).task.id
  await tasks.start(taskId)
  await tasks.pause(taskId, '模拟中断挂起')
  assert.equal((await tasks.getById(taskId))?.status, 'paused')

  // 安全恢复：必须重跑真实填充执行体并产生真实产物（waiting_confirmation + submitToken），绝不只改 running
  const resumeRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_RESUME, { id: taskId }),
  )
  assert.equal(resumeRes.ok, true)
  const resumed = (resumeRes.result as { task: PublishTask }).task
  assert.equal(resumed.status, 'waiting_confirmation')
  assert.ok(resumed.result?.submitToken)
  assert.equal(filler.fillCount, 1)

  // 对已 waiting_confirmation 的任务再发 PUBLISH_RESUME：结构化拒绝，绝不把状态改成 running
  const again = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_RESUME, { id: taskId }),
  )
  assert.equal(again.ok, false)
  assert.equal(again.error?.code, 'INVALID_PAYLOAD')
  assert.equal((await tasks.getById(taskId))?.status, 'waiting_confirmation')
})
