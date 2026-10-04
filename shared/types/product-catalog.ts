/**
 * 商品目录统一查询契约（P7 商品库）。
 *
 * 覆盖两类来源：
 * - `feishu`：复用现有专用飞书分页读取（`FEISHU_PRODUCTS_PAGE`），转换为统一商品；
 * - `my_published`：当前账号官方「我的商品库」在售商品（经 MAIN world 平台桥接读取），
 *   并按需调用既有详情接口补齐描述 / 想要数 / 封面。
 *
 * 设计边界（硬性）：
 * - 只读；结果**绝不包含**任何 token / cookie / 密钥；
 * - 飞书 `total` 仅在 API 真实返回时给出，否则为 null（绝不伪造）；
 * - `my_published` 读取失败（未登录 / 登录失效 / 平台报错 / 分页被截断）一律**报错**，
 *   绝不降级为空列表；详情**部分失败**保留列表并在 `warnings` 中报告；
 * - `desc` 缺失时统一为空字符串（供 UI 展示「暂无描述」），字体字段缺失不臆造。
 *
 * PRODUCT_LIST 与旧 FEISHU_PRODUCTS_PAGE 保留原读取方式；每日表单条素材按真实来源表读取。
 */
import type { ProductOrder } from './product'

/** 商品目录来源。 */
export type ProductCatalogSource = 'feishu' | 'my_published'

/** 每页默认条数。 */
export const PRODUCT_CATALOG_DEFAULT_PAGE_SIZE = 20
/** 每页最大条数。 */
export const PRODUCT_CATALOG_MAX_PAGE_SIZE = 100
/** 关键词最大长度。 */
export const PRODUCT_CATALOG_KEYWORD_MAX_LENGTH = 100
/** 飞书分页游标最大长度。 */
export const PRODUCT_CATALOG_CURSOR_MAX_LENGTH = 2048

/** 商品目录统一商品模型（两类来源归一后的展示/导出形态）。 */
export interface CatalogProduct {
  /** 来源。 */
  source: ProductCatalogSource
  /**
   * 真实「商品 ID」：
   * - 当前账号在售为官方 itemId（必有）；
   * - 飞书缺「商品ID」时为空字符串，**绝不用 recordId 冒充**。
   */
  itemId: string
  /** 飞书行 identity（仅 `feishu` 来源有）；当前账号商品无。 */
  recordId?: string
  /** 飞书记录真实来源表；跨每日表分页时每行可能不同。 */
  targetTableId?: string
  /** 本次采集使用的关键字，不汇总或去重其它记录。 */
  captureKeyword?: string
  title: string
  /** 价格原文（如 `¥123`）。 */
  price: string
  /** 价格数值（解析失败为 0）。 */
  priceNumber: number
  originalPrice: string
  originalPriceNumber: number
  /** 想要人数。 */
  wantCnt: number
  /** 封面 URL（当前账号在售首图 / 飞书封面，可能为空串）。 */
  coverUrl: string
  /** 详情页 URL（可能为空串）。 */
  detailUrl: string
  /** 商品描述；缺失统一为空字符串（UI 显示「暂无描述」）。 */
  desc: string
  /** 图片 URL 列表（可能为空）。 */
  images: string[]
  sellerNick?: string
  sellerCity?: string
  freeShip?: string
  tags?: string
  /** 采集 / 读取时间戳（毫秒）；飞书为行内采集时间，当前账号为本次读取时刻。 */
  captureTimeMs?: number
}

/** PRODUCT_CATALOG_QUERY 请求负载。 */
export interface ProductCatalogQueryPayload {
  source: ProductCatalogSource
  /** 关键词：飞书走服务端过滤；当前账号在完整在售集合上过滤。 */
  keyword?: string
  /** 排序：飞书走服务端排序；当前账号在完整集合上本地排序。 */
  order?: ProductOrder
  /** 每页条数，缺省 {@link PRODUCT_CATALOG_DEFAULT_PAGE_SIZE}，上限 {@link PRODUCT_CATALOG_MAX_PAGE_SIZE}。 */
  pageSize?: number
  /** 页码（从 0 开始）：`my_published` 用 offset 分页；`feishu` 忽略。 */
  page?: number
  /** 飞书分页游标（上一页 `nextCursor`）；首页省略。`my_published` 忽略。 */
  cursor?: string
  /**
   * 飞书分页范围绑定：每日表集合和北京时间日期必须仍一致。
   * 携带 cursor 时必须提供；单条商品的来源表另由 CatalogProduct.targetTableId 承载。
   */
  targetTableId?: string
  /** 强制刷新：重新读取对应来源的数据，不复用该查询的缓存。 */
  forceRefresh?: boolean
}

/** PRODUCT_CATALOG_QUERY 结果。 */
export interface ProductCatalogQueryResult {
  source: ProductCatalogSource
  products: CatalogProduct[]
  /**
   * 完整集合总数：
   * - `my_published`：当前账号在售商品真实总数（已应用关键词过滤）；
   * - `feishu`：飞书 API 真实返回的 total，未返回时为 `null`（绝不伪造）。
   */
  total: number | null
  /** 当前页码（从 0 开始）。 */
  page: number
  pageSize: number
  hasMore: boolean
  /** 下一页游标（`feishu` 的 nextPageToken）；无则省略。 */
  nextCursor?: string
  /** `feishu` 分页范围绑定，UI 翻页时回传；真实来源表在每行 targetTableId。 */
  targetTableId?: string
  /** 非致命告警（如部分商品详情补齐失败），UI 可展示。 */
  warnings: string[]
  /** 本次结果生成时间戳（毫秒）。 */
  fetchedAt: number
}
