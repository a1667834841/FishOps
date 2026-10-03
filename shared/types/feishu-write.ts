/**
 * 飞书商品写入（导出到多维表格）领域类型（P7 后台写入通道）。
 *
 * 安全与边界（硬性）：
 * - 输入只接受**显式 itemIds**；目标表固定为已配置的 `productTableId`，命令绝不携带任意 tableId；
 *   网络出入口只有 `FeishuDataSource`（固定 `https://open.feishu.cn`），不得任意网络。
 * - **预览 / 执行两阶段绑定**：预览生成短期 `previewId` 并缓存目标配置与选品；
 *   执行必须携带 `previewId` 且 `confirm: true`，并严格复验目标配置、选品与去重未变。
 * - **绝不自动创建 / 修改飞书字段**：字段缺失或类型冲突时失败，并回可行动的非敏感信息。
 * - 结果与错误**绝不包含 appSecret / token / spreadsheetToken 等凭据**。
 */
import type { FeishuErrorCategory } from '../data-source/feishu-types'

/** 单次写入请求的商品数量上限（去重前），防止误操作大批量写入。 */
export const FEISHU_WRITE_MAX_ITEMS = 200

/** 单个 itemId 的长度上限。 */
export const FEISHU_WRITE_MAX_ITEM_ID_LENGTH = 128

/** 单个 previewId 的长度上限。 */
export const FEISHU_WRITE_MAX_PREVIEW_ID_LENGTH = 128

/** 预览有效期（毫秒）：到期后执行需重新预览。 */
export const FEISHU_WRITE_PREVIEW_TTL_MS = 5 * 60 * 1000

/** 预览请求负载（只读，不写入）。 */
export interface FeishuProductWritePreviewPayload {
  /** 显式指定的商品 itemId 列表（运行时去重，超量 / 空数组拒绝）。 */
  itemIds: string[]
}

/**
 * 执行请求负载（显式确认 + 绑定预览）。
 *
 * 只接受 `previewId`：选品与目标由预览阶段缓存并复验，杜绝执行期间替换选品。
 */
export interface FeishuProductWriteExecutePayload {
  /** 预览返回的短期 previewId（一次性，执行后失效）。 */
  previewId: string
  /** 必须为字面 `true`：显式确认执行真实写入。 */
  confirm: true
}

/** 预览中的待写入条目（非敏感摘要，供 UI 展示确认）。 */
export interface FeishuProductWritePreviewItem {
  itemId: string
  title: string
  /** 价格数值（解析失败为 0）。 */
  price: number
  /** 想要人数。 */
  wantCnt: number
}

/** 字段类型冲突项（非敏感，供 UI 提示手动调整）。 */
export interface FeishuProductWriteFieldTypeConflict {
  /** 字段名。 */
  name: string
  /** 期望的飞书字段类型。 */
  expectedType: number
  /** 表中实际的飞书字段类型。 */
  actualType: number
}

/** 飞书商品写入 · 预览结果（只读，不产生任何写入）。 */
export interface FeishuProductWritePreviewResult {
  /** 短期预览 ID：执行时必须回传，且目标配置 / 选品不得变化。 */
  previewId: string
  /** 预览过期时间戳（毫秒）；过期后需重新预览。 */
  expiresAt: number
  /** 目标商品表 ID（来自已配置项，非任意表）。 */
  targetTableId: string
  /** 原始请求条数（去重前）。 */
  requestedCount: number
  /** 去重后的唯一 itemId 数量。 */
  uniqueCount: number
  /** 入参中重复出现的 itemId（去重后仅保留一次）。 */
  duplicateItemIds: string[]
  /** 本地商品库中不存在的 itemId。 */
  missingItemIds: string[]
  /** 飞书表中已存在（商品组合键命中）而将跳过的 itemId。 */
  alreadyExistsItemIds: string[]
  /** 将写入的条目摘要。 */
  toCreate: FeishuProductWritePreviewItem[]
  /** 目标表字段是否兼容（缺失或类型冲突时为 false）。 */
  fieldCompatible: boolean
  /** 目标表缺少的必需字段名（非敏感，供 UI 提示手动补齐）。 */
  missingFields: string[]
  /** 目标表字段类型冲突列表（非敏感，供 UI 提示手动调整）。 */
  typeConflicts: FeishuProductWriteFieldTypeConflict[]
}

/** 飞书商品写入 · 执行结果（结构化，非敏感）。 */
export interface FeishuProductWriteExecuteResult {
  /** 回显本次执行绑定的预览 ID。 */
  previewId: string
  targetTableId: string
  requestedCount: number
  uniqueCount: number
  duplicateItemIds: string[]
  missingItemIds: string[]
  alreadyExistsItemIds: string[]
  /** 实际成功创建的商品记录数。 */
  createdCount: number
  /** 成功创建的飞书记录 ID 列表。 */
  createdRecordIds: string[]
  fieldCompatible: boolean
  missingFields: string[]
  typeConflicts: FeishuProductWriteFieldTypeConflict[]
}

/** 飞书写入失败分类（结构化错误 `category`，非敏感）。 */
export type FeishuWriteFailureCategory = FeishuErrorCategory | 'CONFIG_MISSING' | 'BUSY'
