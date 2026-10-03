/**
 * 发布中心（Publish Center）核心领域类型与错误定义（P8）。
 *
 * 遵循 FishOps Workbench 规划与安全约束：
 * - 统一 PublishTask / PublishItem / PublishRule 类型定义；
 * - 状态机包含 pending / running / paused / completed / failed / cancelled / waiting_confirmation；
 * - 强化人工确认边界：仅支持表单自动填充并停留在 waiting_confirmation，严格禁止全自动发布提交。
 */

import type { Task, TaskFilter, TaskStatus } from './task'

/**
 * 发布任务流转状态（包含等待人工确认状态）
 */
export type PublishTaskStatus =
  | TaskStatus
  | 'waiting_confirmation'

/**
 * 人工确认状态
 * - unconfirmed: 初始状态，未填充或未到确认阶段
 * - waiting_review: 表单已填充完成，等待人工在页面核对并确认
 * - confirmed: 人工确认无误（或人工已在页面手工点击发布）
 * - rejected: 人工放弃或拒绝本次发布
 */
export type PublishManualConfirmationStatus =
  | 'unconfirmed'
  | 'waiting_review'
  | 'confirmed'
  | 'rejected'

/**
 * 价格计算模式
 * - multiplier: 基于原商品售价进行系数计算（售价 = 原售价 * 系数 + 加价）
 * - fixed: 使用指定固定售价
 * - original: 保持原商品售价
 */
export type PublishPriceMode = 'multiplier' | 'fixed' | 'original'

/**
 * 价格规则配置
 */
export interface PublishPriceRule {
  /** 价格模式，缺省为 'multiplier' */
  mode?: PublishPriceMode
  /** 售价倍数（例如 1.0 为等价，1.2 为加价 20%），缺省 1.0 */
  multiplier?: number
  /** 固定浮动加减价（单位：元，支持正负数），缺省 0 */
  markup?: number
  /** 固定售价（单位：元，当 mode === 'fixed' 时生效） */
  fixedPrice?: number
  /**
   * 划线原价规则配置
   * 旧版默认逻辑：售价 * 5 作为原价划线展示
   */
  originalPriceRule?: {
    mode?: 'multiplier' | 'fixed' | 'keep'
    /** 原价系数，缺省为 5 */
    multiplier?: number
    /** 固定原价（单位：元） */
    fixedPrice?: number
  }
}

/**
 * 文案规则配置
 */
export interface PublishContentRule {
  /** 标题前缀 */
  titlePrefix?: string
  /** 标题后缀 */
  titleSuffix?: string
  /** 标题最大字符数截断（闲鱼一般限制 30/60 字，缺省 60） */
  maxTitleLength?: number
  /** 描述前缀 */
  descPrefix?: string
  /** 描述后缀 */
  descSuffix?: string
  /** 描述最大字符数截断（缺省 1000） */
  maxDescLength?: number
  /** 文本敏感词过滤与替换列表 */
  textReplacements?: Array<{
    pattern: string
    replacement: string
  }>
}

/**
 * 图片规则配置
 */
export interface PublishImageRule {
  /** 最少图片数量（缺省 1） */
  minImages?: number
  /** 最多图片数量（闲鱼上限通常为 9 张，缺省 9） */
  maxImages?: number
  /** 单张图片最大大小字节数（缺省 10MB） */
  maxSizeBytes?: number
  /** 强制要求 HTTPS 协议，非 HTTPS 自动升级或阻断（缺省 true） */
  requireHttps?: boolean
  /** 允许的图片文件扩展名 */
  allowedExtensions?: string[]
}

/**
 * 统一发布规则
 */
export interface PublishRule {
  /** 价格规则 */
  price?: PublishPriceRule
  /** 文案规则 */
  content?: PublishContentRule
  /** 图片规则 */
  image?: PublishImageRule
}

/**
 * 标准化待发布商品实体（PublishItem）
 */
export interface PublishItem {
  /** 来源商品 ID（严禁偷偷随机选择，必须由调用方显式指定） */
  itemId: string
  /** 来源商品原始标题 */
  sourceTitle: string
  /** 来源商品原始售价（元） */
  sourcePrice: number
  /** 来源商品原始划线原价（元） */
  sourceOriginalPrice?: number
  /** 来源商品原始描述 */
  sourceDesc?: string
  /** 来源商品原始图片链接列表 */
  sourceImages: string[]

