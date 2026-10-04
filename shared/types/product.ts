/**
 * 商品（Product）领域类型（P4）。
 *
 * 概念对齐与迁移策略：
 * - 本地商品库定位为「当前账号发布的商品」目录；
 * - 搜索采集的市场商品不可冒充当前账号发布商品（标记为 captured_search）；
 * - 只有能确认归属当前账号（如 sellerId 匹配当前登录用户）时才归入当前账号发布商品（my_published）；
 * - 历史存量未打标商品作为 legacy_unconfirmed 保留，不可直接视作当前账号已发布商品。
 */

/** 商品来源类型。 */
export type ProductSource =
  | 'my_published'         // 当前账号已发布商品（本地商品目录核心资产）
  | 'captured_search'      // 搜索采集竞品/市场商品（不可冒充当前账号发布商品）
  | 'legacy_unconfirmed'   // 旧数据迁移/未确认来源存量商品

/** 商品发布状态。 */
export type ProductStatus = 'published' | 'offline' | 'unconfirmed'

/** 标准商品记录。 */
export interface Product {
  /** 商品 ID（唯一键）。 */
  itemId: string
  /** 商品标题。 */
  title: string
  /** 价格原文（如 `¥123`）。 */
  price: string
  /** 价格数值（解析失败为 0）。 */
  priceNumber: number
  /** 原价原文。 */
  originalPrice: string
  /** 原价数值。 */
  originalPriceNumber: number
  /** 想要人数。 */
  wantCnt: number
  /** 发布时间（本地化字符串）。 */
  publishTime: string
  /** 发布时间戳（毫秒，缺省 0）。 */
  publishTimeMs: number
  /** 采集时间（本地化字符串）。 */
  captureTime: string
  /** 采集时间戳（毫秒）。 */
  captureTimeMs: number
  /** 本次搜索采集使用的关键字；旧记录可能缺失。 */
  captureKeyword?: string
  /** 卖家昵称。 */
  sellerNick: string
  /** 卖家地区。 */
  sellerCity: string
  /** 是否包邮：`'是'` / `'否'`（与旧 `PRODUCT_SCHEMA.freeShip` 一致）。 */
  freeShip: string
  /** 商品标签（顿号分隔）。 */
  tags: string
  /** 封面图 URL。 */
  coverUrl: string
  /** 详情页 URL。 */
  detailUrl: string

  /** 商品来源（用于区分当前账号发布商品与采集竞品/存量旧数据）。 */
  source?: ProductSource
  /** 商品发布状态（如 published / offline / unconfirmed）。 */
  status?: ProductStatus | string
  /** 归属账号用户 ID。 */
  accountId?: string
  /**
   * 归属是否未确认：`true` 表示无法确认该商品的真实卖家 / 当前账号，来源结论不可信。
   * 用于 upsert 合并时保护已确认归属（尤其 `my_published`）不被未确认采集降级覆盖。
   */
  ownershipUnconfirmed?: boolean

  // ---- 详情采集补充字段（可选，缺数据时不写入） ----
  /** 浏览量。 */
  browseCnt?: number
  /** 收藏数。 */
  collectCnt?: number
  /** 类目 ID。 */
  category?: string
  /** 商品描述。 */
  desc?: string
  /** 卖家 ID。 */
  sellerId?: string
  /** 卖家唯一名。 */
  uniqueName?: string
  /** 商品图片列表。 */
  images?: string[]
}

/**
 * 商品快照：分析记录按 itemId 与毫秒时间去重；搜索采集额外绑定关键字并保存完整内容。
 * 同时供想要人数增长分析和飞书同步恢复使用。
 */
export interface ProductSnapshot {
  /** 快照 ID：itemId@capturedAt；搜索采集追加编码后的关键字。 */
  id: string
  /** 关联商品 ID。 */
  itemId: string
  /** 采集时间戳（毫秒）。 */
  capturedAt: number
  /** 当时的想要人数。 */
  wantCnt: number
  /** 当时的价格数值。 */
  priceNumber: number
  /** 当时的价格原文。 */
  price: string
  /** 当次采集的完整内容，供飞书失败重试使用，不能用商品库最新内容替代。 */
  product?: Product
}

/** 商品 upsert 结果统计。 */
export interface ProductUpsertResult {
  /** 新增商品数。 */
  added: number
  /** 覆盖（已存在 itemId）商品数。 */
  updated: number
  /** 新增快照数。 */
  snapshots: number
}

/** 商品列表排序方式。 */
export type ProductOrder = 'captureTimeDesc' | 'captureTimeAsc' | 'wantCntDesc'

/** 商品列表查询条件。 */
export interface ProductListQuery {
  /** 标题 / itemId 关键字过滤。 */
  keyword?: string
  /** 最多返回条数。 */
  limit?: number
  /** 偏移量。 */
  offset?: number
  /** 排序方式，默认 `captureTimeDesc`。 */
  order?: ProductOrder
  /**
   * 来源过滤：`'my_published'`（当前账号发布商品）、`'captured_search'`、`'legacy_unconfirmed'` 或 `'all'`。
   * 缺省安全默认为 `'my_published'`：`'all'` 必须显式传入，否有误把竞品/存量商品当自有商品的风险。
   */
  source?: ProductSource | 'all'
  /** 状态过滤（可选）。 */
  status?: string
}

/** 商品分页结果。 */
export interface ProductPage {
  products: Product[]
  /** 过滤后总数（不受 limit / offset 影响）。 */
  total: number
}
