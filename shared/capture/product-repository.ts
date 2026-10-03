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
import { buildProductSnapshot } from './normalizer'
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
   * 按 `itemId` 去重 upsert 商品，并为每条商品追加一条采集快照（按 `itemId@capturedAt` 去重）。
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
 * 计算 upsert 时应实际写入的商品：在保留既有归属可信度的前提下合并最新采集字段。
 *
 * 归属安全规则：
 * - 高可信来源（已确认归属）绝不被低可信（未确认归属）覆盖，`my_published` 绝不被降级；
 * - 确定来源优先：已确认竞品不被未确认归属覆盖；
 * - 新采集可信度更高时以新采集为准（如后续采集确认了归属）；
 * - 无论哪一方胜出，最终都校正 sellerId / source / accountId 一致性。
 */
export function mergeProductForUpsert(existing: Product | undefined, incoming: Product): Product {
  if (!existing) return finalizeOwnership({ ...normalizeProductSource(incoming) })

  const prior = normalizeProductSource(existing)
  const next = normalizeProductSource(incoming)
  const merged: Product = { ...prior, ...next }

  // 归属未确认不得覆盖已确认归属：保留既有来源、状态、账号与卖家，保证 my_published 不被降级。
  if (ownershipRank(prior) > ownershipRank(next)) {
    merged.source = prior.source
    merged.status = prior.status
    merged.accountId = prior.accountId
    merged.sellerId = prior.sellerId
    merged.ownershipUnconfirmed = prior.ownershipUnconfirmed
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

      const snapshot = buildProductSnapshot(stored, capturedAt)
      // 同一 (itemId, capturedAt) 视为同一观测：覆盖写入，仅在首次时计入新增快照。
      const isNewSnapshot = !this.snapshots.has(snapshot.id)
      this.snapshots.set(snapshot.id, snapshot)
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
      .map((snapshot) => ({ ...snapshot }))
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
