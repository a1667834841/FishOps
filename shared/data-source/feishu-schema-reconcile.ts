/**
 * 飞书表字段 ↔ 本地商品库字段 schema reconciliation（P7 字段同步，可审计）。
 *
 * 设计要点（硬性）：
 * 1. **目标为并集（UNION），不是破坏性覆盖**：目标字段集 = 本地商品库字段 ∪ 飞书表实际字段。
 *    「哪边字段更多」不做成「以多的一边为准、删掉/覆盖另一边」，而是把两边缺的字段补上，
 *    使一致性靠「并集补齐」达成，绝不以字段更多的一方作为破坏性来源。
 * 2. **本地字段投影**：本地 schema 用英文 name + 中文 label；飞书表以中文字段名为键。
 *    这里用显式映射把本地字段投影成飞书 (name, type)，映射关系集中、可审计。
 * 3. **同名类型冲突绝不静默覆盖**：类型不一致时产出结构化冲突，需调用方显式确认后才继续，
 *    且确认也不自动改类型（飞书字段类型变更受限/不安全，见 {@link FEISHU_SCHEMA_RECONCILE_CAPABILITY}）。
 * 4. **缺失字段只能由显式同步命令创建**：普通写入（FEISHU_PRODUCT_WRITE_*）依旧只做兼容性校验，
 *    绝不隐式创建字段；只有本模块的 reconciliation 执行阶段会创建缺失字段。
 * 5. **删除字段绝不自动执行**：仅在飞书存在、本地未声明的字段只做「报告」，不删除。
 *
 * 与飞书字段类型对照：1 文本 / 2 数字 / 5 日期 / 15 超链接。
 */
import type { DatasetFieldType, DatasetSchema } from '../types/dataset'
import type { FeishuFieldConfig, FeishuTableField } from './feishu-types'
import type { FeishuProductWriteFieldTypeConflict } from '../types/feishu-write'
import { LOCAL_PRODUCT_DATASET_SCHEMA } from './local-data-source'

/** 字段同步采用的策略：始终为并集，而非「以字段更多的一边为准」的破坏性覆盖。 */
export const FEISHU_SCHEMA_RECONCILE_STRATEGY = 'UNION' as const
export type FeishuSchemaReconcileStrategy = typeof FEISHU_SCHEMA_RECONCILE_STRATEGY

/**
 * 本地商品库字段 → 飞书字段名 的显式映射（可审计的单一来源）。
 *
 * 语义等价的字段做名称归一（如本地 `priceNumber` 对应飞书「价格」），语义不同的相近字段保留各自名字
 * （如本地 `price` 原文对应「价格原文」），避免把含义不同的字段错误合并成一个。
 * 未列出的本地字段回退使用其中文 label。
 */
export const LOCAL_TO_FEISHU_FIELD_NAME: Readonly<Record<string, string>> = {
  itemId: '商品ID',
  title: '商品标题',
  price: '价格原文',
  priceNumber: '价格',
  originalPrice: '原价原文',
  originalPriceNumber: '原价',
  wantCnt: '想要人数',
  publishTime: '发布时间原文',
  publishTimeMs: '发布时间',
  captureTime: '采集时间原文',
  captureTimeMs: '采集时间',
  sellerNick: '卖家昵称',
  sellerCity: '地区',
  freeShip: '包邮',
  tags: '商品标签',
  coverUrl: '封面URL',
  detailUrl: '商品详情URL',
  browseCnt: '浏览量',
  collectCnt: '收藏数',
}

/** 本地数据集字段类型 → 飞书字段类型（1 文本 / 2 数字 / 5 日期 / 15 超链接）。 */
export function mapDatasetTypeToFeishuType(type: DatasetFieldType): number {
  switch (type) {
    case 'number':
      return 2
    case 'datetime':
      return 5
    case 'url':
      return 15
    case 'boolean':
    case 'string':
    default:
      return 1
  }
}

/**
 * 把本地商品库 schema 投影为飞书字段配置（名称 + 类型的并集一侧）。
 *
 * 该投影同时覆盖既有 {@link FEISHU_PRODUCT_FIELD_CONFIGS} 的全部字段（名称与类型一致），
 * 因此在并集中本地侧只会「多出」本地独有字段，不会与写入必需字段产生名称级冲突。
 */
export function buildLocalProductFeishuProjection(
  schema: DatasetSchema = LOCAL_PRODUCT_DATASET_SCHEMA,
): FeishuFieldConfig[] {
  return schema.fields.map((field) => ({
    name: LOCAL_TO_FEISHU_FIELD_NAME[field.name] ?? field.label,
    type: mapDatasetTypeToFeishuType(field.type),
  }))
}

/** 本地商品库字段的飞书投影（默认来自 {@link LOCAL_PRODUCT_DATASET_SCHEMA}）。 */
export const LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION: FeishuFieldConfig[] =
  buildLocalProductFeishuProjection()

/** 单次一致性变更项的分类。 */
export type FeishuSchemaChangeKind =
  | 'CREATE'         // 目标并集要求，但飞书表缺失 → 需显式创建
  | 'TYPE_CONFLICT'  // 同名但类型不一致 → 需显式确认，绝不静默覆盖
  | 'IN_SYNC'        // 同名同类型 → 一致
  | 'FEISHU_ONLY'    // 仅飞书存在、本地未声明 → 仅报告，绝不删除

