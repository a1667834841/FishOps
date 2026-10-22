import { normalizeReadParams, readCacheKey, type ReadMethod, type SearchFilter } from '../../../packages/protocol/src/business.ts'
import type { StepParams } from '../../../packages/protocol/src/step.ts'
import type { HostDatabase } from './database.ts'
import type { RunInput } from './scheduler.ts'
import { isReadResult } from '../../../packages/protocol/src/items.ts'

/** 只读业务编排依赖；execute 必须等待真实单步终结，不能用 HTTP 超时替代。 */
export type ReadServiceDeps = {
  db: HostDatabase
  accountId(): string | null
  now(): number
  schedule<T>(input: RunInput, execute: () => Promise<T>, signal?: AbortSignal): Promise<T>
  execute(method: ReadMethod, params: StepParams, accountId: string, signal?: AbortSignal): Promise<unknown>
  validateResult?(method: ReadMethod, data: unknown): boolean
}
const messages: Record<string, string> = {
  LOGIN_REQUIRED: '账号未登录或登录已失效',
  ACCOUNT_CHANGED: '操作期间账号已变化',
  INTERNAL: '平台返回结果无效',
}
/** 暴露可执行的恢复提示，同时禁止调用方把这些只读错误当成可自动重试。 */
const fail = (code: string) =>
  Object.assign(new Error(messages[code] ?? '只读请求失败'), { code, phase: 'read', retryable: false })

/** 在访问数据库或调度器前拒绝非法业务参数；路由据此避免把无效请求写进历史。 */
export function normalizeReadInput(method: ReadMethod, raw: unknown) {
  normalizeReadParams(method, raw)
  return raw as Record<string, unknown>
}

/** 只把调用者显式给出的业务字段交给页面；默认分页与空筛选不应伪装成用户输入。 */
function stepParams(method: ReadMethod, raw: unknown): StepParams {
  const value = raw as Record<string, unknown>
  if (method === 'item.detail') return { itemId: String(value.itemId).trim() }
  if (method === 'search.suggest') return { keyword: String(value.keyword).trim() }
  return {
    keyword: String(value.keyword).trim(),
    ...(value.page !== undefined ? { page: value.page as number } : {}),
    ...(value.rowsPerPage !== undefined ? { rowsPerPage: value.rowsPerPage as number } : {}),
    ...(value.filter !== undefined ? { filter: value.filter as SearchFilter } : {}),
  }
}

/** 规范参数、账号缓存与调度的单一入口；实际单步执行由生产依赖注入。 */
export function createReadService(deps: ReadServiceDeps) {
  const validateResult = deps.validateResult ?? isReadResult
  const call = async (method: ReadMethod, raw: unknown, signal?: AbortSignal): Promise<{ data: unknown; cached: boolean }> => {
    /** 排队阶段允许取消；进入 execute 后只记录 signal，不把平台请求伪装成已取消。 */
    const assertQueued=()=>{if(signal?.aborted)throw Object.assign(new Error('调用方已断开'),{code:'CANCELLED',phase:'queue',retryable:false})}
    assertQueued()
    const params = normalizeReadParams(method, raw)
    assertQueued()
    const accountId = deps.accountId()
    if (!accountId) throw fail('LOGIN_REQUIRED')
    const key = method === 'search.suggest' ? null : readCacheKey(accountId, method, raw)
    if (key && 'maxAgeSec' in params) {
      const cached = deps.db.getReadCache(accountId, key, method as 'search.items' | 'item.detail', params.maxAgeSec, deps.now())
      if (cached !== null) {
        assertQueued()
        if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED')
        if (!validateResult(method, cached)) throw fail('INTERNAL')
        return { data: cached, cached: true }
      }
    }
    const business = stepParams(method, raw)
    assertQueued()
    const data = await deps.schedule({ accountId, category: method === 'search.items' ? 'search' : method === 'item.detail' ? 'detail' : 'light',
      maxWaitMs: params.maxWaitMs, minIntervalMs: params.minIntervalMs }, async () => {
      assertQueued()
      if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED')
      const result = await deps.execute(method, business, accountId, signal)
      if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED')
      if (!validateResult(method, result)) throw fail('INTERNAL')
      return result
    }, signal)
    if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED')
    if (key) deps.db.putReadCache(accountId, key, method as 'search.items' | 'item.detail', data, deps.now())
    return { data, cached: false }
  }
  return {
    async call(method: ReadMethod, raw: unknown, signal?: AbortSignal): Promise<{ data: unknown; cached: boolean }> {
      return call(method, raw, signal)
    },
  }
}
