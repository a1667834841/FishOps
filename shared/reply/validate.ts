/**
 * P6 运行时可校验与净化（共享，纯逻辑，无依赖）。
 *
 * 用途：
 * - 命令负载的运行时校验（`shared/events/codec.ts` 引用）；
 * - 规则落库前的字段白名单净化，确保规则里**绝不会**混入 API key / token。
 *
 * 约定：所有校验函数在非法输入时返回 false，不抛错。
 */
import {
  MAX_SEND_CONTENT_LENGTH,
  REPLY_LIMITS,
  type AiProviderConfig,
  type ReplyGlobalConfig,
  type ReplyMode,
  type ReplyRule,
  type ReplyRuleType,
} from '../types/reply'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function isOptionalPositiveInt(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** 敏感字段名片段（去分隔符后做子串匹配），命中即视为非法规则 / 配置。 */
const SENSITIVE_KEY_PARTS = ['apikey', 'token', 'secret', 'password', 'authorization'] as const

/** 是否含有敏感字段（只检查顶层键，规则结构是扁平的）。 */
function hasSensitiveKey(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => {
    const normalized = key.toLowerCase().replace(/[_-]/g, '')
    return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))
  })
}

const REPLY_MODES: ReadonlySet<string> = new Set<ReplyMode>(['manual', 'suggest', 'auto'])

/** 正则是否可编译（使用 i 标志，与引擎一致）。 */
export function isCompilablePattern(pattern: string): boolean {
  if (pattern.length === 0 || pattern.length > REPLY_LIMITS.maxPatternLength) return false
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, 'i')
    return true
  } catch {
    return false
  }
}

/** 校验单条回复规则。 */
export function isReplyRule(value: unknown): value is ReplyRule {
  if (!isRecord(value)) return false
  if (hasSensitiveKey(value)) return false

  const type = value['type']
  if (type !== 'keyword' && type !== 'ai') return false
  if (typeof value['id'] !== 'string' || value['id'].length === 0) return false
  if (typeof value['name'] !== 'string' || value['name'].length > REPLY_LIMITS.maxNameLength) return false
  if (typeof value['enabled'] !== 'boolean') return false
  if (typeof value['priority'] !== 'number' || !Number.isFinite(value['priority'])) return false
  if (value['itemIds'] !== undefined && !isStringArray(value['itemIds'])) return false
  if (!isOptionalNonNegativeNumber(value['cooldown'])) return false
  if (!isOptionalNonNegativeNumber(value['delay'])) return false

  if (type === 'keyword') {
    const pattern = value['pattern']
    const reply = value['reply']
    if (typeof pattern !== 'string' || !isCompilablePattern(pattern)) return false
    if (typeof reply !== 'string' || reply.length === 0 || reply.length > REPLY_LIMITS.maxReplyLength) return false
    return true
  }

  if (!isOptionalString(value['prompt'])) return false
  if (!isOptionalString(value['userPromptTemplate'])) return false
  if (!isOptionalPositiveInt(value['maxHistoryMessages'])) return false
  if (!isOptionalString(value['model'])) return false
  if (!isOptionalNonNegativeNumber(value['timeoutMs'])) return false
  return true
}

/** 校验规则数组（含数量上限、ID 唯一）。 */
export function isReplyRuleList(value: unknown): value is ReplyRule[] {
  if (!Array.isArray(value) || value.length > REPLY_LIMITS.maxRules) return false
  const ids = new Set<string>()
  for (const rule of value) {
    if (!isReplyRule(rule)) return false
    // 规则 ID 必须唯一，避免 cooldown / commit 口径歧义。
    if (ids.has(rule.id)) return false
    ids.add(rule.id)
  }
  return true
}

/**
 * 校验全局配置（允许部分字段，便于 PATCH 式更新）。
 * 传入对象必须不含敏感字段。
 */
export function isReplyGlobalConfigPatch(value: unknown): value is Partial<ReplyGlobalConfig> {
  if (!isRecord(value)) return false
  if (hasSensitiveKey(value)) return false
  if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') return false
  if (value['mode'] !== undefined && !REPLY_MODES.has(value['mode'] as string)) return false
  if (!isOptionalNonNegativeNumber(value['defaultCooldown'])) return false
  if (!isOptionalNonNegativeNumber(value['defaultDelay'])) return false
  if (value['blacklist'] !== undefined && (!isStringArray(value['blacklist']) || value['blacklist'].length > REPLY_LIMITS.maxBlacklist)) {
    return false
  }
  if (
    value['handoffKeywords'] !== undefined &&
    (!isStringArray(value['handoffKeywords']) || value['handoffKeywords'].length > REPLY_LIMITS.maxHandoffKeywords)
  ) {
    return false
  }
  if (!isOptionalPositiveInt(value['maxAutoRepliesPerSession'])) return false
  if (!isOptionalPositiveInt(value['autoReplyWindowMs'])) return false
  if (!isOptionalPositiveInt(value['aiPauseDurationMs'])) return false
  if (!isOptionalPositiveInt(value['maxContentLength'])) return false
  return true
}

/** 校验完整的全局配置。 */
export function isReplyGlobalConfig(value: unknown): value is ReplyGlobalConfig {
  if (!isReplyGlobalConfigPatch(value)) return false
  const config = value as Partial<ReplyGlobalConfig>
  return (
    typeof config.enabled === 'boolean' &&
    typeof config.mode === 'string' &&
    typeof config.defaultCooldown === 'number' &&
    typeof config.defaultDelay === 'number' &&
    Array.isArray(config.blacklist) &&
    Array.isArray(config.handoffKeywords) &&
    typeof config.maxAutoRepliesPerSession === 'number' &&
    typeof config.autoReplyWindowMs === 'number' &&
    typeof config.aiPauseDurationMs === 'number' &&
    typeof config.maxContentLength === 'number'
  )
}

