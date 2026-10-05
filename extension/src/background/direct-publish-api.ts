/**
 * 直接接口发布后台 API（background / service worker）。
 *
 * 目标：在已登录的闲鱼会话内，复用官方 MTOP SDK **直接调用发布业务接口**完成上架
 * （非 DOM 填表、非纯 HTTP 签名），并把结果归一到四种状态：
 * `published | action_required | rejected | unknown`。
 *
 * 关键设计：
 * 1. {@link createDirectPublishApi} 通过注入的 chrome 子集（tabs / scripting / storage.local）
 *    运行，便于 Node mock 单测，不触碰真实浏览器与网络；
 * 2. 自动维护一个**专用非激活发布 tab**（`active:false`，URL 带专属标记），
 *    只复用自己的专用 tab，**绝不接管用户已打开的 tab**；
 * 3. 通过 `chrome.scripting.executeScript({ world:'MAIN', func })` 注入
 *    {@link injectDirectPublishInPage}，所有 MTOP 请求在页面内复用 `window.lib.mtop.request`；
 * 4. 幂等：`chrome.storage.local` 按 `accountScope::idempotencyKey` 持久审计，
 *    同 key 不同 input（指纹不一致）拒绝；已成功同 key 直接返回既有 result，不再请求；
 *    `attempting / unknown / 超时` 一律阻断重试，无任何自动 retry；
 * 5. fail-closed：审计存储不可读 / 不可写时拒绝发布；service worker 重启后残留 `attempting`
 *    会阻断同 key 再次发布；
 * 6. {@link installDirectPublishApiListener} 注册**独立消息 kind** 的 onMessage 监听，
 *    不影响既有 Workbench 命令监听；只接受 `isExtensionPageSender` 认定的扩展内页来源。
 */

import { injectDirectPublishInPage } from './direct-publish-page'
import type {
  DirectPublishPageCardValue,
  DirectPublishPageProduct,
  DirectPublishPagePropertyCard,
  DirectPublishPageRequest,
  DirectPublishPageResult,
  DirectPublishPageSellerAddress,
  DirectPublishPageSubmitCore,
} from './direct-publish-page'
import { isExtensionPageSender } from './sender-policy'
import type { MessageSenderLike } from './sender-policy'
import type {
  DirectPublishPreparedResult,
  DirectPublishPrepareRequest,
  DirectPublishReviewDraft,
  DirectPublishSubmitRequest,
} from '../../../shared/types/direct-publish'

// ==================== 公开消息协议 ====================

/** 独立消息 kind，避免与 Workbench 命令监听冲突。 */
export const DIRECT_PUBLISH_MESSAGE_KIND = 'fishops-direct-publish'

/** 监听器支持的方法。 */
export type DirectPublishMessageMethod = 'publish' | 'prepare' | 'submit' | 'getProduct' | 'uploadImage' | 'getJob'

/** 扩展内页发来的请求消息。 */
export interface DirectPublishMessage {
  kind: typeof DIRECT_PUBLISH_MESSAGE_KIND
  method: DirectPublishMessageMethod
  /** publish/
   * prepare/submit：对应请求体；getProduct：`{ itemId }`；getJob：可选 `{ jobId }`。 */
  request: unknown
}

/** 监听器响应。 */
export interface DirectPublishMessageResponse {
  kind: typeof DIRECT_PUBLISH_MESSAGE_KIND
  method: DirectPublishMessageMethod
  ok: boolean
  result?: DirectPublishResult | DirectPublishPreparedResult | DirectPublishSubmitResult | DirectProductResult | DirectUploadImageResult | DirectPublishJobResult
  error?: { code: string; message: string }
}

// ==================== 对外业务类型 ====================

/** 卖家发货地址（需完整，含 poiId/gps）。 */
export type DirectPublishSellerAddress = DirectPublishPageSellerAddress

/** 第二种入口的商品源（价格为「元」字符串）。 */
export type DirectPublishProductSource = DirectPublishPageProduct

/** 源商品：itemId（可指定安全图片下标）或直接给 product。 */
export type DirectPublishSource =
  | { itemId: string | number; imageIndexes?: number[] }
  | { product: DirectPublishProductSource }

/** publish 入参。 */
export interface DirectPublishInput {
  source: DirectPublishSource
  idempotencyKey: string
  /** 必须显式为 true。 */
  confirm: boolean
  /** address 或 coordinates 至少一项。 */
  seller: {
    address?: DirectPublishSellerAddress | null
    coordinates?: { latitude: number | string; longitude: number | string } | null
  }
  /** 服务卡偏好，默认全部 false；AI_SALE 强制 false。 */
  servicePreferences?: Record<string, boolean>
  /** 必须显式为 true（上传图片前的二维码人工确认门禁）。 */
  confirmedNoQrCodes: boolean
}

/** 归一化发布状态。 */
export type DirectPublishOutcome = 'published' | 'action_required' | 'rejected' | 'unknown'

/** 发布结果。 */
export interface DirectPublishResult {
  status: DirectPublishOutcome
  idempotencyKey: string
  itemId?: string
  actionRequired?: 'login' | 'captcha' | 'verification'
  code?: string
  message?: string
  /** 同 key 命中既有成功结果时为 true（未再次请求）。 */
  reused?: boolean
  /** 输入指纹（SHA-256，仅内存/审计）。 */
  fingerprint?: string
  /** 脱敏告警。 */
  warnings?: string[]
}

/** getProduct 结果（只读，仅返回最小字段，不泄露卖家私密信息）。 */
export interface DirectProductResult {
  status: 'ok' | 'action_required' | 'rejected' | 'unknown'
  itemId: string
  product?: DirectPublishProductSource
  actionRequired?: 'login' | 'captcha' | 'verification'
  code?: string
  message?: string
}

/** 本地图片真实上传结果。 */
export interface DirectUploadImageResult {
  status: 'uploaded' | 'action_required' | 'rejected' | 'unknown'
  image?: Record<string, unknown>
  actionRequired?: 'login' | 'captcha' | 'verification'
  code?: string
  message?: string
}

/** 审计条目（脱敏，可安全返回）。 */
export interface DirectPublishJobPublic {
  idempotencyKey: string
  accountScope: string
  fingerprint: string
  status: string
  itemId?: string
  code?: string
  actionRequired?: string
  at: string
}

/** getJob 结果。 */
export interface DirectPublishJobResult {
  ok: boolean
  jobs: DirectPublishJobPublic[]
  error?: { code: string; message: string }
}

/** submit 结果（两阶段最终提交）。 */
export interface DirectPublishSubmitResult {
  status: 'published' | 'action_required' | 'rejected' | 'unknown'
  /** 与 prepare 绑定的幂等键（来自 prepareToken）。 */
  idempotencyKey: string
  itemId?: string
  actionRequired?: 'login' | 'captcha' | 'verification'
  code?: string
  message?: string
  /** 同 key 命中既有成功结果时为 true（未再次请求）。 */
  reused?: boolean
  /** 最终确认 payload 指纹（SHA-256，仅内存/审计）。 */
  fingerprint?: string
  /**
   * 明确业务拒绝且已安全恢复 prepareToken 时为 true：可修改草稿后用**同一 token** 手动重提。
   * 绝不自动重试。
   */
  retryable?: boolean
  /**
   * 当前 prepareToken 是否仍可用于下一次 submit：明确业务拒绝且已恢复时为 true；
   * action_required / unknown / published 等已消耗 token 的场景为 false，前端据此禁用重试按钮。
   */
  prepareTokenValid?: boolean
  warnings?: string[]
}

/** 直接发布 API 门面。 */
export interface DirectPublishApi {
  /**
   * @deprecated 旧版一步式发布入口，仅为兼容保留；**新 UI 不应调用**。
   * 两阶段流程请使用 {@link DirectPublishApi.prepare} + {@link DirectPublishApi.submit}。
   */
  publish(input: DirectPublishInput): Promise<DirectPublishResult>
  /** 两阶段：准备（跑完 publish 前全部接口，不提交）。可选以兼容旧 mock。 */
  prepare?(input: DirectPublishPrepareRequest): Promise<DirectPublishPreparedResult>
  /** 两阶段：最终提交（仅接受本轮 prepare 的 draft 与 token）。可选以兼容旧 mock。 */
  submit?(input: DirectPublishSubmitRequest): Promise<DirectPublishSubmitResult>
  getProduct(itemId: string | number): Promise<DirectProductResult>
  /** 在闲鱼页面上下文将 data URL 转为 Blob 并真实上传。 */
  uploadImage(dataUrl: string): Promise<DirectUploadImageResult>
  /** 只读查询审计（jobId 缺省返回最近记录）。 */
  getJob(jobId?: string): Promise<DirectPublishJobResult>
}

// ==================== 注入的 chrome 子集 ====================

/** `chrome.tabs.Tab` 的最小子集。 */
export interface DirectPublishTabLike {
  id?: number
  url?: string
  status?: string
  active?: boolean
}

/** `chrome.tabs` 的最小子集。 */
export interface DirectPublishTabsApi {
  query(queryInfo: { active?: boolean; url?: string } | Record<string, never>): Promise<DirectPublishTabLike[]>
  create(createProperties: { url: string; active: boolean }): Promise<DirectPublishTabLike>
  get(tabId: number): Promise<DirectPublishTabLike>
  onRemoved?: { addListener(listener: (tabId: number) => void): void }
}

/** `chrome.scripting` 的最小子集。 */
export interface DirectPublishScriptingApi {
  executeScript<T>(injection: {
    target: { tabId: number }
    world: 'MAIN'
    args: unknown[]
    func: (...args: never[]) => unknown
  }): Promise<Array<{ result?: T }>>
}

