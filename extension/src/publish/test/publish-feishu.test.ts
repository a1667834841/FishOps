/**
 * 发布中心 · 飞书素材发布闭环测试。
 *
 * 验证：
 * 1. PUBLISH_CREATE(source:'feishu') 后台从当前已配置表真实 getRecord 映射 Product 并创建任务，
 *    payload 用 recordId/targetTableId 承载身份，冻结原素材到 meta，**绝不污染本地商品库 / 伪标 my_published**；
 * 2. 目标表绑定不可漂移：创建时 payload.targetTableId 必须等于已配置商品表，否则拒绝且不拉取记录；
 * 3. 填表阶段按冻结原素材复算，并**安全复验**目标表绑定未漂移（配置变更即拒绝）；
 * 4. override 传入后仍由后台强校验（图片协议 / 价格 / 字段长度），非法即拒绝；
 * 5. 缺字段时明确回退并报告（如缺「商品ID」→ itemId 明确为空串而非伪造）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandTypes,
  createCommand,
  type PublishCreateResult,
  type PublishFillFormResult,
  type PublishTask,
} from '@fishops/shared'
import { createPublishRuntime } from './owned-product-fixture'
import { MemoryFeishuConfigStore } from '../../data-source/feishu-config-store'
import { createMemoryProductRepository } from '../../../../shared/capture/product-repository'
import { MemoryTaskStore, TaskManager } from '../../../../shared/task/index'
import type { FeishuConfig, HttpTransport } from '../../../../shared/data-source/feishu-types'
import type { TabLike, TabsApi } from '../../background/tab-manager'
import type { FormFillResult, FormSubmitResult, PublishFormFiller } from '../form-filler'
import type { ImageDownloader, PreparedImageFile } from '../controller'

const CONFIG: FeishuConfig = {
  appId: 'cli_app_id',
  appSecret: 'feishu-app-secret-value',
  spreadsheetToken: 'sheet-token-secret-value',
  productTableId: 'tbl_product',
}

const RECORD_FIELDS: Record<string, unknown> = {
  '商品ID': 'A1',
  '商品标题': '飞书测试手机',
  '价格': 1999,
  '原价': 2599,
  '想要人数': 8,
  '封面URL': { link: 'https://img.example/a.jpg' },
  '商品详情URL': { link: 'https://item.example/A1' },
  '商品描述': '九成新',
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

interface FeishuHarness {
  transport: HttpTransport
  getCalls: string[]
}

/** 构造可注入的飞书 HTTP Mock（recordFields 为 null 表示记录不存在）。 */
function createFeishuTransport(
  recordFields: Record<string, unknown> | null = RECORD_FIELDS,
  rejectWith?: Error,
  dailyTables: Array<{ table_id: string; name: string }> = [],
): FeishuHarness {
  const getCalls: string[] = []
  const transport: HttpTransport = {
    fetch: async (url) => {
      if (rejectWith) throw rejectWith
      if (url.includes('/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant-token', expire: 7200 })
      }
      if (url.includes('/records/')) {
        getCalls.push(url)
        if (recordFields === null) return jsonResponse({ code: 1254005, msg: 'not found' })
        return jsonResponse({ code: 0, data: { record: { record_id: 'rec_1', fields: recordFields } } })
      }
      if (url.includes('/tables')) return jsonResponse({ code: 0, data: { items: dailyTables, has_more: false } })
      return jsonResponse({})
    },
  }
  return { transport, getCalls }
}

class MockImageDownloader implements ImageDownloader {
  async download(_url: string, filename: string): Promise<PreparedImageFile> {
    return { filename, mimeType: 'image/jpeg', size: 2048, data: new ArrayBuffer(8) }
  }
}

class MockPublishFormFiller implements PublishFormFiller {
  public lastItem: { title?: string } | null = null

  async checkPageStatus() {
    return { isPublishPage: true, isLoggedIn: true, hasCaptcha: false }
  }

  async fill(_tabId: number, item: unknown): Promise<FormFillResult> {
    this.lastItem = item as { title?: string }
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
  }

  async submit(): Promise<FormSubmitResult> {
    return { clicked: true, clickedAt: 1 }
  }
}

