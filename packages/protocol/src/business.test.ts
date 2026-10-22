import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeReadParams, readCacheKey } from './business.ts'

test('搜索默认值和显式刷新保留，不接受空关键词', () => {
  assert.deepEqual(normalizeReadParams('search.items', { keyword: ' 手机 ', maxAgeSec: 0 }), {
    keyword: '手机', page: 1, rowsPerPage: 30, filter: {}, maxAgeSec: 0, maxWaitMs: 120000,
  })
  for (const keyword of ['', ' ', 3, null]) assert.throws(() => normalizeReadParams('search.items', { keyword }))
})

test('声明式边界拒绝未知字段、错误类型与尚未支持的筛选', () => {
  for (const params of [
    { page: 0 }, { page: 1.5 }, { rowsPerPage: 31 }, { maxAgeSec: -1 },
    { maxWaitMs: 600001 }, { minIntervalMs: -1 }, { jitter: 0 },
    { filter: { minPrice: 20 } }, { filter: { maxPrice: 20 } }, { filter: { freeShipping: true } },
    { filter: { publishDays: 0 } }, { filter: { unknown: true } },
  ]) assert.throws(() => normalizeReadParams('search.items', { keyword: '手机', ...params }))
})

test('详情和建议词只接受各自参数，不开放任意方法', () => {
  assert.deepEqual(normalizeReadParams('item.detail', { itemId: ' 123 ' }), {
    itemId: '123', maxAgeSec: 1800, maxWaitMs: 120000,
  })
  assert.deepEqual(normalizeReadParams('search.suggest', { keyword: '手机' }), {
    keyword: '手机', maxWaitMs: 120000,
  })
  assert.throws(() => normalizeReadParams('search.suggest', { keyword: '手机', page: 1 }))
  assert.throws(() => normalizeReadParams('item.detail', { itemId: '123', keyword: '手机' }))
  assert.throws(() => normalizeReadParams('chat.send', {}))
})

test('输入不变、过滤值为新对象，缓存年龄不超过默认上限', () => {
  const params = { keyword: '手机', filter: { publishDays: 7 }, maxAgeSec: 99999 }
  const before = structuredClone(params)
  const result = normalizeReadParams('search.items', params)
  assert.deepEqual(params, before)
  assert.equal(result.maxAgeSec, 900)
  assert.notEqual(result.filter, params.filter)
})

test('缓存键绑定账号和全部业务参数，排除调度与观察元信息', () => {
  const a = { keyword: ' 手机 ', filter: { publishDays: 7 }, tag: 'one' }
  const b = { keyword: '手机', filter: { publishDays: 7 }, tag: 'two', maxWaitMs: 2000, maxAgeSec: 0 }
  assert.equal(readCacheKey('account-a', 'search.items', a), readCacheKey('account-a', 'search.items', b))
  assert.notEqual(readCacheKey('account-a', 'search.items', a), readCacheKey('account-b', 'search.items', a))
  assert.notEqual(readCacheKey('account-a', 'search.items', a), readCacheKey('account-a', 'search.items', { ...a, page: 2 }))
  assert.throws(() => readCacheKey('', 'item.detail', { itemId: '1' }))
  assert.throws(() => readCacheKey('account-a', 'search.suggest', { keyword: '手机' }))
})

test('公共参数拒绝非对象及非有限数值，接受明确边界', () => {
  for (const value of [null, [], 'text', 1]) assert.throws(() => normalizeReadParams('search.items', value))
  for (const field of ['page', 'rowsPerPage', 'maxWaitMs', 'minIntervalMs', 'maxAgeSec']) {
    for (const value of [NaN, Infinity, '1', null, true, 1.5]) {
      assert.throws(() => normalizeReadParams('search.items', { keyword: 'k', [field]: value }))
    }
  }
  const edge = normalizeReadParams('search.items', {
    keyword: 'k'.repeat(200), page: 10000, rowsPerPage: 1, minIntervalMs: 600000,
    maxWaitMs: 1, tag: 't'.repeat(128), filter: { publishDays: 365 },
  })
  assert.equal(edge.page, 10000)
  assert.equal(edge.filter.publishDays, 365)
  for (const params of [{ keyword: 'k'.repeat(201) }, { tag: '' }, { tag: 't'.repeat(129) }]) {
    assert.throws(() => normalizeReadParams('search.items', { keyword: 'k', ...params }))
  }
})

test('缓存键不能丢失筛选条件', () => {
  const base = readCacheKey('a', 'search.items', { keyword: 'k' })
  assert.notEqual(base, readCacheKey('a', 'search.items', { keyword: 'k', filter: { publishDays: 1 } }))
  assert.notEqual(base, readCacheKey('a', 'search.items', { keyword: 'k', rowsPerPage: 1 }))
  assert.notEqual(readCacheKey('a', 'item.detail', { itemId: '1' }), readCacheKey('a', 'item.detail', { itemId: '2' }))
})
