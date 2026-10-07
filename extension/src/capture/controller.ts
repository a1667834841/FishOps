import type { CaptureFeishuSyncResult } from '../../../shared/types/capture'
/**
 * 采集控制器（P4）。
 *
 * 接入 `TaskManager`，串行分页采集闲鱼商品：搜索 → 归一化 → 过滤 → 去重 → 入库（含快照）。
 *
 * 关键设计：
 * - **统一采集队列**：同一时间只执行一个任务；`start` / `resume` 入队后立即返回（仅等待持久化），
 *   暂停 / 取消 / 完成 / 失败后自动调度下一项，杜绝多任务并发采集；
 * - **搜索专用间隔**：搜索请求按「基础间隔 + 均匀随机增量」节流（首页立即），取消固定 1500ms；
 *   既在控制器排队点等待，也把该间隔透传到真实平台调用链；详情等其它请求沿用旧有 1500ms 限速；
 * - **等待可中止**：节流 / 限速等待期间被暂停 / 取消会立即结束等待以释放执行槽，
 *   但**已在途的真实请求不会被抢占**，仍保持串行（绝不并发 inflight）；
 * - **暂停 / 取消的 inflight 竞态保护**：每个 await（搜索、详情、账号读取、入库）之后都重新确认
 *   任务仍处于 running，否则丢弃本页结果、不推进断点；被取消的任务绝不再被写成 completed；
 * - **执行轮次隔离**：每轮 run 持有独立运行态与轮次号，旧轮次绝不覆盖新轮次 / 终态；
 * - **跨轮次去重**：断点保存快照引用，按商品 ID、采集小时和关键字跳过重复观测；
 * - **断点续采**：断点 `nextPage` 写入 `task.meta.capture`，暂停 / 取消 / SW 重启后从该页继续；
 * - **不假成功**：平台不可用时直接失败；所有页面请求都失败时任务置 failed，而非空结果 completed；
 * - **归属不臆断**：只有同时确认当前账号 ID 与商品卖家 ID 且两者一致时才标 my_published；
 *   账号或卖家身份无法确认时一律不标 my_published，并计入 `ownershipUnconfirmed`。
 */
import { PlatformError } from '../platform/errors'
import { createRateLimiter, DEFAULT_MIN_INTERVAL_MS } from '../platform/rate-limit'
import { TaskNotFoundError } from '../../../shared/task/index'
import type { TaskManager } from '../../../shared/task/index'
import {
  DEFAULT_CAPTURE_INTERVAL_MS,
  DEFAULT_CAPTURE_JITTER_MS,
  emptyCaptureStats,
  limitText,
  CAPTURE_LIMITS,
} from '../../../shared/types/capture'
import type {
  CaptureCheckpoint,
  CapturePayload,
  CaptureResult,
} from '../../../shared/types/capture'
import type { Product, ProductListQuery, ProductPage } from '../../../shared/types/product'
import type { Task } from '../../../shared/types/task'
import { passesCaptureFilter } from '../../../shared/capture/filter'
import { buildCaptureDedupeKey } from '../../../shared/data-source/feishu-daily-tables'
import {
  buildProductSnapshot,
  mergeProductImages,
  normalizeDetailPatch,
  normalizeProductsFromSearchPayload,
} from '../../../shared/capture/normalizer'
import type { ProductRepository } from '../../../shared/capture/product-repository'
import { createCapturePacer } from './pacer'

export { DEFAULT_CAPTURE_INTERVAL_MS, DEFAULT_CAPTURE_JITTER_MS }

/**
 * 详情等非搜索请求的限速下限：沿用旧实现的 1500ms，不允许配置得更低。
 * （搜索请求改用「基础间隔 + 随机增量」，见 {@link DEFAULT_CAPTURE_INTERVAL_MS}。）
 */
export const MIN_CAPTURE_INTERVAL_MS = DEFAULT_MIN_INTERVAL_MS

/** 规整搜索基础间隔：非负有限数，否则回退默认值。 */
export function resolveCaptureBaseIntervalMs(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 0) {
    return DEFAULT_CAPTURE_INTERVAL_MS
  }
  return Math.floor(requested)
}

/** 规整搜索随机增量上限：非负有限数，否则回退默认值。 */
export function resolveCaptureJitterMs(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 0) {
    return DEFAULT_CAPTURE_JITTER_MS
  }
  return Math.floor(requested)
}

