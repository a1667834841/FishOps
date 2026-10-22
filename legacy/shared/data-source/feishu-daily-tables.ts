/** 飞书每日采集表的命名、北京时间归档与唯一键规则。 */
import type { FeishuDataSource } from './feishu-data-source'
import { FEISHU_PRODUCT_FIELD_CONFIGS, FeishuError, type FeishuConfig } from './feishu-types'

export const FEISHU_CAPTURE_TABLE_PREFIX = '商品采集_'
export const FEISHU_CAPTURE_FIELD_CONFIGS = [
  ...FEISHU_PRODUCT_FIELD_CONFIGS,
  { name: '采集关键字', type: 1 },
]

/** 返回北京时间日期；不受浏览器本地时区影响。 */
export function captureDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp < 0 || Number.isNaN(new Date(timestamp + 8 * 3600_000).getTime())) throw new FeishuError('采集时间无效', 'INVALID_PARAM')
  return new Date(timestamp + 8 * 3600_000).toISOString().slice(0, 10)
}

/** 商品 ID、北京时间采集小时与关键字共同标识一条采集记录。 */
export function buildCaptureDedupeKey(itemId: string, timestamp: number, keyword: string): string {
  captureDate(timestamp)
  return JSON.stringify([itemId, new Date(timestamp + 8 * 3600_000).toISOString().slice(0, 13), keyword])
}

/** 仅识别本功能约定命名的每日表。 */
export function isCaptureTableName(name: string): boolean {
  if (!/^商品采集_\d{4}-\d{2}-\d{2}$/.test(name)) return false
  const date = name.slice(FEISHU_CAPTURE_TABLE_PREFIX.length)
  const time = Date.parse(`${date}T00:00:00+08:00`)
  return Number.isFinite(time) && captureDate(time) === date
}

/** 单条素材读取只允许旧配置表或当前多维表格中的每日采集表。 */
export async function isAllowedProductTable(source: FeishuDataSource, config: FeishuConfig, tableId: string): Promise<boolean> {
  if (!tableId) return false
  if (tableId === config.productTableId) return true
  return (await source.listTables()).some((table) => table.tableId === tableId && isCaptureTableName(table.name))
}

/** 自动补齐缺失字段；类型冲突必须停止，禁止修改或删除用户已有字段。 */
export async function ensureCaptureTableFields(source: FeishuDataSource, tableId: string): Promise<void> {
  let fields = await source.getTableFields(tableId)
  const checkTypes = (): void => {
    for (const expected of FEISHU_CAPTURE_FIELD_CONFIGS) {
      const actual = fields.find((field) => field.name === expected.name)
      if (actual && actual.type !== expected.type) {
        throw new FeishuError(`每日采集表字段「${expected.name}」类型不兼容，请手动调整后恢复重试`, 'INVALID_PARAM')
      }
    }
  }
  checkTypes()
  const missing = FEISHU_CAPTURE_FIELD_CONFIGS.filter((field) => !fields.some((actual) => actual.name === field.name))
  if (missing.length > 0) await source.createTableFields(tableId, missing)
  fields = await source.getTableFields(tableId)
  checkTypes()
  if (FEISHU_CAPTURE_FIELD_CONFIGS.some((field) => !fields.some((actual) => actual.name === field.name))) {
    throw new FeishuError('每日采集表字段补充不完整，请恢复重试', 'INVALID_RESPONSE')
  }
}
