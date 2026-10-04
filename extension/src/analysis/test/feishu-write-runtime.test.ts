import { syncCapturedProductsToFeishu } from '../../background/capture-feishu-sync'
import { createCaptureRuntime } from '../../background/capture-runtime'
import { MemoryTaskStore, TaskManager } from '../../../../shared/task/index'
import { MockPlatform, makeListItem, makePage } from '../../capture/test/fixtures'
/**
 * 飞书商品写入后台运行时测试。
 *
 * 验证：
 * 1. 预览只读：绝不写入 / 不创建字段，分类（重复 / 缺失 / 已存在）正确，返回 previewId；
 * 2. 字段兼容性：缺失 / 类型冲突均可行动失败，且绝不自动创建 / 修改字段；
 * 3. 执行：必须带 previewId + confirm，绑定复验（目标 / 选品 / 去重）、串行保护、一次性；
 * 4. 预览过期、目标变更、选品变更被拒绝；重新去重跳过新出现的已有记录；
 * 5. 未配置 / 去重失败的结构化错误；响应绝不泄露 secret / token。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, createCommand } from '@fishops/shared'
import { createFeishuWriteRuntime } from '../../background/feishu-write-runtime'
import { MemoryFeishuConfigStore } from '../../data-source/feishu-config-store'
import { createMemoryProductRepository } from '../../../../shared/capture/product-repository'
import { FEISHU_PRODUCT_FIELD_CONFIGS, type FeishuConfig, type HttpTransport } from '../../../../shared/data-source/feishu-types'
import { FEISHU_WRITE_MAX_ITEMS } from '../../../../shared/types/feishu-write'
import type { FeishuProductWriteExecuteResult, FeishuProductWritePreviewResult } from '../../../../shared/types/feishu-write'
import type { Product } from '../../../../shared/types/product'

const CONFIG: FeishuConfig = {
  appId: 'cli_app_id',
  appSecret: 'feishu-app-secret-value',
  spreadsheetToken: 'sheet-token-secret-value',
  productTableId: 'tbl_product',
}

interface Harness {
  transport: HttpTransport
  batchCalls: Array<Array<{ fields: Record<string, unknown> }>>
  fieldPosts: number
  /** 目标表字段（可变，用于模拟字段变化）。 */
  fields: Array<{ field_name: string; type: number }>
  /** 飞书已有记录（可变，用于模拟执行前新增去重命中）。 */
  existingItems: Array<Record<string, unknown>>
  /** 去重查询是否失败（可变，用于模拟执行阶段失败）。 */
  failExisting: boolean
  release?: () => void
}

function defaultFields(): Array<{ field_name: string; type: number }> {
  return FEISHU_PRODUCT_FIELD_CONFIGS.map((field) => ({ field_name: field.name, type: field.type }))
}

/** 构造可注入的飞书 HTTP Mock。 */
function createHarness(options: {
  fields?: Array<{ field_name: string; type: number }>
  existingItems?: Array<Record<string, unknown>>
  failExisting?: boolean
  deferBatch?: boolean
} = {}): Harness {
  const harness: Harness = {
    transport: null as unknown as HttpTransport,
    batchCalls: [],
    fieldPosts: 0,
    fields: options.fields ?? defaultFields(),
    existingItems: options.existingItems ?? [],
    failExisting: options.failExisting ?? false,
  }

  let gateResolve: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    gateResolve = resolve
  })
  harness.release = gateResolve

  harness.transport = {
    fetch: async (url, init) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'token', expire: 7200 })
      }
      if (url.includes('/batch_create')) {
        const records = (JSON.parse((init?.body as string) || '{}').records ?? []) as Array<{
          fields: Record<string, unknown>
        }>
        if (options.deferBatch) await gate
        harness.batchCalls.push(records)
        return jsonResponse({ code: 0, data: { records: records.map((_, i) => ({ record_id: `rec_${i}` })) } })
      }
      if (url.includes('/fields')) {
        if (method === 'POST') {
          harness.fieldPosts += 1
          return jsonResponse({ code: 0 })
        }
        return jsonResponse({ code: 0, data: { has_more: false, items: harness.fields } })
      }
      if (url.includes('/records')) {
        if (harness.failExisting) return jsonResponse({ code: 1254005, msg: 'boom' })
        const items = harness.existingItems.map((fields) => ({ record_id: 'r', fields }))
        return jsonResponse({ code: 0, data: { has_more: false, items } })
      }
      return jsonResponse({})
    },
  }
  return harness
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** 构造最小完整商品。 */
function makeProduct(itemId: string, wantCnt: number, priceNumber: number): Product {
  return {
    itemId,
    title: `标题-${itemId}`,
    price: `¥${priceNumber}`,
    priceNumber,
    originalPrice: '',
    originalPriceNumber: 0,
    wantCnt,
    publishTime: '',
    publishTimeMs: 0,
    captureTime: '',
    captureTimeMs: 0,
    sellerNick: '',
    sellerCity: '',
    freeShip: '',
    tags: '',
    coverUrl: '',
    detailUrl: `https://item.example/${itemId}`,
  }
}

