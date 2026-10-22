/**
 * 飞书记录 ↔ 商品素材映射（P7 商品库 / 发布闭环共用，单一来源）。
 *
 * 安全与边界（硬性）：
 * - 缺字段时**明确回退并报告**（title 回退别名字段、cover 回退首张图片），
 *   但**绝不伪造 ID**：飞书没有「商品ID」时 `itemId` 明确为空字符串，绝不用 recordId 冒充；
 * - URL 只接受 http(s)，非法 / 空值一律回落为空串，绝不臆造；
 * - 只做字段映射，**绝不**写入本地商品库，避免污染目录或伪标 my_published。
 */
import type { DatasetRow } from '../types/dataset'
import { DATASET_MAX_TEXT_LENGTH } from '../types/dataset'
import type { Product } from '../types/product'
import type { CatalogProduct } from '../types/product-catalog'
import type { FeishuProductMaterial } from '../types/feishu-products'

/** 飞书商品标准字段名（与 FEISHU_PRODUCT_FIELD_CONFIGS 对齐）。 */
export const FEISHU_PRODUCT_FIELD_NAMES = {
  itemId: '商品ID',
  title: '商品标题',
  price: '价格',
  originalPrice: '原价',
  wantCnt: '想要人数',
  coverUrl: '封面URL',
  detailUrl: '商品详情URL',
  images: '商品图片',
  desc: '商品描述',
  sellerNick: '卖家昵称',
  sellerCity: '地区',
  freeShip: '包邮',
  tags: '商品标签',
  publishTime: '发布时间',
  captureTime: '采集时间',
  captureKeyword: '采集关键字',
} as const

/** 兼容提取飞书文本字段：字符串 / 数值 / 布尔 / 段落对象数组。 */
export function extractFeishuText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) {
    return value
      .map((item) => extractFeishuText(item))
      .filter(Boolean)
      .join(' ')
      .trim()
  }
  if (typeof value === 'object') {
    const rec = value as Record<string, unknown>
    if (typeof rec['text'] === 'string') return rec['text'].trim()
    if (typeof rec['name'] === 'string') return rec['name'].trim()
    if (typeof rec['value'] === 'string') return rec['value'].trim()
    if (typeof rec['link'] === 'string') return rec['link'].trim()
  }
  return ''
}

/** 兼容提取飞书数字字段：数值 / 带货币符号千分位字符串 / 包装对象。 */
export function extractFeishuNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const matched = value.replace(/,/g, '').match(/-?\d+(\.\d+)?/)
    if (matched) {
      const parsed = Number.parseFloat(matched[0])
      return Number.isFinite(parsed) ? parsed : 0
    }
    return 0
  }
  if (Array.isArray(value) && value.length > 0) return extractFeishuNumber(value[0])
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>
    if ('text' in rec) return extractFeishuNumber(rec['text'])
    if ('value' in rec) return extractFeishuNumber(rec['value'])
  }
  return 0
}

/** 兼容提取飞书 URL 字段：只接受 http(s)，否则回退空串。 */
export function extractFeishuUrl(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return /^https?:\/\//i.test(trimmed) ? trimmed : ''
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = extractFeishuUrl(item)
      if (url) return url
    }
    return ''
  }
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>
    for (const key of ['link', 'url', 'tmp_url']) {
      const candidate = rec[key]
      if (typeof candidate === 'string' && /^https?:\/\//i.test(candidate)) return candidate.trim()
    }
  }
  return ''
}

/** 兼容提取飞书多图 / 附件数组：逐个提取 URL 并去重。 */
export function extractFeishuUrls(value: unknown): string[] {
  const urls: string[] = []
  const push = (candidate: unknown): void => {
    const url = extractFeishuUrl(candidate)
    if (url && !urls.includes(url)) urls.push(url)
  }
  if (Array.isArray(value)) {
    for (const item of value) push(item)
  } else {
    push(value)
  }
  return urls
}

/**
 * 兼容提取飞书时间字段为毫秒时间戳：兼容毫秒 / 秒时间戳与 ISO 字符串。
 * 解析失败返回 0（绝不臆造时间）。
 */
