/**
 * 采集控制器（P4）。
 *
 * 接入 `TaskManager`，串行分页采集闲鱼商品：搜索 → 归一化 → 过滤 → 去重 → 入库（含快照）。
 *
 * 关键设计：
 * - **串行 + 限速**：每页（及可选详情）请求前先 `limiter.acquire()`，最小间隔强制不低于 1500ms；
 * - **暂停 / 取消的 inflight 竞态保护**：每个 await 之后重新确认任务仍处于 running，
 *   否则丢弃本页结果、不推进断点；被取消的任务绝不再被写成 completed；
 * - **断点续采**：断点 `nextPage` 写入 `task.meta.capture`，暂停 / 取消 / SW 重启后从该页继续；
 * - **不假成功**：平台不可用时直接失败；所有页面请求都失败时任务置 failed，而非空结果 completed；
 * - **归属不臆断**：只有同时确认当前账号 ID 与商品卖家 ID 且两者一致时才标 my_published；
 *   账号或卖家身份无法确认时一律不标 my_published，并计入 `ownershipUnconfirmed`。
 */
import { PlatformError } from '../platform/errors'
import { createRateLimiter, DEFAULT_MIN_INTERVAL_MS } from '../platform/rate-limit'
import type { RateLimiter } from '../platform/rate-limit'
import { TaskNotFoundError } from '../../../shared/task/index'
import type { TaskManager } from '../../../shared/task/index'
import { emptyCaptureStats, limitText, CAPTURE_LIMITS } from '../../../shared/types/capture'
import type {
  CaptureCheckpoint,
  CapturePayload,
  CaptureResult,
} from '../../../shared/types/capture'
import type { Product, ProductListQuery, ProductPage } from '../../../shared/types/product'
import type { Task } from '../../../shared/types/task'
import { passesCaptureFilter } from '../../../shared/capture/filter'
import { normalizeDetailPatch, normalizeProductsFromSearchPayload } from '../../../shared/capture/normalizer'
import type { ProductRepository } from '../../../shared/capture/product-repository'

/** 采集限速下限：与原 `autoCrawl` 的 1500ms 一致，且不允许配置得更低。 */
export const MIN_CAPTURE_INTERVAL_MS = DEFAULT_MIN_INTERVAL_MS

/** 计算实际使用的请求间隔（强制不低于 {@link MIN_CAPTURE_INTERVAL_MS}）。 */
export function resolveCaptureIntervalMs(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return MIN_CAPTURE_INTERVAL_MS
  return Math.max(MIN_CAPTURE_INTERVAL_MS, Math.floor(requested))
}

/** 平台搜索入参。 */
export interface CaptureSearchParams {
  keyword: string
  pageNumber: number
  rowsPerPage: number
  searchFilter?: string
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
  tasks: TaskManager
  platform: CapturePlatform
  repository: ProductRepository
  /** 期望最小请求间隔（毫秒），会被 {@link resolveCaptureIntervalMs} 抬高到 1500。 */
  minIntervalMs?: number
  /** 时间源，默认 `Date.now`。 */
  now?: () => number
  /** 休眠实现，默认 `setTimeout`；测试可注入以便确定性验证限速。 */
  sleep?: (ms: number) => Promise<void>
  /** 获取当前登录用户 ID（用于确认商品是否归属当前账号）。 */
  getCurrentUserId?: () => Promise<string | undefined> | string | undefined
}

/** 单次运行的内部状态：仅用于标记「已被请求停止」。 */
interface RunState {
  aborted: boolean
}

export class CaptureController {
  private readonly tasks: TaskManager
  private readonly platform: CapturePlatform
  private readonly repository: ProductRepository
  private readonly defaultIntervalMs: number
  private readonly now: () => number
  private readonly sleep?: (ms: number) => Promise<void>
  private readonly getCurrentUserId?: () => Promise<string | undefined> | string | undefined
  private readonly runs = new Map<string, RunState>()

  constructor(deps: CaptureControllerDeps) {
    this.tasks = deps.tasks
    this.platform = deps.platform
    this.repository = deps.repository
    this.defaultIntervalMs = deps.minIntervalMs ?? MIN_CAPTURE_INTERVAL_MS
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep
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

  /** 启动一个 pending 任务并同步等待整轮采集结束；已在运行时直接返回。 */
  async start(id: string): Promise<Task> {
    const task = await this.requireTask(id)
    if (task.status === 'running') return task
    await this.tasks.start(id)
    return this.run(id)
  }

  /** 从断点恢复一个 paused 任务并同步等待本轮结束。 */
  async resume(id: string): Promise<Task> {
    const task = await this.requireTask(id)
    if (task.status === 'running') return task
    await this.tasks.resume(id)
    return this.run(id)
  }

  /** 暂停任务：标记停止 + 状态流转 running → paused（非 running 时原样返回）。 */
  async pause(id: string, reason?: string): Promise<Task> {
    const task = await this.requireTask(id)
    const run = this.runs.get(id)
    if (run) run.aborted = true
    if (task.status === 'running') return this.tasks.pause(id, reason)
    return task
  }

  /** 取消任务：标记停止 + 状态流转为 cancelled（pending / running / paused 均可）。 */
  async cancel(id: string, reason?: string): Promise<Task> {
    await this.requireTask(id)
    const run = this.runs.get(id)
    if (run) run.aborted = true
    return this.tasks.cancel(id, reason)
  }

  /** 读取单个任务。 */
  async get(id: string): Promise<Task | null> {
    return this.tasks.getById(id)
  }

  /** 查询商品库。 */
  async listProducts(query?: ProductListQuery): Promise<ProductPage> {
    return this.repository.list(query)
  }

  private async requireTask(id: string): Promise<Task> {
    const task = await this.tasks.getById(id)
    if (!task) throw new TaskNotFoundError(id)
    return task
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
    }
  }

