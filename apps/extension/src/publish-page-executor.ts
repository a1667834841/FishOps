/**
 * 发布页面执行器（MAIN world 可注入，离线不接真实平台）。
 *
 * 所有平台访问只经过注入的 mtopRequest；发布结果不包含 cookie、token、
 * 原始响应或完整地址/正文。submit 是唯一写平台路径，未知结果禁止重放。
 */

import {
  decodePublishMyItemsCursor,
  encodePublishMyItemsCursor,
  isPublishMyItemsResult,
  isPublishPrepareResult,
  normalizePublishMyItemsParams,
  normalizePublishMyItemsStepParams,
  normalizePublishPrepareParams,
  normalizePublishSubmitParams,
  type PublishMyItem,
  type PublishMyItemsParams,
  type PublishMyItemsStepParams,
  type PublishPrepareParams,
  type PublishPrepareResult,
  type PublishSubmitParams,
} from '../../../packages/protocol/src/publish.ts'
import { ApiError } from './errors.ts'

/** MTOP SDK 官方请求函数；通过页面 window.lib.mtop.request 注入，测试使用替身。 */
export type MtopRequestFn = (
  api: string,
  version: string,
  data: Record<string, unknown>,
  headers?: Record<string, string>,
) => Promise<MtopResponse>

/** MTOP 响应的最小形状；调用方不得假设 data 具体类型。 */
export interface MtopResponse {
  /** MTOP ret 数组；成功时 ret[0] 以 'SUCCESS' 开头。 */
  ret: string[]
  /** 业务数据；成功时结构由各接口定义。 */
  data?: unknown
}

/** 上传接口返回的最小对象；只接受成功响应中的安全字段。 */
export type PublishUploadedImage = {
  url: string
  widthSize: number
  heightSize: number
}

/**
 * 页面图片上传适配器。
 *
 * 生产实现应使用页面 fetch/XHR 与官方上传域名；执行器不自行拼接上传
 * 地址，也不接受调用方提交的自报宽高或 blob URL。
 */
export type PublishImageUploader = {
  upload(source: { kind: 'url'; url: string }): Promise<PublishUploadedImage>
}

/** prepare 后才可提交的权威核心；只在页面/扩展内部流转。 */
export type PublishPreparedCore = {
  description: string
  priceYuan: string
  specifications: Array<{ name: string; value: string }>
  itemCatDTO: Record<string, string>
  itemLabelExtList: Record<string, unknown>[]
  itemAddrDTO: Record<string, string>
  imageInfoDOList: Record<string, unknown>[]
  services: Array<{ serviceCode: string; enable: boolean }>
}

/**
 * 页面侧短期权威准备数据。
 *
 * 该对象含 rawCards/transportData/已上传图片等内部字段，不能进入公共
 * 结果、日志或持久化明文；submit 通过 Host 指纹取回。
 */
export type PublishPreparedContext = {
  accountId: string
  sourceItemId: string
  expiresAt: number
  /** Host 可持久化的受控内部引用；不含原始推荐卡、地址或图片对象。 */
  prepareRef: string
  core: PublishPreparedCore
  /** 已按最终选择刷新 isClicked/isUserClick 的推荐卡。 */
  rawCards: unknown[]
  /** Host 的业务指纹；submit 必须与 Host 传入值一致。 */
  draftFingerprint: string
}

/** 发布页面上下文存储；生产实现应在扩展内按 token 隔离并限时。 */
export interface PublishPreparedStore {
  get(token: string): PublishPreparedContext | null | Promise<PublishPreparedContext | null>
  set(token: string, value: PublishPreparedContext): void | Promise<void>
  delete(token: string): void | Promise<void>
}

/** 发布执行器的外部依赖；生产由 Chrome 适配层注入，测试注入替身。 */
export interface PublishPageExecutorDeps {
  /** 注入的 MTOP 请求函数；只能通过此函数调用官方接口，绝不直连 HTTP。 */
  mtopRequest: MtopRequestFn
  /** 读取当前登录账号 id；无法确认时返回 null。 */
  readAccountId: () => string | null | Promise<string | null>
  /** 毫秒时间戳；用于 uniqueCode 与 prepare 过期时间，测试可固定。 */
  now: () => number
  /** Host 已授权的权威 prepare 上下文；生产可接扩展内存存储。 */
  preparedStore?: PublishPreparedStore
  /** 生成不可猜的 prepareToken；生产必须注入随机源，测试可固定。 */
  createPrepareToken?: () => string
  /** Host 签发的草稿指纹；页面只读取并绑定，不接受调用方提交时覆盖。 */
  readDraftFingerprint?: (token: string) => string | null | Promise<string | null>
  /** 页面/扩展已上传图片的权威集合；按引用查找，不从调用方 JSON 猜测宽高。 */
  uploadedImages?: Record<string, PublishUploadedImage>
  /** 页面真实上传适配器；URL 图片必须经它上传，不能直接进入平台 payload。 */
  uploadImage?: PublishImageUploader
}

/**
 * prepare 的页面单步结果。
 *
 * Host 只接受脱敏摘要与候选集合；权威上下文先写入页面/扩展内部
 * preparedStore，不能经过 Host 或公共协议。
 */
export type PublishPreparePageResult = Pick<PublishPrepareResult, 'draft' | 'candidates'> & {
  /** Host 用于取回页面权威上下文的内部引用；不能进入公共结果。 */
  prepareRef: string
}
/** myItems 单页结果；nextPage 是 Host 内部不透明游标。 */
export type PublishMyItemsPage = { items: PublishMyItem[]; hasMore: boolean; nextPage?: string }
/** prepare 执行结果。 */
export type PrepareOutcome =
  | { ok: true; result: PublishPreparePageResult }
  | { ok: false; error: ApiError }
/** submit 单步结果：itemId 只是页面证据，最终 published 必须由 Host 用 myItems 确认。 */
export type PublishSubmitPageResult = { outcome: 'accepted' | 'rejected'; itemId?: string }
/** submit 执行结果。 */
export type SubmitOutcome =
  | { ok: true; result: PublishSubmitPageResult }
  | { ok: false; error: ApiError }
/** myItems 执行结果。 */
export type MyItemsOutcome =
  | { ok: true; result: PublishMyItemsPage }
  | { ok: false; error: ApiError }

/** 单次 myItems 分页安全上限；Host 还会跨步骤限制总页数。 */
const MY_ITEMS_MAX_PAGES_PER_CALL = 20
const MY_ITEMS_PAGE_SIZE_MAX = 20
const MY_ITEMS_GROUP_NAME = '在售'
const PREPARE_TTL_MS = 30 * 60 * 1000
const IMAGE_MAX = 9
const DESCRIPTION_MAX = 5000

/**
 * 页面内默认的记忆存储。
 *
 * 生产入口当前只注入 mtopRequest；默认存储保证 prepare 与 submit 至少在同一
 * MAIN world 生命周期内可绑定。真实部署仍应注入按账号分区的持久会话存储。
 */
const DEFAULT_PREPARED_MAX = 100
const defaultPreparedStore = new Map<string, PublishPreparedContext>()

