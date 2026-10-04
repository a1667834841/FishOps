/**
 * 数据采集页控制器（P4）。纯 TypeScript，可在 Node 下直接测试。
 *
 * 使用的命令：`CAPTURE_CREATE`、`CAPTURE_PAUSE`、`CAPTURE_RESUME`、`CAPTURE_CANCEL`、`TASK_LIST`；
 * 订阅事件：`TASK_CHANGED`（驱动进度）、`WORKER_STARTED`（service worker 重启后对账）。
 *
 * 关键约束（均有单测）：
 * - 没有任何轮询，进度只来自 `TASK_CHANGED` 事件与用户点击刷新；
 * - 任务列表请求与事件并发时，以 `updatedAt` 更新者为准，旧快照不会覆盖新快照；
 * - 同一任务的暂停 / 恢复 / 取消进行中时，重复调用直接忽略；创建进行中也不会重复提交；
 * - 非 capture 类型的任务事件（如分析任务）一律忽略；
 * - 事件订阅只在 `start()` 登记一次，`dispose()` 全部释放，之后在途响应不再写状态。
 */
import { CommandTypes, EventTypes } from '@fishops/shared'
import type { CapturePayload, CaptureSuggestWordsPayload, Task } from '../contracts'
import type { BridgeApi } from '../shared/bridge-api'
import { toErrorView, type ErrorView } from '../shared/error-format'
import { StateStore, type ActionPhase, type LoadPhase } from '../shared/state-store'
import { pickDefaultTask, toCaptureTaskView } from './capture-format'

/** 本页面订阅的事件。 */
export const CAPTURE_EVENTS = [EventTypes.TASK_CHANGED, EventTypes.WORKER_STARTED] as const

export type TaskActionKind = 'pause' | 'resume' | 'cancel'

export interface TaskActionState {
  kind: TaskActionKind
  phase: 'running' | 'failed'
  error: ErrorView | null
}

/** 闲鱼流量词（suggest）状态。 */
export interface SuggestState {
  phase: 'idle' | 'loading' | 'ok' | 'error'
  words: string[]
  query: string
  queryId: string | null
  sequence: number
  error: ErrorView | null
}

/** 任务历史过滤与排序参数。 */
export interface TaskListQuery {
  keyword?: string
  sortBy?: 'createdAt' | 'updatedAt'
  sortOrder?: 'asc' | 'desc'
  limit?: number
}

export interface CaptureState {
  availability: 'unavailable' | 'ready'
  tasks: { phase: LoadPhase; items: Task[]; error: ErrorView | null; refreshing: boolean; queryKeyword: string }
  selectedId: string | null
  create: { phase: ActionPhase; error: ErrorView | null; createdId: string | null }
  actions: Record<string, TaskActionState>
  suggest: SuggestState
  realtimeError: string | null
}

export interface CaptureControllerOptions {
  api: BridgeApi | null
  /** 任务列表最多保留条数。 */
  maxTasks?: number
}

const BAD_SHAPE = '扩展返回的数据格式不正确'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTask(value: unknown): value is Task {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['type'] === 'string' &&
    typeof value['status'] === 'string' &&
    typeof value['updatedAt'] === 'number'
  )
}

function sortTasks(tasks: Task[], max: number): Task[] {
  return [...tasks].sort((a, b) => b.createdAt - a.createdAt).slice(0, max)
}

export function createInitialCaptureState(availability: CaptureState['availability']): CaptureState {
  return {
    availability,
    tasks: { phase: 'idle', items: [], error: null, refreshing: false, queryKeyword: '' },
    selectedId: null,
    create: { phase: 'idle', error: null, createdId: null },
    actions: {},
    suggest: {
      phase: 'idle',
      words: [],
      query: '',
      queryId: null,
      sequence: 0,
      error: null,
    },
    realtimeError: null,
  }
}

export class CaptureController extends StateStore<CaptureState> {
  private readonly api: BridgeApi | null
  private maxTasks: number
  private started = false
  private listSeq = 0
  /** 当前列表请求发起后，被事件触及的任务 ID（用于合并时不丢失更新的事件）。 */
  private touchedDuringList = new Set<string>()
  private removedDuringList = new Set<string>()
  private userSelected = false

  // 流量词（suggest）内部状态
  private suggestTimer: ReturnType<typeof setTimeout> | null = null
  private suggestCounter = 0
  private latestSuggestQueryId: string | null = null
  private latestSuggestSequence = 0

  constructor(options: CaptureControllerOptions) {
    super(createInitialCaptureState(options.api ? 'ready' : 'unavailable'))
    this.api = options.api
    this.maxTasks = options.maxTasks ?? 50
  }

