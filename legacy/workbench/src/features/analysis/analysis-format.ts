/**
 * 数据分析页的表单校验、结果解析与文案（纯函数，可在 Node 下测试）。
 *
 * 约束：
 * - 分析结果只展示后台返回并通过结构校验的字段；缺少必需字段视为「非法结果」，不猜测补全；
 * - 页面从不接触 API Key / AppSecret：LLM 未配置时只提示「需在扩展侧配置」。
 */
import { formatFullTime, safeHttpsUrl } from '../chat/chat-format'
import {
  DATASET_DEFAULT_LIMIT,
  DATASET_MAX_LIMIT,
  extractTemplateVariables,
  validatePromptRule,
  type AnalysisResult,
  type DatasetFieldSchema,
  type DatasetFilter,
  type PromptRule,
} from '../contracts'
import { redactSecrets, type ErrorView } from '../shared/error-format'

// ---------------- 数据过滤器 ----------------

export interface FilterDraft {
  keyword: string
  minPrice: string
  maxPrice: string
  minWantCnt: string
  maxWantCnt: string
  onlyFreeShip: boolean
  limit: string
}

export type FilterDraftErrors = Partial<Record<keyof FilterDraft, string>>

export function defaultFilterDraft(): FilterDraft {
  return { keyword: '', minPrice: '', maxPrice: '', minWantCnt: '', maxWantCnt: '', onlyFreeShip: false, limit: '100' }
}

function optionalNumber(raw: string, label: string, integer: boolean): { value?: number; error?: string } {
  const text = raw.trim()
  if (!text) return {}
  const pattern = integer ? /^\d+$/ : /^\d+(\.\d{1,2})?$/
  if (!pattern.test(text)) return { error: `${label}需要是不小于 0 的${integer ? '整数' : '数字'}` }
  return { value: Number(text) }
}

export type FilterBuildResult = { ok: true; filter: DatasetFilter } | { ok: false; errors: FilterDraftErrors }

/** 校验过滤器并生成 `DATA_SOURCE_QUERY` / `ANALYSIS_CREATE.queryParams` 使用的 DatasetFilter。 */
export function buildDatasetFilter(draft: FilterDraft): FilterBuildResult {
  const errors: FilterDraftErrors = {}
  const keyword = draft.keyword.trim()
  if (keyword.length > 60) errors.keyword = '关键词不能超过 60 个字符'

  const minPrice = optionalNumber(draft.minPrice, '最低价格', false)
  if (minPrice.error) errors.minPrice = minPrice.error
  const maxPrice = optionalNumber(draft.maxPrice, '最高价格', false)
  if (maxPrice.error) errors.maxPrice = maxPrice.error
  if (minPrice.value !== undefined && maxPrice.value !== undefined && minPrice.value > maxPrice.value) {
    errors.maxPrice = '最高价格不能低于最低价格'
  }
  const minWant = optionalNumber(draft.minWantCnt, '最小想要人数', true)
  if (minWant.error) errors.minWantCnt = minWant.error
  const maxWant = optionalNumber(draft.maxWantCnt, '最大想要人数', true)
  if (maxWant.error) errors.maxWantCnt = maxWant.error
  if (minWant.value !== undefined && maxWant.value !== undefined && minWant.value > maxWant.value) {
    errors.maxWantCnt = '最大想要人数不能低于最小想要人数'
  }

  const limitText = draft.limit.trim()
  let limit = DATASET_DEFAULT_LIMIT
  if (limitText) {
    if (!/^\d+$/.test(limitText) || Number(limitText) < 1 || Number(limitText) > DATASET_MAX_LIMIT) {
      errors.limit = `数据条数需要在 1 到 ${DATASET_MAX_LIMIT} 之间`
    } else {
      limit = Number(limitText)
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  const filter: DatasetFilter = {
    ...(keyword ? { keyword } : {}),
    ...(minPrice.value !== undefined ? { minPrice: minPrice.value } : {}),
    ...(maxPrice.value !== undefined ? { maxPrice: maxPrice.value } : {}),
    ...(minWant.value !== undefined ? { minWantCnt: minWant.value } : {}),
    ...(maxWant.value !== undefined ? { maxWantCnt: maxWant.value } : {}),
    ...(draft.onlyFreeShip ? { onlyFreeShip: true } : {}),
    limit,
  }
  return { ok: true, filter }
}

/** 抽样条数（送入 LLM 的上限）：后台默认 20，最大 50。 */
export function parseSampleLimit(raw: string): { value?: number; error?: string } {
  const text = raw.trim()
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > 50) return { error: '抽样条数需要在 1 到 50 之间' }
  return { value: Number(text) }
}

// ---------------- 数据集预览 ----------------

/** 单元格展示文本：按字段类型格式化，不做任何臆造。 */
export function formatCell(field: Pick<DatasetFieldSchema, 'type'>, value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  switch (field.type) {
    case 'boolean':
      return value === true ? '是' : value === false ? '否' : String(value)
    case 'datetime':
      return typeof value === 'number' ? formatFullTime(value) || String(value) : String(value)
    default:
      return typeof value === 'string' ? value : JSON.stringify(value)
  }
}

/** URL 类型字段只放行 https 链接。 */
export function cellLink(field: Pick<DatasetFieldSchema, 'type'>, value: unknown): string | null {
  return field.type === 'url' ? safeHttpsUrl(value) : null
}

// ---------------- PromptRule ----------------

export interface PromptRuleDraft {
  id: string
  name: string
  description: string
  systemPrompt: string
  userPromptTemplate: string
}

export function emptyPromptRuleDraft(): PromptRuleDraft {
  return { id: '', name: '', description: '', systemPrompt: '', userPromptTemplate: '' }
}

export function draftFromPromptRule(rule: PromptRule): PromptRuleDraft {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description ?? '',
    systemPrompt: rule.systemPrompt,
    userPromptTemplate: rule.userPromptTemplate,
  }
}

