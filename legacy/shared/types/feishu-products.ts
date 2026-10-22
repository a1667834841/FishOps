/**
 * 飞书商品分页浏览 / 单条读取契约（P7 商品库）。
 *
 * 设计边界（硬性）：
 * - 分页浏览走**专用**命令，真实单次请求（默认每页 20 条），关键词与排序由飞书 search API
 *   过滤，**绝不本地全量拉取或全表过滤**；目标表固定为已配置商品表，不接受任意 tableId；
 * - 结果**绝不包含** appSecret / tenantAccessToken / spreadsheetToken 等任何密钥；
 * - `total` 仅在飞书 API 真实返回时提供，绝不本地估算 / 伪造；
 * - 单条读取把飞书记录映射为可编辑发布素材，缺字段时明确回退（title / cover）并报告，
 *   绝不用 recordId 冒充「商品ID」，也绝不伪造随机 ID；
 * - 本契约**不改变** DATA_SOURCE_QUERY 的批量分析语义，两者互不影响。
 */
import type { DatasetRow } from './dataset'

/** 每页默认条数：真实单次请求只取 20 条，绝不一次性拉全表。 */
export const FEISHU_PRODUCTS_DEFAULT_PAGE_SIZE = 20

/** 每页最大条数上限：防止单次请求过大（并非替代分析批量查询）。 */
export const FEISHU_PRODUCTS_MAX_PAGE_SIZE = 100

/** 关键词最大长度。 */
export const FEISHU_PRODUCTS_KEYWORD_MAX_LENGTH = 100

/** pageToken 最大长度（飞书 opaque token，仅透传，绝不解析）。 */
export const FEISHU_PRODUCTS_PAGE_TOKEN_MAX_LENGTH = 2048

/** recordId 最大长度。 */
export const FEISHU_PRODUCTS_RECORD_ID_MAX_LENGTH = 128

/**
 * 排序方式：映射到飞书 search API 的真实 `sort`，由 API 排序，绝不在本地全量排序。
 * - default: 不指定排序，交由飞书默认顺序；
 * - titleAsc / titleDesc: 按「商品标题」；
 * - priceAsc / priceDesc: 按「价格」；
 * - wantCntDesc: 按「想要人数」降序；
 * - captureTimeDesc / captureTimeAsc: 按「采集时间」降序 / 升序。
 */
export type FeishuProductsOrder =
  | 'default'
  | 'titleAsc'
  | 'titleDesc'
  | 'priceAsc'
  | 'priceDesc'
  | 'wantCntDesc'
  | 'captureTimeDesc'
  | 'captureTimeAsc'

/** 允许的排序值（供运行时校验复用）。 */
export const FEISHU_PRODUCTS_ORDERS: readonly FeishuProductsOrder[] = [
  'default',
  'titleAsc',
  'titleDesc',
  'priceAsc',
  'priceDesc',
  'wantCntDesc',
  'captureTimeDesc',
  'captureTimeAsc',
]

/** FEISHU_PRODUCTS_PAGE 请求负载。 */
export interface FeishuProductsPagePayload {
  /** 每页条数，缺省 {@link FEISHU_PRODUCTS_DEFAULT_PAGE_SIZE}（20）；上限 {@link FEISHU_PRODUCTS_MAX_PAGE_SIZE}。 */
  pageSize?: number
  /** 飞书分页 token（上一页返回的 nextPageToken），仅透传。 */
  pageToken?: string
  /**
   * 目标表绑定断言：
   * - 提供时后台复验必须等于当前已配置商品表，否则以绑定漂移拒绝；
   * - **携带 pageToken 时必须提供**，防止用一张表的游标去翻另一张表（跨表游标）。
   * 命令仍不接受任意 tableId —— 实际查询表恒为已配置商品表。
   */
  targetTableId?: string
  /** 关键词：由飞书 search API 合法过滤（标题 / 商品ID 包含匹配），绝不全表拉取后本地过滤。 */
  keyword?: string
  /** 排序方式。 */
  order?: FeishuProductsOrder
}

/**
 * 分页结果行：与 {@link DatasetRow} 同构的**平铺**字段，`recordId` 与其它字段同层出现，
 * 便于 UI 复用现有飞书 Dataset 行解析逻辑。
 */
export type FeishuProductRow = DatasetRow

/** FEISHU_PRODUCTS_PAGE 结果。 */
export interface FeishuProductsPageResult {
  /** 本页真实行（平铺，含 recordId）。 */
  rows: FeishuProductRow[]
  /** 飞书是否还有下一页。 */
  hasMore: boolean
  /** 下一页 token；无下一页时缺省。 */
  nextPageToken?: string
  /** 仅当飞书 API 真实返回 `total` 时提供；绝不本地估算 / 伪造。 */
  total?: number
  /** 目标表 ID（固定为已配置商品表，不接受任意表）。 */
  targetTableId: string
}

/** FEISHU_PRODUCT_GET 请求负载。 */
export interface FeishuProductGetPayload {
  /** 飞书记录 ID（真实 identity，非「商品ID」）。 */
  recordId: string
  /**
   * 可选：真实来源表 ID。后台复验其为旧配置表或当前多维表格中的每日采集表。
   */
  targetTableId?: string
}

/**
 * 从飞书记录安全映射出的发布素材。
 *
 * 缺字段时明确回退：`title` 缺失回退别名字段 / 空串，`coverUrl` 缺失回退首张图片；
 * 所有回退都在 {@link FeishuProductGetResult.warnings} 中报告。
 */
export interface FeishuProductMaterial {
  /** 真实「商品ID」；飞书缺少该字段时为空字符串，绝不用 recordId 冒充。 */
  itemId: string
  title: string
  desc: string
  /** 价格数值（解析失败为 0）。 */
  price: number
  /** 原价数值（解析失败为 0）。 */
  originalPrice: number
  /** 想要人数。 */
  wantCnt: number
  /** 封面 URL（缺失时回退首张图片，可能为空串）。 */
  coverUrl: string
  /** 商品详情 URL（可能为空串）。 */
  detailUrl: string
  /** 图片 URL 列表（可能为空）。 */
  images: string[]
}

/** FEISHU_PRODUCT_GET 结果。 */
export interface FeishuProductGetResult {
  recordId: string
  targetTableId: string
  /**
   * 平铺的飞书真实行（含 `recordId` 与业务字段，与 DatasetRow 同构），
   * 可直接复用现有飞书行解析逻辑（parseFeishuDatasetRowToProduct）对接编辑表单；不含任何密钥。
   */
  row: DatasetRow
  /** 映射后的发布素材（含明确回退结果）。 */
  material: FeishuProductMaterial
  /** 标准字段中缺失的字段名（报告而非造假）。 */
  missingFields: string[]
  /** 回退 / 兼容说明（如「缺少商品标题，已回退使用别名字段」）。 */
  warnings: string[]
}
