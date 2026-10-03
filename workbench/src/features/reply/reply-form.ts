/**
 * P6 回复规则与全局配置的表单草稿、校验与文案（纯函数，可在 Node 下测试）。
 *
 * 安全约定：
 * - 规则里只有后台白名单字段，绝不出现 API Key / token / secret（最终以 `isReplyRule` 复核，
 *   同时拒绝把疑似密钥写进 prompt / model）；
 * - 全局配置只做「差异补丁」，没有改动的字段不会被发送。
 */
import {
  MAX_SEND_CONTENT_LENGTH,
  REPLY_LIMITS,
  isCompilablePattern,
  isReplyRule,
  validateNoSecrets,
  type AiReplyRule,
  type KeywordReplyRule,
  type ReplyGlobalConfig,
  type ReplyMode,
  type ReplyRule,
  type ReplySuggestionResult,
  type SendMessageErrorCode,
} from '../contracts'

const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const MAX_PROMPT_LENGTH = 4000

// ---------------- 规则草稿 ----------------

export interface RuleDraft {
  /** 已有规则沿用原 ID；新规则在保存时生成。 */
  id: string
  type: 'keyword' | 'ai'
  name: string
  enabled: boolean
  priority: string
  /** 空白或逗号分隔的商品 ID；空表示不限商品。 */
  itemIds: string
  /** 冷却秒数；空表示沿用全局默认。 */
  cooldownSec: string
  /** 发送延迟秒数；空表示沿用全局默认。 */
  delaySec: string
  // keyword
  pattern: string
  reply: string
  // ai
  prompt: string
  maxHistoryMessages: string
  model: string
  timeoutSec: string
}

export type RuleDraftField = keyof RuleDraft
export type RuleDraftErrors = Partial<Record<RuleDraftField, string>>

export function newRuleId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  const unique =
    cryptoObj && typeof cryptoObj.randomUUID === 'function'
      ? cryptoObj.randomUUID().slice(0, 12)
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  return `rule_${unique}`
}

/** 新建规则草稿：默认停用，避免保存后立刻生效。 */
export function emptyRuleDraft(type: 'keyword' | 'ai' = 'keyword'): RuleDraft {
  return {
    id: '',
    type,
    name: '',
    enabled: false,
    priority: '0',
    itemIds: '',
    cooldownSec: '',
    delaySec: '',
    pattern: '',
    reply: '',
    prompt: '',
    maxHistoryMessages: '',
    model: '',
    timeoutSec: '',
  }
}

function msToSecText(ms: number | undefined): string {
  if (ms === undefined) return ''
  const seconds = ms / 1000
  return Number.isInteger(seconds) ? String(seconds) : String(Math.round(seconds * 10) / 10)
}

/** 已有规则转草稿。 */
export function draftFromRule(rule: ReplyRule): RuleDraft {
  const base: RuleDraft = {
    ...emptyRuleDraft(rule.type),
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    priority: String(rule.priority),
    itemIds: (rule.itemIds ?? []).join(', '),
    cooldownSec: msToSecText(rule.cooldown),
    delaySec: msToSecText(rule.delay),
  }
  if (rule.type === 'keyword') return { ...base, pattern: rule.pattern, reply: rule.reply }
  return {
    ...base,
    prompt: rule.prompt ?? '',
    maxHistoryMessages: rule.maxHistoryMessages === undefined ? '' : String(rule.maxHistoryMessages),
    model: rule.model ?? '',
    timeoutSec: msToSecText(rule.timeoutMs),
  }
}

function optionalSeconds(raw: string, label: string, max: number): { value?: number; error?: string } {
  const text = raw.trim()
  if (text === '') return {}
  if (!/^\d+(\.\d)?$/.test(text)) return { error: `${label}需要是不小于 0 的数字（最多一位小数）` }
  const seconds = Number(text)
  if (seconds > max) return { error: `${label}不能超过 ${max} 秒` }
  return { value: Math.round(seconds * 1000) }
}

export type RuleBuildResult = { ok: true; rule: ReplyRule } | { ok: false; errors: RuleDraftErrors }