export function newPromptRuleId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  const unique =
    cryptoObj && typeof cryptoObj.randomUUID === 'function'
      ? cryptoObj.randomUUID().slice(0, 12)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  return `prompt_${unique}`
}

export type PromptRuleBuildResult = { ok: true; rule: PromptRule } | { ok: false; errors: string[] }

/**
 * 校验草稿并生成 PromptRule。
 * 校验复用后台同一份 `validatePromptRule`（必填、模板变量白名单、疑似密钥拦截），
 * 因此把 API Key 粘贴进提示词会在提交前被拒绝。
 */
export function buildPromptRule(
  draft: PromptRuleDraft,
  options: { existing?: PromptRule | null; now?: number; generateId?: () => string } = {},
): PromptRuleBuildResult {
  const now = options.now ?? Date.now()
  const existing = options.existing ?? null
  const candidate: PromptRule = {
    id: draft.id || (options.generateId ?? newPromptRuleId)(),
    name: draft.name.trim(),
    ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
    systemPrompt: draft.systemPrompt,
    userPromptTemplate: draft.userPromptTemplate,
    variables: extractTemplateVariables(draft.userPromptTemplate),
    ...(existing?.targetOutputSchema ? { targetOutputSchema: existing.targetOutputSchema } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  const validation = validatePromptRule(candidate)
  if (!validation.valid) return { ok: false, errors: validation.errors }
  return { ok: true, rule: candidate }
}

// ---------------- 分析结果解析 ----------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export type ParsedResult = { ok: true; result: AnalysisResult } | { ok: false; reason: string }

/** 严格解析 `ANALYSIS_RESULT_GET` 的结果；不合格返回原因，由界面显示「结果格式不合法」。 */
export function parseAnalysisResult(raw: unknown): ParsedResult {
  if (!isRecord(raw)) return { ok: false, reason: '扩展返回的数据格式不正确' }
  const result = raw['result']
  if (result === undefined || result === null) return { ok: false, reason: '该任务没有可用的分析结果' }
  if (!isRecord(result)) return { ok: false, reason: '分析结果不是对象' }
  const output = result['output']
  if (!isRecord(output)) return { ok: false, reason: '分析结果缺少 output 结构' }
  if (typeof output['summary'] !== 'string' || !output['summary'].trim()) return { ok: false, reason: '分析结果缺少 summary' }
  if (!isStringArray(output['keyFindings'])) return { ok: false, reason: '分析结果的 keyFindings 不是字符串数组' }
  if (!isStringArray(output['opportunities'])) return { ok: false, reason: '分析结果的 opportunities 不是字符串数组' }
  if (!isStringArray(output['risks'])) return { ok: false, reason: '分析结果的 risks 不是字符串数组' }
  const price = output['priceAnalysis']
  if (price !== undefined && price !== null) {
    if (
      !isRecord(price) ||
      typeof price['avgPrice'] !== 'number' ||
      typeof price['medianPrice'] !== 'number' ||
      typeof price['priceRange'] !== 'string'
    ) {
      return { ok: false, reason: '分析结果的 priceAnalysis 结构不正确' }
    }
  }
  if (typeof result['ruleName'] !== 'string' || typeof result['sampleCount'] !== 'number' || typeof result['totalCount'] !== 'number') {
    return { ok: false, reason: '分析结果缺少规则名称或样本统计' }
  }
  return { ok: true, result: result as unknown as AnalysisResult }
}

// ---------------- 分析失败原因 ----------------

/** 把后台任务 `error` 字符串转成明确的提示（LLM 未配置 / 数据为空 / 非法结果 / 超时等）。 */
export function describeAnalysisFailure(message: string): ErrorView {
  const detail = redactSecrets(message)
  const make = (title: string, hint: string, kind: ErrorView['kind']): ErrorView => ({ title, hint, detail, kind, code: '' })
  if (/未配置 AI API Key|CONFIG_ERROR/i.test(message)) {
    return make('AI 模型未配置', 'AI 凭据只能在扩展侧安全配置，当前工作台不提供输入入口（设置页待接入）。', 'unavailable')
  }
  if (/查询结果为空|数据源.*为空/.test(message)) {
    return make('数据源没有可分析的数据', '请先在数据采集页采集商品，或放宽下方的数据过滤条件。', 'validation')
  }
  if (/无法解析为合法 JSON|结构化输出|顶层必须/.test(message)) {
    return make('模型返回的结果格式不合法', '可以调整提示词规则，要求模型严格输出 JSON 后重试。', 'validation')
  }
  if (/已取消|CANCELLED/i.test(message)) return make('分析已取消', '', 'unknown')
  if (/超时|TIMEOUT/i.test(message)) return make('AI 请求超时', '请稍后重试。', 'timeout')
  if (/Service Worker 重启/.test(message)) return make('分析被中断', '扩展后台重启导致未完成的分析被终止，请重新开始。', 'unavailable')
  if (/HTTP 错误|NETWORK_ERROR|请求异常/.test(message)) return make('AI 接口调用失败', '请检查扩展侧的 AI 接口地址、网络与额度。', 'platform')
  if (/规则不存在/.test(message)) return make('分析规则不存在', '规则可能已被删除，请重新选择。', 'validation')
  if (/未知或未注册的数据源|数据源不存在/.test(message)) {
    return make('数据源不可用', '该数据源未在扩展后台注册，飞书数据源需要在扩展侧完成配置。', 'unavailable')
  }
  return make(detail || '分析失败，后台未给出原因', '', 'unknown')
}

export function formatAnalyzedAt(timestamp: number): string {
  return formatFullTime(timestamp)
}
