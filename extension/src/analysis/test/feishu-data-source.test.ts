/**
 * 飞书多维表格数据源（FeishuDataSource）单元测试。
 *
 * 验证：
 * 1. 租户访问令牌缓存与过期刷新；
 * 2. 字段 Schema 获取与类型映射；
 * 3. 分页查询 records 与条数上限截断；
 * 4. 批量写入批次切片（<= 500 条）；
 * 5. 商品组合键去重。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FeishuDataSource } from '../../../../shared/data-source/feishu-data-source'
import { FeishuError, type HttpTransport } from '../../../../shared/data-source/feishu-types'
import type { Product } from '../../../../shared/types/product'

test('FeishuDataSource: 缺少必填凭据配置时抛出 INVALID_PARAM', () => {
  assert.throws(
    () =>
      new FeishuDataSource({
        config: { appId: '', appSecret: '', spreadsheetToken: '', productTableId: '' },
      }),
    (err: unknown) => {
      return err instanceof Error && (err as { category?: string }).category === 'INVALID_PARAM'
    },
  )
})

test('FeishuDataSource: 租户访问令牌缓存与过期刷新', async () => {
  let authCallCount = 0
  let currentTime = 1000000

  const mockTransport: HttpTransport = {
    fetch: async (url, init) => {
      if (url.includes('/tenant_access_token/internal')) {
        authCallCount += 1
        const body = JSON.parse((init?.body as string) || '{}')
        assert.equal(body.app_id, 'test_app_id')
        assert.equal(body.app_secret, 'test_app_secret')
        return new Response(
          JSON.stringify({
            code: 0,
            msg: 'ok',
            tenant_access_token: `token_v${authCallCount}`,
            expire: 7200, // 2 小时
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    },
  }

  const ds = new FeishuDataSource({
    config: {
      appId: 'test_app_id',
      appSecret: 'test_app_secret',
      spreadsheetToken: 'sheet_token_123',
      productTableId: 'tbl_product_1',
    },
    transport: mockTransport,
    now: () => currentTime,
  })

  // 第 1 次调用：请求真实获取
  const t1 = await ds.getTenantAccessToken()
  assert.equal(t1, 'token_v1')
  assert.equal(authCallCount, 1)

  // 时间推进 10 分钟（未过期）：复用缓存
  currentTime += 10 * 60 * 1000
  const t2 = await ds.getTenantAccessToken()
  assert.equal(t2, 'token_v1')
  assert.equal(authCallCount, 1)

  // 时间推进超过提前 5 分钟的过期线（7200 - 300 = 6900 秒 = 115 分钟）
  currentTime += 120 * 60 * 1000
  const t3 = await ds.getTenantAccessToken()
  assert.equal(t3, 'token_v2')
  assert.equal(authCallCount, 2)
})

test('FeishuDataSource: getSchema description 只含目标表 ID，绝不泄露 spreadsheetToken / appId', async () => {
  const config = {
    appId: 'cli_app_id_secret',
    appSecret: 'app-secret-value',
    spreadsheetToken: 'sheet-token-secret-value',
    productTableId: 'tbl_product_1',
  }
  const mockTransport: HttpTransport = {
    fetch: async (url) => {
      if (url.includes('/tenant_access_token/internal')) {
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }),
          { status: 200 },
        )
      }
      if (url.includes('/fields')) {
        return new Response(
          JSON.stringify({ code: 0, data: { items: [{ field_name: '商品ID', type: 1 }] } }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    },
  }

  const ds = new FeishuDataSource({ config, transport: mockTransport })
  const schema = await ds.getSchema()
  // 固定文案：只暴露目标表 ID，不回显任何凭据。
  assert.equal(schema.description?.includes('tbl_product_1'), true)
  assert.equal(schema.description?.includes(config.spreadsheetToken), false)
  assert.equal(schema.description?.includes(config.appId), false)
  assert.equal(schema.description?.includes('app='), false)
})

test('FeishuDataSource: searchRecordsOnce 把 page_size/page_token 放入 query，filter/sort 放入 body（官方签名）', async () => {
  let capturedUrl = ''
  let capturedBody = ''
  const mockTransport: HttpTransport = {
    fetch: async (url, init) => {
      if (url.includes('/tenant_access_token/internal')) {
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }),
          { status: 200 },
        )
      }
      capturedUrl = url
      capturedBody = (init?.body as string) ?? ''
      return new Response(JSON.stringify({ code: 0, data: { has_more: false, items: [] } }), {
        status: 200,
      })
    },
  }
  const ds = new FeishuDataSource({
    config: { appId: 'a', appSecret: 'b', spreadsheetToken: 's', productTableId: 'tbl_product_1' },
    transport: mockTransport,
  })

  await ds.searchRecordsOnce('tbl_product_1', {
    pageSize: 20,
    pageToken: 'tok_1',
    keyword: '手机',
    order: 'priceAsc',
  })

  const query = new URL(capturedUrl).searchParams
  assert.equal(query.get('page_size'), '20')
  assert.equal(query.get('page_token'), 'tok_1')
  const body = JSON.parse(capturedBody) as Record<string, unknown>
  // page_size / page_token 绝不得出现在 body（否则分页失效）。
  assert.equal(body['page_size'], undefined)
  assert.equal(body['page_token'], undefined)
  assert.ok(body['filter'])
  assert.ok(Array.isArray(body['sort']))
})

test('FeishuDataSource: order 映射为真实字段 sort（采集时间 / 想要人数）', async () => {
  const bodies: string[] = []
  const mockTransport: HttpTransport = {
    fetch: async (url, init) => {
      if (url.includes('/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }), {
          status: 200,
        })
      }
      bodies.push((init?.body as string) ?? '')
      return new Response(JSON.stringify({ code: 0, data: { has_more: false, items: [] } }), {
        status: 200,
      })
    },
  }
  const ds = new FeishuDataSource({
    config: { appId: 'a', appSecret: 'b', spreadsheetToken: 's', productTableId: 'tbl_product_1' },
    transport: mockTransport,
  })

  await ds.searchRecordsOnce('tbl_product_1', { pageSize: 20, order: 'captureTimeDesc' })
  await ds.searchRecordsOnce('tbl_product_1', { pageSize: 20, order: 'captureTimeAsc' })
  await ds.searchRecordsOnce('tbl_product_1', { pageSize: 20, order: 'wantCntDesc' })

  const sortOf = (index: number): { field_name: string; desc: boolean } =>
    (JSON.parse(bodies[index]!) as { sort: Array<{ field_name: string; desc: boolean }> }).sort[0]!
  assert.deepEqual(sortOf(0), { field_name: '采集时间', desc: true })
  assert.deepEqual(sortOf(1), { field_name: '采集时间', desc: false })
  assert.deepEqual(sortOf(2), { field_name: '想要人数', desc: true })
})

test('FeishuDataSource: searchRecordsOnce 返回条数超过 pageSize 时抛 INVALID_RESPONSE（拒绝假分页）', async () => {
  const items = Array.from({ length: 3 }, (_, i) => ({ record_id: `rec_${i}`, fields: {} }))
  const mockTransport: HttpTransport = {
    fetch: async (url) => {
      if (url.includes('/tenant_access_token/internal')) {
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify({ code: 0, data: { has_more: false, items } }), {
        status: 200,
      })
    },
  }
  const ds = new FeishuDataSource({
    config: { appId: 'a', appSecret: 'b', spreadsheetToken: 's', productTableId: 'tbl_product_1' },
    transport: mockTransport,
  })

  await assert.rejects(
    () => ds.searchRecordsOnce('tbl_product_1', { pageSize: 1 }),
    (err: unknown) => err instanceof FeishuError && err.category === 'INVALID_RESPONSE',
  )
})

test('FeishuDataSource: 分页查询 records 与条数限制', async () => {
  let requestedPageTokens: string[] = []

  const mockTransport: HttpTransport = {
    fetch: async (url) => {
      if (url.includes('/tenant_access_token/internal')) {
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: 'fake_token', expire: 7200 }),
          { status: 200 },
        )
      }
      if (url.includes('/tables/tbl_product_1/records')) {
        const u = new URL(url)
        const pt = u.searchParams.get('page_token') || 'page_1'
        requestedPageTokens.push(pt)

        if (pt === 'page_1') {
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                has_more: true,
                page_token: 'page_2',
                items: [
                  { record_id: 'rec_1', fields: { '商品ID': 'item_1', '价格': 100 } },
                  { record_id: 'rec_2', fields: { '商品ID': 'item_2', '价格': 200 } },
                ],
              },
            }),
            { status: 200 },
          )
        } else {
          return new Response(
            JSON.stringify({
              code: 0,
              data: {
                has_more: false,
                items: [
                  { record_id: 'rec_3', fields: { '商品ID': 'item_3', '价格': 300 } },
                ],
              },
            }),
            { status: 200 },
          )
        }
      }
      if (url.includes('/tables/tbl_product_1/fields')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                { field_name: '商品ID', type: 1 },
                { field_name: '价格', type: 2 },
              ],
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    },
  }

  const ds = new FeishuDataSource({
    config: {
      appId: 'app_id',
      appSecret: 'app_secret',
      spreadsheetToken: 'sheet_token',
      productTableId: 'tbl_product_1',
    },
    transport: mockTransport,
  })

  const dataset = await ds.query({ pageSize: 2, maxRecords: 10 })
  assert.equal(dataset.rows.length, 3)
  assert.equal(requestedPageTokens.length, 2)
  assert.equal(dataset.source, 'feishu')
})

test('FeishuDataSource: 批量创建记录自动分批（<= 500 条）', async () => {
  const batchSizes: number[] = []

  const mockTransport: HttpTransport = {
    fetch: async (url, init) => {
      if (url.includes('/tenant_access_token/internal')) {
        return new Response(
          JSON.stringify({ code: 0, tenant_access_token: 'fake_token', expire: 7200 }),
          { status: 200 },
        )
      }
      if (url.includes('/records/batch_create')) {
        const body = JSON.parse((init?.body as string) || '{}')
        const records = body.records as Array<{ fields: Record<string, unknown> }>
        batchSizes.push(records.length)
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              records: records.map((_, i) => ({ record_id: `rec_${i}` })),
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    },
  }

  const ds = new FeishuDataSource({
    config: {
      appId: 'app_id',
      appSecret: 'app_secret',
      spreadsheetToken: 'sheet_token',
      productTableId: 'tbl_product_1',
    },
    transport: mockTransport,
  })

  // 构造 1200 条记录
  const dummyRecords = Array.from({ length: 1200 }, (_, i) => ({
    fields: { '商品ID': `item_${i}` },
  }))

  const created = await ds.batchCreateRecords('tbl_product_1', dummyRecords)
  assert.equal(created.length, 1200)
  // 必须拆分为 500, 500, 200 三个批次
  assert.deepEqual(batchSizes, [500, 500, 200])
})

test('FeishuDataSource: 兼容代理返回 items、id 与 record_ids 的批量响应', async () => {
  const mockTransport: HttpTransport = {
    fetch: async (url, init) => {
      if (url.includes('/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }), { status: 200 })
      }
      if (url.includes('/records/batch_create')) {
        const body = JSON.parse((init?.body as string) || '{}')
        if (body.records.length === 1) {
          return new Response(JSON.stringify({ code: 0, data: { items: [{ id: 'rec_item' }] } }), { status: 200 })
        }
        return new Response(JSON.stringify({ code: 0, data: { record_ids: ['rec_a', 'rec_b'] } }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    },
  }
  const ds = new FeishuDataSource({
    config: { appId: 'app_id', appSecret: 'app_secret', spreadsheetToken: 'sheet_token', productTableId: 'tbl_product_1' },
    transport: mockTransport,
  })
  const one = await ds.batchCreateRecords('tbl_product_1', [{ fields: {} }])
  assert.deepEqual(one, [{ record_id: 'rec_item' }])
  const two = await ds.batchCreateRecords('tbl_product_1', [{ fields: {} }, { fields: {} }])
  assert.deepEqual(two, [{ record_id: 'rec_a' }, { record_id: 'rec_b' }])
})

test('FeishuDataSource: getTableFields 返回真实字段名与类型（不 fallback）', async () => {
  const mockTransport: HttpTransport = {
    fetch: async (url) => {
      if (url.includes('/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }), { status: 200 })
      }
      if (url.includes('/fields')) {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              has_more: false,
              items: [
                { field_name: '商品ID', type: 1 },
                { field_name: '价格', type: 2 },
              ],
            },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    },
  }
  const ds = new FeishuDataSource({
    config: { appId: 'a', appSecret: 'b', spreadsheetToken: 's', productTableId: 't' },
    transport: mockTransport,
  })
  assert.deepEqual(await ds.getTableFields('t'), [
    { name: '商品ID', type: 1 },
    { name: '价格', type: 2 },
  ])
})

test('FeishuDataSource: getTableFields 分页拉取全部字段', async () => {
  let fieldRequests = 0
  const mockTransport: HttpTransport = {
    fetch: async (url) => {
      if (url.includes('/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }), { status: 200 })
      }
      if (url.includes('/fields')) {
        fieldRequests += 1
        const pageToken = new URL(url).searchParams.get('page_token')
        if (!pageToken) {
          return new Response(
            JSON.stringify({
              code: 0,
              data: { has_more: true, page_token: 'p2', items: [{ field_name: '商品ID', type: 1 }] },
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            code: 0,
            data: { has_more: false, items: [{ field_name: '价格', type: 2 }] },
          }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    },
  }
  const ds = new FeishuDataSource({
    config: { appId: 'a', appSecret: 'b', spreadsheetToken: 's', productTableId: 't' },
    transport: mockTransport,
  })
  assert.deepEqual(await ds.getTableFields('t'), [
    { name: '商品ID', type: 1 },
    { name: '价格', type: 2 },
  ])
  assert.equal(fieldRequests, 2)
})

test('FeishuDataSource: getTableFields 失败时抛 FeishuError（不回退静态 Schema）', async () => {
  const mockTransport: HttpTransport = {
    fetch: async (url) => {
      if (url.includes('/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }), { status: 200 })
      }
      if (url.includes('/fields')) {
        return new Response(JSON.stringify({ code: 99991663, msg: 'table not found' }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    },
  }
  const ds = new FeishuDataSource({
    config: { appId: 'a', appSecret: 'b', spreadsheetToken: 's', productTableId: 't' },
    transport: mockTransport,
  })
  await assert.rejects(
    () => ds.getTableFields('t'),
    (err: unknown) => err instanceof FeishuError,
  )
})

test('FeishuDataSource: 严格去重查询失败抛错，容错版返回空集', async () => {
  const mockTransport: HttpTransport = {
    fetch: async (url) => {
      if (url.includes('/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }), { status: 200 })
      }
      // records 拉取统一返回业务错误。
      return new Response(JSON.stringify({ code: 1254005, msg: 'boom' }), { status: 200 })
    },
  }
  const ds = new FeishuDataSource({
    config: { appId: 'a', appSecret: 'b', spreadsheetToken: 's', productTableId: 't' },
    transport: mockTransport,
  })
  await assert.rejects(
    () => ds.getExistingItemKeysStrict('t'),
    (err: unknown) => err instanceof FeishuError,
  )
  assert.equal((await ds.getExistingItemKeys('t')).size, 0)
})

test('FeishuDataSource: 飞书空表返回 items:null 时视为零条记录', async () => {
  const mockTransport: HttpTransport = {
    fetch: async (url) => {
      if (url.includes('/tenant_access_token/internal')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't', expire: 7200 }), { status: 200 })
      }
      return new Response(JSON.stringify({ code: 0, msg: 'success', data: { items: null, has_more: false, total: 0 } }), { status: 200 })
    },
  }
  const ds = new FeishuDataSource({
    config: { appId: 'a', appSecret: 'b', spreadsheetToken: 's', productTableId: 't' },
    transport: mockTransport,
  })
  assert.deepEqual(await ds.getExistingCaptureKeysStrict('t'), new Set())
})

test('FeishuDataSource: convertProductToFeishuRecord 写入真实描述与商品详情URL', () => {
  const product = {
    itemId: 'i1',
    title: 't',
    desc: '真实商品详情',
    price: '¥1',
    priceNumber: 1,
    originalPrice: '',
    originalPriceNumber: 0,
    wantCnt: 2,
    publishTime: '',
    publishTimeMs: 0,
    captureTime: '',
    captureTimeMs: 0,
    sellerNick: '',
    sellerCity: '',
    freeShip: '',
    tags: '',
    coverUrl: 'https://img.example/1.png',
    detailUrl: 'https://item.example/1',
  } as unknown as Product
  const record = FeishuDataSource.convertProductToFeishuRecord(product)
  assert.deepEqual(record.fields['商品详情URL'], { link: product.detailUrl })
  assert.equal(record.fields['商品描述'], product.desc)
  assert.equal(record.fields['商品标题'], product.title)
  assert.equal(record.fields['详情页URL'], undefined)
})
