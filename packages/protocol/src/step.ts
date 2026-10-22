import { isWire, keys, object, type ApiError } from './index.ts'
import { normalizeReadParams, type ReadMethod, type SearchFilter } from './business.ts'
import { isChatSyncPageParams, type ChatSyncPageParams } from './chat-sync.ts'
import { normalizeWriteParams } from './write.ts'
import { isPublishPrepareStepParams, isPublishSubmitStepParams, isPublishMyItemsStepParams } from './publish.ts'

/** 内部单步白名单；不代表公共能力已注册。 */
export type StepMethod = ReadMethod | 'chat.sync.page' | 'chat.send' | 'publish.prepare' | 'publish.submit' | 'publish.myItems'

/** 固定执行上下文；不得在步骤失败后自动换账号或页面重放。 */
export type StepContext = { accountId: string; tabId: number; documentId: string }
/** 内部页面定位结果只含执行定位字段，不携带 URL、cookie 或原始异常。 */
export type ResolvedPage = { tabId: number; documentId: string }
/** 单步只允许业务参数，缓存及等待参数只由 host 处理。 */
export type StepParams = ChatSyncPageParams | { sessionId: string; receiverId: string; text: string } | Record<string, unknown> | { itemId: string } | { keyword: string } | { keyword: string; page: number; rowsPerPage: number; filter: SearchFilter }
/** 终结结果表示该步骤平台请求确实已结束，不等同于 HTTP 等待超时。 */
export type StepWire =
  | { kind: 'request-step'; id: string; requestId: string; method: StepMethod; params: StepParams; context: StepContext }
  | { kind: 'step-result'; id: string; terminal: true; ok: true; data: unknown }
  | { kind: 'step-result'; id: string; terminal: true; ok: false; error: ApiError }

/** 页面定位失败只允许固定原因，不回传 URL、cookie 或原始浏览器异常。 */
export type PageContextReason = 'PAGE_NOT_READY' | 'LOGIN_REQUIRED' | 'ACCOUNT_CHANGED'
/** host 只请求“当前唯一可执行闲鱼页”，扩展自行选择并返回 documentId。 */
export type PageWire =
  | { kind: 'resolve-page'; id: string; accountId: string }
  | { kind: 'page-context'; id: string; context: { tabId: number; documentId: string } | null; reason?: PageContextReason }

function id(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 }

/** documentId 是 Chrome 生成的 ASCII 标识；空串、空白和超长值一律拒绝。 */
function documentId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !/[\u0000-\u0020\u007f]/.test(value)
}

/** 严格验证扩展返回的固定页面；未知字段与非法 tabId 不得进入单步上下文。 */
export function isResolvedPage(value: unknown): value is ResolvedPage {
  return object(value) && keys(value, ['tabId', 'documentId']) &&
    Number.isSafeInteger(value.tabId) && Number(value.tabId) >= 0 && documentId(value.documentId)
}

/** 页面定位帧严格校验字段和固定原因；成功上下文不得携带失败原因。 */
export function isPageWire(value: unknown): value is PageWire {
  if (!object(value) || !id(value.id)) return false
  if (value.kind === 'resolve-page') {
    return keys(value, ['kind', 'id', 'accountId']) && id(value.accountId)
  }
  if (value.kind !== 'page-context' || !keys(value, ['kind', 'id', 'context', 'reason'])) return false
  if (value.context !== null) {
    if ('reason' in value) return false
    if (!object(value.context) || !keys(value.context, ['tabId', 'documentId'])) return false
    return Number.isSafeInteger(value.context.tabId) && Number(value.context.tabId) >= 0 && documentId(value.context.documentId)
  }
  return value.reason === undefined || value.reason === 'PAGE_NOT_READY' ||
    value.reason === 'LOGIN_REQUIRED' || value.reason === 'ACCOUNT_CHANGED'
}

/** 严格验证单步帧，拒绝未知字段和混入的调度参数。 */
export function isStepWire(value: unknown): value is StepWire {
  if (!object(value) || !id(value.id)) return false
  if (value.kind === 'step-result') {
    if (value.terminal !== true) return false
    if (value.ok === true) return keys(value, ['kind', 'id', 'terminal', 'ok', 'data']) && 'data' in value
    if (value.ok !== false || !keys(value, ['kind', 'id', 'terminal', 'ok', 'error'])) return false
    return isWire({ kind: 'res', id: value.id, ok: false, error: value.error })
  }
  if (value.kind !== 'request-step' || !keys(value, ['kind', 'id', 'requestId', 'method', 'params', 'context']) || !id(value.requestId)) return false
  const c = value.context
  if (!object(c) || !keys(c, ['accountId', 'tabId', 'documentId']) || !id(c.accountId) || !documentId(c.documentId) || !Number.isSafeInteger(c.tabId) || Number(c.tabId) < 0) return false
  if (!object(value.params)) return false
  if (value.method === 'chat.sync.page') return isChatSyncPageParams(value.params)
  if (value.method === 'chat.send') {
    if (!keys(value.params, ['sessionId', 'receiverId', 'text'])) return false
    if (typeof value.params.receiverId !== 'string' || !value.params.receiverId.trim()) return false
    try { normalizeWriteParams('chat.send', { ...value.params, idempotencyKey: 'step-internal' }); return true } catch { return false }
  }
  if (value.method === 'publish.prepare') return isPublishPrepareStepParams(value.params)
  // submit 内部步骤必须携带 Host 持久化的 prepareRef；公共 submit 不接受该字段。
  if (value.method === 'publish.submit') return isPublishSubmitStepParams(value.params)
  // 内部步骤允许受控 nextPage；公共 publish.myItems 仍由独立参数校验拒绝游标。
  if (value.method === 'publish.myItems') return isPublishMyItemsStepParams(value.params)
  const allowed = value.method === 'item.detail' ? ['itemId'] : value.method === 'search.suggest' ? ['keyword']
    : value.method === 'search.items' ? ['keyword', 'page', 'rowsPerPage', 'filter'] : null
  if (!allowed || !keys(value.params, allowed)) return false
  try { normalizeReadParams(String(value.method), value.params); return true } catch { return false }
}
