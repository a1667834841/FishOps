/**
 * 飞书商品库分页浏览 / 单条读取运行时测试。
 *
 * 验证：
 * 1. 分页为**真实单次请求**，缺省每页 20 条（不是一次 500）；
 * 2. 关键词 / 排序由飞书 search API 服务端过滤（filter / sort），绝不本地全表过滤；
 * 3. hasMore / nextPageToken / total 真实透传（total 仅 API 真实返回时给）；
 * 4. 结果平铺含 recordId，目标表固定为已配置商品表，且**绝不泄露任何密钥**；
 * 5. 单条读取缺「商品ID」时 itemId 明确为空串（不伪造 / 不用 recordId 冒充）并报告，
 *    封面缺失时回退首张图片并报告；记录不存在回结构化错误。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, createCommand, FEISHU_PRODUCTS_DEFAULT_PAGE_SIZE } from '@fishops/shared'
import { createFeishuProductsRuntime } from '../../background/feishu-products-runtime'
import { MemoryFeishuConfigStore } from '../../data-source/feishu-config-store'
import type { FeishuConfig, HttpTransport } from '../../../../shared/data-source/feishu-types'
import type {
  FeishuProductGetResult,
  FeishuProductsPageResult,
} from '../../../../shared/types/feishu-products'

const CONFIG: FeishuConfig = {
  appId: 'cli_app_id',
  appSecret: 'feishu-app-secret-value',
  spreadsheetToken: 'sheet-token-secret-value',
  productTableId: 'tbl_product',
}

interface SearchCall {
  url: string
  method: string
  body: Record<string, unknown>
}

interface Harness {
  transport: HttpTransport
  searchCalls: SearchCall[]
  getCalls: string[]
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** 构造可注入的飞书 HTTP Mock。 */
function createHarness(options: {
  recordFields?: Record<string, unknown>
  recordNotFound?: boolean
  searchItems?: Array<{ record_id: string; fields: Record<string, unknown> }>
  hasMore?: boolean
  pageToken?: string
  total?: number
} = {}): Harness {
  const searchCalls: SearchCall[] = []
  const getCalls: string[] = []

  const transport: HttpTransport = {
    fetch: async (url, init) => {
      if (url.includes('/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'tenant-token-secret', expire: 7200 })
      }
      if (url.includes('/records/search')) {
        searchCalls.push({
          url,
          method: init?.method ?? 'GET',
          body: JSON.parse((init?.body as string) || '{}') as Record<string, unknown>,
        })
        return jsonResponse({
          code: 0,
          data: {
            items:
              options.searchItems ?? [
                { record_id: 'rec_a', fields: { 商品ID: 'A1', 商品标题: '测试手机' } },
              ],
            has_more: options.hasMore ?? false,
            ...(options.pageToken ? { page_token: options.pageToken } : {}),
            ...(options.total === undefined ? {} : { total: options.total }),
          },
        })
      }
      if (url.includes('/records/')) {
        getCalls.push(url)
        if (options.recordNotFound) return jsonResponse({ code: 1254005, msg: 'not found' })
        return jsonResponse({
          code: 0,
          data: { record: { record_id: 'rec_a', fields: options.recordFields ?? {} } },
        })
      }
      if (url.includes('/tables')) return jsonResponse({ code: 0, data: { items: [], has_more: false } })
      return jsonResponse({})
    },
  }

  return { transport, searchCalls, getCalls }
}

function setup(harness: Harness, store = new MemoryFeishuConfigStore(CONFIG)) {
  return createFeishuProductsRuntime({ feishuConfigStore: store, transport: harness.transport })
}

test('飞书商品分页：缺省单次请求每页 20 条，结果平铺含 recordId 且不泄露密钥', async () => {
  const harness = createHarness({ hasMore: true, pageToken: 'NEXT', total: 42 })
  const runtime = setup(harness)

  const res = await runtime.handleCommand(createCommand(CommandTypes.FEISHU_PRODUCTS_PAGE, {}))
  assert.equal(res.ok, true)
  const result = res.result as FeishuProductsPageResult

  // 真实单次请求：只发出一次 search 调用。
  assert.equal(harness.searchCalls.length, 1)
  const call = harness.searchCalls[0]!
  assert.equal(call.method, 'POST')
  assert.equal(call.url.includes('/tables/tbl_product/records/search'), true)
  // 官方签名：page_size 在 **URL query**，不得放 body（否则分页失效→一次返回全表）。
  const query = new URL(call.url).searchParams
  assert.equal(query.get('page_size'), String(FEISHU_PRODUCTS_DEFAULT_PAGE_SIZE))
  assert.equal(call.body['page_size'], undefined)
  assert.equal(call.body['page_token'], undefined)
  // 无关键词时不带 filter（不做任何本地过滤）。
  assert.equal(call.body['filter'], undefined)

  // 结果：平铺行含 recordId；hasMore / nextPageToken / total / targetTableId 真实透传。
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]!['recordId'], 'rec_a')
  assert.equal(result.rows[0]!['商品标题'], '测试手机')
  assert.equal(result.hasMore, true)
  assert.equal(result.nextPageToken, 'NEXT')
  assert.equal(result.total, 42)
  assert.equal(result.targetTableId, 'tbl_product')

  // 绝不泄露任何密钥 / token。
  const json = JSON.stringify(result)
  assert.equal(json.includes(CONFIG.appSecret), false)
  assert.equal(json.includes(CONFIG.spreadsheetToken), false)
  assert.equal(json.includes('tenant_access_token'), false)
  assert.equal(json.includes('tenant-token-secret'), false)
  assert.equal(json.includes('Bearer'), false)
})

