import { object } from './index.ts'

/**
 * M5 发布方法的公共参数与结果 schema。
 *
 * 本模块只固定离线契约，不注册能力、不连接平台、不发起真实请求。
 * 设计依据见 docs/m5-publish-plan.md：默认不发布、失败不假成功、未知不重试。
 * 因此这里显式拒绝未知字段、账号范围字段（accountId/userId 等由 Host 按当前
 * 登录账号绑定，调用方不得指定）、前端伪造 payload，并要求人工确认显式为真。
 */

/** 发布类公共方法；prepare 只做只读准备，submit 是唯一允许写平台的方法。 */
export type PublishMethod = 'publish.prepare' | 'publish.submit' | 'publish.myItems'

/** 源商品引用；只接受显式 itemId，不随机挑选、不接受整对象源。 */
export type PublishSource = { itemId: string }

/** 人工确认开关；缺失或非 true 一律拒绝，不进入平台写操作。 */
export type PublishConfirm = { imageNoQr: true; addressConfirmed: true }

/** 发货地址引用；只接受候选引用，不猜测地址、不硬编码坐标。 */
export type PublishSeller = { addressRef: string }

/** 价格；固定价与面议互斥，不接受字符串或负数。 */
export type PublishPrice =
  | { kind: 'fixed'; amount: number; unit: 'CNY' }
  | { kind: 'negotiable' }

/** 图片项；只接受规范 URL 或 prepare 已上传的图片引用。 */
export type PublishImage =
  | { kind: 'url'; url: string }
  | { kind: 'uploaded'; ref: string }

/** 规格键值对；键和值都必须非空文本。 */
export type PublishSpec = { key: string; value: string }

/** 服务偏好；ref 必须来自 prepare 返回的服务候选集合。 */
export type PublishService = { ref: string; value?: string }

/** prepare 接受的规范草稿字段；全部可选，缺失表示不做覆盖。 */
export type PublishDraft = {
  title?: string
  description?: string
  price?: PublishPrice
  images?: PublishImage[]
  categoryRef?: string
  attributeRefs?: string[]
  specs?: PublishSpec[]
  services?: PublishService[]
}

/** publish.prepare 公共参数；账号不由调用方指定。 */
export type PublishPrepareParams = {
  source: PublishSource
  idempotencyKey: string
  seller: PublishSeller
  confirm: PublishConfirm
  draft?: PublishDraft
  tag?: string
  maxWaitMs?: number
  minIntervalMs?: number
}

/** prepare 内部步骤只携带业务字段；可选 key 仅兼容旧内部调用，不承担幂等授权。 */
export type PublishPrepareStepParams = Pick<PublishPrepareParams, 'source' | 'seller' | 'confirm' | 'draft'> & { idempotencyKey?: string }

/** 已确认草稿摘要；未知字段显式为 null，不用 0 或空串伪装事实。 */
export type PublishDraftSummary = {
  title: string | null
  description: string | null
  price: string | null
  imageCount: number
  categoryName: string | null
  attributeNames: string[]
  serviceNames: string[]
}

/** prepare 返回的候选集合；调用方只能用 ref 引用，不得自造 payload。 */
export type PublishPrepareCandidates = {
  categoryRefs: string[]
  attributeRefs: string[]
  serviceRefs: string[]
}

/** publish.prepare 成功结果；不含 cookie、签名、token 原文或原始响应。 */
export type PublishPrepareResult = {
  prepareToken: string
  draftFingerprint: string
  expiresAt: number
  draft: PublishDraftSummary
  candidates: PublishPrepareCandidates
}

/** publish.submit 公共参数；必须绑定一次成功 prepare，且确认显式为真。 */
export type PublishSubmitParams = {
  prepareToken: string
  draftFingerprint: string
  idempotencyKey: string
  confirm: PublishConfirm
  tag?: string
  maxWaitMs?: number
  minIntervalMs?: number
}