/** `chrome.storage.local` 的最小子集（**落盘**：仅审计等脱敏结构）。 */
export interface DirectPublishStorageLocalApi {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

/**
 * `chrome.storage.session` 的最小子集（**会话内存，不落盘**）。
 *
 * 用于持久化两阶段 prepared 条目，使 MV3 service worker 休眠 / 重启后 submit 仍能恢复；
 * 浏览器重启或扩展重载会清空。默认访问级别为 `TRUSTED_CONTEXTS`（后台 + 扩展内页），
 * **不向 content script 暴露**，也不用于存放审计或长期个人数据。
 */
export interface DirectPublishStorageSessionApi {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

/** 注入的 chrome 子集。`storage.session` 可选：缺失时退化为旧的内存缓存（旧 mock 兼容）。 */
export interface DirectPublishChromeSubset {
  tabs: DirectPublishTabsApi
  scripting: DirectPublishScriptingApi
  storage: { local: DirectPublishStorageLocalApi; session?: DirectPublishStorageSessionApi }
}

/** 可注入依赖（便于单测）。 */
export interface DirectPublishApiDeps {
  chrome: DirectPublishChromeSubset
  /** 专用发布页地址，默认 {@link DEFAULT_DIRECT_PUBLISH_URL}。 */
  publishUrl?: string
  /** 等待 tab 加载完成超时（毫秒），默认 15000。 */
  loadTimeoutMs?: number
  /** 页面注入超时（毫秒），默认 120000；超时归 unknown 且不重试。 */
  injectTimeoutMs?: number
  /** 指纹哈希实现，默认 WebCrypto SHA-256。 */
  hashHex?: (text: string) => Promise<string>
  /** 时间源，便于测试。 */
  now?: () => number
  /** 延时函数，便于测试。 */
  sleep?: (ms: number) => Promise<void>
  /** prepareToken 有效期（毫秒），默认 30 分钟；过期需重新 prepare。 */
  prepareTtlMs?: number
}

// ==================== 常量 ====================

/** 审计存储键（chrome.storage.local）。 */
export const DIRECT_PUBLISH_AUDIT_STORAGE_KEY = 'fishops.directPublish.audit.v1'

/** 专用发布 tab 标记键 / 值：只复用严格匹配的 tab，绝不接管用户 tab。 */
const DEDICATED_MARKER_KEY = 'fishopsDirectPublish'
const DEDICATED_MARKER_VALUE = '1'

/** 默认专用发布页地址。 */
export const DEFAULT_DIRECT_PUBLISH_URL = `https://www.goofish.com/publish?${DEDICATED_MARKER_KEY}=${DEDICATED_MARKER_VALUE}`

const DEFAULT_LOAD_TIMEOUT_MS = 15000
const DEFAULT_INJECT_TIMEOUT_MS = 120000
const LOAD_POLL_MS = 250
/** prepareToken 默认有效期（毫秒）。 */
const DEFAULT_PREPARE_TTL_MS = 30 * 60 * 1000
/** prepared 会话存储键（chrome.storage.session，非落盘；SW 休眠不丢，浏览器重启 / 扩展重载清空）。 */
export const DIRECT_PUBLISH_PREPARED_SESSION_KEY = 'fishops.directPublish.prepared.v1'
/** prepared 会话条目上限：防止 propertyCards / rawCards 累积超过 storage.session 10MB 配额。 */
const PREPARED_SESSION_MAX_ENTRIES = 50
/** 已消耗 token 记录上限（用于区分「token 不存在」与「重复提交」）。 */
const PREPARED_CONSUMED_MAX_ENTRIES = 200
/** prepareToken 前缀（不可伪造：真实随机值仅存于内存缓存）。 */
const PREPARE_TOKEN_PREFIX = 'dpp_'
/**
 * 最终描述长度上限（= 描述 + 规格拼接后只追加一次的长度）。
 * 闲鱼商品无独立标题，不再以旧独立标题 30 字阈值校验；改按最终描述长度约束。
 */
const DRAFT_DESCRIPTION_MAX = 5000

/**
 * 严格解析专用发布页地址：必须 https + 主机 `www.goofish.com` + pathname 恰为 `/publish`
 * + 查询参数 `fishopsDirectPublish=1`。**绝不用 substring 判断**，避免恶意 / 相似 URL
 * （如 `https://www.goofish.com.evil.com/publish?fishopsDirectPublish=1`）被误复用。
 */
export function parseDedicatedPublishUrl(rawUrl: string | undefined): URL | null {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return null
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.hostname !== 'www.goofish.com') return null
  if (parsed.pathname !== '/publish') return null
  if (parsed.searchParams.get(DEDICATED_MARKER_KEY) !== DEDICATED_MARKER_VALUE) return null
  return parsed
}

// ==================== 内部工具 ====================

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** 单行化并截断错误信息（脱敏，不携带凭据 / 地址）。 */
function safeMessage(error: unknown): string {
  let text: string
  if (!error) text = '未知错误'
  else if (typeof error === 'string') text = error
  else if (error instanceof Error) text = error.message
  else if (isRecord(error) && typeof error['message'] === 'string') text = error['message']
  else text = '请求未成功返回预期数据'
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > 300 ? `${single.slice(0, 300)}…` : single
}

/** 确定性 JSON 序列化（对象键排序），保证同 input 指纹稳定。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

/** 默认 WebCrypto SHA-256 十六进制实现。 */
async function webCryptoSha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('WebCrypto 不可用')
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** 规范化入参（去空白、转字符串），用于指纹与页面请求。 */
function normalizeInput(input: DirectPublishInput): DirectPublishInput {
  const source = input.source
  let normalizedSource: DirectPublishSource
  if (isRecord(source) && 'product' in source) {
    const product = (source as { product: DirectPublishProductSource }).product
    normalizedSource = {
      product: {
        description: String(product?.description ?? '').trim(),
        price: String(product?.price ?? '').trim(),
        images: Array.isArray(product?.images) ? product.images.map((u) => String(u).trim()).filter(Boolean) : [],
        specifications: Array.isArray(product?.specifications)
          ? product.specifications.map((s) => ({ name: String(s?.name ?? '').trim(), value: String(s?.value ?? '').trim() }))
          : [],
      },
    }
  } else {
    const itemSource = source as { itemId: string | number; imageIndexes?: number[] }
    normalizedSource = {
      itemId: String(itemSource.itemId ?? '').trim(),
      ...(Array.isArray(itemSource.imageIndexes) ? { imageIndexes: itemSource.imageIndexes.slice() } : {}),
    }
  }
  return {
    source: normalizedSource,
    idempotencyKey: String(input.idempotencyKey ?? '').trim(),
    confirm: input.confirm === true,
    seller: {
      address: input.seller?.address ?? null,
      coordinates: input.seller?.coordinates ?? null,
    },
    servicePreferences: isRecord(input.servicePreferences) ? { ...input.servicePreferences } : {},
    confirmedNoQrCodes: input.confirmedNoQrCodes === true,
  }
}

/** 输入校验。 */
function validateInput(input: DirectPublishInput): { ok: true } | { ok: false; code: string; message: string } {
  if (!isRecord(input)) return { ok: false, code: 'INVALID_INPUT', message: '入参必须是对象' }
  if (!input.idempotencyKey || String(input.idempotencyKey).trim() === '') {
    return { ok: false, code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'idempotencyKey 不能为空' }
  }
  if (input.confirm !== true) {
    return { ok: false, code: 'CONFIRM_REQUIRED', message: '必须显式 confirm: true' }
  }
  if (input.confirmedNoQrCodes !== true) {
    return { ok: false, code: 'QR_CONFIRM_REQUIRED', message: '必须显式 confirmedNoQrCodes: true' }
  }
  const source = input.source
  if (!isRecord(source)) return { ok: false, code: 'SOURCE_REQUIRED', message: '缺少 source' }
  if ('product' in source) {
    const product = (source as { product: DirectPublishProductSource }).product
    if (!isRecord(product) || !product.description || !String(product.description).trim()) {
      return { ok: false, code: 'PRODUCT_DESCRIPTION_REQUIRED', message: 'source.product.description 不能为空' }
    }
    if (product.price === undefined || product.price === null || String(product.price).trim() === '') {
      return { ok: false, code: 'PRODUCT_PRICE_REQUIRED', message: 'source.product.price 不能为空（元字符串）' }
    }
    // 价格为精确元字符串：最多 2 位小数，不得静默解析为 0。
    const priceText = String(product.price).trim()
    if (!/^\d+(\.\d{1,2})?$/.test(priceText)) {
      return { ok: false, code: 'PRODUCT_PRICE_INVALID', message: 'source.product.price 必须为元字符串且最多 2 位小数' }
    }
    if (!Number.isFinite(Number(priceText)) || Number(priceText) <= 0) {
      return { ok: false, code: 'PRODUCT_PRICE_INVALID', message: 'source.product.price 必须为有限数值且大于 0 元' }
    }
    if (!Array.isArray(product.images) || product.images.length === 0) {
      return { ok: false, code: 'PRODUCT_IMAGES_REQUIRED', message: 'source.product.images 至少 1 张' }
    }
    // 规格逐项校验非空 name/value，禁止静默丢弃。
    if (product.specifications !== undefined && product.specifications !== null) {
      if (!Array.isArray(product.specifications)) {
        return { ok: false, code: 'PRODUCT_SPECIFICATIONS_INVALID', message: 'source.product.specifications 必须是数组' }
      }
      for (const spec of product.specifications) {
        if (
          !isRecord(spec) ||
          typeof spec['name'] !== 'string' ||
          spec['name'].trim() === '' ||
          typeof spec['value'] !== 'string' ||
          spec['value'].trim() === ''
        ) {
          return {
            ok: false,
            code: 'PRODUCT_SPECIFICATIONS_INVALID',
            message: 'specifications 每项必须包含非空 name/value，禁止静默丢弃',
          }
        }
      }
    }
  } else {
    const itemId = (source as { itemId: string | number }).itemId
    if (itemId === undefined || itemId === null || String(itemId).trim() === '') {
      return { ok: false, code: 'ITEM_ID_REQUIRED', message: 'source.itemId 不能为空' }
    }
  }
  const seller = input.seller
  if (!isRecord(seller) || (!seller.address && !seller.coordinates)) {
    return { ok: false, code: 'SELLER_REQUIRED', message: 'seller 必须配置 address 或 coordinates' }
  }
  return { ok: true }
}

/** 指纹材料：排除 confirm / idempotencyKey 本身。 */
function fingerprintMaterial(input: DirectPublishInput): unknown {
  return {
    source: input.source,
    seller: input.seller,
    servicePreferences: input.servicePreferences ?? {},
    confirmedNoQrCodes: input.confirmedNoQrCodes,
  }
}

// ==================== 审计账本 ====================

interface DirectPublishAuditEntry {
  accountScope: string
  idempotencyKey: string
  fingerprint: string
  status: 'attempting' | 'published' | 'rejected' | 'action_required' | 'unknown'
  at: string
  itemId?: string
  code?: string
  actionRequired?: string
}

interface DirectPublishLedger {
  version: 1
  entries: Record<string, DirectPublishAuditEntry>
}

const ledgerKey = (accountScope: string, idempotencyKey: string): string => `${accountScope}::${idempotencyKey}`

const AUDIT_ENTRY_REQUIRED_FIELDS = ['accountScope', 'idempotencyKey', 'fingerprint', 'status', 'at'] as const
const AUDIT_ENTRY_STATUSES = new Set(['attempting', 'published', 'rejected', 'action_required', 'unknown'])

/** 校验单条审计记录关键字段；损坏时抛出（fail-closed），绝不静默丢弃。 */
function assertAuditEntry(value: unknown): DirectPublishAuditEntry {
  if (!isRecord(value)) throw new Error('审计账本损坏：条目非对象')
  for (const field of AUDIT_ENTRY_REQUIRED_FIELDS) {
    const raw = value[field]
    if (typeof raw !== 'string' || raw === '') throw new Error(`审计账本损坏：条目缺少字段 ${field}`)
  }
  if (!AUDIT_ENTRY_STATUSES.has(value['status'] as string)) throw new Error('审计账本损坏：条目状态非法')
  for (const field of ['itemId', 'code', 'actionRequired'] as const) {
    const raw = value[field]
    if (raw !== undefined && typeof raw !== 'string') throw new Error(`审计账本损坏：字段 ${field} 类型非法`)
  }
  return {
    accountScope: value['accountScope'] as string,
    idempotencyKey: value['idempotencyKey'] as string,
    fingerprint: value['fingerprint'] as string,
    status: value['status'] as DirectPublishAuditEntry['status'],
    at: value['at'] as string,
    itemId: value['itemId'] as string | undefined,
    code: value['code'] as string | undefined,
    actionRequired: value['actionRequired'] as string | undefined,
  }
}

// ==================== 两阶段：prepare / submit ====================

/** 归一化后的 prepare 输入（仅内存）。 */
interface DirectPublishNormalizedPrepare {
  source: { product?: DirectPublishPageProduct; itemId?: string; imageIndexes?: number[] }
  idempotencyKey: string
  seller: { address: Record<string, string> | null; coordinates: { latitude: number; longitude: number } | null }
  confirmedNoQrCodes: boolean
  category?: Record<string, string>
  attributes?: Array<Record<string, unknown>>
}

/** 内存 prepared 缓存条目（**不落盘**，不含日志正文与个人地址）。 */
interface DirectPublishPreparedEntry {
  token: string
  accountScope: string
  tabId: number
  idempotencyKey: string
  inputFingerprint: string
  createdAt: number
  /** prepare 阶段生成的原始 payload（仅内存保留，不落盘、不打印）。 */
  basePayload: Record<string, unknown> | null
  draft: DirectPublishReviewDraft
  /** 已上传图片（权威，submit 只能在其中重排 / 删除）。 */
  images: Array<Record<string, unknown>>
  /** 候选卡（权威，submit 据此重建类目 / 属性）。 */
  propertyCards: DirectPublishPagePropertyCard[]
  /** 原始推荐卡片（service cards cpvList，仅内存）。 */
  rawCards: unknown[]
  /** prepare 时确认可用的服务。 */
  services: Array<{ serviceCode: string; enable: boolean }>
  /** prepare 时的发货地址（白名单字段）。 */
  address: Record<string, string>
}

/** session 中持久化的 prepared 条目（提交恢复所需权威字段；**不含** basePayload，避免撑爆配额）。 */
interface DirectPublishStoredPreparedEntry {
  token: string
  accountScope: string
  tabId: number
  idempotencyKey: string
  inputFingerprint: string
  createdAt: number
  draft: DirectPublishReviewDraft
  images: Array<Record<string, unknown>>
  propertyCards: DirectPublishPagePropertyCard[]
  rawCards: unknown[]
  services: Array<{ serviceCode: string; enable: boolean }>
  address: Record<string, string>
}

/** session prepared 存储根结构（version 固定 1，便于未来迁移）。 */
interface DirectPublishPreparedStore {
  version: 1
  /** token → 条目。 */
  entries: Record<string, DirectPublishStoredPreparedEntry>
  /** accountScope::idempotencyKey → token（按账号隔离，避免跨账号复用）。 */
  byKey: Record<string, string>
  /** 已消耗 token → 消耗时间（毫秒），用于区分「token 不存在」与「重复提交」。 */
  consumed: Record<string, number>
}

/** token 查找结果（session 路径可精确分类；旧内存路径归为 legacy_missing）。 */
type DirectPublishPreparedLookup =
  | { kind: 'ok'; entry: DirectPublishPreparedEntry }
  | { kind: 'expired' }
  | { kind: 'consumed' }
  | { kind: 'not_found' }
  | { kind: 'legacy_missing' }

const emptyPreparedStore = (): DirectPublishPreparedStore => ({ version: 1, entries: {}, byKey: {}, consumed: {} })

/** 由内存条目生成可序列化的 session 条目（**不含** basePayload：submit 不依赖，控制配额）。 */
function toStoredPreparedEntry(entry: DirectPublishPreparedEntry): DirectPublishStoredPreparedEntry {
  return {
    token: entry.token,
    accountScope: entry.accountScope,
    tabId: entry.tabId,
    idempotencyKey: entry.idempotencyKey,
    inputFingerprint: entry.inputFingerprint,
    createdAt: entry.createdAt,
    draft: entry.draft,
    images: entry.images,
    propertyCards: entry.propertyCards,
    rawCards: entry.rawCards,
    services: entry.services,
    address: entry.address,
  }
}

/** 由 session 条目还原内存条目（basePayload 无（旧一步式专用）→ null）。 */
function fromStoredPreparedEntry(stored: DirectPublishStoredPreparedEntry): DirectPublishPreparedEntry {
  return { ...stored, basePayload: null }
}

function isStoredImage(value: unknown): boolean {
  return isRecord(value) && typeof value['url'] === 'string' && value['url'] !== ''
}

function isStoredCardValue(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value['valueId'] !== 'string' || value['valueId'] === '') return false
  if (typeof value['valueName'] !== 'string') return false
  if (!isRecord(value['transportData'])) return false
  return typeof value['isCategory'] === 'boolean'
}

