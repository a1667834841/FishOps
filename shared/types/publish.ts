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
 * 配送（邮费）状态
 * - free: 包邮 / 免费配送（映射邮费 0，勾选发布页“包邮”）；
 * - paid: 需收取邮费（必须显式给出金额，绝不伪造）；
 * - unspecified: 明确为不包邮但未提供邮费金额 —— 需用户行动（补齐 postFee 或改为包邮），
 *   **绝不伪造一个收费金额替用户做决定**。
 */
export type PublishShippingStatus = 'free' | 'paid' | 'unspecified'

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

  // ---- 配送（邮费）与所在地 ----
  /** 最终邮费（元）。0 表示包邮 / 免费配送；缺省表示未提供配送信息（旧任务）。 */
  postFee?: number
  /** 是否包邮（免费配送）。 */
  freeShip?: boolean
  /**
   * 配送状态：free 包邮 / paid 收费 / unspecified 缺费用需用户行动。
   * 缺省表示未提供配送信息（旧任务，不参与配送校验）。
   */
  shippingStatus?: PublishShippingStatus
  /**
   * 所在地文本。缺省时保留发布页当前账号已有地址；为空表示需用户在页面选择，
   * **绝不自动凭空选择地区**。
   */
  location?: string

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
  /**
   * 显式邮费（元，>= 0）。0 表示包邮；未提供且非包邮时拒绝发布（绝不伪造收费）。
   */
  postFee?: number
  /**
   * 显式是否包邮。true 映射邮费 0；false 表示需收费，此时必须同时提供 `postFee`，
   * 否则结构化拒绝，绝不替用户编造一个收费金额。
   */
  freeShip?: boolean
  /**
   * 所在地文本。缺省时保留发布页当前账号已有地址，绝不伪造；为空则需用户在页面选择。
   */
  location?: string
}

/**
 * 发布素材来源：
 * - my_published: 本地商品库当前账号已发布商品（现存语义）；
 * - feishu: 飞书多维表格当前已配置商品表（飞书素材发布闭环）。
 */
export type PublishSource = 'my_published' | 'feishu'

/**
 * 飞书素材：创建发布任务时冻结的原素材与目标表绑定，供填表阶段复用 / 复验。
 *
 * 冻结原素材避免填表期间飞书内容变化导致「所见非所发」；同时保留 targetTableId
 * 以在填表阶段复验「目标表绑定未漂移」。
 */
export interface PublishFeishuMaterial {
  /** 飞书源记录 ID（真实 identity）。 */
  recordId: string
  /** 创建时绑定的旧商品表或每日采集表 ID，填表前复验其归属。 */
  targetTableId: string
  /** 冻结的原始素材（缺字段已在创建时明确回退并报告）。 */
  material: {
    itemId: string
    title: string
    desc: string
    price: number
    originalPrice: number
    wantCnt: number
    coverUrl: string
    detailUrl: string
    images: string[]
  }
  /** 创建时报告的缺失字段与回退说明。 */
  missingFields: string[]
  warnings: string[]
}

/**
 * 发布任务输入荷载
 */
export interface PublishTaskPayload {
  /**
   * 本地商品 itemId。`source` 为 `'my_published'`（缺省）时必填；
   * `source:'feishu'` 时为可选 —— 素材身份由 `recordId` 承载，绝不伪造本地商品 ID。
   */
  itemId?: string
  /** 素材来源（缺省视为 'my_published'，保持向后兼容）。 */
  source?: PublishSource
  /** 飞书源记录 ID（source 为 'feishu' 时必填）。 */
  recordId?: string
  /** 飞书目标表 ID（source 为 'feishu' 时必填，必须等于当前已配置商品表）。 */
  targetTableId?: string
  /** 临时自定义规则（覆盖默认全局规则） */
  rule?: Partial<PublishRule>
  /** 手动覆盖字段（直接指定最终值） */
  override?: PublishItemOverride
}

/**
 * PUBLISH_CREATE 请求负载（命令契约，与 UI 对齐）。
 *
 * 两种互斥来源：
 * - 本地：`source` 缺省或 `'my_published'`，必须显式 `itemId`；
 * - 飞书：`source === 'feishu'`，必须 `recordId` + `targetTableId`（itemId 可选，为真实「商品ID」时携带）。
 * 目标表由后台复验必须等于当前已配置商品表，不接受任意表。
 */
