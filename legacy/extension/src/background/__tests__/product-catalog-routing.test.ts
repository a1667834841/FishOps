/**
 * 商品目录命令登记 / 负载校验 / 路由回归，并验证后台**停止注册**飞书字段同步命令
 * （保留飞书商品写入路由）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, createCommand, isProductCatalogQueryPayload } from '@fishops/shared'
import { PRODUCT_CATALOG_MAX_PAGE_SIZE } from '../../../../shared/types/product-catalog'
import { handleCommand } from '../message-router'

const BASE_DEPS = {
  now: () => 1,
  workerStartedAt: 1,
  incrementPingCount: async () => 1,
  broadcast: () => 0,
  subscribe: (events: string[]) => events,
  unsubscribe: (events: string[]) => events,
}

test('商品目录命令已登记', () => {
  assert.equal(CommandTypes.PRODUCT_CATALOG_QUERY, 'PRODUCT_CATALOG_QUERY')
})

test('isProductCatalogQueryPayload：source 必填 + 键白名单 + 边界', () => {
  assert.equal(isProductCatalogQueryPayload({ source: 'feishu' }), true)
  assert.equal(isProductCatalogQueryPayload({ source: 'my_published' }), true)
  assert.equal(isProductCatalogQueryPayload({ source: 'other' }), false)
  assert.equal(isProductCatalogQueryPayload({}), false)

  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', keyword: '手机', order: 'wantCntDesc' }), true)
  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', order: 'evil' }), false)

  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', pageSize: PRODUCT_CATALOG_MAX_PAGE_SIZE }), true)
  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', pageSize: PRODUCT_CATALOG_MAX_PAGE_SIZE + 1 }), false)
  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', pageSize: 0 }), false)
  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', pageSize: 2.5 }), false)

  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', page: 0 }), true)
  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', page: -1 }), false)

  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', cursor: 'TOK' }), false)
  // cursor（飞书游标）必须绑定 targetTableId（防跨表游标）。
  assert.equal(
    isProductCatalogQueryPayload({ source: 'feishu', cursor: 'TOK', targetTableId: 'tbl' }),
    true,
  )
  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', targetTableId: '' }), false)
  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', cursor: '' }), false)

  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', forceRefresh: true }), true)
  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', forceRefresh: 'yes' }), false)

  // 严格白名单：拒绝未知字段。
  assert.equal(isProductCatalogQueryPayload({ source: 'feishu', tableId: 'x' }), false)
  assert.equal(isProductCatalogQueryPayload(null), false)
})

test('message-router：PRODUCT_CATALOG_QUERY 路由到 productCatalog；未接线回 INTERNAL', async () => {
  const command = createCommand(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'feishu' })

  const routed = await handleCommand(command, {
    ...BASE_DEPS,
    productCatalog: {
      handleCommand: async () => ({
        kind: 'response',
        protocol: 1,
        requestId: command.requestId,
        type: command.type,
        ok: true,
        result: {
          source: 'feishu',
          products: [],
          total: null,
          page: 0,
          pageSize: 20,
          hasMore: false,
          warnings: [],
          fetchedAt: 1,
        },
        respondedAt: 1,
      }),
    },
  } as never)
  assert.equal(routed.ok, true)

  const notWired = await handleCommand(command, { ...BASE_DEPS } as never)
  assert.equal(notWired.ok, false)
  assert.equal(notWired.error?.code, 'INTERNAL')
})

test('后台停止注册飞书字段同步命令（→ UNKNOWN_COMMAND），保留飞书商品写入路由', async () => {
  const deps = { ...BASE_DEPS } as never

  const syncPreview = await handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW, {} as never),
    deps,
  )
  assert.equal(syncPreview.ok, false)
  assert.equal(syncPreview.error?.code, 'UNKNOWN_COMMAND')

  const syncExecute = await handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE, { previewId: 'p', confirm: true }),
    deps,
  )
  assert.equal(syncExecute.ok, false)
  assert.equal(syncExecute.error?.code, 'UNKNOWN_COMMAND')

  // 写入预览仍注册（未接线时回 INTERNAL「未接线」，而非 UNKNOWN_COMMAND）。
  const writePreview = await handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCT_WRITE_PREVIEW, { itemIds: ['x'] }),
    deps,
  )
  assert.equal(writePreview.ok, false)
  assert.equal(writePreview.error?.code, 'INTERNAL')
})