function memoryPreparedStore(): PublishPreparedStore {
  return {
    get: token => defaultPreparedStore.get(token) ?? null,
    set: (token, value) => {
      defaultPreparedStore.delete(token)
      defaultPreparedStore.set(token, value)
      if (defaultPreparedStore.size > DEFAULT_PREPARED_MAX) {
        const oldest = defaultPreparedStore.keys().next().value
        if (oldest !== undefined) defaultPreparedStore.delete(oldest)
      }
    },
    delete: token => { defaultPreparedStore.delete(token) },
  }
}

/**
 * 与 Host buildPrepared 使用同一 canonical 输入生成业务指纹。
 *
 * 页面不能在 prepare 时拿到 Host 稍后才生成的随机 token；以该指纹作为页面
 * 内部权威存储键，submit 步骤即可用 Host 回传的 draftFingerprint 找回数据。
 */
function contentFingerprint(params: PublishPrepareParams, accountId: string): string {
  return JSON.stringify([accountId, params.source.itemId, params.draft])
}

/** 非加密的规范摘要；仅在 WebCrypto 不可用时作为索引兜底。 */
function fallbackFingerprint(canonical: string): string {
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < canonical.length; index += 1) {
    const code = canonical.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193) >>> 0
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0
  }
  return `fb-${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`
}

/** 浏览器可用的 SHA-256；不可用时返回 null，由调用方决定是否失败关闭。 */
async function sha256Hex(value: string): Promise<string | null> {
  try {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) return null
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value))
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}

// ─── MTOP ret 工具函数 ────────────────────────────────────────────────────────

function retCode(resp: MtopResponse): string {
  const first = Array.isArray(resp.ret) ? resp.ret[0] : undefined
  if (typeof first !== 'string') return ''
  const idx = first.indexOf('::')
  return idx === -1 ? first : first.slice(0, idx)
}

function retMessage(resp: MtopResponse): string {
  const first = Array.isArray(resp.ret) ? resp.ret[0] : undefined
  if (typeof first !== 'string') return ''
  const idx = first.indexOf('::')
  return idx === -1 ? '' : first.slice(idx + 2)
}

function isRetOk(resp: MtopResponse): boolean {
  return retCode(resp).startsWith('SUCCESS')
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim()
    : typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// ─── 错误分类 ─────────────────────────────────────────────────────────────────

const RISK_PATTERN =
  /CAPTCHA|USER_VALIDATE|VALIDATE|RGV587|_TMD_|X5SEC|PUNISH|STRONG_VALID|LIVE_CERT/i

const LOGIN_PATTERN =
  /SESSION_EXPIRED|NOT_LOGIN|LOGIN_REQUIRED|TOKEN_EXPIRED|TOKEN_EMPTY|TOKEN_INVALID/i

/** 将 MTOP ret 码归一化为脱敏 ApiError，不透传平台原始消息。 */
function classifyMtopError(code: string, _message: string): ApiError {
  const upper = code.toUpperCase()
  if (RISK_PATTERN.test(upper)) {
    return new ApiError('RISK_BLOCKED', '请求被平台风控拦截，需要人工完成验证后重试', { phase: 'write', retryable: false })
  }
  if (LOGIN_PATTERN.test(upper)) {
    return new ApiError('LOGIN_REQUIRED', '需要登录闲鱼账号或登录状态已失效，请先登录后重试', { phase: 'write', retryable: false })
  }
  if (upper.startsWith('FAIL_BIZ_')) {
    return new ApiError('PLATFORM_REJECTED', '闲鱼接口明确拒绝了本次请求', { phase: 'write', retryable: false })
  }
  return new ApiError('RESULT_UNKNOWN', '闲鱼接口返回未预期响应，结果未知', { phase: 'write', retryable: false })
}

/** 将 SDK reject 归一化；不把原始 message 带出执行器。 */
function classifyMtopException(err: unknown, phase: 'read' | 'write' = 'write'): ApiError {
  if (err instanceof ApiError) return err
  const e = record(err)
  const ret = e?.['ret']
  if (Array.isArray(ret) && typeof ret[0] === 'string') {
    const raw = ret[0]
    const idx = raw.indexOf('::')
    const code = idx === -1 ? raw : raw.slice(0, idx)
    return phase === 'read'
      ? classifyReadMtopError(code)
      : classifyMtopError(code, idx === -1 ? '' : raw.slice(idx + 2))
  }
  const message = typeof e?.['message'] === 'string' ? e['message'].toLowerCase() : ''
  if (message.includes('timeout') || message.includes('超时')) {
    return new ApiError('TIMEOUT', phase === 'read' ? '读取请求超时，结果未知，禁止自动重试' : '发布请求超时，结果未知，禁止自动重试', {
      phase,
      retryable: false,
    })
  }
  return new ApiError('RESULT_UNKNOWN', phase === 'read' ? '读取请求异常，结果未知' : '发布请求异常，结果未知，禁止自动重试', {
    phase,
    retryable: false,
  })
}

function readFailure(message: string, code: 'PLATFORM_REJECTED' | 'RESULT_UNKNOWN' = 'RESULT_UNKNOWN'): ApiError {
  return new ApiError(code, message, { phase: 'read', retryable: false })
}

function writeRejected(message: string): ApiError {
  return new ApiError('PLATFORM_REJECTED', message, { phase: 'write', retryable: false })
}

// ─── 账号核验 ─────────────────────────────────────────────────────────────────

const ACCOUNT_DRIFT_MSG = '执行账号已变化或无法确认，本步骤结果不返回'
const SUBMIT_TOKEN_CACHE_LIMIT = 100
/** Host 先读取 token 以外的业务参数；页面在首次 submit 时把 token 绑定到指纹。 */
const submitTokenCache = new Map<string, string>()

async function requireAccount(
  readAccountId: () => string | null | Promise<string | null>,
  expected: string,
  phase: 'read' | 'write' = 'write',
): Promise<void> {
  let current: string | null
  try {
    current = await readAccountId()
  } catch {
    throw new ApiError('ACCOUNT_CHANGED', ACCOUNT_DRIFT_MSG, { phase, retryable: false })
  }
  if (current !== expected) {
    throw new ApiError('ACCOUNT_CHANGED', ACCOUNT_DRIFT_MSG, { phase, retryable: false })
  }
}

// ─── 低层请求与字段工具 ───────────────────────────────────────────────────────

async function request(
  deps: PublishPageExecutorDeps,
  api: string,
  version: string,
  data: Record<string, unknown>,
  headers?: Record<string, string>,
  phase: 'read' | 'write' = 'read',
): Promise<MtopResponse> {
  try {
    return await deps.mtopRequest(api, version, data, headers)
  } catch (error) {
    throw classifyMtopException(error, phase)
  }
}

async function requireSuccess(
  deps: PublishPageExecutorDeps,
  api: string,
  version: string,
  data: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await request(deps, api, version, data, headers, 'read')
  if (!isRetOk(response)) throw classifyReadMtopError(retCode(response))
  const payload = record(response.data)
  if (!payload) {
    throw new ApiError('PLATFORM_REJECTED', '闲鱼接口返回结构不完整', { phase: 'read', retryable: false })
  }
  return payload
}

/** 只读接口错误不伪装成发布写入失败。 */
function classifyReadMtopError(code: string): ApiError {
  const upper = code.toUpperCase()
  if (RISK_PATTERN.test(upper)) {
    return new ApiError('RISK_BLOCKED', '读取请求被平台风控拦截，需要人工完成验证后重试', { phase: 'read', retryable: false })
  }
  if (LOGIN_PATTERN.test(upper)) {
    return new ApiError('LOGIN_REQUIRED', '需要登录闲鱼账号或登录状态已失效，请先登录后重试', { phase: 'read', retryable: false })
  }
  if (upper.startsWith('FAIL_BIZ_')) {
    return new ApiError('PLATFORM_REJECTED', '闲鱼接口明确拒绝了本次读取请求', { phase: 'read', retryable: false })
  }
  return new ApiError('RESULT_UNKNOWN', '闲鱼接口返回未预期响应，读取结果未知', { phase: 'read', retryable: false })
}

function makeUniqueCode(now: () => number): string {
  return String(now()) + String(Math.floor(Math.random() * 1000))
}

function toCentString(value: string): string {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return '0'
  return String(Math.round(number * 100))
}

function normalizeAddress(value: unknown): Record<string, string> | null {
  const raw = record(value)
  if (!raw) return null
  const latitude = text(raw['latitude'])
  const longitude = text(raw['longitude'])
  const gps = text(raw['gps']) || (latitude && longitude ? `${latitude},${longitude}` : '')
  const gpsParts = gps.split(',')
  if (gpsParts.length !== 2) return null
  const lat = Number(gpsParts[0])
  const lng = Number(gpsParts[1])
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null
  }
  const address = {
    prov: text(raw['prov']),
    city: text(raw['city']),
    area: text(raw['area']),
    divisionId: text(raw['divisionId']),
    poiName: text(raw['poiName']) || text(raw['poi']) || text(raw['address']),
    poiId: text(raw['poiId']),
    gps: `${gpsParts[0]},${gpsParts[1]}`,
  }
  return Object.values(address).every(Boolean) ? address : null
}