export function extractFeishuTimeMs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 秒级时间戳（< 1e11）补齐为毫秒，避免把 1.7e9 当毫秒渲染成 1970 年。
    return Math.round(value < 1e11 ? value * 1000 : value)
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  if (Array.isArray(value) && value.length > 0) return extractFeishuTimeMs(value[0])
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>
    if ('timestamp' in rec) return extractFeishuTimeMs(rec['timestamp'])
    if ('value' in rec) return extractFeishuTimeMs(rec['value'])
  }
  return 0
}

/**
 * 规整飞书「包邮」字段为 `'是'` / `'否'` / 空串（与 `Product.freeShip` 口径一致）。
 * 兼容布尔、`包邮` / `不包邮` 等文本表达；无法识别时原样返回（不臆造）。
 */
export function normalizeFreeShip(value: unknown): string {
  if (typeof value === 'boolean') return value ? '是' : '否'
  const text = extractFeishuText(value)
  if (text === '是' || text === '包邮' || text === 'true') return '是'
  if (text === '否' || text === '不包邮' || text === 'false') return '否'
  return text
}

/** 映射结果：素材 + 缺失字段报告 + 回退说明。 */
export interface FeishuMaterialMappingResult {
  material: FeishuProductMaterial
  missingFields: string[]
  warnings: string[]
}

/**
 * 把飞书平铺字段映射为发布素材，缺字段时明确回退并报告（绝不伪造 ID）。
 */
export function mapFeishuFieldsToMaterial(fields: Record<string, unknown>): FeishuMaterialMappingResult {
  const pick = (...keys: string[]): { value: unknown; key: string } | undefined => {
    for (const key of keys) {
      const value = fields[key]
      if (value !== undefined && value !== null && value !== '') return { value, key }
    }
    return undefined
  }

  const missingFields: string[] = []
  const warnings: string[] = []

  // 商品ID：缺失时明确为空串，绝不用 recordId 冒充。
  const itemIdPick = pick(FEISHU_PRODUCT_FIELD_NAMES.itemId, 'itemId', '商品编号')
  const itemId = extractFeishuText(itemIdPick?.value)
  if (!itemId) {
    missingFields.push(FEISHU_PRODUCT_FIELD_NAMES.itemId)
    warnings.push('飞书记录缺少「商品ID」，已明确置空（不使用 recordId 冒充），请人工确认后再发布')
  } else if (itemIdPick && itemIdPick.key !== FEISHU_PRODUCT_FIELD_NAMES.itemId) {
    warnings.push(`「商品ID」缺失，已回退使用「${itemIdPick.key}」字段`)
  }

  // 标题：标准字段缺失时回退别名字段并报告。
  const titlePick = pick(FEISHU_PRODUCT_FIELD_NAMES.title, 'title', '标题', '商品名称')
  const title = extractFeishuText(titlePick?.value)
  if (!title) {
    missingFields.push(FEISHU_PRODUCT_FIELD_NAMES.title)
    warnings.push('飞书记录缺少「商品标题」，标题已回退为空串，请人工补齐后再发布')
  } else if (titlePick && titlePick.key !== FEISHU_PRODUCT_FIELD_NAMES.title) {
    warnings.push(`「商品标题」缺失，已回退使用「${titlePick.key}」字段`)
  }

  // 封面：缺失时回退首张图片并报告。
  const coverPick = pick(FEISHU_PRODUCT_FIELD_NAMES.coverUrl, 'coverUrl', '封面', '主图', '图片')
  let coverUrl = extractFeishuUrl(coverPick?.value)

  const imagesField = pick(FEISHU_PRODUCT_FIELD_NAMES.images, 'images', '图片列表')
  const images: string[] = []
  if (imagesField) {
    for (const url of extractFeishuUrls(imagesField.value)) {
      if (url && !images.includes(url)) images.push(url)
    }
  }
  if (coverUrl && !images.includes(coverUrl)) images.unshift(coverUrl)

  if (!coverUrl) {
    if (images.length > 0) {
      coverUrl = images[0]!
      warnings.push('「封面URL」缺失，封面已回退使用首张商品图片')
    } else {
      missingFields.push(FEISHU_PRODUCT_FIELD_NAMES.coverUrl)
      warnings.push('飞书记录缺少任何可用图片，封面为空，发布时将因图片不足被拒绝')
    }
  }

  // 描述只接受记录中的真实详情，不用标题伪造商品描述。
  const descPick = pick(FEISHU_PRODUCT_FIELD_NAMES.desc, 'desc', '描述', '详情', '商品详情')
  const rawDesc = extractFeishuText(descPick?.value)
  if (!rawDesc) {
    missingFields.push(FEISHU_PRODUCT_FIELD_NAMES.desc)
    warnings.push('飞书记录缺少「商品描述」，发布草稿描述为空；请补充详情后再发布')
  }

  const price = extractFeishuNumber(pick(FEISHU_PRODUCT_FIELD_NAMES.price, 'price', '售价')?.value)
  const originalPrice = extractFeishuNumber(
    pick(FEISHU_PRODUCT_FIELD_NAMES.originalPrice, 'originalPrice')?.value,
  )
  const wantCnt = extractFeishuNumber(
    pick(FEISHU_PRODUCT_FIELD_NAMES.wantCnt, 'wantCnt', '想要')?.value,
  )
  const detailUrl = extractFeishuUrl(
    pick(FEISHU_PRODUCT_FIELD_NAMES.detailUrl, 'detailUrl', '详情链接', '商品链接')?.value,
  )

  return {
    material: { itemId, title, desc: rawDesc, price, originalPrice, wantCnt, coverUrl, detailUrl, images },
    missingFields,
    warnings,
  }
}

