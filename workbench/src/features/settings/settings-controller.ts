/**
 * 设置页控制器（SettingsController）。纯 TypeScript，可在 Node 下测试。
 *
 * 职责：
 * 1. AI 模型配置：使用专用命令 AI_CONFIG_SET / AI_CONFIG_STATUS，支持 PATCH 式手动保存，
 *    密钥只落专用键，绝不回显，返回非敏感状态（configured / provider / model / timeoutMs）；
 * 2. 飞书配置：使用专用命令 FEISHU_CONFIG_SET / FEISHU_CONFIG_STATUS，支持 PATCH 式手动保存，
 *    返回各成员存在性（绝不回显密钥明文），并提供飞书连接真实测试（基于 DATA_SOURCE_SCHEMA）；
 * 3. 回复策略与 AI 状态：自动回复开关（默认关闭）、模式选择（suggest/auto/manual）、保护参数，
 *    AI 暂停状态展示与手动暂停/恢复控制；开启 auto 模式强制二次确认；
 * 4. 运行环境与后台能力状态：整合 6 项模块健康检查（Bridge、闲鱼页面平台、聊天、回复引擎、采集、分析）；
 * 5. 安全准则：禁止调用旧迁移命令 MIGRATE_LEGACY_CONFIG，密钥绝不写入日志、诊断、状态或错误提示明文中。
 */
import { CommandTypes, EventTypes } from '@fishops/shared'
import {
  DEFAULT_REPLY_GLOBAL_CONFIG,
  extractSafeAiOrigin,
  type AiConfigSetPayload,
  type AiConfigStatus,
  type AutoReplyStatus,
  type FeishuConfigSetPayload,
  type FeishuConfigStatus,
  type ReplyGlobalConfig,
  type ReplyMode,
} from '../contracts'
import type { BridgeApi } from '../shared/bridge-api'
import { toErrorView, redactSecrets, type ErrorView } from '../shared/error-format'
import { StateStore, type ActionPhase, type LoadPhase } from '../shared/state-store'
import {
  CAPABILITY_CHECKS,
  createInitialCapabilityState,
  type CapabilityItem,
} from './capability-controller'
import { broadcastFeishuTargetChanged } from '../products/feishu-schema-controller'

export const SETTINGS_EVENTS = [
  EventTypes.CHAT_RULES_UPDATED,
  EventTypes.CHAT_AI_PAUSE_CHANGED,
  EventTypes.WORKER_STARTED,
] as const

/** 后台测试 AI 配置连通性的命令名称。 */
export const AI_CONFIG_TEST_COMMAND = 'AI_CONFIG_TEST'

export interface AiTestOptions {
  /** 是否存在未保存的表单修改。 */
  isDirty?: boolean
  /** 当前测试目标是否为 HTTP 协议端点。 */
  isHttp?: boolean
  /** 域名是否已被授予权限（false 时拦截并提示，测试按钮不绕过授权）。 */
  originGranted?: boolean
  /** 目标 Origin 字符串（仅 scheme+host），用于提示。 */
  origin?: string
}

/**
 * 格式化 AI 测试失败错误，输出可行动的结构化错误视图（ErrorView）。
 * 严格防护：绝不泄漏探测文本、API key、完整 URL 或响应 body。
 */
