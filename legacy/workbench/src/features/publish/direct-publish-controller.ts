/**
 * 直接发布（两阶段）前端控制器。
 *
 * 完整管理：
 * 1. 准备阶段前置门禁：真实草稿数据、用户显式提供完整7字段地址或坐标（真实经纬度范围 [-90,90],[-180,180]），
 *    坐标优先并仅发一种 seller，绝不编造任何默认坐标、地址、divisionId、poiId 或价格；
 * 2. 准备阶段（prepare）：随机生成 idempotencyKey，调用后台接口获取实际待发送数据与类目属性候选，
 *    绝不隐式提交；
 * 3. 异步漂移防线：通过自增序列号 (seq) 确保在途请求不污染新草稿，防重复并发调用时不篡改 phase；
 * 4. 草稿审核与编辑：title/desc/price/specifications/category/attributes/address/images/services 全量可编辑，
 *    明确以 sourceProduct.title 覆盖赋初值；图片仅限已上传子集排序/删除，类目切换清空不适用属性并使确认失效；
 * 5. 提交门禁与永久 unknown 锁：
 *    - published + itemId 才判定为成功；
 *    - 无论后台返回 unknown 还是通信失联超时，立即将草稿源指纹持久化至 sessionStorage 永久锁定（仅存源特征哈希，不存业务正文），
 *      严禁重新准备或重新提交绕过幂等安全；
 *    - 必须由操作员人工核实未上架后明确点击解除锁定，绝不自动解锁；
 *    - submit rejected 允许用户在修正草稿后重新提交或返回准备，按钮不永久禁用；
 *    - 提交仅发送 token/draft/confirm/categoryConfirmed/noQR 严格契约；
 * 6. 取消仅关弹窗不发布；
 * 7. 支持单测注入 DirectPublishClient。
 */

import {
  buildCategoryFromCandidate,
  normalizePropertyCards,
  setAttributeSelection,
} from './direct-publish-cards'
import { DirectPublishClient } from './direct-publish-client'
import type {
  DirectPublishPhase,
  DirectPublishPrepareRequest,
  DirectPublishPreparedResult,
  DirectPublishReviewDraft,
  DirectPublishSellerForm,
  DirectPublishSubmitRequest,
  DirectPublishSubmitResult,
  NormalizedCardValue,
  NormalizedPropertyCard,
} from './direct-publish-types'

export interface DirectPublishSourceProduct {
  title?: string
  description: string
  price: number | string
  images: string[]
  specifications?: Array<{ name: string; value: string }>
  itemId?: string
}

export interface DirectPublishControllerOptions {
  client?: DirectPublishClient
  now?: () => number
}

const SESSION_STORAGE_LOCK_KEY = 'fishops.directPublish.lockedSourceKeys.v1'

function loadLockedSourceKeys(): Set<string> {
  try {
    const raw = globalThis.sessionStorage?.getItem(SESSION_STORAGE_LOCK_KEY)
    if (raw) {
      const list = JSON.parse(raw)
      if (Array.isArray(list)) return new Set(list.filter((k): k is string => typeof k === 'string'))
    }
  } catch {
    // 环境不可用或解析失败
  }
  return new Set<string>()
}

function saveLockedSourceKeys(keys: Set<string>): void {
  try {
    globalThis.sessionStorage?.setItem(SESSION_STORAGE_LOCK_KEY, JSON.stringify(Array.from(keys)))
  } catch {
    // 环境不可用
  }
}