export interface PublishCreatePayload {
  /** 素材来源：缺省 / `'my_published'` 走本地商品库；`'feishu'` 走已配置飞书商品表。 */
  source?: PublishSource
  /** 本地商品 itemId（source 为 'my_published' / 缺省时必填，禁止偷偷随机选择）。 */
  itemId?: string
  /** 飞书源记录 ID（source 为 'feishu' 时必填）。 */
  recordId?: string
  /** 飞书目标表 ID（source 为 'feishu' 时必填，后台复验须等于当前已配置商品表，防绑定漂移）。 */
  targetTableId?: string
  /** 自定义发布规则覆盖 */
  rule?: Partial<PublishRule>
  /** 手动字段覆盖 */
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
  /**
   * 邮费 / 配送是否已满足：包邮映射 0 或收费额已填入并回读通过。
   * 未涉及配送（旧任务）时为 true；缺省视为 true 以兼容旧数据。
   */
  postFeeFilled?: boolean
  /**
   * 所在地是否已就绪：发布页已有合法地址或用户已选。
   * 未涉及所在地控件（旧版/灰度）时为 true；缺省视为 true 以兼容旧数据。
   */
  locationFilled?: boolean
  /** 发布页当前所在地文本（供编辑层提示“官方默认地址/需选择”） */
  locationValue?: string
  /** 所在地状态：ready 已就绪（官方默认地址）；needs_user_selection 需用户选择 */
  locationStatus?: 'ready' | 'needs_user_selection'
  /** 已确认的配送状态（free 包邮 / paid 收费），未涉及配送时缺省 */
  shippingStatus?: PublishShippingStatus
}

/**
 * 发布提交（最终点击官方发布按钮）的结构化结果状态
 * - submitted: 已确认提交成功。**成功判据必须以官方「我的商品库」真实在售商品数 +1 / 出现新 itemId 为证据**，
 *   绝不能仅凭「URL 离开发布页」判定（误跳转登录页 / 首页同样会离开发布页，但那并不代表发布成功）；
 * - unknown: 已派发点击但结果不可判定（网络超时 / 页面无明确信号 / 官方商品库数量未增 /
 *   缺少官方查询权限或登录态），必须标记为未知且绝不自动重试，交由人工核实。
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
  /**
   * 官方「我的商品库」确认到的新增商品 itemId（仅当在售商品数**严格 +1** 且新商品可信匹配本次发布时写入）。
   * 该 id 必须来自官方只读查询，**绝不使用来源 / 竞品 itemId 冒充**。
   */
  publishedItemId?: string
  /** 提交前官方在售商品数基线（可信验据之一）。 */
  beforeCount?: number
  /** 提交后官方在售商品数（必须严格等于 beforeCount + 1 才可判成功）。 */
  afterCount?: number
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
 * 发布诊断时间线阶段（安全、可复用、可持久化）。
 *
 * 覆盖一次发布从打开干净发布页到官方核验完成的全部关键卡点：
 * - fresh_tab: 为**本次任务专属**新建后台发布页标签（active:false，绝不复用其它任务/页面）；
 * - load: 等待发布页加载完成；
 * - page_check: 登录态 / 验证码等页面状态检查；
 * - fields: 标题 / 描述 / 售价 / 原价 / 配送 / 所在地等字段填充与回读；
 * - images: 图片下载与上传回读（计数限定当前 upload 区）；
 * - form_validation: 表单整体校验与官方可见阻断探测；
 * - baseline: 提交前官方「我的商品库」在售基线快照；
 * - submit_dispatch: 最终发布按钮点击派发（仅用户显式确认链，先 baseline 成功才派发）；
 * - official_verify: 提交后官方在售商品数严格 +1 的轮询核验；
 * - result: 本次任务最终结论。
 */
export type PublishDiagStage =
  | 'fresh_tab'
  | 'load'
  | 'page_check'
  | 'fields'
  | 'images'
  | 'form_validation'
  | 'baseline'
  | 'submit_dispatch'
  | 'official_verify'
  | 'result'

/** 诊断阶段状态：进行中 / 成功 / 失败 / 未知（不可判定）。 */
export type PublishDiagStatus = 'started' | 'ok' | 'failed' | 'unknown'

/**
 * 单条诊断时间线记录（**严格安全**）。
 *
 * 只允许持久化：阶段名、状态、时间戳、耗时、结构化业务码、数值计数与布尔标记。
 * **绝不写入** URL / query / token / cookie / 商品正文（标题 / 描述）/ 收货地址 /
 * 图片原始链接等敏感原文——`code` 仅接受 `^[A-Z][A-Z0-9_]*$` 形态的结构化枚举。
 */
