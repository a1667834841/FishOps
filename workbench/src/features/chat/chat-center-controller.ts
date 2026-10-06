/**
 * 聊天中心控制器（纯 TypeScript，不依赖 Vue / DOM / chrome，可在 Node 下直接测试）。
 *
 * 职责：把 P5 的只读命令 + 受控 `CHAT_MARK_READ`（会话已读，不发送消息）+ 实时事件
 * 编排成一份可订阅的页面状态。
 *
 * 关键约束（均有对应单测）：
 * - 本地缓存查询（STATUS / LIST / GET_MESSAGES）可自动触发；
 *   拉取平台数据（SYNC_CONVERSATIONS / SYNC_HISTORY）只能由显式调用触发；
 * - 异步竞态：每类请求带递增令牌，切会话后旧请求的返回一律丢弃，不会覆盖新会话；
 * - 事件只作为「元数据信号」：收到后重新读 store，绝不从事件取正文，也不输出任何日志；
 * - 订阅只在 `start()` 里注册一次，`dispose()` 全部释放；刷新按钮只重新查询，不重新订阅；
 * - 同步 `result.ok === false` 与抛异常同样视为失败并展示；
 * - 绝不发送聊天消息、不调用 AI（P6 才实现）；会话已读仅经受控的 `CHAT_MARK_READ`，且全局单飞。
 */
import {
  CommandTypes,
  EventTypes,
  type CommandPayloadMap,
  type CommandResultMap,
  type EventPayloadMap,
} from '@fishops/shared'
import { describeError, describeSyncError } from './chat-format'
import type { ChatMessage, ChatStatusResult, Conversation, MessageCursor } from './types'

/** 本页面会用到的命令（均为只读）。 */
export type ChatCommandType =
  | typeof CommandTypes.CHAT_STATUS
  | typeof CommandTypes.CHAT_LIST_CONVERSATIONS
  | typeof CommandTypes.CHAT_GET_MESSAGES
  | typeof CommandTypes.CHAT_SYNC_CONVERSATIONS
  | typeof CommandTypes.CHAT_SYNC_HISTORY
  | typeof CommandTypes.CHAT_MARK_READ

/** 本页面订阅的事件。WORKER_STARTED 用于 service worker 重启 / Port 重连后重新对账。 */
export const CHAT_CENTER_EVENTS = [
  EventTypes.WORKER_STARTED,
  EventTypes.CHAT_MESSAGE_INGESTED,
  EventTypes.CHAT_CONVERSATION_UPDATED,
  EventTypes.CHAT_SYNC_COMPLETED,
  EventTypes.CHAT_SOCKET_STATUS,
] as const

export type ChatCenterEventType = (typeof CHAT_CENTER_EVENTS)[number]

/** 控制器依赖的最小 Bridge 接口；生产环境由 RuntimeClient 适配，测试用 mock。 */
export interface ChatCenterApi {
  call<T extends ChatCommandType>(type: T, payload: CommandPayloadMap[T]): Promise<CommandResultMap[T]>
  /** 订阅事件，返回取消订阅函数。 */
  on<T extends ChatCenterEventType>(type: T, handler: (payload: EventPayloadMap[T]) => void): () => void
  /** 重新声明订阅（Port 因 service worker 回收断开后用于重连）；必须幂等。 */
  resubscribe(): void
}

export type LoadPhase = 'idle' | 'loading' | 'ready' | 'error'
export type SyncPhase = 'idle' | 'running' | 'ok' | 'failed'
export type SocketStatus = ChatStatusResult['socketStatus']

export interface StatusState {
  phase: LoadPhase
  data: ChatStatusResult | null
  error: string | null
}

export interface ConversationsState {
  phase: LoadPhase
  items: Conversation[]
  error: string | null
  /** 已有数据时的后台刷新中（不清空列表）。 */
  refreshing: boolean
}

export interface MessagesState {
  /** 这份消息属于哪个会话；与 selectedId 不一致的数据绝不展示。 */
  sessionId: string | null
  phase: LoadPhase
  items: ChatMessage[]
  error: string | null
  refreshing: boolean
  /** 向前分页状态：独立于初次加载与刷新，失败时保留 items 供重试。 */
  olderPhase: 'idle' | 'loading' | 'error'
  /** 加载更早消息失败的原因（成功 / 首次加载时为 null）。 */
  olderError: string | null
  /** 是否还存在更早的消息（本地或平台任一还有则为 true）；false 时页面提示「没有更多了」。 */
  hasMore: boolean
}

export interface SyncState {
  phase: SyncPhase
  /** 历史同步对应的会话；会话同步恒为 null。 */
  sessionId: string | null
  added: number
  updated: number
  error: string | null
  finishedAt: number | null
}

