/**
 * 聊天中心控制器（纯 TypeScript，不依赖 Vue / DOM / chrome，可在 Node 下直接测试）。
 *
 * 职责：把 P5 的 5 条只读命令 + 4 个实时事件编排成一份可订阅的页面状态。
 *
 * 关键约束（均有对应单测）：
 * - 本地缓存查询（STATUS / LIST / GET_MESSAGES）可自动触发；
 *   拉取平台数据（SYNC_CONVERSATIONS / SYNC_HISTORY）只能由显式调用触发；
 * - 异步竞态：每类请求带递增令牌，切会话后旧请求的返回一律丢弃，不会覆盖新会话；
 * - 事件只作为「元数据信号」：收到后重新读 store，绝不从事件取正文，也不输出任何日志；
 * - 订阅只在 `start()` 里注册一次，`dispose()` 全部释放；刷新按钮只重新查询，不重新订阅；
 * - 同步 `result.ok === false` 与抛异常同样视为失败并展示；
 * - 绝不发送聊天消息、不调用 AI（P6 才实现）。
 */
import {
  CommandTypes,
  EventTypes,
  type CommandPayloadMap,
  type CommandResultMap,
  type EventPayloadMap,
} from '@fishops/shared'
import { describeError, describeSyncError } from './chat-format'
import type { ChatMessage, ChatStatusResult, Conversation } from './types'

/** 本页面会用到的命令（均为只读）。 */
export type ChatCommandType =
  | typeof CommandTypes.CHAT_STATUS
  | typeof CommandTypes.CHAT_LIST_CONVERSATIONS
  | typeof CommandTypes.CHAT_GET_MESSAGES
  | typeof CommandTypes.CHAT_SYNC_CONVERSATIONS
  | typeof CommandTypes.CHAT_SYNC_HISTORY

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
    messages: { sessionId: null, phase: 'idle', items: [], error: null, refreshing: false },
    socketStatus: null,
    conversationSync: idleSync(),
    historySync: idleSync(),
    realtimeError: null,
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

  /** 手动刷新：只重新查询本地缓存，不拉取平台数据，也不重新订阅。 */
  async refresh(): Promise<void> {
    if (this.disposed || !this.api) return
    const tasks: Promise<void>[] = [this.loadStatus(), this.loadConversations(false)]
    if (this.state.selectedId) tasks.push(this.loadMessages(this.state.selectedId, false))
    await Promise.all(tasks)
  }

  /** 选择会话并读取其本地缓存消息。重复选择同一会话不会重载。 */
  selectSession(sessionId: string): void {
    if (this.disposed || !this.api || !sessionId) return
    if (this.state.selectedId === sessionId) return
    // 先让在途的旧会话请求作废，再切换，避免旧响应在切换瞬间写入。
    this.seq.messages++
    this.patch({
      selectedId: sessionId,
      messages: { sessionId, phase: 'loading', items: [], error: null, refreshing: false },
    })
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
    void Promise.all([this.loadStatus(), this.loadConversations(true)])
  }

  /** 显式同步当前选中会话的历史消息：向平台只读拉取。同一时刻只允许一个历史同步。 */
  async syncHistory(): Promise<void> {
    const sessionId = this.state.selectedId
    if (this.disposed || !this.api || !sessionId || this.state.historySync.phase === 'running') return
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
    void Promise.all(tasks)
  }

  // ---------------- 内部实现 ----------------

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
      this.patch({ messages: { sessionId, phase: 'loading', items: [], error: null, refreshing: false } })
    } else if (!silent) {
      this.patch({ messages: { ...current, refreshing: true } })
    }
    try {
      const result = await api.call(CommandTypes.CHAT_GET_MESSAGES, { sessionId, order: 'asc' })
      // 令牌 + 选中会话双重校验：切会话后返回的旧请求不能覆盖新会话。
      if (this.isStale('messages', token) || this.state.selectedId !== sessionId) return
      const items = parseMessages(result)
      if (!items) throw new Error(BAD_SHAPE)
      this.patch({ messages: { sessionId, phase: 'ready', items, error: null, refreshing: false } })
    } catch (error) {
      if (this.isStale('messages', token) || this.state.selectedId !== sessionId) return
      const latest = this.state.messages
      this.patch({
        messages: {
          sessionId,
          phase: hadData ? 'ready' : 'error',
          items: hadData ? latest.items : [],
          error: describeError(error),
          refreshing: false,
        },
      })
    }
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
