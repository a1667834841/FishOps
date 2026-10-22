/**
 * P6 回复 / 发送 / AI 领域类型与常量（共享）。
 *
 * 安全约定（硬性）：
 * - 规则对象**绝不**包含 API key / token 等凭据；AI 凭据只存在于 `AiProviderConfig`，
 *   由配置适配器单独读取（chrome.storage.local），不进规则、不进日志、不进事件。
 * - 事件负载默认不含聊天正文；建议正文只通过命令响应返回给扩展内页（Workbench）。
 * - 默认回复模式为 `suggest`（建议 / 人工安全模式），不会自动发送。
 */
import type { ChatDirection } from './chat'

/** 回复模式：人工、AI 建议、AI 自动。默认使用 `suggest`。 */
export type ReplyMode = 'manual' | 'suggest' | 'auto'

/** 规则类型：关键词正则、AI。 */
export type ReplyRuleType = 'keyword' | 'ai'

/** 规则公共字段。 */
export interface ReplyRuleBase {
  /** 规则 ID。 */
  id: string
  /** 规则类型。 */
  type: ReplyRuleType
  /** 规则名称（用于展示与日志）。 */
  name: string
  /** 是否启用。 */
  enabled: boolean
  /** 优先级，数值越大越先匹配。 */
  priority: number
  /** 商品绑定：非空时仅匹配这些 itemId。 */
  itemIds?: string[]
  /** 规则级冷却（毫秒）；缺省回退全局 `defaultCooldown`。 */
  cooldown?: number
  /** 发送延迟（毫秒）；缺省回退全局 `defaultDelay`。 */
  delay?: number
}

/** 关键词规则：正则命中即回复固定文本。 */
export interface KeywordReplyRule extends ReplyRuleBase {
  type: 'keyword'
  /** 正则表达式字符串（匹配使用 `i` 标志）。 */
  pattern: string
  /** 命中后回复的文本。 */
  reply: string
}

/** AI 规则：命中后由 AI 生成回复（不含任何凭据字段）。 */
export interface AiReplyRule extends ReplyRuleBase {
  type: 'ai'
  /** 系统提示词；缺省使用内置默认。 */
  prompt?: string
  /**
   * 用户提示词模板（可选）。提供时以**结构化上下文**渲染当前用户轮，
   * 支持变量：`{{senderName}}` `{{content}}` `{{history}}` `{{historyCount}}`
   * `{{imageCount}}` `{{itemTitle}}` `{{itemPrice}}` `{{itemCity}}` `{{itemDescription}}`。
   * 缺省时使用「历史多轮 + 当前消息」的默认结构。
   */
  userPromptTemplate?: string
  /** 携带的历史消息条数上限；缺省 10。 */
  maxHistoryMessages?: number
  /** 覆盖全局模型名（不含凭据）。 */
  model?: string
  /** 覆盖全局超时（毫秒）。 */
  timeoutMs?: number
}

/** 回复规则。 */
export type ReplyRule = KeywordReplyRule | AiReplyRule

/** 全局回复配置（与规则列表分开存储）。 */
export interface ReplyGlobalConfig {
  /** 自动回复总开关；默认 false（安全）。 */
  enabled: boolean
  /** 回复模式；默认 `suggest`。 */
  mode: ReplyMode
  /** 默认冷却（毫秒）。 */
  defaultCooldown: number
  /** 默认发送延迟（毫秒）。 */
  defaultDelay: number
  /** 黑名单用户（senderId）。 */
  blacklist: string[]
  /** 命中即转人工的关键词（不自动发送）。 */
  handoffKeywords: string[]
  /** 频率保护：窗口内每会话自动回复上限。 */
  maxAutoRepliesPerSession: number
  /** 频率保护窗口（毫秒）。 */
  autoReplyWindowMs: number
  /** 非 Web 端人工回复触发的 AI 暂停时长（毫秒）。 */
  aiPauseDurationMs: number
  /** 单条发送内容长度上限。 */
  maxContentLength: number
}

/** 默认全局配置：关闭自动回复、建议模式、冷却 60s、延迟 1s、AI 暂停 10 分钟。 */
export const DEFAULT_REPLY_GLOBAL_CONFIG: ReplyGlobalConfig = {
  enabled: false,
  mode: 'suggest',
  defaultCooldown: 60000,
  defaultDelay: 1000,
  blacklist: [],
  handoffKeywords: [],
  maxAutoRepliesPerSession: 5,
  autoReplyWindowMs: 10 * 60 * 1000,
  aiPauseDurationMs: 10 * 60 * 1000,
  maxContentLength: 2000,
}

