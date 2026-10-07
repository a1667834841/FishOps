/**
 /** 命令定义：Workbench → Extension 的请求负载与结果。 */
import type { ChatMessage, Conversation, MessageCursor, SyncError } from '../types/chat'
import type { Task, TaskStatus, TaskType } from '../types/task'
import type {
  PublishCreatePayload,
  PublishDiagnostics,
  PublishManualConfirmationStatus,
  PublishSubmitOutcome,
  PublishTask,
} from '../types/publish'
import type { Product, ProductOrder, ProductSource } from '../types/product'
import type {
  CapturePayload,
  CaptureSuggestWordsPayload,
  CaptureSuggestWordsResult,
  TaskListSortBy,
  TaskListSortOrder,
} from '../types/capture'
import type {
  AiPauseStatus,
  ReplyGlobalConfig,
  ReplyRule,
  ReplySuggestionResult,
  SendMessageResult,
  AutoReplyStatus,
} from '../types/reply'
import type { Dataset, DatasetFilter, DatasetSchema } from '../types/dataset'
import type { AnalysisPayload, AnalysisResult, PromptRule } from '../types/analysis'
import type {
  FeishuProductWriteExecutePayload,
  FeishuProductWriteExecuteResult,
  FeishuProductWritePreviewPayload,
  FeishuProductWritePreviewResult,
} from '../types/feishu-write'
import type {
  FeishuProductSchemaReconcileExecutePayload,
  FeishuProductSchemaReconcileExecuteResult,
  FeishuProductSchemaReconcilePreviewPayload,
  FeishuProductSchemaReconcilePreviewResult,
} from '../types/feishu-schema-reconcile'
import type {
  FeishuProductGetPayload,
  FeishuProductGetResult,
  FeishuProductsPagePayload,
  FeishuProductsPageResult,
} from '../types/feishu-products'
import type {
  ProductCatalogQueryPayload,
  ProductCatalogQueryResult,
} from '../types/product-catalog'
import type {
  LegacyConfigPreview,
  LegacyConfigMigrationResult,
  MigrateLegacyConfigPayload,
  MigrateLegacyConfigResult,
} from '../types/legacy-migration'
import {
  type AiConfigSetPayload,
  type AiConfigStatus,
  type AiConfigTestResult,
  type FeishuConfigSetPayload,
  type FeishuConfigStatus,
  type SafeAiOriginResult,
  extractSafeAiOrigin,
} from '../types/config-setup'
import type { PlatformErrorCategory } from './protocol'

