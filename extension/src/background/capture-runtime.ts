/**
 * background 采集运行时（P4 接线）。
 *
 * 组装 `TaskManager` + `CaptureController` + `ProductRepository`，把 P4 采集闭环暴露为
 * P1 命令 / 事件：
 * - 处理 Workbench 的 `CAPTURE_*`（CREATE / PAUSE / RESUME / CANCEL / GET）、`TASK_LIST`、
 *   `PRODUCT_LIST`；
 * - 订阅 TaskManager 变更，产出 `TASK_CHANGED` 事件（含完整任务快照，可驱动进度条）；
 * - Worker 启动时执行孤儿任务恢复（running → paused），**绝不自动续跑**。
 *
 * 边界：只做采集；不发送 / 回复聊天、不调用 AI、不触发飞书与发布。
 */
import {
  CommandTypes,
  createErrorResponse,
  createResponse,
  EventTypes,
  genEventId,
  isCaptureCreatePayload,
  isCaptureGetPayload,
  isCaptureSuggestWordsPayload,
  isCaptureTaskRefPayload,
  isProductListPayload,
  isTaskListPayload,
  type CommandEnvelope,
  type ProtocolError,
  type ResponseEnvelope,
  type TaskChangedPayload,
} from '@fishops/shared'
import {
  InvalidTaskTransitionError,
  TaskManager,
  TaskNotFoundError,
} from '../../../shared/task/index'
import type { Task, TaskFilter, TaskStatus, TaskType } from '../../../shared/task/index'
import type { ProductListQuery } from '../../../shared/types/product'
import { CAPTURE_LIMITS, limitText } from '../../../shared/types/capture'
import type {
  CaptureSuggestWordsResult,
  TaskListSortBy,
  TaskListSortOrder,
} from '../../../shared/types/capture'
import { PlatformError } from '../platform/errors'
import { CaptureController, type CapturePlatform } from '../capture/controller'
import type { ProductRepository } from '../../../shared/capture/product-repository'

/** 采集运行时产出的事件信封（形状与 P1 `EventEnvelope` 兼容）。 */
export interface CaptureEventEnvelope {
  kind: 'event'
  type: string
  eventId: string
  payload: unknown
  emittedAt: number
}

export interface CaptureRuntimeDeps {
  /** 平台调用端口（基于 P3 `platform.search` / `platform.detail`）。 */
  platform: CapturePlatform
  /** 商品库仓储（IndexedDB 或内存）。 */
  repository: ProductRepository
  /** 任务存储；缺省自动使用 chrome.storage.session / 内存。 */
  tasks?: TaskManager
  /** 期望最小请求间隔（毫秒），会被强制不低于 1500。 */
  minIntervalMs?: number
  /** 时间源，默认 `Date.now`。 */
  now?: () => number
  /** 休眠实现，默认 `setTimeout`。 */
  sleep?: (ms: number) => Promise<void>
  /** 任务变更事件回调（background 用于广播 `TASK_CHANGED`）。 */
  onEvent?: (event: CaptureEventEnvelope) => void
  /** 获取当前登录用户 ID（用于确认商品归属）。 */
  getCurrentUserId?: () => Promise<string | undefined> | string | undefined
}

export interface CaptureRuntime {
  /** 执行一次启动恢复（running → paused）；幂等。 */
  init(): Promise<void>
  /** 平台层当前是否可用。 */
  isPlatformReady(): boolean
  /** 处理一条 Workbench 采集 / 任务命令。 */
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/** 走本运行时的命令集合。 */
export const CAPTURE_ROUTED_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.CAPTURE_CREATE,
  CommandTypes.CAPTURE_PAUSE,
  CommandTypes.CAPTURE_RESUME,
  CommandTypes.CAPTURE_CANCEL,
  CommandTypes.CAPTURE_GET,
  CommandTypes.CAPTURE_SUGGEST_WORDS,
  CommandTypes.TASK_LIST,
  CommandTypes.PRODUCT_LIST,
])