type Repository = ReturnType<typeof createMemoryProductRepository>

async function seedRepository(): Promise<Repository> {
  const repository = createMemoryProductRepository()
  await repository.upsertProducts([makeProduct('A', 10, 100), makeProduct('B', 20, 200)], 1)
  return repository
}

function setup(harness: Harness, store: MemoryFeishuConfigStore, repository: Repository, extra: Record<string, unknown> = {}) {
  return createFeishuWriteRuntime({ feishuConfigStore: store, repository, transport: harness.transport, ...extra })
}

async function preview(runtime: ReturnType<typeof setup>, itemIds: string[]) {
  return runtime.handleCommand(createCommand(CommandTypes.FEISHU_PRODUCT_WRITE_PREVIEW, { itemIds }))
}

async function execute(runtime: ReturnType<typeof setup>, previewId: string) {
  return runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE, { previewId, confirm: true }),
  )
}

test('飞书写入: 预览只读、分类正确并返回 previewId', async () => {
  const repository = await seedRepository()
  const harness = createHarness({ existingItems: [{ 商品ID: 'A', 想要人数: 10, 价格: 100 }] })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const res = await preview(runtime, ['A', 'B', 'A', 'missing'])
  assert.equal(res.ok, true)
  const result = res.result as FeishuProductWritePreviewResult
  assert.equal(result.targetTableId, 'tbl_product')
  assert.equal(result.requestedCount, 4)
  assert.equal(result.uniqueCount, 3)
  assert.deepEqual(result.duplicateItemIds, ['A'])
  assert.deepEqual(result.missingItemIds, ['missing'])
  assert.deepEqual(result.alreadyExistsItemIds, ['A'])
  assert.deepEqual(result.toCreate.map((item) => item.itemId), ['B'])
  assert.equal(result.fieldCompatible, true)
  assert.deepEqual(result.missingFields, [])
  assert.deepEqual(result.typeConflicts, [])

  // previewId / 有效期存在且为短期。
  assert.equal(typeof result.previewId, 'string')
  assert.equal(result.previewId.length > 0, true)
  assert.equal(result.expiresAt > Date.now(), true)

  // 预览绝不写入、绝不创建字段。
  assert.equal(harness.batchCalls.length, 0)
  assert.equal(harness.fieldPosts, 0)
})

test('飞书写入: 字段缺失时预览标记不兼容', async () => {
  const repository = await seedRepository()
  const harness = createHarness({ fields: defaultFields().filter((field) => field.field_name !== '商品详情URL') })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const res = await preview(runtime, ['B'])
  assert.equal(res.ok, true)
  const result = res.result as FeishuProductWritePreviewResult
  assert.equal(result.fieldCompatible, false)
  assert.deepEqual(result.missingFields, ['商品详情URL'])
  assert.deepEqual(result.typeConflicts, [])
  assert.equal(harness.batchCalls.length, 0)
})

test('飞书写入: 旧表缺少商品描述字段时阻止整批写入并提示显式补齐', async () => {
  const repository = await seedRepository()
  const harness = createHarness({
    fields: defaultFields().filter((field) => field.field_name !== '商品描述'),
  })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const res = await preview(runtime, ['B'])
  assert.equal(res.ok, true)
  const result = res.result as FeishuProductWritePreviewResult
  assert.equal(result.fieldCompatible, false)
  assert.deepEqual(result.missingFields, ['商品描述'])
  assert.equal(harness.batchCalls.length, 0)
  assert.equal(harness.fieldPosts, 0)
})

