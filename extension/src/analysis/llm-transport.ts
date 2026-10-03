/**
 * OpenAI 兼容 LLM 传输层抽象与实现（P7）。
 *
 * 1. 规范调用协议与结构化错误（超时、取消、HTTP 错误、非法响应）；
 * 2. 严禁日志输出 Authorization 头或完整 API Key；
 * 3. 支持超时与任务取消中断（AbortController）；
 * 4. 兼容 DashScope / 千问思考模型关闭 enable_thinking。
 */

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmCompletionRequest {
  messages: LlmMessage[]
  model?: string
  baseUrl?: string
  apiKey?: string
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export type LlmErrorCode =
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'HTTP_ERROR'
  | 'INVALID_JSON'
  | 'EMPTY_RESPONSE'
  | 'CONFIG_ERROR'
  | 'NETWORK_ERROR'

export interface LlmCompletionResult {
  success: boolean
  content?: string
  error?: string
  errorCode?: LlmErrorCode
  modelUsed?: string
  usage?: {
    promptTokens?: number
    completionTokens?: number
    totalTokens?: number
  }
}

export interface LlmTransport {
  complete(request: LlmCompletionRequest): Promise<LlmCompletionResult>
}

/** 默认的 OpenAI 兼容 HTTP 传输实现。 */
export class OpenAiCompatibleLlmTransport implements LlmTransport {
  private readonly defaultBaseUrl: string
  private readonly defaultModel: string
  private readonly defaultApiKey: string
  private readonly defaultTimeoutMs: number

  constructor(options: {
    baseUrl?: string
    model?: string
    apiKey?: string
    timeoutMs?: number
  } = {}) {
    this.defaultBaseUrl = (options.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')
    this.defaultModel = options.model || 'gpt-4o-mini'
    this.defaultApiKey = options.apiKey || ''
    this.defaultTimeoutMs = options.timeoutMs ?? 30000
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const apiKey = request.apiKey || this.defaultApiKey
    if (!apiKey) {
      return {
        success: false,
        errorCode: 'CONFIG_ERROR',
        error: '未配置 AI API Key，请在扩展配置中填入',
      }
    }

    if (!request.messages || request.messages.length === 0) {
      return {
        success: false,
        errorCode: 'CONFIG_ERROR',
        error: '调用入参 messages 不能为空',
      }
    }

    const baseUrl = (request.baseUrl || this.defaultBaseUrl).replace(/\/+$/, '')
    const model = request.model || this.defaultModel
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs
    const url = `${baseUrl}/chat/completions`

    // 构建请求体
    const requestBody: Record<string, unknown> = {
      model,
      messages: request.messages,
      temperature: request.temperature ?? 0.3,
      max_tokens: request.maxTokens ?? 2000,
      stream: false,
    }

    // 针对千问等思考模型显式关闭 thinking
    const isDashScope = baseUrl.includes('dashscope')
    const isThinkingModel = /qwen3|qwq/i.test(model)
    if (isDashScope || isThinkingModel) {
      requestBody['enable_thinking'] = false
    }

    // 超时与取消控制
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    // 关联外部取消 signal
    const onExternalAbort = () => controller.abort()
    if (request.signal) {
      if (request.signal.aborted) {
        clearTimeout(timer)
        return {
          success: false,
          errorCode: 'CANCELLED',
          error: '分析任务已取消',
        }
      }
      request.signal.addEventListener('abort', onExternalAbort)
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      })

      clearTimeout(timer)
      if (request.signal) {
        request.signal.removeEventListener('abort', onExternalAbort)
      }

      if (!response.ok) {
        let errDesc = response.statusText
        try {
          const errData = await response.json()
          if (errData && errData.error && errData.error.message) {
            errDesc = errData.error.message
          }
        } catch {
          // ignore json parse error on error body
        }
        return {
          success: false,
          errorCode: 'HTTP_ERROR',
          error: `AI 接口 HTTP 错误 (${response.status}): ${errDesc}`,
        }
      }

      const data = await response.json()
      const firstChoice = data.choices?.[0]
      const content = firstChoice?.message?.content

      if (!content || typeof content !== 'string') {
        return {
          success: false,
          errorCode: 'EMPTY_RESPONSE',
          error: 'AI 接口返回内容为空或无有效 choices',
        }
      }

      const usage = data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined

      return {
        success: true,
        content: content.trim(),
        modelUsed: data.model || model,
        usage,
      }
    } catch (err: unknown) {
      clearTimeout(timer)
      if (request.signal) {
        request.signal.removeEventListener('abort', onExternalAbort)
      }

      if (request.signal?.aborted) {
        return {
          success: false,
          errorCode: 'CANCELLED',
          error: '分析任务已被主动取消',
        }
      }

      if (timedOut || (err instanceof Error && err.name === 'AbortError')) {
        return {
          success: false,
          errorCode: 'TIMEOUT',
          error: `AI 请求超时 (${timeoutMs}ms)`,
        }
      }

      return {
        success: false,
        errorCode: 'NETWORK_ERROR',
        error: `AI 请求异常: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }
}