function isStoredPropertyCard(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value['propertyId'] !== 'string' || value['propertyId'] === '') return false
  if (typeof value['isCategory'] !== 'boolean') return false
  if (!Array.isArray(value['values'])) return false
  return value['values'].every(isStoredCardValue)
}

function isStoredService(value: unknown): boolean {
  return isRecord(value) && typeof value['serviceCode'] === 'string' && value['serviceCode'] !== ''
}

/** 校验 session 条目关键数据；任何缺失 / 非法一律返回 null（调用方 fail-closed 拒绝）。 */
function parseStoredPreparedEntry(value: unknown): DirectPublishStoredPreparedEntry | null {
  if (!isRecord(value)) return null
  const token = value['token']
  const accountScope = value['accountScope']
  const idempotencyKey = value['idempotencyKey']
  const inputFingerprint = value['inputFingerprint']
  const createdAt = value['createdAt']
  const tabId = value['tabId']
  if (typeof token !== 'string' || token === '') return null
  if (typeof accountScope !== 'string' || accountScope === '') return null
  if (typeof idempotencyKey !== 'string' || idempotencyKey === '') return null
  if (typeof inputFingerprint !== 'string' || inputFingerprint === '') return null
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
  if (typeof tabId !== 'number' || !Number.isFinite(tabId)) return null
  // draft 允许**无 title**（描述模式 title 可选）：仅要求为对象，其余字段在 submit 时严格归一化。
  if (!isRecord(value['draft'])) return null
  if (!Array.isArray(value['images']) || !value['images'].every(isStoredImage)) return null
  if (!Array.isArray(value['propertyCards']) || !value['propertyCards'].every(isStoredPropertyCard)) return null
  if (!Array.isArray(value['rawCards'])) return null
  if (!Array.isArray(value['services']) || !value['services'].every(isStoredService)) return null
  if (!isRecord(value['address'])) return null
  return {
    token,
    accountScope,
    idempotencyKey,
    inputFingerprint,
    createdAt,
    tabId,
    draft: value['draft'] as unknown as DirectPublishReviewDraft,
    images: value['images'] as Array<Record<string, unknown>>,
    propertyCards: value['propertyCards'] as DirectPublishPagePropertyCard[],
    rawCards: value['rawCards'],
    services: value['services'] as Array<{ serviceCode: string; enable: boolean }>,
    address: value['address'] as Record<string, string>,
  }
}

/** 校验整份 session prepared 存储；任何未知结构一律返回 null（fail-closed，绝不使用未知数据）。 */
function parsePreparedStore(value: unknown): DirectPublishPreparedStore | null {
  if (!isRecord(value)) return null
  if (value['version'] !== 1) return null
  const rawEntries = value['entries']
  const rawByKey = value['byKey']
  if (!isRecord(rawEntries) || !isRecord(rawByKey)) return null
  const entries: Record<string, DirectPublishStoredPreparedEntry> = {}
  for (const [token, entryValue] of Object.entries(rawEntries)) {
    const parsed = parseStoredPreparedEntry(entryValue)
    if (!parsed || parsed.token !== token) return null
    entries[token] = parsed
  }
  const byKey: Record<string, string> = {}
  for (const [key, token] of Object.entries(rawByKey)) {
    if (typeof token !== 'string' || !entries[token]) return null
    byKey[key] = token
  }
  const consumed: Record<string, number> = {}
  const rawConsumed = value['consumed']
  if (rawConsumed !== undefined) {
    if (!isRecord(rawConsumed)) return null
    for (const [token, at] of Object.entries(rawConsumed)) {
      if (typeof at !== 'number' || !Number.isFinite(at)) return null
      consumed[token] = at
    }
  }
  return { version: 1, entries, byKey, consumed }
}

/** 深拷贝普通对象（仅内存）。 */
function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

/** 深拷贝审核草稿（仅内存，避免调用方修改缓存）。 */
function cloneDraft(draft: DirectPublishReviewDraft): DirectPublishReviewDraft {
  return JSON.parse(JSON.stringify(draft)) as DirectPublishReviewDraft
}

/** 深拷贝候选卡（仅内存，避免调用方修改缓存中的权威 transportData）。 */
function clonePropertyCards(cards: DirectPublishPagePropertyCard[]): Array<Record<string, unknown>> {
  return JSON.parse(JSON.stringify(cards)) as Array<Record<string, unknown>>
}

const safeTextValue = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/**
 * 按最终确认选择重建 service cards 的 cpvList（从 prepare 原始推荐卡克隆），
 * 避免把旧推荐的 isClicked 状态带给 service.cards.list。仅更新 isClicked 标记，
 * 目录 / 属性的权威数据仍来自 prepare 缓存。
 */
function applySelectionToRawCards(
  rawCards: unknown,
  selection: Array<{ propertyId: string; valueId: string }>,
): unknown[] {
  if (!Array.isArray(rawCards)) return []
  const selected = new Map<string, Set<string>>()
  for (const item of selection) {
    if (!item.propertyId || !item.valueId) continue
    let set = selected.get(item.propertyId)
    if (!set) {
      set = new Set<string>()
      selected.set(item.propertyId, set)
    }
    set.add(item.valueId)
  }
  let clone: unknown[]
  try {
    clone = JSON.parse(JSON.stringify(rawCards)) as unknown[]
  } catch {
    return []
  }
  for (const card of clone) {
    if (!isRecord(card)) continue
    const cardData = isRecord(card['cardData']) ? (card['cardData'] as Record<string, unknown>) : card
    const propertyId = typeof cardData['propertyId'] === 'string' ? cardData['propertyId'] : ''
    const wanted = selected.get(propertyId)
    const values = Array.isArray(cardData['valuesList'])
      ? (cardData['valuesList'] as unknown[])
      : Array.isArray(cardData['values'])
        ? (cardData['values'] as unknown[])
        : []
    for (const value of values) {
      if (!isRecord(value)) continue
      const isCategory = propertyId === '-10000'
      const valueId = isCategory
        ? safeTextValue(value['channelCatId']) || safeTextValue(value['catId']) || safeTextValue(value['valueId'])
        : safeTextValue(value['valueId']) || safeTextValue(value['id'])
      const hit = Boolean(wanted && valueId && wanted.has(valueId))
      value['isClicked'] = hit ? '1' : '0'
      if (hit) value['isUserClick'] = '1'
    }
  }
  return clone
}

/** 白名单重建发货地址（丢弃未知字段，防未知字段注入；缺字段或 gps 非法返回 null）。 */
function sanitizeAddress(raw: Record<string, unknown>): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const key of ['prov', 'city', 'area', 'divisionId', 'poiName', 'poiId', 'gps'] as const) {
    const value = raw[key]
    if (typeof value !== 'string' || value.trim() === '') return null
    out[key] = value.trim()
  }
  // gps 需为 `lat,lng` 数值且经纬度在合法范围内（防 UI 只改 GPS 与 poiId 不一致却静默通过）。
  const gpsParts = out['gps'].split(',')
  if (gpsParts.length !== 2) return null
  const lat = Number(gpsParts[0])
  const lng = Number(gpsParts[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return out
}

/** 候选匹配类目 / 属性取值。 */
function candidateMatches(candidate: DirectPublishPageCardValue, wanted: string[]): boolean {
  return (
    wanted.indexOf(candidate.valueId) !== -1 ||
    (candidate.catId !== undefined && wanted.indexOf(candidate.catId) !== -1) ||
    (candidate.channelCatId !== undefined && wanted.indexOf(candidate.channelCatId) !== -1)
  )
}

/** 按权威候选重建平台 label item（transportData 取自候选，不信任前端字段）。 */
function buildLabelItemFromCard(
  card: DirectPublishPagePropertyCard,
  candidate: DirectPublishPageCardValue,
): Record<string, unknown> {
  const base = isRecord(candidate.transportData) ? cloneRecord(candidate.transportData) : {}
  const labelItem: Record<string, unknown> = {
    ...base,
    propertyName: card.propertyName,
    propertyId: card.propertyId,
    isUserClick: '1',
    isUserCancel: '0',
    text: candidate.valueName,
    properties: `${card.propertyId}##${card.propertyName}:${candidate.valueId}##${candidate.valueName}`,
  }
  if (candidate.isCategory) {
    if (labelItem['channelCateId'] === undefined) labelItem['channelCateId'] = candidate.channelCatId || candidate.catId || ''
    if (labelItem['channelCateName'] === undefined) labelItem['channelCateName'] = candidate.catName || candidate.valueName
  } else {
    if (labelItem['valueId'] === undefined) labelItem['valueId'] = candidate.valueId
    if (labelItem['valueName'] === undefined) labelItem['valueName'] = candidate.valueName
  }
  return labelItem
}

/** prepare 入参校验。 */
function validatePrepareInput(
  input: DirectPublishPrepareRequest,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!isRecord(input)) return { ok: false, code: 'INVALID_INPUT', message: '入参必须是对象' }
  if (!input.idempotencyKey || String(input.idempotencyKey).trim() === '') {
    return { ok: false, code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'idempotencyKey 不能为空' }
  }
  // 两阶段不再要求 confirmedNoQrCodes（图片自动上传）与 seller（缺省时自动取账号官方默认地址）。
  const source = input.source
  if (!isRecord(source)) return { ok: false, code: 'SOURCE_REQUIRED', message: '缺少 source' }
  if ('product' in source) {
    const product = (source as { product: DirectPublishPageProduct }).product
    if (!isRecord(product) || !product.description || String(product.description).trim() === '') {
      return { ok: false, code: 'PRODUCT_DESCRIPTION_REQUIRED', message: 'source.product.description 不能为空' }
    }
    const priceText = String(product.price ?? '').trim()
    if (!/^\d+(\.\d{1,2})?$/.test(priceText) || !Number.isFinite(Number(priceText)) || Number(priceText) <= 0) {
      return { ok: false, code: 'PRODUCT_PRICE_INVALID', message: 'source.product.price 必须为元字符串、有限数值且大于 0，最多 2 位小数' }
    }
    if (!Array.isArray(product.images) || product.images.length === 0) {
      return { ok: false, code: 'PRODUCT_IMAGES_REQUIRED', message: 'source.product.images 至少 1 张' }
    }
    if (product.specifications !== undefined && product.specifications !== null) {
      if (!Array.isArray(product.specifications)) {
        return { ok: false, code: 'PRODUCT_SPECIFICATIONS_INVALID', message: 'source.product.specifications 必须是数组' }
      }
      for (const spec of product.specifications) {
        if (
          !isRecord(spec) ||
          typeof spec['name'] !== 'string' ||
          spec['name'].trim() === '' ||
          typeof spec['value'] !== 'string' ||
          spec['value'].trim() === ''
        ) {
          return {
            ok: false,
            code: 'PRODUCT_SPECIFICATIONS_INVALID',
            message: 'specifications 每项必须包含非空 name/value，禁止静默丢弃',
          }
        }
      }
    }
  } else {
    const itemId = (source as { itemId?: string | number }).itemId
    if (itemId === undefined || itemId === null || String(itemId).trim() === '') {
      return { ok: false, code: 'ITEM_ID_REQUIRED', message: 'source.itemId 不能为空' }
    }
  }
  return { ok: true }
}

