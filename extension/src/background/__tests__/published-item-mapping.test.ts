/**
 * 官方在售卡片 → 统一商品（CatalogProduct）归一化单测（以真实字段为准，非假定）：
 * - `id` / `title` / `priceInfo.price` / `picInfo.picUrl`（首图补封面）/ `detailParams.postInfo`；
 * - 描述 / 想要人数兼容真实别名字段与字符串；描述缺失统一为空字符串；
 * - 缺 id 丢弃脏卡片；缺字段不臆造（保留空值 / 0）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapOnSaleCardToProduct } from '../../../../shared/data-source/published-item-mapping'

test('在售卡片归一化：真实字段（价格 / 首图 / 描述 / 想要数 / 包邮）', () => {
  const product = mapOnSaleCardToProduct(
    {
      id: '1019108613935',
      title: '泡泡玛特挂件',
      priceInfo: { price: '100' },
      picInfo: { picUrl: '//img.alicdn.com/x.jpg' },
      desc: '九成新',
      wantCnt: '12人想要',
      detailParams: { postInfo: '包邮' },
    },
    { capturedAt: 1_700_000_000_000 },
  )
  assert.ok(product)
  assert.equal(product.source, 'my_published')
  assert.equal(product.itemId, '1019108613935')
  assert.equal(product.title, '泡泡玛特挂件')
  assert.equal(product.price, '100')
  assert.equal(product.priceNumber, 100)
  // 首图补封面（协议相对地址补 https）。
  assert.equal(product.coverUrl, 'https://img.alicdn.com/x.jpg')
  assert.deepEqual(product.images, ['https://img.alicdn.com/x.jpg'])
  assert.equal(product.desc, '九成新')
  assert.equal(product.wantCnt, 12)
  assert.equal(product.freeShip, '是')
  assert.equal(product.detailUrl, 'https://www.goofish.com/item?id=1019108613935')
  assert.equal(product.captureTimeMs, 1_700_000_000_000)
})

test('在售卡片归一化：缺 id 丢弃；缺字段不臆造（描述统一空串）', () => {
  assert.equal(mapOnSaleCardToProduct({ title: '无 id' }, { capturedAt: 1 }), null)

  const product = mapOnSaleCardToProduct({ id: '1' }, { capturedAt: 1 })
  assert.ok(product)
  assert.equal(product.desc, '')
  assert.equal(product.wantCnt, 0)
  assert.equal(product.coverUrl, '')
  assert.equal(product.price, '')
  assert.deepEqual(product.images, [])
})

test('在售卡片归一化：卖家昵称 / 地区 / 采集时间（列表真实字段不丢失）', () => {
  const product = mapOnSaleCardToProduct(
    { id: '3', title: 'x', userNickName: '卖家A', area: '上海' },
    { capturedAt: 1_700_000_000_001 },
  )
  assert.ok(product)
  assert.equal(product.sellerNick, '卖家A')
  assert.equal(product.sellerCity, '上海')
  assert.equal(product.captureTimeMs, 1_700_000_000_001)
})

test('在售卡片归一化：兼容 description 别名 / price 直出 / 数值想要数', () => {
  const product = mapOnSaleCardToProduct(
    { id: '2', price: '88', description: '别名描述', wantCnt: 3, picUrl: 'https://x/y.jpg' },
    { capturedAt: 1 },
  )
  assert.ok(product)
  assert.equal(product.price, '88')
  assert.equal(product.desc, '别名描述')
  assert.equal(product.wantCnt, 3)
  assert.equal(product.coverUrl, 'https://x/y.jpg')
})
