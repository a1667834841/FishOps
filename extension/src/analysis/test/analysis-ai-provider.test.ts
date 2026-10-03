/**
 * 分析任务 AI 配置接入（全局 AiProviderConfig）回归测试。
 *
 * 验证：
 * 1. 未传 `modelConfig` 时，全局 AI 配置（baseUrl / model / timeoutMs / apiKey）对分析任务生效；
 * 2. 显式 `modelConfig` 合法覆盖优先于全局配置；
 * 3. 仅部分覆盖时，其余字段回退全局配置；
 * 4. `resolveLlmConfig` 合并逻辑（含空白视为未提供）；
 * 5. ANALYSIS_CREATE 对 `modelConfig` 的严格键白名单 / 类型校验；
 * 6. 失败 / 取消路径的任务结果与错误绝不泄露密钥。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAnalysisCreatePayload } from '@fishops/shared'
import { TaskManager } from '../../../../shared/task/index'
import { MemoryPromptRuleStore } from '../../../../shared/analysis/prompt-rule-store'
import type { DataSource } from '../../../../shared/data-source/data-source'
import type { Dataset } from '../../../../shared/types/dataset'
import type { AiProviderConfig } from '../../../../shared/types/reply'
import type { LlmCompletionRequest, LlmTransport } from '../llm-transport'
import { AnalysisService, resolveLlmConfig } from '../analysis-service'

const VALID_JSON = JSON.stringify({
  summary: 'iPad 市场整体需求旺盛',
  keyFindings: ['11寸 Pro 关注度高'],
  opportunities: ['配件捆绑'],
  risks: ['电池健康度争议'],
})

class MockDataSource implements DataSource {
  readonly type = 'feishu'
  readonly name = '飞书测试'

  async getSchema() {
    return { name: 'test', label: 'test', fields: [] }
  }

  async query(): Promise<Dataset> {
    return {
      schema: { name: 'test', label: 'test', fields: [] },
      total: 1,
      source: 'feishu',
      queriedAt: 1000,
      rows: [{ itemId: '101', title: 'iPad Pro', priceNumber: 4200, wantCnt: 88 }],
    }
  }
}

const PROVIDER: AiProviderConfig = {
  apiKey: 'sk-global-secret-value',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  timeoutMs: 12345,
}

/** 组装分析服务并捕获 LLM 请求。 */
function setup(llm: LlmTransport, getAiProvider?: () => AiProviderConfig | undefined) {
  const tasks = new TaskManager()
  const rules = new MemoryPromptRuleStore()
  const dataSources = new Map<string, DataSource>([['feishu', new MockDataSource()]])
  const service = new AnalysisService({
    tasks,
    rules,
    dataSources,
    llm,
    ...(getAiProvider === undefined ? {} : { getAiProvider }),
  })
  return { tasks, service }
}

/** 创建一个简单分析任务并执行。 */
async function runOnce(
  service: AnalysisService,
  payload: Parameters<AnalysisService['createTask']>[0] = {
    ruleId: 'rule_high_demand_low_competition',
    dataSourceType: 'feishu',
  },
) {
  const task = await service.createTask(payload)
  return service.executeTask(task.id)
}

test('AnalysisService: 未传 modelConfig 时全局 AiProviderConfig 生效', async () => {
  let captured: LlmCompletionRequest | undefined
  const llm: LlmTransport = {
    complete: async (request) => {
      captured = request
      return { success: true, content: VALID_JSON, modelUsed: request.model }
    },
  }
  const { service } = setup(llm, () => PROVIDER)

  const task = await runOnce(service)
  assert.equal(task.status, 'completed')
  assert.equal(captured?.apiKey, PROVIDER.apiKey)
  assert.equal(captured?.baseUrl, PROVIDER.baseUrl)
  assert.equal(captured?.model, PROVIDER.model)
  assert.equal(captured?.timeoutMs, PROVIDER.timeoutMs)
})

test('AnalysisService: 显式 modelConfig 合法覆盖优先于全局配置', async () => {
  let captured: LlmCompletionRequest | undefined
  const llm: LlmTransport = {
    complete: async (request) => {
      captured = request
      return { success: true, content: VALID_JSON, modelUsed: request.model }
    },
  }
  const { service } = setup(llm, () => PROVIDER)

  const task = await runOnce(service, {
    ruleId: 'rule_high_demand_low_competition',
    dataSourceType: 'feishu',
    modelConfig: {
      baseUrl: 'https://custom.example.com/v1',
      model: 'custom-model',
      timeoutMs: 999,
      temperature: 0.9,
      maxTokens: 1234,
    },
  })
  assert.equal(task.status, 'completed')
  assert.equal(captured?.baseUrl, 'https://custom.example.com/v1')
  assert.equal(captured?.model, 'custom-model')
  assert.equal(captured?.timeoutMs, 999)
  assert.equal(captured?.temperature, 0.9)
  assert.equal(captured?.maxTokens, 1234)
  // 密钥不来自 modelConfig，仍从全局 provider 注入。
  assert.equal(captured?.apiKey, PROVIDER.apiKey)
})

