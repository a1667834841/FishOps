/**
 * MAIN world runtime host（核心逻辑，无 DOM 依赖）。
 *
 * 该模块只负责“把平台调用方法分派到 client / auth”，不接触 `window`、`document` 或 `chrome`，
 * 因此可以在 Node 中直接单测。真正的页面挂载（postMessage 监听、`window.__FISHOPS_PLATFORM_HOST__`）
 * 由 {@link ./host-entry} 完成。
 */
import { PlatformError, defaultMessageFor, toPlatformError } from './errors'
import {
  PLATFORM_CHANNEL,
  PlatformMethods,
  type PlatformCallRequest,
  type PlatformCallResponse,
  type PlatformMethod,
  type PlatformParamsMap,
  type PlatformResultMap,
  type PublishedItemsParams,
  type SearchParams,
  type SuggestParams,
} from './protocol'
import { buildSearchData, type MtopClient } from './xianyu/mtop-client'
import { readAllOnSaleCards } from './xianyu/my-items'
import type { AuthService } from './xianyu/auth'

export interface RuntimeHostDeps {
  client: MtopClient
  auth: AuthService
  /** 时间来源，默认 Date.now。 */
  now?: () => number
}

export interface RuntimeHost {
  /** 分派单个方法；失败时抛 {@link PlatformError}。 */
  handle(method: string, params: unknown): Promise<unknown>
  /** 处理一个完整调用信封，始终返回结构化响应（不抛错）。 */
  handleCall(request: PlatformCallRequest): Promise<PlatformCallResponse>
  /** 同 handleCall，接受未知输入并做校验。 */
  handleUnknown(value: unknown): Promise<PlatformCallResponse | null>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asSearchParams(params: unknown): SearchParams {
  if (!isRecord(params) || typeof params.keyword !== 'string') {
    throw new PlatformError('unknown', 'SEARCH 参数非法：缺少 keyword')
  }
  return {
    keyword: params.keyword,
    ...(typeof params.pageNumber === 'number' ? { pageNumber: params.pageNumber } : {}),
    ...(typeof params.rowsPerPage === 'number' ? { rowsPerPage: params.rowsPerPage } : {}),
    ...(typeof params.searchFilter === 'string' ? { searchFilter: params.searchFilter } : {}),
    ...(typeof params.searchReqFromPage === 'string'
      ? { searchReqFromPage: params.searchReqFromPage }
      : {}),
    ...(typeof params.minIntervalMs === 'number' ? { minIntervalMs: params.minIntervalMs } : {}),
    ...(typeof params.intervalJitterMs === 'number'
      ? { intervalJitterMs: params.intervalJitterMs }
      : {}),
  }
}

function asDetailItemId(params: unknown): string {
  if (!isRecord(params) || typeof params.itemId !== 'string' || params.itemId.length === 0) {
    throw new PlatformError('unknown', 'DETAIL 参数非法：缺少 itemId')
  }
  return params.itemId
}

function asSuggestParams(params: unknown): SuggestParams {
  if (!isRecord(params) || typeof params.inputWords !== 'string') {
    throw new PlatformError('unknown', 'SUGGEST 参数非法：缺少 inputWords')
  }
  return {
    inputWords: params.inputWords,
    ...(typeof params.searchReqFromPage === 'string'
      ? { searchReqFromPage: params.searchReqFromPage }
      : {}),
    ...(typeof params.bucketId === 'number' ? { bucketId: params.bucketId } : {}),
    ...(typeof params.type === 'number' ? { type: params.type } : {}),
  }
}

function asPublishedItemsParams(params: unknown): PublishedItemsParams {
  const record = isRecord(params) ? params : {}
  return {
    ...(typeof record['pageSize'] === 'number' ? { pageSize: record['pageSize'] } : {}),
    ...(typeof record['maxPages'] === 'number' ? { maxPages: record['maxPages'] } : {}),
  }
}

/** 创建 runtime host。 */
export function createRuntimeHost(deps: RuntimeHostDeps): RuntimeHost {
  const now = deps.now ?? (() => Date.now())

  async function handle(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case PlatformMethods.PING:
        return { pong: true, host: 'main-world', now: now() } satisfies PlatformResultMap[typeof PlatformMethods.PING]
      case PlatformMethods.SEARCH: {
        const p = asSearchParams(params)
        // 采集搜索携带专用间隔时，用「基础间隔 + 随机增量」覆盖全局固定 1500ms；
        // 非采集 / 未携带时保持全局限速不变。
        const options =
          typeof p.minIntervalMs === 'number'
            ? { rateLimit: { minIntervalMs: p.minIntervalMs, jitterMs: p.intervalJitterMs ?? 0 } }
            : undefined
        return deps.client.requestRaw('search', buildSearchData(p), options)
      }
      case PlatformMethods.DETAIL:
        return deps.client.requestRaw('detail', { itemId: asDetailItemId(params) })
      case PlatformMethods.SUGGEST: {
        const p = asSuggestParams(params)
        return deps.client.suggest(p.inputWords, {
          searchReqFromPage: p.searchReqFromPage,
          bucketId: p.bucketId,
          type: p.type,
        })
      }
      case PlatformMethods.AUTH_STATE:
        return deps.auth.getAuthState()
      case PlatformMethods.CURRENT_USER_ID:
        return { userId: await deps.auth.getCurrentUserId() } satisfies PlatformResultMap[typeof PlatformMethods.CURRENT_USER_ID]
      case PlatformMethods.PUBLISHED_ITEMS: {
        const p = asPublishedItemsParams(params)
        // 账号必须是当前登录账号；缺失（未登录）直接抛 unauthorized，绝不返回空集合。
        const accountId = await deps.auth.getCurrentUserId()
        if (!accountId) {
          throw new PlatformError('unauthorized', defaultMessageFor('unauthorized'))
        }
        const items = await readAllOnSaleCards(deps.client, accountId, {
          ...(p.pageSize === undefined ? {} : { pageSize: p.pageSize }),
          ...(p.maxPages === undefined ? {} : { maxPages: p.maxPages }),
        })
        return { accountId, items } satisfies PlatformResultMap[typeof PlatformMethods.PUBLISHED_ITEMS]
      }
      default:
        throw new PlatformError('unknown', `未知平台方法: ${method}`)
    }
  }

  async function handleCall(request: PlatformCallRequest): Promise<PlatformCallResponse> {
    try {
      const result = await handle(request.method, request.params)
      return {
        channel: PLATFORM_CHANNEL,
        kind: 'platform-result',
        method: request.method,
        callId: request.callId,
        ok: true,
        result,
      } as PlatformCallResponse
    } catch (error) {
      return {
        channel: PLATFORM_CHANNEL,
        kind: 'platform-result',
        method: request.method,
        callId: request.callId,
        ok: false,
        error: toPlatformError(error).toPayload(),
      }
    }
  }

  return {
    handle,
    handleCall,
    async handleUnknown(value: unknown): Promise<PlatformCallResponse | null> {
      if (!isRecord(value) || value.kind !== 'platform-call') return null
      const method = value.method
      const callId = value.callId
      if (typeof method !== 'string' || typeof callId !== 'string') return null
      return handleCall({
        channel: PLATFORM_CHANNEL,
        kind: 'platform-call',
        method: method as PlatformMethod,
        params: value.params as PlatformParamsMap[PlatformMethod],
        callId,
      })
    },
  }
}
