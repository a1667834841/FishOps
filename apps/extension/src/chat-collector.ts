import { isChatMessage, type ChatMessage } from '../../../packages/protocol/src/chat.ts'
import { isGapOccurrence, type GapOccurrence } from '../../../packages/protocol/src/chat-gap.ts'
import { MAX_PAGE_GAP_OCCURRENCES } from './page-chat.ts'

/** 固定文档适配器负责校验账号、tab 和 documentId，不能自动切换执行页。 */
export interface ChatPageSource {
  peek(): Promise<{ messages: ChatMessage[]; syncRequired: boolean; occurrences?: GapOccurrence[] }>
  acknowledge(sourceIds: string[]): Promise<void>
}
export interface ChatCollectorDeps {
  source: ChatPageSource
  persist(message: ChatMessage): Promise<void>
  gap(occurrence?: GapOccurrence): Promise<void>
}

/** 页面队列只在扩展持久保存成功后确认；失败保留未确认消息，允许下一次去重恢复。 */
export function createChatCollector(deps: ChatCollectorDeps) {
  let active: Promise<number> | null = null
  async function collect(): Promise<number> {
    const batch = await deps.source.peek()
    if (!Array.isArray(batch.messages) || batch.messages.length > 100 || typeof batch.syncRequired !== 'boolean' || !batch.messages.every(isChatMessage)) throw new Error('CHAT_PAGE_INVALID')
    if (batch.occurrences !== undefined && (!Array.isArray(batch.occurrences) || batch.occurrences.length > MAX_PAGE_GAP_OCCURRENCES || !batch.occurrences.every(isGapOccurrence))) throw new Error('CHAT_PAGE_INVALID')
    let gapFailure: unknown
    let gapFailed = false
    if (batch.syncRequired) {
      try {
        if (batch.occurrences?.length) for (const occurrence of batch.occurrences) await deps.gap(structuredClone(occurrence))
        else await deps.gap()
      } catch (error) {
        // 缺口仍由页面保留；元数据耗尽不能阻止正常消息持久化并让页面队列继续溢出。
        gapFailed = true
        gapFailure = error
      }
    }
    let saved = 0
    for (const message of batch.messages) {
      await deps.persist(structuredClone(message))
      await deps.source.acknowledge([message.sourceId])
      saved++
    }
    if (gapFailed) throw gapFailure
    return saved
  }
  return {
    /** 合并并发采集，避免两个消费者同时确认同一页面批次。 */
    collect(): Promise<number> {
      if (active) return active
      active = collect().finally(() => { active = null })
      return active
    },
  }
}
