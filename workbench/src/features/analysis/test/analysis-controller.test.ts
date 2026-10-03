/**
 * AnalysisController 单元测试：
 * 验证数据分析以飞书多维表格为准：
 * 1. 禁用/隐藏 local 数据源，默认且仅选择 feishu 数据源；
 * 2. 未配置飞书时明确阻止启动分析；
 * 3. 分析任务强制 dataSourceType='feishu'；
 * 4. 飞书目标商品表变更时触发告警提示并支持关闭。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes } from '@fishops/shared'
import type { BridgeApi } from '../../shared/bridge-api'
import { AnalysisController } from '../analysis-controller'

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
    return {}
  }

  on(): () => void {
    return () => {}
  }

  resubscribe(): void {}
  dispose(): void {}
}

test('AnalysisController: 数据分析只认 feishu，禁用/忽略 local 数据源', async () => {
  const api = new MockBridgeApi()
  // 后台即便同时返回 local 与 feishu
  api.respond(CommandTypes.DATA_SOURCE_LIST, () => ({
    dataSources: [
      { type: 'local', name: '本地商品库' },
      { type: 'feishu', name: '飞书多维表格' },
    ],
  }))
  api.respond(CommandTypes.DATA_SOURCE_SCHEMA, (payload: any) => {
    assert.equal(payload.type, 'feishu')
    return {
      schema: {
        name: 'feishu_bitable',
        label: '飞书多维表格',
        description: '多维表格 app=app_123, table=tbl_prod_1',
        fields: [{ name: '商品ID', label: '商品ID', type: 'string' }],
      },
    }
  })
  api.respond(CommandTypes.PROMPT_RULE_LIST, () => ({
    rules: [
      {
        id: 'r1',
        name: '默认分析规则',
        systemPrompt: 'sys',
        userPromptTemplate: 'tpl',
        variables: ['dataset'],
      },
    ],
  }))
  api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [] }))

  const controller = new AnalysisController({ api })
  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  // 严格自动选择 feishu 数据源
  assert.equal(controller.getState().sourceType, 'feishu')
  assert.equal(controller.getState().targetTable.currentTableId, 'tbl_prod_1')

  // 试图手动选择 local 数据源被拒绝
  await controller.selectSource('local')
  assert.equal(controller.getState().sourceType, 'feishu')
})

test('AnalysisController: 未配置飞书时明确阻止启动分析任务', async () => {
  const api = new MockBridgeApi()
  // 仅有 local 或空数据源（未配置飞书）
  api.respond(CommandTypes.DATA_SOURCE_LIST, () => ({
    dataSources: [{ type: 'local', name: '本地商品库' }],
  }))
  api.respond(CommandTypes.PROMPT_RULE_LIST, () => ({
    rules: [{ id: 'r1', name: '规则', systemPrompt: 's', userPromptTemplate: 'u', variables: [] }],
  }))
  api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [] }))

  const controller = new AnalysisController({ api })
  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  // 未检测到 feishu 数据源，sourceType 置为 null
  assert.equal(controller.getState().sourceType, null)

  const started = await controller.startAnalysis({
    ruleId: 'r1',
    filter: {},
    sampleLimit: 10,
  })

  // 必须明确阻止并报错
  assert.equal(started, false)
  assert.equal(controller.getState().task.create.phase, 'failed')
  assert.ok(controller.getState().task.create.error?.title.includes('未配置飞书多维表格'))
  assert.equal(api.calls.some((c) => c.type === CommandTypes.ANALYSIS_CREATE), false)
})

test('AnalysisController: 启动分析强制发送 dataSourceType=feishu', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.DATA_SOURCE_LIST, () => ({
    dataSources: [{ type: 'feishu', name: '飞书多维表格' }],
  }))
  api.respond(CommandTypes.DATA_SOURCE_SCHEMA, () => ({
    schema: {
      name: 'feishu',
      label: '飞书',
      description: '多维表格 app=app_1, table=tbl_main',
      fields: [],
    },
  }))
  api.respond(CommandTypes.PROMPT_RULE_LIST, () => ({
    rules: [{ id: 'r1', name: '规则', systemPrompt: 's', userPromptTemplate: 'u', variables: [] }],
  }))
  api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [] }))
  api.respond(CommandTypes.ANALYSIS_CREATE, (payload: any) => {
    assert.equal(payload.dataSourceType, 'feishu')
    return {
      task: {
        id: 'task_feishu_1',
        type: 'analysis',
        status: 'pending',
        updatedAt: 1000,
      },
    }
  })

  const controller = new AnalysisController({ api })
  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  const ok = await controller.startAnalysis({
    ruleId: 'r1',
    filter: { keyword: 'iphone' },
    sampleLimit: 20,
  })

  assert.equal(ok, true)
  const createCall = api.calls.find((c) => c.type === CommandTypes.ANALYSIS_CREATE)
  assert.ok(createCall)
  assert.equal((createCall?.payload as any).dataSourceType, 'feishu')
})

test('AnalysisController: 飞书目标表变更时提示并允许关闭通知', async () => {
  const api = new MockBridgeApi()
  let currentTable = 'tbl_old'

  api.respond(CommandTypes.DATA_SOURCE_LIST, () => ({
    dataSources: [{ type: 'feishu', name: '飞书多维表格' }],
  }))
  api.respond(CommandTypes.DATA_SOURCE_SCHEMA, () => ({
    schema: {
      name: 'feishu',
      label: '飞书',
      description: `多维表格 app=app_1, table=${currentTable}`,
      fields: [],
    },
  }))
  api.respond(CommandTypes.PROMPT_RULE_LIST, () => ({ rules: [] }))
  api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [] }))

  const controller = new AnalysisController({ api })
  controller.start()
  await new Promise((r) => setTimeout(r, 20))

  assert.equal(controller.getState().targetTable.currentTableId, 'tbl_old')
  assert.equal(controller.getState().targetTable.changed, false)

  // 飞书目标表格发生变更并刷新 schema
  currentTable = 'tbl_new'
  await controller.reloadSchema()

  assert.equal(controller.getState().targetTable.currentTableId, 'tbl_new')
  assert.equal(controller.getState().targetTable.previousTableId, 'tbl_old')
  assert.equal(controller.getState().targetTable.changed, true)
  assert.ok(controller.getState().targetTable.changeMessage?.includes('tbl_old'))
  assert.ok(controller.getState().targetTable.changeMessage?.includes('tbl_new'))

  // 用户点击关闭通知
  controller.dismissTableChangeNotice()
  assert.equal(controller.getState().targetTable.changed, false)
  assert.equal(controller.getState().targetTable.changeMessage, null)
})
