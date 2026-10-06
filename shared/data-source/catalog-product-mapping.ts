/**
 * 商品目录 {@link CatalogProduct} → 发布可用 {@link Product} 映射（当前账号自有商品）。
 *
 * 目的：让「发布候选」与「发布创建」使用**同一来源契约**——发布页候选来自商品目录
 * `my_published` 只读读取，发布创建时后台用同一个目录快照按 itemId 复验并组装可发布商品，
 * 而不是要求候选必须先被采集写入本地商品库。
 *
 * 安全与边界（硬性）：
 * - 只映射 `source === 'my_published'`（当前账号官方在售）且 itemId 非空的条目；
 *   飞书素材、缺 itemId 的脏数据一律返回 `null`，调用方据此结构化拒绝；
 * - 只做字段映射，**绝不**写入本地商品库，也绝不伪造图片 / 描述 / 价格；
 * - 图片缺失时保留空数组，由发布规则（`validateAndFilterImages`）在创建阶段结构化拒绝，
 *   不使用占位图冒充真实商品图。
 */
import { formatProductTime } from '../capture/normalizer'
import type { CatalogProduct } from '../types/product-catalog'
import type { Product } from '../types/product'

/**
 * 把商品目录条目映射为可发布的当前账号自有商品。
 *
 * @param catalog 商品目录条目（`PRODUCT_CATALOG_QUERY` 结果）
 * @returns 可发布商品；来源不是当前账号自有商品或缺少真实 itemId 时返回 `null`
 */
export function mapCatalogProductToProduct(catalog: CatalogProduct): Product | null {
  if (catalog.source !== 'my_published') return null
  const itemId = catalog.itemId?.trim() ?? ''
  if (!itemId) return null

  const captureTimeMs = catalog.captureTimeMs ?? 0
  const images =
    Array.isArray(catalog.images) && catalog.images.length > 0
      ? [...catalog.images]
      : catalog.coverUrl
        ? [catalog.coverUrl]
        : []
  const coverUrl = catalog.coverUrl || images[0] || ''

  return {
    itemId,
    title: catalog.title ?? '',
    price: catalog.price || (catalog.priceNumber > 0 ? `¥${catalog.priceNumber}` : ''),
    priceNumber: catalog.priceNumber ?? 0,
    originalPrice:
      catalog.originalPrice || (catalog.originalPriceNumber > 0 ? `¥${catalog.originalPriceNumber}` : ''),
    originalPriceNumber: catalog.originalPriceNumber ?? 0,
    wantCnt: catalog.wantCnt ?? 0,
    publishTime: '',
    publishTimeMs: 0,
    captureTime: captureTimeMs > 0 ? formatProductTime(captureTimeMs) : '',
    captureTimeMs,
    sellerNick: catalog.sellerNick ?? '',
    sellerCity: catalog.sellerCity ?? '',
    freeShip: catalog.freeShip ?? '',
    tags: catalog.tags ?? '',
    coverUrl,
    detailUrl: catalog.detailUrl || `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}`,
    // 来源固定为当前账号自有商品：目录 `my_published` 本身即官方「我的商品库」在售读取结果。
    source: 'my_published',
    status: 'published',
    desc: catalog.desc ?? '',
    images,
  }
}
