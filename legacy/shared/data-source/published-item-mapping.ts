/**
 * 官方「我的商品库」在售卡片 → {@link CatalogProduct} 归一化（当前账号商品目录，单一来源）。
 *
 * 目的：把官方 `mtop.idle.web.xyh.item.list` 返回的真实 `cardList[].cardData`
 * 归一化为统一商品模型，供「商品目录」展示。卡片经 MAIN world 平台桥接读取
 * （复用现有认证 / 签名 / 限流 / 错误处理），本模块只做字段映射。
 *
 * 真实字段（以 space133 当前账号实测 + 旧实现为准，非假定）：
 * - `id` → 商品 ID；`title` → 标题；
 * - `priceInfo.price`（兼容 `price`）→ 价格原文；
 * - `picInfo.picUrl`（兼容 `picUrl` / `imageUrl`）→ 首图 / 封面（协议相对地址补 `https:`）；
 * - `detailParams.postInfo` 含「包邮」→ 包邮；
 * - 描述 / 想要人数按多处真实别名字段兜底读取，缺失时保留空串 / 0，**绝不臆造**。
 *
 * 安全与边界（硬性）：
 * - 缺少 `id` 的脏卡片**直接丢弃**，绝不用其它字段冒充 itemId；
 * - 描述缺失统一为空字符串（供 UI 显示「暂无描述」）；
 * - 只做字段映射，**绝不**写入本地商品库。
 */
import { normalizeUrl } from '../capture/normalizer'
import type { CatalogProduct } from '../types/product-catalog'

/** 官方在售卡片的 `cardData` 原始结构（宽松，仅读取真实存在的字段）。 */
export type OnSaleCardData = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    // 官方偶发把数值字段返回为数字（如价格），统一转字符串避免丢失。
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}

/** 取首个可用 URL（字符串或包装对象），协议相对地址补 https。 */
function pickUrl(value: unknown): string {
  if (typeof value === 'string') return normalizeUrl(value)
  if (isRecord(value)) {
    for (const key of ['picUrl', 'url', 'link']) {
      const candidate = value[key]
      if (typeof candidate === 'string' && candidate.trim().length > 0) return normalizeUrl(candidate.trim())
    }
  }
  return ''
}

/**
 * 解析想要人数：兼容数值与「12人想要」「12」等字符串，解析失败为 0（绝不臆造）。
 */
function parseWantCount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string') {
    const matched = value.replace(/,/g, '').match(/\d+/)
    return matched ? Number.parseInt(matched[0]!, 10) || 0 : 0
  }
  return 0
}

/** 价格原文 → 数值（保留数字与小数点，解析失败为 0）。 */
function parsePriceNumber(priceText: string): number {
  const parsed = Number.parseFloat(priceText.replace(/[^\d.]/g, ''))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * 归一化单条官方在售卡片为 {@link CatalogProduct}。
 * @param cardData 官方 `cardList[].cardData` 原始对象。
 * @param context 读取时间（本次读取时刻，作为采集时间）。
 * @returns 归一后的商品；缺少真实 `id` 时返回 null（丢弃脏卡片）。
 */
export function mapOnSaleCardToProduct(
  cardData: OnSaleCardData,
  context: { capturedAt: number } = { capturedAt: Date.now() },
): CatalogProduct | null {
  const itemId = firstNonEmptyString(cardData['id'])
  if (!itemId) return null

  const priceInfo = isRecord(cardData['priceInfo']) ? cardData['priceInfo'] : {}
  const picInfo = isRecord(cardData['picInfo']) ? cardData['picInfo'] : {}
  const detailParams = isRecord(cardData['detailParams']) ? cardData['detailParams'] : {}

  const price = firstNonEmptyString(priceInfo['price'], cardData['price'])
  const coverUrl = pickUrl(picInfo['picUrl']) || pickUrl(cardData['picUrl']) || pickUrl(cardData['imageUrl'])

  const desc = firstNonEmptyString(
    cardData['desc'],
    cardData['description'],
    detailParams['desc'],
    detailParams['description'],
  )
  const wantCnt = parseWantCount(
    cardData['wantCnt'] ?? cardData['wantNum'] ?? cardData['wantCount'] ?? detailParams['wantCnt'],
  )

  const postInfo = firstNonEmptyString(detailParams['postInfo'], detailParams['freeShip'])
  const freeShip = postInfo.includes('包邮') ? '是' : ''
  const sellerNick = firstNonEmptyString(cardData['userNickName'], cardData['sellerNick'])
  const sellerCity = firstNonEmptyString(cardData['area'], cardData['sellerCity'])

  return {
    source: 'my_published',
    itemId,
    title: firstNonEmptyString(cardData['title']),
    price,
    priceNumber: parsePriceNumber(price),
    originalPrice: '',
    originalPriceNumber: 0,
    wantCnt,
    coverUrl,
    detailUrl: `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}`,
    desc,
    images: coverUrl ? [coverUrl] : [],
    ...(sellerNick ? { sellerNick } : {}),
    ...(sellerCity ? { sellerCity } : {}),
    ...(freeShip ? { freeShip } : {}),
    captureTimeMs: context.capturedAt,
  }
}