/**
 * publish.submit 内部单步参数。
 *
 * 公共 submit 仍使用 prepareToken + draftFingerprint；单步额外携带 Host
 * 持久化的 prepareRef，供页面取回权威上下文。调用方不能提交该字段。
 */
export type PublishSubmitStepParams = Pick<PublishSubmitParams, 'prepareToken' | 'draftFingerprint' | 'confirm'> & { prepareRef: string; idempotencyKey?: string }

/** 发布终态；只有 published 才携带平台 itemId。 */
export type PublishSubmitState = 'published' | 'rejected' | 'unknown'

/** publish.submit 结果；itemId 仅 published 时存在，confirmedAt 仅 published 时存在。 */
export type PublishSubmitResult = {
  state: PublishSubmitState
  itemId?: string
  confirmedAt?: number
}

/** publish.myItems 公共参数；只读确认，不接受账号 scope。 */
export type PublishMyItemsParams = {
  limit: number
  maxWaitMs: number
  minIntervalMs?: number
  tag?: string
}

/**
 * publish.myItems 内部单步参数。
 *
 * 第一页只传 limit；后续页传页面返回的 nextPage。调度参数、平台页码和
 * groupId 都不能由调用方直接注入，避免公共 API 暴露平台游标。
 */
export type PublishMyItemsStepParams = {
  limit: number
  nextPage?: string
}

/** 内部 myItems 游标载荷；groupId 随账号变化，pageSize 受平台上限约束。 */
export type PublishMyItemsCursor = {
  groupId: number
  pageNumber: number
  pageSize: number
}

/** 在售商品最小摘要；不返回 cookie、签名、原始响应和私密店铺字段。 */
export type PublishMyItem = { itemId: string; title?: string }

/** myItems 结果；hasMore 为 true 表示列表被截断，调用方不得当完整基线。 */
export type PublishMyItemsResult = {
  items: PublishMyItem[]
  total: number
  hasMore: boolean
}

const ID_MAX = 128
const KEY_MAX = 128
const TITLE_MAX = 2000
const DESCRIPTION_MAX = 100000
const TEXT_MAX = 2000
const REF_MAX = 256
const TOKEN_MAX = 512
const FINGERPRINT_MAX = 256
const URL_MAX = 2048
const AMOUNT_MAX = 100000000
const IMAGES_MAX = 20
const ATTRIBUTE_REFS_MAX = 50
const SPECS_MAX = 50
const SERVICES_MAX = 20
const ITEMS_MAX = 200
const MY_ITEMS_PAGE_SIZE_MAX = 20
const MY_ITEMS_PAGE_NUMBER_MAX = 10000
const NEXT_PAGE_MAX = 256
const NEXT_PAGE_PREFIX = 'v1.'
const NEXT_PAGE_BODY_PATTERN = /^[A-Za-z0-9_-]+$/
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/
const URL_PROTOCOLS = new Set(['http:', 'https:'])

// 使用函数声明而非 const 箭头函数：声明形式才能让 TS 将调用识别为控制流终止并完成收窄。
function bad(): never { throw Object.assign(new Error('发布参数无效'), { code: 'BAD_REQUEST' }) }

/** 纯数据对象判定：拒绝数组、null 和原型链被改写的伪装对象。 */
function plain(value: unknown): value is Record<string, unknown> {
  if (!object(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** 拒绝 getter、隐藏字段和 Symbol 键，避免验证期间运行调用者代码。 */
function inert(value: unknown): value is Record<string, unknown> {
  if (!plain(value)) return false
  if (Reflect.ownKeys(value).length !== Object.keys(value).length) return false
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(d => 'value' in d && d.enumerable)
}

function allow(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

/** 非空文本并限制长度；保留原始大小写，不做隐式 trim 结果替换。 */
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) bad()
  return value.trim()
}

/** 不透明引用：只接受受限字符集，防止把任意结构或 payload 塞进引用字段。 */
function ref(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.length || value.length > max || !TOKEN_PATTERN.test(value)) bad()
  return value
}

function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) bad()
  return value as number
}

function safeUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > URL_MAX) bad()
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    bad()
  }
  if (!URL_PROTOCOLS.has(parsed.protocol) || !parsed.hostname.length) bad()
  return value
}

/** 调度与标签等元信息不进入业务指纹，也不影响结果 schema。 */
function schedule(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (value.tag !== undefined) out.tag = text(value.tag, KEY_MAX)
  for (const key of ['maxWaitMs', 'minIntervalMs']) {
    if (value[key] === undefined) continue
    if (!keys.includes(key)) bad()
    const min = key === 'maxWaitMs' ? 1 : 0
    out[key] = integer(value[key], min, 600000)
  }
  return out
}

function confirm(value: unknown): PublishConfirm {
  if (!inert(value) || !allow(value, ['imageNoQr', 'addressConfirmed'])) bad()
  if (value.imageNoQr !== true || value.addressConfirmed !== true) bad()
  return { imageNoQr: true, addressConfirmed: true }
}

function source(value: unknown): PublishSource {
  if (!inert(value) || !allow(value, ['itemId'])) bad()
  return { itemId: text(value.itemId, ID_MAX) }
}

function seller(value: unknown): PublishSeller {
  if (!inert(value) || !allow(value, ['addressRef'])) bad()
  return { addressRef: ref(value.addressRef, REF_MAX) }
}

function price(value: unknown): PublishPrice {
  if (!inert(value)) bad()
  const kind = value.kind
  if (kind === 'negotiable') {
    if (!allow(value, ['kind'])) bad()
    return { kind: 'negotiable' }
  }
  if (kind !== 'fixed' || !allow(value, ['kind', 'amount', 'unit']) || value.unit !== 'CNY') bad()
  return { kind: 'fixed', amount: integer(value.amount, 1, AMOUNT_MAX), unit: 'CNY' }
}

function images(value: unknown): PublishImage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > IMAGES_MAX) bad()
  return value.map(entry => {
    if (!inert(entry)) bad()
    if (entry.kind === 'url') {
      if (!allow(entry, ['kind', 'url'])) bad()
      return { kind: 'url', url: safeUrl(entry.url) }
    }
    if (entry.kind === 'uploaded') {
      if (!allow(entry, ['kind', 'ref'])) bad()
      return { kind: 'uploaded', ref: ref(entry.ref, REF_MAX) }
    }
    bad()
  })
}

function refList(value: unknown, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) bad()
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of value) {
    const item = ref(entry, REF_MAX)
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
  }
  return out
}

function specs(value: unknown): PublishSpec[] {
  if (!Array.isArray(value) || value.length > SPECS_MAX) bad()
  const seen = new Set<string>()
  const out: PublishSpec[] = []
  for (const entry of value) {
    if (!inert(entry) || !allow(entry, ['key', 'value'])) bad()
    const key = text(entry.key, TEXT_MAX)
    if (seen.has(key)) bad()
    seen.add(key)
    out.push({ key, value: text(entry.value, TEXT_MAX) })
  }
  return out
}

function services(value: unknown): PublishService[] {
  if (!Array.isArray(value) || value.length > SERVICES_MAX) bad()
  const seen = new Set<string>()
  const out: PublishService[] = []
  for (const entry of value) {
    if (!inert(entry) || !allow(entry, ['ref', 'value'])) bad()
    const item: PublishService = { ref: ref(entry.ref, REF_MAX) }
    if (entry.value !== undefined) item.value = text(entry.value, TEXT_MAX)
    if (seen.has(item.ref)) bad()
    seen.add(item.ref)
    out.push(item)
  }
  return out
}

