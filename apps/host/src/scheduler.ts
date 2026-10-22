import type { ErrorCode } from '../../../packages/protocol/src/index.ts'

/**
 * M2 调度模块。同一 host 的所有平台请求共用一个在途槽，账号与类别分别记录最近派发时间，
 * 因此账号切换也不会让旧在途请求与新请求并行。
 *
 * 关键约束：
 * - 时间、定时器与持久化全部注入，测试禁止真实 sleep。
 * - `execute` 只授权一次平台网络请求；槽位只在 `execute` 真实 settle 后归还。
 *   模块内部不设平台超时：HTTP 或业务超时只能结束调用者等待，不得提前释放槽位再发下一个请求。
 * - `maxWaitMs` 只约束排队等待，不约束 `execute` 自身耗时。
 * - `close` 与 `cancelAccount` 只处理仍在排队的项，不影响已开始的 `execute`。
 * - `save` 必须是同步调用。异步持久化会让记录时间落后于真实执行时刻，无法保证间隔不被缩短，
 *   因此模块检测到 `save` 返回 thenable 时会直接失败关闭该次派发。
 */

/** 调度类别；每类有独立的强制最小间隔与随机上限。 */
export type Category = 'search' | 'detail' | 'light' | 'chatRead' | 'chatOpen' | 'chatSend' | 'publish'

/** 各分类的强制最小间隔与随机上限，单位毫秒；调用方只能把下限调大。 */
export const CATEGORY_INTERVAL_MS: Readonly<Record<Category, { minIntervalMs: number; randomSpreadMs: number }>> = {
  search: { minIntervalMs: 1500, randomSpreadMs: 1500 },
  detail: { minIntervalMs: 1500, randomSpreadMs: 1000 },
  light: { minIntervalMs: 1000, randomSpreadMs: 0 },
  chatRead: { minIntervalMs: 300, randomSpreadMs: 0 },
  chatOpen: { minIntervalMs: 30000, randomSpreadMs: 60000 },
  chatSend: { minIntervalMs: 10000, randomSpreadMs: 10000 },
  publish: { minIntervalMs: 300000, randomSpreadMs: 0 },
}

/** 同一账号相邻两次平台请求的强制总间隔，单位毫秒。 */
export const ACCOUNT_INTERVAL_MS = 1000
/** 等待队列长度上限，不含在途请求。 */
export const MAX_WAIT_QUEUE = 100
/** 默认排队等待上限，单位毫秒。 */
export const DEFAULT_MAX_WAIT_MS = 120000
/** 排队等待上限的最大值，单位毫秒。 */
export const MAX_WAIT_MS = 600000

/**
 * 单账号调度快照。
 * 只保存时间戳与预留标记，禁止写入 cookie、正文或任何平台响应内容。
 */
export type SchedulerSnapshot = {
  /** 最近一次开始平台请求的有效时间；null 表示从未派发。 */
  lastStartedAt: number | null
  /** 按类别记录最近一次开始平台请求的有效时间。 */
  categories: Partial<Record<Category, number>>
  /** 非 null 表示存在未确认终结的派发；恢复时必须保守等候完整间隔。 */
  pending: PendingDispatch | null
}

/**
 * 未确认终结的派发预留。
 * 派发前先同步落盘，进程在平台请求期间崩溃时靠它保守恢复；
 * 正常终结后由真实开始时刻覆盖并清除。
 */
export type PendingDispatch = {
  /** 预留对应的调度类别。 */
  category: Category
  /** 预留时的有效时间；只用于诊断，恢复时不作为间隔基准。 */
  reservedAt: number
}

/** `run` 的入队参数。 */
export type RunInput = {
  /** 平台账号 ID；非空字符串且长度不超过 128。 */
  accountId: string
  /** 调度类别。 */
  category: Category
  /** 排队等待上限，单位毫秒，默认 120000，范围 1～600000；只约束排队，不影响 `execute`。 */
  maxWaitMs?: number
  /** 调用方希望的最小间隔，单位毫秒，范围 0～600000；最终取它与分类强制下限的较大值。 */
  minIntervalMs?: number
}