test('AnalysisService: 部分 modelConfig 覆盖时其余回退全局配置', async () => {
  let captured: LlmCompletionRequest | undefined
  const llm: LlmTransport = {
    complete: async (request) => {
      captured = request
      return { success: true, content: VALID_JSON, modelUsed: request.model }
    },
  }
  const { service } = setup(llm, () => PROVIDER)

  await runOnce(service, {
    ruleId: 'rule_high_demand_low_competition',
    dataSourceType: 'feishu',
    modelConfig: { model: 'only-model-override' },
  })
  assert.equal(captured?.model, 'only-model-override')
  assert.equal(captured?.baseUrl, PROVIDER.baseUrl)
  assert.equal(captured?.timeoutMs, PROVIDER.timeoutMs)
})

test('resolveLlmConfig: 合并优先级与空白处理', () => {
  assert.deepEqual(resolveLlmConfig(undefined, PROVIDER), {
    apiKey: PROVIDER.apiKey,
    baseUrl: PROVIDER.baseUrl,
    model: PROVIDER.model,
    timeoutMs: PROVIDER.timeoutMs,
  })
  assert.deepEqual(resolveLlmConfig({ baseUrl: 'https://x.example/v1' }, PROVIDER), {
    apiKey: PROVIDER.apiKey,
    baseUrl: 'https://x.example/v1',
    model: PROVIDER.model,
    timeoutMs: PROVIDER.timeoutMs,
  })
  // 空白字符串视为未提供，回退全局 / 缺省。
  assert.deepEqual(resolveLlmConfig({ baseUrl: '   ', model: '  ' }, PROVIDER), {
    apiKey: PROVIDER.apiKey,
    baseUrl: PROVIDER.baseUrl,
    model: PROVIDER.model,
    timeoutMs: PROVIDER.timeoutMs,
  })
  // 无全局配置且无覆盖：返回空对象，交由传输层默认。
  assert.deepEqual(resolveLlmConfig(undefined, undefined), {})
})

test('isAnalysisCreatePayload: modelConfig 严格键白名单与类型 / 边界校验', () => {
  const base = { ruleId: 'r', dataSourceType: 'local' }
  assert.equal(
    isAnalysisCreatePayload({
      ...base,
      modelConfig: { baseUrl: 'https://x/v1', model: 'm', temperature: 0.5, maxTokens: 100, timeoutMs: 1000 },
    }),
    true,
  )
  assert.equal(isAnalysisCreatePayload({ ...base, modelConfig: {} }), false)
  assert.equal(isAnalysisCreatePayload({ ...base, modelConfig: { evil: 1 } }), false)
  assert.equal(isAnalysisCreatePayload({ ...base, modelConfig: { baseUrl: 'https://x/v1', evil: 1 } }), false)
  assert.equal(isAnalysisCreatePayload({ ...base, modelConfig: { baseUrl: '' } }), false)
  assert.equal(isAnalysisCreatePayload({ ...base, modelConfig: { model: '   ' } }), false)
  assert.equal(isAnalysisCreatePayload({ ...base, modelConfig: { temperature: 3 } }), false)
  assert.equal(isAnalysisCreatePayload({ ...base, modelConfig: { maxTokens: 0 } }), false)
  assert.equal(isAnalysisCreatePayload({ ...base, modelConfig: { maxTokens: 1.5 } }), false)
  assert.equal(isAnalysisCreatePayload({ ...base, modelConfig: { timeoutMs: 0 } }), false)
  assert.equal(isAnalysisCreatePayload({ ...base, modelConfig: { timeoutMs: 999_999_999 } }), false)
  // 非对象 customInstructions 拒绝。
  assert.equal(isAnalysisCreatePayload({ ...base, customInstructions: 123 }), false)
})

test('AnalysisService: LLM 失败路径任务结果绝不泄露密钥', async () => {
  const llm: LlmTransport = {
    complete: async () => ({
      success: false,
      errorCode: 'HTTP_ERROR',
      error: 'AI 接口 HTTP 错误 (401): Unauthorized',
    }),
  }
  const { service } = setup(llm, () => PROVIDER)

  const task = await runOnce(service)
  assert.equal(task.status, 'failed')
  const serialized = JSON.stringify(task)
  assert.equal(serialized.includes(PROVIDER.apiKey), false)
  assert.equal(serialized.includes(PROVIDER.baseUrl), false)
})

test('AnalysisService: 取消路径任务结果绝不泄露密钥', async () => {
  const llm: LlmTransport = {
    complete: (request) =>
      new Promise((resolve) => {
        request.signal?.addEventListener('abort', () =>
          resolve({ success: false, errorCode: 'CANCELLED', error: '分析任务已取消' }),
        )
      }),
  }
  const { tasks, service } = setup(llm, () => PROVIDER)

  const task = await service.createTask({ ruleId: 'rule_high_demand_low_competition', dataSourceType: 'feishu' })
  const runPromise = service.executeTask(task.id)
  await new Promise((resolve) => setTimeout(resolve, 10))
  await service.cancelTask(task.id, '用户取消')
  await runPromise

  const finalTask = await tasks.getById(task.id)
  assert.equal(finalTask?.status, 'cancelled')
  assert.equal(JSON.stringify(finalTask).includes(PROVIDER.apiKey), false)
})