  // ---- 经规则计算生成的发布字段 ----
  /** 最终发布标题 */
  title: string
  /** 最终发布商品描述 */
  desc: string
  /** 最终售价（元，保留 2 位小数） */
  price: number
  /** 最终售价（分，整型，用于表单适配） */
  priceInCent: number
  /** 最终划线原价（元，保留 2 位小数） */
  originalPrice: number
  /** 最终划线原价（分，整型） */
  originalPriceInCent: number
  /** 主图 URL（第一张，必须为 HTTPS） */
  mainImage: string
  /** 详情图 URL 列表（第二张及以后，必须为 HTTPS） */
  detailImages: string[]
  /** 完整待上传图片列表 */
  allImages: string[]

  /** 人工确认状态 */
  confirmationStatus: PublishManualConfirmationStatus
}

/**
 * 手动覆盖商品字段的入参
 */
export interface PublishItemOverride {
  title?: string
  desc?: string
  price?: number
  originalPrice?: number
  images?: string[]
}

/**
 * 发布任务输入荷载
 */
export interface PublishTaskPayload {
  /** 目标商品 itemId（必填，禁止随机选择） */
  itemId: string
  /** 临时自定义规则（覆盖默认全局规则） */
  rule?: Partial<PublishRule>
  /** 手动覆盖字段（直接指定最终值） */
  override?: PublishItemOverride
}

/**
 * 表单字段填充执行概况
 */
export interface PublishFillSummary {
  /** 标题是否已填充且回读校验通过 */
  titleFilled: boolean
  /** 主图是否成功准备/设置（必须全部图片成功才为 true） */
  mainImageUploaded: boolean
  /** 详情图成功数量 */
  detailImagesCount: number
  /** 描述是否已填充 */
  descFilled: boolean
  /** 价格是否已填充 */
  priceFilled: boolean
  /** 原价是否已填充 */
  origPriceFilled: boolean
}

/**
 * 发布提交（最终点击官方发布按钮）的结构化结果状态
 * - submitted: 已确认提交成功（观察到明确的页面跳转 / 成功信号）；
 * - unknown: 已派发点击但结果不可判定（网络超时 / 页面无明确信号），
 *   必须标记为未知且绝不自动重试，交由人工核实。
 */
export type PublishSubmitOutcome = 'submitted' | 'unknown'

/**
 * 发布提交尝试记录（一次性、可审计、防重复）
 *
 * 该记录一旦写入即表示“本次任务已经派发过一次提交点击”，其后任何再次提交都必须被拒绝，
 * 以避免在网络结果未知时重复发布同一商品。
 */
export interface PublishSubmitRecord {
  /** in_progress: 已派发点击、正在观察结果；submitted: 已确认成功；unknown: 结果未知需人工核实 */
  state: 'in_progress' | 'submitted' | 'unknown'
  /** 发起提交的时间戳 */
  attemptedAt: number
  /** 实际派发点击的时间戳（若未能派发点击则不存在） */
  clickedAt?: number
  /** 目标发布页 tabId */
  tabId?: number
  /** 结果说明 */
  message?: string
}

/**
 * 发布任务执行结果
 */
export interface PublishTaskResult {
  /** 标准化 PublishItem 实体 */
  item: PublishItem
  /** 表单填充完成时间戳 */
  filledAt?: number
  /** 填充所用的 tabId */
  tabId?: number
  /** 发布页面 URL */
  formUrl?: string
  /** 表单字段填充概况 */
  fillSummary?: PublishFillSummary
  /** 人工确认状态 */
  confirmationStatus: PublishManualConfirmationStatus
  /** 人工确认或审查备注 */
  manualConfirmNote?: string
  /**
   * 一次性提交令牌：仅在表单填充完成进入 waiting_confirmation 时生成。
   * 最终提交必须携带该令牌，且令牌在首次派发点击后立即失效，保证幂等与防重放。
   */
  submitToken?: string
  /** 结构化提交尝试记录（绝不自动重试） */
  submit?: PublishSubmitRecord
}

/**
 * 发布任务元数据
 */
export interface PublishTaskMeta {
  /** 关联商品采集快照摘要 */
  sourceProductSnapshot?: {
    itemId: string
    title: string
    price: string
    sellerNick?: string
    capturedAt?: number
  }
  pauseReason?: string
  cancelReason?: string
  recoveryNote?: string
  /** 操作审计历史 */
  history?: Array<{
    timestamp: number
    action: string
    detail?: string
  }>
  [key: string]: unknown
}

