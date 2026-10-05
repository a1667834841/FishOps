import assert from 'node:assert/strict'
import test from 'node:test'
import type { PublishTask } from '../../contracts'
import type { DirectPublishJob } from '../direct-publish-client'
import { filterPublishHistory, mergePublishHistory } from '../publish-history'

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

test('与旧任务存在相同幂等键时只保留任务行，未知状态不会算作成功', () => {
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
