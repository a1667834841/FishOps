/**
 * 闲鱼 MTOP 客户端。
 *
 * 迁移自旧 `FishOps`（main 分支）`xianyu-api.js` 的 `API_CONFIG` / `request` /
 * `fetchSearchData` / `fetchItemDetail` / `fetchSuggestWords`。
 *
 * 设计：
 * - transport 可注入（{@link MtopTransport}），默认实现基于 `fetch`，在 Node 测试中替换为 mock；
 * - 请求参数、URL 参数顺序、请求头、`credentials: 'include'` 与旧实现一致；
 * - 响应错误统一走 {@link classifyMtopPayload}，不把完整原始响应写入日志；
 * - 相对旧实现的一处**有意增强**：token 为空时直接抛 `unauthorized`（旧代码在调用方 autoCrawl 里检查），
 *   避免发送注定失败的请求。可通过 `requireToken: false` 关闭。
 */
import { PlatformError, classifyMtopPayload, defaultMessageFor } from '../errors'
import { createRateLimiter } from '../rate-limit'
import type { RateLimiter } from '../rate-limit'
import type { SearchParams } from '../protocol'
import { generateSignature, extractDocumentToken, type SignResult } from './sign'

/** 单个 MTOP API 的配置。 */
export interface MtopApiConfig {
  baseUrl: string
  api: string
  appKey: string
  /**
   * 额外 URL 参数（按 API 固定），如 spm 埋点。
   * 签名只针对 body 的 `data`，因此追加 URL 参数不影响签名值。
   */
  extraUrlParams?: Record<string, string>
}

/** API 配置，与旧 `API_CONFIG` 逐字段一致。 */
export const MTOP_API_CONFIG = {
  search: {
    baseUrl: 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search/1.0/',
    api: 'mtop.taobao.idlemtopsearch.pc.search',
    appKey: '34839810',
  },
  detail: {
    baseUrl: 'https://h5api.m.goofish.com/h5/mtop.taobao.idle.pc.detail/1.0/',
    api: 'mtop.taobao.idle.pc.detail',
    appKey: '34839810',
  },
  suggest: {
    baseUrl: 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search.suggest/1.0/',
    api: 'mtop.taobao.idlemtopsearch.pc.search.suggest',
    appKey: '34839810',
  },
  /** 当前账号官方「我的商品库」在售列表（实测接口，URL 参数与旧 goods-list-service 一致）。 */
  myOnSaleItems: {
    baseUrl: 'https://h5api.m.goofish.com/h5/mtop.idle.web.xyh.item.list/1.0/',
    api: 'mtop.idle.web.xyh.item.list',
    appKey: '34839810',
    extraUrlParams: { spm_cnt: 'a21ybx.personal.0.0', spm_pre: 'a21ybx.home.nav.1' },
  },
} as const satisfies Record<string, MtopApiConfig>

export type MtopApiType = keyof typeof MTOP_API_CONFIG

/** MTOP 原始 JSON 响应。 */
export type MtopRawResponse = Record<string, unknown>

/** 一次 HTTP 请求的描述。 */
export interface MtopTransportRequest {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: string
  /** 与旧实现一致：携带页面 cookie。 */
  credentials: 'include'
}

/** transport 抽象：只要能把请求变成已解析的 JSON 即可，便于测试与替换。 */
export interface MtopTransport {
  send(request: MtopTransportRequest): Promise<unknown>
}

/** 基于 `fetch` 的默认 transport（在 MAIN world 使用页面凭据）。 */
export function createFetchTransport(fetchImpl: typeof fetch = globalThis.fetch): MtopTransport {
  return {
    async send(request: MtopTransportRequest): Promise<unknown> {
      const response = await fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        credentials: request.credentials,
      })
      return response.json()
    },
  }
}

/** 请求构造结果，暴露 URL 参数与签名串，便于测试与排查（签名串含 token，禁止记录）。 */
export interface MtopRequestPlan {
  apiType: MtopApiType
  config: MtopApiConfig
  urlParams: Record<string, string>
  url: string
  headers: Record<string, string>
  body: string
  sign: SignResult
}