export function formatAiTestError(
  error: unknown,
  context?: {
    isHttp?: boolean
    originGranted?: boolean
    origin?: string
  },
): ErrorView {
  const errRecord = error && typeof error === 'object' ? (error as Record<string, unknown>) : null
  const errCode = typeof errRecord?.code === 'string' ? errRecord.code : ''
  const errStatus = typeof errRecord?.status === 'number' ? errRecord.status : undefined

  let rawMsg = ''
  if (typeof errRecord?.message === 'string') {
    rawMsg = errRecord.message
  } else if (error instanceof Error) {
    rawMsg = error.message
  } else if (typeof error === 'string') {
    rawMsg = error
  }

  // 严禁显示完整 URL：替换 URL 中的路径与查询参数，仅保留 protocol + host
  rawMsg = rawMsg.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
    try {
      const u = new URL(url)
      return `${u.protocol}//${u.host}`
    } catch {
      return '[URL]'
    }
  })

  // 脱敏 API Key、Token 等敏感字眼，绝不泄露凭据与响应 body
  const cleanDetail = redactSecrets(rawMsg)
  const lowerMsg = cleanDetail.toLowerCase()

  // ==================== 1. 优先按后台返回的固定 code / status 处理 ====================

  if (errCode === 'TIMEOUT' || errStatus === 408 || errStatus === 504) {
    const statusText = errStatus ? ` (${errStatus})` : ''
    return {
      title: `AI 接口响应超时${statusText}`,
      hint: '模型服务未在规定时间内返回响应，请检查网络稳定性或适当调大「超时上限 (毫秒)」后保存重试。',
      detail: cleanDetail,
      kind: 'timeout',
      code: 'TIMEOUT',
    }
  }

  if (errCode === 'NETWORK') {
    if (context?.originGranted === false) {
      const originHint = context?.origin ? `（目标域名：${context.origin}）` : ''
      return {
        title: 'AI 接口请求失败：域名可能未获授权',
        hint: `请检查并点击上方的「授权当前AI接口域名」按钮${originHint}完成浏览器授权后再试。`,
        detail: cleanDetail || '浏览器阻止了对该域名的网络请求（可能缺少 Chrome 域名权限）。',
        kind: 'auth',
        code: 'AI_PERMISSION_REQUIRED',
      }
    }
    if (context?.isHttp) {
      return {
        title: 'HTTP 接口网络连接失败',
        hint: '当前使用的是 HTTP 端点，请确保本地服务或内网代理已启动且端口正确；请确认已了解明文传输风险并完成授权。',
        detail: cleanDetail,
        kind: 'platform',
        code: 'HTTP_ENDPOINT_ERROR',
      }
    }
    return {
      title: '网络连接失败',
      hint: '无法连接到 AI 服务端点，请检查网络连接及 API Base URL 是否正确。',
      detail: cleanDetail,
      kind: 'platform',
      code: 'NETWORK',
    }
  }

  if (errCode === 'HTTP_ERROR' || typeof errStatus === 'number') {
    if (
      errStatus === 401 ||
      errStatus === 403 ||
      lowerMsg.includes('unauthorized') ||
      lowerMsg.includes('forbidden')
    ) {
      const statusText = errStatus ? ` (${errStatus})` : ''
      return {
        title: `API 认证失败${statusText}`,
        hint: 'API Key 无效、已失效或账户余额不足，请检查并在上方重新填写正确的 API Key，点击保存后再试。',
        detail: cleanDetail,
        kind: 'auth',
        code: 'AUTH_FAILED',
      }
    }
    if (errStatus === 404 || lowerMsg.includes('not found') || lowerMsg.includes('model_not_found')) {
      const statusText = errStatus ? ` (${errStatus})` : ''
      return {
        title: `模型或端点未找到${statusText}`,
        hint: '指定的模型不存在或 API Base URL 路径错误，请检查「API Base URL」与「模型名称」配置并保存重试。',
        detail: cleanDetail,
        kind: 'validation',
        code: 'MODEL_NOT_FOUND',
      }
    }
    if (errStatus && errStatus >= 500) {
      return {
        title: `AI 模型服务端异常 (${errStatus})`,
        hint: '模型提供商服务端返回 5xx 异常，请稍后重试或前往提供商状态页查看服务可用性。',
        detail: cleanDetail,
        kind: 'platform',
        code: 'UPSTREAM_ERROR',
      }
    }
    if (context?.isHttp) {
      const statusText = errStatus ? ` (${errStatus})` : ''
      return {
        title: `HTTP 接口请求失败${statusText}`,
        hint: '当前使用的是 HTTP 端点，请检查目标服务状态及配置参数。',
        detail: cleanDetail,
        kind: 'platform',
        code: errCode || 'HTTP_ERROR',
      }
    }
    const statusText = errStatus ? ` (${errStatus})` : ''
    return {
      title: `AI 接口返回错误${statusText}`,
      hint: '接口返回错误状态码，请检查 Base URL、API Key 与模型参数是否正确。',
      detail: cleanDetail,
      kind: 'platform',
      code: errCode || 'HTTP_ERROR',
    }
  }

  if (errCode === 'NO_API_KEY') {
    return {
      title: '未提供 API Key',
      hint: '请在上方填写有效的 API Key，点击保存配置后再进行接口测试。',
      detail: cleanDetail,
      kind: 'auth',
      code: 'NO_API_KEY',
    }
  }

  if (errCode === 'INVALID_REQUEST') {
    return {
      title: 'AI 请求参数无效',
      hint: '指定的模型不存在或请求参数不符合规范，请检查「模型名称」与参数配置后保存重试。',
      detail: cleanDetail,
      kind: 'validation',
      code: 'INVALID_REQUEST',
    }
  }

  if (errCode === 'INVALID_RESPONSE') {
    return {
      title: 'AI 响应格式解析失败',
      hint: '模型服务返回了非预期的响应内容，请检查接口是否兼容 OpenAI 规范。',
      detail: cleanDetail,
      kind: 'validation',
      code: 'INVALID_RESPONSE',
    }
  }

  if (errCode === 'AI_PERMISSION_REQUIRED') {
    const originHint = context?.origin ? `（目标域名：${context.origin}）` : ''
    return {
      title: 'AI 接口请求失败：域名可能未获授权',
      hint: `请检查并点击上方的「授权当前AI接口域名」按钮${originHint}完成浏览器授权后再试。`,
      detail: cleanDetail || '浏览器阻止了对该域名的网络请求（可能缺少 Chrome 域名权限）。',
      kind: 'auth',
      code: 'AI_PERMISSION_REQUIRED',
    }
  }

  // ==================== 2. 文本语义降级匹配（针对原始 Error 或未带 code 的错误） ====================

  // 域名权限不足
  if (
    context?.originGranted === false ||
    lowerMsg.includes('permission') ||
    lowerMsg.includes('not allowed') ||
    lowerMsg.includes('denied') ||
    (Boolean(context?.origin) && (lowerMsg.includes('failed to fetch') || lowerMsg.includes('net::')))
  ) {
    const originHint = context?.origin ? `（目标域名：${context.origin}）` : ''
    return {
      title: 'AI 接口请求失败：域名可能未获授权',
      hint: `请检查并点击上方的「授权当前AI接口域名」按钮${originHint}完成浏览器授权后再试。`,
      detail: cleanDetail || '浏览器阻止了对该域名的网络请求（可能缺少 Chrome 域名权限）。',
      kind: 'auth',
      code: 'AI_PERMISSION_REQUIRED',
    }
  }

  // 认证失败
  if (
    lowerMsg.includes('401') ||
    lowerMsg.includes('403') ||
    lowerMsg.includes('unauthorized') ||
    lowerMsg.includes('no_api_key') ||
    lowerMsg.includes('invalid_api_key') ||
    lowerMsg.includes('incorrect api key') ||
    lowerMsg.includes('authentication')
  ) {
    return {
      title: 'API 认证失败',
      hint: 'API Key 无效、已失效或账户余额不足，请检查并在上方重新填写正确的 API Key，点击保存后再试。',
      detail: cleanDetail,
      kind: 'auth',
      code: 'AUTH_FAILED',
    }
  }

  // 超时
  if (lowerMsg.includes('timeout') || lowerMsg.includes('timed out')) {
    return {
      title: 'AI 接口响应超时',
      hint: '模型服务未在规定时间内返回响应，请检查网络稳定性或适当调大「超时上限 (毫秒)」后保存重试。',
      detail: cleanDetail,
      kind: 'timeout',
      code: 'TIMEOUT',
    }
  }

  // 模型不存在
  if (
    lowerMsg.includes('model_not_found') ||
    lowerMsg.includes('does not exist') ||
    lowerMsg.includes('invalid_model')
  ) {
    return {
      title: '模型调用失败',
      hint: '指定的模型不存在或当前账户无权访问该模型，请检查「模型名称」配置并保存重试。',
      detail: cleanDetail,
      kind: 'validation',
      code: 'MODEL_NOT_FOUND',
    }
  }

  // 5xx 服务端错误
  if (
    lowerMsg.includes('500') ||
    lowerMsg.includes('502') ||
    lowerMsg.includes('503') ||
    lowerMsg.includes('internal')
  ) {
    return {
      title: 'AI 模型服务异常',
      hint: '模型提供商服务端返回 5xx 异常，请稍后重试或前往提供商状态页查看服务可用性。',
      detail: cleanDetail,
      kind: 'platform',
      code: 'UPSTREAM_ERROR',
    }
  }

  // 网络错误
  if (
    lowerMsg.includes('failed to fetch') ||
    lowerMsg.includes('networkerror') ||
    lowerMsg.includes('net::err') ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('network')
  ) {
    if (context?.isHttp) {
      return {
        title: 'HTTP 接口网络连接失败',
        hint: '当前使用的是 HTTP 端点，请确保本地服务或内网代理已启动且端口正确；请确认已了解明文传输风险并完成授权。',
        detail: cleanDetail,
        kind: 'platform',
        code: 'HTTP_ENDPOINT_ERROR',
      }
    }
    return {
      title: '网络连接失败',
      hint: '无法连接到 AI 服务端点，请检查网络连接及 API Base URL 是否正确。',
      detail: cleanDetail,
      kind: 'platform',
      code: 'NETWORK',
    }
  }

  // ==================== 3. 兜底处理 ====================
  const baseView = toErrorView(error)
  return {
    title: baseView.title || 'AI 接口测试失败',
    hint: baseView.hint || '请检查网络连接、API Key 与端点配置是否正确后重试。',
    detail: cleanDetail || baseView.detail,
    kind: baseView.kind,
    code: errCode || baseView.code || 'AI_TEST_FAILED',
  }
}

