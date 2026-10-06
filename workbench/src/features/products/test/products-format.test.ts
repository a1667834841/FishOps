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
  mapCatalogProductToTableItem,
  pageInfo,
  parseFeishuDatasetRowToProduct,
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

test('parseFeishuDatasetRowToProduct：正确解析飞书多维表格行，保留 recordId 并避免冒充 my_published', () => {
  const row = {
    recordId: 'rec_abc_999',
    '商品ID': 'item_10086',
    '商品标题': [{ text: '优质二手单反相机' }],
    '价格': 2999.5,
    '原价': 4999,
    '想要人数': 88,
    '发布时间': 1788200000000,
    '采集时间': '2026-10-01T12:00:00Z',
    '卖家昵称': '数码小店',
    '地区': '杭州',
    '包邮': '是',
    '商品标签': '相机,数码',
    '封面URL': { link: 'https://img.alicdn.com/camera.png' },
    '商品详情URL': { link: 'https://www.goofish.com/item?id=item_10086' },
  }

  const p = parseFeishuDatasetRowToProduct(row)
  assert.equal(p.recordId, 'rec_abc_999')
  assert.equal(p.itemId, 'item_10086')
  assert.equal(p.title, '优质二手单反相机')
  assert.equal(p.priceNumber, 2999.5)
  assert.equal(p.originalPriceNumber, 4999)
  assert.equal(p.wantCnt, 88)
  assert.equal(p.sellerNick, '数码小店')
  assert.equal(p.sellerCity, '杭州')
  assert.equal(p.freeShip, '是')
  assert.equal(p.coverUrl, 'https://img.alicdn.com/camera.png')
  assert.equal(p.detailUrl, 'https://www.goofish.com/item?id=item_10086')
  assert.equal(p.source, 'feishu_material')
  assert.notEqual(p.source, 'my_published')
})

test('parseFeishuDatasetRowToProduct：itemId 缺失时严禁 Math.random 造 ID，且不能拿 recordId 拼接 goofish 链接', () => {
  const row = {
    recordId: 'rec_only_record_id_456',
    '商品标题': '没有商品ID的飞书行',
  }
  const p = parseFeishuDatasetRowToProduct(row)
  // 保留稳定 row identity
  assert.equal(p.recordId, 'rec_only_record_id_456')
  // itemId 明确为空字符串，严禁随机数、严禁把 recordId 填作 itemId
  assert.equal(p.itemId, '')
  assert.ok(!p.itemId.includes('feishu_'))
  // productLink 不得拼出 goofish.com/item?id=rec_only_record_id_456
  assert.equal(productLink(p), null)
})

test('parseFeishuDatasetRowToProduct：无 recordId 且无 itemId 时严禁造随机，结构错误明确为空 ID', () => {
  const row = {}
  const p = parseFeishuDatasetRowToProduct(row)
  assert.equal(p.recordId, '')
  assert.equal(p.itemId, '')
  assert.equal(productLink(p), null)
  assert.equal(p.source, 'feishu_material')
})

test('mapCatalogProductToTableItem: 飞书来源保留 recordId, desc, images, 映射为 feishu_material', () => {
  const catalogItem = {
    source: 'feishu' as const,
    itemId: 'item_fs_1',
    recordId: 'rec_fs_1',
    title: '飞书采集商品',
    price: '¥88.00',
    priceNumber: 88,
    originalPrice: '¥188.00',
    originalPriceNumber: 188,
    wantCnt: 12,
    coverUrl: 'https://img.alicdn.com/fs.jpg',
    detailUrl: 'https://www.goofish.com/item?id=item_fs_1',
    desc: '飞书描述详情内容',
    images: ['https://img.alicdn.com/fs.jpg', 'https://img.alicdn.com/fs2.jpg'],
    sellerNick: '飞书卖家',
    sellerCity: '北京',
    freeShip: '是',
    tags: '数码',
    captureTimeMs: 1788200000000,
  }

  const tableItem = mapCatalogProductToTableItem(catalogItem)
  assert.equal(tableItem.source, 'feishu_material')
  assert.equal(tableItem.recordId, 'rec_fs_1')
  assert.equal(tableItem.itemId, 'item_fs_1')
  assert.equal(tableItem.title, '飞书采集商品')
  assert.equal(tableItem.desc, '飞书描述详情内容')
  assert.deepEqual(tableItem.images, ['https://img.alicdn.com/fs.jpg', 'https://img.alicdn.com/fs2.jpg'])
  assert.equal(tableItem.priceNumber, 88)
  assert.equal(tableItem.sellerCity, '北京')
  assert.equal(tableItem.freeShip, '是')
})