function addressFromSelectedPoi(payload: Record<string, unknown>): Record<string, string> {
  const address = normalizeAddress(payload['selectedPoi'])
  if (!address) {
    throw readFailure('账号未选择有效且坐标合法的官方发货地址（仅接受 selectedPoi）', 'PLATFORM_REJECTED')
  }
  return address
}

function mapSpecifications(value: unknown): Array<{ name: string; value: string }> {
  if (!Array.isArray(value)) return []
  const result: Array<{ name: string; value: string }> = []
  for (const raw of value) {
    const item = record(raw)
    if (!item) continue
    const name = text(item['propertyName']) || text(item['name']) || text(item['text'])
    const valueText = text(item['valueName']) || text(item['value']) || text(item['text'])
    if (name && valueText && name !== valueText) result.push({ name, value: valueText })
  }
  return result
}

// ─── 权威候选与 payload 构造 ──────────────────────────────────────────────────

type NormalizedCard = {
  cardType: string
  propertyId: string
  propertyName: string
  isBook: boolean
  supportWebPublish: boolean
  values: Array<Record<string, unknown>>
}

type Candidate = {
  valueId: string
  valueName: string
  transportData: Record<string, unknown>
  isCategory: boolean
  catId?: string
  channelCatId?: string
  catName?: string
  leafId?: string
  tbCatId?: string
}

function normalizeCards(rawCards: unknown[]): NormalizedCard[] {
  return rawCards.flatMap((raw) => {
    const outer = record(raw)
    if (!outer) return []
    const card = record(outer['cardData']) ?? outer
    const values = Array.isArray(card['valuesList'])
      ? card['valuesList']
      : Array.isArray(card['values']) ? card['values'] : []
    return [{
      cardType: text(outer['cardType']),
      propertyId: text(card['propertyId']),
      propertyName: text(card['propertyName']),
      isBook: card['isBook'] === true,
      supportWebPublish: card['supportWebPublish'] !== false,
      values: values.filter((entry): entry is Record<string, unknown> => record(entry) !== null),
    }]
  })
}

function buildCandidate(card: NormalizedCard, raw: Record<string, unknown>): Candidate | null {
  const isCategory = card.propertyId === '-10000'
  const valueId = isCategory
    ? text(raw['channelCatId']) || text(raw['catId']) || text(raw['valueId'])
    : text(raw['valueId']) || text(raw['id'])
  const valueName = isCategory
    ? text(raw['catName']) || text(raw['channelCateName']) || text(raw['valueName'])
    : text(raw['valueName']) || text(raw['name'])
  if (!valueId || !valueName) return null
  const candidate: Candidate = {
    valueId,
    valueName,
    transportData: record(raw['transportData']) ? clone(raw['transportData'] as Record<string, unknown>) : {},
    isCategory,
  }
  if (isCategory) {
    candidate.catId = text(raw['catId']) || text(raw['channelCatId']) || text(raw['valueId'])
    candidate.channelCatId = text(raw['channelCatId']) || text(raw['catId']) || text(raw['valueId'])
    candidate.catName = valueName
    candidate.leafId = text(raw['leafId']) || '0'
    candidate.tbCatId = text(raw['tbCatId'])
  }
  return candidate
}

function labelItem(card: NormalizedCard, candidate: Candidate): Record<string, unknown> {
  const item: Record<string, unknown> = {
    ...clone(candidate.transportData),
    propertyName: card.propertyName,
    propertyId: card.propertyId,
    isUserClick: '1',
    isUserCancel: '0',
    text: candidate.valueName,
    properties: `${card.propertyId}##${card.propertyName}:${candidate.valueId}##${candidate.valueName}`,
  }
  if (candidate.isCategory) {
    item['channelCateId'] ??= candidate.channelCatId || candidate.catId || ''
    item['channelCateName'] ??= candidate.catName || candidate.valueName
  } else {
    item['valueId'] ??= candidate.valueId
    item['valueName'] ??= candidate.valueName
  }
  return item
}

function chooseCategory(
  cards: NormalizedCard[],
  requested: string | undefined,
): { card: NormalizedCard; candidate: Candidate } | null {
  const card = cards.find(entry => entry.propertyId === '-10000')
  if (!card) return null
  if (card.cardType !== '20401' || card.isBook || !card.supportWebPublish) return null
  const entries = card.values
    .map(raw => ({ raw, candidate: buildCandidate(card, raw) }))
    .filter((entry): entry is { raw: Record<string, unknown>; candidate: Candidate } => entry.candidate !== null)
  const selected = requested
    ? entries.find(entry => entry.candidate.valueId === requested)
    : entries.find(entry => text(entry.raw['isClicked']) === '1') ?? entries[0]
  return selected ? { card, candidate: selected.candidate } : null
}

