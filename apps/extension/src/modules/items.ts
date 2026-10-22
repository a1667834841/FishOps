/**
 * 商品 MTOP 响应归一化。
 *
 * 本模块只做纯数据转换：不读取页面、不访问网络，也不依赖 legacy 运行时。
 * 输出对象中的未知字段使用 null，避免把 0、空串或当前时间伪装成平台事实。
 */

/** 商品在售状态；无法从平台明确字段确认时为 unknown。 */
export type ItemStatus = 'on_sale' | 'sold' | 'unknown'

/** `search.items` 使用的商品摘要。 */
export interface ItemSummary {
  itemId: string
  title: string | null
  price: string | null
  image: string | null
  sellerId: string | null
  sellerNick: string | null
  city: string | null
  wantCnt: number | null
  publishedAt: number | null
  url: string | null
}

/** `item.detail` 返回的完整商品信息。 */
export interface ItemDetail extends ItemSummary {
  description: string | null
  images: string[] | null
  status: ItemStatus
  browseCnt: number | null
  collectCnt: number | null
}

/** `search.items` 的归一化结果；hasMore 未知时为 null。 */
export interface ItemSearchResult {
  items: ItemSummary[]
  hasMore: boolean | null
}

/** 响应结构或 MTOP 业务状态不可用于归一化时抛出。 */
export class ItemNormalizationError extends Error {
  readonly code = 'INVALID_RESPONSE'

  constructor(message: string) {
    super(message)
    this.name = 'ItemNormalizationError'
  }
}

type JsonRecord = Record<string, unknown>

const SUGGEST_MAX_WORDS = 20
const SUGGEST_WORD_MAX_LENGTH = 80
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:'])

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = text(value)
    if (normalized !== null) return normalized
  }
  return null
}

/**
 * 将平台 ID 转成字符串。
 *
 * 字符串 ID 可直接保留；数字 ID 只在安全整数范围内转换，避免大整数因 JS
 * 精度损失后生成一个看似有效但实际错误的 ID。
 */
function idString(value: unknown): string | null {
  if (typeof value === 'string') return text(value)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value)
  }
  return null
}

function firstIdString(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = idString(value)
    if (normalized !== null) return normalized
  }
  return null
}

/** 解析平台计数；支持数字和旧版常见文本（如 `1,234人想要`）。 */
function countNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value !== 'string') return null
  const matched = value.replace(/,/g, '').match(/\d+/)
  if (!matched) return null
  const parsed = Number.parseInt(matched[0], 10)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

/** 解析毫秒时间戳；不把缺失值或非法值替换为当前时间。 */
function timestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** 保留平台价格文本，不做字符串到浮点数的转换。 */
function priceText(value: unknown): string | null {
  if (typeof value === 'string') return text(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (!Array.isArray(value)) return null
  const joined = value
    .map((entry) => {
      const part = asRecord(entry)?.['text']
      return typeof part === 'string' ? part : ''
    })
    .join('')
  return text(joined)
}

/**
 * 规范化图片 URL，只允许 http/https。
 * 协议相对地址按 legacy 规则补为 https，其余未知协议返回 null。
 */
function normalizedUrl(value: unknown): string | null {
  const raw = text(value)
  if (raw === null) return null
  const candidate = raw.startsWith('//') ? `https:${raw}` : raw
  try {
    const parsed = new URL(candidate)
    if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol) || !parsed.hostname) return null
    return candidate
  } catch {
    return null
  }
}

function itemUrl(itemId: string): string {
  return `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}`
}

/** MTOP 的 ret 缺失（可选严格要求）或明确失败时，不能继续把残缺 data 当成成功。 */
function assertMtopSuccess(root: JsonRecord, requireRet = false): void {
  if (!Object.hasOwn(root, 'ret')) {
    if (requireRet) throw new ItemNormalizationError('MTOP 响应缺少 ret')
    return
  }
  const ret = root['ret']
  if (!Array.isArray(ret) || typeof ret[0] !== 'string' || !ret[0].startsWith('SUCCESS')) {
    throw new ItemNormalizationError('MTOP 响应未成功，拒绝归一化')
  }
}

function validUniqueUrls(values: readonly unknown[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const url = normalizedUrl(value)
    if (url === null || seen.has(url)) continue
    seen.add(url)
    result.push(url)
  }
  return result
}

/** 从 fishTags 中读取想要人数；没有明确计数时返回 null。 */
function extractWantCount(fishTags: unknown): number | null {
  const root = asRecord(fishTags)
  if (!root) return null
  let result: number | null = null
  for (const region of Object.values(root)) {
    const tags = asRecord(region)?.['tagList']
    if (!Array.isArray(tags)) continue
    for (const tag of tags) {
      const content = asRecord(asRecord(tag)?.['data'])?.['content']
      if (typeof content !== 'string' || !content.endsWith('人想要')) continue
      const parsed = countNumber(content.slice(0, -'人想要'.length))
      if (parsed !== null) result = parsed
    }
  }
  return result
}

function detailStatus(value: unknown): ItemStatus {
  const normalized = text(value)?.toLocaleLowerCase('en-US')
  if (normalized === '在售' || normalized === 'on_sale' || normalized === 'onsale') return 'on_sale'
  if (normalized === '已售' || normalized === 'sold' || normalized === 'sold_out' || normalized === 'soldout') {
    return 'sold'
  }
  return 'unknown'
}

