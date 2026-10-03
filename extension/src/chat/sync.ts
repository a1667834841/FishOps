/**
 * 聊天同步（P5 只读）。
 *
 * 迁移自 `chat` 分支 `inject/api/chat-sync.js`，职责收敛为：
 * 把「实时 WebSocket 消息」与「历史 LWP 消息」归一为同一标准模型，
 * 交给 `ChatStore` 去重、按时间排序、按会话隔离存储。
 *
 * 边界：只读、只写本地 store；不发送、不自动回复、不调用 AI。
 */
import type { ChatEventKind, ChatMessage, SyncError } from '../../../shared/types/chat'
import { ChatHistoryClient, ChatHistoryError } from './history'
import { parseWebSocketMessage, type ParseContext } from './parser'
import { ChatStore, type UpsertResult } from './store'

/** 同步依赖。 */
export interface ChatSyncDeps {
  store: ChatStore
  /** 历史客户端；未提供时历史同步相关方法不可用。 */
  history?: ChatHistoryClient
  /** 分页之间的等待时间，默认沿用协议建议的 300ms。 */
  sleep?: (ms: number) => Promise<void>
}

/** 单次同步结果。 */
export interface SyncResult {
  ok: boolean
  /** 实时事件的类型（历史/批量同步时为 undefined）。 */
  kind?: ChatEventKind
  /** 新增条数。 */
  added: number
  /** 覆盖（去重命中）条数。 */
  updated: number
  /** 同步失败时的结构化错误（code 含解析 / LWP / transport / 持久化等）。 */
  error?: SyncError
  /** 解析提示（缺字段、未知结构等）。 */
  notes?: string[]
}

/** 历史同步选项。 */
export interface SyncHistoryOptions {
  /** 最多拉取页数。 */
  pages?: number
  /** 每页条数。 */
  count?: number
}

/** 会话同步选项。 */
export interface SyncConversationsOptions {
  /** 最多拉取页数。 */
  pages?: number
  /** 每页条数。 */
  pageSize?: number
}

/**
 * 归一：把任意来源的消息收敛为标准结构。
 * parser / history 已产出标准模型，这里只做防御性清洗，不引入新字段。
 */
export function normalizeMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    senderId: message.senderId ?? '',
    senderName: (message.senderName ?? '').trim(),
    receiverId: message.receiverId ?? '',
    content: message.content ?? '',
    createAt: message.createAt ?? 0,
  }
}

/** 同步错误 message 的安全上限，避免把异常原文/响应体原样透传给 Workbench。 */
const SYNC_ERROR_MESSAGE_MAX = 300

/**
 * 归一任意异常为结构化同步错误。
 *
 * 仅保留 `code` 与经过截断 / 单行化的 `message`；**绝不携带** transport 请求体、
 * LWP 原始响应、token / cookie / API key 或聊天正文（那些仅存在于各层局部变量中）。
 */
export function toSyncError(error: unknown): SyncError {
  if (error instanceof ChatHistoryError) {
    return { code: error.code, message: sanitizeSyncMessage(error.message) }
  }
  const maybeCode = (error as { code?: unknown } | null | undefined)?.code
  const code = typeof maybeCode === 'string' && maybeCode.length > 0 ? maybeCode : 'INTERNAL'
  const message = error instanceof Error ? error.message : String(error)
  return { code, message: sanitizeSyncMessage(message) }
}

function sanitizeSyncMessage(message: string): string {
  const single = message.replace(/\s+/g, ' ').trim()
  return single.length > SYNC_ERROR_MESSAGE_MAX ? `${single.slice(0, SYNC_ERROR_MESSAGE_MAX)}…` : single
}

/** 聊天同步器。 */
export class ChatSync {
  private readonly store: ChatStore
  private readonly history?: ChatHistoryClient
  private readonly parseCtx: ParseContext
  private readonly sleep: (ms: number) => Promise<void>

  constructor(deps: ChatSyncDeps, parseCtx: ParseContext = {}) {
    this.store = deps.store
    this.history = deps.history
    this.parseCtx = parseCtx
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /**
   * 摄入一条实时 WebSocket 原始消息。
   * 解析失败返回 `{ ok: false, error }`，绝不写入 store，也不抛错。
   */
  ingestRealtime(raw: unknown): SyncResult {
    const parsed = parseWebSocketMessage(raw, this.parseCtx)
    if (!parsed.ok) {
      return { ok: false, added: 0, updated: 0, error: parsed.error }
    }
    const count = this.store.upsertMessages(parsed.event.messages)
    return {
      ok: true,
      kind: parsed.event.kind,
      added: count.added,
      updated: count.updated,
      notes: parsed.event.notes,
    }
  }

  /** 摄入一批标准消息（历史抓取或测试注入）。 */
  ingestMessages(messages: readonly ChatMessage[]): SyncResult {
    const normalized = messages.map(normalizeMessage)
    const count: UpsertResult = this.store.upsertMessages(normalized)
    return { ok: true, added: count.added, updated: count.updated }
  }

  /**
   * 同步某会话的历史消息（分页，带游标）。
   * 每页解析后归一写入 store，store 负责跨页去重与排序。
   */
  async syncHistory(sessionId: string, options: SyncHistoryOptions = {}): Promise<SyncResult> {
    if (!this.history) return { ok: false, added: 0, updated: 0, error: { code: 'DECODE_FAILED', message: '未配置 ChatHistoryClient' } }
    const pages = options.pages ?? 1
    let added = 0
    let updated = 0
    let cursor: number | undefined
    try {
      for (let page = 0; page < pages; page++) {
        const result = await this.history.listMessageHistory(sessionId, { cursor, count: options.count })
        const count = this.store.upsertMessages(result.messages.map(normalizeMessage))
        added += count.added
        updated += count.updated
        if (!result.hasMore || result.nextCursor <= 0) break
        cursor = result.nextCursor
        await this.sleep(300)
      }
      await this.store.flush()
      return { ok: true, added, updated }
    } catch (error) {
      // transport reject / LWP 业务失败 / 持久化失败：归一为结构化错误，绝不逃逸。
      return { ok: false, added, updated, error: toSyncError(error) }
    }
  }

  /** 同步会话列表（分页）。 */
  async syncConversations(options: SyncConversationsOptions = {}): Promise<SyncResult> {
    if (!this.history) return { ok: false, added: 0, updated: 0, error: { code: 'DECODE_FAILED', message: '未配置 ChatHistoryClient' } }
    const pages = options.pages ?? 1
    let added = 0
    let updated = 0
    let cursor: number | undefined
    try {
      for (let page = 0; page < pages; page++) {
        const result = await this.history.listConversations({ cursor, pageSize: options.pageSize })
        const count = this.store.upsertConversations(result.conversations)
        added += count.added
        updated += count.updated
        if (!result.hasMore || result.nextCursor === undefined) break
        cursor = result.nextCursor
        await this.sleep(300)
      }
      await this.store.flush()
      return { ok: true, added, updated }
    } catch (error) {
      // transport reject（无 tab / 未登录 / 超时）/ LWP 业务失败 / 持久化失败：归一为结构化错误。
      return { ok: false, added, updated, error: toSyncError(error) }
    }
  }
}
