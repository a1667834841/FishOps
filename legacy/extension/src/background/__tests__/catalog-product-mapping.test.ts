/**
 * 商品目录 → 可发布商品映射单测（Issue19）。
 *
 * 覆盖：
 * - 当前账号在售（my_published）条目映射为可发布商品的字段保真（价格 / 描述 / 图片）；
 * - 图片列表缺失时回退封面，封面也缺失时保留空数组（绝不使用占位图冒充真实图片）；
 * - 飞书素材、缺 itemId 的脏数据一律返回 null，绝不混入自营发布候选；
 * - 只做映射：不写入本地商品库。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapCatalogProductToProduct } from '../../../../shared/data-source/catalog-product-mapping'
import type { CatalogProduct } from '../../../../shared/types/product-catalog'

function catalogProduct(overrides: Partial<CatalogProduct> = {}): CatalogProduct {
  return {
    source: 'my_published',
    itemId: 'item_1',
    title: '测试在售商品',
    price: '¥128.00',
    priceNumber: 128,
    originalPrice: '',
    originalPriceNumber: 0,
    wantCnt: 7,
    coverUrl: 'https://img.alicdn.com/cover.jpg',
    detailUrl: 'https://www.goofish.com/item?id=item_1',
    desc: '真实在售商品描述',
    images: [],
    captureTimeMs: 1788286400000,
    ...overrides,
  }
}

test('Issue19: my_published 目录条目映射为可发布商品（字段保真）', () => {
  const product = mapCatalogProductToProduct(catalogProduct())

  assert.ok(product)
  assert.equal(product!.itemId, 'item_1')
  assert.equal(product!.title, '测试在售商品')
  assert.equal(product!.priceNumber, 128)
  assert.equal(product!.price, '¥128.00')
  assert.equal(product!.wantCnt, 7)
  assert.equal(product!.desc, '真实在售商品描述')
  assert.equal(product!.source, 'my_published')
  assert.equal(product!.captureTimeMs, 1788286400000)
  // 列表不含图片数组时回退封面，绝不留空导致创建阶段误判。
  assert.deepEqual(product!.images, ['https://img.alicdn.com/cover.jpg'])
  assert.equal(product!.coverUrl, 'https://img.alicdn.com/cover.jpg')
})

test('Issue19: 目录提供多图时按序保留，封面缺失时用首图回填', () => {
  const product = mapCatalogProductToProduct(
    catalogProduct({
      coverUrl: '',
      images: ['https://img.alicdn.com/a.jpg', 'https://img.alicdn.com/b.jpg'],
    }),
  )

  assert.ok(product)
  assert.deepEqual(product!.images, ['https://img.alicdn.com/a.jpg', 'https://img.alicdn.com/b.jpg'])
  assert.equal(product!.coverUrl, 'https://img.alicdn.com/a.jpg')
})

test('Issue19: 缺少图片与描述的条目保留空值，绝不伪造', () => {
  const product = mapCatalogProductToProduct(
    catalogProduct({ coverUrl: '', images: [], desc: '', price: '', priceNumber: 0, originalPrice: '' }),
  )

  assert.ok(product)
  assert.deepEqual(product!.images, [])
  assert.equal(product!.coverUrl, '')
  assert.equal(product!.desc, '')
  assert.equal(product!.price, '')
})

test('Issue19: 飞书素材与缺 itemId 的条目绝不映射为自营发布候选', () => {
  assert.equal(mapCatalogProductToProduct(catalogProduct({ source: 'feishu', recordId: 'rec_1' })), null)
  assert.equal(mapCatalogProductToProduct(catalogProduct({ itemId: '   ' })), null)
})

test('Issue19: 缺少真实详情地址时按 itemId 生成官方商品地址', () => {
  const product = mapCatalogProductToProduct(catalogProduct({ detailUrl: '' }))

  assert.ok(product)
  assert.equal(product!.detailUrl, 'https://www.goofish.com/item?id=item_1')
})