/** 规范化 prepare 入参。 */
function normalizePrepareInput(input: DirectPublishPrepareRequest): DirectPublishNormalizedPrepare {
  const source = input.source
  let normalizedSource: DirectPublishNormalizedPrepare['source']
  if (isRecord(source) && 'product' in source) {
    const product = (source as { product: DirectPublishPageProduct }).product
    normalizedSource = {
      product: {
        // 闲鱼商品无独立标题：旧 product.title 被忽略，不进入归一化结果 / 指纹 / 页面请求。
        description: String(product?.description ?? '').trim(),
        price: String(product?.price ?? '').trim(),
        images: Array.isArray(product?.images) ? product.images.map((u) => String(u).trim()).filter(Boolean) : [],
        specifications: Array.isArray(product?.specifications)
          ? product.specifications.map((s) => ({ name: String(s?.name ?? '').trim(), value: String(s?.value ?? '').trim() }))
          : [],
      },
    }
  } else {
    const itemSource = source as { itemId: string | number; imageIndexes?: number[] }
    normalizedSource = {
      itemId: String(itemSource?.itemId ?? '').trim(),
      ...(Array.isArray(itemSource?.imageIndexes) ? { imageIndexes: itemSource.imageIndexes.slice() } : {}),
    }
  }
  const seller = input.seller
  return {
    source: normalizedSource,
    idempotencyKey: String(input.idempotencyKey ?? '').trim(),
    seller: {
      address: isRecord(seller) && isRecord(seller['address']) ? (seller['address'] as Record<string, string>) : null,
      coordinates: isRecord(seller) && isRecord(seller['coordinates'])
        ? {
            latitude: Number((seller['coordinates'] as Record<string, unknown>)['latitude']),
            longitude: Number((seller['coordinates'] as Record<string, unknown>)['longitude']),
          }
        : null,
    },
    confirmedNoQrCodes: input.confirmedNoQrCodes === true,
    ...(input.category !== undefined ? { category: input.category } : {}),
    ...(input.attributes !== undefined ? { attributes: input.attributes } : {}),
  }
}

/** 严格校验并归一化 submit 草稿（白名单编辑；未知字段 / 非候选值一律拒绝）。 */
type DirectPublishDraftNormalizeResult =
  | { ok: true; core: DirectPublishPageSubmitCore; selection: Array<{ propertyId: string; valueId: string }> }
  | { ok: false; code: string; message: string }

function normalizeSubmitDraft(
  entry: DirectPublishPreparedEntry,
  raw: unknown,
): DirectPublishDraftNormalizeResult {
  if (!isRecord(raw)) return { ok: false, code: 'DRAFT_INVALID', message: 'draft 必须是对象' }

  // 描述：唯一文案（闲鱼商品无独立标题），必填。**不信任旧 title 字段**，避免同描述不同隐形 title
  // 产生指纹冲突；旧 title 一律忽略。
  if (typeof raw['description'] !== 'string') {
    return { ok: false, code: 'DRAFT_DESCRIPTION_INVALID', message: 'description 必须是字符串' }
  }
  const description = raw['description'].trim()
  if (!description) {
    return { ok: false, code: 'DRAFT_DESCRIPTION_INVALID', message: 'description 不能为空' }
  }

  // 价格
  if (typeof raw['price'] !== 'string' || !/^\d+(\.\d{1,2})?$/.test(raw['price'].trim())) {
    return { ok: false, code: 'DRAFT_PRICE_INVALID', message: 'price 必须为元字符串且最多 2 位小数' }
  }
  const price = raw['price'].trim()
  if (!Number.isFinite(Number(price)) || Number(price) <= 0) {
    return { ok: false, code: 'DRAFT_PRICE_INVALID', message: 'price 必须为有限数值且大于 0 元' }
  }

  // 规格
  const specifications: Array<{ name: string; value: string }> = []
  if (raw['specifications'] !== undefined) {
    if (!Array.isArray(raw['specifications'])) {
      return { ok: false, code: 'DRAFT_SPECIFICATIONS_INVALID', message: 'specifications 必须是数组' }
    }
    for (const spec of raw['specifications']) {
      if (!isRecord(spec)) return { ok: false, code: 'DRAFT_SPECIFICATIONS_INVALID', message: '规格项必须是对象' }
      const name = spec['name']
      const value = spec['value']
      if (typeof name !== 'string' || name.trim() === '' || typeof value !== 'string' || value.trim() === '') {
        return { ok: false, code: 'DRAFT_SPECIFICATIONS_INVALID', message: 'specifications 每项必须包含非空 name/value' }
      }
      specifications.push({ name: name.trim(), value: value.trim() })
    }
  }

  // 最终描述 = 描述 + 规格（只追加一次）；按**拼接后长度**校验（2 阶段无独立标题）。
  const finalDescText =
    specifications.length > 0
      ? description + '\n' + specifications.map((s) => s.name + '：' + s.value).join('\n')
      : description
  if (finalDescText.length > DRAFT_DESCRIPTION_MAX) {
    return {
      ok: false,
      code: 'DRAFT_DESCRIPTION_INVALID',
      message: `最终描述（含规格追加）不能超过 ${DRAFT_DESCRIPTION_MAX} 字`,
    }
  }

  // 类目：必须命中已准备网页支持候选
  if (!isRecord(raw['category'])) return { ok: false, code: 'DRAFT_CATEGORY_INVALID', message: 'category 必须是对象' }
  const category = raw['category']
  const categoryCard = entry.propertyCards.find((card) => card.isCategory)
  if (!categoryCard) {
    return { ok: false, code: 'DRAFT_CATEGORY_INVALID', message: '本轮未准备类目候选，禁止更换类目' }
  }
  const wantedCategory = [category['catId'], category['channelCatId'], category['valueId']].filter(
    (value): value is string => typeof value === 'string' && value !== '',
  )
  const categoryCandidate = categoryCard.values.find((candidate) => candidateMatches(candidate, wantedCategory))
  if (!categoryCandidate) {
    return { ok: false, code: 'DRAFT_CATEGORY_INVALID', message: '类目不在已准备网页支持的候选内，拒绝发布' }
  }
  const itemCatDTO: Record<string, string> = {
    catId: categoryCandidate.catId || categoryCandidate.valueId,
    catName: categoryCandidate.catName || categoryCandidate.valueName,
    channelCatId: categoryCandidate.channelCatId || categoryCandidate.valueId,
    leafId: categoryCandidate.leafId || '0',
    tbCatId: categoryCandidate.tbCatId || '',
  }
  const itemLabelExtList: Record<string, unknown>[] = [buildLabelItemFromCard(categoryCard, categoryCandidate)]
  const selection: Array<{ propertyId: string; valueId: string }> = [
    { propertyId: '-10000', valueId: categoryCandidate.valueId },
  ]

  // 属性：必须命中候选值，按候选 transportData 重建
  if (!Array.isArray(raw['attributes'])) {
    return { ok: false, code: 'DRAFT_ATTRIBUTES_INVALID', message: 'attributes 必须是数组' }
  }
  for (const attribute of raw['attributes']) {
    if (!isRecord(attribute)) return { ok: false, code: 'DRAFT_ATTRIBUTES_INVALID', message: '属性项必须是对象' }
    const propertyId = typeof attribute['propertyId'] === 'string' ? attribute['propertyId'] : ''
    if (!propertyId || propertyId === '-10000') continue // 类目由 category 统一处理
    const valueId = typeof attribute['valueId'] === 'string' ? attribute['valueId'] : ''
    const card = entry.propertyCards.find((item) => item.propertyId === propertyId)
    if (!card) return { ok: false, code: 'DRAFT_ATTRIBUTE_INVALID', message: `属性 ${propertyId} 不在已准备候选内` }
    const candidate = card.values.find((item) => item.valueId === valueId)
    if (!candidate) return { ok: false, code: 'DRAFT_ATTRIBUTE_INVALID', message: `属性 ${propertyId} 的取值不在候选内` }
    itemLabelExtList.push(buildLabelItemFromCard(card, candidate))
    selection.push({ propertyId, valueId: candidate.valueId })
  }

  // 地址：白名单重建
  if (!isRecord(raw['address'])) return { ok: false, code: 'DRAFT_ADDRESS_INVALID', message: 'address 必须是对象' }
  const itemAddrDTO = sanitizeAddress(raw['address'])
  if (!itemAddrDTO) {
    return { ok: false, code: 'DRAFT_ADDRESS_INVALID', message: 'address 需含 prov/city/area/divisionId/poiName/poiId/gps' }
  }

  // 图片：只能从已上传集合中重排 / 删除
  if (!Array.isArray(raw['images'])) return { ok: false, code: 'DRAFT_IMAGES_INVALID', message: 'images 必须是数组' }
  if (raw['images'].length === 0) return { ok: false, code: 'DRAFT_IMAGES_INVALID', message: '至少保留 1 张图片' }
  const imageInfoDOList: Record<string, unknown>[] = []
  const seenUrls = new Set<string>()
  for (const image of raw['images']) {
    if (!isRecord(image) || typeof image['url'] !== 'string' || image['url'].trim() === '') {
      return { ok: false, code: 'DRAFT_IMAGE_INVALID', message: '图片必须是已上传图片对象（含 url）' }
    }
    const url = image['url'].trim()
    const cachedImage = entry.images.find((item) => item['url'] === url)
    if (!cachedImage) {
      return { ok: false, code: 'DRAFT_IMAGE_INVALID', message: '图片不在已上传集合内，禁止伪造上传图片数据' }
    }
    if (seenUrls.has(url)) return { ok: false, code: 'DRAFT_IMAGE_INVALID', message: '图片重复' }
    seenUrls.add(url)
    imageInfoDOList.push(cloneRecord(cachedImage))
  }
  if (imageInfoDOList.length > 9) return { ok: false, code: 'DRAFT_IMAGES_INVALID', message: '图片最多 9 张' }
  imageInfoDOList.forEach((image, index) => {
    image['major'] = index === 0
  })

  // 服务：只能启用已准备可用服务；AI_SALE 强制 false
  if (!Array.isArray(raw['services'])) return { ok: false, code: 'DRAFT_SERVICES_INVALID', message: 'services 必须是数组' }
  const allowedServices = new Set(entry.services.map((service) => service.serviceCode))
  const services: Array<{ serviceCode: string; enable: boolean }> = []
  const seenServices = new Set<string>()
  for (const service of raw['services']) {
    if (!isRecord(service) || typeof service['serviceCode'] !== 'string') {
      return { ok: false, code: 'DRAFT_SERVICES_INVALID', message: '服务项必须含 serviceCode' }
    }
    const serviceCode = service['serviceCode']
    if (!allowedServices.has(serviceCode)) {
      return { ok: false, code: 'DRAFT_SERVICE_INVALID', message: `服务 ${serviceCode} 不在已准备可用服务内` }
    }
    if (seenServices.has(serviceCode)) continue
    seenServices.add(serviceCode)
    services.push({ serviceCode, enable: serviceCode === 'AI_SALE' ? false : service['enable'] === true })
  }

  return {
    ok: true,
    core: {
      // 兼容结构：2 阶段无独立标题，统一以 description 填充；页面最终 payload 不使用该字段。
      title: description,
      description,
      priceYuan: price,
      specifications,
      itemCatDTO,
      itemLabelExtList,
      itemAddrDTO,
      imageInfoDOList,
      services,
    },
    selection,
  }
}

/** submit 入参结构校验（confirm / categoryConfirmed / confirmedNoQrCodes 必须显式 true）。 */
function validateSubmitInput(
  input: DirectPublishSubmitRequest,
): { ok: true } | { ok: false; code: string; message: string } {
  if (!isRecord(input)) return { ok: false, code: 'INVALID_INPUT', message: '入参必须是对象' }
  if (typeof input.prepareToken !== 'string' || input.prepareToken.trim() === '') {
    return { ok: false, code: 'PREPARE_TOKEN_REQUIRED', message: '缺少 prepareToken' }
  }
  if (input.confirm !== true) return { ok: false, code: 'CONFIRM_REQUIRED', message: '必须显式 confirm: true' }
  if (!isRecord(input.draft)) return { ok: false, code: 'DRAFT_INVALID', message: 'draft 必须是对象' }
  // 两阶段不再要求 categoryConfirmed / confirmedNoQrCodes（旧字段仅保留为可选兼容）。
  return { ok: true }
}

// ==================== API 实现 ====================

/**
 * 创建直接发布 API。
 *
 * 传入 chrome 子集即可在 Node 中用 mock 完整测试；所有网络请求都发生在注入的页面脚本内。
 */