/** 平台搜索入参。 */
export interface CaptureSearchParams {
  keyword: string
  pageNumber: number
  rowsPerPage: number
  searchFilter?: string
  /**
   * 搜索专用基础间隔（毫秒）。采集搜索固定传 `0`：底层为该请求建立「0 间隔 0 抖动」专用限速器，
   * **绕开全局固定 1500ms**（采集节奏完全由控制器 pacer 统一负责，避免二次等待）。
   */
  minIntervalMs?: number
  /** 搜索专用随机增量上限（毫秒），采集搜索固定传 `0`。 */
  intervalJitterMs?: number
}

/**
 * 平台调用端口（由 background 基于 P3 `platform.search` / `platform.detail` 实现）。
 * 控制器只依赖该接口，便于用 mock 做无网络单测。
 */
export interface CapturePlatform {
  /** 平台层当前是否可用（不可用时不得开始采集）。 */
  isAvailable(): boolean
  /** 搜索一页，返回 MTOP 原始 JSON（不被裁剪）。 */
  search(params: CaptureSearchParams): Promise<unknown>
  /** 商品详情，返回 MTOP 原始 JSON。 */
  detail(itemId: string): Promise<unknown>
  /** 搜索建议（流量词），返回建议词列表（仅查询，不创建任务、不搜索商品）。 */
  suggest(keyword: string): Promise<string[]>
}

export interface CaptureControllerDeps {
  /** 采集结束后同步原始快照；保留 itemIds 参数兼容旧端口，第三参数为真实同步内容。 */
  syncProducts?: (itemIds: string[], shouldContinue: () => Promise<boolean>, products: readonly Product[]) => Promise<CaptureFeishuSyncResult>
  tasks: TaskManager
  platform: CapturePlatform
  repository: ProductRepository
  /** 搜索请求基础间隔（毫秒），默认 {@link DEFAULT_CAPTURE_INTERVAL_MS}。 */
  minIntervalMs?: number
  /** 搜索请求随机增量上限（毫秒），默认 {@link DEFAULT_CAPTURE_JITTER_MS}。 */
  intervalJitterMs?: number
  /** 时间源，默认 `Date.now`。 */
  now?: () => number
  /** 休眠实现，默认 `setTimeout`；测试可注入以便确定性验证限速。 */
  sleep?: (ms: number) => Promise<void>
  /** 均匀随机源，返回 [0,1)，默认 `Math.random`；测试可注入以获得确定性。 */
  random?: () => number
  /** 获取当前登录用户 ID（用于确认商品是否归属当前账号）。 */
  getCurrentUserId?: () => Promise<string | undefined> | string | undefined
}

/** 默认休眠。 */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 单次运行的内部状态：中止标记 + 中止通知（用于及时释放等待中的执行槽）。 */
interface RunState {
  aborted: boolean
  /** 暂停 / 取消时 resolve，用于让正在等待的节流 / 限速尽早结束。 */
  aborted$: Promise<void>
  /** 标记中止（幂等）。 */
  abort: () => void
}

/** 创建运行态。 */
function createRunState(): RunState {
  let resolveAbort: () => void = () => {}
  const aborted$ = new Promise<void>((resolve) => {
    resolveAbort = resolve
  })
  const state: RunState = {
    aborted: false,
    aborted$,
    abort: () => {
      if (state.aborted) return
      state.aborted = true
      resolveAbort()
    },
  }
  return state
}

/** 采集操作收到其他类型的任务时抛出，调用方应按无效入参处理。 */
export class CaptureTaskTypeError extends Error {
  constructor(task: Task) {
    super(`任务类型不匹配：采集操作需要 capture，实际为 ${task.type}（${task.id}）`)
    this.name = 'CaptureTaskTypeError'
  }
}

export class CaptureController {
  private readonly syncProducts?: CaptureControllerDeps['syncProducts']
  private readonly tasks: TaskManager
  private readonly platform: CapturePlatform
  private readonly repository: ProductRepository
  private readonly defaultIntervalMs: number
  private readonly defaultJitterMs: number
  private readonly now: () => number
  private readonly sleep?: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly getCurrentUserId?: () => Promise<string | undefined> | string | undefined

  /** 任务 ID → 运行态；旧轮次据 identity 判断是否仍持有运行权。 */
  private readonly runs = new Map<string, RunState>()
  /** 任务 ID → 轮次号（单调递增），用于隔离旧轮次，避免覆盖新状态。 */
  private readonly generations = new Map<string, number>()
  /** 统一采集队列：同一时间只执行一个任务。 */
  private readonly queue: string[] = []
  /** 已在队列中（不含正在执行）的任务 ID 集合，用于去重。 */
  private readonly queued = new Set<string>()
  /** 当前正在执行的任务 ID；null 表示空闲。 */
  private activeId: string | null = null

