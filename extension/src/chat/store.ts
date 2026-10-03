/**
 * 聊天存储（P5 只读）。
 *
 * 迁移自 `chat` 分支 `inject/api/chat-sync.js` 中隐含的存储/去重逻辑，但改造为：
 * - 标准 `ChatMessage` / `Conversation` 模型；
 * - 先提供内存实现，持久化通过 `ChatPersistence` 接口注入（P5 不直接绑定 IndexedDB）；
 * - 去重键与 parser 共用 `buildMessageKey`，保证口径一致；
 * - 只保存净化后的标准模型，不保存原始 base64 / Cookie / token。
 */
import { buildMessageKey } from '../../../shared/chat/index'
import type { ChatMessage, Conversation } from '../../../shared/types/chat'

/** 持久化接口：由宿主实现（内存 / IndexedDB / 其他）。 */
export interface ChatPersistence {
  /** 载入全部消息。 */
  loadMessages(): Promise<ChatMessage[]>
  /** 载入全部会话。 */
  loadConversations(): Promise<Conversation[]>
  /** 保存（新增或覆盖）一批消息。 */
  saveMessages(messages: ChatMessage[]): Promise<void>
  /** 保存（新增或覆盖）一批会话。 */
  saveConversations(conversations: Conversation[]): Promise<void>
}

/** 内存持久化实现：用于测试或无持久化环境。 */
export class MemoryChatPersistence implements ChatPersistence {
  private messages = new Map<string, ChatMessage>()
  private conversations = new Map<string, Conversation>()

  async loadMessages(): Promise<ChatMessage[]> {
    return [...this.messages.values()].map((m) => ({ ...m }))
  }

  async loadConversations(): Promise<Conversation[]> {
    return [...this.conversations.values()].map((c) => ({ ...c }))
  }

  async saveMessages(messages: ChatMessage[]): Promise<void> {
    for (const message of messages) this.messages.set(ChatStore.keyOf(message), { ...message })
  }

  async saveConversations(conversations: Conversation[]): Promise<void> {
    for (const conversation of conversations) this.conversations.set(conversation.sessionId, { ...conversation })
  }
}

/** upsert 结果统计。 */
export interface UpsertResult {
  /** 新增条数。 */
  added: number
  /** 覆盖条数（去重键已存在）。 */
  updated: number
}

/** 查询选项。 */
export interface QueryOptions {
  /** 返回顺序：`asc` 为时间升序（默认，符合聊天时间线），`desc` 为降序。 */
  order?: 'asc' | 'desc'
  /** 最多返回条数（从对应端点截取）。 */
  limit?: number
}

/** 消息排序：createAt 升序，其次 messageId，最后 id，保证稳定。 */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.createAt !== b.createAt) return a.createAt - b.createAt
  if (a.messageId !== b.messageId) return a.messageId < b.messageId ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 会话排序：sortIndex 降序（最近活跃在前），其次 lastMessageTime。 */
export function compareConversations(a: Conversation, b: Conversation): number {
  if (a.sortIndex !== b.sortIndex) return b.sortIndex - a.sortIndex
  return b.lastMessageTime - a.lastMessageTime
}

/**
 * 聊天存储。
 * 内存为主存储，写入后异步 flush 到注入的持久化实现。
 */
export class ChatStore {
  private readonly messagesBySession = new Map<string, Map<string, ChatMessage>>()
  private readonly conversations = new Map<string, Conversation>()
  private readonly persistence: ChatPersistence
  private readonly onFlushError: (error: unknown) => void
  private flushChain: Promise<void> = Promise.resolve()
  private flushError: unknown = null

  constructor(persistence: ChatPersistence = new MemoryChatPersistence(), onFlushError?: (error: unknown) => void) {
    this.persistence = persistence
    this.onFlushError = onFlushError ?? (() => {})
  }

  /** 从持久化实现载入已有数据。 */
  async init(): Promise<void> {
    const [messages, conversations] = await Promise.all([
      this.persistence.loadMessages(),
      this.persistence.loadConversations(),
    ])
    this.applyMessages(messages)
    this.applyConversations(conversations)
  }

  /** 批量 upsert 消息，返回新增/覆盖统计。 */
  upsertMessages(messages: readonly ChatMessage[]): UpsertResult {
    const changed: ChatMessage[] = []
    const result = this.applyMessages(messages, changed)
    if (changed.length > 0) this.enqueueFlush(() => this.persistence.saveMessages(changed))
    return result
  }

