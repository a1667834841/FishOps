/**
 * 数据分析页控制器（P7）。纯 TypeScript，可在 Node 下直接测试。
 *
 * 使用的命令：
 * - 数据源：`DATA_SOURCE_LIST`、`DATA_SOURCE_SCHEMA`、`DATA_SOURCE_QUERY`（只读预览）；
 * - 提示词规则：`PROMPT_RULE_LIST`、`PROMPT_RULE_UPSERT`、`PROMPT_RULE_DELETE`；
 * - 分析任务：`ANALYSIS_CREATE`、`ANALYSIS_GET`（用户点击刷新）、`ANALYSIS_CANCEL`、`ANALYSIS_RESULT_GET`；
 * - 进入页面时用 `TASK_LIST`（analysis）找回最近一次分析任务，避免切页后结果丢失。
 * 订阅事件：`TASK_CHANGED`（驱动分析进度，不轮询）、`WORKER_STARTED`。
 *
 * 关键约束（均有单测）：
 * - 数据源 / Schema / 预览请求都带令牌，切换数据源后旧响应丢弃；
 * - 创建、取消、规则保存 / 删除进行中重复调用被忽略；已有进行中的分析时不允许再创建；
 * - 任务事件与创建响应并发时以 `updatedAt` 较新者为准，创建响应前到达的事件会被暂存后合并；
 * - 结果只通过 `ANALYSIS_RESULT_GET` 获取并严格校验，不合法显示为「结果格式不合法」；
 * - 本控制器从不处理 API Key / AppSecret。
 */
import { CommandTypes, EventTypes } from '@fishops/shared'
import type {
  AnalysisPayload,
  AnalysisResult,
  DataSourceInfo,
  Dataset,
  DatasetFilter,
  DatasetSchema,
  PromptRule,
  Task,
} from '../contracts'
import type { BridgeApi } from '../shared/bridge-api'
import { toErrorView, type ErrorView } from '../shared/error-format'
import { StateStore, type ActionPhase, type LoadPhase } from '../shared/state-store'
import { parseAnalysisResult } from './analysis-format'

export const ANALYSIS_EVENTS = [EventTypes.TASK_CHANGED, EventTypes.WORKER_STARTED] as const

export interface AnalysisState {
  availability: 'unavailable' | 'ready'
  sources: { phase: LoadPhase; items: DataSourceInfo[]; error: ErrorView | null }
  sourceType: string | null
  schema: { phase: LoadPhase; sourceType: string | null; schema: DatasetSchema | null; error: ErrorView | null }
  preview: { phase: ActionPhase; sourceType: string | null; dataset: Dataset | null; error: ErrorView | null }
  rules: { phase: LoadPhase; items: PromptRule[]; error: ErrorView | null }
  selectedRuleId: string | null
  ruleOp: { phase: ActionPhase; kind: 'save' | 'delete' | null; ruleId: string | null; error: string | null }
  task: {
    current: Task | null
    restore: { phase: LoadPhase; error: ErrorView | null }
    create: { phase: ActionPhase; error: ErrorView | null }
    cancel: { phase: ActionPhase; error: ErrorView | null }
    refresh: { phase: ActionPhase; error: ErrorView | null }
  }
  result: { phase: LoadPhase; taskId: string | null; data: AnalysisResult | null; error: string | null }
  realtimeError: string | null
  /** 飞书目标表格变化监测（变更提示）。 */
  targetTable: {
    currentTableId: string | null
    previousTableId: string | null
    changed: boolean
    changeMessage: string | null
  }
}

export interface StartAnalysisInput {
  ruleId: string
  filter: DatasetFilter
  sampleLimit: number
  customInstructions?: string
}

export interface AnalysisControllerOptions {
  api: BridgeApi | null
}

const BAD_SHAPE = '扩展返回的数据格式不正确'
const MAX_BUFFERED_EVENTS = 20

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

function isPromptRule(value: unknown): value is PromptRule {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['systemPrompt'] === 'string' &&
    typeof value['userPromptTemplate'] === 'string'
  )
}

