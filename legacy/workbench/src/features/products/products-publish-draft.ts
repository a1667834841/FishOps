/**
 * 商品库发布草稿转换与本页筛选纯函数（生产代码）。
 * 保持真实 source、recordId、targetTableId、itemId 与图文，不触达发布通道。
 */
import type { PublishDraft } from '../publish/publish-draft-store'
import type { ProductTableItem, ProductTab } from './products-format'

/**
 * 计算商品行唯一稳定 Key：
 * 飞书素材：必须结合 targetTableId + recordId，防止不同数据表使用相同 recordId 发生勾选与状态冲突；
 * 自营发布：按真实 itemId 识别；
 * 无标识条目：返回空字符串。
 */
export function getItemKey(product: ProductTableItem, defaultTargetTableId?: string): string {
  const tableId = product.targetTableId || defaultTargetTableId || ''
  if (product.recordId && product.recordId.trim()) {
    return `rec:${tableId}:${product.recordId.trim()}`
  }
  if (product.itemId && product.itemId.trim()) {
    return `item:${product.itemId.trim()}`
  }
  return ''
}

/**
 * 将商品行映射为 PublishDraft：
 * 严格保留真实的 source, recordId, targetTableId, itemId 与完整图文。
 */
export function buildPublishDraft(
  product: ProductTableItem,
  currentTab: ProductTab,
  defaultTargetTableId?: string,
): PublishDraft {
  const isFeishu = currentTab === 'feishu' || product.source === 'feishu_material'
  return {
    source: isFeishu ? 'feishu' : 'my_published',
    recordId: (product as any).recordId || undefined,
    targetTableId: product.targetTableId || defaultTargetTableId || undefined,
    itemId: product.itemId || undefined,
    title: product.title || '',
    desc: (product as any).desc || (product as any).description || '',
    price: product.priceNumber || 0,
    originalPrice: product.originalPriceNumber || 0,
    coverUrl: product.coverUrl || '',
    imageUrls: product.coverUrl ? [product.coverUrl] : [],
  }
}


export type PageShipFilter = 'all' | 'free' | 'paid'

/**
 * 本页包邮筛选（仅作用于当前页商品列表，不修改全库分页与 total）
 */
export function filterPageProducts(
  items: ProductTableItem[],
  filter: PageShipFilter,
): ProductTableItem[] {
  if (filter === 'free') {
    return items.filter((p) => p.freeShip === '是')
  }
  if (filter === 'paid') {
    return items.filter((p) => p.freeShip === '否')
  }
  return items
}