/**
 * 强类型发布任务实体
 */
export type PublishTask = Task<
  'publish',
  PublishTaskPayload,
  PublishTaskResult,
  PublishTaskMeta,
  PublishTaskStatus
>

/**
 * 结构化失败分类与错误码
 * - PRODUCT_NOT_FOUND: 商品不存在
 * - PRODUCT_SOURCE_NOT_ALLOWED: 商品来源不是当前账号已确认发布商品（竞品/存量未确认），禁止进入发布流程
 * - TAB_LOAD_FAILED: 发布页标签打开或加载超时/失败
 * - FORM_FIELD_CHANGED: 表单字段变化或找不到目标输入控件
 * - IMAGE_DOWNLOAD_FAILED: 图片下载、转换或 URL 协议非法
 * - NOT_LOGGED_IN: 闲鱼账号未登录
 * - VERIFICATION_REQUIRED: 命中风控验证码或滑块
 * - SUBMIT_DISABLED: 旧的全自动提交禁用标记（保留兼容；现行最终提交改由 PUBLISH_SUBMIT 显式触发）
 * - SUBMIT_NOT_ALLOWED: 任务当前状态不允许提交（未进入 waiting_confirmation 等）
 * - SUBMIT_DUPLICATE: 该任务已派发过一次提交，禁止重复点击
 * - SUBMIT_TOKEN_INVALID: 提交令牌缺失或已失效
 * - SUBMIT_PAGE_INVALID: 目标发布页不存在、非发布页或页面状态已失效
 * - SUBMIT_BUTTON_NOT_FOUND: 发布页上未找到真实发布按钮（绝不猜测点击其它元素）
 * - SUBMIT_BUTTON_DISABLED: 发布按钮处于不可点击状态
 * - SCRIPT_INJECTION_FAILED: 注入脚本执行失败、返回空数组或结果为空
 * - INVALID_PAYLOAD: 请求参数非法
 * - TASK_CANCELLED: 任务已取消
 * - INTERNAL_ERROR: 内部执行异常
 */
export type PublishErrorCode =
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_SOURCE_NOT_ALLOWED'
  | 'TAB_LOAD_FAILED'
  | 'FORM_FIELD_CHANGED'
  | 'IMAGE_DOWNLOAD_FAILED'
  | 'NOT_LOGGED_IN'
  | 'VERIFICATION_REQUIRED'
  | 'SUBMIT_DISABLED'
  | 'SUBMIT_NOT_ALLOWED'
  | 'SUBMIT_DUPLICATE'
  | 'SUBMIT_TOKEN_INVALID'
  | 'SUBMIT_PAGE_INVALID'
  | 'SUBMIT_BUTTON_NOT_FOUND'
  | 'SUBMIT_BUTTON_DISABLED'
  | 'SCRIPT_INJECTION_FAILED'
  | 'INVALID_PAYLOAD'
  | 'TASK_CANCELLED'
  | 'INTERNAL_ERROR'

/**
 * 发布中心专用业务异常
 */
export class PublishError extends Error {
  public readonly code: PublishErrorCode
  /** 是否允许自动重试；不可恢复或风控错误一律为 false */
  public readonly retryable: boolean
  public readonly details?: unknown

  constructor(
    code: PublishErrorCode,
    message: string,
    options?: { retryable?: boolean; details?: unknown },
  ) {
    super(`[PublishError:${code}] ${message}`)
    this.name = 'PublishError'
    this.code = code
    this.retryable = options?.retryable ?? false
    this.details = options?.details
  }
}

/**
 * 发布任务查询过滤条件
 */
export interface PublishTaskListFilter extends TaskFilter {
  /** 按商品 itemId 过滤 */
  itemId?: string
  /** 按人工确认状态过滤 */
  confirmationStatus?: PublishManualConfirmationStatus
  /** 模糊匹配关键词 */
  keyword?: string
  /** 限制数量 */
  limit?: number
  /** 偏移量 */
  offset?: number
  /** 排序字段 */
  sortBy?: 'createdAt' | 'updatedAt'
  /** 排序顺序 */
  sortOrder?: 'asc' | 'desc'
}