  /** 批量 upsert 会话，返回新增/覆盖统计。 */
  upsertConversations(conversations: readonly Conversation[]): UpsertResult {
    const changed: Conversation[] = []
    const result = this.applyConversations(conversations, changed)
    if (changed.length > 0) this.enqueueFlush(() => this.persistence.saveConversations(changed))
    return result
  }

  /** 按消息计算去重键（供外部预判是否重复）。 */
  static keyOf(message: ChatMessage): string {
    return buildMessageKey({
      messageId: message.messageId,
      sessionId: message.sessionId,
      senderId: message.senderId,
      createAt: message.createAt,
      content: message.content,
    })
  }

  /** 查询某会话的消息（会话隔离）。 */
  getMessages(sessionId: string, options: QueryOptions = {}): ChatMessage[] {
    const bucket = this.messagesBySession.get(sessionId)
    if (!bucket) return []
    const sorted = [...bucket.values()].sort(compareMessages)
    const ordered = options.order === 'desc' ? sorted.reverse() : sorted
    const limited = options.limit === undefined ? ordered : ordered.slice(0, options.limit)
    return limited.map((m) => ({ ...m }))
  }

  /** 获取全部消息（可选跨会话排序）。 */
  getAllMessages(options: QueryOptions = {}): ChatMessage[] {
    const all: ChatMessage[] = []
    for (const bucket of this.messagesBySession.values()) all.push(...bucket.values())
    const sorted = all.sort(compareMessages)
    const ordered = options.order === 'desc' ? sorted.reverse() : sorted
    return (options.limit === undefined ? ordered : ordered.slice(0, options.limit)).map((m) => ({ ...m }))
  }

  /** 获取单个会话。 */
  getConversation(sessionId: string): Conversation | undefined {
    const conv = this.conversations.get(sessionId)
    return conv ? { ...conv } : undefined
  }

  /** 列出全部会话（按最近活跃排序）。 */
  listConversations(): Conversation[] {
    return [...this.conversations.values()].sort(compareConversations).map((c) => ({ ...c }))
  }

  /** 是否有该会话的消息。 */
  hasSession(sessionId: string): boolean {
    return this.messagesBySession.has(sessionId)
  }

  /** 消息总数。 */
  get messageCount(): number {
    let total = 0
    for (const bucket of this.messagesBySession.values()) total += bucket.size
    return total
  }

  /** 会话总数。 */
  get sessionCount(): number {
    return this.conversations.size
  }

  /** 等待已排队的持久化写入完成；失败会以异常暴露给调用方。 */
  async flush(): Promise<void> {
    await this.flushChain
    if (this.flushError !== null) {
      const error = this.flushError
      this.flushError = null
      throw error
    }
  }

  /** 清空内存数据（不影响持久化实现）。 */
  clear(): void {
    this.messagesBySession.clear()
    this.conversations.clear()
  }

  private enqueueFlush(operation: () => Promise<void>): void {
    this.flushChain = this.flushChain
      .then(operation)
      .catch((error: unknown) => {
        this.flushError = error
        this.onFlushError(error)
      })
  }

  private applyMessages(messages: readonly ChatMessage[], changedOut?: ChatMessage[]): UpsertResult {
    let added = 0
    let updated = 0
    for (const message of messages) {
      const key = ChatStore.keyOf(message)
      let bucket = this.messagesBySession.get(message.sessionId)
      if (!bucket) {
        bucket = new Map<string, ChatMessage>()
        this.messagesBySession.set(message.sessionId, bucket)
      }
      if (bucket.has(key)) {
        updated += 1
      } else {
        added += 1
      }
      const stored = { ...message, id: key }
      bucket.set(key, stored)
      changedOut?.push(stored)
    }
    return { added, updated }
  }

  private applyConversations(conversations: readonly Conversation[], changedOut?: Conversation[]): UpsertResult {
    let added = 0
    let updated = 0
    for (const conv of conversations) {
      if (this.conversations.has(conv.sessionId)) updated += 1
      else added += 1
      const stored = { ...conv }
      this.conversations.set(conv.sessionId, stored)
      changedOut?.push(stored)
    }
    return { added, updated }
  }
}