/** 校验经纬度是否在真实合法范围（[-90, 90], [-180, 180] 且不为 0）。 */
export function isValidCoordinates(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false
  if (lat === 0 && lng === 0) return false // 拒绝 0,0 伪造
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

/** 校验 gps 字符串格式（包含非零合法经纬度）。 */
export function isValidGpsString(gps: unknown): boolean {
  if (typeof gps !== 'string') return false
  const trimmed = gps.trim()
  if (!trimmed) return false
  const parts = trimmed.split(',')
  if (parts.length !== 2) return false
  const num1 = Number(parts[0].trim())
  const num2 = Number(parts[1].trim())
  if (!Number.isFinite(num1) || !Number.isFinite(num2)) return false
  if (num1 === 0 && num2 === 0) return false
  return (
    (num1 >= -180 && num1 <= 180 && num2 >= -90 && num2 <= 90) ||
    (num2 >= -180 && num2 <= 180 && num1 >= -90 && num1 <= 90)
  )
}

/** 校验完整发货地址 7 个白名单字段均非空（trim 后非空，不编造任何默认值）。 */
export function isValidFullAddress(addr: DirectPublishSellerForm): boolean {
  const keys: Array<keyof DirectPublishSellerForm> = [
    'prov',
    'city',
    'area',
    'divisionId',
    'poiName',
    'poiId',
    'gps',
  ]
  for (const k of keys) {
    const v = addr[k]
    if (typeof v !== 'string' || v.trim() === '') return false
  }
  return true
}

/**
 * 确定性不可逆摘要（双 32 位 FNV-1a 哈希），彻底避免在 sessionStorage 中持久化任何商品描述与图片明文。
 */
export function hashTextToDigest(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= code
    h2 = Math.imul(h2, 0x85ebca6b)
  }
  const part1 = (h1 >>> 0).toString(16).padStart(8, '0')
  const part2 = (h2 >>> 0).toString(16).padStart(8, '0')
  return `hash_${part1}${part2}`
}

/** 校验价格是否为严格元格式（有限正数，最多两位小数，绝无静默四舍五入与科学计数法）。 */
export function isValidPrice(price: number | string | undefined | null): boolean {
  if (price === undefined || price === null) return false
  if (typeof price === 'string') {
    const str = price.trim()
    // 严格匹配纯数字及最多2位小数（拒绝 1e2, 99.999, 负数, 00 开头非小数等）
    if (!/^\d+(\.\d{1,2})?$/.test(str)) return false
    const num = Number(str)
    return Number.isFinite(num) && num > 0
  }
  if (typeof price === 'number') {
    if (!Number.isFinite(price) || price <= 0) return false
    // 数值直接转 String 进行严格 regex 校验，拒绝乘 100 精度失真（如 19.99*100=1998.9999999999998），绝不静默舍入
    const str = String(price)
    return /^\d+(\.\d{1,2})?$/.test(str)
  }
  return false
}

/** 校验规格列表：若存在规格项，每项 name 与 value 必须非空。 */
export function isValidSpecifications(specs: Array<{ name: string; value: string }> | undefined | null): boolean {
  if (!specs || !Array.isArray(specs)) return true
  for (const s of specs) {
    if (!s || typeof s !== 'object') return false
    if (typeof s.name !== 'string' || s.name.trim() === '') return false
    if (typeof s.value !== 'string' || s.value.trim() === '') return false
  }
  return true
}

/** 深拷贝普通草稿对象。 */
function cloneDraft(draft: DirectPublishReviewDraft): DirectPublishReviewDraft {
  return JSON.parse(JSON.stringify(draft)) as DirectPublishReviewDraft
}

/** 派生草稿源的唯一特征 Key（不可逆摘要，绝不暴露商品正文或图片 URL 明文）。 */
export function deriveDraftSourceKey(source: DirectPublishSourceProduct): string {
  const cleanId = (source.itemId || '').trim()
  const cleanDesc = (source.description || '').trim()
  const cleanPrice = String(source.price ?? '').trim()
  const cleanImages = (source.images || []).map((img) => img.trim()).filter(Boolean).sort().join('|')
  const rawMaterial = `${cleanId}::${cleanDesc}::${cleanPrice}::${cleanImages}`
  return hashTextToDigest(rawMaterial)
}

export class DirectPublishController {
  private readonly client: DirectPublishClient
  private readonly now: () => number

  // 控制器内部状态
  private phase: DirectPublishPhase = 'idle'
  private sourceProduct: DirectPublishSourceProduct | null = null
  private sourceKey: string = ''
  private currentIdempotencyKey: string = ''

  // 异步漂移序列号（递增序列，防止在途响应覆盖新切换草稿）
  private prepareSequence = 0

  // 永久锁定的草稿特征集合（unknown 同源锁，同步持久化到 sessionStorage）
  private readonly lockedSourceKeys: Set<string>

  // 准备前输入
  private sellerForm: DirectPublishSellerForm = {
    prov: '',
    city: '',
    area: '',
    divisionId: '',
    poiName: '',
    poiId: '',
    gps: '',
    latitude: '',
    longitude: '',
  }
  private preConfirmedNoQrCodes = false

  // 准备后结果
  private prepareToken = ''
  private reviewedDraft: DirectPublishReviewDraft | null = null
  private preparedImages: Array<Record<string, unknown>> = []
  private propertyCards: NormalizedPropertyCard[] = []
  private warnings: string[] = []
  private failureStage: string | null = null
  private missingFields: string[] = []

