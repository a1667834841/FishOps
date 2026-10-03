/**
 * 数据分析与 AI 提示词规则类型定义（P7）。
 *
 * 规范提示词规则结构、模型传输配置、分析入参与结构化输出。
 * 严禁在提示词规则与分析数据中包含明文 secret/token。
 */
import type { DatasetFilter } from './dataset'

/** 提示词规则实体。 */
export interface PromptRule {
  /** 规则唯一 ID。 */
  id: string
  /** 规则名称。 */
  name: string
  /** 规则描述说明。 */
  description?: string
  /** 系统提示词 System Prompt。 */
  systemPrompt: string
  /** 用户提示词模板 User Prompt Template，可包含 `{{dataset}}`, `{{summary}}` 等变量。 */
  userPromptTemplate: string
  /** 模板中引用的合法变量名称列表。 */
  variables: string[]
  /** 期望的输出 JSON Schema 或字段规范（可选）。 */
  targetOutputSchema?: Record<string, unknown>
  /** 创建时间戳（毫秒）。 */
  createdAt: number
  /** 更新时间戳（毫秒）。 */
  updatedAt: number
}

/** LLM 模型传输配置（不包含 apiKey，由 Background 请求层按需注入）。 */
export interface AnalysisModelConfig {
  /** 接口 Base URL。 */
  baseUrl?: string
  /** 使用的模型名称。 */
  model?: string
  /** 采样温度 (0.0 ~ 2.0)。 */
  temperature?: number
  /** 最大 token 限制。 */
  maxTokens?: number
  /** 超时毫秒数。 */
  timeoutMs?: number
}

/**
 * 分析模型覆盖配置的输入上限（运行时严格校验用）。
 *
 * 显式 `modelConfig` 允许覆盖全局 AI 配置的 baseUrl / model / timeoutMs；
 * 超限值一律拒绝，避免异常参数外送或长期挂起。
 */
export const ANALYSIS_MODEL_CONFIG_LIMITS = {
  /** 单字段（baseUrl / model）长度上限。 */
  maxTextLength: 2048,
  /** 采样温度上限。 */
  maxTemperature: 2,
  /** 单次输出 token 上限。 */
  maxOutputTokens: 200_000,
  /** 超时上限（毫秒），与手动配置保持一致的 5 分钟。 */
  maxTimeoutMs: 5 * 60 * 1000,
} as const

/** 分析任务输入荷载（Task.payload）。 */
export interface AnalysisPayload {
  /** 选用规则 ID。 */
  ruleId: string
  /** 数据源标识：'local' 本地商品库，或 'feishu' 飞书多维表格。 */
  dataSourceType: 'local' | 'feishu'
  /** 数据源查询过滤条件。 */
  queryParams?: DatasetFilter & Record<string, unknown>
  /** 抽样送入 LLM 的最大条数上限（默认 20，最大 50）。 */
  sampleLimit?: number
  /** 可选的模型参数覆盖。 */
  modelConfig?: AnalysisModelConfig
  /** 用户附带的自定义补充要求/说明。 */
  customInstructions?: string
}

/** 结构化分析输出中的价格分析项。 */
export interface AnalysisPriceInsights {
  /** 平均价。 */
  avgPrice: number
  /** 中位数价格。 */
  medianPrice: number
  /** 主要价格区间分布描述。 */
  priceRange: string
  /** 定价建议。 */
  recommendation?: string
}

/** 结构化分析输出核心字段。 */
export interface AnalysisStructuredOutput {
  /** 分析概览与核心结论。 */
  summary: string
  /** 关键发现清单。 */
  keyFindings: string[]
  /** 价格带与竞争分析。 */
  priceAnalysis?: AnalysisPriceInsights
  /** 市场机会点列表。 */
  opportunities: string[]
  /** 潜在风险与注意事项。 */
  risks: string[]
  /** 其它自定义提取或拓展的结构化字段。 */
  rawJson?: Record<string, unknown>
}

/** 分析任务执行结果（Task.result）。 */
export interface AnalysisResult {
  /** 使用的规则 ID。 */
  ruleId: string
  /** 使用的规则名称。 */
  ruleName: string
  /** 送入 LLM 评估的抽样样本数量。 */
  sampleCount: number
  /** 数据源总匹配条数。 */
  totalCount: number
  /** 完成分析的时间戳（毫秒）。 */
  analyzedAt: number
  /** 结构化分析结果。 */
  output: AnalysisStructuredOutput
  /** 实际使用的模型名。 */
  modelUsed: string
  /** Token 消耗统计。 */
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}