function chooseAttributes(
  cards: NormalizedCard[],
  requested: string[] | undefined,
): Array<{ card: NormalizedCard; candidate: Candidate }> {
  const attributes: Array<{ card: NormalizedCard; candidate: Candidate }> = []
  for (const card of cards) {
    if (card.propertyId === '-10000') continue
    const entries = card.values
      .map(raw => ({ raw, candidate: buildCandidate(card, raw) }))
      .filter((entry): entry is { raw: Record<string, unknown>; candidate: Candidate } => entry.candidate !== null)
    const selected = requested
      ? entries.filter(entry => requested.includes(entry.candidate.valueId))
      : entries.filter(entry => text(entry.raw['isClicked']) === '1')
    for (const entry of selected) attributes.push({ card, candidate: entry.candidate })
  }
  return attributes
}

function finalDescription(description: string, specs: Array<{ name: string; value: string }>): string {
  return specs.length > 0
    ? `${description}\n${specs.map(item => `${item.name}：${item.value}`).join('\n')}`
    : description
}

/**
 * 按最终类目/属性选择刷新推荐卡状态。
 *
 * service.cards.list 会读取 isClicked/isUserClick；不能复用 prepare 时
 * 推荐接口的旧状态，否则用户改选后服务候选仍按旧条件计算。
 */
function applySelectionToRawCards(
  rawCards: unknown[],
  itemLabelExtList: Record<string, unknown>[],
): unknown[] {
  const selected = new Map<string, Set<string>>()
  for (const label of itemLabelExtList) {
    const propertyId = text(label['propertyId'])
    if (!propertyId) continue
    // 类目 label 以 channelCateId 为准；普通属性 label 使用协议固定的
    // `propertyId##name:valueId##valueName` 串解析，避免 label 额外字段改变匹配。
    const properties = text(label['properties'])
    const separator = properties.startsWith(`${propertyId}##`)
      ? properties.indexOf(':')
      : -1
    const next = separator === -1 ? -1 : properties.indexOf('##', separator + 1)
    const parsedValueId = separator === -1 || next === -1
      ? ''
      : properties.slice(separator + 1, next)
    const valueId = propertyId === '-10000'
      ? text(label['channelCateId'])
      : parsedValueId || text(label['valueId'])
    if (!valueId) continue
    let values = selected.get(propertyId)
    if (!values) {
      values = new Set<string>()
      selected.set(propertyId, values)
    }
    values.add(valueId)
  }

  const cloned = clone(rawCards)
  for (const raw of cloned) {
    const outer = record(raw)
    if (!outer) continue
    const cardData = record(outer['cardData']) ?? outer
    const propertyId = text(cardData['propertyId'])
    const wanted = selected.get(propertyId)
    const values = Array.isArray(cardData['valuesList'])
      ? cardData['valuesList']
      : Array.isArray(cardData['values']) ? cardData['values'] : []
    for (const entry of values) {
      const value = record(entry)
      if (!value) continue
      const isCategory = propertyId === '-10000'
      const valueId = isCategory
        ? text(value['channelCatId']) || text(value['catId']) || text(value['valueId'])
        : text(value['valueId']) || text(value['id'])
      const hit = Boolean(wanted?.has(valueId))
      value['isClicked'] = hit ? '1' : '0'
      if (hit) value['isUserClick'] = '1'
    }
  }
  return cloned
}

function buildSubmitPayload(
  core: PublishPreparedCore,
  services: Array<{ serviceCode: string; enable: boolean }>,
  uniqueCode: string,
): Record<string, unknown> {
  const description = finalDescription(core.description, core.specifications)
  return {
    freebies: false,
    itemTypeStr: 'b',
    quantity: '1',
    simpleItem: 'true',
    itemTextDTO: { desc: description, title: description, titleDescSeparate: false },
    itemPriceDTO: { priceInCent: toCentString(core.priceYuan) },
    itemPostFeeDTO: { canFreeShipping: true, supportFreight: true, onlyTakeSelf: false },
    itemAddrDTO: clone(core.itemAddrDTO),
    itemCatDTO: clone(core.itemCatDTO),
    itemLabelExtList: clone(core.itemLabelExtList),
    imageInfoDOList: clone(core.imageInfoDOList),
    publishScene: 'pcMainPublish',
    userRightsProtocols: services.map(service => ({
      serviceCode: service.serviceCode,
      enable: service.serviceCode === 'AI_SALE' ? false : service.enable,
    })),
    sourceId: 'pcMainPublish',
    bizcode: 'pcMainPublish',
    uniqueCode,
  }
}

/**
 * 解析页面权威上下文的存储键。
 *
 * 生产不能依赖页面自造 token，因为 Host 在页面 prepare 返回后才签发 token；
 * 因此统一使用 Host 同 canonical 输入的指纹。注入 createPrepareToken 仅用于
 * 测试和兼容旧调用，另存别名，不改变主键。
 */
function resolvePrepareStoreKey(fingerprint: string): string {
  return fingerprint
}

/** 内部 prepare 引用只允许受限字符集，避免把平台字段或任意 payload 当索引。 */
function makePrepareRef(fingerprint: string): string {
  // 指纹在 WebCrypto 可用时已是 SHA-256；不要再对短摘要做非加密压缩。
  return `prep.${/^[0-9a-f]{64}$/.test(fingerprint) ? fingerprint : fallbackFingerprint(fingerprint)}`
}

// ─── prepare 执行器 ───────────────────────────────────────────────────────────

/**
 * 执行 publish.prepare：只读准备并生成权威核心。
 *
 * 图片必须先由注入的上传适配器完成真实上传；`kind: uploaded` 只引用
 * 已确认的上传结果。URL 图片没有适配器时 fail-closed，绝不构造伪造结果。
 */
