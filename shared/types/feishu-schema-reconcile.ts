/**
 * 飞书表字段 ↔ 本地商品库字段 schema reconciliation 领域类型（P7 字段同步后台）。
 *
 * 安全与边界（硬性）：
 * - 目标表固定为已配置的 `productTableId`，命令**不接受**任意 tableId（目标表绑定）。
 * - 预览 / 执行两阶段：执行必须携带一次性 `previewId` + `confirm: true`，并复验目标配置未变。
 * - 目标为**并集**（本地字段 ∪ 飞书字段），不是破坏性覆盖；缺失字段由显式同步命令创建。
 * - 同名类型冲突不静默覆盖：需显式 `acceptTypeConflicts: true` 才继续（且仍不自动改类型）。
 * - 删除字段绝不自动执行；仅飞书存在的字段只做报告。
 * - 结果 / 错误**绝不包含** appSecret / token / spreadsheetToken 等凭据。
 */
import type { FeishuProductWriteFieldTypeConflict } from './feishu-write'
import type {
  FeishuSchemaApiCapability,
  FeishuSchemaReconcileStrategy,
} from '../data-source/feishu-schema-reconcile'

/** 单个 previewId 的长度上限。 */
export const FEISHU_SCHEMA_RECONCILE_MAX_PREVIEW_ID_LENGTH = 128

/** 字段同步预览有效期（毫秒）：到期后执行需重新预览。 */
export const FEISHU_SCHEMA_RECONCILE_PREVIEW_TTL_MS = 5 * 60 * 1000

/**
 * 字段同步 · 预览请求负载（只读）。
 *
 * 严格空负载：目标表来自已配置商品表，字段目标来自本地商品库投影与并集策略，
 * 命令不接受任何可改变目标 / 策略的参数，杜绝越权指定任意表或字段。
 */
export type FeishuProductSchemaReconcilePreviewPayload = Record<string, never>

/**
 * 字段同步 · 执行请求负载（显式确认 + 绑定预览）。
 *
 * 仅接受 `previewId` / `confirm` / `acceptTypeConflicts`：目标与字段目标由预览阶段缓存并复验。
 */
export interface FeishuProductSchemaReconcileExecutePayload {
  /** 预览返回的短期 previewId（一次性，执行后失效）。 */
  previewId: string
  /** 必须为字面 `true`：显式确认执行真实字段变更。 */
  confirm: true
  /**
   * 显式确认「已知悉并接受同名类型冲突」。
   *
   * 仅当预览返回 `typeConflicts` 时才有意义；缺省时一旦存在类型冲突即整体拒绝执行。
   * 即使确认，也**不会**自动覆盖飞书字段类型（飞书类型变更不安全），仅继续创建缺失字段并返回人工建议。
   */
  acceptTypeConflicts?: boolean
}

/** 需创建的飞书字段规格（非敏感）。 */
export interface FeishuSchemaReconcileFieldSpec {
  name: string
  type: number
}

/** 字段同步 · 预览结果（只读，不产生任何字段写入）。 */
export interface FeishuProductSchemaReconcilePreviewResult {
  /** 短期预览 ID：执行时必须回传，且目标配置不得变化。 */
  previewId: string
  /** 预览过期时间戳（毫秒）；过期后需重新预览。 */
  expiresAt: number
  /** 目标商品表 ID（来自已配置项，非任意表）。 */
  targetTableId: string
  /** 采用的策略：固定为并集（UNION），而非破坏性覆盖。 */
  strategy: FeishuSchemaReconcileStrategy
  /** 目标并集字段总数（本地投影 ∪ 飞书实际）。 */
  targetFieldCount: number
  /** 本地投影字段数。 */
  localFieldCount: number
  /** 飞书表实际字段数。 */
  feishuFieldCount: number
  /** 需显式创建的缺失字段（并集补充）。 */
  toCreate: FeishuSchemaReconcileFieldSpec[]
  /** 已一致字段名。 */
  inSync: string[]
  /** 同名类型冲突（需显式确认，绝不静默覆盖）。 */
  typeConflicts: FeishuProductWriteFieldTypeConflict[]
  /** 仅飞书存在、本地未声明的字段名（仅审计，绝不删除）。 */
  feishuOnly: string[]
  /** 是否存在需用户显式确认的类型冲突。 */
  requiresConfirmation: boolean
  /** 不存在类型冲突时可直接安全执行（否则须显式确认）。 */
  canAutoApply: boolean
  /** 飞书字段 API 能力与安全边界（可创建 / 不可安全改类型 / 绝不删除），供 UI 展示。 */
  fieldApiCapability: FeishuSchemaApiCapability
  /** 人工操作建议（非敏感，供 UI 直接展示）。 */
  manualActions: string[]
}

/** 字段同步 · 执行结果（结构化，非敏感）。 */
export interface FeishuProductSchemaReconcileExecuteResult {
  /** 回显本次执行绑定的预览 ID。 */
  previewId: string
  targetTableId: string
  strategy: FeishuSchemaReconcileStrategy
  targetFieldCount: number
  localFieldCount: number
  feishuFieldCount: number
  /** 本次实际创建的字段名（幂等：仅创建当时仍缺失的字段）。 */
  createdFields: string[]
  /** 创建时已存在、幂等跳过的字段名。 */
  skippedExistingFields: string[]
  /** 执行时仍存在的类型冲突（未被自动覆盖，需人工处理）。 */
  typeConflicts: FeishuProductWriteFieldTypeConflict[]
  /** 仅飞书存在字段名（未删除）。 */
  feishuOnly: string[]
  /** 人工操作建议（非敏感）。 */
  manualActions: string[]
}

/** 字段同步失败分类（结构化错误 `category`，非敏感）。 */
export type FeishuSchemaReconcileFailureCategory =
  | 'CONFIG_MISSING'
  | 'INVALID_PAYLOAD'
  | 'INTERNAL'
  | 'BUSY'
