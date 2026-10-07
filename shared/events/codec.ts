/**
 * 协议消息的运行时校验、序列化与工厂函数。
 *
 * 不依赖任何第三方库，保证 background service worker 与页面端都可直接使用；
 * 所有校验函数在非法输入时返回 false / null，而不是抛错。
 */
import {
  PROTOCOL_VERSION,
  type BridgeMessage,
  type CommandEnvelope,
  type EventEnvelope,
  type ProtocolError,
  type RequestId,
  type ResponseEnvelope,
  type SubscribeMessage,
} from './protocol'
import type {
  CommandPayloadMap,
  CommandType,
  ChatGetMessagesPayload,
  ChatMarkReadPayload,
  ChatSocketEventPayload,
  ChatSyncConversationsPayload,
  ChatSyncHistoryPayload,
  CaptureCreatePayload,
  CaptureGetPayload,
  CaptureTaskRefPayload,
  CaptureSuggestWordsCommandPayload,
  PingPayload,
  PlatformCallPayload,
  PlatformPingPayload,
  ProductListPayload,
  PublishPayload,
  SubscribePayload,
  TaskListPayload,
  DataSourceListPayload,
  DataSourceSchemaPayload,
  DataSourceQueryPayload,
  PromptRuleListPayload,
  PromptRuleUpsertPayload,
  PromptRuleDeletePayload,
  AnalysisCreatePayload,
  AnalysisGetPayload,
  AnalysisCancelPayload,
  AnalysisResultGetPayload,
  PublishCancelPayload,
  PublishConfirmStatusPayload,
  PublishFillFormPayload,
  PublishGetPayload,
  PublishListPayload,
  PublishPausePayload,
  PublishResumePayload,
  PublishSubmitPayload,
  ProductCatalogQueryCommandPayload as ProductCatalogQueryPayload,
} from './commands'
import type { MessageCursor } from '../types/chat'
import type { MigrateLegacyConfigPayload, LegacyConfigTransfer } from '../types/legacy-migration'
import { LEGACY_TRANSFER_LIMITS, LEGACY_TRANSFER_SECTIONS } from '../types/legacy-migration'
import type { AiConfigSetPayload, FeishuConfigSetPayload } from '../types/config-setup'
import { CONFIG_FIELD_MAX_LENGTH, CONFIG_MAX_TIMEOUT_MS, extractSafeAiOrigin } from '../types/config-setup'
import { ANALYSIS_MODEL_CONFIG_LIMITS } from '../types/analysis'
import type {
  FeishuProductWriteExecutePayload,
  FeishuProductWritePreviewPayload,
} from '../types/feishu-write'
import type {
  FeishuProductSchemaReconcileExecutePayload,
  FeishuProductSchemaReconcilePreviewPayload,
} from '../types/feishu-schema-reconcile'
import {
  FEISHU_WRITE_MAX_ITEMS,
  FEISHU_WRITE_MAX_ITEM_ID_LENGTH,
  FEISHU_WRITE_MAX_PREVIEW_ID_LENGTH,
} from '../types/feishu-write'
import { FEISHU_SCHEMA_RECONCILE_MAX_PREVIEW_ID_LENGTH } from '../types/feishu-schema-reconcile'
import { CHAT_SOCKET_MAX_RAW_LENGTH } from './commands'
import type {
  FeishuProductGetPayload,
  FeishuProductsPagePayload,
} from '../types/feishu-products'
import type { PublishCreatePayload } from '../types/publish'
import {
  FEISHU_PRODUCTS_KEYWORD_MAX_LENGTH,
  FEISHU_PRODUCTS_MAX_PAGE_SIZE,
  FEISHU_PRODUCTS_ORDERS,
  FEISHU_PRODUCTS_PAGE_TOKEN_MAX_LENGTH,
  FEISHU_PRODUCTS_RECORD_ID_MAX_LENGTH,
} from '../types/feishu-products'
import {
  PRODUCT_CATALOG_CURSOR_MAX_LENGTH,
  PRODUCT_CATALOG_KEYWORD_MAX_LENGTH,
  PRODUCT_CATALOG_MAX_PAGE_SIZE,
} from '../types/product-catalog'
import {
  isChatAiPauseSetPayload,
  isChatApplyReplyPayload,
  isChatGetReplySuggestionPayload,
  isChatRulesSetPayload,
  isChatSendMessagePayload,
} from '../reply/index'

/** 生成一个 requestId。 */
export function genRequestId(): RequestId {
  return randomId('req')
}

/** 生成一个 eventId。 */
export function genEventId(): string {
  return randomId('evt')
}

function randomId(prefix: string): string {
  const globalCrypto = globalThis.crypto
  const uuid =
    typeof globalCrypto !== 'undefined' && typeof globalCrypto.randomUUID === 'function'
      ? globalCrypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  return `${prefix}_${uuid}`
}

/** 构造命令信封。 */
export function createCommand<T extends CommandType>(
  type: T,
  payload: CommandPayloadMap[T],
  requestId: RequestId = genRequestId(),
): CommandEnvelope<T, CommandPayloadMap[T]> {
  return {
    kind: 'command',
    protocol: PROTOCOL_VERSION,
    requestId,
    type,
    payload,
    sentAt: Date.now(),
  }
}

/** 构造成功响应。 */
export function createResponse<T extends string, R>(
  requestId: RequestId,
  type: T,
  result: R,
): ResponseEnvelope<T, R> {
  return {
    kind: 'response',
    protocol: PROTOCOL_VERSION,
    requestId,
    type,
    ok: true,
    result,
    respondedAt: Date.now(),
  }
}

/** 构造失败响应。 */
export function createErrorResponse<T extends string>(
  requestId: RequestId,
  type: T,
  error: ProtocolError,
): ResponseEnvelope<T, never> {
  return {
    kind: 'response',
    protocol: PROTOCOL_VERSION,
    requestId,
    type,
    ok: false,
    error,
    respondedAt: Date.now(),
  }
}

/**
 * 构造事件信封。
 * payload 声明为 unknown，以便 background 按动态事件类型广播。
 */
