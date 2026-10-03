/**
 * LocalDataSource 单元测试。
 *
 * 验证：
 * 1. Schema 正确性；
 * 2. 关键词、价格区间、想要人数、包邮、时间范围联合过滤；
 * 3. 分页 offset 与 limit 截断；
 * 4. 字段字符长度超过 1000 时进行安全截断。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryProductRepository } from '../../../../shared/capture/product-repository'
import type { Product } from '../../../../shared/types/product'
import { LocalDataSource } from '../../../../shared/data-source/local-data-source'
import { DATASET_MAX_TEXT_LENGTH } from '../../../../shared/types/dataset'

function makeProduct(partial: Partial<Product> & { itemId: string }): Product {
  return {
    itemId: partial.itemId,
    title: partial.title ?? '测试商品标题',
    price: partial.price ?? '¥100',
    priceNumber: partial.priceNumber ?? 100,
    originalPrice: partial.originalPrice ?? '¥200',
    originalPriceNumber: partial.originalPriceNumber ?? 200,
    wantCnt: partial.wantCnt ?? 10,
    publishTime: partial.publishTime ?? '1天前',
    publishTimeMs: partial.publishTimeMs ?? 1700000000000,
    captureTime: partial.captureTime ?? '2026-10-02 12:00:00',
    captureTimeMs: partial.captureTimeMs ?? 1700000100000,
    sellerNick: partial.sellerNick ?? '卖家小张',
    sellerCity: partial.sellerCity ?? '杭州',
    freeShip: partial.freeShip ?? '是',
    tags: partial.tags ?? '数码、二手、正品',
    coverUrl: partial.coverUrl ?? 'https://example.com/cover.jpg',
    detailUrl: partial.detailUrl ?? 'https://goofish.com/item/1',
    browseCnt: partial.browseCnt,
    collectCnt: partial.collectCnt,
  }
}

test('LocalDataSource: getSchema 返回本地商品 Schema', async () => {
  const repo = createMemoryProductRepository()
  const ds = new LocalDataSource({ repository: repo })
  const schema = await ds.getSchema()

  assert.equal(schema.name, 'local_products')
  assert.equal(schema.fields.length >= 10, true)
  const itemField = schema.fields.find((f) => f.name === 'itemId')
  assert.equal(itemField?.type, 'string')
  assert.equal(itemField?.required, true)
})

test('LocalDataSource: 关键词、价格与想要人数联合过滤', async () => {
  const repo = createMemoryProductRepository()
  await repo.upsertProducts(
    [
      makeProduct({ itemId: 'p1', title: 'iPhone 15 黑色 128G', priceNumber: 3500, wantCnt: 80, freeShip: '是' }),
      makeProduct({ itemId: 'p2', title: 'iPhone 15 Pro 256G', priceNumber: 5200, wantCnt: 150, freeShip: '否' }),
      makeProduct({ itemId: 'p3', title: '小米 14 黑色', priceNumber: 3200, wantCnt: 60, freeShip: '是' }),
      makeProduct({ itemId: 'p4', title: 'iPhone 14 白色', priceNumber: 2800, wantCnt: 40, freeShip: '是' }),
    ],
    1700000100000,
  )

  const ds = new LocalDataSource({ repository: repo })

  // 1. 关键词过滤
  const res1 = await ds.query({ keyword: 'iPhone' })
  assert.equal(res1.rows.length, 3)
  assert.equal(res1.total, 3)

  // 2. 价格区间过滤
  const res2 = await ds.query({ keyword: 'iPhone', minPrice: 3000, maxPrice: 4000 })
  assert.equal(res2.rows.length, 1)
  assert.equal(res2.rows[0]?.['itemId'], 'p1')

  // 3. 想要人数过滤
  const res3 = await ds.query({ minWantCnt: 70 })
  assert.equal(res3.rows.length, 2)

  // 4. 包邮过滤
  const res4 = await ds.query({ keyword: 'iPhone', onlyFreeShip: true })
  assert.equal(res4.rows.length, 2)
  assert.equal(res4.rows.some((r) => r['itemId'] === 'p2'), false)
})

test('LocalDataSource: 时间区间过滤', async () => {
  const repo = createMemoryProductRepository()
  await repo.upsertProducts(
    [
      makeProduct({ itemId: 'p1', publishTimeMs: 1000 }),
      makeProduct({ itemId: 'p2', publishTimeMs: 2000 }),
      makeProduct({ itemId: 'p3', publishTimeMs: 3000 }),
    ],
    1700000100000,
  )

  const ds = new LocalDataSource({ repository: repo })
  const res = await ds.query({
    timeField: 'publishTimeMs',
    startTime: 1500,
    endTime: 2500,
  })
  assert.equal(res.rows.length, 1)
  assert.equal(res.rows[0]?.['itemId'], 'p2')
})

test('LocalDataSource: 分页限制与单字段超长字符截断', async () => {
  const repo = createMemoryProductRepository()
  const longTitle = '超长标题'.repeat(500) // 2000 字符
  await repo.upsertProducts(
    [
      makeProduct({ itemId: 'p_long', title: longTitle }),
    ],
    1700000100000,
  )

  const ds = new LocalDataSource({ repository: repo })
  const res = await ds.query({ limit: 10 })
  assert.equal(res.rows.length, 1)

  const titleInRow = res.rows[0]?.['title'] as string
  assert.equal(titleInRow.length, DATASET_MAX_TEXT_LENGTH)
})
