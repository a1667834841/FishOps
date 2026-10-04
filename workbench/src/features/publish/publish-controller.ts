/**
 * 发布中心页面控制器（P8）。
 *
 * 职责：
 * 1. 与 BridgeApi 通信：PRODUCT_LIST（获取自营商品候选源）、FEISHU_PRODUCT_GET（读取飞书表素材）、
 *    PUBLISH_CREATE、PUBLISH_LIST、PUBLISH_GET、PUBLISH_FILL_FORM、PUBLISH_CANCEL、PUBLISH_CONFIRM_STATUS、PUBLISH_SUBMIT；
 * 2. 接收从商品库导航带来的发布草稿（PublishDraft，精准携带 recordId / targetTableId / 真实 itemId）；
 * 3. 支持在发布页直接编辑标题、描述、售价、划线原价、图片 URL；
 * 4. 关键安全防线：当用户编辑内容或切换商品/素材时，旧 task 及其提交令牌立即失效（置为 null），避免提交错误旧内容；
 * 5. 保存编辑仅作为本次发布表单填充的 override 使用，绝不自动反向修改飞书多维表格；
 * 6. 飞书素材保留 recordId 作为唯一 row identity，绝不冒充 my_published，缺失商品ID时绝无假 itemId；
 * 7. 严格禁止自动发布或隐式触发提交，仅支持用户在工作台明确点击一次“发布”按钮触发 PUBLISH_SUBMIT；
 * 8. 提交按钮严格防双击、提交后立即锁定，成功展示已提交，未知结果绝不自动重试，保留取消/放弃入口。
 */

import { CommandTypes, EventTypes } from '@fishops/shared'
import {
  computeFinalPublishItem,
  stripUnicodeEmoji,
  type FinalPublishItem,
} from './publish-format'
import type {
  FeishuProductGetResult,
  Product,
  PublishCreatePayload,
  PublishDiagnostics,
  PublishGetResult,
  PublishItemOverride,
  PublishSubmitOutcome,
  PublishSubmitResult,
  PublishTask,
} from '../contracts'
import type { BridgeApi } from '../shared/bridge-api'
import { toErrorView, type ErrorView } from '../shared/error-format'
import { StateStore, type ActionPhase, type LoadPhase } from '../shared/state-store'
import type { PublishDraft } from './publish-draft-store'
import { sanitizePublishDiagnostics } from './publish-diagnostics'

export const PUBLISH_EVENTS = [
  EventTypes.TASK_CHANGED,
  EventTypes.PUBLISH_TASK_CHANGED,
  EventTypes.WORKER_STARTED,
] as const

/** 正在编辑中的发布草稿数据 */
export interface EditingPublishDraft {
  source: 'feishu' | 'my_published'
  /** 飞书记录 ID */
  recordId?: string
  /** 飞书目标数据表 ID */
  targetTableId?: string
  /** 闲鱼真实商品 ID（若无则保持空串，绝不伪造随机 ID） */
  itemId?: string
  /** 编辑标题 */
  title: string
  /** 编辑描述文案 */
  desc: string
  /** 编辑售价 */
  price: number
  /** 编辑原价 */
  originalPrice: number
  /** 封面图片 URL */
  coverUrl: string
  /** 图片 URL 列表（支持多图发布） */
  imageUrls: string[]
  /** 标记是否经过用户手动修改 */
  isDirty?: boolean
}