  constructor(deps: CaptureControllerDeps) {
    this.syncProducts = deps.syncProducts
    this.tasks = deps.tasks
    this.platform = deps.platform
    this.repository = deps.repository
    this.defaultIntervalMs = deps.minIntervalMs ?? DEFAULT_CAPTURE_INTERVAL_MS
    this.defaultJitterMs = deps.intervalJitterMs ?? DEFAULT_CAPTURE_JITTER_MS
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep
    this.random = deps.random ?? Math.random
    this.getCurrentUserId = deps.getCurrentUserId
  }

  /** 创建采集任务（pending），并写入初始断点。 */
  async create(payload: CapturePayload): Promise<Task> {
    // 摘要：限制关键词长度，避免单个超长字段挤占 chrome.storage.session 容量。
    const keyword = limitText(payload.keyword.trim(), CAPTURE_LIMITS.captureKeywordMaxLength)
    const sanitized: CapturePayload = { ...payload, keyword }
    const startPage = sanitized.startPage ?? 1
    const totalPages = sanitized.pages ?? 1
    const checkpoint: CaptureCheckpoint = {
      keyword,
      startPage,
      totalPages,
      nextPage: startPage,
      pagesCompleted: 0,
      stats: emptyCaptureStats(),
      storedIds: [],
      capturedRecords: [],
    }
    return this.tasks.create({
      type: 'capture',
      payload: { ...sanitized } as unknown as Record<string, unknown>,
      meta: { capture: checkpoint },
    })
  }

  /**
   * 查询流量词（suggest）：空输入不调用平台，直接返回空数组。
   *
   * 结果会去重（大小写不敏感）、限制条数与单条长度；平台不可用时抛
   * `PlatformError('host-unavailable')`，由运行时归一为结构化错误。**不创建采集任务**。
   */
  async suggest(keyword: string, limit?: number): Promise<string[]> {
    const input = limitText(keyword.trim(), CAPTURE_LIMITS.suggestInputMaxLength)
    if (input.length === 0) return []
    if (!this.platform.isAvailable()) {
      throw new PlatformError(
        'host-unavailable',
        '平台层未就绪：请先打开并登录 goofish.com 闲鱼页面，再查询流量词',
      )
    }
    const words = await this.platform.suggest(input)
    return normalizeSuggestWords(words, limit)
  }

  /**
   * 启动一个 pending 任务：入队后立即返回，**只等待持久化、异步执行**。
   * 等待期间任务保持 pending，真正出队执行时才转 running。
   */
  async start(id: string): Promise<Task> {
    const task = await this.requireTask(id)
    if (task.status === 'pending' || task.status === 'paused') {
      this.enqueue(task)
    } else if (task.status === 'running' && this.activeId !== id) {
      // 已处于 running 但未被本控制器执行（例如 adopt / 重启残留）：纳入队列统一调度。
      this.enqueue(task)
    }
    return this.requireTask(id)
  }

  /**
   * 恢复一个 paused 任务：先持久化为 pending 重新排队（保留首次 startedAt），
   * 再入队后立即返回；真正出队执行时才转 running。**不等待整轮采集结束**。
   */
  async resume(id: string): Promise<Task> {
    const task = await this.requireTask(id)
    if (task.status === 'running') {
      if (this.activeId !== id) this.enqueue(task)
      return task
    }
    if (task.status !== 'paused') return task
    const requeued = await this.tasks.requeue(id)
    this.enqueue(task)
    return requeued
  }

  /** 暂停任务：标记停止 + 从队列移除 + 状态流转 running → paused（非 running 时原样返回）。 */
  async pause(id: string, reason?: string): Promise<Task> {
    const task = await this.requireTask(id)
    const run = this.runs.get(id)
    if (run) run.abort()
    this.dequeue(id)
    const next = task.status === 'running' ? await this.tasks.pause(id, reason) : task
    this.pump()
    return next
  }

  /** 取消任务：标记停止 + 从队列移除 + 状态流转为 cancelled（pending / running / paused 均可）。 */
  async cancel(id: string, reason?: string): Promise<Task> {
    await this.requireTask(id)
    const run = this.runs.get(id)
    if (run) run.abort()
    this.dequeue(id)
    const cancelled = await this.tasks.cancel(id, reason)
    this.pump()
    return cancelled
  }

