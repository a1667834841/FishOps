/**
 * AI 端点安全 Origin 解析辅助工具。
 *
 * 核心职责：
 * 负责「用户填写的 AI Base URL → 安全 scheme+host origin / match pattern」的解析与校验。
 * 扩展已在 manifest.json 静态声明全域名 host_permissions，本模块不再涉及 Chrome 动态权限申请。
 *
 * 安全规则与约束（硬性要求）：
 * 1. 允许 HTTP / HTTPS 协议接口并保留 scheme；任意包含用户名/密码认证信息、查询参数（query）
 *    或片段标识（fragment）的 URL 均提示禁止；
 * 2. 仅解析出纯安全 origin（如 `https://api.openai.com/*`、`http://127.0.0.1:8080/*`），绝不包含 secret、路径、query；
 * 3. 若后台已配置（configured === true）但用户输入框留空，优先采用保存的 origin，
 *    若已配置但 origin 缺失，严禁回退默认端点，明确报错；
 * 4. 仅未配置（configured 为 false 或缺省）且输入框留空时，才允许回退默认端点。
 */
import { extractSafeAiOrigin, type SafeAiOriginResult } from '@fishops/shared'

/** 目标 Origin 解析结果。 */
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
 * 核心安全规则：
 * 1. 用户当前输入框填写的 URL（非空）最高优先，校验必须为合法 HTTP/HTTPS，禁止带 userinfo / query / fragment；
 * 2. 若后台已配置（configured === true）且用户输入框留空：
 *    - 若 permissionOrigin 存在且合法（含 HTTP），使用该 Origin；
 *    - 若 permissionOrigin 缺失（说明后台已保存端点无效），严禁回退默认端点，
 *      明确提示「现有端点无效，请用户填写合规的 HTTP/HTTPS 地址并保存」，绝不显示存储中的完整 URL 或 secret；
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
    // 已配置但 permissionOrigin 缺失，说明旧配置端点无效；严禁回退默认端点，防访问错域名
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

export { extractSafeAiOrigin, type SafeAiOriginResult }
