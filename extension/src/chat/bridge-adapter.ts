/**
 * P5 聊天只读层 ↔ P1 Bridge 适配层。
 *
 * 复用 P1 的信封形态（`kind: 'command' | 'response' | 'event'`），命令/事件名直接取自
 * `@fishops/shared` 的 `CommandTypes` / `EventTypes`，保证与 P1 单一来源、不漂移。
 *
 * ============================ 实际接线（已落地） ============================
 * MAIN world（`content/chat-main.ts`）
 *   - `installChatWebSocketMonitor` 只读监听目标 WebSocket；
 *   - 原始消息/连接状态经 P1 postMessage bridge 以 `CHAT_SOCKET_EVENT` 上报；
 *   - 只读 LWP transport 挂到 `window.__FISHOPS_CHAT_TRANSPORT__` 供 background 拉取历史。
 * background
 *   - `background/index.ts` 按来源校验 `CHAT_SOCKET_EVENT`（仅 goofish content script），
 *     经 `ChatRuntime.ingestSocketEvent` 入库，并 `drainEvents` → P1 `broadcast`；
 *   - `background/message-router.ts` 把 Workbench 的 `CHAT_*` 命令委托给 `ChatRouterDeps`；
 *   - `background/chat-runtime.ts` 组装 store / history / sync / adapter（注入 transport 与持久化）。
 * Workbench
 *   - 通过 `RuntimeClient.call('CHAT_*')` / `RuntimeClient.on('CHAT_*')` 读写（类型已随 shared 扩展）。
 * =================================================================
 */
import { CommandTypes, EventTypes } from '@fishops/shared'
import type { ChatEventKind, ChatMessage, Conversation } from '../../../shared/types/chat'
import type { ChatSocketStatus } from './websocket'
import { correctMessageDirection } from './parser'
import type { ChatSync, SyncConversationsOptions, SyncResult } from './sync'
import type { ChatStore } from './store'
import { isServerMessageId, type ChatReadTransport } from './read-transport'

// ---------------- 与 P1 Bridge 信封兼容的最小结构 ----------------

/** 命令信封（对应 P1 `CommandEnvelope`，字段宽松）。 */
export interface BridgeCommandEnvelopeLike {
  kind: 'command'
  requestId: string
  type: string
  payload?: unknown
  protocol?: number
  sentAt?: number
}

/** 响应信封（对应 P1 `ResponseEnvelope`）。 */
export interface BridgeResponseEnvelopeLike {
  kind: 'response'
  requestId: string
  type: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
  protocol?: number
  respondedAt?: number
}

/** 事件信封（对应 P1 `EventEnvelope`）。 */
export interface BridgeEventEnvelopeLike {
  kind: 'event'
  type: string
  eventId: string
  payload: unknown
  emittedAt: number
  protocol?: number
}

/**
 * 聊天相关命令类型。
 * 值直接引用 `@fishops/shared` 的 {@link CommandTypes}，保证与 P1 命令表单一来源、不会漂移。
 */
export const ChatBridgeCommands = {
  /** 列出会话。 */
  CHAT_LIST_CONVERSATIONS: CommandTypes.CHAT_LIST_CONVERSATIONS,
  /** 读取某会话消息。 */
  CHAT_GET_MESSAGES: CommandTypes.CHAT_GET_MESSAGES,
  /** 拉取某会话历史。 */
  CHAT_SYNC_HISTORY: CommandTypes.CHAT_SYNC_HISTORY,
  /** 拉取会话列表。 */
  CHAT_SYNC_CONVERSATIONS: CommandTypes.CHAT_SYNC_CONVERSATIONS,
  /** 对指定会话最新入站服务端消息确认已读。 */
  CHAT_MARK_READ: CommandTypes.CHAT_MARK_READ,
  /** 聊天层状态（socket 连接、计数）。 */
  CHAT_STATUS: CommandTypes.CHAT_STATUS,
} as const