  /** 读取单个任务。 */
  async get(id: string): Promise<Task | null> {
    return this.tasks.getById(id)
  }

  /** 查询商品库。 */
  async listProducts(query?: ProductListQuery): Promise<ProductPage> {
    return this.repository.list(query)
  }

  /**
   * 重新入队所有 pending 采集任务（Service Worker 重启后调用），按 createdAt 升序。
   * running 任务由 `TaskManager.recoverOnStartup` 按既有策略转为 paused，不在此处理。
   */
  async requeuePending(): Promise<void> {
    const pending = await this.tasks.list({ status: 'pending', type: 'capture' })
    pending.sort((a, b) => a.createdAt - b.createdAt)
    for (const task of pending) this.enqueue(task)
  }

  private async requireTask(id: string): Promise<Task> {
    const task = await this.tasks.getById(id)
    if (!task) throw new TaskNotFoundError(id)
    // 采集与分析共用存储，必须在任何状态写入或队列操作之前隔离任务类型。
    if (task.type !== 'capture') throw new CaptureTaskTypeError(task)
    return task
  }

  /** 把任务加入统一队列；已在队列中的任务不重复入队。 */
  private enqueue(task: Task): void {
    if (task.type !== 'capture') throw new CaptureTaskTypeError(task)
    const id = task.id
    if (this.queued.has(id)) return
    this.queued.add(id)
    this.queue.push(id)
    this.pump()
  }

  /** 从等待队列移除任务（不影响正在执行的任务）。 */
  private dequeue(id: string): void {
    if (!this.queued.has(id)) return
    this.queued.delete(id)
    const index = this.queue.indexOf(id)
    if (index >= 0) this.queue.splice(index, 1)
  }

  /** 调度器：空闲时取出队首任务执行；保证同一时间单任务。 */
  private pump(): void {
    if (this.activeId !== null) return
    const id = this.queue.shift()
    if (id === undefined) return
    this.queued.delete(id)
    this.activeId = id
    void this.execute(id)
      .catch((error: unknown) => {
        console.error('[FishOps:Capture] 采集执行异常', error)
      })
      .finally(() => {
        if (this.activeId === id) this.activeId = null
        this.pump()
      })
  }

  /** 执行一个已出队的任务：按当前状态流转到 running 后运行整轮。 */
  private async execute(id: string): Promise<void> {
    let task = await this.tasks.getById(id)
    // 出队时重新读取并复验，避免等待期间存储变化后执行其他类型任务。
    if (!task || task.type !== 'capture') return
    if (task.status === 'pending') {
      task = await this.tasks.start(id)
    } else if (task.status === 'paused') {
      task = await this.tasks.resume(id)
    }
    // 队列等待期间可能已被取消 / 完成；非 running 不再执行。
    if (task.status !== 'running') return
    await this.run(id)
  }

  /** 读取断点：优先沿用 `task.meta.capture`，缺失时按入参重建。 */
  private readCheckpoint(task: Task, payload: CapturePayload): CaptureCheckpoint {
    const meta = task.meta as Record<string, unknown> | undefined
    const existing = meta?.['capture'] as CaptureCheckpoint | undefined
    if (
      existing &&
      typeof existing === 'object' &&
      typeof existing.nextPage === 'number' &&
      typeof existing.totalPages === 'number' &&
      typeof existing.startPage === 'number'
    ) {
      return {
        keyword: typeof existing.keyword === 'string' && existing.keyword ? existing.keyword : payload.keyword,
        startPage: existing.startPage,
        totalPages: existing.totalPages,
        nextPage: existing.nextPage,
        pagesCompleted: typeof existing.pagesCompleted === 'number' ? existing.pagesCompleted : 0,
        stats: existing.stats ? { ...existing.stats } : emptyCaptureStats(),
        // 兼容旧断点：缺失 storedIds 时按空集合处理。
        storedIds: Array.isArray(existing.storedIds)
          ? existing.storedIds.filter((value): value is string => typeof value === 'string')
          : [],
        ...(Array.isArray(existing.capturedRecords) ? { capturedRecords: [...existing.capturedRecords] } : {}),
      }
    }
    const startPage = payload.startPage ?? 1
    return {
      keyword: payload.keyword,
      startPage,
      totalPages: payload.pages ?? 1,
      nextPage: startPage,
      pagesCompleted: 0,
      stats: emptyCaptureStats(),
      storedIds: [],
      capturedRecords: [],
    }
  }