class MockTabsApi implements TabsApi {
  private idSeq = 100
  private readonly tabs: TabLike[] = []
  async query(): Promise<TabLike[]> {
    return [...this.tabs]
  }
  async create(createProperties: { url: string; active?: boolean }): Promise<TabLike> {
    const tab: TabLike = { id: ++this.idSeq, url: createProperties.url, active: createProperties.active, status: 'complete' }
    this.tabs.push(tab)
    return tab
  }
  async get(tabId: number): Promise<TabLike> {
    const found = this.tabs.find((t) => t.id === tabId)
    if (!found) throw new Error('Tab not found')
    return found
  }
  onRemoved = { addListener: () => {} }
}

function createRuntime(options: {
  store?: MemoryFeishuConfigStore
  transport?: HttpTransport
  repository?: ReturnType<typeof createMemoryProductRepository>
  formFiller?: MockPublishFormFiller
}) {
  const repository = options.repository ?? createMemoryProductRepository()
  const formFiller = options.formFiller ?? new MockPublishFormFiller()
  const runtime = createPublishRuntime({
    repository,
    tasks: new TaskManager({ store: new MemoryTaskStore() }),
    feishuConfigStore: options.store ?? new MemoryFeishuConfigStore(CONFIG),
    transport: options.transport ?? createFeishuTransport().transport,
    tabs: new MockTabsApi(),
    imageDownloader: new MockImageDownloader(),
    formFiller,
  })
  return { runtime, repository, formFiller }
}

function createFeishuCommand(payload: Record<string, unknown>) {
  return createCommand(CommandTypes.PUBLISH_CREATE, {
    source: 'feishu',
    recordId: 'rec_1',
    targetTableId: 'tbl_product',
    ...payload,
  })
}

test('飞书素材发布：创建任务真实映射素材、冻结原素材、绝不污染本地商品库', async () => {
  const harness = createFeishuTransport()
  const { runtime, repository } = createRuntime({ transport: harness.transport })
  await runtime.init()

  const res = await runtime.handleCommand(createFeishuCommand({}))
  assert.equal(res.ok, true)
  const task = (res.result as PublishCreateResult).task

  // 身份由 recordId / targetTableId 承载，不使用本地 itemId 冒充。
  assert.equal(task.payload.source, 'feishu')
  assert.equal(task.payload.recordId, 'rec_1')
  assert.equal(task.payload.targetTableId, 'tbl_product')
  assert.equal(task.payload.itemId, undefined)

  // 冻结原素材（供填表复用 / 复验）。
  const frozen = (task.meta as { feishu?: { recordId: string; targetTableId: string; material: { title: string } } }).feishu
  assert.ok(frozen)
  assert.equal(frozen!.recordId, 'rec_1')
  assert.equal(frozen!.targetTableId, 'tbl_product')
  assert.equal(frozen!.material.title, '飞书测试手机')

  // 真实 getRecord 且响应不外泄密钥。
  assert.equal(harness.getCalls.length, 1)
  assert.equal(JSON.stringify(task).includes(CONFIG.appSecret), false)

  // 绝不污染本地商品库 / 伪标 my_published。
  assert.equal(await repository.count(), 0)
  const repositoryList = await repository.list({ source: 'all' })
  assert.equal(repositoryList.total, 0)
})

test('每日表素材发布绑定行内真实来源表，填表仍复验当前多维表格归属', async () => {
  const h = createFeishuTransport(RECORD_FIELDS, undefined, [{ table_id: 'tbl_daily', name: '商品采集_2026-10-05' }])
  const { runtime } = createRuntime({ transport: h.transport })
  const created = await runtime.handleCommand(createFeishuCommand({ targetTableId: 'tbl_daily' }))
  assert.equal(created.ok, true)
  const task = (created.result as PublishCreateResult).task
  assert.equal(task.payload.targetTableId, 'tbl_daily')
  assert.ok(h.getCalls[0]!.includes('/tables/tbl_daily/'))
  const filled = await runtime.handleCommand(createCommand(CommandTypes.PUBLISH_FILL_FORM, { id: task.id }))
  assert.equal(filled.ok, true)
})

test('飞书素材发布：目标表绑定漂移（payload 与配置不一致）时拒绝且不拉取记录', async () => {
  const harness = createFeishuTransport()
  const { runtime, repository } = createRuntime({ transport: harness.transport })
  await runtime.init()

  const res = await runtime.handleCommand(createFeishuCommand({ targetTableId: 'tbl_evil' }))
  assert.equal(res.ok, false)
  assert.equal(res.error?.businessCode, 'PUBLISH_TARGET_TABLE_MISMATCH')
  // 漂移在拉取记录之前拦截。
  assert.equal(harness.getCalls.length, 0)
  assert.equal(await repository.count(), 0)
})

