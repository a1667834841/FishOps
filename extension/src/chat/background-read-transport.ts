/** Background 到 MAIN world 的独立会话已读写 transport。 */
import { isRecord, type LwpResponse } from '../../../shared/chat/index'
import type { ChatReadTransport } from './read-transport'

export interface ChatReadScriptExecutor {
  markRead(sessionId: string, messageId: string): Promise<unknown>
}

export function createBackgroundChatReadTransport(executor: ChatReadScriptExecutor): ChatReadTransport {
  return {
    async markRead(sessionId, messageId): Promise<LwpResponse> {
      const raw = await executor.markRead(sessionId, messageId)
      if (isRecord(raw) && raw['ok'] === true && isRecord(raw['response'])) return raw['response'] as LwpResponse
      if (isRecord(raw) && raw['ok'] === false && isRecord(raw['error'])) {
        const message = typeof raw['error']['message'] === 'string' ? raw['error']['message'] : '页面已读 transport 失败'
        throw new Error(message)
      }
      throw new Error('页面已读 transport 返回非法结果')
    },
  }
}

export interface ChatReadScriptingApi {
  executeScript(injection: {
    target: { tabId: number }
    world: 'MAIN'
    args: [string, string]
    func: (sessionId: string, messageId: string) => Promise<unknown>
  }): Promise<Array<{ result?: unknown }>>
}

export function createChromeChatReadExecutor(
  scripting: ChatReadScriptingApi,
  resolveTabId: () => Promise<number | null>,
): ChatReadScriptExecutor {
  return {
    async markRead(sessionId, messageId) {
      const tabId = await resolveTabId()
      if (tabId === null) throw new Error('未找到闲鱼标签页')
      const results = await scripting.executeScript({
        target: { tabId }, world: 'MAIN', args: [sessionId, messageId], func: invokeChatReadInPage,
      })
      return results[0]?.result
    },
  }
}

/** 注入函数必须可独立序列化，不引用模块外变量。 */
export function invokeChatReadInPage(sessionId: string, messageId: string): Promise<unknown> {
  const host = (globalThis as { __FISHOPS_CHAT_TRANSPORT__?: { markRead?: (sid: unknown, mid: unknown) => Promise<unknown> } }).__FISHOPS_CHAT_TRANSPORT__
  if (!host || typeof host.markRead !== 'function') {
    return Promise.resolve({ ok: false, error: { code: 'NO_TRANSPORT', message: '页面未安装已读 transport' } })
  }
  return Promise.resolve(host.markRead(sessionId, messageId))
}