export async function executePrepare(
  params: PublishPrepareParams,
  accountId: string,
  deps: PublishPageExecutorDeps,
): Promise<PrepareOutcome> {
  try {
    await requireAccount(deps.readAccountId, accountId, 'read')
    if (params.confirm.imageNoQr !== true || params.confirm.addressConfirmed !== true) {
      return { ok: false, error: writeRejected('发布准备缺少显式人工确认') }
    }

    const check = await requireSuccess(deps, 'mtop.idle.pc.idleitem.prepublish.check', '1.0', {})
    if (check['limited'] === true) return { ok: false, error: writeRejected('发布资格受限，需人工处理') }

    // preget 仅读取能力；登录/风控错误必须中断，其余错误不阻断后续准备。
    try {
      const preget = await deps.mtopRequest('mtop.idle.pc.idleitem.preget', '1.0', {})
      if (!isRetOk(preget)) {
        const failure = classifyMtopError(retCode(preget), retMessage(preget))
        if (failure.code === 'LOGIN_REQUIRED' || failure.code === 'RISK_BLOCKED') throw failure
      }
    } catch (error) {
      const failure = error instanceof ApiError ? error : classifyMtopException(error)
      if (failure.code === 'LOGIN_REQUIRED' || failure.code === 'RISK_BLOCKED') throw failure
    }

    const detail = await requireSuccess(deps, 'mtop.taobao.idle.pc.detail', '1.0', { itemId: params.source.itemId })
    const itemDO = record(detail['itemDO'])
    if (!itemDO) return { ok: false, error: writeRejected('源商品详情缺少 itemDO，无法准备发布') }
    const sourceDescription = text(itemDO['desc']) || text(itemDO['title'])
    if (!sourceDescription) return { ok: false, error: writeRejected('源商品描述为空，无法准备发布') }
    const sourcePrice = text(itemDO['soldPrice'])
    if (toCentString(sourcePrice) === '0') return { ok: false, error: writeRejected('源商品售价必须大于 0 元') }
    if (params.draft?.specs !== undefined && params.draft.specs.length === 0) {
      return { ok: false, error: writeRejected('草稿规格必须至少包含一项') }
    }
    // 规格会进入最终描述。调用方显式覆盖时必须用该选择完成预检、指纹和
    // 提交 payload，不能页面审阅一套、平台提交另一套。
    const sourceSpecs = params.draft?.specs === undefined
      ? mapSpecifications(itemDO['itemLabelExtList'])
      : params.draft.specs.map(item => ({ name: item.key, value: item.value }))
    const description = params.draft?.description ?? sourceDescription
    // 官方网页协议使用正文作为标题；不能接受一个只展示、不实际提交的标题。
    if (params.draft?.title !== undefined && params.draft.title !== description) {
      return { ok: false, error: writeRejected('网页发布不支持独立标题，title 必须与 description 一致或省略') }
    }
    const title = finalDescription(description, sourceSpecs)
    const price = params.draft?.price
      ? params.draft.price.kind === 'fixed' ? String(params.draft.price.amount) : sourcePrice
      : sourcePrice
    if (toCentString(price) === '0') return { ok: false, error: writeRejected('草稿售价必须大于 0 元') }

    const sourceImages = Array.isArray(itemDO['imageInfos'])
      ? itemDO['imageInfos'].flatMap(raw => {
        const info = record(raw)
        const url = text(info?.['url'])
        return url ? [url] : []
      })
      : []
    const requestedImages = params.draft?.images
    const sourceImageInput = sourceImages.map(url => ({ kind: 'url' as const, url }))
    const images = (requestedImages ?? sourceImageInput).slice(0, IMAGE_MAX)
    if (images.length === 0) return { ok: false, error: writeRejected('商品图片为空，无法准备发布') }
    const checkedText = finalDescription(description, sourceSpecs)
    const badwordsResponse = await request(deps, 'mtop.taobao.idleitem.badwords.prepubcheck', '2.0', {
      title: checkedText,
      scene: 'pcPublish',
      sessionId: String(deps.now()),
    }, undefined, 'read')
    if (!isRetOk(badwordsResponse)) throw classifyReadMtopError(retCode(badwordsResponse))
    const badwords = record(badwordsResponse.data)
    if (!badwords || typeof badwords['forbidPublish'] !== 'boolean') {
      throw readFailure('违禁词预检缺少有效 forbidPublish，按失败关闭处理', 'PLATFORM_REJECTED')
    }
    if (badwords['forbidPublish'] === true) return { ok: false, error: writeRejected('文案包含违禁内容，禁止发布') }


    const imageInfoDOList: Record<string, unknown>[] = []
    for (const [index, image] of images.entries()) {
      let uploaded: PublishUploadedImage | null | undefined
      if (image.kind === 'url') {
        if (!deps.uploadImage) {
          return { ok: false, error: writeRejected('当前页面执行器未注入图片上传适配器，URL 图片不能直接提交') }
        }
        let url: URL
        try {
          url = new URL(image.url.startsWith('//') ? `https:${image.url}` : image.url)
        } catch {
          return { ok: false, error: writeRejected('商品图片 URL 无效') }
        }
        // 平台详情接口对阿里 CDN 图片返回 http:// 链接；该 CDN 同路径支持 HTTPS，
        // 因此仅对 alicdn.com 域名做协议升级，其它域名的 http 链接仍拒绝。
        if (url.protocol === 'http:' && (url.hostname === 'alicdn.com' || url.hostname.endsWith('.alicdn.com'))) url.protocol = 'https:'
        if (url.protocol !== 'https:') {
          return { ok: false, error: writeRejected('远程商品图片只允许 HTTPS') }
        }
        try {
          uploaded = await deps.uploadImage.upload({ kind: 'url', url: url.href })
        } catch {
          return { ok: false, error: writeRejected(`第 ${index + 1} 张图片上传失败，禁止提交未上传图片`) }
        }
      } else {
        // uploaded.ref 只查注入的上传结果表；不接受裸 URL 或客户端自报宽高。
        uploaded = deps.uploadedImages?.[image.ref]
      }
      if (!uploaded) {
        return { ok: false, error: writeRejected('已上传图片引用不存在或上传结果不可信') }
      }
      const url = text(uploaded.url)
      const width = Number(uploaded.widthSize)
      const height = Number(uploaded.heightSize)
      if (!url || !/^https:\/\//i.test(url) ||
        !Number.isSafeInteger(width) || width <= 0 ||
        !Number.isSafeInteger(height) || height <= 0) {
        return { ok: false, error: writeRejected('已上传图片缺少有效 URL 或真实宽高') }
      }
      imageInfoDOList.push({
        extraInfo: { isH: 'false', isT: 'false', raw: 'false' },
        isQrCode: false,
        url,
        heightSize: height,
        widthSize: width,
        major: index === 0,
        type: 0,
        status: 'done',
      })
    }

    const recommend = await requireSuccess(deps, 'mtop.taobao.idle.kgraph.property.recommend', '2.0', {
      title: checkedText,
      description: checkedText,
      imageInfos: imageInfoDOList,
      lockCpv: false,
      multiSKU: false,
      publishScene: 'mainPublish',
      scene: 'newPublishChoice',
      uniqueCode: makeUniqueCode(deps.now),
    })
    const rawCards = Array.isArray(recommend['cardList']) ? recommend['cardList'] : []
    if (rawCards.length === 0) return { ok: false, error: writeRejected('未取得类目/属性推荐，禁止发布') }
    const cards = normalizeCards(rawCards)
    const category = chooseCategory(cards, params.draft?.categoryRef)
    if (!category) return { ok: false, error: writeRejected('未取得有效网页发布类目，禁止发布') }
    const attributes = chooseAttributes(cards, params.draft?.attributeRefs)
    const itemLabelExtList = [
      labelItem(category.card, category.candidate),
      ...attributes.map(entry => labelItem(entry.card, entry.candidate)),
    ]
    const selectedRawCards = applySelectionToRawCards(rawCards, itemLabelExtList)
    const itemCatDTO = {
      catId: category.candidate.catId || category.candidate.valueId,
      catName: category.candidate.catName || category.candidate.valueName,
      channelCatId: category.candidate.channelCatId || category.candidate.valueId,
      leafId: category.candidate.leafId || '0',
      tbCatId: category.candidate.tbCatId || '',
    }

    const poi = await requireSuccess(deps, 'mtop.taobao.idle.local.poi.get', '1.0', {}, {
      'EagleEye-UserData': 'spm-cnt=a21ybx',
    })
    const address = addressFromSelectedPoi(poi)
    // 调用方给出的 addressRef 只是在已授权地址集合中的引用；当前页面
    // 接口只返回账号已选 selectedPoi，不能把它当作任意 addressRef 的解析器。
    // 因此只有引用与 selectedPoi 的稳定 ID 完全一致时才继续，避免静默发布到
    // 另一个地址。
    if (params.seller.addressRef !== address['poiId']) {
      return { ok: false, error: writeRejected('请求地址与账号当前已选官方发货地址不一致，请先在官方发布页选择后重试') }
    }

    const intermediate = {
      freebies: false,
      itemTypeStr: 'b',
      quantity: '1',
      simpleItem: 'true',
      itemTextDTO: { desc: checkedText, title: checkedText, titleDescSeparate: false },
      itemPriceDTO: { priceInCent: toCentString(price) },
      itemPostFeeDTO: { canFreeShipping: true, supportFreight: true, onlyTakeSelf: false },
      itemAddrDTO: address,
      itemCatDTO,
      itemLabelExtList,
      imageInfoDOList,
      defaultPrice: false,
      publishScene: 'mainPublish',
    }
    const serviceCards = await requireSuccess(deps, 'mtop.idle.item.publish.service.cards.list', '1.0', {
      cpvList: JSON.stringify(selectedRawCards),
      itemInfoJson: JSON.stringify(intermediate),
      param: JSON.stringify({ multiSkuEditingMode: 'false', settingsPreferences: null, supportDefaultOpen: true }),
    })
    const availableServices = Array.isArray(serviceCards['services'])
      ? serviceCards['services'].flatMap(raw => {
        const item = record(raw)
        const code = text(item?.['code'])
        return code ? [{ serviceCode: code, enable: false }] : []
      })
      : []
    const requestedServices = params.draft?.services ?? []
    if (requestedServices.some(item => !availableServices.some(service => service.serviceCode === item.ref))) {
      return { ok: false, error: writeRejected('草稿服务不在当前可用候选内') }
    }
    const services = requestedServices.length === 0
      ? availableServices
      : availableServices.flatMap(service => {
        const requested = requestedServices.find(item => item.ref === service.serviceCode)
        return requested
          ? [{ serviceCode: service.serviceCode, enable: service.serviceCode !== 'AI_SALE' && requested.value === 'true' }]
          : []
      })

    const core: PublishPreparedCore = {
      description,
      priceYuan: price,
      specifications: sourceSpecs,
      itemCatDTO,
      itemLabelExtList,
      itemAddrDTO: address,
      imageInfoDOList,
      services,
    }
    const canonical = contentFingerprint(params, accountId)
    const fingerprint = await sha256Hex(canonical) ?? fallbackFingerprint(canonical)
    const token = resolvePrepareStoreKey(fingerprint)
    const prepared = { sourceItemId: params.source.itemId, core, rawCards: selectedRawCards }
    const store = deps.preparedStore ?? memoryPreparedStore()
    const previous = await store.get(token)
    if (previous && previous.accountId === accountId && previous.expiresAt > deps.now()) {
      return { ok: false, error: writeRejected('相同业务输入已有未过期的 prepare 引用，禁止覆盖') }
    }
    const storedContext: PublishPreparedContext = {
      ...prepared,
      accountId,
      expiresAt: deps.now() + PREPARE_TTL_MS,
      draftFingerprint: fingerprint,
      prepareRef: makePrepareRef(fingerprint),
    }
    await store.set(token, storedContext)
    // 兼容测试/旧调用注入的 token；生产不注入，不会创建额外别名。
    if (deps.createPrepareToken) {
      const alias = deps.createPrepareToken()
      if (typeof alias !== 'string' || alias.length === 0 || alias.length > 512 || !/^[A-Za-z0-9._:-]+$/.test(alias)) {
        return { ok: false, error: writeRejected('prepare 引用无效') }
      }
      if (alias !== token) await store.set(alias, storedContext)
    }

    const publicDraft = {
      title,
      description: checkedText,
      price,
      imageCount: imageInfoDOList.length,
      categoryName: itemCatDTO.catName || null,
      attributeNames: attributes.map(entry => entry.card.propertyName),
      serviceNames: availableServices.map(service => service.serviceCode),
    }
    const candidates = {
      categoryRefs: [category.candidate.valueId],
      attributeRefs: attributes.map(entry => entry.candidate.valueId),
      serviceRefs: availableServices.map(service => service.serviceCode),
    }
    // Host 使用相同的规范摘要绑定授权；页面内容索引与授权指纹是不同概念。
    // 内部引用必须真实指向该权威上下文，不能依赖测试注入的 token 别名。
    const authorizationFingerprint = await sha256Hex(JSON.stringify([
      accountId, params.source.itemId, params.seller, params.draft ?? {},
      storedContext.prepareRef, publicDraft, candidates,
    ]))
    if (!authorizationFingerprint) throw writeRejected('缺少 SHA-256，无法绑定发布授权')
    await store.set(storedContext.prepareRef, {
      ...storedContext, draftFingerprint: authorizationFingerprint,
    })
    if (!isPublishPrepareResult({
      prepareToken: token,
      draftFingerprint: fingerprint,
      expiresAt: deps.now() + PREPARE_TTL_MS,
      draft: publicDraft,
      candidates,
    })) {
      return { ok: false, error: writeRejected('准备阶段结果结构无效，无法继续') }
    }

    const result: PublishPreparePageResult = {
      draft: publicDraft,
      candidates,
      prepareRef: storedContext.prepareRef,
    }
    await requireAccount(deps.readAccountId, accountId, 'read')
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: error instanceof ApiError ? error : ApiError.from(error, 'PLATFORM_REJECTED') }
  }
}

