/**
 * 商品库的展示与导出辅助（纯函数，可在 Node 下测试）。
 *
 * 约束：只处理调用方传入的、已经查询到的商品，不补数据、不外推；
 * 链接必须是可信域名下的 https 地址，否则不渲染为可点击链接。
 */
import { buildItemUrl, formatFullTime, safeHttpsUrl } from '../chat/chat-format'
import type { CatalogProduct, DatasetRow, Product, ProductOrder, ProductSource } from '../contracts'

/** 选项卡类型：飞书采集的商品库（默认）与自己发布的商品库。 */
export type ProductTab = 'feishu' | 'my_published'

export interface ProductTabOption {
  id: ProductTab
  label: string
  description: string
}

export const PRODUCT_TABS: readonly ProductTabOption[] = [
  { id: 'feishu', label: '飞书采集的商品库', description: '展示北京时间今天和昨天的全部采集记录' },
  { id: 'my_published', label: '自己发布的商品库', description: '当前闲鱼账号已发布的商品目录' },
]

/** 工作台展示层商品来源：不修改 shared 领域定义，隔离扩展。 */
export type ProductDisplaySource = ProductSource | 'feishu_material'

/** 飞书商品库条目展示模型：独立保留 recordId 作为唯一 row identity，绝不冒充 my_published。 */
export interface FeishuProductItem extends Omit<Product, 'source'> {
  recordId: string
  targetTableId?: string
  source: 'feishu_material'
}

/** 工作台商品库统一展示行类型（保证两个分支均有可选的 recordId）。 */
export type ProductTableItem = (Product & { recordId?: string; targetTableId?: string }) | FeishuProductItem

