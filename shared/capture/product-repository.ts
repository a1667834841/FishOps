/**
 * 商品库仓储（P4）。
 *
 * - `ProductRepository`：抽象接口，索引键为 `itemId`（去重），并保留历史快照；
 * - `MemoryProductRepository`：纯内存实现，供 Node 测试与无 IndexedDB 环境；
 * - `createMemoryProductRepository`：工厂。
 *
 * IndexedDB 实现位于 extension 侧（`extension/src/capture/indexed-db-repository.ts`），
 * 复用本文件的接口与快照构建逻辑。
 */
import { buildProductSnapshot, mergeProductImages } from './normalizer'
import type {
  Product,
  ProductListQuery,
  ProductOrder,
  ProductPage,
  ProductSnapshot,
  ProductUpsertResult,
} from '../types/product'

/** 商品库仓储接口。 */
export interface ProductRepository {
  /**
   * 按 itemId 合并本地目录，并保存采集快照；搜索快照额外绑定关键字且保留当次完整内容。
   * @param products 归一后的商品列表（同一批次内允许重复 itemId，后者覆盖前者）。
   * @param capturedAt 本次采集时间戳（毫秒）。
   */
  upsertProducts(products: readonly Product[], capturedAt: number): Promise<ProductUpsertResult>
  /** 查询商品列表。 */
  list(query?: ProductListQuery): Promise<ProductPage>
  /** 读取某商品的全部快照（按 capturedAt 升序）。 */
  getSnapshots(itemId: string): Promise<ProductSnapshot[]>
  /** 商品总数。 */
  count(): Promise<number>
  /** 清空商品与快照（主要用于测试 / 重置）。 */
  clear(): Promise<void>
}

/** 按指定方式排序商品（返回新数组，不修改入参）。 */
export function sortProducts(products: readonly Product[], order: ProductOrder = 'captureTimeDesc'): Product[] {
  const copy = [...products]
  switch (order) {
    case 'captureTimeAsc':
      copy.sort((a, b) => a.captureTimeMs - b.captureTimeMs)
      break
    case 'wantCntDesc':
      copy.sort((a, b) => b.wantCnt - a.wantCnt || b.captureTimeMs - a.captureTimeMs)
      break
    case 'captureTimeDesc':
    default:
      copy.sort((a, b) => b.captureTimeMs - a.captureTimeMs)
      break
  }
  return copy
}

/**
 * 安全规整商品来源与状态（对未显式打标的历史旧数据执行最小兼容迁移）。
 * 存量商品缺省标记为 legacy_unconfirmed，杜绝冒充当前账号发布商品。
 */
export function normalizeProductSource(product: Product): Product {
  if (product.source) return product
  return {
    ...product,
    source: 'legacy_unconfirmed',
    status: product.status || 'unconfirmed',
    ownershipUnconfirmed: product.ownershipUnconfirmed ?? true,
  }
}

/**
 * 判定商品归属可信度等级（数值越大越可信）：
 * 3 = my_published（当前账号已确认发布）；
 * 2 = captured_search 且归属已确认（确认是他人竞品）；
 * 1 = 归属未确认（缺卖家身份 / 账号未知 / legacy 存量）。
 * 仅供 upsert 合并时决定「谁覆盖谁」，保证低可信来源绝不覆盖高可信来源。
 */
function ownershipRank(product: Product): number {
  if (product.source === 'my_published') return 3
  if (product.source === 'captured_search') return product.ownershipUnconfirmed === true ? 1 : 2
  return 1
}

/**
 * 校正「来源 / sellerId / accountId」三者一致性，避免同一 itemId 出现自相矛盾的归属：
 * - my_published 必须归属当前账号：回填 accountId，sellerId 与 accountId 对齐；
 * - captured_search 是竞品 / 市场商品：绝不携带当前账号归属，不得残留 accountId；
 * - 其余（legacy_unconfirmed）一律视为归属未确认。
 */
function finalizeOwnership(product: Product): Product {
  if (product.source === 'my_published') {
    product.ownershipUnconfirmed = false
    if (product.accountId) {
      product.sellerId = product.accountId
    } else if (product.sellerId) {
      product.accountId = product.sellerId
    }
  } else if (product.source === 'captured_search') {
    delete product.accountId
    if (product.ownershipUnconfirmed === undefined) {
      product.ownershipUnconfirmed = !product.sellerId
    }
  } else {
    delete product.accountId
    product.ownershipUnconfirmed = true
  }
  return product
}

/**
 * upsert 合并时需要做「稀疏保护」的文本字段。
 *
 * 搜索 / 详情响应可能只返回部分字段（例如某次搜索缺 `userNickName` / `area`，或详情缺失）。
 * 这类字段在归一化时会被写成空串；若直接 `{ ...prior, ...next }`，空串会清空已采到的非空值，
 * 导致卖家 / 地区 / 标题等界面显示「未知」。因此新采集为空串时保留已有非空值。
 */
const SPARSE_PROTECTED_TEXT_FIELDS: readonly string[] = [
  'title',
  'price',
  'originalPrice',
  'publishTime',
  'captureTime',
  'sellerNick',
  'sellerCity',
  'freeShip',
  'tags',
  'coverUrl',
  'detailUrl',
  'sellerId',
  'accountId',
  'uniqueName',
  'desc',
  'category',
]

/**
 * 计算 upsert 时应实际写入的商品：在保留既有归属可信度的前提下合并最新采集字段。
 *
 * 归属安全规则：
 * - 高可信来源（已确认归属）绝不被低可信（未确认归属）覆盖，`my_published` 绝不被降级；
 * - 确定来源优先：已确认竞品不被未确认归属覆盖；
 * - 新采集可信度更高时以新采集为准（如后续采集确认了归属）；
 * - 稀疏响应（新采集字段为空串）绝不清空已采到的非空文本，避免信息被冲空成「未知」；
 * - 无论哪一方胜出，最终都校正 sellerId / source / accountId 一致性。
 */
