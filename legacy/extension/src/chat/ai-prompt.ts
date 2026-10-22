/**
 * P6 AI 提示词构造（纯逻辑）。
 *
 * 迁移自 `chat` 分支 `auto-reply-processor.js` 的 `buildMessages`，但收敛为：
 * - 只处理**文本**历史（视觉能力本轮不接入，避免把图片 URL 送外部服务）；
 * - 注入商品详情（可选）；
 * - 去重「最后一条历史 == 当前消息」的情况，避免重复提问。
 *
 * 本模块不调用网络、不持有凭据。
 */
import type { ChatMessage } from '../../../shared/types/chat'
import {
  DEFAULT_AI_MAX_HISTORY,
  type AiChatMessage,
  type AiContentPart,
  type ReplyContextSummary,
  type ReplyIncomingMessage,
} from '../../../shared/types/reply'
import {
  buildReplyContext,
  maskSensitiveText,
  type ReplyContextSnapshot,
  type ReplyContextTurn,
  type ReplyItemContext,
} from './reply-context'

/** 默认系统提示词（与旧实现一致）。 */
export const DEFAULT_AI_SYSTEM_PROMPT =
  '你是一个闲鱼卖家的客服助手，请根据聊天记录和用户的最新消息进行回复。回复要简洁、友好、专业。不要用markdown格式。用中文回答。'

/**
 * 默认用户提示词模板（规则未提供 `userPromptTemplate` 时使用历史多轮结构）。
 *
 * 仅在显式提供模板变量时用于渲染当前用户轮；缺省路径不使用本模板。
 */
export const DEFAULT_AI_USER_PROMPT_TEMPLATE =
  '以下是与买家「{{senderName}}」的会话记录（最近 {{historyCount}} 条历史）：\n{{history}}\n\n【买家最新消息】\n{{content}}\n\n{{itemInfo}}'

/** 商品详情（用于拼接进提示词）。 */
export interface AiItemDetail {
  title: string
  price?: number | string
  description?: string
  city?: string
}

/** 构造入参。 */
export interface BuildAiMessagesInput {
  /** 历史消息（可乱序，内部按 createAt 升序排序）。 */
  history: readonly ChatMessage[]
  /** 当前消息。 */
  current: ReplyIncomingMessage
  /** 基础系统提示词；缺省 {@link DEFAULT_AI_SYSTEM_PROMPT}。 */
  basePrompt?: string
  /** 商品详情（可选）。 */
  itemDetail?: AiItemDetail
  /** 携带的历史条数上限；缺省 {@link DEFAULT_AI_MAX_HISTORY}。 */
  maxHistoryMessages?: number
}

/** 把商品详情拼进系统提示词（无详情时原样返回）；文本字段会先脱敏。 */
export function withItemDetail(basePrompt: string, itemDetail?: AiItemDetail): string {
  if (!itemDetail) return basePrompt
  const title = maskSensitiveText(String(itemDetail.title ?? ''))
  const description = itemDetail.description ? maskSensitiveText(itemDetail.description) : '无详细描述'
  const city = itemDetail.city ? maskSensitiveText(itemDetail.city) : '未设置'
  const lines = [
    '',
    '',
    '【当前咨询商品】',
    `商品名称：${title}`,
    `商品价格：${itemDetail.price === undefined ? '未设置' : `${itemDetail.price}元`}`,
    `商品描述：${description}`,
    `商品所在地：${city}`,
    '请根据以上商品信息，严格以商品价格为准，专业地回答用户关于该商品的问题。',
  ]
  return basePrompt + lines.join('\n')
}

/** 把标准消息转换为 AI 角色文本；空内容返回 null。 */
function toAiText(message: { direction: string; content: string }): { role: 'user' | 'assistant'; content: string } | null {
  const content = message.content.trim()
  if (content.length === 0) return null
  return { role: message.direction === 'out' ? 'assistant' : 'user', content }
}

/**
 * 构造 OpenAI 兼容的 messages 数组。
 * 结构：system → 历史（升序、最多 maxHistoryMessages 条）→ 当前消息（去重后）。
 */