export type ChatBridgeCommand = (typeof ChatBridgeCommands)[keyof typeof ChatBridgeCommands]

/** 聊天相关事件类型（值引用 shared，保证与 P1 事件表单一来源）。 */
export const ChatBridgeEvents = {
  /** 实时消息已入库（负载仅含元数据，不含正文）。 */
  CHAT_MESSAGE_INGESTED: EventTypes.CHAT_MESSAGE_INGESTED,
  /** 会话信息更新。 */
  CHAT_CONVERSATION_UPDATED: EventTypes.CHAT_CONVERSATION_UPDATED,
  /** 历史/会话同步完成。 */
  CHAT_SYNC_COMPLETED: EventTypes.CHAT_SYNC_COMPLETED,
  /** WebSocket 连接状态变化。 */
  CHAT_SOCKET_STATUS: EventTypes.CHAT_SOCKET_STATUS,
} as const

export type ChatBridgeEvent = (typeof ChatBridgeEvents)[keyof typeof ChatBridgeEvents]

/** 适配器依赖。 */
export interface ChatBridgeAdapterDeps {
  sync: ChatSync
  store: ChatStore
  /** 已读接口独立写 transport；不复用只读历史 transport 白名单。 */
  readTransport?: ChatReadTransport
  /** 当前用户 ID。 */
  myUserId?: string
  /** 时间源，便于测试。 */
  now?: () => number
  /** eventId 生成器，便于测试。 */
  genEventId?: () => string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function defaultEventId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID()
  return `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * 聊天 Bridge 适配器。
 * 把只读的 store / sync 暴露为 P1 风格的命令处理与事件队列。
 */
export class ChatBridgeAdapter {
  private readonly sync: ChatSync
  private readonly store: ChatStore
  private readonly now: () => number
  private readonly genEventId: () => string
  private readonly readTransport?: ChatReadTransport
  /** 当前用户 ID；用于读取时对方向做即时校正（防御归一尚未执行的窗口）。 */
  private myUserId?: string
  private readonly events: BridgeEventEnvelopeLike[] = []
  private socketStatus: ChatSocketStatus = 'connecting'
  /** 进行中的会话同步 promise（并发去重：并发的 CHAT_SYNC_CONVERSATIONS 只拉取一次平台数据）。 */
  private conversationsSyncInFlight: Promise<SyncResult> | null = null

  constructor(deps: ChatBridgeAdapterDeps) {
    this.sync = deps.sync
    this.store = deps.store
    this.readTransport = deps.readTransport
    this.myUserId = deps.myUserId
    this.now = deps.now ?? (() => Date.now())
    this.genEventId = deps.genEventId ?? defaultEventId
  }

  /**
   * 动态更新当前用户 ID。
   *
   * 适配器本身不持有历史解析逻辑；这里保存 ID 仅用于读取（`CHAT_GET_MESSAGES`）时对未
   * 归一的消息做即时方向校正，避免 runtime 后置解析的窗口内仍把自己显示在左侧。
   * 已写入 store 的批量归一由 {@link ChatSync.setMyUserId} 负责。
   */
  setMyUserId(myUserId?: string): void {
    this.myUserId = myUserId
  }

  /**
   * 处理一条 P1 风格命令，返回 P1 风格响应。
   * 未知命令与非法负载都返回 `ok: false` 的结构化错误，不抛错。
   */
  async handleCommand(command: BridgeCommandEnvelopeLike): Promise<BridgeResponseEnvelopeLike> {
    const { requestId, type } = command
    switch (type) {
      case ChatBridgeCommands.CHAT_LIST_CONVERSATIONS: {
        const conversations: Conversation[] = this.store.listConversations()
        return this.ok(requestId, type, { conversations })
      }
      case ChatBridgeCommands.CHAT_GET_MESSAGES: {
        const payload = command.payload
        if (!isRecord(payload) || typeof payload['sessionId'] !== 'string') {
          return this.fail(requestId, type, 'INVALID_PAYLOAD', 'CHAT_GET_MESSAGES 需要 sessionId')
        }
        const order = payload['order'] === 'desc' ? 'desc' : 'asc'
        const limit = typeof payload['limit'] === 'number' ? payload['limit'] : undefined
        const messages: ChatMessage[] = this.store
          .getMessages(payload['sessionId'] as string, { order, limit })
          .map((message) => correctMessageDirection(message, this.myUserId) ?? message)
        return this.ok(requestId, type, { messages })
      }
      case ChatBridgeCommands.CHAT_SYNC_HISTORY: {
        const payload = command.payload
        if (!isRecord(payload) || typeof payload['sessionId'] !== 'string') {
          return this.fail(requestId, type, 'INVALID_PAYLOAD', 'CHAT_SYNC_HISTORY 需要 sessionId')
        }
        const result = await this.sync.syncHistory(payload['sessionId'] as string, {
          pages: typeof payload['pages'] === 'number' ? payload['pages'] : undefined,
          count: typeof payload['count'] === 'number' ? payload['count'] : undefined,
        })
        this.pushSyncCompleted('history', result)
        return this.ok(requestId, type, result)
      }
      case ChatBridgeCommands.CHAT_SYNC_CONVERSATIONS: {
        const payload = isRecord(command.payload) ? command.payload : {}
        // 并发去重：多个并发同步共享同一次拉取与事件（事件只推送一次），
        // 每个调用方各自拿到一份带自己 requestId / type 的合法响应。
        const result = await this.syncConversationsOnce({
          pages: typeof payload['pages'] === 'number' ? payload['pages'] : undefined,
          pageSize: typeof payload['pageSize'] === 'number' ? payload['pageSize'] : undefined,
        })
        return this.ok(requestId, type, result)
      }
      case ChatBridgeCommands.CHAT_MARK_READ: {
        const payload = command.payload
        if (!isRecord(payload) || typeof payload['sessionId'] !== 'string' || !/^[^@\s]{1,128}$/.test(payload['sessionId'])) {
          return this.fail(requestId, type, 'INVALID_PAYLOAD', 'CHAT_MARK_READ 需要有效 sessionId')
        }
        if (!this.readTransport) return this.ok(requestId, type, { ok: false, error: { code: 'READ_UNAVAILABLE', message: '已读 transport 未接线' } })
        const sessionId = payload['sessionId']
        const existingConversation = this.store.getConversation(sessionId)
        if (!existingConversation) return this.ok(requestId, type, { ok: false, error: { code: 'INVALID_SESSION', message: '会话不存在' } })
        let messages = this.store.getMessages(sessionId, { order: 'desc' })
        let latest = messages.find((message) => message.direction === 'in' && isServerMessageId(message.messageId))
        if (!latest) {
          const history = await this.sync.syncHistory(sessionId, { pages: 1 })
          if (!history.ok) return this.ok(requestId, type, { ok: false, error: { code: 'HISTORY_SYNC_FAILED', message: history.error?.message ?? '读取最新消息失败' } })
          messages = this.store.getMessages(sessionId, { order: 'desc' })
          latest = messages.find((message) => message.direction === 'in' && isServerMessageId(message.messageId))
        }
        if (!latest) return this.ok(requestId, type, { ok: false, error: { code: 'MESSAGE_ID_UNAVAILABLE', message: '没有可用的服务端消息 ID' } })
        try {
          const response = await this.readTransport.markRead(sessionId, latest.messageId)
          if (response.code !== 200) return this.ok(requestId, type, { ok: false, error: { code: 'PLATFORM_REJECTED', message: '平台未确认已读' } })
          const newest = this.store.getMessages(sessionId, { order: 'desc' }).find((message) => message.direction === 'in' && isServerMessageId(message.messageId))
          const conversation = this.store.getConversation(sessionId)
          if (conversation && newest?.messageId === latest.messageId) {
            this.store.upsertConversations([{ ...conversation, unreadCount: 0 }])
            await this.store.flush()
            this.push(ChatBridgeEvents.CHAT_CONVERSATION_UPDATED, { added: 0, updated: 1 })
          }
          return this.ok(requestId, type, { ok: true })
        } catch (error) {
          return this.ok(requestId, type, { ok: false, error: { code: 'MARK_READ_FAILED', message: error instanceof Error ? error.message : '已读请求失败' } })
        }
      }
      case ChatBridgeCommands.CHAT_STATUS:
        return this.ok(requestId, type, {
          socketStatus: this.socketStatus,
          sessionCount: this.store.sessionCount,
          messageCount: this.store.messageCount,
        })
      default:
        return this.fail(requestId, type, 'UNKNOWN_COMMAND', `未知聊天命令: ${type}`)
    }
  }

  /**
   * 摄入一条实时 WebSocket 原始消息，成功时为每条消息排队一个「元数据事件」。
   * 事件负载刻意不含正文，避免日志/持久化泄露聊天内容。
   */
  ingestRealtime(raw: unknown): SyncResult {
    const result = this.sync.ingestRealtime(raw)
    if (result.ok && result.added + result.updated > 0) {
      // 通过 store 反查本次消息不现实（可能重复），此处按事件类型通知即可。
      this.push(ChatBridgeEvents.CHAT_MESSAGE_INGESTED, {
        kind: result.kind as ChatEventKind | undefined,
        added: result.added,
        updated: result.updated,
      })
    }
    return result
  }

  /** 上报 WebSocket 连接状态（由 websocket.ts 的 onStatus 调用）。 */
  reportSocketStatus(status: ChatSocketStatus): void {
    this.socketStatus = status
    this.push(ChatBridgeEvents.CHAT_SOCKET_STATUS, { status })
  }

  /** 取出并清空待广播事件；background 拿到后交给 P1 `broadcast` 投递。 */
  drainEvents(): BridgeEventEnvelopeLike[] {
    return this.events.splice(0, this.events.length)
  }

  /**
   * 执行一次会话同步（含事件推送），并发调用共享同一 promise。
   *
   * 事件（CHAT_CONVERSATION_UPDATED / CHAT_SYNC_COMPLETED）在共享工作内**只推送一次**，
   * 避免并发的重复同步向 Workbench 广播重复事件；完成后清空，后续同步会重新拉取。
   */
  private syncConversationsOnce(options: SyncConversationsOptions): Promise<SyncResult> {
    if (this.conversationsSyncInFlight) return this.conversationsSyncInFlight
    const run = (async (): Promise<SyncResult> => {
      const result = await this.sync.syncConversations(options)
      if (result.added + result.updated > 0) {
        this.push(ChatBridgeEvents.CHAT_CONVERSATION_UPDATED, {
          added: result.added,
          updated: result.updated,
        })
      }
      this.pushSyncCompleted('conversations', result)
      return result
    })()
    this.conversationsSyncInFlight = run.finally(() => {
      this.conversationsSyncInFlight = null
    })
    return this.conversationsSyncInFlight
  }

  private pushSyncCompleted(scope: 'history' | 'conversations', result: SyncResult): void {
    this.push(ChatBridgeEvents.CHAT_SYNC_COMPLETED, {
      scope,
      ok: result.ok,
      added: result.added,
      updated: result.updated,
      error: result.error,
    })
  }

  private push(type: ChatBridgeEvent, payload: unknown): void {
    this.events.push({ kind: 'event', type, eventId: this.genEventId(), payload, emittedAt: this.now() })
  }

  private ok(requestId: string, type: string, result: unknown): BridgeResponseEnvelopeLike {
    return { kind: 'response', requestId, type, ok: true, result, respondedAt: this.now() }
  }

  private fail(requestId: string, type: string, code: string, message: string): BridgeResponseEnvelopeLike {
    return { kind: 'response', requestId, type, ok: false, error: { code, message }, respondedAt: this.now() }
  }
}
