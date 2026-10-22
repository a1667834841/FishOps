import { isChatMessage, type ChatMessage } from './chat.ts'

/** 聊天同步单页参数；anchor 是平台游标，不是本地事件序号。 */
export type ChatSyncPageParams =
  | { mode: 'conversations'; anchor: string; limit: number }
  | { mode: 'messages'; sessionId: string; anchor: string; limit: number }

/** 独立会话记录；关联字段未知时明确为 null，不依赖最后消息存在。 */
export type ChatSyncConversation = {
  sessionId: string
  peerUserId: string | null
  itemId: string | null
  updatedAt: number
  sortIndex: string
}

/** 未归一化模型数量；大于零表示覆盖不完整，不得静默当作完整页。 */
export type ChatSyncUnsupportedCount = number

type PageProgress = { hasMore: boolean; nextAnchor: string | null; unsupportedCount: ChatSyncUnsupportedCount }
/** 单页归一化结果；unsupportedCount 两种模式都必须提供。 */
export type ChatSyncPageResult = PageProgress & (
  | { mode: 'conversations'; conversations: ChatSyncConversation[] }
  | { mode: 'messages'; messages: ChatMessage[] }
)

export const CHAT_SYNC_MAX_RESULT_BYTES = 512 * 1024
const encoder = new TextEncoder()

/** 只接受无隐藏字段、无访问器的纯数据对象，避免验证期间运行调用者代码。 */
function record(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(value).length === fields.length && fields.every(key => {
    const d = descriptors[key]
    return d !== undefined && d.enumerable && 'value' in d
  })
}
function id(value: unknown): value is string { return typeof value === 'string' && !!value.trim() && value.length <= 128 }
function nonnegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function anchor(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 16 && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)
}
/** 校验内部单页参数；不补默认值、不修正游标、不接受公共调度字段。 */
export function isChatSyncPageParams(value: unknown): value is ChatSyncPageParams {
  try {
    if (!value || typeof value !== 'object') return false
    const mode = Object.getOwnPropertyDescriptor(value, 'mode')?.value
    const fields = mode === 'conversations' ? ['mode', 'anchor', 'limit'] : mode === 'messages' ? ['mode', 'sessionId', 'anchor', 'limit'] : null
    return fields !== null && record(value, fields) && anchor(value.anchor) &&
      Number.isInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 100 &&
      (mode !== 'messages' || id(value.sessionId))
  } catch { return false }
}
/** 会话纯数据严格校验，所有字段必填且未知关联只能为 null。 */
export function isChatSyncConversation(value: unknown): value is ChatSyncConversation {
  try {
    return record(value, ['sessionId', 'peerUserId', 'itemId', 'updatedAt', 'sortIndex']) && id(value.sessionId) &&
      (value.peerUserId === null || id(value.peerUserId)) && (value.itemId === null || id(value.itemId)) &&
      nonnegative(value.updatedAt) && anchor(value.sortIndex)
  } catch { return false }
}
function list(value: unknown, validate: (entry: unknown) => boolean): value is unknown[] {
  if (!Array.isArray(value) || value.length > 100 || Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i))
    if (!d || !('value' in d) || !d.enumerable || !validate(d.value)) return false
  }
  return true
}
/** 只验证结果本身；上下文游标进展和请求页大小由 validateResult 再检查。 */
export function isChatSyncPageResult(value: unknown): value is ChatSyncPageResult {
  try {
    if (!value || typeof value !== 'object') return false
    const mode = Object.getOwnPropertyDescriptor(value, 'mode')?.value
    const collection = mode === 'conversations' ? 'conversations' : mode === 'messages' ? 'messages' : null
    if (!collection || !record(value, ['mode', collection, 'hasMore', 'nextAnchor', 'unsupportedCount'])) return false
    if (typeof value.hasMore !== 'boolean' || !nonnegative(value.unsupportedCount)) return false
    if (value.hasMore ? !anchor(value.nextAnchor) : value.nextAnchor !== null) return false
    if (!list(value[collection], mode === 'conversations' ? isChatSyncConversation : isChatMessage)) return false
    return encoder.encode(JSON.stringify(value)).byteLength <= CHAT_SYNC_MAX_RESULT_BYTES
  } catch { return false }
}
/** 核验单页结果与请求一致，游标必须严格递减；不把 unsupportedCount>0 修补成完整覆盖。 */
export function validateResult(params: unknown, value: unknown): value is ChatSyncPageResult {
  if (!isChatSyncPageParams(params) || !isChatSyncPageResult(value) || params.mode !== value.mode) return false
  if (value.hasMore && BigInt(value.nextAnchor!) >= BigInt(params.anchor)) return false
  const entries = value.mode === 'conversations' ? value.conversations : value.messages
  if (entries.length + value.unsupportedCount > params.limit) return false
  if (params.mode === 'messages' && value.mode === 'messages' && value.messages.some(m => m.sessionId !== params.sessionId)) return false
  return true
}