export function createDirectPublishApi(deps: DirectPublishApiDeps): DirectPublishApi {
  const { tabs, scripting, storage } = deps.chrome
  const publishUrl = deps.publishUrl ?? DEFAULT_DIRECT_PUBLISH_URL
  const loadTimeoutMs = deps.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
  const injectTimeoutMs = deps.injectTimeoutMs ?? DEFAULT_INJECT_TIMEOUT_MS
  const hashHex = deps.hashHex ?? webCryptoSha256Hex
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const prepareTtlMs = deps.prepareTtlMs ?? DEFAULT_PREPARE_TTL_MS
  // 自定义 publishUrl 也必须通过严格校验，否则直接 fail-closed 拒绝发布。
  const publishUrlError: string | null = parseDedicatedPublishUrl(publishUrl)
    ? null
    : '专用发布页地址非法：必须为 https://www.goofish.com/publish?fishopsDirectPublish=1'

  /** 专用发布 tab 缓存（只复用带标记的自建 tab）。 */
  let cachedTabId: number | null = null
  /** 同步全局发布锁：防止同一 service worker 内并发 publish。 */
  let publishInFlight = false
  /** 同步全局提交锁：防止同一 service worker 内并发 submit。 */
  let submitInFlight = false
  /** 注入串行化队列：避免 prepare/publish/submit/getProduct 在同一 tab 上并发注入。 */
  let tabQueue: Promise<unknown> = Promise.resolve()

  /** storage.session 能力（会话内存、非落盘）；缺失时退化为旧的内存缓存（旧 mock 兼容）。 */
  const sessionStorage: DirectPublishStorageSessionApi | null =
    typeof storage.session?.get === 'function' && typeof storage.session?.set === 'function' ? storage.session : null
  const hasSession = sessionStorage !== null

  /** 旧的内存 prepared 缓存（仅在无 storage.session 的环境使用）；不落盘。 */
  const preparedCache = new Map<string, DirectPublishPreparedEntry>()
  const preparedByKey = new Map<string, string>()

  /** 生成不可伪造的 prepareToken：真实随机值仅存于 prepared 存储。 */
  const generatePrepareToken = (): string => {
    const uuid = globalThis.crypto?.randomUUID?.()
    const random = uuid ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
    return PREPARE_TOKEN_PREFIX + random.replace(/-/g, '')
  }

  const isEntryExpired = (entry: DirectPublishPreparedEntry): boolean => now() - entry.createdAt > prepareTtlMs

  /** 清理内存缓存过期条目（仅内存路径使用）。 */
  const prunePrepared = (): void => {
    for (const [token, entry] of preparedCache) {
      if (isEntryExpired(entry)) {
        preparedCache.delete(token)
        const cacheKey = ledgerKey(entry.accountScope, entry.idempotencyKey)
        if (preparedByKey.get(cacheKey) === token) preparedByKey.delete(cacheKey)
      }
    }
  }

  // ---- prepared 会话存储（chrome.storage.session，非落盘） ----
  // 同一 SW 实例内串行化「读改写」，避免并发覆盖丢失（storage.session 无分布式锁，仅靠单 SW 实例）。
  let preparedWriteQueue: Promise<unknown> = Promise.resolve()
  function withPreparedWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = preparedWriteQueue.then(fn, fn)
    preparedWriteQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** 读取并校验 session prepared 存储；键不存在返回空存储，结构损坏抛错（fail-closed）。 */
  async function readPreparedStore(): Promise<DirectPublishPreparedStore> {
    if (!sessionStorage) throw new Error('storage.session 不可用')
    const raw = await sessionStorage.get(DIRECT_PUBLISH_PREPARED_SESSION_KEY)
    const hasKey = isRecord(raw) && DIRECT_PUBLISH_PREPARED_SESSION_KEY in raw
    if (!hasKey) return emptyPreparedStore()
    const parsed = parsePreparedStore((raw as Record<string, unknown>)[DIRECT_PUBLISH_PREPARED_SESSION_KEY])
    if (!parsed) throw new Error('prepared 会话存储损坏（fail-closed）')
    return parsed
  }

  async function writePreparedStore(store: DirectPublishPreparedStore): Promise<void> {
    if (!sessionStorage) throw new Error('storage.session 不可用')
    await sessionStorage.set({ [DIRECT_PUBLISH_PREPARED_SESSION_KEY]: store })
  }

  /** 从存储中移除条目并同步清理索引。 */
  function removeStoredEntry(store: DirectPublishPreparedStore, token: string): void {
    const entry = store.entries[token]
    delete store.entries[token]
    if (entry) {
      const cacheKey = ledgerKey(entry.accountScope, entry.idempotencyKey)
      if (store.byKey[cacheKey] === token) delete store.byKey[cacheKey]
    }
  }

  /** 有界清理：TTL 过期 + 条目上限（保护 storage.session 10MB 配额）。 */
  function prunePreparedStore(store: DirectPublishPreparedStore): void {
    for (const [token, entry] of Object.entries(store.entries)) {
      if (now() - entry.createdAt > prepareTtlMs) removeStoredEntry(store, token)
    }
    const tokens = Object.keys(store.entries)
    if (tokens.length > PREPARED_SESSION_MAX_ENTRIES) {
      tokens
        .sort((a, b) => (store.entries[a]?.createdAt ?? 0) - (store.entries[b]?.createdAt ?? 0))
        .slice(0, tokens.length - PREPARED_SESSION_MAX_ENTRIES)
        .forEach((token) => removeStoredEntry(store, token))
    }
    for (const token of Object.keys(store.consumed)) {
      if (now() - (store.consumed[token] ?? 0) > prepareTtlMs) delete store.consumed[token]
    }
    const consumedTokens = Object.keys(store.consumed)
    if (consumedTokens.length > PREPARED_CONSUMED_MAX_ENTRIES) {
      consumedTokens
        .sort((a, b) => (store.consumed[a] ?? 0) - (store.consumed[b] ?? 0))
        .slice(0, consumedTokens.length - PREPARED_CONSUMED_MAX_ENTRIES)
        .forEach((token) => delete store.consumed[token])
    }
  }

  /** 持久化一名 prepared 条目（session 权威）。 */
  async function persistPreparedEntry(entry: DirectPublishPreparedEntry): Promise<void> {
    const stored = toStoredPreparedEntry(entry)
    await withPreparedWrite(async () => {
      const store = await readPreparedStore()
      store.entries[stored.token] = stored
      store.byKey[ledgerKey(stored.accountScope, stored.idempotencyKey)] = stored.token
      prunePreparedStore(store)
      await writePreparedStore(store)
    })
  }

  /**
   * 按 token 查找 prepared：
   * - session 路径：区分 ok / expired / consumed / not_found；
   * - 内存路径（旧 mock）：保持旧语义，legacy_missing 由调用方归为 PREPARE_EXPIRED。
   */
  async function lookupPreparedByToken(token: string): Promise<DirectPublishPreparedLookup> {
    if (!sessionStorage) {
      prunePrepared()
      const entry = preparedCache.get(token)
      if (!entry) return { kind: 'legacy_missing' }
      if (isEntryExpired(entry)) return { kind: 'expired' }
      return { kind: 'ok', entry }
    }
    const store = await readPreparedStore()
    const stored = store.entries[token]
    if (!stored) return token in store.consumed ? { kind: 'consumed' } : { kind: 'not_found' }
    if (now() - stored.createdAt > prepareTtlMs) return { kind: 'expired' }
    return { kind: 'ok', entry: fromStoredPreparedEntry(stored) }
  }

  /** 按 accountScope::idempotencyKey 查找（幂等复用；session 优先，回退内存）。 */
  async function lookupPreparedByKey(cacheKey: string): Promise<DirectPublishPreparedEntry | null> {
    if (!sessionStorage) {
      prunePrepared()
      const token = preparedByKey.get(cacheKey)
      if (!token) return null
      const entry = preparedCache.get(token)
      if (!entry || isEntryExpired(entry)) {
        preparedByKey.delete(cacheKey)
        preparedCache.delete(token)
        return null
      }
      return entry
    }
    const store = await readPreparedStore()
    const token = store.byKey[cacheKey]
    if (!token) return null
    const stored = store.entries[token]
    if (!stored) return null
    if (now() - stored.createdAt > prepareTtlMs) return null
    return fromStoredPreparedEntry(stored)
  }

  /** 消耗 token：移除条目并记录 consumed（用于区分重复提交）；成功后才真正提交。 */
  async function consumePreparedEntry(entry: DirectPublishPreparedEntry): Promise<void> {
    if (!sessionStorage) {
      preparedCache.delete(entry.token)
      const cacheKey = ledgerKey(entry.accountScope, entry.idempotencyKey)
      if (preparedByKey.get(cacheKey) === entry.token) preparedByKey.delete(cacheKey)
      return
    }
    await withPreparedWrite(async () => {
      const store = await readPreparedStore()
      removeStoredEntry(store, entry.token)
      store.consumed[entry.token] = now()
      prunePreparedStore(store)
      await writePreparedStore(store)
    })
  }

  /**
   * 恢复已被 consume 的 prepared 条目（**仅用于明确业务拒绝**场景）。
   *
   * 业务拒绝发生在最终 publish 被服务端明确拒绝时，此时 token 已消耗；恢复后：
   * - 条目重新可被同 token 命中，前端可改稿后手动重提；
   * - 清空 consumed 标识，避免被误判为重复提交；
   * - 沿用原权威 candidate / 已上传图，**不重新 prepare、不重复上传**；
   * - 写入失败向上抛，由调用方 fail-closed（绝不假装可重试）。
   */
  async function restorePreparedEntry(entry: DirectPublishPreparedEntry): Promise<void> {
    if (!sessionStorage) {
      // 旧内存路径：放回缓存与索引（无 consumed 概念）。
      preparedCache.set(entry.token, entry)
      preparedByKey.set(ledgerKey(entry.accountScope, entry.idempotencyKey), entry.token)
      return
    }
    const stored = toStoredPreparedEntry(entry)
    await withPreparedWrite(async () => {
      const store = await readPreparedStore()
      store.entries[stored.token] = stored
      store.byKey[ledgerKey(stored.accountScope, stored.idempotencyKey)] = stored.token
      delete store.consumed[stored.token]
      prunePreparedStore(store)
      await writePreparedStore(store)
    })
  }

  function withTabLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = tabQueue.then(fn, fn)
    tabQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  const isDedicatedTab = (url: string | undefined): boolean => parseDedicatedPublishUrl(url) !== null

  async function readLedger(): Promise<DirectPublishLedger> {
    const raw = await storage.local.get(DIRECT_PUBLISH_AUDIT_STORAGE_KEY)
    // 仅当键不存在时才初始化空账本；键存在但内容损坏则抛错（fail-closed）。
    const hasKey = isRecord(raw) && DIRECT_PUBLISH_AUDIT_STORAGE_KEY in raw
    if (!hasKey) return { version: 1, entries: {} }
    const value = (raw as Record<string, unknown>)[DIRECT_PUBLISH_AUDIT_STORAGE_KEY]
    if (!isRecord(value)) throw new Error('审计账本损坏：根节点非对象')
    if (value['version'] !== 1) throw new Error('审计账本损坏：版本不支持')
    if (!isRecord(value['entries'])) throw new Error('审计账本损坏：entries 非对象')
    const entries: Record<string, DirectPublishAuditEntry> = {}
    for (const [entryKey, entryValue] of Object.entries(value['entries'])) {
      entries[entryKey] = assertAuditEntry(entryValue)
    }
    return { version: 1, entries }
  }

  async function writeLedger(ledger: DirectPublishLedger): Promise<void> {
    await storage.local.set({ [DIRECT_PUBLISH_AUDIT_STORAGE_KEY]: ledger })
  }

  async function upsertEntry(key: string, entry: DirectPublishAuditEntry): Promise<void> {
    const ledger = await readLedger()
    ledger.entries[key] = entry
    await writeLedger(ledger)
  }

  /** 等待专用 tab 加载完成（有界轮询，不无限等待）。 */
  async function waitForTabComplete(tabId: number): Promise<boolean> {
    const deadline = now() + loadTimeoutMs
    for (;;) {
      let tab: DirectPublishTabLike | null = null
      try {
        tab = await tabs.get(tabId)
      } catch {
        return false
      }
      if (!tab) return false
      if (tab.status === 'complete') return true
      if (now() >= deadline) return false
      await sleep(LOAD_POLL_MS)
    }
  }

  /** 复用或创建专用非激活发布 tab；绝不接管用户 tab。 */
  async function ensureDedicatedTab(): Promise<{ ok: true; tabId: number } | { ok: false; message: string }> {
    if (publishUrlError) return { ok: false, message: publishUrlError }
    if (cachedTabId !== null) {
      try {
        const cached = await tabs.get(cachedTabId)
        if (cached && isDedicatedTab(cached.url)) return { ok: true, tabId: cachedTabId }
      } catch {
        // 缓存失效，继续查找 / 创建
      }
      cachedTabId = null
    }

    try {
      const all = await tabs.query({})
      const dedicated = all.filter((tab) => typeof tab.id === 'number' && isDedicatedTab(tab.url))
      if (dedicated.length > 0) {
        const chosen = dedicated[0] as DirectPublishTabLike & { id: number }
        cachedTabId = chosen.id
        if (chosen.status === 'complete' || (await waitForTabComplete(chosen.id))) {
          return { ok: true, tabId: chosen.id }
        }
        return { ok: false, message: '专用发布页加载超时' }
      }
    } catch {
      // 查询失败则尝试新建
    }

    let created: DirectPublishTabLike
    try {
      created = await tabs.create({ url: publishUrl, active: false })
    } catch (error) {
      return { ok: false, message: `创建专用发布页失败：${safeMessage(error)}` }
    }
    if (typeof created.id !== 'number') {
      return { ok: false, message: '创建的专用发布页缺少 tab id' }
    }
    cachedTabId = created.id
    if (created.status === 'complete' || (await waitForTabComplete(created.id))) {
      return { ok: true, tabId: created.id }
    }
    return { ok: false, message: '专用发布页加载超时' }
  }

  /** 注入一次页面脚本调用（带注入超时，超时归 unknown 且不重试）。 */
  async function inject(tabId: number, request: DirectPublishPageRequest): Promise<DirectPublishPageResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const traceId = crypto.randomUUID()
    const startedAt = now()
    // 不记录 request/result 全量对象，避免商品正文、地址和验证码参数进入日志。
    const logResult = (result: DirectPublishPageResult): DirectPublishPageResult => {
      const code = result.code && /^[A-Z0-9_]{1,80}$/.test(result.code) ? result.code : undefined
      const record = { traceId, phase: request.op, tabId, status: result.status, code,
        actionRequired: result.actionRequired, durationMs: now() - startedAt }
      try {
        if (result.ok) console.info('[FishOps:DirectPublish:Background]', record)
        else console.warn('[FishOps:DirectPublish:Background]', record)
      } catch {
        // 日志不可用不能改变发布状态。
      }
      return result
    }
    try {
      const execution = scripting.executeScript<DirectPublishPageResult>({
        target: { tabId },
        world: 'MAIN',
        args: [{ ...request, traceId }],
        func: injectDirectPublishInPage,
      })
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PAGE_INJECTION_TIMEOUT')), injectTimeoutMs)
      })
      const results = await Promise.race([execution, timeout])
      const first = Array.isArray(results) ? results[0] : undefined
      const result = first?.result
      if (!isRecord(result)) {
        return logResult({ ok: false, op: request.op, status: 'unknown', code: 'PAGE_NO_RESULT', message: '页面脚本未返回有效结果' })
      }
      return logResult(result as unknown as DirectPublishPageResult)
    } catch (error) {
      const isTimeout = error instanceof Error && error.message === 'PAGE_INJECTION_TIMEOUT'
      return logResult({
        ok: false,
        op: request.op,
        status: 'unknown',
        code: isTimeout ? 'PAGE_INJECTION_TIMEOUT' : 'PAGE_INJECTION_FAILED',
        message: isTimeout
          ? '页面注入超时，结果未知（可能已产生上传等副作用），禁止自动重试'
          : `页面注入失败：${safeMessage(error)}`,
      })
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /** 页面失败结果 → 归一化发布结果。 */
  function mapPageResult(result: DirectPublishPageResult, idempotencyKey: string): DirectPublishResult {
    if (result.status === 'published' && result.itemId) {
      return { status: 'published', idempotencyKey, itemId: result.itemId, warnings: result.warnings }
    }
    if (result.status === 'action_required') {
      return {
        status: 'action_required',
        idempotencyKey,
        actionRequired: result.actionRequired ?? 'login',
        code: result.code,
        message: result.message,
      }
    }
    if (result.status === 'rejected') {
      return { status: 'rejected', idempotencyKey, code: result.code, message: result.message }
    }
    return { status: 'unknown', idempotencyKey, code: result.code ?? 'UNKNOWN', message: result.message }
  }

  async function publish(input: DirectPublishInput): Promise<DirectPublishResult> {
    const key = String(input?.idempotencyKey ?? '')
    const validation = validateInput(input)
    if (!validation.ok) {
      return { status: 'rejected', idempotencyKey: key, code: validation.code, message: validation.message }
    }

    // 同步全局锁：调用前立即加锁，防止并发重复提交。
    if (publishInFlight) {
      return {
        status: 'rejected',
        idempotencyKey: key,
        code: 'CONCURRENT_LOCK',
        message: '已有发布请求正在执行，禁止并发触发',
      }
    }
    publishInFlight = true

    try {
      return await withTabLock(async () => {
        const normalized = normalizeInput(input)
        const idempotencyKey = normalized.idempotencyKey
        let fingerprint: string
        try {
          fingerprint = await hashHex(stableStringify(fingerprintMaterial(normalized)))
        } catch (error) {
          return {
            status: 'unknown',
            idempotencyKey,
            code: 'FINGERPRINT_FAILED',
            message: `无法计算输入指纹（fail-closed）：${safeMessage(error)}`,
          }
        }

        const tab = await ensureDedicatedTab()
        if (!tab.ok) {
          return { status: 'unknown', idempotencyKey, fingerprint, code: 'TAB_UNAVAILABLE', message: tab.message }
        }

        // 1. 账号探测（不产生网络请求）：拿到不可逆 accountScope 与登录态。
        const account = await inject(tab.tabId, { op: 'account' })
        if (account.status !== 'account' || !account.accountScope) {
          const mapped = mapPageResult(account, idempotencyKey)
          return { ...mapped, fingerprint }
        }
        const accountScope = account.accountScope
        const auditKey = ledgerKey(accountScope, idempotencyKey)

        // 2. 读审计账本（fail-closed）。
        let ledger: DirectPublishLedger
        try {
          ledger = await readLedger()
        } catch (error) {
          return {
            status: 'unknown',
            idempotencyKey,
            fingerprint,
            code: 'AUDIT_STORAGE_UNAVAILABLE',
            message: `审计存储不可用，按 fail-closed 拒绝发布：${safeMessage(error)}`,
          }
        }

        const existing = ledger.entries[auditKey]
        if (existing) {
          // 已知业务拒绝：允许同 key 修改输入后重试（新指纹）；其余状态先校验指纹，防止绕锁。
          if (existing.status !== 'rejected' && existing.fingerprint !== fingerprint) {
            return {
              status: 'rejected',
              idempotencyKey,
              fingerprint,
              code: 'IDEMPOTENCY_KEY_CONFLICT',
              message: '同一 idempotencyKey 对应不同输入，拒绝执行',
            }
          }
          if (existing.status === 'published' && existing.itemId) {
            return {
              status: 'published',
              idempotencyKey,
              itemId: existing.itemId,
              fingerprint,
              reused: true,
            }
          }
          if (existing.status === 'attempting' || existing.status === 'unknown') {
            return {
              status: 'unknown',
              idempotencyKey,
              fingerprint,
              code: 'PREVIOUS_ATTEMPT_UNKNOWN',
              message: '该 key 之前已发起过发布且结果未知，禁止重试',
            }
          }
          // rejected / action_required 允许修正后重试。
        }

        // 3. prepare（读取 + 上传 + 组装 payload），传入探测到的 accountScope 供页面校验账号未漂移。
        const prepared = await inject(tab.tabId, {
          op: 'prepare',
          expectedAccountScope: accountScope,
          ...(('itemId' in normalized.source)
            ? { sourceItemId: String(normalized.source.itemId), imageIndexes: (normalized.source as { imageIndexes?: number[] }).imageIndexes }
            : { sourceProduct: (normalized.source as { product: DirectPublishPageProduct }).product }),
          sellerAddress: normalized.seller.address ?? null,
          coordinates: normalized.seller.coordinates ?? null,
          servicePreferences: normalized.servicePreferences,
          confirmedNoQrCodes: normalized.confirmedNoQrCodes,
        })
        if (prepared.status !== 'prepared' || !prepared.payload) {
          const mapped = mapPageResult(prepared, idempotencyKey)
          const auditStatus: DirectPublishAuditEntry['status'] =
            mapped.status === 'published'
              ? 'published'
              : mapped.status === 'action_required'
                ? 'action_required'
                : mapped.status === 'rejected'
                  ? 'rejected'
                  : 'unknown'
          try {
            await upsertEntry(auditKey, {
              accountScope,
              idempotencyKey,
              fingerprint,
              status: auditStatus,
              at: new Date().toISOString(),
              code: mapped.code,
              actionRequired: mapped.actionRequired,
            })
          } catch {
            // 准备阶段失败时的审计写入失败不改变对外结果。
          }
          return { ...mapped, fingerprint, warnings: prepared.warnings }
        }

        // prepare 成功：后台再次确认 accountScope 一致，不一致则不写 attempting。
        const preparedWarnings = prepared.warnings ?? []
        if (prepared.accountScope !== accountScope) {
          try {
            await upsertEntry(auditKey, {
              accountScope,
              idempotencyKey,
              fingerprint,
              status: 'action_required',
              at: new Date().toISOString(),
              code: 'ACCOUNT_CHANGED',
              actionRequired: 'login',
            })
          } catch {
            // 账号漂移阻断时的审计写入失败不改变对外结果。
          }
          return {
            status: 'action_required',
            idempotencyKey,
            fingerprint,
            actionRequired: 'login',
            code: 'ACCOUNT_CHANGED',
            message: 'prepare 阶段账号与探测账号不一致，已阻断发布',
            warnings: preparedWarnings,
          }
        }

        // 4. 先记录 attempting，再提交（service worker 重启后据此阻断重复）。
        try {
          await upsertEntry(auditKey, {
            accountScope,
            idempotencyKey,
            fingerprint,
            status: 'attempting',
            at: new Date().toISOString(),
          })
        } catch (error) {
          return {
            status: 'unknown',
            idempotencyKey,
            fingerprint,
            code: 'AUDIT_STORAGE_UNAVAILABLE',
            message: `无法写入 attempting 审计，按 fail-closed 拒绝发布：${safeMessage(error)}`,
          }
        }

        // 5. 提交发布（再次传入 accountScope，页面在最终 publish 前再校验账号）。
        const published = await inject(tab.tabId, {
          op: 'publish',
          expectedAccountScope: accountScope,
          preparedPayload: prepared.payload as Record<string, unknown>,
        })
        const result = mapPageResult(published, idempotencyKey)
        const finalStatus: DirectPublishAuditEntry['status'] =
          result.status === 'published'
            ? 'published'
            : result.status === 'action_required'
              ? 'action_required'
              : result.status === 'rejected'
                ? 'rejected'
                : 'unknown'
        const auditWarnings: string[] = []
        try {
          await upsertEntry(auditKey, {
            accountScope,
            idempotencyKey,
            fingerprint,
            status: finalStatus,
            at: new Date().toISOString(),
            itemId: result.itemId,
            code: result.code,
            actionRequired: result.actionRequired,
          })
        } catch (error) {
          // 提交已发生，审计写入失败不回滚结果，但必须显式告警（可能影响后续防重）。
          auditWarnings.push(`审计写入失败：${safeMessage(error)}`)
        }

        return {
          ...result,
          fingerprint,
          warnings: Array.from(new Set([...preparedWarnings, ...(result.warnings ?? []), ...auditWarnings])),
        }
      })
    } finally {
      publishInFlight = false
    }
  }

  async function getProduct(itemId: string | number): Promise<DirectProductResult> {
    const id = String(itemId ?? '').trim()
    if (!id) {
      return { status: 'rejected', itemId: '', code: 'ITEM_ID_REQUIRED', message: '缺少 itemId' }
    }
    return withTabLock(async () => {
      const tab = await ensureDedicatedTab()
      if (!tab.ok) {
        return { status: 'unknown', itemId: id, code: 'TAB_UNAVAILABLE', message: tab.message }
      }
      const result = await inject(tab.tabId, { op: 'getProduct', sourceItemId: id })
      if (result.status === 'product' && result.product) {
        return { status: 'ok', itemId: id, product: result.product }
      }
      if (result.status === 'action_required') {
        return {
          status: 'action_required',
          itemId: id,
          actionRequired: result.actionRequired ?? 'login',
          code: result.code,
          message: result.message,
        }
      }
      if (result.status === 'rejected') {
        return { status: 'rejected', itemId: id, code: result.code, message: result.message }
      }
      return { status: 'unknown', itemId: id, code: result.code ?? 'UNKNOWN', message: result.message }
    })
  }

  async function uploadImage(dataUrl: string): Promise<DirectUploadImageResult> {
    const raw = String(dataUrl ?? '')
    if (!/^data:[^;]+;base64,[a-z0-9+/=\s]+$/i.test(raw)) {
      return { status: 'rejected', code: 'INVALID_DATA_URL', message: '本地图片上传只接受 base64 data URL' }
    }
    return withTabLock(async () => {
      const tab = await ensureDedicatedTab()
      if (!tab.ok) return { status: 'unknown', code: 'TAB_UNAVAILABLE', message: tab.message }
      const result = await inject(tab.tabId, { op: 'uploadImage', dataUrl: raw })
      if (result.status === 'uploaded' && result.image) return { status: 'uploaded', image: result.image }
      if (result.status === 'action_required') {
        return { status: 'action_required', actionRequired: result.actionRequired ?? 'login', code: result.code, message: result.message }
      }
      if (result.status === 'rejected') return { status: 'rejected', code: result.code, message: result.message }
      return { status: 'unknown', code: result.code ?? 'UNKNOWN', message: result.message }
    })
  }

  async function getJob(jobId?: string): Promise<DirectPublishJobResult> {
    let ledger: DirectPublishLedger
    try {
      ledger = await readLedger()
    } catch (error) {
      return { ok: false, jobs: [], error: { code: 'AUDIT_STORAGE_UNAVAILABLE', message: safeMessage(error) } }
    }
    const id = jobId ? String(jobId).trim() : ''
    const jobs = Object.values(ledger.entries)
      .filter((entry) => (id ? entry.idempotencyKey === id : true))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, 50)
      .map((entry) => ({
        idempotencyKey: entry.idempotencyKey,
        accountScope: entry.accountScope,
        fingerprint: entry.fingerprint,
        status: entry.status,
        itemId: entry.itemId,
        code: entry.code,
        actionRequired: entry.actionRequired,
        at: entry.at,
      }))
    return { ok: true, jobs }
  }

  /** 页面失败结果 → prepare 结果（保留阶段细分与 partial draft，供 UI 展示已准备部分而非空白表单）。 */
  function mapPageResultToPrepared(result: DirectPublishPageResult): DirectPublishPreparedResult {
    const partial: Partial<DirectPublishPreparedResult> = {
      warnings: result.warnings,
      ...(result.failureStage ? { failureStage: result.failureStage } : {}),
      ...(result.missingFields && result.missingFields.length > 0 ? { missingFields: result.missingFields } : {}),
      ...(result.draft ? { draft: result.draft as unknown as DirectPublishReviewDraft } : {}),
      ...(Array.isArray(result.propertyCards) ? { propertyCards: clonePropertyCards(result.propertyCards) } : {}),
    }
    if (result.status === 'action_required') {
      return {
        status: 'action_required',
        actionRequired: result.actionRequired ?? 'login',
        code: result.code,
        message: result.message,
        ...partial,
      }
    }
    if (result.status === 'rejected') {
      return { status: 'rejected', code: result.code, message: result.message, ...partial }
    }
    return { status: 'unknown', code: result.code ?? 'UNKNOWN', message: result.message, ...partial }
  }

  /** 页面失败结果 → submit 结果。 */
  function mapPageResultToSubmit(result: DirectPublishPageResult, idempotencyKey: string): DirectPublishSubmitResult {
    if (result.status === 'published' && result.itemId) {
      return { status: 'published', idempotencyKey, itemId: result.itemId, warnings: result.warnings }
    }
    if (result.status === 'action_required') {
      return {
        status: 'action_required',
        idempotencyKey,
        actionRequired: result.actionRequired ?? 'login',
        code: result.code,
        message: result.message,
      }
    }
    if (result.status === 'rejected') {
      return { status: 'rejected', idempotencyKey, code: result.code, message: result.message }
    }
    return { status: 'unknown', idempotencyKey, code: result.code ?? 'UNKNOWN', message: result.message }
  }

  /**
   * 两阶段第一阶段：跑完最终 publish 之前的全部接口，返回完整待发送数据与候选，
   * **绝不提交**。不写审计（避免污染后续 submit 的幂等判断）。
   */
  async function prepare(input: DirectPublishPrepareRequest): Promise<DirectPublishPreparedResult> {
    const validation = validatePrepareInput(input)
    if (!validation.ok) {
      return { status: 'rejected', code: validation.code, message: validation.message }
    }
    const normalized = normalizePrepareInput(input)
    let inputFingerprint: string
    try {
      inputFingerprint = await hashHex(
        stableStringify({
          source: normalized.source,
          seller: normalized.seller,
          category: normalized.category ?? null,
          attributes: normalized.attributes ?? null,
        }),
      )
    } catch (error) {
      return {
        status: 'unknown',
        code: 'FINGERPRINT_FAILED',
        message: `无法计算准备输入指纹（fail-closed）：${safeMessage(error)}`,
      }
    }

    return withTabLock(async () => {
      const tab = await ensureDedicatedTab()
      if (!tab.ok) return { status: 'unknown', code: 'TAB_UNAVAILABLE', message: tab.message }

      // 账号探测（不产生网络请求）：拿到不可逆 accountScope 与登录态。
      const account = await inject(tab.tabId, { op: 'account' })
      if (account.status !== 'account' || !account.accountScope) {
        return mapPageResultToPrepared(account)
      }
      const accountScope = account.accountScope

      // 同 key 重复 prepare 的幂等检查必须在锁内、账号探测之后：
      // 1. 串行化（锁内）保证两个同 key 准备不会重复上传；
      // 2. 按 accountScope 隔离（session 索引）防止账号切换后复用上一个账号的 token；
      // 3. SW 休眠 / 重启后仍可从 session 索引复用，避免重复上传。
      const cacheKey = ledgerKey(accountScope, normalized.idempotencyKey)
      let existing: DirectPublishPreparedEntry | null
      try {
        existing = await lookupPreparedByKey(cacheKey)
      } catch (error) {
        return {
          status: 'unknown',
          code: 'PREPARE_STORAGE_UNAVAILABLE',
          message: `准备结果会话存储不可读，按 fail-closed 拒绝：${safeMessage(error)}`,
        }
      }
      if (existing) {
        if (existing.inputFingerprint !== inputFingerprint) {
          return {
            status: 'rejected',
            code: 'IDEMPOTENCY_KEY_CONFLICT',
            message: '同一 idempotencyKey 对应不同准备输入，拒绝执行',
          }
        }
        return {
          status: 'prepared',
          prepareToken: existing.token,
          draft: cloneDraft(existing.draft),
          propertyCards: clonePropertyCards(existing.propertyCards),
          warnings: ['复用同一 idempotencyKey 的已准备结果'],
        }
      }

      const pageRequest: DirectPublishPageRequest = {
        op: 'prepare',
        // 两阶段审核模式：跳过旧版二维码人工确认门禁，未提供 seller 时自动取账号默认地址。
        reviewMode: true,
        expectedAccountScope: accountScope,
        ...('itemId' in normalized.source
          ? { sourceItemId: String(normalized.source.itemId), imageIndexes: normalized.source.imageIndexes }
          : { sourceProduct: normalized.source.product as DirectPublishPageProduct }),
        sellerAddress: normalized.seller.address ?? null,
        coordinates: normalized.seller.coordinates ?? null,
        // 两阶段：服务默认全部关闭，用户在草稿中自行启用（submit 再校验可用性）。
        servicePreferences: {},
        ...(normalized.category !== undefined ? { category: normalized.category } : {}),
        ...(normalized.attributes !== undefined ? { attributes: normalized.attributes } : {}),
      }
      const prepared = await inject(tab.tabId, pageRequest)
      if (prepared.status !== 'prepared' || !prepared.draft || !Array.isArray(prepared.propertyCards)) {
        return mapPageResultToPrepared(prepared)
      }
      // prepare 成功：后台再次确认 accountScope 一致，不一致则阻断。
      if (prepared.accountScope && prepared.accountScope !== accountScope) {
        return {
          status: 'action_required',
          actionRequired: 'login',
          code: 'ACCOUNT_CHANGED',
          message: 'prepare 阶段账号与探测账号不一致，已阻断',
          warnings: prepared.warnings,
        }
      }

      const draft = prepared.draft as unknown as DirectPublishReviewDraft
      const images = Array.isArray(draft.images)
        ? draft.images.filter((item): item is Record<string, unknown> => isRecord(item)).map(cloneRecord)
        : []
      const services = Array.isArray(draft.services)
        ? draft.services
            .map((service) =>
              isRecord(service) && typeof service['serviceCode'] === 'string'
                ? { serviceCode: service['serviceCode'], enable: service['enable'] === true }
                : null,
            )
            .filter((service): service is { serviceCode: string; enable: boolean } => service !== null)
        : []
      const address = isRecord(draft.address) ? (draft.address as Record<string, string>) : {}

      const token = generatePrepareToken()
      const entry: DirectPublishPreparedEntry = {
        token,
        accountScope,
        tabId: tab.tabId,
        idempotencyKey: normalized.idempotencyKey,
        inputFingerprint,
        createdAt: now(),
        basePayload: prepared.payload ?? null,
        draft,
        images,
        propertyCards: prepared.propertyCards,
        rawCards: Array.isArray(prepared.rawCards) ? prepared.rawCards : [],
        services,
        address,
      }

      // 先持久化（storage.session 权威）再返回 token：写入失败则 fail-closed，绝不返回不可恢复的 token。
      if (sessionStorage) {
        try {
          await persistPreparedEntry(entry)
        } catch (error) {
          return {
            status: 'unknown',
            code: 'PREPARE_STORAGE_UNAVAILABLE',
            message: `无法保存准备结果，按 fail-closed 拒绝（未返回 token）：${safeMessage(error)}`,
          }
        }
      } else {
        preparedCache.set(token, entry)
        preparedByKey.set(cacheKey, token)
      }

      return {
        status: 'prepared',
        prepareToken: token,
        draft: cloneDraft(draft),
        propertyCards: clonePropertyCards(entry.propertyCards),
        warnings: prepared.warnings,
      }
    })
  }

  /**
   * 两阶段第二阶段：严格运行时校验任意网页传入的 draft，按已准备候选重建最终 payload，
   * 写 attempting 审计后才真正 publish；防重复 / 防账号漂移 / 未知禁止重试。
   */
  async function submit(input: DirectPublishSubmitRequest): Promise<DirectPublishSubmitResult> {
    const token = String(input?.prepareToken ?? '')
    const validation = validateSubmitInput(input)
    if (!validation.ok) {
      return { status: 'rejected', idempotencyKey: '', code: validation.code, message: validation.message }
    }
    if (submitInFlight) {
      return {
        status: 'rejected',
        idempotencyKey: '',
        code: 'CONCURRENT_LOCK',
        message: '已有提交请求正在执行，禁止并发触发',
      }
    }
    submitInFlight = true

    try {
      // 先按 token 从 session 恢复（SW 休眠 / 重启后仍可用）；存储损坏 / 不可读一律 fail-closed。
      let lookup: DirectPublishPreparedLookup
      try {
        lookup = await lookupPreparedByToken(token)
      } catch (error) {
        return {
          status: 'unknown',
          idempotencyKey: '',
          code: 'PREPARE_STORAGE_UNAVAILABLE',
          message: `准备结果会话存储不可读，按 fail-closed 拒绝：${safeMessage(error)}`,
        }
      }
      if (lookup.kind === 'expired') {
        return {
          status: 'rejected',
          idempotencyKey: '',
          code: 'PREPARE_EXPIRED',
          message: '准备结果已过期（超过有效期），请重新 prepare',
        }
      }
      if (lookup.kind === 'consumed') {
        return {
          status: 'rejected',
          idempotencyKey: '',
          code: 'SUBMIT_DUPLICATE',
          message: '该 prepareToken 已提交过，禁止重复提交（如需重新发布请重新 prepare）',
        }
      }
      if (lookup.kind === 'not_found' || lookup.kind === 'legacy_missing') {
        // session 路径区分「尚未准备 / 会话已清空」；旧内存路径保持 PREPARE_EXPIRED 兼容。
        return {
          status: 'rejected',
          idempotencyKey: '',
          code: hasSession ? 'PREPARE_NOT_FOUND' : 'PREPARE_EXPIRED',
          message: hasSession
            ? '准备结果不存在（可能未准备、已过期或浏览器重启清空了会话），请重新 prepare'
            : '准备结果不存在或已过期（如 service worker 重启），请重新 prepare',
        }
      }
      const entry = lookup.entry
      const idempotencyKey = entry.idempotencyKey
      /** 消耗 token 失败仅告警（attempting 审计已落盘，防重不依赖会话消耗）。 */
      const consumeWarnings: string[] = []

      // 严格校验并归一化 draft（白名单编辑；未知字段 / 非候选值一律拒绝）。
      const normalizedDraft = normalizeSubmitDraft(entry, input.draft)
      if (!normalizedDraft.ok) {
        return { status: 'rejected', idempotencyKey, code: normalizedDraft.code, message: normalizedDraft.message }
      }
      const core = normalizedDraft.core

      // 指纹对「最终确认 payload」计算（submit 完成输入归一后）。
      let fingerprint: string
      try {
        fingerprint = await hashHex(stableStringify(core))
      } catch (error) {
        return {
          status: 'unknown',
          idempotencyKey,
          code: 'FINGERPRINT_FAILED',
          message: `无法计算最终 payload 指纹（fail-closed）：${safeMessage(error)}`,
        }
      }

      return await withTabLock(async () => {
        const tab = await ensureDedicatedTab()
        if (!tab.ok) {
          return { status: 'unknown', idempotencyKey, fingerprint, code: 'TAB_UNAVAILABLE', message: tab.message }
        }

        // 提交前重新探测账号，防止账号漂移。
        const account = await inject(tab.tabId, { op: 'account' })
        if (account.status !== 'account' || !account.accountScope) {
          return { ...mapPageResultToSubmit(account, idempotencyKey), fingerprint }
        }
        const accountScope = account.accountScope
        if (accountScope !== entry.accountScope) {
          return {
            status: 'action_required',
            idempotencyKey,
            fingerprint,
            actionRequired: 'login',
            code: 'ACCOUNT_CHANGED',
            message: '提交前检测到登录账号发生变化，请确认账号一致后重新 prepare',
          }
        }

        const auditKey = ledgerKey(accountScope, idempotencyKey)
        let ledger: DirectPublishLedger
        try {
          ledger = await readLedger()
        } catch (error) {
          return {
            status: 'unknown',
            idempotencyKey,
            fingerprint,
            code: 'AUDIT_STORAGE_UNAVAILABLE',
            message: `审计存储不可用，按 fail-closed 拒绝提交：${safeMessage(error)}`,
          }
        }
        const existing = ledger.entries[auditKey]
        if (existing) {
          // 已知业务拒绝：允许同 key 修改草稿后重试（新指纹）；其余状态先校验指纹，防止绕锁。
          if (existing.status !== 'rejected' && existing.fingerprint !== fingerprint) {
            return {
              status: 'rejected',
              idempotencyKey,
              fingerprint,
              code: 'IDEMPOTENCY_KEY_CONFLICT',
              message: '同一 idempotencyKey 对应不同最终 payload，拒绝执行',
            }
          }
          if (existing.status === 'published' && existing.itemId) {
            return { status: 'published', idempotencyKey, itemId: existing.itemId, fingerprint, reused: true }
          }
          if (existing.status === 'attempting' || existing.status === 'unknown') {
            return {
              status: 'unknown',
              idempotencyKey,
              fingerprint,
              code: 'PREVIOUS_ATTEMPT_UNKNOWN',
              message: '该 key 之前已发起过提交且结果未知，禁止重试',
            }
          }
          // rejected / action_required 允许修正后重试。
        }

        // 先记录 attempting，再提交（service worker 重启后据此阻断重复）。
        try {
          await upsertEntry(auditKey, {
            accountScope,
            idempotencyKey,
            fingerprint,
            status: 'attempting',
            at: new Date().toISOString(),
          })
        } catch (error) {
          return {
            status: 'unknown',
            idempotencyKey,
            fingerprint,
            code: 'AUDIT_STORAGE_UNAVAILABLE',
            message: `无法写入 attempting 审计，按 fail-closed 拒绝提交：${safeMessage(error)}`,
          }
        }

        // 已写入 attempting 审计后即消耗 token：审计是防重权威，token 消耗是会话卫生，
        // 确保 SW 重启后同 token 不可复用；消耗失败也不阻断（attempting 审计足以防重）。
        try {
          await consumePreparedEntry(entry)
        } catch (error) {
          consumeWarnings.push(`准备结果消耗失败（不影响防重）：${safeMessage(error)}`)
        }

        const published = await inject(tab.tabId, {
          op: 'submit',
          expectedAccountScope: accountScope,
          submitCore: core,
          // cpvList 同步最终选择（从原始推荐卡克隆后更新 isClicked），绝不传旧推荐状态。
          rawCards: applySelectionToRawCards(entry.rawCards, normalizedDraft.selection),
        })
        const result = mapPageResultToSubmit(published, idempotencyKey)
        const finalStatus: DirectPublishAuditEntry['status'] =
          result.status === 'published'
            ? 'published'
            : result.status === 'action_required'
              ? 'action_required'
              : result.status === 'rejected'
                ? 'rejected'
                : 'unknown'
        const auditWarnings: string[] = []
        let auditPersisted = true
        try {
          await upsertEntry(auditKey, {
            accountScope,
            idempotencyKey,
            fingerprint,
            status: finalStatus,
            at: new Date().toISOString(),
            itemId: result.itemId,
            code: result.code,
            actionRequired: result.actionRequired,
          })
        } catch (error) {
          auditPersisted = false
          auditWarnings.push(`审计写入失败：${safeMessage(error)}`)
        }

        // 明确业务拒绝：**先持久 audit rejected 成功，才恢复**已消耗的 prepareToken，
        // 允许改稿后用同一 token 手动重提；恢复失败一律降级 unknown（绝不假装可重试）。
        if (finalStatus === 'rejected') {
          const baseWarnings = Array.from(
            new Set([...(published.warnings ?? []), ...(result.warnings ?? []), ...auditWarnings, ...consumeWarnings]),
          )
          if (!auditPersisted) {
            return {
              status: 'unknown',
              idempotencyKey,
              fingerprint,
              code: 'REJECT_RESTORE_UNAVAILABLE',
              message: '业务拒绝但审计未持久化，无法安全恢复本次提交，请重新 prepare',
              prepareTokenValid: false,
              warnings: baseWarnings,
            }
          }
          try {
            await restorePreparedEntry(entry)
          } catch (error) {
            return {
              status: 'unknown',
              idempotencyKey,
              fingerprint,
              code: 'REJECT_RESTORE_UNAVAILABLE',
              message: `业务拒绝但无法恢复准备结果，请重新 prepare：${safeMessage(error)}`,
              prepareTokenValid: false,
              warnings: baseWarnings,
            }
          }
          return {
            ...result,
            fingerprint,
            retryable: true,
            prepareTokenValid: true,
            warnings: baseWarnings,
          }
        }

        return {
          ...result,
          fingerprint,
          prepareTokenValid: false,
          warnings: Array.from(
            new Set([...(published.warnings ?? []), ...(result.warnings ?? []), ...auditWarnings, ...consumeWarnings]),
          ),
        }
      })
    } finally {
      submitInFlight = false
    }
  }

  // 专用 tab 关闭时清理缓存（可选能力）。
  if (tabs.onRemoved) {
    try {
      tabs.onRemoved.addListener((tabId) => {
        if (cachedTabId === tabId) cachedTabId = null
      })
    } catch {
      // 容忍非完整 Chrome 环境
    }
  }

  return { publish, prepare, submit, getProduct, uploadImage, getJob }
}

