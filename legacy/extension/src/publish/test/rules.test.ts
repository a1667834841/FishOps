/**
 * 发布规则引擎单元测试（P8）。
 *
 * 测试内容：
 * 1. 价格规则：系数加价、固定售价、默认 5 倍划线原价与保留 2 位小数、分计算；
 * 2. 文案规则：前缀 / 后缀拼接、敏感词替换、超长字符串截断；
 * 3. 图片规则：仅允许 HTTPS（自动将 http 升级为 https）、拦截非法协议、数量限制。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyContentRule,
  applyPriceRule,
  buildPublishItem,
  resolveShipping,
  validateAndFilterImages,
} from '../../../../shared/publish/rules'
import { PublishError } from '../../../../shared/types/publish'
import type { Product } from '../../../../shared/types/product'

function makeMockProduct(override: Partial<Product> = {}): Product {
  return {
    itemId: 'item_1001',
    title: '99新 苹果 iPhone 15 Pro 黑色 128G',
    price: '¥4999.00',
    priceNumber: 4999.0,
    originalPrice: '¥7999.00',
    originalPriceNumber: 7999.0,
    wantCnt: 120,
    publishTime: '2026-09-01',
    publishTimeMs: 1788200000000,
    captureTime: '2026-09-02',
    captureTimeMs: 1788286400000,
    sellerNick: '闲置数码小铺',
    sellerCity: '杭州',
    freeShip: '是',
    tags: '数码、手机、正品',
    coverUrl: 'https://img.alicdn.com/imgextra/cover.jpg',
    detailUrl: 'https://www.goofish.com/item?id=item_1001',
    desc: '自用一手国行，全套在保，屏幕无划痕，电池健康98%，包顺丰。',
    images: [
      'https://img.alicdn.com/imgextra/cover.jpg',
      'https://img.alicdn.com/imgextra/detail_1.jpg',
      'https://img.alicdn.com/imgextra/detail_2.jpg',
    ],
    ...override,
  }
}

test('价格规则: 默认系数 1.0 与 5 倍划线原价计算', () => {
  const product = makeMockProduct({ priceNumber: 100 })
  const result = applyPriceRule(product)

  assert.equal(result.price, 100.0)
  assert.equal(result.priceInCent, 10000)
  assert.equal(result.originalPrice, 500.0) // 100 * 5
  assert.equal(result.originalPriceInCent, 50000)
})

test('价格规则: 自定义系数 multiplier 与 markup 浮动加价', () => {
  const product = makeMockProduct({ priceNumber: 200 })
  const result = applyPriceRule(product, {
    mode: 'multiplier',
    multiplier: 1.2, // 200 * 1.2 = 240
    markup: 9.9, // 240 + 9.9 = 249.9
    originalPriceRule: {
      mode: 'multiplier',
      multiplier: 3, // 249.9 * 3 = 749.7
    },
  })

  assert.equal(result.price, 249.9)
  assert.equal(result.priceInCent, 24990)
  assert.equal(result.originalPrice, 749.7)
  assert.equal(result.originalPriceInCent, 74970)
})

test('价格规则: 固定售价 fixedPrice 与 keep 原价规则', () => {
  const product = makeMockProduct({ priceNumber: 200, originalPriceNumber: 888 })
  const result = applyPriceRule(product, {
    mode: 'fixed',
    fixedPrice: 168.88,
    originalPriceRule: {
      mode: 'keep',
    },
  })

  assert.equal(result.price, 168.88)
  assert.equal(result.priceInCent, 16888)
  assert.equal(result.originalPrice, 888)
})

test('文案规则: 前缀/后缀拼接与敏感词过滤替换', () => {
  const product = makeMockProduct({
    title: '苹果 iPhone 15 Pro 原装未拆封',
    desc: '加微详聊，诚心出，支持当面验机。',
  })

  const content = applyContentRule(product, {
    titlePrefix: '【包邮】',
    titleSuffix: ' [自用出]',
    descPrefix: '【郑重承诺】',
    descSuffix: '\n售出不退不换。',
    textReplacements: [
      { pattern: '加微', replacement: '平台沟通' },
      { pattern: '未拆封', replacement: '全新' },
    ],
  })

  assert.equal(content.title, '【包邮】苹果 iPhone 15 Pro 原装全新 [自用出]')
  assert.ok(content.desc.includes('平台沟通详聊'))
  assert.ok(content.desc.startsWith('【郑重承诺】'))
  assert.ok(content.desc.endsWith('售出不退不换。'))
})

test('文案规则: 字符超长硬限制截断', () => {
  const longText = '闲鱼爆款商品'.repeat(50)
  const product = makeMockProduct({
    title: longText,
    desc: longText,
  })

  const content = applyContentRule(product, {
    maxTitleLength: 20,
    maxDescLength: 50,
  })

  assert.equal(content.title.length, 20)
  assert.equal(content.desc.length, 50)
})

test('图片规则: 仅允许 HTTPS，自动将 http:// 升级为 https://', () => {
  const product = makeMockProduct({
    coverUrl: 'http://img.alicdn.com/cover.jpg',
    images: [
      'http://img.alicdn.com/1.jpg',
      'https://img.alicdn.com/2.jpg',
    ],
  })

  const images = validateAndFilterImages(product)
  assert.ok(images.mainImage.startsWith('https://'))
  for (const img of images.allImages) {
    assert.ok(img.startsWith('https://'), `图片必须为 https: ${img}`)
  }
})

test('图片规则: 非法协议过滤与有效图片不足报错', () => {
  const product = makeMockProduct({
    coverUrl: 'javascript:alert(1)',
    images: ['data:image/png;base64,xxxx', 'file:///etc/passwd'],
  })

  assert.throws(
    () => validateAndFilterImages(product),
    (err: unknown) => {
      assert.ok(err instanceof PublishError)
      assert.equal((err as PublishError).code, 'IMAGE_DOWNLOAD_FAILED')
      return true
    },
  )
})

test('buildPublishItem: 完整组合与 override 手动覆盖', () => {
  const product = makeMockProduct({ priceNumber: 100 })
  const item = buildPublishItem(
    product,
    {
      price: { multiplier: 1.1 },
      content: { titlePrefix: '【专柜】' },
    },
    {
      title: '手动强行指定标题',
      price: 199.9,
    },
  )

  assert.equal(item.itemId, product.itemId)
  assert.equal(item.title, '手动强行指定标题')
  assert.equal(item.price, 199.9)
  assert.equal(item.priceInCent, 19990)
  assert.equal(item.confirmationStatus, 'unconfirmed')
  assert.ok(item.mainImage.startsWith('https://'))
})

// ============================ 配送（邮费）规则 ============================

test('配送规则: 包邮来源映射邮费 0', () => {
  const shipping = resolveShipping({ freeShip: '是' })
  assert.equal(shipping.status, 'free')
  assert.equal(shipping.postFee, 0)
  assert.equal(shipping.freeShip, true)
})

test('配送规则: 不包邮来源缺费用时标记 unspecified 并给出可行动提示（绝不伪造收费）', () => {
  const shipping = resolveShipping({ freeShip: '否' })
  assert.equal(shipping.status, 'unspecified')
  assert.equal(shipping.postFee, undefined)
  assert.ok((shipping.actionable ?? '').length > 0)
})

test('配送规则: 显式 postFee=0 视为包邮，>0 视为收费', () => {
  assert.equal(resolveShipping({ freeShip: '否' }, { postFee: 0 }).status, 'free')
  const paid = resolveShipping({ freeShip: '否' }, { postFee: 12.5 })
  assert.equal(paid.status, 'paid')
  assert.equal(paid.postFee, 12.5)
})

test('配送规则: 显式 freeShip=false 但未给金额时标记 unspecified', () => {
  const shipping = resolveShipping({ freeShip: '是' }, { freeShip: false })
  assert.equal(shipping.status, 'unspecified')
})

test('配送规则: 来源未提供包邮信息时保守按包邮处理（不产生收费）', () => {
  const shipping = resolveShipping({ freeShip: '' })
  assert.equal(shipping.status, 'free')
  assert.equal(shipping.postFee, 0)
})

test('buildPublishItem: 写入配送与所在地字段，不伪造收费', () => {
  const freeItem = buildPublishItem(makeMockProduct({ freeShip: '是' }), undefined, {
    location: '外滩',
  })
  assert.equal(freeItem.shippingStatus, 'free')
  assert.equal(freeItem.postFee, 0)
  assert.equal(freeItem.location, '外滩')

  const paidItem = buildPublishItem(makeMockProduct({ freeShip: '否' }), undefined, { postFee: 8 })
  assert.equal(paidItem.shippingStatus, 'paid')
  assert.equal(paidItem.postFee, 8)

  const missingItem = buildPublishItem(makeMockProduct({ freeShip: '否' }))
  assert.equal(missingItem.shippingStatus, 'unspecified')
  assert.equal(missingItem.postFee, undefined)
})