/**
 * 规则净化：只保留已知字段，剔除任何额外键（含敏感键）。
 * 用于落库前的最后一道防线。
 */
export function sanitizeReplyRule(rule: ReplyRule): ReplyRule {
  const base = {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    priority: rule.priority,
    ...(rule.itemIds === undefined ? {} : { itemIds: [...rule.itemIds] }),
    ...(rule.cooldown === undefined ? {} : { cooldown: rule.cooldown }),
    ...(rule.delay === undefined ? {} : { delay: rule.delay }),
  }
  if (rule.type === 'keyword') {
    return { ...base, type: 'keyword', pattern: rule.pattern, reply: rule.reply }
  }
  return {
    ...base,
    type: 'ai',
    ...(rule.prompt === undefined ? {} : { prompt: rule.prompt }),
    ...(rule.userPromptTemplate === undefined ? {} : { userPromptTemplate: rule.userPromptTemplate }),
    ...(rule.maxHistoryMessages === undefined ? {} : { maxHistoryMessages: rule.maxHistoryMessages }),
    ...(rule.model === undefined ? {} : { model: rule.model }),
    ...(rule.timeoutMs === undefined ? {} : { timeoutMs: rule.timeoutMs }),
  }
}

/** 批量净化规则。 */
export function sanitizeReplyRules(rules: readonly ReplyRule[]): ReplyRule[] {
  return rules.map(sanitizeReplyRule)
}

// ---------------- P6 命令负载校验 ----------------

/** 校验 CHAT_SEND_MESSAGE 的发送输入。 */
export function isChatSendMessagePayload(value: unknown): value is {
  sessionId: string
  receiverId: string
  content: string
  itemId?: string
  timeoutMs?: number
} {
  if (!isRecord(value)) return false
  if (typeof value['sessionId'] !== 'string' || value['sessionId'].length === 0) return false
  if (typeof value['receiverId'] !== 'string' || value['receiverId'].length === 0) return false
  const content = value['content']
  if (typeof content !== 'string' || content.length === 0 || content.length > MAX_SEND_CONTENT_LENGTH) return false
  if (!isOptionalString(value['itemId'])) return false
  if (!isOptionalPositiveInt(value['timeoutMs'])) return false
  return true
}

/** 校验 CHAT_GET_REPLY_SUGGESTION 负载。 */
export function isChatGetReplySuggestionPayload(value: unknown): value is {
  sessionId: string
  messageId?: string
  respectPause?: boolean
  includeImages?: boolean
} {
  if (!isRecord(value)) return false
  if (typeof value['sessionId'] !== 'string' || value['sessionId'].length === 0) return false
  if (!isOptionalString(value['messageId'])) return false
  if (value['respectPause'] !== undefined && typeof value['respectPause'] !== 'boolean') return false
  if (value['includeImages'] !== undefined && typeof value['includeImages'] !== 'boolean') return false
  return true
}

/** 校验 CHAT_APPLY_REPLY 负载。 */
export function isChatApplyReplyPayload(value: unknown): value is {
  sessionId: string
  content: string
  receiverId?: string
  messageId?: string
  ruleId?: string
} {
  if (!isRecord(value)) return false
  if (typeof value['sessionId'] !== 'string' || value['sessionId'].length === 0) return false
  const content = value['content']
  if (typeof content !== 'string' || content.length === 0 || content.length > MAX_SEND_CONTENT_LENGTH) return false
  if (!isOptionalString(value['receiverId'])) return false
  if (!isOptionalString(value['messageId'])) return false
  if (!isOptionalString(value['ruleId'])) return false
  return true
}

/** 校验 CHAT_RULES_SET 负载（规则整表替换 + 全局配置部分更新）。 */
export function isChatRulesSetPayload(value: unknown): value is {
  global?: Partial<ReplyGlobalConfig>
  rules?: ReplyRule[]
} {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length === 0) return false
  if (!keys.every((key) => key === 'global' || key === 'rules')) return false
  if (value['global'] !== undefined && !isReplyGlobalConfigPatch(value['global'])) return false
  if (value['rules'] !== undefined && !isReplyRuleList(value['rules'])) return false
  return true
}

/** 校验 CHAT_AI_PAUSE_SET 负载。 */
export function isChatAiPauseSetPayload(value: unknown): value is {
  paused: boolean
  durationMs?: number
  reason?: string
} {
  if (!isRecord(value)) return false
  if (typeof value['paused'] !== 'boolean') return false
  if (!isOptionalPositiveInt(value['durationMs'])) return false
  if (!isOptionalString(value['reason'])) return false
  return true
}

/** 校验 AI 供应方配置（配置适配器用；含凭据，校验后由适配器独占持有）。 */
export function isAiProviderConfig(value: unknown): value is AiProviderConfig {
  if (!isRecord(value)) return false
  if (!isOptionalString(value['apiKey'])) return false
  if (!isOptionalString(value['baseUrl'])) return false
  if (!isOptionalString(value['model'])) return false
  if (!isOptionalPositiveInt(value['timeoutMs'])) return false
  return true
}

/** 规则类型是否为已登记类型。 */
export function isReplyRuleType(value: unknown): value is ReplyRuleType {
  return value === 'keyword' || value === 'ai'
}