export interface PublishDiagEntry {
  /** 阶段名 */
  stage: PublishDiagStage
  /** 阶段状态 */
  status: PublishDiagStatus
  /** 阶段开始时间戳（epoch ms） */
  startedAt: number
  /** 阶段结束时间戳（epoch ms）；仍进行中时缺省 */
  endedAt?: number
  /** 阶段耗时（ms）；结束时写入 */
  latencyMs?: number
  /** 安全结构化原因码（发布错误码 / 阶段内固定枚举），绝非页面原文 */
  code?: string
  /** 安全数值计数（图片数 / 在售数 / 轮询次数 / 字段数等） */
  counters?: Record<string, number>
  /** 安全布尔标记（loggedIn / captcha / strictPlusOne 等） */
  flags?: Record<string, boolean>
}

/**
 * 发布诊断时间线（持久化在 `task.meta.diagnostics`，可经 PUBLISH_GET 读取）。
 *
 * 长度有界（见 {@link PUBLISH_DIAG_TIMELINE_LIMIT}），累计被丢弃的旧条目数写入 `dropped`，
 * 保证长时间反复重填也不会无限增长；与 `result` 中的敏感原文严格隔离。
 */
export interface PublishDiagnostics {
  /** 结构版本号，便于未来演进 */
  schema: 1
  /** 有序时间线（最旧 → 最新） */
  timeline: PublishDiagEntry[]
  /** 因超出上限被丢弃的旧条目数 */
  dropped: number
  /** 最后一次更新时间戳（epoch ms） */
  updatedAt: number
}

/** 诊断时间线保留的最大条目数（超出丢弃最旧记录并累加 `dropped`）。 */
export const PUBLISH_DIAG_TIMELINE_LIMIT = 64

/**
 * 发布任务元数据
 */
export interface PublishTaskMeta {
  /** 发布素材来源（缺省为 'local'）。 */
  sourceKind?: PublishSource
  /**
   * 飞书素材发布时冻结的原素材与目标表绑定。**绝不写入本地商品库**，
   * 仅用于填表阶段按冻结素材重算 / 复验目标表绑定未漂移。
   */
  feishu?: PublishFeishuMaterial
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
  /**
   * 发布诊断时间线（安全、有界、可复用）。由运行时在各阶段写入，供 PUBLISH_GET 读取，
   * 与 `result` 中的敏感原文（标题 / 地址 / 图片链接 / token）严格隔离。
   */
  diagnostics?: PublishDiagnostics
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
 * - FEISHU_SOURCE_NOT_CONFIGURED: 飞书素材发布但未配置飞书多维表格
 * - FEISHU_RECORD_NOT_FOUND: 飞书源记录不存在（可能被删除或 recordId 失效）
 * - PUBLISH_TARGET_TABLE_MISMATCH: 飞书素材发布目标表与当前已配置商品表不一致（绑定漂移，拒绝）
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
 * - SUBMIT_VERIFY_UNAVAILABLE: 缺少官方商品库读取能力或基线（未登录/无权限），无法在提交后可信核验，\
 *   **在派发点击前直接拒绝**（绝不“先发后 unknown”）
 * - FORM_VALIDATION_FAILED: 提交前表单校验未通过（如邮费为空、所在地为空、官方内联校验提示描述含 emoji），在派发点击前结构化拒绝
 * - PUBLISH_CATEGORY_UNSUPPORTED: 官方发布页当前分类不支持网页端发布（页面 toast / 校验态明确阻断），
 *   在填表阶段即结构化拒绝，绝不复用/切换分类或绕过，交由用户更换素材
 * - SCRIPT_INJECTION_FAILED: 注入脚本执行失败、返回空数组或结果为空
 * - INVALID_PAYLOAD: 请求参数非法
 * - TASK_CANCELLED: 任务已取消
 * - INTERNAL_ERROR: 内部执行异常
 */
export type PublishErrorCode =
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_SOURCE_NOT_ALLOWED'
  | 'FEISHU_SOURCE_NOT_CONFIGURED'
  | 'FEISHU_RECORD_NOT_FOUND'
  | 'PUBLISH_TARGET_TABLE_MISMATCH'
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
  | 'SUBMIT_VERIFY_UNAVAILABLE'
  | 'FORM_VALIDATION_FAILED'
  | 'PUBLISH_CATEGORY_UNSUPPORTED'
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
