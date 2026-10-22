import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryProductRepository } from '../../../../shared/capture/product-repository'
import type { Product } from '../../../../shared/types/product'
import { PublishController } from '../controller'

function product(overrides: Partial<Product> = {}): Product {
  return { itemId: 'owned-item', title: '测试素材', price: '10', priceNumber: 10,
    originalPrice: '', originalPriceNumber: 0, wantCnt: 0, publishTime: '', publishTimeMs: 0, captureTime: '', captureTimeMs: 0,
    sellerNick: '', sellerCity: '', freeShip: '是', tags: '',
    coverUrl: 'https://img.alicdn.com/test.jpg', detailUrl: '',
    images: ['https://img.alicdn.com/test.jpg'], source: 'my_published',
    accountId: 'account-A', sellerId: 'account-A', ownershipUnconfirmed: false, ...overrides }
}

test('Issue29: 旧账号本地命中不能绕过当前账号目录', async () => {
  const repository = createMemoryProductRepository()
  await repository.upsertProducts([product()], Date.now())
  let calls = 0
  const controller = new PublishController({ repository, ownedProducts: { resolve: async () => { calls++; return null } } })
  await assert.rejects(() => controller.preparePublishItem('owned-item'), { code: 'PRODUCT_NOT_FOUND' })
  assert.equal(calls, 1)
})

test('Issue29: 本地归属不确定时使用官方复验素材，不沿用旧账号内容', async () => {
  for (const patch of [{ownershipUnconfirmed:true}, {accountId:undefined}, {accountId:'old-account'}]) {
    const repository = createMemoryProductRepository()
    await repository.upsertProducts([product({ ...patch, title:'旧内容' })], Date.now())
    const controller = new PublishController({repository, ownedProducts:{resolve:async()=>product({title:'官方内容'})}})
    assert.equal((await controller.preparePublishItem('owned-item')).sourceTitle, '官方内容')
    assert.equal((await repository.list({source:'all'})).products[0]?.title, '旧内容')
  }
})

test('Issue29: 缺少复验能力、目录失败或未确认目录记录都拒绝', async () => {
  const repository = createMemoryProductRepository()
  await repository.upsertProducts([product()], Date.now())
  await assert.rejects(() => new PublishController({repository}).preparePublishItem('owned-item'), {code:'PRODUCT_SOURCE_UNAVAILABLE'})
  await assert.rejects(() => new PublishController({repository,ownedProducts:{resolve:async()=>{throw new Error('offline')}}}).preparePublishItem('owned-item'), {code:'PRODUCT_SOURCE_UNAVAILABLE'})
  await assert.rejects(() => new PublishController({repository,ownedProducts:{resolve:async()=>product({ownershipUnconfirmed:true})}}).preparePublishItem('owned-item'), {code:'PRODUCT_SOURCE_NOT_ALLOWED'})
})

test('Issue29: 再次操作时账号变化重新校验，不复用第一次许可', async () => {
  const repository = createMemoryProductRepository()
  await repository.upsertProducts([product()], Date.now())
  let current: Product | null = product()
  const controller = new PublishController({repository,ownedProducts:{resolve:async()=>current}})
  await controller.preparePublishItem('owned-item')
  current = null
  await assert.rejects(() => controller.preparePublishItem('owned-item'), {code:'PRODUCT_NOT_FOUND'})
  current = product()
  await controller.preparePublishItem('owned-item')
})