/** 校验草稿并生成后台规则；保存新规则时自动生成 ID。 */
export function buildRuleFromDraft(draft: RuleDraft, options: { generateId?: () => string } = {}): RuleBuildResult {
  const errors: RuleDraftErrors = {}

  const name = draft.name.trim()
  if (!name) errors.name = '请填写规则名称'
  else if (name.length > REPLY_LIMITS.maxNameLength) errors.name = `名称不能超过 ${REPLY_LIMITS.maxNameLength} 个字符`

  const priorityText = draft.priority.trim()
  if (!/^-?\d{1,6}$/.test(priorityText)) errors.priority = '优先级需要是整数，数值越大越先匹配'

  const itemIds = draft.itemIds
    .split(/[\s,，、]+/)
    .map((value) => value.trim())
    .filter(Boolean)
  if (itemIds.some((id) => !ITEM_ID_PATTERN.test(id))) errors.itemIds = '商品 ID 只能包含字母、数字、下划线和短横线'
  else if (new Set(itemIds).size !== itemIds.length) errors.itemIds = '商品 ID 有重复'

  const cooldown = optionalSeconds(draft.cooldownSec, '冷却时间', 86400)
  if (cooldown.error) errors.cooldownSec = cooldown.error
  const delay = optionalSeconds(draft.delaySec, '发送延迟', 600)
  if (delay.error) errors.delaySec = delay.error

  let rule: ReplyRule | null = null
  if (draft.type === 'keyword') {
    const pattern = draft.pattern.trim()
    if (!pattern) errors.pattern = '请填写匹配的正则表达式'
    else if (pattern.length > REPLY_LIMITS.maxPatternLength) errors.pattern = `正则不能超过 ${REPLY_LIMITS.maxPatternLength} 个字符`
    else if (!isCompilablePattern(pattern)) errors.pattern = '正则表达式无法编译，请检查语法'
    const reply = draft.reply
    if (!reply.trim()) errors.reply = '请填写命中后回复的文本'
    else if (reply.length > REPLY_LIMITS.maxReplyLength) errors.reply = `回复不能超过 ${REPLY_LIMITS.maxReplyLength} 个字符`
    if (Object.keys(errors).length === 0) {
      const built: KeywordReplyRule = {
        id: draft.id || (options.generateId ?? newRuleId)(),
        type: 'keyword',
        name,
        enabled: draft.enabled,
        priority: Number(priorityText),
        ...(itemIds.length > 0 ? { itemIds } : {}),
        ...(cooldown.value === undefined ? {} : { cooldown: cooldown.value }),
        ...(delay.value === undefined ? {} : { delay: delay.value }),
        pattern,
        reply,
      }
      rule = built
    }
  } else {
    const prompt = draft.prompt.trim()
    if (prompt.length > MAX_PROMPT_LENGTH) errors.prompt = `提示词不能超过 ${MAX_PROMPT_LENGTH} 个字符`
    else if (prompt && !validateNoSecrets(prompt).valid) errors.prompt = '提示词里疑似包含密钥，请移除；密钥不能写进规则'

    const historyText = draft.maxHistoryMessages.trim()
    if (historyText !== '' && (!/^\d+$/.test(historyText) || Number(historyText) < 1 || Number(historyText) > 50)) {
      errors.maxHistoryMessages = '历史条数需要是 1 到 50 的整数'
    }
    const model = draft.model.trim()
    if (model.length > 100) errors.model = '模型名过长'
    else if (model && (!/^[A-Za-z0-9._:/-]+$/.test(model) || /^sk-/i.test(model))) errors.model = '模型名格式不正确'
    const timeout = optionalSeconds(draft.timeoutSec, '超时', 120)
    if (timeout.error) errors.timeoutSec = timeout.error

    if (Object.keys(errors).length === 0) {
      const built: AiReplyRule = {
        id: draft.id || (options.generateId ?? newRuleId)(),
        type: 'ai',
        name,
        enabled: draft.enabled,
        priority: Number(priorityText),
        ...(itemIds.length > 0 ? { itemIds } : {}),
        ...(cooldown.value === undefined ? {} : { cooldown: cooldown.value }),
        ...(delay.value === undefined ? {} : { delay: delay.value }),
        ...(prompt ? { prompt } : {}),
        ...(historyText ? { maxHistoryMessages: Number(historyText) } : {}),
        ...(model ? { model } : {}),
        ...(timeout.value === undefined ? {} : { timeoutMs: timeout.value }),
      }
      rule = built
    }
  }

  if (Object.keys(errors).length > 0 || !rule) return { ok: false, errors }
  // 与后台同一份校验再复核一次，避免前后端口径漂移。
  if (!isReplyRule(rule)) return { ok: false, errors: { name: '规则未通过后台格式校验，请检查各字段' } }
  return { ok: true, rule }
}

/** 用新规则替换或追加到规则表（按 ID），返回新数组，不修改入参。 */
export function upsertRuleInList(rules: readonly ReplyRule[], rule: ReplyRule): ReplyRule[] {
  const exists = rules.some((item) => item.id === rule.id)
  return exists ? rules.map((item) => (item.id === rule.id ? rule : item)) : [...rules, rule]
}