/**
 * 把飞书素材映射为 {@link Product}（**仅用于发布计算，绝不写回商品库**）。
 *
 * 不设置 `source`，也不注入 recordId（记录 identity 由发布任务 payload / meta 承载）；
 * 调用方不得将其持久化到本地目录，避免伪标 my_published 或污染目录。
 */
export function materialToProduct(material: FeishuProductMaterial): Product {
  return {
    itemId: material.itemId,
    title: material.title,
    price: material.price > 0 ? `¥${material.price}` : '',
    priceNumber: material.price,
    originalPrice: material.originalPrice > 0 ? `¥${material.originalPrice}` : '',
    originalPriceNumber: material.originalPrice,
    wantCnt: material.wantCnt,
    publishTime: '',
    publishTimeMs: 0,
    captureTime: '',
    captureTimeMs: 0,
    sellerNick: '',
    sellerCity: '',
    freeShip: '',
    tags: '',
    coverUrl: material.coverUrl,
    detailUrl: material.detailUrl,
    desc: material.desc,
    images: material.images.length > 0 ? [...material.images] : material.coverUrl ? [material.coverUrl] : [],
  }
}

/**
 * 把飞书原始记录平铺为 {@link DatasetRow}：`recordId` 与业务字段同层，
 * 与 DATA_SOURCE_QUERY 产出的行结构保持一致（超长文本按安全上限截断）。
 */
export function flattenFeishuRecord(
  recordId: string,
  fields: Record<string, unknown>,
): DatasetRow {
  const row: DatasetRow = { recordId }
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' && value.length > DATASET_MAX_TEXT_LENGTH) {
      row[key] = value.slice(0, DATASET_MAX_TEXT_LENGTH)
    } else {
      row[key] = value
    }
  }
  return row
}

/**
 * 把飞书平铺记录行映射为「商品目录」统一模型 {@link CatalogProduct}。
 *
 * 与 {@link mapFeishuFieldsToMaterial} 的差异：本函数面向**目录展示**而非发布素材，
 * 因此不报告 missingFields / warnings，而把缺失描述统一为空字符串（供 UI 显示「暂无描述」）；
 * 「商品ID」缺失时 `itemId` 明确为空串，**绝不用 recordId 冒充**；`recordId` 单独保留为行 identity。
 */
