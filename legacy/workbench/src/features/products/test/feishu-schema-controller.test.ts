/**
 * 飞书商品字段同步控制器（schema reconciliation）纯逻辑与安全边界单测。
 *
 * 验证：
 * 1. 初始状态与纯手动规范：start() 绝不自动发起预览或执行；
 * 2. 只读预览：空 payload 调用 FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW，解析结构化结果（并集策略 UNION、字段统计等）；
 * 3. 未配置飞书状态识别：isConfigMissing 正确标记，便于 UI 引导去设置；
 * 4. 执行前置守卫：
 *    - 未经成功预览严禁执行；
 *    - 预览已过期（now >= expiresAt）严禁执行并自动作废旧预览；
 *    - 缺少 confirm: true 严禁执行；
 * 5. 类型冲突默认阻止：
 *    - 存在 typeConflicts 且未传 acceptTypeConflicts: true 默认阻止，不调用 execute 命令；
 *    - 显式勾选传 acceptTypeConflicts: true 后放行并调用 execute；
 * 6. 目标表变更复验：notifyTargetTableChanged 立即作废旧预览；
 * 7. 一次性 previewId 防重放：执行成功后 preview 立即作废，防止二次重放；
 * 8. 失败后作废旧预览且绝不自动重试；
 * 9. 执行并发防护：执行中重复调用被忽略；
 * 10. 非扩展环境守卫：api 为 null 优雅报错。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandTypes } from '@fishops/shared'
import {
  FEISHU_SCHEMA_RECONCILE_PREVIEW_TTL_MS,
  type FeishuProductSchemaReconcileExecutePayload,
  type FeishuProductSchemaReconcileExecuteResult,
  type FeishuProductSchemaReconcilePreviewResult,
} from '../../contracts'
import type { BridgeApi } from '../../shared/bridge-api'
import {
  FeishuSchemaReconcileController,
  resolveFeishuTargetTableId,
  extractLegacyTextFieldConflicts,
  isFeishuPreviewExpired,
  isLegacyTextFieldConflict,
  formatFeishuTypeName,
  buildLegacyMigrationGuide,
  FEISHU_TARGET_CONFIG_CHANGED_EVENT,
} from '../feishu-schema-controller'

class MockBridgeApi implements BridgeApi {
  public sentCommands: Array<{ type: string; payload: unknown }> = []
  public previewResponse: FeishuProductSchemaReconcilePreviewResult | null = null
  public executeResponse: FeishuProductSchemaReconcileExecuteResult | null = null
  public configStatusResponse: any = null
  public dataSourceSchemaResponse: any = null
  public errorToThrow: Error | null = null

  async call(type: any, payload: any): Promise<any> {
    this.sentCommands.push({ type, payload })
    if (this.errorToThrow) {
      throw this.errorToThrow
    }
    if (type === CommandTypes.FEISHU_CONFIG_STATUS) {
      return (
        this.configStatusResponse ?? {
          configured: true,
          hasAppId: true,
          hasAppSecret: true,
          hasSpreadsheetToken: true,
          hasProductTableId: true,
          hasSellerTableId: false,
        }
      )
    }
    if (type === CommandTypes.DATA_SOURCE_SCHEMA) {
      return (
        this.dataSourceSchemaResponse ?? {
          schema: {
            name: 'feishu_bitable',
            description: '多维表格 app=sht_default, table=tbl_product_main',
            fields: [],
          },
        }
      )
    }
    if (type === CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW) {
      if (this.previewResponse) return this.previewResponse
      const res: FeishuProductSchemaReconcilePreviewResult = {
        previewId: 'prev_schema_001',
        expiresAt: Date.now() + FEISHU_SCHEMA_RECONCILE_PREVIEW_TTL_MS,
        targetTableId: 'tbl_product_main',
        strategy: 'UNION',
        targetFieldCount: 20,
        localFieldCount: 18,
        feishuFieldCount: 14,
        toCreate: [
          { name: '价格原文', type: 1 },
          { name: '浏览量', type: 2 },
        ],
        inSync: ['商品ID', '商品标题', '价格'],
        typeConflicts: [],
        feishuOnly: ['内部备注'],
        requiresConfirmation: false,
        canAutoApply: true,
        fieldApiCapability: {
          canCreateField: true,
          canUpdateFieldType: false,
          canDeleteField: false,
          notes: [],
        },
        manualActions: ['仅飞书存在的字段仅作展示审计，绝不删除。'],
      }
      return res
    }
    if (type === CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE) {
      if (this.executeResponse) return this.executeResponse
      const p = payload as FeishuProductSchemaReconcileExecutePayload
      const res: FeishuProductSchemaReconcileExecuteResult = {
        previewId: p.previewId,
        targetTableId: 'tbl_product_main',
        strategy: 'UNION',
        targetFieldCount: 20,
        localFieldCount: 18,
        feishuFieldCount: 16,
        createdFields: ['价格原文', '浏览量'],
        skippedExistingFields: [],
        typeConflicts: [],
        feishuOnly: ['内部备注'],
        manualActions: [],
      }
      return res
    }
    throw new Error(`Unexpected command: ${String(type)}`)
  }

  on(): () => void {
    return () => {}
  }

  resubscribe(): void {}
}

test('字段同步控制器：初始化与生命周期绝不自动触发后台命令', () => {
  const api = new MockBridgeApi()
  const controller = new FeishuSchemaReconcileController({ api })

  const state = controller.getState()
  assert.equal(state.availability, 'ready')
  assert.equal(state.preview.phase, 'idle')
  assert.equal(state.execute.phase, 'idle')
  assert.equal(state.strategy, 'UNION')
  assert.equal(state.isConfigMissing, false)
  assert.equal(state.boundTargetTableId, null)

  // 挂载 start() 绝不调用任何 API
  controller.start()
  assert.equal(api.sentCommands.length, 0)
})

test('字段同步控制器：只读预览成功返回结构化 diff', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuSchemaReconcileController({ api })

  const res = await controller.preview()
  assert.ok(res)
  assert.equal(api.sentCommands.length, 1)
  assert.equal(api.sentCommands[0].type, CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW)
  assert.deepEqual(api.sentCommands[0].payload, {}) // 空 payload 严格契约

  const state = controller.getState()
  assert.equal(state.preview.phase, 'ready')
  assert.equal(state.preview.result?.previewId, 'prev_schema_001')
  assert.equal(state.strategy, 'UNION')
  assert.equal(state.boundTargetTableId, 'tbl_product_main')
  assert.equal(controller.isCurrentPreviewValid(), true)
})

test('字段同步控制器：未配置飞书时捕获 isConfigMissing 并清空目标表', async () => {
  const api = new MockBridgeApi()
  api.errorToThrow = new Error('飞书数据源未完整配置：缺少 productTableId (CONFIG_MISSING)')
  const controller = new FeishuSchemaReconcileController({ api })

  const res = await controller.preview()
  assert.equal(res, null)

  const state = controller.getState()
  assert.equal(state.preview.phase, 'error')
  assert.equal(state.isConfigMissing, true)
  assert.equal(state.boundTargetTableId, null)
  assert.equal(controller.isCurrentPreviewValid(), false)
})

test('字段同步控制器：未经有效预览严禁执行', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuSchemaReconcileController({ api })

  const res = await controller.execute({ confirm: true })
  assert.equal(res, null)
  assert.equal(api.sentCommands.length, 0)

  const state = controller.getState()
  assert.equal(state.execute.phase, 'error')
  assert.equal(state.execute.error?.code, 'PREVIEW_REQUIRED')
})

test('字段同步控制器：预览已过期严禁执行并自动作废原预览', async () => {
  const api = new MockBridgeApi()
  let currentTime = 100_000
  const controller = new FeishuSchemaReconcileController({
    api,
    now: () => currentTime,
  })

  // 1. 生成预览
  api.previewResponse = {
    previewId: 'prev_will_expire',
    expiresAt: currentTime + 5000,
    targetTableId: 'tbl_product_main',
    strategy: 'UNION',
    targetFieldCount: 10,
    localFieldCount: 10,
    feishuFieldCount: 10,
    toCreate: [],
    inSync: [],
    typeConflicts: [],
    feishuOnly: [],
    requiresConfirmation: false,
    canAutoApply: true,
    fieldApiCapability: { canCreateField: true, canUpdateFieldType: false, canDeleteField: false, notes: [] },
    manualActions: [],
  }
  await controller.preview()
  assert.equal(controller.isCurrentPreviewValid(), true)

  // 2. 时间推进到过期
  currentTime += 6000
  assert.equal(controller.isCurrentPreviewValid(), false)

  // 3. 执行拦截
  const res = await controller.execute({ confirm: true })
  assert.equal(res, null)
  assert.equal(api.sentCommands.length, 1) // 仅有之前的 preview 命令，无 execute 命令

  const state = controller.getState()
  assert.equal(state.execute.phase, 'error')
  assert.equal(state.execute.error?.code, 'PREVIEW_EXPIRED')
  assert.equal(state.preview.phase, 'idle') // 旧预览已作废
})

test('字段同步控制器：旧历史口径类型冲突绝对阻止执行，严禁通过 acceptTypeConflicts 放行', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuSchemaReconcileController({ api })

  // 模拟旧历史口径的 4 种典型字段冲突：价格、原价为文本，发布时间、采集时间为文本
  api.previewResponse = {
    previewId: 'prev_legacy_conflict',
    expiresAt: Date.now() + 60000,
    targetTableId: 'tbl_product_main',
    strategy: 'UNION',
    targetFieldCount: 10,
    localFieldCount: 10,
    feishuFieldCount: 10,
    toCreate: [{ name: '新字段', type: 1 }],
    inSync: [],
    typeConflicts: [
      { name: '价格', expectedType: 2, actualType: 1 },
      { name: '原价', expectedType: 2, actualType: 1 },
      { name: '发布时间', expectedType: 5, actualType: 1 },
      { name: '采集时间', expectedType: 5, actualType: 1 },
    ],
    feishuOnly: [],
    requiresConfirmation: true,
    canAutoApply: false,
    fieldApiCapability: { canCreateField: true, canUpdateFieldType: false, canDeleteField: false, notes: [] },
    manualActions: ['存量表字段类型需人工调整。'],
  }
  await controller.preview()

  // 1. 未勾选 acceptTypeConflicts 时拦截
  const blocked1 = await controller.execute({ confirm: true })
  assert.equal(blocked1, null)
  assert.equal(api.sentCommands.length, 1) // 仅 preview
  assert.equal(controller.getState().execute.error?.code, 'LEGACY_TYPE_CONFLICT_BLOCKED')
  assert.equal(
    controller.getState().execute.error?.hint.includes('存量表需人工迁移/改类型，系统不会覆盖已有字段；暂不能执行商品写入'),
    true,
  )

  // 2. 即使显式传递 acceptTypeConflicts: true，也绝对不放行！
  const blocked2 = await controller.execute({ confirm: true, acceptTypeConflicts: true })
  assert.equal(blocked2, null)
  assert.equal(api.sentCommands.length, 1) // 依然仅 preview，绝不调用 execute 命令
  assert.equal(controller.getState().execute.error?.code, 'LEGACY_TYPE_CONFLICT_BLOCKED')
  assert.equal(
    controller.getState().execute.error?.hint.includes('存量表需人工迁移/改类型，系统不会覆盖已有字段；暂不能执行商品写入'),
    true,
  )
})

test('字段同步控制器：普通同名类型冲突默认阻止，显式确认后正常放行', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuSchemaReconcileController({ api })

  // 非旧历史口径的普通类型冲突（例如卖家地区期望文本 1，实际单选 3）
  api.previewResponse = {
    previewId: 'prev_normal_conflict',
    expiresAt: Date.now() + 60000,
    targetTableId: 'tbl_product_main',
    strategy: 'UNION',
    targetFieldCount: 10,
    localFieldCount: 10,
    feishuFieldCount: 10,
    toCreate: [{ name: '新字段', type: 1 }],
    inSync: [],
    typeConflicts: [{ name: '地区', expectedType: 1, actualType: 3 }],
    feishuOnly: [],
    requiresConfirmation: true,
    canAutoApply: false,
    fieldApiCapability: { canCreateField: true, canUpdateFieldType: false, canDeleteField: false, notes: [] },
    manualActions: ['类型冲突不会被自动覆盖。'],
  }
  await controller.preview()

  // 1. 未勾选 acceptTypeConflicts 时执行被本地默认阻止
  const blocked = await controller.execute({ confirm: true })
  assert.equal(blocked, null)
  assert.equal(api.sentCommands.length, 1) // 仅 preview，无 execute
  assert.equal(controller.getState().execute.error?.code, 'TYPE_CONFLICT_UNACCEPTED')

  // 2. 显式确认后正常放行
  const ok = await controller.execute({ confirm: true, acceptTypeConflicts: true })
  assert.ok(ok)
  assert.equal(api.sentCommands.length, 2)
  const execCmd = api.sentCommands[1]
  assert.equal(execCmd.type, CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE)
  assert.deepEqual(execCmd.payload, {
    previewId: 'prev_normal_conflict',
    confirm: true,
    acceptTypeConflicts: true,
  })
})

test('字段同步控制器：目标表变更通知强制重新预览（统一以 productTableId 为口径）', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuSchemaReconcileController({ api })

  await controller.preview()
  assert.equal(controller.getState().boundTargetTableId, 'tbl_product_main')
  assert.equal(controller.isCurrentPreviewValid(), true)

  // 1. appId / spreadsheetToken 变化但 productTableId 未变：不得作废预览（避免误伤）
  controller.notifyTargetTableChanged({
    appId: 'cli_new_app',
    spreadsheetToken: 'sht_new_token',
    productTableId: 'tbl_product_main',
  })
  assert.equal(controller.getState().boundTargetTableId, 'tbl_product_main')
  assert.equal(controller.getState().preview.phase, 'ready')
  assert.equal(controller.isCurrentPreviewValid(), true)

  // 2. 目标 tableId 确实变更：立即作废
  controller.notifyTargetTableChanged('tbl_product_new')
  assert.equal(controller.getState().boundTargetTableId, null)
  assert.equal(controller.getState().preview.phase, 'idle')
  assert.equal(controller.isCurrentPreviewValid(), false)

  // 重新生成预览
  await controller.preview()
  assert.equal(controller.isCurrentPreviewValid(), true)

  // 3. 目标重置为空时作废
  controller.notifyTargetTableChanged(null)
  assert.equal(controller.getState().boundTargetTableId, null)
  assert.equal(controller.getState().preview.phase, 'idle')
})

test('字段同步控制器：安全状态检查 checkSafetyStatus', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuSchemaReconcileController({ api })

  // 1. 配置完整时安全检查通过
  const check1 = await controller.checkSafetyStatus()
  assert.equal(check1.ok, true)
  assert.equal(check1.isConfigMissing, false)
  assert.equal(check1.targetChanged, false)
  assert.equal(controller.getState().isConfigMissing, false)

  // 生成预览
  await controller.preview()
  assert.equal(controller.isCurrentPreviewValid(), true)

  // 2. app/token 变化但目标 table 未变：不得作废预览（不得伪造 token 指纹误伤）
  api.dataSourceSchemaResponse = {
    schema: {
      name: 'feishu_bitable',
      description: '多维表格 app=sht_rotated_token, table=tbl_product_main',
      fields: [],
    },
  }
  const checkSame = await controller.checkSafetyStatus()
  assert.equal(checkSame.targetChanged, false)
  assert.equal(controller.isCurrentPreviewValid(), true)
  assert.equal(controller.getState().boundTargetTableId, 'tbl_product_main')

  // 3. 目标表在后台确实发生变动（DATA_SOURCE_SCHEMA 返回不同 table）
  api.dataSourceSchemaResponse = {
    schema: {
      name: 'feishu_bitable',
      description: '多维表格 app=sht_default, table=tbl_product_switched',
      fields: [],
    },
  }
  const check2 = await controller.checkSafetyStatus()
  assert.equal(check2.targetChanged, true)
  assert.equal(controller.isCurrentPreviewValid(), false) // 旧预览已被主动作废
  assert.equal(controller.getState().boundTargetTableId, null)

  // 重新生成预览
  api.dataSourceSchemaResponse = null
  await controller.preview()
  assert.equal(controller.isCurrentPreviewValid(), true)

  // 4. 检查后台配置被清除（未配置飞书）
  api.configStatusResponse = {
    configured: false,
    hasAppId: false,
    hasAppSecret: false,
    hasSpreadsheetToken: false,
    hasProductTableId: false,
    hasSellerTableId: false,
  }
  const check3 = await controller.checkSafetyStatus()
  assert.equal(check3.ok, false)
  assert.equal(check3.isConfigMissing, true)
  assert.equal(controller.getState().isConfigMissing, true)
  assert.equal(controller.isCurrentPreviewValid(), false) // 预览被作废
})

test('历史口径判定与非敏感指纹生成纯函数测试', () => {
  // 1. 历史口径冲突识别
  assert.equal(isLegacyTextFieldConflict({ name: '价格', expectedType: 2, actualType: 1 }), true)
  assert.equal(isLegacyTextFieldConflict({ name: '原价', expectedType: 2, actualType: 1 }), true)
  assert.equal(isLegacyTextFieldConflict({ name: '发布时间', expectedType: 5, actualType: 1 }), true)
  assert.equal(isLegacyTextFieldConflict({ name: '采集时间', expectedType: 5, actualType: 1 }), true)

  // 非旧口径（如类型已是对的，或不是这 4 个字段，或不是文本类型）
  assert.equal(isLegacyTextFieldConflict({ name: '价格', expectedType: 2, actualType: 2 }), false)
  assert.equal(isLegacyTextFieldConflict({ name: '标题', expectedType: 1, actualType: 2 }), false)
  assert.equal(isLegacyTextFieldConflict({ name: '地区', expectedType: 1, actualType: 3 }), false)

  const extracted = extractLegacyTextFieldConflicts([
    { name: '价格', expectedType: 2, actualType: 1 },
    { name: '地区', expectedType: 1, actualType: 3 },
    { name: '发布时间', expectedType: 5, actualType: 1 },
  ])
  assert.equal(extracted.length, 2)
  assert.equal(extracted[0].name, '价格')
  assert.equal(extracted[1].name, '发布时间')

  // 2. UI 目标失效口径解析：统一以 productTableId 为准（字符串或绑定对象）
  assert.equal(resolveFeishuTargetTableId('  tbl_456  '), 'tbl_456')
  assert.equal(
    resolveFeishuTargetTableId({ appId: 'cli_123', spreadsheetToken: 'sht_secret_token_value', productTableId: 'tbl_456' }),
    'tbl_456',
  )
  // 只有 appId / token、无 productTableId：无法判定 → null（不作废，避免误伤）
  assert.equal(resolveFeishuTargetTableId({ appId: 'cli_123', spreadsheetToken: 'sht_secret_token_value' }), null)
  assert.equal(resolveFeishuTargetTableId(null), null)
  assert.equal(resolveFeishuTargetTableId(undefined), null)
  assert.equal(resolveFeishuTargetTableId(''), null)

  assert.equal(FEISHU_TARGET_CONFIG_CHANGED_EVENT, 'fishops:feishu-target-changed')
})

test('字段同步控制器：执行成功后立即作废 preview（防重放）', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuSchemaReconcileController({ api })

  await controller.preview()
  const res = await controller.execute({ confirm: true })
  assert.ok(res)

  const state = controller.getState()
  assert.equal(state.execute.phase, 'ready')
  assert.equal(state.execute.result?.createdFields.length, 2)
  // preview 状态立即被作废
  assert.equal(state.preview.phase, 'idle')
  assert.equal(state.preview.result, null)

  // 再次点击执行被阻断（必须重新预览）
  const replay = await controller.execute({ confirm: true })
  assert.equal(replay, null)
  assert.equal(controller.getState().execute.error?.code, 'PREVIEW_REQUIRED')
})

test('字段同步控制器：执行失败后作废 preview 且绝不自动重试', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuSchemaReconcileController({ api })

  await controller.preview()

  // 模拟 execute 失败
  api.errorToThrow = new Error('飞书多维表格 API 请求繁忙 (BUSY)')
  const res = await controller.execute({ confirm: true })
  assert.equal(res, null)

  const state = controller.getState()
  assert.equal(state.execute.phase, 'error')
  const errText = `${state.execute.error?.title ?? ''} ${state.execute.error?.detail ?? ''}`
  assert.equal(errText.includes('BUSY'), true)
  // 失败后旧 previewId 也作废，不能重放
  assert.equal(state.preview.phase, 'idle')
  assert.equal(state.preview.result, null)

  // 后台仅收到 1 次 execute，无任何静默重试
  const executeCalls = api.sentCommands.filter(
    (c) => c.type === CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE,
  )
  assert.equal(executeCalls.length, 1)
})

test('isFeishuPreviewExpired 纯函数测试', () => {
  assert.equal(isFeishuPreviewExpired(null, 1000), false)
  assert.equal(isFeishuPreviewExpired(undefined, 1000), false)
  assert.equal(isFeishuPreviewExpired(2000, 1999), false)
  assert.equal(isFeishuPreviewExpired(2000, 2000), true)
  assert.equal(isFeishuPreviewExpired(2000, 2001), true)
})

test('历史旧表文本冲突人工迁移指引：逐字段列当前类型/目标类型与关键操作说明', () => {
  // 1. 无冲突或普通类型冲突：返回 null，不展示历史迁移指引
  assert.equal(buildLegacyMigrationGuide(null), null)
  assert.equal(buildLegacyMigrationGuide([]), null)
  assert.equal(
    buildLegacyMigrationGuide([
      { name: '地区', actualType: 3, expectedType: 1 },
    ]),
    null,
  )

  // 2. 存在价格/原价/发布时间/采集时间文本冲突
  const conflicts = [
    { name: '价格', actualType: 1, expectedType: 2 },
    { name: '原价', actualType: 1, expectedType: 2 },
    { name: '发布时间', actualType: 1, expectedType: 5 },
    { name: '采集时间', actualType: 1, expectedType: 5 },
    { name: '地区', actualType: 3, expectedType: 1 }, // 普通冲突，不应混入历史旧表指引
  ]

  const guide = buildLegacyMigrationGuide(conflicts)
  assert.ok(guide)
  assert.equal(guide.isBlocked, true)
  assert.equal(guide.fields.length, 4)

  // 逐字段校验当前类型与目标类型
  const priceField = guide.fields.find((f) => f.name === '价格')!
  assert.ok(priceField)
  assert.equal(priceField.actualType, 1)
  assert.equal(priceField.actualTypeName, '文本')
  assert.equal(priceField.expectedType, 2)
  assert.equal(priceField.expectedTypeName, '数字')
  assert.equal(priceField.adjustmentHint.includes('数字'), true)

  const originPriceField = guide.fields.find((f) => f.name === '原价')!
  assert.ok(originPriceField)
  assert.equal(originPriceField.actualType, 1)
  assert.equal(originPriceField.actualTypeName, '文本')
  assert.equal(originPriceField.expectedType, 2)
  assert.equal(originPriceField.expectedTypeName, '数字')

  const publishTimeField = guide.fields.find((f) => f.name === '发布时间')!
  assert.ok(publishTimeField)
  assert.equal(publishTimeField.actualType, 1)
  assert.equal(publishTimeField.actualTypeName, '文本')
  assert.equal(publishTimeField.expectedType, 5)
  assert.equal(publishTimeField.expectedTypeName, '日期时间')

  const captureTimeField = guide.fields.find((f) => f.name === '采集时间')!
  assert.ok(captureTimeField)
  assert.equal(captureTimeField.actualType, 1)
  assert.equal(captureTimeField.actualTypeName, '文本')
  assert.equal(captureTimeField.expectedType, 5)
  assert.equal(captureTimeField.expectedTypeName, '日期时间')

  // 关键规范与安全指引文案断言
  // 备份
  assert.equal(guide.backupNotice.includes('备份'), true)
  // 新建正确类型字段或人工调整
  assert.equal(guide.migrationAdvice.includes('新建'), true)
  assert.equal(guide.migrationAdvice.includes('人工'), true)
  // 旧列不要自动删除
  assert.equal(guide.retentionNotice.includes('删除'), true)
  assert.equal(guide.retentionNotice.includes('旧'), true)
  // 调整后重新预览
  assert.equal(guide.recheckNotice.includes('重新生成预览'), true)
  // 没有任何自动执行按钮
  assert.equal(guide.noAutoExecutionNotice.includes('不提供任何自动执行'), true)
})

test('formatFeishuTypeName: 飞书类型编码转换', () => {
  assert.equal(formatFeishuTypeName(1), '文本')
  assert.equal(formatFeishuTypeName(2), '数字')
  assert.equal(formatFeishuTypeName(3), '单选')
  assert.equal(formatFeishuTypeName(4), '多选')
  assert.equal(formatFeishuTypeName(5), '日期时间')
  assert.equal(formatFeishuTypeName(999), '类型(999)')
})