test('飞书商品分页：无 total 时不伪造（不返回 total 字段）', async () => {
  const harness = createHarness()
  const runtime = setup(harness)
  const res = await runtime.handleCommand(createCommand(CommandTypes.FEISHU_PRODUCTS_PAGE, {}))
  const result = res.result as FeishuProductsPageResult
  assert.equal('total' in result, false)
  assert.equal(result.hasMore, false)
  assert.equal(result.nextPageToken, undefined)
})

test('飞书商品分页：关键词走 search API filter（服务端过滤），绝不本地全表过滤', async () => {
  const harness = createHarness()
  const runtime = setup(harness)

  const res = await runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCTS_PAGE, { keyword: '手机', pageSize: 20 }),
  )
  assert.equal(res.ok, true)
  // 仍只发一次请求（未因关键词退化为全量拉取）。
  assert.equal(harness.searchCalls.length, 1)
  const body = harness.searchCalls[0]!.body
  const filter = body['filter'] as {
    conjunction: string
    conditions: Array<{ field_name: string; operator: string; value: string[] }>
  }
  assert.equal(filter.conjunction, 'or')
  assert.equal(filter.conditions.length, 2)
  assert.equal(filter.conditions[0]!.operator, 'contains')
  assert.deepEqual(filter.conditions[0]!.value, ['手机'])
})

test('飞书商品分页：排序映射为 search API sort（服务端排序）', async () => {
  const harness = createHarness()
  const runtime = setup(harness)

  await runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCTS_PAGE, { order: 'priceAsc' }),
  )
  const sort = harness.searchCalls[0]!.body['sort'] as Array<{ field_name: string; desc: boolean }>
  assert.equal(sort.length, 1)
  assert.equal(sort[0]!.field_name, '价格')
  assert.equal(sort[0]!.desc, false)
})

test('飞书商品分页：pageToken 作为 URL query 透传（并绑定 targetTableId）', async () => {
  const harness = createHarness()
  const runtime = setup(harness)
  await runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCTS_PAGE, { pageToken: 'TOK', targetTableId: 'tbl_product' }),
  )
  const call = harness.searchCalls[0]!
  const query = new URL(call.url).searchParams
  assert.equal(query.get('page_token'), 'TOK')
  assert.equal(query.get('page_size'), String(FEISHU_PRODUCTS_DEFAULT_PAGE_SIZE))
  // page_token 不得出现在 body。
  assert.equal(call.body['page_token'], undefined)
})

test('飞书商品分页：返回条数超过 pageSize（page_size 未生效）时结构化拒绝，绝不假成功', async () => {
  // pageSize=1 但 transport 错误地返回 3 条（模拟 body 传 page_size 被忽略、一次全表）。
  const harness = createHarness({
    searchItems: [
      { record_id: 'rec_1', fields: { 商品ID: 'A1' } },
      { record_id: 'rec_2', fields: { 商品ID: 'A2' } },
      { record_id: 'rec_3', fields: { 商品ID: 'A3' } },
    ],
    hasMore: false,
  })
  const runtime = setup(harness)
  const res = await runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCTS_PAGE, { pageSize: 1 }),
  )
  assert.equal(res.ok, false)
  assert.equal(res.error?.businessCode, 'INVALID_RESPONSE')
  // 绝不返回 rows（避免 281 条被当成 1 页展示）。
  assert.equal(res.result, undefined)
})

test('飞书商品分页：无 targetTableId 的 pageToken 被 codec 拒绝，不发起跨表游标请求', async () => {
  const harness = createHarness()
  const runtime = setup(harness)
  const res = await runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCTS_PAGE, { pageToken: 'TOK' }),
  )
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  assert.equal(harness.searchCalls.length, 0)
})

test('飞书商品分页：targetTableId 与已配置商品表不一致（绑定漂移）时拒绝', async () => {
  const harness = createHarness()
  const runtime = setup(harness)
  const res = await runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCTS_PAGE, { targetTableId: 'tbl_other' }),
  )
  assert.equal(res.ok, false)
  assert.equal(res.error?.businessCode, 'PUBLISH_TARGET_TABLE_MISMATCH')
  assert.equal(harness.searchCalls.length, 0)
})