export function createEvent<T extends string>(type: T, payload: unknown): EventEnvelope<T, unknown> {
  return {
    kind: 'event',
    protocol: PROTOCOL_VERSION,
    type,
    eventId: genEventId(),
    payload,
    emittedAt: Date.now(),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 判断是否为命令信封。 */
export function isCommandEnvelope(value: unknown): value is CommandEnvelope {
  return (
    isRecord(value) &&
    value.kind === 'command' &&
    typeof value.requestId === 'string' &&
    typeof value.type === 'string'
  )
}

/** 判断是否为响应信封。 */
export function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  return (
    isRecord(value) &&
    value.kind === 'response' &&
    typeof value.requestId === 'string' &&
    typeof value.type === 'string' &&
    typeof value.ok === 'boolean'
  )
}

/** 判断是否为事件信封。 */
export function isEventEnvelope(value: unknown): value is EventEnvelope {
  return (
    isRecord(value) &&
    value.kind === 'event' &&
    typeof value.type === 'string' &&
    typeof value.eventId === 'string'
  )
}

/** 判断是否为任一协议消息。 */
export function isBridgeMessage(value: unknown): value is BridgeMessage {
  return isCommandEnvelope(value) || isResponseEnvelope(value) || isEventEnvelope(value)
}

/** 判断是否为事件长连接的订阅声明消息。 */
export function isSubscribeMessage(value: unknown): value is SubscribeMessage {
  return (
    isRecord(value) &&
    value.kind === 'subscribe' &&
    Array.isArray(value.events) &&
    value.events.every((item) => typeof item === 'string')
  )
}

/** 序列化为字符串，便于跨 postMessage / 结构化克隆边界传输与日志。 */
export function serializeMessage(message: BridgeMessage): string {
  return JSON.stringify(message)
}

/** 从字符串反序列化；内容非法时返回 null。 */
export function deserializeMessage(raw: string): BridgeMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isBridgeMessage(parsed) ? parsed : null
  } catch {
    return null
  }
}

// ---- 命令负载的运行时校验（background 处理前调用） ----

/** 校验 PING 负载。 */
export function isPingPayload(value: unknown): value is PingPayload {
  return isRecord(value) && typeof value.clientTime === 'number' && typeof value.nonce === 'string'
}

/** 校验 SUBSCRIBE / UNSUBSCRIBE 负载。 */
export function isSubscribePayload(value: unknown): value is SubscribePayload {
  return (
    isRecord(value) &&
    Array.isArray(value.events) &&
    value.events.every((item) => typeof item === 'string')
  )
}

/** 校验 PUBLISH 负载。 */
export function isPublishPayload(value: unknown): value is PublishPayload {
  return isRecord(value) && typeof value.event === 'string' && 'payload' in value
}

/**
 * 校验 PLATFORM_CALL 负载。
 *
 * 仅做结构校验（method 为字符串、带 params）；method 是否在白名单内由 background
 * 平台层用 `isPlatformMethod` 决定，避免 shared 包依赖 extension 的方法表。
 */
export function isPlatformCallPayload(value: unknown): value is PlatformCallPayload {
  return isRecord(value) && typeof value.method === 'string' && 'params' in value
}

/** 校验 PLATFORM_PING 负载（约定为空对象）。 */
export function isPlatformPingPayload(value: unknown): value is PlatformPingPayload {
  return isRecord(value)
}

// ---- 聊天只读层（P5）负载校验 ----

/** 校验 CHAT_GET_MESSAGES 负载。 */
export function isChatGetMessagesPayload(value: unknown): value is ChatGetMessagesPayload {
  if (!isRecord(value)) return false
  if (typeof value['sessionId'] !== 'string' || value['sessionId'].length === 0) return false
  if (value['order'] !== undefined && value['order'] !== 'asc' && value['order'] !== 'desc') return false
  // limit 沿用旧契约（只要求有限数字），不因新增 before 而收紧：旧调用方可能传 0/负数/小数/较大值。
  if (value['limit'] !== undefined && (typeof value['limit'] !== 'number' || !Number.isFinite(value['limit']))) return false
  // before 是本次新增的向前分页边界；非法游标（缺字段 / 非数字 / 空 id）直接拒绝，避免上游用它做任意查询。
  if (value['before'] !== undefined && !isMessageCursor(value['before'])) return false
  return true
}

/** 校验 CHAT_SYNC_HISTORY 负载。 */
export function isChatSyncHistoryPayload(value: unknown): value is ChatSyncHistoryPayload {
  if (!isRecord(value)) return false
  if (typeof value['sessionId'] !== 'string' || value['sessionId'].length === 0) return false
  // pages/count 沿用旧契约（有限非负数），不因新增 cursor 而收紧。
  if (!isOptionalPositiveNumber(value['pages']) || !isOptionalPositiveNumber(value['count'])) return false
  // cursor 是本次新增的服务端历史游标，必须为严格正 safe integer：0/小数/超界/非数字一律拒绝，
  // 避免上游用它构造非法或重复的历史查询。
  if (value['cursor'] !== undefined && (typeof value['cursor'] !== 'number' || !Number.isSafeInteger(value['cursor']) || value['cursor'] <= 0)) {
    return false
  }
  return true
}

/**
 * 校验消息排序游标（分页边界）。
 *
 * 与存储层 `compareMessages` 的排序键一致：`createAt` 为有限数字，
 * `messageId` 可为空（指纹消息），`id` 必须是非空去重键，否则拒绝。
 */
export function isMessageCursor(value: unknown): value is MessageCursor {
  if (!isRecord(value)) return false
  if (typeof value['createAt'] !== 'number' || !Number.isFinite(value['createAt'])) return false
  if (typeof value['messageId'] !== 'string') return false
  if (typeof value['id'] !== 'string' || value['id'].length === 0) return false
  return true
}

/** 校验 CHAT_MARK_READ 负载；限制长度并拒绝空白/非服务端 ID。 */
export function isChatMarkReadPayload(value: unknown): value is ChatMarkReadPayload {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    Object.keys(value)[0] === 'sessionId' &&
    typeof value['sessionId'] === 'string' &&
    /^[^@\s]{1,128}$/.test(value['sessionId'])
  )
}

