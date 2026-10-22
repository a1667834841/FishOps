/**
 * AnalysisRuntime 协议集成与命令测试。
 *
 * 验证：
 * 1. DATA_SOURCE_LIST / SCHEMA / QUERY 命令；
 * 2. PROMPT_RULE_LIST / UPSERT / DELETE 命令；
 * 3. ANALYSIS_CREATE / GET / CANCEL / RESULT_GET 命令；
 * 4. 任务变更 TASK_CHANGED 事件推送；
 * 5. 非法负载校验拦截。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandTypes,
  createCommand,
  type CommandEnvelope,
} from '@fishops/shared'
import { TaskManager } from '../../../../shared/task/index'
import { createMemoryProductRepository } from '../../../../shared/capture/product-repository'
import type { DataSource } from '../../../../shared/data-source/data-source'
import {
  createAnalysisRuntime,
  type AnalysisEventEnvelope,
} from '../../background/analysis-runtime'
import type { LlmTransport } from '../llm-transport'

test('AnalysisRuntime: 数据源（仅飞书对外）与规则协议命令', async () => {
  const runtime = createAnalysisRuntime({})
  await runtime.init()

  // 注册飞书数据源（模拟）：用于验证对外列表仅暴露 feishu。
  const feishuSource: DataSource = {
    type: 'feishu',
    name: '飞书多维表格',
    async getSchema() {
      return { name: 'feishu', label: '飞书', fields: [] }
    },
    async query() {
      return {
        source: 'feishu',
        queriedAt: 1000,
        schema: { name: 'feishu', label: '飞书', fields: [] },
        rows: [{ '商品ID': 'item_1', '商品标题': '测试商品' }],
        total: 1,
      }
    },
  }
  runtime.registerDataSource(feishuSource)

  // 1. DATA_SOURCE_LIST：仅 feishu，绝不暴露 local
  const cmdList = createCommand(CommandTypes.DATA_SOURCE_LIST, {})
  const resList = await runtime.handleCommand(cmdList as CommandEnvelope)
  assert.equal(resList.ok, true)
  const listResult = resList.result as { dataSources: Array<{ type: string }> }
  assert.equal(listResult.dataSources.some((d) => d.type === 'feishu'), true)
  assert.equal(listResult.dataSources.some((d) => d.type === 'local'), false)

  // 2. DATA_SOURCE_SCHEMA(feishu) 放行
  const cmdSchema = createCommand(CommandTypes.DATA_SOURCE_SCHEMA, { type: 'feishu' })
  const resSchema = await runtime.handleCommand(cmdSchema as CommandEnvelope)
  assert.equal(resSchema.ok, true)

  // 3. DATA_SOURCE_QUERY(feishu) 放行
  const cmdQuery = createCommand(CommandTypes.DATA_SOURCE_QUERY, {
    type: 'feishu',
    filter: { keyword: '测试' },
  })
  const resQuery = await runtime.handleCommand(cmdQuery as CommandEnvelope)
  assert.equal(resQuery.ok, true)
  const queryResult = resQuery.result as { dataset: { total: number } }
  assert.equal(queryResult.dataset.total, 1)

  // 4. DATA_SOURCE_SCHEMA(local) 后台结构化拒绝（仅飞书）
  const cmdSchemaLocal = createCommand(CommandTypes.DATA_SOURCE_SCHEMA, { type: 'local' })
  const resSchemaLocal = await runtime.handleCommand(cmdSchemaLocal as CommandEnvelope)
  assert.equal(resSchemaLocal.ok, false)
  assert.equal(resSchemaLocal.error?.code, 'INVALID_PAYLOAD')

  // 5. DATA_SOURCE_QUERY(local) 后台结构化拒绝（仅飞书）
  const cmdQueryLocal = createCommand(CommandTypes.DATA_SOURCE_QUERY, {
    type: 'local',
    filter: { keyword: '测试' },
  })
  const resQueryLocal = await runtime.handleCommand(cmdQueryLocal as CommandEnvelope)
  assert.equal(resQueryLocal.ok, false)
  assert.equal(resQueryLocal.error?.code, 'INVALID_PAYLOAD')

  // 6. PROMPT_RULE_LIST
  const cmdRules = createCommand(CommandTypes.PROMPT_RULE_LIST, {})
  const resRules = await runtime.handleCommand(cmdRules as CommandEnvelope)
  assert.equal(resRules.ok, true)

  // 7. PROMPT_RULE_UPSERT
  const cmdUpsert = createCommand(CommandTypes.PROMPT_RULE_UPSERT, {
    rule: {
      id: 'custom_r',
      name: '自定义规则',
      systemPrompt: 'System',
      userPromptTemplate: '{{dataset}}',
      variables: ['dataset'],
      createdAt: 1000,
      updatedAt: 1000,
    },
  })
  const resUpsert = await runtime.handleCommand(cmdUpsert as CommandEnvelope)
  assert.equal(resUpsert.ok, true)

  // 8. PROMPT_RULE_DELETE
  const cmdDelete = createCommand(CommandTypes.PROMPT_RULE_DELETE, { id: 'custom_r' })
  const resDelete = await runtime.handleCommand(cmdDelete as CommandEnvelope)
  assert.equal(resDelete.ok, true)
})

test('AnalysisRuntime: 分析任务创建、查询与事件推送', async () => {
  const events: AnalysisEventEnvelope[] = []
  const mockLlm: LlmTransport = {
    complete: async () => ({
      success: true,
      content: JSON.stringify({
        summary: '分析总结',
        keyFindings: ['点1'],
        opportunities: ['机会1'],
        risks: ['风险1'],
      }),
    }),
  }

  const repo = createMemoryProductRepository()
  await repo.upsertProducts(
    [
      {
        itemId: 'i1',
        title: '测试商品',
        price: '10',
        priceNumber: 10,
        originalPrice: '20',
        originalPriceNumber: 20,
        wantCnt: 5,
        publishTime: '刚刚',
        publishTimeMs: 1000,
        captureTime: '刚刚',
        captureTimeMs: 1000,
        sellerNick: 'nick',
        sellerCity: '北京',
        freeShip: '是',
        tags: 'tag',
        coverUrl: 'url',
        detailUrl: 'url',
      },
    ],
    1000,
  )

  const runtime = createAnalysisRuntime({
    repository: repo,
    llm: mockLlm,
    onEvent: (evt) => events.push(evt),
  })
  await runtime.init()

  // 1. ANALYSIS_CREATE 拒绝 local 数据源
  const createLocalCmd = createCommand(CommandTypes.ANALYSIS_CREATE, {
    ruleId: 'rule_high_demand_low_competition',
    dataSourceType: 'local',
  })
  const createLocalRes = await runtime.handleCommand(createLocalCmd as CommandEnvelope)
  assert.equal(createLocalRes.ok, false)
  assert.equal(createLocalRes.error?.code, 'INVALID_PAYLOAD')

  // 2. 未配置飞书数据源时明确阻止
  const createFeishuWithoutConfigCmd = createCommand(CommandTypes.ANALYSIS_CREATE, {
    ruleId: 'rule_high_demand_low_competition',
    dataSourceType: 'feishu',
  })
  const createBlockedRes = await runtime.handleCommand(createFeishuWithoutConfigCmd as CommandEnvelope)
  assert.equal(createBlockedRes.ok, false)
  assert.equal(createBlockedRes.error?.businessCode, 'CONFIG_MISSING')

  // 3. 注册飞书数据源后成功创建分析任务
  runtime.registerDataSource({
    type: 'feishu',
    name: '飞书多维表格',
    async getSchema() {
      return { name: 'feishu', label: '飞书', fields: [] }
    },
    async query() {
      return {
        source: 'feishu',
        queriedAt: 1000,
        schema: { name: 'feishu', label: '飞书', fields: [] },
        rows: [{ '商品ID': 'i1', '商品标题': '测试商品' }],
        total: 1,
      }
    },
  })

  const createCmd = createCommand(CommandTypes.ANALYSIS_CREATE, {
    ruleId: 'rule_high_demand_low_competition',
    dataSourceType: 'feishu',
  })
  const createRes = await runtime.handleCommand(createCmd as CommandEnvelope)
  assert.equal(createRes.ok, true)
  const task = (createRes.result as { task: { id: string; status: string } }).task
  assert.equal(task.status, 'pending')

  // 等待异步分析执行完毕
  await new Promise((r) => setTimeout(r, 60))

  // 4. ANALYSIS_GET
  const getCmd = createCommand(CommandTypes.ANALYSIS_GET, { id: task.id })
  const getRes = await runtime.handleCommand(getCmd as CommandEnvelope)
  assert.equal(getRes.ok, true)
  const fetchedTask = (getRes.result as { task: { status: string } }).task
  assert.equal(fetchedTask.status, 'completed')

  // 5. ANALYSIS_RESULT_GET
  const getResultCmd = createCommand(CommandTypes.ANALYSIS_RESULT_GET, { id: task.id })
  const resResult = await runtime.handleCommand(getResultCmd as CommandEnvelope)
  assert.equal(resResult.ok, true)
  const finalResult = resResult.result as { result?: { output: { summary: string } } }
  assert.equal(finalResult.result?.output.summary, '分析总结')

  // 验证事件广播到了 onEvent（TASK_CHANGED）
  assert.equal(events.length > 0, true)
  assert.equal(events[0]?.type, 'TASK_CHANGED')
})

test('AnalysisRuntime: 启动恢复把 running 任务置为 failed', async () => {
  const tasks = new TaskManager()
  // 创建一个任务并手动启动到 running
  const task = await tasks.create({
    type: 'analysis',
    payload: { ruleId: 'r1', dataSourceType: 'local' },
  })
  await tasks.start(task.id)

  const runtime = createAnalysisRuntime({ tasks })
  await runtime.init()

  const restored = await tasks.getById(task.id)
  assert.equal(restored?.status, 'failed')
  assert.equal(restored?.error?.includes('Service Worker 重启'), true)
})
