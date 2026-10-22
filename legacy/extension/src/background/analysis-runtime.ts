/**
 * background 分析运行时（P7 接线）。
 *
 * 组装 TaskManager + DataSource (Local/Feishu) + PromptRuleStore + AnalysisService，
 * 处理 Workbench 发来的 P7 命令：
 * - DATA_SOURCE_LIST / SCHEMA / QUERY
 * - PROMPT_RULE_LIST / UPSERT / DELETE
 * - ANALYSIS_CREATE / GET / CANCEL / RESULT_GET
 *
 * 订阅 TaskManager 变更向 Workbench 推送 TASK_CHANGED 事件。
 */
import {
  CommandTypes,
  createErrorResponse,
  createResponse,
  EventTypes,
  genEventId,
  isAnalysisCancelPayload,
  isAnalysisCreatePayload,
  isAnalysisGetPayload,
  isAnalysisResultGetPayload,
  isDataSourceListPayload,
  isDataSourceQueryPayload,
  isDataSourceSchemaPayload,
  isPromptRuleDeletePayload,
  isPromptRuleListPayload,
  isPromptRuleUpsertPayload,
  type CommandEnvelope,
  type ProtocolError,
  type ResponseEnvelope,
  type TaskChangedPayload,
} from '@fishops/shared'
import {
  TaskManager,
  TaskNotFoundError,
  type TaskStatus,
} from '../../../shared/task/index'
import type { DataSource } from '../../../shared/data-source/data-source'
import { LocalDataSource } from '../../../shared/data-source/local-data-source'
import type { ProductRepository } from '../../../shared/capture/product-repository'
import { createMemoryProductRepository } from '../../../shared/capture/product-repository'
import {
  MemoryPromptRuleStore,
  StoragePromptRuleStore,
  type PromptRuleStore,
} from '../../../shared/analysis/prompt-rule-store'
import type { PromptRule } from '../../../shared/types/analysis'
import { AnalysisService } from '../analysis/analysis-service'
import {
  OpenAiCompatibleLlmTransport,
  type LlmTransport,
} from '../analysis/llm-transport'
import { FeishuDataSource } from '../../../shared/data-source/feishu-data-source'
import type { FeishuConfig } from '../../../shared/data-source/feishu-types'
import type { AiProviderConfig } from '../../../shared/types/reply'

export interface AnalysisEventEnvelope {
  kind: 'event'
  type: string
  eventId: string
  payload: unknown
  emittedAt: number
}

export interface AnalysisRuntimeDeps {
  tasks?: TaskManager
  rules?: PromptRuleStore
  repository?: ProductRepository
  dataSources?: Map<string, DataSource>
  llm?: LlmTransport
  feishuConfig?: FeishuConfig
  getApiKey?: () => Promise<string | undefined> | string | undefined
  /** 读取全局 AI 供应方配置（apiKey / baseUrl / model / timeoutMs），使自定义端点生效。 */
  getAiProvider?: () => Promise<AiProviderConfig | undefined> | AiProviderConfig | undefined
  onEvent?: (event: AnalysisEventEnvelope) => void
  now?: () => number
}

export interface AnalysisRuntime {
  init(): Promise<void>
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
  registerDataSource(source: DataSource): void
  updateFeishuConfig(config: FeishuConfig): void
}

/** P7 路由器负责的命令集合。 */
export const ANALYSIS_ROUTED_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.DATA_SOURCE_LIST,
  CommandTypes.DATA_SOURCE_SCHEMA,
  CommandTypes.DATA_SOURCE_QUERY,
  CommandTypes.PROMPT_RULE_LIST,
  CommandTypes.PROMPT_RULE_UPSERT,
  CommandTypes.PROMPT_RULE_DELETE,
  CommandTypes.ANALYSIS_CREATE,
  CommandTypes.ANALYSIS_GET,
  CommandTypes.ANALYSIS_CANCEL,
  CommandTypes.ANALYSIS_RESULT_GET,
])

