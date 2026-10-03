/**
 * 手动配置（AI / 飞书）领域类型（共享，纯类型）。
 *
 * 背景与约束（硬性）：
 * - 配置页原先误用 `MIGRATE_LEGACY_CONFIG` 保存用户**手动填写**的 AI / 飞书配置；
 *   迁移命令语义是「从旧扩展转移」，不应承载手动输入，故新增专用命令
 *   `AI_CONFIG_SET` / `AI_CONFIG_STATUS` / `FEISHU_CONFIG_SET` / `FEISHU_CONFIG_STATUS`。
 * - 凭据（`apiKey` / `appSecret` / `spreadsheetToken`）只写入扩展专用存储键
 *   （`fishops.reply.aiProvider` / `fishops.analysis.feishuConfig`）；
 * - 命令响应、事件、日志、错误**绝不回显任何明文凭据**：
 *   状态结果只含 `configured` 与派生的 `provider` / 存在性布尔。
 *
 * 写入采用 PATCH 语义：负载中出现的字段才更新；未出现的字段保持原值。
 * 因此 `apiKey: ''`（显式空串）表示清除已保存的密钥，而不是「未提供」。
 */

/** 单字段长度上限（含 apiKey / appSecret，防止超长写入）。 */
export const CONFIG_FIELD_MAX_LENGTH = 8192

/** AI 超时上限（毫秒），防止误填长期挂起。 */
export const CONFIG_MAX_TIMEOUT_MS = 5 * 60 * 1000

/**
 * AI_CONFIG_SET 请求负载（PATCH：仅更新出现的字段）。
 *
 * `apiKey` 仅在写入路径使用，绝不回显。
 */
export interface AiConfigSetPayload {
  /** AI 密钥（敏感，含空串表示清除）。 */
  apiKey?: string
  /** AI Base URL；空串时回退默认值。 */
  baseUrl?: string
  /** AI 模型名；空串时回退默认值。 */
  model?: string
  /** 请求超时（毫秒，正整数）。 */
  timeoutMs?: number
}

/**
 * FEISHU_CONFIG_SET 请求负载（PATCH：仅更新出现的字段）。
 *
 * `appSecret` / `spreadsheetToken` 敏感，绝不回显；
 * 保存时经合并后必须满足必需字段完整，否则拒绝写入半成品。
 */
export interface FeishuConfigSetPayload {
  appId?: string
  appSecret?: string
  spreadsheetToken?: string
  productTableId?: string
  /** 空串表示清除可选的商家表格 ID。 */
  sellerTableId?: string
}

/** AI 配置状态（只含非敏感信息：是否已配置 + 派生供应方 + 模型 + 超时 + 安全域名 Origin）。 */
export interface AiConfigStatus {
  /** 是否已配置密钥（只回布尔）。 */
  configured: boolean
  /** 由 baseUrl 推断的供应方标识（派生、非敏感）。 */
  provider: string
  /** 当前模型名（非敏感）。 */
  model: string
  /** 当前超时（毫秒）。 */
  timeoutMs: number
  /**
   * 安全的 AI 接口 Origin（只含 scheme 与 host，绝不包含 key、baseURL 路径、query、片段或 userinfo）。
   * 保留原始 scheme（http / https），用于前端设置页按钮进行显式按需权限申请。
   */
  permissionOrigin?: string
}

/** 安全提取 AI 接口 Origin 的解析结果。 */
export interface SafeAiOriginResult {
  ok: boolean
  origin?: string
  pattern?: string
  error?: string
}

/** IPv4 地址逐段校验（四段十进制、每段 0-255）。 */
function isIpv4Host(host: string): boolean {
  const parts = host.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 判断 host 是否为标准域名或 IP 地址（用于拒绝非标准 / 空 host）。
 *
 * - IPv6 字面量：`URL.hostname` 保留方括号，形如 `[::1]`；
 * - IPv4：四段 0-255；
 * - 域名：点分隔标签，标签仅含字母 / 数字 / 连字符且首尾为字母或数字，单标签 ≤ 63、总长 ≤ 253。
 */
function isStandardAiHost(host: string): boolean {
  // IPv6 字面量（URL.hostname 保留方括号）。
  if (host.startsWith('[') && host.endsWith(']')) return true
  // 纯 IPv6（去掉方括号后仍含冒号）。
  if (host.includes(':')) return true
  if (isIpv4Host(host)) return true
  if (host.length === 0 || host.length > 253) return false
  const labels = host.split('.')
  return labels.every(
    (label) => label.length > 0 && label.length <= 63 && /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label),
  )
}