test('飞书写入: 字段类型冲突时预览标记不兼容', async () => {
  const repository = await seedRepository()
  const harness = createHarness({
    fields: defaultFields().map((field) => (field.field_name === '价格' ? { ...field, type: 1 } : field)),
  })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const res = await preview(runtime, ['B'])
  assert.equal(res.ok, true)
  const result = res.result as FeishuProductWritePreviewResult
  assert.equal(result.fieldCompatible, false)
  assert.deepEqual(result.missingFields, [])
  assert.deepEqual(result.typeConflicts, [{ name: '价格', expectedType: 2, actualType: 1 }])
})

test('飞书写入: 执行成功、字段名正确且结果不泄露凭据', async () => {
  const repository = await seedRepository()
  const harness = createHarness()
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const previewRes = await preview(runtime, ['B'])
  const previewId = (previewRes.result as FeishuProductWritePreviewResult).previewId
  const res = await execute(runtime, previewId)

  assert.equal(res.ok, true)
  const result = res.result as FeishuProductWriteExecuteResult
  assert.equal(result.previewId, previewId)
  assert.equal(result.createdCount, 1)
  assert.deepEqual(result.createdRecordIds, ['rec_0'])
  assert.equal(harness.batchCalls.length, 1)

  const fields = harness.batchCalls[0][0].fields
  assert.deepEqual(fields['商品详情URL'], { link: 'https://item.example/B' })
  assert.equal('详情页URL' in fields, false)

  const json = JSON.stringify(res)
  assert.equal(json.includes(CONFIG.appSecret), false)
  assert.equal(json.includes(CONFIG.spreadsheetToken), false)
  assert.equal(json.includes(CONFIG.appId), false)
})

test('飞书写入: 字段不兼容时执行失败且不写入、不创建字段', async () => {
  const repository = await seedRepository()
  const harness = createHarness({ fields: defaultFields().filter((field) => field.field_name !== '商品详情URL') })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const previewRes = await preview(runtime, ['B'])
  const previewId = (previewRes.result as FeishuProductWritePreviewResult).previewId
  const res = await execute(runtime, previewId)

  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  assert.equal(res.error?.message.includes('商品详情URL'), true)
  assert.equal(res.error?.message.includes('不会自动创建或修改字段'), true)
  assert.equal(harness.batchCalls.length, 0)
  assert.equal(harness.fieldPosts, 0)
  assert.equal(JSON.stringify(res).includes(CONFIG.appSecret), false)
})

test('飞书写入: 类型冲突时执行失败并指明期望 / 实际类型', async () => {
  const repository = await seedRepository()
  const harness = createHarness({
    fields: defaultFields().map((field) => (field.field_name === '价格' ? { ...field, type: 1 } : field)),
  })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const previewRes = await preview(runtime, ['B'])
  const previewId = (previewRes.result as FeishuProductWritePreviewResult).previewId
  const res = await execute(runtime, previewId)

  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  assert.equal(res.error?.message.includes('价格'), true)
  assert.equal(res.error?.message.includes('期望 2'), true)
  assert.equal(res.error?.message.includes('实际 1'), true)
  assert.equal(harness.batchCalls.length, 0)
  assert.equal(harness.fieldPosts, 0)
})

test('飞书写入: 已存在组合键在写入时被跳过', async () => {
  const repository = await seedRepository()
  const harness = createHarness({ existingItems: [{ 商品ID: 'A', 想要人数: 10, 价格: 100 }] })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const previewRes = await preview(runtime, ['A'])
  const previewId = (previewRes.result as FeishuProductWritePreviewResult).previewId
  const res = await execute(runtime, previewId)

  assert.equal(res.ok, true)
  const result = res.result as FeishuProductWriteExecuteResult
  assert.equal(result.createdCount, 0)
  assert.deepEqual(result.alreadyExistsItemIds, ['A'])
  assert.equal(harness.batchCalls.length, 0)
})