/** 命令类型常量。 */
export const CommandTypes = {
  /** 独立文件备份的状态、立即保存和合并恢复。 */
  DATA_BACKUP_STATUS: 'DATA_BACKUP_STATUS',
  DATA_BACKUP_SAVE: 'DATA_BACKUP_SAVE',
  DATA_BACKUP_RESTORE: 'DATA_BACKUP_RESTORE',
  /** 连通性探测，用于验证 Workbench ↔ Extension 链路。 */
  PING: 'PING',
  /** 声明订阅的事件类型（页面侧通道使用；扩展内页走长连接 Port）。 */
  SUBSCRIBE: 'SUBSCRIBE',
  /** 取消订阅。 */
  UNSUBSCRIBE: 'UNSUBSCRIBE',
  /** 发布事件，由 background 广播给订阅者。 */
  PUBLISH: 'PUBLISH',
  /**
   * 调用 MAIN world 平台 host 的一个方法（P3）。
   * method 为平台方法名，background 侧会做白名单校验后再经 chrome.scripting 调用。
   */
  PLATFORM_CALL: 'PLATFORM_CALL',
  /** 探测 MAIN world 平台 host 是否已就绪（P3）。 */
  PLATFORM_PING: 'PLATFORM_PING',
  /** 查询聊天只读层状态（socket 连接状态、会话/消息计数）（P5）。 */
  CHAT_STATUS: 'CHAT_STATUS',
  /** 列出本地已缓存的会话（P5）。 */
  CHAT_LIST_CONVERSATIONS: 'CHAT_LIST_CONVERSATIONS',
  /** 读取某会话的本地缓存消息（P5）。 */
  CHAT_GET_MESSAGES: 'CHAT_GET_MESSAGES',
  /** 拉取某会话的历史消息（只读 LWP，经 MAIN world 已建立连接）（P5）。 */
  CHAT_SYNC_HISTORY: 'CHAT_SYNC_HISTORY',
  /** 拉取会话列表（只读 LWP）（P5）。 */
  CHAT_SYNC_CONVERSATIONS: 'CHAT_SYNC_CONVERSATIONS',
  /** 对单个会话的指定服务端消息确认已读（受控平台写操作）。 */
  CHAT_MARK_READ: 'CHAT_MARK_READ',
  /**
   * 由 goofish 页面的 MAIN world 上报的原始 WebSocket 事件（P5 只读）。
   * 该命令**只接受来自 goofish content script 的来源**，Workbench 不应发送。
   */
  CHAT_SOCKET_EVENT: 'CHAT_SOCKET_EVENT',
  // ---------------- 采集与任务中心（P4） ----------------
  /** 创建并启动一个采集任务。 */
  CAPTURE_CREATE: 'CAPTURE_CREATE',
  /** 暂停采集任务。 */
  CAPTURE_PAUSE: 'CAPTURE_PAUSE',
  /** 恢复（断点续采）采集任务。 */
  CAPTURE_RESUME: 'CAPTURE_RESUME',
  /** 取消采集任务。 */
  CAPTURE_CANCEL: 'CAPTURE_CANCEL',
  /** 查询单个采集任务。 */
  CAPTURE_GET: 'CAPTURE_GET',
  /** 查询闲鱼搜索流量词（suggest）：**仅查询建议词，不创建采集任务、不搜索商品**。 */
  CAPTURE_SUGGEST_WORDS: 'CAPTURE_SUGGEST_WORDS',
  /** 列出任务（任务中心历史列表：过滤 / 排序 / limit）。 */
  TASK_LIST: 'TASK_LIST',
  /** 列出商品库（商品表格）。 */
  PRODUCT_LIST: 'PRODUCT_LIST',
  // ---------------- 聊天发送与 AI（P6） ----------------
  /** 显式发送一条文本消息（唯一发送入口，绝不隐式发送）。 */
  CHAT_SEND_MESSAGE: 'CHAT_SEND_MESSAGE',
  /** 生成一条回复建议（关键词或 AI），**不发送**。 */
  CHAT_GET_REPLY_SUGGESTION: 'CHAT_GET_REPLY_SUGGESTION',
  /** 采用（或修改后）建议并真正发送。 */
  CHAT_APPLY_REPLY: 'CHAT_APPLY_REPLY',
  /** 查询自动回复状态（开关、模式、暂停、计数）。 */
  CHAT_AUTO_REPLY_STATUS: 'CHAT_AUTO_REPLY_STATUS',
  /** 读取回复规则与全局配置。 */
  CHAT_RULES_GET: 'CHAT_RULES_GET',
  /** 写入回复规则与全局配置（规则整表替换 + 全局部分更新）。 */
  CHAT_RULES_SET: 'CHAT_RULES_SET',
  /** 手动暂停 / 恢复 AI 自动回复。 */
  CHAT_AI_PAUSE_SET: 'CHAT_AI_PAUSE_SET',
  // ---------------- 旧扩展配置迁移（安全，显式触发） ----------------
  /**
   * 迁移旧扩展 AI / 飞书配置。**仅在用户显式调用时执行**，background 启动不自动读取。
   * 默认（未 confirm）只做 dry-run 预览，返回存在性而不返回值。
   */
  MIGRATE_LEGACY_CONFIG: 'MIGRATE_LEGACY_CONFIG',
  // ---------------- 手动配置（AI / 飞书，专用写入通道） ----------------
  /**
   * 手动保存 AI 配置（apiKey / baseUrl / model / timeoutMs）。
   * PATCH 语义：只更新负载中出现的字段；密钥只落专用键，**绝不回显**。
   */
  AI_CONFIG_SET: 'AI_CONFIG_SET',
  /** 读取 AI 配置状态（只回 configured / provider / model / timeoutMs）。 */
  AI_CONFIG_STATUS: 'AI_CONFIG_STATUS',
  /**
   * 测试当前 AI 配置连通性：后台用已保存的 apiKey / baseUrl / model / timeoutMs
   * 调用一次真实文本接口（固定探测 prompt，不带聊天 / 商品 / 图片上下文）。
   * 负载必须为空对象；只回测量指标，**绝不回传探测正文 / key / 完整 URL / 响应 body**。
   */
  AI_CONFIG_TEST: 'AI_CONFIG_TEST',
  /**
   * 手动保存飞书配置（appId / appSecret / spreadsheetToken / productTableId / sellerTableId）。
   * PATCH 语义：合并后必需字段不完整则拒绝写入；密钥只落专用键，**绝不回显**。
   */
  FEISHU_CONFIG_SET: 'FEISHU_CONFIG_SET',
  /** 读取飞书配置状态（只回各成员是否存在，不回明文）。 */
  FEISHU_CONFIG_STATUS: 'FEISHU_CONFIG_STATUS',
  // ---------------- 运行时自动准备（P8） ----------------
  /**
   * 查询闲鱼运行时就绪状态（后台 tab / host / WebSocket / 用户 ID 是否就绪）。
   * 只读：不创建 tab、不发消息、不读写聊天内容。
   */
  RUNTIME_STATUS: 'RUNTIME_STATUS',
  /**
   * 准备闲鱼运行时：优先复用已打开的 goofish tab，缺失时以 `active:false` 后台创建，
   * 并等待页面 host / WebSocket / 当前用户 ID 就绪。**只准备，不发送任何消息**。
   */
  CHAT_RUNTIME_PREPARE: 'CHAT_RUNTIME_PREPARE',
  // ---------------- 数据源与分析（P7） ----------------
  /** 列出可用数据源。 */
  DATA_SOURCE_LIST: 'DATA_SOURCE_LIST',
  /** 获取指定数据源 Schema。 */
  DATA_SOURCE_SCHEMA: 'DATA_SOURCE_SCHEMA',
  /** 查询数据源。 */
  DATA_SOURCE_QUERY: 'DATA_SOURCE_QUERY',
  /** 列出提示词规则。 */
  PROMPT_RULE_LIST: 'PROMPT_RULE_LIST',
  /** 创建或更新提示词规则。 */
  PROMPT_RULE_UPSERT: 'PROMPT_RULE_UPSERT',
  /** 删除提示词规则。 */
  PROMPT_RULE_DELETE: 'PROMPT_RULE_DELETE',
  /** 创建并启动分析任务。 */
  ANALYSIS_CREATE: 'ANALYSIS_CREATE',
  /** 查询分析任务。 */
  ANALYSIS_GET: 'ANALYSIS_GET',
  /** 取消分析任务。 */
  ANALYSIS_CANCEL: 'ANALYSIS_CANCEL',
  /** 获取分析结果。 */
  ANALYSIS_RESULT_GET: 'ANALYSIS_RESULT_GET',
  // ---------------- 飞书商品写入（P7 后台，预览 / 执行分离） ----------------
  /**
   * 预览飞书商品写入：输入显式 itemIds，**只读**（读字段与已有记录），绝不写入。
   * 目标表固定为已配置商品表，不接受任意 tableId。
   */
  FEISHU_PRODUCT_WRITE_PREVIEW: 'FEISHU_PRODUCT_WRITE_PREVIEW',
  /**
   * 执行飞书商品写入：必须显式 `confirm: true`；去重 / 限量 / 串行保护，
   * 仅寫已配置商品表，**不自动创建 / 修改飞书字段**。
   */
  FEISHU_PRODUCT_WRITE_EXECUTE: 'FEISHU_PRODUCT_WRITE_EXECUTE',
  // ---------------- 飞书表字段同步（P7 后台，schema reconciliation） ----------------
  /**
   * 预览飞书表字段与本地商品库字段的 schema 一致性（**只读**）：目标为**并集**，
   * 返回需创建的缺失字段、同名类型冲突与仅飞书存在字段；绝不写入 / 创建 / 删除字段。
   * 目标表固定为已配置商品表，不接受任意 tableId。
   */
  FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW: 'FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW',
  /**
   * 执行飞书表字段同步：必须显式 `confirm: true`；仅**创建缺失字段**（幂等），
   * 同名类型冲突需显式 `acceptTypeConflicts: true` 且绝不自动覆盖，**绝不删除字段**。
   */
  FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE: 'FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE',
  // ---------------- 飞书商品库分页浏览 / 单条读取（P7 商品库） ----------------
  /**
   * 分页读取飞书商品表：**真实单次请求**（默认每页 20 条），关键词 / 排序由飞书 search API 服务端过滤，
   * **绝不本地全量拉取或全表过滤**；目标表固定为已配置商品表（不接受任意 tableId），结果不含任何密钥。
   * 本命令只做分页浏览，**不改变** DATA_SOURCE_QUERY 的批量分析语义。
   */
  FEISHU_PRODUCTS_PAGE: 'FEISHU_PRODUCTS_PAGE',
  /**
   * 读取飞书商品表**单条**真实记录并映射为可编辑发布素材：缺字段时明确回退（title / cover）并报告，
   * 绝不伪造 ID；目标表固定为已配置商品表（不接受任意 tableId），结果不含任何密钥。
   */
  FEISHU_PRODUCT_GET: 'FEISHU_PRODUCT_GET',
  // ---------------- 商品目录统一查询（P7 商品库） ----------------
  /**
   * 商品目录查询：`source: 'feishu'`（复用飞书专用分页读取）/ `'my_published'`
   * （当前账号官方「我的商品库」在售，经 MAIN world 平台桥接读取 + 按需详情补齐）；
   * 支持关键词 / 排序 / 分页 / `forceRefresh`。本命令**不改变** `PRODUCT_LIST`（本地商品库）语义。
   * 只读；结果不含任何密钥；`my_published` 读取失败报错而非空列表，详情部分失败进 `warnings`。
   */
  PRODUCT_CATALOG_QUERY: 'PRODUCT_CATALOG_QUERY',
  // ---------------- 发布中心（P8） ----------------
  /** 创建发布任务（从指定 itemId 获取商品，严格校验入参，禁止随机偷选）。 */
  PUBLISH_CREATE: 'PUBLISH_CREATE',
  /** 列出发布任务。 */
  PUBLISH_LIST: 'PUBLISH_LIST',
  /** 查询指定发布任务。 */
  PUBLISH_GET: 'PUBLISH_GET',
  /** 准备图片并在发布页后台 Tab 中自动填充表单（执行到 waiting_confirmation 即停，严禁提交）。 */
  PUBLISH_FILL_FORM: 'PUBLISH_FILL_FORM',
  /** 取消发布任务。 */
  PUBLISH_CANCEL: 'PUBLISH_CANCEL',
  /** 暂停发布任务。 */
  PUBLISH_PAUSE: 'PUBLISH_PAUSE',
  /** 恢复发布任务。 */
  PUBLISH_RESUME: 'PUBLISH_RESUME',
  /** 查看或记录人工确认状态（只读或记录确认标记，绝不自动提交发布）。 */
  PUBLISH_CONFIRM_STATUS: 'PUBLISH_CONFIRM_STATUS',
  /**
   * 最终提交发布（仅由用户在工作台明确点击一次“发布”时发送）。
   * 严禁任务创建/填表自动调用；仅对 waiting_confirmation 任务、携带一次性令牌、
   * 且页面状态仍有效时执行一次真实提交，未知结果绝不自动重试。
   */
  PUBLISH_SUBMIT: 'PUBLISH_SUBMIT',
} as const

