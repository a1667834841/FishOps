/**
 * 数据集与数据源通用类型定义（P7）。
 *
 * 为 Workbench 与 Extension 统一规范数据源 schema、行列格式、过滤条件与安全边界，
 * 限制查询数据量与单字段文本长度，防止内存超载与无限数据。
 */

/** 字段数据类型。 */
export type DatasetFieldType = 'string' | 'number' | 'boolean' | 'datetime' | 'url'

/** 单个字段定义。 */
export interface DatasetFieldSchema {
  /** 字段内部唯一标识。 */
  name: string
  /** 字段显示名称。 */
  label: string
  /** 字段类型。 */
  type: DatasetFieldType
  /** 字段描述或说明。 */
  description?: string
  /** 是否为必填/核心字段。 */
  required?: boolean
}

/** 数据集结构定义。 */
export interface DatasetSchema {
  /** 结构唯一名称。 */
  name: string
  /** 结构中文展示名。 */
  label: string
  /** 包含的所有字段列表。 */
  fields: DatasetFieldSchema[]
  /** 结构说明。 */
  description?: string
}

/** 单行记录类型。 */
export type DatasetRow = Record<string, unknown>

/** 标准数据集。 */
export interface Dataset {
  /** 数据集结构。 */
  schema: DatasetSchema
  /** 数据行记录列表。 */
  rows: DatasetRow[]
  /** 匹配的总记录数（可能受 limit 影响大于 rows.length）。 */
  total: number
  /** 数据来源标识（如 'local'、'feishu'）。 */
  source: 'local' | 'feishu' | string
  /** 数据查询生成时间戳（毫秒）。 */
  queriedAt: number
  /** 是否因安全上限发生了数据截断。 */
  truncated?: boolean
}

/** 数据过滤条件。 */
export interface DatasetFilter {
  /** 关键词检索（匹配标题、ID、昵称等）。 */
  keyword?: string
  /** 价格区间下限。 */
  minPrice?: number
  /** 价格区间上限。 */
  maxPrice?: number
  /** 想要人数下限。 */
  minWantCnt?: number
  /** 想要人数上限。 */
  maxWantCnt?: number
  /** 是否只看包邮。 */
  onlyFreeShip?: boolean
  /** 时间过滤基准字段。 */
  timeField?: 'publishTimeMs' | 'captureTimeMs'
  /** 起始时间戳（毫秒）。 */
  startTime?: number
  /** 结束时间戳（毫秒）。 */
  endTime?: number
  /** 最大返回条数。 */
  limit?: number
  /** 偏移量。 */
  offset?: number
}

/** 默认查询条数上限。 */
export const DATASET_DEFAULT_LIMIT = 50

/** 单次查询绝对最大条数上限（防止无限数据拖垮 Background/Workbench）。 */
export const DATASET_MAX_LIMIT = 500

/** 单个字符串字段的最大字符数限制，超过部分截断。 */
export const DATASET_MAX_TEXT_LENGTH = 1000
