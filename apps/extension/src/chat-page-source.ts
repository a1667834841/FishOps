import { isChatMessage, type ChatMessage } from '../../../packages/protocol/src/chat.ts'
import { isGapOccurrence } from '../../../packages/protocol/src/chat-gap.ts'
import type { StepContext } from '../../../packages/protocol/src/step.ts'
import type { ChatPageSource } from './chat-collector.ts'
import type { PageBootstrapScripting } from './page-bootstrap.ts'
import { ApiError } from './errors.ts'
import { MAX_PAGE_GAP_OCCURRENCES } from './page-chat.ts'

/** 固定文档聊天来源依赖；只调用已有队列，不负责注入或创建页面运行时。 */
export type ChatPageSourceDeps = {
  context: { verify(expected: StepContext): Promise<StepContext> }
  scripting: PageBootstrapScripting
}
const unavailable = () => new ApiError('PAGE_NOT_READY', '页面聊天来源不可用', { phase: 'read', retryable: false })
const changed = () => new ApiError('ACCOUNT_CHANGED', '执行账号已变化', { phase: 'read', retryable: false })

/** 创建固定账号及文档的 peek/ack 适配；ack 仅由下游持久化成功后显式调用。 */
export function createChatPageSource(deps: ChatPageSourceDeps, expected: StepContext): ChatPageSource {
  const bound = Object.freeze({ ...expected })
  async function verify(): Promise<void> {
    const actual = await deps.context.verify({ ...bound })
    if (actual.accountId !== bound.accountId) throw changed()
    if (actual.tabId !== bound.tabId || actual.documentId !== bound.documentId) throw unavailable()
  }
  async function invoke(op: 'peek' | 'ack', ids: string[] = []): Promise<unknown> {
    try {
      if (typeof bound.accountId !== 'string' || !bound.accountId.trim() || !Number.isSafeInteger(bound.tabId) || bound.tabId < 0 || typeof bound.documentId !== 'string' || !bound.documentId) throw unavailable()
      await verify()
      // Chrome 仅序列化函数本身；不得引用模块变量、导入或外部闭包。
      const call = function (input: { op: 'peek' | 'ack'; accountId: string; ids: string[] }): unknown {
        const page = (window as unknown as { __fishopsPageChatV1__?: {
          peek(account: string, limit: number): unknown
          status(): { syncRequired: unknown }
          ack(account: string, ids: string[]): unknown
          gapOccurrences?(account: string): unknown
          requiresSync?(account: string): boolean
        } }).__fishopsPageChatV1__
        if (!page) return null
        if (input.op === 'ack') return page.ack(input.accountId, input.ids)
        return { messages: page.peek(input.accountId, 100), syncRequired: page.requiresSync ? page.requiresSync(input.accountId) : page.status().syncRequired,
          ...(page.gapOccurrences ? { occurrences: page.gapOccurrences(input.accountId) } : {}) }
      }
      const results = await deps.scripting.executeScript({
        target: { tabId: bound.tabId, documentIds: [bound.documentId] }, world: 'MAIN',
        func: call as unknown as (...args: unknown[]) => unknown,
        args: [{ op, accountId: bound.accountId, ids }],
      })
      await verify()
      if (!Array.isArray(results) || results.length !== 1 || results[0]?.documentId !== bound.documentId) throw unavailable()
      return results[0].result
    } catch (error) {
      if (error instanceof ApiError && error.code === 'ACCOUNT_CHANGED') throw changed()
      throw unavailable()
    }
  }
  return {
    async peek() {
      const result = await invoke('peek')
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw unavailable()
      const value = result as Record<string, unknown>
      if (Object.keys(value).some(key => !['messages', 'syncRequired', 'occurrences'].includes(key)) || !Object.hasOwn(value, 'messages') || !Object.hasOwn(value, 'syncRequired') ||
        typeof value.syncRequired !== 'boolean' || !Array.isArray(value.messages) || value.messages.length > 100 || !value.messages.every(isChatMessage)) throw unavailable()
      if (value.occurrences !== undefined && (!Array.isArray(value.occurrences) || value.occurrences.length > MAX_PAGE_GAP_OCCURRENCES ||
        !value.occurrences.every(item => isGapOccurrence(item) && item.accountId === bound.accountId && item.reason === 'PAGE_GAP'))) throw unavailable()
      return { messages: value.messages.map(message => ({ ...message } as ChatMessage)), syncRequired: value.syncRequired,
        ...(value.occurrences !== undefined ? { occurrences: structuredClone(value.occurrences) } : {}) }
    },
    async acknowledge(sourceIds) {
      if (!Array.isArray(sourceIds) || sourceIds.length > 100 || sourceIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128)) throw unavailable()
      const ids = [...sourceIds], result = await invoke('ack', ids)
      if (!Number.isSafeInteger(result) || Number(result) < 0 || Number(result) > ids.length) throw unavailable()
    },
  }
}
