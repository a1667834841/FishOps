/**
 * 数据分析服务（AnalysisService）（P7）。
 *
 * 核心流程：
 * 1. 接入 TaskManager 管理 analysis 类型任务（pending/running/completed/failed/cancelled）；
 * 2. 从指定数据源（Local 或 Feishu）查询原始数据集；
 * 3. 聚合统计指标（均价、中位数、想要数分布、Top城市/标签）；
 * 4. 分层抽样并应用白名单脱敏（手机号、微信号、字符长度受限）；
 * 5. 渲染 PromptRule 模板，带超时与取消控制调用 LLM；
 * 6. 严格校验结构化 JSON 输出，非法输出、网络错误、超时与取消均记录结构化失败；
 * 7. 任务完成写入结果，或失败记录原因，通过 TaskManager 事件总线驱动。
 */
import type { Task, TaskManager } from '../../../shared/task/index'
import type {
  AnalysisModelConfig,
  AnalysisPayload,
  AnalysisResult,
  AnalysisStructuredOutput,
} from '../../../shared/types/analysis'
import type { AiProviderConfig } from '../../../shared/types/reply'
import type { DataSource } from '../../../shared/data-source/data-source'
import type { PromptRuleStore } from '../../../shared/analysis/prompt-rule-store'
import {
  aggregateDataset,
  formatDatasetSummary,
  renderPromptTemplate,
  sampleDataset,
} from '../../../shared/analysis/dataset-processor'
import type { LlmTransport } from './llm-transport'

export interface AnalysisServiceDeps {
  tasks: TaskManager
  rules: PromptRuleStore
  dataSources: Map<string, DataSource>
  llm: LlmTransport
  /** 获取当前 API Key（动态获取，不持久化在规则中）。 */
  getApiKey?: () => Promise<string | undefined> | string | undefined
  /**
   * 获取全局 AI 供应方配置（含 apiKey / baseUrl / model / timeoutMs）。
   * 优先级高于传输层默认值，但**低于**任务显式 `modelConfig` 覆盖。
   * 凭据只用于请求层，绝不写入任务 / 结果 / 事件 / 日志。
   */
  getAiProvider?: () => Promise<AiProviderConfig | undefined> | AiProviderConfig | undefined
  now?: () => number
}

/** 已解析的 LLM 请求参数（已合并显式覆盖 / 全局配置 / 传输层默认）。 */
export interface ResolvedLlmConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

/** 取去空白后的非空字符串；空串 / 空白视为未提供。 */
function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * 合并显式 `modelConfig` 与全局 AI 供应方配置。
 *
 * 优先级：显式且非空的 `modelConfig` 字段 > 全局 `provider` 字段 > 传输层默认（返回 undefined 项）。
 * `apiKey` 不来自 `modelConfig`（其类型不含密钥），仅从全局 provider 注入。
 * temperature / maxTokens 仅支持任务级覆盖（全局配置不含这两项）。
 */
export function resolveLlmConfig(
  modelConfig: AnalysisModelConfig | undefined,
  provider: AiProviderConfig | undefined,
): ResolvedLlmConfig {
  const resolved: ResolvedLlmConfig = {}

  const apiKey = nonEmptyString(provider?.apiKey)
  if (apiKey) resolved.apiKey = apiKey

  const baseUrl = nonEmptyString(modelConfig?.baseUrl) ?? nonEmptyString(provider?.baseUrl)
  if (baseUrl) resolved.baseUrl = baseUrl

  const model = nonEmptyString(modelConfig?.model) ?? nonEmptyString(provider?.model)
  if (model) resolved.model = model

  if (modelConfig?.temperature !== undefined) resolved.temperature = modelConfig.temperature
  if (modelConfig?.maxTokens !== undefined) resolved.maxTokens = modelConfig.maxTokens

  const timeoutMs = modelConfig?.timeoutMs ?? provider?.timeoutMs
  if (timeoutMs !== undefined && timeoutMs > 0) resolved.timeoutMs = timeoutMs

  return resolved
}

export class AnalysisService {
  private readonly tasks: TaskManager
  private readonly rules: PromptRuleStore
  private readonly dataSources: Map<string, DataSource>
  private readonly llm: LlmTransport
  private readonly getApiKey?: () => Promise<string | undefined> | string | undefined
  private readonly getAiProvider?: () => Promise<AiProviderConfig | undefined> | AiProviderConfig | undefined
  private readonly now: () => number