/** 校验 CHAT_SYNC_CONVERSATIONS 负载。 */
export function isChatSyncConversationsPayload(value: unknown): value is ChatSyncConversationsPayload {
  if (!isRecord(value)) return false
  return isOptionalPositiveNumber(value['pages']) && isOptionalPositiveNumber(value['pageSize'])
}

/**
 * 校验 CHAT_SOCKET_EVENT 负载。
 *
 * 除结构外还限制 `raw` 长度（{@link CHAT_SOCKET_MAX_RAW_LENGTH}），避免异常大帧进入 background。
 */
export function isChatSocketEventPayload(value: unknown): value is ChatSocketEventPayload {
  if (!isRecord(value)) return false
  const event = value['event']
  if (event !== 'message' && event !== 'open' && event !== 'close' && event !== 'error') return false
  if (typeof value['at'] !== 'number' || !Number.isFinite(value['at'])) return false
  if (value['connectedAt'] !== undefined &&
    (typeof value['connectedAt'] !== 'number' || !Number.isFinite(value['connectedAt']) ||
      value['connectedAt'] < 0 || value['connectedAt'] > value['at'])) return false
  if (value['raw'] !== undefined) {
    if (typeof value['raw'] !== 'string') return false
    if (value['raw'].length > CHAT_SOCKET_MAX_RAW_LENGTH) return false
  }
  if (value['code'] !== undefined && typeof value['code'] !== 'number') return false
  if (value['reason'] !== undefined && typeof value['reason'] !== 'string') return false
  return true
}

/** 可选的正数（含 0）；undefined 视为合法。 */
function isOptionalPositiveNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

// ---- 采集与任务中心（P4）负载校验 ----

/** 允许的任务类型（与 shared/types/task 的 TaskTypeRegistry 对齐）。 */
const TASK_TYPES: ReadonlySet<string> = new Set(['capture', 'publish', 'analysis'])

/** 允许的 TASK_LIST 排序字段。 */
const TASK_LIST_SORT_BY: ReadonlySet<string> = new Set(['createdAt', 'updatedAt'])

/** 允许的 TASK_LIST 排序方向。 */
const TASK_LIST_SORT_ORDER: ReadonlySet<string> = new Set(['asc', 'desc'])

/** 允许的任务状态。 */
const TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
])

/** 允许的商品排序方式。 */
const PRODUCT_ORDERS: ReadonlySet<string> = new Set(['captureTimeDesc', 'captureTimeAsc', 'wantCntDesc'])

/** 允许的商品来源筛选方式。 */
const PRODUCT_SOURCES: ReadonlySet<string> = new Set(['my_published', 'captured_search', 'legacy_unconfirmed', 'all'])

/** 可选的非负有限数。 */
function isOptionalNonNegativeNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

/** 可选的正整数（>= min）。 */
function isOptionalPositiveInt(value: unknown, min: number): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= min)
}

/** 校验采集过滤条件。 */
function isCaptureFilter(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (!isOptionalNonNegativeNumber(value['minWantCnt'])) return false
  if (!isOptionalNonNegativeNumber(value['minPrice'])) return false
  if (!isOptionalNonNegativeNumber(value['maxPrice'])) return false
  if (value['onlyFreeShip'] !== undefined && typeof value['onlyFreeShip'] !== 'boolean') return false
  return true
}

/** 校验 CAPTURE_CREATE 负载。 */
export function isCaptureCreatePayload(value: unknown): value is CaptureCreatePayload {
  if (!isRecord(value)) return false
  const keyword = value['keyword']
  if (typeof keyword !== 'string' || keyword.trim().length === 0) return false
  if (!isOptionalPositiveInt(value['startPage'], 1)) return false
  if (!isOptionalPositiveInt(value['pages'], 1)) return false
  if (!isOptionalPositiveInt(value['rowsPerPage'], 1)) return false
  if (!isOptionalNonNegativeNumber(value['minIntervalMs'])) return false
  if (!isOptionalNonNegativeNumber(value['intervalJitterMs'])) return false
  if (value['fetchDetail'] !== undefined && typeof value['fetchDetail'] !== 'boolean') return false
  if (value['filter'] !== undefined && !isCaptureFilter(value['filter'])) return false
  return true
}

/** 校验 CAPTURE_PAUSE / RESUME / CANCEL 负载。 */
export function isCaptureTaskRefPayload(value: unknown): value is CaptureTaskRefPayload {
  if (!isRecord(value)) return false
  if (typeof value['id'] !== 'string' || value['id'].length === 0) return false
  if (value['reason'] !== undefined && typeof value['reason'] !== 'string') return false
  return true
}

/** 校验 CAPTURE_GET 负载。 */
export function isCaptureGetPayload(value: unknown): value is CaptureGetPayload {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].length > 0
}

/** 校验 TASK_LIST 负载。 */
export function isTaskListPayload(value: unknown): value is TaskListPayload {
  if (!isRecord(value)) return false
  const type = value['type']
  if (type !== undefined && (typeof type !== 'string' || !TASK_TYPES.has(type))) return false
  const status = value['status']
  if (status !== undefined && (typeof status !== 'string' || !TASK_STATUSES.has(status))) return false
  const keyword = value['keyword']
  if (keyword !== undefined && typeof keyword !== 'string') return false
  const sortBy = value['sortBy']
  if (sortBy !== undefined && (typeof sortBy !== 'string' || !TASK_LIST_SORT_BY.has(sortBy))) return false
  const sortOrder = value['sortOrder']
  if (
    sortOrder !== undefined &&
    (typeof sortOrder !== 'string' || !TASK_LIST_SORT_ORDER.has(sortOrder))
  ) {
    return false
  }
  if (!isOptionalPositiveInt(value['limit'], 1)) return false
  return true
}