function isSchema(value: unknown): value is DatasetSchema {
  return isRecord(value) && typeof value['name'] === 'string' && Array.isArray(value['fields'])
}

function isDataset(value: unknown): value is Dataset {
  return isRecord(value) && isSchema(value['schema']) && Array.isArray(value['rows']) && typeof value['total'] === 'number'
}

/** 任务是否仍在进行（不可再创建、可取消）。 */
export function isActiveAnalysis(task: Task | null): boolean {
  return task !== null && (task.status === 'pending' || task.status === 'running')
}

export function createInitialAnalysisState(availability: AnalysisState['availability']): AnalysisState {
  return {
    availability,
    sources: { phase: 'idle', items: [], error: null },
    sourceType: null,
    schema: { phase: 'idle', sourceType: null, schema: null, error: null },
    preview: { phase: 'idle', sourceType: null, dataset: null, error: null },
    rules: { phase: 'idle', items: [], error: null },
    selectedRuleId: null,
    ruleOp: { phase: 'idle', kind: null, ruleId: null, error: null },
    task: {
      current: null,
      restore: { phase: 'idle', error: null },
      create: { phase: 'idle', error: null },
      cancel: { phase: 'idle', error: null },
      refresh: { phase: 'idle', error: null },
    },
    result: { phase: 'idle', taskId: null, data: null, error: null },
    realtimeError: null,
    targetTable: {
      currentTableId: null,
      previousTableId: null,
      changed: false,
      changeMessage: null,
    },
  }
}

export class AnalysisController extends StateStore<AnalysisState> {
  private readonly api: BridgeApi | null
  private started = false
  private sourcesSeq = 0
  private schemaSeq = 0
  private previewSeq = 0
  private rulesSeq = 0
  private resultSeq = 0
  /** 创建响应返回前到达的分析任务事件快照。 */
  private readonly buffered = new Map<string, Task>()

  constructor(options: AnalysisControllerOptions) {
    super(createInitialAnalysisState(options.api ? 'ready' : 'unavailable'))
    this.api = options.api
  }

  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    const api = this.api
    if (!api) return
    try {
      this.track(api.on(EventTypes.TASK_CHANGED, (payload) => this.onTaskChanged(payload)))
      this.track(api.on(EventTypes.WORKER_STARTED, () => void this.restoreLatestTask()))
    } catch (error) {
      this.patch({ realtimeError: `实时更新不可用：${toErrorView(error).title}` })
    }
    void this.loadSources()
    void this.loadRules()
    void this.restoreLatestTask()
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

  // ---------------- 数据源 ----------------

  loadSources(): Promise<void> {
    return this.fetchSources()
  }

  /** 选择数据源；只能选择后台已注册的飞书数据源。 */
  selectSource(type: string): Promise<void> {
    if (this.disposed || !type) return Promise.resolve()
    // 数据分析只以飞书表格为准：禁用 local 数据源
    if (type !== 'feishu') return Promise.resolve()
    if (!this.state.sources.items.some((source) => source.type === type)) return Promise.resolve()
    this.previewSeq++
    this.patch({
      sourceType: type,
      preview: { phase: 'idle', sourceType: null, dataset: null, error: null },
    })
    return this.loadSchema(type)
  }

  /** 关闭目标表变更提示通知。 */
  dismissTableChangeNotice(): void {
    this.patch({
      targetTable: {
        ...this.state.targetTable,
        changed: false,
        changeMessage: null,
      },
    })
  }