/** 单条字段一致性变更（非敏感，供审计）。 */
export interface FeishuSchemaChange {
  name: string
  kind: FeishuSchemaChangeKind
  /** 目标（期望）飞书类型；仅飞书存在时为 undefined。 */
  desiredType?: number
  /** 飞书表中实际类型；飞书缺失时为 undefined。 */
  actualType?: number
}

/** 飞书 schema 与本地投影的一致性 diff（只读描述，不含任何写入副作用）。 */
export interface FeishuSchemaDiff {
  /** 目标并集字段总数（本地投影 ∪ 飞书实际）。 */
  targetFieldCount: number
  /** 本地投影字段数。 */
  localFieldCount: number
  /** 飞书表实际字段数。 */
  feishuFieldCount: number
  /** 需显式创建的缺失字段（并集补充）。 */
  toCreate: FeishuFieldConfig[]
  /** 同名类型冲突（需显式确认，绝不静默覆盖）。 */
  typeConflicts: FeishuProductWriteFieldTypeConflict[]
  /** 已一致的字段名。 */
  inSync: string[]
  /** 仅飞书存在、本地未声明的字段名（仅报告，绝不删除）。 */
  feishuOnly: string[]
  /** 全部变更项（按「本地投影顺序 + 仅飞书字段」排列，供审计）。 */
  changes: FeishuSchemaChange[]
}

/**
 * 计算目标并集 schema 与飞书表实际 schema 的差异。
 *
 * 目标 = 本地投影 ∪ 飞书实际：本地投影缺失于飞书 → CREATE；类型不一致 → TYPE_CONFLICT；
 * 仅在飞书存在 → FEISHU_ONLY（仅报告）。同一字段绝不既出现在 toCreate 又出现在 typeConflicts。
 */
export function diffFeishuSchema(
  desired: FeishuFieldConfig[],
  actual: FeishuTableField[],
): FeishuSchemaDiff {
  const actualTypeByName = new Map(actual.map((field) => [field.name, field.type]))
  const desiredNameSet = new Set(desired.map((field) => field.name))

  const toCreate: FeishuFieldConfig[] = []
  const typeConflicts: FeishuProductWriteFieldTypeConflict[] = []
  const inSync: string[] = []
  const changes: FeishuSchemaChange[] = []

  for (const field of desired) {
    const actualType = actualTypeByName.get(field.name)
    if (actualType === undefined) {
      toCreate.push({ name: field.name, type: field.type })
      changes.push({ name: field.name, kind: 'CREATE', desiredType: field.type })
      continue
    }
    if (actualType !== field.type) {
      typeConflicts.push({ name: field.name, expectedType: field.type, actualType })
      changes.push({ name: field.name, kind: 'TYPE_CONFLICT', desiredType: field.type, actualType })
      continue
    }
    inSync.push(field.name)
    changes.push({ name: field.name, kind: 'IN_SYNC', desiredType: field.type, actualType })
  }

  const feishuOnly: string[] = []
  for (const field of actual) {
    if (desiredNameSet.has(field.name)) continue
    feishuOnly.push(field.name)
    changes.push({ name: field.name, kind: 'FEISHU_ONLY', actualType: field.type })
  }

  const targetFieldCount = new Set<string>([
    ...desired.map((field) => field.name),
    ...actual.map((field) => field.name),
  ]).size

  return {
    targetFieldCount,
    localFieldCount: desired.length,
    feishuFieldCount: actual.length,
    toCreate,
    typeConflicts,
    inSync,
    feishuOnly,
    changes,
  }
}

/** 飞书字段 API 能力与安全边界说明（供 UI 与审计展示）。 */
export interface FeishuSchemaApiCapability {
  /** 是否支持由本通道创建缺失字段（是）。 */
  canCreateField: boolean
  /**
   * 是否支持安全地更新已有字段类型（否）。
   *
   * 飞书 Bitable 字段类型变更受限（文本 / 数字 / 日期 / 超链接之间并非任意可互转，且可能损坏已有数据），
   * 因此类型冲突一律不自动覆盖，改为返回人工操作建议。
   */
  canUpdateFieldType: boolean
  /** 是否会自动删除字段（否，绝不删除）。 */
  canDeleteField: boolean
  /** 非敏感说明清单（供 UI 直接展示）。 */
  notes: string[]
}

/** 飞书字段同步的 API 能力与安全边界常量。 */
export const FEISHU_SCHEMA_RECONCILE_CAPABILITY: FeishuSchemaApiCapability = {
  canCreateField: true,
  canUpdateFieldType: false,
  canDeleteField: false,
  notes: [
    '缺失字段可通过字段同步命令显式创建（幂等，已存在则跳过）。',
    '同名类型冲突不会自动覆盖：请在飞书多维表格中手动调整字段类型，或改用同义字段后重新预览。',
    '仅飞书存在、本地未声明的字段不会被删除；如需保留请补充本地字段定义，否则请人工确认去留。',
    '普通商品写入不会隐式创建或修改字段，仅做写入前兼容性校验。',
  ],
}