/** 校验 CAPTURE_SUGGEST_WORDS 负载。关键词可为空串（由运行时判定“空输入不调用”并回结构化错误）。 */
export function isCaptureSuggestWordsPayload(
  value: unknown,
): value is CaptureSuggestWordsCommandPayload {
  if (!isRecord(value)) return false
  if (typeof value['keyword'] !== 'string') return false
  const queryId = value['queryId']
  if (queryId !== undefined && typeof queryId !== 'string') return false
  if (!isOptionalPositiveInt(value['limit'], 1)) return false
  return true
}

/** 校验 PRODUCT_LIST 负载。 */
export function isProductListPayload(value: unknown): value is ProductListPayload {
  if (!isRecord(value)) return false
  if (value['keyword'] !== undefined && typeof value['keyword'] !== 'string') return false
  if (!isOptionalPositiveInt(value['limit'], 1)) return false
  if (value['offset'] !== undefined && !(typeof value['offset'] === 'number' && Number.isInteger(value['offset']) && value['offset'] >= 0)) {
    return false
  }
  const order = value['order']
  if (order !== undefined && (typeof order !== 'string' || !PRODUCT_ORDERS.has(order))) return false
  const source = value['source']
  if (source !== undefined && (typeof source !== 'string' || !PRODUCT_SOURCES.has(source))) return false
  if (value['status'] !== undefined && typeof value['status'] !== 'string') return false
  return true
}

// ---- 聊天发送与 AI（P6）负载校验 ----

/**
 * 校验空对象负载（CHAT_AUTO_REPLY_STATUS / CHAT_RULES_GET）。
 * 允许多余字段吗？不允许：只接受空对象，避免隐藏参数绕过后续校验。
 */
export function isEmptyPayload(value: unknown): value is Record<string, never> {
  return isRecord(value) && Object.keys(value).length === 0
}

// P6 负载校验直接复用 shared/reply 的实现（单一来源），在此重新导出供 background 统一从 @fishops/shared 引用。
export {
  isChatSendMessagePayload,
  isChatGetReplySuggestionPayload,
  isChatApplyReplyPayload,
  isChatRulesSetPayload,
  isChatAiPauseSetPayload,
}

// ---- 旧扩展配置迁移（安全，受信载荷）负载校验 ----

/** 判断可选字符串是否合法（undefined 或限长字符串）。 */
function isOptionalLimitedString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= LEGACY_TRANSFER_LIMITS.maxStringLength)
}

/** 校验受信载荷 · AI 分区（严格键白名单 + 类型）。 */
function isLegacyTransferAi(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => key === 'apiKey' || key === 'baseUrl' || key === 'model' || key === 'timeoutMs')) {
    return false
  }
  return (
    isOptionalLimitedString(value['apiKey']) &&
    isOptionalLimitedString(value['baseUrl']) &&
    isOptionalLimitedString(value['model']) &&
    (value['timeoutMs'] === undefined ||
      (typeof value['timeoutMs'] === 'number' && Number.isFinite(value['timeoutMs']) && value['timeoutMs'] > 0))
  )
}

/** 校验受信载荷 · 全局分区（严格键白名单 + 类型）。 */
function isLegacyTransferGlobal(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => key === 'enabled' || key === 'defaultCooldown' || key === 'defaultDelay' || key === 'blacklist')) {
    return false
  }
  if (value['enabled'] !== undefined && typeof value['enabled'] !== 'boolean') return false
  for (const key of ['defaultCooldown', 'defaultDelay']) {
    const n = value[key]
    if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n) || n < 0)) return false
  }
  const blacklist = value['blacklist']
  if (blacklist !== undefined) {
    if (!Array.isArray(blacklist) || blacklist.length > LEGACY_TRANSFER_LIMITS.maxBlacklist) return false
    if (!blacklist.every((item) => typeof item === 'string' && item.length <= LEGACY_TRANSFER_LIMITS.maxStringLength)) {
      return false
    }
  }
  return true
}

/** 校验受信载荷 · 飞书分区（严格键白名单 + 类型）。 */
function isLegacyTransferFeishu(value: unknown): boolean {
  if (!isRecord(value)) return false
  const allowed = ['appId', 'appSecret', 'spreadsheetToken', 'productTableId', 'sellerTableId']
  if (!Object.keys(value).every((key) => allowed.includes(key))) return false
  return allowed.every((key) => isOptionalLimitedString(value[key]))
}

/**
 * 校验受信迁移载荷（{@link LegacyConfigTransfer}）。
 *
 * 严格白名单：未知顶层键 / 分区未知键一律拒绝；`rules` 只校验为数组且元素为对象，
 * 具体规则合法性由来源适配器在净化后逐条校验（避免在 protocol 层依赖规则语义之外的字段）。
 */
export function isLegacyConfigTransfer(value: unknown): value is LegacyConfigTransfer {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => LEGACY_TRANSFER_SECTIONS.includes(key))) return false
  if (value['ai'] !== undefined && !isLegacyTransferAi(value['ai'])) return false
  if (value['global'] !== undefined && !isLegacyTransferGlobal(value['global'])) return false
  if (value['feishu'] !== undefined && !isLegacyTransferFeishu(value['feishu'])) return false
  const rules = value['rules']
  if (rules !== undefined) {
    if (!Array.isArray(rules) || rules.length > LEGACY_TRANSFER_LIMITS.maxRules) return false
    if (!rules.every((item) => isRecord(item))) return false
  }
  return true
}

/**
 * 校验 MIGRATE_LEGACY_CONFIG 负载。
 *
 * - 只接受 `legacy` / `dryRun` / `confirm` / `overwrite`；
 * - `overwrite=true` 必须同时 `confirm=true`（二次确认）；
 * - `legacy` 存在时必须通过 {@link isLegacyConfigTransfer}（严格白名单）。
 */
export function isMigrateLegacyConfigPayload(value: unknown): value is MigrateLegacyConfigPayload {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => key === 'legacy' || key === 'dryRun' || key === 'confirm' || key === 'overwrite')) {
    return false
  }
  for (const key of ['dryRun', 'confirm', 'overwrite']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') return false
  }
  if (value['overwrite'] === true && value['confirm'] !== true) return false
  if (value['legacy'] !== undefined && !isLegacyConfigTransfer(value['legacy'])) return false
  return true
}

