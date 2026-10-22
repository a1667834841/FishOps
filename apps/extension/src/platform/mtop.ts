/**
 * 闲鱼 MTOP 只读请求构造与响应分类（纯计算，不发起网络）。
 *
 * 复用 legacy `mtop-client.ts` 的 `API_CONFIG` / `request()` / `buildSearchData()` 与
 * `errors.ts` 的 ret 分类规则。本模块只生成“请求描述”和“脱敏错误”：
 * - 给 host 授权的单步执行器使用；真正发送由 MAIN world 执行方完成，本模块不调用 `window` / 网络 API；
 * - 仅支持本阶段三种只读方法 `search.items`、`search.suggest`、`item.detail`；
 * - 返回值只含 `url` / `body` / `headers` / `credentials`，不含 token 独立字段或签名原始拼接。
 *
 * 与 legacy 的已知差异：legacy 的请求头对象包含 `origin` / `referer`，但浏览器把这两个名字列为
 * 禁止脚本设置的头（forbidden header names），真实请求中会被忽略并由页面自然填充。这里只保留
 * `accept` 与 `content-type`，避免硬塞实际不生效的头；真实请求发出的头以页面为准。
 */
import { object } from '../../../../packages/protocol/src/index.ts'
import {
  normalizeReadParams,
  type ItemDetailParams,
  type SearchFilter,
  type SearchItemsParams,
  type SuggestParams,
} from '../../../../packages/protocol/src/business.ts'
import { ApiError } from '../errors.ts'
import { MTOP_APP_KEY, generateSignature } from './sign.ts'

/** 本阶段允许的只读业务方法。 */
export type ReadMethod = 'search.items' | 'search.suggest' | 'item.detail'

/** 只读方法白名单；顺序即签名 URL 参数顺序之外的调用约定。 */
export const READ_METHODS: readonly ReadMethod[] = ['search.items', 'search.suggest', 'item.detail']

/** 单个只读方法的 MTOP 端点；与 legacy `MTOP_API_CONFIG` 逐字段一致。 */
interface ReadEndpoint {
  baseUrl: string
  api: string
}

const READ_ENDPOINTS: Record<ReadMethod, ReadEndpoint> = {
  'search.items': {
    baseUrl: 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search/1.0/',
    api: 'mtop.taobao.idlemtopsearch.pc.search',
  },
  'item.detail': {
    baseUrl: 'https://h5api.m.goofish.com/h5/mtop.taobao.idle.pc.detail/1.0/',
    api: 'mtop.taobao.idle.pc.detail',
  },
  'search.suggest': {
    baseUrl: 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search.suggest/1.0/',
    api: 'mtop.taobao.idlemtopsearch.pc.search.suggest',
  },
}

/** 每个方法允许的业务参数键；其它键（如 tag / maxAgeSec 等调度、缓存元信息）一律拒绝。 */
const BUSINESS_KEYS: Record<ReadMethod, readonly string[]> = {
  'search.items': ['keyword', 'page', 'rowsPerPage', 'filter'],
  'search.suggest': ['keyword'],
  'item.detail': ['itemId'],
}

/**
 * 构造好的只读请求描述。
 * 只暴露执行所需的最小字段；token、签名原始拼接（`token&t&appKey&data`）不在此对象中。
 * 调用方固定以 `POST` 发送，`body` 为 `application/x-www-form-urlencoded`。
 */
export interface ReadRequest {
  url: string
  body: string
  headers: Record<string, string>
  credentials: 'include'
}

function bad(message: string): never {
  throw new ApiError('BAD_REQUEST', message)
}

/**
 * 把业务 filter 映射为 legacy `propValueStr.searchFilter` 串。
 *
 * 目前只有 `publishDays` 具备 legacy 生产代码依据：旧平台层 `xianyu/mtop-client.ts` 中
 * `searchFilter ?? 'publishDays:14;'` 是真实默认值，可证明 `publishDays:<n>;` 的服务端映射形式。
 *
 * 价格与包邮筛选在 legacy 里只有客户端本地过滤，没有生产代码证明服务端映射。
 * 公共协议已暂时移除这些字段，避免“校验成功、执行必然失败”的假能力。
 */
