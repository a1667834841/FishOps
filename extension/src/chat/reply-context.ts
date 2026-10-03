/**
 * P6 回复上下文组装（纯逻辑，不调用网络、不持有凭据）。
 *
 * 目标：把当前会话整理成送 AI 的**结构化上下文**，并保证安全边界：
 * - 只携带白名单字段：历史消息的角色/正文/图片、发送者昵称、关联商品的
 *   `itemId/title/price/description/city`；其它字段一律丢弃；
 * - 长度上限：历史条数、单条正文、商品文本、图片数量与 URL 长度均封顶；
 * - 图片只允许 **HTTPS**，去重且限长；无图片时退化为纯文本；
 * - 文本脱敏：Bearer、sk- 前缀密钥、飞书 token、`password=...` 等凭据特征与手机号中段会被打码，
 *   避免把 cookie/token/key 或完整个人信息送出。
 *
 * 本模块不做发送、不生成建议，只产出可复核的上下文快照与**非敏感**诊断摘要。
 */
import type { ChatMessage } from '../../../shared/types/chat'
import {
  REPLY_CONTEXT_LIMITS,
  type ReplyContextSummary,
  type ReplyIncomingMessage,
} from '../../../shared/types/reply'

/** 关联商品上下文字段白名单（未列出的字段不进入上下文）。 */
export interface ReplyItemContext {
  itemId?: string
  title?: string
  price?: number | string
  description?: string
  city?: string
}

/** 单轮上下文（角色 + 脱敏正文 + 图片 URL）。 */
export interface ReplyContextTurn {
  role: 'user' | 'assistant'
  content: string
  imageUrls: string[]
}

/** 结构化回复上下文快照（可复核，不含原始对象）。 */
export interface ReplyContextSnapshot {
  sessionId: string
  targetMessageId: string
  senderId: string
  senderName: string
  /** 历史轮（升序），不含当前消息。 */
  history: ReplyContextTurn[]
  /** 当前目标消息轮。 */
  current: ReplyContextTurn
  /** 关联商品（白名单字段）。 */
  item?: ReplyItemContext
  /** 非敏感诊断摘要。 */
  summary: ReplyContextSummary
}

/** 组装入参。 */
export interface BuildReplyContextInput {
  /** 历史消息（可乱序，内部按 createAt 升序排序）。 */
  history: readonly ChatMessage[]
  /** 当前目标消息（可携带 imageUrl/kind/contentType/商品标题等）。 */
  current: ReplyIncomingMessage
  /** 商品详情（可选，白名单字段）。 */
  item?: ReplyItemContext
  /** 携带历史条数上限；缺省 {@link REPLY_CONTEXT_LIMITS.maxHistoryMessages}。 */
  maxHistoryMessages?: number
  /** 是否允许携带图片；缺省 true。 */
  includeImages?: boolean
}

/**
 * 敏感信息打码（幂等、保守）。
 *
 * 覆盖：Bearer token、OpenAI 风格 `sk-*`、飞书 `t-*` 租户 token、
 * `password/token/secret/api_key/authorization/cookie=...` 赋值、手机号中段。
 */
export function maskSensitiveText(text: string): string {
  if (!text) return text
  let output = text
  // 1) Authorization / Bearer。
  output = output.replace(/bearer\s+[a-z0-9._~+/-]{8,}=*/gi, 'Bearer [REDACTED]')
  // 2) 常见密钥前缀。
  output = output.replace(/\b(?:sk|rk|pk)-[a-z0-9_-]{6,}/gi, '[REDACTED_KEY]')
  // 3) 飞书 tenant/app token 常见前缀。
  output = output.replace(/\bt-[a-z0-9]{16,}/gi, '[REDACTED_TOKEN]')
  // 4) key=value / key: value 形式的凭据。
  output = output.replace(
    /\b(password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]{4,}/gi,
    '$1=[REDACTED]',
  )
  // 5) 手机号中段打码（保留前 3 后 4）。
  output = output.replace(/\b(1[3-9]\d)\d{4}(\d{4})\b/g, '$1****$2')
  return output
}