  /** 按过滤器查询当前数据源，用于预览（只读）。 */
  async queryPreview(filter: DatasetFilter): Promise<void> {
    const api = this.api
    const type = this.state.sourceType
    if (this.disposed || !api || !type || this.state.preview.phase === 'running') return
    const token = ++this.previewSeq
    this.patch({ preview: { phase: 'running', sourceType: type, dataset: null, error: null } })
    try {
      const result = await api.call(CommandTypes.DATA_SOURCE_QUERY, { type, filter })
      if (this.disposed || token !== this.previewSeq || this.state.sourceType !== type) return
      if (!isRecord(result) || !isDataset(result.dataset)) throw new Error(BAD_SHAPE)
      this.patch({ preview: { phase: 'ok', sourceType: type, dataset: result.dataset, error: null } })
    } catch (error) {
      if (this.disposed || token !== this.previewSeq || this.state.sourceType !== type) return
      this.patch({ preview: { phase: 'failed', sourceType: type, dataset: null, error: toErrorView(error) } })
    }
  }

  reloadSchema(): Promise<void> {
    const type = this.state.sourceType
    return type ? this.loadSchema(type) : Promise.resolve()
  }

  private async fetchSources(): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    const token = ++this.sourcesSeq
    this.patch({ sources: { phase: 'loading', items: this.state.sources.items, error: null } })
    try {
      const result = await api.call(CommandTypes.DATA_SOURCE_LIST, {})
      if (this.disposed || token !== this.sourcesSeq) return
      if (!isRecord(result) || !Array.isArray(result.dataSources) || !result.dataSources.every((s) => isRecord(s) && typeof s['type'] === 'string' && typeof s['name'] === 'string')) {
        throw new Error(BAD_SHAPE)
      }
      const items = result.dataSources
      this.patch({ sources: { phase: 'ready', items, error: null } })
      // 数据分析只以飞书表格为准：仅选择 feishu，禁用/隐藏 local
      const hasFeishu = items.some((item) => item.type === 'feishu')
      if (hasFeishu) {
        this.patch({ sourceType: 'feishu' })
        void this.loadSchema('feishu')
      } else {
        // 未配置飞书数据源
        this.patch({ sourceType: null })
      }
    } catch (error) {
      if (this.disposed || token !== this.sourcesSeq) return
      this.patch({ sources: { phase: 'error', items: [], error: toErrorView(error) } })
    }
  }

  private async loadSchema(type: string): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    const token = ++this.schemaSeq
    this.patch({ schema: { phase: 'loading', sourceType: type, schema: null, error: null } })
    try {
      const result = await api.call(CommandTypes.DATA_SOURCE_SCHEMA, { type })
      if (this.disposed || token !== this.schemaSeq) return
      if (!isRecord(result) || !isSchema(result.schema)) throw new Error(BAD_SHAPE)
      
      // 检测飞书目标商品表变更（从 description 中的 table=xxx 解析）
      let changed = false
      let changeMessage: string | null = null
      let currentTableId: string | null = this.state.targetTable.currentTableId
      let previousTableId: string | null = this.state.targetTable.previousTableId

      if (type === 'feishu' && result.schema.description) {
        const match = result.schema.description.match(/table=([^\s,;]+)/)
        const newTableId = match ? match[1] : null
        if (newTableId) {
          if (currentTableId && currentTableId !== newTableId) {
            changed = true
            previousTableId = currentTableId
            changeMessage = `检测到飞书目标商品表已发生变更：由「${previousTableId}」变更为「${newTableId}」，请重新确认查询过滤器和分析规则。`
          }
          currentTableId = newTableId
        }
      }

      this.patch({
        schema: { phase: 'ready', sourceType: type, schema: result.schema, error: null },
        targetTable: {
          currentTableId,
          previousTableId,
          changed,
          changeMessage,
        },
      })
    } catch (error) {
      if (this.disposed || token !== this.schemaSeq) return
      this.patch({ schema: { phase: 'error', sourceType: type, schema: null, error: toErrorView(error) } })
    }
  }

  // ---------------- 提示词规则 ----------------

  loadRules(): Promise<void> {
    return this.fetchRules()
  }

  selectRule(ruleId: string | null): void {
    if (this.disposed) return
    this.patch({ selectedRuleId: ruleId })
  }

  async upsertRule(rule: PromptRule): Promise<boolean> {
    const api = this.api
    if (this.disposed || !api || this.state.ruleOp.phase === 'running') return false
    this.patch({ ruleOp: { phase: 'running', kind: 'save', ruleId: rule.id, error: null } })
    try {
      const result = await api.call(CommandTypes.PROMPT_RULE_UPSERT, { rule })
      if (this.disposed) return false
      if (!isRecord(result) || !isPromptRule(result.rule)) throw new Error(BAD_SHAPE)
      const saved = result.rule
      const items = this.state.rules.items
      const next = items.some((item) => item.id === saved.id)
        ? items.map((item) => (item.id === saved.id ? saved : item))
        : [...items, saved]
      this.rulesSeq++
      this.patch({
        rules: { phase: 'ready', items: next, error: null },
        selectedRuleId: saved.id,
        ruleOp: { phase: 'ok', kind: 'save', ruleId: saved.id, error: null },
      })
      return true
    } catch (error) {
      if (this.disposed) return false
      this.patch({ ruleOp: { phase: 'failed', kind: 'save', ruleId: rule.id, error: toErrorView(error).detail || toErrorView(error).title } })
      return false
    }
  }

  async deleteRule(ruleId: string): Promise<boolean> {
    const api = this.api
    if (this.disposed || !api || this.state.ruleOp.phase === 'running') return false
    this.patch({ ruleOp: { phase: 'running', kind: 'delete', ruleId, error: null } })
    try {
      const result = await api.call(CommandTypes.PROMPT_RULE_DELETE, { id: ruleId })
      if (this.disposed) return false
      if (!isRecord(result) || typeof result.success !== 'boolean') throw new Error(BAD_SHAPE)
      if (!result.success) {
        this.patch({ ruleOp: { phase: 'failed', kind: 'delete', ruleId, error: '后台没有删除这条规则，它可能已经不存在' } })
        void this.fetchRules()
        return false
      }
      this.rulesSeq++
      this.patch({
        rules: { phase: 'ready', items: this.state.rules.items.filter((rule) => rule.id !== ruleId), error: null },
        selectedRuleId: this.state.selectedRuleId === ruleId ? null : this.state.selectedRuleId,
        ruleOp: { phase: 'ok', kind: 'delete', ruleId, error: null },
      })
      return true
    } catch (error) {
      if (this.disposed) return false
      this.patch({ ruleOp: { phase: 'failed', kind: 'delete', ruleId, error: toErrorView(error).detail || toErrorView(error).title } })
      return false
    }
  }

  clearRuleOp(): void {
    if (this.disposed || this.state.ruleOp.phase === 'running') return
    this.patch({ ruleOp: { phase: 'idle', kind: null, ruleId: null, error: null } })
  }

  private async fetchRules(): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    const token = ++this.rulesSeq
    const hadData = this.state.rules.phase === 'ready'
    if (!hadData) this.patch({ rules: { phase: 'loading', items: [], error: null } })
    try {
      const result = await api.call(CommandTypes.PROMPT_RULE_LIST, {})
      if (this.disposed || token !== this.rulesSeq) return
      if (!isRecord(result) || !Array.isArray(result.rules) || !result.rules.every(isPromptRule)) throw new Error(BAD_SHAPE)
      const items = result.rules
      const selected = this.state.selectedRuleId
      this.patch({
        rules: { phase: 'ready', items, error: null },
        selectedRuleId: selected && items.some((rule) => rule.id === selected) ? selected : (items[0]?.id ?? null),
      })
    } catch (error) {
      if (this.disposed || token !== this.rulesSeq) return
      this.patch({
        rules: { phase: hadData ? 'ready' : 'error', items: hadData ? this.state.rules.items : [], error: toErrorView(error) },
      })
    }
  }

  // ---------------- 分析任务 ----------------

  async startAnalysis(input: StartAnalysisInput): Promise<boolean> {
    const api = this.api
    const type = this.state.sourceType
    if (this.disposed || !api || this.state.task.create.phase === 'running') return false

    // 数据分析只以飞书表格为准：分析任务强制 dataSourceType=feishu，未配置飞书时明确阻止
    if (type !== 'feishu') {
      this.patch({
        task: {
          ...this.state.task,
          create: {
            phase: 'failed',
            error: toErrorView(new Error('数据分析只以飞书表格为准，未配置飞书多维表格时无法启动分析，请前往设置页完成飞书配置')),
          },
        },
      })
      return false
    }
    if (isActiveAnalysis(this.state.task.current)) {
      this.patch({
        task: { ...this.state.task, create: { phase: 'failed', error: toErrorView(new Error('已有分析任务正在进行，请等待完成或先取消')) } },
      })
      return false
    }
    const payload: AnalysisPayload = {
      ruleId: input.ruleId,
      dataSourceType: 'feishu',
      // Shared 契约要求 queryParams 可携带额外字段，这里按字面量展开以满足 `DatasetFilter & Record<string, unknown>`。
      queryParams: { ...input.filter },
      sampleLimit: input.sampleLimit,
      ...(input.customInstructions?.trim() ? { customInstructions: input.customInstructions.trim() } : {}),
    }
    this.buffered.clear()
    this.resultSeq++
    this.patch({
      task: { ...this.state.task, current: null, create: { phase: 'running', error: null }, cancel: { phase: 'idle', error: null } },
      result: { phase: 'idle', taskId: null, data: null, error: null },
    })
    try {
      const response = await api.call(CommandTypes.ANALYSIS_CREATE, payload)
      if (this.disposed) return false
      if (!isRecord(response) || !isTask(response.task)) throw new Error(BAD_SHAPE)
      let task = response.task
      const newer = this.buffered.get(task.id)
      if (newer && newer.updatedAt > task.updatedAt) task = newer
      this.patch({ task: { ...this.state.task, current: task, create: { phase: 'ok', error: null } } })
      this.afterTaskUpdate(task)
      return true
    } catch (error) {
      if (this.disposed) return false
      this.patch({ task: { ...this.state.task, create: { phase: 'failed', error: toErrorView(error) } } })
      return false
    }
  }

  async cancelAnalysis(): Promise<boolean> {
    const api = this.api
    const current = this.state.task.current
    if (this.disposed || !api || !current || this.state.task.cancel.phase === 'running' || !isActiveAnalysis(current)) return false
    this.patch({ task: { ...this.state.task, cancel: { phase: 'running', error: null } } })
    try {
      const response = await api.call(CommandTypes.ANALYSIS_CANCEL, { id: current.id })
      if (this.disposed) return false
      if (!isRecord(response) || !isTask(response.task)) throw new Error(BAD_SHAPE)
      this.patch({ task: { ...this.state.task, cancel: { phase: 'ok', error: null } } })
      this.applyTask(response.task)
      return true
    } catch (error) {
      if (this.disposed) return false
      this.patch({ task: { ...this.state.task, cancel: { phase: 'failed', error: toErrorView(error) } } })
      return false
    }
  }

  /** 用户点击刷新：用 `ANALYSIS_GET` 对账当前任务。 */
  async refreshTask(): Promise<void> {
    const api = this.api
    const current = this.state.task.current
    if (this.disposed || !api || !current || this.state.task.refresh.phase === 'running') return
    this.patch({ task: { ...this.state.task, refresh: { phase: 'running', error: null } } })
    try {
      const response = await api.call(CommandTypes.ANALYSIS_GET, { id: current.id })
      if (this.disposed) return
      if (!isRecord(response) || !isTask(response.task)) throw new Error(BAD_SHAPE)
      this.patch({ task: { ...this.state.task, refresh: { phase: 'ok', error: null } } })
      this.applyTask(response.task)
    } catch (error) {
      if (this.disposed) return
      this.patch({ task: { ...this.state.task, refresh: { phase: 'failed', error: toErrorView(error) } } })
    }
  }

  /** 重新读取当前任务的结果（结果解析失败后用户可重试）。 */
  retryResult(): Promise<void> {
    const current = this.state.task.current
    if (!current || current.status !== 'completed') return Promise.resolve()
    return this.loadResult(current.id, true)
  }

  private async restoreLatestTask(): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    this.patch({ task: { ...this.state.task, restore: { phase: 'loading', error: null } } })
    try {
      const response = await api.call(CommandTypes.TASK_LIST, { type: 'analysis' })
      if (this.disposed) return
      if (!isRecord(response) || !Array.isArray(response.tasks) || !response.tasks.every(isTask)) throw new Error(BAD_SHAPE)
      this.patch({ task: { ...this.state.task, restore: { phase: 'ready', error: null } } })
      // 用户已在本页创建 / 收到了任务时，不用历史记录覆盖。
      if (this.state.task.current || this.state.task.create.phase === 'running') return
      const latest = [...response.tasks]
        .filter((task) => task.type === 'analysis')
        .sort((a, b) => b.createdAt - a.createdAt)[0]
      if (latest) {
        this.patch({ task: { ...this.state.task, current: latest } })
        this.afterTaskUpdate(latest)
      }
    } catch (error) {
      if (this.disposed) return
      this.patch({ task: { ...this.state.task, restore: { phase: 'error', error: toErrorView(error) } } })
    }
  }

  private onTaskChanged(payload: unknown): void {
    if (this.disposed || !isRecord(payload) || !isTask(payload['task'])) return
    const task = payload['task']
    if (task.type !== 'analysis') return
    if (payload['eventType'] === 'removed') {
      this.buffered.delete(task.id)
      if (this.state.task.current?.id === task.id) {
        this.resultSeq++
        this.patch({
          task: { ...this.state.task, current: null },
          result: { phase: 'idle', taskId: null, data: null, error: null },
        })
      }
      return
    }
    const known = this.buffered.get(task.id)
    if (!known || known.updatedAt <= task.updatedAt) {
      this.buffered.set(task.id, task)
      if (this.buffered.size > MAX_BUFFERED_EVENTS) {
        const oldest = this.buffered.keys().next().value
        if (oldest !== undefined) this.buffered.delete(oldest)
      }
    }
    if (this.state.task.current?.id === task.id) this.applyTask(task)
  }

  /** 应用任务快照：只接受不更旧的快照。 */
  private applyTask(task: Task): void {
    const current = this.state.task.current
    if (!current || current.id !== task.id || task.updatedAt < current.updatedAt) return
    this.patch({ task: { ...this.state.task, current: task } })
    this.afterTaskUpdate(task)
  }

  /** 任务完成时读取结果；任务离开 completed 之外的终态时不读取。 */
  private afterTaskUpdate(task: Task): void {
    if (task.status === 'completed') {
      const result = this.state.result
      const alreadyHandled = result.taskId === task.id && (result.phase === 'loading' || result.phase === 'ready')
      if (!alreadyHandled) void this.loadResult(task.id, false)
    }
  }

  private async loadResult(taskId: string, force: boolean): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    if (!force && this.state.result.taskId === taskId && this.state.result.phase !== 'idle' && this.state.result.phase !== 'error') return
    const token = ++this.resultSeq
    this.patch({ result: { phase: 'loading', taskId, data: null, error: null } })
    try {
      const response = await api.call(CommandTypes.ANALYSIS_RESULT_GET, { id: taskId })
      if (this.disposed || token !== this.resultSeq || this.state.task.current?.id !== taskId) return
      const parsed = parseAnalysisResult(response)
      if (!parsed.ok) {
        this.patch({ result: { phase: 'error', taskId, data: null, error: parsed.reason } })
        return
      }
      this.patch({ result: { phase: 'ready', taskId, data: parsed.result, error: null } })
    } catch (error) {
      if (this.disposed || token !== this.resultSeq || this.state.task.current?.id !== taskId) return
      const view = toErrorView(error)
      this.patch({ result: { phase: 'error', taskId, data: null, error: view.detail ? `${view.title}（${view.detail}）` : view.title } })
    }
  }
}