/** 创建采集运行时。 */
export function createCaptureRuntime(deps: CaptureRuntimeDeps): CaptureRuntime {
  const tasks = deps.tasks ?? new TaskManager()
  const controller = new CaptureController({
    tasks,
    platform: deps.platform,
    repository: deps.repository,
    ...(deps.minIntervalMs === undefined ? {} : { minIntervalMs: deps.minIntervalMs }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    ...(deps.getCurrentUserId === undefined ? {} : { getCurrentUserId: deps.getCurrentUserId }),
  })

  // 订阅任务变更 → 产出 TASK_CHANGED（含完整快照）。
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

  // 启动恢复仅执行一次；running → paused，保留断点，不自动续跑。
  let initPromise: Promise<void> | null = null
  const ensureInit = (): Promise<void> => {
    if (!initPromise) {
      initPromise = tasks.recoverOnStartup({
        strategy: 'paused',
        reason: 'Service Worker 重启，采集任务已挂起，等待手动续采',
      }).then(() => undefined)
    }
    return initPromise
  }

  /** 流量词请求序号：按请求到达顺序同步分配，便于 UI 丢弃乱序的旧响应。 */
  let suggestSequence = 0

  async function handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope> {
    switch (command.type) {
      case CommandTypes.CAPTURE_CREATE:
        return handleCreate(command)
      case CommandTypes.CAPTURE_PAUSE:
        return handleTaskAction(command, 'pause')
      case CommandTypes.CAPTURE_RESUME:
        return handleTaskAction(command, 'resume')
      case CommandTypes.CAPTURE_CANCEL:
        return handleTaskAction(command, 'cancel')
      case CommandTypes.CAPTURE_GET:
        return handleGet(command)
      case CommandTypes.CAPTURE_SUGGEST_WORDS:
        return handleSuggest(command)
      case CommandTypes.TASK_LIST:
        return handleTaskList(command)
      case CommandTypes.PRODUCT_LIST:
        return handleProductList(command)
      default:
        return createErrorResponse(command.requestId, command.type, {
          code: 'UNKNOWN_COMMAND',
          message: `非采集命令: ${command.type}`,
        })
    }
  }

  async function handleCreate(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isCaptureCreatePayload(command.payload)) {
      return invalid(command, 'CAPTURE_CREATE 负载非法：需要非空 keyword 与合法可选字段')
    }
    await ensureInit()
    if (!deps.platform.isAvailable()) {
      return platformUnavailable(command)
    }
    try {
      const task = await controller.create(command.payload)
      // 后台异步执行；进度 / 状态经 TASK_CHANGED 推送。
      void controller.start(task.id).catch((error: unknown) => {
        console.error('[FishOps:Capture] 采集执行失败', error)
      })
      return createResponse(command.requestId, command.type, { task })
    } catch (error) {
      return taskError(command, error)
    }
  }

  async function handleTaskAction(
    command: CommandEnvelope,
    action: 'pause' | 'resume' | 'cancel',
  ): Promise<ResponseEnvelope> {
    if (!isCaptureTaskRefPayload(command.payload)) {
      return invalid(command, `${command.type} 负载非法：需要非空 id`)
    }
    await ensureInit()
    const { id, reason } = command.payload
    try {
      const task =
        action === 'pause'
          ? await controller.pause(id, reason)
          : action === 'resume'
            ? await controller.resume(id)
            : await controller.cancel(id, reason)
      return createResponse(command.requestId, command.type, { task })
    } catch (error) {
      return taskError(command, error)
    }
  }

  async function handleGet(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isCaptureGetPayload(command.payload)) {
      return invalid(command, 'CAPTURE_GET 负载非法：需要非空 id')
    }
    await ensureInit()
    const task = await controller.get(command.payload.id)
    if (!task) {
      return invalid(command, `未找到任务: ${command.payload.id}`)
    }
    return createResponse(command.requestId, command.type, { task })
  }

  async function handleTaskList(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isTaskListPayload(command.payload)) {
      return invalid(command, 'TASK_LIST 负载非法')
    }
    await ensureInit()
    const { type, status, keyword, limit, sortBy, sortOrder } = command.payload
    const filter: TaskFilter = {
      ...(type === undefined ? {} : { type: type as TaskType }),
      ...(status === undefined ? {} : { status: status as TaskStatus }),
    }
    let tasksList: Task[] = await tasks.list(filter)

    // 关键词模糊过滤（匹配采集任务 payload.keyword）；空串视为不限制。
    const needle = (keyword ?? '').trim().toLowerCase()
    if (needle.length > 0) {
      tasksList = tasksList.filter((task) => {
        const taskKeyword = (task.payload as { keyword?: unknown } | undefined)?.keyword
        return typeof taskKeyword === 'string' && taskKeyword.toLowerCase().includes(needle)
      })
    }

    // 排序（默认按创建时间倒序）后再截断，保证 limit 取到的是“最新/最旧”的 N 条。
    tasksList = [...tasksList].sort((a, b) =>
      compareTasks(a, b, sortBy ?? 'createdAt', sortOrder ?? 'desc'),
    )
    if (limit !== undefined) tasksList = tasksList.slice(0, limit)
    return createResponse(command.requestId, command.type, { tasks: tasksList })
  }

  /**
   * CAPTURE_SUGGEST_WORDS：查询流量词（仅建议词，**不创建采集任务、不搜索商品**）。
   * - 空输入不调用平台；
   * - 平台不可用回结构化 PLATFORM_ERROR；
   * - 结果去重 / 限长 / 限条数，并回传 queryId + 单调 sequence。
   */
  async function handleSuggest(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isCaptureSuggestWordsPayload(command.payload)) {
      return invalid(command, 'CAPTURE_SUGGEST_WORDS 负载非法：需要字符串 keyword')
    }
    const { keyword, queryId, limit } = command.payload
    const input = keyword.trim()
    // 空输入不调用平台：直接回结构化错误，绝不发请求、绝不创建任务。
    if (input.length === 0) {
      return invalid(command, 'CAPTURE_SUGGEST_WORDS 负载非法：keyword 不能为空')
    }
    // 序号按请求到达顺序同步分配（早于任何 await），保证并发下仍单调递增。
    const sequence = (suggestSequence += 1)
    await ensureInit()
    if (!deps.platform.isAvailable()) {
      return platformUnavailable(
        command,
        '平台层未就绪：请先打开并登录 goofish.com 闲鱼页面，再查询流量词',
      )
    }
    try {
      const words = await controller.suggest(input, limit)
      const result: CaptureSuggestWordsResult = {
        keyword: limitText(input, CAPTURE_LIMITS.suggestInputMaxLength),
        words,
        sequence,
        ...(queryId === undefined
          ? {}
          : { queryId: limitText(queryId, CAPTURE_LIMITS.suggestQueryIdMaxLength) }),
      }
      return createResponse(command.requestId, command.type, result)
    } catch (error) {
      return platformOrInternalError(command, error)
    }
  }

  async function handleProductList(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isProductListPayload(command.payload)) {
      return invalid(command, 'PRODUCT_LIST 负载非法')
    }
    await ensureInit()
    const page = await controller.listProducts(command.payload as ProductListQuery)
    return createResponse(command.requestId, command.type, {
      products: page.products,
      total: page.total,
    })
  }

  return {
    init: ensureInit,
    isPlatformReady: () => deps.platform.isAvailable(),
    handleCommand,
  }
}

