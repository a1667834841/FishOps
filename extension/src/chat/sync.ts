/**
 * 聊天同步（P5 只读）。
 *
 * 迁移自 `chat` 分支 `inject/api/chat-sync.js`，职责收敛为：
 * 把「实时 WebSocket 消息」与「历史 LWP 消息」归一为同一标准模型，
 * 交给 `ChatStore` 去重、按时间排序、按会话隔离存储。
 *
 * 边界：只读、只写本地 store；不发送、不自动回复、不调用 AI。
 */
import type { ChatEventKind, ChatMessage, Conversation, SyncError } from '../../../shared/types/chat'
import { ChatHistoryClient, ChatHistoryError } from './history'
import { parseWebSocketMessage, correctMessageDirection, type ParseContext } from './parser'
import type { PeerProfileResolver } from './peer-profiles'
import { ChatStore, type UpsertResult } from './store'

/** 同步依赖。 */
export interface ChatSyncDeps {
  store: ChatStore
  /** 历史客户端；未提供时历史同步相关方法不可用。 */
  history?: ChatHistoryClient
  /** 分页之间的等待时间，默认沿用协议建议的 300ms。 */
  sleep?: (ms: number) => Promise<void>
  /**
   * 可选的对方头像补齐器（只读 mtop，见 `peer-profiles.ts`）。
   * 未提供时不做头像补齐；补齐失败一律不中断会话同步。
   */
  peerProfiles?: PeerProfileResolver
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
  private readonly peerProfiles?: PeerProfileResolver

  constructor(deps: ChatSyncDeps, parseCtx: ParseContext = {}) {
    this.store = deps.store
    this.history = deps.history
    this.parseCtx = parseCtx
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.peerProfiles = deps.peerProfiles
  }

  /**
   * 动态更新当前登录用户 ID，并重新归一已缓存消息方向。
   *
   * 场景：runtime 首次组装时登录态尚未就绪（myUserId 缺失），历史消息全被漏判为 `in`
   * （自己也在左侧）；后续准备流程解析出真实 ID 后调用本方法，把已有缓存（含持久化）纠正。
   *
   * 规则（安全优先，绝不做猜测）：
   * - 仅当新 ID 非空时执行重新归一；未知 ID 保持原样（诚实按 in，不猜）；
   * - 仅做 `in → out` 纠正（senderId 明确匹配新 ID），**绝不把已确认的 `out` 降级为 `in`**
   *   （保护本地发送回显 `pendingEcho` 与平台回声）；
   * - 只重写 `direction`（history 来源同时回填 `receiverId`），其余字段（头像、pendingEcho
   *   等）原样保留，不丢数据。
   */
  setMyUserId(myUserId?: string): void {
    const next = typeof myUserId === 'string' && myUserId.length > 0 ? myUserId : undefined
    this.parseCtx.myUserId = next
    this.history?.setMyUserId(next)
    // 头像补齐器若支持动态用户同步，顺带通知（避免其冻结在旧 ID 而错判归属）。
    const withUser = this.peerProfiles as unknown as { setMyUserId?: (id?: string) => void } | undefined
    withUser?.setMyUserId?.(next)
    if (next === undefined) return
    this.rederiveDirections(next)
  }

  /** 按当前用户 ID 重新归一 store 中已缓存消息方向（仅 in → out 纠正，绝不降级）。 */
  private rederiveDirections(myUserId: string): void {
    const all = this.store.getAllMessages()
    if (all.length === 0) return
    const changed: ChatMessage[] = []
    for (const message of all) {
      const corrected = correctMessageDirection(message, myUserId)
      if (corrected) changed.push(corrected)
    }
    if (changed.length === 0) return
    this.store.upsertMessages(changed)
    // 归一结果异步落盘；失败不抛出（store 的 onFlushError 会兑底，不影响调用方）。
    void this.store.flush().catch(() => {})
  }

  /** 摄入一条实时 WebSocket 原始消息。
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
        // 历史批次是权威边界：以它的时间上界剔除已覆盖的本地发送回显（仅此类批次可当边界）。
        const count = this.store.upsertMessages(result.messages.map(normalizeMessage), { authoritativeHistory: true })
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
        // LWP 会话数据不含头像；合并时保留 store 中已有的对方头像，避免重复同步把它抹掉。
        const incoming = result.conversations.map((conv) => {
          const existing = this.store.getConversation(conv.sessionId)
          if (existing?.peerAvatarUrl && !conv.peerAvatarUrl) {
            return { ...conv, peerAvatarUrl: existing.peerAvatarUrl }
          }
          return conv
        })
        const count = this.store.upsertConversations(incoming)
        added += count.added
        updated += count.updated
        if (!result.hasMore || result.nextCursor === undefined) break
        cursor = result.nextCursor
        await this.sleep(300)
      }
      await this.store.flush()
      const notes = await this.resolvePeerAvatars()
      return { ok: true, added, updated, ...(notes === undefined ? {} : { notes }) }
    } catch (error) {
      // transport reject（无 tab / 未登录 / 超时）/ LWP 业务失败 / 持久化失败：归一为结构化错误。
      return { ok: false, added, updated, error: toSyncError(error) }
    }
  }

  /**
   * 为缺失对方头像的会话补齐头像（只读 mtop）。
   *
   * 仅补齐 `peerAvatarUrl` 为空的会话，且写入前再次确认当前仍缺头像，保留已有头像。
   * 任何失败都只返回提示，绝不影响已经完成的会话同步。
   */
  private async resolvePeerAvatars(): Promise<string[] | undefined> {
    if (!this.peerProfiles) return undefined
    try {
      const missing = this.store.listConversations().filter((conv) => !conv.peerAvatarUrl)
      if (missing.length === 0) return undefined
      const updates = await this.peerProfiles.resolveMissing(missing)
      if (updates.length === 0) return undefined

      const merged: Conversation[] = []
      for (const update of updates) {
        const current = this.store.getConversation(update.sessionId)
        if (!current || current.peerAvatarUrl) continue
        merged.push({
          ...current,
          peerAvatarUrl: update.peerAvatarUrl,
          ...(update.peerUserId === undefined ? {} : { peerUserId: update.peerUserId }),
        })
      }
      if (merged.length === 0) return undefined
      this.store.upsertConversations(merged)
      await this.store.flush()
      return [`已补齐 ${merged.length} 个会话的对方头像`]
    } catch {
      // 兜底：头像补齐绝不让会话同步失败。
      return ['对方头像补齐失败（不影响会话同步）']
    }
  }
}