export interface MtopCallOptions {
  /** 自定义 token；缺省时由 deps.getToken 提供。 */
  token?: string
  /** 自定义时间戳（毫秒字符串）。 */
  timestamp?: string
  /** 自定义 appKey。 */
  appKey?: string
  /**
   * 本次请求专用限速（覆盖全局 `deps.rateLimiter`）。仅采集搜索会携带，
   * 用于按任务配置的「基础间隔 + 随机增量」节流，而不被全局固定 1500ms 拖慢。
   */
  rateLimit?: { minIntervalMs: number; jitterMs: number }
}

/**
 * 构造 MTOP POST 请求（搜索 / 详情 / 建议共用）。
 *
 * URL 参数顺序与旧 `request()` 完全一致，以保证签名与请求可复现。
 */
export function buildMtopRequest(
  apiType: MtopApiType,
  data: unknown,
  options: MtopCallOptions = {},
): MtopRequestPlan {
  const config = MTOP_API_CONFIG[apiType]
  const sign = generateSignature(data, {
    token: options.token ?? '',
    timestamp: options.timestamp,
    appKey: options.appKey ?? config.appKey,
  })

  // 顺序与旧实现一致：jsv → appKey → t → sign → v → type → accountSite → dataType → timeout → api → sessionOption
  const urlParams: Record<string, string> = {
    jsv: '2.7.2',
    appKey: sign.appKey,
    t: sign.t,
    sign: sign.sign,
    v: '1.0',
    type: 'originaljson',
    accountSite: 'xianyu',
    dataType: 'json',
    timeout: '20000',
    api: config.api,
    sessionOption: 'AutoLoginOnly',
    ...('extraUrlParams' in config ? config.extraUrlParams : {}),
  }

  return {
    apiType,
    config,
    urlParams,
    url: config.baseUrl + '?' + new URLSearchParams(urlParams).toString(),
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://www.goofish.com',
      referer: 'https://www.goofish.com/',
    },
    body: 'data=' + encodeURIComponent(sign.data),
    sign,
  }
}

/** 搜索请求体，字段与旧 `fetchSearchData` 一致。 */
export function buildSearchData(params: SearchParams): Record<string, unknown> {
  return {
    pageNumber: params.pageNumber ?? 1,
    keyword: params.keyword,
    fromFilter: false,
    rowsPerPage: params.rowsPerPage ?? 30,
    sortValue: '',
    sortField: '',
    customDistance: '',
    gps: '',
    propValueStr: { searchFilter: params.searchFilter ?? 'publishDays:14;' },
    customGps: '',
    searchReqFromPage: params.searchReqFromPage ?? 'pcSearch',
    extraFilterValue: '{}',
    userPositionJson: '{}',
  }
}

/** 从 suggest 原始响应中提取词列表，兼容旧 `fetchSuggestWords` 的字段路径。 */
export function extractSuggestWords(payload: MtopRawResponse): string[] {
  const data = payload.data
  if (typeof data !== 'object' || data === null) return []
  const items = (data as { items?: unknown }).items
  if (!Array.isArray(items)) return []
  return items
    .map((item) => (typeof item === 'object' && item !== null ? (item as { suggest?: unknown }).suggest : undefined))
    .filter((text): text is string => typeof text === 'string' && text.length > 0)
}

/** 校验响应并返回原始 JSON；失败时抛 {@link PlatformError}。 */
export function assertMtopSuccess(payload: unknown): MtopRawResponse {
  const failure = classifyMtopPayload(payload)
  if (failure) {
    throw new PlatformError(failure.category, failure.message, { retCode: failure.retCode })
  }
  return payload as MtopRawResponse
}

export interface MtopClientDeps {
  transport: MtopTransport
  /** token 提供者，默认读取当前页面 cookie（MAIN world）。 */
  getToken?: () => string | null
  /** 请求限速（全局默认，非搜索请求使用）。 */
  rateLimiter?: RateLimiter
  /** 是否要求 token 非空（默认 true）。 */
  requireToken?: boolean
  /** 专用限速器的时间源，默认 Date.now。 */
  now?: () => number
  /** 专用限速器的休眠实现，默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>
  /** 专用限速器的随机源，默认 Math.random。 */
  random?: () => number
}

