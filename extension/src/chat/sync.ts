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
import { INITIAL_CURSOR } from '../../../shared/chat/index'
import { ChatHistoryClient, ChatHistoryError } from './history'
import { parseWebSocketMessage, correctMessageDirection, normalizeUserId, type ParseContext } from './parser'
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
  /** 仅供后台回复接线使用的本批新增消息，不放入 Bridge 事件。 */
  newMessages?: ChatMessage[]
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
  /**
   * 历史同步专用：下一次继续向更早翻页时使用的服务端游标。
   * 仅当 `hasMore` 为 `true` 时给出；失败或无更多时为 undefined。
   */
  nextCursor?: number
  /** 历史同步专用：服务端是否还存在更早的历史。 */
  hasMore?: boolean
}

/** 历史同步选项。 */
export interface SyncHistoryOptions {
  /** 最多拉取页数。 */
  pages?: number
  /** 每页条数。 */
  count?: number
  /** 起始服务端游标；不传时从最新一页开始（保持既有行为）。 */
  cursor?: number
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
  // 平台快照/已读确认作为未读水位；本地摘要时间推进不代表该消息已被平台计数。
  private readonly unreadSnapshots = new Map<string, { at: number; count: number }>()
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
   * 规则（安全优先，绝不猜测）：
   * - 仅当新 ID 非空时执行重新归一；未知 ID 保持原样（诚实按 in，不猜）；
   * - 依据**新的可靠 self**全量重算方向：发送者归一后等于 self → `out`，不等 → `in`；
   *   因此账号变化（或旧账号遗留）的 `out` 会被降级为 `in`（不再冻结）；
   * - 发送者为空（未知）的消息一律不动（无法证伪，不误伤本地回显 `pendingEcho`）；
   * - `pendingEcho` 同样参与判定，不作特殊冻结：仅当其发送者明确匹配 self 时才保持 `out`；
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

