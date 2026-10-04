/**
 * 商品库页控制器（P4/P7）。纯 TypeScript，可在 Node 下直接测试。
 *
 * 数据源：
 * - 统一使用后台独立 `CommandTypes.PRODUCT_CATALOG_QUERY` 命令读取两源：
 *   - `feishu`：飞书采集商品库，游标栈（Cursor Stack）模式，下一页使用上一页的 nextCursor，
 *     不前端缓存全部数据，不伪造总页数；
 *   - `my_published`：当前账号官方在售商品库，page 模式（0 开始），启动时预热两源首页，切 Tab 复用缓存；
 * - 手动 `refresh()` 强制刷新当前来源；任务成功后后台刷新缓存，当前显示来源同步重载；暂停不触发刷新；
 * - 切换 Tab 时重置分页、清空关键词与游标栈，通过递增序号 seq 与 Tab 归属比对杜绝旧请求迟到覆盖（Inflight 竞态防护）；
 * - 映射 `CatalogProduct` 到现有 `ProductTableItem`，完整保留 `recordId`、`desc`、`images` 与来源展示模型；
 * - 订阅事件：`TASK_CHANGED`、`WORKER_STARTED`。
 */
import { CommandTypes, EventTypes } from '@fishops/shared'
import type {
  CatalogProduct,
  ProductCatalogQueryPayload,
  ProductCatalogQueryResult,
  ProductOrder,
} from '../contracts'
import type { BridgeApi } from '../shared/bridge-api'
import { toErrorView, type ErrorView } from '../shared/error-format'
import { StateStore, type LoadPhase } from '../shared/state-store'
import {
  mapCatalogProductToTableItem,
  pageInfo,
  type ProductSourceFilter,
  type ProductTab,
  type ProductTableItem,
} from './products-format'

export const PRODUCTS_EVENTS = [EventTypes.TASK_CHANGED, EventTypes.WORKER_STARTED] as const

export interface ProductsQuery {
  keyword: string
  order: ProductOrder
  pageSize: number
  /** 当前页码（从 0 开始） */
  page: number
  /** 兼容旧代码，若有使用。 */
  source?: ProductSourceFilter
}

export interface ProductsState {
  availability: 'unavailable' | 'ready'
  /** 当前激活的 Tab（默认 'feishu'，次项 'my_published'）。 */
  tab: ProductTab
  query: ProductsQuery
  result: {
    phase: LoadPhase
    items: ProductTableItem[]
    /** 真实总条数：仅在后端返回真实非负数值时有效；未返回时为 undefined，绝不伪造总页数 */
    total?: number
    /** 是否有更多数据 */
    hasMore: boolean
    /** 下一页游标 Token */
    nextPageToken?: string
    /** 飞书数据源目标数据表 ID（供后续发布流程精确使用） */
    targetTableId?: string
    /** 飞书数据是否被后端截断（兼容旧标记） */
    truncated?: boolean
    /** 非致命告警（如部分商品详情补齐失败提示） */
    warnings: string[]
    error: ErrorView | null
    refreshing: boolean
    /** 这批数据对应的查询与 Tab（用于导出文件的说明与界面展示）。 */
    queriedWith: { tab: ProductTab; query: ProductsQuery } | null
    queriedAt: number | null
  }
  /** 飞书数据源是否未配置或配置缺失（用于 UI 直接给出去设置的引导）。 */
  isConfigMissing: boolean
  /** 采集任务有新进展（完成或更新）但尚未刷新商品库。 */
  hasNewCapture: boolean
  /** 是否允许翻上一页 */
  canPrev: boolean
  /** 是否允许翻下一页 */
  canNext: boolean
}

export interface ProductsControllerOptions {
  api: BridgeApi | null
  now?: () => number
}

const BAD_SHAPE = '扩展返回的数据格式不正确'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 识别飞书错误是否因未配置或缺少关键凭证导致。 */
function isFeishuConfigMissingError(message: string): boolean {
  return (
    message.includes('缺少') ||
    message.includes('未配置') ||
    message.includes('未找到数据源') ||
    message.includes('spreadsheetToken') ||
    message.includes('productTableId') ||
    message.includes('CONFIG_MISSING') ||
    message.includes('INVALID_PARAM')
  )
}

