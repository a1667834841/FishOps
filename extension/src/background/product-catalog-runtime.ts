/**
 * 商品目录统一查询运行时（P7 商品库，后台 Service Worker）。
 *
 * 覆盖两类来源，**不改变**既有 `PRODUCT_LIST`（本地商品库）与
 * `FEISHU_PRODUCTS_PAGE` / `FEISHU_PRODUCT_GET`（发布素材）的语义：
 * - `feishu`：复用现有专用飞书分页读取（目标表固定为已配置商品表，服务端关键词 / 排序），
 *   把平铺行转换为统一 {@link CatalogProduct}；游标必须绑定目标表（防跨表游标）。
 * - `my_published`：经 MAIN world 平台桥接（复用现有认证 / 签名 / 限流 / 错误处理）读取当前账号
 *   官方「我的商品库」**全部在售商品**，并按需调用既有详情接口补齐 desc / wantCnt / cover。
 *
 * 安全与边界（硬性）：
 * - 只读；结果不含任何 token / cookie / 密钥；错误**绝不透传**底层任意含凭证的原始信息；
 * - `my_published` 读取失败（未登录 / 登录失效 / 平台报错 / 分页被截断 / 结构异常）一律**报错**，
 *   绝不返回空列表；详情**部分失败**（非会话类）保留列表并写入 `warnings`；
 * - **缓存按账号会话复用**：同一账号在本次查询会话内翻页直接复用，`forceRefresh`（进入 / 刷新）重建；
 *   每请求都确认当前账号，账号变化立即重建；账号失效 / 切换**清空旧集合**并返回 `unauthorized`；
 * - **inflight 按 accountId + generation 隔离**：切号或 forceRefresh 后的旧读取完成后，
 *   **绝不覆盖新 snapshot、也绝不清除新 inflight**；
 * - 读取列表后与详情全部完成后**再次确认账号一致**（初始 / readAccountId / 当前账号三者一致）。
 */
import {
  CommandTypes,
  createErrorResponse,
  createResponse,
  isProductCatalogQueryPayload,
  type CommandEnvelope,
  type ProtocolError,
  type ResponseEnvelope,
} from '@fishops/shared'
import { PlatformError } from '../platform/errors'
import { FeishuProductsError } from './feishu-products-runtime'
import { mergeProductImages, normalizeDetailPatch } from '../../../shared/capture/normalizer'
import { mapFeishuRowToCatalogProduct } from '../../../shared/data-source/feishu-product-mapping'
import { mapOnSaleCardToProduct } from '../../../shared/data-source/published-item-mapping'
import {
  PRODUCT_CATALOG_DEFAULT_PAGE_SIZE,
  PRODUCT_CATALOG_MAX_PAGE_SIZE,
  type CatalogProduct,
  type ProductCatalogQueryPayload,
  type ProductCatalogQueryResult,
} from '../../../shared/types/product-catalog'
import type { ProductOrder } from '../../../shared/types/product'
import type {
  FeishuProductsOrder,
  FeishuProductsPagePayload,
  FeishuProductsPageResult,
} from '../../../shared/types/feishu-products'

/** 平台桥接端口（MAIN world）：当前账号在售商品 + 详情 + 账号确认。 */
export interface CatalogPlatformPort {
  /** 平台层当前是否可用（缺少 scripting / tabs 时为 false）。 */
  isAvailable(): boolean
  /** 读取当前登录账号 ID（仅读 cookie；未登录返回 null）。 */
  currentUserId(): Promise<string | null>
  /** 读取当前账号全部在售原始卡片（读全；失败抛错）。 */
  listOnSaleItems(): Promise<{ accountId: string; items: Record<string, unknown>[] }>
  /** 读取单条商品详情原始 JSON（MTOP）。 */
  detail(itemId: string): Promise<unknown>
}

/** 飞书专用分页读取端口（复用同一运行时实例）。 */
export interface CatalogFeishuPort {
  /** 返回完整配置身份的内部指纹，确保缓存不跨应用或表格配置复用。 */
  cacheIdentity(): Promise<string | null>
  page(payload: FeishuProductsPagePayload): Promise<FeishuProductsPageResult>
}

