/**
 * products-format 单测：可信链接、分页、CSV 导出（只含传入行、防注入）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildProductsCsv,
  csvFileName,
  displayCaptureTime,
  displayPrice,
  escapeCsvCell,
  pageInfo,
  productLink,
  trustedProductUrl,
} from '../products-format'
import type { Product } from '../../contracts'

function product(extra: Partial<Product> = {}): Product {
  return {
    itemId: '123456',
    title: '测试商品',
    price: '¥10',
    priceNumber: 10,
    originalPrice: '',
    originalPriceNumber: 0,
    wantCnt: 3,
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
    ...extra,
  }
}

test('trustedProductUrl：只放行可信域名的 https 地址', () => {
  assert.equal(trustedProductUrl('https://www.goofish.com/item?id=1'), 'https://www.goofish.com/item?id=1')
  assert.equal(trustedProductUrl('http://www.goofish.com/item?id=1'), null)
  assert.equal(trustedProductUrl('https://evil.com/item?id=1'), null)
  assert.equal(trustedProductUrl('javascript:alert(1)'), null)
  assert.equal(trustedProductUrl(undefined), null)
})

test('productLink：优先可信 detailUrl，其次由合法 itemId 拼接，非法 itemId 返回 null', () => {
  assert.equal(productLink({ detailUrl: 'https://www.goofish.com/item?id=1', itemId: '123456' }), 'https://www.goofish.com/item?id=1')
  const built = productLink({ detailUrl: 'https://evil.com/x', itemId: '123456' })
  assert.ok(built && built.includes('123456'))
  assert.equal(productLink({ detailUrl: '', itemId: 'bad id!' }), null)
})

test('pageInfo：分页边界与页码回退', () => {
  assert.deepEqual(pageInfo(0, 20, 0), { totalPages: 1, page: 0, from: 0, to: 0 })
  assert.deepEqual(pageInfo(45, 20, 2), { totalPages: 3, page: 2, from: 41, to: 45 })
  assert.equal(pageInfo(45, 20, 9).page, 2)
})

test('displayPrice / displayCaptureTime：缺失时如实显示未知', () => {
  assert.equal(displayPrice(product({ price: '¥88', priceNumber: 88 })), '¥88')
  assert.equal(displayPrice(product({ price: '', priceNumber: 88 })), '¥88')
  assert.equal(displayPrice(product({ price: '', priceNumber: 0 })), '未知')
  assert.equal(displayCaptureTime(product({ captureTime: '刚刚', captureTimeMs: 0 })), '刚刚')
})

test('escapeCsvCell：公式注入前缀化，含分隔符时加引号', () => {
  assert.equal(escapeCsvCell('=1+1'), "'=1+1")
  assert.equal(escapeCsvCell('a,b'), '"a,b"')
  assert.equal(escapeCsvCell(10), '10')
})

test('buildProductsCsv：只包含传入的商品行', () => {
  const rows = [product({ itemId: 'A1', title: '甲' }), product({ itemId: 'B2', title: '乙' })]
  const csv = buildProductsCsv(rows)
  assert.ok(csv.startsWith('\uFEFF'))
  assert.ok(csv.includes('A1'))
  assert.ok(csv.includes('B2'))
  assert.ok(!csv.includes('C3'))
  // 表头 + 2 行数据，最后一行以换行结束。
  const lines = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n')
  assert.equal(lines.length, 3)
})

test('csvFileName：包含日期时间戳', () => {
  const name = csvFileName(new Date(2026, 0, 2, 3, 4, 5).getTime())
  assert.equal(name, 'fishops-products-20260102-030405.csv')
})