export function mapFeishuRowToCatalogProduct(row: DatasetRow): CatalogProduct {
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      const value = row[key]
      if (value !== undefined && value !== null && value !== '') return value
    }
    return undefined
  }

  const recordId = typeof row['recordId'] === 'string' ? row['recordId'].trim() : ''
  const itemId = extractFeishuText(pick(FEISHU_PRODUCT_FIELD_NAMES.itemId, 'itemId', '商品编号'))
  const title = extractFeishuText(pick(FEISHU_PRODUCT_FIELD_NAMES.title, 'title', '标题', '商品名称'))

  const price = extractFeishuNumber(pick(FEISHU_PRODUCT_FIELD_NAMES.price, 'price', '售价'))
  const originalPrice = extractFeishuNumber(
    pick(FEISHU_PRODUCT_FIELD_NAMES.originalPrice, 'originalPrice'),
  )
  const wantCnt = extractFeishuNumber(pick(FEISHU_PRODUCT_FIELD_NAMES.wantCnt, 'wantCnt', '想要'))

  const coverUrl = extractFeishuUrl(
    pick(FEISHU_PRODUCT_FIELD_NAMES.coverUrl, 'coverUrl', '封面', '主图', '图片'),
  )
  const detailUrl = extractFeishuUrl(
    pick(FEISHU_PRODUCT_FIELD_NAMES.detailUrl, 'detailUrl', '详情链接', '商品链接'),
  )

  const images: string[] = []
  const imagesField = pick(FEISHU_PRODUCT_FIELD_NAMES.images, 'images', '图片列表')
  for (const url of extractFeishuUrls(imagesField)) {
    if (!images.includes(url)) images.push(url)
  }
  if (coverUrl && !images.includes(coverUrl)) images.unshift(coverUrl)

  // 卖家 / 地区 / 包邮 / 标签 / 采集时间：飞书表标准字段真实存在，缺失时保留为空（绝不臆造）。
  const sellerNick = extractFeishuText(pick(FEISHU_PRODUCT_FIELD_NAMES.sellerNick, 'sellerNick', '卖家'))
  const sellerCity = extractFeishuText(
    pick(FEISHU_PRODUCT_FIELD_NAMES.sellerCity, 'sellerCity', '城市', '所在地'),
  )
  const freeShip = normalizeFreeShip(
    pick(FEISHU_PRODUCT_FIELD_NAMES.freeShip, 'freeShip', '是否包邮'),
  )
  const tags = extractFeishuText(pick(FEISHU_PRODUCT_FIELD_NAMES.tags, 'tags', '标签'))
  const captureTimeMs = extractFeishuTimeMs(
    pick(FEISHU_PRODUCT_FIELD_NAMES.captureTime, 'captureTimeMs', 'captureTime'),
  )

  return {
    source: 'feishu',
    itemId,
    ...(recordId ? { recordId } : {}),
    ...(typeof row['targetTableId'] === 'string' ? { targetTableId: row['targetTableId'] } : {}),
    ...(row[FEISHU_PRODUCT_FIELD_NAMES.captureKeyword] === undefined ? {} : { captureKeyword: extractFeishuText(pick(FEISHU_PRODUCT_FIELD_NAMES.captureKeyword)) }),
    title,
    price: price > 0 ? `¥${price}` : '',
    priceNumber: price,
    originalPrice: originalPrice > 0 ? `¥${originalPrice}` : '',
    originalPriceNumber: originalPrice,
    wantCnt,
    coverUrl,
    detailUrl,
    // 描述缺失统一为空字符串（UI 显示「暂无描述」）。
    desc: extractFeishuText(pick(FEISHU_PRODUCT_FIELD_NAMES.desc, 'desc', '描述', '详情', '商品详情')),
    images,
    ...(sellerNick ? { sellerNick } : {}),
    ...(sellerCity ? { sellerCity } : {}),
    ...(freeShip ? { freeShip } : {}),
    ...(tags ? { tags } : {}),
    ...(captureTimeMs > 0 ? { captureTimeMs } : {}),
  }
}
