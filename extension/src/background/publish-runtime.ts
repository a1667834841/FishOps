/**
 * PublishRuntime - background 发布中心运行时（P8 接线）。
 *
 * 组装 TaskManager + PublishController + TabManager/Tabs + PublishFormFiller，
 * 把 P8 发布中心闭环暴露为 P1 命令 / 事件：
 * - 处理 Workbench 的 PUBLISH_* 命令（CREATE / LIST / GET / FILL_FORM / CANCEL / PAUSE / RESUME / CONFIRM_STATUS / SUBMIT）；
 * - 严格来源校验与参数校验；从指定 itemId 显式读取商品，严禁偷偷随机选择；
 * - 自动打开/复用 https://www.goofish.com/publish* 标签页，默认 active:false 优先；
 * - 表单填充执行到“表单已填充/等待确认”（waiting_confirmation）就停止，且绝不提交；
 * - 最终提交只能由用户在工作台明确点击一次“发布”触发 PUBLISH_SUBMIT：
 *   仅对 waiting_confirmation 任务、携带一次性令牌、tabId 必须是本任务目标发布页、
 *   页面状态仍有效时才点击真实发布按钮一次；网络超时/未知结果标记 unknown 且绝不自动重试；
 * - Service Worker 重启恢复：running 状态恢复为 paused（保留断点），waiting_confirmation 保持原样，绝不自动重跑或自动提交。
 */

import {
  CommandTypes,
  createErrorResponse,
  createResponse,
  EventTypes,
  genEventId,
  isPublishCancelPayload,
  isPublishConfirmStatusPayload,
  isPublishCreatePayload,
  isPublishFillFormPayload,
  isPublishGetPayload,
  isPublishListPayload,
  isPublishPausePayload,
  isPublishResumePayload,
  isPublishSubmitPayload,
  PublishError,
  type CommandEnvelope,
  type ProtocolError,
  type PublishConfirmStatusResult,
  type PublishCreateResult,
  type PublishErrorCode,
  type PublishFillFormResult,
  type PublishGetResult,
  type PublishItemOverride,
  type PublishListResult,
  type PublishManualConfirmationStatus,
  type PublishRule,
  type PublishSubmitRecord,
  type PublishSubmitResult,
  type PublishTask,
  type PublishTaskChangedPayload,
  type PublishTaskListFilter,
  type PublishTaskResult,
  type PublishTaskStatus,
  type ResponseEnvelope,
  type TaskChangedPayload,
} from '@fishops/shared'
import {
  InvalidTaskTransitionError,
  TaskManager,
  TaskNotFoundError,
  type Task,
  type TaskFilter,
  type TaskStatus,
} from '../../../shared/task/index'
import type { ProductRepository } from '../../../shared/capture/product-repository'
import {
  PublishController,
  type ImageDownloader,
  type PreparedImageFile,
} from '../publish/controller'
import {
  DOMPublishFormFiller,
  type FormFillResult,
  type FormSubmitResult,
  type PublishFormFiller,
  type ScriptingExecutor,
} from '../publish/form-filler'
import type { TabLike, TabsApi } from './tab-manager'

/**
 * 发布运行时事件信封
 */
export interface PublishEventEnvelope {
  kind: 'event'
  type: string
  eventId: string
  payload: unknown
  emittedAt: number
}

/**
 * PublishRuntime 依赖配置
 */
export interface PublishRuntimeDeps {
  /** 商品仓储（P4 ProductRepository） */
  repository: ProductRepository
  /** 任务管理器；缺省自动使用默认持久化 Store */
  tasks?: TaskManager
  /** Chrome Tabs API 抽象 */
  tabs?: TabsApi
  /** 脚本执行器（用于注入表单填充） */
  scripting?: ScriptingExecutor
  /** 发布业务控制器（缺省自动根据 repository 构造） */
  controller?: PublishController
  /** 图片下载器（用于单测 mock） */
  imageDownloader?: ImageDownloader
  /** 表单填充器（缺省自动使用 DOMPublishFormFiller） */
  formFiller?: PublishFormFiller
  /** 闲鱼发布页基础 URL，默认 'https://www.goofish.com/publish' */
  publishUrl?: string
  /** 标签页等待完成超时毫秒数，默认 15000 */
  loadTimeoutMs?: number
  /** 提交后观察标签页跳转的最长毫秒数，默认 8000 */
  submitObserveTimeoutMs?: number
  /** 提交后轮询标签页跳转的间隔毫秒数，默认 300 */
  submitObserveIntervalMs?: number
  /** 时间发生器 */
  now?: () => number
  /** 休眠发生器 */
  sleep?: (ms: number) => Promise<void>
  /** 任务变更事件回调（用于 background 广播 TASK_CHANGED 与 PUBLISH_TASK_CHANGED） */
  onEvent?: (event: PublishEventEnvelope) => void
}

/**
 * 发布运行时接口
 */
export interface PublishRuntime {
  /** 启动初始化（幂等执行孤儿任务恢复） */
  init(): Promise<void>
  /** 确保闲鱼发布页打开或复用（默认 active: false） */
  ensurePublishTab(options?: { active?: boolean }): Promise<{ tab: TabLike; created: boolean }>
  /** 执行表单填充（到 waiting_confirmation 即停，绝不提交） */
  fillForm(taskId: string): Promise<PublishTask>
  /**
   * 处理一条发布命令。
   *
   * 注意：最终提交不对外暴露独立方法，只能经此方法派发 `PUBLISH_SUBMIT` 命令触发，
   * 避免任何调用方绕过协议直接点击真实发布按钮。
   */
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

export const DEFAULT_PUBLISH_URL = 'https://www.goofish.com/publish'
export const DEFAULT_LOAD_TIMEOUT_MS = 15000
export const DEFAULT_SUBMIT_OBSERVE_TIMEOUT_MS = 8000
export const DEFAULT_SUBMIT_OBSERVE_INTERVAL_MS = 300

/**
 * 判断 URL 是否属于闲鱼发布页
 */
export function isGoofishPublishUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return (
      (parsed.hostname === 'goofish.com' || parsed.hostname.endsWith('.goofish.com')) &&
      parsed.pathname.startsWith('/publish')
    )
  } catch {
    return false
  }
}

