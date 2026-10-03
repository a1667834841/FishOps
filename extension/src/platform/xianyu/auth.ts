/**
 * 闲鱼登录态抽象。
 *
 * 迁移自旧 `FishOps`：main 分支 `xianyu-api.js` 的 token 读取，以及 chat 分支
 * `inject/api/user-api.js` 的“获取当前用户 ID”流程（`mtop.taobao.idlemessage.pc.loginuser.get`）。
 *
 * 当前用户 ID 的**优先来源**改为服务端下发的受信 cookie（真实当前用户上下文）：
 * 依次尝试 `unb` 与 `havana_lgc2_*`（后者的 `hid` 即用户 ID，与 `unb` 等值；旧 chat 分支
 * `background/goods-list-service.js` 同样以 `unb` 作为用户 ID）。这样即使用户已登录、LWP 链路正常，
 * 但 `loginuser.get` 被风控拦截（如 `FAIL_SYS_ILLEGAL_ACCESS`）时，仍能可靠拿到当前用户 ID。
 * 只有受信 cookie 均不可用时才回退到 MTOP `loginuser.get`，并保留未登录 / token / 风控 / 网络等错误类别。
 *
 * 边界约定：
 * - 本模块只在平台层内部流转 token；对外（跨 Bridge）只暴露布尔值与 userId，
 *   **绝不返回 cookie 原文**，也不会打印 token / cookie；
 * - `havana` cookie 内部含登录 token，本模块**只提取其中的 `hid`**，其它字段一律丢弃、不返回、不记录；
 * - `getToken()` 是给同层 mtop-client 签名用的，不应直接透出到 Workbench。
 */
import { PlatformError, classifyMtopPayload, defaultMessageFor } from '../errors'
import type { AuthStateResult } from '../protocol'
import type { MtopTransport, MtopTransportRequest } from './mtop-client'
import { MTOP_APP_KEY, extractToken, generateSignature, getFullToken } from './sign'

/** 获取当前登录用户 ID 的 MTOP 接口。 */
export const LOGIN_USER_API = 'mtop.taobao.idlemessage.pc.loginuser.get'

/** 接口基础 URL（与 chat 分支 user-api.js 一致）。 */
export const LOGIN_USER_BASE_URL = 'https://h5api.m.goofish.com/h5/mtop.taobao.idlemessage.pc.loginuser.get/1.0/'

/** 当前登录用户 ID 的受信 cookie 名（服务端下发，代表真实当前用户）。 */
export const USER_ID_COOKIE = 'unb'

/** `havana_lgc2_<site>` 受信 cookie 前缀（其 JSON 负载中的 `hid` 即当前用户 ID）。 */
export const HAVANA_COOKIE_PREFIX = 'havana_lgc2_'

export interface AuthServiceDeps {
  /** 读取页面 cookie 字符串；默认安全读 document.cookie。 */
  readCookie?: () => string
  /** 用于调用 loginuser.get 的 transport（HTTP 层）。 */
  transport: MtopTransport
  /** 时间戳来源，默认 Date.now。 */
  now?: () => number
}

export interface AuthService {
  /** 是否存在 `_m_h5_tk` cookie。 */
  hasToken(): boolean
  /** 解析后的 token（去掉时间戳后缀）；不存在返回 null。仅供平台内部签名使用。 */
  getToken(): string | null
  /** 快速登录态判断（基于 token 是否存在）。 */
  getAuthState(): AuthStateResult
  /**
   * 获取当前用户 ID。
   *
   * 优先读服务端下发的受信 cookie `unb`（真实当前用户，不触碰 MTOP）；缺失时才回退到
   * `loginuser.get`（更弱的兼容路径）。
   * @throws PlatformError 未登录 / token 过期 / 风控 / 网络错误（仅回退路径可能抛出）。
   */
  getCurrentUserId(): Promise<string | null>
}

function defaultReadCookie(): string {
  return typeof document === 'undefined' ? '' : document.cookie
}

/**
 * 校验候选值是否可作为「当前登录用户 ID」。
 *
 * 只接受非空、长度受限、且不含 `@` 的 ID：`@` 是会话 cid / 发送信封的后缀（见
 * `toFullCid`），带 `@` 的值可能是会话标识或对方 ID，**绝不能当作本人**。
 * 不做「必须是纯数字」的假设（账号 ID 形态可能变化），但要求是可作 cookie 值的简单串。
 */
export function isValidUserId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > 64) return false
  if (trimmed.includes('@')) return false
  return /^[0-9A-Za-z_-]+$/.test(trimmed)
}

/**
 * 从 cookie 字符串读取指定名（行首或 `;` 之后）的原始值。
 * 仅匹配独立字段名，避免把 `xxxunb=` 之类的其它 cookie 误命中。
 */