/** 草稿字段；未知字段、伪造 payload 和非法边界都拒绝。 */
function draft(value: unknown): PublishDraft {
  const allowed = ['title', 'description', 'price', 'images', 'categoryRef', 'attributeRefs', 'specs', 'services']
  if (!inert(value) || !allow(value, allowed)) bad()
  const out: PublishDraft = {}
  if (value.title !== undefined) out.title = text(value.title, TITLE_MAX)
  if (value.description !== undefined) out.description = text(value.description, DESCRIPTION_MAX)
  if (value.price !== undefined) out.price = price(value.price)
  if (value.images !== undefined) out.images = images(value.images)
  if (value.categoryRef !== undefined) out.categoryRef = ref(value.categoryRef, REF_MAX)
  if (value.attributeRefs !== undefined) out.attributeRefs = refList(value.attributeRefs, ATTRIBUTE_REFS_MAX)
  if (value.specs !== undefined) out.specs = specs(value.specs)
  if (value.services !== undefined) out.services = services(value.services)
  return out
}

/** 账号范围字段禁止由调用方提供；出现即视为越权请求。 */
const ACCOUNT_KEYS = ['accountId', 'account', 'userId', 'accountScope', 'scope', 'token', 'cookie']

function rejectAccountKeys(value: Record<string, unknown>): void {
  if (Object.keys(value).some(key => ACCOUNT_KEYS.includes(key))) bad()
}

/** publish.prepare 严格规范化；缺失 source/confirm 或账号字段一律拒绝。 */
export function normalizePublishPrepareParams(value: unknown): PublishPrepareParams {
  const allowed = ['source', 'idempotencyKey', 'seller', 'confirm', 'draft', 'tag', 'maxWaitMs', 'minIntervalMs']
  if (!inert(value) || !allow(value, allowed)) bad()
  rejectAccountKeys(value)
  const out: PublishPrepareParams = {
    source: source(value.source),
    idempotencyKey: text(value.idempotencyKey, KEY_MAX),
    seller: seller(value.seller),
    confirm: confirm(value.confirm),
    ...schedule(value, ['maxWaitMs', 'minIntervalMs']),
  }
  if (value.draft !== undefined) out.draft = draft(value.draft)
  return out
}

/** publish.submit 严格规范化；缺 prepareToken/draftFingerprint/confirm 一律拒绝。 */
export function normalizePublishSubmitParams(value: unknown): PublishSubmitParams {
  const allowed = ['prepareToken', 'draftFingerprint', 'idempotencyKey', 'confirm', 'tag', 'maxWaitMs', 'minIntervalMs']
  if (!inert(value) || !allow(value, allowed)) bad()
  rejectAccountKeys(value)
  if (value.prepareToken === undefined || value.draftFingerprint === undefined) bad()
  return {
    prepareToken: ref(value.prepareToken, TOKEN_MAX),
    draftFingerprint: ref(value.draftFingerprint, FINGERPRINT_MAX),
    idempotencyKey: text(value.idempotencyKey, KEY_MAX),
    confirm: confirm(value.confirm),
    ...schedule(value, ['maxWaitMs', 'minIntervalMs']),
  }
}

/** publish.myItems 严格规范化；只读分页，不接受账号 scope 和原始游标。 */
export function normalizePublishMyItemsParams(value: unknown): PublishMyItemsParams {
  const allowed = ['limit', 'maxWaitMs', 'minIntervalMs', 'tag']
  if (!inert(value) || !allow(value, allowed)) bad()
  rejectAccountKeys(value)
  return {
    limit: value.limit === undefined ? 100 : integer(value.limit, 1, ITEMS_MAX),
    maxWaitMs: value.maxWaitMs === undefined ? 120000 : integer(value.maxWaitMs, 1, 600000),
    // maxWaitMs 必须列入 schedule 白名单：公共入口先由 validateParams 补出该字段，
    // Host 编排层再规范化一次，因此本函数必须接受自己的输出（幂等），否则公共
    // publish.myItems 一定在进入页面执行器之前被拒绝为 BAD_REQUEST。
    ...schedule(value, ['maxWaitMs', 'minIntervalMs']),
  }
}

