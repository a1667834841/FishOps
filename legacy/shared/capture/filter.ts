/**
 * 采集过滤（P4）。
 *
 * 对照旧 `FishOps`（main 分支）`background.js` 的过滤规则：
 * 最小想要人数、价格区间、只看包邮。值为 0 / false 表示不限制。
 */
import type { Product } from '../types/product'
import type { CaptureFilter } from '../types/capture'

/**
 * 判断商品是否通过过滤条件。
 * 未提供过滤条件或缺省字段时一律放行（与旧实现 `> 0` 的判断一致）。
 */
export function passesCaptureFilter(product: Product, filter?: CaptureFilter): boolean {
  if (!filter) return true

  const minWantCnt = filter.minWantCnt ?? 0
  if (minWantCnt > 0 && product.wantCnt < minWantCnt) return false

  const minPrice = filter.minPrice ?? 0
  if (minPrice > 0 && product.priceNumber < minPrice) return false

  const maxPrice = filter.maxPrice ?? 0
  if (maxPrice > 0 && product.priceNumber > maxPrice) return false

  if (filter.onlyFreeShip && product.freeShip !== '是') return false

  return true
}
