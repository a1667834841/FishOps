/**
 * 商品库仓储单测：itemId 去重、快照、列表查询 / 排序 / 分页。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MemoryProductRepository,
  createMemoryProductRepository,
} from '../../../../shared/capture/product-repository'
import type { Product } from '../../../../shared/types/product'

function product(overrides: Partial<Product>): Product {
  const itemId = overrides.itemId ?? 'i'
  return {
    itemId,
    title: `标题${itemId}`,
    price: '¥100',
    priceNumber: 100,
    originalPrice: '',
    originalPriceNumber: 0,
    wantCnt: 1,
    publishTime: '',
    publishTimeMs: 0,
    captureTime: '',
    captureTimeMs: 0,
    sellerNick: '',
    sellerCity: '',
    freeShip: '否',
    tags: '',
    coverUrl: '',
    detailUrl: '',
    ...overrides,
  }
}

test('按 itemId 去重 upsert，并追加快照', async () => {
  const repo = new MemoryProductRepository()
  const first = await repo.upsertProducts([product({ itemId: 'A' }), product({ itemId: 'A' }), product({ itemId: 'B' })], 100)
  assert.deepEqual(first, { added: 2, updated: 1, snapshots: 2 })
  assert.equal(await repo.count(), 2)

  // 同一 capturedAt 再写 → 快照按 id 去重；商品 itemId 已存在 → updated
  const second = await repo.upsertProducts([product({ itemId: 'A', wantCnt: 9 })], 100)
  assert.deepEqual(second, { added: 0, updated: 1, snapshots: 0 })

  // 新 capturedAt → 新增快照
  const third = await repo.upsertProducts([product({ itemId: 'A', wantCnt: 20 })], 200)
  assert.deepEqual(third, { added: 0, updated: 1, snapshots: 1 })

  const snapshots = await repo.getSnapshots('A')
  assert.equal(snapshots.length, 2)
  assert.deepEqual(snapshots.map((s) => s.wantCnt), [9, 20])

  const list = await repo.list({ source: 'all' })
  assert.equal(list.total, 2)
  const a = list.products.find((p) => p.itemId === 'A')!
  assert.equal(a.wantCnt, 20) // 最近一次覆盖
})

test('列表关键字过滤 / 排序 / 分页', async () => {
  const repo = createMemoryProductRepository()
  await repo.upsertProducts(
    [
      product({ itemId: 'a', title: 'iPhone 15', wantCnt: 5, captureTimeMs: 300 }),
      product({ itemId: 'b', title: 'iPad', wantCnt: 50, captureTimeMs: 100 }),
      product({ itemId: 'c', title: 'iPod', wantCnt: 20, captureTimeMs: 200 }),
    ],
    1,
  )

  const filtered = await repo.list({ keyword: 'Pad', source: 'all' })
  assert.equal(filtered.total, 1)

  const byWant = await repo.list({ order: 'wantCntDesc', source: 'all' })
  assert.deepEqual(byWant.products.map((p) => p.itemId), ['b', 'c', 'a'])

  const byTime = await repo.list({ order: 'captureTimeAsc', source: 'all' })
  assert.deepEqual(byTime.products.map((p) => p.itemId), ['b', 'c', 'a'])

  const page = await repo.list({ order: 'captureTimeDesc', limit: 2, offset: 1, source: 'all' })
  assert.deepEqual(page.products.map((p) => p.itemId), ['c', 'b'])
  assert.equal(page.total, 3)
})

test('clear 清空商品与快照', async () => {
  const repo = new MemoryProductRepository()
  await repo.upsertProducts([product({ itemId: 'A' })], 1)
  await repo.clear()
  assert.equal(await repo.count(), 0)
  assert.deepEqual(await repo.getSnapshots('A'), [])
})

test('最小一致迁移与来源隔离: 旧数据标记为 legacy_unconfirmed，不冒充 my_published', async () => {
  const repo = createMemoryProductRepository()
  await repo.upsertProducts(
    [
      // 旧数据：无 source 字段
      product({ itemId: 'legacy_1', title: '旧存量商品' }),
      // 当前账号已发布商品
      product({ itemId: 'pub_1', title: '我的在售相机', source: 'my_published', status: 'published' }),
      // 搜索采集竞品
      product({ itemId: 'search_1', title: '竞品雨伞', source: 'captured_search', status: 'unconfirmed' }),
    ],
    1000,
  )

  // 1. 默认查询或全部查询：旧数据安全带上 legacy_unconfirmed 标记
  const allList = await repo.list({ source: 'all' })
  assert.equal(allList.total, 3)
  const legacyItem = allList.products.find((p) => p.itemId === 'legacy_1')
  assert.equal(legacyItem?.source, 'legacy_unconfirmed')
  assert.equal(legacyItem?.status, 'unconfirmed')

  // 2. 严格筛选当前账号发布商品（my_published）：旧数据与竞品绝不混入
  const myList = await repo.list({ source: 'my_published' })
  assert.equal(myList.total, 1)
  assert.equal(myList.products[0].itemId, 'pub_1')
  assert.equal(myList.products[0].source, 'my_published')

  // 3. 筛选存量未确认商品
  const legacyList = await repo.list({ source: 'legacy_unconfirmed' })
  assert.equal(legacyList.total, 1)
  assert.equal(legacyList.products[0].itemId, 'legacy_1')

  // 4. 筛选搜索采集竞品
  const searchList = await repo.list({ source: 'captured_search' })
  assert.equal(searchList.total, 1)
  assert.equal(searchList.products[0].itemId, 'search_1')
})

test('安全默认查询：缺省 source 只返回当前账号发布商品（my_published），显式 all 才全量', async () => {
  const repo = createMemoryProductRepository()
  await repo.upsertProducts(
    [
      product({ itemId: 'mine', source: 'my_published', status: 'published' }),
      product({ itemId: 'comp', source: 'captured_search', status: 'unconfirmed' }),
      product({ itemId: 'old' }),
    ],
    1000,
  )

  // 缺省（含只传关键字 / 分页）绝不把竞品与未确认存量当作自有商品
  const defaultList = await repo.list()
  assert.equal(defaultList.total, 1)
  assert.equal(defaultList.products[0].itemId, 'mine')

  const byKeyword = await repo.list({ keyword: 'o' })
  assert.equal(byKeyword.total, 0)

  // 显式 all 才返回全量
  const allList = await repo.list({ source: 'all' })
  assert.equal(allList.total, 3)
})

test('upsert 归属安全：归属未确认绝不允许覆盖已有 my_published，确定来源优先', async () => {
  const repo = createMemoryProductRepository()

  // 先确认归属为当前账号发布商品
  await repo.upsertProducts(
    [
      product({
        itemId: 'A',
        source: 'my_published',
        status: 'published',
        accountId: 'me_1',
        sellerId: 'me_1',
        ownershipUnconfirmed: false,
        wantCnt: 10,
      }),
    ],
    1000,
  )

  // 后续一次「归属未确认」采集（缺卖家身份）绝不得把 my_published 降级为 captured_search
  await repo.upsertProducts(
    [
      product({
        itemId: 'A',
        source: 'captured_search',
        status: 'unconfirmed',
        ownershipUnconfirmed: true,
        wantCnt: 20,
      }),
    ],
    2000,
  )

  const [p] = (await repo.list({ source: 'my_published' })).products
  assert.equal(p!.source, 'my_published')
  assert.equal(p!.status, 'published')
  assert.equal(p!.accountId, 'me_1')
  assert.equal(p!.sellerId, 'me_1')
  assert.equal(p!.ownershipUnconfirmed, false)
  assert.equal(p!.wantCnt, 20) // 采集数据本身仍更新

  // 我的商品仍然只能通过 my_published 查出，绝不落入 captured_search
  assert.equal((await repo.list({ source: 'captured_search' })).total, 0)
})

test('upsert 确定来源优先：已确认竞品不被后续未确认归属覆盖，归属确认后才升级', async () => {
  const repo = createMemoryProductRepository()

  // 先确认是他人竞品（有卖家 ID、归属已确认）
  await repo.upsertProducts(
    [
      product({
        itemId: 'B',
        source: 'captured_search',
        status: 'unconfirmed',
        sellerId: 'other_9',
        ownershipUnconfirmed: false,
      }),
    ],
    1000,
  )

  // 后续一次归属未确认采集（缺卖家）不得把它降级
  await repo.upsertProducts(
    [
      product({
        itemId: 'B',
        source: 'captured_search',
        status: 'unconfirmed',
        ownershipUnconfirmed: true,
      }),
    ],
    2000,
  )

  let [p] = (await repo.list({ source: 'captured_search' })).products
  assert.equal(p!.sellerId, 'other_9')
  assert.equal(p!.ownershipUnconfirmed, false)

  // 一旦确认归属为当前账号发布商品，则升级为 my_published
  await repo.upsertProducts(
    [
      product({
        itemId: 'B',
        source: 'my_published',
        status: 'published',
        accountId: 'me_1',
        sellerId: 'me_1',
        ownershipUnconfirmed: false,
      }),
    ],
    3000,
  )

  const mine = await repo.list({ source: 'my_published' })
  assert.equal(mine.total, 1)
  assert.equal(mine.products[0].itemId, 'B')
  assert.equal(mine.products[0].accountId, 'me_1')
  assert.equal((await repo.list({ source: 'captured_search' })).total, 0)
})
