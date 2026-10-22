/**
 * 聊天中心的纯展示辅助函数（无 Vue / DOM 依赖，可直接在 Node 下测试）。
 *
 * 约束：这里只做「格式化 + 安全校验」，不虚构任何数据——
 * 拿不到的字段返回 null / 空串，由界面决定如何如实呈现「暂无」。
 */
import type { ChatMessage, ChatMessageKind, ChatSocketStatusPayload, Conversation } from './types'

/** 闲鱼商品详情页的固定 https 前缀；仅在 itemId 通过白名单校验后才拼接。 */
const ITEM_URL_BASE = 'https://www.goofish.com/item'

/** itemId 只允许字母数字与 `_`、`-`，且限制长度，避免拼出异常 URL。 */
const ITEM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * 仅放行 https 协议的 URL，其余（http / javascript: / data: / 带账号密码等）一律视为不可用。
 * 返回规范化后的 href；不合法返回 null。
 */
export function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  // 带用户名/密码的 URL 常用于钓鱼伪装，直接拒绝。
  if (url.username || url.password) return null
  if (!url.hostname) return null
  return url.href
}

/**
 * 由 itemId 生成商品页链接。P5 不提供完整商品详情，这里只给出「打开该 itemId」的链接，
 * 不展示价格、图片等无法确认的内容。itemId 不合法时返回 null。
 */
export function buildItemUrl(itemId: unknown): string | null {
  if (typeof itemId !== 'string' || !ITEM_ID_PATTERN.test(itemId)) return null
  return safeHttpsUrl(`${ITEM_URL_BASE}?id=${encodeURIComponent(itemId)}`)
}

/** WebSocket 状态的中文标签与色调。 */
export function socketStatusView(status: ChatSocketStatusPayload['status'] | null): {
  label: string
  tone: 'neutral' | 'ok' | 'warn' | 'error'
} {
  switch (status) {
    case 'open':
      return { label: '实时连接已建立', tone: 'ok' }
    case 'connecting':
      return { label: '实时连接中', tone: 'warn' }
    case 'closed':
      return { label: '实时连接已断开', tone: 'warn' }
    case 'error':
      return { label: '实时连接异常', tone: 'error' }
    default:
      return { label: '实时连接状态未知', tone: 'neutral' }
  }
}

const KIND_LABELS: Record<ChatMessageKind, string> = {
  text: '文本',
  image: '图片',
  voice: '语音',
  item: '商品',
  order: '订单',
  system: '系统',
  unknown: '未识别',
}

/** 消息类型的中文名。 */
export function messageKindLabel(kind: ChatMessageKind): string {
  return KIND_LABELS[kind] ?? KIND_LABELS.unknown
}

/** 消息气泡里要显示的文本：正文为空时退回类型提示，避免出现空白气泡。 */
export function messageDisplayText(message: ChatMessage): string {
  const text = typeof message.content === 'string' ? message.content.trim() : ''
  if (text) return message.content
  return `[${messageKindLabel(message.kind)}消息，无文字内容]`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 供 `<time datetime>` 使用的 ISO 字符串；时间戳无效（含越界）时返回 undefined，避免渲染期抛错。 */
export function isoTime(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return undefined
  const d = new Date(timestamp)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** 完整时间：YYYY-MM-DD HH:mm:ss；无效时间戳返回空串。 */
export function formatFullTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 列表用的短时间：当天只显示 HH:mm，同年显示 MM-DD，否则 YYYY-MM-DD。 */
export function formatShortTime(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return ''
  const d = new Date(timestamp)
  if (Number.isNaN(d.getTime())) return ''
  const n = new Date(now)
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.getFullYear() === n.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 把任意异常转成可展示的一行文案（只取 code / message，不拼接任何负载内容）。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' && code ? `${code}: ${error.message}` : error.message
  }
  return typeof error === 'string' && error ? error : '未知错误'
}

/** 把同步结果里的结构化错误转成一行文案。 */
export function describeSyncError(error: { code?: unknown; message?: unknown } | undefined): string {
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = typeof error?.message === 'string' ? error.message : ''
  if (code && message) return `${code}: ${message}`
  return code || message || '平台未返回失败原因'
}

/** 关联商品信息：仅包含从真实数据中得到的字段。 */
export interface ItemContext {
  itemId: string
  /** 仅当历史同步/消息中确有标题时才有值。 */
  itemTitle: string | null
  /** 通过校验的 https 链接；itemId 不合法时为 null（此时只显示 itemId 文本）。 */
  url: string | null
}

/**
 * 推导会话关联商品。
 * 优先取会话自带的 itemId；没有时取最新一条带 itemId 的消息。
 * 标题只在与 itemId 匹配的消息里查找；找不到就是 null，绝不拼造。
 */
export function deriveItemContext(
  conversation: Conversation | null,
  messages: readonly ChatMessage[],
): ItemContext | null {
  let itemId = conversation?.itemId?.trim() || ''
  if (!itemId) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const candidate = messages[i].itemId?.trim()
      if (candidate) {
        itemId = candidate
        break
      }
    }
  }
  if (!itemId) return null

  let itemTitle: string | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.itemId?.trim() === itemId && message.itemTitle?.trim()) {
      itemTitle = message.itemTitle.trim()
      break
    }
  }
  return { itemId, itemTitle, url: buildItemUrl(itemId) }
}

/** 对方信息：优先用会话列表，其次退回最近一条对方消息里的昵称/ID。 */
export interface PeerContext {
  name: string | null
  userId: string | null
}

export function derivePeer(conversation: Conversation | null, messages: readonly ChatMessage[]): PeerContext {
  const name = conversation?.peerUserName?.trim() || ''
  const userId = conversation?.peerUserId?.trim() || ''
  if (name || userId) return { name: name || null, userId: userId || null }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.direction !== 'in') continue
    const fallbackName = message.senderName?.trim() || ''
    const fallbackId = message.senderId?.trim() || ''
    if (fallbackName || fallbackId) return { name: fallbackName || null, userId: fallbackId || null }
  }
  return { name: null, userId: null }
}

/**
 * 对方头像 URL：优先会话字段，其次最近一条对方消息的发送者头像。
 * 只放行通过 https 校验的地址；拿不到时返回 null，由界面回退字母头像。
 */
export function peerAvatarUrl(conversation: Conversation | null, messages: readonly ChatMessage[]): string | null {
  const fromConversation = safeHttpsUrl(conversation?.peerAvatarUrl)
  if (fromConversation) return fromConversation
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.direction !== 'in') continue
    const url = safeHttpsUrl(message.senderAvatarUrl)
    if (url) return url
  }
  return null
}

/** 单条消息发送者头像 URL；仅 https 且经验证，缺失 / 非法返回 null。 */
export function messageAvatarUrl(message: ChatMessage): string | null {
  return safeHttpsUrl(message.senderAvatarUrl)
}
