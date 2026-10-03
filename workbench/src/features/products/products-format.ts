/**
 * 商品库的展示与导出辅助（纯函数，可在 Node 下测试）。
 *
 * 约束：只处理调用方传入的、已经查询到的商品，不补数据、不外推；
 * 链接必须是可信域名下的 https 地址，否则不渲染为可点击链接。
 */
import { buildItemUrl, formatFullTime, safeHttpsUrl } from '../chat/chat-format'
import type { Product, ProductOrder, ProductSource } from '../contracts'

/** 来源过滤选项值。 */
export type ProductSourceFilter = ProductSource | 'all'

export const PRODUCT_SOURCE_OPTIONS: readonly { value: ProductSourceFilter; label: string }[] = [
  { value: 'my_published', label: '当前账号发布商品' },
  { value: 'all', label: '全部本地商品记录' },
  { value: 'legacy_unconfirmed', label: '存量未确认商品' },
  { value: 'captured_search', label: '搜索采集竞品' },
]

/** 获取商品来源的标签展示。 */
export function displayProductSourceTag(source?: string): { text: string; tone: 'ok' | 'warn' | 'accent' | 'neutral' } {
  switch (source) {
    case 'my_published':
      return { text: '当前账号发布', tone: 'ok' }
    case 'captured_search':
      return { text: '采集竞品', tone: 'accent' }
    case 'legacy_unconfirmed':
      return { text: '存量未确认', tone: 'warn' }
    default:
      return { text: '存量未确认', tone: 'warn' }
  }
}

/** 可作为「打开商品」链接的可信域名（后台 normalizer 只会生成 goofish.com）。 */
const TRUSTED_HOSTS: readonly string[] = ['goofish.com', '2.taobao.com']

function isTrustedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return TRUSTED_HOSTS.some((trusted) => host === trusted || host.endsWith(`.${trusted}`))
}

/** 仅当 URL 为 https 且域名可信时返回规范化地址，否则返回 null。 */
export function trustedProductUrl(raw: unknown): string | null {
  const safe = safeHttpsUrl(raw)
  if (!safe) return null
  try {
    return isTrustedHost(new URL(safe).hostname) ? safe : null
  } catch {
    return null
  }
}

/**
 * 商品详情链接：优先使用后台给出的 detailUrl（需可信），其次用格式合法的 itemId 拼接；
 * 都不满足时返回 null，界面只显示文本。
 */
export function productLink(product: Pick<Product, 'detailUrl' | 'itemId'>): string | null {
  return trustedProductUrl(product.detailUrl) ?? buildItemUrl(product.itemId)
}

export const PRODUCT_ORDER_OPTIONS: readonly { value: ProductOrder; label: string }[] = [
  { value: 'captureTimeDesc', label: '采集时间：新到旧' },
  { value: 'captureTimeAsc', label: '采集时间：旧到新' },
  { value: 'wantCntDesc', label: '想要人数：高到低' },
]

export const PRODUCT_PAGE_SIZES: readonly number[] = [20, 50, 100]

/** 价格展示：优先后台原文，缺失时才用数值（0 视为未知）。 */
export function displayPrice(product: Pick<Product, 'price' | 'priceNumber'>): string {
  if (product.price && product.price.trim()) return product.price
  return product.priceNumber > 0 ? `¥${product.priceNumber}` : '未知'
}

/** 采集时间展示：优先时间戳格式化，其次后台给出的本地化文本。 */
export function displayCaptureTime(product: Pick<Product, 'captureTimeMs' | 'captureTime'>): string {
  return formatFullTime(product.captureTimeMs) || product.captureTime || ''
}

/** 分页信息推导；页码从 0 开始。 */
export function pageInfo(total: number, pageSize: number, page: number): {
  totalPages: number
  page: number
  from: number
  to: number
} {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))
  const safePage = Math.min(Math.max(0, page), totalPages - 1)
  const from = total === 0 ? 0 : safePage * pageSize + 1
  const to = Math.min(total, (safePage + 1) * pageSize)
  return { totalPages, page: safePage, from, to }
}

// ---------------- CSV ----------------

/** CSV 列定义：只含 Product 的真实字段。 */
const CSV_COLUMNS: ReadonlyArray<{ header: string; value: (product: Product) => string | number }> = [
  { header: '商品ID', value: (p) => p.itemId },
  { header: '标题', value: (p) => p.title },
  { header: '价格', value: (p) => p.price },
  { header: '价格数值', value: (p) => p.priceNumber },
  { header: '想要人数', value: (p) => p.wantCnt },
  { header: '卖家', value: (p) => p.sellerNick },
  { header: '地区', value: (p) => p.sellerCity },
  { header: '是否包邮', value: (p) => p.freeShip },
  { header: '采集时间', value: (p) => displayCaptureTime(p) },
  { header: '详情链接', value: (p) => productLink(p) ?? '' },
]

/**
 * 转义单元格。字符串开头为 `= + - @` 或控制字符时前置单引号，防止 Excel 把内容当公式执行（CSV 注入）。
 * 数值单元格不加前缀，保证负数 / 小数仍是数字。
 */
export function escapeCsvCell(value: string | number): string {
  let text: string
  if (typeof value === 'number') {
    text = Number.isFinite(value) ? String(value) : ''
  } else {
    text = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value
  }
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** 生成 CSV 文本（带 UTF-8 BOM，便于 Excel 正确识别中文）。只导出传入的商品。 */
export function buildProductsCsv(products: readonly Product[]): string {
  const lines = [CSV_COLUMNS.map((column) => escapeCsvCell(column.header)).join(',')]
  for (const product of products) {
    lines.push(CSV_COLUMNS.map((column) => escapeCsvCell(column.value(product))).join(','))
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

/** 导出文件名：带本地时间戳，避免覆盖。 */
export function csvFileName(now: number): string {
  const d = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `fishops-products-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.csv`
}