export interface ChatCenterState {
  /** unavailable：不在扩展内页，没有可用 Bridge。 */
  availability: 'unavailable' | 'ready'
  status: StatusState
  conversations: ConversationsState
  selectedId: string | null
  messages: MessagesState
  /** 最近一次已知的实时连接状态（STATUS 结果或 CHAT_SOCKET_STATUS 事件）。 */
  socketStatus: SocketStatus | null
  conversationSync: SyncState
  historySync: SyncState
  /** 实时事件订阅失败时的说明；为 null 表示订阅正常。 */
  realtimeError: string | null
  /** 用户显式刷新平台最近记录时的运行状态与错误。 */
  recentSyncing: boolean
  recentSyncError: string | null
  /** 当前会话已读请求错误；成功后为 null。 */
  markReadError: string | null
}

export interface ChatCenterControllerOptions {
  /** Bridge；传 null 表示当前环境不可用（非扩展内页）。 */
  api: ChatCenterApi | null
  /** 事件触发重新读 store 前的合并窗口（毫秒），默认 300。 */
  debounceMs?: number
  now?: () => number
}

const SOCKET_STATUSES: ReadonlySet<string> = new Set(['connecting', 'open', 'closed', 'error'])
const BAD_SHAPE = '扩展返回的数据格式不正确'

/** 打开会话 / 每次向前翻页的条数（最近 10 条）。 */
export const MESSAGE_PAGE_SIZE = 10

/** 单次「加载更早」最多向平台追朔的页数，避免极端情况下长时间循环。 */
const MAX_OLDER_SYNC_ROUNDS = 5

/** 平台历史游标的初始上界（与 shared/chat/protocol.ts 的 INITIAL_CURSOR 对齐，用于判定「是否真的前进」）。 */
const CURSOR_UPPER_BOUND = Number.MAX_SAFE_INTEGER

/**
 * 各会话的分页位置：服务端游标、平台是否还有更早历史、本地是否已确认取尽。
 *
 * `localExhausted` 用于抵抗「实时刷新把 hasMore 重新置真」：刷新只读最近一页，
 * 本地库仍比这一页多，但这不代表窗口最旧消息之前还有数据。
 */
interface PagingBook {
  serverCursor: number | undefined
  serverHasMore: boolean
  localExhausted: boolean
}

/**
 * 消息排序：与扩展侧 store 的 `compareMessages` 保持一致
 * （createAt → messageId → id），保证前插合并后顺序稳定、不重复。
 */
function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.createAt !== b.createAt) return a.createAt - b.createAt
  if (a.messageId !== b.messageId) return a.messageId < b.messageId ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 升序拷贝（不改动入参）。 */
function sortMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return [...messages].sort(compareMessages)
}

/** 按 id 去重合并两批消息并升序返回；同 id 以后到的为准（界面始终拿到最新快照）。 */
function mergeMessageWindow(existing: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()
  for (const message of existing) byId.set(message.id, message)
  for (const message of incoming) byId.set(message.id, message)
  return sortMessages([...byId.values()])
}

/** 解析分页结果：消息列表 + hasMore（缺省视为 false）。 */
function parseMessagePage(value: unknown): { messages: ChatMessage[]; hasMore: boolean } | null {
  const messages = parseMessages(value)
  if (!messages) return null
  return { messages, hasMore: isRecord(value) && value['hasMore'] === true }
}

/**
 * 读取 CHAT_SYNC_HISTORY 结果的分页进度与失败原因。
 *
 * 平台游标必须严格向更早方向前进（递减正整数）：`hasMore` 为真时，
 * 游标缺失、非安全正整数、或未前进（同值 / 反向 / 等于当前上界）都判为失败，
 * 绝不把重复页当成终点，也绝不因此宣称「没有更多了」。
 */