export type CommandType = (typeof CommandTypes)[keyof typeof CommandTypes]

/** PING 请求负载。 */
export interface PingPayload {
  /** 调用方时间戳，回程原样带回，便于计算往返时延。 */
  clientTime: number
  /** 调用方生成的唯一串，防止响应串号。 */
  nonce: string
}

/** PING 响应结果（即 PONG）。 */
export interface PingResult {
  pong: true
  /** 回显 nonce。 */
  nonce: string
  /** background 自本次浏览器会话启动以来处理过的 PING 次数（持久化，不随 service worker 回收丢失）。 */
  pingCount: number
  /** background service worker 本次实例的启动时间。 */
  workerStartedAt: number
  /** background 当前时间，便于粗略校时。 */
  serverTime: number
}

/** SUBSCRIBE 请求负载。 */
export interface SubscribePayload {
  events: string[]
}

/** SUBSCRIBE 结果。 */
export interface SubscribeResult {
  /** background 确认已订阅的事件类型。 */
  subscribed: string[]
}

/** UNSUBSCRIBE 请求负载。 */
export interface UnsubscribePayload {
  events: string[]
}

/** UNSUBSCRIBE 结果。 */
export interface UnsubscribeResult {
  /** 退订后仍保留的事件类型。 */
  subscribed: string[]
}

/** PUBLISH 请求负载。 */
export interface PublishPayload {
  /** 要发布的事件类型。 */
  event: string
  /** 事件负载，原样广播。 */
  payload: unknown
}

/** PUBLISH 结果。 */
export interface PublishResult {
  /** 实际收到该事件的订阅者数量。 */
  delivered: number
}

/** PLATFORM_CALL 请求负载。 */
export interface PlatformCallPayload {
  /** 平台方法名（如 `platform.search`）；background 侧会校验是否在白名单内。 */
  method: string
  /** 方法参数，结构随 method 而定；由平台层负责校验，非法时返回 PLATFORM_ERROR。 */
  params: unknown
}

/** PLATFORM_PING 请求负载（无参数，约定为空对象）。 */
export type PlatformPingPayload = Record<string, never>

/** PLATFORM_PING 结果（与平台层 PingResult 对齐）。 */
export interface PlatformPingResult {
  pong: true
  /** 标识响应来自 MAIN world host。 */
  host: 'main-world'
  /** host 当前时间，便于粗略校时。 */
  now: number
}

// ---------------- 聊天只读层（P5） ----------------

/** WebSocket 上报事件的原始文本上限（256 KiB），防止异常大帧拖垮 background。 */
export const CHAT_SOCKET_MAX_RAW_LENGTH = 262144

/** CHAT_STATUS 请求负载（无参数，约定为空对象）。 */
export type ChatStatusPayload = Record<string, never>

/** CHAT_LIST_CONVERSATIONS 请求负载（无参数）。 */
export type ChatListConversationsPayload = Record<string, never>

/** CHAT_GET_MESSAGES 请求负载。 */
export interface ChatGetMessagesPayload {
  /** 会话 ID（已去掉 `@goofish` 后缀）。 */
  sessionId: string
  /** 返回顺序：`asc`（默认，时间线）或 `desc`（最新在前）。 */
  order?: 'asc' | 'desc'
  /** 最多返回条数。 */
  limit?: number
  /**
   * 向前分页边界：只返回**严格早于**该游标的消息。
   *
   * 配合 `order: 'desc' | 'asc'` + `limit` 即可取「某游标之前最近的一页」；
   * 不传时保持原有语义（从最早/最新的一端取 `limit` 条）。
   */
  before?: MessageCursor
}

/** CHAT_SYNC_HISTORY 请求负载。 */
export interface ChatSyncHistoryPayload {
  sessionId: string
  /** 最多拉取页数。 */
  pages?: number
  /** 每页条数。 */
  count?: number
  /**
   * 服务端历史游标：从该游标继续向更早翻页。
   *
   * 不传时从最新一页开始（保持既有行为）；调用方可用上一次结果的
   * `nextCursor` 递进，避免每次都从头拉取。
   */
  cursor?: number
}

/** CHAT_MARK_READ 请求负载；只接受规范化会话 ID 和服务端 messageId。 */
export interface ChatMarkReadPayload {
  sessionId: string
}

/** CHAT_MARK_READ 结果。 */
export interface ChatMarkReadResult {
  ok: boolean
  error?: SyncError
}

/** CHAT_SYNC_CONVERSATIONS 请求负载。 */
export interface ChatSyncConversationsPayload {
  /** 最多拉取页数。 */
  pages?: number
  /** 每页条数。 */
  pageSize?: number
}

/** 聊天 WebSocket 事件名。 */
export type ChatSocketEventName = 'message' | 'open' | 'close' | 'error'

/**
 * CHAT_SOCKET_EVENT 负载（goofish MAIN world → background）。
 * 仅 message 事件携带 `raw` 原始文本，且长度受 {@link CHAT_SOCKET_MAX_RAW_LENGTH} 限制；
 * 该负载只用于内存内解析，background 不会把它写日志或透传给 Workbench。
 */
