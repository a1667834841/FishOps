/**
 * 平台调用协议：MAIN world runtime host ↔ background 的最小调用契约。
 *
 * 设计目标：
 * - 与 P1 的 `shared/events` Bridge 解耦（不改动既有 Command/Event），通过独立的
 *   `channel` 标记识别平台调用信封，避免两类消息互相污染；
 * - 与 DOM / `window` 无关，仅是一组纯类型 + 校验函数，便于 Node 测试；
 * - 请求带 `callId`，与 P1 的 `requestId` 思路一致，便于把响应匹配回请求。
 */
import type { PlatformErrorPayload } from './errors'

/** 平台调用信封的通道标记，用于把平台消息与其他 postMessage 区分开。 */
export const PLATFORM_CHANNEL = 'fishops-platform'

/** 平台调用方法名（一律以 `platform.` 前缀，和 PLAN 的 `platform.ping` 一致）。 */
export const PlatformMethods = {
  /** 连通性探测：确认 MAIN world host 已就绪。 */
  PING: 'platform.ping',
  /** 商品搜索，返回 MTOP 原始 JSON。 */
  SEARCH: 'platform.search',
  /** 商品详情，返回 MTOP 原始 JSON。 */
  DETAIL: 'platform.detail',
  /** 搜索建议（流量词），返回词列表。 */
  SUGGEST: 'platform.suggest',
  /** 登录态检测。 */
  AUTH_STATE: 'platform.authState',
  /** 当前登录用户 ID。 */
  CURRENT_USER_ID: 'platform.currentUserId',
  /** 当前账号官方「我的商品库」在售商品（读全：分组发现 + nextPage 分页）。 */
  PUBLISHED_ITEMS: 'platform.publishedItems',
} as const

export type PlatformMethod = (typeof PlatformMethods)[keyof typeof PlatformMethods]

/** 判断是否为已知的平台方法名。 */
export function isPlatformMethod(value: unknown): value is PlatformMethod {
  return typeof value === 'string' && (Object.values(PlatformMethods) as string[]).includes(value)
}

/** 无参数方法的占位参数类型。 */
export type EmptyParams = Record<string, never>

/** 搜索参数。默认值在 mtop-client 内与旧 `fetchSearchData` 对齐。 */
export interface SearchParams {
  keyword: string
  /** 页码，默认 1。 */
  pageNumber?: number
  /** 每页数量，默认 30。 */
  rowsPerPage?: number
  /** 搜索过滤串，默认 `publishDays:14;`（与旧实现一致）。 */
  searchFilter?: string
  /** 搜索来源页，默认 `pcSearch`。 */
  searchReqFromPage?: string
  /**
   * 搜索专用基础间隔（毫秒）。仅采集搜索会传递：携带时该次搜索改用「基础间隔 +
   * 随机增量」节流，而非全局固定 1500ms；缺省 / 非采集请求保持全局限速不变。
   */
  minIntervalMs?: number
  /** 搜索专用随机增量上限（毫秒），配合 `minIntervalMs` 使用。 */
  intervalJitterMs?: number
}

/** 详情参数。 */
export interface DetailParams {
  itemId: string
}

/** 搜索建议参数。 */
export interface SuggestParams {
  inputWords: string
  searchReqFromPage?: string
  bucketId?: number
  type?: number
}

/** PING 结果。 */
export interface PingResult {
  pong: true
  /** 标识响应来自 MAIN world host。 */
  host: 'main-world'
  /** host 当前时间，便于粗略校时。 */
  now: number
}

/** 登录态。 */
export interface AuthStateResult {
  /** 是否具备可用登录态（存在 token）。 */
  loggedIn: boolean
  /** 是否存在 `_m_h5_tk`。 */
  hasToken: boolean
}

/** 当前用户 ID 结果。 */
export interface CurrentUserIdResult {
  userId: string | null
}

/** 当前账号在售商品读取参数。 */
export interface PublishedItemsParams {
  /** 每页条数（官方上限 20，超出会被服务端拒绝）。 */
  pageSize?: number
  /** 防御性翻页上限（在售商品极端多时也要有界）。 */
  maxPages?: number
}

