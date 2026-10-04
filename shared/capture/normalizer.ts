/**
 * 采集数据归一化（P4）。
 *
 * 对照旧 `FishOps`（main 分支）`background.js` 的 `processListData` / `normalizeUrl`
 * 与 `item-download.js` 的详情字段路径，把平台层返回的 MTOP 原始 JSON 转成标准 {@link Product}。
 *
 * 原则：
 * - 只读取响应中真实存在的字段，缺失时保留旧实现的空值（`''` / `0`）或省略可选字段；
 * - 缺少 `itemId` 的条目直接丢弃（不臆造 ID）；
 * - 不打印、不保存原始响应（可能很大且含用户数据）。
 */
import type { Product, ProductSnapshot } from '../types/product'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 取首个非空字符串。 */
function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * 取首个非空 ID 字符串：兼容平台偶发把 ID 返回为数字（如 `userId` / `sellerId`）。
 * 数字 ID 统一转为 `String`，避免因类型不符丢失卖家身份、进而误判归属。
 */
function firstIdString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/** 取有限数字（非数字返回 undefined，注意不把 0 当缺失）。 */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 取想要人数等计数：兼容数值与平台偶发的字符串（如 `12` / `12人想要`，含千分位），
 * 解析失败返回 undefined（缺失不写入，不臆造 0）。
 */
function asCountNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const matched = value.replace(/,/g, '').match(/\d+/)
    if (matched) return Number.parseInt(matched[0]!, 10)
  }
  return undefined
}

/** URL 规范化：处理 `//` 开头的协议相对地址（与旧 `normalizeUrl` 一致）。 */
export function normalizeUrl(url: unknown): string {
  if (typeof url !== 'string') return ''
  const trimmed = url.trim()
  if (trimmed.startsWith('//')) return 'https:' + trimmed
  return trimmed
}

/** 规范化并去重 URL 列表：去除空白项，保留首次出现顺序（去重保序）。 */
function uniqueNormalizedUrls(urls: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const url of urls) {
    if (url.length === 0 || seen.has(url)) continue
    seen.add(url)
    result.push(url)
  }
  return result
}

/**
 * 合并图片集合：已有在前（保序），追加新 URL，规范化后去重保序。
 * 用于详情采集时**不覆盖**已有图片集合，避免详情重采把封面 / 历史图片冲掉。
 */
export function mergeProductImages(
  existing: readonly string[] | undefined,
  incoming: readonly string[] | undefined,
): string[] {
  return uniqueNormalizedUrls(
    [...(existing ?? []), ...(incoming ?? [])].map((url) => normalizeUrl(url)),
  )
}