// ==================== 监听器 ====================

/** 判定是否为直接发布消息（独立 kind，不影响既有命令）。 */
export function isDirectPublishMessage(message: unknown): message is DirectPublishMessage {
  if (!isRecord(message)) return false
  if (message['kind'] !== DIRECT_PUBLISH_MESSAGE_KIND) return false
  const method = message['method']
  if (method !== 'publish' && method !== 'prepare' && method !== 'submit' && method !== 'getProduct' && method !== 'uploadImage' && method !== 'getJob') return false
  if (!isRecord(message['request'])) return false
  if (method === 'getJob') {
    const jobId = message['request']['jobId']
    return jobId === undefined || typeof jobId === 'string'
  }
  if (method === 'uploadImage') {
    const dataUrl = message['request']['dataUrl']
    return typeof dataUrl === 'string' && dataUrl.startsWith('data:') && dataUrl.length <= 14_000_000
  }
  return true
}

/** 依据运行时 chrome 组装 API；环境能力缺失时返回 null。 */
export function createChromeDirectPublishApi(): DirectPublishApi | null {
  const globalChrome = (globalThis as { chrome?: unknown }).chrome as
    | {
        tabs?: DirectPublishTabsApi
        scripting?: DirectPublishScriptingApi
        storage?: {
          local?: DirectPublishStorageLocalApi
          session?: DirectPublishStorageSessionApi & { setAccessLevel?: (options: { accessLevel: string }) => Promise<void> }
        }
      }
    | undefined
  if (!globalChrome) return null
  const tabs = globalChrome.tabs
  const scripting = globalChrome.scripting
  const local = globalChrome.storage?.local
  const session = globalChrome.storage?.session
  if (!tabs || !scripting || !local) return null
  if (typeof tabs.query !== 'function' || typeof tabs.create !== 'function' || typeof tabs.get !== 'function') return null
  if (typeof scripting.executeScript !== 'function') return null
  if (typeof local.get !== 'function' || typeof local.set !== 'function') return null
  const storage: DirectPublishChromeSubset['storage'] = { local }
  if (session && typeof session.get === 'function' && typeof session.set === 'function') {
    storage.session = session
    // 明确限定为 TRUSTED_CONTEXTS（默认值，后台 + 扩展内页），**绝不**扩到 content script；旧版本无此能力则忽略。
    if (typeof session.setAccessLevel === 'function') {
      try {
        void session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {})
      } catch {
        // 容忍不返回 Promise / 能力缺失。
      }
    }
  }
  return createDirectPublishApi({ chrome: { tabs, scripting, storage } })
}