/** 截断文本到上限（返回是否发生截断）。 */
function truncateText(text: string, maxLength: number): { text: string; truncated: boolean } {
  if (text.length <= maxLength) return { text, truncated: false }
  return { text: text.slice(0, maxLength), truncated: true }
}

/** 规整单条正文：脱敏 + 截断。 */
export function sanitizeContextContent(content: string, maxLength: number = REPLY_CONTEXT_LIMITS.maxContentLength): { text: string; truncated: boolean } {
  const trimmed = (content ?? '').trim()
  if (trimmed.length === 0) return { text: '', truncated: false }
  const masked = maskSensitiveText(trimmed)
  return truncateText(masked, maxLength)
}

/** 是否为合法（HTTPS 且限长）图片 URL。 */
export function isAllowedImageUrl(url: unknown, maxLength: number = REPLY_CONTEXT_LIMITS.maxImageUrlLength): url is string {
  if (typeof url !== 'string') return false
  const trimmed = url.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return false
  return /^https:\/\/[^\s]+$/i.test(trimmed)
}

/** 递归收集 JSON 结构中的 HTTPS URL（历史消息正文可能内嵌图片结构）。 */
function collectHttpsUrlsFromJson(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (isAllowedImageUrl(value)) out.push(value.trim())
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectHttpsUrlsFromJson(item, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectHttpsUrlsFromJson(item, out)
  }
}

/**
 * 从单条消息提取图片 URL。
 *
 * 来源优先级：`message.imageUrl` → `content` 内嵌 JSON 结构 → 图片消息的裸 HTTPS URL。
 * 结果只保留 HTTPS、去重、限长，且最多 {@link REPLY_CONTEXT_LIMITS.maxImages} 条。
 */
