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
 *   页面状态仍有效时才点击真实发布按钮一次；**成功判据必须以官方「我的商品库」真实在售商品数严格 +1
 *   （afterCount === beforeCount + 1）且新 itemId 与标题可信匹配为证据（绝不凭 URL 离开发布页判定）**；
 *   缺读取能力 / 无基线时**在派发点击前直接拒绝**；数量未严格 +1 / 超时一律标记 unknown 并锁定，绝不自动重试；
 * - Service Worker 重启恢复：running 状态恢复为 paused（保留断点），waiting_confirmation 保持原样，绝不自动重跑或自动提交。
 */

import {
  buildPublishItem,
  CommandTypes,
  createErrorResponse,
  createResponse,
  DEFAULT_PUBLISH_RULE,
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
  type PublishCreatePayload,
  type PublishCreateResult,
  type PublishDiagnostics,
  type PublishErrorCode,
  type PublishFeishuMaterial,
  type PublishFillFormResult,
  type PublishGetResult,
  type PublishItem,
  type PublishItemOverride,
  type PublishListResult,
  type PublishManualConfirmationStatus,
  type PublishRule,
  type PublishSubmitRecord,
  type PublishSubmitResult,
  type PublishTask,
  type PublishTaskChangedPayload,
  type PublishTaskListFilter,
  type PublishTaskPayload,
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
import { FeishuDataSource } from '../../../shared/data-source/feishu-data-source'
import { isAllowedProductTable } from '../../../shared/data-source/feishu-daily-tables'
import {
  mapFeishuFieldsToMaterial,
  materialToProduct,
} from '../../../shared/data-source/feishu-product-mapping'
import type { FeishuConfig, HttpTransport } from '../../../shared/data-source/feishu-types'
import { FeishuError } from '../../../shared/data-source/feishu-types'
import type { FeishuConfigStore } from '../data-source/feishu-config-store'
import {
  PublishController,
  type ImageDownloader,
  type OwnedProductFallback,
  type PreparedImageFile,
} from '../publish/controller'
import {
  DOMPublishFormFiller,
  type FormFillResult,
  type FormSubmitResult,
  type PublishFormFiller,
  type ScriptingExecutor,
} from '../publish/form-filler'
import {
  appendDiagStage,
  beginDiagStage,
  endDiagStage,
  readDiagnosticsFromMeta,
  setResultStage,
  snapshotDiagnostics,
} from '../publish/diagnostics'
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
  /**
   * 当前账号自有商品的只读复验来源（本地命中也必须复验）。
   * 未接线时拒绝自营素材；创建、填充及提交均使用当前账号官方在售目录复验。
   */
  ownedProducts?: OwnedProductFallback
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
  /** 飞书配置存储（飞书素材发布闭环：只读取已配置商品表，密钥仅用于请求层）。 */
  feishuConfigStore?: FeishuConfigStore
  /**
   * 官方「我的商品库」只读读取端口（真实在售商品查询）。
   *
   * **提交成功判定的唯一依据**：提交前快照官方在售商品 id，提交后轮询确认出现新 itemId。
   * 缺省（未接线）时任何提交都只能判定为 unknown，**绝不报告 success**。
   */
  publishedItems?: PublishedItemsReader
  /** 可注入的 HTTP 传输器（单测 / 离线环境 Mock）。 */
  transport?: HttpTransport
  /** 表单填充器（缺省自动使用 DOMPublishFormFiller） */
  formFiller?: PublishFormFiller
  /** 闲鱼发布页基础 URL，默认 'https://www.goofish.com/publish' */
  publishUrl?: string
  /** 标签页等待完成超时毫秒数，默认 15000 */
  loadTimeoutMs?: number
  /** 提交后观察结果的最长毫秒数，默认 8000 */
  submitObserveTimeoutMs?: number
  /** 提交后轮询标签页 URL 的间隔毫秒数，默认 300 */
  submitObserveIntervalMs?: number
  /** 提交后轮询官方商品库确认结果的间隔毫秒数，默认 1500（避免高频请求官方接口） */
  submitVerifyIntervalMs?: number
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
  /**
   * 兼容保留：按 active:false 查找 / 新建闲鱼发布页标签。
   *
   * 注意：**填表流程不再使用它** —— `fillForm` 会为每个新任务新建专属 fresh tab
   * （`chrome.tabs.create({ url, active:false })`），绝不复用其它任务 / 页面，
   * 也绝不清除 / 关闭用户其它页面。本接口仅为历史用途保留。
   */
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
export const DEFAULT_SUBMIT_VERIFY_INTERVAL_MS = 1500

/** 官方「我的商品库」中的一条在售商品引用（只读、最小字段）。 */
export interface PublishedItemRef {
  /** 官方真实 itemId（绝不使用来源 / 竞品 itemId 冒充）。 */
  itemId: string
  /** 官方返回的商品标题（用于与本次发布标题比对，可能缺失）。 */
  title?: string
}

/**
 * 官方「我的商品库」只读读取端口。
 *
 * 语义约定：
 * - 成功返回当前账号官方在售商品的 id / 标题列表（可能为空数组，表示当前 0 件在售）；
 * - 缺少查询权限 / 未登录 / 网络失败 / 无法判定时必须 throw，调用方据此判 unknown 并锁定，
 *   **绝不把读取失败当作“发布成功”**；
 * - 该端口只读，绝不写入本地商品库，也绝不用本地 upsert(+1) 伪造验收。
 */
export interface PublishedItemsReader {
  readOnSaleItems(): Promise<PublishedItemRef[]>
}

/**
 * 将 FeishuError 映射为**固定、非敏感**的发布错误（绝不透传底层 message / URL / 凭据）。
 */
function mapFeishuErrorForPublish(error: FeishuError): { code: 'INVALID_PAYLOAD' | 'INTERNAL'; message: string } {
  switch (error.category) {
    case 'AUTH_FAILED':
      return { code: 'INVALID_PAYLOAD', message: '飞书鉴权失败：请检查 appId / appSecret 配置是否正确' }
    case 'NOT_FOUND':
      return { code: 'INVALID_PAYLOAD', message: '飞书目标表或记录不存在：请检查商品表配置与记录是否仍存在' }
    case 'RATE_LIMITED':
      return { code: 'INTERNAL', message: '飞书接口频率超限：请稍后重试' }
    case 'NETWORK_ERROR':
      return { code: 'INTERNAL', message: '飞书网络请求失败：请检查网络后重试' }
    case 'INVALID_PARAM':
      return { code: 'INVALID_PAYLOAD', message: '飞书请求参数不合法：请检查飞书配置是否正确' }
    case 'INVALID_RESPONSE':
      return { code: 'INTERNAL', message: '飞书返回数据异常：已拒绝本次结果，请稍后重试' }
    case 'BATCH_TOO_LARGE':
      return { code: 'INTERNAL', message: '飞书请求超出上限：请减少数量后重试' }
    case 'API_ERROR':
    default:
      return { code: 'INTERNAL', message: '飞书请求失败：请检查飞书配置与目标表后重试' }
  }
}

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
 * 判断 URL 是否为登录页（误跳转登录页 = 未登录，绝非发布成功）。
 * 仅用于生成诊断信息，不参与成功判定。
 */
function isLoginUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const host = new URL(url).hostname
    return (
      host === 'login.taobao.com' ||
      host.endsWith('.login.taobao.com') ||
      host === 'login.m.taobao.com' ||
      host === 'login.goofish.com'
    )
  } catch {
    return false
  }
}