// ─── submit 执行器 ────────────────────────────────────────────────────────────

/** 按 Host 指纹取回权威上下文；调用方不能直接构造提交核心或 payload。 */
async function resolvePrepared(
  params: PublishSubmitParams,
  accountId: string,
  deps: PublishPageExecutorDeps,
  prepareRef?: string,
): Promise<PublishPreparedContext> {
  const store = deps.preparedStore ?? memoryPreparedStore()
  // Host 持久化的 prepareRef 指向页面权威上下文；旧调用仍可按指纹或 token 兼容。
  const byRef = prepareRef ? await store.get(prepareRef) : null
  const byFingerprint = byRef ? null : await store.get(params.draftFingerprint)
  const cachedKey = submitTokenCache.get(params.prepareToken)
  const byToken = byRef || byFingerprint ? null : await store.get(cachedKey ?? params.prepareToken)
  const stored = byRef ?? byFingerprint ?? byToken
  if (!stored) throw writeRejected('prepare 引用不存在或已失效')
  if (stored.accountId !== accountId) {
    throw new ApiError('ACCOUNT_CHANGED', ACCOUNT_DRIFT_MSG, { phase: 'write', retryable: false })
  }
  if (stored.expiresAt <= deps.now()) throw writeRejected('prepare 引用已过期，请重新准备')
  if (!stored.core || !Array.isArray(stored.rawCards)) throw writeRejected('prepare 权威数据不完整')
  if (stored.draftFingerprint !== params.draftFingerprint) {
    throw writeRejected('prepare 引用与草稿指纹不一致')
  }
  if (prepareRef !== undefined && stored.prepareRef !== prepareRef) {
    throw writeRejected('prepare 内部引用与权威上下文不一致')
  }
  submitTokenCache.delete(params.prepareToken)
  submitTokenCache.set(params.prepareToken, params.draftFingerprint)
  if (submitTokenCache.size > SUBMIT_TOKEN_CACHE_LIMIT) {
    const oldest = submitTokenCache.keys().next().value
    if (oldest !== undefined) submitTokenCache.delete(oldest)
  }
  return stored
}

