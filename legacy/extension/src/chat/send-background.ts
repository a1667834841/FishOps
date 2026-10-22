/**
 * background 侧发送 transport（P6）。
 *
 * background 无法直接访问页面 MAIN world 的 WebSocket，因此通过
 * `chrome.scripting.executeScript({ world: 'MAIN' })` 调用页面上的
 * `window.__FISHOPS_CHAT_SEND__.send(request, timeoutMs)`（由 `send-host.ts` 安装）。
 *
 * 安全：
 * - 发送前再次用发送白名单校验信封（与 MAIN world 双重保险）；
 * - 只传 `lwp / headers / body`，绝不透传任意 payload；
 * - **不修改 P5 只读 transport / 其白名单**，本模块是独立发送通道。
 *
 * 通过 {@link SendScriptExecutor} 抽象 `chrome.scripting`，便于 Node 中用 mock 测试。
 */
import { isRecord, type LwpRequest, type LwpResponse } from '../../../shared/chat/index'
import { SEND_TIMEOUT_MS } from '../../../shared/types/reply'
import { validateSendLwpRequest } from './send-protocol'
import { ChatSendTransportError, type ChatSendTransport, type ChatSendTransportErrorCode } from './send-transport'

/** 执行一次 MAIN world 发送调用。 */
export interface SendScriptExecutor {
  execute(tabId: number, request: LwpRequest, timeoutMs: number): Promise<unknown>
}

export interface BackgroundSendTransportDeps {
  executor: SendScriptExecutor
  /** 解析目标 goofish tab id；返回 null 表示无可用 tab。 */
  resolveTabId: () => Promise<number | null>
}

/**
 * 创建 background 侧发送 transport。
 * 校验失败 / 无 tab / 页面未安装 host / 超时都以结构化错误 reject。
 */
export function createBackgroundSendTransport(deps: BackgroundSendTransportDeps): ChatSendTransport {
  return {
    async send(request: LwpRequest, options: { timeoutMs?: number } = {}): Promise<LwpResponse> {
      const invalid = validateSendLwpRequest(request)
      if (invalid) throw new ChatSendTransportError(invalid.code, invalid.message)

      const tabId = await deps.resolveTabId()
      if (tabId === null) {
        throw new ChatSendTransportError('NO_SOCKET', '未找到闲鱼标签页，请先打开 goofish.com 页面')
      }

      const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS
      let raw: unknown
      try {
        raw = await deps.executor.execute(tabId, request, timeoutMs)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new ChatSendTransportError('NO_SOCKET', `MAIN world 发送调用失败: ${message}`)
      }

      if (isRecord(raw) && raw['ok'] === true && isRecord(raw['response'])) {
        return raw['response'] as LwpResponse
      }
      if (isRecord(raw) && raw['ok'] === false && isRecord(raw['error'])) {
        const error = raw['error'] as Record<string, unknown>
        const code = (typeof error['code'] === 'string' ? error['code'] : 'SEND_FAILED') as ChatSendTransportErrorCode
        const message = typeof error['message'] === 'string' ? error['message'] : '页面发送 host 返回失败'
        throw new ChatSendTransportError(code, message)
      }
      // 兼容：MAIN world 直接返回了 LwpResponse（无包装）。
      if (isRecord(raw) && 'code' in raw) return raw as LwpResponse
      throw new ChatSendTransportError('SEND_FAILED', '页面发送 host 返回了非法结果')
    },
  }
}

/** `chrome.scripting` 的最小子集（与 platform 层保持结构一致，避免跨模块依赖）。 */
export interface SendScriptingApi {
  executeScript(injection: {
    target: { tabId: number }
    world: 'MAIN'
    args: [LwpRequest, number]
    func: (request: LwpRequest, timeoutMs: number) => unknown
  }): Promise<Array<{ result?: unknown }>>
}

/**
 * 在目标 tab 的 MAIN world 执行一次发送调用。
 *
 * 注意：该函数会被序列化后注入页面，**不得引用模块外的任何变量**（host 键名与
 * `CHAT_SEND_HOST_KEY` 一致，此处用字面量以保证可序列化）。
 */
export function invokeSendInPage(request: LwpRequest, timeoutMs: number): Promise<unknown> {
  const globalObject = globalThis as {
    __FISHOPS_CHAT_SEND__?: { send?: (req: unknown, timeout: number) => Promise<unknown> }
  }
  const host = globalObject.__FISHOPS_CHAT_SEND__
  if (!host || typeof host.send !== 'function') {
    return Promise.resolve({ ok: false, error: { code: 'NO_SOCKET', message: '页面未安装 FishOps 发送 host' } })
  }
  return Promise.resolve(host.send(request, timeoutMs))
}

/** 基于 `chrome.scripting.executeScript` 的发送执行器。 */
export function createChromeSendExecutor(scripting: SendScriptingApi): SendScriptExecutor {
  return {
    async execute(tabId: number, request: LwpRequest, timeoutMs: number): Promise<unknown> {
      const results = await scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [request, timeoutMs],
        func: invokeSendInPage,
      })
      return results[0]?.result
    },
  }
}
