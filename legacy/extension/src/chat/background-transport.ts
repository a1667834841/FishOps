/**
 * background 侧只读聊天 transport（P5）。
 *
 * background 无法直接访问页面 MAIN world 的 WebSocket，因此通过
 * `chrome.scripting.executeScript({ world: 'MAIN' })` 调用页面上的
 * `window.__FISHOPS_CHAT_TRANSPORT__.send(request, timeoutMs)`（由 `content/chat-main.ts` 挂载）。
 *
 * 安全：
 * - 发送前再次校验 LWP 路由白名单与信封结构（与 MAIN world 双重保险）；
 * - 只传 `lwp / headers / body`，绝不透传任意 payload；
 * - 不调用 P6 sender，不发送聊天消息。
 *
 * 通过 {@link ChatScriptExecutor} 抽象 `chrome.scripting`，便于 Node 中用 mock 测试。
 */
import { isRecord, LWP_REQUEST_TIMEOUT_MS, type LwpRequest, type LwpResponse } from '../../../shared/chat/index'
import type { ChatTransport } from './history'
import {
  ChatSocketTransportError,
  validateAllowedLwpRequest,
  type ChatSocketTransportErrorCode,
} from './socket-transport'

/** 执行一次 MAIN world transport 调用。 */
export interface ChatScriptExecutor {
  execute(tabId: number, request: LwpRequest, timeoutMs: number): Promise<unknown>
}

/** 错误 message 的安全上限：避免把页面/底层异常原文原样透传给 Workbench。 */
const TRANSPORT_ERROR_MESSAGE_MAX = 300

/** 截断并单行化错误 message（不携带请求体 / 凭据）。 */
function safeErrorMessage(message: string): string {
  const single = message.replace(/\s+/g, ' ').trim()
  return single.length > TRANSPORT_ERROR_MESSAGE_MAX ? `${single.slice(0, TRANSPORT_ERROR_MESSAGE_MAX)}…` : single
}

export interface BackgroundChatTransportDeps {
  executor: ChatScriptExecutor
  /** 解析目标 goofish tab id；返回 null 表示无可用 tab。 */
  resolveTabId: () => Promise<number | null>
}

/**
 * 创建 background 侧的只读 ChatTransport。
 * 校验失败 / 无 tab / 页面未安装 host / 超时都以结构化错误 reject。
 */
export function createBackgroundChatTransport(deps: BackgroundChatTransportDeps): ChatTransport {
  return {
    async send(request: LwpRequest, options: { timeoutMs?: number } = {}): Promise<LwpResponse> {
      const invalid = validateAllowedLwpRequest(request)
      if (invalid) throw invalid

      const tabId = await deps.resolveTabId()
      if (tabId === null) {
        throw new ChatSocketTransportError('NO_SOCKET', '未找到闲鱼标签页，请先打开 goofish.com 页面')
      }

      const timeoutMs = options.timeoutMs ?? LWP_REQUEST_TIMEOUT_MS
      let raw: unknown
      try {
        raw = await deps.executor.execute(tabId, request, timeoutMs)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new ChatSocketTransportError('NO_SOCKET', safeErrorMessage(`MAIN world 调用失败: ${message}`))
      }

      if (isRecord(raw) && raw['ok'] === true && isRecord(raw['response'])) {
        return raw['response'] as LwpResponse
      }
      if (isRecord(raw) && raw['ok'] === false && isRecord(raw['error'])) {
        const error = raw['error'] as Record<string, unknown>
        const code = (typeof error['code'] === 'string' ? error['code'] : 'SEND_FAILED') as ChatSocketTransportErrorCode
        const message = typeof error['message'] === 'string' ? error['message'] : '页面 transport 返回失败'
        // 仅透传结构化 code 与截断后的 message，绝不回传页面原始请求 / 响应体。
        throw new ChatSocketTransportError(code, safeErrorMessage(message))
      }
      // 兼容：MAIN world 直接返回了 LwpResponse（无包装）。
      if (isRecord(raw) && 'code' in raw) return raw as LwpResponse
      throw new ChatSocketTransportError('INVALID_REQUEST', '页面 transport 返回了非法结果')
    },
  }
}

/** `chrome.scripting` 的最小子集（与 platform 层保持结构一致，避免跨模块依赖）。 */
export interface ChatScriptingApi {
  executeScript(injection: {
    target: { tabId: number }
    world: 'MAIN'
    args: [LwpRequest, number]
    func: (request: LwpRequest, timeoutMs: number) => unknown
  }): Promise<Array<{ result?: unknown }>>
}

/**
 * 在目标 tab 的 MAIN world 执行一次 transport 调用。
 *
 * 注意：该函数会被序列化后注入页面，**不得引用模块外的任何变量**（host 键名与 P5 的
 * `CHAT_TRANSPORT_HOST_KEY` 一致，此处用字面量以保证可序列化）。
 */
export function invokeChatTransportInPage(request: LwpRequest, timeoutMs: number): Promise<unknown> {
  const globalObject = globalThis as {
    __FISHOPS_CHAT_TRANSPORT__?: { send?: (req: unknown, timeout: number) => Promise<unknown> }
  }
  const host = globalObject.__FISHOPS_CHAT_TRANSPORT__
  if (!host || typeof host.send !== 'function') {
    return Promise.resolve({ ok: false, error: { code: 'NO_SOCKET', message: '页面未安装 FishOps chat transport' } })
  }
  return Promise.resolve(host.send(request, timeoutMs))
}

/** 基于 `chrome.scripting.executeScript` 的聊天 transport 执行器。 */
export function createChromeChatExecutor(scripting: ChatScriptingApi): ChatScriptExecutor {
  return {
    async execute(tabId: number, request: LwpRequest, timeoutMs: number): Promise<unknown> {
      const results = await scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [request, timeoutMs],
        func: invokeChatTransportInPage,
      })
      return results[0]?.result
    },
  }
}
