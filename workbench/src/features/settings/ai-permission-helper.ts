/**
 * AI 端点按需权限授权辅助工具（适配 Chrome Permissions API）。
 *
 * 规范与约束（硬性要求）：
 * 1. 真实环境下 aiOriginGranted 初始为 false；
 * 2. 允许 HTTP / HTTPS 协议接口并保留 scheme；任意包含用户名/密码认证信息、查询参数（query）
 *    或片段标识（fragment）的 URL 均提示禁止；
 * 3. 仅授权提取出的安全 origin（如 `https://api.openai.com/*`、`http://127.0.0.1:8080/*`），绝不包含 secret、路径、query；
 * 4. 必须在用户点击同步手势内调用 `chrome.permissions.request`，严禁在 await 之后调用；
 * 5. 适配浏览器环境与测试环境（缺少 chrome 类型或在非扩展环境时不崩溃）。
 */
import { extractSafeAiOrigin, type SafeAiOriginResult } from '@fishops/shared'

/** Chrome Permissions API 最小接口定义（环境无 types 扩展时自适配）。 */
export interface ChromePermissionsApi {
  request(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>
  contains?(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>
}

/** 获取全局 chrome.permissions 引用（非扩展环境返回 null）。 */
export function getChromePermissions(): ChromePermissionsApi | null {
  if (
    typeof chrome !== 'undefined' &&
    chrome &&
    chrome.permissions &&
    typeof chrome.permissions.request === 'function'
  ) {
    return chrome.permissions as ChromePermissionsApi
  }
  return null
}

/** 待授权的目标 Origin 解析结果。 */
export interface ResolvedAiTargetOrigin {
  ok: boolean
  origin?: string
  pattern?: string
  error?: string
}

export interface ResolveTargetAiOriginOptions {
  /** 后台是否已配置过 AI 凭据 / 端点。 */
  configured?: boolean
  /** 用户当前在输入框填写的 URL。 */
  inputUrl?: string
  /** 后台已保存并预先载入的安全 Origin（纯 scheme+host）。 */
  permissionOrigin?: string | null
  /** 默认端点（仅在未配置时允许回退）。 */
  defaultUrl?: string
}

/**
 * 从用户填写的输入值或预载入的安全 status origin 计算目标 Origin 及 Match Pattern。
 *
 * 核心安全规则（防止错误授权）：
 * 1. 用户当前输入框填写的 URL（非空）最高优先，校验必须为合法 HTTP/HTTPS，禁止带 userinfo / query / fragment；
 * 2. 若后台已配置（configured === true）且用户输入框留空：
 *    - 若 permissionOrigin 存在且合法（含 HTTP），使用该 Origin（按当前 origin 请求，不回退默认域名）；
 *    - 若 permissionOrigin 缺失（说明后台已保存端点无效），严禁回退默认 OpenAI 端点，
 *      严禁发起授权请求，明确提示「现有端点无效，请用户填写合规的 HTTP/HTTPS 地址并保存」，绝不显示存储中的完整 URL 或 secret；
 * 3. 仅未配置（configured 为 false 或缺省）且用户输入框留空时，才允许回退默认 OpenAI 端点。
 */
export function resolveTargetAiOrigin(options: ResolveTargetAiOriginOptions): ResolvedAiTargetOrigin {
  const input = (options.inputUrl ?? '').trim()
  if (input.length > 0) {
    const result: SafeAiOriginResult = extractSafeAiOrigin(input)
    if (!result.ok) {
      return { ok: false, error: result.error ?? '输入的 AI 接口 URL 无效' }
    }
    return { ok: true, origin: result.origin, pattern: result.pattern }
  }

  // 后台已配置（configured === true）但用户输入框留空保留现有端点
  if (options.configured) {
    const savedOrigin = (options.permissionOrigin ?? '').trim()
    if (savedOrigin.length > 0) {
      const result: SafeAiOriginResult = extractSafeAiOrigin(savedOrigin)
      if (result.ok) {
        return { ok: true, origin: result.origin, pattern: result.pattern }
      }
    }
    // 已配置但 permissionOrigin 缺失，说明旧配置端点无效；严禁回退默认端点，防授权错域名
    return {
      ok: false,
      error: '现有端点无效，请用户填写合规的 HTTP/HTTPS 地址并保存',
    }
  }

  // 仅在未配置（configured 为 false 或未提供）时，才允许回退默认 OpenAI 端点
  const fallback = (options.defaultUrl ?? '').trim()
  if (fallback.length > 0) {
    const result: SafeAiOriginResult = extractSafeAiOrigin(fallback)
    if (result.ok) {
      return { ok: true, origin: result.origin, pattern: result.pattern }
    }
  }

  return { ok: false, error: '请先填写 AI API Base URL 或配置后台端点' }
}

/**
 * 在同步用户手势内发起 Chrome 域名权限请求。
 *
 * 核心警告：
 * 此函数必须在同步点击事件处理函数中直接调用，其内部立即同步执行 `api.request(...)`，
 * 绝不能放在 `await` 之后，否则 Chrome 丢失 user gesture 会抛错。
 */
export function requestChromeOriginPermission(
  pattern: string,
  api: ChromePermissionsApi | null = getChromePermissions()
): Promise<boolean> {
  if (!api || typeof api.request !== 'function') {
    return Promise.reject(new Error('当前环境不支持动态权限申请（非扩展环境，请在已安装扩展的页面中使用）'))
  }

  // 必须在同步用户手势执行栈内立即触发底层 request
  try {
    const maybePromise = api.request({ origins: [pattern] })
    if (maybePromise && typeof (maybePromise as Promise<boolean>).then === 'function') {
      return maybePromise
    }
  } catch (error) {
    return Promise.reject(error)
  }

  // 兼容老版本 callback 签名
  return new Promise<boolean>((resolve, reject) => {
    try {
      ;(api.request as unknown as (perms: unknown, cb: (granted: boolean) => void) => void)(
        { origins: [pattern] },
        (granted: boolean) => {
          const lastError =
            typeof chrome !== 'undefined' ? chrome.runtime?.lastError?.message : undefined
          if (lastError) {
            reject(new Error(lastError))
          } else {
            resolve(Boolean(granted))
          }
        },
      )
    } catch (e) {
      reject(e)
    }
  })
}

/**
 * 查询指定 Origin Pattern 当前是否已获得权限。
 */
export async function checkChromeOriginPermission(
  pattern: string,
  api: ChromePermissionsApi | null = getChromePermissions()
): Promise<boolean> {
  if (!api || typeof api.contains !== 'function') {
    return false
  }

  try {
    const maybePromise = api.contains({ origins: [pattern] })
    if (maybePromise && typeof (maybePromise as Promise<boolean>).then === 'function') {
      return await maybePromise
    }
    return await new Promise<boolean>((resolve) => {
      ;(api.contains as unknown as (perms: unknown, cb: (has: boolean) => void) => void)(
        { origins: [pattern] },
        (has: boolean) => {
          resolve(Boolean(has))
        },
      )
    })
  } catch {
    return false
  }
}

export { extractSafeAiOrigin, type SafeAiOriginResult }
