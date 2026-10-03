/**
 * 数据源统一抽象接口（P7）。
 *
 * 为本地商品库、飞书多维表格等不同数据提供方建立一致的获取元结构与查询标准。
 */
import type { Dataset, DatasetSchema } from '../types/dataset'

/** 数据源接口规范。 */
export interface DataSource {
  /** 数据源唯一类型标识（如 'local'、'feishu'）。 */
  readonly type: string
  /** 数据源名称。 */
  readonly name: string
  /** 获取当前数据源的字段 Schema。 */
  getSchema(): Promise<DatasetSchema>
  /** 按条件执行查询并生成规范 Dataset。 */
  query(params?: unknown): Promise<Dataset>
}
