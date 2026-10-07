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
import type { ChatMessage, Conversation, MessageCursor } from '../../../shared/types/chat'

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

/** 消息写入选项。 */
export interface UpsertMessagesOptions {
  /**
   * 本批是否为「已同步的权威历史」快照。
   *
   * 只有历史同步批次才可作为剔除本地 `pendingEcho` 回显的时间边界：
   * 实时单条入站消息可能与本地发送无关，若拿它当边界会误删尚未被历史证实的回显。
   */
  authoritativeHistory?: boolean
}

/** 查询选项。 */
export interface QueryOptions {
  /** 返回顺序：`asc` 为时间升序（默认，符合聊天时间线），`desc` 为降序。 */
  order?: 'asc' | 'desc'
  /** 最多返回条数（从对应端点截取）。 */
  limit?: number
}

/** 分页查询选项（在 {@link QueryOptions} 基础上增加向前边界）。 */
export interface MessagePageQueryOptions extends QueryOptions {
  /**
   * 向前分页边界：只看**严格早于**该游标的消息。
   *
   * 与 `limit` 配合即可取「游标之前最近的一页」，这是把历史向前翻页的稳定做法。
   */
  before?: MessageCursor
}

/** 分页查询结果。 */
export interface MessagePageResult {
  messages: ChatMessage[]
  /** 是否还存在比本页更早的消息（仅在传入 `limit` 时有意义）。 */
  hasMore: boolean
}

/**
 * 消息排序：createAt 升序，其次 messageId，最后 id，保证稳定。
 *
 * 参数放宽为 {@link MessageCursor}，使分页游标（只需排序键三要素）可直接参与比较。
 */
export function compareMessages(a: MessageCursor, b: MessageCursor): number {
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

  /** 按现有会话和去重键检查消息是否已入库，不读取或复制全量会话。 */
  hasMessage(message: ChatMessage): boolean {
    return this.messagesBySession.get(message.sessionId)?.has(ChatStore.keyOf(message)) ?? false
  }

  /** 批量 upsert 消息，返回新增/覆盖统计。 */
  upsertMessages(messages: readonly ChatMessage[], options: UpsertMessagesOptions = {}): UpsertResult {
    const changed: ChatMessage[] = []
    const result = this.applyMessages(messages, changed)
    if (changed.length > 0) this.enqueueFlush(() => this.persistence.saveMessages(changed))
    // 仅当本批是「已同步的权威历史」时才以它为边界剔除已被覆盖的本地回显；
    // 实时单条入站消息不能当边界，否则会误删尚未被历史证实的本地发送回显。
    if (options.authoritativeHistory === true) this.pruneCoveredEchoes(messages)
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

  /**
   * 分页查询某会话的消息。
   *
   * 语义与 {@link getMessages} 的区别：`limit` 取的是**窗口内最近**的 N 条
   * （而不是最早的 N 条），并额外返回 `hasMore`。专用于历史向前翻页，
   * 因此不影响 `getMessages` 的既有语义（asc+limit 仍从最早端截取）。
   */
  getMessagePage(sessionId: string, options: MessagePageQueryOptions = {}): MessagePageResult {
    const bucket = this.messagesBySession.get(sessionId)
    const sorted = bucket ? [...bucket.values()].sort(compareMessages) : []
    const window = options.before ? sorted.filter((m) => compareMessages(m, options.before as MessageCursor) < 0) : sorted
    const limit = options.limit
    if (limit === undefined) {
      const ordered = options.order === 'desc' ? window.reverse() : window
      return { messages: ordered.map((m) => ({ ...m })), hasMore: false }
    }
    // 本页之前是否还有更早的消息：窗口比 limit 长就说明有。
    const hasMore = window.length > limit
    // 取窗口内最近的 limit 条（升序下即尾部），再按请求方向输出。
    const page = window.slice(Math.max(0, window.length - limit))
    const ordered = options.order === 'desc' ? page.reverse() : page
    return { messages: ordered.map((m) => ({ ...m })), hasMore }
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
      // 本地确认回显仅内存暂存，不持久化：权威历史 / 回声才是持久真相，
      // 避免 service worker 重启后回显与权威消息并存重复。
      if (stored.pendingEcho !== true) changedOut?.push(stored)
    }
    return { added, updated }
  }

  /**
   * 剔除被权威历史时间边界覆盖的本地确认回显（`pendingEcho`）。
   *
   * 只在 {@link upsertMessages} 的 `authoritativeHistory` 批次上调用（历史同步）。
   * 规则（确定性，不做内容 / 模糊匹配）：
   * - 仅本批权威消息（非 `pendingEcho`）参与边界计算，按会话取最大 `createAt` 作为上界；
   * - 仅删除 `pendingEcho` 且 `createAt <= 上界` 的回显：即「已确认发送且比历史边界早」；
   * - 晚于上界的回显（历史尚未同步到的新消息）一律保留，不误删。
   *
   * 回显本就不持久化，因此这里仅删除内存条目。返回剔除条数（诊断 / 测试用）。
   */
  private pruneCoveredEchoes(authoritative: readonly ChatMessage[]): number {
    const boundaries = new Map<string, number>()
    for (const message of authoritative) {
      if (message.pendingEcho === true) continue
      const current = boundaries.get(message.sessionId)
      if (current === undefined || message.createAt > current) boundaries.set(message.sessionId, message.createAt)
    }
    if (boundaries.size === 0) return 0

    let removed = 0
    for (const [sessionId, boundary] of boundaries) {
      const bucket = this.messagesBySession.get(sessionId)
      if (!bucket) continue
      for (const [key, message] of bucket) {
        if (message.pendingEcho === true && message.createAt <= boundary) {
          bucket.delete(key)
          removed += 1
        }
      }
    }
    return removed
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