/**
 * 执行 publish.submit：唯一允许写平台的路径。
 *
 * prepareToken/draftFingerprint 只用于取回本扩展保存的权威数据；最终平台
 * 请求使用完整发布 payload，绝不把 token、指纹或幂等键发给平台。任何
 * 超时/异常都返回 unknown，且不会在同一调用内重试。
 */
export async function executeSubmit(
  params: PublishSubmitParams,
  accountId: string,
  deps: PublishPageExecutorDeps,
  prepareRef?: string,
): Promise<SubmitOutcome> {
  try {
    await requireAccount(deps.readAccountId, accountId, 'write')
    const prepared = await resolvePrepared(params, accountId, deps, prepareRef)

    const check = await requireSuccess(deps, 'mtop.idle.pc.idleitem.prepublish.check', '1.0', {})
    if (check['limited'] === true) return { ok: false, error: writeRejected('发布资格受限，需人工处理') }

    const description = finalDescription(prepared.core.description, prepared.core.specifications)
    if (!description || description.length > DESCRIPTION_MAX) {
      return { ok: false, error: writeRejected('最终描述为空或超长') }
    }
    const badwordsResponse = await request(deps, 'mtop.taobao.idleitem.badwords.prepubcheck', '2.0', {
      title: description,
      scene: 'pcPublish',
      sessionId: String(deps.now()),
    }, undefined, 'read')
    if (!isRetOk(badwordsResponse)) throw classifyReadMtopError(retCode(badwordsResponse))
    const badwords = record(badwordsResponse.data)
    if (!badwords || typeof badwords['forbidPublish'] !== 'boolean') {
      throw readFailure('最终违禁词复检缺少有效 forbidPublish，按失败关闭处理', 'PLATFORM_REJECTED')
    }
    if (badwords['forbidPublish'] === true) return { ok: false, error: writeRejected('最终文案包含违禁内容') }

    // 提交前重新确认服务可用性；已启用但不可用必须拒绝，不静默删除服务。
    const intermediate = {
      freebies: false,
      itemTypeStr: 'b',
      quantity: '1',
      simpleItem: 'true',
      itemTextDTO: { desc: description, title: description, titleDescSeparate: false },
      itemPriceDTO: { priceInCent: toCentString(prepared.core.priceYuan) },
      itemPostFeeDTO: { canFreeShipping: true, supportFreight: true, onlyTakeSelf: false },
      itemAddrDTO: prepared.core.itemAddrDTO,
      itemCatDTO: prepared.core.itemCatDTO,
      itemLabelExtList: prepared.core.itemLabelExtList,
      imageInfoDOList: prepared.core.imageInfoDOList,
      defaultPrice: false,
      publishScene: 'mainPublish',
    }
    const cards = await requireSuccess(deps, 'mtop.idle.item.publish.service.cards.list', '1.0', {
      cpvList: JSON.stringify(prepared.rawCards),
      itemInfoJson: JSON.stringify(intermediate),
      param: JSON.stringify({ multiSkuEditingMode: 'false', settingsPreferences: null, supportDefaultOpen: true }),
    })
    const available = new Set(Array.isArray(cards['services'])
      ? cards['services'].flatMap(raw => {
        const item = record(raw)
        const code = text(item?.['code'])
        return code ? [code] : []
      })
      : [])
    for (const service of prepared.core.services) {
      if (service.enable && service.serviceCode !== 'AI_SALE' && !available.has(service.serviceCode)) {
        return { ok: false, error: writeRejected('所选服务在当前商品上不可用') }
      }
    }

    await requireAccount(deps.readAccountId, accountId, 'write')
    const payload = buildSubmitPayload(prepared.core, prepared.core.services, makeUniqueCode(deps.now))
    let response: MtopResponse
    try {
      response = await deps.mtopRequest('mtop.idle.pc.idleitem.publish', '1.0', payload)
    } catch (error) {
      return { ok: false, error: classifyMtopException(error) }
    }
    if (!isRetOk(response)) return { ok: false, error: classifyMtopError(retCode(response), retMessage(response)) }
    const itemId = text(record(response.data)?.['itemId'])
    if (!itemId) {
      return {
        ok: false,
        error: new ApiError('RESULT_UNKNOWN', '服务端返回 SUCCESS 但缺少 itemId，结果未知，禁止自动重试', {
          phase: 'write',
          retryable: false,
        }),
      }
    }
    await requireAccount(deps.readAccountId, accountId, 'write')
    return { ok: true, result: { outcome: 'accepted', itemId } }
  } catch (error) {
    return { ok: false, error: error instanceof ApiError ? error : ApiError.from(error, 'INTERNAL') }
  }
}

// ─── myItems 执行器 ───────────────────────────────────────────────────────────

function parseMyItemsCards(data: Record<string, unknown>): PublishMyItem[] {
  const cards = data['cardList']
  if (!Array.isArray(cards)) throw readFailure('官方在售列表缺少 cardList，结果不完整')
  const items: PublishMyItem[] = []
  for (const raw of cards) {
    const card = record(raw)
    const cardData = record(card?.['cardData'])
    const itemId = text(cardData?.['id'])
    // 基线用于归因发布副作用；无法识别的卡片不能静默丢弃为“没有商品”。
    if (!itemId) throw readFailure('官方在售商品卡缺少有效 itemId，无法确认完整基线')
    const title = text(cardData?.['title'])
    items.push(title ? { itemId, title } : { itemId })
  }
  return items
}

function findOnSaleGroupId(data: Record<string, unknown>): number | null {
  const groups = data['itemGroupList']
  if (!Array.isArray(groups)) throw readFailure('官方商品库缺少 itemGroupList，无法定位在售分组')
  for (const raw of groups) {
    const group = record(raw)
    if (group?.['groupName'] === MY_ITEMS_GROUP_NAME &&
      Number.isSafeInteger(group['groupId']) && Number(group['groupId']) > 0) {
      return Number(group['groupId'])
    }
  }
  return null
}

function pageSizeFromLimit(limit: number): number {
  return Math.max(1, Math.min(limit, MY_ITEMS_PAGE_SIZE_MAX))
}