export interface ChatSocketEventPayload {
  event: ChatSocketEventName
  /** 原始 WebSocket 文本（仅 message）；超限会被拒绝。 */
  raw?: string
  /** close 事件的 code。 */
  code?: number
  /** close 事件的 reason（可能被截断）。 */
  reason?: string
  /** 事件发生时间（毫秒时间戳）。 */
  at: number
}

/** CHAT_STATUS 结果。 */
export interface ChatStatusResult {
  socketStatus: 'connecting' | 'open' | 'closed' | 'error'
  sessionCount: number
  messageCount: number
}

/** CHAT_LIST_CONVERSATIONS 结果。 */
export interface ChatListConversationsResult {
  conversations: Conversation[]
}

/** CHAT_GET_MESSAGES 结果。 */
export interface ChatGetMessagesResult {
  messages: ChatMessage[]
  /**
   * 是否还存在比本页更早的消息。
   *
   * 仅在请求携带 `limit` 时有意义：为 `true` 表示本地缓存里本页之前仍有数据。
   * 可选字段，未携带 `limit` 的旧调用方不受影响。
   */
  hasMore?: boolean
}

/**
 * 同步结果（历史 / 会话共用）。
 *
 * 注意：`ok` 描述的是**本次同步业务是否成功**。命令本身只要被正常处理，
 * ResponseEnvelope 的 `ok` 仍可为 `true`，客户端应读取 `result.ok` 判断业务结果，
 * 并可用 `result.error` 展示结构化失败原因（不泄露凭据 / 聊天正文）。
 */
export interface ChatSyncResultDto {
  ok: boolean
  added: number
  updated: number
  error?: SyncError
  /**
   * 下一次向更早翻页应使用的服务端游标；`hasMore` 为 `false` 或同步失败时缺省。
   */
  nextCursor?: number
  /** 服务端是否还存在更早的历史（本次成功后仍可继续翻页）。 */
  hasMore?: boolean
}

/** CHAT_SOCKET_EVENT 结果。 */
export interface ChatSocketEventResult {
  accepted: boolean
}

// ---------------- 采集与任务中心（P4） ----------------

/** CAPTURE_CREATE 请求负载（即采集入参）。 */
export type CaptureCreatePayload = CapturePayload

/** CAPTURE_PAUSE / RESUME / CANCEL 请求负载。 */
export interface CaptureTaskRefPayload {
  /** 任务 ID。 */
  id: string
  /** 可选原因（暂停 / 取消时记录）。 */
  reason?: string
}

/** CAPTURE_GET 请求负载。 */
export interface CaptureGetPayload {
  id: string
}

/** TASK_LIST 请求负载。 */
export interface TaskListPayload {
  /** 按任务类型筛选。 */
  type?: TaskType
  /** 按状态筛选（单值）。 */
  status?: TaskStatus
  /** 关键词模糊过滤（匹配采集任务 `payload.keyword`，大小写不敏感）。 */
  keyword?: string
  /** 排序字段，默认 `createdAt`。 */
  sortBy?: TaskListSortBy
  /** 排序方向，默认 `desc`。 */
  sortOrder?: TaskListSortOrder
  /** 最多返回条数。 */
  limit?: number
}

/** CAPTURE_SUGGEST_WORDS 请求负载。 */
export type CaptureSuggestWordsCommandPayload = CaptureSuggestWordsPayload

/** CAPTURE_SUGGEST_WORDS 结果。 */
export type CaptureSuggestWordsCommandResult = CaptureSuggestWordsResult

/** PRODUCT_LIST 请求负载。 */
export interface ProductListPayload {
  keyword?: string
  limit?: number
  offset?: number
  order?: ProductOrder
  /** 来源筛选：'my_published' (当前账号发布商品) | 'captured_search' | 'legacy_unconfirmed' | 'all' */
  source?: ProductSource | 'all'
  /** 状态筛选（可选） */
  status?: string
}

/** 采集 / 任务命令结果：返回任务快照。 */
export interface CaptureTaskResult {
  task: Task
}

/** TASK_LIST 结果。 */
export interface TaskListResult {
  tasks: Task[]
}

/** PRODUCT_LIST 结果。 */
export interface ProductListResult {
  products: Product[]
  total: number
}

// ---------------- 聊天发送与 AI（P6） ----------------

/** CHAT_SEND_MESSAGE 请求负载：显式发送一条文本消息。 */
export interface ChatSendMessagePayload {
  /** 会话 ID（已去掉 `@goofish` 后缀）。 */
  sessionId: string
  /** 对方用户 ID（消息接收者）。 */
  receiverId: string
  /** 消息正文。 */
  content: string
  /** 可选：关联商品 ID（仅诊断用，不参与协议）。 */
  itemId?: string
  /** 覆盖默认发送超时（毫秒）。 */
  timeoutMs?: number
}

/** CHAT_GET_REPLY_SUGGESTION 请求负载。 */
export interface ChatGetReplySuggestionPayload {
  sessionId: string
  /** 指定用于生成建议的消息；缺省取该会话最新一条对方消息。 */
  messageId?: string
  /** 是否遵循 AI 暂停（用户显式请求建议时通常传 false）。缺省 true。 */
  respectPause?: boolean
  /** 是否允许携带图片（多模态）。缺省 true；无图片时自动退化为纯文本。 */
  includeImages?: boolean
}

/** CHAT_APPLY_REPLY 请求负载：采用（或修改后）建议并发送。 */
export interface ChatApplyReplyPayload {
  sessionId: string
  /** 实际要发送的正文（可为建议原文或人工修改后文本）。 */
  content: string
  /** 对方用户 ID；缺省时由 background 从会话消息推断。 */
  receiverId?: string
  /** 可选：来源消息 ID，用于防重 / 冷却记账。 */
  messageId?: string
  /** 可选：来源规则 ID，用于规则级冷却记账。 */
  ruleId?: string
}

/** CHAT_AI_PAUSE_SET 请求负载：手动暂停 / 恢复自动回复。 */
export interface ChatAiPauseSetPayload {
  /** true 表示暂停，false 表示恢复。 */
  paused: boolean
  /** 暂停时长（毫秒）；缺省使用全局配置。 */
  durationMs?: number
  /** 暂停原因（仅用于状态展示，不含敏感信息）。 */
  reason?: string
}

/** CHAT_RULES_SET 请求负载（规则整表替换 + 全局配置部分更新）。 */
export interface ChatRulesSetPayload {
  /** 全局配置增量；缺省表示不改。 */
  global?: Partial<ReplyGlobalConfig>
  /** 规则整表；缺省表示不改。传 `[]` 表示清空。 */
  rules?: ReplyRule[]
}

/** CHAT_RULES_GET 结果 / CHAT_RULES_SET 结果。 */
export interface ChatRulesResult {
  global: ReplyGlobalConfig
  rules: ReplyRule[]
}

/** CHAT_SEND_MESSAGE / CHAT_APPLY_REPLY 结果。 */
export type ChatSendResult = SendMessageResult

/** CHAT_GET_REPLY_SUGGESTION 结果。 */
export type ChatGetReplySuggestionResult = ReplySuggestionResult