export function buildAiMessages(input: BuildAiMessagesInput): AiChatMessage[] {
  const basePrompt = input.basePrompt && input.basePrompt.trim().length > 0 ? input.basePrompt : DEFAULT_AI_SYSTEM_PROMPT
  const maxHistory = input.maxHistoryMessages ?? DEFAULT_AI_MAX_HISTORY

  const sorted = [...input.history].sort((a, b) => (a.createAt ?? 0) - (b.createAt ?? 0))
  const converted: AiChatMessage[] = []
  for (const message of sorted) {
    const aiText = toAiText(message)
    if (aiText) converted.push(aiText)
  }
  const history = maxHistory > 0 ? converted.slice(Math.max(0, converted.length - maxHistory)) : []

  const messages: AiChatMessage[] = [{ role: 'system', content: withItemDetail(basePrompt, input.itemDetail) }]
  messages.push(...history)

  const current = toAiText(input.current)
  if (current) {
    const last = messages[messages.length - 1]
    const duplicate = typeof last.content === 'string' && last.role === current.role && last.content === current.content
    if (!duplicate) messages.push(current)
  }
  return messages
}

// ---------------- 结构化上下文 / 多模态（Goal B） ----------------

/** 用户提示词模板变量。 */
export interface ReplyPromptTemplateVars {
  senderName?: string
  content?: string
  history?: string
  historyCount?: number
  imageCount?: number
  itemTitle?: string
  itemPrice?: string | number
  itemCity?: string
  itemDescription?: string
  itemInfo?: string
}

/**
 * 渲染用户提示词模板。
 *
 * 支持的变量：`{{senderName}}` `{{content}}` `{{history}}` `{{historyCount}}`
 * `{{imageCount}}` `{{itemTitle}}` `{{itemPrice}}` `{{itemCity}}`
 * `{{itemDescription}}` `{{itemInfo}}`。
 * 未知变量替换为空字符串；所有变量值渲染前先脱敏。
 */
export function renderUserPromptTemplate(template: string, vars: ReplyPromptTemplateVars): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    const value = (vars as Record<string, unknown>)[name]
    if (value === undefined || value === null) return ''
    return maskSensitiveText(String(value))
  })
}

/** 把单轮上下文转为 OpenAI 兼容消息（有图时用多模态 parts）。 */
function turnToMessage(turn: ReplyContextTurn): AiChatMessage {
  if (turn.imageUrls.length === 0) {
    return { role: turn.role, content: turn.content }
  }
  const parts: AiContentPart[] = []
  if (turn.content.trim().length > 0) parts.push({ type: 'text', text: turn.content })
  for (const url of turn.imageUrls) parts.push({ type: 'image_url', image_url: { url } })
  return { role: turn.role, content: parts }
}

/** 把上下文拼为单段文本（用于 `{{history}}` 变量）。 */
function formatHistoryText(turns: readonly ReplyContextTurn[]): string {
  return turns
    .map((turn) => `${turn.role === 'assistant' ? '我' : '买家'}：${turn.content}${turn.imageUrls.length > 0 ? ' [图片]' : ''}`)
    .join('\n')
}

/** 拼商品信息块（用于 `{{itemInfo}}` 变量）。 */
function formatItemInfo(item: ReplyItemContext | undefined): string {
  if (!item) return ''
  const lines = ['【当前咨询商品】']
  if (item.title) lines.push(`商品名称：${item.title}`)
  if (item.price !== undefined) lines.push(`商品价格：${item.price}元`)
  if (item.description) lines.push(`商品描述：${item.description}`)
  if (item.city) lines.push(`商品所在地：${item.city}`)
  return lines.join('\n')
}

/** 构造入参（结构化上下文 + 多模态）。 */
export interface BuildReplyMessagesInput {
  /** 历史消息（可乱序，内部按 createAt 升序排序）。 */
  history: readonly ChatMessage[]
  /** 当前消息（可携带 imageUrl/kind/contentType 等）。 */
  current: ReplyIncomingMessage
  /** 基础系统提示词；缺省 {@link DEFAULT_AI_SYSTEM_PROMPT}。 */
  basePrompt?: string
  /** 商品详情（可选；白名单字段）。 */
  itemDetail?: AiItemDetail
  /** 用户提示词模板（可选）；提供时以结构化上下文渲染当前用户轮。 */
  userPromptTemplate?: string
  /** 携带历史条数上限；缺省 {@link DEFAULT_AI_MAX_HISTORY}。 */
  maxHistoryMessages?: number
  /** 是否允许携带图片（多模态）；缺省 true。 */
  includeImages?: boolean
}