test('飞书素材发布：源记录不存在时回结构化 PRODUCT/记录不存在错误', async () => {
  const harness = createFeishuTransport(null)
  const { runtime } = createRuntime({ transport: harness.transport })
  await runtime.init()

  const res = await runtime.handleCommand(createFeishuCommand({}))
  assert.equal(res.ok, false)
  assert.equal(res.error?.businessCode, 'FEISHU_RECORD_NOT_FOUND')
})

test('飞书素材发布：未配置飞书时拒绝', async () => {
  const { runtime } = createRuntime({ store: new MemoryFeishuConfigStore(null) })
  await runtime.init()
  const res = await runtime.handleCommand(createFeishuCommand({}))
  assert.equal(res.ok, false)
  assert.equal(res.error?.businessCode, 'FEISHU_SOURCE_NOT_CONFIGURED')
})

test('飞书素材发布：override 传入后仍由后台强校验（非法图片协议 / 非正价拒绝）', async () => {
  const { runtime } = createRuntime({})
  await runtime.init()

  const badImage = await runtime.handleCommand(
    createFeishuCommand({ override: { images: ['ftp://img.example/a.jpg'] } }),
  )
  assert.equal(badImage.ok, false)
  assert.equal(badImage.error?.businessCode, 'INVALID_PAYLOAD')

  const badPrice = await runtime.handleCommand(createFeishuCommand({ override: { price: 0 } }))
  assert.equal(badPrice.ok, false)
  assert.equal(badPrice.error?.businessCode, 'INVALID_PAYLOAD')

  const tooLongTitle = await runtime.handleCommand(
    createFeishuCommand({ override: { title: 'x'.repeat(61) } }),
  )
  assert.equal(tooLongTitle.ok, false)
  assert.equal(tooLongTitle.error?.businessCode, 'INVALID_PAYLOAD')
})

test('飞书素材发布：override 配送/所在地白名单强校验（未知 freeShip 不默默付费、false 缺金额拒绝）', async () => {
  const { runtime } = createRuntime({})
  await runtime.init()

  // 明确不包邮但未提供邮费 → 拒绝（绝不默默当作免费/收费）
  const noFee = await runtime.handleCommand(createFeishuCommand({ override: { freeShip: false } }))
  assert.equal(noFee.ok, false)
  assert.equal(noFee.error?.businessCode, 'INVALID_PAYLOAD')

  // 明确不包邮但邮费为 0（矛盾）→ 拒绝
  const zeroFee = await runtime.handleCommand(
    createFeishuCommand({ override: { freeShip: false, postFee: 0 } }),
  )
  assert.equal(zeroFee.ok, false)
  assert.equal(zeroFee.error?.businessCode, 'INVALID_PAYLOAD')

  // 负数邮费 → 拒绝
  const negFee = await runtime.handleCommand(createFeishuCommand({ override: { postFee: -1 } }))
  assert.equal(negFee.ok, false)
  assert.equal(negFee.error?.businessCode, 'INVALID_PAYLOAD')

  // 明确包邮同时给正数邮费（矛盾）→ 拒绝
  const contradiction = await runtime.handleCommand(
    createFeishuCommand({ override: { freeShip: true, postFee: 5 } }),
  )
  assert.equal(contradiction.ok, false)
  assert.equal(contradiction.error?.businessCode, 'INVALID_PAYLOAD')

  // freeShip 非布尔 / location 非字符串 → 拒绝
  const badFree = await runtime.handleCommand(
    createFeishuCommand({ override: { freeShip: 'yes' as unknown as boolean } }),
  )
  assert.equal(badFree.ok, false)
  const badLoc = await runtime.handleCommand(
    createFeishuCommand({ override: { location: 123 as unknown as string } }),
  )
  assert.equal(badLoc.ok, false)

  // 合法：不包邮 + 正数邮费 + 所在地 → 通过
  const okPaid = await runtime.handleCommand(
    createFeishuCommand({ override: { freeShip: false, postFee: 8, location: '外滩' } }),
  )
  assert.equal(okPaid.ok, true)

  // 合法：包邮（postFee 0）→ 通过
  const okFree = await runtime.handleCommand(
    createFeishuCommand({ override: { freeShip: true, postFee: 0 } }),
  )
  assert.equal(okFree.ok, true)
})