export function createInitialProductsState(availability: ProductsState['availability']): ProductsState {
  return {
    availability,
    tab: 'feishu',
    query: { keyword: '', order: 'captureTimeDesc', pageSize: 20, page: 0, source: 'my_published' },
    result: {
      phase: 'idle',
      items: [],
      total: undefined,
      hasMore: false,
      nextPageToken: undefined,
      targetTableId: undefined,
      truncated: false,
      warnings: [],
      error: null,
      refreshing: false,
      queriedWith: null,
      queriedAt: null,
    },
    isConfigMissing: false,
    hasNewCapture: false,
    canPrev: false,
    canNext: false,
  }
}

export class ProductsController extends StateStore<ProductsState> {
  private readonly api: BridgeApi | null
  private readonly now: () => number
  private started = false
  private seq = 0
  /** 当前飞书 Tab 绑定的目标商品表 ID（首请求无，返回后绑定；后续翻页带入以防漂移；换筛选或刷新清空） */
  private boundTargetTableId: string | undefined = undefined
  /**
   * 飞书游标栈（Cursor Stack）：
   * 下标 index 对应页码（从 0 开始）；
   * cursorStack[0] 恒为 undefined（首页）；
   * cursorStack[pageIndex + 1] 保存上一页响应中的 nextCursor。
   */
  private cursorStack: Array<string | undefined> = [undefined]

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
          const confirmedPublish =
            task['type'] === 'publish' &&
            task['status'] === 'completed' &&
            isRecord(task['result']) &&
            task['result']['confirmationStatus'] === 'confirmed'
          if (!((task['type'] === 'capture' && task['status'] === 'completed') || confirmedPublish)) return
          if (task['type'] === 'capture') this.patch({ hasNewCapture: true })
          if (this.state.tab === 'my_published' && confirmedPublish) void this.reloadAfterTaskChange('my_published')
          if (this.state.tab === 'feishu' && task['type'] === 'capture') void this.reloadAfterTaskChange('feishu')
        }),
      )
    } catch {
      // 事件订阅失败不影响手动刷新。
    }
    // 只在商品库页挂载时异步预热，不启动采集或发布任务。
    void this.preloadCatalogs()
    void this.load(false, undefined, false)
  }

  private async preloadCatalogs(): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    await Promise.allSettled([
      api.call(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'feishu', pageSize: 20, order: 'captureTimeDesc' }),
      api.call(CommandTypes.PRODUCT_CATALOG_QUERY, { source: 'my_published', pageSize: 20, page: 0, order: 'captureTimeDesc' }),
    ])
  }

  private async reloadAfterTaskChange(source: ProductTab): Promise<void> {
    await Promise.resolve()
    if (this.disposed) return
    if (this.state.tab === source) await this.load(true, undefined, false)
    else {
      await this.api?.call(CommandTypes.PRODUCT_CATALOG_QUERY, {
        source: source === 'feishu' ? 'feishu' : 'my_published',
        pageSize: this.state.query.pageSize,
        order: this.state.query.order,
        ...(source === 'my_published' ? { page: 0 } : {}),
      }).catch(() => {})
    }
  }

  resubscribe(): void {
    if (this.disposed || !this.api) return
    try {
      this.api.resubscribe()
    } catch {
      // 忽略：用户仍可手动刷新。
    }
  }

  /**
   * 刷新当前 Tab 数据。
   * 重置游标栈并重新加载第一页真实数据，forceRefresh = true 强制后端重建/重拉缓存。
   */
  refresh(): Promise<void> {
    this.resetCursorStack()
    this.patch({
      query: { ...this.state.query, page: 0 },
      canPrev: false,
    })
    return this.load(false, undefined, true)
  }

  /**
   * 切换菜单 Tab（默认「飞书采集的商品库」，次项「自己发布的商品库」）。
   * 切换时重置游标栈、清空关键词与分页，并复用后台缓存。
   */
  setTab(tab: ProductTab): Promise<void> {
    if (tab === this.state.tab) return Promise.resolve()
    const token = ++this.seq
    this.resetCursorStack()
    this.patch({
      tab,
      isConfigMissing: false,
      query: { ...this.state.query, keyword: '', page: 0 },
      result: {
        phase: 'idle',
        items: [],
        total: undefined,
        hasMore: false,
        nextPageToken: undefined,
        targetTableId: undefined,
        truncated: false,
        warnings: [],
        error: null,
        refreshing: false,
        queriedWith: null,
        queriedAt: null,
      },
      canPrev: false,
      canNext: false,
    })
    return this.load(false, token, false)
  }

  /**
   * 应用新的搜索关键字：
   * 严格重置游标栈，回到第一页，forceRefresh = false。
   */
  search(keyword: string): Promise<void> {
    const trimmed = keyword.trim()
    if (trimmed === this.state.query.keyword) return Promise.resolve()
    this.resetCursorStack()
    this.patch({
      query: { ...this.state.query, keyword: trimmed, page: 0 },
      canPrev: false,
    })
    return this.load(false, undefined, false)
  }

  /**
   * 切换排序：
   * 严格重置游标栈，回到第一页，forceRefresh = false。
   */
  setOrder(order: ProductOrder): Promise<void> {
    if (order === this.state.query.order) return Promise.resolve()
    this.resetCursorStack()
    this.patch({
      query: { ...this.state.query, order, page: 0 },
      canPrev: false,
    })
    return this.load(false, undefined, false)
  }

  /** 兼容保留：切换商品来源过滤。 */
  setSource(source: ProductSourceFilter): Promise<void> {
    if (source === 'my_published') {
      return this.setTab('my_published')
    }
    return this.setTab('feishu')
  }

  /**
   * 修改每页条数：
   * 严格重置游标栈，回到第一页，forceRefresh = false。
   */
  setPageSize(pageSize: number): Promise<void> {
    if (pageSize === this.state.query.pageSize) return Promise.resolve()
    this.resetCursorStack()
    this.patch({
      query: { ...this.state.query, pageSize, page: 0 },
      canPrev: false,
    })
    return this.load(false, undefined, false)
  }

  /**
   * 翻上一页（基于游标栈回退或 page - 1）。
   */
  prevPage(): Promise<void> {
    if (!this.state.canPrev || this.state.query.page <= 0) return Promise.resolve()
    const targetPage = this.state.query.page - 1
    this.patch({ query: { ...this.state.query, page: targetPage } })
    return this.load(false, undefined, false)
  }

  /**
   * 翻下一页（基于游标栈前进或 page + 1）。
   */
  nextPage(): Promise<void> {
    if (!this.state.canNext) return Promise.resolve()
    const targetPage = this.state.query.page + 1
    this.patch({ query: { ...this.state.query, page: targetPage } })
    return this.load(false, undefined, false)
  }

  /**
   * 跳转到指定页（兼容旧调用与组件接口）。
   */
  goToPage(page: number): Promise<void> {
    if (page === this.state.query.page || page < 0) return Promise.resolve()

    if (this.state.tab === 'feishu') {
      // 飞书游标栈模式：仅允许在已知游标范围内跳转
      if (page > this.state.query.page && (!this.state.result.hasMore || !this.cursorStack[page])) {
        return Promise.resolve()
      }
      this.patch({ query: { ...this.state.query, page } })
      return this.load(false, undefined, false)
    }

    // 自己发布库：基于 offset / page 的分页
    const total = this.state.result.total ?? 0
    const info = pageInfo(total, this.state.query.pageSize, page)
    if (info.page === this.state.query.page && this.state.result.phase === 'ready') return Promise.resolve()
    this.patch({ query: { ...this.state.query, page: info.page } })
    return this.load(false, undefined, false)
  }

  /** 重置游标栈与绑定的目标表 ID（换筛选/刷新/切换 Tab 时调用，杜绝混页与游标污染） */
  private resetCursorStack(): void {
    this.cursorStack = [undefined]
    this.boundTargetTableId = undefined
  }

  /**
   * 核心加载逻辑：使用统一的 CommandTypes.PRODUCT_CATALOG_QUERY 命令。
   *
   * @param silent 是否静默加载（已有数据刷新时）
   * @param explicitToken 可选的外部递增序号（切换 Tab 时显式传入）
   * @param forceRefresh 是否强制刷新底层数据源
   */
  private async load(silent: boolean, explicitToken?: number, forceRefresh = false): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    const token = explicitToken ?? ++this.seq
    const activeTab = this.state.tab
    const query = this.state.query
    const current = this.state.result
    const hadData = current.phase === 'ready' && current.items.length > 0

    if (!hadData) {
      this.patch({ result: { ...current, phase: 'loading', error: null, refreshing: false } })
    } else if (!silent) {
      this.patch({ result: { ...current, refreshing: true } })
    }

    try {
      const payload: ProductCatalogQueryPayload = {
        source: activeTab === 'feishu' ? 'feishu' : 'my_published',
        pageSize: query.pageSize,
        ...(query.keyword ? { keyword: query.keyword } : {}),
        ...(query.order ? { order: query.order } : {}),
        ...(forceRefresh ? { forceRefresh: true } : {}),
      }

      if (activeTab === 'feishu') {
        const cursor = this.cursorStack[query.page]
        if (cursor) {
          payload.cursor = cursor
          if (this.boundTargetTableId) {
            payload.targetTableId = this.boundTargetTableId
          }
        }
      } else {
        payload.page = query.page
      }

      const res = (await api.call(
        CommandTypes.PRODUCT_CATALOG_QUERY,
        payload,
      )) as ProductCatalogQueryResult

      // inflight 竞态防护：如果已销毁，或 token 已被新请求超越，或 Tab 已被切换，则绝对丢弃迟到的响应
      if (this.disposed || token !== this.seq || activeTab !== this.state.tab) return

      if (!isRecord(res) || !Array.isArray(res.products)) {
        throw new Error(BAD_SHAPE)
      }

      const targetTableId = typeof (res as any).targetTableId === 'string' ? (res as any).targetTableId : undefined

      // Target Mismatch 防护：后台返回目标与当前不一致不接受 rows，提示刷新不混页
      if (this.boundTargetTableId && targetTableId && targetTableId !== this.boundTargetTableId) {
        this.patch({
          canNext: false,
          canPrev: query.page > 0,
          result: {
            ...this.state.result,
            phase: 'error',
            items: [], // 不接受这批 rows，严禁跨表混页
            error: {
              title: '飞书目标商品表已发生变更',
              hint: `飞书目标商品表已发生变更（当前绑定的目标表 ${this.boundTargetTableId} 与后台最新返回的目标表 ${targetTableId} 不一致）。为防止混淆不同表格数据，本次加载已被拦截，请刷新重新读取。`,
              detail: '',
              kind: 'platform',
              code: 'TARGET_TABLE_MISMATCH',
            },
            refreshing: false,
          },
        })
        return
      }

      // 首请求返回目标表时绑定
      if (!this.boundTargetTableId && targetTableId) {
        this.boundTargetTableId = targetTableId
      }

      const items = res.products.map((item: CatalogProduct) => mapCatalogProductToTableItem(item))
      const hasMore = Boolean(res.hasMore)
      const nextCursor = typeof res.nextCursor === 'string' && res.nextCursor.trim() ? res.nextCursor.trim() : undefined

      // 飞书游标栈记录下一页游标
      if (activeTab === 'feishu' && hasMore && nextCursor) {
        this.cursorStack[query.page + 1] = nextCursor
      }

      // 真实 total：仅当后端返回真实非负数值时使用，未返回为 undefined，绝不假造总页数
      const realTotal = typeof res.total === 'number' && Number.isFinite(res.total) && res.total >= 0 ? res.total : undefined

      const canPrev = query.page > 0
      const canNext = hasMore
      const warnings = Array.isArray(res.warnings) ? res.warnings : []

      this.patch({
        isConfigMissing: false,
        hasNewCapture: false,
        canPrev,
        canNext,
        result: {
          phase: 'ready',
          items,
          total: realTotal,
          hasMore,
          nextPageToken: nextCursor,
          targetTableId: targetTableId ?? this.boundTargetTableId,
          truncated: false,
          warnings,
          error: null,
          refreshing: false,
          queriedWith: { tab: activeTab, query: { ...query } },
          queriedAt: this.now(),
        },
      })
    } catch (error) {
      // inflight 竞态防护：如果已销毁，或 token 已被新请求超越，或 Tab 已被切换，则绝对丢弃迟到的响应
      if (this.disposed || token !== this.seq || activeTab !== this.state.tab) return
      const latest = this.state.result
      const errView = toErrorView(error)
      const errText = `${errView.title} ${errView.detail} ${errView.code} ${String(error)}`
      const isMissing = isFeishuConfigMissingError(errText)
      this.patch({
        isConfigMissing: activeTab === 'feishu' && isMissing,
        canPrev: query.page > 0,
        canNext: false,
        result: {
          ...latest,
          phase: hadData ? 'ready' : 'error',
          items: hadData ? latest.items : [],
          error: errView,
          refreshing: false,
        },
      })
    }
  }
}
