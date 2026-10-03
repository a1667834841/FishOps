/**
 * 发布任务历史跨扩展 reload 持久化回归（真实缺陷复现 + 修复验证）。
 *
 * 真实缺陷：扩展标准 reload 会按官方语义清空 chrome.storage.session
 * （Chrome 文档：session「disabled / reloaded / updated / 浏览器重启时清空」）。
 * 修复前发布任务历史写在 session 里，因此 reload 后 PUBLISH_LIST total=0；
 * 同时官方发布页里的已填充表单仍然存在（网页 tab 不受扩展 reload 影响），
 * 现象与真实复测完全一致。
 *
 * 本测试不依赖浏览器，用最小 chrome.storage mock 精确模拟
 * 「扩展 reload = 清空 session、保留 local」语义，覆盖：
 * 1. 根因复现：任务历史存 chrome.storage.session 时 reload 后 total=0；
 * 2. 修复验证：发布任务持久化到 chrome.storage.local 后 reload 后
 *    waiting_confirmation 仍保留，遗留 running 挂起为 paused，绝不自动重跑 / 提交；
 * 3. 隔离：发布中心启动恢复只处理 publish 类型，不触碰同存储中的 capture / analysis 任务。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CommandTypes,
  type CommandEnvelope,
  type PublishCreateResult,
  type PublishFillFormResult,
  type PublishListResult,
} from '@fishops/shared'
import { createMemoryProductRepository } from '../../../../shared/capture/product-repository'
import {
  AdapterTaskStore,
  ChromeStorageLocalAdapter,
  ChromeStorageSessionAdapter,
  TaskManager,
} from '../../../../shared/task/index'
import type { Product } from '../../../../shared/types/product'
import { createPublishRuntime } from '../../background/publish-runtime'
import type { FormFillResult, PublishFormFiller } from '../form-filler'
import type { ImageDownloader, PreparedImageFile } from '../controller'

/**
 * 最小 chrome.storage 区域 mock：与真实 StorageArea 的异步读写语义一致，
 * 可通过 clear() 模拟「扩展 reload 清空 session」。
 */
function createMockStorageArea() {
  const map = new Map<string, unknown>()
  const area = {
    async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
      const result: Record<string, unknown> = {}
      if (keys === null || keys === undefined) {
        for (const [k, v] of map.entries()) result[k] = v
        return result
      }
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
      for (const k of names) {
        if (map.has(k)) result[k] = map.get(k)
      }
      return result
    },
    async set(items: Record<string, unknown>): Promise<void> {
      for (const [k, v] of Object.entries(items)) map.set(k, v)
    },
    async remove(keys: string | string[]): Promise<void> {
      const names = typeof keys === 'string' ? [keys] : keys
      for (const k of names) map.delete(k)
    },
    async clear(): Promise<void> {
      map.clear()
    },
  }
  return { map, area }
}

class MockImageDownloader implements ImageDownloader {
  async download(_url: string, filename: string): Promise<PreparedImageFile> {
    return { filename, mimeType: 'image/jpeg', size: 2048, data: new ArrayBuffer(8) }
  }
}

/** 记录 fill 调用次数，用于断言 reload 后绝不自动重跑。 */
class CountingFormFiller implements PublishFormFiller {
  public fillCount = 0

  async checkPageStatus() {
    return { isPublishPage: true, isLoggedIn: true, hasCaptcha: false }
  }

  async fill(): Promise<FormFillResult> {
    this.fillCount++
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

  async submit(): Promise<never> {
    throw new Error('SUBMIT_DISABLED: 严禁自动点击发布提交！')
  }
}

function makeProduct(itemId: string): Product {
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

/** 走真实 fillForm 路径，把任务推进到 waiting_confirmation。 */
async function createWaitingConfirmationTask(
  runtime: ReturnType<typeof createPublishRuntime>,
  itemId: string,
): Promise<string> {
  const createRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId }),
  )
  assert.equal(createRes.ok, true)
  const taskId = (createRes.result as PublishCreateResult).task.id

  const fillRes = await runtime.handleCommand(
    makeCommand(CommandTypes.PUBLISH_FILL_FORM, { id: taskId }),
  )
  assert.equal(fillRes.ok, true)
  assert.equal((fillRes.result as PublishFillFormResult).task.status, 'waiting_confirmation')
  return taskId
}