export interface ProductCatalogRuntimeDeps {
  platform: CatalogPlatformPort
  feishu: CatalogFeishuPort
  /** 时间源，默认 `Date.now`。 */
  now?: () => number
  /**
   * 详情补齐时间预算（毫秒，默认 {@link PRODUCT_CATALOG_DETAIL_ENRICH_BUDGET_MS}）。
   * 首次读取在 UI bridge 超时内必须有界：预算内未补齐的商品跳过并告警，绝不把正常账号目录拖到超时。
   */
  detailEnrichBudgetMs?: number
  /** 详情补齐条数上限（默认 {@link PRODUCT_CATALOG_MAX_DETAIL_ENRICH}）。 */
  maxDetailEnrich?: number
}

/** 商品目录运行时。 */
export interface ProductCatalogRuntime {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
  refreshCaches(source?: 'feishu' | 'my_published' | 'all'): Promise<void>
  /**
   * 只读解析当前账号自有（`my_published`）商品：复用会话快照，按 itemId 精确匹配。
   *
   * 语义约定：
   * - 命中返回目录条目；未命中返回 `null`（可能是已下架 / 候选过期，调用方应提示刷新）；
   * - 空 itemId 直接返回 `null`，绝不猜商品；
   * - 未登录 / 登录失效 / 账号变更 / 平台读取失败一律抛 {@link PlatformError}，
   *   **绝不降级为空候选或返回其他账号的商品**；
   * - 只读：不写入本地商品库，也不产生任何外部写入。
   */
  resolveMyPublishedItem(itemId: string): Promise<CatalogProduct | null>
}

/** 详情补齐默认时间预算（列表读取通常数秒，预算内补齐可保证首次调用在 bridge 超时内返回）。 */
export const PRODUCT_CATALOG_DETAIL_ENRICH_BUDGET_MS = 8000
/** 详情补齐默认条数上限。 */
export const PRODUCT_CATALOG_MAX_DETAIL_ENRICH = 20

/** 会话类致命错误类别：详情补齐遇到时整体失败（不降级为 warning）。 */
const FATAL_PLATFORM_CATEGORIES: ReadonlySet<string> = new Set([
  'host-unavailable',
  'unauthorized',
  'token-expired',
  'captcha',
])

interface CatalogSnapshot {
  accountId: string
  products: CatalogProduct[]
  warnings: string[]
  fetchedAt: number
}

interface InflightLoad {
  accountId: string
  generation: number
  promise: Promise<CatalogSnapshot>
}

/** 安全错误类别（不暴露底层任意 message）。 */
function safeCategory(error: unknown): string {
  return error instanceof PlatformError ? error.category : 'unknown'
}

/** 规整每页条数到 [1, 上限]。 */
function resolvePageSize(requested?: number): number {
  if (requested === undefined) return PRODUCT_CATALOG_DEFAULT_PAGE_SIZE
  return Math.min(Math.max(1, Math.floor(requested)), PRODUCT_CATALOG_MAX_PAGE_SIZE)
}

/** 在完整集合上排序（自有商品使用发布时间，兼容既有时间排序枚举）。 */
function sortCatalogProducts(
  products: readonly CatalogProduct[],
  order: ProductOrder = 'captureTimeDesc',
): CatalogProduct[] {
  const copy = [...products]
  switch (order) {
    case 'captureTimeAsc':
      copy.sort((a, b) => (a.publishTimeMs ?? 0) - (b.publishTimeMs ?? 0))
      break
    case 'wantCntDesc':
      copy.sort((a, b) => b.wantCnt - a.wantCnt || (b.publishTimeMs ?? 0) - (a.publishTimeMs ?? 0))
      break
    case 'captureTimeDesc':
    default:
      copy.sort((a, b) => (b.publishTimeMs ?? 0) - (a.publishTimeMs ?? 0))
      break
  }
  return copy
}

/** 关键词过滤（标题 / 商品ID 包含匹配）。 */
function filterByKeyword(products: readonly CatalogProduct[], keyword: string): CatalogProduct[] {
  const needle = keyword.trim()
  if (!needle) return [...products]
  return products.filter((p) => p.title.includes(needle) || p.itemId.includes(needle))
}