function readCookieValue(cookieString: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`))
  return match ? (match[1] ?? '').trim() : null
}

/**
 * 解码标准 / URL-safe base64（容忍缺失 padding）；失败返回 null，不抛错。
 */
function decodeBase64(value: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    // cookie 值可能是 percent-encoded（如 `%3D`），先还原。
    const raw = value.includes('%') ? decodeURIComponent(value) : value
    const normalized = raw.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    return atob(padded)
  } catch {
    return null
  }
}

/**
 * 从 `havana_lgc2_*` 受信 cookie 中提取 `hid`（当前用户 ID）。
 * **只返回 `hid`；cookie 中的 `sg` / `token` 等其它字段一律丢弃，绝不返回或记录。**
 */
function extractHavanaUserId(cookieString: string): string | null {
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)(${HAVANA_COOKIE_PREFIX}\\d+)=([^;]*)`))
  if (!match) return null
  const decoded = decodeBase64((match[2] ?? '').trim())
  if (decoded === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(decoded)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const hid = (parsed as { hid?: unknown }).hid
  if (typeof hid === 'number') return isValidUserId(String(hid)) ? String(hid) : null
  return isValidUserId(hid) ? (hid as string).trim() : null
}

/**
 * 从 cookie 字符串中解析「当前登录用户 ID」。
 *
 * 依次尝试服务端下发的受信 cookie：`unb` → `havana_lgc2_*`（`hid`）——均为真实当前用户上下文。
 * **只返回值，绝不返回 / 打印 cookie 原文**；均未找到或值非法（如空、含 `@`）时返回 null，
 * 绝不猜测、绝不用对方（买家）ID 顶替。
 */
export function extractUserIdFromCookie(cookieString: string): string | null {
  const unb = readCookieValue(cookieString, USER_ID_COOKIE)
  if (isValidUserId(unb)) return unb.trim()
  return extractHavanaUserId(cookieString)
}

/**
 * 构造 loginuser.get 的 GET 请求。
 *
 * 与 user-api.js 的差异仅是提取为纯函数；签名数据同样是“查询参数按插入顺序拼接”，
 * 因此签名字符串与旧实现一致。
 */
export function buildLoginUserRequest(token: string, timestamp: string): MtopTransportRequest {
  const queryParams: Record<string, string> = {
    jsv: '2.7.2',
    appKey: MTOP_APP_KEY,
    t: timestamp,
    sign: '',
    v: '1.0',
    type: 'originaljson',
    accountSite: 'xianyu',
    dataType: 'json',
    timeout: '20000',
    api: LOGIN_USER_API,
    sessionOption: 'AutoLoginOnly',
    spm_cnt: 'a21ybx.im.0.0',
    spm_pre: 'a21ybx.home.sidebar.2.4c053da6OBdnko',
    log_id: '4c053da6OBdnko',
  }

  const signData = Object.keys(queryParams)
    .map((key) => `${key}=${queryParams[key] ?? ''}`)
    .join('&')
  const sign = generateSignature(signData, { token, timestamp, appKey: MTOP_APP_KEY }).sign
  queryParams.sign = sign

  const url =
    LOGIN_USER_BASE_URL +
    '?' +
    Object.keys(queryParams)
      .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key] ?? '')}`)
      .join('&')

  return {
    url,
    method: 'GET',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
  }
}

/** 从 loginuser.get 响应中提取 userId（字符串化）。 */
export function extractUserId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null
  const data = (payload as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return null
  const userId = (data as { userId?: unknown }).userId
  if (typeof userId === 'string' && userId.length > 0) return userId
  if (typeof userId === 'number') return String(userId)
  return null
}

/** 创建登录态服务。 */
export function createAuthService(deps: AuthServiceDeps): AuthService {
  const readCookie = deps.readCookie ?? defaultReadCookie
  const now = deps.now ?? (() => Date.now())

  function hasToken(): boolean {
    return getFullToken(readCookie()) !== null
  }

  function getToken(): string | null {
    return extractToken(readCookie())
  }

  function getAuthState(): AuthStateResult {
    const token = getToken()
    return { loggedIn: token !== null && token.length > 0, hasToken: hasToken() }
  }

  async function getCurrentUserId(): Promise<string | null> {
    // 优先使用服务端下发的受信 cookie（真实当前用户），避免依赖易被风控拦截的 loginuser.get。
    const userIdFromCookie = extractUserIdFromCookie(readCookie())
    if (userIdFromCookie) return userIdFromCookie

    // 回退：MTOP loginuser.get（保留未登录 / token / 风控 / 网络等类别透传）。
    const token = getToken()
    if (!token) {
      throw new PlatformError('unauthorized', defaultMessageFor('unauthorized'))
    }

    const request = buildLoginUserRequest(token, String(now()))
    const payload = await deps.transport.send(request)

    const failure = classifyMtopPayload(payload)
    if (failure) {
      throw new PlatformError(failure.category, failure.message, { retCode: failure.retCode })
    }

    const userId = extractUserId(payload)
    if (!userId) {
      throw new PlatformError('unknown', '登录用户接口未返回 userId')
    }
    return userId
  }

  return { hasToken, getToken, getAuthState, getCurrentUserId }
}