/** AI 默认 Base URL。 */
export const DEFAULT_AI_BASE_URL = 'https://api.openai.com/v1'
/** AI 默认模型。 */
export const DEFAULT_AI_MODEL = 'gpt-4o-mini'
/** AI 默认超时（毫秒）。 */
export const DEFAULT_AI_TIMEOUT_MS = 30000
/** AI 默认历史条数。 */
export const DEFAULT_AI_MAX_HISTORY = 10

/**
 * 回复上下文构建上限（长度上限与字段白名单）。
 *
 * 用于组装送 AI 的上下文：历史条数、单条正文、图片数量与 URL 长度均设上限，
 * 避免超大 / 异常数据外送，也便于诊断。
 */
export const REPLY_CONTEXT_LIMITS = {
  /** 携带历史条数上限。 */
  maxHistoryMessages: 20,
  /** 单条消息正文截断上限（字符）。 */
  maxContentLength: 1000,
  /** 上下文总图片数量上限（历史 + 当前）。 */
  maxImages: 3 as number,
  /** 单个图片 URL 长度上限。 */
  maxImageUrlLength: 2048,
  /** 商品描述截断上限（字符）。 */
  maxItemDescriptionLength: 300,
  /** 商品文本字段截断上限（标题 / 城市）。 */
  maxItemTextLength: 120,
} as const

/**
 * 回复上下文诊断摘要（非敏感）。
 *
 * 只包含条数与布尔，**绝不包含聊天正文、图片 URL 或任何凭据**，
 * 可安全进入命令响应与事件负载。
 */
export interface ReplyContextSummary {
  /** 实际携带的历史条数（不含当前消息）。 */
  historyCount: number
  /** 携带的图片数量（历史 + 当前）。 */
  imageCount: number
  /** 是否发生截断（历史条数 / 正文长度 / 图片数量任一）。 */
  truncated: boolean
  /** 是否携带关联商品信息。 */
  hasItem: boolean
}

/**
 * AI 供应方配置（含凭据）。
 * 仅允许配置适配器读取；不得写入规则、日志、事件或任何持久化规则数据。
 */
export interface AiProviderConfig {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs: number
}

/** 默认 AI 供应方配置（空 key 表示未配置）。 */
export const DEFAULT_AI_PROVIDER_CONFIG: AiProviderConfig = {
  apiKey: '',
  baseUrl: DEFAULT_AI_BASE_URL,
  model: DEFAULT_AI_MODEL,
  timeoutMs: DEFAULT_AI_TIMEOUT_MS,
}

// ---------------- AI 对话消息 ----------------

/** AI 角色。 */
export type AiRole = 'system' | 'user' | 'assistant'

/** 文本片段。 */
export interface AiTextPart {
  type: 'text'
  text: string
}

/** 图片片段（视觉能力保留接口；本轮不调用）。 */
export interface AiImagePart {
  type: 'image_url'
  image_url: { url: string }
}

/** 多模态内容片段。 */
export type AiContentPart = AiTextPart | AiImagePart

/** OpenAI 兼容的对话消息。 */
export interface AiChatMessage {
  role: AiRole
  content: string | AiContentPart[]
}

// ---------------- 决策与建议 ----------------

/** 跳过原因。 */
export type ReplySkipReason =
  | 'disabled'
  | 'ai-paused'
  | 'self'
  | 'outgoing'
  | 'blacklisted'
  | 'duplicate'
  | 'session-cooldown'
  | 'no-match'
  | 'handoff'
  | 'max-auto-replies'

/** 决策类型：跳过、给出建议、自动发送。 */
export type ReplyDecisionKind = 'skip' | 'suggest' | 'auto'

/** 规则引擎输出（纯逻辑，不发送）。 */
export interface ReplyDecision {
  kind: ReplyDecisionKind
  mode: ReplyMode
  /** 命中的规则 ID（`kind !== 'skip'` 时存在）。 */
  ruleId?: string
  /** 命中规则类型。 */
  ruleType?: ReplyRuleType
  /** 关键词规则可直接给出的回复文本；AI 规则为空。 */
  content?: string
  /** AI 规则需背景再调用 AI 才能得到 content。 */
  needsAi?: boolean
  /** AI 系统提示词。 */
  prompt?: string
  /** AI 用户提示词模板（可选，用于以结构化上下文渲染当前用户轮）。 */
  userPromptTemplate?: string
  /** AI 历史消息条数上限。 */
  maxHistoryMessages?: number
  /** AI 覆盖模型（不含凭据）。 */
  model?: string
  /** AI 覆盖超时（毫秒）。 */
  timeoutMs?: number
  /** 发送/建议前的延迟（毫秒）。 */
  delayMs: number
  /** 跳过 / 拦截原因。 */
  reason?: ReplySkipReason
}