/** CHAT_AUTO_REPLY_STATUS 结果。 */
export type ChatAutoReplyStatusResult = AutoReplyStatus

/** CHAT_AI_PAUSE_SET 结果。 */
export type ChatAiPauseSetResult = AiPauseStatus

// ---------------- 旧扩展配置迁移（安全，显式触发） ----------------

/**
 * MIGRATE_LEGACY_CONFIG 请求负载。
 *
 * 契约：
 * - 缺省 / `dryRun:true` / 未 `confirm` → 仅预览（返回有哪些配置存在，不返回值）；
 * - `confirm:true` → 执行写入；已有新配置的目标默认跳过；
 * - `confirm:true && overwrite:true` → 覆盖已有新配置（二次确认）。
 */
export type MigrateLegacyConfigCommandPayload = MigrateLegacyConfigPayload

/** MIGRATE_LEGACY_CONFIG 结果（mode 区分预览 / 已应用）。 */
export type MigrateLegacyConfigCommandResult = MigrateLegacyConfigResult

/** 重新导出迁移领域类型，方便 Workbench 直接引用。 */
export type { LegacyConfigPreview, LegacyConfigMigrationResult }

// ---------------- 手动配置（AI / 飞书，专用写入通道） ----------------

/** AI_CONFIG_SET 请求负载。 */
export type AiConfigSetCommandPayload = AiConfigSetPayload

/** AI_CONFIG_SET / AI_CONFIG_STATUS 结果（只含非敏感状态）。 */
export type AiConfigCommandResult = AiConfigStatus

/** FEISHU_CONFIG_SET 请求负载。 */
export type FeishuConfigSetCommandPayload = FeishuConfigSetPayload

/** FEISHU_CONFIG_SET / FEISHU_CONFIG_STATUS 结果（只含存在性，不回显明文）。 */
export type FeishuConfigCommandResult = FeishuConfigStatus

/** 重新导出配置领域类型与安全工具函数，方便 Workbench 与扩展直接引用。 */
export type {
  AiConfigSetPayload,
  AiConfigStatus,
  AiConfigTestResult,
  FeishuConfigSetPayload,
  FeishuConfigStatus,
  SafeAiOriginResult,
}
export { extractSafeAiOrigin }

// ---------------- 运行时自动准备（P8） ----------------

/** 聊天 WebSocket 连接状态（与 P5 `ChatSocketStatus` 同构）。 */
export type RuntimeSocketStatus = 'connecting' | 'open' | 'closed' | 'error'

/** 运行时准备用途：聊天发送 / 平台调用（决定目标页面与等待策略）。 */
export type RuntimePurpose = 'chat' | 'platform'

/** RUNTIME_STATUS 请求负载（空对象）。 */
export type RuntimeStatusPayload = Record<string, never>

/** CHAT_RUNTIME_PREPARE 请求负载。 */
export interface ChatRuntimePreparePayload {
  /** 准备用途，缺省 `chat`。 */
  purpose?: RuntimePurpose
  /** 是否强制刷新已缓存的当前用户 ID（显式准备时通常为 true，允许重试失败）。 */
  force?: boolean
}

/** 运行时结构化错误（不含任何凭据；category 决定 UI 引导文案）。 */
export interface RuntimeErrorInfo {
  category: PlatformErrorCategory
  message: string
}

/** RUNTIME_STATUS 结果（只读快照）。 */
export interface RuntimeStatusResult {
  /** 是否存在可用的 goofish tab（含后台创建的）。 */
  tabOpen: boolean
  /** tab 是否已加载完成且确认为 goofish 页面。 */
  tabReady: boolean
  /** 页面 MAIN world host 是否已就绪（platform.ping 成功）。 */
  hostReady: boolean
  /** WebSocket 连接状态（由页面只读上报）。 */
  socketStatus: RuntimeSocketStatus
  /** 当前用户 ID 是否已就绪（只回布尔，**绝不输出用户 ID 值**）。 */
  userIdReady: boolean
  /** 最近一次运行时就绪失败（若有）。 */
  lastError?: RuntimeErrorInfo
}

/** CHAT_RUNTIME_PREPARE 结果。 */
export interface ChatRuntimePrepareResult {
  /** 是否已准备好发送（host + 用户 ID 就绪）。 */
  ok: boolean
  /** 目标 tab id；未创建时为 null。 */
  tabId: number | null
  /** 本次是否新建了后台 tab。 */
  tabCreated: boolean
  /**
   * 页面 MAIN world host 是否就绪（真实 platform.ping 成功）。
   * 只代表平台层可用，**不代表** WebSocket 已 open。
   */
  platformReady: boolean
  /** WebSocket 是否已在等待窗口内变为 open（best-effort，且只在真实上报后为真）。 */
  socketReady: boolean
  socketStatus: RuntimeSocketStatus
  /** 当前用户 ID 是否就绪。 */
  userIdReady: boolean
  /** 失败时的结构化原因。 */
  error?: RuntimeErrorInfo
}

// ---------------- 数据源与分析（P7） ----------------

/** DATA_SOURCE_LIST 请求负载（空对象）。 */
export type DataSourceListPayload = Record<string, never>

/** DATA_SOURCE_LIST 结果。 */
export interface DataSourceListResult {
  dataSources: Array<{
    type: string
    name: string
    description?: string
  }>
}

/** DATA_SOURCE_SCHEMA 请求负载。 */
export interface DataSourceSchemaPayload {
  type: string
}

/** DATA_SOURCE_SCHEMA 结果。 */
export interface DataSourceSchemaResult {
  schema: DatasetSchema
}

/** DATA_SOURCE_QUERY 请求负载。 */
export interface DataSourceQueryPayload {
  type: string
  filter?: DatasetFilter
  params?: Record<string, unknown>
}

/** DATA_SOURCE_QUERY 结果。 */
export interface DataSourceQueryResult {
  dataset: Dataset
}

/** PROMPT_RULE_LIST 请求负载（空对象）。 */
export type PromptRuleListPayload = Record<string, never>

/** PROMPT_RULE_LIST 结果。 */
export interface PromptRuleListResult {
  rules: PromptRule[]
}

/** PROMPT_RULE_UPSERT 请求负载。 */
export interface PromptRuleUpsertPayload {
  rule: PromptRule
}

/** PROMPT_RULE_UPSERT 结果。 */
export interface PromptRuleUpsertResult {
  rule: PromptRule
}

/** PROMPT_RULE_DELETE 请求负载。 */
export interface PromptRuleDeletePayload {
  id: string
}

/** PROMPT_RULE_DELETE 结果。 */
export interface PromptRuleDeleteResult {
  success: boolean
}

/** ANALYSIS_CREATE 请求负载。 */
export type AnalysisCreatePayload = AnalysisPayload

/** ANALYSIS_CREATE 结果。 */
export interface AnalysisCreateResult {
  task: Task
}

/** ANALYSIS_GET 请求负载。 */
export interface AnalysisGetPayload {
  id: string
}

/** ANALYSIS_GET 结果。 */
export interface AnalysisGetResult {
  task: Task
}

