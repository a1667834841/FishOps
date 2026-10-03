/**
 * 飞书多维表格（Bitable）数据源类型与错误分类（P7）。
 *
 * 迁移旧版 `main:background.js` 中的飞书逻辑，规范字段类型、Token 刷新与批量操作。
 * 严禁在日志与对外异常中输出敏感凭据（如 appSecret、tenantAccessToken）。
 */

/** 可注入的 HTTP 传输器接口，便于单测与离线环境 Mock。 */
export interface HttpTransport {
  fetch(url: string, init?: RequestInit): Promise<Response>
}

/** 飞书 Bitable 配置。 */
export interface FeishuConfig {
  /** 飞书开放平台 App ID。 */
  appId: string
  /** 飞书开放平台 App Secret。仅在请求层使用，禁止写入日志或暴露给前端。 */
  appSecret: string
  /** 多维表格 App Token（即 spreadsheetToken）。 */
  spreadsheetToken: string
  /** 商品表格 ID。 */
  productTableId: string
  /** 商家表格 ID（可选）。 */
  sellerTableId?: string
}

/** 飞书字段映射配置（与旧版 PRODUCT_SCHEMA 对齐）。 */
export interface FeishuFieldConfig {
  name: string
  type: number // 1: 文本, 2: 数字, 5: 日期, 15: 超链接
}

/** 飞书表格中的真实字段（读取结果，含类型）。 */
export interface FeishuTableField {
  name: string
  /** 飞书字段类型（1 文本 / 2 数字 / 5 日期 / 15 超链接 等）。 */
  type: number
}

/**
 * 归一化飞书商品去重组合键（读写共用，单一来源）。
 *
 * 组合键格式：`${itemId}_${wantCnt}_${price}`；数字字段统一 `Number(x) || 0` 归一，
 * 避免“读侧拼原始值、写侧拼归一值”不一致导致去重失效。
 */
export function buildFeishuProductDedupeKey(itemId: unknown, wantCnt: unknown, price: unknown): string {
  return `${String(itemId ?? '')}_${Number(wantCnt) || 0}_${Number(price) || 0}`
}

/** 飞书错误分类。 */
export type FeishuErrorCategory =
  | 'AUTH_FAILED'      // 鉴权失败 / 凭证错误
  | 'RATE_LIMITED'     // 请求频率超限
  | 'NOT_FOUND'        // 表格/字段不存在
  | 'INVALID_PARAM'    // 参数校验失败
  | 'BATCH_TOO_LARGE'  // 单批次超过限制
  | 'NETWORK_ERROR'    // 网络传输异常
  | 'API_ERROR'        // 飞书接口返回业务错误

/** 飞书结构化错误，屏蔽敏感 secret。 */
export class FeishuError extends Error {
  readonly category: FeishuErrorCategory
  readonly feishuCode?: number

  constructor(message: string, category: FeishuErrorCategory, feishuCode?: number) {
    super(message)
    this.name = 'FeishuError'
    this.category = category
    this.feishuCode = feishuCode
  }
}

/** 飞书字段配置映射（对齐旧版 PRODUCT_SCHEMA）。 */
export const FEISHU_PRODUCT_FIELD_CONFIGS: FeishuFieldConfig[] = [
  { name: '商品ID', type: 1 },
  { name: '商品标题', type: 1 },
  { name: '价格', type: 2 },
  { name: '原价', type: 2 },
  { name: '想要人数', type: 2 },
  { name: '发布时间', type: 5 },
  { name: '采集时间', type: 5 },
  { name: '卖家昵称', type: 1 },
  { name: '地区', type: 1 },
  { name: '包邮', type: 1 },
  { name: '商品标签', type: 1 },
  { name: '封面URL', type: 15 },
  { name: '商品详情URL', type: 15 },
]

/** 飞书 API 批量记录最大条数限制（官方硬上限 500 条）。 */
export const FEISHU_MAX_BATCH_SIZE = 500