/**
 * 执行 publish.myItems：只读分页读取官方“在售”分组。
 *
 * Host 内部 nextPage 是带 groupId/pageNumber/pageSize 的受控游标；
 * 公共 API 不暴露该游标。达到本次安全页数仍 nextPage=true 时返回
 * RESULT_UNKNOWN，不能截断后冒充完整列表。
 */
export async function executeMyItems(
  params: PublishMyItemsParams | PublishMyItemsStepParams,
  accountId: string,
  deps: PublishPageExecutorDeps,
): Promise<MyItemsOutcome> {
  try {
    await requireAccount(deps.readAccountId, accountId, 'read')
    const pageSize = pageSizeFromLimit(params.limit)
    const cursorValue = 'nextPage' in params ? params.nextPage : undefined
    let groupId: number | undefined
    let pageNumber: number
    if (cursorValue !== undefined) {
      const cursor = decodePublishMyItemsCursor(cursorValue)
      if (cursor.pageSize !== pageSize) throw readFailure('在售列表游标页大小不一致', 'PLATFORM_REJECTED')
      groupId = cursor.groupId
      pageNumber = cursor.pageNumber
    } else {
      const probe = await requireSuccess(deps, 'mtop.idle.web.xyh.item.list', '1.0', {
        needGroupInfo: true,
        pageNumber: 1,
        userId: accountId,
        pageSize,
        defaultGroup: true,
      })
      const discovered = findOnSaleGroupId(probe)
      if (discovered === null) {
        await requireAccount(deps.readAccountId, accountId, 'read')
        return { ok: true, result: { items: [], hasMore: false } }
      }
      groupId = discovered
      pageNumber = 1
    }

    const items: PublishMyItem[] = []
    const seen = new Set<string>()
    for (let page = 0; page < MY_ITEMS_MAX_PAGES_PER_CALL; page += 1) {
      const data = await requireSuccess(deps, 'mtop.idle.web.xyh.item.list', '1.0', {
        needGroupInfo: false,
        pageNumber,
        userId: accountId,
        pageSize,
        groupName: MY_ITEMS_GROUP_NAME,
        groupId: groupId as number,
        defaultGroup: false,
      })
      const parsed = parseMyItemsCards(data)
      for (const item of parsed) {
        if (seen.has(item.itemId)) continue
        seen.add(item.itemId)
        items.push(item)
      }
      const hasMore = data['nextPage']
      if (typeof hasMore !== 'boolean') throw readFailure('官方在售列表缺少布尔 nextPage，结果不完整')
      if (!hasMore) {
        await requireAccount(deps.readAccountId, accountId, 'read')
        const result: PublishMyItemsPage = { items, hasMore: false }
        if (!isPublishMyItemsResult({ items, total: items.length, hasMore: false })) {
          throw readFailure('在售列表结果结构无效', 'PLATFORM_REJECTED')
        }
        return { ok: true, result }
      }
      pageNumber += 1
      // 单次调用读满安全页数但仍有下一页时，返回受控游标供 Host 继续。
      if (page === MY_ITEMS_MAX_PAGES_PER_CALL - 1) {
        if (groupId === undefined) throw readFailure('在售列表游标缺少 groupId，结果未知')
        const nextPage = encodePublishMyItemsCursor({ groupId, pageNumber, pageSize })
        await requireAccount(deps.readAccountId, accountId, 'read')
        return { ok: true, result: { items, hasMore: true, nextPage } }
      }
    }
    throw readFailure('官方在售商品分页超过安全上限，结果未知')
  } catch (error) {
    return { ok: false, error: error instanceof ApiError ? error : ApiError.from(error, 'RESULT_UNKNOWN') }
  }
}

// ─── 公共入口（含参数规范化） ──────────────────────────────────────────────────

export async function runPublishPrepare(
  rawParams: unknown,
  accountId: string,
  deps: PublishPageExecutorDeps,
): Promise<PrepareOutcome> {
  let params: PublishPrepareParams
  try {
    // Host 单步只传业务字段；幂等键只属于 Host operations，不进入页面请求。
    const internal = record(rawParams) && !('idempotencyKey' in (rawParams as Record<string, unknown>))
      ? { ...(rawParams as Record<string, unknown>), idempotencyKey: 'page-step' }
      : rawParams
    params = normalizePublishPrepareParams(internal)
  } catch {
    return { ok: false, error: new ApiError('BAD_REQUEST', '发布准备参数无效，已拒绝', { phase: 'write', retryable: false }) }
  }
  return executePrepare(params, accountId, deps)
}

export async function runPublishSubmit(
  rawParams: unknown,
  accountId: string,
  deps: PublishPageExecutorDeps,
): Promise<SubmitOutcome> {
  let params: PublishSubmitParams
  let prepareRef: string | undefined
  try {
    // Host 单步还会带 source/draft/candidates；页面只把它们当形状上下文，
    // 真正的提交核心仍按 token+指纹从 preparedStore 取回。
    const raw = record(rawParams)
    const allowed = ['prepareToken', 'draftFingerprint', 'idempotencyKey', 'confirm', 'tag', 'maxWaitMs', 'minIntervalMs', 'prepareRef']
    const isInternalStep = raw !== null && Object.keys(raw).every(key => allowed.includes(key) || key === 'source' || key === 'draft' || key === 'candidates')
    const internal = raw && isInternalStep
      ? {
        ...Object.fromEntries(Object.entries(raw).filter(([key]) => allowed.includes(key))),
        ...(!('idempotencyKey' in raw) ? { idempotencyKey: 'page-step' } : {}),
      }
      : rawParams
    // prepareRef 只属于内部步骤，不能进入公共 submit schema。
    if (internal && typeof internal === 'object' && !Array.isArray(internal)) delete (internal as Record<string, unknown>)['prepareRef']
    if (raw && isInternalStep && raw['prepareRef'] !== undefined) {
      if (typeof raw['prepareRef'] !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw['prepareRef'])) {
        throw new Error('prepareRef 无效')
      }
      prepareRef = raw['prepareRef']
    }
    params = normalizePublishSubmitParams(internal)
  } catch {
    return { ok: false, error: new ApiError('BAD_REQUEST', '发布提交参数无效，已拒绝', { phase: 'write', retryable: false }) }
  }
  return executeSubmit(params, accountId, deps, prepareRef)
}

/**
 * 规范化并执行 publish.myItems。
 *
 * 首屏走公共参数校验；带 nextPage 时只接受 Host 生成的内部游标，公共 API
 * 仍不能直接注入页码、groupId 或平台游标。
 */
export async function runPublishMyItems(
  rawParams: unknown,
  accountId: string,
  deps: PublishPageExecutorDeps,
): Promise<MyItemsOutcome> {
  try {
    if (record(rawParams)?.['nextPage'] !== undefined) {
      return executeMyItems(normalizePublishMyItemsStepParams(rawParams), accountId, deps)
    }
    return executeMyItems(normalizePublishMyItemsParams(rawParams), accountId, deps)
  } catch {
    return { ok: false, error: new ApiError('BAD_REQUEST', 'myItems 参数无效，已拒绝', { phase: 'read', retryable: false }) }
  }
}

