/**
 * 飞书商品分页浏览 / 单条读取 · 命令登记 / 负载校验 / 路由 回归。
 *
 * 验证：
 * 1. 命令已在 CommandTypes 登记；
 * 2. 分页负载严格键白名单（不接受任意 tableId）与边界（pageSize / pageToken / keyword / order）；
 * 3. 单条读取负载仅接受非空 recordId；
 * 4. PUBLISH_CREATE 本地 / 飞书两种来源互斥且字段完整；
 * 5. 路由到 feishuProducts deps；未接线回 INTERNAL。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandTypes,
  createCommand,
  isFeishuProductGetPayload,
  isFeishuProductsPagePayload,
  isPublishCreatePayload,
} from '@fishops/shared'
import { FEISHU_PRODUCTS_MAX_PAGE_SIZE } from '../../../../shared/types/feishu-products'
import { handleCommand } from '../message-router'

test('飞书商品分页 / 单条读取命令已登记', () => {
  assert.equal(CommandTypes.FEISHU_PRODUCTS_PAGE, 'FEISHU_PRODUCTS_PAGE')
  assert.equal(CommandTypes.FEISHU_PRODUCT_GET, 'FEISHU_PRODUCT_GET')
})

test('isFeishuProductsPagePayload：空负载合法，白名单 + 边界正确', () => {
  // 空负载合法（后台使用默认每页 20 条）。
  assert.equal(isFeishuProductsPagePayload({}), true)
  assert.equal(isFeishuProductsPagePayload({ pageSize: 20 }), true)
  assert.equal(isFeishuProductsPagePayload({ pageSize: 1 }), true)
  assert.equal(isFeishuProductsPagePayload({ pageSize: FEISHU_PRODUCTS_MAX_PAGE_SIZE }), true)
  // 越界 / 非整数拒绝。
  assert.equal(isFeishuProductsPagePayload({ pageSize: FEISHU_PRODUCTS_MAX_PAGE_SIZE + 1 }), false)
  assert.equal(isFeishuProductsPagePayload({ pageSize: 0 }), false)
  assert.equal(isFeishuProductsPagePayload({ pageSize: 2.5 }), false)
  assert.equal(isFeishuProductsPagePayload({ pageSize: '20' }), false)
  // keyword / order。
  assert.equal(isFeishuProductsPagePayload({ keyword: '手机' }), true)
  assert.equal(isFeishuProductsPagePayload({ keyword: 123 }), false)
  assert.equal(isFeishuProductsPagePayload({ order: 'priceDesc' }), true)
  assert.equal(isFeishuProductsPagePayload({ order: 'evil' }), false)
  // 严格白名单：不接受任意 table（tableId）字段。
  assert.equal(isFeishuProductsPagePayload({ tableId: 'tbl' }), false)
  assert.equal(isFeishuProductsPagePayload({ pageSize: 20, tableId: 'tbl' }), false)
  assert.equal(isFeishuProductsPagePayload(null), false)
})

test('isFeishuProductsPagePayload：pageToken 必须绑定 targetTableId（防跨表游标）', () => {
  // 首页无 pageToken：targetTableId 可选（绑定断言）。
  assert.equal(isFeishuProductsPagePayload({ targetTableId: 'tbl' }), true)
  assert.equal(isFeishuProductsPagePayload({ targetTableId: '' }), false)
  assert.equal(isFeishuProductsPagePayload({ targetTableId: 123 }), false)
  // 带 pageToken 时必须提供 targetTableId。
  assert.equal(isFeishuProductsPagePayload({ pageToken: 'tok' }), false)
  assert.equal(isFeishuProductsPagePayload({ pageToken: 'tok', targetTableId: 'tbl' }), true)
  assert.equal(isFeishuProductsPagePayload({ pageToken: '' }), false)
  assert.equal(isFeishuProductsPagePayload({ pageToken: '' , targetTableId: 'tbl' }), false)
  // tableId 依旧被拒绝（仅接受 targetTableId 绑定断言）。
  assert.equal(isFeishuProductsPagePayload({ pageToken: 'tok', tableId: 'tbl' }), false)
})

test('isFeishuProductGetPayload：接受非空 recordId 与可选 targetTableId，拒绝任意字段', () => {
  assert.equal(isFeishuProductGetPayload({ recordId: 'rec1' }), true)
  assert.equal(isFeishuProductGetPayload({ recordId: 'rec1', targetTableId: 'tbl' }), true)
  assert.equal(isFeishuProductGetPayload({ recordId: '' }), false)
  assert.equal(isFeishuProductGetPayload({ recordId: '   ' }), false)
  assert.equal(isFeishuProductGetPayload({ recordId: 'rec1', targetTableId: '  ' }), false)
  assert.equal(isFeishuProductGetPayload({ recordId: 'rec1', tableId: 'evil' }), false)
  assert.equal(isFeishuProductGetPayload({ recordId: 1 }), false)
  assert.equal(isFeishuProductGetPayload(null), false)
})

test('isPublishCreatePayload：本地 / 飞书两种来源互斥且字段完整', () => {
  assert.equal(isPublishCreatePayload({ itemId: 'prod_1' }), true)
  assert.equal(isPublishCreatePayload({ source: 'my_published', itemId: 'prod_1' }), true)
  assert.equal(
    isPublishCreatePayload({ source: 'feishu', recordId: 'rec1', targetTableId: 'tbl' }),
    true,
  )
  // 飞书来源缺字段。
  assert.equal(isPublishCreatePayload({ source: 'feishu', recordId: 'rec1' }), false)
  assert.equal(isPublishCreatePayload({ source: 'feishu', targetTableId: 'tbl' }), false)
  // 飞书来源可携带真实「商品ID」（itemId）作为附加信息。
  assert.equal(
    isPublishCreatePayload({ source: 'feishu', recordId: 'rec1', targetTableId: 'tbl', itemId: 'prod' }),
    true,
  )
  // 本地来源不得携带飞书字段。
  assert.equal(isPublishCreatePayload({ itemId: 'prod', recordId: 'rec' }), false)
  assert.equal(isPublishCreatePayload({ itemId: 'prod', targetTableId: 'tbl' }), false)
  // 来源非法 / 空 itemId / 任意字段。
  assert.equal(isPublishCreatePayload({ source: 'local', itemId: 'x' }), false)
  assert.equal(isPublishCreatePayload({ source: 'other', itemId: 'x' }), false)
  assert.equal(isPublishCreatePayload({ itemId: '  ' }), false)
  assert.equal(isPublishCreatePayload({ itemId: 'x', evil: 1 }), false)
})

test('message-router：飞书商品库命令路由到 feishuProducts deps；未接线回 INTERNAL', async () => {
  const command = createCommand(CommandTypes.FEISHU_PRODUCTS_PAGE, { pageSize: 20 })
  const baseDeps = {
    now: () => 1,
    workerStartedAt: 1,
    incrementPingCount: async () => 1,
    broadcast: () => 0,
    subscribe: (e: string[]) => e,
    unsubscribe: (e: string[]) => e,
  }

  const routed = await handleCommand(command, {
    ...baseDeps,
    feishuProducts: {
      handleCommand: async () => ({
        kind: 'response',
        protocol: 1,
        requestId: command.requestId,
        type: command.type,
        ok: true,
        result: { rows: [], hasMore: false, targetTableId: 'tbl_product' },
        respondedAt: 1,
      }),
    },
  } as never)
  assert.equal(routed.ok, true)
  assert.equal((routed.result as { targetTableId: string }).targetTableId, 'tbl_product')

  const notWired = await handleCommand(command, { ...baseDeps } as never)
  assert.equal(notWired.ok, false)
  assert.equal(notWired.error?.code, 'INTERNAL')
})