/**
 * 创建发布运行时实例
 */
export function createPublishRuntime(deps: PublishRuntimeDeps): PublishRuntime {
  const tasks = deps.tasks ?? new TaskManager()
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const publishUrl = deps.publishUrl ?? DEFAULT_PUBLISH_URL
  const loadTimeoutMs = deps.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
  const submitObserveTimeoutMs = deps.submitObserveTimeoutMs ?? DEFAULT_SUBMIT_OBSERVE_TIMEOUT_MS
  const submitObserveIntervalMs = deps.submitObserveIntervalMs ?? DEFAULT_SUBMIT_OBSERVE_INTERVAL_MS

  const controller =
    deps.controller ??
    new PublishController({
      repository: deps.repository,
      imageDownloader: deps.imageDownloader,
      now,
    })

  const formFiller =
    deps.formFiller ??
    new DOMPublishFormFiller({
      executor: deps.scripting,
    })

  let cachedPublishTabId: number | null = null

  /**
   * 正在提交中的任务 ID 集合：用于同步阻止并发重复点击（同一任务同一时刻只允许一次提交）。
   * 一次性令牌 + meta.submitAttempted 负责跨请求/跨 SW 重启的防重放。
   */
  const inFlightSubmits = new Set<string>()

  /**
   * 生成一次性提交令牌。
   */
  function generateSubmitToken(): string {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `sub_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
      }
    } catch {
      // 降级到随机字符串
    }
    return `sub_${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
  }

  /**
   * 将通用 Task 实例转换为具备严格类型的 PublishTask，去除模糊类型强转
   */
  function toPublishTask(task: Task<any, any, any, any, any>): PublishTask {
    const payload = (task.payload ?? {}) as PublishTask['payload']
    const result = (task.result ?? undefined) as PublishTask['result']
    const meta = (task.meta ?? undefined) as PublishTask['meta']
    const status = task.status as PublishTaskStatus
    return {
      ...task,
      type: 'publish',
      payload,
      result,
      meta,
      status,
    }
  }

  // 订阅任务变更 → 同时向外广播统一 TASK_CHANGED 与专属 PUBLISH_TASK_CHANGED
  tasks.subscribe((event) => {
    if (!deps.onEvent) return
    const prev = event.previousStatus

    // 1. 统一 TASK_CHANGED 广播
    const taskChangedPayload: TaskChangedPayload = {
      eventType: event.eventType,
      task: event.task,
      ...(prev === undefined ? {} : { previousStatus: prev as TaskStatus }),
      timestamp: event.timestamp,
    }
    deps.onEvent({
      kind: 'event',
      type: EventTypes.TASK_CHANGED,
      eventId: genEventId(),
      payload: taskChangedPayload,
      emittedAt: now(),
    })

    // 2. 发布中心专属 PUBLISH_TASK_CHANGED 广播
    if (event.task.type === 'publish') {
      const publishPayload: PublishTaskChangedPayload = {
        eventType: event.eventType,
        task: toPublishTask(event.task),
        ...(prev === undefined ? {} : { previousStatus: prev as PublishTaskStatus }),
        timestamp: event.timestamp,
      }
      deps.onEvent({
        kind: 'event',
        type: EventTypes.PUBLISH_TASK_CHANGED,
        eventId: genEventId(),
        payload: publishPayload,
        emittedAt: now(),
      })
    }
  })

  // 启动恢复：Service Worker 重启时仅扫描并挂起 publish 类型的 running 任务，绝不影响 capture/analysis 共用存储！
  let initPromise: Promise<void> | null = null
  const ensureInit = (): Promise<void> => {
    if (!initPromise) {
      initPromise = (async () => {
        // 关键约束：所有任务恢复仅限 publish 类型，不能影响 capture/analysis 共用 storage
        const runningPublishTasks = await tasks.list({ type: 'publish', status: 'running' })
        for (const t of runningPublishTasks) {
          try {
            const note = 'Service Worker 重启，未完成的发布填充已安全挂起，等待人工核实续跑'
            await tasks.updateProgress(t.id, t.progress, { recoveryNote: note })
            await tasks.pause(t.id, note)
          } catch {
            // 忽略并发状态迁移
          }
        }
        // waiting_confirmation 状态完全保持原样，不自动重跑，绝不自动提交发布
      })()
    }
    return initPromise
  }

  // 监听 Tab 关闭事件以清理缓存
  if (deps.tabs?.onRemoved) {
    try {
      deps.tabs.onRemoved.addListener((tabId) => {
        if (cachedPublishTabId === tabId) {
          cachedPublishTabId = null
        }
      })
    } catch {
      // 容忍非完整 Chrome 环境
    }
  }

  /**
   * 查找或创建闲鱼发布页 Tab（默认 active: false，不抢占焦点）
   */
  async function ensurePublishTab(options?: { active?: boolean }): Promise<{ tab: TabLike; created: boolean }> {
    if (!deps.tabs) {
      // 在无 tabs 的轻量单测环境下提供虚拟 tab
      return {
        tab: { id: 8888, url: publishUrl, active: options?.active ?? false, status: 'complete' },
        created: false,
      }
    }

    // 1. 先验证缓存的 tab 是否有效
    if (cachedPublishTabId !== null) {
      try {
        const cached = await deps.tabs.get(cachedPublishTabId)
        if (cached && isGoofishPublishUrl(cached.url)) {
          return { tab: cached, created: false }
        }
      } catch {
        cachedPublishTabId = null
      }
    }

    // 2. 全局查找已有的闲鱼发布页 tab
    try {
      const allTabs = await deps.tabs.query({})
      const publishTabs = allTabs.filter((t) => isGoofishPublishUrl(t.url) && t.id !== undefined)
      if (publishTabs.length > 0) {
        // 优先复用已有发布页
        const chosen = publishTabs.find((t) => t.active === true) ?? publishTabs[0]!
        cachedPublishTabId = chosen.id ?? null
        return { tab: chosen, created: false }
      }
    } catch {
      // 继续往下尝试新建
    }

    // 3. 不存在时创建新标签页，默认 active: false
    const active = options?.active ?? false
    let createdTab: TabLike
    try {
      createdTab = await deps.tabs.create({ url: publishUrl, active })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new PublishError('TAB_LOAD_FAILED', `创建发布页标签失败: ${msg}`, { details: err })
    }

    cachedPublishTabId = createdTab.id ?? null

    // 4. 等待页面加载至 complete（限制超时）
    if (createdTab.id !== undefined && createdTab.status !== 'complete') {
      const tabId = createdTab.id
      const startTime = now()
      let isComplete = false

      while (now() - startTime < loadTimeoutMs) {
        await sleep(300)
        try {
          const fresh = await deps.tabs.get(tabId)
          if (!fresh) {
            throw new PublishError('TAB_LOAD_FAILED', '发布页标签在加载过程中被意外关闭')
          }
          if (fresh.status === 'complete') {
            createdTab = fresh
            isComplete = true
            break
          }
        } catch (e) {
          if (e instanceof PublishError) throw e
          break
        }
      }

      if (!isComplete) {
        throw new PublishError(
          'TAB_LOAD_FAILED',
          `发布页加载超时 (${loadTimeoutMs}ms)，请检查网络连接或闲鱼访问状态`,
          { retryable: false },
        )
      }
    }

    return { tab: createdTab, created: true }
  }

  /**
   * 检查任务是否在 inflight 期间被取消或暂停
   */
  async function checkInflightAborted(taskId: string): Promise<Task | null> {
    const latest = await tasks.getById(taskId)
    if (!latest) return null
    if (latest.status === 'cancelled' || latest.status === 'paused') {
      return latest
    }
    return null
  }

  /**
   * 创建发布任务
   */
  async function createTask(payload: {
    itemId: string
    rule?: Partial<PublishRule>
    override?: PublishItemOverride
  }): Promise<PublishTask> {
    await ensureInit()
    // 严格调用 controller 预校验商品存在性与规则合法性
    const publishItem = await controller.preparePublishItem(
      payload.itemId,
      payload.rule,
      payload.override,
    )

    const created = await tasks.create<'publish'>({
      type: 'publish',
      payload: {
        itemId: publishItem.itemId,
        rule: payload.rule,
        override: payload.override,
      },
      meta: {
        sourceProductSnapshot: {
          itemId: publishItem.itemId,
          title: publishItem.sourceTitle,
          price: String(publishItem.sourcePrice),
          capturedAt: now(),
        },
        history: [
          {
            timestamp: now(),
            action: 'create',
            detail: `从指定商品 \"${publishItem.itemId}\" 创建发布任务`,
          },
        ],
      },
    })

    return toPublishTask(created)
  }

  /**
   * 执行表单填充（核心执行逻辑，到 waiting_confirmation 即停）
   */
  async function fillForm(taskId: string): Promise<PublishTask> {
    await ensureInit()
    const current = await tasks.getById(taskId)
    if (!current) {
      throw new PublishError('INVALID_PAYLOAD', `未找到 ID 为 "${taskId}" 的发布任务`)
    }
    // Task 泛型状态类型不含 waiting_confirmation，发布任务状态由运行时专用类型收窄
    const currentStatus = current.status as PublishTaskStatus

    // 状态守卫（关键修复）：必须位于任何状态变更与 try 之前，绝不能被下方 catch 捕获后误置为 failed。
    // 1) waiting_confirmation：表单已填充完毕，正等待人工确认。再次填充会破坏任务、一次性 submitToken
    //    与人工确认状态，因此结构化拒绝并保持三者完全不变；
    // 2) running：已有一次填充正在执行，重复进入会并发破坏同一任务状态（如进度/结果相互覆盖），同样拒绝；
    // 3) 终态：不可再次执行。
    if (currentStatus === 'waiting_confirmation') {
      throw new PublishError(
        'INVALID_PAYLOAD',
        `任务 "${taskId}" 已处于 waiting_confirmation，重复填充已拒绝：` +
          '请直接提交（PUBLISH_SUBMIT）或取消放弃，任务状态与提交令牌保持不变',
        { retryable: false },
      )
    }
    if (currentStatus === 'running') {
      throw new PublishError(
        'INVALID_PAYLOAD',
        `任务 "${taskId}" 正在填充中，已阻止重复执行，避免并发破坏任务状态`,
        { retryable: false },
      )
    }
    if (currentStatus === 'completed' || currentStatus === 'failed' || currentStatus === 'cancelled') {
      throw new PublishError(
        'INVALID_PAYLOAD',
        `任务 "${taskId}" 当前处于终态 "${currentStatus}"，不可重复填充`,
        { retryable: false },
      )
    }

    // 1. 流转到 running 状态
    let runningTask: Task
    if (current.status === 'pending') {
      runningTask = await tasks.start(taskId)
    } else if (current.status === 'paused') {
      runningTask = await tasks.resume(taskId)
    } else {
      runningTask = current
    }

    await tasks.updateProgress(taskId, 15, { step: 'preparing_item' })

    try {
      const payload = runningTask.payload as {
        itemId: string
        rule?: Partial<PublishRule>
        override?: PublishItemOverride
      }

      // 2. 准备商品与规则计算
      const item = await controller.preparePublishItem(
        payload.itemId,
        payload.rule,
        payload.override,
      )

      // inflight 取消/暂停保护检查点 1
      const aborted1 = await checkInflightAborted(taskId)
      if (aborted1) return toPublishTask(aborted1)

      await tasks.updateProgress(taskId, 40, { step: 'preparing_images' })

      // 3. 准备与校验图片（全部本地/HTTPS 校验，不真实发布）
      let preparedImages: PreparedImageFile[] = []
      try {
        preparedImages = await controller.prepareImages(item.allImages)
      } catch (err) {
        if (err instanceof PublishError) throw err
        const msg = err instanceof Error ? err.message : String(err)
        throw new PublishError('IMAGE_DOWNLOAD_FAILED', `准备图片失败: ${msg}`, { details: err })
      }

      // inflight 取消/暂停保护检查点 2
      const aborted2 = await checkInflightAborted(taskId)
      if (aborted2) return toPublishTask(aborted2)

      await tasks.updateProgress(taskId, 65, { step: 'ensuring_tab' })

      // 4. 打开/复用后台发布页 Tab（active: false 优先）
      const { tab } = await ensurePublishTab({ active: false })
      const tabId = tab.id ?? 0

      // inflight 取消/暂停保护检查点 3
      const aborted3 = await checkInflightAborted(taskId)
      if (aborted3) return toPublishTask(aborted3)

      await tasks.updateProgress(taskId, 85, { step: 'filling_form' })

      // 5. 调用 FormFiller 填充表单字段
      const fillResult: FormFillResult = await formFiller.fill(tabId, item, preparedImages)

      // inflight 取消/暂停保护检查点 4
      const aborted4 = await checkInflightAborted(taskId)
      if (aborted4) return toPublishTask(aborted4)

      // 6. 严格校验：只有标题、描述、售价、原价、图片全部填充且回读校验通过，
      //    才允许进入 waiting_confirmation；任何一项未通过都视为失败，绝不假成功。
      const summary = fillResult.fillSummary
      const allFieldsVerified =
        fillResult.ok === true &&
        summary.titleFilled === true &&
        summary.descFilled === true &&
        summary.priceFilled === true &&
        summary.origPriceFilled === true &&
        summary.mainImageUploaded === true &&
        (fillResult.imagesFailed?.length ?? 0) === 0

      if (!allFieldsVerified) {
        const reason =
          fillResult.errors && fillResult.errors.length > 0
            ? fillResult.errors.join('; ')
            : '存在未成功填充或未通过回读校验的字段'
        throw new PublishError(
          'FORM_FIELD_CHANGED',
          `表单填充未全部通过校验，拒绝进入 waiting_confirmation 以免假成功: ${reason}`,
          { retryable: false, details: fillResult },
        )
      }

      // 7. 全部字段验证通过，执行到表单填充完成，进入 waiting_confirmation 等待用户确认发布，
      //    同时下发一次性提交令牌：最终提交必须携带该令牌，点击后立即失效。
      const submitToken = generateSubmitToken()
      const resultPayload = {
        item: {
          ...item,
          confirmationStatus: 'waiting_review' as PublishManualConfirmationStatus,
        },
        filledAt: now(),
        tabId,
        formUrl: tab.url || publishUrl,
        fillSummary: fillResult.fillSummary,
        confirmationStatus: 'waiting_review' as PublishManualConfirmationStatus,
        manualConfirmNote: '表单已自动填充并通过校验，可在发布中心点击一次“发布”完成提交',
        submitToken,
      }

      const finalTask = await tasks.waitForConfirmation(taskId, {
        progress: 100,
        result: resultPayload,
        meta: {
          step: 'waiting_confirmation',
          filledTabId: tabId,
          submitAttempted: false,
          filledFormUrl: tab.url || publishUrl,
        },
      })

      return toPublishTask(finalTask)
    } catch (error: unknown) {
      // 若当前任务已经被外部取消或暂停，不得覆盖为 failed！
      const aborted = await checkInflightAborted(taskId)
      if (aborted) {
        return toPublishTask(aborted)
      }

      const publishErr =
        error instanceof PublishError
          ? error
          : new PublishError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error))

      await tasks.fail(taskId, publishErr.message)
      throw publishErr
    }
  }

  /**
   * 将注入侧返回的结构化原因码映射为发布错误码（未知一律回退 FORM_FIELD_CHANGED）。
   */
  function toSubmitErrorCode(code: string | undefined): PublishErrorCode {
    const allowed: string[] = [
      'SUBMIT_PAGE_INVALID',
      'NOT_LOGGED_IN',
      'VERIFICATION_REQUIRED',
      'FORM_FIELD_CHANGED',
      'SUBMIT_BUTTON_NOT_FOUND',
      'SUBMIT_BUTTON_DISABLED',
    ]
    return code && allowed.includes(code) ? (code as PublishErrorCode) : 'FORM_FIELD_CHANGED'
  }

  /**
   * 持久化提交尝试记录（一次合法的 waiting_confirmation -> paused -> waiting_confirmation 往返）。
   *
   * TaskManager 没有面向 waiting_confirmation 的通用结果更新接口，而
   * `pause` -> `updateProgress` -> `waitForConfirmation` 三者均为合法状态迁移，
   * 因此借其写入 `submitAttempted` 与 `submit` 记录，最终仍回到 waiting_confirmation，
   * 保证即使 Service Worker 在观察期间被销毁，重启后也无法再次提交（绝不重复发布）。
   */
  async function persistSubmitRecord(
    taskId: string,
    record: PublishSubmitRecord,
    options: { clearToken: boolean; submitAttempted?: boolean },
  ): Promise<PublishTask> {
    const current = await tasks.getById(taskId)
    if (!current) {
      throw new PublishError('INVALID_PAYLOAD', `未找到任务 "${taskId}"`)
    }
    const currentResult = (current.result ?? {}) as unknown as PublishTaskResult
    const submitAttempted = options.submitAttempted ?? true

    // waiting_confirmation -> paused（合法）
    await tasks.pause(taskId, `提交状态持久化：${record.state}`)
    // paused 允许更新进度与 meta
    await tasks.updateProgress(taskId, 100, {
      submitAttempted,
      submitAttemptedAt: record.attemptedAt,
      submitState: record.state,
      submitRecord: record,
    })
    // paused -> waiting_confirmation（合法），同时回写 result.submit / 可选清除令牌
    const nextResult: PublishTaskResult = { ...currentResult, submit: record }
    if (options.clearToken) delete nextResult.submitToken
    const back = await tasks.waitForConfirmation(taskId, {
      progress: 100,
      result: nextResult,
      meta: { step: 'waiting_confirmation' },
    })
    return toPublishTask(back)
  }

  /**
   * 回滚“点击前 dispatching 锁”。
   *
   * 仅当注入侧确定性确认“未派发任何点击”（未找到按钮 / 按钮禁用 / 页面状态失效）时调用：
   * 把 `meta.submitAttempted` 复位为 false、清除进行中的 `result.submit` 记录并保留一次性令牌，
   * 使用户修正页面后仍可用同一令牌显式重试。
   *
   * 已派发点击 / 结果未知 / 注入异常一律不得走此路径（必须保持锁定，绝不重复发布）。
   */
  async function rollbackSubmitDispatching(taskId: string): Promise<PublishTask> {
    const current = await tasks.getById(taskId)
    if (!current) {
      throw new PublishError('INVALID_PAYLOAD', `未找到任务 "${taskId}"`)
    }
    const currentResult = (current.result ?? {}) as unknown as PublishTaskResult
    const nextResult: PublishTaskResult = { ...currentResult }
    delete nextResult.submit

    // waiting_confirmation -> paused -> waiting_confirmation（合法往返），复位提交锁
    await tasks.pause(taskId, '提交未派发，回滚 dispatching 锁')
    await tasks.updateProgress(taskId, 100, {
      submitAttempted: false,
      submitAttemptedAt: undefined,
      submitState: undefined,
      submitRecord: undefined,
    })
    return toPublishTask(
      await tasks.waitForConfirmation(taskId, {
        progress: 100,
        result: nextResult,
        meta: { step: 'waiting_confirmation' },
      }),
    )
  }

  /**
   * 提交后观察标签页是否已离开发布页，作为“提交成功”的判定依据。
   *
   * - 观察到 URL 不再是 goofish 发布页 -> 'submitted'；
   * - 无 tabs 能力 / 超时 / 标签页查询异常 / 标签页被关闭 -> 'unknown'（绝不自动重试）。
   */
  async function observeSubmitOutcome(tabId: number): Promise<'submitted' | 'unknown'> {
    if (!deps.tabs) return 'unknown'
    const deadline = now() + submitObserveTimeoutMs
    for (;;) {
      try {
        const tab = await deps.tabs.get(tabId)
        if (!tab) return 'unknown'
        if (!isGoofishPublishUrl(tab.url)) return 'submitted'
      } catch {
        // 标签页可能正在跳转 / 被关闭，无法判定 -> unknown
        return 'unknown'
      }
      if (now() >= deadline) return 'unknown'
      await sleep(submitObserveIntervalMs)
    }
  }

  /**
   * 执行最终提交（唯一允许点击真实发布按钮的路径）。
   *
   * 安全闭环：
   * 1. 仅 waiting_confirmation 任务；2. 携带一次性令牌且未提交过；3. tabId 必须是
   * 本任务目标发布页且页面状态仍有效；4. **点击前先把 dispatching 锁落盘**
   * （防 Service Worker 在点击后、结果持久化前重启造成重复发布），只点击真实发布按钮一次；
   * 5. 注入侧确定性确认“未派发点击”时回滚锁并保留令牌供重试；
   * 已派发 / 结果未知 / 注入异常一律保持锁定，结果未知标记 unknown 且绝不自动重试。
   */
  async function submitForm(payload: {
    id: string
    submitToken: string
    confirm: true
  }): Promise<PublishSubmitResult> {
    await ensureInit()

    // 1. 显式确认（双重防线；codec 已强制）
    if (payload.confirm !== true) {
      throw new PublishError('SUBMIT_NOT_ALLOWED', '最终提交必须携带 confirm:true 显式确认')
    }

    const task = await getTask(payload.id)
    if (!task) {
      throw new PublishError('INVALID_PAYLOAD', `未找到任务 "${payload.id}"`)
    }

    // 2. 仅允许 waiting_confirmation 任务
    if (task.status !== 'waiting_confirmation') {
      throw new PublishError(
        'SUBMIT_NOT_ALLOWED',
        `任务 "${task.id}" 当前状态为 "${task.status}"，只有 waiting_confirmation 任务可提交`,
      )
    }

    // 3. 并发重复点击保护：同步“检查-占位”。
    //    关键：检查与 add 之间不得有 await，否则并发请求会同时通过检查后各自点击，
    //    造成重复发布；若已有同任务提交在进行中则直接拒绝。
    if (inFlightSubmits.has(task.id)) {
      throw new PublishError('SUBMIT_DUPLICATE', `任务 "${task.id}" 正在提交中，已阻止重复点击`, {
        retryable: false,
      })
    }
    inFlightSubmits.add(task.id)

    try {
      // 4. 已派发过提交的任务永不重试（包含结果未知的场景）
      if ((task.meta?.submitAttempted as boolean | undefined) === true) {
        throw new PublishError(
          'SUBMIT_DUPLICATE',
          `任务 "${task.id}" 已派发过提交，为避免重复发布已拒绝再次提交`,
          { retryable: false },
        )
      }

      // 5. 一次性令牌校验
      const expectedToken = task.result?.submitToken
      if (!expectedToken || expectedToken !== payload.submitToken) {
        throw new PublishError('SUBMIT_TOKEN_INVALID', '提交令牌缺失或已失效，请重新填充表单', {
          retryable: false,
        })
      }

      // 6. tabId 必须是本任务实际填充的目标发布页（绝不提交到任意其它标签页）
      const targetTabId =
        typeof task.result?.tabId === 'number'
          ? task.result.tabId
          : typeof (task.meta?.filledTabId as number | undefined) === 'number'
            ? (task.meta?.filledTabId as number)
            : undefined
      if (targetTabId === undefined) {
        throw new PublishError('SUBMIT_NOT_ALLOWED', '任务缺少目标发布页 tabId，无法提交', {
          retryable: false,
        })
      }
      if (deps.tabs) {
        let tab: TabLike | null = null
        try {
          tab = await deps.tabs.get(targetTabId)
        } catch {
          tab = null
        }
        if (!tab || !isGoofishPublishUrl(tab.url)) {
          throw new PublishError(
            'SUBMIT_PAGE_INVALID',
            `目标发布页 tab ${targetTabId} 不存在或已不是闲鱼发布页`,
            { retryable: false },
          )
        }
      }

      if (typeof formFiller.submit !== 'function') {
        throw new PublishError('INTERNAL_ERROR', '当前表单填充器不支持提交操作', { retryable: false })
      }

      // 7. 提交前重新确认页面状态仍有效（登录态 / 验证码 / 发布页）
      await formFiller.checkPageStatus(targetTabId)

      // 8. 【防重复发布·关键顺序】在派发真实点击之前，先把“已尝试提交”锁持久化落盘：
      //    - 若 Service Worker 在点击之后、结果持久化之前被销毁并重启，
      //      `meta.submitAttempted === true` 已经落盘，重启后第 4 步会直接拒绝再次提交；
      //    - 该阶段只标记“已请求派发、正在执行”，`state` 为 in_progress（绝不写成 submitted），
      //      因此 dispatching 状态绝不会被误判为提交成功；
      //    - 令牌此阶段暂不清除，仅当确定性确认“未派发点击”时才回滚并保留令牌供重试。
      const dispatchingRecord: PublishSubmitRecord = {
        state: 'in_progress',
        attemptedAt: now(),
        tabId: targetTabId,
        message: '已请求派发发布点击，正在执行（结果尚未确认）',
      }
      await persistSubmitRecord(task.id, dispatchingRecord, {
        clearToken: false,
        submitAttempted: true,
      })

      // 9. 触发一次真实点击（注入侧只点击真实发布按钮，绝不猜测）
      let submitResult: FormSubmitResult
      try {
        submitResult = await formFiller.submit(targetTabId)
      } catch (err) {
        // 注入失败 / 结果丢失：点击可能已派发但页面跳转导致上下文丢失。
        // 保守按“已派发、结果未知”处理并保持锁定（不回滚 dispatching 锁、绝不自动重试）。
        const message = err instanceof Error ? err.message : String(err)
        const record: PublishSubmitRecord = {
          state: 'unknown',
          attemptedAt: dispatchingRecord.attemptedAt,
          clickedAt: now(),
          tabId: targetTabId,
          message: `提交执行结果未知：${message}`,
        }
        // 结果未知时令牌必须失效（点击可能已生效），显式 clearToken: true 保证幂等失效。
        const updated = await persistSubmitRecord(task.id, record, { clearToken: true })
        return {
          id: updated.id,
          outcome: 'unknown',
          deterministic: false,
          task: updated,
          tabId: targetTabId,
          message: '已发起提交但无法确认结果，请人工核实；系统不会自动重试',
        }
      }

      // 10. 注入侧确定性确认“未派发任何点击”（未找到按钮 / 禁用 / 页面失效）：
      //     回滚第 8 步的 dispatching 锁，任务保持 waiting_confirmation 且令牌仍有效，
      //     用户修正后可再次显式提交。这是唯一允许解除提交锁的路径。
      if (submitResult.clicked !== true) {
        await rollbackSubmitDispatching(task.id)
        const code = toSubmitErrorCode(submitResult.code)
        throw new PublishError(code, submitResult.reason || '提交前校验未通过，未点击发布按钮', {
          retryable: false,
          details: submitResult,
        })
      }

      // 11. 已派发点击：持久化进行中状态并立即失效令牌（防重放），随后依据标签页跳转判定结果。
      const clickedRecord: PublishSubmitRecord = {
        state: 'in_progress',
        attemptedAt: dispatchingRecord.attemptedAt,
        clickedAt: submitResult.clickedAt ?? now(),
        tabId: targetTabId,
        message: '已派发发布按钮点击，正在观察结果',
      }
      await persistSubmitRecord(task.id, clickedRecord, { clearToken: true, submitAttempted: true })

      const outcome = await observeSubmitOutcome(targetTabId)

      if (outcome === 'submitted') {
        const completedResult: PublishTaskResult = {
          ...((task.result ?? {}) as PublishTaskResult),
          confirmationStatus: 'confirmed' as PublishManualConfirmationStatus,
          manualConfirmNote: '用户已在发布中心点击发布，已观察到页面跳转，提交成功',
          submit: {
            state: 'submitted',
            attemptedAt: clickedRecord.attemptedAt,
            clickedAt: clickedRecord.clickedAt,
            tabId: targetTabId,
            message: '提交成功',
          },
        }
        delete completedResult.submitToken
        const completed = await tasks.complete(task.id, completedResult)
        return {
          id: completed.id,
          outcome: 'submitted',
          deterministic: true,
          task: toPublishTask(completed),
          tabId: targetTabId,
          message: '发布提交成功',
        }
      }

      // 12. 结果未知：保持 waiting_confirmation，标记 unknown 并锁定，绝不自动重试。
      const unknownRecord: PublishSubmitRecord = {
        state: 'unknown',
        attemptedAt: clickedRecord.attemptedAt,
        clickedAt: clickedRecord.clickedAt,
        tabId: targetTabId,
        message: '未在超时时间内观察到提交成功信号，结果未知',
      }
      // 令牌已在第 11 步派发点击时清除；此处同样以 clearToken: true 表达“确保令牌失效”，
      // 修正此前 clearToken: false “依赖上一步、语义自相矛盾”的写法。
      const unknownTask = await persistSubmitRecord(task.id, unknownRecord, { clearToken: true })
      return {
        id: unknownTask.id,
        outcome: 'unknown',
        deterministic: false,
        task: unknownTask,
        tabId: targetTabId,
        message: '已点击发布但结果未知，请人工核实；系统不会自动重试',
      }
    } finally {
      inFlightSubmits.delete(task.id)
    }
  }

  /**
   * 查询发布任务列表
   */
  async function listTasks(filter: PublishTaskListFilter = {}): Promise<{ tasks: PublishTask[]; total: number }> {
    await ensureInit()
    const taskFilter: TaskFilter = {
      type: 'publish',
      ...(filter.status !== undefined ? { status: filter.status } : {}),
    }

    const rawTasks = await tasks.list(taskFilter)
    let all: PublishTask[] = rawTasks.map(toPublishTask)

    // 按 itemId 过滤
    if (filter.itemId) {
      const matchItemId = filter.itemId.trim()
      all = all.filter((t) => t.payload?.itemId === matchItemId)
    }

    // 按人工确认状态过滤
    if (filter.confirmationStatus) {
      all = all.filter((t) => t.result?.confirmationStatus === filter.confirmationStatus)
    }

    // 关键词过滤
    if (filter.keyword) {
      const kw = filter.keyword.trim().toLowerCase()
      all = all.filter((t) => {
        const title = (t.result?.item?.title || '').toLowerCase()
        const itemId = (t.payload?.itemId || '').toLowerCase()
        return title.includes(kw) || itemId.includes(kw)
      })
    }

    const total = all.length

    // 排序
    const sortBy = filter.sortBy === 'updatedAt' ? 'updatedAt' : 'createdAt'
    const sortOrder = filter.sortOrder ?? 'desc'
    all.sort((a, b) => {
      const va = a[sortBy] ?? 0
      const vb = b[sortBy] ?? 0
      return sortOrder === 'desc' ? vb - va : va - vb
    })

    // 分页
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? all.length
    const paged = all.slice(offset, offset + limit)

    return { tasks: paged, total }
  }

  /**
   * 查询单个发布任务详情
   */
  async function getTask(taskId: string): Promise<PublishTask | null> {
    await ensureInit()
    const task = await tasks.getById(taskId)
    if (!task || task.type !== 'publish') return null
    return toPublishTask(task)
  }

  /**
   * 取消发布任务
   */
  async function cancelTask(taskId: string, reason?: string): Promise<PublishTask> {
    await ensureInit()
    const cancelled = await tasks.cancel(taskId, reason ?? '用户取消发布任务')
    return toPublishTask(cancelled)
  }

  /**
   * 暂停发布任务
   */
  async function pauseTask(taskId: string, reason?: string): Promise<PublishTask> {
    await ensureInit()
    const paused = await tasks.pause(taskId, reason ?? '用户暂停任务')
    return toPublishTask(paused)
  }

  /**
   * 恢复发布任务（安全恢复策略）。
   *
   * 关键修复：绝不将任务空转为 running。publish 任务的执行体只存在于 `fillForm`（真实重跑填充流水线，
   * paused -> running -> ... -> waiting_confirmation），因此：
   * - paused：直接重跑填充执行体进行安全续跑，绝不出现“状态是 running 却无任何执行体”的悬挂任务；
   * - 其余状态（waiting_confirmation / running / pending / 终态）：结构化拒绝，并提示重新执行 PUBLISH_FILL_FORM。
   */
  async function resumeTask(taskId: string): Promise<PublishTask> {
    await ensureInit()
    const current = await tasks.getById(taskId)
    if (!current || current.type !== 'publish') {
      throw new PublishError('INVALID_PAYLOAD', `未找到 ID 为 "${taskId}" 的发布任务`)
    }
    const currentStatus = current.status as PublishTaskStatus

    if (currentStatus !== 'paused') {
      const hint =
        currentStatus === 'waiting_confirmation'
          ? '该任务已填表完成并等待人工确认，请直接提交（PUBLISH_SUBMIT）或取消放弃'
          : '请按当前状态重新执行 PUBLISH_FILL_FORM'
      throw new PublishError(
        'INVALID_PAYLOAD',
        `任务 "${taskId}" 当前状态为 "${currentStatus}"，仅 paused 任务可安全恢复；${hint}`,
        { retryable: false },
      )
    }

    // paused -> 重跑真实填充执行体，任务将携带真实执行过程回到 waiting_confirmation。
    return fillForm(taskId)
  }

  /**
   * 查询或记录人工确认状态（只读或记录确认标记，绝不提交发布）
   */
  async function confirmStatus(payload: {
    id: string
    confirmationStatus?: 'confirmed' | 'rejected'
    note?: string
  }): Promise<PublishConfirmStatusResult> {
    await ensureInit()
    const task = await getTask(payload.id)
    if (!task) {
      throw new PublishError('INVALID_PAYLOAD', `未找到任务 \"${payload.id}\"`)
    }

    // 仅查看
    if (!payload.confirmationStatus) {
      return {
        id: task.id,
        confirmationStatus: task.result?.confirmationStatus ?? 'unconfirmed',
        note: task.result?.manualConfirmNote,
        task,
      }
    }

    // 记录人工确认
    if (payload.confirmationStatus === 'confirmed') {
      // 人工在发布页面点击发布后，标记任务为 completed 或 confirmed
      const updated = await tasks.complete(task.id, {
        ...task.result,
        confirmationStatus: 'confirmed',
        manualConfirmNote: payload.note ?? '人工已确认并发布完成',
      })
      return {
        id: task.id,
        confirmationStatus: 'confirmed',
        note: payload.note,
        task: toPublishTask(updated),
      }
    }

    // 记录人工拒绝 / 放弃
    const updated = await tasks.cancel(task.id, payload.note ?? '人工放弃发布')
    return {
      id: task.id,
      confirmationStatus: 'rejected',
      note: payload.note,
      task: toPublishTask(updated),
    }
  }

  /**
   * 处理 Workbench 发送的 P8 发布命令
   */
  async function handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope> {
    switch (command.type) {
      case CommandTypes.PUBLISH_CREATE: {
        if (!isPublishCreatePayload(command.payload)) {
          return invalid(command, 'PUBLISH_CREATE 负载非法：必须提供非空 itemId')
        }
        try {
          const task = await createTask(command.payload)
          const result: PublishCreateResult = { task }
          return createResponse(command.requestId, command.type, result)
        } catch (err) {
          return handleError(command, err)
        }
      }

      case CommandTypes.PUBLISH_LIST: {
        if (!isPublishListPayload(command.payload)) {
          return invalid(command, 'PUBLISH_LIST 负载非法')
        }
        try {
          const listRes = await listTasks(command.payload as PublishTaskListFilter)
          const result: PublishListResult = listRes
          return createResponse(command.requestId, command.type, result)
        } catch (err) {
          return handleError(command, err)
        }
      }

      case CommandTypes.PUBLISH_GET: {
        if (!isPublishGetPayload(command.payload)) {
          return invalid(command, 'PUBLISH_GET 负载非法：需要非空 id')
        }
        try {
          const task = await getTask(command.payload.id)
          if (!task) {
            return invalid(command, `未找到发布任务: ${command.payload.id}`)
          }
          const result: PublishGetResult = { task }
          return createResponse(command.requestId, command.type, result)
        } catch (err) {
          return handleError(command, err)
        }
      }

      case CommandTypes.PUBLISH_FILL_FORM: {
        if (!isPublishFillFormPayload(command.payload)) {
          return invalid(command, 'PUBLISH_FILL_FORM 负载非法：需要非空 id')
        }
        try {
          const task = await fillForm(command.payload.id)
          const result: PublishFillFormResult = { task }
          return createResponse(command.requestId, command.type, result)
        } catch (err) {
          return handleError(command, err)
        }
      }

      case CommandTypes.PUBLISH_CANCEL: {
        if (!isPublishCancelPayload(command.payload)) {
          return invalid(command, 'PUBLISH_CANCEL 负载非法：需要非空 id')
        }
        try {
          const task = await cancelTask(command.payload.id, command.payload.reason)
          return createResponse(command.requestId, command.type, { task })
        } catch (err) {
          return handleError(command, err)
        }
      }

      case CommandTypes.PUBLISH_PAUSE: {
        if (!isPublishPausePayload(command.payload)) {
          return invalid(command, 'PUBLISH_PAUSE 负载非法：需要非空 id')
        }
        try {
          const task = await pauseTask(command.payload.id, command.payload.reason)
          return createResponse(command.requestId, command.type, { task })
        } catch (err) {
          return handleError(command, err)
        }
      }

      case CommandTypes.PUBLISH_RESUME: {
        if (!isPublishResumePayload(command.payload)) {
          return invalid(command, 'PUBLISH_RESUME 负载非法：需要非空 id')
        }
        try {
          const task = await resumeTask(command.payload.id)
          return createResponse(command.requestId, command.type, { task })
        } catch (err) {
          return handleError(command, err)
        }
      }

      case CommandTypes.PUBLISH_CONFIRM_STATUS: {
        if (!isPublishConfirmStatusPayload(command.payload)) {
          return invalid(command, 'PUBLISH_CONFIRM_STATUS 负载非法：需要非空 id')
        }
        try {
          const res = await confirmStatus(command.payload)
          return createResponse(command.requestId, command.type, res)
        } catch (err) {
          return handleError(command, err)
        }
      }

      case CommandTypes.PUBLISH_SUBMIT: {
        if (!isPublishSubmitPayload(command.payload)) {
          return invalid(
            command,
            'PUBLISH_SUBMIT 负载非法：需要非空 id、submitToken 与 confirm:true',
          )
        }
        try {
          const result = await submitForm(command.payload)
          return createResponse(command.requestId, command.type, result)
        } catch (err) {
          return handleError(command, err)
        }
      }

      default:
        return createErrorResponse(command.requestId, command.type, {
          code: 'UNKNOWN_COMMAND',
          message: `非发布命令: ${command.type}`,
        })
    }
  }

  function invalid(command: CommandEnvelope, message: string): ResponseEnvelope {
    const error: ProtocolError = { code: 'INVALID_PAYLOAD', message }
    return createErrorResponse(command.requestId, command.type, error)
  }

  function handleError(command: CommandEnvelope, err: unknown): ResponseEnvelope {
    if (err instanceof PublishError) {
      const code = err.code === 'INVALID_PAYLOAD' ? 'INVALID_PAYLOAD' : 'INTERNAL'
      return createErrorResponse(command.requestId, command.type, {
        code,
        message: err.message,
        // 结构化业务码（如 SUBMIT_DUPLICATE / SUBMIT_BUTTON_NOT_FOUND），便于 UI 精准分支
        businessCode: err.code,
      })
    }
    if (err instanceof InvalidTaskTransitionError) {
      return createErrorResponse(command.requestId, command.type, {
        code: 'INTERNAL',
        message: err.message,
      })
    }
    if (err instanceof TaskNotFoundError) {
      return createErrorResponse(command.requestId, command.type, {
        code: 'INTERNAL',
        message: err.message,
      })
    }
    const msg = err instanceof Error ? err.message : String(err)
    return createErrorResponse(command.requestId, command.type, {
      code: 'INTERNAL',
      message: `发布执行失败: ${msg}`,
    })
  }

  return {
    init: ensureInit,
    ensurePublishTab,
    fillForm,
    handleCommand,
  }
}