/** ANALYSIS_CANCEL 请求负载。 */
export interface AnalysisCancelPayload {
  id: string
  reason?: string
}

/** ANALYSIS_CANCEL 结果。 */
export interface AnalysisCancelResult {
  task: Task
}

/** ANALYSIS_RESULT_GET 请求负载。 */
export interface AnalysisResultGetPayload {
  id: string
}

/** ANALYSIS_RESULT_GET 结果。 */
export interface AnalysisResultGetResult {
  result?: AnalysisResult
}

// ---------------- 飞书商品写入（P7 后台） 负载与结果 ----------------

/** FEISHU_PRODUCT_WRITE_PREVIEW 请求负载（只读预览）。 */
export type FeishuProductWritePreviewCommandPayload = FeishuProductWritePreviewPayload

/** FEISHU_PRODUCT_WRITE_PREVIEW 结果（结构化，非敏感）。 */
export type FeishuProductWritePreviewCommandResult = FeishuProductWritePreviewResult

/** FEISHU_PRODUCT_WRITE_EXECUTE 请求负载（显式 confirm）。 */
export type FeishuProductWriteExecuteCommandPayload = FeishuProductWriteExecutePayload

/** FEISHU_PRODUCT_WRITE_EXECUTE 结果（结构化，非敏感）。 */
export type FeishuProductWriteExecuteCommandResult = FeishuProductWriteExecuteResult

/** 重新导出飞书商品写入领域类型，方便 Workbench 直接引用。 */
export type {
  FeishuProductWritePreviewPayload,
  FeishuProductWritePreviewResult,
  FeishuProductWritePreviewItem,
  FeishuProductWriteExecutePayload,
  FeishuProductWriteExecuteResult,
  FeishuProductWriteFieldTypeConflict,
  FeishuWriteFailureCategory,
} from '../types/feishu-write'

// ---------------- 飞书表字段同步（P7 后台） 负载与结果 ----------------

/** FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW 请求负载（只读，空负载）。 */
export type FeishuProductSchemaReconcilePreviewCommandPayload = FeishuProductSchemaReconcilePreviewPayload

/** FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW 结果（结构化，非敏感）。 */
export type FeishuProductSchemaReconcilePreviewCommandResult = FeishuProductSchemaReconcilePreviewResult

/** FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE 请求负载（显式 confirm）。 */
export type FeishuProductSchemaReconcileExecuteCommandPayload = FeishuProductSchemaReconcileExecutePayload

/** FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE 结果（结构化，非敏感）。 */
export type FeishuProductSchemaReconcileExecuteCommandResult = FeishuProductSchemaReconcileExecuteResult

/** 重新导出飞书表字段同步领域类型，方便 Workbench 直接引用。 */
export type {
  FeishuProductSchemaReconcilePreviewPayload,
  FeishuProductSchemaReconcilePreviewResult,
  FeishuSchemaReconcileFieldSpec,
  FeishuProductSchemaReconcileExecutePayload,
  FeishuProductSchemaReconcileExecuteResult,
  FeishuSchemaReconcileFailureCategory,
} from '../types/feishu-schema-reconcile'

// ---------------- 发布中心（P8） 负载与结果 ----------------

/** 重新导出 PUBLISH_CREATE 请求负载（命令契约主体定义于 shared/types/publish）。 */
export type { PublishCreatePayload } from '../types/publish'

/** PUBLISH_CREATE 结果 */
export interface PublishCreateResult {
  task: PublishTask
}

/** PUBLISH_LIST 请求负载 */
export interface PublishListPayload {
  status?: TaskStatus | TaskStatus[]
  itemId?: string
  confirmationStatus?: PublishManualConfirmationStatus
  keyword?: string
  limit?: number
  offset?: number
  sortBy?: 'createdAt' | 'updatedAt'
  sortOrder?: 'asc' | 'desc'
}

/** PUBLISH_LIST 结果 */
export interface PublishListResult {
  tasks: PublishTask[]
  total: number
}

/** PUBLISH_GET 请求负载 */
export interface PublishGetPayload {
  id: string
}

/** PUBLISH_GET 结果 */
export interface PublishGetResult {
  task: PublishTask
  /**
   * 可选：从 `task.meta.diagnostics` 提取的发布诊断时间线（安全、有界），
   * 便于 UI 无需额外路由即可直接渲染时间线。缺省表示该任务尚无诊断记录。
   */
  diag?: PublishDiagnostics
}

/** PUBLISH_FILL_FORM 请求负载 */
export interface PublishFillFormPayload {
  id: string
}

/** PUBLISH_FILL_FORM 结果 */
export interface PublishFillFormResult {
  task: PublishTask
}

/** PUBLISH_CANCEL 请求负载 */
export interface PublishCancelPayload {
  id: string
  reason?: string
}

/** PUBLISH_CANCEL 结果 */
export interface PublishCancelResult {
  task: PublishTask
}

/** PUBLISH_PAUSE 请求负载 */
export interface PublishPausePayload {
  id: string
  reason?: string
}

/** PUBLISH_PAUSE 结果 */
export interface PublishPauseResult {
  task: PublishTask
}

/** PUBLISH_RESUME 请求负载 */
export interface PublishResumePayload {
  id: string
}

/** PUBLISH_RESUME 结果 */
export interface PublishResumeResult {
  task: PublishTask
}

/** PUBLISH_CONFIRM_STATUS 请求负载 */
export interface PublishConfirmStatusPayload {
  id: string
  /** 可选记录人工确认或拒绝动作（只记录状态，绝不触发提交发布） */
  confirmationStatus?: 'confirmed' | 'rejected'
  note?: string
}

/** PUBLISH_CONFIRM_STATUS 结果 */
export interface PublishConfirmStatusResult {
  id: string
  confirmationStatus: PublishManualConfirmationStatus
  note?: string
  task?: PublishTask
}

/**
 * PUBLISH_SUBMIT 请求负载（用户在工作台明确点击一次“发布”时发送）。
 *
 * 该命令是唯一允许触发最终提交的入口，必须同时满足：
 * - 显式用户动作（工作台按钮）；`confirm` 必须为字面 `true`；
 * - 携带由 PUBLISH_FILL_FORM 下发的一次性 `submitToken`。
 */
export interface PublishSubmitPayload {
  /** 目标发布任务 ID */
  id: string
  /** 一次性提交令牌（进入 waiting_confirmation 时下发，点击后立即失效） */
  submitToken: string
  /** 显式确认字面量 true，防止误触发 */
  confirm: true
}

/** PUBLISH_SUBMIT 结果 */
export interface PublishSubmitResult {
  id: string
  /** 结构化提交结果：submitted 已确认成功；unknown 结果未知且绝不自动重试 */
  outcome: PublishSubmitOutcome
  /** 结果是否确定（submitted=true；unknown=false） */
  deterministic: boolean
  /** 提交后的最新任务快照 */
  task: PublishTask
  /** 目标发布页 tabId */
  tabId?: number
  /**
   * 官方「我的商品库」确认到的新增商品 itemId（仅 outcome === 'submitted' 且以官方在售商品数**严格 +1** 为证据时携带）。
   */
  newItemId?: string
  /** 提交前官方在售商品数基线（仅成功时携带，供 UI 展示可信验据）。 */
  beforeCount?: number
  /** 提交后官方在售商品数（仅成功时携带；必须等于 beforeCount + 1）。 */
  afterCount?: number
  /** 结果说明 */
  message: string
}