/** 调度器依赖；时间、定时器与持久化全部注入，便于用假时钟测试。 */
export type SchedulerDeps = {
  /** 返回当前有效时间（毫秒）；模块内部会钳制回拨，保证等待不被缩短。 */
  now: () => number
  /** 设定一次性定时器，返回可传给 `clearTimer` 的句柄。 */
  setTimer: (callback: () => void, delayMs: number) => unknown
  /** 清理 `setTimer` 返回的句柄。 */
  clearTimer: (handle: unknown) => void
  /** 读取账号调度快照；返回 null 或 undefined 表示没有历史。 */
  load: (accountId: string) => SchedulerSnapshot | null | undefined | Promise<SchedulerSnapshot | null | undefined>
  /**
   * 同步保存账号调度快照；必须在 `execute` 之前返回，失败则拒绝该次派发且不重试。
   * 禁止返回 Promise：异步写入会让记录时间早于真实执行时刻，破坏间隔下限。
   */
  save: (accountId: string, snapshot: SchedulerSnapshot) => void
  /** 随机源，必须返回 [0,1)；默认 Math.random。 */
  random?: () => number
}

type QueueItem = {
  accountId: string
  category: Category
  /** 入队时的账号取消代次；代次变化说明该项已被 cancelAccount 作废。 */
  epoch: number
  intervalMs: number
  deadlineAt: number
  execute: () => unknown
  signal?: AbortSignal
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type NormalizedRun = {
  accountId: string
  category: Category
  intervalFloorMs: number
  intervalSpreadMs: number
  maxWaitMs: number
}

/** 构造带协议错误码的调度错误，便于上层直接映射 HTTP 状态。 */
function schedulerError(code: ErrorCode, message: string, phase?: 'queue'): Error {
  return phase ? Object.assign(new Error(message), { code, phase }) : Object.assign(new Error(message), { code })
}

/** 统一异常形态；保留原始错误码，否则回退到兜底码。 */
function toError(cause: unknown, fallback: ErrorCode): Error {
  const error = cause instanceof Error ? cause : new Error(typeof cause === 'string' && cause ? cause : '调度依赖失败')
  if (typeof (error as { code?: unknown }).code !== 'string') Object.assign(error, { code: fallback })
  return error
}

const emptySnapshot = (): SchedulerSnapshot => ({ lastStartedAt: null, categories: {}, pending: null })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 严格解析持久化内容。
 * 只有 null/undefined 才代表“无历史”；内容损坏必须抛错并失败关闭，
 * 否则会把未知历史当成无历史，直接放宽间隔。
 * 缺少 `pending` 字段的旧快照按“无预留”迁移，保证升级后仍可读取。
 */
function parseSnapshot(value: unknown): SchedulerSnapshot {
  if (value === null || value === undefined) return emptySnapshot()
  if (!isRecord(value)) throw schedulerError('INTERNAL', '调度快照格式无效')
  const rawLastStartedAt = value.lastStartedAt
  if (rawLastStartedAt !== null && (typeof rawLastStartedAt !== 'number' || !Number.isFinite(rawLastStartedAt))) {
    throw schedulerError('INTERNAL', '调度快照 lastStartedAt 无效')
  }
  const rawCategories = value.categories
  if (!isRecord(rawCategories)) throw schedulerError('INTERNAL', '调度快照 categories 无效')
  const categories: Partial<Record<Category, number>> = {}
  for (const [key, at] of Object.entries(rawCategories)) {
    if (!Object.prototype.hasOwnProperty.call(CATEGORY_INTERVAL_MS, key)) throw schedulerError('INTERNAL', '调度快照含未知类别')
    if (typeof at !== 'number' || !Number.isFinite(at)) throw schedulerError('INTERNAL', '调度快照类别时间无效')
    categories[key as Category] = at
  }
  return { lastStartedAt: rawLastStartedAt, categories, pending: parsePending(value.pending) }
}

/** 解析未确认终结的预留；缺失视为无预留，存在但结构不合法则按损坏处理。 */
function parsePending(value: unknown): PendingDispatch | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)) throw schedulerError('INTERNAL', '调度快照 pending 无效')
  const category = value.category
  if (typeof category !== 'string' || !Object.prototype.hasOwnProperty.call(CATEGORY_INTERVAL_MS, category)) {
    throw schedulerError('INTERNAL', '调度快照 pending 类别无效')
  }
  const reservedAt = value.reservedAt
  if (typeof reservedAt !== 'number' || !Number.isFinite(reservedAt)) throw schedulerError('INTERNAL', '调度快照 pending 时间无效')
  return { category: category as Category, reservedAt }
}