test('飞书写入: 执行前飞书端新增相同记录时重新去重跳过（不重复写入）', async () => {
  const repository = await seedRepository()
  const harness = createHarness()
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const previewRes = await preview(runtime, ['B'])
  const previewId = (previewRes.result as FeishuProductWritePreviewResult).previewId

  // 预览后飞书端出现同组合键记录。
  harness.existingItems.push({ 商品ID: 'B', 想要人数: 20, 价格: 200 })

  const res = await execute(runtime, previewId)
  assert.equal(res.ok, true)
  const result = res.result as FeishuProductWriteExecuteResult
  assert.equal(result.createdCount, 0)
  assert.deepEqual(result.alreadyExistsItemIds, ['B'])
  assert.equal(harness.batchCalls.length, 0)
})

test('飞书写入: 预览过期后执行被拒绝', async () => {
  const repository = await seedRepository()
  const harness = createHarness()
  let currentTime = 1_000_000
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository, {
    now: () => currentTime,
    previewTtlMs: 1000,
  })

  const previewRes = await preview(runtime, ['B'])
  const previewId = (previewRes.result as FeishuProductWritePreviewResult).previewId

  currentTime += 5000
  const res = await execute(runtime, previewId)
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  assert.equal(res.error?.message.includes('过期'), true)
  assert.equal(harness.batchCalls.length, 0)
})

test('飞书写入: 目标表配置变更后执行被拒绝', async () => {
  const repository = await seedRepository()
  const harness = createHarness()
  const store = new MemoryFeishuConfigStore(CONFIG)
  const runtime = setup(harness, store, repository)

  const previewRes = await preview(runtime, ['B'])
  const previewId = (previewRes.result as FeishuProductWritePreviewResult).previewId

  await store.save({ ...CONFIG, productTableId: 'tbl_other' })
  const res = await execute(runtime, previewId)
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  assert.equal(res.error?.message.includes('目标表已变更'), true)
  assert.equal(harness.batchCalls.length, 0)
})

test('飞书写入: 选品内容变化后执行被拒绝', async () => {
  const repository = await seedRepository()
  const harness = createHarness()
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const previewRes = await preview(runtime, ['B'])
  const previewId = (previewRes.result as FeishuProductWritePreviewResult).previewId

  // 本地商品数据更新（价格变化 → 组合键变化）。
  await repository.upsertProducts([makeProduct('B', 20, 999)], 2)

  const res = await execute(runtime, previewId)
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  assert.equal(res.error?.message.includes('选品已变化'), true)
  assert.equal(harness.batchCalls.length, 0)
})

test('飞书写入: previewId 一次性（重放被拒绝）', async () => {
  const repository = await seedRepository()
  const harness = createHarness()
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const previewRes = await preview(runtime, ['B'])
  const previewId = (previewRes.result as FeishuProductWritePreviewResult).previewId

  assert.equal((await execute(runtime, previewId)).ok, true)
  const replay = await execute(runtime, previewId)
  assert.equal(replay.ok, false)
  assert.equal(replay.error?.code, 'INVALID_PAYLOAD')
  assert.equal(replay.error?.message.includes('已失效'), true)
})

test('飞书写入: 串行并发保护（进行中的写入拒绝第二次执行）', async () => {
  const repository = await seedRepository()
  const harness = createHarness({ deferBatch: true })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const id1 = ((await preview(runtime, ['B'])).result as FeishuProductWritePreviewResult).previewId
  const id2 = ((await preview(runtime, ['B'])).result as FeishuProductWritePreviewResult).previewId

  const first = execute(runtime, id1)
  // 等待首次执行进入 batch_create 并挂起。
  await new Promise((resolve) => setTimeout(resolve, 20))

  const second = await execute(runtime, id2)
  assert.equal(second.ok, false)
  assert.equal(second.error?.message.includes('正在进行'), true)

  harness.release?.()
  assert.equal((await first).ok, true)
})

test('飞书写入: 超量 itemIds 预览被拒绝（限量保护）', async () => {
  const repository = await seedRepository()
  const harness = createHarness()
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const itemIds = Array.from({ length: FEISHU_WRITE_MAX_ITEMS + 1 }, (_, i) => `id_${i}`)
  const res = await preview(runtime, itemIds)
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  assert.equal(harness.batchCalls.length, 0)
})