// ---------------- 飞书商品库分页浏览 / 单条读取（P7） 负载与结果 ----------------

/** 重新导出飞书商品分页浏览 / 单条读取领域类型，方便 Workbench 直接引用。 */
export type {
  FeishuProductsPagePayload,
  FeishuProductsPageResult,
  FeishuProductGetPayload,
  FeishuProductGetResult,
  FeishuProductMaterial,
  FeishuProductRow,
  FeishuProductsOrder,
} from '../types/feishu-products'

/** FEISHU_PRODUCTS_PAGE 请求负载。 */
export type FeishuProductsPageCommandPayload = FeishuProductsPagePayload

/** FEISHU_PRODUCTS_PAGE 结果。 */
export type FeishuProductsPageCommandResult = FeishuProductsPageResult

/** FEISHU_PRODUCT_GET 请求负载。 */
export type FeishuProductGetCommandPayload = FeishuProductGetPayload

/** FEISHU_PRODUCT_GET 结果。 */
export type FeishuProductGetCommandResult = FeishuProductGetResult

// ---------------- 商品目录统一查询（P7） 负载与结果 ----------------

/** PRODUCT_CATALOG_QUERY 请求负载。 */
export type ProductCatalogQueryCommandPayload = ProductCatalogQueryPayload

/** PRODUCT_CATALOG_QUERY 结果。 */
export type ProductCatalogQueryCommandResult = ProductCatalogQueryResult

/** 商品目录统一商品模型、来源与查询类型（供 Workbench 直接引用）。 */
export type {
  CatalogProduct,
  ProductCatalogQueryPayload,
  ProductCatalogQueryResult,
  ProductCatalogSource,
} from '../types/product-catalog'

/** 商品目录查询相关的运行时常量。 */
export {
  PRODUCT_CATALOG_DEFAULT_PAGE_SIZE,
  PRODUCT_CATALOG_MAX_PAGE_SIZE,
  PRODUCT_CATALOG_KEYWORD_MAX_LENGTH,
  PRODUCT_CATALOG_CURSOR_MAX_LENGTH,
} from '../types/product-catalog'

/** 命令 → 负载 映射。 */
export interface CommandPayloadMap {
  [CommandTypes.DATA_BACKUP_STATUS]: Record<string, never>
  [CommandTypes.DATA_BACKUP_SAVE]: Record<string, never>
  [CommandTypes.DATA_BACKUP_RESTORE]: { content: string }
  [CommandTypes.PING]: PingPayload
  [CommandTypes.SUBSCRIBE]: SubscribePayload
  [CommandTypes.UNSUBSCRIBE]: UnsubscribePayload
  [CommandTypes.PUBLISH]: PublishPayload
  [CommandTypes.PLATFORM_CALL]: PlatformCallPayload
  [CommandTypes.PLATFORM_PING]: PlatformPingPayload
  [CommandTypes.CHAT_STATUS]: ChatStatusPayload
  [CommandTypes.CHAT_LIST_CONVERSATIONS]: ChatListConversationsPayload
  [CommandTypes.CHAT_GET_MESSAGES]: ChatGetMessagesPayload
  [CommandTypes.CHAT_SYNC_HISTORY]: ChatSyncHistoryPayload
  [CommandTypes.CHAT_SYNC_CONVERSATIONS]: ChatSyncConversationsPayload
  [CommandTypes.CHAT_MARK_READ]: ChatMarkReadPayload
  [CommandTypes.CHAT_SOCKET_EVENT]: ChatSocketEventPayload
  [CommandTypes.CAPTURE_CREATE]: CaptureCreatePayload
  [CommandTypes.CAPTURE_PAUSE]: CaptureTaskRefPayload
  [CommandTypes.CAPTURE_RESUME]: CaptureTaskRefPayload
  [CommandTypes.CAPTURE_CANCEL]: CaptureTaskRefPayload
  [CommandTypes.CAPTURE_GET]: CaptureGetPayload
  [CommandTypes.CAPTURE_SUGGEST_WORDS]: CaptureSuggestWordsCommandPayload
  [CommandTypes.TASK_LIST]: TaskListPayload
  [CommandTypes.PRODUCT_LIST]: ProductListPayload
  [CommandTypes.CHAT_SEND_MESSAGE]: ChatSendMessagePayload
  [CommandTypes.CHAT_GET_REPLY_SUGGESTION]: ChatGetReplySuggestionPayload
  [CommandTypes.CHAT_APPLY_REPLY]: ChatApplyReplyPayload
  [CommandTypes.CHAT_AUTO_REPLY_STATUS]: Record<string, never>
  [CommandTypes.CHAT_RULES_GET]: Record<string, never>
  [CommandTypes.CHAT_RULES_SET]: ChatRulesSetPayload
  [CommandTypes.CHAT_AI_PAUSE_SET]: ChatAiPauseSetPayload
  [CommandTypes.MIGRATE_LEGACY_CONFIG]: MigrateLegacyConfigPayload
  [CommandTypes.AI_CONFIG_SET]: AiConfigSetPayload
  [CommandTypes.AI_CONFIG_STATUS]: Record<string, never>
  [CommandTypes.AI_CONFIG_TEST]: Record<string, never>
  [CommandTypes.FEISHU_CONFIG_SET]: FeishuConfigSetPayload
  [CommandTypes.FEISHU_CONFIG_STATUS]: Record<string, never>
  [CommandTypes.RUNTIME_STATUS]: RuntimeStatusPayload
  [CommandTypes.CHAT_RUNTIME_PREPARE]: ChatRuntimePreparePayload
  [CommandTypes.DATA_SOURCE_LIST]: DataSourceListPayload
  [CommandTypes.DATA_SOURCE_SCHEMA]: DataSourceSchemaPayload
  [CommandTypes.DATA_SOURCE_QUERY]: DataSourceQueryPayload
  [CommandTypes.PROMPT_RULE_LIST]: PromptRuleListPayload
  [CommandTypes.PROMPT_RULE_UPSERT]: PromptRuleUpsertPayload
  [CommandTypes.PROMPT_RULE_DELETE]: PromptRuleDeletePayload
  [CommandTypes.ANALYSIS_CREATE]: AnalysisCreatePayload
  [CommandTypes.ANALYSIS_GET]: AnalysisGetPayload
  [CommandTypes.ANALYSIS_CANCEL]: AnalysisCancelPayload
  [CommandTypes.ANALYSIS_RESULT_GET]: AnalysisResultGetPayload
  [CommandTypes.FEISHU_PRODUCT_WRITE_PREVIEW]: FeishuProductWritePreviewCommandPayload
  [CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE]: FeishuProductWriteExecuteCommandPayload
  [CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW]: FeishuProductSchemaReconcilePreviewCommandPayload
  [CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE]: FeishuProductSchemaReconcileExecuteCommandPayload
  [CommandTypes.FEISHU_PRODUCTS_PAGE]: FeishuProductsPageCommandPayload
  [CommandTypes.FEISHU_PRODUCT_GET]: FeishuProductGetCommandPayload
  [CommandTypes.PRODUCT_CATALOG_QUERY]: ProductCatalogQueryCommandPayload
  [CommandTypes.PUBLISH_CREATE]: PublishCreatePayload
  [CommandTypes.PUBLISH_LIST]: PublishListPayload
  [CommandTypes.PUBLISH_GET]: PublishGetPayload
  [CommandTypes.PUBLISH_FILL_FORM]: PublishFillFormPayload
  [CommandTypes.PUBLISH_CANCEL]: PublishCancelPayload
  [CommandTypes.PUBLISH_PAUSE]: PublishPausePayload
  [CommandTypes.PUBLISH_RESUME]: PublishResumePayload
  [CommandTypes.PUBLISH_CONFIRM_STATUS]: PublishConfirmStatusPayload
  [CommandTypes.PUBLISH_SUBMIT]: PublishSubmitPayload
}