interface InstallListenerOptions {
  /** 覆盖 API 组装（测试用）；返回 null 表示依赖缺失。 */
  createApi?: () => DirectPublishApi | null
  /** 覆盖扩展 id（测试用）。 */
  extensionId?: string
}

let installed = false
let cachedApi: DirectPublishApi | null | undefined

/** 处理一条直接发布消息（返回响应，不抛错）。 */
async function handleDirectPublishMessage(
  message: DirectPublishMessage,
  createApi: () => DirectPublishApi | null,
): Promise<DirectPublishMessageResponse> {
  const respond = (partial: Omit<DirectPublishMessageResponse, 'kind' | 'method'>): DirectPublishMessageResponse => ({
    kind: DIRECT_PUBLISH_MESSAGE_KIND,
    method: message.method,
    ...partial,
  })
  let api: DirectPublishApi | null
  try {
    api = createApi()
  } catch (error) {
    return respond({ ok: false, error: { code: 'API_CREATE_FAILED', message: safeMessage(error) } })
  }
  if (!api) {
    return respond({
      ok: false,
      error: { code: 'DEPENDENCIES_MISSING', message: '当前环境缺少 chrome.tabs / scripting / storage.local' },
    })
  }
  try {
    if (message.method === 'publish') {
      const result = await api.publish(message.request as DirectPublishInput)
      return respond({ ok: result.status === 'published', result })
    }
    if (message.method === 'prepare') {
      if (typeof api.prepare !== 'function') {
        return respond({ ok: false, error: { code: 'METHOD_UNAVAILABLE', message: '当前 API 不支持 prepare' } })
      }
      const result = await api.prepare(message.request as DirectPublishPrepareRequest)
      return respond({ ok: result.status === 'prepared', result })
    }
    if (message.method === 'submit') {
      if (typeof api.submit !== 'function') {
        return respond({ ok: false, error: { code: 'METHOD_UNAVAILABLE', message: '当前 API 不支持 submit' } })
      }
      const result = await api.submit(message.request as DirectPublishSubmitRequest)
      return respond({ ok: result.status === 'published', result })
    }
    if (message.method === 'getProduct') {
      const itemId = (message.request as { itemId?: string | number })?.itemId ?? ''
      const result = await api.getProduct(itemId)
      return respond({ ok: result.status === 'ok', result })
    }
    if (message.method === 'getJob') {
      if (typeof api.getJob !== 'function') {
        return respond({ ok: false, error: { code: 'METHOD_UNAVAILABLE', message: '当前 API 不支持 getJob' } })
      }
      const jobId = (message.request as { jobId?: string }).jobId
      const result = await api.getJob(jobId)
      return respond({ ok: result.ok, result })
    }
    if (typeof api.uploadImage !== 'function') {
      return respond({ ok: false, error: { code: 'METHOD_UNAVAILABLE', message: '当前 API 不支持 uploadImage' } })
    }
    const dataUrl = (message.request as { dataUrl?: string }).dataUrl
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      return respond({ ok: false, error: { code: 'INVALID_DATA_URL', message: '本地图片上传只接受 data URL' } })
    }
    const result = await api.uploadImage(dataUrl)
    return respond({ ok: result.status === 'uploaded', result })
  } catch (error) {
    return respond({ ok: false, error: { code: 'INTERNAL', message: safeMessage(error) } })
  }
}

