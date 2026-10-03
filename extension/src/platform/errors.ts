/**
 * 平台层统一错误分类。
 *
 * 闲鱼 MTOP 请求的失败来源很多（未登录、token 过期、风控验证码、网络异常、业务错误），
 * 上层（采集 / 聊天 / 发布）需要按类别决定行为（例如验证码要停下等人工处理，token 过期要重新登录）。
 * 这里把所有失败归一为固定的 {@link PlatformErrorCategory}，并提供安全的错误对象，
 * **绝不在 message / retCode 中携带 token、cookie 或完整响应**。
 */

/** 平台错误类别。 */
export type PlatformErrorCategory =
  /** 页面尚未安装平台 host，或目标 tab 不存在 / 已关闭。 */
  | 'host-unavailable'
  /** 未登录 / 会话失效：没有 token，或服务端明确要求登录。 */
  | 'unauthorized'
  /** token 过期或为空：cookie 中的 _m_h5_tk 已失效，需要页面刷新或重新登录。 */
  | 'token-expired'
  /** 验证码 / 风控拦截：需要人工完成滑块或安全验证，应暂停自动化。 */
  | 'captcha'
  /** 网络 / 传输层错误：fetch 失败、超时、DNS 等。 */
  | 'network'
  /** MTOP 业务错误：ret 非成功但可归类到上面的类别之外。 */
  | 'api'
  /** 其他无法归类的错误。 */
  | 'unknown'

/** 可安全序列化、可跨 Bridge 传递的错误负载（不含任何凭据或原始响应）。 */
export interface PlatformErrorPayload {
  category: PlatformErrorCategory
  /** 面向用户的安全文案。 */
  message: string
  /** MTOP 返回的 ret 码（如 `FAIL_SYS_TOKEN_EXOIRED`），仅用于诊断，不含凭据。 */
  retCode?: string
}

/** 平台错误对象。 */
export class PlatformError extends Error {
  readonly category: PlatformErrorCategory
  /** MTOP ret 码（若有），例如 `FAIL_SYS_USER_VALIDATE`。 */
  readonly retCode?: string

