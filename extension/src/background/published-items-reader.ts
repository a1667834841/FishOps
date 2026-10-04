/**
 * 官方「我的商品库」只读读取器（后台 Service Worker）。
 *
 * 目的：给发布运行时的**提交结果判定**提供唯一可信证据——当前账号官方在售商品的
 * 真实 itemId 列表。发布“成功”必须以「提交前去重基线 → 提交后出现新 itemId」为准，
 * **绝不能仅凭 URL 离开发布页判定**（误跳转登录页 / 首页同样会离开）。
 *
 * 真实接口（以 space133 当前账号实测为准，非假定字段）：
 * - API: `mtop.idle.web.xyh.item.list`（v1.0，appKey `34839810`，`h5api.m.goofish.com`）；
 * - 请求体：`{ needGroupInfo, pageNumber, userId, pageSize, groupName, groupId?, defaultGroup }`；
 * - `pageSize` 官方上限 20（超过报 `FAIL_BIZ_FORBIDDEN`）；
 * - 响应：`data.itemGroupList[].{groupName,groupId,itemNumber}` 给出各分组计数；
 *   `data.cardList[].cardData.{id,title,...}` 给出商品项；
 * - **重要实测**：`data.totalCount` 恒为 0、不可信，计数必须以 `cardList` 长度 / `itemGroupList.itemNumber` 为准；
 *   `readOnSaleItems()` 保证**读全**（nextPage 循环）；若达到翻页上限仍 nextPage=true 则抛错，
 *   **绝不把截断后的条数冒充为真实总数**；
 * - 「在售」分组的 `groupId` **随账号而变**（本账号为 14645107），因此先经 `needGroupInfo` 发现，
 *   绝不硬编码旧源码里的 `70746814`。
 *
 * 安全边界：
 * - 单例复用后台注入的 `chrome.cookies`，**只读** `_m_h5_tk` / `unb`；
 * - token / cookie 原文**绝不写入日志、绝不外泄**（对外仅返回 itemId / 标题）；
 * - 缺权限 / 未登录 / 网络失败 / 接口返回非 SUCCESS 时一律 throw，调用方据此判 unknown 并锁定，**
 *   绝不把读取失败当作“发布成功”**；
 * - 该读取器只读，**绝不写入本地商品库**（不靠本地 upsert(+1) 伪造验收）。
 */
import { extractUserIdFromCookie } from '../platform/xianyu/auth'
import { extractToken, generateSignature, MTOP_APP_KEY } from '../platform/xianyu/sign'
import type { PublishedItemRef, PublishedItemsReader } from './publish-runtime'

/** 官方「我的商品库」接口名（实测）。 */
export const MY_ITEMS_API = 'mtop.idle.web.xyh.item.list'
/** 接口基础 URL。 */
export const MY_ITEMS_BASE_URL = `https://h5api.m.goofish.com/h5/${MY_ITEMS_API}/1.0/`
/** 在售分组名。 */
export const ON_SALE_GROUP_NAME = '在售'

/** 目标 API 的真实 origin（cookie 查询首选域；与请求 URL 同域）。 */
const API_ORIGIN = 'https://h5api.m.goofish.com'
/** 兼容回退域（仅当 h5api 域读不到 cookie 时才尝试；绝不假定 cookie 一定在 www）。 */
const FALLBACK_ORIGIN = 'https://www.goofish.com'
const TOKEN_COOKIE = '_m_h5_tk'
const USER_ID_COOKIE = 'unb'
/** 官方每页上限。 */
const DEFAULT_PAGE_SIZE = 20
/** 防御性翻页上限（在售商品极端多时也要有界）。 */
const DEFAULT_MAX_PAGES = 20

/** `chrome.cookies` 的最小只读抽象（便于单测注入）。 */
export interface CookiesApiLike {
  get(details: { url: string; name: string }): Promise<{ value?: string } | null>
}

export interface PublishedItemsReaderDeps {
  cookies: CookiesApiLike
  /** 可注入的 fetch（单测 / 离线环境 Mock）；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 时间戳来源，默认 Date.now。 */
  now?: () => number
  /** 每页条数（官方上限 20，超出会被服务端拒绝）。 */
  pageSize?: number
  /** 最大翻页数。 */
  maxPages?: number
}