// ---- 手动配置（AI / 飞书）负载校验 ----

/** 判断可选配置字符串是否合法（undefined 或限长字符串）。 */
function isOptionalConfigString(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= CONFIG_FIELD_MAX_LENGTH)
}

/**
 * 校验 AI_CONFIG_SET 负载。
 *
 * - 非空对象，仅允许 `apiKey` / `baseUrl` / `model` / `timeoutMs`；
 * - `timeoutMs` 必须为不超过 {@link CONFIG_MAX_TIMEOUT_MS} 的正整数。
 */
export function isAiConfigSetPayload(value: unknown): value is AiConfigSetPayload {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length === 0) return false
  if (!keys.every((key) => key === 'apiKey' || key === 'baseUrl' || key === 'model' || key === 'timeoutMs')) {
    return false
  }
  if (!isOptionalConfigString(value['apiKey'])) return false
  if (!isOptionalConfigString(value['baseUrl'])) return false
  if (typeof value['baseUrl'] === 'string' && value['baseUrl'].trim().length > 0) {
    // 校验 baseUrl：允许 HTTP/HTTPS，禁止携带用户名/密码认证信息、查询参数、片段或非标准/空域名
    if (!extractSafeAiOrigin(value['baseUrl']).ok) return false
  }
  if (!isOptionalConfigString(value['model'])) return false
  const timeout = value['timeoutMs']
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0 || timeout > CONFIG_MAX_TIMEOUT_MS)
  ) {
    return false
  }
  return true
}

/**
 * 校验 AI_CONFIG_TEST 负载。
 *
 * 必须是空对象：探测所使用的 apiKey / baseUrl / model / timeoutMs 全部取自
 * background 已保存的配置，不接受任何请求侧覆盖参数，避免隐藏字段绕过校验。
 */
export function isAiConfigTestPayload(value: unknown): value is Record<string, never> {
  return isEmptyPayload(value)
}

/** 飞书配置允许的字段（严格白名单）。 */
const FEISHU_CONFIG_SET_KEYS: readonly string[] = [
  'appId',
  'appSecret',
  'spreadsheetToken',
  'productTableId',
  'sellerTableId',
]

/**
 * 校验 FEISHU_CONFIG_SET 负载。
 *
 * - 非空对象，仅允许白名单字段；
 * - 必需字段的完整性在 background 合并后判定（允许 PATCH 式分次填写）。
 */
export function isFeishuConfigSetPayload(value: unknown): value is FeishuConfigSetPayload {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length === 0) return false
  if (!keys.every((key) => FEISHU_CONFIG_SET_KEYS.includes(key))) return false
  return FEISHU_CONFIG_SET_KEYS.every((key) => isOptionalConfigString(value[key]))
}

// ---- 运行时自动准备（P8）负载校验 ----

/** 校验 CHAT_RUNTIME_PREPARE 负载：可选 purpose/force，不接受其它字段。 */
export function isChatRuntimePreparePayload(value: unknown): value is {
  purpose?: 'chat' | 'platform'
  force?: boolean
} {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (!keys.every((key) => key === 'purpose' || key === 'force')) return false
  if (value['purpose'] !== undefined && value['purpose'] !== 'chat' && value['purpose'] !== 'platform') {
    return false
  }
  if (value['force'] !== undefined && typeof value['force'] !== 'boolean') return false
  return true
}

// ---- 数据源与分析（P7）负载校验 ----

/** 校验 DATA_SOURCE_LIST 负载（空对象）。 */
export function isDataSourceListPayload(value: unknown): value is DataSourceListPayload {
  return isEmptyPayload(value)
}

/** 校验 DATA_SOURCE_SCHEMA 负载。 */
export function isDataSourceSchemaPayload(value: unknown): value is DataSourceSchemaPayload {
  return isRecord(value) && typeof value['type'] === 'string' && value['type'].trim().length > 0
}

/** 校验 DATA_SOURCE_QUERY 负载。 */
export function isDataSourceQueryPayload(value: unknown): value is DataSourceQueryPayload {
  if (!isRecord(value)) return false
  if (typeof value['type'] !== 'string' || value['type'].trim().length === 0) return false
  if (value['filter'] !== undefined && !isRecord(value['filter'])) return false
  if (value['params'] !== undefined && !isRecord(value['params'])) return false
  return true
}

/** 校验 PROMPT_RULE_LIST 负载（空对象）。 */
export function isPromptRuleListPayload(value: unknown): value is PromptRuleListPayload {
  return isEmptyPayload(value)
}

/** 校验 PROMPT_RULE_UPSERT 负载。 */
export function isPromptRuleUpsertPayload(value: unknown): value is PromptRuleUpsertPayload {
  if (!isRecord(value) || !isRecord(value['rule'])) return false
  const rule = value['rule']
  return (
    typeof rule['id'] === 'string' &&
    rule['id'].trim().length > 0 &&
    typeof rule['name'] === 'string' &&
    rule['name'].trim().length > 0 &&
    typeof rule['systemPrompt'] === 'string' &&
    typeof rule['userPromptTemplate'] === 'string'
  )
}

/** 校验 PROMPT_RULE_DELETE 负载。 */
export function isPromptRuleDeletePayload(value: unknown): value is PromptRuleDeletePayload {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].trim().length > 0
}

/**
 * 校验分析任务的可选 `modelConfig` 覆盖（严格键白名单 + 类型 / 边界）。
 *
 * 仅允许 `baseUrl` / `model` / `temperature` / `maxTokens` / `timeoutMs`；
 * baseUrl / model 若提供必须为非空限长字符串，其余为数值边界内的正数。
 * 非法覆盖直接拒绝，避免脏参数透传到 LLM 请求层。
 */
