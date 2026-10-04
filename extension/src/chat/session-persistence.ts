/**
 * chrome.storage.session 持久化实现（P5 只读）。
 *
 * 当前策略（见 P5 集成说明）：
 * - 聊天数据存 `chrome.storage.session`：同一浏览器会话内跨 service worker 回收保留，
 *   浏览器关闭即清空；不落盘，符合「只读、避免长期留存聊天正文」的取向。
 * - **字段白名单**：写入前只保留标准 `ChatMessage` 已知字段，`raw` / base64 / Cookie / token
 *   一律不进存储；图片只存 URL 不存内容。
 * - **容量保护**：session 配额有限（约 10MB），按时间保留最近 `maxMessages` 条消息、
 *   按活跃度保留最近 `maxConversations` 个会话，避免无限膨胀把整个 service worker 状态写爆。
 *
 * 后续若正文量级超出 session 配额，可换 IndexedDB 实现同一 `ChatPersistence` 接口，上层无感。
 */
import type { ChatMessage, Conversation } from '../../../shared/types/chat'
import { ChatStore, compareConversations, compareMessages, type ChatPersistence } from './store'

/** chrome.storage.session 的最小子集。 */
export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

/** 存储键。 */
export const CHAT_MESSAGES_KEY = 'fishops.chat.messages'
export const CHAT_CONVERSATIONS_KEY = 'fishops.chat.conversations'

/** 默认保留上限。 */
export const DEFAULT_MAX_MESSAGES = 500
export const DEFAULT_MAX_CONVERSATIONS = 100

/** 只保留标准 ChatMessage 字段（显式白名单，防止 raw/凭据混入）。 */
function sanitizeMessage(message: ChatMessage): ChatMessage {
  return {
    id: message.id,
    messageId: message.messageId,
    sessionId: message.sessionId,
    cid: message.cid,
    senderId: message.senderId,
    senderName: message.senderName,
    ...(message.senderAvatarUrl === undefined ? {} : { senderAvatarUrl: message.senderAvatarUrl }),
    receiverId: message.receiverId,
    direction: message.direction,
    kind: message.kind,
    contentType: message.contentType,
    content: message.content,
    ...(message.imageUrl === undefined ? {} : { imageUrl: message.imageUrl }),
    ...(message.itemId === undefined ? {} : { itemId: message.itemId }),
    ...(message.itemTitle === undefined ? {} : { itemTitle: message.itemTitle }),
    createAt: message.createAt,
    ...(message.readStatus === undefined ? {} : { readStatus: message.readStatus }),
    source: message.source,
  }
}

export interface SessionChatPersistenceOptions {
  maxMessages?: number
  maxConversations?: number
}

/** 基于 chrome.storage.session 的 ChatPersistence。 */
export class SessionChatPersistence implements ChatPersistence {
  private readonly storage: StorageAreaLike
  private readonly maxMessages: number
  private readonly maxConversations: number

  constructor(storage: StorageAreaLike, options: SessionChatPersistenceOptions = {}) {
    this.storage = storage
    this.maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES
    this.maxConversations = options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS
  }

  async loadMessages(): Promise<ChatMessage[]> {
    const stored = await this.storage.get(CHAT_MESSAGES_KEY)
    const value = stored[CHAT_MESSAGES_KEY]
    return Array.isArray(value) ? (value as ChatMessage[]) : []
  }

  async loadConversations(): Promise<Conversation[]> {
    const stored = await this.storage.get(CHAT_CONVERSATIONS_KEY)
    const value = stored[CHAT_CONVERSATIONS_KEY]
    return Array.isArray(value) ? (value as Conversation[]) : []
  }

  async saveMessages(messages: ChatMessage[]): Promise<void> {
    const existing = await this.loadMessages()
    const byKey = new Map(existing.map((message) => [ChatStore.keyOf(message), message]))
    for (const message of messages) byKey.set(ChatStore.keyOf(message), sanitizeMessage(message))
    const sorted = [...byKey.values()].sort(compareMessages)
    const trimmed = sorted.slice(Math.max(0, sorted.length - this.maxMessages))
    await this.storage.set({ [CHAT_MESSAGES_KEY]: trimmed })
  }

  async saveConversations(conversations: Conversation[]): Promise<void> {
    const existing = await this.loadConversations()
    const byId = new Map(existing.map((conv) => [conv.sessionId, conv]))
    for (const conv of conversations) byId.set(conv.sessionId, { ...conv })
    const sorted = [...byId.values()].sort(compareConversations)
    const trimmed = sorted.slice(0, this.maxConversations)
    await this.storage.set({ [CHAT_CONVERSATIONS_KEY]: trimmed })
  }
}