  // 最终确认门禁（已简化，保留字段以向下兼容）
  private categoryConfirmed = false
  private submitConfirmedNoQrCodes = false

  // 最终提交结果
  private submitResult: DirectPublishSubmitResult | null = null
  private publishedItemId: string | null = null

  // 错误信息
  private errorCode: string | null = null
  private errorMessage: string | null = null
  private actionRequired: 'login' | 'captcha' | 'verification' | null = null

  // 状态变更监听器
  private readonly listeners = new Set<() => void>()

  constructor(options: DirectPublishControllerOptions = {}) {
    this.client = options.client || new DirectPublishClient()
    this.now = options.now || (() => Date.now())
    this.lockedSourceKeys = loadLockedSourceKeys()
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // 容忍监听器抛错
      }
    }
  }

  // ==================== 状态只读 Getter ====================

  public getPhase(): DirectPublishPhase {
    return this.phase
  }

  public getSourceProduct(): DirectPublishSourceProduct | null {
    return this.sourceProduct
  }

  public getSellerForm(): DirectPublishSellerForm {
    return { ...this.sellerForm }
  }

  public getPreConfirmedNoQrCodes(): boolean {
    return this.preConfirmedNoQrCodes
  }

  public getPrepareToken(): string {
    return this.prepareToken
  }

  public getReviewedDraft(): DirectPublishReviewDraft | null {
    return this.reviewedDraft ? cloneDraft(this.reviewedDraft) : null
  }

  public getPreparedImages(): Array<Record<string, unknown>> {
    return this.preparedImages.map((img) => ({ ...img }))
  }

  public getPropertyCards(): NormalizedPropertyCard[] {
    return this.propertyCards.map((card) => ({
      ...card,
      values: card.values.map((v) => ({ ...v })),
    }))
  }

  public getWarnings(): string[] {
    return [...this.warnings]
  }

  public getFailureStage(): string | null {
    return this.failureStage
  }

  public getMissingFields(): string[] {
    return [...this.missingFields]
  }

  public isCategoryConfirmed(): boolean {
    return this.categoryConfirmed
  }

  public isSubmitConfirmedNoQrCodes(): boolean {
    return this.submitConfirmedNoQrCodes
  }

  public getSubmitResult(): DirectPublishSubmitResult | null {
    return this.submitResult
  }

  public getPublishedItemId(): string | null {
    return this.publishedItemId
  }

  public getErrorCode(): string | null {
    return this.errorCode
  }

  public getErrorMessage(): string | null {
    return this.errorMessage
  }

  public getActionRequired(): 'login' | 'captcha' | 'verification' | null {
    return this.actionRequired
  }

  /** 判断当前草稿是否因此前 unknown 提交被锁定（非永久锁，可由操作员手动核实后解除）。 */
  public isDraftLocked(): boolean {
    if (!this.sourceKey) return false
    return this.lockedSourceKeys.has(this.sourceKey)
  }

  /** 判断是否是与当前控制器关联的同源商品草稿。 */
  public isSameSource(source: DirectPublishSourceProduct): boolean {
    if (!this.sourceKey) return false
    return this.sourceKey === deriveDraftSourceKey(source)
  }

  /** 判断针对指定商品草稿是否已有已审核草稿（重开时保留编辑，不重复上传）。 */
  public hasReviewedDraftFor(source: DirectPublishSourceProduct): boolean {
    return (
      this.isSameSource(source) &&
      (this.phase === 'reviewed' || this.phase === 'submit_rejected') &&
      Boolean(this.prepareToken && this.reviewedDraft)
    )
  }

  /**
   * 判断准备发布按钮是否可用。
   * 仅校验 source 商品有效、未 busy、未锁；seller 地址与二维码勾选门禁已去掉。
   */
  public canStartPrepare(): boolean {
    if (this.phase === 'preparing' || this.phase === 'submitting') return false
    if (this.isDraftLocked()) return false
    if (!this.sourceProduct) return false
    if (!isValidPrice(this.sourceProduct.price)) return false
    if (!this.sourceProduct.description?.trim()) return false
    if (!Array.isArray(this.sourceProduct.images) || this.sourceProduct.images.length === 0) return false
    return true
  }

  /**
   * 判断最终提交发布按钮是否可用。
   * 仅以描述为有效门禁（无独立标题校验与30字门禁），要求完整 7 字段 address 且 gps 有效、类目有效、有限价格、候选 token。
   */
  public canSubmit(): boolean {
    if (this.phase !== 'reviewed' && this.phase !== 'submit_rejected') return false
    if (this.isDraftLocked()) return false
    if (!this.prepareToken || !this.reviewedDraft) return false

    // 描述非空（源 title 不作为门禁，仅 description 有效）
    if (!this.reviewedDraft.description?.trim()) return false

    // 价格有效
    if (!this.reviewedDraft.price || !isValidPrice(this.reviewedDraft.price)) return false

    // 规格有效
    if (!isValidSpecifications(this.reviewedDraft.specifications)) return false

    // 图片有效
    if (!Array.isArray(this.reviewedDraft.images) || this.reviewedDraft.images.length === 0) return false

    // 类目有效（须为有效候选对象，包含可用 id）
    if (!this.reviewedDraft.category || typeof this.reviewedDraft.category !== 'object') return false
    const catId =
      this.reviewedDraft.category.catId ||
      this.reviewedDraft.category.channelCatId ||
      this.reviewedDraft.category.valueId
    if (!catId || !String(catId).trim()) return false

    // 发货地址：后台严格要求全部 7 个白名单字段均非空且 gps 有效
    const addr = this.reviewedDraft.address
    if (!addr || typeof addr !== 'object') return false
    const requiredKeys = ['prov', 'city', 'area', 'divisionId', 'poiName', 'poiId', 'gps']
    for (const k of requiredKeys) {
      if (!addr[k] || !String(addr[k]).trim()) return false
    }
    if (!isValidGpsString(addr.gps)) return false

    return true
  }

  // ==================== 操作方法 ====================

  /**
   * 初始化准备上下文（传入当前真实商品草稿）。
   * 递增 prepareSequence，废弃此前的任何在途异步结果。
   */
  /** 自营商品进入发布页时读取一次最新详情，失败直接进入准备失败态，不回退旧缓存。 */
  public async initAndPrepareSource(source: DirectPublishSourceProduct): Promise<DirectPublishPreparedResult> {
    if (this.phase === 'preparing' || this.phase === 'submitting') {
      return { status: 'rejected', code: 'CONCURRENT_PREPARE', message: '已有发布准备正在执行中' }
    }
    let latest = source
    if (source.itemId) {
      const detail = await this.client.getProduct(String(source.itemId))
      if (detail.status !== 'ok' || !detail.product) {
        this.initSource(source)
        this.phase = 'prepare_failed'
        this.errorCode = detail.code || 'DETAIL_FAILED'
        const sourceLabel = source.title?.trim() || '未知商品'
        const sourceId = source.itemId ? `（商品 ID：${source.itemId}）` : ''
        this.errorMessage = `${sourceLabel}${sourceId}：${detail.message || '获取商品最新详情失败，未回退到旧数据'}`
        this.failureStage = 'source'
        this.notify()
        return { status: 'rejected', code: this.errorCode, message: this.errorMessage, failureStage: 'source' }
      }
      latest = {
        ...source,
        description: detail.product.description,
        price: detail.product.price,
        images: detail.product.images,
        specifications: detail.product.specifications || [],
      }
    }
    this.initSource(latest)
    return this.executePrepare()
  }

  /** 将本地文件上传至闲鱼后追加到当前审核草稿；未完成上传不会修改草稿。 */
  public async uploadImageDataUrl(dataUrl: string): Promise<{ ok: true; image: Record<string, unknown> } | { ok: false; message: string }> {
    if (!this.reviewedDraft) return { ok: false, message: '发布数据尚未准备完成' }
    try {
      const image = await this.client.uploadImage(dataUrl)
      const list = Array.isArray(this.reviewedDraft.images) ? [...this.reviewedDraft.images] : []
      const url = String(image.url || '').trim()
      if (!url || list.some((entry) => String(entry.url || '') === url)) return { ok: false, message: '后台返回的图片地址无效或重复' }
      if (list.length >= 9) return { ok: false, message: '图片最多支持 9 张' }
      list.push(image)
      this.reviewedDraft.images = list
      this.onDraftEdit()
      this.notify()
      return { ok: true, image }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '本地图片上传失败' }
    }
  }

  public initSource(source: DirectPublishSourceProduct): void {
    this.prepareSequence++
    this.sourceProduct = { ...source }
    this.sourceKey = deriveDraftSourceKey(source)
    this.phase = 'idle'
    this.errorCode = null
    this.errorMessage = null
    this.actionRequired = null
    this.failureStage = null
    this.missingFields = []
    this.prepareToken = ''
    this.reviewedDraft = null
    this.preparedImages = []
    this.propertyCards = []
    this.warnings = []
    this.categoryConfirmed = false
    this.submitConfirmedNoQrCodes = false
    this.submitResult = null
    this.publishedItemId = null
    this.notify()
  }

  /**
   * 从审核草稿状态返回准备前配置阶段：
   * 保留已输入的地址/坐标与无二维码承诺，清除旧 prepareToken 与 draft，进入 idle 供用户调整后再次准备。
   */
  public backToPrepare(): void {
    if (this.phase === 'submitting' || this.phase === 'preparing') return
    this.prepareSequence++
    this.phase = 'idle'
    this.prepareToken = ''
    this.reviewedDraft = null
    this.preparedImages = []
    this.propertyCards = []
    this.warnings = []
    this.categoryConfirmed = false
    this.submitConfirmedNoQrCodes = false
    this.errorCode = null
    this.errorMessage = null
    this.actionRequired = null
    this.notify()
  }

  /** 更新准备前发货地址表单。 */
  public updateSellerForm(patch: Partial<DirectPublishSellerForm>): void {
    this.sellerForm = {
      ...this.sellerForm,
      ...patch,
    }
    this.notify()
  }

  /** 更新准备前图片无二维码确认勾选。 */
  public setPreConfirmedNoQrCodes(val: boolean): void {
    this.preConfirmedNoQrCodes = val
    this.notify()
  }

  /**
   * 第一阶段：执行准备（Prepare）。
   * 跑完 publish 前全部接口，拿回 draft 和 propertyCards，绝不调用 submit。
   * 支持可选项 overrideSeller，默认无需提供地址（使用官方账号预填地点或默认地点）。
   */
  public async executePrepare(
    customIdempotencyKey?: string,
    overrideSeller?: DirectPublishPrepareRequest['seller'],
  ): Promise<DirectPublishPreparedResult> {
    // 防并发重复调用：若当前正在 preparing，严禁把 phase 改为 prepare_failed
    if (this.phase === 'preparing') {
      return {
        status: 'rejected',
        code: 'CONCURRENT_PREPARE',
        message: '已有准备任务正在执行中，请勿重复调用',
      }
    }

    if (this.isDraftLocked()) {
      const errRes: DirectPublishPreparedResult = {
        status: 'rejected',
        code: 'DRAFT_LOCKED_UNKNOWN',
        message: '该商品草稿此前的发布结果未知，已锁定以防闲鱼重复发布。请人工前往闲鱼核实！',
      }
      this.errorCode = errRes.code || 'DRAFT_LOCKED'
      this.errorMessage = errRes.message || '草稿已锁定'
      this.phase = 'prepare_failed'
      this.notify()
      return errRes
    }

    if (!this.sourceProduct) {
      const errRes: DirectPublishPreparedResult = {
        status: 'rejected',
        code: 'SOURCE_PRODUCT_REQUIRED',
        message: '缺少有效待发布商品草稿',
      }
      this.errorCode = errRes.code || 'NO_SOURCE'
      this.errorMessage = errRes.message || '缺少草稿'
      this.phase = 'prepare_failed'
      this.notify()
      return errRes
    }

    if (!isValidPrice(this.sourceProduct.price)) {
      const errRes: DirectPublishPreparedResult = {
        status: 'rejected',
        code: 'INVALID_PRICE',
        message: '商品售价必须为大于 0 的有效元数值（最多两位小数），禁止发布，绝不伪造默认价格',
      }
      this.errorCode = errRes.code || 'INVALID_PRICE'
      this.errorMessage = errRes.message || '价格无效'
      this.phase = 'prepare_failed'
      this.notify()
      return errRes
    }

    this.phase = 'preparing'
    this.errorCode = null
    this.errorMessage = null
    this.actionRequired = null
    this.failureStage = null
    this.missingFields = []
    const currentSeq = ++this.prepareSequence
    this.currentIdempotencyKey =
      customIdempotencyKey || `dp_${this.now()}_${Math.random().toString(36).slice(2, 9)}`
    this.notify()

    // 组装发货地址/坐标：仅在显式传入 overrideSeller 时携带，默认不传由后台从当前账号获取
    const seller = overrideSeller

    const priceText = Number(this.sourceProduct.price).toFixed(2)

    const prepareReq: DirectPublishPrepareRequest = {
      source: this.sourceProduct.itemId
        ? { itemId: String(this.sourceProduct.itemId) }
        : {
            product: {
              description: this.sourceProduct.description.trim(),
              price: priceText,
              images: this.sourceProduct.images.map((img) => img.trim()).filter(Boolean),
              specifications: this.sourceProduct.specifications || [],
            },
          },
      idempotencyKey: this.currentIdempotencyKey,
      ...(seller ? { seller } : {}),
    }

    const result = await this.client.prepare(prepareReq)

    // 异步漂移防线：若请求在途期间用户切了草稿或返回了准备，丢弃过期的在途响应
    if (currentSeq !== this.prepareSequence) {
      return {
        status: 'rejected',
        code: 'STALE_PREPARE',
        message: '草稿已切换，已丢弃过期准备响应',
      }
    }

    if (result.status === 'prepared' && result.prepareToken && result.draft) {
      this.phase = 'reviewed'
      this.prepareToken = result.prepareToken
      this.reviewedDraft = cloneDraft(result.draft)
      this.preparedImages = Array.isArray(result.draft.images)
        ? (result.draft.images as Array<Record<string, unknown>>)
        : []
      this.propertyCards = normalizePropertyCards(result.propertyCards)
      this.warnings = result.warnings || []
      // 同步回填地址到 sellerForm（方便界面查看官方预填地点与微调）
      if (result.draft.address && typeof result.draft.address === 'object') {
        const addr = result.draft.address
        this.sellerForm = {
          ...this.sellerForm,
          prov: addr.prov || this.sellerForm.prov,
          city: addr.city || this.sellerForm.city,
          area: addr.area || this.sellerForm.area,
          divisionId: addr.divisionId || this.sellerForm.divisionId,
          poiName: addr.poiName || this.sellerForm.poiName,
          poiId: addr.poiId || this.sellerForm.poiId,
          gps: addr.gps || this.sellerForm.gps,
        }
      }
      this.failureStage = null
      this.missingFields = []
      this.notify()
      return result
    }

    if (result.status === 'action_required') {
      this.phase = 'action_required'
      this.actionRequired = result.actionRequired || 'login'
      this.errorCode = result.code || 'ACTION_REQUIRED'
      this.errorMessage = result.message || '需要先完成平台验证或登录'
      this.warnings = result.warnings || []
      if (result.draft) {
        this.reviewedDraft = cloneDraft(result.draft)
      }
      if (result.propertyCards) {
        this.propertyCards = normalizePropertyCards(result.propertyCards)
      }
      this.notify()
      return result
    }

    // 失败保留 returned draft 与 propertyCards 展示已准备部分，不清空
    this.phase = 'prepare_failed'
    this.errorCode = result.code || 'PREPARE_FAILED'
    this.errorMessage = result.message || '准备发布失败，请检查商品信息并重试'
    this.warnings = result.warnings || []
    this.failureStage = result.failureStage || null
    this.missingFields = result.missingFields || []
    if (result.draft) {
      this.reviewedDraft = cloneDraft(result.draft)
    }
    if (result.propertyCards) {
      this.propertyCards = normalizePropertyCards(result.propertyCards)
    }
    this.notify()
    return result
  }

  // ==================== 草稿编辑方法 ====================

  private onDraftEdit(): void {
    if (this.phase === 'submit_rejected') {
      // 修正草稿后，允许重新提交
      this.phase = 'reviewed'
      this.errorCode = null
      this.errorMessage = null
    }
  }

  /** 更新草稿标题。 */
  public updateDraftTitle(title: string): void {
    if (!this.reviewedDraft) return
    this.reviewedDraft.title = title
    this.onDraftEdit()
    this.notify()
  }

  /** 更新草稿描述。 */
  public updateDraftDescription(description: string): void {
    if (!this.reviewedDraft) return
    this.reviewedDraft.description = description
    this.onDraftEdit()
    this.notify()
  }

  /** 更新草稿价格（元字符串）。 */
  public updateDraftPrice(price: string): void {
    if (!this.reviewedDraft) return
    this.reviewedDraft.price = price
    this.onDraftEdit()
    this.notify()
  }

  /** 更新草稿规格（单 SKU 规格）。 */
  public updateDraftSpecifications(specifications: Array<{ name: string; value: string }>): void {
    if (!this.reviewedDraft) return
    this.reviewedDraft.specifications = specifications.map((s) => ({
      name: s.name.trim(),
      value: s.value.trim(),
    }))
    this.onDraftEdit()
    this.notify()
  }

  /**
   * 切换类目：
   * 1. 更新 draft.category；
   * 2. 清空不适用的属性（清空旧属性列表）；
   * 3. 重置 categoryConfirmed = false（类目确认失效，必须重新确认）。
   */
  public selectCategory(candidate: NormalizedCardValue): void {
    if (!this.reviewedDraft) return
    this.reviewedDraft.category = buildCategoryFromCandidate(candidate)
    this.reviewedDraft.attributes = []
    this.categoryConfirmed = false
    this.onDraftEdit()
    this.notify()
  }

  /**
   * 更新属性取值：
   * 严格按后台 normalizeReviewedDraft 要求构造 { propertyId, valueId }。
   */
  public selectAttribute(propertyId: string, valueId: string): void {
    if (!this.reviewedDraft) return
    this.reviewedDraft.attributes = setAttributeSelection(
      this.reviewedDraft.attributes || [],
      propertyId,
      valueId,
    )
    this.onDraftEdit()
    this.notify()
  }

  /**
   * 图片重排（只能在已上传集合内重排，不能添加新图）。
   */
  public reorderImages(fromIndex: number, toIndex: number): void {
    if (!this.reviewedDraft || !Array.isArray(this.reviewedDraft.images)) return
    const list = [...this.reviewedDraft.images]
    if (fromIndex < 0 || fromIndex >= list.length || toIndex < 0 || toIndex >= list.length) return
    const [moved] = list.splice(fromIndex, 1)
    list.splice(toIndex, 0, moved)
    this.reviewedDraft.images = list
    this.onDraftEdit()
    this.notify()
  }

  /**
   * 删除图片（只能保留 1~9 张已上传图片）。
   */
  public removeImage(index: number): void {
    if (!this.reviewedDraft || !Array.isArray(this.reviewedDraft.images)) return
    if (this.reviewedDraft.images.length <= 1) return // 至少保留 1 张
    const list = [...this.reviewedDraft.images]
    list.splice(index, 1)
    this.reviewedDraft.images = list
    this.onDraftEdit()
    this.notify()
  }

  /** 更新发货地址白名单字段。 */
  public updateDraftAddress(patch: Record<string, string>): void {
    if (!this.reviewedDraft) return
    this.reviewedDraft.address = {
      ...(this.reviewedDraft.address || {}),
      ...patch,
    }
    this.onDraftEdit()
    this.notify()
  }

  /** 切换服务卡片启用状态（AI_SALE 强制始终为 false）。 */
  public toggleService(serviceCode: string, enable: boolean): void {
    if (!this.reviewedDraft || !Array.isArray(this.reviewedDraft.services)) return
    if (serviceCode === 'AI_SALE') return
    const services = this.reviewedDraft.services.map((s) => {
      if (s.serviceCode === serviceCode) {
        return { serviceCode, enable }
      }
      return s
    })
    this.reviewedDraft.services = services
    this.onDraftEdit()
    this.notify()
  }

  /** 设置类目与属性确认勾选。 */
  public setCategoryConfirmed(confirmed: boolean): void {
    this.categoryConfirmed = confirmed
    this.notify()
  }

  /** 设置提交阶段无二维码承诺勾选。 */
  public setSubmitConfirmedNoQrCodes(confirmed: boolean): void {
    this.submitConfirmedNoQrCodes = confirmed
    this.notify()
  }

  // ==================== 最终提交方法 ====================

  /**
   * 第二阶段：最终提交（Submit）。
   * 仅发送 token/draft/confirm: true 规范参数；
   * 旧 categoryConfirmed / confirmedNoQrCodes 可选兼容，新前端不伪造发送 true；
   * 成功必须返回 published + itemId；
   * 结果未知时加入持久化同源锁，严禁自动重试。
   */
  public async executeSubmit(): Promise<DirectPublishSubmitResult> {
    if (this.isDraftLocked()) {
      const errRes: DirectPublishSubmitResult = {
        status: 'unknown',
        idempotencyKey: this.currentIdempotencyKey,
        code: 'DRAFT_LOCKED_UNKNOWN',
        message: '该草稿此前提交结果未知，已锁定以防闲鱼重复发布！请在闲鱼核实后手动解锁。',
      }
      this.phase = 'unknown'
      this.errorCode = errRes.code || 'UNKNOWN_LOCKED'
      this.errorMessage = errRes.message || '草稿已锁定'
      this.notify()
      return errRes
    }

    if (!this.canSubmit() || !this.reviewedDraft) {
      const errRes: DirectPublishSubmitResult = {
        status: 'rejected',
        idempotencyKey: this.currentIdempotencyKey,
        code: 'SUBMIT_GATE_BLOCKED',
        message: '发布信息不完整（请确保标题、描述、价格及地址有效），无法提交发布',
      }
      this.errorCode = errRes.code || 'GATE_BLOCKED'
      this.errorMessage = errRes.message || '门禁未通过'
      this.notify()
      return errRes
    }

    this.phase = 'submitting'
    this.errorCode = null
    this.errorMessage = null
    this.notify()

    const submitReq: DirectPublishSubmitRequest = {
      prepareToken: this.prepareToken,
      draft: cloneDraft(this.reviewedDraft) as any,
      confirm: true,
    }

    const result = await this.client.submit(submitReq)
    this.submitResult = result

    // 成功判据：published 并且存在真实 itemId，缺一不可！
    if (result.status === 'published' && result.itemId) {
      this.phase = 'published'
      this.publishedItemId = result.itemId
      this.warnings = result.warnings || []
      this.notify()
      return result
    }

    // 结果未知：无论是后台返回 unknown 还是通信失联，锁定该草稿并持久化！
    if (result.status === 'unknown') {
      this.phase = 'unknown'
      if (this.sourceKey) {
        this.lockedSourceKeys.add(this.sourceKey)
        saveLockedSourceKeys(this.lockedSourceKeys)
      }
      this.errorCode = result.code || 'SUBMIT_UNKNOWN'
      this.errorMessage =
        result.message || '提交结果未知，为防止在闲鱼重复发布同一商品，已锁定该草稿，严禁自动重试！请在闲鱼核实后手动解锁。'
      this.notify()
      return result
    }

    if (result.status === 'action_required') {
      this.phase = 'action_required'
      this.actionRequired = result.actionRequired || 'login'
      this.errorCode = result.code || 'ACTION_REQUIRED'
      this.errorMessage = result.message || '提交时平台要求验证身份，请先完成验证'
      this.notify()
      return result
    }

    // rejected：后台尝试发布后被平台拒绝
    // 1. 若 prepareTokenValid 为 false（令牌失效/审计未持久化等）：禁用提交，引导重新准备，但完整保留 reviewedDraft 草稿
    if (result.prepareTokenValid === false) {
      this.phase = 'submit_rejected'
      this.prepareToken = '' // 清空 token 禁用提交（canSubmit 返回 false）
      this.errorCode = result.code || 'SUBMIT_REJECTED'
      this.errorMessage = `${result.message || '发布被平台拒绝'}（准备令牌已失效，请重新准备发布）`
      this.notify()
      return result
    }

    // 2. 正常业务拒绝（FAIL_BIZ_* / DRAFT_TITLE_INVALID，retryable: true, prepareTokenValid: true）
    // 保持 token、保持 editable draft、不切 unknown 页、不锁草稿，仅 Callout 提示修改并可再次提交
    this.phase = 'submit_rejected'
    this.errorCode = result.code || 'SUBMIT_REJECTED'
    this.errorMessage = `${result.message || '发布被平台拒绝'}（请修改后再次点击确认并发布）`
    this.notify()
    return result
  }

  /**
   * 取消操作：仅关闭流程或返回 idle，不发布任何内容。
   * 取消时递增 prepareSequence，使在途的异步 prepare 彻底作废，杜绝后台响应返回后偷偷改写状态或打开！
   */
  public cancel(): void {
    if (this.phase === 'submitting') {
      // 提交中禁止取消
      return
    }
    this.prepareSequence++
    this.phase = 'idle'
    this.notify()
  }

  /**
   * 人工核实后解除同源未知锁定（必须由操作员明确在闲鱼核实未重复发布后触发，绝不自动解锁）。
   */
  public manualUnlockDraft(): void {
    if (this.sourceKey) {
      this.lockedSourceKeys.delete(this.sourceKey)
      saveLockedSourceKeys(this.lockedSourceKeys)
    }
    this.phase = 'idle'
    this.errorCode = null
    this.errorMessage = null
    this.notify()
  }
}