/** 来源过滤选项值（兼容旧定义）。 */
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
    case 'feishu_material':
      return { text: '飞书采集表', tone: 'accent' }
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
  { header: '关键字', value: (p) => p.captureKeyword ?? '' },
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
export function buildProductsCsv(products: readonly ProductTableItem[]): string {
  const lines = [CSV_COLUMNS.map((column) => escapeCsvCell(column.header)).join(',')]
  for (const product of products) {
    lines.push(CSV_COLUMNS.map((column) => escapeCsvCell(column.value(product as Product))).join(','))
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

/** 导出文件名：带本地时间戳，避免覆盖。 */
export function csvFileName(now: number): string {
  const d = new Date(now)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `fishops-products-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.csv`
}

// ---------------- 飞书 DatasetRow 解析与模型转换 ----------------

/**
 * 健壮提取飞书文本字段：兼容字符串、多文本段落对象数组与纯数值/布尔。
 */
export function extractFeishuText(val: unknown): string {
  if (val === undefined || val === null) return ''
  if (typeof val === 'string') return val.trim()
  if (typeof val === 'number') return String(val)
  if (typeof val === 'boolean') return val ? '是' : '否'
  if (Array.isArray(val)) {
    return val
      .map((item) => extractFeishuText(item))
      .filter(Boolean)
      .join(' ')
  }
  if (typeof val === 'object') {
    const rec = val as Record<string, unknown>
    if (typeof rec['text'] === 'string') return rec['text'].trim()
    if (typeof rec['name'] === 'string') return rec['name'].trim()
    if (typeof rec['link'] === 'string') return rec['link'].trim()
  }
  return ''
}

/**
 * 健壮提取飞书数字字段：兼容数值、带货币符号千分位字符串与包装对象。
 */
export function extractFeishuNumber(val: unknown): number {
  if (typeof val === 'number') return Number.isFinite(val) ? val : 0
  if (typeof val === 'string') {
    const cleaned = val.replace(/,/g, '').match(/-?\d+(\.\d+)?/)
    if (cleaned) {
      const n = parseFloat(cleaned[0])
      return Number.isFinite(n) ? n : 0
    }
    return 0
  }
  if (Array.isArray(val) && val.length > 0) {
    return extractFeishuNumber(val[0])
  }
  if (typeof val === 'object' && val !== null) {
    const rec = val as Record<string, unknown>
    if ('text' in rec) return extractFeishuNumber(rec['text'])
    if ('value' in rec) return extractFeishuNumber(rec['value'])
  }
  return 0
}

/**
 * 健壮提取飞书 URL/图片字段：兼容字符串、飞书超链接对象与附件数组。
 */
export function extractFeishuUrl(val: unknown): string {
  if (typeof val === 'string') {
    const trimmed = val.trim()
    if (/^https?:\/\//i.test(trimmed)) return trimmed
    return ''
  }
  if (Array.isArray(val)) {
    for (const item of val) {
      const url = extractFeishuUrl(item)
      if (url) return url
    }
    return ''
  }
  if (typeof val === 'object' && val !== null) {
    const rec = val as Record<string, unknown>
    if (typeof rec['link'] === 'string' && /^https?:\/\//i.test(rec['link'])) return rec['link'].trim()
    if (typeof rec['url'] === 'string' && /^https?:\/\//i.test(rec['url'])) return rec['url'].trim()
    if (typeof rec['tmp_url'] === 'string' && /^https?:\/\//i.test(rec['tmp_url'])) return rec['tmp_url'].trim()
  }
  return ''
}

/**
 * 健壮提取飞书时间字段：兼容毫秒时间戳、秒时间戳与 ISO 时间字符串。
 */
export function extractFeishuTime(val: unknown): { text: string; ms: number } {
  if (typeof val === 'number' && val > 0) {
    const ms = val < 1e11 ? val * 1000 : val
    return { text: formatFullTime(ms), ms }
  }
  if (typeof val === 'string' && val.trim()) {
    const parsed = Date.parse(val)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return { text: formatFullTime(parsed), ms: parsed }
    }
    return { text: val.trim(), ms: 0 }
  }
  if (typeof val === 'object' && val !== null) {
    const rec = val as Record<string, unknown>
    if ('timestamp' in rec) return extractFeishuTime(rec['timestamp'])
    if ('text' in rec) return extractFeishuTime(rec['text'])
  }
  return { text: '', ms: 0 }
}

/**
 * 将飞书 DatasetRow 转换为工作台统一的商品展示模型。
 *
 * 核心边界约束：
 * 1. 保留 recordId 作为飞书条目的唯一选择与行稳定 identity；
 * 2. 禁止使用 Math.random 生成伪造随机 ID；
 * 3. 当飞书记录无真实「商品ID」时，itemId 明确为空字符串 `''`，绝不得把 recordId 赋给 itemId
 *    避免触发 buildItemUrl(itemId) 产生错误的 goofish 商品链接；
 * 4. 来源固定为 'feishu_material'，绝不冒充 'my_published'；
 * 5. 健壮解析飞书文本/数字/链接/图片/日期。
 */
export function parseFeishuDatasetRowToProduct(row: DatasetRow): FeishuProductItem {
  const recordId = typeof row['recordId'] === 'string' ? row['recordId'].trim() : ''

  const get = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k]
    }
    return undefined
  }

  // 严格提取真实闲鱼商品 ID，缺失时明确为空字符串，绝对不使用 Math.random 也不用 recordId 充当 itemId
  const rawItemId = extractFeishuText(get('商品ID', 'itemId', 'id', '商品编号'))
  const itemId = rawItemId

  const title = extractFeishuText(get('商品标题', 'title', '标题', '商品名称'))

  const priceNum = extractFeishuNumber(get('价格', 'priceNumber', '售价'))
  const priceText = extractFeishuText(get('价格原文', 'price', '价格'))
  const price = priceText || (priceNum > 0 ? `¥${priceNum}` : '')

  const origPriceNum = extractFeishuNumber(get('原价', 'originalPriceNumber'))
  const origPriceText = extractFeishuText(get('原价原文', 'originalPrice', '原价'))
  const originalPrice = origPriceText || (origPriceNum > 0 ? `¥${origPriceNum}` : '')

  const wantCnt = extractFeishuNumber(get('想要人数', 'wantCnt', '想要', '想买人数'))

  const pubTime = extractFeishuTime(get('发布时间', 'publishTimeMs', 'publishTime'))
  const capTime = extractFeishuTime(get('采集时间', 'captureTimeMs', 'captureTime'))

  const sellerNick = extractFeishuText(get('卖家昵称', 'sellerNick', '卖家'))
  const sellerCity = extractFeishuText(get('地区', 'sellerCity', '城市', '所在地'))

  const freeShipVal = get('包邮', 'freeShip', '是否包邮')
  let freeShip = ''
  if (typeof freeShipVal === 'boolean') {
    freeShip = freeShipVal ? '是' : '否'
  } else {
    const txt = extractFeishuText(freeShipVal)
    if (txt === '是' || txt === '包邮' || txt === 'true') freeShip = '是'
    else if (txt === '否' || txt === '不包邮' || txt === 'false') freeShip = '否'
    else freeShip = txt
  }

  const tags = extractFeishuText(get('商品标签', 'tags', '标签'))

  const coverUrl = extractFeishuUrl(get('封面URL', 'coverUrl', '封面', '图片', '主图'))
  const detailUrl = extractFeishuUrl(get('商品详情URL', 'detailUrl', '商品链接', '链接', '详情链接'))

  return {
    itemId,
    recordId,
    title,
    price,
    priceNumber: priceNum,
    originalPrice,
    originalPriceNumber: origPriceNum,
    wantCnt,
    publishTime: pubTime.text,
    publishTimeMs: pubTime.ms,
    captureTime: capTime.text,
    captureTimeMs: capTime.ms,
    sellerNick,
    sellerCity,
    freeShip,
    tags,
    coverUrl,
    detailUrl,
    source: 'feishu_material',
  }
}

/**
 * 将 CatalogProduct 统一映射到现有 ProductTableItem。
 *
 * 核心边界约束：
 * 1. 保留 recordId（飞书来源必有，my_published 存在则保留）；
 * 2. 保留 desc（缺失为空字符串）与 images（图片列表）；
 * 3. 飞书来源映射为 'feishu_material'（与现有点阵展示模型与来源标签完全对齐）；
 * 4. 补齐 Product 默认值（captureTime, price, publishTime 等）。
 */
export function mapCatalogProductToTableItem(p: CatalogProduct): ProductTableItem {
  const isFeishu = p.source === 'feishu'
  const captureTimeMs = p.captureTimeMs ?? 0
  const captureTime = captureTimeMs > 0 ? formatFullTime(captureTimeMs) : ''

  if (isFeishu) {
    const item: FeishuProductItem = {
      recordId: p.recordId ?? '',
      targetTableId: p.targetTableId,
      captureKeyword: p.captureKeyword ?? '',
      itemId: p.itemId ?? '',
      title: p.title ?? '',
      price: p.price || (p.priceNumber > 0 ? `¥${p.priceNumber}` : ''),
      priceNumber: p.priceNumber ?? 0,
      originalPrice: p.originalPrice || (p.originalPriceNumber > 0 ? `¥${p.originalPriceNumber}` : ''),
      originalPriceNumber: p.originalPriceNumber ?? 0,
      wantCnt: p.wantCnt ?? 0,
      publishTime: '',
      publishTimeMs: 0,
      captureTime,
      captureTimeMs,
      sellerNick: p.sellerNick ?? '',
      sellerCity: p.sellerCity ?? '',
      freeShip: p.freeShip ?? '',
      tags: p.tags ?? '',
      coverUrl: p.coverUrl ?? '',
      detailUrl: p.detailUrl ?? '',
      source: 'feishu_material',
      desc: p.desc ?? '',
      images: p.images ?? [],
    }
    return item
  }

  const item: ProductTableItem = {
    itemId: p.itemId ?? '',
    recordId: p.recordId,
    title: p.title ?? '',
    price: p.price || (p.priceNumber > 0 ? `¥${p.priceNumber}` : ''),
    priceNumber: p.priceNumber ?? 0,
    originalPrice: p.originalPrice || (p.originalPriceNumber > 0 ? `¥${p.originalPriceNumber}` : ''),
    originalPriceNumber: p.originalPriceNumber ?? 0,
    wantCnt: p.wantCnt ?? 0,
    publishTime: '',
    publishTimeMs: 0,
    captureTime,
    captureTimeMs,
    sellerNick: p.sellerNick ?? '',
    sellerCity: p.sellerCity ?? '',
    freeShip: p.freeShip ?? '',
    tags: p.tags ?? '',
    coverUrl: p.coverUrl ?? '',
    detailUrl: p.detailUrl ?? '',
    source: 'my_published',
    desc: p.desc ?? '',
    images: p.images ?? [],
  }
  return item
}