// ---------------- 全局配置草稿 ----------------

export interface GlobalDraft {
  enabled: boolean
  mode: ReplyMode
  defaultCooldownSec: string
  defaultDelaySec: string
  blacklist: string
  handoffKeywords: string
  maxAutoRepliesPerSession: string
  autoReplyWindowMin: string
  aiPauseMin: string
  maxContentLength: string
}

export type GlobalDraftField = keyof GlobalDraft
export type GlobalDraftErrors = Partial<Record<GlobalDraftField, string>>

function listToText(items: readonly string[]): string {
  return items.join('\n')
}

function textToList(text: string): string[] {
  return [...new Set(text.split(/[\n,，]+/).map((item) => item.trim()).filter(Boolean))]
}

export function draftFromGlobal(config: ReplyGlobalConfig): GlobalDraft {
  return {
    enabled: config.enabled,
    mode: config.mode,
    defaultCooldownSec: msToSecText(config.defaultCooldown),
    defaultDelaySec: msToSecText(config.defaultDelay),
    blacklist: listToText(config.blacklist),
    handoffKeywords: listToText(config.handoffKeywords),
    maxAutoRepliesPerSession: String(config.maxAutoRepliesPerSession),
    autoReplyWindowMin: String(Math.round((config.autoReplyWindowMs / 60000) * 10) / 10),
    aiPauseMin: String(Math.round((config.aiPauseDurationMs / 60000) * 10) / 10),
    maxContentLength: String(config.maxContentLength),
  }
}

