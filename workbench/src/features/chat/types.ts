/**
 * 聊天中心使用的 P5 类型别名。
 *
 * `@fishops/shared` 只导出命令/事件协议，不直接导出 `shared/types/chat`；
 * 这里从真实的命令结果类型反推，保证与 background 返回的结构始终一致，不另造一份。
 */
import type {
  ChatGetMessagesPayload,
  ChatGetMessagesResult,
  ChatListConversationsResult,
  ChatSocketStatusPayload,
  ChatStatusResult,
  ChatSyncResultDto,
} from '@fishops/shared'

export type Conversation = ChatListConversationsResult['conversations'][number]
export type ChatMessage = ChatGetMessagesResult['messages'][number]
export type ChatMessageKind = ChatMessage['kind']
/** 向前分页游标：取自命令负载的 `before`，与扩展侧排序键三要素一致。 */
export type MessageCursor = NonNullable<ChatGetMessagesPayload['before']>
export type { ChatSocketStatusPayload, ChatStatusResult, ChatSyncResultDto }