/** 构造 INVALID_PAYLOAD 响应。 */
function invalid(command: CommandEnvelope, message: string): ResponseEnvelope {
  const error: ProtocolError = { code: 'INVALID_PAYLOAD', message }
  return createErrorResponse(command.requestId, command.type, error)
}

/** 平台层不可用：返回结构化 PLATFORM_ERROR（host-unavailable），不创建任务、不假成功。 */
function platformUnavailable(
  command: CommandEnvelope,
  message = '平台层未就绪：请先打开并登录 goofish.com 闲鱼页面，再开始采集',
): ResponseEnvelope {
  return createErrorResponse(command.requestId, command.type, {
    code: 'PLATFORM_ERROR',
    message,
    category: 'host-unavailable',
  })
}

/** 平台错误 → 结构化 PLATFORM_ERROR；非平台错误 → INTERNAL。 */
function platformOrInternalError(command: CommandEnvelope, error: unknown): ResponseEnvelope {
  if (error instanceof PlatformError) {
    return createErrorResponse(command.requestId, command.type, {
      code: 'PLATFORM_ERROR',
      message: error.message,
      category: error.category,
      ...(error.retCode === undefined ? {} : { retCode: error.retCode }),
    })
  }
  return createErrorResponse(command.requestId, command.type, {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
  })
}

/** 任务历史排序比较：按 createdAt / updatedAt，方向可升可降。 */
function compareTasks(
  a: Task,
  b: Task,
  sortBy: TaskListSortBy,
  order: TaskListSortOrder,
): number {
  const diff = (a[sortBy] ?? 0) - (b[sortBy] ?? 0)
  return order === 'asc' ? diff : -diff
}

/** 把任务相关异常归一为协议错误响应。 */
function taskError(command: CommandEnvelope, error: unknown): ResponseEnvelope {
  if (error instanceof TaskNotFoundError) {
    return invalid(command, error.message)
  }
  if (error instanceof InvalidTaskTransitionError) {
    return createErrorResponse(command.requestId, command.type, {
      code: 'INTERNAL',
      message: error.message,
    })
  }
  return createErrorResponse(command.requestId, command.type, {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
  })
}