  /** 按任务保存的引用读取固定快照，缺失时拒绝用当前商品内容替代。 */
  private async readCapturedProducts(checkpoint: CaptureCheckpoint): Promise<Product[]> {
    const snapshots = new Map<string, Awaited<ReturnType<ProductRepository['getSnapshots']>>>()
    const products: Product[] = []
    for (const ref of checkpoint.capturedRecords ?? []) {
      if (!snapshots.has(ref.itemId)) snapshots.set(ref.itemId, await this.repository.getSnapshots(ref.itemId))
      const product = snapshots.get(ref.itemId)?.find((snapshot) => snapshot.id === ref.snapshotId)?.product
      if (!product) throw new Error('当次采集快照缺失，请重新采集')
      products.push(structuredClone(product))
    }
    return products
  }

  /** 任务是否应继续运行：未被请求停止，且当前仍处于 running。 */
  private async shouldContinue(id: string, run: RunState): Promise<boolean> {
    if (run.aborted) return false
    const task = await this.tasks.getById(id)
    return task !== null && task.type === 'capture' && task.status === 'running'
  }

  /**
   * 可中止休眠：暂停 / 取消时立即结束等待，及时释放执行槽。
   * 注意只用于**等待**（节流 / 限速），不用于在途请求，保证请求仍串行、不并发。
   */
  private async sleepUnlessAborted(ms: number, run: RunState): Promise<void> {
    if (run.aborted || ms <= 0) return
    const sleep = this.sleep ?? defaultSleep
    await Promise.race([sleep(ms), run.aborted$])
  }

  /** 尽力持久化断点（暂停 / 取消后不推进 nextPage 时用于保存已入库 ID）。 */
  private async persistCheckpoint(id: string, checkpoint: CaptureCheckpoint): Promise<void> {
    try {
      const task = await this.tasks.getById(id)
      if (!task || (task.status !== 'running' && task.status !== 'paused')) return
      await this.tasks.updateProgress(id, task.progress, { capture: checkpoint })
    } catch {
      // 断点持久化失败不覆盖主流程。
    }
  }

  private progressFor(checkpoint: CaptureCheckpoint, endPage: number): number {
    const span = endPage - checkpoint.startPage + 1
    const done = checkpoint.nextPage - checkpoint.startPage
    if (span <= 0) return 100
    return Math.max(0, Math.min(100, Math.round((done / span) * 100)))
  }

  /**
   * 应用详情补丁：图片集合用「已有优先 + 去重保序」合并，绝不用详情覆盖已有图片集合；
   * 其余字段沿用详情权威覆盖（newest-wins）。
   * 封面仅在列表缺失时用详情首图回填：已有封面（来自搜索）绝不被详情覆盖。
   */
  private applyDetailPatch(product: Product, patch: Partial<Product>): void {
    const { images, ...rest } = patch
    Object.assign(product, rest)
    if (images && images.length > 0) {
      product.images = mergeProductImages(product.images, images)
      // 列表无封面时用详情首图回填，避免“有图无封面”；已有封面保持不变。
      if (!product.coverUrl && images[0]) product.coverUrl = images[0]
    }
  }