/** 本地排序（ProductOrder）→ 飞书服务端排序枚举（含真实「采集时间」字段）。 */
function toFeishuOrder(order: ProductOrder): FeishuProductsOrder {
  switch (order) {
    case 'wantCntDesc':
      return 'wantCntDesc'
    case 'captureTimeAsc':
      return 'captureTimeAsc'
    case 'captureTimeDesc':
      return 'captureTimeDesc'
    default:
      return 'default'
  }
}

/** 创建商品目录运行时。 */
export function createProductCatalogRuntime(deps: ProductCatalogRuntimeDeps): ProductCatalogRuntime {
  const now = deps.now ?? (() => Date.now())
  const detailBudgetMs = deps.detailEnrichBudgetMs ?? PRODUCT_CATALOG_DETAIL_ENRICH_BUDGET_MS
  const maxDetailEnrich = deps.maxDetailEnrich ?? PRODUCT_CATALOG_MAX_DETAIL_ENRICH

  /** 当前账号快照（会话级复用；账号变化 / forceRefresh 才重建）。 */
  let snapshot: CatalogSnapshot | null = null
  /** 全局代际计数：每次重建（含 forceRefresh）自增，用于丢弃旧完成。 */
  let generation = 0
  /** 进行中的账号集合读取（按 accountId + generation 隔离）。 */
  let inflight: InflightLoad | null = null
  const feishuSnapshots = new Map<string, ProductCatalogQueryResult>()
  const feishuInflight = new Map<string, Promise<ProductCatalogQueryResult>>()
  let feishuGeneration = 0
  let cacheRefresh: Promise<void> | null = null
  const dirtyRefreshSources = new Set<'feishu' | 'my_published' | 'all'>()
  const activeRefreshSources = new Set<'feishu' | 'my_published' | 'all'>()

  /**
   * 按需用详情补齐缺字段：列表已含 desc / cover / wantCnt 的项跳过；
   * 受预算（时间 + 条数）约束，超预算跳过并告警；单条非致命失败保留列表并告警；
   * 会话类失败（未登录 / token 失效 / 风控 / host 不可用）整体抛出。
   */
  async function enrichWithDetail(products: CatalogProduct[]): Promise<string[]> {
    const warnings: string[] = []
    const deadline = now() + detailBudgetMs
    let enriched = 0
    let skipped = 0
    for (const product of products) {
      // 列表已含 desc / cover / wantCnt / 卖家地区 / 卖家昵称时跳过；缺任一即尝试用详情补齐
      // （在售卡片通常不含卖家地区，需经详情接口的 sellerDO / itemDO.city 补全）。
      if (
        product.desc &&
        product.coverUrl &&
        product.wantCnt > 0 &&
        product.sellerCity &&
        product.sellerNick &&
        product.publishTimeMs
      ) {
        continue
      }
      if (enriched >= maxDetailEnrich || now() >= deadline) {
        skipped += 1
        continue
      }
      try {
        const raw = await deps.platform.detail(product.itemId)
        const patch = normalizeDetailPatch(raw)
        if (patch.publishTimeMs) product.publishTimeMs = patch.publishTimeMs
        if (patch.desc) product.desc = patch.desc
        if (typeof patch.wantCnt === 'number') product.wantCnt = patch.wantCnt
        // 详情补出的卖家地区 / 昵称：列表未提供时才写入，绝不覆盖已有真实值。
        if (patch.sellerCity && !product.sellerCity) product.sellerCity = patch.sellerCity
        if (patch.sellerNick && !product.sellerNick) product.sellerNick = patch.sellerNick
        if (patch.images && patch.images.length > 0) {
          product.images = mergeProductImages(product.images, patch.images)
          if (!product.coverUrl) product.coverUrl = product.images[0] ?? ''
        }
        enriched += 1
      } catch (error) {
        if (error instanceof PlatformError && FATAL_PLATFORM_CATEGORIES.has(error.category)) throw error
        // 只回传安全类别与商品 ID，绝不透传底层原始 message（可能含凭证 / 原始响应）。
        warnings.push(`商品 ${product.itemId} 详情补齐失败（${safeCategory(error)}）`)
      }
    }
    if (skipped > 0) {
      warnings.push(`本次已跳过 ${skipped} 件商品的详情补齐（超出预算），可稍后刷新重试`)
    }
    return warnings
  }

  /**
   * 确认账号在读取过程中未变化：初始账号 / 读取返回账号 / 当前账号三者必须一致。
   * 任一不一致（切号 / 失效）→ 清空旧 snapshot 并抛 `unauthorized`，绝不返回旧集合。
   */
  async function assertAccountUnchanged(initial: string, readAccountId: string): Promise<void> {
    const current = await deps.platform.currentUserId()
    if (readAccountId !== initial || current !== initial) {
      // 账号在本次读取过程中发生变化：丢弃本次结果。
      // 仅在现有 snapshot 不属于**当前**账号时才清空，避免误清新账号（并发读取）的合法集合。
      if (snapshot && snapshot.accountId !== current) snapshot = null
      throw new PlatformError('unauthorized', '登录账号已变更，已丢弃本次在售集合读取结果，请刷新重试')
    }
  }

  /** 实际读取（一次会话内的重建）。 */
  async function runLoad(accountId: string, myGeneration: number): Promise<CatalogSnapshot> {
    const { accountId: readAccountId, items } = await deps.platform.listOnSaleItems()
    // 读取列表后立即确认账号一致。
    await assertAccountUnchanged(accountId, readAccountId)

    const capturedAt = now()
    const products: CatalogProduct[] = []
    for (const card of items) {
      const product = mapOnSaleCardToProduct(card, { capturedAt })
      if (product) products.push(product)
    }

    const warnings = await enrichWithDetail(products)
    // 详情全部完成后再次确认账号一致。
    await assertAccountUnchanged(accountId, readAccountId)

    const next: CatalogSnapshot = { accountId: readAccountId, products, warnings, fetchedAt: now() }
    // 仅当仍是最新 generation 时才写 snapshot，防止旧完成（切号 / forceRefresh 的迟到结果）覆盖新 snapshot。
    if (myGeneration === generation) snapshot = next
    return next
  }

  /** 读取当前账号全量在售商品（会话复用；forceRefresh / 账号变化重建）。 */
  async function load(forceRefresh: boolean, duringRefresh = false): Promise<CatalogSnapshot> {
    if (!deps.platform.isAvailable()) {
      throw new PlatformError('host-unavailable', '平台层未就绪：请先打开并登录 goofish.com 闲鱼页面')
    }
    let accountId = await deps.platform.currentUserId()
    if (!accountId) {
      // 失效 / 未登录：清空旧集合，绝不返回旧账号数据。
      snapshot = null
      throw new PlatformError('unauthorized', '未登录或登录状态已失效，请先在 goofish.com 登录闲鱼账号')
    }
    // 账号变化：清空旧账号集合（避免任何路径返回旧集合）。
    if (snapshot && snapshot.accountId !== accountId) snapshot = null

    // 会话复用：同一账号、非强制刷新 → 直接复用（不因时间过期而翻页重建）。
    if (!forceRefresh && !duringRefresh && cacheRefresh &&
      (activeRefreshSources.has('all') || activeRefreshSources.has('my_published'))) {
      await cacheRefresh
      accountId = await deps.platform.currentUserId()
      if (!accountId) {
        snapshot = null
        throw new PlatformError('unauthorized', '未登录或登录状态已失效，请先在 goofish.com 登录闲鱼账号')
      }
      if (snapshot?.accountId === accountId) return snapshot
    }
    if (!forceRefresh && snapshot && snapshot.accountId === accountId) return snapshot
    // 并发合并：同一账号同一会话内的并发请求共享 inflight；forceRefresh 不共享（起新代际）。
    if (!forceRefresh && inflight && inflight.accountId === accountId) return inflight.promise

    const myGeneration = (generation += 1)
    const promise = runLoad(accountId, myGeneration)
    inflight = { accountId, generation: myGeneration, promise }
    try {
      return await promise
    } finally {
      // 只有仍是最新 inflight 时才清除，避免旧完成清掉新 inflight。
      if (inflight && inflight.generation === myGeneration) inflight = null
    }
  }

  async function queryMyPublished(payload: ProductCatalogQueryPayload): Promise<ProductCatalogQueryResult> {
    const current = await load(payload.forceRefresh === true)
    const pageSize = resolvePageSize(payload.pageSize)
    const page = Math.max(0, payload.page ?? 0)

    const filtered = payload.keyword ? filterByKeyword(current.products, payload.keyword) : [...current.products]
    const sorted = sortCatalogProducts(filtered, payload.order)
    const total = sorted.length
    const offset = page * pageSize
    const products = sorted.slice(offset, offset + pageSize)

    return {
      source: 'my_published',
      products,
      total,
      page,
      pageSize,
      hasMore: offset + pageSize < total,
      warnings: current.warnings,
      fetchedAt: current.fetchedAt,
    }
  }

  async function queryFeishu(payload: ProductCatalogQueryPayload): Promise<ProductCatalogQueryResult> {
    const pageSize = resolvePageSize(payload.pageSize)
    const identity = await deps.feishu.cacheIdentity()
    if (!identity) throw new FeishuProductsError('INVALID_PAYLOAD', '飞书未配置：请先在设置页填写飞书应用与多维表格信息', 'CONFIG_MISSING')
    if (!payload.forceRefresh && cacheRefresh &&
      (activeRefreshSources.has('all') || activeRefreshSources.has('feishu'))) {
      await cacheRefresh
      return queryFeishu(payload)
    }
    const cacheKey = JSON.stringify([identity, payload.targetTableId ?? '', payload.cursor ?? '', payload.keyword ?? '', payload.order ?? '', pageSize])
    if (payload.forceRefresh) {
      feishuGeneration += 1
      invalidateFeishuIdentity(identity)
    }
    const cached = feishuSnapshots.get(cacheKey)
    if (cached) return cached
    const pending = feishuInflight.get(cacheKey)
    if (pending) return pending
    const requestGeneration = feishuGeneration
    const request = (async () => {
      const res = await deps.feishu.page({
        pageSize,
        ...(payload.cursor ? { pageToken: payload.cursor } : {}),
        ...(payload.targetTableId ? { targetTableId: payload.targetTableId } : {}),
        ...(payload.keyword ? { keyword: payload.keyword } : {}),
        ...(payload.order ? { order: toFeishuOrder(payload.order) } : {}),
      })
      const products = res.rows.map((row) => mapFeishuRowToCatalogProduct(row))
      // 首页为空且没有后续页即可确定总数为 0；其他未知总数仍保持未知。
      const total =
        typeof res.total === 'number' && Number.isFinite(res.total) && res.total >= 0 ? res.total
          : !payload.cursor && !payload.page && products.length === 0 && !res.hasMore ? 0 : null
      const result: ProductCatalogQueryResult = {
        source: 'feishu',
        products,
        total,
        page: Math.max(0, payload.page ?? 0),
        pageSize,
        hasMore: Boolean(res.hasMore),
        ...(res.nextPageToken ? { nextCursor: res.nextPageToken } : {}),
        targetTableId: res.targetTableId,
        warnings: [],
        fetchedAt: now(),
      }
      if (requestGeneration === feishuGeneration && await deps.feishu.cacheIdentity() === identity) {
        feishuSnapshots.set(cacheKey, result)
      }
      return result
    })()
    feishuInflight.set(cacheKey, request)
    try {
      return await request
    } finally {
      if (feishuInflight.get(cacheKey) === request) feishuInflight.delete(cacheKey)
    }
  }

  function invalidateFeishuIdentity(identity: string): void {
    for (const key of feishuSnapshots.keys()) {
      if ((JSON.parse(key) as unknown[])[0] === identity) feishuSnapshots.delete(key)
    }
    for (const key of feishuInflight.keys()) {
      if ((JSON.parse(key) as unknown[])[0] === identity) feishuInflight.delete(key)
    }
  }

  async function refreshCaches(source: 'feishu' | 'my_published' | 'all' = 'all'): Promise<void> {
    if (cacheRefresh) {
      activeRefreshSources.add(source)
      dirtyRefreshSources.add(source)
      return cacheRefresh
    }
    activeRefreshSources.add(source)
    dirtyRefreshSources.add(source)
    cacheRefresh = (async () => {
      while (dirtyRefreshSources.size > 0) {
        const sources = new Set(dirtyRefreshSources)
        dirtyRefreshSources.clear()
        const effective = sources.has('all') || (sources.has('feishu') && sources.has('my_published'))
          ? 'all'
          : sources.values().next().value ?? 'all'
        await refreshAllCaches(effective)
      }
    })()
    try {
      await cacheRefresh
    } finally {
      activeRefreshSources.clear()
      cacheRefresh = null
    }
  }

  async function refreshAllCaches(source: 'feishu' | 'my_published' | 'all'): Promise<void> {
    const refreshPublished = source === 'all' || source === 'my_published'
    const refreshFeishu = source === 'all' || source === 'feishu'
    const tasks: Promise<unknown>[] = []
    if (refreshPublished) {
      generation += 1
      inflight = null
      tasks.push(load(true, true))
    }
    if (refreshFeishu) {
      feishuGeneration += 1
      feishuSnapshots.clear()
      feishuInflight.clear()
      tasks.push(queryFeishu({ source: 'feishu', pageSize: PRODUCT_CATALOG_DEFAULT_PAGE_SIZE, order: 'captureTimeDesc', forceRefresh: true }))
    }
    await Promise.allSettled(tasks)
  }

  /**
   * 只读解析当前账号自有商品（当前账号官方在售目录）：复用会话快照（无快照时重建一次）。
   * 账号失效 / 切换 / 平台读取失败抛错，未命中返回 null。
   */
  async function resolveMyPublishedItem(itemId: string): Promise<CatalogProduct | null> {
    const target = itemId?.trim() ?? ''
    if (!target) return null
    const current = await load(false)
    return current.products.find((product) => product.itemId === target) ?? null
  }

  function toErrorResponse(command: CommandEnvelope, error: unknown): ResponseEnvelope {
    // 仅透传飞书运行时已脱敏的结构化错误，保留配置引导及真实故障类型。
    if (error instanceof FeishuProductsError) {
      return createErrorResponse(command.requestId, command.type, {
        code: error.code,
        message: error.message,
        ...(error.businessCode === undefined ? {} : { businessCode: error.businessCode }),
      })
    }
    if (error instanceof PlatformError) {
      const protocolError: ProtocolError = {
        code: 'PLATFORM_ERROR',
        message: error.message,
        category: error.category,
        ...(error.retCode === undefined ? {} : { retCode: error.retCode }),
      }
      return createErrorResponse(command.requestId, command.type, protocolError)
    }
    // 非平台错误：绝不透传底层任意 message（可能含凭证 / 原始响应）。
    return createErrorResponse(command.requestId, command.type, {
      code: 'INTERNAL',
      message: '商品目录查询失败：请稍后重试',
    })
  }

  async function handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (command.type !== CommandTypes.PRODUCT_CATALOG_QUERY) {
      return createErrorResponse(command.requestId, command.type, {
        code: 'UNKNOWN_COMMAND',
        message: `非商品目录命令: ${command.type}`,
      })
    }
    if (!isProductCatalogQueryPayload(command.payload)) {
      return createErrorResponse(command.requestId, command.type, {
        code: 'INVALID_PAYLOAD',
        message:
          'PRODUCT_CATALOG_QUERY 负载非法：需要合法 source 与可选 keyword / order / pageSize / page / cursor / targetTableId / forceRefresh',
      })
    }
    try {
      const result =
        command.payload.source === 'feishu'
          ? await queryFeishu(command.payload)
          : await queryMyPublished(command.payload)
      return createResponse(command.requestId, command.type, result)
    } catch (error) {
      return toErrorResponse(command, error)
    }
  }

  return { handleCommand, refreshCaches, resolveMyPublishedItem }
}
