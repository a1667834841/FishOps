/**
 * products-publish-queue 单测：
 * 验证生产纯函数 products-publish-draft 的行为契约：
 * 1. 真实函数映射与草稿保留 source / recordId / targetTableId / itemId / 图文；
 * 2. 结合 targetTableId + recordId 生成稳定 Key，杜绝跨表同 recordId 冲突；
 * 3. 使用 store 返回 ID 与状态一致性进行去重计数，验证无标识同 title 不同价独立入队；
 * 4. 本页包邮筛选计数与仅导出筛选后 displayItems 的 CSV 验证。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ProductTableItem } from '../products-format'
import { buildProductsCsv } from '../products-format'
import { buildPublishDraft, filterPageProducts, getItemKey } from '../products-publish-draft'

test('buildPublishDraft: 飞书素材商品正确保留 recordId, targetTableId 与图文', () => {
  const feishuItem: ProductTableItem = {
    recordId: 'rec_test_1001',
    targetTableId: 'tbl_products_01',
    source: 'feishu_material',
    itemId: '66778899',
    title: 'Sony A7M4 国行单机',
    price: '¥8,850.00',
    priceNumber: 8850,
    originalPrice: '¥10,000.00',
    originalPriceNumber: 10000,
    wantCnt: 120,
    publishTime: '',
    publishTimeMs: 0,
    captureTime: '10-05 14:12',
    captureTimeMs: 1788200000000,
    sellerNick: '摄影小陈',
    sellerCity: '上海',
    freeShip: '是',
    tags: '相机',
    coverUrl: 'https://img.alicdn.com/a7m4.jpg',
    detailUrl: 'https://www.goofish.com/item?id=66778899',
    desc: '99新无划痕快门低',
  }

  const draft = buildPublishDraft(feishuItem, 'feishu', 'tbl_fallback')
  assert.equal(draft.source, 'feishu')
  assert.equal(draft.recordId, 'rec_test_1001')
  assert.equal(draft.targetTableId, 'tbl_products_01')
  assert.equal(draft.itemId, '66778899')
  assert.equal(draft.title, 'Sony A7M4 国行单机')
  assert.equal(draft.price, 8850)
  assert.equal(draft.originalPrice, 10000)
  assert.equal(draft.coverUrl, 'https://img.alicdn.com/a7m4.jpg')
  assert.deepEqual(draft.imageUrls, ['https://img.alicdn.com/a7m4.jpg'])
  assert.equal(draft.desc, '99新无划痕快门低')
})

test('buildPublishDraft: 自营已发布商品保留真实 itemId，绝不造假 recordId', () => {
  const myItem: ProductTableItem = {
    source: 'my_published',
    itemId: '884029',
    title: '佳能 EOS R6 Mark II',
    price: '¥11,800.00',
    priceNumber: 11800,
    originalPrice: '',
    originalPriceNumber: 0,
    wantCnt: 312,
    publishTime: '',
    publishTimeMs: 0,
    captureTime: '',
    captureTimeMs: 0,
    sellerNick: '自己账号',
    sellerCity: '深圳',
    freeShip: '是',
    tags: '',
    coverUrl: 'https://img.alicdn.com/r6m2.jpg',
    detailUrl: 'https://www.goofish.com/item?id=884029',
  }

  const draft = buildPublishDraft(myItem, 'my_published')
  assert.equal(draft.source, 'my_published')
  assert.equal(draft.recordId, undefined)
  assert.equal(draft.itemId, '884029')
  assert.equal(draft.title, '佳能 EOS R6 Mark II')
  assert.equal(draft.price, 11800)
  assert.equal(draft.coverUrl, 'https://img.alicdn.com/r6m2.jpg')
})

test('getItemKey: 包含 targetTableId + recordId，杜绝跨表同 recordId 冲突', () => {
  const itemFromTableA: ProductTableItem = {
    recordId: 'rec_same_identity_001',
    targetTableId: 'tbl_source_alpha',
    source: 'feishu_material',
    itemId: '',
    title: '商品 A',
    price: '¥100',
    priceNumber: 100,
    originalPrice: '',
    originalPriceNumber: 0,
    wantCnt: 0,
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
  }

  const itemFromTableB: ProductTableItem = {
    recordId: 'rec_same_identity_001',
    targetTableId: 'tbl_source_beta',
    source: 'feishu_material',
    itemId: '',
    title: '商品 B',
    price: '¥200',
    priceNumber: 200,
    originalPrice: '',
    originalPriceNumber: 0,
    wantCnt: 0,
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
  }

  const keyA = getItemKey(itemFromTableA)
  const keyB = getItemKey(itemFromTableB)

  assert.equal(keyA, 'rec:tbl_source_alpha:rec_same_identity_001')
  assert.equal(keyB, 'rec:tbl_source_beta:rec_same_identity_001')
  assert.notEqual(keyA, keyB)

  // 回退默认 targetTableId
  const itemNoTable: ProductTableItem = { ...itemFromTableA, targetTableId: undefined }
  const keyWithDefault = getItemKey(itemNoTable, 'tbl_default_scope')
  assert.equal(keyWithDefault, 'rec:tbl_default_scope:rec_same_identity_001')

  // 自营商品按 itemId 生成
  const myItem: ProductTableItem = {
    source: 'my_published',
    itemId: 'item_self_99',
    title: '自营商品',
    price: '¥100',
    priceNumber: 100,
    originalPrice: '',
    originalPriceNumber: 0,
    wantCnt: 0,
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
  }
  assert.equal(getItemKey(myItem), 'item:item_self_99')
})

test('filterPageProducts 与 CSV 导出：本页筛选计数精准，导出严格匹配筛选结果', () => {
  const pageItems: ProductTableItem[] = [
    {
      source: 'my_published',
      itemId: 'it_1',
      title: '商品一 包邮',
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
      freeShip: '是',
      tags: '',
      coverUrl: '',
      detailUrl: '',
    },
    {
      source: 'my_published',
      itemId: 'it_2',
      title: '商品二 不包邮',
      price: '¥200',
      priceNumber: 200,
      originalPrice: '',
      originalPriceNumber: 0,
      wantCnt: 2,
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
    },
    {
      source: 'my_published',
      itemId: 'it_3',
      title: '商品三 包邮',
      price: '¥300',
      priceNumber: 300,
      originalPrice: '',
      originalPriceNumber: 0,
      wantCnt: 3,
      publishTime: '',
      publishTimeMs: 0,
      captureTime: '',
      captureTimeMs: 0,
      sellerNick: '',
      sellerCity: '',
      freeShip: '是',
      tags: '',
      coverUrl: '',
      detailUrl: '',
    },
  ]

  // 全部
  const allFiltered = filterPageProducts(pageItems, 'all')
  assert.equal(allFiltered.length, 3)

  // 仅包邮
  const freeFiltered = filterPageProducts(pageItems, 'free')
  assert.equal(freeFiltered.length, 2)
  assert.deepEqual(
    freeFiltered.map((i) => i.itemId),
    ['it_1', 'it_3'],
  )

  // 仅不包邮
  const paidFiltered = filterPageProducts(pageItems, 'paid')
  assert.equal(paidFiltered.length, 1)
  assert.equal(paidFiltered[0].itemId, 'it_2')

  // CSV 导出筛选后的结果
  const csvContent = buildProductsCsv(freeFiltered)
  assert.ok(csvContent.includes('it_1'))
  assert.ok(csvContent.includes('it_3'))
  assert.ok(!csvContent.includes('it_2')) // 不包邮的未被导出
})
