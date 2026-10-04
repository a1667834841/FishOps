/**
 * 飞书表字段同步 · 命令登记 / 负载校验 / 路由 回归。
 *
 * 验证：
 * 1. 命令已在 CommandTypes 登记（协议保留）；
 * 2. 预览负载必须为空（不接受 tableId 等任意目标）；执行负载严格白名单（previewId + confirm:true +
 *    可选 acceptTypeConflicts）；
 * 3. **后台已停止注册字段同步路由**：命中该命令时回 UNKNOWN_COMMAND（不再路由到 feishuSchema）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandTypes,
  createCommand,
  isFeishuProductSchemaReconcileExecutePayload,
  isFeishuProductSchemaReconcilePreviewPayload,
} from '@fishops/shared'
import { handleCommand } from '../message-router'

test('飞书字段同步命令已登记', () => {
  assert.equal(CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW, 'FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW')
  assert.equal(CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE, 'FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE')
})

test('isFeishuProductSchemaReconcilePreviewPayload：仅接受空负载', () => {
  assert.equal(isFeishuProductSchemaReconcilePreviewPayload({}), true)
  // 严格空负载：不接受 tableId / 字段目标等任意参数（目标表固定为已配置商品表）。
  assert.equal(isFeishuProductSchemaReconcilePreviewPayload({ tableId: 'evil' }), false)
  assert.equal(isFeishuProductSchemaReconcilePreviewPayload({ fields: [] }), false)
  assert.equal(isFeishuProductSchemaReconcilePreviewPayload(null), false)
  assert.equal(isFeishuProductSchemaReconcilePreviewPayload(''), false)
})

test('isFeishuProductSchemaReconcileExecutePayload：必须 previewId + confirm:true', () => {
  assert.equal(isFeishuProductSchemaReconcileExecutePayload({ previewId: 'p1', confirm: true }), true)
  assert.equal(
    isFeishuProductSchemaReconcileExecutePayload({ previewId: 'p1', confirm: true, acceptTypeConflicts: true }),
    true,
  )
  assert.equal(
    isFeishuProductSchemaReconcileExecutePayload({ previewId: 'p1', confirm: true, acceptTypeConflicts: false }),
    true,
  )
  assert.equal(isFeishuProductSchemaReconcileExecutePayload({ previewId: 'p1' }), false)
  assert.equal(isFeishuProductSchemaReconcileExecutePayload({ previewId: 'p1', confirm: false }), false)
  assert.equal(isFeishuProductSchemaReconcileExecutePayload({ previewId: 'p1', confirm: true, acceptTypeConflicts: 'yes' }), false)
  assert.equal(isFeishuProductSchemaReconcileExecutePayload({ confirm: true }), false)
  assert.equal(isFeishuProductSchemaReconcileExecutePayload({ previewId: '   ', confirm: true }), false)
  // 严格键白名单：不接受 tableId / fields 等任意字段。
  assert.equal(isFeishuProductSchemaReconcileExecutePayload({ previewId: 'p1', confirm: true, tableId: 'x' }), false)
  assert.equal(isFeishuProductSchemaReconcileExecutePayload({ previewId: 'p1', confirm: true, fields: [] }), false)
})

test('message-router：后台已停止注册字段同步路由（→ UNKNOWN_COMMAND）', async () => {
  const baseDeps = {
    now: () => 1,
    workerStartedAt: 1,
    incrementPingCount: async () => 1,
    broadcast: () => 0,
    subscribe: (e: string[]) => e,
    unsubscribe: (e: string[]) => e,
  }

  const preview = await handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW, {}),
    { ...baseDeps } as never,
  )
  assert.equal(preview.ok, false)
  assert.equal(preview.error?.code, 'UNKNOWN_COMMAND')

  const execute = await handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE, { previewId: 'p', confirm: true }),
    { ...baseDeps } as never,
  )
  assert.equal(execute.ok, false)
  assert.equal(execute.error?.code, 'UNKNOWN_COMMAND')
})
