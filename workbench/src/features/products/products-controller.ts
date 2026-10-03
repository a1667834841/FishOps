/**
 * 商品库页控制器（P4）。纯 TypeScript，可在 Node 下直接测试。
 *
 * 使用的命令：`PRODUCT_LIST`（只读）；
 * 订阅事件：`TASK_CHANGED`（仅用于提示「有新的采集结果」，不自动刷新）、`WORKER_STARTED`。
 *
 * 关键约束（均有单测）：
 * - 每次查询带递增令牌，旧响应（含已切换关键字 / 排序 / 页码之后返回的）一律丢弃；
 * - 失败时若已有数据则保留旧数据并附带错误，没有数据则进入 error 状态，不会把空列表当成「没有商品」；
 * - 页码在总数变小后会自动回退到最后一页并重新查询；
 * - CSV 导出的数据只来自 `result.items`（当前页已查询到的商品）。
 */
import { CommandTypes, EventTypes } from '@fishops/shared'
import type { Product, ProductOrder } from '../contracts'
import type { BridgeApi } from '../shared/bridge-api'
import { toErrorView, type ErrorView } from '../shared/error-format'
import { StateStore, type LoadPhase } from '../shared/state-store'
import { pageInfo, type ProductSourceFilter } from './products-format'

export const PRODUCTS_EVENTS = [EventTypes.TASK_CHANGED, EventTypes.WORKER_STARTED] as const

export interface ProductsQuery {
  keyword: string
  order: ProductOrder
  pageSize: number
  /** 从 0 开始。 */
  page: number
  /** 商品来源过滤（默认 'my_published'，只看当前账号发布商品）。 */
  source: ProductSourceFilter
}

export interface ProductsState {
  availability: 'unavailable' | 'ready'
  query: ProductsQuery
  result: {
    phase: LoadPhase
    items: Product[]
    total: number
    error: ErrorView | null
    refreshing: boolean
    /** 这批数据对应的查询（用于导出文件的说明与界面展示）。 */
    queriedWith: ProductsQuery | null
    queriedAt: number | null
  }
  /** 采集任务有新进展（完成或更新）但尚未刷新商品库。 */
  hasNewCapture: boolean
}

export interface ProductsControllerOptions {
  api: BridgeApi | null
  now?: () => number
}

const BAD_SHAPE = '扩展返回的数据格式不正确'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isProduct(value: unknown): value is Product {
  return (
    isRecord(value) &&
    typeof value['itemId'] === 'string' &&
    typeof value['title'] === 'string' &&
    typeof value['wantCnt'] === 'number'
  )
}

export function createInitialProductsState(availability: ProductsState['availability']): ProductsState {
  return {
    availability,
    query: { keyword: '', order: 'captureTimeDesc', pageSize: 20, page: 0, source: 'my_published' },
    result: { phase: 'idle', items: [], total: 0, error: null, refreshing: false, queriedWith: null, queriedAt: null },
    hasNewCapture: false,
  }
}

export class ProductsController extends StateStore<ProductsState> {
  private readonly api: BridgeApi | null
  private readonly now: () => number
  private started = false
  private seq = 0

  constructor(options: ProductsControllerOptions) {
    super(createInitialProductsState(options.api ? 'ready' : 'unavailable'))
    this.api = options.api
    this.now = options.now ?? (() => Date.now())
  }

  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    const api = this.api
    if (!api) return
    try {
      this.track(
        api.on(EventTypes.TASK_CHANGED, (payload) => {
          if (this.disposed || !isRecord(payload) || !isRecord(payload['task'])) return
          const task = payload['task']
          if (task['type'] !== 'capture') return
          // 只有进入终态（完成）或暂停时才提示，避免每页进度都打扰。
          if (task['status'] === 'completed' || task['status'] === 'paused') this.patch({ hasNewCapture: true })
        }),
      )
    } catch {
      // 事件订阅失败不影响手动刷新。
    }
    void this.load(false)
  }

  resubscribe(): void {
    if (this.disposed || !this.api) return
    try {
      this.api.resubscribe()
    } catch {
      // 忽略：用户仍可手动刷新。
    }
  }

  refresh(): Promise<void> {
    return this.load(false)
  }

  /** 应用新的关键字，回到第一页。 */
  search(keyword: string): Promise<void> {
    this.patch({ query: { ...this.state.query, keyword: keyword.trim(), page: 0 } })
    return this.load(false)
  }

  setOrder(order: ProductOrder): Promise<void> {
    if (order === this.state.query.order) return Promise.resolve()
    this.patch({ query: { ...this.state.query, order, page: 0 } })
    return this.load(false)
  }

  setSource(source: ProductSourceFilter): Promise<void> {
    if (source === this.state.query.source) return Promise.resolve()
    this.patch({ query: { ...this.state.query, source, page: 0 } })
    return this.load(false)
  }

  setPageSize(pageSize: number): Promise<void> {
    if (pageSize === this.state.query.pageSize) return Promise.resolve()
    this.patch({ query: { ...this.state.query, pageSize, page: 0 } })
    return this.load(false)
  }

  goToPage(page: number): Promise<void> {
    const info = pageInfo(this.state.result.total, this.state.query.pageSize, page)
    if (info.page === this.state.query.page && this.state.result.phase === 'ready') return Promise.resolve()
    this.patch({ query: { ...this.state.query, page: info.page } })
    return this.load(false)
  }

  private async load(silent: boolean): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    const token = ++this.seq
    const query = this.state.query
    const current = this.state.result
    const hadData = current.phase === 'ready'
    if (!hadData) {
      this.patch({ result: { ...current, phase: 'loading', error: null, refreshing: false } })
    } else if (!silent) {
      this.patch({ result: { ...current, refreshing: true } })
    }
    try {
      const result = await api.call(CommandTypes.PRODUCT_LIST, {
        ...(query.keyword ? { keyword: query.keyword } : {}),
        limit: query.pageSize,
        offset: query.page * query.pageSize,
        order: query.order,
        source: query.source,
      })
      if (this.disposed || token !== this.seq) return
      if (!isRecord(result) || !Array.isArray(result.products) || !result.products.every(isProduct) || typeof result.total !== 'number') {
        throw new Error(BAD_SHAPE)
      }
      // 总数变小导致当前页越界：回退到最后一页重新查询，而不是展示空页。
      const info = pageInfo(result.total, query.pageSize, query.page)
      if (result.products.length === 0 && result.total > 0 && info.page !== query.page) {
        this.patch({ query: { ...this.state.query, page: info.page } })
        await this.load(true)
        return
      }
      this.patch({
        hasNewCapture: false,
        result: {
          phase: 'ready',
          items: result.products,
          total: result.total,
          error: null,
          refreshing: false,
          queriedWith: query,
          queriedAt: this.now(),
        },
      })
    } catch (error) {
      if (this.disposed || token !== this.seq) return
      const latest = this.state.result
      this.patch({
        result: {
          ...latest,
          phase: hadData ? 'ready' : 'error',
          items: hadData ? latest.items : [],
          error: toErrorView(error),
          refreshing: false,
        },
      })
    }
  }
}
