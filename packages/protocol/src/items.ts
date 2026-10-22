import { keys, object } from './index.ts'
import type { ReadMethod } from './business.ts'

/**
 * M2 只读方法的公共输出 schema。
 *
 * 归一化结果在写入公共响应或缓存前必须经过本模块的严格运行时校验：
 * 只接受已知字段、固定类型和明确边界。任何 token、cookie、原始 MTOP
 * 字段，以及非有限数值、超长文本、数字 ID 都会被拒绝。
 * 字段形状与 apps/extension/src/modules/items.ts 的归一化输出保持一致。
 */

/** 商品在售状态；无法从平台明确字段确认时为 unknown。 */
export type ItemStatus = 'on_sale' | 'sold' | 'unknown'

/** search.items 使用的商品摘要；未知字段为 null，不用 0 或空串伪装事实。 */
export interface ItemSummary {
  itemId: string
  title: string | null
  price: string | null
  image: string | null
  sellerId: string | null
  sellerNick: string | null
  city: string | null
  wantCnt: number | null
  publishedAt: number | null
  url: string | null
}

/** item.detail 返回的完整商品信息。 */
export interface ItemDetail extends ItemSummary {
  description: string | null
  images: string[] | null
  status: ItemStatus
  browseCnt: number | null
  collectCnt: number | null
}

/** search.items 的归一化结果；hasMore 未知时为 null。 */
export interface ItemSearchResult {
  items: ItemSummary[]
  hasMore: boolean | null
}

/** search.suggest 的结果：已按大小写不敏感去重的建议词。 */
export type ItemSuggestResult = string[]

const ITEM_ID_MAX = 128
const TITLE_MAX = 2000
const TEXT_MAX = 2000
const PRICE_MAX = 100
const DESCRIPTION_MAX = 100000
const IMAGES_MAX = 100
const SEARCH_ITEMS_MAX = 30
const SUGGEST_MAX_WORDS = 20
const SUGGEST_WORD_MAX = 80
const URL_MAX = 2048

const SUMMARY_KEYS = [
  'itemId', 'title', 'price', 'image', 'sellerId', 'sellerNick', 'city', 'wantCnt', 'publishedAt', 'url',
] as const
const DETAIL_KEYS = [...SUMMARY_KEYS, 'description', 'images', 'status', 'browseCnt', 'collectCnt'] as const
const SEARCH_KEYS = ['items', 'hasMore'] as const
const ITEM_STATUSES: readonly string[] = ['on_sale', 'sold', 'unknown']
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * 纯数据对象判定：拒绝数组、null 以及原型链被改写的伪装对象。
 * JSON 解析结果的原型是 Object.prototype，Object.create(null) 视为纯数据。
 */
function plain(value: unknown): value is Record<string, unknown> {
  if (!object(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** 字段集合必须恰好等于允许字段：缺字段和多余字段都拒绝。 */
function exact(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).length === allowed.length && keys(value, allowed)
}

/** 非空文本并限制长度；全空白按缺失处理，调用方应给出 null。 */
function boundedText(value: unknown, max: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim().length > 0
}

function nullableText(value: unknown, max: number): boolean {
  return value === null || boundedText(value, max)
}

/** 只接受带主机名的 http/https 绝对 URL。 */
function safeUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > URL_MAX) return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return ALLOWED_URL_PROTOCOLS.has(parsed.protocol) && parsed.hostname.length > 0
}

function nullableUrl(value: unknown): boolean {
  return value === null || safeUrl(value)
}

/** 计数与发布时间都必须是安全非负整数；拒绝 NaN、Infinity、小数和负数。 */
function nonNegativeInt(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
}

function hasSummaryFields(value: Record<string, unknown>): boolean {
  return (
    boundedText(value.itemId, ITEM_ID_MAX) &&
    nullableText(value.title, TITLE_MAX) &&
    nullableText(value.price, PRICE_MAX) &&
    nullableUrl(value.image) &&
    nullableText(value.sellerId, TEXT_MAX) &&
    nullableText(value.sellerNick, TEXT_MAX) &&
    nullableText(value.city, TEXT_MAX) &&
    nonNegativeInt(value.wantCnt) &&
    nonNegativeInt(value.publishedAt) &&
    nullableUrl(value.url)
  )
}

/** images 为 null 或最多 100 个互不重复的安全 URL。 */
function safeImages(value: unknown): boolean {
  if (value === null) return true
  if (!Array.isArray(value) || value.length > IMAGES_MAX) return false
  const seen = new Set<string>()
  for (const entry of value) {
    if (!safeUrl(entry)) return false
    const url = entry as string
    if (seen.has(url)) return false
    seen.add(url)
  }
  return true
}

/** 校验单条商品摘要，供搜索与详情复用。 */
function isItemSummary(value: unknown): value is ItemSummary {
  return plain(value) && exact(value, SUMMARY_KEYS) && hasSummaryFields(value)
}

function isItemDetail(value: unknown): value is ItemDetail {
  if (!plain(value) || !exact(value, DETAIL_KEYS) || !hasSummaryFields(value)) return false
  return (
    nullableText(value.description, DESCRIPTION_MAX) &&
    safeImages(value.images) &&
    typeof value.status === 'string' &&
    ITEM_STATUSES.includes(value.status) &&
    nonNegativeInt(value.browseCnt) &&
    nonNegativeInt(value.collectCnt)
  )
}

function isItemSearchResult(value: unknown): value is ItemSearchResult {
  if (!plain(value) || !exact(value, SEARCH_KEYS)) return false
  const items = value.items
  if (!Array.isArray(items) || items.length > SEARCH_ITEMS_MAX || !items.every(isItemSummary)) return false
  return value.hasMore === null || typeof value.hasMore === 'boolean'
}

function isItemSuggestResult(value: unknown): value is ItemSuggestResult {
  if (!Array.isArray(value) || value.length > SUGGEST_MAX_WORDS) return false
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > SUGGEST_WORD_MAX) return false
    const key = entry.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
  }
  return true
}

/**
 * 严格校验只读方法的成功输出，未知方法一律返回 false。
 * 调用方据此决定是否落缓存或写入公共响应，避免未校验数据外泄。
 */
export function isReadResult(method: 'search.items', data: unknown): data is ItemSearchResult
export function isReadResult(method: 'item.detail', data: unknown): data is ItemDetail
export function isReadResult(method: 'search.suggest', data: unknown): data is ItemSuggestResult
export function isReadResult(method: ReadMethod, data: unknown): boolean
export function isReadResult(method: string, data: unknown): boolean
export function isReadResult(method: string, data: unknown): boolean {
  if (method === 'search.items') return isItemSearchResult(data)
  if (method === 'item.detail') return isItemDetail(data)
  if (method === 'search.suggest') return isItemSuggestResult(data)
  return false
}
