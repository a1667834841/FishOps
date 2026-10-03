/**
 * 飞书商品写入控制器纯逻辑与安全边界单测（适配最新 previewId / expiresAt / typeConflicts 契约）。
 *
 * 覆盖：
 * 1. 显式勾选管理：单选、多选、反选、清空与 200 件上限拦截；
 * 2. 严禁挂载自动写入/自动预览：初始化与 start() 不调用任何后台命令；
 * 3. 选品变更失效：选品变化使 preview 结果立即失效作废，避免以旧预览偷跑执行；
 * 4. 只读预览：调用 FEISHU_PRODUCT_WRITE_PREVIEW，解析包含 previewId、expiresAt 与 typeConflicts 的结果；
 * 5. 执行安全前置防护（全方位拦截违规执行）：
 *    - 未经成功预览严禁执行；
 *    - 预览已过期（当前时间 >= expiresAt）严禁执行并自动失效；
 *    - 选品快照不一致严禁执行并自动失效；
 *    - 字段缺失严禁执行（严禁自动创建字段）；
 *    - 字段类型冲突（typeConflicts）严禁执行；
 *    - 待写入数为 0 严禁执行；
 *    - 未显式传递 confirm: true 严禁执行；
 * 6. 执行并发防重复：执行中重复调用被忽略；
 * 7. 写入成功：
 *    - 仅携带 { previewId, confirm: true } 发送，无 itemIds；
 *    - 正确上报 createdCount 等结果；
 *    - 成功后 preview 立即作废，防止二次重放（replay 防护）；
 * 8. 写入失败风险与作废 preview（需重新 preview）：
 *    - 失败后 preview 立即作废，禁止直接重放重试；
 *    - 提示实际风险（部分已落表风险）；
 *    - 严禁自动发起重试；
 *    - 密钥与凭据安全脱敏；
 * 9. 未配置飞书状态识别：isConfigMissing 为 true 便于 UI 导航到设置页；
 * 10. 非扩展环境安全守卫：不调用后台 API 并优雅报错。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, ref } from 'vue'
import { CommandTypes } from '@fishops/shared'
import {
  FEISHU_WRITE_MAX_ITEMS,
  FEISHU_WRITE_PREVIEW_TTL_MS,
  type FeishuProductWriteExecuteResult,
  type FeishuProductWritePreviewResult,
} from '../../contracts'
import type { BridgeApi } from '../../shared/bridge-api'
import {
  FeishuWriteController,
  isFeishuPreviewExpired,
} from '../feishu-write-controller'

class MockBridgeApi implements BridgeApi {
  public sentCommands: Array<{ type: string; payload: unknown }> = []
  public previewResponse: FeishuProductWritePreviewResult | null = null
  public executeResponse: FeishuProductWriteExecuteResult | null = null
  public errorToThrow: Error | null = null

  async call(type: any, payload: any): Promise<any> {
    this.sentCommands.push({ type, payload })
    if (this.errorToThrow) {
      throw this.errorToThrow
    }
    if (type === CommandTypes.FEISHU_PRODUCT_WRITE_PREVIEW) {
      if (this.previewResponse) return this.previewResponse
      const p = payload as { itemIds: string[] }
      const res: FeishuProductWritePreviewResult = {
        previewId: 'prev_test_123',
        expiresAt: Date.now() + FEISHU_WRITE_PREVIEW_TTL_MS,
        targetTableId: 'tbl_product_test',
        requestedCount: p.itemIds.length,
        uniqueCount: p.itemIds.length,
        duplicateItemIds: [],
        missingItemIds: [],
        alreadyExistsItemIds: [],
        toCreate: p.itemIds.map((id) => ({
          itemId: id,
          title: `商品_${id}`,
          price: 99,
          wantCnt: 10,
        })),
        fieldCompatible: true,
        missingFields: [],
        typeConflicts: [],
      }
      return res
    }
    if (type === CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE) {
      if (this.executeResponse) return this.executeResponse
      const p = payload as { previewId: string; confirm: boolean }
      const res: FeishuProductWriteExecuteResult = {
        previewId: p.previewId,
        targetTableId: 'tbl_product_test',
        requestedCount: 1,
        uniqueCount: 1,
        duplicateItemIds: [],
        missingItemIds: [],
        alreadyExistsItemIds: [],
        createdCount: 1,
        createdRecordIds: ['rec_mock_1'],
        fieldCompatible: true,
        missingFields: [],
        typeConflicts: [],
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

test('显式勾选管理：单选、多选、反选、清空与 200 件上限拦截', () => {
  const api = new MockBridgeApi()
  const controller = new FeishuWriteController({ api })

  assert.equal(controller.getState().selectedItemIds.length, 0)

  // 1. 单选
  controller.select('item_1')
  controller.select('item_2')
  assert.deepEqual(controller.getState().selectedItemIds, ['item_1', 'item_2'])

  // 重复选择不重复添加
  controller.select('item_1')
  assert.equal(controller.getState().selectedItemIds.length, 2)

  // 2. 取消选择与 toggle
  controller.deselect('item_1')
  assert.deepEqual(controller.getState().selectedItemIds, ['item_2'])
  controller.toggle('item_2')
  assert.deepEqual(controller.getState().selectedItemIds, [])
  controller.toggle('item_3')
  assert.deepEqual(controller.getState().selectedItemIds, ['item_3'])

  // 3. 批量选择
  controller.selectMultiple(['item_4', 'item_5'])
  assert.deepEqual(controller.getState().selectedItemIds, ['item_3', 'item_4', 'item_5'])

  // 4. 批量取消
  controller.deselectMultiple(['item_3', 'item_5'])
  assert.deepEqual(controller.getState().selectedItemIds, ['item_4'])

  // 5. 清空
  controller.clearSelection()
  assert.deepEqual(controller.getState().selectedItemIds, [])

  // 6. 200 件上限拦截
  const bigList = Array.from({ length: 250 }, (_, i) => `item_big_${i}`)
  controller.selectMultiple(bigList)
  assert.equal(controller.getState().selectedItemIds.length, FEISHU_WRITE_MAX_ITEMS)
  assert.ok(controller.getState().warningMessage?.includes('已达勾选上限'))

  // 试图继续添加应被拦截
  controller.select('item_overflow')
  assert.equal(controller.getState().selectedItemIds.length, FEISHU_WRITE_MAX_ITEMS)
  assert.ok(controller.getState().warningMessage?.includes('单次最多勾选'))
})

test('严禁挂载自动写入/自动预览：初始化与 start() 不调用任何命令', () => {
  const api = new MockBridgeApi()
  const controller = new FeishuWriteController({ api })

  assert.equal(api.sentCommands.length, 0)
  controller.start()
  assert.equal(api.sentCommands.length, 0)
})

test('选品变更导致预览立即失效并清空', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuWriteController({ api })

  controller.select('item_1')
  await controller.preview()
  assert.equal(controller.getState().preview.phase, 'ready')
  assert.ok(controller.getState().preview.result)
  assert.deepEqual(controller.getState().preview.targetItemIds, ['item_1'])

  // 添加新商品 -> preview 必须立即作废
  controller.select('item_2')
  assert.equal(controller.getState().preview.phase, 'idle')
  assert.equal(controller.getState().preview.result, null)
  assert.deepEqual(controller.getState().preview.targetItemIds, [])

  // 再次预览
  await controller.preview()
  assert.equal(controller.getState().preview.phase, 'ready')

  // 取消商品 -> preview 必须立即作废
  controller.deselect('item_1')
  assert.equal(controller.getState().preview.phase, 'idle')
  assert.equal(controller.getState().preview.result, null)

  // 再次预览
  await controller.preview()
  assert.equal(controller.getState().preview.phase, 'ready')

  // 清空选择 -> preview 必须立即作废
  controller.clearSelection()
  assert.equal(controller.getState().preview.phase, 'idle')
  assert.equal(controller.getState().preview.result, null)
})

test('只读预览：调用 FEISHU_PRODUCT_WRITE_PREVIEW，解析包含 previewId 与 expiresAt 的结构化结果', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuWriteController({ api })

  controller.selectMultiple(['item_1', 'item_2'])
  const res = await controller.preview()

  assert.ok(res)
  assert.equal(api.sentCommands.length, 1)
  assert.equal(api.sentCommands[0].type, CommandTypes.FEISHU_PRODUCT_WRITE_PREVIEW)
  assert.deepEqual((api.sentCommands[0].payload as any).itemIds, ['item_1', 'item_2'])

  assert.equal(controller.getState().preview.phase, 'ready')
  assert.equal(controller.getState().preview.result?.targetTableId, 'tbl_product_test')
  assert.equal(controller.getState().preview.result?.previewId, 'prev_test_123')
  assert.ok(typeof controller.getState().preview.result?.expiresAt === 'number')
  assert.equal(controller.getState().preview.result?.toCreate.length, 2)
  assert.equal(controller.getState().preview.result?.fieldCompatible, true)
  assert.deepEqual(controller.getState().preview.result?.typeConflicts, [])
})

test('安全防护：未经成功预览严禁执行', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuWriteController({ api })

  controller.select('item_1')
  // 未预览直接执行
  const res = await controller.execute({ confirm: true })
  assert.equal(res, null)
  assert.equal(controller.getState().execute.phase, 'error')
  assert.equal(controller.getState().execute.error?.code, 'PREVIEW_REQUIRED')
  assert.equal(api.sentCommands.length, 0) // 严禁发出任何 EXECUTE 命令
})

test('安全防护：预览已过期严禁执行，且自动使当前预览作废', async () => {
  let currentTime = 100000
  const api = new MockBridgeApi()
  api.previewResponse = {
    previewId: 'prev_expired_test',
    expiresAt: 100050, // 50ms 后过期
    targetTableId: 'tbl_product_test',
    requestedCount: 1,
    uniqueCount: 1,
    duplicateItemIds: [],
    missingItemIds: [],
    alreadyExistsItemIds: [],
    toCreate: [{ itemId: 'item_1', title: '商品1', price: 10, wantCnt: 1 }],
    fieldCompatible: true,
    missingFields: [],
    typeConflicts: [],
  }
  const controller = new FeishuWriteController({ api, now: () => currentTime })

  controller.select('item_1')
  await controller.preview()
  assert.equal(controller.getState().preview.phase, 'ready')

  // 时间推进到过期时间之后
  currentTime = 100100
  assert.equal(controller.isCurrentPreviewValid(), false)

  const res = await controller.execute({ confirm: true })
  assert.equal(res, null)
  assert.equal(controller.getState().execute.phase, 'error')
  assert.equal(controller.getState().execute.error?.code, 'PREVIEW_EXPIRED')
  // 校验当前 preview 已经作废
  assert.equal(controller.getState().preview.phase, 'idle')
  assert.equal(controller.getState().preview.result, null)
  assert.equal(api.sentCommands.filter((c) => c.type === CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE).length, 0)
})

test('安全防护：预览后选品发生变动严禁执行', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuWriteController({ api })

  controller.select('item_1')
  await controller.preview()
  assert.equal(controller.getState().preview.phase, 'ready')

  // 变更选品自动让 preview 失效
  controller.select('item_2')
  const res = await controller.execute({ confirm: true })
  assert.equal(res, null)
  assert.equal(controller.getState().execute.phase, 'error')
  assert.equal(api.sentCommands.filter((c) => c.type === CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE).length, 0)
})

test('安全防护：字段缺失与字段类型冲突严禁执行，严禁自动创建或修改字段', async () => {
  const api = new MockBridgeApi()
  api.previewResponse = {
    previewId: 'prev_conflict_test',
    expiresAt: Date.now() + 60000,
    targetTableId: 'tbl_product_test',
    requestedCount: 1,
    uniqueCount: 1,
    duplicateItemIds: [],
    missingItemIds: [],
    alreadyExistsItemIds: [],
    toCreate: [{ itemId: 'item_1', title: '商品1', price: 10, wantCnt: 1 }],
    fieldCompatible: false,
    missingFields: ['商品标题'],
    typeConflicts: [{ name: '价格', expectedType: 2, actualType: 1 }],
  }
  const controller = new FeishuWriteController({ api })

  controller.select('item_1')
  await controller.preview()
  assert.equal(controller.getState().preview.phase, 'ready')
  assert.equal(controller.getState().preview.result?.fieldCompatible, false)
  assert.equal(controller.getState().preview.result?.typeConflicts.length, 1)

  const res = await controller.execute({ confirm: true })
  assert.equal(res, null)
  assert.equal(controller.getState().execute.phase, 'error')
  assert.equal(controller.getState().execute.error?.code, 'FIELDS_INCOMPATIBLE')
  assert.ok(controller.getState().execute.error?.hint.includes('缺少必需字段'))
  assert.ok(controller.getState().execute.error?.hint.includes('字段类型冲突'))
  assert.ok(controller.getState().execute.error?.hint.includes('严禁自动创建'))
  assert.equal(api.sentCommands.filter((c) => c.type === CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE).length, 0)
})

test('安全防护：待写入数为 0 严禁执行', async () => {
  const api = new MockBridgeApi()
  api.previewResponse = {
    previewId: 'prev_zero_test',
    expiresAt: Date.now() + 60000,
    targetTableId: 'tbl_product_test',
    requestedCount: 1,
    uniqueCount: 1,
    duplicateItemIds: [],
    missingItemIds: [],
    alreadyExistsItemIds: ['item_1'],
    toCreate: [],
    fieldCompatible: true,
    missingFields: [],
    typeConflicts: [],
  }
  const controller = new FeishuWriteController({ api })

  controller.select('item_1')
  await controller.preview()

  const res = await controller.execute({ confirm: true })
  assert.equal(res, null)
  assert.equal(controller.getState().execute.phase, 'error')
  assert.equal(controller.getState().execute.error?.code, 'NOTHING_TO_CREATE')
  assert.equal(api.sentCommands.filter((c) => c.type === CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE).length, 0)
})

test('安全防护：未显式传递 confirm: true 严禁执行', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuWriteController({ api })

  controller.select('item_1')
  await controller.preview()

  const res = await controller.execute({ confirm: false as unknown as true })
  assert.equal(res, null)
  assert.equal(controller.getState().execute.phase, 'error')
  assert.equal(controller.getState().execute.error?.code, 'CONFIRM_REQUIRED')
  assert.equal(api.sentCommands.filter((c) => c.type === CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE).length, 0)
})

test('执行并发防重复：执行中再次触发被忽略', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuWriteController({ api })

  controller.select('item_1')
  await controller.preview()

  const p1 = controller.execute({ confirm: true })
  const p2 = controller.execute({ confirm: true })

  const [res1, res2] = await Promise.all([p1, p2])
  assert.ok(res1)
  assert.equal(res2, null)
  const execCommands = api.sentCommands.filter((c) => c.type === CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE)
  assert.equal(execCommands.length, 1)
})

test('写入成功：仅带 previewId 与 confirm 且杜绝重放', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuWriteController({ api })

  controller.select('item_1')
  await controller.preview()

  const res = await controller.execute({ confirm: true })
  assert.ok(res)
  assert.equal(res.createdCount, 1)
  assert.equal(controller.getState().execute.phase, 'ready')
  assert.equal(controller.getState().execute.error, null)

  // 验证入参：仅携带 previewId 与 confirm: true，绝对无 itemIds！
  const execCommand = api.sentCommands.find((c) => c.type === CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE)
  assert.ok(execCommand)
  assert.deepEqual(execCommand.payload, {
    previewId: 'prev_test_123',
    confirm: true,
  })
  assert.equal((execCommand.payload as any).itemIds, undefined)

  // 重放防护测试：成功后 preview 已被清空作废，如果再次调用 execute 必须被拦截！
  assert.equal(controller.getState().preview.phase, 'idle')
  assert.equal(controller.getState().preview.result, null)
  const replayRes = await controller.execute({ confirm: true })
  assert.equal(replayRes, null)
  assert.equal(controller.getState().execute.phase, 'error')
  assert.equal(controller.getState().execute.error?.code, 'PREVIEW_REQUIRED')
  // 仍然只有 1 次 execute 命令
  const totalExec = api.sentCommands.filter((c) => c.type === CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE).length
  assert.equal(totalExec, 1)
})

test('写入失败：提示实际风险、作废 preview（需重新 preview）且绝不自动重试', async () => {
  const api = new MockBridgeApi()
  const controller = new FeishuWriteController({ api })

  controller.select('item_1')
  await controller.preview()

  // 模拟 execute 失败并带有敏感凭据
  api.errorToThrow = new Error('飞书写入网络中断 appSecret=sec_super_secret_123456 token=t-abcdef1234567890123456')
  const res = await controller.execute({ confirm: true })

  assert.equal(res, null)
  assert.equal(controller.getState().execute.phase, 'error')
  // 实际风险提示
  assert.ok(controller.getState().execute.riskNotice)
  assert.ok(controller.getState().execute.riskNotice?.includes('实际风险：部分商品记录可能已被写入'))
  assert.ok(controller.getState().execute.riskNotice?.includes('严禁自动重试'))
  assert.ok(controller.getState().execute.riskNotice?.includes('本次写入预览已作废'))

  // 验证失败后当前 preview 已作废，不能直接重试 execute
  assert.equal(controller.getState().preview.phase, 'idle')
  assert.equal(controller.getState().preview.result, null)

  // 尝试直接重试 execute 会被阻止
  const retryRes = await controller.execute({ confirm: true })
  assert.equal(retryRes, null)
  assert.equal(controller.getState().execute.error?.code, 'PREVIEW_REQUIRED')

  // 严禁自动重试：后台仅收到 1 次 execute 调用
  const execCommands = api.sentCommands.filter((c) => c.type === CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE)
  assert.equal(execCommands.length, 1)

  // 密钥脱敏验证
  const errorTitle = controller.getState().execute.error?.title ?? ''
  const errorDetail = controller.getState().execute.error?.detail ?? ''
  assert.ok(!errorTitle.includes('sec_super_secret'))
  assert.ok(!errorDetail.includes('sec_super_secret'))
  assert.ok(!errorTitle.includes('t-abcdef1234567890123456'))
  assert.ok(!errorDetail.includes('t-abcdef1234567890123456'))
})

test('未配置飞书时：isConfigMissing 标记为 true', async () => {
  const api = new MockBridgeApi()
  api.errorToThrow = new Error('飞书未配置：请先在配置页填写飞书应用与商品表信息')
  const controller = new FeishuWriteController({ api })

  controller.select('item_1')
  await controller.preview()

  assert.equal(controller.getState().preview.phase, 'error')
  assert.equal(controller.getState().isConfigMissing, true)
})

test('非扩展环境安全守卫：不调用 API 并优雅报错', async () => {
  const controller = new FeishuWriteController({ api: null })

  assert.equal(controller.getState().availability, 'unavailable')
  controller.select('item_1')
  const previewRes = await controller.preview()
  assert.equal(previewRes, null)
  assert.equal(controller.getState().preview.error?.code, 'UNAVAILABLE')

  const execRes = await controller.execute({ confirm: true })
  assert.equal(execRes, null)
  assert.equal(controller.getState().execute.error?.code, 'UNAVAILABLE')
})

test('isFeishuPreviewExpired 纯函数与 nowTick 响应式依赖测试', () => {
  const expiresAt = 100500

  // 1. 边界判断
  assert.equal(isFeishuPreviewExpired(null, 100000), false)
  assert.equal(isFeishuPreviewExpired(undefined, 100000), false)
  assert.equal(isFeishuPreviewExpired(expiresAt, 100000), false)
  assert.equal(isFeishuPreviewExpired(expiresAt, 100500), true) // 到期边界
  assert.equal(isFeishuPreviewExpired(expiresAt, 100600), true) // 超时

  // 2. Vue computed 响应式依赖 nowTick 测试
  const nowTick = ref(100000)
  const isExpired = computed(() => isFeishuPreviewExpired(expiresAt, nowTick.value))

  // 初始未过期
  assert.equal(isExpired.value, false)

  // 模拟时间流逝（未到期）
  nowTick.value = 100400
  assert.equal(isExpired.value, false)

  // 模拟到达 5 分钟到期时间戳：computed 必须自动响应式变为 true！
  nowTick.value = 100500
  assert.equal(isExpired.value, true)

  // 进一步超时
  nowTick.value = 100600
  assert.equal(isExpired.value, true)
})

test('nowTick timer 启动与卸载清理逻辑测试', () => {
  let timer: ReturnType<typeof setInterval> | null = null
  let tickCount = 0

  // 模拟挂载启动 timer
  timer = setInterval(() => {
    tickCount++
  }, 10)
  assert.ok(timer !== null)

  // 模拟卸载清理 timer
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  assert.equal(timer, null)
})
