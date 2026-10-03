/**
 * P6 AI 服务（OpenAI 兼容，background 内运行）。
 *
 * 迁移自 `chat` 分支 `background/ai-service.js` 的 `callChatCompletion`：
 * - API key 从**配置适配器**读取（本模块不持久化、不打日志、不进事件）；
 * - 支持超时 / 取消 / 非 2xx / 非法响应，全部归一为结构化错误，绝不抛错；
 * - 支持文本对话；视觉能力只保留接口（{@link AiChatService.analyzeImage}），本轮不调用真实网络。
 *
 * 通过注入 `fetchImpl` 与 `loadProvider` 可在 Node 中纯逻辑测试，不访问真实 AI API。
 */
import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_TIMEOUT_MS,
  type AiChatMessage,
  type AiProviderConfig,
} from '../../../shared/types/reply'

/** AI 错误码。 */
export type AiErrorCode =
  | 'NO_API_KEY'
  | 'INVALID_REQUEST'
  | 'TIMEOUT'
  | 'HTTP_ERROR'
  | 'INVALID_RESPONSE'
  | 'NETWORK'
  | 'UNSUPPORTED'

/** AI 调用成功。 */
export interface AiCompletionSuccess {
  ok: true
  content: string
  model: string
  usage?: unknown
}

/** AI 调用失败。 */
export interface AiCompletionFailure {
  ok: false
  error: { code: AiErrorCode; message: string; status?: number }
}

/** AI 调用结果。 */
export type AiCompletionResult = AiCompletionSuccess | AiCompletionFailure

/** `fetch` 响应的最小子集。 */
export interface AiHttpResponseLike {
  ok: boolean
  status: number
  statusText?: string
  json(): Promise<unknown>
}

/** `fetch` 请求参数的最小子集。 */
export interface AiFetchInitLike {
  method: string
  headers: Record<string, string>
  body: string
  signal?: unknown
}

/** 可注入的 fetch（结构上兼容全局 `fetch`）。 */
export type AiFetchLike = (url: string, init: AiFetchInitLike) => Promise<AiHttpResponseLike>

/** 计时器句柄。 */
type TimerHandle = ReturnType<typeof setTimeout>