function isAnalysisModelConfig(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (keys.length === 0) return false
  if (
    !keys.every(
      (key) =>
        key === 'baseUrl' ||
        key === 'model' ||
        key === 'temperature' ||
        key === 'maxTokens' ||
        key === 'timeoutMs',
    )
  ) {
    return false
  }
  const baseUrl = value['baseUrl']
  if (
    baseUrl !== undefined &&
    (typeof baseUrl !== 'string' || baseUrl.trim().length === 0 || baseUrl.length > ANALYSIS_MODEL_CONFIG_LIMITS.maxTextLength)
  ) {
    return false
  }
  const model = value['model']
  if (
    model !== undefined &&
    (typeof model !== 'string' || model.trim().length === 0 || model.length > ANALYSIS_MODEL_CONFIG_LIMITS.maxTextLength)
  ) {
    return false
  }
  const temperature = value['temperature']
  if (
    temperature !== undefined &&
    (typeof temperature !== 'number' ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > ANALYSIS_MODEL_CONFIG_LIMITS.maxTemperature)
  ) {
    return false
  }
  const maxTokens = value['maxTokens']
  if (
    maxTokens !== undefined &&
    (typeof maxTokens !== 'number' ||
      !Number.isInteger(maxTokens) ||
      maxTokens <= 0 ||
      maxTokens > ANALYSIS_MODEL_CONFIG_LIMITS.maxOutputTokens)
  ) {
    return false
  }
  const timeoutMs = value['timeoutMs']
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > ANALYSIS_MODEL_CONFIG_LIMITS.maxTimeoutMs)
  ) {
    return false
  }
  return true
}

/** 校验 ANALYSIS_CREATE 负载。 */
export function isAnalysisCreatePayload(value: unknown): value is AnalysisCreatePayload {
  if (!isRecord(value)) return false
  if (typeof value['ruleId'] !== 'string' || value['ruleId'].trim().length === 0) return false
  if (typeof value['dataSourceType'] !== 'string' || value['dataSourceType'].trim().length === 0) return false
  if (value['sampleLimit'] !== undefined) {
    if (typeof value['sampleLimit'] !== 'number' || !Number.isInteger(value['sampleLimit']) || value['sampleLimit'] <= 0) {
      return false
    }
  }
  if (value['modelConfig'] !== undefined && !isAnalysisModelConfig(value['modelConfig'])) return false
  if (value['customInstructions'] !== undefined && typeof value['customInstructions'] !== 'string') return false
  return true
}

/** 校验 ANALYSIS_GET 负载。 */
export function isAnalysisGetPayload(value: unknown): value is AnalysisGetPayload {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].trim().length > 0
}

/** 校验 ANALYSIS_CANCEL 负载。 */
export function isAnalysisCancelPayload(value: unknown): value is AnalysisCancelPayload {
  if (!isRecord(value)) return false
  if (typeof value['id'] !== 'string' || value['id'].trim().length === 0) return false
  if (value['reason'] !== undefined && typeof value['reason'] !== 'string') return false
  return true
}

/** 校验 ANALYSIS_RESULT_GET 负载。 */
export function isAnalysisResultGetPayload(value: unknown): value is AnalysisResultGetPayload {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].trim().length > 0
}

// ---- 飞书商品库分页浏览 / 单条读取（P7）负载校验 ----

/**
 * 校验 FEISHU_PRODUCTS_PAGE 负载。
 *
 * 严格键白名单：仅允许 `pageSize` / `pageToken` / `keyword` / `order`。命令**不接受** tableId，
 * 目标表固定为已配置商品表；`pageSize` 必须为 1..上限的整数（缺省由后台使用默认 20）。
 */
/**
 * 校验 FEISHU_PRODUCTS_PAGE 负载。
 *
 * 严格键白名单：仅允许 `pageSize` / `pageToken` / `targetTableId` / `keyword` / `order`。命令**不接受**任意
 * tableId，实际查询表固定为已配置商品表；`targetTableId` 仅作绑定断言。
 * `pageSize` 必须为 1..上限的整数（缺省由后台使用默认 20）；
 * **携带 `pageToken` 时必须同时提供 `targetTableId`**（防跨表游标）。
 */
export function isFeishuProductsPagePayload(value: unknown): value is FeishuProductsPagePayload {
  if (!isRecord(value)) return false
  if (
    !Object.keys(value).every(
      (key) =>
        key === 'pageSize' ||
        key === 'pageToken' ||
        key === 'targetTableId' ||
        key === 'keyword' ||
        key === 'order',
    )
  ) {
    return false
  }

  const pageSize = value['pageSize']
  if (
    pageSize !== undefined &&
    !(
      typeof pageSize === 'number' &&
      Number.isInteger(pageSize) &&
      pageSize >= 1 &&
      pageSize <= FEISHU_PRODUCTS_MAX_PAGE_SIZE
    )
  ) {
    return false
  }

  const pageToken = value['pageToken']
  if (
    pageToken !== undefined &&
    !(
      typeof pageToken === 'string' &&
      pageToken.trim().length > 0 &&
      pageToken.length <= FEISHU_PRODUCTS_PAGE_TOKEN_MAX_LENGTH
    )
  ) {
    return false
  }

  const targetTableId = value['targetTableId']
  if (
    targetTableId !== undefined &&
    !(typeof targetTableId === 'string' && targetTableId.trim().length > 0)
  ) {
    return false
  }

  // 携带 pageToken 时必须绑定目标表，防止跨表游标。
  if (pageToken !== undefined && targetTableId === undefined) return false

  const keyword = value['keyword']
  if (
    keyword !== undefined &&
    !(typeof keyword === 'string' && keyword.length <= FEISHU_PRODUCTS_KEYWORD_MAX_LENGTH)
  ) {
    return false
  }

  const order = value['order']
  if (
    order !== undefined &&
    !(typeof order === 'string' && (FEISHU_PRODUCTS_ORDERS as readonly string[]).includes(order))
  ) {
    return false
  }

  return true
}

/**
 * 校验 FEISHU_PRODUCT_GET 负载。
 *
 * 严格键白名单：仅允许 `recordId`（非空限长字符串）；命令**不接受** tableId。
 */