/** 从价格数组（`[{ text }]`）拼出价格原文。 */
function joinPriceText(exContent: Record<string, unknown>): string {
  return asArray(exContent['price'])
    .map((entry) => {
      const text = asRecord(entry)?.['text']
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

/** 价格字符串 → 数值（保留数字与小数点）。 */
function parsePriceNumber(priceStr: string): number {
  return parseFloat(priceStr.replace(/[^\d.]/g, '')) || 0
}

/** 从 `fishTags` 提取想要人数与标签内容（与旧实现口径一致）。 */
function extractFishTags(fishTags: Record<string, unknown>): { wantCnt: number; tags: string } {
  let wantCnt = 0
  const tagContents: string[] = []
  for (const region of Object.values(fishTags)) {
    for (const tag of asArray(asRecord(region)?.['tagList'])) {
      const content = asRecord(asRecord(tag)?.['data'])?.['content']
      if (typeof content !== 'string' || content.length === 0) continue
      if (content.endsWith('人想要')) {
        wantCnt = parseInt(content.replace('人想要', ''), 10) || 0
      } else if (content.includes('freeShippingIcon')) {
        tagContents.push('包邮')
      } else {
        tagContents.push(content)
      }
    }
  }
  return { wantCnt, tags: [...new Set(tagContents)].join('、') }
}

/** 判断是否包邮（与旧实现的三条判定一致）。 */
function detectFreeShip(
  clickParam: Record<string, unknown>,
  fishTags: Record<string, unknown>,
): boolean {
  const tag = clickParam['tag']
  const tagName = clickParam['tagname']
  const r1Baoyou = asArray(asRecord(asRecord(fishTags['r1'])?.['tagList'])).some(
    (tagItem) => asRecord(asRecord(tagItem)?.['data'])?.['content'] === '包邮',
  )
  return (
    (typeof tag === 'string' && tag.includes('freeship')) ||
    (typeof tagName === 'string' && tagName.includes('包邮')) ||
    r1Baoyou
  )
}

/** 本地化时间字符串（与旧实现的 `toLocaleString('zh-CN')` 一致）。 */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN')
}

/**
 * 归一化单条搜索结果（`data.item.main`）。
 * @returns 归一后的商品；缺少 `itemId` 或结构不符时返回 null。
 */
export function normalizeProductFromSearchItem(item: unknown, capturedAt: number): Product | null {
  const itemRecord = asRecord(item)
  const data = itemRecord ? asRecord(itemRecord['data']) : null
  const itemInner = data ? asRecord(data['item']) : null
  const mainData = itemInner ? asRecord(itemInner['main']) : null
  if (!mainData) return null

  const exContent = asRecord(mainData['exContent']) ?? {}
  const clickParam = asRecord(asRecord(mainData['clickParam'])?.['args']) ?? {}

  const itemId = firstString(clickParam['item_id'], exContent['itemId'])
  if (!itemId) return null

  const fishTags = asRecord(exContent['fishTags']) ?? {}
  const { wantCnt, tags } = extractFishTags(fishTags)
  const isFreeShip = detectFreeShip(clickParam, fishTags)

  const priceStr = joinPriceText(exContent)
  const originalPrice = typeof exContent['oriPrice'] === 'string' ? exContent['oriPrice'] : ''

  const publishRaw = clickParam['publishTime']
  const publishTimeMs =
    typeof publishRaw === 'number'
      ? publishRaw
      : typeof publishRaw === 'string'
        ? parseInt(publishRaw, 10) || 0
        : 0

  const sellerNick = firstString(exContent['userNickName'])
  const sellerCity = firstString(exContent['area'])
  // 卖家 ID 只取明确表达卖家身份的字段。`clickParam.args.user_id` 是埋点里的浏览者
  // （当前登录账号）ID，**不是卖家**；若把它当 sellerId，会让搜索到的他人商品全部被误判为
  // 当前账号发布。无法确认卖家身份时留空，由上层标记为 captured_search / unconfirmed。
  // 平台可能把 ID 返回为数字，用 firstIdString 统一转字符串，避免误丢卖家身份。
  const sellerId = firstIdString(exContent['sellerId'], exContent['userId'], clickParam['seller_id'])

  return {
    itemId,
    title: firstString(exContent['title']),
    price: priceStr,
    priceNumber: parsePriceNumber(priceStr),
    originalPrice,
    originalPriceNumber: parsePriceNumber(originalPrice),
    wantCnt,
    publishTime: publishTimeMs ? formatTime(publishTimeMs) : '',
    publishTimeMs,
    captureTime: formatTime(capturedAt),
    captureTimeMs: capturedAt,
    sellerNick,
    sellerCity,
    freeShip: isFreeShip ? '是' : '否',
    tags,
    coverUrl: normalizeUrl(exContent['picUrl']),
    detailUrl: normalizeUrl(`https://www.goofish.com/item?id=${itemId}`),
    ...(sellerId ? { sellerId } : {}),
  }
}

/**
 * 归一化一页搜索结果（平台 `platform.search` 的 MTOP 原始 JSON）。
 * 数据路径与旧实现一致：`data.resultList`。
 */
export function normalizeProductsFromSearchPayload(payload: unknown, capturedAt: number): Product[] {
  const root = asRecord(payload)
  const data = root ? asRecord(root['data']) : null
  const resultList = data ? data['resultList'] : undefined
  const products: Product[] = []
  for (const item of asArray(resultList)) {
    const product = normalizeProductFromSearchItem(item, capturedAt)
    if (product) products.push(product)
  }
  return products
}

/**
 * 归一化商品详情（平台 `platform.detail` 的 MTOP 原始 JSON），返回可合并到列表商品的补丁。
 * 只包含响应中真实存在的字段；缺失时不写入（不臆造）。
 */
export function normalizeDetailPatch(payload: unknown): Partial<Product> {
  const root = asRecord(payload)
  const data = root ? asRecord(root['data']) : null
  if (!data) return {}

  const itemDO = asRecord(data['itemDO']) ?? {}
  const sellerDO = asRecord(data['sellerDO']) ?? {}
  const patch: Partial<Product> = {}

  const browseCnt = asFiniteNumber(itemDO['browseCnt'])
  if (browseCnt !== undefined) patch.browseCnt = browseCnt
  const collectCnt = asFiniteNumber(itemDO['collectCnt'])
  if (collectCnt !== undefined) patch.collectCnt = collectCnt
  const wantCnt = asCountNumber(itemDO['wantCnt'])
  if (wantCnt !== undefined) patch.wantCnt = wantCnt

  const category = firstString(itemDO['categoryId'])
  if (category) patch.category = category
  // 真实描述字段兼容：标准名 `desc`，部分响应使用 `description`。
  const desc = firstString(itemDO['desc'], itemDO['description'])
  if (desc) patch.desc = desc

  // 详情地区字段兼容：真实详情响应（`mtop.taobao.idle.pc.detail`）地区可能在
  // `itemDO.city`（市）或 `itemDO.prov`（省），部分响应放在 `sellerDO`。
  // 城市优先（更具体），缺失时用省份兜底，避免「地区」因只读 city 而显示未知。
  const sellerCity = firstString(itemDO['city'], sellerDO['city'], itemDO['prov'], sellerDO['prov'])
  if (sellerCity) patch.sellerCity = sellerCity
  const sellerId = firstIdString(sellerDO['sellerId'])
  if (sellerId) patch.sellerId = sellerId
  const sellerNick = firstString(sellerDO['nick'])
  if (sellerNick) patch.sellerNick = sellerNick
  const uniqueName = firstString(sellerDO['uniqueName'])
  if (uniqueName) patch.uniqueName = uniqueName

  const images = uniqueNormalizedUrls(
    asArray(itemDO['imageInfos']).map((img) => normalizeUrl(firstString(asRecord(img)?.['url']))),
  )
  if (images.length > 0) patch.images = images

  return patch
}

/** 由商品构建快照（供 P7 分析想要人数增长）。 */
export function buildProductSnapshot(product: Product, capturedAt: number): ProductSnapshot {
  return {
    id: `${product.itemId}@${capturedAt}${product.captureKeyword === undefined ? '' : `#${encodeURIComponent(product.captureKeyword)}`}`,
    itemId: product.itemId,
    capturedAt,
    wantCnt: product.wantCnt,
    priceNumber: product.priceNumber,
    price: product.price,
    ...(product.captureKeyword === undefined ? {} : { product: structuredClone(product) }),
  }
}
