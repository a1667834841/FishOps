/**
 * 过滤（filter）单测：最小想要人数、价格区间、只看包邮。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { passesCaptureFilter } from '../../../../shared/capture/filter'
import type { Product } from '../../../../shared/types/product'

function product(overrides: Partial<Product>): Product {
  return {
    itemId: 'i',
    title: 't',
    price: '¥100',
    priceNumber: 100,
    originalPrice: '',
    originalPriceNumber: 0,
    wantCnt: 10,
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

test('无过滤条件一律放行', () => {
  assert.equal(passesCaptureFilter(product({})), true)
  assert.equal(passesCaptureFilter(product({}), {}), true)
})

test('最小想要人数', () => {
  assert.equal(passesCaptureFilter(product({ wantCnt: 4 }), { minWantCnt: 5 }), false)
  assert.equal(passesCaptureFilter(product({ wantCnt: 5 }), { minWantCnt: 5 }), true)
  assert.equal(passesCaptureFilter(product({ wantCnt: 0 }), { minWantCnt: 0 }), true)
})

test('价格区间', () => {
  assert.equal(passesCaptureFilter(product({ priceNumber: 50 }), { minPrice: 60 }), false)
  assert.equal(passesCaptureFilter(product({ priceNumber: 500 }), { maxPrice: 100 }), false)
  assert.equal(passesCaptureFilter(product({ priceNumber: 80 }), { minPrice: 60, maxPrice: 100 }), true)
})

test('只看包邮', () => {
  assert.equal(passesCaptureFilter(product({ freeShip: '否' }), { onlyFreeShip: true }), false)
  assert.equal(passesCaptureFilter(product({ freeShip: '是' }), { onlyFreeShip: true }), true)
  assert.equal(passesCaptureFilter(product({ freeShip: '否' }), { onlyFreeShip: false }), true)
})