export function mergeProductForUpsert(existing: Product | undefined, incoming: Product): Product {
  if (!existing) return finalizeOwnership({ ...normalizeProductSource(incoming) })

  const prior = normalizeProductSource(existing)
  const next = normalizeProductSource(incoming)
  const merged: Product = { ...prior, ...next }

  // 稀疏保护：新采集为空串、已有非空时，保留已有值（newest-wins 仅作用于有值的字段）。
  const mergedRecord = merged as unknown as Record<string, unknown>
  const priorRecord = prior as unknown as Record<string, unknown>
  const nextRecord = next as unknown as Record<string, unknown>
  for (const field of SPARSE_PROTECTED_TEXT_FIELDS) {
    const incomingValue = nextRecord[field]
    const priorValue = priorRecord[field]
    if (
      incomingValue === '' &&
      typeof priorValue === 'string' &&
      priorValue.length > 0
    ) {
      mergedRecord[field] = priorValue
    }
  }

  // 价格和时间的文本、数值必须同步保留，否则展示旧价格时分析却会读到缺省的 0。
  // 明确返回的零价有非空价格原文，不会进入缺值保护。
  if (!next.price && next.priceNumber === 0 && prior.price) merged.priceNumber = prior.priceNumber
  if (!next.originalPrice && next.originalPriceNumber === 0 && prior.originalPrice) {
    merged.originalPriceNumber = prior.originalPriceNumber
  }
  if (!next.publishTime && next.publishTimeMs === 0 && prior.publishTime) {
    merged.publishTimeMs = prior.publishTimeMs
  }

  // 归属未确认不得覆盖已确认归属：保留既有来源、状态、账号与卖家，保证 my_published 不被降级。
  if (ownershipRank(prior) > ownershipRank(next)) {
    merged.source = prior.source
    merged.status = prior.status
    merged.accountId = prior.accountId
    merged.sellerId = prior.sellerId
    merged.ownershipUnconfirmed = prior.ownershipUnconfirmed
  }

  // 图片集合：已有 + 新采集合并去重保序，绝不用不完整的新集合覆盖已有完整集合。
  if (prior.images !== undefined || next.images !== undefined) {
    merged.images = mergeProductImages(prior.images, next.images)
  }

  return finalizeOwnership(merged)
}

/** 在商品列表上应用关键字、来源/状态过滤与分页（供各实现复用）。 */
export function queryProducts(
  products: readonly Product[],
  query: ProductListQuery = {},
): ProductPage {
  let items = products.map((product) => normalizeProductSource(product))
  const keyword = query.keyword?.trim()
  if (keyword) {
    items = items.filter(
      (product) => product.title.includes(keyword) || product.itemId.includes(keyword),
    )
  }
  // 来源过滤：缺省安全默认仅当前账号发布商品（my_published）；显式 'all' 才放行全部；
  // 其它来源精准匹配。避免调用方忘了传 source 时把竞品 / 未确认存量商品当作自有商品。
  const sourceFilter = query.source ?? 'my_published'
  if (sourceFilter !== 'all') {
    items = items.filter((product) => product.source === sourceFilter)
  }
  if (query.status) {
    items = items.filter((product) => product.status === query.status)
  }
  items = sortProducts(items, query.order)
  const total = items.length
  const offset = query.offset ?? 0
  const sliced = query.limit === undefined ? items.slice(offset) : items.slice(offset, offset + query.limit)
  return { products: sliced.map((product) => ({ ...product })), total }
}

/** 内存型商品库仓储。 */
export class MemoryProductRepository implements ProductRepository {
  private readonly products = new Map<string, Product>()
  private readonly snapshots = new Map<string, ProductSnapshot>()

  async upsertProducts(products: readonly Product[], capturedAt: number): Promise<ProductUpsertResult> {
    let added = 0
    let updated = 0
    let snapshots = 0

    for (const product of products) {
      if (!product.itemId) continue
      const existing = this.products.get(product.itemId)
      const stored = mergeProductForUpsert(existing, product)
      this.products.set(product.itemId, stored)
      if (existing) updated += 1
      else added += 1

      // 同步快照保留当次输入，不能把本地目录合并后的旧字段带入另一轮采集。
      const snapshot = buildProductSnapshot(product.captureKeyword === undefined ? stored : product, capturedAt)
      // 完整搜索快照保留首次内容；旧分析快照仍允许同观测覆盖。
      const isNewSnapshot = !this.snapshots.has(snapshot.id)
      if (isNewSnapshot || product.captureKeyword === undefined) this.snapshots.set(snapshot.id, snapshot)
      if (isNewSnapshot) snapshots += 1
    }

    return { added, updated, snapshots }
  }

  async list(query: ProductListQuery = {}): Promise<ProductPage> {
    return queryProducts([...this.products.values()], query)
  }

  async getSnapshots(itemId: string): Promise<ProductSnapshot[]> {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.itemId === itemId)
      .sort((a, b) => a.capturedAt - b.capturedAt)
      .map((snapshot) => structuredClone(snapshot))
  }

  async count(): Promise<number> {
    return this.products.size
  }

  async clear(): Promise<void> {
    this.products.clear()
    this.snapshots.clear()
  }
}

/** 创建内存型商品库仓储。 */
export function createMemoryProductRepository(): ProductRepository {
  return new MemoryProductRepository()
}
