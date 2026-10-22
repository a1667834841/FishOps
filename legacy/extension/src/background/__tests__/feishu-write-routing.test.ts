/**
 * 飞书商品写入 · 命令登记 / 负载校验 / 路由 回归。
 *
 * 验证：
 * 1. 命令已在 CommandTypes 登记；
 * 2. 预览 / 执行负载严格键白名单与类型校验（预览不接受 tableId 等任意字段，执行必须 confirm:true）；
 * 3. 路由到 feishuWrite deps；未接线回 INTERNAL。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandTypes,
  createCommand,
  isFeishuProductWriteExecutePayload,
  isFeishuProductWritePreviewPayload,
} from '@fishops/shared'
import { FEISHU_WRITE_MAX_ITEMS } from '../../../../shared/types/feishu-write'
import { handleCommand } from '../message-router'

test('飞书写入命令已登记', () => {
  assert.equal(CommandTypes.FEISHU_PRODUCT_WRITE_PREVIEW, 'FEISHU_PRODUCT_WRITE_PREVIEW')
  assert.equal(CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE, 'FEISHU_PRODUCT_WRITE_EXECUTE')
})

test('isFeishuProductWritePreviewPayload：仅接受非空 itemIds', () => {
  assert.equal(isFeishuProductWritePreviewPayload({ itemIds: ['a'] }), true)
  assert.equal(isFeishuProductWritePreviewPayload({ itemIds: ['a', 'b'] }), true)
  // 空数组 / 非数组 / 非字符串元素 / 空白元素拒绝。
  assert.equal(isFeishuProductWritePreviewPayload({ itemIds: [] }), false)
  assert.equal(isFeishuProductWritePreviewPayload({ itemIds: 'a' }), false)
  assert.equal(isFeishuProductWritePreviewPayload({ itemIds: [1] }), false)
  assert.equal(isFeishuProductWritePreviewPayload({ itemIds: ['  '] }), false)
  // 严格键白名单：不接受 tableId / confirm 等任意字段。
  assert.equal(isFeishuProductWritePreviewPayload({ itemIds: ['a'], tableId: 'evil' }), false)
  assert.equal(isFeishuProductWritePreviewPayload({ itemIds: ['a'], confirm: true }), false)
  assert.equal(isFeishuProductWritePreviewPayload(null), false)
})

test('isFeishuProductWriteExecutePayload：必须 previewId + confirm:true', () => {
  assert.equal(isFeishuProductWriteExecutePayload({ previewId: 'p1', confirm: true }), true)
  assert.equal(isFeishuProductWriteExecutePayload({ previewId: 'p1' }), false)
  assert.equal(isFeishuProductWriteExecutePayload({ previewId: 'p1', confirm: false }), false)
  assert.equal(isFeishuProductWriteExecutePayload({ previewId: 'p1', confirm: 'true' }), false)
  assert.equal(isFeishuProductWriteExecutePayload({ confirm: true }), false)
  assert.equal(isFeishuProductWriteExecutePayload({ previewId: '', confirm: true }), false)
  assert.equal(isFeishuProductWriteExecutePayload({ previewId: '   ', confirm: true }), false)
  // 严格键白名单：执行不接受 itemIds / tableId 等任意字段（选品由预览绑定）。
  assert.equal(isFeishuProductWriteExecutePayload({ previewId: 'p1', confirm: true, itemIds: ['a'] }), false)
  assert.equal(isFeishuProductWriteExecutePayload({ previewId: 'p1', confirm: true, tableId: 'x' }), false)
})

test('飞书写入：超量 itemIds 预览校验拒绝', () => {
  const tooMany = Array.from({ length: FEISHU_WRITE_MAX_ITEMS + 1 }, (_, i) => `id_${i}`)
  assert.equal(isFeishuProductWritePreviewPayload({ itemIds: tooMany }), false)
  const maxOk = Array.from({ length: FEISHU_WRITE_MAX_ITEMS }, (_, i) => `id_${i}`)
  assert.equal(isFeishuProductWritePreviewPayload({ itemIds: maxOk }), true)
})

test('message-router：飞书写入命令路由到 feishuWrite deps；未接线回 INTERNAL', async () => {
  const command = createCommand(CommandTypes.FEISHU_PRODUCT_WRITE_PREVIEW, { itemIds: ['a'] })
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
    feishuWrite: {
      handleCommand: async () => ({
        kind: 'response',
        protocol: 1,
        requestId: command.requestId,
        type: command.type,
        ok: true,
        result: { targetTableId: 'tbl', requestedCount: 1, uniqueCount: 1 },
        respondedAt: 1,
      }),
    },
  } as never)
  assert.equal(routed.ok, true)
  assert.equal((routed.result as { targetTableId: string }).targetTableId, 'tbl')

  const notWired = await handleCommand(command, { ...baseDeps } as never)
  assert.equal(notWired.ok, false)
  assert.equal(notWired.error?.code, 'INTERNAL')
})