test('飞书素材发布：底层错误含 secret/token 时不回显，返回固定安全文案', async () => {
  const leak = new Error(
    'boom app_secret=feishu-app-secret-value spreadsheet=sheet-token-secret-value tenant=tenant-token-secret',
  )
  const harness = createFeishuTransport(RECORD_FIELDS, leak)
  const { runtime } = createRuntime({ transport: harness.transport })
  await runtime.init()

  const res = await runtime.handleCommand(createFeishuCommand({}))
  assert.equal(res.ok, false)
  assert.equal(res.error?.businessCode, 'FEISHU_SOURCE_ERROR')
  // 固定安全文案，绝不透传底层 message。
  assert.equal(res.error?.message, '飞书网络请求失败：请检查网络后重试')
  const json = JSON.stringify(res)
  assert.equal(json.includes('feishu-app-secret-value'), false)
  assert.equal(json.includes('sheet-token-secret-value'), false)
  assert.equal(json.includes('tenant-token-secret'), false)
})

test('飞书素材发布：合法 override 被采纳，并在填表阶段生效（按冻结素材复算）', async () => {
  const { runtime, formFiller, repository } = createRuntime({})
  await runtime.init()

  const createRes = await runtime.handleCommand(
    createFeishuCommand({ override: { title: '自定义飞书标题' } }),
  )
  assert.equal(createRes.ok, true)
  const task = (createRes.result as PublishCreateResult).task
  assert.equal((task.payload.override as { title?: string } | undefined)?.title, '自定义飞书标题')

  const fillRes = await runtime.handleCommand(createCommand(CommandTypes.PUBLISH_FILL_FORM, { id: task.id }))
  assert.equal(fillRes.ok, true)
  const filled = (fillRes.result as PublishFillFormResult).task
  assert.equal(filled.status, 'waiting_confirmation')
  assert.equal(formFiller.lastItem?.title, '自定义飞书标题')
  // 依然不污染本地商品库。
  assert.equal(await repository.count(), 0)
})

test('飞书素材发布：填表阶段安全复验目标表绑定，配置漂移即拒绝', async () => {
  const store = new MemoryFeishuConfigStore(CONFIG)
  const { runtime } = createRuntime({ store })
  await runtime.init()

  const createRes = await runtime.handleCommand(createFeishuCommand({}))
  assert.equal(createRes.ok, true)
  const task = (createRes.result as PublishCreateResult).task

  // 创建后飞书商品表配置发生漂移。
  await store.save({ ...CONFIG, productTableId: 'tbl_other' })

  const fillRes = await runtime.handleCommand(createCommand(CommandTypes.PUBLISH_FILL_FORM, { id: task.id }))
  assert.equal(fillRes.ok, false)
  assert.equal(fillRes.error?.businessCode, 'PUBLISH_TARGET_TABLE_MISMATCH')
})

test('飞书素材发布：缺「商品ID」明确置空并报告，绝不伪造 ID', async () => {
  const harness = createFeishuTransport({
    '商品标题': '无 ID 手机',
    '封面URL': { link: 'https://img.example/a.jpg' },
  })
  const { runtime } = createRuntime({ transport: harness.transport })
  await runtime.init()

  const res = await runtime.handleCommand(createFeishuCommand({}))
  assert.equal(res.ok, true)
  const task = (res.result as PublishCreateResult).task
  const frozen = (task.meta as {
    feishu?: { material: { itemId: string }; missingFields: string[] }
  }).feishu
  assert.ok(frozen)
  // 缺「商品ID」→ itemId 明确为空串，绝不伪造。
  assert.equal(frozen!.material.itemId, '')
  assert.equal(frozen!.missingFields.includes('商品ID'), true)
})

test('飞书素材发布：任务列表 / GET 可读回，身份为 recordId（无本地 itemId）', async () => {
  const { runtime } = createRuntime({})
  await runtime.init()
  const created = (await runtime.handleCommand(createFeishuCommand({}))).result as PublishCreateResult

  const got = await runtime.handleCommand(createCommand(CommandTypes.PUBLISH_GET, { id: created.task.id }))
  assert.equal(got.ok, true)
  const task = (got.result as { task: PublishTask }).task
  assert.equal(task.payload.source, 'feishu')
  assert.equal(task.payload.recordId, 'rec_1')
})