function searchFilterOf(filter: SearchFilter): string {
  if (Object.keys(filter).some(key => key !== 'publishDays')) {
    bad('该筛选条件缺少 legacy 服务端映射，当前未支持，无法构造搜索请求')
  }
  return filter.publishDays === undefined ? '' : `publishDays:${filter.publishDays};`
}

/** 构造 legacy `fetchSearchData()` 的请求体字段；字段顺序影响签名，需与 legacy 一致。 */
function buildSearchData(params: {
  keyword: string
  page: number
  rowsPerPage: number
  filter: SearchFilter
}): Record<string, unknown> {
  return {
    pageNumber: params.page,
    keyword: params.keyword,
    fromFilter: false,
    rowsPerPage: params.rowsPerPage,
    sortValue: '',
    sortField: '',
    customDistance: '',
    gps: '',
    propValueStr: { searchFilter: searchFilterOf(params.filter) },
    customGps: '',
    searchReqFromPage: 'pcSearch',
    extraFilterValue: '{}',
    userPositionJson: '{}',
  }
}

/** 按方法生成 MTOP 的 `data` 载荷；各方法与 legacy 对应方法字段一致。 */
function buildData(method: ReadMethod, raw: unknown): Record<string, unknown> {
  if (!object(raw) || !Object.keys(raw).every((key) => BUSINESS_KEYS[method].includes(key))) {
    bad('业务参数包含未知字段')
  }
  let normalized: SearchItemsParams | SuggestParams | ItemDetailParams
  try {
    // 逐方法与 overload 对齐，避免把调度/缓存元信息当成业务参数。
    normalized =
      method === 'item.detail'
        ? normalizeReadParams('item.detail', raw)
        : method === 'search.suggest'
          ? normalizeReadParams('search.suggest', raw)
          : normalizeReadParams('search.items', raw)
  } catch {
    // 统一为 BAD_REQUEST：normalizeReadParams 的原始异常不外传，避免泄露内部细节。
    bad('业务参数无效')
  }
  if (method === 'item.detail') {
    return { itemId: (normalized as ItemDetailParams).itemId }
  }
  if (method === 'search.suggest') {
    return {
      inputWords: (normalized as SuggestParams).keyword,
      searchReqFromPage: 'xyPcHome',
      bucketId: 30,
      type: 0,
    }
  }
  const params = normalized as SearchItemsParams
  return buildSearchData(params)
}

function isReadMethod(value: string): value is ReadMethod {
  return (READ_METHODS as readonly string[]).includes(value)
}

/**
 * 构造一次只读 MTOP 请求描述（同步、纯计算，不发起网络）。
 *
 * @param method 三种只读方法之一；其它值抛 `BAD_REQUEST`。
 * @param params 业务参数；严格 schema，仅允许该方法的业务字段，未知或非法字段抛 `BAD_REQUEST`。
 * @param token 用于签名的 token（已去掉 `_timestamp` 后缀）；必须为非空字符串。
 * @param timestamp 毫秒时间戳字符串（数字）；签名与 URL 的 `t` 参数使用同一值。
 * @returns 只含 `url` / `body` / `headers` / `credentials` 的请求描述。
 */
export function buildReadRequest(
  method: string,
  params: unknown,
  token: string,
  timestamp: string,
): ReadRequest {
  if (typeof method !== 'string' || !isReadMethod(method)) bad('不支持的只读方法')
  if (typeof token !== 'string' || token.length === 0) bad('缺少 MTOP token')
  if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)) bad('时间戳必须是毫秒数字字符串')

  const endpoint = READ_ENDPOINTS[method]
  const data = buildData(method, params)
  const sign = generateSignature(data, { token, timestamp, appKey: MTOP_APP_KEY })

  // URL 参数顺序与 legacy `request()` 一致，保证签名与请求可复现。
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
    api: endpoint.api,
    sessionOption: 'AutoLoginOnly',
  }

  return {
    url: endpoint.baseUrl + '?' + new URLSearchParams(urlParams).toString(),
    body: 'data=' + encodeURIComponent(sign.data),
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    credentials: 'include',
  }
}

