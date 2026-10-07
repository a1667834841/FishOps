import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryTaskStore } from '../../../../shared/task/task-store'
import { createMemoryProductRepository } from '../../../../shared/capture/product-repository'
import { FileBackup, parseBackup } from '../file-backup'
import type { BackupFileHandle } from '../../../../shared/persistence/file-handle'

function fixture() {
  let content = ''
  let allowed = true
  let fail = false
  const handle: BackupFileHandle = {
    name: 'backup.json',
    async queryPermission() { return allowed ? 'granted' : 'prompt' },
    async requestPermission() { return 'granted' },
    async getFile() { return { size: content.length, text: async () => content } },
    async createWritable() {
      let staged = ''
      return { async write(data) { if (fail) throw new Error('磁盘已满'); staged = data },
        async close() { content = staged }, async abort() {} }
    },
  }
  const tasks = new MemoryTaskStore()
  const publish = new MemoryTaskStore()
  const products = createMemoryProductRepository()
  const backup = new FileBackup({ tasks, publish, products, getHandle: async () => handle })
  return { tasks, publish, products, backup, content: () => content,
    setContent: (data: string) => { content = data }, deny: () => { allowed = false }, fail: () => { fail = true } }
}
const task = (id: string, type: 'capture' | 'publish', status = 'running') =>
  ({ id, type, status, progress: 30, createdAt: 1, updatedAt: 2, payload: {} })

test('备份包括两类任务，重装后合并恢复，不自动执行；重复恢复幂等', async () => {
  const a = fixture()
  await a.tasks.save(task('c', 'capture') as never)
  await a.publish.save(task('p', 'publish', 'waiting_confirmation') as never)
  await a.backup.save()
  const b = fixture()
  await b.backup.restore(a.content())
  assert.equal((await b.tasks.get('c'))?.status, 'paused')
  assert.equal((await b.publish.get('p'))?.status, 'cancelled')
  await b.backup.restore(a.content())
  assert.equal((await b.tasks.list()).length, 1)
  assert.equal((await b.publish.list()).length, 1)
  assert.equal((await b.tasks.get('c'))?.meta?.recoveryNote, '从文件恢复，等待手动恢复采集')
})

test('损坏及不支持版本在任何写入前拒绝；更新失败保留原文件', async () => {
  const f = fixture()
  await f.backup.save()
  const content = f.content()
  await assert.rejects(f.backup.restore('{'))
  await assert.rejects(f.backup.restore(JSON.stringify({ ...JSON.parse(content), version: 99 })))
  await assert.rejects(f.backup.restore(JSON.stringify({ ...JSON.parse(content), tasks: [task('bad', 'capture', 'evil')] })))
  assert.equal((await f.tasks.list()).length, 0)
  f.fail()
  await assert.rejects(f.backup.save())
  assert.equal(f.content(), content)
})

test('权限撤销不静默成功；文件被外部损坏时不覆盖', async () => {
  const f = fixture()
  f.setContent('损坏文件')
  await assert.rejects(f.backup.save())
  assert.equal(f.content(), '损坏文件')
  f.deny()
  await assert.rejects(f.backup.save())
})

test('现有任务较新或正在执行时不被历史恢复覆盖', async () => {
  const f = fixture()
  await f.publish.save({ ...task('p', 'publish', 'completed'), updatedAt: 10 } as never)
  const source = fixture()
  await source.publish.save(task('p', 'publish') as never)
  await source.backup.save()
  await f.backup.restore(source.content())
  assert.equal((await f.publish.get('p'))?.status, 'completed')
  assert.throws(() => parseBackup('{}'))
})


test('商品与原始快照完整往返，较新商品不被旧文件覆盖', async () => {
  const source = fixture()
  const item = { itemId: 'item', title: '旧标题', price: '10', priceNumber: 10, originalPrice: '', originalPriceNumber: 0,
    wantCnt: 1, publishTime: '', publishTimeMs: 0, captureTime: '', captureTimeMs: 2,
    sellerNick: '', sellerCity: '', freeShip: '', tags: '', coverUrl: '', detailUrl: '', captureKeyword: 'keyword', source: 'captured_search' as const }
  await source.products.upsertProducts([item], 2)
  await source.backup.save()
  const target = fixture()
  await target.backup.restore(source.content())
  assert.deepEqual(await target.products.exportData!(), await source.products.exportData!())
  await target.products.upsertProducts([{ ...item, title: '新标题', captureTimeMs: 5 }], 5)
  await target.backup.restore(source.content())
  const result = await target.products.exportData!()
  assert.equal(result.products[0].title, '新标题')
  assert.equal(result.snapshots.length, 2)
})

test('恢复只广播真实改变的任务快照；再次恢复不重复广播', async () => {
  const source = fixture()
  await source.tasks.save(task('c', 'capture') as never)
  await source.publish.save(task('p', 'publish') as never)
  await source.backup.save()
  const target = fixture()
  const changed: Array<{ id: string; type: string; status: string }> = []
  const backup = new FileBackup({ tasks: target.tasks, publish: target.publish, products: target.products,
    getHandle: async () => null,
    onTaskRestored: item => changed.push({ id: item.id, type: item.type, status: item.status }),
  })
  await backup.restore(source.content())
  assert.deepEqual(changed, [{ id: 'c', type: 'capture', status: 'paused' }, { id: 'p', type: 'publish', status: 'cancelled' }])
  await backup.restore(source.content())
  assert.equal(changed.length, 2)
})
