/**
 * ProductsController 单元测试：
 * 验证商品库双 Tab 设计与统一 PRODUCT_CATALOG_QUERY 获取两源：
 * 1. 默认 Tab 查询飞书缓存，并并行预热两源首页；
 * 2. 游标栈（Cursor Stack）：下一页使用上一页的 nextCursor，上一页回退到此前游标，不能前端缓存全 500 条；
 * 3. 筛选关键词、排序规则、页大小变动时，严格重置游标栈并回到第一页且 forceRefresh=false；
 * 4. 真实 total：后端未返回 total 时不假造总页数（为 undefined），后端返回真实 total 时如实透出；
 * 5. 快速切换 Tab / 迟到请求防竞态；切 Tab 清空 keyword 与 page，并复用后台缓存；
 * 6. 第二 Tab「自己发布的商品库」调用 PRODUCT_CATALOG_QUERY { source: 'my_published', page, pageSize }；
 * 7. 目标表漂移 Target Mismatch 保护与清空重置；
 * 8. warnings 正常存入 state 供 UI 呈现非致命详情告警。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, EventTypes, type EventPayloadMap, type EventType } from '@fishops/shared'
import type { CatalogProduct } from '../../contracts'
import type { BridgeApi } from '../../shared/bridge-api'
import { ProductsController } from '../products-controller'

class MockBridgeApi implements BridgeApi {
  public calls: Array<{ type: string; payload: unknown }> = []
  private responders = new Map<string, (payload: unknown) => unknown>()
  private listeners = new Map<string, Set<(payload: unknown) => void>>()

  respond(type: string, handler: (payload: unknown) => unknown): void {
    this.responders.set(type, handler)
  }

  async call(type: string, payload: unknown): Promise<any> {
    this.calls.push({ type, payload })
    const handler = this.responders.get(type)
    if (handler) return handler(payload)
    return { source: 'feishu', products: [], hasMore: false, page: 0, pageSize: 20, warnings: [], fetchedAt: Date.now() }
  }

  on<T extends EventType>(event: T, listener: (payload: EventPayloadMap[T]) => void): () => void {
    const listeners = this.listeners.get(event) ?? new Set<(payload: unknown) => void>()
    listeners.add(listener as (payload: unknown) => void)
    this.listeners.set(event, listeners)
    return () => listeners.delete(listener as (payload: unknown) => void)
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }

  resubscribe(): void {}
  dispose(): void {}
}

function makeCatalogProduct(
  itemId: string,
  source: 'feishu' | 'my_published' = 'feishu',
  overrides: Partial<CatalogProduct> = {},
): CatalogProduct {
  return {
    source,
    itemId,
    recordId: source === 'feishu' ? `rec_${itemId}` : undefined,
    title: `测试商品 ${itemId}`,
    price: '¥99.00',
    priceNumber: 99,
    originalPrice: '¥199.00',
    originalPriceNumber: 199,
    wantCnt: 10,
    coverUrl: 'https://img.alicdn.com/cover.jpg',
    detailUrl: `https://www.goofish.com/item?id=${itemId}`,
    desc: '测试描述',
    images: ['https://img.alicdn.com/cover.jpg'],
    sellerNick: 'my_store',
    sellerCity: '杭州',
    freeShip: '是',
    tags: '数码',
    captureTimeMs: 1788200000000,
    ...overrides,
  }
}

test('ProductsController: 同商品多条采集记录完整保留关键字和来源表，搜索回到首页', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, () => ({ source: 'feishu', products: [
    makeCatalogProduct('same', 'feishu', { recordId: 'rec_new', targetTableId: 'tbl_today', captureKeyword: '手机' }),
    makeCatalogProduct('same', 'feishu', { recordId: 'rec_old', targetTableId: 'tbl_yesterday', captureKeyword: '相机' }),
  ], total: 2, hasMore: false, targetTableId: 'daily:2026-10-05:tbl_today,tbl_yesterday', warnings: [] }))
  const controller = new ProductsController({ api })
  await controller.search('手机')
  const state = controller.getState()
  assert.equal(state.result.items.length, 2)
  assert.deepEqual(state.result.items.map((item) => item.captureKeyword), ['手机', '相机'])
  assert.deepEqual(state.result.items.map((item) => item.targetTableId), ['tbl_today', 'tbl_yesterday'])
  assert.equal(state.query.page, 0)
  controller.dispose()
})

test('ProductsController: 默认 Tab 启动查询复用缓存，并异步预热两源首页', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, (payload: any) => {
    if (payload.source !== 'feishu') return { source: 'my_published', products: [], page: 0, pageSize: 20, hasMore: false, warnings: [] }
    assert.equal(payload.source, 'feishu')
    assert.equal(payload.pageSize, 20)
    assert.equal(payload.cursor, undefined)
    assert.notEqual(payload.forceRefresh, true)
    return {
      source: 'feishu',
      products: [
        makeCatalogProduct('789012345', 'feishu', {
          recordId: 'rec_feishu_123',
          title: '飞书多维表格中的相机',
          priceNumber: 1200,
          wantCnt: 35,
          coverUrl: 'https://img.alicdn.com/camera.jpg',
          desc: '极品成色相机',
          images: ['https://img.alicdn.com/camera.jpg'],
        }),
      ],
      hasMore: true,
      nextCursor: 'token_p2',
      targetTableId: 'tbl_product_table',
      total: null,
      page: 0,
      pageSize: 20,
      warnings: [],
      fetchedAt: Date.now(),
    }
  })

  const controller = new ProductsController({ api })
  assert.equal(controller.getState().tab, 'feishu')

  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  const state = controller.getState()
  assert.equal(state.result.phase, 'ready')
  assert.equal(state.result.items.length, 1)

  const item = state.result.items[0]
  assert.equal(item.recordId, 'rec_feishu_123')
  assert.equal(item.itemId, '789012345')
  assert.equal(item.title, '飞书多维表格中的相机')
  assert.equal(item.priceNumber, 1200)
  assert.equal(item.wantCnt, 35)
  assert.equal(item.coverUrl, 'https://img.alicdn.com/camera.jpg')
  assert.equal(item.source, 'feishu_material')
  assert.equal(item.desc, '极品成色相机')
  assert.deepEqual(item.images, ['https://img.alicdn.com/camera.jpg'])
  assert.notEqual(item.source, 'my_published')

  // 分页与游标状态验证
  assert.equal(state.result.hasMore, true)
  assert.equal(state.result.nextPageToken, 'token_p2')
  assert.equal(state.result.targetTableId, 'tbl_product_table')
  assert.equal(state.canPrev, false)
  assert.equal(state.canNext, true)
  // 不假造总页数，后端传 null 时真实为 undefined
  assert.equal(state.result.total, undefined)

  const initialCall = api.calls.find((call) => (call.payload as any).source === 'feishu')!
  assert.equal(initialCall.type, CommandTypes.PRODUCT_CATALOG_QUERY)
  assert.equal((initialCall.payload as any).pageSize, 20)
  assert.equal((initialCall.payload as any).cursor, undefined)
  assert.notEqual((initialCall.payload as any).forceRefresh, true)
  assert.ok(api.calls.some((call) => (call.payload as any).source === 'my_published'))
  assert.ok(api.calls.some((call) => (call.payload as any).source === 'feishu' && (call.payload as any).order === 'captureTimeDesc'))
})

test('ProductsController: 当前显示的商品库收到成功事件后加载后台更新的新商品', async () => {
  const api = new MockBridgeApi()
  let version = 0
  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, (payload: any) => ({
    source: payload.source,
    products: [makeCatalogProduct(version === 0 ? 'old' : 'new', payload.source)],
    total: 1,
    page: 0,
    pageSize: 20,
    hasMore: false,
    warnings: [],
    fetchedAt: Date.now(),
  }))
  const controller = new ProductsController({ api })
  controller.start()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(controller.getState().result.items[0]?.itemId, 'old')
  version = 1
  api.emit(EventTypes.TASK_CHANGED, { task: { type: 'capture', status: 'completed' } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(controller.getState().result.items[0]?.itemId, 'new')
})

test('ProductsController: 采集暂停不提示也不触发商品库重新加载', async () => {
  const api = new MockBridgeApi()
  let reads = 0
  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, (payload: any) => {
    reads += 1
    return { source: payload.source, products: [makeCatalogProduct('stable', payload.source)], page: 0, pageSize: 20, hasMore: false, warnings: [] }
  })
  const controller = new ProductsController({ api })
  controller.start()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const initialReads = reads
  api.emit(EventTypes.TASK_CHANGED, { task: { type: 'capture', status: 'paused' } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(reads, initialReads)
  assert.equal(controller.getState().hasNewCapture, false)
})

test('ProductsController: 发布待确认不刷新，人工确认完成后更新自己发布商品库', async () => {
  const api = new MockBridgeApi()
  let version = 0
  let reads = 0
  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, (payload: any) => {
    if (payload.source === 'my_published') reads += 1
    return {
      source: payload.source,
      products: [makeCatalogProduct(version === 0 ? 'before' : 'published-new', payload.source)],
      total: 1, page: 0, pageSize: 20, hasMore: false, warnings: [],
    }
  })
  const controller = new ProductsController({ api })
  controller.start()
  await controller.setTab('my_published')
  await new Promise((resolve) => setTimeout(resolve, 20))
  const initialReads = reads
  api.emit(EventTypes.TASK_CHANGED, { task: { type: 'publish', status: 'waiting_confirmation' } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(reads, initialReads)
  version = 1
  api.emit(EventTypes.TASK_CHANGED, { task: { type: 'publish', status: 'completed', result: { confirmationStatus: 'confirmed' } } })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(reads > initialReads)
  assert.equal(controller.getState().result.items[0]?.itemId, 'published-new')
})

test('ProductsController: 游标栈模式实现上一页/下一页，翻页真实向后端请求而不前端缓存 500 条且 forceRefresh=false', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, (payload: any) => {
    if (payload.cursor === undefined) {
      return {
        source: 'feishu',
        products: [makeCatalogProduct('p1_1', 'feishu', { recordId: 'rec_p1_1' })],
        hasMore: true,
        nextCursor: 'cursor_token_page2',
        page: 0,
        pageSize: 20,
        warnings: [],
        fetchedAt: Date.now(),
      }
    }
    if (payload.cursor === 'cursor_token_page2') {
      assert.equal(payload.forceRefresh, undefined) // 翻页 forceRefresh=false
      return {
        source: 'feishu',
        products: [makeCatalogProduct('p2_1', 'feishu', { recordId: 'rec_p2_1' })],
        hasMore: false,
        page: 1,
        pageSize: 20,
        warnings: [],
        fetchedAt: Date.now(),
      }
    }
    return { source: 'feishu', products: [], hasMore: false, page: 0, pageSize: 20, warnings: [], fetchedAt: Date.now() }
  })

  const controller = new ProductsController({ api })
  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(controller.getState().query.page, 0)
  assert.equal(controller.getState().result.items[0].recordId, 'rec_p1_1')
  assert.equal(controller.getState().canNext, true)
  assert.equal(controller.getState().canPrev, false)

  // 1. 翻到下一页（第 2 页，应带 cursor_token_page2）
  await controller.nextPage()
  assert.equal(controller.getState().query.page, 1)
  assert.equal(controller.getState().result.items[0].recordId, 'rec_p2_1')
  assert.equal(controller.getState().canNext, false) // hasMore 为 false
  assert.equal(controller.getState().canPrev, true)

  const call2 = api.calls[api.calls.length - 1]
  assert.equal(call2.type, CommandTypes.PRODUCT_CATALOG_QUERY)
  assert.equal((call2.payload as any).cursor, 'cursor_token_page2')
  assert.equal((call2.payload as any).forceRefresh, undefined)

  // 2. 翻回上一页（第 1 页，游标栈回退，cursor 恢复为 undefined）
  await controller.prevPage()
  assert.equal(controller.getState().query.page, 0)
  assert.equal(controller.getState().result.items[0].recordId, 'rec_p1_1')
  assert.equal(controller.getState().canPrev, false)
  assert.equal(controller.getState().canNext, true)

  const call3 = api.calls[api.calls.length - 1]
  assert.equal((call3.payload as any).cursor, undefined)
  assert.equal((call3.payload as any).forceRefresh, undefined)
})

test('ProductsController: 筛选关键词、排序规则、页大小变动时，严格重置游标栈并回到第一页且 forceRefresh=false', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, (payload: any) => {
    return {
      source: 'feishu',
      products: [makeCatalogProduct(`item_${payload.keyword || 'all'}`, 'feishu', { recordId: `rec_${payload.keyword || 'all'}` })],
      hasMore: true,
      nextCursor: 'token_next',
      page: 0,
      pageSize: payload.pageSize || 20,
      warnings: [],
      fetchedAt: Date.now(),
    }
  })

  const controller = new ProductsController({ api })
  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  // 先前进一页
  await controller.nextPage()
  assert.equal(controller.getState().query.page, 1)

  // 1. 搜索关键词变动：重置游标栈，回到第 0 页，cursor 必须为 undefined，forceRefresh=false
  await controller.search('相机')
  assert.equal(controller.getState().query.page, 0)
  assert.equal(controller.getState().query.keyword, '相机')
  const searchCall = api.calls[api.calls.length - 1]
  assert.equal((searchCall.payload as any).cursor, undefined)
  assert.equal((searchCall.payload as any).keyword, '相机')
  assert.equal((searchCall.payload as any).forceRefresh, undefined)

  // 再次前进一页
  await controller.nextPage()
  assert.equal(controller.getState().query.page, 1)

  // 2. 排序方式变动：重置游标栈，回到第 0 页，forceRefresh=false
  await controller.setOrder('wantCntDesc')
  assert.equal(controller.getState().query.page, 0)
  assert.equal(controller.getState().query.order, 'wantCntDesc')
  const orderCall = api.calls[api.calls.length - 1]
  assert.equal((orderCall.payload as any).cursor, undefined)
  assert.equal((orderCall.payload as any).forceRefresh, undefined)

  // 再次前进一页
  await controller.nextPage()
  assert.equal(controller.getState().query.page, 1)

  // 3. 页大小变动：重置游标栈，回到第 0 页，forceRefresh=false
  await controller.setPageSize(50)
  assert.equal(controller.getState().query.page, 0)
  assert.equal(controller.getState().query.pageSize, 50)
  const sizeCall = api.calls[api.calls.length - 1]
  assert.equal((sizeCall.payload as any).cursor, undefined)
  assert.equal((sizeCall.payload as any).pageSize, 50)
  assert.equal((sizeCall.payload as any).forceRefresh, undefined)
})

test('ProductsController: 真实 total 呈现，后端提供真实 total 时保留，不提供时不假造总页数', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, () => ({
    source: 'feishu',
    products: [makeCatalogProduct('1', 'feishu', { recordId: 'rec_1' })],
    hasMore: true,
    total: 88, // 真实 total
    page: 0,
    pageSize: 20,
    warnings: [],
    fetchedAt: Date.now(),
  }))

  const controller = new ProductsController({ api })
  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  const state = controller.getState()
  assert.equal(state.result.total, 88)
})

test('ProductsController: 切换到自己发布的商品库复用缓存且清空 keyword 与 page', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, (payload: any) => {
    if (payload.source === 'feishu') {
      return {
        source: 'feishu',
        products: [],
        hasMore: false,
        page: 0,
        pageSize: 20,
        warnings: [],
        fetchedAt: Date.now(),
      }
    }
    assert.equal(payload.source, 'my_published')
    assert.notEqual(payload.forceRefresh, true)
    assert.equal(payload.page, 0)
    assert.equal(payload.keyword, undefined) // 切换 Tab 清空关键词
    return {
      source: 'my_published',
      products: [makeCatalogProduct('prod_my_1', 'my_published', { title: '我的在售商品1', desc: '真实商品描述' })],
      total: 1,
      page: 0,
      pageSize: 20,
      hasMore: false,
      warnings: [],
      fetchedAt: Date.now(),
    }
  })

  const controller = new ProductsController({ api })
  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  // 先在飞书 Tab 输入搜索词
  await controller.search('镜头')
  assert.equal(controller.getState().query.keyword, '镜头')

  // 切换到自己发布 tab：验证 keyword 与 page 被清空
  await controller.setTab('my_published')
  assert.equal(controller.getState().tab, 'my_published')
  assert.equal(controller.getState().query.keyword, '') // 关键词已清空
  assert.equal(controller.getState().query.page, 0)

  const lastCall = api.calls[api.calls.length - 1]
  assert.equal(lastCall.type, CommandTypes.PRODUCT_CATALOG_QUERY)
  assert.equal((lastCall.payload as any).source, 'my_published')
  assert.notEqual((lastCall.payload as any).forceRefresh, true)

  const state = controller.getState()
  assert.equal(state.result.phase, 'ready')
  assert.equal(state.result.items.length, 1)
  assert.equal(state.result.items[0].itemId, 'prod_my_1')
  assert.equal(state.result.items[0].source, 'my_published')
  assert.equal(state.result.items[0].desc, '真实商品描述')
})

test('ProductsController: 飞书未配置或缺失凭据时，识别 isConfigMissing 引导去设置', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, () => {
    throw new Error('飞书未配置：请先在设置页填写飞书应用与多维表格信息 (INVALID_PAYLOAD)')
  })

  const controller = new ProductsController({ api })
  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  const state = controller.getState()
  assert.equal(state.result.phase, 'error')
  assert.equal(state.isConfigMissing, true)
})

test('ProductsController: 快速切换 Tab 防竞态，旧 Tab 的慢响应不得覆盖新 Tab（Inflight 竞态保护）', async () => {
  const api = new MockBridgeApi()
  let resolveFeishu: (val: any) => void
  const feishuPromise = new Promise((r) => {
    resolveFeishu = r
  })

  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, (payload: any) => {
    if (payload.source === 'feishu') return feishuPromise
    return {
      source: 'my_published',
      products: [makeCatalogProduct('prod_my_instant', 'my_published')],
      total: 1,
      page: 0,
      pageSize: 20,
      hasMore: false,
      warnings: [],
      fetchedAt: Date.now(),
    }
  })

  const controller = new ProductsController({ api })
  controller.start() // 默认发起 feishu 请求，处于挂起状态

  // 立即切换为 my_published
  await controller.setTab('my_published')
  assert.equal(controller.getState().tab, 'my_published')
  assert.equal(controller.getState().result.items[0].itemId, 'prod_my_instant')

  // 迟到的旧 feishu 响应返回
  resolveFeishu!({
    source: 'feishu',
    products: [makeCatalogProduct('slow_item', 'feishu', { recordId: 'rec_slow', title: '慢飞书' })],
    hasMore: false,
    page: 0,
    pageSize: 20,
    warnings: [],
    fetchedAt: Date.now(),
  })
  await new Promise((r) => setTimeout(r, 20))

  // 状态依然是 my_published，绝不被旧 feishu 响应覆盖！
  assert.equal(controller.getState().tab, 'my_published')
  assert.equal(controller.getState().result.items[0].itemId, 'prod_my_instant')
})

test('ProductsController: 目标表漂移 Target Mismatch 保护与清空重置，且翻页带 cursor 时回传 targetTableId', async () => {
  const api = new MockBridgeApi()
  let callCount = 0

  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, (payload: any) => {
    if (payload.source !== 'feishu') return { source: 'my_published', products: [], page: 0, pageSize: 20, hasMore: false, warnings: [] }
    if (!payload.cursor && payload.forceRefresh) {
      callCount++
      return {
        source: 'feishu', products: [makeCatalogProduct('tableB_p1_refreshed', 'feishu', { recordId: 'rec_tableB_p1_refreshed' })],
        hasMore: false, targetTableId: 'tbl_table_B_drifted', page: 0, pageSize: 20, warnings: [], fetchedAt: Date.now(),
      }
    }
    if (!payload.cursor) {
      // 首请求无 cursor，不传 targetTableId
      assert.equal(payload.cursor, undefined)
      assert.equal(payload.targetTableId, undefined)
      return {
        source: 'feishu',
        products: [makeCatalogProduct('tableA_p1', 'feishu', { recordId: 'rec_tableA_p1' })],
        hasMore: true,
        nextCursor: 'token_page2',
        targetTableId: 'tbl_table_A',
        page: 0,
        pageSize: 20,
        warnings: [],
        fetchedAt: Date.now(),
      }
    }
    if (payload.cursor === 'token_page2') {
      // 翻页带 cursor 时，必须回传上一页绑定的 targetTableId
      assert.equal(payload.cursor, 'token_page2')
      assert.equal(payload.targetTableId, 'tbl_table_A')
      return {
        source: 'feishu',
        products: [makeCatalogProduct('tableA_p2', 'feishu', { recordId: 'rec_tableA_p2' })],
        hasMore: true,
        nextCursor: 'token_page3',
        targetTableId: 'tbl_table_A', // 保持一致
        page: 1,
        pageSize: 20,
        warnings: [],
        fetchedAt: Date.now(),
      }
    }
    if (payload.cursor === 'token_page3') {
      assert.equal(payload.cursor, 'token_page3')
      assert.equal(payload.targetTableId, 'tbl_table_A')
      return {
        source: 'feishu',
        products: [makeCatalogProduct('tableB_p3', 'feishu', { recordId: 'rec_tableB_p3' })],
        hasMore: false,
        targetTableId: 'tbl_table_B_drifted', // 目标表漂移！
        page: 2,
        pageSize: 20,
        warnings: [],
        fetchedAt: Date.now(),
      }
    }
    throw new Error('未预期的游标')
  })

  const controller = new ProductsController({ api })
  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  // 首请求验证
  assert.equal(controller.getState().result.targetTableId, 'tbl_table_A')
  assert.equal(controller.getState().result.items[0].recordId, 'rec_tableA_p1')

  // 翻页验证
  await controller.nextPage()
  assert.equal(controller.getState().result.items[0].recordId, 'rec_tableA_p2')

  // 翻页触发 Mismatch：后台返回了 tbl_table_B_drifted
  await controller.nextPage()
  const mismatchState = controller.getState()
  // 必须拦截不接受 rows，杜绝混页！
  assert.equal(mismatchState.result.phase, 'error')
  assert.equal(mismatchState.result.items.length, 0)
  assert.equal(mismatchState.result.error?.code, 'TARGET_TABLE_MISMATCH')
  assert.ok(mismatchState.result.error?.hint.includes('已发生变更'))

  // 换筛选/刷新清空绑定：重新发起首请求
  await controller.refresh()
  const refreshedState = controller.getState()
  assert.equal(refreshedState.result.phase, 'ready')
  assert.equal(refreshedState.result.items[0].recordId, 'rec_tableB_p1_refreshed')
  assert.equal(refreshedState.result.targetTableId, 'tbl_table_B_drifted')
})

test('ProductsController: warnings 正常存入 state 供 UI 呈现非致命详情告警', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, () => ({
    source: 'my_published',
    products: [makeCatalogProduct('prod_partial', 'my_published')],
    total: 1,
    page: 0,
    pageSize: 20,
    hasMore: false,
    warnings: ['商品 prod_partial 详情获取超时，已降级展示基本卡片信息'],
    fetchedAt: Date.now(),
  }))

  const controller = new ProductsController({ api })
  await controller.setTab('my_published')

  const state = controller.getState()
  assert.equal(state.result.phase, 'ready')
  assert.equal(state.result.warnings.length, 1)
  assert.ok(state.result.warnings[0].includes('详情获取超时'))
})

test('ProductsController: refresh() 传递 forceRefresh=true 重新拉取底层', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.PRODUCT_CATALOG_QUERY, () => ({
    source: 'feishu',
    products: [makeCatalogProduct('prod_1', 'feishu')],
    hasMore: false,
    page: 0,
    pageSize: 20,
    warnings: [],
    fetchedAt: Date.now(),
  }))

  const controller = new ProductsController({ api })
  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  await controller.refresh()
  const lastCall = api.calls[api.calls.length - 1]
  assert.equal(lastCall.type, CommandTypes.PRODUCT_CATALOG_QUERY)
  assert.equal((lastCall.payload as any).forceRefresh, true)
})