/** 风控 / 验证码特征：命中即判定为 RISK_BLOCKED。 */
const RISK_PATTERN =
  /FAIL_SYS_USER_VALIDATE|RGV587|_tmd_|punish|x5sec|captcha|安全验证|滑块|验证码|被挤爆/i

/** 登录态特征：token 过期 / 为空 / 未登录 / 会话失效，命中即判定为 LOGIN_REQUIRED。 */
const LOGIN_PATTERN =
  /FAIL_SYS_TOKEN_EXPIRED|FAIL_SYS_TOKEN_EXOIRED|FAIL_SYS_TOKEN_EMPTY|FAIL_SYS_TOKEN_INVALID|TOKEN_EXPIRED|TOKEN_EXOIRED|TOKEN_EMPTY|FAIL_SYS_SESSION_EXPIRED|FAIL_SYS_NOT_LOGIN|FAIL_SYS_LOGIN|NOT_LOGIN|未登录|请先登录|登录失效|登录已过期/i

/** 三类只读错误的固定文案；不携带平台 ret 原文，避免外泄响应内容。 */
const READ_MESSAGES: Record<'LOGIN_REQUIRED' | 'RISK_BLOCKED' | 'PLATFORM_REJECTED', string> = {
  LOGIN_REQUIRED: '需要登录闲鱼账号或登录状态已失效，请先登录后重试',
  RISK_BLOCKED: '请求被平台风控拦截，需要人工完成验证后重试',
  PLATFORM_REJECTED: '闲鱼接口拒绝了本次请求',
}

function readError(code: 'LOGIN_REQUIRED' | 'RISK_BLOCKED' | 'PLATFORM_REJECTED'): ApiError {
  return new ApiError(code, READ_MESSAGES[code], { phase: 'read', retryable: false })
}

/** 按文本特征分类：先识别风控，再识别登录，最后归为平台拒绝。 */
function classifyText(text: string): ApiError {
  if (RISK_PATTERN.test(text)) return readError('RISK_BLOCKED')
  if (LOGIN_PATTERN.test(text)) return readError('LOGIN_REQUIRED')
  return readError('PLATFORM_REJECTED')
}

/**
 * 按 MTOP `ret` 分类只读结果。
 *
 * @param ret MTOP 响应的 `ret` 字段。
 * @returns 成功（`ret[0]` 以 `SUCCESS` 开头）返回 null；失败返回脱敏 {@link ApiError}
 *          （`LOGIN_REQUIRED` / `RISK_BLOCKED` / `PLATFORM_REJECTED`）。非法或缺失 ret 一律按
 *          `PLATFORM_REJECTED` 拒绝，绝不返回成功。分类结果不含原始 ret 文本。
 */
export function classifyMtopRet(ret: unknown): ApiError | null {
  const first = Array.isArray(ret) ? ret[0] : undefined
  if (typeof first !== 'string') return readError('PLATFORM_REJECTED')
  if (first.startsWith('SUCCESS')) return null
  return classifyText(first)
}

/**
 * 按完整 MTOP 响应分类只读结果。
 *
 * @param payload 已解析的 MTOP 响应（或拦截页文本）。
 * @returns 成功返回 null；失败返回脱敏 {@link ApiError}。缺少 `ret` 视为响应被网关改写，按
 *          `PLATFORM_REJECTED` 拒绝，不把缺字段当成成功。返回对象不含原始响应正文。
 */
export function classifyReadResponse(payload: unknown): ApiError | null {
  if (typeof payload === 'string') return classifyText(payload)
  if (!object(payload)) return readError('PLATFORM_REJECTED')
  if (!Object.hasOwn(payload, 'ret') || payload['ret'] === undefined) {
    return readError('PLATFORM_REJECTED')
  }
  return classifyMtopRet(payload['ret'])
}
