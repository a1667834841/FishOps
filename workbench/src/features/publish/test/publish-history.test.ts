import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublishTask } from '../../contracts'
import type { DirectPublishJob } from '../direct-publish-client'
import { filterPublishHistory, mergePublishHistory, resolvePublishHistoryNames } from '../publish-history'

const job = (idempotencyKey: string, status = 'published', at = '2026-10-05T10:00:00.000Z', itemId?: string): DirectPublishJob => ({
  idempotencyKey, status, at, itemId,
})

test('主历史以直接审计补足旧任务为空时的三条已发布记录，count、过滤和时间排序一致', () => {
  const rows = mergePublishHistory([], [job('k1', 'published', '2026-10-05T10:00:00Z', 'i1'), job('k2', 'published', '2026-10-05T11:00:00Z', 'i2'), job('k3', 'published', '2026-10-05T12:00:00Z', 'i3')])
  assert.equal(rows.length, 3)
  assert.deepEqual(rows.map((row) => row.itemId), ['i3', 'i2', 'i1'])
  assert.equal(filterPublishHistory(rows, '', 'published').length, 3)
})

test('重复幂等键用最新审计更新，不重复计数', () => {
  const rows = mergePublishHistory([], [job('same', 'attempting', '2026-10-05T10:00:00Z'), job('same', 'published', '2026-10-05T11:00:00Z', 'real-id')])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'completed')
  assert.equal(rows[0].itemId, 'real-id')
})

test('与旧任务存在相同幂等键时只保留一行，未知状态不会算作成功', () => {
  const task = {
    id: 'task-1', type: 'publish', status: 'completed', progress: 100, createdAt: 1, updatedAt: 2,
    payload: {}, result: { item: { itemId: 'item-1', sourceTitle: '商品', sourcePrice: 1, sourceImages: [], title: '商品', desc: '', price: 1, priceInCent: 100, originalPrice: 1, originalPriceInCent: 100, mainImage: '', detailImages: [], allImages: [], confirmationStatus: 'confirmed' }, confirmationStatus: 'confirmed' },
    meta: { idempotencyKey: 'same' },
  } as PublishTask
  const rows = mergePublishHistory([task], [job('same'), job('other', 'unknown')])
  assert.equal(rows.length, 2)
  assert.equal(filterPublishHistory(rows, '', 'published').length, 1)
  assert.equal(filterPublishHistory(rows, '', 'unknown').length, 1)
  assert.equal(filterPublishHistory(rows, '', 'published').some((row) => row.id.includes('other')), false)
})


test('直接审计使用名称快照，名称搜索命中，商品链接只使用发布结果 ID', () => {
  const rows = mergePublishHistory([], [{ ...job('named', 'published', undefined, '1087000000001'), productName: '个人一手手机' }])
  assert.equal(rows[0].summary, '个人一手手机')
  assert.equal(rows[0].itemUrl, 'https://www.goofish.com/item?id=1087000000001')
  assert.equal(filterPublishHistory(rows, '一手手机', 'published').length, 1)
})

test('旧任务已发布时使用新增商品 ID，缺少发布结果时不可误跳来源', () => {
  const task = { id: 't', status: 'completed', createdAt: 1, payload: { itemId: '111' }, result: { item: { itemId: '111', title: '手机', price: 1 }, submit: { state: 'submitted', publishedItemId: '222' } } } as PublishTask
  assert.equal(mergePublishHistory([task], [])[0].itemUrl, 'https://www.goofish.com/item?id=222')
  delete task.result!.submit
  assert.equal(mergePublishHistory([task], [])[0].itemUrl, undefined)
  task.status = 'pending'
  assert.equal(mergePublishHistory([task], [])[0].itemUrl, 'https://www.goofish.com/item?id=111')
})

test('历史无名称或非法商品 ID 时明确标记，不生成无效地址', () => {
  const rows = mergePublishHistory([], [job('missing', 'published', undefined, 'javascript:bad')])
  assert.equal(rows[0].summary, '商品名称暂不可用')
  assert.equal(rows[0].itemUrl, undefined)
})


test('旧审计只读补名称，快照不查询，查询失败或返回其他商品时不猜名称', async () => {
  const queried: string[] = []
  const input = [
    { ...job('snapshot', 'published', undefined, '100'), productName: '已保存名称' },
    job('old', 'published', undefined, '200'),
    job('failed-read', 'published', undefined, '300'),
    job('mismatch', 'published', undefined, '400'),
    job('invalid', 'published', undefined, 'rec-not-item'),
    job('unknown', 'unknown', undefined, '500'),
  ]
  const rows = await resolvePublishHistoryNames(input, { async getProduct(itemId) {
    queried.push(itemId)
    if (itemId === '300') throw new Error('商品查询不可用')
    return { status: 'ok', itemId: itemId === '400' ? '999' : itemId, product: { description: '真实商品名称\n商品说明', price: '1', images: [] } }
  } })
  assert.deepEqual(queried, ['200', '300', '400'])
  assert.equal(rows[0].productName, '已保存名称')
  assert.equal(rows[1].productName, '真实商品名称')
  assert.equal(rows[2].productName, undefined)
  assert.equal(rows[3].productName, undefined)
  assert.equal(input[1].productName, undefined)
})


test('同幂等键使用最新审计的名称和发布结果，不能继续展示旧任务来源链接', () => {
  const task = { id: 't', type: 'publish', progress: 0, updatedAt: 1, status: 'pending', createdAt: 1, payload: { itemId: '111' }, meta: { idempotencyKey: 'same', sourceProductSnapshot: { title: '来源手机', price: '1', itemId: '111' } } } as PublishTask
  const rows = mergePublishHistory([task], [{ ...job('same', 'published', undefined, '222'), productName: '实际发布手机' }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].summary, '实际发布手机')
  assert.equal(rows[0].status, 'completed')
  assert.equal(rows[0].itemUrl, 'https://www.goofish.com/item?id=222')
})