/** 归一化 `search.items` 的 MTOP 原始响应。 */
export function normalizeSearch(payload: unknown): ItemSearchResult {
  const root = asRecord(payload)
  if (!root) throw new ItemNormalizationError('搜索结果不是对象')
  assertMtopSuccess(root)

  const data = asRecord(root['data'])
  if (!data || !Array.isArray(data['resultList'])) {
    // 缺失 resultList 与“平台明确返回空页”不是同一个事实，不能伪装成空成功。
    throw new ItemNormalizationError('搜索结果缺少 data.resultList')
  }

  const items: ItemSummary[] = []
  const seenIds = new Set<string>()
  for (const rawItem of data['resultList']) {
    const item = asRecord(asRecord(asRecord(rawItem)?.['data'])?.['item'])
    const main = asRecord(item?.['main'])
    if (!main) continue

    const exContent = asRecord(main['exContent'])
    const clickParam = asRecord(main['clickParam'])
    // 没有商品主结构或埋点结构的卡片视为广告/非商品卡片。
    if (!exContent && !clickParam) continue

    const args = asRecord(clickParam?.['args'])
    const content: JsonRecord = exContent ?? {}
    const itemId = firstIdString(args?.['item_id'], content['itemId'])
    if (itemId === null) {
      // 已进入商品结构后仍缺 ID，说明响应不完整；不能生成替代 ID，也不能静默丢商品。
      throw new ItemNormalizationError('商品条目缺少 itemId')
    }
    if (seenIds.has(itemId)) continue
    seenIds.add(itemId)

    const image = normalizedUrl(content['picUrl'])
    items.push({
      itemId,
      title: text(content['title']),
      price: priceText(content['price']),
      image,
      // clickParam.args.user_id 是浏览者（当前账号），不是卖家。这里只读取明确卖家字段。
      sellerId: firstIdString(content['sellerId'], content['userId'], args?.['seller_id']),
      sellerNick: text(content['userNickName']),
      city: text(content['area']),
      wantCnt: extractWantCount(content['fishTags']),
      publishedAt: timestamp(args?.['publishTime']),
      url: itemUrl(itemId),
    })
  }

  return {
    items,
    // 只透传平台明确的布尔值，不从 items.length 推断是否还有下一页。
    hasMore: typeof data['hasMore'] === 'boolean' ? data['hasMore'] : null,
  }
}

/** 归一化 `item.detail` 的 MTOP 原始响应。 */
export function normalizeDetail(payload: unknown): ItemDetail {
  const root = asRecord(payload)
  if (!root) throw new ItemNormalizationError('详情结果不是对象')
  assertMtopSuccess(root)

  const data = asRecord(root['data'])
  const itemDO = asRecord(data?.['itemDO'])
  if (!itemDO) throw new ItemNormalizationError('详情结果缺少 data.itemDO')

  const itemId = idString(itemDO['itemId'])
  if (itemId === null) throw new ItemNormalizationError('详情商品缺少 itemId')

  const sellerDO = asRecord(data?.['sellerDO']) ?? {}
  const images = Array.isArray(itemDO['imageInfos'])
    ? validUniqueUrls(
        itemDO['imageInfos'].map((entry) => asRecord(entry)?.['url']),
      )
    : null

  return {
    itemId,
    title: text(itemDO['title']),
    price: priceText(itemDO['soldPrice']) ?? priceText(itemDO['price']),
    image: images?.[0] ?? null,
    sellerId: idString(sellerDO['sellerId']),
    sellerNick: text(sellerDO['nick']),
    city: firstText(itemDO['city'], sellerDO['city'], itemDO['prov'], sellerDO['prov']),
    wantCnt: countNumber(itemDO['wantCnt']),
    publishedAt: timestamp(itemDO['gmtCreate']),
    url: itemUrl(itemId),
    description: firstText(itemDO['desc'], itemDO['description']),
    images,
    status: detailStatus(itemDO['status'] ?? itemDO['itemStatus']),
    browseCnt: countNumber(itemDO['browseCnt']),
    collectCnt: countNumber(itemDO['collectCnt']),
  }
}

/**
 * 归一化 suggest 原始响应中的建议词。
 *
 * 按 legacy 规则去空白、大小写不敏感去重、单条截断为 80 字符并最多返回 20 条。
 * 必须收到明确成功的 MTOP ret、对象 data 和数组 items；只有 items 明确为空数组
 * 时才返回空结果，缺字段或类型错误都按响应结构无效处理。
 */
export function normalizeSuggest(payload: unknown, limit = SUGGEST_MAX_WORDS): string[] {
  const root = asRecord(payload)
  if (!root) throw new ItemNormalizationError('suggest 结果不是对象')
  assertMtopSuccess(root, true)

  const data = asRecord(root['data'])
  if (!data) throw new ItemNormalizationError('suggest 结果缺少 data')
  const items = data['items']
  if (!Array.isArray(items)) throw new ItemNormalizationError('suggest 结果缺少 data.items')
  const requested = Number.isSafeInteger(limit) && limit > 0 ? limit : SUGGEST_MAX_WORDS
  const cap = Math.min(requested, SUGGEST_MAX_WORDS)
  const seen = new Set<string>()
  const result: string[] = []

  for (const item of items) {
    const suggestion = text(asRecord(item)?.['suggest'])
    if (suggestion === null) continue
    const word = suggestion.slice(0, SUGGEST_WORD_MAX_LENGTH)
    const key = word.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(word)
    if (result.length >= cap) break
  }
  return result
}