export interface MtopClient {
  /** 发请求并返回完整 MTOP 原始 JSON（含 ret / data）。 */
  requestRaw(
    apiType: MtopApiType,
    data: unknown,
    options?: MtopCallOptions,
  ): Promise<MtopRawResponse>
  /** 搜索，返回响应中的 `data`。 */
  search(params: SearchParams, options?: MtopCallOptions): Promise<MtopRawResponse>
  /** 商品详情，返回响应中的 `data`。 */
  fetchItemDetail(itemId: string, options?: MtopCallOptions): Promise<MtopRawResponse>
  /** 搜索建议（流量词），返回词列表。 */
  suggest(
    inputWords: string,
    options?: { searchReqFromPage?: string; bucketId?: number; type?: number } & MtopCallOptions,
  ): Promise<string[]>
}

/** 创建 MTOP 客户端。 */
export function createMtopClient(deps: MtopClientDeps): MtopClient {
  const getToken = deps.getToken ?? extractDocumentToken
  const requireToken = deps.requireToken ?? true

  // 搜索专用限速器：按「基础间隔:随机增量」缓存，保证同一配置跨请求持续生效。
  const searchLimiters = new Map<string, RateLimiter>()
  const searchLimiterFor = (config: { minIntervalMs: number; jitterMs: number }): RateLimiter => {
    const key = `${config.minIntervalMs}:${config.jitterMs}`
    let limiter = searchLimiters.get(key)
    if (!limiter) {
      limiter = createRateLimiter({
        minIntervalMs: config.minIntervalMs,
        jitterMs: config.jitterMs,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
        ...(deps.random === undefined ? {} : { random: deps.random }),
      })
      searchLimiters.set(key, limiter)
    }
    return limiter
  }

  async function requestRaw(
    apiType: MtopApiType,
    data: unknown,
    options: MtopCallOptions = {},
  ): Promise<MtopRawResponse> {
    const token = options.token ?? getToken() ?? ''
    if (requireToken && !token) {
      throw new PlatformError('unauthorized', defaultMessageFor('unauthorized'))
    }

    const limiter = options.rateLimit ? searchLimiterFor(options.rateLimit) : deps.rateLimiter
    await limiter?.acquire()

    const plan = buildMtopRequest(apiType, data, { ...options, token })
    const payload = await deps.transport.send({
      url: plan.url,
      method: 'POST',
      headers: plan.headers,
      body: plan.body,
      credentials: 'include',
    })
    return assertMtopSuccess(payload)
  }

  return {
    requestRaw,
    async search(params: SearchParams, options: MtopCallOptions = {}): Promise<MtopRawResponse> {
      const rateLimit =
        typeof params.minIntervalMs === 'number'
          ? { minIntervalMs: params.minIntervalMs, jitterMs: params.intervalJitterMs ?? 0 }
          : undefined
      const payload = await requestRaw('search', buildSearchData(params), {
        ...options,
        ...(rateLimit === undefined ? {} : { rateLimit }),
      })
      const data = payload.data
      return typeof data === 'object' && data !== null ? (data as MtopRawResponse) : {}
    },
    async fetchItemDetail(itemId: string, options: MtopCallOptions = {}): Promise<MtopRawResponse> {
      const payload = await requestRaw('detail', { itemId }, options)
      const data = payload.data
      return typeof data === 'object' && data !== null ? (data as MtopRawResponse) : {}
    },
    async suggest(inputWords, options = {}): Promise<string[]> {
      const data = {
        inputWords,
        searchReqFromPage: options.searchReqFromPage ?? 'xyPcHome',
        bucketId: options.bucketId ?? 30,
        type: options.type ?? 0,
      }
      const payload = await requestRaw('suggest', data, options)
      return extractSuggestWords(payload)
    },
  }
}