/** 命令 → 结果 映射。 */
export interface CommandResultMap {
  [CommandTypes.DATA_BACKUP_STATUS]: import('../persistence/backup-status').BackupStatus
  [CommandTypes.DATA_BACKUP_SAVE]: import('../persistence/backup-status').BackupStatus
  [CommandTypes.DATA_BACKUP_RESTORE]: { products: number; tasks: number }
  [CommandTypes.PING]: PingResult
  [CommandTypes.SUBSCRIBE]: SubscribeResult
  [CommandTypes.UNSUBSCRIBE]: UnsubscribeResult
  [CommandTypes.PUBLISH]: PublishResult
  [CommandTypes.PLATFORM_CALL]: unknown
  [CommandTypes.PLATFORM_PING]: PlatformPingResult
  [CommandTypes.CHAT_STATUS]: ChatStatusResult
  [CommandTypes.CHAT_LIST_CONVERSATIONS]: ChatListConversationsResult
  [CommandTypes.CHAT_GET_MESSAGES]: ChatGetMessagesResult
  [CommandTypes.CHAT_SYNC_HISTORY]: ChatSyncResultDto
  [CommandTypes.CHAT_SYNC_CONVERSATIONS]: ChatSyncResultDto
  [CommandTypes.CHAT_MARK_READ]: ChatMarkReadResult
  [CommandTypes.CHAT_SOCKET_EVENT]: ChatSocketEventResult
  [CommandTypes.CAPTURE_CREATE]: CaptureTaskResult
  [CommandTypes.CAPTURE_PAUSE]: CaptureTaskResult
  [CommandTypes.CAPTURE_RESUME]: CaptureTaskResult
  [CommandTypes.CAPTURE_CANCEL]: CaptureTaskResult
  [CommandTypes.CAPTURE_GET]: CaptureTaskResult
  [CommandTypes.CAPTURE_SUGGEST_WORDS]: CaptureSuggestWordsCommandResult
  [CommandTypes.TASK_LIST]: TaskListResult
  [CommandTypes.PRODUCT_LIST]: ProductListResult
  [CommandTypes.CHAT_SEND_MESSAGE]: ChatSendResult
  [CommandTypes.CHAT_GET_REPLY_SUGGESTION]: ChatGetReplySuggestionResult
  [CommandTypes.CHAT_APPLY_REPLY]: ChatSendResult
  [CommandTypes.CHAT_AUTO_REPLY_STATUS]: ChatAutoReplyStatusResult
  [CommandTypes.CHAT_RULES_GET]: ChatRulesResult
  [CommandTypes.CHAT_RULES_SET]: ChatRulesResult
  [CommandTypes.CHAT_AI_PAUSE_SET]: ChatAiPauseSetResult
  [CommandTypes.MIGRATE_LEGACY_CONFIG]: MigrateLegacyConfigCommandResult
  [CommandTypes.AI_CONFIG_SET]: AiConfigStatus
  [CommandTypes.AI_CONFIG_STATUS]: AiConfigStatus
  [CommandTypes.AI_CONFIG_TEST]: AiConfigTestResult
  [CommandTypes.FEISHU_CONFIG_SET]: FeishuConfigStatus
  [CommandTypes.FEISHU_CONFIG_STATUS]: FeishuConfigStatus
  [CommandTypes.RUNTIME_STATUS]: RuntimeStatusResult
  [CommandTypes.CHAT_RUNTIME_PREPARE]: ChatRuntimePrepareResult
  [CommandTypes.DATA_SOURCE_LIST]: DataSourceListResult
  [CommandTypes.DATA_SOURCE_SCHEMA]: DataSourceSchemaResult
  [CommandTypes.DATA_SOURCE_QUERY]: DataSourceQueryResult
  [CommandTypes.PROMPT_RULE_LIST]: PromptRuleListResult
  [CommandTypes.PROMPT_RULE_UPSERT]: PromptRuleUpsertResult
  [CommandTypes.PROMPT_RULE_DELETE]: PromptRuleDeleteResult
  [CommandTypes.ANALYSIS_CREATE]: AnalysisCreateResult
  [CommandTypes.ANALYSIS_GET]: AnalysisGetResult
  [CommandTypes.ANALYSIS_CANCEL]: AnalysisCancelResult
  [CommandTypes.ANALYSIS_RESULT_GET]: AnalysisResultGetResult
  [CommandTypes.FEISHU_PRODUCT_WRITE_PREVIEW]: FeishuProductWritePreviewCommandResult
  [CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE]: FeishuProductWriteExecuteCommandResult
  [CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW]: FeishuProductSchemaReconcilePreviewCommandResult
  [CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE]: FeishuProductSchemaReconcileExecuteCommandResult
  [CommandTypes.FEISHU_PRODUCTS_PAGE]: FeishuProductsPageCommandResult
  [CommandTypes.FEISHU_PRODUCT_GET]: FeishuProductGetCommandResult
  [CommandTypes.PRODUCT_CATALOG_QUERY]: ProductCatalogQueryCommandResult
  [CommandTypes.PUBLISH_CREATE]: PublishCreateResult
  [CommandTypes.PUBLISH_LIST]: PublishListResult
  [CommandTypes.PUBLISH_GET]: PublishGetResult
  [CommandTypes.PUBLISH_FILL_FORM]: PublishFillFormResult
  [CommandTypes.PUBLISH_CANCEL]: PublishCancelResult
  [CommandTypes.PUBLISH_PAUSE]: PublishPauseResult
  [CommandTypes.PUBLISH_RESUME]: PublishResumeResult
  [CommandTypes.PUBLISH_CONFIRM_STATUS]: PublishConfirmStatusResult
  [CommandTypes.PUBLISH_SUBMIT]: PublishSubmitResult
}