/** 把内部游标对象编码为带版本号的 base64url 字符串。 */
export function encodePublishMyItemsCursor(value: unknown): string {
  if (!inert(value) || !allow(value, ['groupId', 'pageNumber', 'pageSize'])) bad()
  const cursor: PublishMyItemsCursor = {
    groupId: integer(value.groupId, 1, Number.MAX_SAFE_INTEGER),
    pageNumber: integer(value.pageNumber, 1, MY_ITEMS_PAGE_NUMBER_MAX),
    pageSize: integer(value.pageSize, 1, MY_ITEMS_PAGE_SIZE_MAX),
  }
  const json = JSON.stringify([1, cursor.groupId, cursor.pageNumber, cursor.pageSize])
  const encoded = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  return `${NEXT_PAGE_PREFIX}${encoded}`
}

/**
 * 严格解码内部游标。
 *
 * 只接受 encodePublishMyItemsCursor 产生的规范格式；未知版本、额外字段、
 * 非法页码或超长字符串都拒绝。游标不含账号秘密，也不能作为授权凭据。
 */
export function decodePublishMyItemsCursor(value: unknown): PublishMyItemsCursor {
  if (typeof value !== 'string' || !value.length || value.length > NEXT_PAGE_MAX || !value.startsWith(NEXT_PAGE_PREFIX)) bad()
  const body = value.slice(NEXT_PAGE_PREFIX.length)
  if (!body.length || !NEXT_PAGE_BODY_PATTERN.test(body)) bad()

  let json: string
  try {
    const padded = body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - body.length % 4) % 4)
    json = atob(padded)
  } catch {
    bad()
  }

  // 拒绝 padding、非规范字符等可产生同一载荷的替代编码。
  const canonicalBody = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  if (canonicalBody !== body) bad()

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    bad()
  }
  if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== 1) bad()
  if (JSON.stringify(parsed) !== json) bad()

  const groupId = integer(parsed[1], 1, Number.MAX_SAFE_INTEGER)
  const pageNumber = integer(parsed[2], 1, MY_ITEMS_PAGE_NUMBER_MAX)
  const pageSize = integer(parsed[3], 1, MY_ITEMS_PAGE_SIZE_MAX)
  return { groupId, pageNumber, pageSize }
}

/**
 * publish.myItems 内部单步规范化。
 *
 * 不接受公共调度字段、平台分页字段或账号 scope；nextPage 必须是本模块
 * 生成并严格可解码的游标。
 */
export function normalizePublishMyItemsStepParams(value: unknown): PublishMyItemsStepParams {
  if (!inert(value) || !allow(value, ['limit', 'nextPage'])) bad()
  rejectAccountKeys(value)
  const out: PublishMyItemsStepParams = { limit: integer(value.limit, 1, ITEMS_MAX) }
  if (value.nextPage !== undefined) {
    decodePublishMyItemsCursor(value.nextPage)
    out.nextPage = value.nextPage as string
  }
  return out
}

/**
 * publish.submit 内部单步规范化。
 *
 * 幂等权威保留在 Host；内部步骤不要求公共 key，也不接受调度字段。
 * 可选 key 仅兼容旧内部调用，仍须校验；不得接受草稿、候选、账号或平台 payload。
 */
export function normalizePublishSubmitStepParams(value: unknown): PublishSubmitStepParams {
  if (!inert(value) || !allow(value, ['prepareToken', 'draftFingerprint', 'idempotencyKey', 'confirm', 'prepareRef'])) bad()
  rejectAccountKeys(value)
  if (value.prepareToken === undefined || value.draftFingerprint === undefined || value.prepareRef === undefined) bad()
  return {
    prepareToken: ref(value.prepareToken, TOKEN_MAX),
    draftFingerprint: ref(value.draftFingerprint, FINGERPRINT_MAX),
    prepareRef: ref(value.prepareRef, 128),
    ...(value.idempotencyKey === undefined ? {} : { idempotencyKey: text(value.idempotencyKey, KEY_MAX) }),
    confirm: confirm(value.confirm),
  }
}