/** 进入规则引擎的消息输入。 */
export interface ReplyIncomingMessage {
  messageId: string
  sessionId: string
  senderId: string
  receiverId: string
  direction: ChatDirection
  content: string
  itemId?: string
  createAt?: number
  /** 消息来源平台（如 `web` / `android`）；非 `web` 的 out 消息触发 AI 暂停。 */
  platform?: string
  /** 发送者昵称（可选，用于上下文元数据；不参与规则判定）。 */
  senderName?: string
  /** 关联商品标题（可选，用于上下文商品信息）。 */
  itemTitle?: string
  /** 归一后的内容类型（可选；`image` 表示图片消息）。 */
  kind?: string
  /** 原始 contentType 数值（可选；2 表示图片）。 */
  contentType?: number
  /** 图片消息 URL（可选；用于多模态上下文组装，仅 HTTPS 且限长）。 */
  imageUrl?: string
}

/** 建议结果。 */
export interface ReplySuggestion {
  sessionId: string
  /** 生成建议所用的消息 ID。 */
  messageId: string
  ruleId: string
  ruleType: ReplyRuleType
  mode: ReplyMode
  /** 建议回复正文。 */
  content: string
  /** 是否因安全闸需要人工确认（如关键词转人工）。 */
  requiresHuman: boolean
  generatedAt: number
  /**
   * 非敏感诊断元数据（上下文条数 / 图片数等）。
   * 不含聊天正文、图片 URL 或任何凭据，Workbench 可直接展示。
   */
  diagnostics?: {
    contextSummary: ReplyContextSummary
  }
}

/** 建议失败码。 */
export type ReplySuggestionFailureCode =
  | 'NO_MESSAGE'
  | 'NO_MATCH'
  | 'SKIPPED'
  | 'AI_DISABLED'
  | 'AI_ERROR'

/** 建议失败。 */
export interface ReplySuggestionFailure {
  ok: false
  code: ReplySuggestionFailureCode
  message: string
  /** 引擎跳过原因（`SKIPPED` 时存在）。 */
  reason?: ReplySkipReason
}

/** 建议成功。 */
export interface ReplySuggestionSuccess {
  ok: true
  suggestion: ReplySuggestion
}

/** 建议结果。 */
export type ReplySuggestionResult = ReplySuggestionSuccess | ReplySuggestionFailure

// ---------------- AI 暂停 ----------------

/** AI 暂停状态。 */
export interface AiPauseStatus {
  paused: boolean
  /** 暂停截止时间（毫秒时间戳）；未暂停为 0。 */
  pausedUntil: number
  /** 暂停原因；未暂停为 null。 */
  reason: string | null
}

// ---------------- 发送 ----------------

/** 发送错误码。 */
export type SendMessageErrorCode =
  | 'INVALID_INPUT'
  | 'NO_SOCKET'
  | 'ROUTE_NOT_ALLOWED'
  | 'DUPLICATE_MID'
  | 'SEND_FAILED'
  | 'LWP_ERROR'
  | 'TIMEOUT'
  | 'INVALID_RESPONSE'

/** 发送成功。 */
export interface SendMessageSuccess {
  ok: true
  /** 服务端消息标识（本实现为 uuid）。 */
  messageId: string
  sessionId: string
  receiverId: string
  sentAt: number
}

/** 发送失败。 */
export interface SendMessageFailure {
  ok: false
  error: { code: SendMessageErrorCode; message: string }
}

/** 发送结果。 */
export type SendMessageResult = SendMessageSuccess | SendMessageFailure

// ---------------- 自动回复状态 ----------------

/** 自动回复运行时状态（不含任何凭据/正文）。 */
export interface AutoReplyStatus {
  configLoaded: boolean
  enabled: boolean
  mode: ReplyMode
  rulesCount: number
  processedCount: number
  aiPaused: boolean
  aiPausedUntil: number
  aiPauseReason: string | null
  /** 是否已配置 AI 凭据（仅布尔，绝不暴露 key）。 */
  aiConfigured: boolean
}

// ---------------- 协议常量 ----------------

/** 闲鱼 LWP 发送路由。 */
export const SEND_LWP_ROUTE = '/r/MessageSend/sendByReceiverScope'
/** 闲鱼 ID 后缀。 */
export const GOOFISH_SUFFIX = '@goofish'
/** 发送超时（毫秒）。 */
export const SEND_TIMEOUT_MS = 10000
/** 文本消息内层 contentType（旧实现与抓包一致，非 101）。 */
export const TEXT_CONTENT_TYPE = 1
/** 文本消息外层 contentType。 */
export const OUTER_CONTENT_TYPE = 101
/** 发送内容长度上限。 */
export const MAX_SEND_CONTENT_LENGTH = 2000

/** 规则与配置的输入上限（运行时校验用）。 */
export const REPLY_LIMITS = {
  maxRules: 200,
  maxNameLength: 100,
  maxPatternLength: 500,
  maxReplyLength: 2000,
  maxBlacklist: 1000,
  maxHandoffKeywords: 200,
} as const
