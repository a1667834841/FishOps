/**
 * Workbench 使用的后台数据契约统一出口。
 *
 * 原则：不在 Workbench 重复定义后台类型。
 * - 命令负载 / 结果 / 事件类型一律从 `@fishops/shared` 取；
 * - `@fishops/shared` 只导出 events 协议，领域类型（Product / Task / ReplyRule / PromptRule 等）
 *   与少量运行时常量、校验函数直接从 monorepo 的 `shared/` 源码按相对路径引用（只读，不修改 shared）。
 * 集中在这一个文件，后续 shared 目录调整时只需改这里。
 */
import type { CommandPayloadMap, CommandResultMap, EventPayloadMap } from '@fishops/shared'

// ---------------- 领域类型（仅类型，构建时会被擦除） ----------------
export type { Product, ProductOrder, ProductSource, ProductStatus } from '../../../shared/types/product'
export type { Task, TaskStatus } from '../../../shared/types/task'
export type {
  CapturePayload,
  CaptureFilter,
  CaptureCheckpoint,
  CaptureResult,
  CaptureStats,
  CaptureSuggestWordsPayload,
  CaptureSuggestWordsResult,
  TaskListSortBy,
  TaskListSortOrder,
} from '../../../shared/types/capture'
export {
  CAPTURE_LIMITS as SHARED_CAPTURE_LIMITS,
  emptyCaptureStats,
} from '../../../shared/types/capture'
export type {
  AiReplyRule,
  AutoReplyStatus,
  KeywordReplyRule,
  ReplyGlobalConfig,
  ReplyMode,
  ReplyRule,
  ReplySuggestion,
  ReplySuggestionResult,
  SendMessageErrorCode,
  SendMessageResult,
} from '../../../shared/types/reply'
export type {
  AnalysisPayload,
  AnalysisResult,
  AnalysisStructuredOutput,
  PromptRule,
} from '../../../shared/types/analysis'
export type {
  Dataset,
  DatasetFieldSchema,
  DatasetFilter,
  DatasetRow,
  DatasetSchema,
} from '../../../shared/types/dataset'
export type {
  PublishContentRule,
  PublishCreatePayload,
  PublishDiagEntry,
  PublishDiagnostics,
  PublishDiagStage,
  PublishDiagStatus,
  PublishErrorCode,
  PublishFillSummary,
  PublishImageRule,
  PublishItem,
  PublishItemOverride,
  PublishManualConfirmationStatus,
  PublishPriceRule,
  PublishRule,
  PublishSource,
  PublishSubmitOutcome,
  PublishSubmitRecord,
  PublishTask,
  PublishTaskMeta,
  PublishTaskPayload,
  PublishTaskResult,
  PublishTaskListFilter,
  PublishTaskStatus,
} from '../../../shared/types/publish'
// 诊断时间线保留上限（与后台 diagnostics 记录器共用同一常量，避免 UI 侧自造数字）。
export { PUBLISH_DIAG_TIMELINE_LIMIT } from '../../../shared/types/publish'
export type {
  FeishuProductsOrder,
  FeishuProductsPageResult,
  FeishuProductGetPayload,
  FeishuProductGetResult,
  FeishuProductMaterial,
} from '../../../shared/types/feishu-products'
export type {
  CatalogProduct,
  ProductCatalogQueryPayload,
  ProductCatalogQueryResult,
  ProductCatalogSource,
} from '../../../shared/types/product-catalog'
export {
  PRODUCT_CATALOG_DEFAULT_PAGE_SIZE,
  PRODUCT_CATALOG_MAX_PAGE_SIZE,
} from '../../../shared/types/product-catalog'
import type { FeishuProductsPagePayload as SharedFeishuProductsPagePayload } from '../../../shared/types/feishu-products'

/** 飞书商品分页请求负载（扩展支持后续翻页传递 state 绑定的 targetTableId，首请求缺省） */
export interface FeishuProductsPagePayload extends SharedFeishuProductsPagePayload {
  targetTableId?: string
}

// ---------------- 运行时常量与校验（与后台共用同一份实现） ----------------
export {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_REPLY_GLOBAL_CONFIG,
  MAX_SEND_CONTENT_LENGTH,
  REPLY_LIMITS,
} from '../../../shared/types/reply'
export type {
  LegacyConfigTransfer,
  MigrateLegacyConfigPayload,
  MigrateLegacyConfigResult,
} from '../../../shared/types/legacy-migration'
export type { FeishuConfig } from '../../../shared/data-source/feishu-types'
export type {
  AiConfigSetPayload,
  AiConfigStatus,
  FeishuConfigSetPayload,
  FeishuConfigStatus,
  SafeAiOriginResult,
} from '../../../shared/types/config-setup'
export { extractSafeAiOrigin } from '../../../shared/types/config-setup'
export { DATASET_DEFAULT_LIMIT, DATASET_MAX_LIMIT } from '../../../shared/types/dataset'
export type {
  FeishuProductWritePreviewPayload,
  FeishuProductWritePreviewResult,
  FeishuProductWritePreviewItem,
  FeishuProductWriteExecutePayload,
  FeishuProductWriteExecuteResult,
  FeishuWriteFailureCategory,
  FeishuProductWriteFieldTypeConflict,
} from '../../../shared/types/feishu-write'
export {
  FEISHU_WRITE_MAX_ITEMS,
  FEISHU_WRITE_MAX_ITEM_ID_LENGTH,
  FEISHU_WRITE_MAX_PREVIEW_ID_LENGTH,
  FEISHU_WRITE_PREVIEW_TTL_MS,
} from '../../../shared/types/feishu-write'
export type {
  FeishuProductSchemaReconcilePreviewPayload,
  FeishuProductSchemaReconcilePreviewResult,
  FeishuProductSchemaReconcileExecutePayload,
  FeishuProductSchemaReconcileExecuteResult,
  FeishuSchemaReconcileFieldSpec,
  FeishuSchemaReconcileFailureCategory,
} from '../../../shared/types/feishu-schema-reconcile'
export {
  FEISHU_SCHEMA_RECONCILE_MAX_PREVIEW_ID_LENGTH,
  FEISHU_SCHEMA_RECONCILE_PREVIEW_TTL_MS,
} from '../../../shared/types/feishu-schema-reconcile'
export {
  FEISHU_SCHEMA_RECONCILE_STRATEGY,
  type FeishuSchemaReconcileStrategy,
  type FeishuSchemaApiCapability,
} from '../../../shared/data-source/feishu-schema-reconcile'
export { isCompilablePattern, isReplyRule } from '../../../shared/reply/validate'
export {
  ALLOWED_TEMPLATE_VARIABLES,
  extractTemplateVariables,
  validateNoSecrets,
  validatePromptRule,
} from '../../../shared/analysis/prompt-rule-validator'

// ---------------- 由命令结果反推的便捷类型 ----------------
export type TaskChangedEvent = EventPayloadMap['TASK_CHANGED']
export type ChatRulesResult = CommandResultMap['CHAT_RULES_GET']
export type DataSourceInfo = CommandResultMap['DATA_SOURCE_LIST']['dataSources'][number]
export type PublishGetResult = CommandResultMap['PUBLISH_GET']
export type PublishSubmitPayload = CommandPayloadMap['PUBLISH_SUBMIT']
export type PublishSubmitResult = CommandResultMap['PUBLISH_SUBMIT']
