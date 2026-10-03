/**
 * AnalysisService 单元测试。
 *
 * 验证：
 * 1. 正常分析任务生命周期（pending -> running -> completed）；
 * 2. 结构化 JSON 输出校验（剥离 Markdown，验证必填字段）；
 * 3. LLM 异常情况下的结构化失败（超时、非法 JSON、非 2xx 报错）；
 * 4. 任务手动取消（cancelTask）与中断 inflight LLM 请求。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TaskManager } from '../../../../shared/task/index'
import { MemoryPromptRuleStore } from '../../../../shared/analysis/prompt-rule-store'
import type { DataSource } from '../../../../shared/data-source/data-source'
import type { Dataset } from '../../../../shared/types/dataset'
import type { LlmCompletionRequest, LlmCompletionResult, LlmTransport } from '../llm-transport'
import { AnalysisService } from '../analysis-service'

class MockDataSource implements DataSource {
  readonly type = 'feishu'
  readonly name = '飞书测试'

  async getSchema() {
    return { name: 'test', label: 'test', fields: [] }
  }

  async query(): Promise<Dataset> {
    return {
      schema: { name: 'test', label: 'test', fields: [] },
      total: 2,
      source: 'feishu',
      queriedAt: 1000,
      rows: [
        { itemId: '101', title: 'iPad Pro 11寸 256G', priceNumber: 4200, wantCnt: 88, sellerCity: '深圳' },
        { itemId: '102', title: 'iPad Air 5 64G', priceNumber: 3100, wantCnt: 50, sellerCity: '广州' },
      ],
    }
  }
}

test('AnalysisService: 正常分析任务生命周期与结构化 JSON 解析', async () => {
  const tasks = new TaskManager()
  const rules = new MemoryPromptRuleStore()
  const dataSources = new Map<string, DataSource>([['feishu', new MockDataSource()]])

  const validJsonOutput = JSON.stringify({
    summary: 'iPad 市场整体需求旺盛，Pro 系列保值率高',
    keyFindings: ['11寸 Pro 关注度高', '价格集中在 3000~4500 元'],
    priceAnalysis: {
      avgPrice: 3650,
      medianPrice: 3650,
      priceRange: '¥3100 - ¥4200',
      recommendation: '成色良好建议定价 ¥3999',
    },
    opportunities: ['快充配件捆绑销售'],
    risks: ['电池健康度争议'],
  })

  // 模拟返回带 Markdown 代码块包装的 JSON
  const mockLlm: LlmTransport = {
    complete: async () => ({
      success: true,
      content: `\`\`\`json\n${validJsonOutput}\n\`\`\``,
      modelUsed: 'gpt-4o-mini',
      usage: { promptTokens: 200, completionTokens: 100, totalTokens: 300 },
    }),
  }

  const service = new AnalysisService({
    tasks,
    rules,
    dataSources,
    llm: mockLlm,
  })

  // 1. 创建任务
  const task = await service.createTask({
    ruleId: 'rule_high_demand_low_competition',
    dataSourceType: 'feishu',
  })
  assert.equal(task.type, 'analysis')
  assert.equal(task.status, 'pending')

  // 2. 执行任务
  const completedTask = await service.executeTask(task.id)
  assert.equal(completedTask.status, 'completed')
  assert.equal(completedTask.progress, 100)

  const result = completedTask.result as unknown as { output: { summary: string; opportunities: string[] } }
  assert.notEqual(result, undefined)
  assert.equal(result.output.summary, 'iPad 市场整体需求旺盛，Pro 系列保值率高')
  assert.equal(result.output.opportunities[0], '快充配件捆绑销售')
})

test('AnalysisService: LLM 输出非法 JSON 时任务置为 failed（不假成功）', async () => {
  const tasks = new TaskManager()
  const rules = new MemoryPromptRuleStore()
  const dataSources = new Map<string, DataSource>([['feishu', new MockDataSource()]])

  const mockLlm: LlmTransport = {
    complete: async () => ({
      success: true,
      content: '不好意思，我是 AI，我没有生成合法 JSON 格式的数据...',
    }),
  }

  const service = new AnalysisService({ tasks, rules, dataSources, llm: mockLlm })
  const task = await service.createTask({
    ruleId: 'rule_high_demand_low_competition',
    dataSourceType: 'feishu',
  })

  const failedTask = await service.executeTask(task.id)
  assert.equal(failedTask.status, 'failed')
  assert.equal(failedTask.error?.includes('无法解析为合法 JSON'), true)
})

test('AnalysisService: LLM 超时时任务置为 failed', async () => {
  const tasks = new TaskManager()
  const rules = new MemoryPromptRuleStore()
  const dataSources = new Map<string, DataSource>([['feishu', new MockDataSource()]])

  const mockLlm: LlmTransport = {
    complete: async () => ({
      success: false,
      errorCode: 'TIMEOUT',
      error: 'AI 请求超时 (30000ms)',
    }),
  }

  const service = new AnalysisService({ tasks, rules, dataSources, llm: mockLlm })
  const task = await service.createTask({
    ruleId: 'rule_high_demand_low_competition',
    dataSourceType: 'feishu',
  })

  const failedTask = await service.executeTask(task.id)
  assert.equal(failedTask.status, 'failed')
  assert.equal(failedTask.error?.includes('超时'), true)
})

test('AnalysisService: 手动取消任务（cancelTask）中断执行中的 LLM 请求', async () => {
  const tasks = new TaskManager()
  const rules = new MemoryPromptRuleStore()
  const dataSources = new Map<string, DataSource>([['feishu', new MockDataSource()]])

  let abortedSignalReceived = false

  const mockLlm: LlmTransport = {
    complete: async (req: LlmCompletionRequest): Promise<LlmCompletionResult> => {
      return new Promise<LlmCompletionResult>((resolve) => {
        req.signal?.addEventListener('abort', () => {
          abortedSignalReceived = true
          resolve({
            success: false,
            errorCode: 'CANCELLED',
            error: '任务已取消',
          })
        })
      })
    },
  }

  const service = new AnalysisService({ tasks, rules, dataSources, llm: mockLlm })
  const task = await service.createTask({
    ruleId: 'rule_high_demand_low_competition',
    dataSourceType: 'feishu',
  })

  // 启动后台执行
  const runPromise = service.executeTask(task.id)

  // 稍作等待后主动取消
  await new Promise((resolve) => setTimeout(resolve, 10))
  const cancelledTask = await service.cancelTask(task.id, '用户主动终止')

  assert.equal(cancelledTask.status, 'cancelled')
  await runPromise
  assert.equal(abortedSignalReceived, true)

  const finalTask = await tasks.getById(task.id)
  assert.equal(finalTask?.status, 'cancelled')
})

test('AnalysisService: createTask 纵深拒绝非 feishu 数据源（防绕过 runtime）', async () => {
  const tasks = new TaskManager()
  const rules = new MemoryPromptRuleStore()
  // 即便 local 仍在注册表中，service 层也必须拒绝。
  const dataSources = new Map<string, DataSource>([['feishu', new MockDataSource()]])
  const service = new AnalysisService({
    tasks,
    rules,
    dataSources,
    llm: { complete: async () => ({ success: true, content: '{}' }) },
  })

  await assert.rejects(
    () => service.createTask({ ruleId: 'rule_high_demand_low_competition', dataSourceType: 'local' }),
    /只以飞书表格为准/,
  )
})

test('AnalysisService: executeTask 纵深拒绝 non-feishu 有效负载（防本地数据入 LLM）', async () => {
  const tasks = new TaskManager()
  const rules = new MemoryPromptRuleStore()
  const dataSources = new Map<string, DataSource>([['feishu', new MockDataSource()]])
  let llmCalled = false
  const service = new AnalysisService({
    tasks,
    rules,
    dataSources,
    llm: {
      complete: async () => {
        llmCalled = true
        return { success: true, content: '{}' }
      },
    },
  })

  // 绕过 createTask 直接写入 local 有效负载的任务，executeTask 必须失败且绝不调用 LLM。
  const task = await tasks.create({
    type: 'analysis',
    payload: { ruleId: 'rule_high_demand_low_competition', dataSourceType: 'local' },
  })
  const failedTask = await service.executeTask(task.id)
  assert.equal(failedTask.status, 'failed')
  assert.equal(failedTask.error?.includes('只以飞书表格为准'), true)
  assert.equal(llmCalled, false)
})
