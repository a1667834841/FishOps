/** M4 写操作允许的公共方法；本模块不注册 METHODS。 */
export type WriteMethod = 'chat.open' | 'chat.send'
export type ChatOpenParams = { itemId: string; idempotencyKey: string; tag?: string; maxWaitMs?: number; minIntervalMs?: number }
export type ChatSendParams = { sessionId: string; receiverId: string; text: string; idempotencyKey: string; tag?: string; maxWaitMs?: number; minIntervalMs?: number }
export type ChatOpenResult = { sessionId: string; peerUserId: string | null; created: boolean }
export type ChatSendResult = { messageId: string; sentAt: number }
export type OperationState = 'attempting' | 'dispatching' | 'succeeded' | 'failed' | 'unknown'
export type OperationFingerprint = { accountId: string; method: WriteMethod; idempotencyKey: string; fingerprint: string }
export type OperationRecord<T = ChatOpenResult | ChatSendResult> = OperationFingerprint & { state: OperationState; result?: T; errorCode?: string }
const bad = (): never => { throw Object.assign(new Error('写操作参数无效'), { code: 'BAD_REQUEST' }) }
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Reflect.ownKeys(value).length === Object.keys(value).length && Object.values(descriptors).every(d => 'value' in d && d.enumerable)
}
function text(value: unknown, max: number, trim = true): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (trim && value.trim().length === 0)) bad()
  return trim ? (value as string).trim() : value as string
}
function option(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (value.tag !== undefined) out.tag = text(value.tag, 128)
  for (const key of ['maxWaitMs', 'minIntervalMs'] as const) if (value[key] !== undefined) {
    const min = key === 'maxWaitMs' ? 1 : 0
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < min || Number(value[key]) > 600000) bad()
    out[key] = value[key]
  }
  return out
}
/** 严格规范化写参数；不包含 tag 和调度元信息的指纹应由调用方按业务字段生成。 */
export function normalizeWriteParams(method: 'chat.open', value: unknown): ChatOpenParams
export function normalizeWriteParams(method: 'chat.send', value: unknown): ChatSendParams
export function normalizeWriteParams(method: string, value: unknown): ChatOpenParams | ChatSendParams
export function normalizeWriteParams(method: string, value: unknown): ChatOpenParams | ChatSendParams {
  if (!plain(value)) bad()
  const input = value as Record<string, unknown>
  const allowed = method === 'chat.open' ? ['itemId', 'idempotencyKey', 'tag', 'maxWaitMs', 'minIntervalMs'] : method === 'chat.send' ? ['sessionId', 'receiverId', 'text', 'idempotencyKey', 'tag', 'maxWaitMs', 'minIntervalMs'] : null
  if (!allowed || !Object.keys(input).every(k => allowed!.includes(k))) bad()
  const common = { idempotencyKey: text(input.idempotencyKey, 128), ...option(input) }
  if (method === 'chat.open') return { itemId: text(input.itemId, 128), ...common }
  const body = text(input.text, 2000, false)
  if (new TextEncoder().encode(body).length > 8192) bad()
  return { sessionId: text(input.sessionId, 128), receiverId: text(input.receiverId, 128), text: body, ...common }
}
/** 生成账号范围幂等指纹；tag、等待时间和最小间隔不参与指纹。 */
export function writeFingerprint(accountId: string, method: WriteMethod, params: ChatOpenParams | ChatSendParams): OperationFingerprint {
  if (typeof accountId !== 'string' || !accountId.trim()) bad()
  const normalized = normalizeWriteParams(method, params)
  const business = method === 'chat.open' ? { itemId: (normalized as ChatOpenParams).itemId } : { sessionId: (normalized as ChatSendParams).sessionId, receiverId: (normalized as ChatSendParams).receiverId, text: (normalized as ChatSendParams).text }
  const idempotencyKey = normalized.idempotencyKey
  const fingerprint = JSON.stringify([accountId, method, idempotencyKey, business])
  return { accountId, method, idempotencyKey, fingerprint }
}
