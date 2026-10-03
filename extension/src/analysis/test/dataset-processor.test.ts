/**
 * 数据集聚合、抽样与脱敏单元测试。
 *
 * 验证：
 * 1. 字段白名单过滤（非白名单字段不送模）；
 * 2. 手机号、微信等隐私联系方式脱敏；
 * 3. 统计聚合指标（均价、中位数、想要数分布、Top城市/标签）；
 * 4. 分层采样与样本量约束。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Dataset } from '../../../../shared/types/dataset'
import {
  aggregateDataset,
  formatDatasetSummary,
  renderPromptTemplate,
  sampleDataset,
  sanitizeProductForLLM,
  sanitizeText,
} from '../../../../shared/analysis/dataset-processor'

test('DatasetProcessor: 敏感联系方式脱敏', () => {
  const text1 = '联系电话 13812345678 有意者联系'
  assert.equal(sanitizeText(text1), '联系电话 138****5678 有意者联系')

  const text2 = '加微信: wx12345678 或 vx: abc_test'
  const sanitized2 = sanitizeText(text2)
  assert.equal(sanitized2.includes('12345678'), false)
})

test('DatasetProcessor: 字段白名单与超长字符截断', () => {
  const rawRow = {
    itemId: 'item_101',
    title: '商品标题，包含手机号 13987654321 ' + '超长部分'.repeat(30),
    priceNumber: 99,
    originalPriceNumber: 199,
    wantCnt: 30,
    sellerCity: '上海',
    freeShip: '是',
    tags: '数码、二手',
    // 以下为非白名单字段，必须被剔除
    desc: '非常详细的描述，包含不应暴露给模型的长文本',
    images: ['https://example.com/1.jpg', 'https://example.com/2.jpg'],
    sellerNick: '真实卖家名',
    detailUrl: 'https://goofish.com/item/101',
  }

  const sanitized = sanitizeProductForLLM(rawRow)

  // 白名单字段保留
  assert.equal(sanitized['itemId'], 'item_101')
  assert.equal(sanitized['priceNumber'], 99)
  assert.equal(sanitized['sellerCity'], '上海')
  // 标题脱敏且长度不超过 80
  const title = sanitized['title'] as string
  assert.equal(title.includes('139****4321'), true)
  assert.equal(title.length <= 80, true)

  // 非白名单字段剔除
  assert.equal(sanitized['desc'], undefined)
  assert.equal(sanitized['images'], undefined)
  assert.equal(sanitized['sellerNick'], undefined)
  assert.equal(sanitized['detailUrl'], undefined)
})

test('DatasetProcessor: aggregateDataset 统计聚合计算', () => {
  const dataset: Dataset = {
    schema: { name: 'test', label: 'test', fields: [] },
    total: 4,
    source: 'local',
    queriedAt: 1000,
    rows: [
      { itemId: '1', priceNumber: 100, wantCnt: 10, freeShip: '是', sellerCity: '北京', tags: '手机、数码' },
      { itemId: '2', priceNumber: 200, wantCnt: 20, freeShip: '否', sellerCity: '上海', tags: '数码' },
      { itemId: '3', priceNumber: 300, wantCnt: 30, freeShip: '是', sellerCity: '北京', tags: '数码、苹果' },
      { itemId: '4', priceNumber: 400, wantCnt: 40, freeShip: '是', sellerCity: '广州', tags: '配件' },
    ],
  }

  const summary = aggregateDataset(dataset)

  assert.equal(summary.totalCount, 4)
  assert.equal(summary.price.min, 100)
  assert.equal(summary.price.max, 400)
  assert.equal(summary.price.avg, 250)
  assert.equal(summary.price.median, 250) // (200 + 300) / 2

  assert.equal(summary.want.min, 10)
  assert.equal(summary.want.max, 40)
  assert.equal(summary.want.avg, 25)
  assert.equal(summary.want.total, 100)

  assert.equal(summary.freeShipCount, 3)
  assert.equal(summary.freeShipRatio, 0.75)

  // Top 城市
  assert.equal(summary.topCities[0]?.city, '北京')
  assert.equal(summary.topCities[0]?.count, 2)

  // Top 标签
  assert.equal(summary.topTags[0]?.tag, '数码')
  assert.equal(summary.topTags[0]?.count, 3)

  const text = formatDatasetSummary(summary)
  assert.equal(text.includes('商品总数: 4 件'), true)
  assert.equal(text.includes('均价: ¥250'), true)
})

test('DatasetProcessor: sampleDataset 抽样与限额', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    itemId: `item_${i}`,
    title: `商品 ${i}`,
    priceNumber: 100 + i,
    wantCnt: i * 2,
    sellerCity: '杭州',
  }))

  const dataset: Dataset = {
    schema: { name: 'test', label: 'test', fields: [] },
    total: 100,
    source: 'local',
    queriedAt: 1000,
    rows,
  }

  const sampled = sampleDataset(dataset, 20)
  assert.equal(sampled.length, 20)

  // 必须按白名单净化
  assert.equal(sampled[0]?.['itemId'], 'item_99') // 想要数最高的头部商品
  assert.notEqual(sampled[0]?.['title'], undefined)
})

test('DatasetProcessor: renderPromptTemplate 模板填充', () => {
  const template = '总结: {{summary}}\n样本: {{dataset}}'
  const rendered = renderPromptTemplate(template, {
    summary: '测试数据概况',
    dataset: '[{"itemId":"1"}]',
  })
  assert.equal(rendered, '总结: 测试数据概况\n样本: [{"itemId":"1"}]')
})