test('根因复现：任务历史若存 chrome.storage.session，扩展 reload 后 PUBLISH_LIST total=0', async () => {
  const session = createMockStorageArea()
  const repository = createMemoryProductRepository()
  await repository.upsertProducts([makeProduct('prod_session')], Date.now())

  const tasks1 = new TaskManager({
    store: new AdapterTaskStore(new ChromeStorageSessionAdapter(session.area), 'fishops'),
  })
  const runtime1 = createPublishRuntime({
    tasks: tasks1,
    repository,
    formFiller: new CountingFormFiller(),
    imageDownloader: new MockImageDownloader(),
  })
  await runtime1.init()
  await createWaitingConfirmationTask(runtime1, 'prod_session')

  // 确认 reload 前任务存在。
  const before = await runtime1.handleCommand(makeCommand(CommandTypes.PUBLISH_LIST, {}))
  assert.equal((before.result as PublishListResult).total, 1)

  // ---- 模拟扩展标准 reload：官方语义清空 session ----
  session.map.clear()

  const tasks2 = new TaskManager({
    store: new AdapterTaskStore(new ChromeStorageSessionAdapter(session.area), 'fishops'),
  })
  const runtime2 = createPublishRuntime({
    tasks: tasks2,
    repository,
    formFiller: new CountingFormFiller(),
    imageDownloader: new MockImageDownloader(),
  })
  await runtime2.init()

  const after = await runtime2.handleCommand(makeCommand(CommandTypes.PUBLISH_LIST, {}))
  // 复现真实缺陷现象：total=0，任务历史随 session 一起被清空。
  assert.equal((after.result as PublishListResult).total, 0)
})

test('修复验证：发布任务持久化到 chrome.storage.local，reload 后 waiting_confirmation 仍保留且不自动重跑/提交', async () => {
  const session = createMockStorageArea()
  const local = createMockStorageArea()
  const repository = createMemoryProductRepository()
  await repository.upsertProducts([makeProduct('prod_local')], Date.now())

  const filler = new CountingFormFiller()
  const makeLocalManager = () =>
    new TaskManager({
      store: new AdapterTaskStore(new ChromeStorageLocalAdapter(local.area), 'fishops.publish'),
    })

  const tasks1 = makeLocalManager()
  const runtime1 = createPublishRuntime({
    tasks: tasks1,
    repository,
    formFiller: filler,
    imageDownloader: new MockImageDownloader(),
  })
  await runtime1.init()

  // 任务A：执行到 waiting_confirmation（模拟上一次发布任务已到等待确认）。
  const taskAId = await createWaitingConfirmationTask(runtime1, 'prod_local')
  assert.equal(filler.fillCount, 1)

  // 任务B：处于 running（模拟崩溃中断的发布填充）。
  const createB = await runtime1.handleCommand(
    makeCommand(CommandTypes.PUBLISH_CREATE, { itemId: 'prod_local' }),
  )
  const taskBId = (createB.result as PublishCreateResult).task.id
  await tasks1.start(taskBId)

  // ---- 模拟扩展标准 reload：session 被清空，local 保留 ----
  session.map.clear()

  const tasks2 = makeLocalManager()
  const runtime2 = createPublishRuntime({
    tasks: tasks2,
    repository,
    formFiller: filler,
    imageDownloader: new MockImageDownloader(),
  })
  await runtime2.init()

  const listRes = await runtime2.handleCommand(makeCommand(CommandTypes.PUBLISH_LIST, {}))
  const list = listRes.result as PublishListResult
  // 1) 任务历史跨 reload 保留。
  assert.equal(list.total, 2)

  const taskA = list.tasks.find((t) => t.id === taskAId)
  const taskB = list.tasks.find((t) => t.id === taskBId)
  // 2) waiting_confirmation 保持原样，进度与人工确认状态未变。
  assert.equal(taskA?.status, 'waiting_confirmation')
  assert.equal(taskA?.progress, 100)
  assert.equal(taskA?.result?.confirmationStatus, 'waiting_review')
  // 3) 遗留 running 安全挂起为 paused，绝不自动续跑。
  assert.equal(taskB?.status, 'paused')
  assert.ok(taskB?.meta?.recoveryNote?.includes('未完成的发布填充已安全挂起'))
  // 4) reload 恢复期间表单填充器未被再次调用，无自动重跑 / 提交。
  assert.equal(filler.fillCount, 1)
})

test('隔离：持久化到 local 的发布中心启动恢复只处理 publish，不触碰 capture/analysis 任务', async () => {
  const local = createMockStorageArea()
  const repository = createMemoryProductRepository()

  const tasks = new TaskManager({
    store: new AdapterTaskStore(new ChromeStorageLocalAdapter(local.area), 'fishops.publish'),
  })

  // 同一存储中混入 capture / analysis / publish 三类 running 任务。
  const cap = await tasks.create({ type: 'capture', payload: { keyword: '显卡' } as any })
  await tasks.start(cap.id)
  const ana = await tasks.create({ type: 'analysis', payload: { ruleId: 'r1', dataSourceType: 'local' } as any })
  await tasks.start(ana.id)
  const pub = await tasks.create({ type: 'publish', payload: { itemId: 'prod_iso' } as any })
  await tasks.start(pub.id)

  const runtime = createPublishRuntime({
    tasks,
    repository,
    formFiller: new CountingFormFiller(),
    imageDownloader: new MockImageDownloader(),
  })
  await runtime.init()

  // publish 被挂起，capture / analysis 完全不受影响。
  assert.equal((await tasks.getById(pub.id))?.status, 'paused')
  assert.equal((await tasks.getById(cap.id))?.status, 'running')
  assert.equal((await tasks.getById(ana.id))?.status, 'running')
})