test('飞书商品分页：未配置飞书时回结构化 CONFIG_MISSING，且不发起任何请求', async () => {
  const harness = createHarness()
  const runtime = setup(harness, new MemoryFeishuConfigStore(null))
  const res = await runtime.handleCommand(createCommand(CommandTypes.FEISHU_PRODUCTS_PAGE, {}))
  assert.equal(res.ok, false)
  assert.equal(res.error?.businessCode, 'CONFIG_MISSING')
  assert.equal(harness.searchCalls.length, 0)
})

test('飞书单条读取：映射素材，缺「商品ID」明确置空并报告，封面回退首图并报告', async () => {
  const harness = createHarness({
    recordFields: {
      商品标题: { text: '别名标题' },
      商品图片: [{ url: 'https://img.example/b.jpg' }],
    },
  })
  const runtime = setup(harness)

  const res = await runtime.handleCommand(createCommand(CommandTypes.FEISHU_PRODUCT_GET, { recordId: 'rec_a' }))
  assert.equal(res.ok, true)
  const result = res.result as FeishuProductGetResult

  assert.equal(result.recordId, 'rec_a')
  assert.equal(result.targetTableId, 'tbl_product')
  // 平铺行含 recordId，可直接复用现有 DatasetRow 解析。
  assert.equal(result.row['recordId'], 'rec_a')
  assert.equal(result.row['商品标题'] !== undefined, true)
  // 缺「商品ID」→ itemId 明确为空串，绝不用 recordId 冒充。
  assert.equal(result.material.itemId, '')
  assert.equal(result.missingFields.includes('商品ID'), true)
  assert.equal(result.material.desc, '')
  assert.equal(result.missingFields.includes('商品描述'), true)
  assert.equal(result.warnings.some((warning) => warning.includes('发布草稿描述为空')), true)
  // 封面缺失 → 回退首张图片并报告。
  assert.equal(result.material.coverUrl, 'https://img.example/b.jpg')
  assert.equal(result.warnings.some((w) => w.includes('封面URL')), true)
  // 单条 GET 请求 url 使用真实 recordId，且不外泄密钥。
  assert.equal(harness.getCalls.length, 1)
  assert.equal(harness.getCalls[0]!.includes('/records/rec_a'), true)
  assert.equal(JSON.stringify(result).includes(CONFIG.appSecret), false)
})

test('飞书单条读取：字段齐全时映射价格 / 标题 / 详情链接', async () => {
  const harness = createHarness({
    recordFields: {
      '商品ID': 'A9',
      '商品标题': '完整手机',
      '价格': 1999,
      '原价': 2599,
      '想要人数': 8,
      '封面URL': { link: 'https://img.example/a.jpg' },
      '商品详情URL': { link: 'https://item.example/A9' },
      '商品描述': '九成新',
    },
  })
  const runtime = setup(harness)
  const res = await runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCT_GET, { recordId: 'rec_a' }),
  )
  const result = res.result as FeishuProductGetResult
  assert.equal(result.material.itemId, 'A9')
  assert.equal(result.material.title, '完整手机')
  assert.equal(result.material.price, 1999)
  assert.equal(result.material.originalPrice, 2599)
  assert.equal(result.material.detailUrl, 'https://item.example/A9')
  assert.equal(result.material.desc, '九成新')
  assert.deepEqual(result.missingFields, [])
})

test('飞书单条读取：旧记录缺商品描述时保持空值并报告，不用标题伪造详情', async () => {
  const harness = createHarness({
    recordFields: { 商品ID: 'A10', 商品标题: '只有标题' },
  })
  const runtime = setup(harness)
  const res = await runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCT_GET, { recordId: 'rec_legacy' }),
  )
  const result = res.result as FeishuProductGetResult
  assert.equal(result.material.desc, '')
  assert.equal(result.missingFields.includes('商品描述'), true)
  assert.equal(result.warnings.some((warning) => warning.includes('发布草稿描述为空')), true)
})

test('飞书单条读取：targetTableId 与已配置商品表不一致（绑定漂移）时拒绝', async () => {
  const harness = createHarness()
  const runtime = setup(harness)
  const res = await runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCT_GET, {
      recordId: 'rec_a',
      targetTableId: 'tbl_other',
    }),
  )
  assert.equal(res.ok, false)
  assert.equal(res.error?.businessCode, 'PUBLISH_TARGET_TABLE_MISMATCH')
  // 漂移在拉取记录之前拦截。
  assert.equal(harness.getCalls.length, 0)
})

test('飞书单条读取：记录不存在回结构化错误且不伪造素材', async () => {
  const harness = createHarness({ recordNotFound: true })
  const runtime = setup(harness)
  const res = await runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCT_GET, { recordId: 'rec_missing' }),
  )
  assert.equal(res.ok, false)
  assert.equal(res.error?.businessCode, 'FEISHU_RECORD_NOT_FOUND')
  assert.equal(res.result, undefined)
})