/** 归一化标题（去空白）用于可信匹配。 */
function normalizeMatchText(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, '').trim()
}

/** 安全耗时：仅接受有限非负数字，否则回退 0。 */
function safeLatency(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
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
  const submitVerifyIntervalMs = deps.submitVerifyIntervalMs ?? DEFAULT_SUBMIT_VERIFY_INTERVAL_MS

  const controller =
    deps.controller ??
    new PublishController({
      repository: deps.repository,
      ...(deps.ownedProducts ? { ownedProducts: deps.ownedProducts } : {}),
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
   * 尽力持久化诊断时间线（绝不因诊断写入失败而影响发布安全路径）。
   *
   * 仅对 running / paused 任务通过 updateProgress 写入；其余状态（如 waiting_confirmation）
   * 由 {@link persistSubmitDiagBestEffort} 走合法往返写入。
   */
  async function flushDiagBestEffort(taskId: string, diag: PublishDiagnostics): Promise<void> {
    try {
      const latest = await tasks.getById(taskId)
      if (!latest) return
      if (latest.status === 'running' || latest.status === 'paused') {
        await tasks.updateProgress(taskId, latest.progress, {
          diagnostics: snapshotDiagnostics(diag),
        })
      }
    } catch {
      // 诊断为尽力而为，绝不阻断发布安全路径
    }
  }

  /**
   * 在 waiting_confirmation 状态内安全写入诊断时间线（不改动提交锁 / 令牌 / 结果结论）。
   *
   * 复用 `pause -> updateProgress -> waitForConfirmation` 合法往返，使任务保持
   * waiting_confirmation 不变，但 meta.diagnostics 得到持久化。
   */
  async function persistSubmitDiagBestEffort(
    taskId: string,
    diag: PublishDiagnostics,
  ): Promise<void> {
    try {
      const current = await tasks.getById(taskId)
      if (!current) return
      const currentStatus = current.status as PublishTaskStatus
      const snap = snapshotDiagnostics(diag)
      if (currentStatus === 'waiting_confirmation') {
        await tasks.pause(taskId, '持久化发布诊断时间线')
        await tasks.updateProgress(taskId, current.progress, { diagnostics: snap })
        await tasks.waitForConfirmation(taskId, {
          progress: current.progress,
          ...(current.result === undefined ? {} : { result: current.result }),
          meta: { step: 'waiting_confirmation', diagnostics: snap },
        })
      } else if (current.status === 'running' || current.status === 'paused') {
        await tasks.updateProgress(taskId, current.progress, { diagnostics: snap })
      }
    } catch {
      // 力求持久化，但绝不因诊断失败而阻断发布安全路径
    }
  }

  /**
   * 把 FormFiller 返回的安全 timings / 字段与图片计数写入诊断时间线。
   *
   * 绝不写入标题 / URL / 地址 / 图片原始链接等原文：只记录布尔标记与数值计数。
   */
  function recordFillStagesFromResult(
    diag: PublishDiagnostics,
    callStart: number,
    requestedImages: number,
    result: FormFillResult,
  ): void {
    const timings = result.timings ?? {}
    let cursor = callStart

    const pageMs = safeLatency(timings.pageCheckMs)
    appendDiagStage(diag, 'page_check', 'ok', cursor + pageMs, {
      startedAt: cursor,
      latencyMs: pageMs,
      flags: { isPublishPage: true, isLoggedIn: true, hasCaptcha: false },
    })
    cursor += pageMs

    const s = result.fillSummary
    const fieldsMs = safeLatency(timings.fieldsMs)
    const fieldsOk = s.titleFilled && s.descFilled && s.priceFilled && s.origPriceFilled
    appendDiagStage(diag, 'fields', fieldsOk ? 'ok' : 'failed', cursor + fieldsMs, {
      startedAt: cursor,
      latencyMs: fieldsMs,
      counters: {
        filled:
          (s.titleFilled ? 1 : 0) +
          (s.descFilled ? 1 : 0) +
          (s.priceFilled ? 1 : 0) +
          (s.origPriceFilled ? 1 : 0),
      },
      flags: {
        titleFilled: s.titleFilled === true,
        descFilled: s.descFilled === true,
        priceFilled: s.priceFilled === true,
        origPriceFilled: s.origPriceFilled === true,
        postFeeFilled: s.postFeeFilled !== false,
        locationFilled: s.locationFilled !== false,
      },
    })
    cursor += fieldsMs

    const imagesMs = safeLatency(timings.imagesMs)
    const failed = result.imagesFailed?.length ?? 0
    const uploaded = Math.max(0, s.detailImagesCount + (s.mainImageUploaded ? 1 : 0))
    const imagesOk = failed === 0 && s.mainImageUploaded === true
    appendDiagStage(diag, 'images', imagesOk ? 'ok' : 'failed', cursor + imagesMs, {
      startedAt: cursor,
      latencyMs: imagesMs,
      counters: { requested: requestedImages, uploaded, failed },
      flags: { mainImageUploaded: s.mainImageUploaded === true },
    })
  }

  /**
   * 注入填充抛错时，按错误码还原 page_check / form_validation / fields 阶段失败。
   *
   * 官方可见阻断（PUBLISH_CATEGORY_UNSUPPORTED / FORM_VALIDATION_FAILED）只记录
   * 结构化 code，绝不把页面 toast 原文写入时间线。
   */
  function recordFillStagesFromError(
    diag: PublishDiagnostics,
    callStart: number,
    error: unknown,
  ): void {
    const code = error instanceof PublishError ? error.code : 'INTERNAL_ERROR'
    const at = now()
    const latency = Math.max(0, at - callStart)
    const pageFailed = code === 'NOT_LOGGED_IN' || code === 'VERIFICATION_REQUIRED'
    appendDiagStage(diag, 'page_check', pageFailed ? 'failed' : 'ok', at, {
      startedAt: callStart,
      latencyMs: latency,
      ...(pageFailed ? { code } : {}),
    })
    if (code === 'PUBLISH_CATEGORY_UNSUPPORTED' || code === 'FORM_VALIDATION_FAILED') {
      appendDiagStage(diag, 'form_validation', 'failed', at, {
        startedAt: callStart,
        latencyMs: latency,
        code,
      })
    } else {
      appendDiagStage(diag, 'fields', 'unknown', at, {
        startedAt: callStart,
        latencyMs: latency,
        code,
      })
    }
  }

  /**
   * 为**本次填表任务**新建一个干净的发布页后台标签（active:false）。
   *
   * 安全要求：
   * 1. 每个新 fill task 专属 fresh `chrome.tabs.create({ url: publishUrl, active:false })`，
   *    **绝不复用**其它任务 / 已有页面（避免上一轮残留 toast / 表单状态污染诊断）；
   * 2. 暂停后重试（publish resume）/ 重新填充同样得到 fresh tab；
   * 3. **绝不关闭或清理用户其它页面**，只新建不删除。
   */
  async function openFreshPublishTab(diag: PublishDiagnostics): Promise<TabLike> {
    const freshEntry = beginDiagStage(diag, 'fresh_tab', now(), {
      counters: { createCalls: 1 },
      flags: { active: false },
    })

    if (!deps.tabs) {
      // 轻量单测环境：提供虚拟 fresh tab（仍保证每次调用得到独立 id）
      endDiagStage(freshEntry, 'ok', now())
      appendDiagStage(diag, 'load', 'ok', now(), { latencyMs: 0 })
      return { id: 8888, url: publishUrl, active: false, status: 'complete' }
    }

    let createdTab: TabLike
    try {
      createdTab = await deps.tabs.create({ url: publishUrl, active: false })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      endDiagStage(freshEntry, 'failed', now(), { code: 'TAB_LOAD_FAILED' })
      throw new PublishError('TAB_LOAD_FAILED', `创建发布页标签失败: ${msg}`, { details: err })
    }
    endDiagStage(freshEntry, 'ok', now())

    if (createdTab.id === undefined || createdTab.status === 'complete') {
      appendDiagStage(diag, 'load', 'ok', now(), { latencyMs: 0 })
      return createdTab
    }

    // 等待页面加载至 complete（限制超时）
    const tabId = createdTab.id
    const loadEntry = beginDiagStage(diag, 'load', now())
    const startTime = now()
    let isComplete = false
    while (now() - startTime < loadTimeoutMs) {
      await sleep(300)
      try {
        const fresh = await deps.tabs.get(tabId)
        if (!fresh) {
          endDiagStage(loadEntry, 'failed', now(), { code: 'TAB_LOAD_FAILED' })
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
      endDiagStage(loadEntry, 'failed', now(), { code: 'TAB_LOAD_FAILED' })
      throw new PublishError(
        'TAB_LOAD_FAILED',
        `发布页加载超时 (${loadTimeoutMs}ms)，请检查网络连接或闲鱼访问状态`,
        { retryable: false },
      )
    }
    endDiagStage(loadEntry, 'ok', now())
    return createdTab
  }

  /** 飞书数据源缓存（复用令牌缓存）；未配置时返回 null。 */
  let cachedFeishuSource: FeishuDataSource | null = null
  let cachedFeishuConfig: FeishuConfig | null = null

  /** 完整（内存）比较飞书配置，检测（含同长度密钥轮换）变化。 */
  function sameFeishuConfig(a: FeishuConfig, b: FeishuConfig): boolean {
    return (
      a.appId === b.appId &&
      a.appSecret === b.appSecret &&
      a.spreadsheetToken === b.spreadsheetToken &&
      a.productTableId === b.productTableId &&
      (a.sellerTableId ?? '') === (b.sellerTableId ?? '')
    )
  }

  /** 读取已配置飞书数据源；未配置 / 未接线返回 null。 */
  async function getFeishuDataSource(): Promise<{ source: FeishuDataSource; config: FeishuConfig } | null> {
    const store = deps.feishuConfigStore
    if (!store) return null
    const config = await store.load()
    if (!config) {
      cachedFeishuSource = null
      cachedFeishuConfig = null
      return null
    }
    if (cachedFeishuSource && cachedFeishuConfig && sameFeishuConfig(cachedFeishuConfig, config)) {
      return { source: cachedFeishuSource, config }
    }
    cachedFeishuSource = new FeishuDataSource({
      config,
      ...(deps.transport === undefined ? {} : { transport: deps.transport }),
      now,
    })
    cachedFeishuConfig = config
    return { source: cachedFeishuSource, config }
  }

  /**
   * 后台强校验人工覆盖字段：override 传入后仍由服务端复验
   * 标题 / 描述长度、价格与图片数量 / 协议 / URL 合法性，以及配送（freeShip / postFee）
   * 与所在地（location）白名单；任一非法或交叉矛盾（如明确不包邮却缺正数邮费）即结构化拒绝。
   */
  function validatePublishOverride(override?: PublishItemOverride): void {
    if (!override) return
    if (typeof override !== 'object') {
      throw new PublishError('INVALID_PAYLOAD', '发布覆盖字段（override）必须为对象')
    }
    const maxTitleLength = DEFAULT_PUBLISH_RULE.content?.maxTitleLength ?? 60
    const maxDescLength = DEFAULT_PUBLISH_RULE.content?.maxDescLength ?? 1000
    const maxImages = DEFAULT_PUBLISH_RULE.image?.maxImages ?? 9

    if (override.title !== undefined) {
      if (typeof override.title !== 'string' || override.title.trim().length === 0) {
        throw new PublishError('INVALID_PAYLOAD', '覆盖标题（override.title）必须为非空字符串')
      }
      if (override.title.trim().length > maxTitleLength) {
        throw new PublishError('INVALID_PAYLOAD', `覆盖标题超出长度上限（最多 ${maxTitleLength} 字符）`)
      }
    }
    if (override.desc !== undefined) {
      if (typeof override.desc !== 'string') {
        throw new PublishError('INVALID_PAYLOAD', '覆盖描述（override.desc）必须为字符串')
      }
      if (override.desc.length > maxDescLength) {
        throw new PublishError('INVALID_PAYLOAD', `覆盖描述超出长度上限（最多 ${maxDescLength} 字符）`)
      }
    }
    if (override.price !== undefined) {
      if (typeof override.price !== 'number' || !Number.isFinite(override.price) || override.price <= 0) {
        throw new PublishError('INVALID_PAYLOAD', '覆盖售价（override.price）必须为正数')
      }
    }
    if (override.originalPrice !== undefined) {
      if (
        typeof override.originalPrice !== 'number' ||
        !Number.isFinite(override.originalPrice) ||
        override.originalPrice <= 0
      ) {
        throw new PublishError('INVALID_PAYLOAD', '覆盖原价（override.originalPrice）必须为正数')
      }
    }
    if (override.images !== undefined) {
      if (!Array.isArray(override.images) || override.images.length === 0) {
        throw new PublishError('INVALID_PAYLOAD', '覆盖图片（override.images）必须为非空数组')
      }
      if (override.images.length > maxImages) {
        throw new PublishError('INVALID_PAYLOAD', `覆盖图片数量超出上限（最多 ${maxImages} 张）`)
      }
      for (const url of override.images) {
        if (typeof url !== 'string' || url.trim().length === 0) {
          throw new PublishError('INVALID_PAYLOAD', '覆盖图片每一项必须为非空 URL 字符串')
        }
        try {
          const parsed = new URL(url.trim().replace(/^http:\/\//i, 'https://'))
          if (parsed.protocol !== 'https:') throw new Error('not https')
        } catch {
          throw new PublishError('INVALID_PAYLOAD', `覆盖图片 URL 非法（仅支持 HTTPS）: ${url}`)
        }
      }
    }

    // ---- 配送（邮费）与所在地白名单校验（按 shared 实际语义）----
    if (override.freeShip !== undefined && typeof override.freeShip !== 'boolean') {
      throw new PublishError('INVALID_PAYLOAD', '覆盖包邮标记（override.freeShip）必须为布尔值')
    }
    if (override.postFee !== undefined) {
      if (typeof override.postFee !== 'number' || !Number.isFinite(override.postFee) || override.postFee < 0) {
        throw new PublishError('INVALID_PAYLOAD', '覆盖邮费（override.postFee）必须为非负数（0 表示包邮）')
      }
    }
    if (override.location !== undefined && typeof override.location !== 'string') {
      throw new PublishError('INVALID_PAYLOAD', '覆盖所在地（override.location）必须为字符串')
    }
    // 交叉一致性：明确不包邮（freeShip=false）必须给出正数邮费；否则拒绝，
    // 绝不默默当作免费/收费，也绝不伪造一个收费金额。
    if (override.freeShip === false && !(typeof override.postFee === 'number' && override.postFee > 0)) {
      throw new PublishError(
        'INVALID_PAYLOAD',
        '明确不包邮（override.freeShip=false）时必须提供正数邮费（override.postFee > 0），绝不伪造收费金额',
      )
    }
    // 交叉一致性：明确包邮（freeShip=true）不得同时给出正数邮费。
    if (override.freeShip === true && typeof override.postFee === 'number' && override.postFee > 0) {
      throw new PublishError(
        'INVALID_PAYLOAD',
        '明确包邮（override.freeShip=true）不能同时指定正数邮费（override.postFee > 0）',
      )
    }
  }

  /** 用（合并规则 + override）将来源商品组装为可发布 PublishItem，统一错误映射。 */
  function buildPublishItemFromProduct(
    product: Parameters<typeof buildPublishItem>[0],
    rule?: Partial<PublishRule>,
    override?: PublishItemOverride,
  ): PublishItem {
    const mergedRule: PublishRule = {
      price: { ...DEFAULT_PUBLISH_RULE.price, ...rule?.price },
      content: { ...DEFAULT_PUBLISH_RULE.content, ...rule?.content },
      image: { ...DEFAULT_PUBLISH_RULE.image, ...rule?.image },
    }
    try {
      return buildPublishItem(product, mergedRule, override)
    } catch (err) {
      if (err instanceof PublishError) throw err
      throw new PublishError(
        'INVALID_PAYLOAD',
        `素材无法组装为可发布商品: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * 创建发布任务
   */
  async function createTask(payload: PublishCreatePayload): Promise<PublishTask> {
    await ensureInit()
    // 飞书素材来源：走独立闭环，绝不写入 / 污染本地商品库。
    if (payload.source === 'feishu') {
      return createFeishuTask(payload)
    }

    const itemId = payload.itemId?.trim()
    if (!itemId) {
      throw new PublishError('INVALID_PAYLOAD', 'PUBLISH_CREATE 必须提供本地 itemId 或飞书 source/recordId/targetTableId')
    }
    // 严格调用 controller 预校验商品存在性与规则合法性
    const publishItem = await controller.preparePublishItem(itemId, payload.rule, payload.override)

    const created = await tasks.create<'publish'>({
      type: 'publish',
      payload: {
        source: 'my_published',
        itemId: publishItem.itemId,
        rule: payload.rule,
        override: payload.override,
      },
      meta: {
        sourceKind: 'my_published',
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
            detail: `从指定商品 "${publishItem.itemId}" 创建发布任务`,
          },
        ],
      },
    })

    return toPublishTask(created)
  }

  /**
   * 创建飞书素材发布任务（发布闭环）。
   *
   * 1. 后台从旧配置商品表或当前多维表格的每日采集表读取真实记录；
   * 2. 目标表必须经后台白名单复验，不能读取任意表；
   * 3. override 传入后仍在此处后台强校验；
   * 4. 冻结原素材到 meta.feishu，供填表阶段复用 / 复验；
   * 5. **绝不写入本地商品库**，绝不伪标 my_published。
   */
  async function createFeishuTask(payload: PublishCreatePayload): Promise<PublishTask> {
    const recordId = payload.recordId?.trim() ?? ''
    const targetTableId = payload.targetTableId?.trim() ?? ''
    if (!recordId || !targetTableId) {
      throw new PublishError('INVALID_PAYLOAD', '飞书素材发布必须提供 recordId 与 targetTableId')
    }
    validatePublishOverride(payload.override)

    const resolved = await getFeishuDataSource()
    if (!resolved) {
      throw new PublishError(
        'FEISHU_SOURCE_NOT_CONFIGURED',
        '飞书未配置：请先在设置页填写飞书应用与商品表信息',
      )
    }
    const { source, config } = resolved

    // 每日表仍须属于当前多维表格并符合固定命名，不能直接信任 UI 提供的表 ID。
    if (!(await isAllowedProductTable(source, config, targetTableId))) {
      throw new PublishError(
        'PUBLISH_TARGET_TABLE_MISMATCH',
        `飞书素材目标表与当前已配置商品表不一致（绑定漂移）：目标 ${targetTableId}，配置 ${config.productTableId}`,
        { retryable: false, details: { targetTableId, configuredTableId: config.productTableId } },
      )
    }

    const record = await source.getRecordOnce(targetTableId, recordId)
    if (!record) {
      throw new PublishError(
        'FEISHU_RECORD_NOT_FOUND',
        `飞书商品表中未找到记录: "${recordId}"（可能已被删除或 recordId 失效）`,
        { retryable: false },
      )
    }

    const mapping = mapFeishuFieldsToMaterial(record.fields)
    const product = materialToProduct(mapping.material)
    const publishItem = buildPublishItemFromProduct(product, payload.rule, payload.override)

    const frozen: PublishFeishuMaterial = {
      recordId: record.record_id,
      targetTableId,
      material: { ...mapping.material, images: [...mapping.material.images] },
      missingFields: [...mapping.missingFields],
      warnings: [...mapping.warnings],
    }

    const created = await tasks.create<'publish'>({
      type: 'publish',
      payload: {
        source: 'feishu',
        recordId: record.record_id,
        targetTableId,
        rule: payload.rule,
        override: payload.override,
      },
      meta: {
        sourceKind: 'feishu',
        feishu: frozen,
        sourceProductSnapshot: {
          itemId: mapping.material.itemId,
          title: publishItem.sourceTitle,
          price: String(publishItem.sourcePrice),
          capturedAt: now(),
        },
        history: [
          {
            timestamp: now(),
            action: 'create',
            detail: `从飞书记录 "${record.record_id}"（表 ${targetTableId}）创建发布任务`,
          },
        ],
      },
    })

    return toPublishTask(created)
  }

  /**
   * 为飞书素材任务准备 PublishItem（填表阶段）。
   *
   * 按**冻结的原素材**重算（避免填表期间飞书内容变化导致所见非所发），同时**安全复验**
   * 目标表绑定未漂移（冻结来源仍须属于当前允许读取的商品表）。
   */
  async function prepareFeishuTaskItem(runningTask: Task): Promise<PublishItem> {
    const meta = (runningTask.meta ?? {}) as { feishu?: PublishFeishuMaterial }
    const frozen = meta.feishu
    if (!frozen) {
      throw new PublishError('INVALID_PAYLOAD', '飞书素材发布任务缺少冻结素材，无法填充')
    }
    const payload = runningTask.payload as PublishTaskPayload
    validatePublishOverride(payload.override)

    const resolved = await getFeishuDataSource()
    if (!resolved) {
      throw new PublishError(
        'FEISHU_SOURCE_NOT_CONFIGURED',
        '飞书未配置：请先在设置页填写飞书应用与商品表信息',
      )
    }

    // 目标表绑定复验：填表前配置若已漂移，拒绝继续，避免发到错误目标。
    if (!(await isAllowedProductTable(resolved.source, resolved.config, frozen.targetTableId))) {
      throw new PublishError(
        'PUBLISH_TARGET_TABLE_MISMATCH',
        `飞书素材目标表绑定已漂移：创建时 ${frozen.targetTableId}，当前配置 ${resolved.config.productTableId}`,
        { retryable: false },
      )
    }

    const product = materialToProduct(frozen.material)
    return buildPublishItemFromProduct(product, payload.rule, payload.override)
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

    // 诊断时间线：从任务已有记录续接（跨重填累计），全程安全、有界、可持久化。
    // 绝不写入 URL / token / cookie / 商品正文 / 地址 / 图片原始链接等原文。
    const diag = readDiagnosticsFromMeta(current.meta)

    // 1. 流转到 running 状态
    let runningTask: Task
    if (current.status === 'pending') {
      runningTask = await tasks.start(taskId)
    } else if (current.status === 'paused') {
      runningTask = await tasks.resume(taskId)
    } else {
      runningTask = current
    }

    const persistProgress = async (progress: number, patch: Record<string, unknown> = {}) => {
      await tasks.updateProgress(taskId, progress, {
        ...patch,
        diagnostics: snapshotDiagnostics(diag),
      })
    }

    await persistProgress(15, { step: 'preparing_item' })

    try {
      const payload = runningTask.payload as PublishTaskPayload

      // 2. 准备商品与规则计算（本地走商品库；飞书走冻结素材 + 目标表绑定复验）
      const item =
        payload.source === 'feishu'
          ? await prepareFeishuTaskItem(runningTask)
          : await controller.preparePublishItem(
              payload.itemId ?? '',
              payload.rule,
              payload.override,
            )

      // inflight 取消/暂停保护检查点 1
      const aborted1 = await checkInflightAborted(taskId)
      if (aborted1) {
        await flushDiagBestEffort(taskId, diag)
        return toPublishTask(aborted1)
      }

      await persistProgress(40, { step: 'preparing_images' })

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
      if (aborted2) {
        await flushDiagBestEffort(taskId, diag)
        return toPublishTask(aborted2)
      }

      await persistProgress(65, { step: 'ensuring_tab' })

      // 4. 为**本次任务**新建专属干净发布页 Tab（active: false，绝不复用其它任务/页面，
      //    绝不清除 / 关闭用户其它页面；暂停重试同样得到 fresh tab）。
      const tab = await openFreshPublishTab(diag)
      const tabId = tab.id ?? 0

      // inflight 取消/暂停保护检查点 3
      const aborted3 = await checkInflightAborted(taskId)
      if (aborted3) {
        await flushDiagBestEffort(taskId, diag)
        return toPublishTask(aborted3)
      }

      await persistProgress(85, { step: 'filling_form' })

      // 图片下载与打开页面期间可能切号；派发填充前重新复验，不复用创建许可。
      if (payload.source !== 'feishu') {
        await controller.preparePublishItem(payload.itemId ?? '', payload.rule, payload.override)
      }

      // 5. 调用 FormFiller 填充表单字段（记录 page_check / fields / images 安全阶段）
      const fillCallStart = now()
      let fillResult: FormFillResult
      try {
        fillResult = await formFiller.fill(tabId, item, preparedImages)
      } catch (fillErr) {
        recordFillStagesFromError(diag, fillCallStart, fillErr)
        throw fillErr
      }
      recordFillStagesFromResult(diag, fillCallStart, item.allImages.length, fillResult)

      // inflight 取消/暂停保护检查点 4
      const aborted4 = await checkInflightAborted(taskId)
      if (aborted4) {
        await flushDiagBestEffort(taskId, diag)
        return toPublishTask(aborted4)
      }

      // 6. 严格校验：只有标题、描述、售价、原价、图片全部填充且回读校验通过，
      //    才允许进入 waiting_confirmation；任何一项未通过都视为失败，绝不假成功。
      //    邮费 / 所在地：仅当注入侧**明确**为 false 时拒绝；缺省（undefined，旧 mock / 未涉及）保持兼容。
      const validationStart = now()
      const summary = fillResult.fillSummary
      const shippingUnfilled = summary.postFeeFilled === false
      const locationUnfilled = summary.locationFilled === false
      const allFieldsVerified =
        fillResult.ok === true &&
        summary.titleFilled === true &&
        summary.descFilled === true &&
        summary.priceFilled === true &&
        summary.origPriceFilled === true &&
        summary.mainImageUploaded === true &&
        summary.postFeeFilled !== false &&
        summary.locationFilled !== false &&
        (fillResult.imagesFailed?.length ?? 0) === 0

      if (!allFieldsVerified) {
        const reason =
          fillResult.errors && fillResult.errors.length > 0
            ? fillResult.errors.join('; ')
            : shippingUnfilled || locationUnfilled
              ? '邮费 / 所在地必填校验未通过（绝不自动选择地区 / 伪造收费），拒绝进入 waiting_confirmation'
              : '存在未成功填充或未通过回读校验的字段'
        const code = shippingUnfilled || locationUnfilled ? 'FORM_VALIDATION_FAILED' : 'FORM_FIELD_CHANGED'
        appendDiagStage(diag, 'form_validation', 'failed', now(), {
          startedAt: validationStart,
          latencyMs: Math.max(0, now() - validationStart),
          code,
          flags: { postFeeFilled: !shippingUnfilled, locationFilled: !locationUnfilled },
        })
        throw new PublishError(
          code,
          `表单填充未全部通过校验，拒绝进入 waiting_confirmation 以免假成功: ${reason}`,
          { retryable: false, details: fillResult },
        )
      }

      // 6.5 表单整体校验通过：记录 form_validation ok（官方阻断已在 fill 阶段被拦截并记录 code）
      appendDiagStage(diag, 'form_validation', 'ok', now(), {
        startedAt: validationStart,
        latencyMs: Math.max(0, now() - validationStart),
        flags: { allFieldsVerified: true },
      })

      // 7. 全部字段验证通过，执行到表单填充完成，进入 waiting_confirmation 等待用户确认发布，
      //    同时下发一次性提交令牌：最终提交必须携带该令牌，点击后立即失效。
      const submitToken = generateSubmitToken()
      // 填写阶段完成，等待人工确认：记录 result ok（awaitingConfirm=true，尚未提交）
      setResultStage(diag, 'ok', now(), { flags: { awaitingConfirm: true } })
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
          diagnostics: snapshotDiagnostics(diag),
        },
      })

      return toPublishTask(finalTask)
    } catch (error: unknown) {
      // 若当前任务已经被外部取消或暂停，不得覆盖为 failed！
      const aborted = await checkInflightAborted(taskId)
      if (aborted) {
        // 中止（取消/暂停）时尽力保留已采集的诊断时间线，绝不改变任务状态
        await flushDiagBestEffort(taskId, diag)
        return toPublishTask(aborted)
      }

      const publishErr =
        error instanceof PublishError
          ? error
          : new PublishError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error))

      // 失败结论写入时间线，并在置 failed 前落盘（failed 为终态后无法再更新 meta）
      setResultStage(diag, 'failed', now(), { code: publishErr.code })
      await flushDiagBestEffort(taskId, diag)
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
      'FORM_VALIDATION_FAILED',
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
    options: { clearToken: boolean; submitAttempted?: boolean; diagnostics?: PublishDiagnostics },
  ): Promise<PublishTask> {
    const current = await tasks.getById(taskId)
    if (!current) {
      throw new PublishError('INVALID_PAYLOAD', `未找到任务 "${taskId}"`)
    }
    const currentResult = (current.result ?? {}) as unknown as PublishTaskResult
    const submitAttempted = options.submitAttempted ?? true
    const diagPatch =
      options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }

    // waiting_confirmation -> paused（合法）
    await tasks.pause(taskId, `提交状态持久化：${record.state}`)
    // paused 允许更新进度与 meta
    await tasks.updateProgress(taskId, 100, {
      submitAttempted,
      submitAttemptedAt: record.attemptedAt,
      submitState: record.state,
      submitRecord: record,
      ...diagPatch,
    })
    // paused -> waiting_confirmation（合法），同时回写 result.submit / 可选清除令牌
    const nextResult: PublishTaskResult = { ...currentResult, submit: record }
    if (options.clearToken) delete nextResult.submitToken
    const back = await tasks.waitForConfirmation(taskId, {
      progress: 100,
      result: nextResult,
      meta: { step: 'waiting_confirmation', ...diagPatch },
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
  async function rollbackSubmitDispatching(
    taskId: string,
    diagnostics?: PublishDiagnostics,
  ): Promise<PublishTask> {
    const current = await tasks.getById(taskId)
    if (!current) {
      throw new PublishError('INVALID_PAYLOAD', `未找到任务 "${taskId}"`)
    }
    const currentResult = (current.result ?? {}) as unknown as PublishTaskResult
    const nextResult: PublishTaskResult = { ...currentResult }
    delete nextResult.submit
    const diagPatch = diagnostics === undefined ? {} : { diagnostics }

    // waiting_confirmation -> paused -> waiting_confirmation（合法往返），复位提交锁
    await tasks.pause(taskId, '提交未派发，回滚 dispatching 锁')
    await tasks.updateProgress(taskId, 100, {
      submitAttempted: false,
      submitAttemptedAt: undefined,
      submitState: undefined,
      submitRecord: undefined,
      ...diagPatch,
    })
    return toPublishTask(
      await tasks.waitForConfirmation(taskId, {
        progress: 100,
        result: nextResult,
        meta: { step: 'waiting_confirmation', ...diagPatch },
      }),
    )
  }

  /** 提交后观察结果（以官方商品库**严格 +1** 为准，绝不凭 URL 判定成功）。 */
  type SubmitObservation =
    | { kind: 'submitted'; newItemId: string; beforeCount: number; afterCount: number }
    | { kind: 'unknown'; reason: string }

  /**
   * 提交后的官方商品库结果观察：**唯一允许判 submitted 的路径**。
   *
   * 成功判据（必须同时满足）：
   * 1. 提交前已成功快照官方在售商品基线（缺能力/基线时已在派发点击前拒绝，不会走到这里）；
   * 2. 提交后轮询官方接口，在售商品数 **严格等于基线 + 1**（afterCount === beforeCount + 1）；
   * 3. 恰好出现 1 个基线中不存在的新 itemId；若官方返回了标题且本次期望标题可得，标题必须一致（可信匹配）。
   *
   * URL 离开发布页仅用于生成诊断信息，**绝不作为成功依据**：误跳转登录页 / 首页 /
   * 官方校验失败未发布 / 数量未严格 +1 / 无查询权限，一律 unknown 并保持锁定。
   */
  async function observeSubmitOutcome(
    tabId: number,
    baselineIds: ReadonlySet<string>,
    beforeCount: number,
    expectedTitle: string | undefined,
  ): Promise<SubmitObservation> {
    const reader = deps.publishedItems
    if (!reader) {
      return { kind: 'unknown', reason: '缺少官方商品库读取能力，无法确认是否发布成功' }
    }
    const deadline = now() + submitObserveTimeoutMs
    let lastVerifyAt: number | null = null
    let sawLoginRedirect = false
    for (;;) {
      // 官方接口限速：首次立即读取，其后按 submitVerifyIntervalMs 节流。
      if (lastVerifyAt === null || now() - lastVerifyAt >= submitVerifyIntervalMs) {
        lastVerifyAt = now()
        try {
          const items = await reader.readOnSaleItems()
          const ids = new Set(items.map((it) => it.itemId).filter((id) => id.length > 0))
          const afterCount = ids.size
          const fresh = items.filter((it) => it.itemId && !baselineIds.has(it.itemId))
          // 本用户标准：必须“总数严格 +1”且“恰好 1 个新 id”，才可进入标题比对。
          if (afterCount === beforeCount + 1 && fresh.length === 1) {
            const expected = normalizeMatchText(expectedTitle)
            const freshTitle = normalizeMatchText(fresh[0]!.title)
            const matched =
              expected.length === 0 || freshTitle.length === 0 || freshTitle === expected
            if (matched) {
              return {
                kind: 'submitted',
                newItemId: fresh[0]!.itemId,
                beforeCount,
                afterCount,
              }
            }
          }
        } catch {
          // 读取失败（无权限 / 未登录 / 网络 / 风控）→ 继续轮询；到点仍无法确认则 unknown
        }
      }

      // URL 仅用于诊断（是否误跳转登录页），不参与成功判定。
      if (deps.tabs) {
        try {
          const tab = await deps.tabs.get(tabId)
          if (isLoginUrl(tab?.url)) sawLoginRedirect = true
        } catch {
          // 标签页正在跳转 / 被关闭，不影响以官方商品库为准的判定
        }
      }

      if (now() >= deadline) {
        return {
          kind: 'unknown',
          reason: sawLoginRedirect
            ? '发布页跳转登录页，且官方在售商品数未严格 +1，未确认发布成功'
            : '官方在售商品数未在超时时间内严格 +1 并出现新商品，结果未知',
        }
      }
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
   * 6. **派发点击前**先快照官方在售商品基线；缺读取能力 / 无基线直接拒绝（绝不“先发后 unknown”）；
   *    已派发点击后的结果以**官方在售商品数严格 +1（afterCount === beforeCount + 1）
   *    + 唯一新 itemId + 标题可信匹配**为唯一成功证据（绝不凭 URL 离开发布页判定）；
   *    数量未严格 +1 / 超时一律保持锁定标记 unknown 且绝不自动重试。
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

    // 发布可复用诊断时间线：从任务已有记录续接（跨命令 / 跨 SW 重启累计），全程安全、有界。
    const diag = readDiagnosticsFromMeta(task.meta)

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
      const submitPageCheckStart = now()
      const submitPageCheckEntry = beginDiagStage(diag, 'page_check', submitPageCheckStart)
      try {
        await formFiller.checkPageStatus(targetTabId)
        endDiagStage(submitPageCheckEntry, 'ok', now(), {
          flags: { isPublishPage: true, isLoggedIn: true, hasCaptcha: false },
        })
      } catch (pageErr) {
        endDiagStage(submitPageCheckEntry, 'failed', now(), {
          code: pageErr instanceof PublishError ? pageErr.code : 'INTERNAL_ERROR',
        })
        throw pageErr
      }

      // 7.5 提交前快照官方「我的商品库」在售商品基线（成功判定的唯一依据）。
      //     **缺读取能力 / 无法取得基线时必须在派发点击前直接拒绝**（绝不“先发后 unknown”）。
      if (!deps.publishedItems) {
        appendDiagStage(diag, 'baseline', 'failed', now(), { code: 'SUBMIT_VERIFY_UNAVAILABLE' })
        throw new PublishError(
          'SUBMIT_VERIFY_UNAVAILABLE',
          '缺少官方商品库读取能力，无法核验是否真正发布，已拒绝提交',
          { retryable: false },
        )
      }
      const baselineStart = now()
      let baseline: PublishedItemRef[]
      try {
        baseline = await deps.publishedItems.readOnSaleItems()
      } catch {
        appendDiagStage(diag, 'baseline', 'failed', now(), {
          startedAt: baselineStart,
          latencyMs: Math.max(0, now() - baselineStart),
          code: 'SUBMIT_VERIFY_UNAVAILABLE',
        })
        throw new PublishError(
          'SUBMIT_VERIFY_UNAVAILABLE',
          '无法读取官方在售商品基线（未登录 / 无权限 / 网络失败），已拒绝提交',
          { retryable: false },
        )
      }
      const baselineIds = new Set(
        baseline.map((it) => it.itemId).filter((id) => id.length > 0),
      )
      const beforeCount = baselineIds.size
      appendDiagStage(diag, 'baseline', 'ok', now(), {
        startedAt: baselineStart,
        latencyMs: Math.max(0, now() - baselineStart),
        counters: { onSaleCount: beforeCount },
      })

      // 人工确认期间可能切号或下架；在写入派发锁之前只读复验，失败不点击。
      const sourcePayload = task.payload as PublishTaskPayload
      if (sourcePayload.source !== 'feishu') {
        await controller.preparePublishItem(sourcePayload.itemId ?? '', sourcePayload.rule, sourcePayload.override)
      }

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
      // 派发阶段（先 baseline 成功才走到这里）：点击前先落盘 dispatching 锁与诊断（含 dispatch started）
      const dispatchEntry = beginDiagStage(diag, 'submit_dispatch', now(), {
        counters: { clickCount: 0 },
        flags: { baselineReady: true },
      })
      await persistSubmitRecord(task.id, dispatchingRecord, {
        clearToken: false,
        submitAttempted: true,
        diagnostics: snapshotDiagnostics(diag),
      })

      // 9. 触发一次真实点击（注入侧只点击真实发布按钮，绝不猜测）
      let submitResult: FormSubmitResult
      try {
        submitResult = await formFiller.submit(targetTabId)
      } catch (err) {
        // 注入失败 / 结果丢失：点击可能已派发但页面跳转导致上下文丢失。
        // 保守按“已派发、结果未知”处理并保持锁定（不回滚 dispatching 锁、绝不自动重试）。
        const message = err instanceof Error ? err.message : String(err)
        endDiagStage(dispatchEntry, 'unknown', now(), { code: 'SUBMIT_DISPATCH_UNKNOWN' })
        appendDiagStage(diag, 'official_verify', 'unknown', now(), {
          counters: { before: beforeCount },
        })
        setResultStage(diag, 'unknown', now(), { code: 'SUBMIT_DISPATCH_UNKNOWN' })
        const record: PublishSubmitRecord = {
          state: 'unknown',
          attemptedAt: dispatchingRecord.attemptedAt,
          clickedAt: now(),
          tabId: targetTabId,
          message: `提交执行结果未知：${message}`,
        }
        // 结果未知时令牌必须失效（点击可能已生效），显式 clearToken: true 保证幂等失效。
        const updated = await persistSubmitRecord(task.id, record, {
          clearToken: true,
          diagnostics: snapshotDiagnostics(diag),
        })
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
        const code = toSubmitErrorCode(submitResult.code)
        endDiagStage(dispatchEntry, 'failed', now(), { code, counters: { clickCount: 0 } })
        setResultStage(diag, 'failed', now(), { code })
        await rollbackSubmitDispatching(task.id, snapshotDiagnostics(diag))
        throw new PublishError(code, submitResult.reason || '提交前校验未通过，未点击发布按钮', {
          retryable: false,
          details: submitResult,
        })
      }
      endDiagStage(dispatchEntry, 'ok', now(), {
        code: undefined,
        counters: { clickCount: 1 },
        flags: { clicked: true },
      })

      // 11. 已派发点击：持久化进行中状态并立即失效令牌（防重放），
      //     随后以官方「我的商品库」真实在售商品数 +1 / 新 itemId 判定结果。
      const clickedRecord: PublishSubmitRecord = {
        state: 'in_progress',
        attemptedAt: dispatchingRecord.attemptedAt,
        clickedAt: submitResult.clickedAt ?? now(),
        tabId: targetTabId,
        message: '已派发发布按钮点击，正在观察结果',
      }
      await persistSubmitRecord(task.id, clickedRecord, {
        clearToken: true,
        submitAttempted: true,
        diagnostics: snapshotDiagnostics(diag),
      })

      const observeStart = now()
      const observation = await observeSubmitOutcome(
        targetTabId,
        baselineIds,
        beforeCount,
        task.result?.item?.title,
      )

      if (observation.kind === 'submitted') {
        appendDiagStage(diag, 'official_verify', 'ok', now(), {
          startedAt: observeStart,
          latencyMs: Math.max(0, now() - observeStart),
          counters: { before: observation.beforeCount, after: observation.afterCount },
          flags: { strictPlusOne: true },
        })
        setResultStage(diag, 'ok', now(), {
          counters: { before: observation.beforeCount, after: observation.afterCount },
          flags: { awaitingConfirm: false },
        })
        const completedResult: PublishTaskResult = {
          ...((task.result ?? {}) as PublishTaskResult),
          confirmationStatus: 'confirmed' as PublishManualConfirmationStatus,
          manualConfirmNote: '用户已在发布中心点击发布，官方在售商品数已严格 +1',
          submit: {
            state: 'submitted',
            attemptedAt: clickedRecord.attemptedAt,
            clickedAt: clickedRecord.clickedAt,
            tabId: targetTabId,
            publishedItemId: observation.newItemId,
            beforeCount: observation.beforeCount,
            afterCount: observation.afterCount,
            message: `提交成功（官方在售商品数 ${observation.beforeCount} → ${observation.afterCount}）`,
          },
        }
        delete completedResult.submitToken
        // complete 是终态、无法再写 meta：先把最终诊断落盘，再 complete
        await persistSubmitDiagBestEffort(task.id, diag)
        const completed = await tasks.complete(task.id, completedResult)
        return {
          id: completed.id,
          outcome: 'submitted',
          deterministic: true,
          task: toPublishTask(completed),
          tabId: targetTabId,
          newItemId: observation.newItemId,
          beforeCount: observation.beforeCount,
          afterCount: observation.afterCount,
          message: `发布提交成功，官方在售商品数已严格 +1（${observation.beforeCount} → ${observation.afterCount}）`,
        }
      }

      // 12. 结果未知：保持 waiting_confirmation，标记 unknown 并锁定，绝不自动重试。
      appendDiagStage(diag, 'official_verify', 'unknown', now(), {
        startedAt: observeStart,
        latencyMs: Math.max(0, now() - observeStart),
        counters: { before: beforeCount },
        flags: { strictPlusOne: false },
      })
      setResultStage(diag, 'unknown', now(), { counters: { before: beforeCount } })
      const unknownRecord: PublishSubmitRecord = {
        state: 'unknown',
        attemptedAt: clickedRecord.attemptedAt,
        clickedAt: clickedRecord.clickedAt,
        tabId: targetTabId,
        message: observation.reason,
      }
      // 令牌已在第 11 步派发点击时清除；此处同样以 clearToken: true 表达“确保令牌失效”，
      // 修正此前 clearToken: false “依赖上一步、语义自相矛盾”的写法。
      const unknownTask = await persistSubmitRecord(task.id, unknownRecord, {
        clearToken: true,
        diagnostics: snapshotDiagnostics(diag),
      })
      return {
        id: unknownTask.id,
        outcome: 'unknown',
        deterministic: false,
        task: unknownTask,
        tabId: targetTabId,
        message: '已点击发布但官方商品库未确认新增商品，结果未知，请人工核实；系统不会自动重试',
      }
    } catch (submitError: unknown) {
      // 记录失败结论并尽力持久化诊断（绝不改变既有错误返回语义，也不改变提交锁状态）。
      // 若任务已派发过提交（submitAttempted=true，例如 prior unknown 锁定），则保留既有结论，
      // 绝不让一次被拒绝的重复提交把已锁定的结果改写成 failed。
      const code = submitError instanceof PublishError ? submitError.code : 'INTERNAL_ERROR'
      const priorAttempted = (task.meta?.submitAttempted as boolean | undefined) === true
      if (!priorAttempted) {
        setResultStage(diag, 'failed', now(), { code })
      }
      await persistSubmitDiagBestEffort(task.id, diag)
      throw submitError
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
          // 无需新增路由：直接把安全诊断时间线（若有）随任务详情返回，便于 UI 渲染
          const result: PublishGetResult = {
            task,
            ...(task.meta?.diagnostics ? { diag: task.meta.diagnostics } : {}),
          }
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
    // 飞书底层错误绝不透传原始 message（可能含 URL / token / secret）。
    if (err instanceof FeishuError) {
      const mapped = mapFeishuErrorForPublish(err)
      return createErrorResponse(command.requestId, command.type, {
        code: mapped.code,
        message: mapped.message,
        businessCode: 'FEISHU_SOURCE_ERROR',
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