/** prepare 内部规范化；公共幂等键由 Host 维护，调度与账号字段不能进入页面步骤。 */
export function normalizePublishPrepareStepParams(value: unknown): PublishPrepareStepParams {
  if (!inert(value) || !allow(value, ['source', 'seller', 'confirm', 'draft', 'idempotencyKey'])) bad()
  rejectAccountKeys(value)
  return {
    source: source(value.source),
    seller: seller(value.seller),
    confirm: confirm(value.confirm),
    ...(value.draft === undefined ? {} : { draft: draft(value.draft) }),
    ...(value.idempotencyKey === undefined ? {} : { idempotencyKey: text(value.idempotencyKey, KEY_MAX) }),
  }
}

/** 账号范围幂等指纹；tag、等待时间和最小间隔不参与指纹。 */
export function publishFingerprint(accountId: string, method: PublishMethod, params: unknown): { accountId: string; method: PublishMethod; idempotencyKey: string; fingerprint: string } {
  if (typeof accountId !== 'string' || !accountId.trim()) bad()
  if (method === 'publish.prepare') {
    const p = normalizePublishPrepareParams(params)
    const business = { source: p.source, seller: p.seller, confirm: p.confirm, draft: p.draft ?? null }
    return { accountId, method, idempotencyKey: p.idempotencyKey, fingerprint: JSON.stringify([accountId, method, p.idempotencyKey, business]) }
  }
  if (method === 'publish.submit') {
    const p = normalizePublishSubmitParams(params)
    const business = { prepareToken: p.prepareToken, draftFingerprint: p.draftFingerprint, confirm: p.confirm }
    return { accountId, method, idempotencyKey: p.idempotencyKey, fingerprint: JSON.stringify([accountId, method, p.idempotencyKey, business]) }
  }
  bad()
}

function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return inert(value) && Object.keys(value).length === fields.length && fields.every(key => key in value)
}

function optionalText(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= max && value.trim().length > 0)
}

function nullableText(value: unknown, max: number): value is string | null {
  return value === null || optionalText(value, max)
}

function count(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
}

function refArray(value: unknown, max: number): value is string[] {
  if (!Array.isArray(value) || value.length > max) return false
  const seen = new Set<string>()
  return value.every(entry => {
    if (typeof entry !== 'string' || !entry.length || entry.length > REF_MAX || !TOKEN_PATTERN.test(entry) || seen.has(entry)) return false
    seen.add(entry)
    return true
  })
}

function draftSummary(value: unknown): value is PublishDraftSummary {
  if (!exact(value, ['title', 'description', 'price', 'imageCount', 'categoryName', 'attributeNames', 'serviceNames'])) return false
  return nullableText(value.title, TITLE_MAX) &&
    nullableText(value.description, DESCRIPTION_MAX) &&
    nullableText(value.price, 64) &&
    count(value.imageCount, IMAGES_MAX) &&
    nullableText(value.categoryName, TEXT_MAX) &&
    Array.isArray(value.attributeNames) && value.attributeNames.length <= ATTRIBUTE_REFS_MAX && value.attributeNames.every(entry => optionalText(entry, TEXT_MAX)) &&
    Array.isArray(value.serviceNames) && value.serviceNames.length <= SERVICES_MAX && value.serviceNames.every(entry => optionalText(entry, TEXT_MAX))
}

/** 校验 prepare 结果；未知字段、缺 token 或非候选形状都返回 false。 */
export function isPublishPrepareResult(value: unknown): value is PublishPrepareResult {
  if (!exact(value, ['prepareToken', 'draftFingerprint', 'expiresAt', 'draft', 'candidates'])) return false
  if (typeof value.prepareToken !== 'string' || !value.prepareToken.length || value.prepareToken.length > TOKEN_MAX || !TOKEN_PATTERN.test(value.prepareToken)) return false
  if (typeof value.draftFingerprint !== 'string' || !value.draftFingerprint.length || value.draftFingerprint.length > FINGERPRINT_MAX || !TOKEN_PATTERN.test(value.draftFingerprint)) return false
  if (!count(value.expiresAt, Number.MAX_SAFE_INTEGER)) return false
  if (!draftSummary(value.draft)) return false
  const candidates = value.candidates
  if (!exact(candidates, ['categoryRefs', 'attributeRefs', 'serviceRefs'])) return false
  return refArray(candidates.categoryRefs, ATTRIBUTE_REFS_MAX) && refArray(candidates.attributeRefs, ATTRIBUTE_REFS_MAX) && refArray(candidates.serviceRefs, SERVICES_MAX)
}