function readSyncProgress(
  result: unknown,
  cursor: number | undefined,
): { ok: boolean; hasMore: boolean; nextCursor?: number; error: string } {
  if (!isRecord(result) || typeof result['ok'] !== 'boolean') return { ok: false, hasMore: false, error: BAD_SHAPE }
  if (!result['ok']) {
    const detail = isRecord(result['error']) ? result['error'] : undefined
    return { ok: false, hasMore: false, error: describeSyncError(detail) }
  }
  if (result['hasMore'] !== true) return { ok: true, hasMore: false, error: '' }
  const raw = result['nextCursor']
  const nextCursor = typeof raw === 'number' ? raw : undefined
  const upperBound = cursor ?? CURSOR_UPPER_BOUND
  if (nextCursor === undefined || !Number.isSafeInteger(nextCursor) || nextCursor <= 0 || nextCursor >= upperBound) {
    return { ok: false, hasMore: true, error: '平台分页游标无效' }
  }
  return { ok: true, hasMore: true, nextCursor, error: '' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStatusResult(value: unknown): value is ChatStatusResult {
  return (
    isRecord(value) &&
    typeof value['socketStatus'] === 'string' &&
    SOCKET_STATUSES.has(value['socketStatus']) &&
    typeof value['sessionCount'] === 'number' &&
    typeof value['messageCount'] === 'number'
  )
}

function parseConversations(value: unknown): Conversation[] | null {
  if (!isRecord(value) || !Array.isArray(value['conversations'])) return null
  const items: unknown[] = value['conversations']
  if (!items.every((item) => isRecord(item) && typeof item['sessionId'] === 'string')) return null
  return items as Conversation[]
}

function parseMessages(value: unknown): ChatMessage[] | null {
  if (!isRecord(value) || !Array.isArray(value['messages'])) return null
  const items: unknown[] = value['messages']
  if (!items.every((item) => isRecord(item) && typeof item['id'] === 'string' && typeof item['sessionId'] === 'string')) {
    return null
  }
  return items as ChatMessage[]
}

interface RefreshFlags {
  status: boolean
  list: boolean
  messages: boolean
}

type SeqKind = 'status' | 'list' | 'messages'

function idleSync(): SyncState {
  return { phase: 'idle', sessionId: null, added: 0, updated: 0, error: null, finishedAt: null }
}

export function createInitialState(availability: ChatCenterState['availability']): ChatCenterState {
  return {
    availability,
    status: { phase: 'idle', data: null, error: null },
    conversations: { phase: 'idle', items: [], error: null, refreshing: false },
    selectedId: null,
    messages: {
      sessionId: null,
      phase: 'idle',
      items: [],
      error: null,
      refreshing: false,
      olderPhase: 'idle',
      olderError: null,
      hasMore: false,
    },
    socketStatus: null,
    conversationSync: idleSync(),
    historySync: idleSync(),
    realtimeError: null,
    recentSyncing: false,
    recentSyncError: null,
    markReadError: null,
  }
}

export class ChatCenterController {
  private state: ChatCenterState
  private readonly api: ChatCenterApi | null
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribers: Array<() => void> = []

  private started = false
  private disposed = false

  /** 各类请求的最新令牌；返回时令牌不一致说明已被更新的请求取代。 */
  private readonly seq = { status: 0, list: 0, messages: 0 }
  /**
   * 会话选择代（epoch）：切会话即递增，使旧会话在途的向前分页作废。
   *
   * 刻意不复用 `seq.messages`：同会话因事件触发的消息刷新不应中断向前分页。
   */
  private sessionEpoch = 0
  /** 单飞：同一时刻只允许一次「加载更早」在途。 */
  private olderInFlight: Promise<void> | null = null
  /** 各会话的服务端分页位置（切会话即重置）。 */
  private readonly paging = new Map<string, PagingBook>()
  private recentSyncInFlight: Promise<void> | null = null
  /** 全局单飞：同一时刻只允许一个已读请求在途，切会话立即作废旧响应，避免重复 / 竞态。 */
  private markReadInFlight: Promise<void> | null = null
  /** 在途已读请求 settle 后是否还需对「当前选中会话 / 新水位」补一次。 */
  private markReadDirty = false
  /** 会话选择代（epoch）：切会话即递增，使旧会话在途的已读响应作废。 */
  private markReadGeneration = 0
  /** 已成功确认已读的会话 → 其确认时的服务端 messageId（缓存无历史时记空串）。 */
  private readonly markedReadMessageIds = new Map<string, string>()
  /** 实时连接状态事件序号：status 响应若发起后又收到了事件，则以事件为准。 */
  private socketEventSeq = 0

  private refreshTimer: ReturnType<typeof setTimeout> | null = null
  private pending: RefreshFlags = { status: false, list: false, messages: false }

  constructor(options: ChatCenterControllerOptions) {
    this.api = options.api
    this.debounceMs = options.debounceMs ?? 300
    this.now = options.now ?? (() => Date.now())
    this.state = createInitialState(options.api ? 'ready' : 'unavailable')
  }

  getState(): ChatCenterState {
    return this.state
  }

  /** 订阅状态变化，返回取消订阅函数。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 启动：先注册事件监听（避免初次加载期间错过事件），再读取本地缓存。
   * 幂等——重复调用（如热更新）不会重复订阅。
   */
  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    if (!this.api) return
    this.registerEvents(this.api)
    void this.reload()
  }

  /** 释放所有订阅与定时器；之后任何在途请求的返回都会被丢弃。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.refreshTimer !== null) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = null
    }
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      try {
        unsubscribe()
      } catch {
        // 取消订阅失败不影响其余资源释放。
      }
    }
    this.listeners.clear()
    this.paging.clear()
    this.olderInFlight = null
  }

  /** 页面回到前台时调用：重新声明订阅（Port 可能已随 service worker 回收而断开）。 */
  resubscribe(): void {
    if (this.disposed || !this.api) return
    try {
      this.api.resubscribe()
      if (this.state.realtimeError) this.patch({ realtimeError: null })
    } catch (error) {
      this.patch({ realtimeError: `实时更新不可用：${describeError(error)}` })
    }
  }

  /** 只重新查询本地缓存，不拉取平台数据，也不重新订阅；供内部事件与发送完成后对账。 */
  async refresh(): Promise<void> {
    if (this.disposed || !this.api) return
    const tasks: Promise<void>[] = [this.loadStatus(), this.loadConversations(false)]
    if (this.state.selectedId) tasks.push(this.loadMessages(this.state.selectedId, false))
    await Promise.all(tasks)
  }

  /** 用户显式刷新：同步平台最近一页会话及刷新开始时选中会话的最近一页历史。 */
  async syncRecent(): Promise<void> {
    if (this.disposed || !this.api || this.recentSyncInFlight) return this.recentSyncInFlight ?? undefined
    const selectedId = this.state.selectedId
    this.patch({ recentSyncing: true, recentSyncError: null })
    const run = (async () => {
      try {
        await this.syncConversations()
        if (this.disposed) return
        if (this.state.conversationSync.phase === 'failed') {
          this.patch({ recentSyncError: this.state.conversationSync.error })
          return
        }
        if (!selectedId || this.state.selectedId !== selectedId) return
        await this.syncHistoryFor(selectedId)
        if (this.state.historySync.phase === 'failed' && this.state.historySync.sessionId === selectedId) {
          this.patch({ recentSyncError: this.state.historySync.error })
        }
      } finally {
        if (!this.disposed) this.patch({ recentSyncing: false })
        this.recentSyncInFlight = null
      }
    })()
    this.recentSyncInFlight = run
    return run
  }

  /** 选择会话并读取其本地缓存消息。重复选择同一会话不会重载。 */
  selectSession(sessionId: string): void {
    if (this.disposed || !this.api || !sessionId) return
    if (this.state.selectedId === sessionId) return
    this.markReadGeneration++
    // 切会话即推进代，使旧会话在途的向前分页结果作废；并重置该会话的分页位置。
    this.sessionEpoch++
    // 先让在途的旧会话请求作废，再切换，避免旧响应在切换瞬间写入。
    this.seq.messages++
    this.paging.set(sessionId, { serverCursor: undefined, serverHasMore: true, localExhausted: false })
    this.patch({
      selectedId: sessionId,
      messages: {
        sessionId,
        phase: 'loading',
        items: [],
        error: null,
        refreshing: false,
        olderPhase: 'idle',
        olderError: null,
        hasMore: false,
      },
      markReadError: null,
    })
    // 消息读取完成后会统一触发已读检查（见 loadMessages 成功分支）。
    void this.loadMessages(sessionId, false)
  }

  /** 重试当前会话的消息读取。 */
  async retryMessages(): Promise<void> {
    const id = this.state.selectedId
    if (!id) return
    await this.loadMessages(id, false)
  }

  /** 显式同步会话列表：向平台只读拉取。 */
  async syncConversations(): Promise<void> {
    if (this.disposed || !this.api || this.state.conversationSync.phase === 'running') return
    this.patch({ conversationSync: { ...idleSync(), phase: 'running' } })
    try {
      const result = await this.api.call(CommandTypes.CHAT_SYNC_CONVERSATIONS, {})
      if (this.disposed) return
      this.patch({ conversationSync: this.toSyncState(result, null) })
    } catch (error) {
      if (this.disposed) return
      this.patch({ conversationSync: this.failedSync(describeError(error), null) })
    }
    // 无论成败都重新读本地缓存：分页同步可能已写入部分数据。
    await Promise.all([this.loadStatus(), this.loadConversations(true)])
  }

  /** 显式同步当前选中会话的历史消息：向平台只读拉取。同一时刻只允许一个历史同步。 */
  async syncHistory(): Promise<void> {
    const sessionId = this.state.selectedId
    if (!sessionId) return
    await this.syncHistoryFor(sessionId)
  }

  private async syncHistoryFor(sessionId: string): Promise<void> {
    if (this.disposed || !this.api || this.state.historySync.phase === 'running') return
    this.patch({ historySync: { ...idleSync(), phase: 'running', sessionId } })
    try {
      const result = await this.api.call(CommandTypes.CHAT_SYNC_HISTORY, { sessionId })
      if (this.disposed) return
      this.patch({ historySync: this.toSyncState(result, sessionId) })
    } catch (error) {
      if (this.disposed) return
      this.patch({ historySync: this.failedSync(describeError(error), sessionId) })
    }
    const tasks: Promise<void>[] = [this.loadStatus(), this.loadConversations(true)]
    // 用户若已切到别的会话，就不要再为旧会话重读消息。
    if (this.state.selectedId === sessionId) tasks.push(this.loadMessages(sessionId, true))
    await Promise.all(tasks)
  }

  // ---------------- 内部实现 ----------------

  private async markSelectedRead(sessionId: string): Promise<void> {
    const api = this.api
    if (!api || this.disposed || this.state.selectedId !== sessionId) return
    // 已有已读在途：登记 dirty，待其 settle 后对当前选中会话 / 新水位补一次（不返回在途 promise，
    // 否则新会话会被静默丢弃、依赖用户再点）。
    if (this.markReadInFlight) {
      this.markReadDirty = true
      return
    }
    const latestId = this.latestServerInboundId(sessionId)
    const alreadyMarked = this.markedReadMessageIds.get(sessionId)
    // 已确认过且水位未变则不再请求，避免事件风暴。
    // 注意：缓存无历史（latestId 未定义）时仍需触发——后台 markRead 会先补同步最近一页历史再确认，
    // 不能因为页面消息为空就完全不触发而永远未读。
    if (alreadyMarked !== undefined && (latestId === undefined || alreadyMarked === latestId)) {
      this.markReadDirty = false
      return
    }
    const generation = this.markReadGeneration
    this.markReadDirty = false
    this.patch({ markReadError: null })
    const run = (async () => {
      try {
        const markResult = await api.call(CommandTypes.CHAT_MARK_READ, { sessionId })
        // 会话代 + 选中会话校验：切会话后的旧响应丢弃。
        // 不用 seq.messages：同会话因事件触发的消息重读不应作废已读请求（否则会被自己的广播更新不停作废）。
        if (this.disposed || this.state.selectedId !== sessionId || this.markReadGeneration !== generation) return
        if (!isRecord(markResult) || markResult['ok'] !== true) {
          const error = isRecord(markResult) && isRecord(markResult['error']) && typeof markResult['error']['message'] === 'string'
            ? markResult['error']['message'] : '平台未确认已读'
          this.patch({ markReadError: error })
          return
        }
        this.markedReadMessageIds.set(sessionId, latestId ?? '')
        // 成功后重读会话列表，清除该会话的未读标记（不改动消息，也不自动发送）。
        const result = await api.call(CommandTypes.CHAT_LIST_CONVERSATIONS, {})
        if (this.disposed || this.state.selectedId !== sessionId || this.markReadGeneration !== generation) return
        const items = parseConversations(result)
        if (items) this.patch({ conversations: { phase: 'ready', items, error: null, refreshing: false } })
      } catch (error) {
        if (this.disposed || this.state.selectedId !== sessionId || this.markReadGeneration !== generation) return
        this.patch({ markReadError: describeError(error) })
      } finally {
        this.markReadInFlight = null
        this.scheduleMarkReadFollowUp()
      }
    })()
    this.markReadInFlight = run
    return run
  }

  /**
   * 已读在途请求 settle 后的补发调度。
   *
   * 仅当 dirty（在途期间发生了会话切换或当前会话出现新水位）且仍有选中会话时补一次；
   * dispose / 无选中会话则不补。补发失败不会再递归补发（dirty 已清），避免循环重试与事件风暴。
   */
  private scheduleMarkReadFollowUp(): void {
    if (this.disposed) return
    if (!this.markReadDirty) return
    const selected = this.state.selectedId
    this.markReadDirty = false
    if (!selected) return
    void this.markSelectedRead(selected)
  }

  /** 取当前会话最新的服务端入站 messageId（过滤本地 pendingEcho 回显，不当作已读水位）。 */
  private latestServerInboundId(sessionId: string): string | undefined {
    if (this.state.messages.sessionId !== sessionId) return undefined
    const items = this.state.messages.items
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const message = items[i]
      if (
        message.direction === 'in' &&
        message.pendingEcho !== true &&
        typeof message.messageId === 'string' &&
        message.messageId.length > 0
      ) {
        return message.messageId
      }
    }
    return undefined
  }

  private async reload(): Promise<void> {
    await Promise.all([this.loadStatus(), this.loadConversations(false)])
  }

  private registerEvents(api: ChatCenterApi): void {
    const all: RefreshFlags = { status: true, list: true, messages: true }
    const listOnly: RefreshFlags = { status: true, list: true, messages: false }
    try {
      // 逐个登记并立即记录取消函数：中途失败时，已登记的也能在 dispose 时释放。
      // 事件只当作「有变化」的信号：负载里没有正文，重读 store 才是唯一数据来源。
      this.unsubscribers.push(api.on(EventTypes.WORKER_STARTED, () => this.scheduleRefresh(all)))
      this.unsubscribers.push(api.on(EventTypes.CHAT_MESSAGE_INGESTED, () => this.scheduleRefresh(all)))
      this.unsubscribers.push(api.on(EventTypes.CHAT_CONVERSATION_UPDATED, () => this.scheduleRefresh(listOnly)))
      this.unsubscribers.push(api.on(EventTypes.CHAT_SYNC_COMPLETED, () => this.scheduleRefresh(all)))
      this.unsubscribers.push(api.on(EventTypes.CHAT_SOCKET_STATUS, (payload) => this.onSocketStatus(payload)))
    } catch (error) {
      this.patch({ realtimeError: `实时更新不可用：${describeError(error)}` })
    }
  }

  private onSocketStatus(payload: unknown): void {
    if (this.disposed || !isRecord(payload)) return
    const status = payload['status']
    if (typeof status !== 'string' || !SOCKET_STATUSES.has(status)) return
    this.socketEventSeq++
    this.patch({ socketStatus: status as SocketStatus })
  }

  private scheduleRefresh(flags: RefreshFlags): void {
    if (this.disposed) return
    this.pending = {
      status: this.pending.status || flags.status,
      list: this.pending.list || flags.list,
      messages: this.pending.messages || flags.messages,
    }
    if (this.refreshTimer !== null) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      if (this.disposed) return
      const flagsNow = this.pending
      this.pending = { status: false, list: false, messages: false }
      const tasks: Promise<void>[] = []
      if (flagsNow.status) tasks.push(this.loadStatus())
      if (flagsNow.list) tasks.push(this.loadConversations(true))
      const selected = this.state.selectedId
      if (flagsNow.messages && selected) tasks.push(this.loadMessages(selected, true))
      void Promise.all(tasks)
    }, this.debounceMs)
  }

  private isStale(kind: SeqKind, token: number): boolean {
    return this.disposed || this.seq[kind] !== token
  }

  private async loadStatus(): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    const token = ++this.seq.status
    const socketSeq = this.socketEventSeq
    const hadData = this.state.status.data !== null
    if (!hadData) this.patch({ status: { phase: 'loading', data: null, error: null } })
    try {
      const result = await api.call(CommandTypes.CHAT_STATUS, {})
      if (this.isStale('status', token)) return
      if (!isStatusResult(result)) throw new Error(BAD_SHAPE)
      this.patch({
        status: { phase: 'ready', data: result, error: null },
        // 请求期间若已收到更新的实时状态事件，保留事件值。
        ...(socketSeq === this.socketEventSeq ? { socketStatus: result.socketStatus } : {}),
      })
    } catch (error) {
      if (this.isStale('status', token)) return
      this.patch({
        status: { phase: hadData ? 'ready' : 'error', data: this.state.status.data, error: describeError(error) },
      })
    }
  }

  private async loadConversations(silent: boolean): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    const token = ++this.seq.list
    const current = this.state.conversations
    const hadData = current.phase === 'ready'
    if (!hadData) {
      this.patch({ conversations: { phase: 'loading', items: [], error: null, refreshing: false } })
    } else if (!silent) {
      this.patch({ conversations: { ...current, refreshing: true } })
    }
    try {
      const result = await api.call(CommandTypes.CHAT_LIST_CONVERSATIONS, {})
      if (this.isStale('list', token)) return
      const items = parseConversations(result)
      if (!items) throw new Error(BAD_SHAPE)
      this.patch({ conversations: { phase: 'ready', items, error: null, refreshing: false } })
    } catch (error) {
      if (this.isStale('list', token)) return
      const latest = this.state.conversations
      this.patch({
        // 已有数据时保留旧列表并附带错误提示，避免一次失败清空界面。
        conversations: {
          phase: hadData ? 'ready' : 'error',
          items: hadData ? latest.items : [],
          error: describeError(error),
          refreshing: false,
        },
      })
    }
  }

  private async loadMessages(sessionId: string, silent: boolean): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    const token = ++this.seq.messages
    const current = this.state.messages
    const sameSession = current.sessionId === sessionId
    const hadData = sameSession && current.phase === 'ready'
    if (!hadData) {
      // 首次 / 切换 / 重试：从头开始一页，并重置该会话的分页位置。
      this.paging.set(sessionId, { serverCursor: undefined, serverHasMore: true, localExhausted: false })
      this.patch({
        messages: {
          sessionId,
          phase: 'loading',
          items: [],
          error: null,
          refreshing: false,
          olderPhase: 'idle',
          olderError: null,
          hasMore: false,
        },
      })
    } else if (!silent) {
      this.patch({ messages: { ...current, refreshing: true } })
    }
    try {
      // 只取最近一页（默认 10 条）；刷新时与已有窗口合并，绝不缩回 10 条或整体覆盖。
      const result = await api.call(CommandTypes.CHAT_GET_MESSAGES, {
        sessionId,
        order: 'desc',
        limit: MESSAGE_PAGE_SIZE,
      })
      // 令牌 + 选中会话双重校验：切会话后返回的旧请求不能覆盖新会话。
      if (this.isStale('messages', token) || this.state.selectedId !== sessionId) return
      const page = parseMessagePage(result)
      if (!page) throw new Error(BAD_SHAPE)
      const latest = this.state.messages
      const items = hadData && latest.sessionId === sessionId
        ? mergeMessageWindow(latest.items, page.messages)
        : sortMessages(page.messages)
      const preserveOlderState = hadData && latest.sessionId === sessionId
      this.patch({
        messages: {
          sessionId,
          phase: 'ready',
          items,
          error: null,
          refreshing: false,
          olderPhase: preserveOlderState ? latest.olderPhase : 'idle',
          olderError: preserveOlderState ? latest.olderError : null,
          // 本地本页之前还有数据（且未确认取尽），或平台可能还有（未知即视为还有，等翻页时再确认）。
          hasMore: (page.hasMore && !this.ensurePaging(sessionId).localExhausted) || this.ensurePaging(sessionId).serverHasMore,
        },
      })
      // 消息就绪后统一检查已读：会话切换与同会话新水位都由这里驱动（在途时会登记 dirty）。
      void this.markSelectedRead(sessionId)
    } catch (error) {
      if (this.isStale('messages', token) || this.state.selectedId !== sessionId) return
      const latest = this.state.messages
      this.patch({
        messages: {
          ...latest,
          sessionId,
          phase: hadData ? 'ready' : 'error',
          items: hadData ? latest.items : [],
          error: describeError(error),
          refreshing: false,
        },
      })
    }
  }

  /**
   * 加载更早的一页消息（单次最多新增 `MESSAGE_PAGE_SIZE` 条）。
   *
   * 顺序：每轮先用「当前窗口最旧消息」作边界向本地取剩余额度；本地取尽仍凑不满一页时，
   * 再按保存的服务端游标同步一页历史，然后回到本地重新取（边界随之更新，保证同步写入的
   * 更早消息能被同一次调用读到），直到凑满一页、本地仍有更早、或平台确认耗尽。
   * 单飞；失败只标记 `olderPhase: 'error'` 且游标不推进。
   */
  async loadOlder(): Promise<void> {
    const api = this.api
    const sessionId = this.state.selectedId
    if (!api || this.disposed || !sessionId) return
    const current = this.state.messages
    if (current.sessionId !== sessionId) return
    if (current.olderPhase === 'loading' || this.olderInFlight) return
    const book = this.ensurePaging(sessionId)
    const emptyWindow = current.items.length === 0
    // 已确认耗尽时不重复请求；但空窗口例外：本地缓存可能随后写入，平台也可能还有历史，
    // 不能因为 hasMore=false 就永久卡死（此时只有用户显式重试 / 刷新才会再次触发）。
    if (!current.hasMore && !emptyWindow) return
    const epoch = this.sessionEpoch
    this.patchMessages(sessionId, { olderPhase: 'loading', olderError: null })
    const run = (async () => {
      let localMore = false
      let added = 0
      let rounds = 0
      try {
        while (added < MESSAGE_PAGE_SIZE) {
          if (this.isOlderStale(epoch, sessionId)) return
          // 每轮都用当前最旧消息作边界：同步补入的更早消息必须能在同一轮内被读到。
          const boundary = this.oldestCursor(sessionId)
          const page = await this.loadOlderFromLocal(sessionId, epoch, boundary, MESSAGE_PAGE_SIZE - added)
          if (this.isOlderStale(epoch, sessionId)) return
          localMore = page.hasMore
          // 只累计本次真正新增的更早页条数：并发实时 append 到窗口尾部的新消息不计入，
          // 否则会把 already 虚高、提前结束本轮，导致一次更早页都没取到。
          added += page.added
          // 凑满一页或本地还有更早（下一页已备好）：本次立即结束，不额外追平台。
          if (added >= MESSAGE_PAGE_SIZE || localMore) break
          if (!book.serverHasMore) break
          if (rounds >= MAX_OLDER_SYNC_ROUNDS) break
          rounds += 1
          const cursor = book.serverCursor
          const result = await api.call(CommandTypes.CHAT_SYNC_HISTORY, {
            sessionId,
            pages: 1,
            count: MESSAGE_PAGE_SIZE,
            ...(cursor === undefined ? {} : { cursor }),
          })
          if (this.isOlderStale(epoch, sessionId)) return
          const sync = readSyncProgress(result, cursor)
          if (!sync.ok) {
            // 平台失败 / 游标未严格前进：保留本地已加载消息，标记错误供重试；游标不推进。
            this.patchMessages(sessionId, { olderPhase: 'error', olderError: sync.error })
            return
          }
          if (sync.hasMore && sync.nextCursor !== undefined) book.serverCursor = sync.nextCursor
          else if (!sync.hasMore) book.serverHasMore = false
        }
        if (this.isOlderStale(epoch, sessionId)) return
        // 只有本地与平台都确认耗尽才收起「还能继续翻」；本地耗尽不得宣称平台耗尽。
        this.patchMessages(sessionId, {
          olderPhase: 'idle',
          olderError: null,
          hasMore: localMore || book.serverHasMore,
        })
      } catch (error) {
        if (this.isOlderStale(epoch, sessionId)) return
        this.patchMessages(sessionId, { olderPhase: 'error', olderError: describeError(error) })
      } finally {
        this.olderInFlight = null
      }
    })()
    this.olderInFlight = run
    return run
  }

  /** 用本地游标取一页更早的消息并合并；返回本地是否还有更早的一页，以及本次真正新增的条数。 */
  private async loadOlderFromLocal(
    sessionId: string,
    epoch: number,
    before = this.oldestCursor(sessionId),
    limit = MESSAGE_PAGE_SIZE,
  ): Promise<{ hasMore: boolean; added: number }> {
    const api = this.api
    if (!api) return { hasMore: false, added: 0 }
    const result = await api.call(CommandTypes.CHAT_GET_MESSAGES, {
      sessionId,
      order: 'desc',
      limit,
      ...(before ? { before } : {}),
    })
    if (this.isOlderStale(epoch, sessionId)) return { hasMore: false, added: 0 }
    const page = parseMessagePage(result)
    if (!page) throw new Error(BAD_SHAPE)
    // 本次向前查询已把游标之前的本地消息取尽：记下来，避免刷新又把 hasMore 置真。
    this.ensurePaging(sessionId).localExhausted = !page.hasMore
    const added = page.messages.length > 0 ? this.mergeMessages(sessionId, page.messages) : 0
    return { hasMore: page.hasMore, added }
  }

  /** 当前窗口最旧消息的排序游标；窗口为空时返回 undefined。 */
  private oldestCursor(sessionId: string): MessageCursor | undefined {
    const current = this.state.messages
    if (current.sessionId !== sessionId) return undefined
    const first = current.items[0]
    if (!first) return undefined
    return { createAt: first.createAt, messageId: first.messageId, id: first.id }
  }

  /** 按 id 去重合并一页消息并保持升序，保留已展开的旧窗口；返回本次真正新增的条数。 */
  private mergeMessages(sessionId: string, incoming: readonly ChatMessage[]): number {
    const current = this.state.messages
    if (current.sessionId !== sessionId) return 0
    const merged = mergeMessageWindow(current.items, incoming)
    // 合并只增不减（旧窗口保留），因此长度差即本次真正新增（去重后）的条数。
    const added = Math.max(0, merged.length - current.items.length)
    this.patchMessages(sessionId, { items: merged })
    return added
  }

  /** 只更新仍属于该会话的消息状态，避免切换会话后旧请求写回。 */
  private patchMessages(sessionId: string, partial: Partial<MessagesState>): void {
    const current = this.state.messages
    if (current.sessionId !== sessionId) return
    this.patch({ messages: { ...current, ...partial } })
  }

  private ensurePaging(sessionId: string): PagingBook {
    let book = this.paging.get(sessionId)
    if (!book) {
      book = { serverCursor: undefined, serverHasMore: true, localExhausted: false }
      this.paging.set(sessionId, book)
    }
    return book
  }

  private isOlderStale(epoch: number, sessionId: string): boolean {
    return this.disposed || this.sessionEpoch !== epoch || this.state.selectedId !== sessionId
  }

  private toSyncState(result: unknown, sessionId: string | null): SyncState {
    if (!isRecord(result) || typeof result['ok'] !== 'boolean') {
      return this.failedSync(BAD_SHAPE, sessionId)
    }
    const added = typeof result['added'] === 'number' ? result['added'] : 0
    const updated = typeof result['updated'] === 'number' ? result['updated'] : 0
    if (!result['ok']) {
      // 命令本身成功但平台同步失败：必须按失败展示，不能当作「0 条更新」。
      const error = isRecord(result['error']) ? describeSyncError(result['error']) : describeSyncError(undefined)
      return { phase: 'failed', sessionId, added, updated, error, finishedAt: this.now() }
    }
    return { phase: 'ok', sessionId, added, updated, error: null, finishedAt: this.now() }
  }

  private failedSync(error: string, sessionId: string | null): SyncState {
    return { phase: 'failed', sessionId, added: 0, updated: 0, error, finishedAt: this.now() }
  }

  private patch(partial: Partial<ChatCenterState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...partial }
    for (const listener of [...this.listeners]) listener()
  }
}