  /** 启动：先登记事件监听，再读取任务列表。幂等。 */
  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    const api = this.api
    if (!api) return
    try {
      this.track(api.on(EventTypes.TASK_CHANGED, (payload) => this.onTaskChanged(payload)))
      this.track(api.on(EventTypes.WORKER_STARTED, () => void this.loadTasks(true)))
    } catch (error) {
      this.patch({ realtimeError: `实时更新不可用：${toErrorView(error).title}` })
    }
    void this.loadTasks(false)
  }

  resubscribe(): void {
    if (this.disposed || !this.api) return
    try {
      this.api.resubscribe()
      if (this.state.realtimeError) this.patch({ realtimeError: null })
    } catch (error) {
      this.patch({ realtimeError: `实时更新不可用：${toErrorView(error).title}` })
    }
  }

  /** 手动刷新（用户点击），重新读取任务列表。 */
  refresh(): Promise<void> {
    return this.loadTasks(false)
  }

  /** 过滤任务历史关键字。 */
  filterHistory(keyword: string): Promise<void> {
    this.patch({ tasks: { ...this.state.tasks, queryKeyword: keyword } })
    return this.loadTasks(false)
  }

  /** 加载更多任务历史（扩大保留上限并重新拉取）。 */
  async loadMoreHistory(step = 30): Promise<void> {
    this.maxTasks += step
    await this.loadTasks(false)
  }

  select(taskId: string): void {
    if (this.disposed || !this.state.tasks.items.some((task) => task.id === taskId)) return
    this.userSelected = true
    this.patch({ selectedId: taskId })
  }

  /**
   * 触发流量词查询。
   * - 空输入时不调用后台，重置状态为 idle，清空防抖；
   * - 默认 300ms 防抖，immediate=true 时立即发起（供点击“获取流量词”按钮使用）；
   * - 严格按 sequence / queryId 丢弃旧结果；
   * - 仅查询建议词，绝不创建任务。
   */
  fetchSuggest(
    input: string,
    options?: { immediate?: boolean; limit?: number; debounceMs?: number; queryId?: string },
  ): Promise<void> {
    if (this.disposed || !this.api) return Promise.resolve()
    const trimmed = input.trim()
    this.cancelSuggestDebounce()

    // 空输入不调用后台：直接清空并重置为 idle
    if (trimmed.length === 0) {
      this.latestSuggestQueryId = null
      this.patch({
        suggest: {
          phase: 'idle',
          words: [],
          query: '',
          queryId: null,
          sequence: this.latestSuggestSequence,
          error: null,
        },
      })
      return Promise.resolve()
    }

    const queryId = options?.queryId ?? `sug_${Date.now()}_${++this.suggestCounter}`
    this.latestSuggestQueryId = queryId

    const execute = async (): Promise<void> => {
      if (this.disposed || this.latestSuggestQueryId !== queryId) return
      this.patch({
        suggest: {
          ...this.state.suggest,
          phase: 'loading',
          query: trimmed,
          queryId,
          error: null,
        },
      })

      try {
        // 传递 keyword 并兼容 inputWords
        const payload: CaptureSuggestWordsPayload & { inputWords?: string } = {
          keyword: trimmed,
          inputWords: trimmed,
          queryId,
          ...(options?.limit ? { limit: options.limit } : {}),
        }
        const result = await this.api!.call(
          CommandTypes.CAPTURE_SUGGEST_WORDS,
          payload as CaptureSuggestWordsPayload,
        )
        if (this.disposed) return

        // 丢弃旧响应：
        // 1. queryId 与当前激活的 queryId 不匹配则丢弃
        if (this.latestSuggestQueryId !== queryId) return
        if (result.queryId && result.queryId !== queryId) return
        // 2. sequence <= 已应用的 sequence 则丢弃（乱序迟到）
        if (typeof result.sequence === 'number' && result.sequence <= this.latestSuggestSequence) {
          return
        }

        this.latestSuggestSequence = result.sequence
        this.patch({
          suggest: {
            phase: 'ok',
            words: Array.isArray(result.words) ? result.words : [],
            query: trimmed,
            queryId,
            sequence: result.sequence,
            error: null,
          },
        })
      } catch (error) {
        if (this.disposed || this.latestSuggestQueryId !== queryId) return
        this.patch({
          suggest: {
            phase: 'error',
            words: [],
            query: trimmed,
            queryId,
            sequence: this.latestSuggestSequence,
            error: toErrorView(error),
          },
        })
      }
    }

    if (options?.immediate) {
      return execute()
    }

    const ms = options?.debounceMs ?? 300
    return new Promise<void>((resolve) => {
      this.suggestTimer = setTimeout(() => {
        this.suggestTimer = null
        execute().then(resolve, () => resolve())
      }, ms)
    })
  }

  cancelSuggestDebounce(): void {
    if (this.suggestTimer !== null) {
      clearTimeout(this.suggestTimer)
      this.suggestTimer = null
    }
  }

  clearSuggest(): void {
    this.cancelSuggestDebounce()
    this.latestSuggestQueryId = null
    this.patch({
      suggest: {
        phase: 'idle',
        words: [],
        query: '',
        queryId: null,
        sequence: this.latestSuggestSequence,
        error: null,
      },
    })
  }

  /**
   * 用户选择建议词。
   * 仅关闭/重置建议词状态并返回所选词，绝不触发创建任务！
   */
  selectSuggestWord(word: string): string {
    this.clearSuggest()
    return word
  }

  /** 创建并启动采集任务。仅在创建进行中防重复提交，不因有 active 任务拦截。 */
  async createTask(payload: CapturePayload): Promise<boolean> {
    const api = this.api
    if (this.disposed || !api || this.state.create.phase === 'running') return false
    this.patch({ create: { phase: 'running', error: null, createdId: null } })
    try {
      const result = await api.call(CommandTypes.CAPTURE_CREATE, payload)
      if (this.disposed) return false
      if (!isRecord(result) || !isTask(result.task)) throw new Error(BAD_SHAPE)
      this.upsertTask(result.task)
      this.userSelected = true
      this.patch({
        selectedId: result.task.id,
        create: { phase: 'ok', error: null, createdId: result.task.id },
      })
      return true
    } catch (error) {
      if (this.disposed) return false
      this.patch({ create: { phase: 'failed', error: toErrorView(error), createdId: null } })
      return false
    }
  }

  /**
   * 批量创建采集任务：按词依次调用现有 CAPTURE_CREATE 命令。
   * 成功即进入列表，防重复提交；部分失败时保留已成功任务，并汇总失败项供重试。
   */
  async createBatchTasks(payloads: readonly CapturePayload[]): Promise<{
    successes: Task[]
    failures: Array<{ keyword: string; error: ErrorView }>
  }> {
    const api = this.api
    if (this.disposed || !api || this.state.create.phase === 'running' || payloads.length === 0) {
      return { successes: [], failures: [] }
    }
    this.patch({ create: { phase: 'running', error: null, createdId: null } })
    const successes: Task[] = []
    const failures: Array<{ keyword: string; error: ErrorView }> = []

    for (const payload of payloads) {
      if (this.disposed) break
      try {
        const result = await api.call(CommandTypes.CAPTURE_CREATE, payload)
        if (!isRecord(result) || !isTask(result.task)) throw new Error(BAD_SHAPE)
        this.upsertTask(result.task)
        this.userSelected = true
        this.patch({ selectedId: result.task.id })
        successes.push(result.task)
      } catch (error) {
        failures.push({
          keyword: payload.keyword,
          error: toErrorView(error),
        })
      }
    }

    if (this.disposed) return { successes, failures }

    if (failures.length === 0) {
      const lastId = successes[successes.length - 1]?.id ?? null
      this.patch({
        create: { phase: 'ok', error: null, createdId: lastId },
      })
    } else {
      const failedWords = failures.map((f) => f.keyword).join('、')
      const firstError = failures[0].error
      const summaryError: ErrorView = {
        title: failures.length === payloads.length ? '全部任务创建失败' : '部分任务创建失败',
        detail: `失败关键词：${failedWords}。${firstError.detail || firstError.title}`,
        code: firstError.code,
        kind: 'platform',
        hint: '已成功的任务已进入列表，可直接点击“重试失败项”重新提交。',
      }
      this.patch({
        create: { phase: 'failed', error: summaryError, createdId: null },
      })
    }

    return { successes, failures }
  }

  /** 暂停 / 恢复 / 取消。同一任务有操作进行中时忽略。 */
  async act(kind: TaskActionKind, taskId: string): Promise<boolean> {
    const api = this.api
    if (this.disposed || !api) return false
    if (this.state.actions[taskId]?.phase === 'running') return false
    const task = this.state.tasks.items.find((item) => item.id === taskId)
    if (!task) return false
    const view = toCaptureTaskView(task)
    const allowed = kind === 'pause' ? view.canPause : kind === 'resume' ? view.canResume : view.canCancel
    if (!allowed) return false

    this.setAction(taskId, { kind, phase: 'running', error: null })
    const type =
      kind === 'pause'
        ? CommandTypes.CAPTURE_PAUSE
        : kind === 'resume'
          ? CommandTypes.CAPTURE_RESUME
          : CommandTypes.CAPTURE_CANCEL
    try {
      const result = await api.call(type, { id: taskId })
      if (this.disposed) return false
      if (!isRecord(result) || !isTask(result.task)) throw new Error(BAD_SHAPE)
      this.upsertTask(result.task)
      this.setAction(taskId, null)
      return true
    } catch (error) {
      if (this.disposed) return false
      this.setAction(taskId, { kind, phase: 'failed', error: toErrorView(error) })
      // 失败常见于任务状态已变化，静默对账一次。
      void this.loadTasks(true)
      return false
    }
  }

  override dispose(): void {
    this.cancelSuggestDebounce()
    super.dispose()
  }

  // ---------------- 内部实现 ----------------

  private setAction(taskId: string, action: TaskActionState | null): void {
    const actions = { ...this.state.actions }
    if (action) actions[taskId] = action
    else delete actions[taskId]
    this.patch({ actions })
  }

  private onTaskChanged(payload: unknown): void {
    if (this.disposed || !isRecord(payload) || !isTask(payload['task'])) return
    const task = payload['task']
    if (task.type !== 'capture') return
    if (payload['eventType'] === 'removed') {
      this.removedDuringList.add(task.id)
      this.touchedDuringList.delete(task.id)
      const items = this.state.tasks.items.filter((item) => item.id !== task.id)
      this.patch({ tasks: { ...this.state.tasks, items } })
      this.reselectIfNeeded(items)
      return
    }
    this.touchedDuringList.add(task.id)
    this.removedDuringList.delete(task.id)
    this.upsertTask(task)
  }

  /** 写入一个任务快照：同 ID 只接受不更旧的快照，保留全部历史。 */
  private upsertTask(task: Task): void {
    if (task.type !== 'capture') return
    const current = this.state.tasks.items
    const existing = current.find((item) => item.id === task.id)
    if (existing && existing.updatedAt > task.updatedAt) return
    const items = sortTasks([...current.filter((item) => item.id !== task.id), task], this.maxTasks)
    const phase: LoadPhase =
      this.state.tasks.phase === 'idle' || this.state.tasks.phase === 'loading'
        ? this.state.tasks.phase
        : 'ready'
    this.patch({ tasks: { ...this.state.tasks, phase, items } })
    this.reselectIfNeeded(items)
  }

  private reselectIfNeeded(items: Task[]): void {
    const selected = this.state.selectedId
    if (selected && items.some((item) => item.id === selected)) return
    this.userSelected = false
    this.patch({ selectedId: pickDefaultTask(items) })
  }

  private async loadTasks(silent: boolean): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    const token = ++this.listSeq
    this.touchedDuringList = new Set()
    this.removedDuringList = new Set()
    const hadData = this.state.tasks.phase === 'ready'
    if (!hadData) this.patch({ tasks: { ...this.state.tasks, phase: 'loading', items: [], error: null, refreshing: false } })
    else if (!silent) this.patch({ tasks: { ...this.state.tasks, refreshing: true } })
    try {
      const queryKeyword = this.state.tasks.queryKeyword.trim()
      const result = await api.call(CommandTypes.TASK_LIST, {
        type: 'capture',
        sortBy: 'createdAt',
        sortOrder: 'desc',
        limit: this.maxTasks,
        ...(queryKeyword.length > 0 ? { keyword: queryKeyword } : {}),
      })
      if (this.disposed || token !== this.listSeq) return
      if (!isRecord(result) || !Array.isArray(result.tasks) || !result.tasks.every(isTask)) throw new Error(BAD_SHAPE)

      const merged = new Map<string, Task>()

      // 1. 保留本地已有的未被删除的任务（不覆盖、不抹除历史）
      for (const local of this.state.tasks.items) {
        if (!this.removedDuringList.has(local.id)) {
          merged.set(local.id, local)
        }
      }

      // 2. 合并后台拉取到的任务，按 id + updatedAt 合并
      for (const fetched of result.tasks) {
        if (fetched.type !== 'capture' || this.removedDuringList.has(fetched.id)) continue
        const existing = merged.get(fetched.id)
        if (!existing) {
          merged.set(fetched.id, fetched)
        } else if (fetched.updatedAt >= existing.updatedAt) {
          // 后台快照较新或相同，使用后台快照
          merged.set(fetched.id, fetched)
        }
        // 若 existing.updatedAt > fetched.updatedAt，说明本地在请求期间收到了更新的快照，保留 existing
      }

      const items = sortTasks([...merged.values()], this.maxTasks)
      this.patch({ tasks: { ...this.state.tasks, phase: 'ready', items, error: null, refreshing: false } })
      if (!(this.userSelected && this.state.selectedId && items.some((item) => item.id === this.state.selectedId))) {
        this.patch({ selectedId: pickDefaultTask(items) })
      }
    } catch (error) {
      if (this.disposed || token !== this.listSeq) return
      const view = toErrorView(error)
      this.patch({
        tasks: {
          ...this.state.tasks,
          phase: hadData ? 'ready' : 'error',
          items: hadData ? this.state.tasks.items : [],
          error: view,
          refreshing: false,
        },
      })
    }
  }
}
