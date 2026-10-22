import { normalizeChatParams } from './chat.ts'
import { normalizeChatSyncInput } from './chat-sync-input.ts'
import { isPublishResult, normalizePublishMyItemsParams, normalizePublishPrepareParams, normalizePublishSubmitParams } from './publish.ts'
import { normalizeWriteParams } from './write.ts'

/** 公共协议：运行时验证与静态类型共享一个入口。 */
export const PROTOCOL_VERSION = 1 as const
export const VERSION = '0.2.0'
export const HOST_NAME = 'top.ggball.fishops'
export const METHODS = ['system.status', 'events.list', 'requests.list', 'search.items', 'search.suggest', 'item.detail', 'chat.messages', 'chat.conversations', 'chat.sync', 'chat.sync.status', 'chat.send', 'publish.prepare', 'publish.submit', 'publish.myItems', 'risk.status', 'risk.clear'] as const
export const EVENT_TYPES = ['account.changed', 'chat.message', 'chat.gap', 'chat.socket', 'risk.signal', 'publish.result'] as const
export type Account = { userId: string; nick: string } | null
export type ErrorCode = 'BAD_REQUEST' | 'NOT_FOUND' | 'INTERNAL' | 'UNAUTHORIZED' | 'ORIGIN_FORBIDDEN' | 'METHOD_NOT_ALLOWED' | 'PAYLOAD_TOO_LARGE' | 'EXTENSION_OFFLINE' | 'PAGE_NOT_READY' | 'LOGIN_REQUIRED' | 'TIMEOUT' | 'RESULT_UNKNOWN' | 'IDEMPOTENCY_CONFLICT' | 'ACCOUNT_CHANGED' | 'RISK_BLOCKED' | 'PLATFORM_REJECTED' | 'CANCELLED'
export type ApiError = { code: ErrorCode; message: string; phase?: 'queue' | 'read' | 'write'; retryable?: boolean }
export type Wire =
  | { kind: 'hello'; protocolVersion: 1; extensionVersion: string; extensionBuildId?: string; account: Account }
  | { kind: 'req'; id: string; method: string; params?: unknown }
  | { kind: 'res'; id: string; ok: true; data: unknown }
  | { kind: 'res'; id: string; ok: false; error: ApiError }
  | { kind: 'event'; type: 'account.changed'; data: { account: Account } }