export interface AiConfigInput {
  baseUrl?: string
  apiKey?: string
  model?: string
  timeoutMs?: number
}

export interface FeishuConfigInput {
  appId?: string
  appSecret?: string
  spreadsheetToken?: string
  productTableId?: string
  sellerTableId?: string
}

export interface ReplyStrategyDraft {
  enabled: boolean
  mode: ReplyMode
  defaultCooldownSec: number
  defaultDelaySec: number
  maxAutoRepliesPerSession: number
  autoReplyWindowMin: number
  aiPauseMin: number
  blacklistText: string
  handoffKeywordsText: string
}

export interface SettingsState {
  availability: 'unavailable' | 'ready'
  ai: {
    configured: boolean
    provider: string | null
    model: string | null
    timeoutMs: number | null
    /** 后台返回的安全 Origin（仅 scheme+host，无密钥/路径/query），供权限按钮使用；保留原始 http/https scheme。 */
    permissionOrigin: string | null
    savePhase: ActionPhase
    saveError: string | null
    saveSuccess: string | null
    testPhase: ActionPhase
    testError: string | null
    testErrorView: ErrorView | null
    testSuccess: string | null
  }
  feishu: {
    configured: boolean
    hasAppId: boolean
    hasAppSecret: boolean
    hasSpreadsheetToken: boolean
    hasProductTableId: boolean
    hasSellerTableId: boolean
    fieldsCount: number | null
    savePhase: ActionPhase
    saveError: string | null
    saveSuccess: string | null
    testPhase: ActionPhase
    testError: string | null
    testSuccess: string | null
  }
  reply: {
    loadPhase: LoadPhase
    loadError: string | null
    global: ReplyGlobalConfig | null
    status: AutoReplyStatus | null
    rulesCount: number
    savePhase: ActionPhase
    saveError: string | null
    saveSuccess: string | null
    pausePhase: ActionPhase
    pauseError: string | null
  }
  capability: {
    running: boolean
    items: CapabilityItem[]
  }
  realtimeError: string | null
}

