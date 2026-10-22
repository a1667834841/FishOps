import { isCursor, keys, object } from './index.ts'

/** M3 归一化消息；sourceId 必须来自稳定来源，不生成随机或时间替代 ID。 */
export type ChatMessage = {
  sourceId: string
  sessionId: string
  senderId: string
  text: string
  sentAt: number
  itemId?: string
  peerUserId?: string
}
/** 本地消息查询；afterSeq 是 SQLite 消息序号的十进制字符串。 */
export type ChatMessagesParams = { sessionId?: string; tag?: string; afterSeq: string; limit: number }
/** 本地会话查询；按稳定本地行号升序分页，updatedAfter 仅作筛选，不改变游标顺序。 */
export type ChatConversationsParams = { afterId: string; updatedAfter?: number; tag?: string; itemId?: string; limit: number }
/** 显式聊天同步；省略 sessionId 时同步会话列表，调度参数不属于平台业务参数。 */
export type ChatSyncParams = { sessionId?: string; maxWaitMs: number; minIntervalMs?: number; tag?: string }
/** 本模块支持的聊天读取方法；定义不代表已注册生产路由。 */
export type ChatReadMethod = 'chat.messages' | 'chat.conversations' | 'chat.sync'

function plain(value: unknown): value is Record<string, unknown> {
  if (!object(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && value.trim().length > 0
}
function bad(): never { throw Object.assign(new Error('聊天参数无效'), { code: 'BAD_REQUEST' }) }
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) bad()
  return value as number
}
function text(value: unknown): string {
  if (!id(value)) bad()
  return value.trim()
}
function cursor(value: unknown): string {
  if (value === undefined) return '0'
  if (!isCursor(value)) bad()
  return value
}

/**
 * 严格校验消息纯数据、已知字段和 UTF-8 JSON 字节数；失败返回 false，不修补来源 ID。
 * 正文可为空，最长 20000 个 UTF-16 码元；完整消息 JSON 最多 64KiB（含字段和转义）。
 */
export function isChatMessage(value: unknown): value is ChatMessage {
  try {
    if (!plain(value) || !keys(value, ['sourceId', 'sessionId', 'senderId', 'text', 'sentAt', 'itemId', 'peerUserId'])) return false
    // 只接受自有数据属性，拒绝 getter、不可枚举字段与 symbol 隐藏字段。
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) return false
    if (Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d))) return false
    if (!['sourceId', 'sessionId', 'senderId', 'text', 'sentAt'].every(k => Object.hasOwn(value, k))) return false
    if (!id(value.sourceId) || !id(value.sessionId) || !id(value.senderId)) return false
    for (const k of ['itemId', 'peerUserId']) if (Object.hasOwn(value, k) && !id(value[k])) return false
    if (typeof value.text !== 'string' || value.text.length > 20000) return false
    if (!Number.isSafeInteger(value.sentAt) || Number(value.sentAt) < 0) return false
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 65536
  } catch { return false }
}

/** 校验并复制聊天参数，补齐分页或等待默认值；非法输入抛 BAD_REQUEST，未知方法抛 NOT_FOUND。 */
export function normalizeChatParams(method: 'chat.messages', value: unknown): ChatMessagesParams
export function normalizeChatParams(method: 'chat.conversations', value: unknown): ChatConversationsParams
export function normalizeChatParams(method: 'chat.sync', value: unknown): ChatSyncParams
export function normalizeChatParams(method: string, value: unknown): ChatMessagesParams | ChatConversationsParams | ChatSyncParams
export function normalizeChatParams(method: string, value: unknown): ChatMessagesParams | ChatConversationsParams | ChatSyncParams {
  const allowed = method === 'chat.messages' ? ['sessionId', 'tag', 'afterSeq', 'limit']
    : method === 'chat.conversations' ? ['tag', 'itemId', 'updatedAfter', 'afterId', 'limit']
      : method === 'chat.sync' ? ['sessionId', 'maxWaitMs', 'minIntervalMs', 'tag'] : null
  if (!allowed) throw Object.assign(new Error('未知聊天方法'), { code: 'NOT_FOUND' })
  if (!plain(value) || !keys(value, allowed)) bad()
  if (Reflect.ownKeys(value).length !== Object.keys(value).length || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d))) bad()
  const tag = value.tag === undefined ? {} : { tag: text(value.tag) }
  if (method === 'chat.sync') {
    return {
      ...tag,
      ...(value.sessionId === undefined ? {} : { sessionId: text(value.sessionId) }),
      maxWaitMs: value.maxWaitMs === undefined ? 120000 : integer(value.maxWaitMs, 1, 600000),
      ...(value.minIntervalMs === undefined ? {} : { minIntervalMs: integer(value.minIntervalMs, 0, 600000) }),
    }
  }
  const limit = value.limit === undefined ? 100 : integer(value.limit, 1, 500)
  if (method === 'chat.messages') {
    const session = value.sessionId === undefined ? {} : { sessionId: text(value.sessionId) }
    if (!session.sessionId && !tag.tag) bad()
    return { ...tag, ...session, afterSeq: cursor(value.afterSeq), limit }
  }
  return {
    ...tag, afterId: cursor(value.afterId), limit,
    ...(value.itemId === undefined ? {} : { itemId: text(value.itemId) }),
    ...(value.updatedAfter === undefined ? {} : { updatedAfter: integer(value.updatedAfter, 0, Number.MAX_SAFE_INTEGER) }),
  }
}
