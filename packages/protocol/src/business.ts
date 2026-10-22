import { keys, object } from './index.ts'

/** M2 单页只读方法；尚未注册到公共路由。 */
export type ReadMethod = 'search.items' | 'search.suggest' | 'item.detail'
/** 搜索过滤条件；不存在的字段不发送，避免暗中附加旧版十四天筛选。 */
export type SearchFilter = { publishDays?: number }
/** 调度元信息不进入业务缓存键。 */
export type ReadOptions = { maxWaitMs: number; minIntervalMs?: number; tag?: string }
export type SearchItemsParams = ReadOptions & { keyword: string; page: number; rowsPerPage: number; filter: SearchFilter; maxAgeSec: number }
export type SuggestParams = ReadOptions & { keyword: string }
export type ItemDetailParams = ReadOptions & { itemId: string; maxAgeSec: number }

function bad(): never { throw Object.assign(new Error('业务参数无效'), { code: 'BAD_REQUEST' }) }
function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) bad()
  return value as number
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) bad()
  return value.trim()
}
function age(value: unknown, ttl: number): number {
  return value === undefined ? ttl : Math.min(integer(value, 0, Number.MAX_SAFE_INTEGER), ttl)
}
function filter(value: unknown): SearchFilter {
  if (value === undefined) return {}
  if (!object(value) || !keys(value, ['publishDays'])) bad()
  const result: SearchFilter = {}
  if (value.publishDays !== undefined) result.publishDays = integer(value.publishDays, 1, 365)
  return result
}

/** 校验并规范化业务输入；拒绝未知字段，不修改调用者对象。 */
export function normalizeReadParams(method: 'search.items', value: unknown): SearchItemsParams
export function normalizeReadParams(method: 'search.suggest', value: unknown): SuggestParams
export function normalizeReadParams(method: 'item.detail', value: unknown): ItemDetailParams
export function normalizeReadParams(method: string, value: unknown): SearchItemsParams | SuggestParams | ItemDetailParams
export function normalizeReadParams(method: string, value: unknown): SearchItemsParams | SuggestParams | ItemDetailParams {
  const common = ['maxWaitMs', 'minIntervalMs', 'tag']
  const allowed = method === 'search.items' ? [...common, 'keyword', 'page', 'rowsPerPage', 'filter', 'maxAgeSec']
    : method === 'search.suggest' ? [...common, 'keyword']
      : method === 'item.detail' ? [...common, 'itemId', 'maxAgeSec'] : null
  if (!allowed) throw Object.assign(new Error('未知业务方法'), { code: 'NOT_FOUND' })
  if (!object(value) || !keys(value, allowed)) bad()
  const options: ReadOptions = { maxWaitMs: value.maxWaitMs === undefined ? 120000 : integer(value.maxWaitMs, 1, 600000) }
  if (value.minIntervalMs !== undefined) options.minIntervalMs = integer(value.minIntervalMs, 0, 600000)
  if (value.tag !== undefined) {
    if (typeof value.tag !== 'string' || !value.tag.length || value.tag.length > 128) bad()
    options.tag = value.tag
  }
  if (method === 'item.detail') return { ...options, itemId: text(value.itemId, 128), maxAgeSec: age(value.maxAgeSec, 1800) }
  const keyword = text(value.keyword, 200)
  if (method === 'search.suggest') return { ...options, keyword }
  return {
    ...options, keyword,
    page: value.page === undefined ? 1 : integer(value.page, 1, 10000),
    rowsPerPage: value.rowsPerPage === undefined ? 30 : integer(value.rowsPerPage, 1, 30),
    filter: filter(value.filter), maxAgeSec: age(value.maxAgeSec, 900),
  }
}

/** 生成账号范围的规范缓存键；键只用于数据库，不应写入日志。 */
export function readCacheKey(accountId: string, method: 'search.items' | 'item.detail' | 'search.suggest', value: unknown): string {
  if (typeof accountId !== 'string' || !accountId.trim()) bad()
  if (method === 'search.suggest') bad()
  if (method === 'item.detail') {
    const params = normalizeReadParams(method, value)
    return JSON.stringify([accountId, method, params.itemId])
  }
  const params = normalizeReadParams(method, value)
  // 固定字段顺序，避免对象插入顺序与调度元信息造成同一查询多个缓存键。
  const f = params.filter
  return JSON.stringify([accountId, method, params.keyword, params.page, params.rowsPerPage, f.publishDays ?? null])
}