  /** 执行整轮采集；返回终止时的任务快照。 */
  private async run(id: string): Promise<Task> {
    const runState = createRunState()
    const generation = (this.generations.get(id) ?? 0) + 1
    this.generations.set(id, generation)
    this.runs.set(id, runState)

    // 当前 run 是否仍持有运行权：既要是本轮运行态，也要是最新轮次。
    const owns = (): boolean =>
      this.runs.get(id) === runState && this.generations.get(id) === generation
    const keepGoing = async (): Promise<boolean> => owns() && (await this.shouldContinue(id, runState))

    try {
      // 平台可用性前置校验：不可用直接失败，避免产生“假成功”的空结果。
      if (!this.platform.isAvailable()) {
        throw new PlatformError(
          'host-unavailable',
          '平台层未就绪：请先打开并登录 goofish.com 闲鱼页面，再开始采集',
        )
      }

      const task = await this.requireTask(id)
      const payload = (task.payload ?? {}) as unknown as CapturePayload
      const checkpoint = this.readCheckpoint(task, payload)
      const endPage = checkpoint.startPage + checkpoint.totalPages - 1
      const baseIntervalMs = resolveCaptureBaseIntervalMs(payload.minIntervalMs ?? this.defaultIntervalMs)
      const jitterMs = resolveCaptureJitterMs(payload.intervalJitterMs ?? this.defaultJitterMs)

      // 搜索：基础间隔 + 均匀随机增量（首页立即）；等待可中止以释放执行槽。
      const searchPacer = createCapturePacer({
        baseMs: baseIntervalMs,
        jitterMs,
        now: this.now,
        sleep: (ms) => this.sleepUnlessAborted(ms, runState),
        random: this.random,
      })
      // 详情等非搜索请求：沿用旧有固定 1500ms 限速，独立节流；等待同样可中止。
      const detailLimiter = createRateLimiter({
        minIntervalMs: MIN_CAPTURE_INTERVAL_MS,
        now: this.now,
        sleep: (ms) => this.sleepUnlessAborted(ms, runState),
      })

      // 新断点按采集小时去重，同一任务跨小时可以保留同一商品的新观测。
      const savedProducts = await this.readCapturedProducts(checkpoint)
      const seen = new Set(savedProducts.map((product) => buildCaptureDedupeKey(product.itemId, product.captureTimeMs, product.captureKeyword ?? checkpoint.keyword)))
      const legacyIds = checkpoint.capturedRecords === undefined ? new Set(checkpoint.storedIds ?? []) : new Set<string>()
      let pageFailures = 0
      let detailFailures = 0
      let lastError = ''

      /** 把本轮累计失败并入断点统计（跨轮次保持），并重置本轮计数。 */
      const flushFailures = (): void => {
        if (pageFailures === 0 && detailFailures === 0) return
        checkpoint.stats.pageFailed = (checkpoint.stats.pageFailed ?? 0) + pageFailures
        checkpoint.stats.detailFailed = (checkpoint.stats.detailFailed ?? 0) + detailFailures
        checkpoint.stats.failed = (checkpoint.stats.pageFailed ?? 0) + (checkpoint.stats.detailFailed ?? 0)
        pageFailures = 0
        detailFailures = 0
      }

      for (let page = checkpoint.nextPage; page <= endPage; page += 1) {
        if (!(await keepGoing())) break

        await searchPacer.pace()
        // 等待期间可能被暂停 / 取消，请求前再确认一次。
        if (!(await keepGoing())) break

        let raw: unknown
        try {
          raw = await this.platform.search({
            keyword: checkpoint.keyword,
            pageNumber: page,
            rowsPerPage: payload.rowsPerPage ?? 30,
            // 采集节奏完全由控制器 pacer 负责：底层传 0/0 绕开全局 1500ms 与随机限速，
            // 避免 platform 层叠加二次随机等待 / 跨任务首请求等待。
            minIntervalMs: 0,
            intervalJitterMs: 0,
          })
        } catch (error) {
          // 请求期间可能已被暂停 / 取消：不得再改写状态（尤其不能把 cancelled 改成 paused）。
          if (!(await keepGoing())) return this.requireTask(id)
          pageFailures += 1
          lastError = errorMessage(error)
          flushFailures()
          // 及时持久化失败统计，保证 failed / paused 任务也能在 meta.capture.stats 查看失败计数。
          await this.persistCheckpoint(id, checkpoint)
          const category = platformCategory(error)
          if (category === 'captcha' || category === 'unauthorized' || category === 'token-expired') {
            // 需要人工处理（验证码 / 重新登录）：暂停并保留断点，等待续跑。
            await this.tasks.pause(
              id,
              limitText(`采集中断（${category}）：${lastError}`, CAPTURE_LIMITS.taskErrorMaxLength),
            )
            return await this.requireTask(id)
          }
          // 其它错误（网络 / 业务）继续下一页，与原实现“不中断”一致。
          continue
        }

        // ★ inflight 竞态保护：请求返回后若已被暂停 / 取消，丢弃本页结果、不推进断点。
        if (!(await keepGoing())) break

        const capturedAt = this.now()
        const pageProducts = normalizeProductsFromSearchPayload(raw, capturedAt)
        checkpoint.stats.fetched += pageProducts.length

        let collected: Product[] = []
        for (const product of pageProducts) {
          product.captureKeyword = checkpoint.keyword
          if (!passesCaptureFilter(product, payload.filter)) {
            checkpoint.stats.filtered += 1
            continue
          }
          const observationKey = buildCaptureDedupeKey(product.itemId, capturedAt, checkpoint.keyword)
          if (seen.has(observationKey) || legacyIds.has(product.itemId)) {
            checkpoint.stats.duplicates += 1
            continue
          }
          seen.add(observationKey)
          checkpoint.stats.valid += 1
          collected.push(product)
        }

        // 可选详情采集：串行 + 旧限速；单条失败不致命，单独计数。
        if (payload.fetchDetail) {
          for (const product of collected) {
            if (!(await keepGoing())) break
            try {
              await detailLimiter.acquire()
              if (!(await keepGoing())) break
              const detailRaw = await this.platform.detail(product.itemId)
              // ★ 详情返回后再确认运行权，避免暂停 / 取消后写入旧轮次。
              if (!(await keepGoing())) break
              this.applyDetailPatch(product, normalizeDetailPatch(detailRaw))
            } catch (error) {
              if (!(await keepGoing())) break
              detailFailures += 1
              lastError = errorMessage(error)
              flushFailures()
              // 详情失败同样及时持久化统计。
              await this.persistCheckpoint(id, checkpoint)
            }
          }
          // 列表预筛选保持原有请求范围；详情覆盖筛选字段后，只有最终合格商品可以入库。
          // 同时撤销候选阶段的有效计数和去重标记，允许后续页重新采到合格观测。
          collected = collected.filter((product) => {
            if (passesCaptureFilter(product, payload.filter)) return true
            checkpoint.stats.valid -= 1
            checkpoint.stats.filtered += 1
            seen.delete(buildCaptureDedupeKey(product.itemId, capturedAt, checkpoint.keyword))
            return false
          })
        }

        // 账号读取前后都确认运行权，避免暂停后继续标记 / 入库。
        if (!(await keepGoing())) break
        let currentUserId: string | undefined
        try {
          currentUserId = await this.getCurrentUserId?.()
        } catch (error) {
          // 获取账号 ID 失败不得静默降级为「非本人」：明确记录，本轮商品按归属未确认处理。
          console.warn('[FishOps:Capture] 获取当前账号 ID 失败，本轮商品归属未确认：', errorMessage(error))
        }
        if (!(await keepGoing())) break

        // 来源与归属标记：
        // - 只有同时确认「当前登录账号」与「商品卖家」且两者一致时，才归入当前账号商品目录（my_published）；
        // - 能确认卖家身份且卖家不是当前账号 → captured_search（确认的竞品 / 市场商品）；
        // - 无法确认当前账号（获取失败 / 为空）或无法确认卖家身份（缺 sellerId）→ 归属未确认：
        //   一律不标 my_published，并计入 ownershipUnconfirmed，绝不把「未知」静默伪装成「非本人」。
        const ownershipKnown = typeof currentUserId === 'string' && currentUserId.length > 0
        let unconfirmedOwnership = 0
        for (const p of collected) {
          if (ownershipKnown && p.sellerId && p.sellerId === currentUserId) {
            p.source = 'my_published'
            p.status = 'published'
            p.accountId = currentUserId
            p.ownershipUnconfirmed = false
          } else {
            p.source = 'captured_search'
            p.status = 'unconfirmed'
            // 缺卖家身份或账号未知 → 归属未确认（区别于「确认非本人」）。
            const unconfirmed = !ownershipKnown || !p.sellerId
            p.ownershipUnconfirmed = unconfirmed
            // 非当前账号发布：绝不残留账号归属，保证 source / sellerId / accountId 一致。
            delete p.accountId
            if (unconfirmed) unconfirmedOwnership += 1
          }
        }
        checkpoint.stats.ownershipUnconfirmed =
          (checkpoint.stats.ownershipUnconfirmed ?? 0) + unconfirmedOwnership

        const upsert = await this.repository.upsertProducts(collected, capturedAt)
        // 记录已成功入库的 itemId（跨轮次去重），并累加成功入库数量。
        if (collected.length > 0) {
          const storedIds = new Set(checkpoint.storedIds ?? [])
          for (const p of collected) storedIds.add(p.itemId)
          checkpoint.storedIds = [...storedIds]
          checkpoint.capturedRecords ??= []
          for (const product of collected) {
            checkpoint.capturedRecords.push({ itemId: product.itemId, snapshotId: buildProductSnapshot(product, capturedAt).id })
          }
        }
        checkpoint.stats.stored = (checkpoint.stats.stored ?? 0) + upsert.added + upsert.updated

        // upsert 返回后若已暂停 / 取消：持久化已入库 ID（不推进 nextPage），避免本页被跳过。
        if (!(await keepGoing())) {
          await this.persistCheckpoint(id, checkpoint)
          break
        }

        checkpoint.nextPage = page + 1
        checkpoint.pagesCompleted += 1
        await this.tasks.updateProgress(id, this.progressFor(checkpoint, endPage), {
          capture: checkpoint,
        })
      }

      const current = await this.tasks.getById(id)
      if (!current) throw new TaskNotFoundError(id)
      // 已被新一轮运行接管（如暂停后立即恢复）：旧 run 不得再写终态。
      if (!owns()) return current
      // 被暂停 / 取消：不写终态，保留断点。
      if (current.status !== 'running') return current

      // 全任务未成功任何一页、且存在页面失败 → 失败（不假成功）。统计为跨轮次累计。
      if (checkpoint.pagesCompleted === 0 && (checkpoint.stats.pageFailed ?? 0) > 0) {
        return this.tasks.fail(
          id,
          limitText(lastError || '采集失败：所有页面请求均未成功', CAPTURE_LIMITS.taskErrorMaxLength),
        )
      }

      let feishuSync: CaptureFeishuSyncResult | undefined
      if (this.syncProducts) {
        try {
          // 只从固定快照恢复，不能从按 itemId 合并的最新商品库重建旧任务。
          if ((checkpoint.storedIds ?? []).some((itemId) => !checkpoint.capturedRecords?.some((record) => record.itemId === itemId))) {
            throw new Error('旧任务缺少完整采集快照，无法安全恢复原始数据，请重新采集')
          }
          const products = await this.readCapturedProducts(checkpoint)
          feishuSync = await this.syncProducts(checkpoint.storedIds ?? [], keepGoing, products)
        } catch (error) {
          if (!(await keepGoing())) return this.requireTask(id)
          await this.pause(id, limitText(`采集数据已保存，飞书同步失败：${errorMessage(error)}。修复后点击恢复重试同步`, CAPTURE_LIMITS.taskErrorMaxLength))
          return this.requireTask(id)
        }
        // 飞书请求期间仍可暂停或取消；旧轮次不得覆盖用户操作后的状态。
        if (!(await keepGoing())) return this.requireTask(id)
      }

      const result: CaptureResult = {
        ...(feishuSync === undefined ? {} : { feishuSync }),
        keyword: checkpoint.keyword,
        fetched: checkpoint.stats.fetched,
        valid: checkpoint.stats.valid,
        filtered: checkpoint.stats.filtered,
        duplicates: checkpoint.stats.duplicates,
        failed: checkpoint.stats.failed ?? 0,
        detailFailed: checkpoint.stats.detailFailed ?? 0,
        stored: checkpoint.stats.stored ?? 0,
        pagesCompleted: checkpoint.pagesCompleted,
        nextPage: checkpoint.nextPage,
        ownershipUnconfirmed: checkpoint.stats.ownershipUnconfirmed ?? 0,
        ...(current.startedAt === undefined ? {} : { startedAt: current.startedAt }),
        endedAt: this.now(),
      }
      return this.tasks.complete(id, result)
    } catch (error) {
      // 仅在任务仍处于 running 且未被新一轮接管时才落 failed，避免覆盖暂停 / 取消状态。
      const current = await this.tasks.getById(id).catch(() => null)
      if (current && current.type === 'capture' && owns() && current.status === 'running') {
        return await this.tasks.fail(id, limitText(errorMessage(error), CAPTURE_LIMITS.taskErrorMaxLength))
      }
      if (current) return current
      throw error
    } finally {
      if (this.runs.get(id) === runState) this.runs.delete(id)
    }
  }
}

/** 提取错误文本（保留真实错误，不吞）。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 归一化流量词：丢弃非字符串 / 空白，去重（大小写不敏感，保留首次出现），
 * 单条按 {@link CAPTURE_LIMITS.suggestWordMaxLength} 截断，总条数受
 * `min(limit, suggestMaxWords)` 约束。
 */
export function normalizeSuggestWords(words: unknown, limit?: number): string[] {
  if (!Array.isArray(words)) return []
  const requested =
    typeof limit === 'number' && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : CAPTURE_LIMITS.suggestMaxWords
  const cap = Math.min(requested, CAPTURE_LIMITS.suggestMaxWords)
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of words) {
    if (typeof raw !== 'string') continue
    const word = limitText(raw.trim(), CAPTURE_LIMITS.suggestWordMaxLength)
    if (word.length === 0) continue
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(word)
    if (result.length >= cap) break
  }
  return result
}

/** 归类平台错误（非 PlatformError 一律 unknown）。 */
function platformCategory(error: unknown): PlatformError['category'] | 'unknown' {
  return error instanceof PlatformError ? error.category : 'unknown'
}
