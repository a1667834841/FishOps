/**
 * 当前账号官方「我的商品库」在售商品读取（MAIN world 平台层）。
 *
 * 经 {@link MtopClient} 调用 `mtop.idle.web.xyh.item.list`，**复用其认证 / 签名 / 限流 / 错误处理**，
 * 不新增后台 cookies+fetch 路径；只在 MAIN world 使用页面凭据。
 *
 * 真实字段（实测，非假定）：
 * - 请求体：`{ needGroupInfo, pageNumber, userId, pageSize, groupName?, groupId?, defaultGroup }`；
 * - `pageSize` 官方上限 20（超出报 `FAIL_BIZ_FORBIDDEN`）；
 * - 响应：`data.itemGroupList[].{groupName,groupId,itemNumber}`；`data.cardList[].cardData.{id,title,priceInfo,picInfo,...}`；
 * - `data.nextPage` 指示是否有下一页；`data.totalCount` 恒为 0、不可信。
 *
 * 边界（硬性）：
 * - 「在售」分组 `groupId` 随账号而变 → 先 `needGroupInfo` 发现，绝不硬编码；官方未列出该分组时视为真实 0 件；
 * - `cardList` / `data` 结构缺失或非数组一律抛错（**绝不静默降级为空列表**）；
 * - **读全**（nextPage 循环）并去重 id；若达到翻页上限仍 `nextPage=true`，直接抛错（**绝不截断冒充总数**）；
 * - 缺 userId / 非 SUCCESS / 网络错误一律抛（由 mtop-client 归一为 {@link PlatformError}）。
 */
import { PlatformError } from '../errors'
import type { MtopClient, MtopRawResponse } from './mtop-client'

/** 在售分组名。 */
export const ON_SALE_GROUP_NAME = '在售'
/** 官方每页上限。 */
export const MY_ITEMS_MAX_PAGE_SIZE = 20
/** 默认每页条数。 */
export const MY_ITEMS_DEFAULT_PAGE_SIZE = 20
/** 防御性翻页上限（在售商品极端多时也要有界）。 */
export const MY_ITEMS_DEFAULT_MAX_PAGES = 20

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 从响应中找「在售」分组 groupId；官方未列出「在售」分组时返回 null（视为真实 0 件）。 */
export function findOnSaleGroupId(payload: unknown): number | null {
  const data = isRecord(payload) ? payload['data'] : undefined
  const groups = isRecord(data) ? data['itemGroupList'] : undefined
  if (!Array.isArray(groups)) {
    throw new PlatformError('api', '官方商品库响应缺少 itemGroupList，无法定位在售分组')
  }
  for (const group of groups) {
    if (!isRecord(group)) continue
    if (group['groupName'] === ON_SALE_GROUP_NAME && typeof group['groupId'] === 'number') {
      return group['groupId']
    }
  }
  // 官方未列出「在售」分组（如无任何在售商品时可能不出现该分组）：视为真实 0 件，不抛错。
  return null
}

/**
 * 从响应中解析真实在售卡片（`cardList[].cardData`）。
 *
 * 结构强校验：`data` / `cardList` 缺失或非数组一律抛 {@link PlatformError}（`api`），
 * **绝不把结构异常静默降级为空列表**。
 */
export function parseOnSaleCards(payload: unknown): MtopRawResponse[] {
  const data = isRecord(payload) ? payload['data'] : undefined
  if (!isRecord(data)) {
    throw new PlatformError('api', '官方商品库分页响应缺少 data')
  }
  const cards = data['cardList']
  if (!Array.isArray(cards)) {
    throw new PlatformError('api', '官方商品库分页响应缺少 cardList')
  }
  const items: MtopRawResponse[] = []
  for (const card of cards) {
    if (!isRecord(card)) continue
    const cardData = card['cardData']
    if (!isRecord(cardData)) continue
    items.push(cardData)
  }
  return items
}

/**
 * 读全当前账号「在售」分组的全部真实卡片。
 *
 * @throws PlatformError 未登录 / token 失效 / 风控 / 网络 / 分组缺失 / 分页被截断。
 */
export async function readAllOnSaleCards(
  client: MtopClient,
  userId: string,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<MtopRawResponse[]> {
  const pageSize = Math.min(options.pageSize ?? MY_ITEMS_DEFAULT_PAGE_SIZE, MY_ITEMS_MAX_PAGE_SIZE)
  const maxPages = Math.max(1, options.maxPages ?? MY_ITEMS_DEFAULT_MAX_PAGES)

  // 1) 发现「在售」分组 groupId（随账号而变，绝不硬编码）。
  const groupProbe = await client.requestRaw('myOnSaleItems', {
    needGroupInfo: true,
    pageNumber: 1,
    userId,
    pageSize,
    defaultGroup: true,
  })
  const groupId = findOnSaleGroupId(groupProbe)
  // 官方未列出「在售」分组 → 当前账号真实 0 件在售，直接返回空集合（不谎报、不抛错）。
  if (groupId === null) return []

  // 2) 分页读全「在售」分组商品；达到上限仍 nextPage=true 直接抛错（不截断冒充 total）。
  const cards: MtopRawResponse[] = []
  const seenIds = new Set<string>()
  let pageNumber = 1
  for (;;) {
    const page = await client.requestRaw('myOnSaleItems', {
      needGroupInfo: false,
      pageNumber,
      userId,
      pageSize,
      groupName: ON_SALE_GROUP_NAME,
      groupId,
      defaultGroup: false,
    })
    for (const card of parseOnSaleCards(page)) {
      // 去重 id 防跨页重复；无 id 的脏项保留（由归一化阶段丢弃）。
      const id = card['id']
      if (typeof id === 'string' && id.length > 0) {
        if (seenIds.has(id)) continue
        seenIds.add(id)
      }
      cards.push(card)
    }
    const data = isRecord(page) ? page['data'] : undefined
    // nextPage 非布尔值一律视为 false（容错）。
    const hasMore = isRecord(data) ? data['nextPage'] === true : false
    if (!hasMore) break
    if (pageNumber >= maxPages) {
      throw new PlatformError('api', '官方在售商品分页超过上限，无法获得完整总数（不截断冒充 total）')
    }
    pageNumber += 1
  }

  return cards
}