  /**
   * 按当前用户 ID 重新归一 store 中已缓存消息方向。
   *
   * 依据可靠 self 严格重算：发送者明确等于 self → `out`，明确不等（且 sender 非空）→ `in`；
   * 发送者未知则保持原方向。账号变化时旧 `out` 会降级为 `in`。
   */
  private rederiveDirections(myUserId: string): void {
    const all = this.store.getAllMessages()
    if (all.length === 0) return
    const changed: ChatMessage[] = []
    for (const message of all) {
      const corrected = correctMessageDirection(message, myUserId, { allowDemotion: true })
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
  ingestRealtime(raw: unknown, window?: { from: number; to: number }): SyncResult {
    const parsed = parseWebSocketMessage(raw, this.parseCtx)
    if (!parsed.ok) {
      return { ok: false, added: 0, updated: 0, error: parsed.error }
    }
    const seen = new Set<string>()
    const newMessages: ChatMessage[] = []
    for (const message of parsed.event.messages) {
      const key = `${message.sessionId}:${ChatStore.keyOf(message)}`
      // 同批重复及已有历史都不触发；缺少可靠账号时默认方向只能用于聊天展示。
      if (!seen.has(key) && !this.store.hasMessage(message) &&
        normalizeUserId(this.parseCtx.myUserId) && message.senderId) newMessages.push(message)
      seen.add(key)
    }
    // 保留原批量持久化，避免每条消息单独读取和重写 session 缓存。
    const count = this.store.upsertMessages(parsed.event.messages)
    this.updateRealtimeConversations(newMessages.filter(m =>
      !window || (m.createAt >= window.from && m.createAt <= window.to)))
    return {
      ok: true,
      kind: parsed.event.kind,
      newMessages,
      added: count.added,
      updated: count.updated,
      notes: parsed.event.notes,
    }
  }

  /** 新实时消息更新会话；历史补推保持平台摘要和已计数的未读数。 */
  private updateRealtimeConversations(messages: readonly ChatMessage[]): void {
    const updates = new Map<string, Conversation>()
    for (const message of messages) {
      const existing = updates.get(message.sessionId) ?? this.store.getConversation(message.sessionId)
      let snapshot = this.unreadSnapshots.get(message.sessionId)
      // 已读或平台刷新改变计数时，重新采用权威快照；同批本地变化不重置水位。
      if (!snapshot || snapshot.count !== (existing?.unreadCount ?? 0)) {
        snapshot = { at: existing?.lastMessageTime ?? 0, count: existing?.unreadCount ?? 0 }
      }
      if (message.createAt <= snapshot.at) continue
      const newer = message.createAt >= (existing?.lastMessageTime ?? 0)
      const unreadCount = (existing?.unreadCount ?? 0) + (message.direction === 'in' ? 1 : 0)
      const base: Conversation = existing ?? {
        sessionId: message.sessionId,
        cid: `${message.sessionId}@goofish`,
        peerUserName: message.direction === 'in' ? message.senderName : '',
        lastMessage: '', lastMessageTime: 0, sortIndex: 0, visible: true, unreadCount: 0,
      }
      const conversation: Conversation = {
        ...base,
        peerUserName: base.peerUserName || (message.direction === 'in' ? message.senderName : ''),
        ...(newer ? { lastMessage: message.content, lastMessageTime: message.createAt,
          sortIndex: Math.max(existing?.sortIndex ?? 0, message.createAt) } : {}),
        unreadCount,
        ...(message.direction === 'in' && message.senderAvatarUrl && !existing?.peerAvatarUrl
          ? { peerAvatarUrl: message.senderAvatarUrl } : {}),
      }
      snapshot.count = unreadCount
      this.unreadSnapshots.set(message.sessionId, snapshot)
      updates.set(message.sessionId, conversation)
    }
    if (updates.size) this.store.upsertConversations([...updates.values()])
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
    let cursor: number | undefined = options.cursor
    let hasMore = false
    let nextCursor: number | undefined
    try {
      for (let page = 0; page < pages; page++) {
        const result = await this.history.listMessageHistory(sessionId, { cursor, count: options.count })
        // 历史批次是权威边界：以它的时间上界剔除已覆盖的本地发送回显（仅此类批次可当边界）。
        const count = this.store.upsertMessages(result.messages.map(normalizeMessage), { authoritativeHistory: true })
        added += count.added
        updated += count.updated
        // 游标必须严格向更早推进：同值 / 反向 / 非法游标一律按失败处理，绝不当成终点，也不宣称耗尽。
        const progress = readHistoryProgress(result, cursor)
        if (!progress.ok) return { ok: false, added, updated, error: progress.error }
        hasMore = progress.hasMore
        nextCursor = progress.nextCursor
        if (!hasMore) break
        cursor = progress.nextCursor
        await this.sleep(300)
      }
      await this.store.flush()
      return { ok: true, added, updated, hasMore, ...(nextCursor !== undefined ? { nextCursor } : {}) }
    } catch (error) {
      // transport reject / LWP 业务失败 / 持久化失败：归一为结构化错误，绝不逃逸。
      // 失败时不带游标：调用方不得据此推进分页位置。
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
        // LWP 会话数据不含头像 / 对方 ID；合并时保留 store 中已补齐 / 已校正的值，
        // 避免重复同步把头像与对方 ID 抹掉（昵称不保留，由 latest 解析与 session.sync 共同负责）。
        const incoming = result.conversations.map((conv) => {
          const existing = this.store.getConversation(conv.sessionId)
          if (!existing) return conv
          return {
            ...conv,
            ...(existing.peerAvatarUrl && !conv.peerAvatarUrl ? { peerAvatarUrl: existing.peerAvatarUrl } : {}),
            ...(existing.peerUserId && !conv.peerUserId ? { peerUserId: existing.peerUserId } : {}),
          }
        })
        for (const conv of incoming) this.unreadSnapshots.set(conv.sessionId, {
          at: conv.lastMessageTime, count: conv.unreadCount,
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
   * 解析并按需补齐 / 纠正会话的对方资料（只读 mtop）。
   *
   * 不再只补「缺头像」：将全部会话交给 resolver，它会用 session.sync 的可靠结果纠正
   * 账号变化遗留的错 peer（peerUserId 缺 / 等于自己）、补齐昵称与头像（含覆盖错 peer 的旧头像）。
   * 任何失败都只返回粗粒度提示，绝不影响已完成的会话同步；仍缺头像时给出可见提示，不静默。
   */
  private async resolvePeerAvatars(): Promise<string[] | undefined> {
    if (!this.peerProfiles) return undefined
    try {
      const all = this.store.listConversations()
      if (all.length === 0) return undefined
      const updates = await this.peerProfiles.resolveMissing(all)

      const merged: Conversation[] = []
      for (const update of updates) {
        const current = this.store.getConversation(update.sessionId)
        if (!current) continue
        const next: Conversation = { ...current }
        let changed = false
        if (
          update.peerUserId !== undefined &&
          normalizeUserId(update.peerUserId) !== normalizeUserId(current.peerUserId)
        ) {
          next.peerUserId = update.peerUserId
          changed = true
        }
        if (update.peerUserName !== undefined && update.peerUserName !== current.peerUserName) {
          next.peerUserName = update.peerUserName
          changed = true
        }
        // 头像：仅当确实拿到、且与现值不同才写（纠正错 peer 时覆盖旧头像）。
        if (update.peerAvatarUrl !== undefined && update.peerAvatarUrl !== current.peerAvatarUrl) {
          next.peerAvatarUrl = update.peerAvatarUrl
          changed = true
        }
        if (changed) merged.push(next)
      }

      const notes: string[] = []
      if (merged.length > 0) {
        this.store.upsertConversations(merged)
        await this.store.flush()
        notes.push(`已补齐/校正 ${merged.length} 个会话的对方头像/昵称`)
      }
      // 可见的粗粒度提示：仍缺头像的会话数（不静默、不假成功）。
      const stillMissing = this.store.listConversations().filter((conv) => !conv.peerAvatarUrl).length
      if (stillMissing > 0) {
        notes.push(`${stillMissing} 个会话仍未取到对方头像（session.sync/user.query 未返回可用 logo 或身份不符）`)
      }
      return notes.length === 0 ? undefined : notes
    } catch {
      // 兜底：头像补齐绝不让会话同步失败。
      return ['对方资料解析失败（不影响会话同步）']
    }
  }
}

/**
 * 归约平台历史分页进度（严格前进校验）。
 *
 * 平台游标是递减的正整数（0 / 缺省表示结束）。只有严格向更早方向前进才算有效：
 * - hasMore 为真但游标缺失、非安全正整数、或未前进（同值 / 反向 / 等于初始上界）
 *   → 结构化失败，绝不把重复页当终点，也不宣称已到最早一页；
 * - hasMore 为假 → 正常结束（不给出游标）。
 *
 * 初次请求未带 cursor 时以 {@link INITIAL_CURSOR} 为上界，保证「无进展」同样被拦住。
 */
function readHistoryProgress(
  result: { hasMore: boolean; nextCursor: number },
  cursor: number | undefined,
): { ok: true; hasMore: boolean; nextCursor: number | undefined } | { ok: false; error: SyncError } {
  if (!result.hasMore) return { ok: true, hasMore: false, nextCursor: undefined }
  const next = result.nextCursor
  const upperBound = cursor ?? INITIAL_CURSOR
  if (typeof next !== 'number' || !Number.isSafeInteger(next) || next <= 0 || next >= upperBound) {
    return { ok: false, error: { code: 'CURSOR_STALLED', message: '平台历史分页游标未严格前进，已停止并标记失败' } }
  }
  return { ok: true, hasMore: true, nextCursor: next }
}
