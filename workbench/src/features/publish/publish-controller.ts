/**
 * 发布中心页面控制器（P8）。
 *
 * 职责：
 * 1. 与 BridgeApi 通信：PRODUCT_LIST（获取商品候选源）、PUBLISH_CREATE、PUBLISH_LIST、
 *    PUBLISH_GET、PUBLISH_FILL_FORM、PUBLISH_CANCEL、PUBLISH_CONFIRM_STATUS、PUBLISH_SUBMIT；
 * 2. 支持显式选择商品与随机选择 1 条商品并展示预览；
 * 3. 创建发布任务并在后台静默打开发布页执行表单自动填充（PUBLISH_FILL_FORM）；
 * 4. 表单填充完毕后停在 waiting_confirmation，下发一次性 submitToken；
 * 5. 严格禁止自动发布或隐式触发提交，仅支持用户在工作台明确点击一次“发布”按钮触发 PUBLISH_SUBMIT；
 * 6. 提交按钮严格防双击、提交后立即锁定，成功展示已提交，未知结果绝不自动重试，保留取消/放弃入口。
 */

import { CommandTypes, EventTypes } from '@fishops/shared'
import type {
  Product,
  PublishItemOverride,
  PublishRule,
  PublishSubmitOutcome,
  PublishSubmitResult,
  PublishTask,
} from '../contracts'
import type { BridgeApi } from '../shared/bridge-api'
import { toErrorView, type ErrorView } from '../shared/error-format'
import { StateStore, type ActionPhase, type LoadPhase } from '../shared/state-store'

export const PUBLISH_EVENTS = [
  EventTypes.TASK_CHANGED,
  EventTypes.PUBLISH_TASK_CHANGED,
  EventTypes.WORKER_STARTED,
] as const

export interface PublishState {
  availability: 'unavailable' | 'ready'
  /** 商品库候选源加载状态 */
  products: {
    phase: LoadPhase
    items: Product[]
    error: ErrorView | null
  }
  /** 当前选中的商品 */
  selectedProduct: Product | null
  /** 自定义发布规则调整项 */
  customRule: {
    priceMultiplier: number
    priceMarkup: number
    titlePrefix: string
    titleSuffix: string
    descPrefix: string
    descSuffix: string
  }
  /** 发布任务列表 */
  taskList: {
    phase: LoadPhase
    items: PublishTask[]
    total: number
    error: ErrorView | null
  }
  /** 当前聚焦/填表中的发布任务 */
  currentTask: PublishTask | null
  /** 填表与操作执行状态 */
  action: {
    phase: ActionPhase
    error: ErrorView | null
    successMessage: string | null
  }
  /** 正在执行最终发布提交的任务 ID（用于防双击与状态锁定） */
  submittingTaskId: string | null
  /** 最近一次提交的结构化反馈（submitted / unknown） */
  submitOutcome: {
    taskId: string
    outcome: PublishSubmitOutcome
    message?: string
  } | null
}

export interface PublishControllerOptions {
  api: BridgeApi | null
  /** 随机数生成器，便于单测确定性验证 */
  randomFn?: () => number
}

export function createInitialPublishState(
  availability: PublishState['availability'],
): PublishState {
  return {
    availability,
    products: { phase: 'idle', items: [], error: null },
    selectedProduct: null,
    customRule: {
      priceMultiplier: 1.0,
      priceMarkup: 0,
      titlePrefix: '',
      titleSuffix: '',
      descPrefix: '',
      descSuffix: '',
    },
    taskList: { phase: 'idle', items: [], total: 0, error: null },
    currentTask: null,
    action: { phase: 'idle', error: null, successMessage: null },
    submittingTaskId: null,
    submitOutcome: null,
  }
}

function makeSimpleError(title: string, hint = ''): ErrorView {
  return {
    title,
    hint,
    detail: '',
    kind: 'validation',
    code: 'VALIDATION_ERROR',
  }
}