/** AI 服务依赖。 */
export interface AiChatServiceDeps {
  /** 读取 AI 供应方配置（含凭据）；每次调用时读取，避免缓存凭据。 */
  loadProvider: () => Promise<AiProviderConfig>
  /** 注入 fetch（测试用）。缺省使用全局 fetch。 */
  fetchImpl?: AiFetchLike
  setTimer?: (fn: () => void, ms: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

/** 文本补全选项。 */
export interface AiCompleteOptions {
  /** 覆盖模型（不含凭据）。 */
  model?: string
  /** 覆盖超时（毫秒）。 */
  timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 按 provider 适配请求参数（thinking / 采样）。
 *
 * - DashScope / qwen3 / qwq：非流式需显式关闭 `enable_thinking`；
 * - DeepSeek reasoner（`deepseek-reasoner` / `deepseek-r1`）：不支持 `temperature`；
 * - 其它 OpenAI-compatible：保持默认采样。
 *
 * 返回值仅为非敏感参数与供应方标识，不含凭据。
 */
export interface ProviderRequestParams {
  /** 是否允许发送 `temperature`。 */
  supportsTemperature: boolean
  /** `false` 表示需显式关闭 thinking；`undefined` 表示不处理。 */
  enableThinking?: false
  /** 供应方标识（非敏感，诊断用）。 */
  provider: string
}

export function resolveProviderParams(baseUrl: string, model: string): ProviderRequestParams {
  const url = baseUrl.toLowerCase()
  const lowerModel = model.toLowerCase()
  if (url.includes('dashscope') || /qwen3|qwq/.test(lowerModel)) {
    return { supportsTemperature: true, enableThinking: false, provider: 'dashscope' }
  }
  if (/deepseek-(reasoner|r1)/.test(lowerModel)) {
    // 推理模型不支持采样参数。
    return { supportsTemperature: false, provider: 'deepseek' }
  }
  if (url.includes('deepseek')) return { supportsTemperature: true, provider: 'deepseek' }
  if (url.includes('openai.com')) return { supportsTemperature: true, provider: 'openai' }
  if (url.includes('anthropic')) return { supportsTemperature: true, provider: 'anthropic' }
  return { supportsTemperature: true, provider: 'custom' }
}

/** AI 聊天补全服务。 */
export class AiChatService {
  private readonly deps: AiChatServiceDeps
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle
  private readonly clearTimer: (handle: TimerHandle) => void

  constructor(deps: AiChatServiceDeps) {
    this.deps = deps
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle))
  }

  /** 文本对话补全。任何失败返回结构化结果，绝不抛错。 */
  async completeText(messages: AiChatMessage[], options: AiCompleteOptions = {}): Promise<AiCompletionResult> {
    if (!Array.isArray(messages) || messages.length === 0) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'messages 不能为空' } }
    }

    let provider: AiProviderConfig
    try {
      provider = await this.deps.loadProvider()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: { code: 'NETWORK', message: `读取 AI 配置失败: ${message}` } }
    }

    if (!provider.apiKey) {
      // 注意：不打印 key（此处也没有 key 可打印）。
      return { ok: false, error: { code: 'NO_API_KEY', message: 'AI API Key 未配置' } }
    }

    const baseUrl = (provider.baseUrl || DEFAULT_AI_BASE_URL).replace(/\/+$/, '')
    const model = options.model || provider.model || DEFAULT_AI_MODEL
    const timeoutMs = options.timeoutMs ?? provider.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS

    const requestBody: Record<string, unknown> = {
      model,
      messages,
      max_tokens: 500,
      stream: false,
    }
    const providerParams = resolveProviderParams(baseUrl, model)
    if (providerParams.supportsTemperature) requestBody['temperature'] = 0.7
    if (providerParams.enableThinking === false) requestBody['enable_thinking'] = false

    const controller = new AbortController()
    const timer = this.setTimer(() => controller.abort(), timeoutMs)

    const fetchImpl: AiFetchLike =
      this.deps.fetchImpl ?? ((url, init) => (globalThis.fetch as unknown as AiFetchLike)(url, init))

    try {
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${provider.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })
      this.clearTimer(timer)

      if (!response.ok) {
        // 尽力读取错误信息，但不回显请求体、不回显 key。
        let detail = response.statusText ?? ''
        try {
          const errorData: unknown = await response.json()
          if (isRecord(errorData) && isRecord(errorData['error']) && typeof errorData['error']['message'] === 'string') {
            detail = errorData['error']['message']
          }
        } catch {
          // 忽略：错误体不是 JSON。
        }
        return {
          ok: false,
          error: { code: 'HTTP_ERROR', message: `AI 接口错误 (${response.status})${detail ? `: ${detail}` : ''}`, status: response.status },
        }
      }

      const data: unknown = await response.json()
      const content = extractContent(data)
      if (content === null) {
        return { ok: false, error: { code: 'INVALID_RESPONSE', message: 'AI 返回结构非法或无有效回复' } }
      }
      return {
        ok: true,
        content,
        model: extractModel(data) ?? model,
        usage: isRecord(data) ? data['usage'] : undefined,
      }
    } catch (error) {
      this.clearTimer(timer)
      if (isAbortError(error)) {
        return { ok: false, error: { code: 'TIMEOUT', message: `AI 请求超时 (${timeoutMs}ms)` } }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: { code: 'NETWORK', message: `AI 网络异常: ${message}` } }
    }
  }

  /**
   * 视觉能力接口（保留，本轮不调用真实网络）。
   * 真实接入时应在配置中显式开启，并复用 {@link completeText} 的超时 / 错误归一逻辑。
   */
  async analyzeImage(_input: { imageUrl: string; prompt?: string }): Promise<AiCompletionFailure> {
    return { ok: false, error: { code: 'UNSUPPORTED', message: '视觉分析本轮未启用' } }
  }
}

/** 从响应中提取首个 choice 的文本内容；结构非法返回 null。 */
export function extractContent(data: unknown): string | null {
  if (!isRecord(data)) return null
  const choices = data['choices']
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  if (!isRecord(first) || !isRecord(first['message'])) return null
  const content = first['message']['content']
  if (typeof content !== 'string') return null
  const trimmed = content.trim()
  return trimmed.length === 0 ? null : trimmed
}

/** 从响应中提取 model 名；缺失返回 null。 */
export function extractModel(data: unknown): string | null {
  if (!isRecord(data)) return null
  const model = data['model']
  return typeof model === 'string' && model.length > 0 ? model : null
}

/** 是否为 abort（超时）错误。 */
function isAbortError(error: unknown): boolean {
  if (isRecord(error) && error['name'] === 'AbortError') return true
  return error instanceof Error && error.name === 'AbortError'
}