  /** 任务是否应继续运行：未被请求停止，且当前仍处于 running。 */
  private async shouldContinue(id: string, run: RunState): Promise<boolean> {
    if (run.aborted) return false
    const task = await this.tasks.getById(id)
    return task !== null && task.status === 'running'
  }

  private progressFor(checkpoint: CaptureCheckpoint, endPage: number): number {
    const span = endPage - checkpoint.startPage + 1
    const done = checkpoint.nextPage - checkpoint.startPage
    if (span <= 0) return 100
    return Math.max(0, Math.min(100, Math.round((done / span) * 100)))
  }

  /** 执行整轮采集；返回终止时的任务快照。 */
  private async run(id: string): Promise<Task> {
    const runState: RunState = { aborted: false }
    this.runs.set(id, runState)

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
      const limiter: RateLimiter = createRateLimiter({
        minIntervalMs: resolveCaptureIntervalMs(payload.minIntervalMs ?? this.defaultIntervalMs),
        now: this.now,
        ...(this.sleep ? { sleep: this.sleep } : {}),
      })

      const seen = new Set<string>()
      let pageFailures = 0
      let detailFailures = 0
      let lastError = ''

      for (let page = checkpoint.nextPage; page <= endPage; page += 1) {
        if (!(await this.shouldContinue(id, runState))) break

        await limiter.acquire()
        // 限速等待期间可能被暂停 / 取消，请求前再确认一次。
        if (!(await this.shouldContinue(id, runState))) break

        let raw: unknown
        try {
          raw = await this.platform.search({
            keyword: checkpoint.keyword,
            pageNumber: page,
            rowsPerPage: payload.rowsPerPage ?? 30,
          })
        } catch (error) {
          pageFailures += 1
          lastError = errorMessage(error)
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
        if (!(await this.shouldContinue(id, runState))) break

        const capturedAt = this.now()
        const pageProducts = normalizeProductsFromSearchPayload(raw, capturedAt)
        checkpoint.stats.fetched += pageProducts.length

        const collected: Product[] = []
        for (const product of pageProducts) {
          if (!passesCaptureFilter(product, payload.filter)) {
            checkpoint.stats.filtered += 1
            continue
          }
          if (seen.has(product.itemId)) {
            checkpoint.stats.duplicates += 1
            continue
          }
          seen.add(product.itemId)
          checkpoint.stats.valid += 1
          collected.push(product)
        }

        // 可选详情采集：串行 + 限速；单条失败不致命。
        if (payload.fetchDetail) {
          for (const product of collected) {
            if (!(await this.shouldContinue(id, runState))) break
            try {
              await limiter.acquire()
              if (!(await this.shouldContinue(id, runState))) break
              const detailRaw = await this.platform.detail(product.itemId)
              Object.assign(product, normalizeDetailPatch(detailRaw))
            } catch (error) {
              detailFailures += 1
              lastError = errorMessage(error)
            }
          }
        }

        checkpoint.stats.failed = pageFailures + detailFailures

        // 来源与归属标记：
        // - 只有同时确认「当前登录账号」与「商品卖家」且两者一致时，才归入当前账号商品目录（my_published）；
        // - 能确认卖家身份且卖家不是当前账号 → captured_search（确认的竞品 / 市场商品）；
        // - 无法确认当前账号（获取失败 / 为空）或无法确认卖家身份（缺 sellerId）→ 归属未确认：
        //   一律不标 my_published，并计入 ownershipUnconfirmed，绝不把「未知」静默伪装成「非本人」。
        let currentUserId: string | undefined
        try {
          currentUserId = await this.getCurrentUserId?.()
        } catch (error) {
          // 获取账号 ID 失败不得静默降级为「非本人」：明确记录，本轮商品按归属未确认处理。
          console.warn('[FishOps:Capture] 获取当前账号 ID 失败，本轮商品归属未确认：', errorMessage(error))
        }
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

        await this.repository.upsertProducts(collected, capturedAt)

        checkpoint.nextPage = page + 1
        checkpoint.pagesCompleted += 1
        await this.tasks.updateProgress(id, this.progressFor(checkpoint, endPage), {
          capture: checkpoint,
        })
      }

      const current = await this.tasks.getById(id)
      if (!current) throw new TaskNotFoundError(id)
      // 已被新一轮运行接管（如暂停后立即恢复）：旧run不得再写终态。
      if (this.runs.get(id) !== runState) return current
      // 被暂停 / 取消：不写终态，保留断点。
      if (current.status !== 'running') return current

      if (checkpoint.pagesCompleted === 0 && pageFailures > 0) {
        return this.tasks.fail(
          id,
          limitText(lastError || '采集失败：所有页面请求均未成功', CAPTURE_LIMITS.taskErrorMaxLength),
        )
      }

      const result: CaptureResult = {
        keyword: checkpoint.keyword,
        fetched: checkpoint.stats.fetched,
        valid: checkpoint.stats.valid,
        filtered: checkpoint.stats.filtered,
        duplicates: checkpoint.stats.duplicates,
        failed: pageFailures + detailFailures,
        pagesCompleted: checkpoint.pagesCompleted,
        nextPage: checkpoint.nextPage,
        ownershipUnconfirmed: checkpoint.stats.ownershipUnconfirmed ?? 0,
      }
      return this.tasks.complete(id, result)
    } catch (error) {
      // 仅在任务仍处于 running 且未被新一轮接管时才落 failed，避免覆盖暂停 / 取消状态。
      const current = await this.tasks.getById(id).catch(() => null)
      if (current && this.runs.get(id) === runState && current.status === 'running') {
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
function platformCategory(error: unknown): string {
  return error instanceof PlatformError ? error.category : 'unknown'
}