export class PublishController extends StateStore<PublishState> {
  private readonly api: BridgeApi | null
  private readonly randomFn: () => number
  private unsubscribeEvents: (() => void) | null = null

  constructor(options: PublishControllerOptions) {
    const availability = options.api ? 'ready' : 'unavailable'
    super(createInitialPublishState(availability))
    this.api = options.api
    this.randomFn = options.randomFn ?? Math.random
  }

  start(): void {
    if (!this.api) return
    this.bindEvents()
    void this.loadProducts()
    void this.loadTasks()
  }

  resubscribe(): void {
    if (!this.api) return
    this.bindEvents()
    void this.loadTasks()
  }

  override dispose(): void {
    super.dispose()
    if (this.unsubscribeEvents) {
      this.unsubscribeEvents()
      this.unsubscribeEvents = null
    }
  }

  private bindEvents(): void {
    if (!this.api) return
    if (this.unsubscribeEvents) this.unsubscribeEvents()

    const un1 = this.api.on(EventTypes.TASK_CHANGED, (payload) => {
      if (payload?.task && payload.task.type === 'publish') {
        this.handleTaskUpdated(payload.task as unknown as PublishTask)
      }
    })
    const un2 = this.api.on(EventTypes.PUBLISH_TASK_CHANGED, (payload) => {
      if (payload?.task) {
        this.handleTaskUpdated(payload.task)
      }
    })

    this.unsubscribeEvents = () => {
      un1()
      un2()
    }
  }

  private handleTaskUpdated(task: PublishTask): void {
    const s = this.state
    const index = s.taskList.items.findIndex((t) => t.id === task.id)
    let newItems: PublishTask[]
    if (index >= 0) {
      newItems = [...s.taskList.items]
      newItems[index] = task
    } else {
      newItems = [task, ...s.taskList.items]
    }

    const currentTask =
      s.currentTask?.id === task.id ? task : s.currentTask

    this.patch({
      taskList: {
        ...s.taskList,
        items: newItems,
      },
      currentTask,
    })
  }

  /**
   * 从商品库加载候选商品（PRODUCT_LIST）
   */
  async loadProducts(): Promise<void> {
    if (!this.api) return
    const s = this.state
    this.patch({
      products: { ...s.products, phase: 'loading', error: null },
    })

    try {
      // 发布候选源只能来自当前账号已确认发布商品：显式传 source: 'my_published'，
      // 绝不把采集到的竞品 / 存量未确认商品当作可发布候选，与后台发布控制器的来源校验保持一致。
      const res = await this.api.call(CommandTypes.PRODUCT_LIST, {
        limit: 100,
        source: 'my_published',
      })
      const items = Array.isArray(res?.products) ? res.products : []

      // 保持用户此前明确选中的商品（若仍存在于新列表中），禁止偷偷自动选择第一项
      const retainedProduct = s.selectedProduct
        ? items.find((p) => p.itemId === s.selectedProduct?.itemId) ?? null
        : null

      this.patch({
        products: { phase: 'ready', items, error: null },
        selectedProduct: retainedProduct,
      })
    } catch (err: unknown) {
      this.patch({
        products: {
          ...s.products,
          phase: 'error',
          error: toErrorView(err),
        },
      })
    }
  }

  /**
   * 显式选择商品（传入空字符串表示清除选择）
   */
  selectProduct(itemId: string): void {
    const s = this.state
    const trimmed = itemId.trim()
    if (!trimmed) {
      this.patch({
        selectedProduct: null,
        action: { phase: 'idle', error: null, successMessage: null },
      })
      return
    }
    const found = s.products.items.find((p) => p.itemId === trimmed) ?? null
    this.patch({
      selectedProduct: found,
      action: { phase: 'idle', error: null, successMessage: null },
    })
  }