export type ExtensionStatus = { extensionVersion: string; account: Account; page: { present: boolean }; chatReady: null }
export const unobservedRisk = () => ({ level: 'unobserved' as const, observedAt: null, signals: [], usage: {} })
export function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
export function isAccount(value: unknown): value is Account { return value === null || (object(value) && keys(value, ['userId', 'nick']) && typeof value.userId === 'string' && value.userId.length > 0 && typeof value.nick === 'string') }
export function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every(key => allowed.includes(key)) }
export function isCursor(value: unknown): value is string { return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && value.length <= 19 && BigInt(value) <= 9223372036854775807n }
/** 构建身份格式：随机 UUID 或 64 位小写 hex（SHA-256）二者之一，不混用。 */
const BUILD_ID_PATTERNS: readonly RegExp[] = [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, /^[0-9a-f]{64}$/]
/** 校验 hello 里可选的构建身份；不符合统一格式即拒绝，避免把任意串当作可追踪标识。 */
export function isExtensionBuildId(value: unknown): value is string { return typeof value === 'string' && BUILD_ID_PATTERNS.some(pattern => pattern.test(value)) }
const codes: readonly string[] = ['BAD_REQUEST','NOT_FOUND','INTERNAL','UNAUTHORIZED','ORIGIN_FORBIDDEN','METHOD_NOT_ALLOWED','PAYLOAD_TOO_LARGE','EXTENSION_OFFLINE','PAGE_NOT_READY','LOGIN_REQUIRED','TIMEOUT','RESULT_UNKNOWN','IDEMPOTENCY_CONFLICT','ACCOUNT_CHANGED','RISK_BLOCKED','PLATFORM_REJECTED','CANCELLED']
export function isWire(v: unknown): v is Wire {
  if (!object(v)) return false
  if (v.kind === 'hello') return keys(v,['kind','protocolVersion','extensionVersion','extensionBuildId','account']) && v.protocolVersion === 1 && typeof v.extensionVersion === 'string' && !!v.extensionVersion && (v.extensionBuildId === undefined || isExtensionBuildId(v.extensionBuildId)) && isAccount(v.account)
  if (v.kind === 'event') return keys(v,['kind','type','data']) && v.type === 'account.changed' && object(v.data) && keys(v.data,['account']) && isAccount(v.data.account)
  if (typeof v.id !== 'string' || !v.id || v.id.length > 128) return false
  if (v.kind === 'req') return keys(v,['kind','id','method','params']) && typeof v.method === 'string' && !!v.method
  if (v.kind !== 'res' || typeof v.ok !== 'boolean') return false
  if (v.ok) return keys(v,['kind','id','ok','data']) && 'data' in v
  return keys(v,['kind','id','ok','error']) && object(v.error) && keys(v.error,['code','message','phase','retryable']) && typeof v.error.code === 'string' && codes.includes(v.error.code) && typeof v.error.message === 'string' && (v.error.phase === undefined || ['queue','read','write'].includes(String(v.error.phase))) && (v.error.retryable === undefined || typeof v.error.retryable === 'boolean')
}
export function validateParams(method: string, v: unknown): Record<string, unknown> {
  if (!object(v)) throw new Error('BAD_REQUEST')
  if (method === 'chat.messages' || method === 'chat.conversations') return { ...normalizeChatParams(method, v) }
  if (method === 'chat.sync') return { ...normalizeChatSyncInput(v) }
  if (method === 'chat.sync.status') {
    if (!keys(v, ['runId']) || typeof v.runId !== 'string' || !/^[0-9a-f-]{36}$/.test(v.runId)) throw new Error('BAD_REQUEST')
    return { runId: v.runId }
  }
  if (method === 'chat.send') return { ...normalizeWriteParams('chat.send', v) }
  if (method === 'publish.prepare') return { ...normalizePublishPrepareParams(v) }
  if (method === 'publish.submit') return { ...normalizePublishSubmitParams(v) }
  if (method === 'publish.myItems') return { ...normalizePublishMyItemsParams(v) }
  // risk.clear 必须显式声明人工已完成验证，防止 Agent 无意识地解除熔断。
  // 该分支提前 return，因此 tag 长度约束必须在此处一并校验，否则超限审计标签会绕过通用规则。
  if (method === 'risk.clear') {
    if (!keys(v,['manualVerified','tag']) || v.manualVerified !== true) throw new Error('BAD_REQUEST')
    if (v.tag !== undefined && (typeof v.tag !== 'string' || !v.tag.length || v.tag.length > 128)) throw new Error('BAD_REQUEST')
    return v
  }
  const allowed = method === 'system.status' || method === 'risk.status' ? ['tag'] : method === 'events.list' ? ['afterSeq','types','tag','limit'] : method === 'requests.list' ? ['afterId','tag','fromTs','toTs','limit'] : method === 'search.items' ? ['keyword','page','rowsPerPage','filter','maxAgeSec','maxWaitMs','minIntervalMs','tag'] : method === 'search.suggest' ? ['keyword','maxWaitMs','minIntervalMs','tag'] : method === 'item.detail' ? ['itemId','maxAgeSec','maxWaitMs','minIntervalMs','tag'] : null
  if (!allowed) throw new Error('NOT_FOUND')
  if (!keys(v,allowed)) throw new Error('BAD_REQUEST')
  if (v.tag !== undefined && (typeof v.tag !== 'string' || !v.tag.length || v.tag.length > 128)) throw new Error('BAD_REQUEST')
  for (const key of ['afterSeq','afterId']) if (v[key] !== undefined && !isCursor(v[key])) throw new Error('BAD_REQUEST')
  if (v.limit !== undefined && (!Number.isInteger(v.limit) || Number(v.limit)<1 || Number(v.limit)>500)) throw new Error('BAD_REQUEST')
  if (v.types !== undefined && (!Array.isArray(v.types) || v.types.length>20 || !v.types.every(t => EVENT_TYPES.includes(t as typeof EVENT_TYPES[number])))) throw new Error('BAD_REQUEST')
  for (const key of ['fromTs','toTs']) if (v[key] !== undefined && (!Number.isSafeInteger(v[key]) || Number(v[key])<0)) throw new Error('BAD_REQUEST')
  if (v.fromTs !== undefined && v.toTs !== undefined && Number(v.fromTs)>=Number(v.toTs)) throw new Error('BAD_REQUEST')
  return v
}
/** 验证扩展只读状态，避免未校验的 native data 进入公共响应。 */
export function isExtensionStatus(v: unknown): v is ExtensionStatus {
  return object(v) && keys(v,['extensionVersion','account','page','chatReady']) && typeof v.extensionVersion === 'string' && !!v.extensionVersion && isAccount(v.account) && object(v.page) && keys(v.page,['present']) && typeof v.page.present === 'boolean' && v.chatReady === null
}
/** M5 发布契约：参数规范化、指纹与结果校验统一从此入口再导出。 */
export * from './publish.ts'