export function createAnalysisRuntime(deps: AnalysisRuntimeDeps): AnalysisRuntime {
  const tasks = deps.tasks ?? new TaskManager()
  const repository = deps.repository ?? createMemoryProductRepository()

  // 默认规则存储：在 Chrome 环境尝试接入 storage，否则使用内存存储
  const rules =
    deps.rules ??
    (typeof chrome !== 'undefined' && chrome.storage?.local
      ? new StoragePromptRuleStore({
          get: (keys) => chrome.storage.local.get(keys),
          set: (items) => chrome.storage.local.set(items),
        })
      : new MemoryPromptRuleStore())

  const dataSources = deps.dataSources ?? new Map<string, DataSource>()
  // 本地数据源仅作内部保留，绝不通过 DATA_SOURCE_* / ANALYSIS_* 命令对外暴露：
  // 数据分析只以飞书表格为准，DATA_SOURCE_LIST 仅返回 feishu，SCHEMA/QUERY 拒绝非 feishu。
  if (!dataSources.has('local')) {
    dataSources.set('local', new LocalDataSource({ repository, now: deps.now }))
  }
  // 注册飞书数据源
  if (deps.feishuConfig && !dataSources.has('feishu')) {
    try {
      dataSources.set('feishu', new FeishuDataSource({ config: deps.feishuConfig, now: deps.now }))
    } catch {
      // 飞书配置不全时忽略，允许后续通过 updateFeishuConfig 动态启用
    }
  }

  const llm = deps.llm ?? new OpenAiCompatibleLlmTransport()

  const service = new AnalysisService({
    tasks,
    rules,
    dataSources,
    llm,
    getApiKey: deps.getApiKey,
    getAiProvider: deps.getAiProvider,
    now: deps.now,
  })

  // 订阅 TaskManager 变更 → 广播 TASK_CHANGED
  tasks.subscribe((event) => {
    if (!deps.onEvent) return
    const previousStatus: TaskStatus | undefined = event.previousStatus
    const payload: TaskChangedPayload = {
      eventType: event.eventType,
      task: event.task,
      ...(previousStatus === undefined ? {} : { previousStatus }),
      timestamp: event.timestamp,
    }
    deps.onEvent({
      kind: 'event',
      type: EventTypes.TASK_CHANGED,
      eventId: genEventId(),
      payload,
      emittedAt: Date.now(),
    })
  })

  let initPromise: Promise<void> | null = null
  const ensureInit = (): Promise<void> => {
    if (!initPromise) {
      // 与采集共享默认存储，仅中止本模块任务，不改写采集断点及其恢复策略。
      initPromise = tasks.recoverOnStartup({
        type: 'analysis',
        strategy: 'failed',
        reason: 'Service Worker 重启，未完成的分析任务已中止',
      }).then(() => undefined)
    }
    return initPromise
  }

  async function handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope> {
    switch (command.type) {
      case CommandTypes.DATA_SOURCE_LIST:
        return handleDataSourceList(command)
      case CommandTypes.DATA_SOURCE_SCHEMA:
        return handleDataSourceSchema(command)
      case CommandTypes.DATA_SOURCE_QUERY:
        return handleDataSourceQuery(command)
      case CommandTypes.PROMPT_RULE_LIST:
        return handlePromptRuleList(command)
      case CommandTypes.PROMPT_RULE_UPSERT:
        return handlePromptRuleUpsert(command)
      case CommandTypes.PROMPT_RULE_DELETE:
        return handlePromptRuleDelete(command)
      case CommandTypes.ANALYSIS_CREATE:
        return handleAnalysisCreate(command)
      case CommandTypes.ANALYSIS_GET:
        return handleAnalysisGet(command)
      case CommandTypes.ANALYSIS_CANCEL:
        return handleAnalysisCancel(command)
      case CommandTypes.ANALYSIS_RESULT_GET:
        return handleAnalysisResultGet(command)
      default:
        return createErrorResponse(command.requestId, command.type, {
          code: 'UNKNOWN_COMMAND',
          message: `非分析命令: ${command.type}`,
        })
    }
  }

  async function handleDataSourceList(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isDataSourceListPayload(command.payload)) {
      return invalid(command, 'DATA_SOURCE_LIST 负载非法')
    }
    // 数据分析只以飞书表格为准：对外仅暴露 feishu，绝不暴露 local 等内部数据源。
    const list = Array.from(dataSources.values())
      .filter((ds) => ds.type === 'feishu')
      .map((ds) => ({
        type: ds.type,
        name: ds.name,
      }))
    return createResponse(command.requestId, command.type, { dataSources: list })
  }

  async function handleDataSourceSchema(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isDataSourceSchemaPayload(command.payload)) {
      return invalid(command, 'DATA_SOURCE_SCHEMA 负载非法：需要非空 type')
    }
    // 纵深防御：数据分析只以飞书表格为准，后台拒绝任何非 feishu 数据源查询。
    if (command.payload.type !== 'feishu') {
      return invalid(
        command,
        `数据分析只以飞书表格为准：DATA_SOURCE_SCHEMA 仅支持 type=feishu，收到 ${command.payload.type}`,
      )
    }
    const ds = dataSources.get(command.payload.type)
    if (!ds) {
      return invalid(command, `未找到数据源: ${command.payload.type}`)
    }
    try {
      const schema = await ds.getSchema()
      return createResponse(command.requestId, command.type, { schema })
    } catch (err) {
      return internalError(command, `获取 Schema 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleDataSourceQuery(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isDataSourceQueryPayload(command.payload)) {
      return invalid(command, 'DATA_SOURCE_QUERY 负载非法')
    }
    // 纵深防御：数据分析只以飞书表格为准，后台拒绝任何非 feishu 数据源查询。
    if (command.payload.type !== 'feishu') {
      return invalid(
        command,
        `数据分析只以飞书表格为准：DATA_SOURCE_QUERY 仅支持 type=feishu，收到 ${command.payload.type}`,
      )
    }
    const ds = dataSources.get(command.payload.type)
    if (!ds) {
      return invalid(command, `未找到数据源: ${command.payload.type}`)
    }
    try {
      const dataset = await ds.query(command.payload.filter || command.payload.params)
      return createResponse(command.requestId, command.type, { dataset })
    } catch (err) {
      return internalError(command, `查询数据源失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handlePromptRuleList(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isPromptRuleListPayload(command.payload)) {
      return invalid(command, 'PROMPT_RULE_LIST 负载非法')
    }
    const ruleList = await rules.list()
    return createResponse(command.requestId, command.type, { rules: ruleList })
  }

  async function handlePromptRuleUpsert(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isPromptRuleUpsertPayload(command.payload)) {
      return invalid(command, 'PROMPT_RULE_UPSERT 负载非法')
    }
    try {
      const saved = await rules.upsert(command.payload.rule as PromptRule)
      return createResponse(command.requestId, command.type, { rule: saved })
    } catch (err) {
      return invalid(command, `保存规则失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handlePromptRuleDelete(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isPromptRuleDeletePayload(command.payload)) {
      return invalid(command, 'PROMPT_RULE_DELETE 负载非法')
    }
    const success = await rules.delete(command.payload.id)
    return createResponse(command.requestId, command.type, { success })
  }

  async function handleAnalysisCreate(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isAnalysisCreatePayload(command.payload)) {
      return invalid(command, 'ANALYSIS_CREATE 负载非法：缺少必填字段')
    }
    // 数据分析只以飞书表格为准：分析任务强制 dataSourceType=feishu
    if (command.payload.dataSourceType !== 'feishu') {
      return invalid(
        command,
        `数据分析只以飞书表格为准，不支持 ${command.payload.dataSourceType} 数据源，dataSourceType 必须为 feishu`,
      )
    }
    if (!dataSources.has('feishu')) {
      return createErrorResponse(command.requestId, command.type, {
        code: 'INVALID_PAYLOAD',
        businessCode: 'CONFIG_MISSING',
        message: '未配置飞书多维表格数据源，无法创建分析任务。请先前往设置页完成飞书配置。',
      })
    }
    await ensureInit()
    try {
      const task = await service.createTask(command.payload)
      // 后台异步执行分析主流程，进度与状态经 TASK_CHANGED 广播推送
      void service.executeTask(task.id).catch((err) => {
        console.error('[FishOps:Analysis] 异步分析执行异常:', err)
      })
      return createResponse(command.requestId, command.type, { task })
    } catch (err) {
      return invalid(command, `创建分析任务失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function handleAnalysisGet(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isAnalysisGetPayload(command.payload)) {
      return invalid(command, 'ANALYSIS_GET 负载非法')
    }
    await ensureInit()
    const task = await tasks.getById(command.payload.id)
    if (!task) {
      return invalid(command, `未找到分析任务: ${command.payload.id}`)
    }
    return createResponse(command.requestId, command.type, { task })
  }

  async function handleAnalysisCancel(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isAnalysisCancelPayload(command.payload)) {
      return invalid(command, 'ANALYSIS_CANCEL 负载非法')
    }
    await ensureInit()
    try {
      const task = await service.cancelTask(command.payload.id, command.payload.reason)
      return createResponse(command.requestId, command.type, { task })
    } catch (err) {
      return taskError(command, err)
    }
  }

  async function handleAnalysisResultGet(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isAnalysisResultGetPayload(command.payload)) {
      return invalid(command, 'ANALYSIS_RESULT_GET 负载非法')
    }
    await ensureInit()
    const task = await tasks.getById(command.payload.id)
    if (!task) {
      return invalid(command, `未找到分析任务: ${command.payload.id}`)
    }
    return createResponse(command.requestId, command.type, {
      result: task.result,
    })
  }

  return {
    init: ensureInit,
    handleCommand,
    registerDataSource: (source) => {
      dataSources.set(source.type, source)
    },
    updateFeishuConfig: (config) => {
      try {
        dataSources.set('feishu', new FeishuDataSource({ config, now: deps.now }))
      } catch (err) {
        console.warn('[FishOps:Analysis] 更新飞书配置失败', err)
      }
    },
  }
}

function invalid(command: CommandEnvelope, message: string): ResponseEnvelope {
  const error: ProtocolError = { code: 'INVALID_PAYLOAD', message }
  return createErrorResponse(command.requestId, command.type, error)
}

function internalError(command: CommandEnvelope, message: string): ResponseEnvelope {
  const error: ProtocolError = { code: 'INTERNAL', message }
  return createErrorResponse(command.requestId, command.type, error)
}

function taskError(command: CommandEnvelope, error: unknown): ResponseEnvelope {
  if (error instanceof TaskNotFoundError) {
    return invalid(command, error.message)
  }
  return internalError(command, error instanceof Error ? error.message : String(error))
}