/** 生成派发时间快照；只写时间戳与预留标记，不写入任何平台内容。 */
function snapshotAt(base: SchedulerSnapshot, category: Category, startedAt: number, pending: PendingDispatch | null): SchedulerSnapshot {
  return { lastStartedAt: startedAt, categories: { ...base.categories, [category]: startedAt }, pending }
}

/** 校验并归一化 `run` 入参；非法输入一律 BAD_REQUEST。 */
function normalizeRun(input: RunInput): NormalizedRun {
  if (!isRecord(input)) throw schedulerError('BAD_REQUEST', '调度参数无效')
  const accountId = input.accountId
  if (typeof accountId !== 'string' || accountId.length === 0 || accountId.length > 128) {
    throw schedulerError('BAD_REQUEST', 'accountId 无效')
  }
  const category = input.category
  if (typeof category !== 'string' || !Object.prototype.hasOwnProperty.call(CATEGORY_INTERVAL_MS, category)) {
    throw schedulerError('BAD_REQUEST', 'category 无效')
  }
  const rawMaxWaitMs = input.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  if (typeof rawMaxWaitMs !== 'number' || !Number.isInteger(rawMaxWaitMs) || rawMaxWaitMs < 1 || rawMaxWaitMs > MAX_WAIT_MS) {
    throw schedulerError('BAD_REQUEST', 'maxWaitMs 无效')
  }
  const requestedMinIntervalMs = input.minIntervalMs ?? 0
  if (typeof requestedMinIntervalMs !== 'number' || !Number.isInteger(requestedMinIntervalMs) || requestedMinIntervalMs < 0 || requestedMinIntervalMs > MAX_WAIT_MS) {
    throw schedulerError('BAD_REQUEST', 'minIntervalMs 无效')
  }
  const defaults = CATEGORY_INTERVAL_MS[category as Category]
  return {
    accountId,
    category: category as Category,
    intervalFloorMs: Math.max(requestedMinIntervalMs, defaults.minIntervalMs),
    intervalSpreadMs: defaults.randomSpreadMs,
    maxWaitMs: rawMaxWaitMs,
  }
}

/**
 * M2 调度器。
 * 构造后即可用 `run` 入队；`execute` 只应授权一次平台网络请求，多步业务必须分别入队。
 */
export class Scheduler {
  #deps: SchedulerDeps
  #queue: QueueItem[] = []
  #states = new Map<string, SchedulerSnapshot>()
  #loaded = new Set<string>()
  /** 快照读取失败或内容损坏的账号；失败关闭后不再放行该账号的任何派发。 */
  #failures = new Map<string, Error>()
  /** 账号取消代次；cancelAccount 推进它，使尚未执行平台请求的项作废。 */
  #cancelEpoch = new Map<string, number>()
  #timer: { handle: unknown } | null = null
  #running = false
  #pumping = false
  #repump = false
  #closed = false
  #lastNow = Number.NEGATIVE_INFINITY

  constructor(deps: SchedulerDeps) {
    this.#deps = deps
  }

  /** 仍在排队的项数，不含在途请求。 */
  get pendingCount(): number {
    return this.#queue.length
  }