export interface SettingsControllerOptions {
  api: BridgeApi | null
  now?: () => number
}

/** 由 baseUrl 推断供应方显示名称（安全、非敏感）。 */
export function inferAiProvider(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`)
    const host = parsed.hostname.toLowerCase()
    if (!host) return 'OpenAI 兼容'
    if (host.includes('dashscope')) return '通义千问 (DashScope)'
    if (host.includes('deepseek')) return 'DeepSeek'
    if (host.includes('openai.com')) return 'OpenAI'
    if (host.includes('anthropic')) return 'Anthropic'
    if (host.includes('moonshot')) return 'Moonshot (Kimi)'
    if (host.includes('bigmodel') || host.includes('zhipu')) return '智谱 GLM'
    return host
  } catch {
    return 'OpenAI 兼容'
  }
}

export function createInitialSettingsState(availability: SettingsState['availability']): SettingsState {
  const cap = createInitialCapabilityState(availability)
  return {
    availability,
    ai: {
      configured: false,
      provider: null,
      model: null,
      timeoutMs: null,
      permissionOrigin: null,
      savePhase: 'idle',
      saveError: null,
      saveSuccess: null,
      testPhase: 'idle',
      testError: null,
      testErrorView: null,
      testSuccess: null,
    },
    feishu: {
      configured: false,
      hasAppId: false,
      hasAppSecret: false,
      hasSpreadsheetToken: false,
      hasProductTableId: false,
      hasSellerTableId: false,
      fieldsCount: null,
      savePhase: 'idle',
      saveError: null,
      saveSuccess: null,
      testPhase: 'idle',
      testError: null,
      testSuccess: null,
    },
    reply: {
      loadPhase: 'idle',
      loadError: null,
      global: null,
      status: null,
      rulesCount: 0,
      savePhase: 'idle',
      saveError: null,
      saveSuccess: null,
      pausePhase: 'idle',
      pauseError: null,
    },
    capability: {
      running: false,
      items: cap.items,
    },
    realtimeError: null,
  }
}

export class SettingsController extends StateStore<SettingsState> {
  private readonly api: BridgeApi | null
  private readonly now: () => number
  private runCapSeq = 0

  constructor(options: SettingsControllerOptions) {
    super(createInitialSettingsState(options.api ? 'ready' : 'unavailable'))
    this.api = options.api
    this.now = options.now ?? (() => Date.now())
  }

  /** 页面挂载时初始化：注册事件监听并加载已有配置与状态。 */
  start(): void {
    const api = this.api
    if (!api) return

    try {
      this.track(api.on(EventTypes.CHAT_RULES_UPDATED, () => void this.loadReplyConfig()))
      this.track(api.on(EventTypes.CHAT_AI_PAUSE_CHANGED, () => void this.loadAutoReplyStatus()))
      this.track(api.on(EventTypes.WORKER_STARTED, () => void this.reloadAll()))
    } catch (error) {
      const view = toErrorView(error)
      this.patch({ realtimeError: `实时事件监听建立失败: ${view.title}` })
    }

    void this.reloadAll()
  }

  resubscribe(): void {
    if (this.disposed || !this.api) return
    try {
      this.api.resubscribe()
    } catch {
      // 失败由底层处理
    }
    void this.reloadAll()
  }

  /** 静默刷新所有后台状态。 */
  async reloadAll(): Promise<void> {
    if (this.disposed || !this.api) return
    await Promise.all([
      this.loadAiStatus(),
      this.loadFeishuStatus(),
      this.loadReplyConfig(),
      this.loadAutoReplyStatus(),
    ])
  }

  // ==================== 1. AI 模型配置（专用命令） ====================

  /** 读取 AI 配置状态（专用命令 AI_CONFIG_STATUS）。 */
  async loadAiStatus(): Promise<void> {
    const api = this.api
    if (this.disposed || !api) return

    try {
      const status: AiConfigStatus = await api.call(CommandTypes.AI_CONFIG_STATUS, {})
      if (this.disposed) return
      this.patch({
        ai: {
          ...this.state.ai,
          configured: status.configured,
          provider: status.provider,
          model: status.model,
          timeoutMs: status.timeoutMs,
          permissionOrigin: status.permissionOrigin ?? null,
        },
      })
    } catch {
      // 忽略只读查询失败
    }
  }

  /** 保存用户手动输入的 AI 配置（调用专用命令 AI_CONFIG_SET，支持 PATCH 语义）。 */
  async saveAiConfig(input: AiConfigInput): Promise<boolean> {
    const api = this.api
    if (this.disposed || !api || this.state.ai.savePhase === 'running') return false

    const hasNewKey = typeof input.apiKey === 'string' && input.apiKey.trim().length > 0
    const alreadyConfigured = this.state.ai.configured

    // 首次配置必须填写 API Key；已配置过则允许仅修改模型/Base URL/超时而不必每次重填密钥
    if (!alreadyConfigured && !hasNewKey) {
      this.patch({
        ai: {
          ...this.state.ai,
          savePhase: 'failed',
          saveError: '请填写 API Key',
          saveSuccess: null,
        },
      })
      return false
    }

    // 若提供了 Base URL，进行严格安全校验：允许 HTTP/HTTPS，禁止带用户名/密码认证信息、查询参数、片段或非标准/空域名
    if (typeof input.baseUrl === 'string' && input.baseUrl.trim().length > 0) {
      const originCheck = extractSafeAiOrigin(input.baseUrl)
      if (!originCheck.ok) {
        this.patch({
          ai: {
            ...this.state.ai,
            savePhase: 'failed',
            saveError: originCheck.error ?? '输入的 API Base URL 格式无效',
            saveSuccess: null,
          },
        })
        return false
      }
    }

    const payload: AiConfigSetPayload = {}
    if (hasNewKey) {
      payload.apiKey = input.apiKey!.trim()
    }
    if (typeof input.baseUrl === 'string' && input.baseUrl.trim().length > 0) {
      payload.baseUrl = input.baseUrl.trim()
    }
    if (typeof input.model === 'string' && input.model.trim().length > 0) {
      payload.model = input.model.trim()
    }
    if (typeof input.timeoutMs === 'number' && input.timeoutMs > 0) {
      payload.timeoutMs = input.timeoutMs
    }

    this.patch({
      ai: {
        ...this.state.ai,
        savePhase: 'running',
        saveError: null,
        saveSuccess: null,
      },
    })

    try {
      const status: AiConfigStatus = await api.call(CommandTypes.AI_CONFIG_SET, payload)

      if (this.disposed) return false

      this.patch({
        ai: {
          ...this.state.ai,
          configured: status.configured,
          provider: status.provider,
          model: status.model,
          timeoutMs: status.timeoutMs,
          permissionOrigin: status.permissionOrigin ?? null,
          savePhase: 'ok',
          saveError: null,
          saveSuccess: 'AI 配置已成功保存至扩展安全存储',
          testError: null,
          testErrorView: null,
          testSuccess: null,
        },
      })

      // 刷新后台回复状态
      await this.loadAutoReplyStatus()
      return true
    } catch (error) {
      if (this.disposed) return false
      const view = toErrorView(error)
      this.patch({
        ai: {
          ...this.state.ai,
          savePhase: 'failed',
          saveError: view.hint ? `${view.title}：${view.hint}` : view.title,
          saveSuccess: null,
        },
      })
      return false
    }
  }

  /**
   * 测试 AI 模型接口真实连通性（调用 AI_CONFIG_TEST 命令，空 payload，真实探测已保存配置）。
   *
   * 规范与约束：
   * 1. 探测前校验：后台未保存配置时拦截并提示先保存；表单有未保存改动时拦截并提示先保存；
   * 2. 授权拦截：测试按钮不绕过授权，若当前域名尚未获得授权则拦截并提示；
   * 3. 严格防重复点击与 loading 状态管理；
   * 4. 成功时仅展示模型名称、耗时及响应字符数，绝不展示探测文本、API key、完整 URL 或响应 body；
   * 5. 失败时转换为结构化 ErrorView，展示针对性权限/HTTP/认证可行动建议。
   */
  async testAiConnection(options?: AiTestOptions): Promise<boolean> {
    const api = this.api
    if (this.disposed || !api || this.state.ai.testPhase === 'running') return false

    // 1. 未保存配置拦截：若后台未保存配置，提示先保存
    if (!this.state.ai.configured) {
      const view: ErrorView = {
        title: '未检测到已保存的 AI 配置',
        hint: '请先填写并保存 AI 配置后再进行接口测试。',
        detail: '当前尚未在扩展中保存有效的 AI 配置。',
        kind: 'validation',
        code: 'CONFIG_MISSING',
      }
      this.patch({
        ai: {
          ...this.state.ai,
          testPhase: 'failed',
          testError: `${view.title}：${view.hint}`,
          testErrorView: view,
          testSuccess: null,
        },
      })
      return false
    }

    // 2. 表单有未保存修改拦截：提示先保存
    if (options?.isDirty) {
      const view: ErrorView = {
        title: '检测到未保存的配置修改',
        hint: '测试接口仅探测后台已保存的真实配置，请先点击「保存 AI 配置」后再进行测试。',
        detail: '表单存在未保存的修改，为避免测试与预期不符，请先保存配置。',
        kind: 'validation',
        code: 'UNSAVED_CHANGES',
      }
      this.patch({
        ai: {
          ...this.state.ai,
          testPhase: 'failed',
          testError: `${view.title}：${view.hint}`,
          testErrorView: view,
          testSuccess: null,
        },
      })
      return false
    }

    // 3. 授权拦截：测试按钮不绕过授权
    if (options?.originGranted === false) {
      const view: ErrorView = {
        title: '当前 AI 接口域名尚未获得授权',
        hint: options.origin
          ? `请先点击上方的「授权当前AI接口域名」按钮，授权 ${options.origin} 后再进行测试。`
          : '请先点击上方的「授权当前AI接口域名」按钮完成浏览器权限授权后再进行测试。',
        detail: '测试按钮不绕过权限授权，需先显式授予该 Origin 访问权限。',
        kind: 'auth',
        code: 'AI_PERMISSION_REQUIRED',
      }
      this.patch({
        ai: {
          ...this.state.ai,
          testPhase: 'failed',
          testError: `${view.title}：${view.hint}`,
          testErrorView: view,
          testSuccess: null,
        },
      })
      return false
    }

    this.patch({
      ai: {
        ...this.state.ai,
        testPhase: 'running',
        testError: null,
        testErrorView: null,
        testSuccess: null,
      },
    })

    const startedAt = this.now()

    try {
      // 传递空 payload {}，后台探测当前已保存配置
      const res: any = await api.call(AI_CONFIG_TEST_COMMAND as any, {})
      if (this.disposed) return false

      // 1. 结构合法性校验：必须为非 null 对象且 ok 属性必须为布尔值
      if (!res || typeof res !== 'object' || typeof res.ok !== 'boolean') {
        const view: ErrorView = {
          title: 'AI 接口测试失败：响应结构非法',
          hint: '扩展后台返回了非预期的测试响应，请检查扩展后台状态。',
          detail: '响应缺少布尔值 ok 字段或返回非对象结构。',
          kind: 'validation',
          code: 'MALFORMED_RESPONSE',
        }
        this.patch({
          ai: {
            ...this.state.ai,
            testPhase: 'failed',
            testError: `${view.title}：${view.hint}`,
            testErrorView: view,
            testSuccess: null,
          },
        })
        return false
      }

      // 2. 显式判断业务失败 res.ok === false
      if (res.ok === false) {
        const errObj = res.error && typeof res.error === 'object' ? res.error : { message: 'AI 接口探测失败' }
        const view = formatAiTestError(errObj, {
          isHttp: options?.isHttp,
          originGranted: options?.originGranted,
          origin: options?.origin,
        })
        this.patch({
          ai: {
            ...this.state.ai,
            testPhase: 'failed',
            testError: view.hint ? `${view.title}：${view.hint}` : view.title,
            testErrorView: view,
            testSuccess: null,
          },
        })
        return false
      }

      // 3. 成功只接受 res.ok === true
      const elapsed = Math.max(1, this.now() - startedAt)
      const duration =
        typeof res.durationMs === 'number'
          ? res.durationMs
          : typeof res.elapsedMs === 'number'
            ? res.elapsedMs
            : typeof res.latencyMs === 'number'
              ? res.latencyMs
              : elapsed
      const model = res.model || this.state.ai.model || '已配置模型'
      const count =
        typeof res.charactersCount === 'number'
          ? res.charactersCount
          : typeof res.characterCount === 'number'
            ? res.characterCount
            : typeof res.charCount === 'number'
              ? res.charCount
              : typeof res.responseLength === 'number'
                ? res.responseLength
                : typeof res.contentLength === 'number'
                  ? res.contentLength
                  : (typeof res.content === 'string' ? res.content.length : 0)

      this.patch({
        ai: {
          ...this.state.ai,
          testPhase: 'ok',
          testError: null,
          testErrorView: null,
          testSuccess: `AI 接口测试成功！模型：${model}，耗时：${duration}ms，响应字符数：${count}`,
        },
      })
      return true
    } catch (error) {
      if (this.disposed) return false
      const view = formatAiTestError(error, {
        isHttp: options?.isHttp,
        originGranted: options?.originGranted,
        origin: options?.origin,
      })
      this.patch({
        ai: {
          ...this.state.ai,
          testPhase: 'failed',
          testError: view.hint ? `${view.title}：${view.hint}` : view.title,
          testErrorView: view,
          testSuccess: null,
        },
      })
      return false
    }
  }

  // ==================== 2. 飞书多维表格配置（专用命令） ====================

  /** 读取飞书配置状态（专用命令 FEISHU_CONFIG_STATUS）。 */
  async loadFeishuStatus(): Promise<void> {
    const api = this.api
    if (this.disposed || !api) return

    try {
      const status: FeishuConfigStatus = await api.call(CommandTypes.FEISHU_CONFIG_STATUS, {})
      if (this.disposed) return
      this.patch({
        feishu: {
          ...this.state.feishu,
          configured: status.configured,
          hasAppId: status.hasAppId,
          hasAppSecret: status.hasAppSecret,
          hasSpreadsheetToken: status.hasSpreadsheetToken,
          hasProductTableId: status.hasProductTableId,
          hasSellerTableId: status.hasSellerTableId,
        },
      })
    } catch {
      // 忽略只读查询失败
    }
  }

  /** 保存用户手动输入的飞书配置（调用专用命令 FEISHU_CONFIG_SET，支持 PATCH 语义）。 */
  async saveFeishuConfig(input: FeishuConfigInput): Promise<boolean> {
    const api = this.api
    if (this.disposed || !api || this.state.feishu.savePhase === 'running') return false

    const current = this.state.feishu
    const appId = input.appId?.trim()
    const appSecret = input.appSecret?.trim()
    const spreadsheetToken = input.spreadsheetToken?.trim()
    const productTableId = input.productTableId?.trim()
    const sellerTableId = input.sellerTableId?.trim()

    // 校验完整性：如当前未配置，必需字段缺一不可
    const willHaveAppId = Boolean(appId || current.hasAppId)
    const willHaveSecret = Boolean(appSecret || current.hasAppSecret)
    const willHaveToken = Boolean(spreadsheetToken || current.hasSpreadsheetToken)

    if (!willHaveAppId || !willHaveSecret || !willHaveToken) {
      this.patch({
        feishu: {
          ...this.state.feishu,
          savePhase: 'failed',
          saveError: '请完整填写 App ID、App Secret 和 Spreadsheet Token',
          saveSuccess: null,
        },
      })
      return false
    }

    const payload: FeishuConfigSetPayload = {}
    if (appId) payload.appId = appId
    if (appSecret) payload.appSecret = appSecret
    if (spreadsheetToken) payload.spreadsheetToken = spreadsheetToken
    if (productTableId) payload.productTableId = productTableId
    if (sellerTableId) payload.sellerTableId = sellerTableId

    this.patch({
      feishu: {
        ...this.state.feishu,
        savePhase: 'running',
        saveError: null,
        saveSuccess: null,
      },
    })

    try {
      const status: FeishuConfigStatus = await api.call(CommandTypes.FEISHU_CONFIG_SET, payload)

      if (this.disposed) return false

      this.patch({
        feishu: {
          ...this.state.feishu,
          configured: status.configured,
          hasAppId: status.hasAppId,
          hasAppSecret: status.hasAppSecret,
          hasSpreadsheetToken: status.hasSpreadsheetToken,
          hasProductTableId: status.hasProductTableId,
          hasSellerTableId: status.hasSellerTableId,
          savePhase: 'ok',
          saveError: null,
          saveSuccess: '飞书配置已成功保存并同步至数据分析模块',
        },
      })

      // 飞书配置保存成功后广播目标变更通知（非敏感指纹，杜绝泄露 secret/token 明文）
      broadcastFeishuTargetChanged({
        appId: status.hasAppId ? appId : undefined,
        spreadsheetToken,
        productTableId,
      })

      return true
    } catch (error) {
      if (this.disposed) return false
      const view = toErrorView(error)
      this.patch({
        feishu: {
          ...this.state.feishu,
          savePhase: 'failed',
          saveError: view.hint ? `${view.title}：${view.hint}` : view.title,
          saveSuccess: null,
        },
      })
      return false
    }
  }

  /** 测试飞书多维表格真实连通性（调用 DATA_SOURCE_SCHEMA 命令）。 */
  async testFeishuConnection(): Promise<boolean> {
    const api = this.api
    if (this.disposed || !api || this.state.feishu.testPhase === 'running') return false

    this.patch({
      feishu: {
        ...this.state.feishu,
        testPhase: 'running',
        testError: null,
        testSuccess: null,
      },
    })

    try {
      const res = await api.call(CommandTypes.DATA_SOURCE_SCHEMA, { type: 'feishu' })
      if (this.disposed) return false

      const count = res.schema?.fields?.length ?? 0
      this.patch({
        feishu: {
          ...this.state.feishu,
          configured: true,
          fieldsCount: count,
          testPhase: 'ok',
          testError: null,
          testSuccess: `连接成功！已获取到多维表格结构（共 ${count} 个字段）`,
        },
      })
      return true
    } catch (error) {
      if (this.disposed) return false
      const view = toErrorView(error)
      this.patch({
        feishu: {
          ...this.state.feishu,
          testPhase: 'failed',
          testError: `飞书连接测试失败: ${view.detail || view.title}`,
          testSuccess: null,
        },
      })
      return false
    }
  }

  // ==================== 3. 回复策略与 AI 暂停 ====================

  /** 加载回复全局配置和规则数。 */
  async loadReplyConfig(): Promise<void> {
    const api = this.api
    if (this.disposed || !api) return

    this.patch({
      reply: {
        ...this.state.reply,
        loadPhase: this.state.reply.global ? 'ready' : 'loading',
      },
    })

    try {
      const [rulesRes, statusRes] = await Promise.all([
        api.call(CommandTypes.CHAT_RULES_GET, {}),
        api.call(CommandTypes.CHAT_AUTO_REPLY_STATUS, {}),
      ])

      if (this.disposed) return

      this.patch({
        reply: {
          ...this.state.reply,
          loadPhase: 'ready',
          loadError: null,
          global: rulesRes.global,
          status: statusRes,
          rulesCount: rulesRes.rules.length,
        },
        ai: {
          ...this.state.ai,
          configured: statusRes.aiConfigured || this.state.ai.configured,
        },
      })
    } catch (error) {
      if (this.disposed) return
      const view = toErrorView(error)
      this.patch({
        reply: {
          ...this.state.reply,
          loadPhase: 'error',
          loadError: view.title,
        },
      })
    }
  }

  /** 查询自动回复引擎状态（包含 AI 是否配置、暂停状态等）。 */
  async loadAutoReplyStatus(): Promise<void> {
    const api = this.api
    if (this.disposed || !api) return

    try {
      const status = await api.call(CommandTypes.CHAT_AUTO_REPLY_STATUS, {})
      if (this.disposed) return

      this.patch({
        reply: {
          ...this.state.reply,
          status,
        },
        ai: {
          ...this.state.ai,
          configured: status.aiConfigured || this.state.ai.configured,
        },
      })
    } catch {
      // 忽略
    }
  }

  /** 保存回复全局策略配置。如切换到 auto 或在 auto 下启用，需 confirmedAuto 为 true。 */
  async saveReplyStrategy(
    patch: Partial<ReplyGlobalConfig>,
    confirmedAuto = false,
  ): Promise<{ ok: boolean; needsAutoConfirm?: boolean; error?: string }> {
    const api = this.api
    if (this.disposed || !api || this.state.reply.savePhase === 'running') {
      return { ok: false }
    }

    const current = this.state.reply.global ?? DEFAULT_REPLY_GLOBAL_CONFIG
    const nextMode = patch.mode ?? current.mode
    const nextEnabled = patch.enabled ?? current.enabled

    // 安全闸：开启自动模式必须经过二次确认
    const willBeAuto = nextMode === 'auto'
    const switchingOnAuto = nextEnabled && willBeAuto
    if ((willBeAuto || switchingOnAuto) && !confirmedAuto) {
      return { ok: false, needsAutoConfirm: true }
    }

    this.patch({
      reply: {
        ...this.state.reply,
        savePhase: 'running',
        saveError: null,
        saveSuccess: null,
      },
    })

    try {
      const res = await api.call(CommandTypes.CHAT_RULES_SET, { global: patch })
      if (this.disposed) return { ok: false }

      this.patch({
        reply: {
          ...this.state.reply,
          global: res.global,
          savePhase: 'ok',
          saveError: null,
          saveSuccess: '回复策略已成功更新',
        },
      })
      await this.loadAutoReplyStatus()
      return { ok: true }
    } catch (error) {
      if (this.disposed) return { ok: false }
      const view = toErrorView(error)
      const errorMsg = view.hint ? `${view.title}: ${view.hint}` : view.title
      this.patch({
        reply: {
          ...this.state.reply,
          savePhase: 'failed',
          saveError: errorMsg,
          saveSuccess: null,
        },
      })
      return { ok: false, error: errorMsg }
    }
  }

  /** 手动控制 AI 暂停状态（暂停 / 恢复）。 */
  async setAiPause(paused: boolean, durationMs = 10 * 60 * 1000): Promise<boolean> {
    const api = this.api
    if (this.disposed || !api || this.state.reply.pausePhase === 'running') return false

    this.patch({
      reply: {
        ...this.state.reply,
        pausePhase: 'running',
        pauseError: null,
      },
    })

    try {
      await api.call(CommandTypes.CHAT_AI_PAUSE_SET, {
        paused,
        ...(paused ? { durationMs, reason: 'manual' } : {}),
      })
      if (this.disposed) return false

      this.patch({
        reply: {
          ...this.state.reply,
          pausePhase: 'ok',
          pauseError: null,
        },
      })
      await this.loadAutoReplyStatus()
      return true
    } catch (error) {
      if (this.disposed) return false
      const view = toErrorView(error)
      this.patch({
        reply: {
          ...this.state.reply,
          pausePhase: 'failed',
          pauseError: view.title,
        },
      })
      return false
    }
  }

  // ==================== 4. 后台能力检查（Capability） ====================

  /** 执行后台模块完整体检。 */
  async runCapabilityChecks(): Promise<void> {
    const api = this.api
    if (this.disposed || !api || this.state.capability.running) return

    const token = ++this.runCapSeq
    this.patch({
      capability: {
        running: true,
        items: this.state.capability.items.map((item) => ({
          ...item,
          phase: 'checking',
          summary: '检测中',
          detail: '',
        })),
      },
    })

    await Promise.all(
      CAPABILITY_CHECKS.map(async (check) => {
        let update: Partial<CapabilityItem>
        try {
          const outcome = await check.run(api, this.now)
          update = { phase: outcome.phase, summary: outcome.summary, detail: outcome.detail ?? '' }
        } catch (error) {
          const view = toErrorView(error)
          update = { phase: 'error', summary: view.title, detail: view.hint ? `${view.hint}` : view.detail }
        }

        if (this.disposed || token !== this.runCapSeq) return

        this.patch({
          capability: {
            ...this.state.capability,
            items: this.state.capability.items.map((item) =>
              item.id === check.id ? { ...item, ...update, checkedAt: this.now() } : item,
            ),
          },
        })
      }),
    )

    if (this.disposed || token !== this.runCapSeq) return
    this.patch({
      capability: {
        ...this.state.capability,
        running: false,
      },
    })
  }

  clearAlerts(): void {
    this.patch({
      ai: {
        ...this.state.ai,
        saveError: null,
        saveSuccess: null,
        testError: null,
        testErrorView: null,
        testSuccess: null,
      },
      feishu: {
        ...this.state.feishu,
        saveError: null,
        saveSuccess: null,
        testError: null,
        testSuccess: null,
      },
      reply: {
        ...this.state.reply,
        saveError: null,
        saveSuccess: null,
        pauseError: null,
      },
      realtimeError: null,
    })
  }
}