export function isFeishuProductGetPayload(value: unknown): value is FeishuProductGetPayload {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'recordId' || key === 'targetTableId')) return false
  const recordId = value['recordId']
  if (
    typeof recordId !== 'string' ||
    recordId.trim().length === 0 ||
    recordId.length > FEISHU_PRODUCTS_RECORD_ID_MAX_LENGTH
  ) {
    return false
  }
  const targetTableId = value['targetTableId']
  if (
    targetTableId !== undefined &&
    !(typeof targetTableId === 'string' && targetTableId.trim().length > 0)
  ) {
    return false
  }
  return true
}

// ---- 商品目录统一查询（P7）负载校验 ----

/** 允许的商品目录来源。 */
const PRODUCT_CATALOG_SOURCE_VALUES: ReadonlySet<string> = new Set(['feishu', 'my_published'])

/**
 * 校验 PRODUCT_CATALOG_QUERY 负载。
 *
 * 严格键白名单：仅允许 `source` / `keyword` / `order` / `pageSize` / `page` / `cursor` / `forceRefresh`。
 * `source` 必填且仅接受 `feishu` / `my_published`；`pageSize` 为 1..上限整数；`page` 为非负整数；
 * `cursor` 为非空限长字符串（飞书分页游标）。
 */
export function isProductCatalogQueryPayload(value: unknown): value is ProductCatalogQueryPayload {
  if (!isRecord(value)) return false
  if (
    !Object.keys(value).every(
      (key) =>
        key === 'source' ||
        key === 'keyword' ||
        key === 'order' ||
        key === 'pageSize' ||
        key === 'page' ||
        key === 'cursor' ||
        key === 'targetTableId' ||
        key === 'forceRefresh',
    )
  ) {
    return false
  }

  const source = value['source']
  if (typeof source !== 'string' || !PRODUCT_CATALOG_SOURCE_VALUES.has(source)) return false

  const keyword = value['keyword']
  if (
    keyword !== undefined &&
    !(typeof keyword === 'string' && keyword.length <= PRODUCT_CATALOG_KEYWORD_MAX_LENGTH)
  ) {
    return false
  }

  const order = value['order']
  if (order !== undefined && (typeof order !== 'string' || !PRODUCT_ORDERS.has(order))) return false

  const pageSize = value['pageSize']
  if (
    pageSize !== undefined &&
    !(
      typeof pageSize === 'number' &&
      Number.isInteger(pageSize) &&
      pageSize >= 1 &&
      pageSize <= PRODUCT_CATALOG_MAX_PAGE_SIZE
    )
  ) {
    return false
  }

  const page = value['page']
  if (page !== undefined && !(typeof page === 'number' && Number.isInteger(page) && page >= 0)) {
    return false
  }

  const cursor = value['cursor']
  if (
    cursor !== undefined &&
    !(
      typeof cursor === 'string' &&
      cursor.trim().length > 0 &&
      cursor.length <= PRODUCT_CATALOG_CURSOR_MAX_LENGTH
    )
  ) {
    return false
  }

  const targetTableId = value['targetTableId']
  if (
    targetTableId !== undefined &&
    !(typeof targetTableId === 'string' && targetTableId.trim().length > 0)
  ) {
    return false
  }
  // 携带 cursor（飞书分页游标）时必须绑定目标表，防止跨表游标。
  if (cursor !== undefined && targetTableId === undefined) return false

  if (value['forceRefresh'] !== undefined && typeof value['forceRefresh'] !== 'boolean') return false

  return true
}

// ---- 发布中心（P8）负载校验 ----

/** 校验 PUBLISH_CREATE 负载：必须显式提供非空 itemId，可选 rule 和 override。 */
/**
 * 校验 PUBLISH_CREATE 负载。
 *
 * 两种互斥来源（严格键白名单：仅 itemId / source / recordId / targetTableId / rule / override）：
 * - 本地：`source` 缺省或 `'my_published'`，必须显式提供非空 `itemId`，不得携带 recordId / targetTableId；
 * - 飞书：`source === 'feishu'`，必须提供非空 `recordId` 与 `targetTableId`；
 *   `itemId` 可选（为飞书记录中真实「商品ID」时携带），绝不要求伪造。
 *
 * 无论哪种来源，`rule` / `override` 如出现必须为对象，后台仍会再次校验覆盖字段。
 */
export function isPublishCreatePayload(value: unknown): value is PublishCreatePayload {
  if (!isRecord(value)) return false
  if (
    !Object.keys(value).every(
      (key) =>
        key === 'itemId' ||
        key === 'source' ||
        key === 'recordId' ||
        key === 'targetTableId' ||
        key === 'rule' ||
        key === 'override',
    )
  ) {
    return false
  }
  if (value['rule'] !== undefined && !isRecord(value['rule'])) return false
  if (value['override'] !== undefined && !isRecord(value['override'])) return false

  const source = value['source']
  if (source !== undefined && source !== 'my_published' && source !== 'feishu') return false

  const nonEmptyString = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && candidate.trim().length > 0

  if (source === 'feishu') {
    // 飞书来源：必须带 recordId 与 targetTableId；itemId 可选（真实商品ID）。
    if (value['itemId'] !== undefined && !nonEmptyString(value['itemId'])) return false
    return nonEmptyString(value['recordId']) && nonEmptyString(value['targetTableId'])
  }

  // 本地来源：必须带 itemId，不得携带飞书字段。
  if (value['recordId'] !== undefined || value['targetTableId'] !== undefined) return false
  return nonEmptyString(value['itemId'])
}

/** 校验 PUBLISH_LIST 负载。 */
export function isPublishListPayload(value: unknown): value is PublishListPayload {
  if (!isRecord(value)) return false
  if (value['itemId'] !== undefined && typeof value['itemId'] !== 'string') return false
  if (value['keyword'] !== undefined && typeof value['keyword'] !== 'string') return false
  if (value['limit'] !== undefined && !isOptionalPositiveInt(value['limit'], 1)) return false
  if (value['offset'] !== undefined && !(typeof value['offset'] === 'number' && Number.isInteger(value['offset']) && value['offset'] >= 0)) {
    return false
  }
  if (value['sortBy'] !== undefined && value['sortBy'] !== 'createdAt' && value['sortBy'] !== 'updatedAt') {
    return false
  }
  if (value['sortOrder'] !== undefined && value['sortOrder'] !== 'asc' && value['sortOrder'] !== 'desc') {
    return false
  }
  return true
}