  /**
   * 排队并执行一次平台请求。
   * @returns `execute` 的返回值；参数非法、队列满、排队超时、账号取消或关闭时以对应错误 reject。
   */
  run<T>(input: RunInput, execute: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#closed) return Promise.reject(schedulerError('EXTENSION_OFFLINE', '扩展已离线，拒绝新的调度请求'))
    if (typeof execute !== 'function') return Promise.reject(schedulerError('BAD_REQUEST', 'execute 必须是函数'))
    let params: NormalizedRun
    let sample: number
    try {
      params = normalizeRun(input)
      sample = this.#sample()
    } catch (error) {
      return Promise.reject(error)
    }
    const failure = this.#failures.get(params.accountId)
    if (failure) return Promise.reject(failure)
    if (this.#queue.length >= MAX_WAIT_QUEUE) return Promise.reject(schedulerError('BAD_REQUEST', '等待队列已满'))
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        accountId: params.accountId,
        category: params.category,
        epoch: this.#epochOf(params.accountId),
        // 随机数在入队时采样一次，后续泵入只读取该值，避免等待抖动。
        intervalMs: params.intervalFloorMs + sample * params.intervalSpreadMs,
        deadlineAt: this.#now() + params.maxWaitMs,
        execute,
        signal,
        resolve: value => resolve(value as T),
        reject,
      })
      this.#pump()
    })
  }

  /**
   * 取消该账号所有仍在排队的项，返回被拒绝的数量。
   * 已在途但尚未发出平台请求的项会在派发检查点被拒绝（异步，不计入返回值）；
   * 已经开始的 `execute` 不受影响，也不会迁移到新账号。
   */
  cancelAccount(accountId: string): number {
    // 先推进取消代次：正在保存快照、尚未执行回调的项也会因此作废。
    this.#cancelEpoch.set(accountId, this.#epochOf(accountId) + 1)
    let cancelled = 0
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const item = this.#queue[index]
      if (item.accountId !== accountId) continue
      this.#queue.splice(index, 1)
      item.reject(schedulerError('ACCOUNT_CHANGED', '账号已切换，排队项取消'))
      cancelled += 1
    }
    if (cancelled > 0) this.#armTimer()
    return cancelled
  }

  /**
   * 关闭调度器：拒绝所有排队项并清理定时器。
   * 已开始的 `execute` 保持原状，不虚假宣称取消已发生的平台请求。
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#clearTimer()
    const pending = this.#queue.splice(0, this.#queue.length)
    for (const item of pending) item.reject(schedulerError('EXTENSION_OFFLINE', '扩展已离线，排队项取消'))
  }

  /** 采样一次随机数；注入源必须落在 [0,1)。 */
  #sample(): number {
    const value = this.#deps.random ? this.#deps.random() : Math.random()
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 1) {
      throw schedulerError('INTERNAL', '随机源必须返回 [0,1) 区间数值')
    }
    return value
  }

  /** 有效时间；系统时钟回拨时保持上一次取值，等待时间不会被缩短。 */
  #now(): number {
    const raw = this.#deps.now()
    if (Number.isFinite(raw) && raw > this.#lastNow) this.#lastNow = raw
    return this.#lastNow
  }

  #accountState(accountId: string): SchedulerSnapshot {
    return this.#states.get(accountId) ?? emptySnapshot()
  }

  /** 该队列项最早可派发的有效时间：账号总间隔与类别间隔同时满足。 */
  #readyAt(item: QueueItem): number {
    const state = this.#accountState(item.accountId)
    const accountReadyAt = (state.lastStartedAt ?? Number.NEGATIVE_INFINITY) + ACCOUNT_INTERVAL_MS
    const categoryReadyAt = (state.categories[item.category] ?? Number.NEGATIVE_INFINITY) + item.intervalMs
    return Math.max(accountReadyAt, categoryReadyAt)
  }

  /** 账号取消代次；用于判定派发开始前该项是否已被 cancelAccount 作废。 */
  #epochOf(accountId: string): number {
    return this.#cancelEpoch.get(accountId) ?? 0
  }

  /**
   * 恢复持久化状态。
   * 存在 pending 预留说明上次派发没有确认终结：把该次派发当作“启动时刻刚刚开始”，
   * 于是账号总间隔与对应类别都需要完整等待，绝不按偏早记录放行。
   */
  #restore(snapshot: SchedulerSnapshot): SchedulerSnapshot {
    if (!snapshot.pending) return snapshot
    const startupAt = this.#now()
    return {
      lastStartedAt: startupAt,
      categories: { ...snapshot.categories, [snapshot.pending.category]: startupAt },
      pending: null,
    }
  }

  /**
   * 加载队列中尚未加载账号的快照。
   * 读取失败或内容损坏都进入失败关闭：拒绝该账号排队项，并且不再放行该账号后续请求，
   * 避免把未知历史当成无历史而放宽间隔。
   */
  async #ensureStates(): Promise<void> {
    for (const item of [...this.#queue]) {
      const failure = this.#failures.get(item.accountId)
      if (failure) {
        this.#rejectQueued(item.accountId, failure)
        continue
      }
      if (this.#loaded.has(item.accountId)) continue
      this.#loaded.add(item.accountId)
      try {
        this.#states.set(item.accountId, this.#restore(parseSnapshot(await this.#deps.load(item.accountId))))
      } catch (error) {
        const failure = toError(error, 'INTERNAL')
        this.#states.delete(item.accountId)
        this.#failures.set(item.accountId, failure)
        this.#rejectQueued(item.accountId, failure)
      }
    }
  }

  /** 拒绝某账号全部排队项；用于快照不可用等无法确认间隔的场景。 */
  #rejectQueued(accountId: string, error: Error): void {
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const item = this.#queue[index]
      if (item.accountId !== accountId) continue
      this.#queue.splice(index, 1)
      item.reject(error)
    }
  }

  /** 拒绝并清空全部排队项；用于调度依赖不可用、无法继续计时的场景。 */
  #rejectAll(error: Error): void {
    const pending = this.#queue.splice(0, this.#queue.length)
    for (const item of pending) item.reject(error)
  }

  /**
   * 同步写入一次调度快照。
   * 返回 thenable 说明调用方违反同步契约：此时记录时间会落后于真实执行时刻，
   * 直接失败关闭，避免留下一个被低估的间隔。
   */
  #write(accountId: string, snapshot: SchedulerSnapshot): void {
    const result = this.#deps.save(accountId, snapshot) as unknown
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void (result as Promise<unknown>).catch(() => {})
      throw schedulerError('INTERNAL', 'save 必须同步完成，异步持久化会破坏派发时间记录')
    }
  }

  /**
   * 正常终结后覆盖真实开始时刻并清除预留。
   * 写入失败时持久化会停留在 pending 预留上，恢复时按启动时刻保守等候，
   * 因此不需要重试，也不会退化成偏早放行。
   */
  #settle(accountId: string, base: SchedulerSnapshot, category: Category, startedAt: number): void {
    try {
      this.#write(accountId, snapshotAt(base, category, startedAt, null))
    } catch {
      // 保留 pending 即保守：重启后按启动时刻重新起算完整间隔。
    }
  }

  /** 清理超过排队上限的项；排队超时只结束调用者等待，不涉及在途请求。 */
  #expireTimedOut(): void {
    const now = this.#now()
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const item = this.#queue[index]
      if (now < item.deadlineAt) continue
      this.#queue.splice(index, 1)
      item.reject(schedulerError('TIMEOUT', '排队等待超时', 'queue'))
    }
  }
  /** 取消调用方已断开的排队项；只结束等待，不触碰已开始的平台请求。 */
  #expireCancelled(): void {
    for (let index = this.#queue.length - 1; index >= 0; index -= 1) {
      const item = this.#queue[index]
      if (!item.signal?.aborted) continue
      this.#queue.splice(index, 1)
      item.reject(schedulerError('CANCELLED', '调用方已断开', 'queue'))
    }
  }

  /** 按入队顺序取第一个已到期项；未到期项不阻塞其他类别。 */
  #pickReady(): QueueItem | undefined {
    const now = this.#now()
    return this.#queue.find(item => now >= this.#readyAt(item))
  }

  /**
   * 设定下一次唤醒时刻。
   * 在途请求占用槽位时不按就绪时间唤醒，避免空转；排队超时始终计时，保证按时拒绝。
   */
  #armTimer(): void {
    this.#clearTimer()
    if (this.#closed) return
    const now = this.#now()
    let wakeAt = Number.POSITIVE_INFINITY
    for (const item of this.#queue) {
      if (item.deadlineAt < wakeAt) wakeAt = item.deadlineAt
      if (this.#running) continue
      const readyAt = this.#readyAt(item)
      if (readyAt < wakeAt) wakeAt = readyAt
    }
    if (!Number.isFinite(wakeAt)) return
    this.#timer = { handle: this.#deps.setTimer(() => this.#pump(), Math.max(0, wakeAt - now)) }
  }

  #clearTimer(): void {
    if (!this.#timer) return
    const handle = this.#timer.handle
    this.#timer = null
    this.#deps.clearTimer(handle)
  }

  /**
   * 泵入入口；`#pumping` 防止并发重入，`#running` 保证同一时刻只有一个在途请求。
   * 泵入期间的唤醒请求会合并为一次补跑，避免入队或槽位归还在 await 间隙被丢弃。
   */
  #pump(): void {
    if (this.#closed) return
    if (this.#pumping) {
      this.#repump = true
      return
    }
    this.#pumping = true
    void this.#drain()
      .catch(error => {
        // 兜底：调度依赖异常必须显式失败排队项，不能只抑制 unhandled rejection。
        this.#rejectAll(toError(error, 'INTERNAL'))
      })
      .finally(() => {
        this.#pumping = false
        if (this.#repump && !this.#closed) {
          this.#repump = false
          this.#pump()
        }
      })
  }

  async #drain(): Promise<void> {
    try {
      while (!this.#closed) {
        await this.#ensureStates()
        this.#expireCancelled()
        this.#expireTimedOut()
        if (this.#running) break
        const item = this.#pickReady()
        if (!item) break
        this.#queue.splice(this.#queue.indexOf(item), 1)
        this.#running = true
        // 槽位只在 execute 真实 settle 后归还；此处不设超时，避免旧请求仍在执行时发出下一个请求。
        void this.#dispatch(item)
          .catch(error => {
            this.#rejectAll(toError(error, 'INTERNAL'))
          })
          .finally(() => {
            this.#running = false
            this.#pump()
          })
      }
    } catch (error) {
      // 依赖注入异常（例如 now/load 抛错）会打断计时，必须失败所有排队项，避免它们永远 pending。
      this.#rejectAll(toError(error, 'INTERNAL'))
      return
    }
    try {
      this.#armTimer()
    } catch (error) {
      this.#rejectAll(toError(error, 'INTERNAL'))
    }
  }

  /**
   * 派发单个队列项。
   * 固定两次同步写：先写 pending 预留（保证未记账不发请求），再在终结后覆盖真实开始时刻。
   * 崩溃窗口：预留已落盘、终结写未完成时崩溃，恢复会看到 pending 并按启动时刻完整等候，
   * 因此只会更保守，不会缩短间隔。
   */
  async #dispatch(item: QueueItem): Promise<void> {
    const base = this.#accountState(item.accountId)
    const bookedAt = this.#now()
    const reserved: PendingDispatch = { category: item.category, reservedAt: bookedAt }
    try {
      this.#write(item.accountId, snapshotAt(base, item.category, bookedAt, reserved))
    } catch (error) {
      // 保存失败不执行平台请求，也不自动重试。
      item.reject(toError(error, 'INTERNAL'))
      return
    }
    // 同步记账返回后采样：此刻紧邻 execute，就是真实的平台请求开始时刻。
    const startedAt = this.#now()
    this.#states.set(item.accountId, snapshotAt(base, item.category, startedAt, reserved))
    try {
      // 到这里尚未发出平台请求：关闭或账号取消仍必须生效，不能继续执行回调。
      if (this.#closed) {
        item.reject(schedulerError('EXTENSION_OFFLINE', '扩展已离线，取消派发'))
        return
      }
      if (item.epoch !== this.#epochOf(item.accountId)) {
        item.reject(schedulerError('ACCOUNT_CHANGED', '账号已切换，取消派发'))
        return
      }
      if (item.signal?.aborted) {
        item.reject(schedulerError('CANCELLED', '调用方已断开', 'queue'))
        return
      }
      try {
        item.resolve(await item.execute())
      } catch (error) {
        // 回调失败也要归还槽位，且已发生的尝试仍计间隔。
        item.reject(toError(error, 'INTERNAL'))
      }
    } finally {
      // 覆盖为真实开始时刻并清除预留；失败时持久化保留 pending，恢复仍按启动时刻保守等候。
      this.#settle(item.accountId, base, item.category, startedAt)
      this.#states.set(item.accountId, snapshotAt(base, item.category, startedAt, null))
    }
  }
}