/**
 * 安装后台消息监听（幂等）。
 *
 * 只处理 `kind: 'fishops-direct-publish'` 且来源为扩展内页的消息；其余消息返回 false，
 * 因此不影响既有 Workbench 命令 / 订阅监听。长请求直接以 Promise 保持消息通道。
 *
 * 注意：真实接线时需由 `extension/src/background/index.ts` 调用一次本函数（主代理负责）。
 */
export function installDirectPublishApiListener(options: InstallListenerOptions = {}): void {
  if (installed) return
  const globalChrome = (globalThis as { chrome?: any }).chrome
  if (!globalChrome?.runtime?.onMessage) return
  installed = true

  const createApi =
    options.createApi ??
    (() => {
      if (cachedApi === undefined) cachedApi = createChromeDirectPublishApi()
      return cachedApi
    })
  const extensionId = options.extensionId ?? globalChrome.runtime.id

  globalChrome.runtime.onMessage.addListener((message: unknown, sender: MessageSenderLike, sendResponse: (response: unknown) => void) => {
    if (!isDirectPublishMessage(message)) return false
    // 严格来源校验：只接受本扩展内页，拒绝 content script / 外部页面。
    if (!isExtensionPageSender(sender, extensionId)) return false
    void handleDirectPublishMessage(message, createApi).then((response) => {
      try {
        sendResponse(response)
      } catch {
        // 通道可能已关闭，忽略。
      }
    })
    return true
  })
}

/** 仅供测试：重置监听安装标记。 */
export function __resetDirectPublishListenerForTests(): void {
  installed = false
  cachedApi = undefined
}