test('mapCatalogProductToTableItem: my_published 来源映射为 my_published, 保留 desc, images, 补齐默认值', () => {
  const catalogItem = {
    source: 'my_published' as const,
    itemId: 'item_my_1',
    title: '我的在售商品',
    price: '¥299',
    priceNumber: 299,
    originalPrice: '',
    originalPriceNumber: 0,
    wantCnt: 50,
    coverUrl: 'https://img.alicdn.com/my.jpg',
    detailUrl: 'https://www.goofish.com/item?id=item_my_1',
    desc: '自营商品完整描述',
    images: ['https://img.alicdn.com/my.jpg'],
    sellerNick: '官方账号',
    sellerCity: '深圳',
    captureTimeMs: 1788300000000,
  }

  const tableItem = mapCatalogProductToTableItem(catalogItem)
  assert.equal(tableItem.source, 'my_published')
  assert.equal(tableItem.recordId, undefined)
  assert.equal(tableItem.itemId, 'item_my_1')
  assert.equal(tableItem.desc, '自营商品完整描述')
  assert.deepEqual(tableItem.images, ['https://img.alicdn.com/my.jpg'])
  assert.equal(tableItem.priceNumber, 299)
  assert.equal(tableItem.price, '¥299')
})

test('mapCatalogProductToTableItem: 两个来源均保留缺失想要数，不误显示为零', () => {
  for (const source of ['feishu', 'my_published'] as const) {
    const item = {
      source, itemId: 'missing-want', title: '', price: '', priceNumber: 0,
      originalPrice: '', originalPriceNumber: 0, coverUrl: '', detailUrl: '',
      desc: '', images: [], wantCnt: 0,
    }
    // 模拟旧记录/运行时响应缺字段，不依赖静态契约保证字段存在。
    Reflect.deleteProperty(item, 'wantCnt')
    assert.equal(mapCatalogProductToTableItem(item).wantCnt, undefined)
    assert.equal(mapCatalogProductToTableItem({ ...item, wantCnt: 0 }).wantCnt, 0)
    assert.equal(mapCatalogProductToTableItem({ ...item, wantCnt: 26 }).wantCnt, 26)
  }
})

test('mapCatalogProductToTableItem: 缺项安全补齐，价格和描述回退', () => {
  const minimalItem = {
    source: 'my_published' as const,
    itemId: 'item_min',
    title: '极简商品',
    price: '',
    priceNumber: 15,
    originalPrice: '',
    originalPriceNumber: 0,
    wantCnt: 0,
    coverUrl: '',
    detailUrl: '',
    desc: '',
    images: [],
  }

  const tableItem = mapCatalogProductToTableItem(minimalItem)
  assert.equal(tableItem.price, '¥15')
  assert.equal(tableItem.desc, '')
  assert.deepEqual(tableItem.images, [])
  assert.equal(tableItem.publishTimeMs, 0)
  assert.equal(tableItem.captureTimeMs, 0)
})

test('自有商品展示保留真实发布时间，不用读取时间替代', () => {
  const item = mapCatalogProductToTableItem({ source: 'my_published', itemId: '1', publishTimeMs: 1700000000000, captureTimeMs: 1800000000000 } as import('../../contracts').CatalogProduct)
  assert.equal(item.publishTimeMs, 1700000000000)
  assert.ok(item.publishTime)
  const missing = mapCatalogProductToTableItem({ source: 'my_published', itemId: '2', captureTimeMs: 1800000000000 } as import('../../contracts').CatalogProduct)
  assert.equal(missing.publishTimeMs, 0)
  assert.equal(missing.publishTime, '')
})