/** 校验 PUBLISH_GET 负载。 */
export function isPublishGetPayload(value: unknown): value is PublishGetPayload {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].trim().length > 0
}

/** 校验 PUBLISH_FILL_FORM 负载。 */
export function isPublishFillFormPayload(value: unknown): value is PublishFillFormPayload {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].trim().length > 0
}

/** 校验 PUBLISH_CANCEL 负载。 */
export function isPublishCancelPayload(value: unknown): value is PublishCancelPayload {
  if (!isRecord(value)) return false
  if (typeof value['id'] !== 'string' || value['id'].trim().length === 0) return false
  if (value['reason'] !== undefined && typeof value['reason'] !== 'string') return false
  return true
}

/** 校验 PUBLISH_PAUSE 负载。 */
export function isPublishPausePayload(value: unknown): value is PublishPausePayload {
  if (!isRecord(value)) return false
  if (typeof value['id'] !== 'string' || value['id'].trim().length === 0) return false
  if (value['reason'] !== undefined && typeof value['reason'] !== 'string') return false
  return true
}

/** 校验 PUBLISH_RESUME 负载。 */
export function isPublishResumePayload(value: unknown): value is PublishResumePayload {
  return isRecord(value) && typeof value['id'] === 'string' && value['id'].trim().length > 0
}

/** 校验 PUBLISH_CONFIRM_STATUS 负载。 */
export function isPublishConfirmStatusPayload(value: unknown): value is PublishConfirmStatusPayload {
  if (!isRecord(value)) return false
  if (typeof value['id'] !== 'string' || value['id'].trim().length === 0) return false
  const status = value['confirmationStatus']
  if (status !== undefined && status !== 'confirmed' && status !== 'rejected') return false
  if (value['note'] !== undefined && typeof value['note'] !== 'string') return false
  return true
}

/**
 * 校验 PUBLISH_SUBMIT 负载。
 *
 * 严格键白名单：仅允许 `id` / `submitToken` / `confirm`；
 * `confirm` 必须为字面 `true`，`submitToken` 必须为非空字符串 —— 以此保证最终提交只能由
 * 携带一次性令牌的显式用户动作触发，且无法被任意字段伪装。
 */
export function isPublishSubmitPayload(value: unknown): value is PublishSubmitPayload {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'id' || key === 'submitToken' || key === 'confirm')) {
    return false
  }
  if (typeof value['id'] !== 'string' || value['id'].trim().length === 0) return false
  if (typeof value['submitToken'] !== 'string' || value['submitToken'].trim().length === 0) return false
  if (value['confirm'] !== true) return false
  return true
}

// ---- 飞书商品写入（后台）负载校验 ----

/** 校验 itemIds 字段：非空数组、元素为非空限长字符串、数量不超过上限。 */
function isFeishuWriteItemIds(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  if (value.length === 0 || value.length > FEISHU_WRITE_MAX_ITEMS) return false
  return value.every(
    (item) => typeof item === 'string' && item.trim().length > 0 && item.length <= FEISHU_WRITE_MAX_ITEM_ID_LENGTH,
  )
}

/**
 * 校验 FEISHU_PRODUCT_WRITE_PREVIEW 负载（只读预览）。
 *
 * 严格白名单：仅允许 `itemIds`；命令**不接受** tableId 等参数，目标表固定为已配置商品表。
 */
export function isFeishuProductWritePreviewPayload(value: unknown): value is FeishuProductWritePreviewPayload {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'itemIds')) return false
  return isFeishuWriteItemIds(value['itemIds'])
}

/**
 * 校验 FEISHU_PRODUCT_WRITE_EXECUTE 负载（显式确认执行 + 绑定预览）。
 *
 * 严格白名单：仅允许 `previewId` / `confirm`；`confirm` 必须为字面 `true`；
 * `previewId` 必须为非空限长字符串，选品由预览缓存决定（执行不可另传 itemIds）。
 */
export function isFeishuProductWriteExecutePayload(value: unknown): value is FeishuProductWriteExecutePayload {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'previewId' || key === 'confirm')) return false
  if (value['confirm'] !== true) return false
  const previewId = value['previewId']
  return (
    typeof previewId === 'string' &&
    previewId.trim().length > 0 &&
    previewId.length <= FEISHU_WRITE_MAX_PREVIEW_ID_LENGTH
  )
}

// ---- 飞书表字段同步（后台）负载校验 ----

/**
 * 校验 FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW 负载（只读预览）。
 *
 * 严格空负载：命令不接受 tableId / 字段目标等参数，目标表固定为已配置商品表。
 */
export function isFeishuProductSchemaReconcilePreviewPayload(
  value: unknown,
): value is FeishuProductSchemaReconcilePreviewPayload {
  return isEmptyPayload(value)
}

/**
 * 校验 FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE 负载（显式确认执行 + 绑定预览）。
 *
 * 严格白名单：仅允许 `previewId` / `confirm` / `acceptTypeConflicts`；`confirm` 必须为字面 `true`；
 * `acceptTypeConflicts` 如出现必须为 boolean；目标与字段目标由预览缓存决定。
 */
export function isFeishuProductSchemaReconcileExecutePayload(
  value: unknown,
): value is FeishuProductSchemaReconcileExecutePayload {
  if (!isRecord(value)) return false
  if (!Object.keys(value).every((key) => key === 'previewId' || key === 'confirm' || key === 'acceptTypeConflicts')) {
    return false
  }
  if (value['confirm'] !== true) return false
  const acceptTypeConflicts = value['acceptTypeConflicts']
  if (acceptTypeConflicts !== undefined && typeof acceptTypeConflicts !== 'boolean') return false
  const previewId = value['previewId']
  return (
    typeof previewId === 'string' &&
    previewId.trim().length > 0 &&
    previewId.length <= FEISHU_SCHEMA_RECONCILE_MAX_PREVIEW_ID_LENGTH
  )
}