interface ListResponse {
  ret?: unknown
  data?: {
    cardList?: unknown
    itemGroupList?: unknown
    nextPage?: unknown
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 校验 MTOP 响应：`ret[0]` 必须以 `SUCCESS` 开头，否则视为失败（不打印原始响应）。 */
function assertSuccess(payload: ListResponse): void {
  const ret = payload.ret
  if (!Array.isArray(ret) || ret.length === 0 || typeof ret[0] !== 'string') {
    throw new Error('官方商品库响应缺少 ret 字段')
  }
  if (!ret[0].startsWith('SUCCESS')) {
    // 只回传协议错误码（不含任何凭据），便于定位而未登录 / 风控 / 参数超限等场景。
    throw new Error(`官方商品库接口返回失败：${ret[0]}`)
  }
}

/** 从 itemGroupList 中找出「在售」分组的 groupId。 */
function findOnSaleGroupId(payload: ListResponse): number {
  const groups = payload.data?.itemGroupList
  if (!Array.isArray(groups)) {
    throw new Error('官方商品库响应缺少 itemGroupList，无法定位在售分组')
  }
  for (const group of groups) {
    if (!isRecord(group)) continue
    if (group.groupName === ON_SALE_GROUP_NAME && typeof group.groupId === 'number') {
      return group.groupId
    }
  }
  throw new Error('官方商品库中未找到「在售」分组')
}

/** 从 cardList 中提取 itemId / 标题（忽略无 id 的脏项）。 */
function parseCardList(payload: ListResponse): PublishedItemRef[] {
  const cards = payload.data?.cardList
  if (!Array.isArray(cards)) return []
  const refs: PublishedItemRef[] = []
  for (const card of cards) {
    if (!isRecord(card)) continue
    const cardData = card.cardData
    if (!isRecord(cardData)) continue
    const id = cardData.id
    if (typeof id !== 'string' || id.length === 0) continue
    const title = cardData.title
    refs.push({ itemId: id, ...(typeof title === 'string' ? { title } : {}) })
  }
  return refs
}

/**
 * 创建官方「我的商品库」只读读取器。
 *
 * `readOnSaleItems()` 语义见 {@link PublishedItemsReader}：成功返回在售商品列表；
 * 缺权限 / 未登录 / 失败一律 throw。
 */
export function createPublishedItemsReader(deps: PublishedItemsReaderDeps): PublishedItemsReader {
  const now = deps.now ?? Date.now
  const pageSize = Math.min(deps.pageSize ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE)
  const maxPages = Math.max(1, deps.maxPages ?? DEFAULT_MAX_PAGES)
  const doFetch = deps.fetchImpl ?? globalThis.fetch

  async function readCookie(name: string): Promise<string | null> {
    // 先取**目标 API 实际域**（h5api.m.goofish.com）的 cookie；读不到再回退兼容域。
    for (const url of [API_ORIGIN, FALLBACK_ORIGIN]) {
      const cookie = await deps.cookies.get({ url, name })
      const value = cookie?.value
      if (typeof value === 'string' && value.length > 0) return value
    }
    return null
  }

  async function callList(dataObj: Record<string, unknown>): Promise<ListResponse> {
    const token = await readCookie(TOKEN_COOKIE).then((v) => (v === null ? null : extractToken(`${TOKEN_COOKIE}=${v}`)))
    if (!token) {
      throw new Error('缺少官方商品库查询 token（未登录或登录态失效）')
    }
    const dataStr = JSON.stringify(dataObj)
    const timestamp = String(now())
    const sign = generateSignature(dataStr, { token, timestamp, appKey: MTOP_APP_KEY }).sign

    const urlParams: Record<string, string> = {
      jsv: '2.7.2',
      appKey: MTOP_APP_KEY,
      t: timestamp,
      sign,
      v: '1.0',
      type: 'originaljson',
      accountSite: 'xianyu',
      dataType: 'json',
      timeout: '20000',
      api: MY_ITEMS_API,
      sessionOption: 'AutoLoginOnly',
      spm_cnt: 'a21ybx.personal.0.0',
      spm_pre: 'a21ybx.home.nav.1',
    }

    let response: Response
    try {
      response = await doFetch(`${MY_ITEMS_BASE_URL}?${new URLSearchParams(urlParams).toString()}`, {
        method: 'POST',
        // 不设置 origin / referer：它们是 fetch 禁止头（forbidden header），浏览器会自动处理；
        // 手动设置会被忽略甚至报错，因此移除。
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: `data=${encodeURIComponent(dataStr)}`,
        credentials: 'include',
      })
    } catch {
      throw new Error('官方商品库查询请求失败（网络异常）')
    }
    if (!response.ok) {
      throw new Error(`官方商品库查询返回 HTTP ${response.status}`)
    }
    const payload = (await response.json()) as ListResponse
    assertSuccess(payload)
    return payload
  }

  async function readOnSaleItems(): Promise<PublishedItemRef[]> {
    const userId = extractUserIdFromCookie(
      `unb=${(await readCookie(USER_ID_COOKIE)) ?? ''}`,
    )
    if (!userId) {
      throw new Error('缺少官方商品库查询用户 ID（未登录）')
    }

    // 1) 发现「在售」分组 groupId（随账号而变，绝不硬编码）。
    const groupProbe = await callList({
      needGroupInfo: true,
      pageNumber: 1,
      userId,
      pageSize,
      defaultGroup: true,
    })
    const groupId = findOnSaleGroupId(groupProbe)

    // 2) 分页读取「在售」分组商品。
    //    必须读全：若达到翻页上限时官方仍 nextPage=true，说明数据被截断，
    //    **不能把截断后的条数冒充为真实总数** —— 直接抛错（调用方据此拒绝/unknown）。
    const results: PublishedItemRef[] = []
    let pageNumber = 1
    for (;;) {
      const page = await callList({
        needGroupInfo: false,
        pageNumber,
        userId,
        pageSize,
        groupName: ON_SALE_GROUP_NAME,
        groupId,
        defaultGroup: false,
      })
      results.push(...parseCardList(page))
      if (page.data?.nextPage !== true) break
      if (pageNumber >= maxPages) {
        throw new Error('官方在售商品分页超过上限，无法获得完整总数（不截断冒充 total）')
      }
      pageNumber++
    }

    // 去重（同 itemId 只保留一次）。
    const seen = new Set<string>()
    return results.filter((ref) => {
      if (seen.has(ref.itemId)) return false
      seen.add(ref.itemId)
      return true
    })
  }

  return { readOnSaleItems }
}