export function extractImageUrls(
  message: Pick<ChatMessage, 'content' | 'imageUrl'> & { kind?: string; contentType?: number },
  maxCount: number = REPLY_CONTEXT_LIMITS.maxImages,
): string[] {
  if (maxCount <= 0) return []
  const candidates: string[] = []

  if (message.imageUrl) candidates.push(message.imageUrl)

  const content = typeof message.content === 'string' ? message.content : ''
  if (content.includes('{') || content.includes('[')) {
    try {
      collectHttpsUrlsFromJson(JSON.parse(content), candidates)
    } catch {
      // 非 JSON：忽略，走下方裸 URL 分支。
    }
  }
  const isImageMessage = message.kind === 'image' || message.contentType === 2
  if (isImageMessage && /^https:\/\//i.test(content.trim())) candidates.push(content.trim())

  const seen = new Set<string>()
  const result: string[] = []
  for (const candidate of candidates) {
    if (!isAllowedImageUrl(candidate)) continue
    const url = candidate.trim()
    if (seen.has(url)) continue
    seen.add(url)
    result.push(url)
    if (result.length >= maxCount) break
  }
  return result
}

/** 把商品详情规整为白名单字段（脱敏 + 截断）。 */
export function sanitizeItemContext(item: ReplyItemContext | undefined): ReplyItemContext | undefined {
  if (!item) return undefined
  const result: ReplyItemContext = {}
  if (typeof item.itemId === 'string' && item.itemId.trim().length > 0) result.itemId = item.itemId.trim()
  if (typeof item.title === 'string' && item.title.trim().length > 0) {
    result.title = maskSensitiveText(item.title.trim()).slice(0, REPLY_CONTEXT_LIMITS.maxItemTextLength)
  }
  if (typeof item.price === 'number' || typeof item.price === 'string') {
    if (item.price !== '') result.price = item.price
  }
  if (typeof item.description === 'string' && item.description.trim().length > 0) {
    result.description = maskSensitiveText(item.description.trim()).slice(0, REPLY_CONTEXT_LIMITS.maxItemDescriptionLength)
  }
  if (typeof item.city === 'string' && item.city.trim().length > 0) {
    result.city = maskSensitiveText(item.city.trim()).slice(0, REPLY_CONTEXT_LIMITS.maxItemTextLength)
  }
  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * 组装结构化回复上下文。
 *
 * 顺序：历史按 `createAt` 升序 → 取最后 N 条 → 追加当前消息。
 * 图片预算优先分配给最新的消息（当前消息 → 历史由新到旧），保证总量不超过上限。
 */
export function buildReplyContext(input: BuildReplyContextInput): ReplyContextSnapshot {
  const maxHistory = Math.max(0, input.maxHistoryMessages ?? REPLY_CONTEXT_LIMITS.maxHistoryMessages)
  const includeImages = input.includeImages ?? true
  let truncated = false

  const sortedHistory = [...input.history]
    .filter((message) => message.createAt !== undefined)
    .sort((a, b) => (a.createAt ?? 0) - (b.createAt ?? 0))

  const selected = maxHistory > 0 ? sortedHistory.slice(Math.max(0, sortedHistory.length - maxHistory)) : []
  if (sortedHistory.length > selected.length) truncated = true

  const toTurn = (message: ChatMessage): ReplyContextTurn | null => {
    const sanitized = sanitizeContextContent(message.content)
    if (sanitized.truncated) truncated = true
    const role: 'user' | 'assistant' = message.direction === 'out' ? 'assistant' : 'user'
    const content = sanitized.text
    if (content.length === 0 && !message.imageUrl && message.kind !== 'image') return null
    return { role, content, imageUrls: [] }
  }

  const historyTurns: ReplyContextTurn[] = []
  /** 与 historyTurns 一一对应的来源消息（用于图片提取）。 */
  const historyEntries: Array<{ message: ChatMessage; turn: ReplyContextTurn }> = []
  for (const message of selected) {
    const turn = toTurn(message)
    if (!turn) continue
    historyTurns.push(turn)
    historyEntries.push({ message, turn })
  }

  // 当前消息轮。
  const currentSanitized = sanitizeContextContent(input.current.content)
  if (currentSanitized.truncated) truncated = true
  const currentTurn: ReplyContextTurn = {
    role: input.current.direction === 'out' ? 'assistant' : 'user',
    content: currentSanitized.text,
    imageUrls: [],
  }

  // 图片预算：当前消息优先，其次历史由新到旧。
  let imageCount = 0
  if (includeImages) {
    const budget = REPLY_CONTEXT_LIMITS.maxImages
    const takeImages = (
      message: Pick<ChatMessage, 'content' | 'imageUrl'> & { kind?: string; contentType?: number },
      turn: ReplyContextTurn,
    ): void => {
      const urls = extractImageUrls(message, REPLY_CONTEXT_LIMITS.maxImages)
      if (urls.length === 0) return
      const room = Math.max(0, budget - imageCount)
      const take = urls.slice(0, room)
      if (take.length < urls.length) truncated = true
      if (take.length === 0) return
      turn.imageUrls = take
      imageCount += take.length
    }

    const currentSource = {
      content: input.current.content,
      ...(input.current.imageUrl === undefined ? {} : { imageUrl: input.current.imageUrl }),
      ...(input.current.kind === undefined ? {} : { kind: input.current.kind }),
      ...(input.current.contentType === undefined ? {} : { contentType: input.current.contentType }),
    }
    takeImages(currentSource, currentTurn)

    // 历史图片：按选中顺序逆序（新 → 旧）分配预算。
    for (let i = historyEntries.length - 1; i >= 0; i -= 1) {
      const entry = historyEntries[i]
      if (!entry) continue
      takeImages(entry.message, entry.turn)
    }
  }

  const item = sanitizeItemContext(input.item)
  const summary: ReplyContextSummary = {
    historyCount: historyTurns.length,
    imageCount,
    truncated,
    hasItem: item !== undefined,
  }

  return {
    sessionId: input.current.sessionId,
    targetMessageId: input.current.messageId,
    senderId: input.current.senderId,
    senderName: maskSensitiveText((input.current.senderName ?? '').trim()),
    history: historyTurns,
    current: currentTurn,
    ...(item === undefined ? {} : { item }),
    summary,
  }
}
