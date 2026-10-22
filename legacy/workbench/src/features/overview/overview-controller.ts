import { CommandTypes, EventTypes } from '@fishops/shared'
import type { PublishTask, Task } from '../contracts'
import type { BridgeApi } from '../shared/bridge-api'
import { toErrorView, type ErrorView } from '../shared/error-format'
import { StateStore } from '../shared/state-store'

export const OVERVIEW_EVENTS = [EventTypes.TASK_CHANGED, EventTypes.PUBLISH_TASK_CHANGED,
  EventTypes.CHAT_CONVERSATION_UPDATED, EventTypes.CHAT_MESSAGE_INGESTED,
  EventTypes.CHAT_SYNC_COMPLETED, EventTypes.WORKER_STARTED] as const
export interface OverviewSource<T> {
  value: T | null
  loading: boolean
  error: ErrorView | null
  updatedAt: number | null
}
export type OverviewTask = Task | PublishTask
export interface OverviewState {
  productSource: 'feishu' | 'my_published'
  availability: 'ready' | 'unavailable'
  products: OverviewSource<number>
  conversations: OverviewSource<number>
  tasks: OverviewSource<OverviewTask[]>
  publish: OverviewSource<OverviewTask[]>
  realtimeError: string | null
}
function empty<T>(): OverviewSource<T> {
  return { value: null, loading: false, error: null, updatedAt: null }
}
export function overviewTasks(state: OverviewState): OverviewTask[] {
  // 发布具有独立的持久化存储，以 PUBLISH_LIST 为准，避免历史兼容数据重复。
  return [...(state.tasks.value ?? []).filter((task) => task.type !== 'publish'),
    ...(state.publish.value ?? [])].sort((a, b) => b.updatedAt - a.updatedAt)
}
export function taskCounts(state: OverviewState): { running: number; failed: number } | null {
  if (state.tasks.value === null || state.publish.value === null) return null
  const tasks = overviewTasks(state)
  return { running: tasks.filter((task) => task.status === 'running').length,
    failed: tasks.filter((task) => task.status === 'failed').length }
}
/** 概览仅读取存储；各来源独立刷新，事件合并后再读取全量快照。 */
export class OverviewController extends StateStore<OverviewState> {
  private readonly api: BridgeApi | null
  private started = false
  private sequence = { products: 0, conversations: 0, tasks: 0, publish: 0 }
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(api: BridgeApi | null) {
    super({ productSource: 'feishu', availability: api ? 'ready' : 'unavailable', products: empty(),
      conversations: empty(), tasks: empty(), publish: empty(), realtimeError: null })
    this.api = api
  }
  start(): void {
    if (this.started || this.disposed || !this.api) return
    this.started = true
    try {
      for (const event of OVERVIEW_EVENTS) this.track(this.api.on(event, () => this.scheduleRefresh()))
    } catch (error) {
      this.patch({ realtimeError: `实时更新不可用：${toErrorView(error).title}` })
    }
    void this.refresh()
  }
  resubscribe(): void {
    if (!this.api || this.disposed) return
    try { this.api.resubscribe(); this.patch({ realtimeError: null }); this.scheduleRefresh() }
    catch (error) { this.patch({ realtimeError: toErrorView(error).title }) }
  }
  private scheduleRefresh(): void {
    if (this.disposed || this.timer !== null) return
    // 立即使在途旧响应失效，避免事件后的状态被旧快照覆盖。
    for (const key of Object.keys(this.sequence) as Array<keyof typeof this.sequence>) this.sequence[key]++
    this.timer = setTimeout(() => { this.timer = null; void this.refresh(false) }, 300)
  }
  async refresh(forceRefresh = true): Promise<void> {
    if (!this.api || this.disposed) return
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
    const api = this.api
    await Promise.all([
      this.load('products', () => this.loadProductCount(forceRefresh)),
      this.load('conversations', async () => {
        const result = await api.call(CommandTypes.CHAT_LIST_CONVERSATIONS, {})
        if (!Array.isArray(result.conversations) || result.conversations.some((item) =>
          !Number.isFinite(item.unreadCount) || item.unreadCount < 0)) throw new Error('会话数据格式不正确')
        return result.conversations.filter((item) => item.unreadCount > 0).length
      }),
      this.load('tasks', async () => {
        // 不传 limit：该接口没有 total，截断后不能用于全量统计。
        const result = await api.call(CommandTypes.TASK_LIST, { sortBy: 'updatedAt', sortOrder: 'desc' })
        return this.validateTasks(result.tasks)
      }),
      this.load('publish', async () => {
        const result = await api.call(CommandTypes.PUBLISH_LIST, { sortBy: 'updatedAt', sortOrder: 'desc' })
        const tasks = this.validateTasks(result.tasks)
        if (result.total !== tasks.length) throw new Error('发布任务数据不完整')
        return tasks
      }),
    ])
  }
  /** 点击未读入口时读取最新会话，选择最近未读；已全部读完返回 null。 */
  async getLatestUnreadSessionId(): Promise<string | null> {
    if (!this.api || this.disposed) return null
    const result = await this.api.call(CommandTypes.CHAT_LIST_CONVERSATIONS, {})
    if (this.disposed) return null
    if (!Array.isArray(result.conversations) || result.conversations.some(c =>
      !Number.isFinite(c.unreadCount) || c.unreadCount < 0)) throw new Error('会话数据格式不正确')
    const unread = result.conversations.filter(c => c.unreadCount > 0)
    if (unread.some(c => typeof c.sessionId !== 'string' || !c.sessionId ||
      !Number.isFinite(c.lastMessageTime))) throw new Error('未读会话缺少定位信息')
    return unread.sort((a, b) => b.lastMessageTime - a.lastMessageTime)[0]?.sessionId ?? null
  }
  /** 切换与商品库一致的来源，旧来源计数不得沿用。 */
  async setProductSource(source: 'feishu' | 'my_published'): Promise<void> {
    if (source === this.state.productSource) return
    this.sequence.products++
    this.patch({ productSource: source, products: empty() })
    await this.refresh()
  }
  private async loadProductCount(forceRefresh: boolean): Promise<number> {
    const source = this.state.productSource
    let cursor: string | undefined
    let targetTableId: string | undefined
    let count = 0
    const seen = new Set<string>()
    for (let page = 0; page < 10000; page++) {
      const result = await this.api!.call(CommandTypes.PRODUCT_CATALOG_QUERY, {
        source, pageSize: 100,
        ...(forceRefresh && !cursor ? { forceRefresh: true } : {}),
        ...(cursor ? { cursor, targetTableId } : {}),
      })
      if (this.disposed || source !== this.state.productSource) throw new Error('商品来源已切换')
      if (result.source !== source || !Array.isArray(result.products)) throw new Error('商品目录格式不正确')
      if (result.total !== null) {
        if (!Number.isInteger(result.total) || result.total! < 0) throw new Error('商品数量格式不正确')
        return result.total!
      }
      // 飞书未返回 total 时遍历真实分页；不按 itemId 去重，保持每日表采集记录口径。
      count += result.products.length
      if (!result.hasMore) return count
      if (!result.nextCursor || seen.has(result.nextCursor) || !result.targetTableId ||
        (targetTableId && targetTableId !== result.targetTableId)) throw new Error('商品分页不完整，请刷新重试')
      seen.add(result.nextCursor)
      cursor = result.nextCursor
      targetTableId = result.targetTableId
    }
    throw new Error('商品分页超出读取上限')
  }
  private validateTasks(tasks: OverviewTask[]): OverviewTask[] {
    if (!Array.isArray(tasks) || tasks.some((task) => !task || typeof task.id !== 'string' ||
      !['capture', 'analysis', 'publish'].includes(task.type) || typeof task.status !== 'string' ||
      !Number.isFinite(task.updatedAt))) throw new Error('任务数据格式不正确')
    return tasks
  }
  private async load<K extends 'products' | 'conversations' | 'tasks' | 'publish'>(
    key: K, fetch: () => Promise<NonNullable<OverviewState[K]['value']>>,
  ): Promise<void> {
    const seq = ++this.sequence[key]
    this.patch({ [key]: { ...this.state[key], loading: true, error: null } })
    try {
      const value = await fetch()
      if (this.disposed || seq !== this.sequence[key]) return
      this.patch({ [key]: { value, loading: false, error: null, updatedAt: Date.now() } })
    } catch (error) {
      if (this.disposed || seq !== this.sequence[key]) return
      this.patch({ [key]: { ...this.state[key], loading: false, error: toErrorView(error) } })
    }
  }
  override dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    super.dispose()
  }
}