/** 构造结果。 */
export interface BuiltReplyMessages {
  messages: AiChatMessage[]
  /** 非敏感诊断摘要（条数 / 图片数 / 截断 / 是否有商品）。 */
  contextSummary: ReplyContextSummary
  /** 结构化上下文快照（可复核）。 */
  context: ReplyContextSnapshot
}

/** 判断两条消息是否同构（用于去掉重复的最后一条历史）。 */
function isSameMessage(a: AiChatMessage, b: AiChatMessage): boolean {
  return a.role === b.role && JSON.stringify(a.content) === JSON.stringify(b.content)
}

/**
 * 构造结构化上下文 + 多模态 `messages`（Goal B 主入口）。
 *
 * 结构：system（含商品信息，脱敏）→ 历史轮（升序、限条数）→ 当前用户轮（去重后）。
 * 图片仅 HTTPS、去重、限数量与 URL 长度；无图片时退化为纯文本。
 */
export function buildReplyMessages(input: BuildReplyMessagesInput): BuiltReplyMessages {
  const basePrompt = input.basePrompt && input.basePrompt.trim().length > 0 ? input.basePrompt : DEFAULT_AI_SYSTEM_PROMPT
  const maxHistory = input.maxHistoryMessages ?? DEFAULT_AI_MAX_HISTORY

  const itemContext: ReplyItemContext | undefined = input.itemDetail
    ? {
        ...(input.itemDetail.title ? { title: input.itemDetail.title } : {}),
        ...(input.itemDetail.price === undefined ? {} : { price: input.itemDetail.price }),
        ...(input.itemDetail.description ? { description: input.itemDetail.description } : {}),
        ...(input.itemDetail.city ? { city: input.itemDetail.city } : {}),
      }
    : undefined

  const context = buildReplyContext({
    history: input.history,
    current: input.current,
    ...(itemContext === undefined ? {} : { item: itemContext }),
    maxHistoryMessages: maxHistory,
    includeImages: input.includeImages ?? true,
  })

  const messages: AiChatMessage[] = [{ role: 'system', content: withItemDetail(basePrompt, input.itemDetail) }]
  for (const turn of context.history) messages.push(turnToMessage(turn))

  const currentRole: 'user' | 'assistant' = context.current.role
  let currentMessage: AiChatMessage
  if (input.userPromptTemplate && input.userPromptTemplate.trim().length > 0) {
    const rendered = renderUserPromptTemplate(input.userPromptTemplate, {
      senderName: context.senderName,
      content: context.current.content,
      history: formatHistoryText(context.history),
      historyCount: context.summary.historyCount,
      imageCount: context.summary.imageCount,
      ...(context.item?.title === undefined ? {} : { itemTitle: context.item.title }),
      ...(context.item?.price === undefined ? {} : { itemPrice: context.item.price }),
      ...(context.item?.city === undefined ? {} : { itemCity: context.item.city }),
      ...(context.item?.description === undefined ? {} : { itemDescription: context.item.description }),
      itemInfo: formatItemInfo(context.item),
    })
    currentMessage = attachImages(currentRole, rendered, context.current.imageUrls)
  } else {
    currentMessage = attachImages(currentRole, context.current.content, context.current.imageUrls)
  }

  const last = messages[messages.length - 1]
  if (!last || !isSameMessage(last, currentMessage)) messages.push(currentMessage)
  return { messages, contextSummary: context.summary, context }
}

/** 组装一条消息：文本 + 可选图片 parts。 */
function attachImages(role: 'user' | 'assistant', text: string, imageUrls: readonly string[]): AiChatMessage {
  const trimmed = text.trim()
  if (imageUrls.length === 0) return { role, content: trimmed }
  const parts: AiContentPart[] = []
  if (trimmed.length > 0) parts.push({ type: 'text', text: trimmed })
  for (const url of imageUrls) parts.push({ type: 'image_url', image_url: { url } })
  return { role, content: parts }
}