  /** 活跃执行中的任务 AbortController 映射（用于支持主动取消中断）。 */
  private readonly inflightControllers = new Map<string, AbortController>()

  constructor(deps: AnalysisServiceDeps) {
    this.tasks = deps.tasks
    this.rules = deps.rules
    this.dataSources = deps.dataSources
    this.llm = deps.llm
    this.getApiKey = deps.getApiKey
    this.getAiProvider = deps.getAiProvider
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * 创建一个数据分析任务（进入 pending 状态）。
   */
  async createTask(payload: AnalysisPayload): Promise<Task> {
    if (!payload.ruleId) {
      throw new Error('创建分析任务失败：缺少 ruleId')
    }
    // 纵深防御：数据分析只以飞书表格为准。即使调用方绕过 runtime 直接调用 service，
    // 也绝不接受 local 等非 feishu 数据源进入分析链路（防止本地数据被送往 LLM）。
    if (payload.dataSourceType !== 'feishu') {
      throw new Error(
        `创建分析任务失败：数据分析只以飞书表格为准，dataSourceType 必须为 feishu（收到 ${payload.dataSourceType}）`,
      )
    }
    if (!this.dataSources.has(payload.dataSourceType)) {
      throw new Error(`创建分析任务失败：未知或未注册的数据源类型 ${payload.dataSourceType}`)
    }

    const task = await this.tasks.create({
      type: 'analysis',
      payload: payload as unknown as Record<string, unknown>,
    })

    return task
  }

  /**
   * 启动并执行指定的分析任务。
   */
  async executeTask(taskId: string): Promise<Task> {
    const task = await this.tasks.getById(taskId)
    if (!task) {
      throw new Error(`未找到任务: ${taskId}`)
    }

    if (task.status !== 'pending' && task.status !== 'paused') {
      throw new Error(`无法启动任务: 当前状态为 ${task.status}`)
    }

    // 状态流转为 running
    await this.tasks.start(taskId)

    const abortController = new AbortController()
    this.inflightControllers.set(taskId, abortController)

    // 异步执行主流程
    try {
      const payload = task.payload as unknown as AnalysisPayload
      // 纵深防御：任务可能被绕过 runtime 直接写入非 feishu 数据源（或历史遗留任务），
      // 执行前再次断言，绝不把 local 等数据送 LLM。
      if (payload.dataSourceType !== 'feishu') {
        throw new Error(
          `分析任务数据源非法：数据分析只以飞书表格为准，dataSourceType 必须为 feishu（收到 ${payload.dataSourceType}）`,
        )
      }
      const rule = await this.rules.get(payload.ruleId)
      if (!rule) {
        throw new Error(`分析规则不存在: ${payload.ruleId}`)
      }

      const dataSource = this.dataSources.get(payload.dataSourceType)
      if (!dataSource) {
        throw new Error(`数据源不存在: ${payload.dataSourceType}`)
      }

      // 1. 查询数据源
      await this.tasks.updateProgress(taskId, 20)
      if (abortController.signal.aborted) throw new Error('任务已取消')

      const dataset = await dataSource.query(payload.queryParams)
      if (dataset.rows.length === 0) {
        throw new Error('数据源查询结果为空，无法进行分析')
      }

      // 2. 统计聚合与样本抽样脱敏
      await this.tasks.updateProgress(taskId, 40)
      if (abortController.signal.aborted) throw new Error('任务已取消')

      const summary = aggregateDataset(dataset)
      const summaryText = formatDatasetSummary(summary)

      const sampleLimit = payload.sampleLimit ?? 20
      const sampledRows = sampleDataset(dataset, sampleLimit)
      const datasetText = JSON.stringify(sampledRows, null, 2)

      // 3. 组装 Prompt 提示词
      await this.tasks.updateProgress(taskId, 60)
      const renderedUserPrompt = renderPromptTemplate(rule.userPromptTemplate, {
        dataset: datasetText,
        summary: summaryText,
        rowCount: sampledRows.length,
        ruleName: rule.name,
        customInstructions: payload.customInstructions || '',
      })

      // 4. 调用 LLM：显式 modelConfig 覆盖优先，其次全局 AiProviderConfig，最后传输层默认。
      const provider = this.getAiProvider ? await this.getAiProvider() : undefined
      const llmConfig = resolveLlmConfig(payload.modelConfig, provider)
      // 兼容旧接线：仅当全局 provider 未提供密钥时，回退到 getApiKey。
      if (!llmConfig.apiKey && this.getApiKey) {
        const fallbackKey = nonEmptyString(await this.getApiKey())
        if (fallbackKey) llmConfig.apiKey = fallbackKey
      }
      const llmResult = await this.llm.complete({
        messages: [
          { role: 'system', content: rule.systemPrompt },
          { role: 'user', content: renderedUserPrompt },
        ],
        ...llmConfig,
        signal: abortController.signal,
      })

      if (abortController.signal.aborted) {
        throw new Error('任务已取消')
      }

      if (!llmResult.success || !llmResult.content) {
        throw new Error(llmResult.error || 'LLM 调用失败')
      }

      await this.tasks.updateProgress(taskId, 85)

      // 5. 校验结构化 JSON 输出
      const structuredOutput = this.parseAndValidateStructuredOutput(llmResult.content)

      const result: AnalysisResult = {
        ruleId: rule.id,
        ruleName: rule.name,
        sampleCount: sampledRows.length,
        totalCount: dataset.total,
        analyzedAt: this.now(),
        output: structuredOutput,
        modelUsed: llmResult.modelUsed || 'unknown',
        usage: llmResult.usage,
      }

      // 6. 标记完成
      const completedTask = await this.tasks.complete(taskId, result as unknown as Record<string, unknown>)
      return completedTask
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        // 如果已被取消，TaskManager 会由 cancel 操作置为 cancelled，不覆盖为 failed
        const current = await this.tasks.getById(taskId)
        return current ?? task
      }
      const message = err instanceof Error ? err.message : String(err)
      return this.tasks.fail(taskId, message)
    } finally {
      this.inflightControllers.delete(taskId)
    }
  }