export interface PublishState {
  availability: 'unavailable' | 'ready'
  /** 自营商品库候选源加载状态 */
  products: {
    phase: LoadPhase
    items: Product[]
    error: ErrorView | null
  }
  /** 当前选中的商品（自营商品来源） */
  selectedProduct: Product | null
  /** 当前正在编辑的发布草稿（支持飞书素材或自营商品编辑） */
  editingDraft: EditingPublishDraft | null
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
  /** 最近一次提交的结构化反馈（submitted / unknown / in_progress） */
  submitOutcome: {
    taskId: string
    outcome: PublishSubmitOutcome | 'in_progress'
    message?: string
  } | null
  /**
   * 当前聚焦任务的发布诊断时间线（已安全过滤）。
   * 无诊断记录（旧任务 / 尚未产生）时为 null，UI 据此提示“无记录”，绝不本地补位造 fake。
   */
  diagnostics: PublishDiagnostics | null
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
    editingDraft: null,
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
    diagnostics: null,
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

/** 归一化身份字段：将 undefined / 空白统一为空串，供精确比较。 */
function normalizeIdentityId(value: string | undefined): string {
  return (value ?? '').trim()
}

/** 冻结后的目标身份：飞书以 recordId + targetTableId 承载，自营以 itemId 承载。 */
interface FrozenPublishIdentity {
  source: 'feishu' | 'my_published'
  recordId?: string
  targetTableId?: string
  itemId?: string
}

/**
 * 由最终计算值构造「无 undefined 键」的覆盖对象。
 *
 * codec 对 PUBLISH_CREATE 采用严格键白名单，任何 undefined 可选键都会造成负载歧义，
 * 因此此处仅写入真实有值的字段。标题 / 描述在此再统一清理一次 Unicode emoji：
 * 即便走 fallbackTitle / fallbackDesc 分支（如全 emoji 被清空后回退），也能保证
 * “预览（preview）=== 实际发送（send）”，绝不把 emoji 重新带进真实发布。
 */
function buildPublishOverride(
  finalItem: FinalPublishItem,
  fallbackTitle?: string,
  fallbackDesc?: string,
): PublishItemOverride {
  const override: PublishItemOverride = {}
  const title = stripUnicodeEmoji(finalItem.title || fallbackTitle || '')
  if (title) override.title = title
  const descSource = finalItem.desc || fallbackDesc
  if (descSource !== undefined && descSource !== null) {
    override.desc = stripUnicodeEmoji(descSource)
  }
  if (finalItem.price > 0) override.price = finalItem.price
  if (finalItem.originalPrice > 0) override.originalPrice = finalItem.originalPrice
  if (finalItem.images.length > 0) override.images = [...finalItem.images]
  return override
}

/**
 * 按 source 构造 typed 的 PUBLISH_CREATE 负载，绝不写入 undefined 可选键：
 * - 飞书：仅 source / recordId / targetTableId（+ 真实商品 ID，若存在）/ rule / override；
 * - 自营：仅 source / itemId / rule / override。
 */
function buildPublishCreatePayload(
  identity: FrozenPublishIdentity,
  override: PublishItemOverride,
): PublishCreatePayload {
  const itemId = normalizeIdentityId(identity.itemId)
  if (identity.source === 'feishu') {
    const payload: PublishCreatePayload = {
      source: 'feishu',
      recordId: normalizeIdentityId(identity.recordId),
      targetTableId: normalizeIdentityId(identity.targetTableId),
      rule: {},
      override,
    }
    if (itemId) payload.itemId = itemId
    return payload
  }
  return {
    source: 'my_published',
    itemId,
    rule: {},
    override,
  }
}

/**
 * 判断既有任务是否与「当前冻结草稿」完全对应：
 * 1. 目标身份一致（source + recordId / targetTableId / itemId）；
 * 2. 任务最终发布字段与冻结最终参数逐字段一致（标题 / 描述 / 价格 / 原价 / 图片序列）。
 *
 * 只有完全命中的任务才允许复用其一次性提交令牌；否则一律视为无关历史任务，
 * 必须创建新任务，绝不复用旧令牌 —— 防止「聚焦历史任务却提交了当前另一份草稿」。
 */
function isPublishTaskMatchingFrozen(
  task: PublishTask,
  identity: FrozenPublishIdentity,
  finalItem: FinalPublishItem,
): boolean {
  const payload = task.payload ?? {}
  const taskSource = payload.source ?? 'my_published'
  if (taskSource !== identity.source) return false

  if (identity.source === 'feishu') {
    if (normalizeIdentityId(payload.recordId) !== normalizeIdentityId(identity.recordId)) return false
    if (normalizeIdentityId(payload.targetTableId) !== normalizeIdentityId(identity.targetTableId)) return false
    if (normalizeIdentityId(payload.itemId) !== normalizeIdentityId(identity.itemId)) return false
  } else if (normalizeIdentityId(payload.itemId) !== normalizeIdentityId(identity.itemId)) {
    return false
  }

  const item = task.result?.item
  if (!item) return false

  if (item.title !== finalItem.title) return false
  // desc：后台 buildPublishItem 对空 override.desc 会回退到来源商品描述（与前端 computeFinalPublishItem 不同），
  // 前端无法预知该回退值，故仅当冻结 desc 非空时才严格比对。
  const expectedDesc = finalItem.desc
  if (expectedDesc !== '' && (item.desc ?? '').trim() !== expectedDesc) return false
  if (item.price !== finalItem.price) return false
  if (item.originalPrice !== finalItem.originalPrice) return false

  const taskImages = [item.mainImage, ...(item.detailImages ?? [])]
    .map((url) => normalizeIdentityId(url))
    .filter(Boolean)
  const expectedImages = finalItem.images.map((url) => normalizeIdentityId(url)).filter(Boolean)
  if (taskImages.length !== expectedImages.length) return false
  return taskImages.every((url, index) => url === expectedImages[index])
}

export class PublishController extends StateStore<PublishState> {
  private readonly api: BridgeApi | null
  private readonly randomFn: () => number
  private unsubscribeEvents: (() => void) | null = null
  /**
   * 草稿代数守卫（Generation Seq / Draft Guard）：
   * 每当切换素材（loadDraft/selectProduct）或编辑字段（updateDraftField）时递增；
   * 异步执行中的 create/fill 必须校验代数一致性，一旦代数漂移立即放弃响应，
   * 严禁将旧任务与旧提交令牌恢复到当前状态。
   */
  private draftSeq = 0
  /** 是否正在执行确认发布调用链路（防双击与并发） */
  private isPublishingChain = false

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