  /**
   * 随机选择 1 条商品并显示预览
   */
  async selectRandomProduct(): Promise<Product | null> {
    let s = this.state
    if (s.products.items.length === 0) {
      await this.loadProducts()
      s = this.state
    }

    const items = s.products.items
    if (items.length === 0) {
      this.patch({
        action: {
          phase: 'failed',
          error: makeSimpleError('商品库为空', '请先采集或导入商品后再进行选择'),
          successMessage: null,
        },
      })
      return null
    }

    const randomIndex = Math.floor(this.randomFn() * items.length)
    const picked = items[randomIndex] ?? items[0]!

    this.patch({
      selectedProduct: picked,
      action: {
        phase: 'idle',
        error: null,
        successMessage: `已为您随机挑选商品: ${picked.title}`,
      },
    })
    return picked
  }

  /**
   * 更新界面自定义规则
   */
  updateCustomRule(patch: Partial<PublishState['customRule']>): void {
    const s = this.state
    this.patch({
      customRule: {
        ...s.customRule,
        ...patch,
      },
    })
  }

  /**
   * 加载发布任务列表（PUBLISH_LIST）
   */
  async loadTasks(): Promise<void> {
    if (!this.api) return
    const s = this.state
    this.patch({
      taskList: { ...s.taskList, phase: 'loading', error: null },
    })

    try {
      const res = await this.api.call(CommandTypes.PUBLISH_LIST, { limit: 50 })
      const items = Array.isArray(res?.tasks) ? res.tasks : []
      const total = typeof res?.total === 'number' ? res.total : items.length

      this.patch({
        taskList: { phase: 'ready', items, total, error: null },
      })
    } catch (err: unknown) {
      this.patch({
        taskList: {
          ...s.taskList,
          phase: 'error',
          error: toErrorView(err),
        },
      })
    }
  }

  /**
   * 查询指定发布任务详情（PUBLISH_GET）
   */
  async getTask(id: string): Promise<PublishTask | null> {
    if (!this.api) return null
    const trimmed = id.trim()
    if (!trimmed) return null
    try {
      const res = await this.api.call(CommandTypes.PUBLISH_GET, { id: trimmed })
      const task = (res?.task as PublishTask | undefined) ?? null
      if (task) {
        this.handleTaskUpdated(task)
      }
      return task
    } catch (err: unknown) {
      this.patch({
        action: {
          phase: 'failed',
          error: toErrorView(err),
          successMessage: null,
        },
      })
      return null
    }
  }

  /**
   * 设置当前聚焦核对的任务
   */
  setCurrentTask(task: PublishTask | null): void {
    this.patch({ currentTask: task })
  }

  /**
   * 核心填表流程：创建发布任务（PUBLISH_CREATE）并立即触发自动表单填充（PUBLISH_FILL_FORM）
   * 执行完成后任务进入 waiting_confirmation 状态，绝不点击发布按钮！
   */
  async createAndFillTask(override?: PublishItemOverride): Promise<PublishTask | null> {
    if (!this.api) return null
    const s = this.state
    const product = s.selectedProduct
    if (!product) {
      this.patch({
        action: {
          phase: 'failed',
          error: makeSimpleError('请先选择商品', '需要选择需要发布的商品后方可填表'),
          successMessage: null,
        },
      })
      return null
    }

    this.patch({
      action: { phase: 'running', error: null, successMessage: null },
    })

    try {
      // 1. 组装规则
      const rule: Partial<PublishRule> = {
        price: {
          multiplier: s.customRule.priceMultiplier,
          markup: s.customRule.priceMarkup,
        },
        content: {
          titlePrefix: s.customRule.titlePrefix,
          titleSuffix: s.customRule.titleSuffix,
          descPrefix: s.customRule.descPrefix,
          descSuffix: s.customRule.descSuffix,
        },
      }

      // 2. 发起真实 PUBLISH_CREATE
      const createRes = await this.api.call(CommandTypes.PUBLISH_CREATE, {
        itemId: product.itemId,
        rule,
        override,
      })
      const created = createRes.task
      this.patch({
        currentTask: created,
      })

      // 3. 紧接着发起真实 PUBLISH_FILL_FORM
      const fillRes = await this.api.call(CommandTypes.PUBLISH_FILL_FORM, {
        id: created.id,
      })
      const filledTask = fillRes.task

      this.patch({
        currentTask: filledTask,
        action: {
          phase: 'ok',
          error: null,
          successMessage:
            '表单填充已就绪，已生成一次性提交令牌。请点击“发布”按钮提交发布。',
        },
      })

      void this.loadTasks()
      return filledTask
    } catch (err: unknown) {
      this.patch({
        action: {
          phase: 'failed',
          error: toErrorView(err),
          successMessage: null,
        },
      })
      return null
    }
  }