  /**
   * 取消分析任务（支持中断活跃执行中的 LLM 请求）。
   */
  async cancelTask(taskId: string, reason = '用户手动取消'): Promise<Task> {
    const controller = this.inflightControllers.get(taskId)
    if (controller) {
      controller.abort()
      this.inflightControllers.delete(taskId)
    }
    return this.tasks.cancel(taskId, reason)
  }

  /**
   * 解析并校验 LLM 返回的内容为结构化 JSON。
   */
  private parseAndValidateStructuredOutput(rawText: string): AnalysisStructuredOutput {
    // 剥离可能存在的 Markdown 代码块包裹
    let cleaned = rawText.trim()
    const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    if (codeBlockMatch && codeBlockMatch[1]) {
      cleaned = codeBlockMatch[1].trim()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch {
      throw new Error(`LLM 输出无法解析为合法 JSON: ${cleaned.slice(0, 120)}...`)
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('LLM 输出 JSON 顶层必须为对象结构')
    }

    const record = parsed as Record<string, unknown>

    if (typeof record['summary'] !== 'string' || record['summary'].trim().length === 0) {
      throw new Error('LLM 结构化输出缺少必填字符串字段 summary')
    }

    if (!Array.isArray(record['keyFindings'])) {
      throw new Error('LLM 结构化输出缺少数组字段 keyFindings')
    }

    const keyFindings = record['keyFindings'].map((item) => String(item))
    const opportunities = Array.isArray(record['opportunities'])
      ? record['opportunities'].map((item) => String(item))
      : []
    const risks = Array.isArray(record['risks'])
      ? record['risks'].map((item) => String(item))
      : []

    let priceAnalysis: AnalysisStructuredOutput['priceAnalysis']
    if (typeof record['priceAnalysis'] === 'object' && record['priceAnalysis'] !== null) {
      const pa = record['priceAnalysis'] as Record<string, unknown>
      priceAnalysis = {
        avgPrice: Number(pa['avgPrice']) || 0,
        medianPrice: Number(pa['medianPrice']) || 0,
        priceRange: String(pa['priceRange'] || ''),
        recommendation: pa['recommendation'] ? String(pa['recommendation']) : undefined,
      }
    }

    return {
      summary: record['summary'],
      keyFindings,
      priceAnalysis,
      opportunities,
      risks,
      rawJson: record,
    }
  }
}