/** 当前账号在售商品读取结果（只暴露真实业务卡片，不含任何凭据）。 */
export interface PublishedItemsResult {
  /** 归属账号 ID（官方 `unb` / `havana` 解析）。 */
  accountId: string
  /** 原始在售卡片（`cardList[].cardData`，未归一）。 */
  items: MtopRawResult[]
}

/** MTOP 原始 JSON 响应（保留关键字段，不裁剪）。 */
export type MtopRawResult = Record<string, unknown>

/** 方法 → 参数 映射。 */
export interface PlatformParamsMap {
  [PlatformMethods.PING]: EmptyParams
  [PlatformMethods.SEARCH]: SearchParams
  [PlatformMethods.DETAIL]: DetailParams
  [PlatformMethods.SUGGEST]: SuggestParams
  [PlatformMethods.AUTH_STATE]: EmptyParams
  [PlatformMethods.CURRENT_USER_ID]: EmptyParams
  [PlatformMethods.PUBLISHED_ITEMS]: PublishedItemsParams
}

/** 方法 → 结果 映射。 */
export interface PlatformResultMap {
  [PlatformMethods.PING]: PingResult
  [PlatformMethods.SEARCH]: MtopRawResult
  [PlatformMethods.DETAIL]: MtopRawResult
  [PlatformMethods.SUGGEST]: string[]
  [PlatformMethods.AUTH_STATE]: AuthStateResult
  [PlatformMethods.CURRENT_USER_ID]: CurrentUserIdResult
  [PlatformMethods.PUBLISHED_ITEMS]: PublishedItemsResult
}

/** 调用请求信封。 */
export interface PlatformCallRequest<M extends PlatformMethod = PlatformMethod> {
  channel: typeof PLATFORM_CHANNEL
  kind: 'platform-call'
  method: M
  params: PlatformParamsMap[M]
  callId: string
}

/** 成功响应信封。 */
export interface PlatformCallSuccess<M extends PlatformMethod = PlatformMethod> {
  channel: typeof PLATFORM_CHANNEL
  kind: 'platform-result'
  method: M
  callId: string
  ok: true
  result: PlatformResultMap[M]
}

/** 失败响应信封（错误负载已脱敏，不含 token / cookie / 原始响应）。 */
export interface PlatformCallFailure {
  channel: typeof PLATFORM_CHANNEL
  kind: 'platform-result'
  method: string
  callId: string
  ok: false
  error: PlatformErrorPayload
}

/** 响应信封。 */
export type PlatformCallResponse<M extends PlatformMethod = PlatformMethod> =
  | PlatformCallSuccess<M>
  | PlatformCallFailure

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 校验平台调用请求。 */
export function isPlatformCallRequest(value: unknown): value is PlatformCallRequest {
  return (
    isRecord(value) &&
    value.channel === PLATFORM_CHANNEL &&
    value.kind === 'platform-call' &&
    isPlatformMethod(value.method) &&
    typeof value.callId === 'string' &&
    'params' in value
  )
}

/** 校验平台调用响应。 */
export function isPlatformCallResponse(value: unknown): value is PlatformCallResponse {
  return (
    isRecord(value) &&
    value.channel === PLATFORM_CHANNEL &&
    value.kind === 'platform-result' &&
    typeof value.method === 'string' &&
    typeof value.callId === 'string' &&
    typeof value.ok === 'boolean'
  )
}

/** 构造调用请求。 */
export function createPlatformCall<M extends PlatformMethod>(
  method: M,
  params: PlatformParamsMap[M],
  callId: string,
): PlatformCallRequest<M> {
  return { channel: PLATFORM_CHANNEL, kind: 'platform-call', method, params, callId }
}

/** 构造成功响应。 */
export function createPlatformSuccess<M extends PlatformMethod>(
  method: M,
  callId: string,
  result: PlatformResultMap[M],
): PlatformCallSuccess<M> {
  return { channel: PLATFORM_CHANNEL, kind: 'platform-result', method, callId, ok: true, result }
}

/** 构造失败响应。 */
export function createPlatformFailure(
  method: string,
  callId: string,
  error: PlatformErrorPayload,
): PlatformCallFailure {
  return { channel: PLATFORM_CHANNEL, kind: 'platform-result', method, callId, ok: false, error }
}