export type GlobalBuildResult =
  | { ok: true; patch: Partial<ReplyGlobalConfig> }
  | { ok: false; errors: GlobalDraftErrors }

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/** 校验草稿，与当前配置比较后只生成有改动的补丁。 */
export function buildGlobalPatch(draft: GlobalDraft, current: ReplyGlobalConfig): GlobalBuildResult {
  const errors: GlobalDraftErrors = {}

  const cooldown = optionalSeconds(draft.defaultCooldownSec, '默认冷却', 86400)
  if (cooldown.error || cooldown.value === undefined) errors.defaultCooldownSec = cooldown.error ?? '请填写默认冷却秒数'
  const delay = optionalSeconds(draft.defaultDelaySec, '默认延迟', 600)
  if (delay.error || delay.value === undefined) errors.defaultDelaySec = delay.error ?? '请填写默认延迟秒数'

  const blacklist = textToList(draft.blacklist)
  if (blacklist.length > REPLY_LIMITS.maxBlacklist) errors.blacklist = `黑名单最多 ${REPLY_LIMITS.maxBlacklist} 项`
  const handoff = textToList(draft.handoffKeywords)
  if (handoff.length > REPLY_LIMITS.maxHandoffKeywords) errors.handoffKeywords = `转人工关键词最多 ${REPLY_LIMITS.maxHandoffKeywords} 项`

  const maxAuto = draft.maxAutoRepliesPerSession.trim()
  if (!/^\d+$/.test(maxAuto) || Number(maxAuto) < 1 || Number(maxAuto) > 1000) {
    errors.maxAutoRepliesPerSession = '需要是 1 到 1000 的整数'
  }
  const windowMin = draft.autoReplyWindowMin.trim()
  if (!/^\d+(\.\d)?$/.test(windowMin) || Number(windowMin) < 1 || Number(windowMin) > 1440) {
    errors.autoReplyWindowMin = '需要是 1 到 1440 分钟'
  }
  const pauseMin = draft.aiPauseMin.trim()
  if (!/^\d+(\.\d)?$/.test(pauseMin) || Number(pauseMin) < 1 || Number(pauseMin) > 1440) {
    errors.aiPauseMin = '需要是 1 到 1440 分钟'
  }
  const maxLen = draft.maxContentLength.trim()
  if (!/^\d+$/.test(maxLen) || Number(maxLen) < 1 || Number(maxLen) > MAX_SEND_CONTENT_LENGTH) {
    errors.maxContentLength = `需要是 1 到 ${MAX_SEND_CONTENT_LENGTH} 的整数`
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const patch: Partial<ReplyGlobalConfig> = {}
  if (draft.enabled !== current.enabled) patch.enabled = draft.enabled
  if (draft.mode !== current.mode) patch.mode = draft.mode
  if (cooldown.value !== current.defaultCooldown) patch.defaultCooldown = cooldown.value as number
  if (delay.value !== current.defaultDelay) patch.defaultDelay = delay.value as number
  if (!sameList(blacklist, current.blacklist)) patch.blacklist = blacklist
  if (!sameList(handoff, current.handoffKeywords)) patch.handoffKeywords = handoff
  if (Number(maxAuto) !== current.maxAutoRepliesPerSession) patch.maxAutoRepliesPerSession = Number(maxAuto)
  const windowMs = Math.round(Number(windowMin) * 60000)
  if (windowMs !== current.autoReplyWindowMs) patch.autoReplyWindowMs = windowMs
  const pauseMs = Math.round(Number(pauseMin) * 60000)
  if (pauseMs !== current.aiPauseDurationMs) patch.aiPauseDurationMs = pauseMs
  if (Number(maxLen) !== current.maxContentLength) patch.maxContentLength = Number(maxLen)
  return { ok: true, patch }
}

/**
 * 这次补丁是否会让「自动发送」真正生效，需要用户二次确认。
 * 判定：补丁结果为 mode=auto，且本次补丁新设置了 mode=auto 或新打开了 enabled。
 */
export function patchNeedsAutoConfirm(current: ReplyGlobalConfig, patch: Partial<ReplyGlobalConfig>): boolean {
  const next = { ...current, ...patch }
  if (next.mode !== 'auto') return false
  const switchedToAuto = patch.mode === 'auto' && current.mode !== 'auto'
  const switchedOn = patch.enabled === true && !current.enabled
  return switchedToAuto || switchedOn
}

export const MODE_OPTIONS: readonly { value: ReplyMode; label: string; description: string }[] = [
  { value: 'manual', label: '人工', description: '不生成建议，也不自动发送，所有回复由你手动完成。' },
  { value: 'suggest', label: '建议（默认）', description: '为新消息生成回复建议，由你确认后才会发送。' },
  { value: 'auto', label: '自动回复', description: '命中规则后无需确认直接发送，存在误发与风控风险。' },
]

// ---------------- 建议与发送结果文案 ----------------

const SKIP_REASON_TEXT: Record<string, string> = {
  disabled: '回复引擎未启用。请在「回复规则」里先启用回复引擎（默认关闭）。',
  'ai-paused': 'AI 回复当前处于暂停状态。',
  self: '最后一条消息来自自己，没有需要回复的买家消息。',
  outgoing: '最后一条消息是自己发出的，没有需要回复的买家消息。',
  blacklisted: '该买家在黑名单中。',
  duplicate: '这条买家消息已经处理过。',
  'session-cooldown': '该会话仍在冷却时间内。',
  'no-match': '没有规则匹配这条买家消息。',
  handoff: '命中转人工关键词，请人工回复。',
  'max-auto-replies': '该会话自动回复次数已达上限。',
}

/** 建议失败结果的中文说明。 */
export function describeSuggestionFailure(result: Extract<ReplySuggestionResult, { ok: false }>): string {
  if (result.code === 'SKIPPED' && result.reason && SKIP_REASON_TEXT[result.reason]) return SKIP_REASON_TEXT[result.reason]
  if (result.code === 'NO_MATCH') return SKIP_REASON_TEXT['no-match']
  switch (result.code) {
    case 'NO_MESSAGE':
      return '该会话本地没有买家消息可用于生成建议。可先在消息栏点击「同步历史」。'
    case 'AI_DISABLED':
      return 'AI 回复未启用或未配置。AI 凭据需要在扩展侧安全配置，这里不会读取或显示。'
    case 'AI_ERROR':
      return 'AI 生成建议失败，请检查 AI 配置与网络后重试。'
    default:
      return result.message || '未生成建议'
  }
}

const SEND_ERROR_TEXT: Record<SendMessageErrorCode, string> = {
  INVALID_INPUT: '发送内容不合法。',
  NO_SOCKET: '聊天实时连接未建立。请保持已登录的闲鱼页面打开，等待连接恢复后重试。',
  ROUTE_NOT_ALLOWED: '发送路由未被允许，已被安全策略拦截。',
  DUPLICATE_MID: '检测到重复的消息标识，已拦截，请稍后重试。',
  SEND_FAILED: '发送失败。',
  LWP_ERROR: '平台返回了发送错误。',
  TIMEOUT: '发送等待超时，消息可能已经发出。请先点击「同步历史」确认，再决定是否重发。',
  INVALID_RESPONSE: '平台返回了无法识别的响应，发送结果未知。请先点击「同步历史」确认。',
}

/** 发送失败结果的中文说明（只含错误码与后台给出的安全文案）。 */
export function describeSendFailure(error: { code: SendMessageErrorCode; message: string }): string {
  const base = SEND_ERROR_TEXT[error.code] ?? '发送失败。'
  const detail = error.message && !base.includes(error.message) ? `（${error.code}：${error.message}）` : `（${error.code}）`
  return `${base}${detail}`
}
