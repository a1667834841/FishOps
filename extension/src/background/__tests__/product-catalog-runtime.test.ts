/**
 * 商品目录运行时单测（全 mock，无真实网络）：
 * - feishu：复用专用分页读取并把行转为统一商品（缺描述空串、游标 + targetTableId 绑定）；
 * - my_published：经平台桥接读全 + 按需详情补齐；会话复用 / forceRefresh 重建；
 * - inflight 按 accountId + generation 隔离：账号 A in-flight 时切 B、forceRefresh 旧迟到完成不覆盖新 snapshot；
 * - 详情期间切号 → unauthorized 且清空旧集合；
 * - 详情部分失败 → 保留列表 + warnings；读取失败 → 结构化错误（不返回空列表、不透传底层 message）；
 * - 缓存不因时间过期而翻页重建。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CommandTypes, createCommand } from '@fishops/shared'
import { PlatformError } from '../../platform/errors'
import {
  createProductCatalogRuntime,
  type CatalogPlatformPort,
  type CatalogFeishuPort,
} from '../product-catalog-runtime'
import type { OnSaleCardData } from '../../../../shared/data-source/published-item-mapping'
import type {
  FeishuProductsPagePayload,
  FeishuProductsPageResult,
} from '../../../../shared/types/feishu-products'
import type { ProductCatalogQueryResult } from '../../../../shared/types/product-catalog'

function card(id: string, extra: Record<string, unknown> = {}): OnSaleCardData {
  return { id, title: `T${id}`, priceInfo: { price: '10' }, picInfo: { picUrl: `//img/${id}.jpg` }, ...extra }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makePlatform(overrides: Partial<CatalogPlatformPort> = {}): CatalogPlatformPort {
  return {
    isAvailable: () => true,
    currentUserId: async () => 'u1',
    listOnSaleItems: async () => ({ accountId: 'u1', items: [] }),
    detail: async () => ({ data: { itemDO: { desc: '详情描述', wantCnt: 9 } } }),
    ...overrides,
  }
}

function makeFeishu(overrides: Partial<CatalogFeishuPort> = {}): {
  port: CatalogFeishuPort
  calls: FeishuProductsPagePayload[]
} {
  const calls: FeishuProductsPagePayload[] = []
  const port: CatalogFeishuPort = {
    cacheIdentity: async () => 'config-1',
    page: async (payload: FeishuProductsPagePayload): Promise<FeishuProductsPageResult> => {
      calls.push(payload)
      return { rows: [], hasMore: false, targetTableId: 'tbl' }
    },
    ...overrides,
  }
  return { port, calls }
}

type Envelope = { ok: boolean; result?: unknown; error?: { code?: string; category?: string; message?: string } }

function ok(res: Envelope): ProductCatalogQueryResult {
  assert.equal(res.ok, true, `expected ok, got error: ${JSON.stringify(res.error)}`)
  return res.result as ProductCatalogQueryResult
}

test('my_published：会话内复用（不因 60s 过期重建），forceRefresh / 账号变化重建', async () => {
  let clock = 1000
  let account = 'u1'
  let reads = 0
  const runtime = createProductCatalogRuntime({
    platform: makePlatform({
      currentUserId: async () => account,
      listOnSaleItems: async () => {
        reads += 1
        return { accountId: account, items: [card(account === 'u1' ? 'a' : 'b')] }
      },
      detail: async () => ({ data: {} }),
    }),
    feishu: makeFeishu().port,
    now: () => clock,
  })

  const first = ok(await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' })))
  assert.equal(first.products[0]!.itemId, 'a')

  // 时间推进 > 60s：仍复用（不再因 TTL 翻页重建）。
  clock += 5 * 60 * 1000
  const again = ok(await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' })))
  assert.equal(again.products[0]!.itemId, 'a')
  assert.equal(reads, 1)

  ok(await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published', forceRefresh: true })))
  assert.equal(reads, 2)

  account = 'u2'
  const switched = ok(await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' })))
  assert.equal(switched.products[0]!.itemId, 'b')
  assert.equal(reads, 3)
})

test('my_published：账号 A in-flight 时切 B，A 迟到完成返回 unauthorized 且不覆盖 B 集合', async () => {
  let account = 'u1'
  const dA = deferred<{ accountId: string; items: OnSaleCardData[] }>()
  const runtime = createProductCatalogRuntime({
    platform: makePlatform({
      currentUserId: async () => account,
      listOnSaleItems: async () => (account === 'u1' ? dA.promise : { accountId: 'u2', items: [card('b')] }),
      detail: async () => ({ data: {} }),
    }),
    feishu: makeFeishu().port,
    now: () => 1000,
  })

  const aPromise = runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' }))
  await Promise.resolve()
  account = 'u2'
  const bResult = ok(await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' })))
  assert.equal(bResult.products[0]!.itemId, 'b')

  // A 迟到返回：账号已切 → unauthorized，且不得覆盖 B 的集合。
  dA.resolve({ accountId: 'u1', items: [card('a')] })
  const aEnvelope = (await aPromise) as Envelope
  assert.equal(aEnvelope.ok, false)
  assert.equal(aEnvelope.error?.category, 'unauthorized')

  const again = ok(await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' })))
  assert.equal(again.products[0]!.itemId, 'b')
})

test('my_published：forceRefresh 后的旧读取迟到完成，不覆盖新 snapshot、不清除新 inflight', async () => {
  const dOld = deferred<{ accountId: string; items: OnSaleCardData[] }>()
  const dNew = deferred<{ accountId: string; items: OnSaleCardData[] }>()
  let call = 0
  const runtime = createProductCatalogRuntime({
    platform: makePlatform({
      currentUserId: async () => 'u1',
      listOnSaleItems: async () => {
        call += 1
        return call === 1 ? dOld.promise : dNew.promise
      },
      detail: async () => ({ data: {} }),
    }),
    feishu: makeFeishu().port,
    now: () => 1000,
  })

  const oldPromise = runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' }))
  await Promise.resolve()
  const newPromise = runtime.handleCommand(
    createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published', forceRefresh: true }),
  )
  await Promise.resolve()

  // forceRefresh（新代际）先完成。
  dNew.resolve({ accountId: 'u1', items: [card('new')] })
  const newResult = ok(await newPromise)
  assert.equal(newResult.products[0]!.itemId, 'new')

  // 旧读取迟到完成：不得覆盖新 snapshot。
  dOld.resolve({ accountId: 'u1', items: [card('old')] })
  await oldPromise

  const again = ok(await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' })))
  assert.equal(again.products[0]!.itemId, 'new')
})

test('my_published：详情补齐期间切号 → unauthorized 且清空旧集合', async () => {
  let account = 'u1'
  const dDetail = deferred<{ data: unknown }>()
  const runtime = createProductCatalogRuntime({
    platform: makePlatform({
      currentUserId: async () => account,
      listOnSaleItems: async () => ({ accountId: 'u1', items: [card('a')] }),
      detail: async () => dDetail.promise,
    }),
    feishu: makeFeishu().port,
    now: () => 1000,
  })

  const pending = runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' }))
  await Promise.resolve()
  await Promise.resolve()
  account = 'u2'
  dDetail.resolve({ data: { itemDO: { desc: 'x' } } })

  const res = (await pending) as Envelope
  assert.equal(res.ok, false)
  assert.equal(res.error?.category, 'unauthorized')
})

test('my_published：详情部分失败 → 保留列表 + warnings（非致命，不透传底层 message）', async () => {
  const runtime = createProductCatalogRuntime({
    platform: makePlatform({
      listOnSaleItems: async () => ({ accountId: 'u1', items: [card('1'), card('2')] }),
      detail: async (itemId: string) => {
        if (itemId === '2') throw new Error('raw detail failure with token=secret')
        return { data: { itemDO: { desc: '补齐描述', wantCnt: 5 } } }
      },
    }),
    feishu: makeFeishu().port,
    now: () => 1000,
  })
  const result = ok(await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' })))

  assert.equal(result.products.length, 2)
  assert.equal(result.products.find((p) => p.itemId === '1')!.desc, '补齐描述')
  assert.equal(result.warnings.length, 1)
  assert.ok(result.warnings[0]!.includes('2'))
  // 警告不含底层原始 message（可能含凭证）。
  assert.ok(!result.warnings.join(' ').includes('secret'))
  assert.ok(!result.warnings.join(' ').includes('token='))
})

test('my_published：详情补齐卖家地区 / 昵称（列表缺省时写入，已有真实值不覆盖）', async () => {
  const runtime = createProductCatalogRuntime({
    platform: makePlatform({
      listOnSaleItems: async () => ({
        accountId: 'u1',
        items: [card('1'), { ...card('2'), area: '北京', userNickName: '列表昵称' }],
      }),
      // 详情接口真实字段：itemDO.city / sellerDO.city 提供地区，sellerDO.nick 提供昵称。
      detail: async () => ({
        data: { itemDO: { desc: 'd', city: '广东深圳' }, sellerDO: { nick: '详情昵称' } },
      }),
    }),
    feishu: makeFeishu().port,
    now: () => 1000,
  })
  const result = ok(await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' })))

  const p1 = result.products.find((p) => p.itemId === '1')!
  assert.equal(p1.sellerCity, '广东深圳')
  assert.equal(p1.sellerNick, '详情昵称')

  // 列表已提供真实卖家信息时不得被详情覆盖。
  const p2 = result.products.find((p) => p.itemId === '2')!
  assert.equal(p2.sellerCity, '北京')
  assert.equal(p2.sellerNick, '列表昵称')
})

test('my_published：详情会话类失败（未登录）→ 整体错误，不降级为 warning', async () => {
  const runtime = createProductCatalogRuntime({
    platform: makePlatform({
      listOnSaleItems: async () => ({ accountId: 'u1', items: [card('1')] }),
      detail: async () => {
        throw new PlatformError('unauthorized', '会话已失效')
      },
    }),
    feishu: makeFeishu().port,
    now: () => 1000,
  })
  const res = (await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' }))) as Envelope
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'PLATFORM_ERROR')
  assert.equal(res.error?.category, 'unauthorized')
})

test('my_published：详情补齐受预算约束（超条数上限 → 跳过并告警）', async () => {
  let detailCalls = 0
  const runtime = createProductCatalogRuntime({
    platform: makePlatform({
      listOnSaleItems: async () => ({
        accountId: 'u1',
        items: [card('1'), card('2'), card('3'), card('4')],
      }),
      detail: async () => {
        detailCalls += 1
        return { data: { itemDO: { desc: 'd' } } }
      },
    }),
    feishu: makeFeishu().port,
    now: () => 1000,
    maxDetailEnrich: 2,
  })
  const result = ok(await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' })))
  assert.equal(detailCalls, 2)
  assert.ok(result.warnings.some((w) => w.includes('跳过')))
})

test('my_published：平台读取失败（非平台错误）→ INTERNAL 固定文案，不透传底层 message', async () => {
  const runtime = createProductCatalogRuntime({
    platform: makePlatform({
      listOnSaleItems: async () => {
        throw new Error('official raw failure token=secret')
      },
    }),
    feishu: makeFeishu().port,
    now: () => 1000,
  })
  const res = (await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published' }))) as Envelope
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INTERNAL')
  assert.ok(!String(res.error?.message).includes('secret'))
})

test('feishu：复用专用分页读取，游标必须绑定 targetTableId，返回 targetTableId', async () => {
  const { port, calls } = makeFeishu({
    page: async (payload: FeishuProductsPagePayload): Promise<FeishuProductsPageResult> => {
      calls.push(payload)
      return {
        rows: [
          {
            recordId: 'rec1',
            商品ID: 'A1',
            商品标题: '飞书商品',
            价格: { text: '88' },
            想要人数: 3,
            卖家昵称: '闲鱼卖家',
            地区: '浙江杭州',
            包邮: '是',
            商品标签: '九成新、包邮',
            采集时间: 1_700_000_000_000,
          },
        ],
        hasMore: true,
        nextPageToken: 'NEXT',
        total: 42,
        targetTableId: 'tbl_exact',
      }
    },
  })
  const runtime = createProductCatalogRuntime({ platform: makePlatform(), feishu: port, now: () => 1000 })

  const result = ok(
    await runtime.handleCommand(
      createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, {
        source: 'feishu',
        cursor: 'TOK',
        targetTableId: 'tbl_exact',
        pageSize: 20,
        keyword: 'k',
        order: 'captureTimeDesc',
      }),
    ),
  )
  assert.equal(result.source, 'feishu')
  assert.equal(result.targetTableId, 'tbl_exact')
  assert.equal(result.nextCursor, 'NEXT')
  assert.equal(result.total, 42)
  assert.equal(result.products[0]!.itemId, 'A1')
  assert.equal(result.products[0]!.desc, '')
  // 飞书行真实字段不再丢失：卖家昵称 / 地区 / 包邮 / 标签 / 采集时间全部映射到统一商品。
  assert.equal(result.products[0]!.sellerNick, '闲鱼卖家')
  assert.equal(result.products[0]!.sellerCity, '浙江杭州')
  assert.equal(result.products[0]!.freeShip, '是')
  assert.equal(result.products[0]!.tags, '九成新、包邮')
  assert.equal(result.products[0]!.captureTimeMs, 1_700_000_000_000)
  // 复用专用分页读取：透传 cursor / targetTableId / keyword / order（captureTimeDesc 映射真实字段）。
  assert.equal(calls[0]!.pageToken, 'TOK')
  assert.equal(calls[0]!.targetTableId, 'tbl_exact')
  assert.equal(calls[0]!.keyword, 'k')
  assert.equal(calls[0]!.order, 'captureTimeDesc')
})

test('feishu：未返回 total 时为 null（绝不伪造）', async () => {
  const runtime = createProductCatalogRuntime({ platform: makePlatform(), feishu: makeFeishu().port, now: () => 1000 })
  const result = ok(await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'feishu' })))
  assert.equal(result.total, null)
})

test('feishu：相同配置与查询复用缓存，配置身份变化后重新读取', async () => {
  let identity = 'config-1'
  let reads = 0
  const { port } = makeFeishu({
    cacheIdentity: async () => identity,
    page: async () => {
      reads += 1
      return { rows: [], hasMore: false, targetTableId: 'tbl' }
    },
  })
  const runtime = createProductCatalogRuntime({ platform: makePlatform(), feishu: port })
  const query = createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'feishu', order: 'captureTimeDesc' })
  await runtime.handleCommand(query)
  await runtime.handleCommand(query)
  assert.equal(reads, 1)
  identity = 'rotated-app-token'
  await runtime.handleCommand(query)
  assert.equal(reads, 2)
})

test('feishu：强制刷新结果可复用，且目标表绑定参与缓存键', async () => {
  let reads = 0
  const { port } = makeFeishu({
    page: async (payload) => {
      reads += 1
      return { rows: [], hasMore: false, targetTableId: payload.targetTableId ?? 'tbl_' + reads }
    },
  })
  const runtime = createProductCatalogRuntime({ platform: makePlatform(), feishu: port })
  const query = (targetTableId?: string, forceRefresh = false) => runtime.handleCommand(createCommand(
    CommandTypes.PRODUCT_CATALOG_QUERY,
    { source: 'feishu', order: 'captureTimeDesc', ...(targetTableId ? { targetTableId } : {}), ...(forceRefresh ? { forceRefresh: true } : {}) },
  ))
  await query(undefined, true)
  await query()
  assert.equal(reads, 1)
  await query('tbl_A')
  await query('tbl_A')
  assert.equal(reads, 2)
  await query('tbl_B')
  assert.equal(reads, 3)
})

test('缓存刷新：强制远端读取新内容，完成期间普通查询等待刷新快照', async () => {
  let publishedId = 'before'
  let publishedReads = 0
  let feishuTitle = '飞书旧值'
  let feishuReads = 0
  const runtime = createProductCatalogRuntime({
    platform: makePlatform({
      listOnSaleItems: async () => {
        publishedReads += 1
        return { accountId: 'u1', items: [card(publishedId)] }
      },
      detail: async () => ({ data: {} }),
    }),
    feishu: makeFeishu({
      page: async () => {
        feishuReads += 1
        return { rows: [{ recordId: 'r1', 商品ID: 'F1', 商品标题: feishuTitle }], hasMore: false, targetTableId: 'tbl' }
      },
    }).port,
  })
  const run = async (source: 'feishu' | 'my_published') => ok(await runtime.handleCommand(
    createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source, order: 'captureTimeDesc' }),
  ))

  assert.equal((await run('my_published')).products[0]!.itemId, 'before')
  assert.equal((await run('feishu')).products[0]!.title, '飞书旧值')
  publishedId = 'after'
  feishuTitle = '飞书新值'
  await runtime.refreshCaches('all')
  assert.equal((await run('my_published')).products[0]!.itemId, 'after')
  assert.equal((await run('feishu')).products[0]!.title, '飞书新值')
  assert.equal(publishedReads, 2)
  assert.equal(feishuReads, 2)
})

test('缓存刷新：刷新期间新增来源会排队执行', async () => {
  let publishedReads = 0
  let feishuReads = 0
  const gate = deferred<FeishuProductsPageResult>()
  const { port } = makeFeishu({
    page: async () => {
      feishuReads += 1
      return feishuReads === 2 ? gate.promise : { rows: [], hasMore: false, targetTableId: 'tbl' }
    },
  })
  const runtime = createProductCatalogRuntime({
    platform: makePlatform({ listOnSaleItems: async () => {
      publishedReads += 1
      return { accountId: 'u1', items: [] }
    } }),
    feishu: port,
  })
  await runtime.handleCommand(createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'feishu', order: 'captureTimeDesc' }))
  const refresh = runtime.refreshCaches('feishu')
  await new Promise((resolve) => setTimeout(resolve, 0))
  const queued = runtime.refreshCaches('my_published')
  gate.resolve({ rows: [], hasMore: false, targetTableId: 'tbl' })
  await Promise.all([refresh, queued])
  assert.equal(feishuReads, 2)
  assert.equal(publishedReads, 1)
})