  /**
   * 从任务快照的 meta 中安全提取诊断时间线（无记录返回 null，绝不造 fake）。
   * 仅在当前聚焦任务上使用；`getTask` 另有 PUBLISH_GET.diag 权威来源。
   */
  private diagnosticsForTask(task: PublishTask | null): PublishDiagnostics | null {
    if (!task) return null
    const raw = (task.meta as { diagnostics?: unknown } | undefined)?.diagnostics
    return sanitizePublishDiagnostics(raw)
  }

  /**
   * 设置当前聚焦任务时同时解析其诊断时间线。
   * 任务为空（切换草稿 / 取消聚焦）时诊断同步清空，绝不残留旧任务时间线。
   */
  private currentTaskPatch(
    task: PublishTask | null,
  ): { currentTask: PublishTask | null; diagnostics: PublishDiagnostics | null } {
    return { currentTask: task, diagnostics: this.diagnosticsForTask(task) }
  }

  private handleTaskUpdated(task: PublishTask, options?: { diagnostics?: unknown }): void {
    const s = this.state
    const index = s.taskList.items.findIndex((t) => t.id === task.id)
    let newItems: PublishTask[]
    if (index >= 0) {
      newItems = [...s.taskList.items]
      newItems[index] = task
    } else {
      newItems = [task, ...s.taskList.items]
    }

    const isCurrentTask = s.currentTask?.id === task.id
    const currentTask = isCurrentTask ? task : s.currentTask

    // 诊断时间线仅在快照属于当前聚焦任务时同步：陈旧 / 无关任务的事件绝不污染当前时间线。
    // 优先采用显式传入的权威来源（getTask 的 PUBLISH_GET.diag），缺省回退快照 meta.diagnostics；
    // 无记录时置 null，UI 提示“无记录”，绝不造 fake。
    const metaDiag = (task.meta as { diagnostics?: unknown } | undefined)?.diagnostics
    const incomingRaw = options?.diagnostics !== undefined ? options.diagnostics : metaDiag
    const diagnostics = isCurrentTask ? sanitizePublishDiagnostics(incomingRaw) : s.diagnostics

    // 跨刷新时同步 submit 结果：仅 state === 'submitted' 为成功，in_progress / unknown 保持对应状态且锁定
    let submitOutcome = s.submitOutcome
    const isMatchingTask = Boolean(
      task.id &&
      (currentTask?.id === task.id || s.submitOutcome?.taskId === task.id),
    )
    if (task.result?.submit && isMatchingTask) {
      const sub = task.result.submit
      submitOutcome = {
        taskId: task.id,
        outcome:
          sub.state === 'submitted'
            ? 'submitted'
            : sub.state === 'unknown'
              ? 'unknown'
              : 'in_progress',
        message: (sub as any).message,
      }
    } else if (
      isMatchingTask &&
      !task.result?.submit &&
      task.meta?.submitAttempted !== true &&
      submitOutcome?.taskId === task.id &&
      submitOutcome.outcome === 'in_progress'
    ) {
      // 权威快照回滚（clicked: false，后台清除 result.submit 且复位 meta.submitAttempted=false）：
      // 清空正在进行中遗留的 in_progress 状态，使 UI 恢复正常重试按钮。
      // 注意：未知 (unknown) 或已提交 (submitted) 或已派发点击 (submitAttempted=true) 绝不解锁！
      submitOutcome = null
    }

    this.patch({
      taskList: {
        ...s.taskList,
        items: newItems,
      },
      currentTask,
      submitOutcome,
      diagnostics,
    })
  }