  /**
   * 取消任务（PUBLISH_CANCEL）
   */
  async cancelTask(taskId: string, reason?: string): Promise<void> {
    if (!this.api) return
    try {
      await this.api.call(CommandTypes.PUBLISH_CANCEL, { id: taskId, reason })
      void this.getTask(taskId)
      void this.loadTasks()
    } catch (err: unknown) {
      this.patch({
        action: {
          phase: 'failed',
          error: toErrorView(err),
          successMessage: null,
        },
      })
    }
  }

  /**
   * 最终发布提交（PUBLISH_SUBMIT）
   *
   * 业务规则与安全防线：
   * 1. 绝不自动发布，必须由操作员在工作台明确点击“发布”按钮单次调用；
   * 2. 按钮防双击与提交后锁定：同一任务在提交中（submittingTaskId）或已尝试过提交（submitAttempted / submitOutcome）时严格阻断；
   * 3. 必须携带后台下发的合法一次性 submitToken 与 confirm: true 字面量，禁止扫描猜测选择器；
   * 4. 成功返回 outcome === 'submitted' 展示已提交；
   * 5. 若返回 outcome === 'unknown'，展示结果未知，坚决不自动重试，提示人工核实；
   * 6. 确定性错误（如 SUBMIT_BUTTON_NOT_FOUND）未派发点击、未锁定时可提示修正后重新点击，
   *    但若后台已锁定（如 SUBMIT_DUPLICATE）或令牌已失效（如 SUBMIT_TOKEN_INVALID），必须尊重后台状态。
   */
  async submitPublish(taskId?: string): Promise<PublishSubmitResult | null> {
    if (!this.api) return null

    const s = this.state
    const targetTask = taskId
      ? s.taskList.items.find((t) => t.id === taskId) ?? (s.currentTask?.id === taskId ? s.currentTask : null)
      : s.currentTask

    if (!targetTask) {
      this.patch({
        action: {
          phase: 'failed',
          error: makeSimpleError('未找到发布任务', '请先选择商品并创建填充任务后再提交发布'),
          successMessage: null,
        },
      })
      return null
    }

    // 1. 本地防双击与并发锁
    if (s.submittingTaskId === targetTask.id || s.action.phase === 'running') {
      return null
    }

    // 2. 状态机校验：仅 waiting_confirmation 允许最终提交
    if (targetTask.status !== 'waiting_confirmation') {
      this.patch({
        action: {
          phase: 'failed',
          error: makeSimpleError(
            '当前任务状态不允许发布',
            `任务当前状态为“${targetTask.status}”，只有表单就绪等待发布（waiting_confirmation）的任务可以提交。`,
          ),
          successMessage: null,
        },
      })
      return null
    }

    // 3. 严格尊重后台锁状态：已派发过提交的任务绝不再提交（防重复发布）
    const isAlreadyAttempted =
      (targetTask.meta?.submitAttempted as boolean | undefined) === true ||
      targetTask.result?.submit?.state === 'submitted' ||
      targetTask.result?.submit?.state === 'unknown'

    if (isAlreadyAttempted) {
      this.patch({
        action: {
          phase: 'failed',
          error: makeSimpleError(
            '该任务已派发过提交',
            '该任务此前已派发过发布提交，后台已锁定。为避免在平台重复发布同一商品，禁止再次点击。',
          ),
          successMessage: null,
        },
      })
      return null
    }

    // 4. 一次性令牌校验：必须使用后台下发的 submitToken，禁止猜测选择器
    const submitToken = targetTask.result?.submitToken
    if (!submitToken || typeof submitToken !== 'string' || !submitToken.trim()) {
      this.patch({
        action: {
          phase: 'failed',
          error: makeSimpleError(
            '提交令牌缺失或已失效',
            '当前任务缺少有效的一次性发布令牌，请重新执行表单填充后再提交。',
          ),
          successMessage: null,
        },
      })
      return null
    }

    // 5. 设置提交状态，锁定提交动作
    this.patch({
      submittingTaskId: targetTask.id,
      action: {
        phase: 'running',
        error: null,
        successMessage: null,
      },
    })

    try {
      // 6. 调用后台 PUBLISH_SUBMIT 契约
      const res = await this.api.call(CommandTypes.PUBLISH_SUBMIT, {
        id: targetTask.id,
        submitToken,
        confirm: true,
      })

      // 7. 更新本地任务快照
      if (res?.task) {
        this.handleTaskUpdated(res.task)
      }

      // 8. 区分 outcome：submitted vs unknown
      if (res.outcome === 'submitted') {
        this.patch({
          submittingTaskId: null,
          submitOutcome: {
            taskId: targetTask.id,
            outcome: 'submitted',
            message: res.message || '商品发布已成功提交！',
          },
          action: {
            phase: 'ok',
            error: null,
            successMessage: '商品发布已提交！',
          },
        })
      } else {
        // outcome === 'unknown'：结果未知，明确提示切勿自动重试
        this.patch({
          submittingTaskId: null,
          submitOutcome: {
            taskId: targetTask.id,
            outcome: 'unknown',
            message:
              res.message ||
              '发布提交结果未知（未观测到明确跳转信号）。后台已记录并锁定，请勿自动或重复重试，请稍后在闲鱼核实。',
          },
          action: {
            phase: 'ok',
            error: null,
            successMessage:
              '发布结果未知：提交点击已派发，但在超时时间内未确认平台返回。为防重复发布，绝不自动重试，请前往闲鱼查看。',
          },
        })
      }

      void this.loadTasks()
      return res
    } catch (err: unknown) {
      const errObj = err as { code?: string; businessCode?: string; message?: string } | null
      const businessCode = errObj?.businessCode || errObj?.code
      const errorView = toErrorView(err)

      // 区分确定性错误与锁/令牌状态提示
      if (businessCode === 'SUBMIT_BUTTON_NOT_FOUND') {
        errorView.hint = '未在发布页找到发布按钮，请检查页面加载状态后重新点击发布。'
      } else if (businessCode === 'SUBMIT_BUTTON_DISABLED') {
        errorView.hint = '页面发布按钮当前不可点击，请检查发布信息是否完整后重新点击。'
      } else if (businessCode === 'SUBMIT_DUPLICATE') {
        errorView.hint = '该任务已派发过提交或正在提交中，后台已锁定，不可重复点击。'
      } else if (businessCode === 'SUBMIT_TOKEN_INVALID') {
        errorView.hint = '提交令牌已失效，请重新生成并填充表单。'
      } else if (businessCode === 'SUBMIT_PAGE_INVALID') {
        errorView.hint = '目标发布页不存在或已离开闲鱼发布页，无法提交。'
      }

      this.patch({
        submittingTaskId: null,
        action: {
          phase: 'failed',
          error: errorView,
          successMessage: null,
        },
      })

      // 同步后台最新状态（尊重后台可能的锁状态）
      void this.getTask(targetTask.id)
      void this.loadTasks()
      return null
    }
  }

}
