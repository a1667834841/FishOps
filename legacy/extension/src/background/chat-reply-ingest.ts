/** 可信实时帧先入库，再按序处理新消息回复；两个队列隔离发送耗时与失败。 */
import { isChatSocketEventPayload, type ChatSocketEventPayload } from '@fishops/shared'
import type { ChatMessage } from '../../../shared/types/chat'
import { isTrustedChatContentSource, type ChatMessageSenderLike } from './chat-source'
import type { ChatRuntime } from './chat-runtime'

/** 后台接线依赖；测试可注入禁止真实外发的回复处理器。 */
export interface ChatReplyIngestDeps {
  extensionId: string
  /** 旧宿主缺少 connectedAt 时使用的后台启动时间；更早的补推仅入库。 */
  liveSince: number
  getChatRuntime: () => Promise<ChatRuntime>
  getReplyRuntime: () => Promise<{ handleIncomingMessage: (message: ChatMessage) => Promise<unknown> }>
  flushChatEvents: () => void
  flushReplyEvents: () => void
  onReplyError: () => void
}

/** 创建可信实时消息接线；handle 不等待发送，drainReplies 供验收等待队列收敛。 */
export function createChatReplyIngestor(deps: ChatReplyIngestDeps) {
  let chatChain = Promise.resolve()
  let replyChain = Promise.resolve()
  return {
    async handle(payload: unknown, sender: ChatMessageSenderLike): Promise<boolean> {
      if (!isTrustedChatContentSource(sender, deps.extensionId) || !isChatSocketEventPayload(payload)) return false
      const frame: ChatSocketEventPayload = payload
      const run = chatChain.then(async () => {
        const chat = await deps.getChatRuntime()
        const result = chat.ingestSocketEvent(frame)
        deps.flushChatEvents()
        for (const message of result?.newMessages ?? []) {
          // 缓存去重之外再拒绝连接前重放、无效时间及未来消息，跨 worker 唤醒保留宿主边界，避免冷启动自动回复历史。
          if (!Number.isFinite(message.createAt) || message.createAt < (frame.connectedAt ?? deps.liveSince) || message.createAt > frame.at) continue
          replyChain = replyChain.then(async () => {
            try {
              const reply = await deps.getReplyRuntime()
              await reply.handleIncomingMessage(message)
            } catch {
              // 不记录异常原文或聊天正文；单条失败不重试发送，不阻塞后续消息。
              deps.onReplyError()
            } finally {
              deps.flushReplyEvents()
            }
          }).catch(() => { deps.onReplyError() })
        }
      })
      chatChain = run.catch(() => {})
      await run
      return true
    },
    async drainReplies(): Promise<void> {
      await chatChain
      await replyChain
    },
  }
}