  /**
   * 从自营商品库加载候选商品（PRODUCT_LIST { source: 'my_published' }）
   */
  async loadProducts(): Promise<void> {
    if (!this.api) return
    const s = this.state
    this.patch({
      products: { ...s.products, phase: 'loading', error: null },
    })

    try {
      const res = await this.api.call(CommandTypes.PRODUCT_LIST, {
        limit: 100,
        source: 'my_published',
      })
      const items = Array.isArray(res?.products) ? res.products : []

      // 保持用户此前明确选中的自营商品（若仍存在于新列表中），禁止自动偷选
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
   * 载入跨页面传递的草稿（从 ProductsPage 飞书 Tab 或自营 Tab 导航带入）。
   * 核心安全防线：载入新素材时立即使旧 task 失效，避免提交错误历史任务。
   */
  async loadDraft(draft: PublishDraft): Promise<void> {
    // 确认发布链路执行期间冻结草稿，禁止任何切换素材导致草稿漂移
    if (this.isPublishingChain) return
    const isFeishu = draft.source === 'feishu'
    const currentSeq = ++this.draftSeq

    const initialDraft: EditingPublishDraft = {
      source: draft.source,
      recordId: draft.recordId,
      targetTableId: draft.targetTableId,
      itemId: draft.itemId || undefined,
      title: draft.title || '',
      desc: draft.desc || '',
      price: draft.price || 0,
      originalPrice: draft.originalPrice || 0,
      coverUrl: draft.coverUrl || '',
      imageUrls: draft.imageUrls && draft.imageUrls.length > 0 ? draft.imageUrls : draft.coverUrl ? [draft.coverUrl] : [],
      isDirty: false,
    }

    // 关键安全防线：切换素材立即使旧 task 失效
    this.patch({
      selectedProduct: isFeishu ? null : (this.state.products.items.find((p) => p.itemId === draft.itemId) ?? null),
      editingDraft: initialDraft,
      currentTask: null,
      diagnostics: null,
      submittingTaskId: null,
      submitOutcome: null,
      action: { phase: 'idle', error: null, successMessage: null },
    })

    // 若来源为飞书且带有 recordId，异步调用后台 FEISHU_PRODUCT_GET 读取最新素材详情（携带 targetTableId 防漂移）
    if (isFeishu && draft.recordId && this.api) {
      try {
        const remote = await this.loadFeishuProduct(draft.recordId, draft.targetTableId)
        if (this.disposed || currentSeq !== this.draftSeq) return
        if (remote?.material && !this.state.editingDraft?.isDirty) {
          this.patch({
            editingDraft: {
              ...this.state.editingDraft!,
              title: remote.material.title || this.state.editingDraft!.title,
              desc: remote.material.desc || this.state.editingDraft!.desc,
              price: remote.material.price || this.state.editingDraft!.price,
              originalPrice: remote.material.originalPrice || this.state.editingDraft!.originalPrice,
              coverUrl: remote.material.coverUrl || this.state.editingDraft!.coverUrl,
              imageUrls: remote.material.images && remote.material.images.length > 0 ? remote.material.images : this.state.editingDraft!.imageUrls,
            },
          })
        }
      } catch {
        // 读取失败降级保留传入草稿，不抛出异常阻断用户操作
      }
    }
  }

  /**
   * 后台新增命令：读取已保存的飞书表素材详情（FEISHU_PRODUCT_GET）
   * 必须携带 targetTableId，供后台断言校验与当前配置商品表一致，杜绝目标表漂移。
   */
  async loadFeishuProduct(recordId: string, targetTableId?: string): Promise<FeishuProductGetResult | null> {
    if (!this.api) return null
    try {
      const res = await this.api.call(CommandTypes.FEISHU_PRODUCT_GET, {
        recordId: recordId.trim(),
        ...(targetTableId && targetTableId.trim() ? { targetTableId: targetTableId.trim() } : {}),
      })
      return (res as FeishuProductGetResult) ?? null
    } catch {
      return null
    }
  }

  /**
   * 编辑发布草稿字段（标题、描述、售价、原价、图片等）。
   * 核心安全防线：
   * 1. 执行 submit 期间严格禁止修改 draft，防止正在提交时数据被污染；
   * 2. 任何字段发生编辑，递增代数序列号，旧 task 必须立即失效！
   */
  updateDraftField(patch: Partial<EditingPublishDraft>): void {
    const s = this.state
    // 确认发布链路执行期间冻结草稿：严禁在链中编辑导致目标身份/内容漂移
    if (this.isPublishingChain) return
    // 执行 submit 时禁止改 draft
    if (s.submittingTaskId !== null || (s.action.phase === 'running' && s.submittingTaskId !== null)) {
      return
    }

    ++this.draftSeq
    const baseDraft = s.editingDraft ?? {
      source: (s.selectedProduct ? 'my_published' : 'feishu') as 'feishu' | 'my_published',
      title: s.selectedProduct?.title || '',
      desc: s.selectedProduct?.desc || '',
      price: s.selectedProduct?.priceNumber || 0,
      originalPrice: s.selectedProduct?.originalPriceNumber || 0,
      coverUrl: s.selectedProduct?.coverUrl || '',
      imageUrls: Array.isArray(s.selectedProduct?.images) && s.selectedProduct.images.length > 0
        ? [...s.selectedProduct.images]
        : s.selectedProduct?.coverUrl
          ? [s.selectedProduct.coverUrl]
          : [],
      itemId: s.selectedProduct?.itemId,
      recordId: (s.selectedProduct as any)?.recordId,
    }

    let images = patch.imageUrls !== undefined ? [...patch.imageUrls] : [...baseDraft.imageUrls]
    let cover = ''

    // 封面 coverUrl 与 images 同步
    if (patch.coverUrl !== undefined && patch.coverUrl.trim()) {
      cover = patch.coverUrl.trim()
      if (images.length === 0) {
        images = [cover]
      } else if (!images.includes(cover)) {
        images[0] = cover
      }
    } else {
      cover = images[0] || ''
    }

    const updated: EditingPublishDraft = {
      ...baseDraft,
      ...patch,
      coverUrl: cover,
      imageUrls: images,
      isDirty: true,
    }

    // 关键安全防线：编辑内容导致旧 task、旧一次性令牌全部作废，必须重新生成填表任务
    this.patch({
      editingDraft: updated,
      currentTask: null,
      diagnostics: null,
      submittingTaskId: null,
      submitOutcome: null,
      action: {
        phase: 'idle',
        error: null,
        successMessage: null,
      },
    })
  }

  /**
   * 显式从下拉框选择自营商品（传入空字符串表示清除选择）。
   * 切换商品同样使旧 task 失效。
   */
  selectProduct(itemId: string): void {
    const s = this.state
    // 确认发布链路执行期间冻结目标身份，禁止切换商品
    if (this.isPublishingChain) return
    ++this.draftSeq
    const trimmed = itemId.trim()
    if (!trimmed) {
      this.patch({
        selectedProduct: null,
        editingDraft: null,
        currentTask: null,
        diagnostics: null,
        submittingTaskId: null,
        submitOutcome: null,
        action: { phase: 'idle', error: null, successMessage: null },
      })
      return
    }
    const found = s.products.items.find((p) => p.itemId === trimmed) ?? null
    const newDraft: EditingPublishDraft | null = found
      ? {
          source: 'my_published',
          itemId: found.itemId,
          recordId: (found as any).recordId,
          title: found.title,
          desc: '',
          price: found.priceNumber || 0,
          originalPrice: found.originalPriceNumber || 0,
          coverUrl: found.coverUrl || '',
          imageUrls: found.coverUrl ? [found.coverUrl] : [],
          isDirty: false,
        }
      : null

    this.patch({
      selectedProduct: found,
      editingDraft: newDraft,
      currentTask: null,
      diagnostics: null,
      submittingTaskId: null,
      submitOutcome: null,
      action: { phase: 'idle', error: null, successMessage: null },
    })
  }

  /**
   * 随机选择 1 条商品并显示预览
   */
  async selectRandomProduct(): Promise<Product | null> {
    let s = this.state
    // 确认发布链路执行期间冻结目标身份，禁止随机切换商品
    if (this.isPublishingChain) return null
    ++this.draftSeq
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

    const newDraft: EditingPublishDraft = {
      source: 'my_published',
      itemId: picked.itemId,
      recordId: (picked as any).recordId,
      title: picked.title,
      desc: '',
      price: picked.priceNumber || 0,
      originalPrice: picked.originalPriceNumber || 0,
      coverUrl: picked.coverUrl || '',
      imageUrls: picked.coverUrl ? [picked.coverUrl] : [],
      isDirty: false,
    }

    this.patch({
      selectedProduct: picked,
      editingDraft: newDraft,
      currentTask: null,
      diagnostics: null,
      submittingTaskId: null,
      submitOutcome: null,
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
    // 确认发布链路执行期间冻结规则，禁止修改导致 override 漂移
    if (this.isPublishingChain) return
    ++this.draftSeq
    this.patch({
      customRule: {
        ...s.customRule,
        ...patch,
      },
      // 规则微调同样作废旧任务，需重新填表
      currentTask: null,
      diagnostics: null,
      submittingTaskId: null,
      submitOutcome: null,
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
        // 优先消费后台 PUBLISH_GET.diag 作为权威诊断来源，缺省回退快照 meta.diagnostics。
        this.handleTaskUpdated(task, { diagnostics: (res as PublishGetResult | undefined)?.diag })
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
    // 同步解析该任务自身的诊断时间线（无记录为 null），供刷新 / 历史详情持久复原。
    this.patch(this.currentTaskPatch(task))
  }

  /**
   * 核心填表流程：创建发布任务（PUBLISH_CREATE）并立即触发自动表单填充（PUBLISH_FILL_FORM）
   *
   * 契约对齐：
   * - 支持飞书素材发布（source: 'feishu', recordId, targetTableId）与自营发布（source: 'my_published', itemId）；
   * - 绝不使用 any；
   * - 保存编辑仅用于本次发布表单 override，绝不自动反向修改飞书表格；
   * - 执行完成后任务进入 waiting_confirmation 状态，生成一次性提交令牌，绝不自动调用发布提交！
   */
  async createAndFillTask(override?: PublishItemOverride): Promise<PublishTask | null> {
    if (!this.api) return null
    const s = this.state
    const draft = s.editingDraft
    const product = s.selectedProduct

    if (!draft && !product) {
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

    const targetSeq = this.draftSeq

    try {
      // 1. 使用统一 pure 函数计算最终发布内容（与 preview 完全一致，支持前后缀与加价运算）
      const itemToCompute = draft ?? product
      const finalItem = computeFinalPublishItem(itemToCompute, s.customRule)

      // 2. 组装 override（无 undefined 键；支持手动编辑与计算后的最终值）
      const finalOverride = buildPublishOverride(
        finalItem,
        draft?.title || product?.title,
        draft?.desc,
      )
      // 显式传入的 override 作为补充，逐键合并且剔除 undefined
      if (override) {
        for (const [key, value] of Object.entries(override)) {
          if (value !== undefined) {
            ;(finalOverride as Record<string, unknown>)[key] = value
          }
        }
      }

      // 3. 按 source 构造严格 typed 的 PUBLISH_CREATE 请求契约：绝不写入 undefined 可选键
      // 后端 override 本次只传最终计算值，不双加；rule 传空避免后台双重加价或前后缀吞并
      const isFeishu = draft?.source === 'feishu'
      const createPayload = buildPublishCreatePayload(
        {
          source: isFeishu ? 'feishu' : 'my_published',
          recordId: isFeishu ? draft?.recordId : undefined,
          targetTableId: isFeishu ? draft?.targetTableId : undefined,
          itemId: isFeishu ? (draft?.itemId || undefined) : (draft?.itemId || product?.itemId || ''),
        },
        finalOverride,
      )

      // 发起真实 PUBLISH_CREATE
      const createRes = await this.api.call(CommandTypes.PUBLISH_CREATE, createPayload)
      // Draft Guard 校验：若在途期间草稿已发生编辑或切换，旧任务立即丢弃
      if (this.disposed || targetSeq !== this.draftSeq) {
        return null
      }

      const created = createRes.task
      this.patch(this.currentTaskPatch(created))

      // 4. 紧接着发起真实 PUBLISH_FILL_FORM
      const fillRes = await this.api.call(CommandTypes.PUBLISH_FILL_FORM, {
        id: created.id,
      })
      // Draft Guard 校验：若填表在途期间发生编辑，严禁恢复旧任务与旧令牌
      if (this.disposed || targetSeq !== this.draftSeq) {
        return null
      }

      const filledTask = fillRes.task

      this.patch({
        ...this.currentTaskPatch(filledTask),
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
   * 6. 确定性错误（如 SUBMIT_BUTTON_NOT_FOUND / SUBMIT_VERIFY_UNAVAILABLE）未派发点击、未锁定时可提示修正后重新点击，
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

    // 1. 本地防双击与并发锁：任意任务已在提交中即拒绝。
    //    注意：executeConfirmedPublish 串行链路在调用本方法前会把 action.phase 置为 running 以驱动进度展示，
    //    因此重入判定只能以 submittingTaskId 为准，绝不能因链内自身的 running 而自我阻断。
    if (s.submittingTaskId !== null) {
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
      targetTask.result?.submit?.state === 'unknown' ||
      targetTask.result?.submit?.state === 'in_progress'

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

      // 8. 区分 outcome：backend final 结果只会有 submitted 或 unknown（死分支 in_progress 移除）
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
      } else if (businessCode === 'SUBMIT_VERIFY_UNAVAILABLE') {
        // 后台为保证“官方在售商品数严格 +1”的可信验据，在派发点击前就拒绝提交；
        // 属确定性拒绝且未派发点击，明确指引用户恢复能力后可重试。
        errorView.hint =
          '未取得官方「我的商品库」读取能力或基线（未登录 / 无权限 / 商品库读取失败），为保证发布结果可信，已在派发点击前拒绝提交。请确认闲鱼已登录且后台具备商品库读取权限后重试。'
      } else if (
        businessCode === 'CAPTCHA_REQUIRED' ||
        businessCode === 'VERIFICATION_REQUIRED' ||
        String(errObj?.message).includes('验证码')
      ) {
        errorView.hint = '平台出现安全验证码，请在闲鱼网页或客户端完成验证后再进行发布。'
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

  /**
   * 确认发布唯一执行入口：
   * 在 AppModal 显式确认后被调用，冻结当前草稿与目标身份/override，
   * 串行执行 PUBLISH_CREATE → PUBLISH_FILL_FORM → PUBLISH_SUBMIT。
   *
   * 关键安全规范：
   * 1. 唯一显式用户确认入口：用户在 AppModal 点确认直接发布，不再独立分步；
   * 2. 打开弹窗与取消不调用任何写命令（纯前端状态切换，零写操作）；
   * 3. 防双击与并发锁：两次确认仅一链，执行期间拦截并发重入；
   * 4. 确认时冻结编辑草稿与目标身份/override：异步 seq 防草稿漂移，在途发生编辑立即丢弃响应；
   * 5. 旧已有 waiting token 兼容：仅当既有任务与当前冻结草稿「目标身份 + 最终内容」完全一致，
   *    且处于 waiting_confirmation、拥有合法 submitToken 且未尝试提交时，才复用其令牌直接 SUBMIT；
   *    任何不一致（不同素材 / 同素材内容不同）一律忽略并创建新任务，绝不提交旧令牌；
   * 6. 后台 fill.ok 且任务 waiting_confirmation / 合法 submitToken 才 SUBMIT，失败立即中断；
   * 7. 与当前草稿一致的既有任务若 submitAttempted / in_progress / unknown / submitted 绝对不可重提，不自动重试；
   *    无关历史任务不参与锁定，避免误阻当前草稿发布；
   * 8. PUBLISH_CREATE 负载按 source 构造 typed 字段，绝不含 undefined 可选键（codec 严格键白名单）；
   * 9. 遇平台验证码或确定性失败显示 actionable 提示，绝不假成功。
   */
  async executeConfirmedPublish(): Promise<PublishSubmitResult | null> {
    if (!this.api) return null
    const s = this.state

    // 1. 本地防双击与并发锁（两次确认仅一链）
    if (
      this.isPublishingChain ||
      s.submittingTaskId !== null ||
      (s.action.phase === 'running' && s.submittingTaskId !== null)
    ) {
      return null
    }

    // 2. 校验素材与必填字段：无选品、缺字段阻止确认
    const draft = s.editingDraft
    const product = s.selectedProduct
    if (!draft && !product) {
      this.patch({
        action: {
          phase: 'failed',
          error: makeSimpleError('请先选择商品', '需要选择需要发布的商品后方可发布'),
          successMessage: null,
        },
      })
      return null
    }

    const itemToCompute = draft ?? product!
    const frozenFinalItem = computeFinalPublishItem(itemToCompute, s.customRule)
    const isTitleValid = Boolean(frozenFinalItem.title && frozenFinalItem.title.trim())
    const isPriceValid = frozenFinalItem.price > 0
    if (!isTitleValid || !isPriceValid) {
      this.patch({
        action: {
          phase: 'failed',
          error: makeSimpleError(
            '商品信息不完整',
            !isTitleValid ? '商品标题不能为空' : '商品售价必须大于 0',
          ),
          successMessage: null,
        },
      })
      return null
    }

    // 3. 冻结当前代数与目标身份（异步 seq 防草稿漂移）
    const targetSeq = this.draftSeq

    const isFeishu = draft?.source === 'feishu'
    const frozenIdentity: FrozenPublishIdentity = {
      source: isFeishu ? 'feishu' : 'my_published',
      recordId: isFeishu ? draft?.recordId : undefined,
      targetTableId: isFeishu ? draft?.targetTableId : undefined,
      itemId: isFeishu ? (draft?.itemId || undefined) : (draft?.itemId || product?.itemId || ''),
    }

    // 4. 身份完整性校验：飞书需 recordId + targetTableId，自营需真实 itemId，缺字段阻止创建
    if (isFeishu) {
      if (
        !normalizeIdentityId(frozenIdentity.recordId) ||
        !normalizeIdentityId(frozenIdentity.targetTableId)
      ) {
        this.patch({
          action: {
            phase: 'failed',
            error: makeSimpleError('飞书素材信息不完整', '缺少 recordId 或目标表 ID，无法创建发布任务。'),
            successMessage: null,
          },
        })
        return null
      }
    } else if (!normalizeIdentityId(frozenIdentity.itemId)) {
      this.patch({
        action: {
          phase: 'failed',
          error: makeSimpleError('商品缺少有效 ID', '自营发布需要真实 itemId，无法创建发布任务。'),
          successMessage: null,
        },
      })
      return null
    }

    // 5. 冻结最终 override（无 undefined 键），此后进入发布链路，拒绝一切编辑/切素材
    const frozenOverride = buildPublishOverride(
      frozenFinalItem,
      draft?.title || product?.title,
      draft?.desc,
    )
    this.isPublishingChain = true

    try {
      const current = s.currentTask

      // 6. 仅「与当前冻结草稿完全一致」（身份 + 最终内容）的既有任务才算本草稿对应任务；
      //    无关历史任务（不同素材 / 同素材不同内容）一律忽略，下面必然创建新任务，绝不复用其旧令牌。
      const isCurrentMatchingFrozen =
        Boolean(current) &&
        isPublishTaskMatchingFrozen(current as PublishTask, frozenIdentity, frozenFinalItem)

      // 7. 匹配任务的提交锁：submitAttempted / in_progress / unknown / submitted 不可重提
      if (isCurrentMatchingFrozen && current) {
        const isAlreadyAttempted =
          current.meta?.submitAttempted === true ||
          current.result?.submit?.state === 'submitted' ||
          current.result?.submit?.state === 'unknown' ||
          current.result?.submit?.state === 'in_progress'
        if (isAlreadyAttempted) {
          this.patch({
            action: {
              phase: 'failed',
              error: makeSimpleError(
                '该任务已派发过提交',
                '该任务此前已派发过发布提交，后台已锁定。为避免在平台重复发布同一商品，禁止再次发布。',
              ),
              successMessage: null,
            },
          })
          return null
        }
      }

      let taskToSubmit: PublishTask | null = null

      // 8. 旧已有 waiting token 兼容策略：任务需与草稿完全匹配（身份 + 最终内容）、处于
      //    waiting_confirmation、拥有合法 submitToken、未尝试提交，且草稿未被编辑，才复用其令牌直接 SUBMIT。
      const isCurrentTaskReusable =
        isCurrentMatchingFrozen &&
        current !== null &&
        current.status === 'waiting_confirmation' &&
        typeof current.result?.submitToken === 'string' &&
        Boolean(current.result.submitToken.trim()) &&
        current.meta?.submitAttempted !== true &&
        !current.result?.submit &&
        !draft?.isDirty

      if (isCurrentTaskReusable && current) {
        taskToSubmit = current
      } else {
        // 6. 串行第一步：PUBLISH_CREATE
        this.patch({
          action: { phase: 'running', error: null, successMessage: '正在准备发布任务...' },
        })

        // 按 source 构造 typed 负载：绝不写入 undefined 可选键（codec 严格键白名单）
        const createPayload = buildPublishCreatePayload(frozenIdentity, frozenOverride)

        const createRes = await this.api.call(CommandTypes.PUBLISH_CREATE, createPayload)
        // 异步 seq 防草稿漂移
        if (this.disposed || targetSeq !== this.draftSeq) {
          return null
        }

        const created = createRes?.task
        if (!created || !created.id) {
          throw new Error('创建发布任务失败：未返回有效任务')
        }
        this.patch(this.currentTaskPatch(created))

        // 7. 串行第二步：PUBLISH_FILL_FORM
        this.patch({
          action: { phase: 'running', error: null, successMessage: '正在自动填充发布表单...' },
        })

        const fillRes = (await this.api.call(CommandTypes.PUBLISH_FILL_FORM, {
          id: created.id,
        })) as {
          task?: PublishTask
          ok?: boolean
          error?: unknown
          code?: string
        }
        // 异步 seq 防草稿漂移
        if (this.disposed || targetSeq !== this.draftSeq) {
          return null
        }

        const filled = fillRes?.task
        // 后台 fill.ok 且任务 waiting_confirmation / 合法 submitToken 才 SUBMIT，失败中断
        const isFillOk =
          fillRes?.ok !== false &&
          filled &&
          filled.status === 'waiting_confirmation'
        const hasValidToken =
          typeof filled?.result?.submitToken === 'string' &&
          Boolean(filled.result.submitToken.trim())

        if (!isFillOk || !hasValidToken) {
          const fillErr =
            fillRes?.error ||
            filled?.error ||
            '表单填充未就绪或未生成有效提交令牌'
          const errView = toErrorView(fillErr)
          if (
            String(fillErr).includes('验证码') ||
            fillRes?.code === 'CAPTCHA_REQUIRED'
          ) {
            errView.hint = '表单填充遇到安全验证码，请在闲鱼端核实。'
          }
          this.patch({
            ...this.currentTaskPatch(filled ?? created),
            action: {
              phase: 'failed',
              error: errView,
              successMessage: null,
            },
          })
          return null
        }

        this.patch(this.currentTaskPatch(filled))
        taskToSubmit = filled
      }

      // 8. 串行第三步：PUBLISH_SUBMIT
      this.patch({
        action: { phase: 'running', error: null, successMessage: '表单已就绪，正在提交发布...' },
      })

      const submitRes = await this.submitPublish(taskToSubmit.id)
      return submitRes
    } catch (err: unknown) {
      // 官方 root guard 阻断（分类不支持 / 描述含 emoji）：给出可行动提示，绝不自动换分类 / 绕过 / 重试。
      const errView = toErrorView(err)
      const businessCode = (err as { businessCode?: string } | null)?.businessCode
      const errMessage = String((err as { message?: string } | null)?.message ?? '')
      if (businessCode === 'PUBLISH_CATEGORY_UNSUPPORTED') {
        errView.hint =
          '官方发布页提示“当前分类不支持网页端发布”，无法通过网页端发布。请更换为支持网页端发布的分类 / 素材后重试；系统不会自动切换分类，也不会自动重试。'
      } else if (errMessage.includes('emoji') || errMessage.includes('表情')) {
        errView.hint =
          '官方表单校验提示描述含 emoji。标题 / 描述已在发布前自动清理表情符号（保留中文、数字与标点），请核对素材后重新发布。'
      }
      this.patch({
        action: {
          phase: 'failed',
          error: errView,
          successMessage: null,
        },
      })
      return null
    } finally {
      this.isPublishingChain = false
    }
  }
}
