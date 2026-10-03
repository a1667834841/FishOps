/**
 * ProductsController 单元测试：
 * 验证商品目录概念已转变为「当前账号发布的商品」：
 * 1. 默认查询条件强制 source: 'my_published'；
 * 2. 来源筛选切换支持 'my_published' / 'all' / 'legacy_unconfirmed' / 'captured_search'；
 * 3. PRODUCT_LIST 命令参数严格符合契约。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes } from '@fishops/shared'
import type { BridgeApi } from '../../shared/bridge-api'
import { ProductsController } from '../products-controller'
import type { Product } from '../../contracts'

class MockBridgeApi implements BridgeApi {
  public calls: Array<{ type: string; payload: unknown }> = []
  private responders = new Map<string, (payload: unknown) => unknown>()

  respond(type: string, handler: (payload: unknown) => unknown): void {
    this.responders.set(type, handler)
  }

  async call(type: string, payload: unknown): Promise<any> {
    this.calls.push({ type, payload })
    const handler = this.responders.get(type)
    if (handler) return handler(payload)
    return { products: [], total: 0 }
  }

  on(): () => void {
    return () => {}
  }

  resubscribe(): void {}
  dispose(): void {}
}

function makeProduct(itemId: string, source: 'my_published' | 'captured_search' | 'legacy_unconfirmed' = 'my_published'): Product {
  return {
    itemId,
    title: `测试商品 ${itemId}`,
    price: '¥99.00',
    priceNumber: 99,
    originalPrice: '¥199.00',
    originalPriceNumber: 199,
    wantCnt: 10,
    publishTime: '2026-10-01',
    publishTimeMs: 1788200000000,
    captureTime: '2026-10-01',
    captureTimeMs: 1788200000000,
    sellerNick: 'my_store',
    sellerCity: '杭州',
    freeShip: '是',
    tags: '数码',
    coverUrl: 'https://img.alicdn.com/cover.jpg',
    detailUrl: `https://www.goofish.com/item?id=${itemId}`,
    source,
  }
}

test('ProductsController: 默认只查询当前账号发布商品 (source: my_published)', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.PRODUCT_LIST, (payload: any) => {
    assert.equal(payload.source, 'my_published')
    return {
      products: [makeProduct('prod_1', 'my_published')],
      total: 1,
    }
  })

  const controller = new ProductsController({ api })
  assert.equal(controller.getState().query.source, 'my_published')

  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(controller.getState().result.phase, 'ready')
  assert.equal(controller.getState().result.items.length, 1)
  assert.equal(controller.getState().result.items[0].source, 'my_published')
  assert.equal(api.calls[0].type, CommandTypes.PRODUCT_LIST)
  assert.equal((api.calls[0].payload as any).source, 'my_published')
})

test('ProductsController: 支持切换商品来源筛选', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.PRODUCT_LIST, (payload: any) => {
    return {
      products: [makeProduct('prod_all', payload.source === 'all' ? 'legacy_unconfirmed' : 'my_published')],
      total: 1,
    }
  })

  const controller = new ProductsController({ api })
  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  // 切换为全部
  await controller.setSource('all')
  assert.equal(controller.getState().query.source, 'all')
  const lastCall = api.calls[api.calls.length - 1]
  assert.equal((lastCall.payload as any).source, 'all')

  // 切换为未确认旧存量
  await controller.setSource('legacy_unconfirmed')
  assert.equal(controller.getState().query.source, 'legacy_unconfirmed')
  const unconfirmedCall = api.calls[api.calls.length - 1]
  assert.equal((unconfirmedCall.payload as any).source, 'legacy_unconfirmed')

  // 恢复为当前账号发布商品
  await controller.setSource('my_published')
  assert.equal(controller.getState().query.source, 'my_published')
  const restoredCall = api.calls[api.calls.length - 1]
  assert.equal((restoredCall.payload as any).source, 'my_published')
})