test('飞书写入: 执行缺少 previewId / confirm 被拒绝', async () => {
  const repository = await seedRepository()
  const harness = createHarness()
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  const missingPreviewId = await runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE, { confirm: true } as never),
  )
  assert.equal(missingPreviewId.ok, false)
  assert.equal(missingPreviewId.error?.code, 'INVALID_PAYLOAD')

  const missingConfirm = await runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE, { previewId: 'p1' } as never),
  )
  assert.equal(missingConfirm.ok, false)
  assert.equal(missingConfirm.error?.code, 'INVALID_PAYLOAD')
  assert.equal(harness.batchCalls.length, 0)
})

test('飞书写入: 未配置飞书时回结构化错误且不泄露配置', async () => {
  const repository = await seedRepository()
  const harness = createHarness()
  const runtime = setup(harness, new MemoryFeishuConfigStore(null), repository)

  const res = await preview(runtime, ['B'])
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  assert.equal(res.error?.message.includes('未配置'), true)
  assert.equal(harness.batchCalls.length, 0)
})

test('飞书写入: 严格去重查询失败时执行失败，不静默重复写入', async () => {
  const repository = await seedRepository()
  const harness = createHarness()
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)

  // 预览阶段去重成功并取得 previewId。
  const previewId = ((await preview(runtime, ['B'])).result as FeishuProductWritePreviewResult).previewId

  // 执行阶段去重查询失败。
  harness.failExisting = true
  const res = await execute(runtime, previewId)
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INTERNAL')
  assert.equal(harness.batchCalls.length, 0)
  // 固定文案：不回显底层异常文本。
  assert.equal(res.error?.message.includes('boom'), false)
})


test('采集自动同步完整链路：真实采集入库后调用飞书 batch_create', async () => {
  const repository = createMemoryProductRepository()
  const tasks = new TaskManager({ store: new MemoryTaskStore() })
  const harness = createHarness()
  const writeRuntime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)
  const platform = new MockPlatform()
  platform.pages.set(1, makePage([makeListItem({ itemId: 'captured_A' })]))
  let finish!: (status: string) => void
  const terminal = new Promise<string>((resolve) => { finish = resolve })
  const capture = createCaptureRuntime({
    platform, repository, tasks, sleep: async () => {},
    syncProducts: (ids) => syncCapturedProductsToFeishu(writeRuntime, ids),
    onEvent: (event) => {
      const status = (event.payload as { task: { status: string } }).task.status
      if (['completed', 'paused', 'failed'].includes(status)) finish(status)
    },
  })
  await capture.handleCommand(createCommand(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 1 }))
  assert.equal(await terminal, 'completed')
  assert.equal(harness.batchCalls.length, 1)
  assert.equal(harness.batchCalls[0]![0]!.fields['商品ID'], 'captured_A')
  assert.equal(harness.fieldPosts, 0)
})

test('采集同步分批不超过 200 条，并跳过飞书已有组合键', async () => {
  const repository = createMemoryProductRepository()
  const products = Array.from({ length: 201 }, (_, i) => makeProduct(`bulk_${i}`, 10, 100))
  await repository.upsertProducts(products, 1)
  const harness = createHarness({ existingItems: [{ 商品ID: 'bulk_0', 想要人数: 10, 价格: 100 }] })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)
  const result = await syncCapturedProductsToFeishu(runtime, products.map((p) => p.itemId))
  assert.deepEqual(result, { createdCount: 200, skippedCount: 1 })
  assert.deepEqual(harness.batchCalls.map((records) => records.length), [199, 1])
})

test('采集同步缺字段明确失败，空采集不发起飞书请求', async () => {
  const repository = await seedRepository()
  const harness = createHarness({ fields: [] })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)
  assert.deepEqual(await syncCapturedProductsToFeishu(runtime, []), { createdCount: 0, skippedCount: 0 })
  await assert.rejects(syncCapturedProductsToFeishu(runtime, ['A']), /字段不兼容/)
  assert.equal(harness.batchCalls.length, 0)
})


test('采集同步取消后不再发送下一批飞书写入', async () => {
  const repository = createMemoryProductRepository()
  const products = Array.from({ length: 201 }, (_, i) => makeProduct(`stop_${i}`, 10, 100))
  await repository.upsertProducts(products, 1)
  const harness = createHarness()
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG), repository)
  await assert.rejects(syncCapturedProductsToFeishu(runtime, products.map((p) => p.itemId), async () => harness.batchCalls.length === 0), /同步已中止/)
  assert.deepEqual(harness.batchCalls.map((records) => records.length), [200])
})