  constructor(
    category: PlatformErrorCategory,
    message: string,
    options: { retCode?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'PlatformError'
    this.category = category
    this.retCode = options.retCode
  }

  /** 转换为可跨进程传输的安全负载。 */
  toPayload(): PlatformErrorPayload {
    return {
      category: this.category,
      message: this.message,
      ...(this.retCode === undefined ? {} : { retCode: this.retCode }),
    }
  }
}

/** 每个类别对应的默认安全文案。 */
const CATEGORY_MESSAGE: Record<PlatformErrorCategory, string> = {
  'host-unavailable': '未找到可用的闲鱼页面（MAIN world host 未就绪），请打开或刷新 goofish.com 页面后重试',
  unauthorized: '未登录或登录状态已失效，请先在 goofish.com 登录闲鱼账号',
  'token-expired': 'MTOP token 已过期，请刷新闲鱼页面后重试',
  captcha: '请求被风控拦截，可能需要在页面完成验证码 / 滑块验证',
  network: '网络请求失败，请检查网络连接后重试',
  api: '闲鱼接口返回业务错误',
  unknown: '发生未知错误',
}

/** 取得某类别的默认安全文案。 */
export function defaultMessageFor(category: PlatformErrorCategory): string {
  return CATEGORY_MESSAGE[category]
}

/**
 * ret 码 → 类别 的匹配规则（按顺序匹配，先命中者优先）。
 *
 * 顺序有意为之：先识别最“紧急”的风控 / 验证码，再识别 token，最后才是未登录与泛化错误。
 * 这些 ret 码来自阿里 MTOP 网关与闲鱼风控（`_tmd_` / `x5sec` / `punish` 出现在验证码 URL 上）。
 */
const RET_RULES: ReadonlyArray<{ pattern: RegExp; category: PlatformErrorCategory }> = [
  // 风控 / 验证码：RGV587 是“被挤爆”、FAIL_SYS_USER_VALIDATE 是需要安全验证
  { pattern: /FAIL_SYS_USER_VALIDATE|RGV587|_tmd_|punish|x5sec|captcha|安全验证|滑块|验证码|被挤爆/i, category: 'captcha' },
  // token 过期 / 为空（注意阿里的历史拼写错误 EXOIRED）
  { pattern: /FAIL_SYS_TOKEN_EXPIRED|FAIL_SYS_TOKEN_EXOIRED|FAIL_SYS_TOKEN_EMPTY|FAIL_SYS_TOKEN_INVALID|TOKEN_EXPIRED|TOKEN_EXOIRED|TOKEN_EMPTY/i, category: 'token-expired' },
  // 未登录 / 会话失效
  { pattern: /FAIL_SYS_SESSION_EXPIRED|FAIL_SYS_NOT_LOGIN|FAIL_SYS_LOGIN|NOT_LOGIN|未登录|请先登录|登录失效|登录已过期/i, category: 'unauthorized' },
]

/** 判断 MTOP 响应是否为成功（ret[0] 以 SUCCESS 开头）。 */
export function isMtopSuccess(ret: unknown): boolean {
  const first = firstRet(ret)
  return first !== null && first.startsWith('SUCCESS')
}

/** 取 ret 数组的首个字符串，非法时返回 null。 */
export function firstRet(ret: unknown): string | null {
  if (!Array.isArray(ret)) return null
  const first = ret[0]
  return typeof first === 'string' ? first : null
}

/**
 * 根据 MTOP 响应中的 ret 码分类错误。
 *
 * @param ret MTOP 响应里的 `ret` 字段（字符串数组或未知类型）。
 * @returns 命中规则时返回类别与 ret 码；成功或无法识别时返回 null。
 */
export function classifyMtopRet(ret: unknown): { category: PlatformErrorCategory; retCode: string } | null {
  const first = firstRet(ret)
  if (first === null || first.startsWith('SUCCESS')) return null
  const retCode = first.split('::')[0] ?? first
  for (const rule of RET_RULES) {
    if (rule.pattern.test(first)) return { category: rule.category, retCode }
  }
  return { category: 'api', retCode }
}

/**
 * 把一段 MTOP 原始响应归类为错误负载；成功则返回 null。
 *
 * 注意：只读取 `ret` 或做轻量的风控特征匹配，不会把整个响应（可能很大且含用户数据）
 * 放入错误对象，更不会记录原始响应。
 */
export function classifyMtopPayload(payload: unknown): PlatformErrorPayload | null {
  // 网关可能直接返回 HTML / 纯文本（例如安全验证页），先按特征串识别。
  if (typeof payload === 'string') {
    for (const rule of RET_RULES) {
      if (rule.pattern.test(payload)) {
        return { category: rule.category, message: defaultMessageFor(rule.category) }
      }
    }
    return { category: 'unknown', message: defaultMessageFor('unknown') }
  }
  if (typeof payload !== 'object' || payload === null) {
    return { category: 'unknown', message: defaultMessageFor('unknown') }
  }

  const ret = (payload as { ret?: unknown }).ret
  if (ret === undefined) {
    // 正常 MTOP 响应必带 ret；缺失说明响应被改写或非预期，视为业务错误。
    return { category: 'api', message: '响应缺少 ret 字段，可能被网关或风控拦截' }
  }
  const matched = classifyMtopRet(ret)
  if (matched === null) return null
  return {
    category: matched.category,
    message: defaultMessageFor(matched.category),
    retCode: matched.retCode,
  }
}

/** 把任意抛出的异常（网络错误等）归类为安全负载。 */
export function classifyThrownError(error: unknown): PlatformErrorPayload {
  if (error instanceof PlatformError) return error.toPayload()
  if (error instanceof Error) {
    const name = error.name
    if (name === 'AbortError' || name === 'TimeoutError') {
      return { category: 'network', message: '请求超时' }
    }
    // fetch 失败通常是 TypeError: Failed to fetch / Load failed
    if (error instanceof TypeError) {
      return { category: 'network', message: defaultMessageFor('network') }
    }
    return { category: 'unknown', message: error.message }
  }
  return { category: 'unknown', message: defaultMessageFor('unknown') }
}

/** 把任意异常转换为 PlatformError（已是则原样返回）。 */
export function toPlatformError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error
  const payload = classifyThrownError(error)
  return new PlatformError(payload.category, payload.message, { retCode: payload.retCode, cause: error })
}