/**
 * 校验 AI 接口 URL 并提取安全 Origin 及 Chrome 权限 Match Pattern。
 *
 * 安全约束与业务规则：
 * 1. 允许 HTTP / HTTPS 协议接口，并保留原始 scheme
 *    （HTTP 仅由上层设置页提示「明文传输 API Key」风险并要求用户显式确认，不静默放行）；
 * 2. 严格禁止包含用户名、密码等认证信息（userinfo）；
 * 3. 严格禁止包含查询参数（query / search）；
 * 4. 严格禁止包含片段标识（fragment / hash）；
 * 5. 域名必须为标准域名或 IP 地址，禁止空 host / 非标准 host；
 * 6. 提取标准 origin（如 `https://api.openai.com`、`http://127.0.0.1:8080`），
 *    不含任何路径、query、片段、密钥或认证信息；
 * 7. 组装符合 Chrome 权限规范的 match pattern（如 `https://api.openai.com/*`），保留 scheme。
 */
export function extractSafeAiOrigin(rawUrl: string): SafeAiOriginResult {
  const trimmed = (rawUrl ?? '').trim()
  if (!trimmed) {
    return { ok: false, error: 'URL 不能为空' }
  }

  let parsed: URL
  try {
    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    const normalized = hasScheme ? trimmed : `https://${trimmed}`
    parsed = new URL(normalized)
  } catch {
    return { ok: false, error: 'URL 格式无效' }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: '仅支持 HTTP/HTTPS 协议接口' }
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URL 禁止包含用户名或密码等认证信息' }
  }

  if (parsed.search && parsed.search.length > 0) {
    return { ok: false, error: 'URL 禁止包含查询参数' }
  }

  if (parsed.hash && parsed.hash.length > 0) {
    return { ok: false, error: 'URL 禁止包含片段标识' }
  }

  const hostname = parsed.hostname.trim()
  if (!hostname) {
    return { ok: false, error: 'URL 域名无效' }
  }
  if (!isStandardAiHost(hostname)) {
    return { ok: false, error: 'URL 域名格式无效，仅支持标准域名或 IP 地址' }
  }

  const origin = parsed.origin
  const pattern = `${origin}/*`
  return { ok: true, origin, pattern }
}

// ---------------- AI 配置连通性自测（AI_CONFIG_TEST） ----------------

/**
 * AI 配置自测错误码（安全，绝不携带响应体 / 凭据 / 完整 URL）。
 *
 * - `TEST_IN_PROGRESS`：已有一次测试进行中（防并发）；
 * - `CONFIG_ERROR`：读取本地 AI 配置失败；
 * - `NO_API_KEY`：未配置密钥；
 * - 其余与 `AiErrorCode` 语义一致，但探测正文 / 响应 body 一律不回传。
 */
export type AiConfigTestErrorCode =
  | 'TEST_IN_PROGRESS'
  | 'CONFIG_ERROR'
  | 'NO_API_KEY'
  | 'INVALID_REQUEST'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'NETWORK'
  | 'UNSUPPORTED'

/** AI 配置自测结果公共字段（均为非敏感派生信息）。 */
export interface AiConfigTestBase {
  /** 由 baseUrl 推断的供应方标识（派生、非敏感）。 */
  provider: string
  /** 实际使用的模型名（非敏感）。 */
  model: string
  /** 端到端耗时（毫秒）。 */
  latencyMs: number
}

/**
 * AI 配置自测成功。
 *
 * 只回传「是否存在结果」与「响应字符数」，**绝不回传探测正文 / key / 完整 URL / 响应 body**。
 */
export interface AiConfigTestSuccess extends AiConfigTestBase {
  ok: true
  /** 是否收到非空文本（仅布尔）。 */
  hasContent: boolean
  /** 响应文本字符数（仅长度，不含正文）。 */
  responseChars: number
}

/** AI 配置自测失败（保留安全 errorCode / status，不泄露 body / key）。 */
export interface AiConfigTestFailure extends AiConfigTestBase {
  ok: false
  error: {
    code: AiConfigTestErrorCode
    message: string
    /** HTTP 状态码（仅 HTTP 错误时存在，安全）。 */
    status?: number
  }
}

/** AI 配置自测结果。 */
export type AiConfigTestResult = AiConfigTestSuccess | AiConfigTestFailure

/** 飞书配置状态（只说明各成员是否存在，绝不含 appSecret / token 明文）。 */
export interface FeishuConfigStatus {
  /** 是否已保存完整飞书配置（只回布尔）。 */
  configured: boolean
  hasAppId: boolean
  hasAppSecret: boolean
  hasSpreadsheetToken: boolean
  hasProductTableId: boolean
  hasSellerTableId: boolean
}