/** 校验 submit 结果；published 必须有 itemId，其他状态不得携带成功字段。 */
export function isPublishSubmitResult(value: unknown): value is PublishSubmitResult {
  if (!inert(value)) return false
  const state = value.state
  if (state === 'published') {
    if (!exact(value, ['state', 'itemId', 'confirmedAt'])) return false
    return typeof value.itemId === 'string' && value.itemId.length > 0 && value.itemId.length <= ID_MAX &&
      typeof value.confirmedAt === 'number' && Number.isSafeInteger(value.confirmedAt) && value.confirmedAt >= 0
  }
  if (state !== 'rejected' && state !== 'unknown') return false
  if (!exact(value, ['state'])) return false
  return true
}

/** 校验 myItems 结果；itemId 去重，标题只作辅助，hasMore 必须显式。 */
export function isPublishMyItemsResult(value: unknown): value is PublishMyItemsResult {
  if (!exact(value, ['items', 'total', 'hasMore'])) return false
  if (typeof value.hasMore !== 'boolean') return false
  if (!count(value.total, Number.MAX_SAFE_INTEGER)) return false
  const items = value.items
  if (!Array.isArray(items) || items.length > ITEMS_MAX) return false
  const seen = new Set<string>()
  for (const entry of items) {
    if (!inert(entry)) return false
    const keys = Object.keys(entry)
    if (keys.length < 1 || keys.length > 2 || !keys.every(key => key === 'itemId' || key === 'title')) return false
    if (typeof entry.itemId !== 'string' || !entry.itemId.length || entry.itemId.length > ID_MAX) return false
    if (entry.title !== undefined && !optionalText(entry.title, TITLE_MAX)) return false
    if (seen.has(entry.itemId)) return false
    seen.add(entry.itemId)
  }
  return true
}

/** 严格校验发布方法的成功输出；未知方法一律返回 false。 */
export function isPublishResult(method: PublishMethod, data: unknown): boolean {
  if (method === 'publish.prepare') return isPublishPrepareResult(data)
  if (method === 'publish.submit') return isPublishSubmitResult(data)
  if (method === 'publish.myItems') return isPublishMyItemsResult(data)
  return false
}

/** 单步参数判别：只验证形状，不抛错，供 native 帧白名单使用。 */
export function isPublishPrepareParams(value: unknown): value is PublishPrepareParams {
  try { normalizePublishPrepareParams(value); return true } catch { return false }
}
/** prepare 内部帧判别；不放宽公共 API 的必填幂等键规则。 */
export function isPublishPrepareStepParams(value: unknown): value is PublishPrepareStepParams {
  try { normalizePublishPrepareStepParams(value); return true } catch { return false }
}
export function isPublishSubmitParams(value: unknown): value is PublishSubmitParams {
  try { normalizePublishSubmitParams(value); return true } catch { return false }
}
export function isPublishSubmitStepParams(value: unknown): value is PublishSubmitStepParams {
  try { normalizePublishSubmitStepParams(value); return true } catch { return false }
}
export function isPublishMyItemsParams(value: unknown): value is PublishMyItemsParams {
  try { normalizePublishMyItemsParams(value); return true } catch { return false }
}
export function isPublishMyItemsStepParams(value: unknown): value is PublishMyItemsStepParams {
  try { normalizePublishMyItemsStepParams(value); return true } catch { return false }
}
export function isPublishMyItemsCursor(value: unknown): value is PublishMyItemsCursor {
  try { decodePublishMyItemsCursor(value); return true } catch { return false }
}
