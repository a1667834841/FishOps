/** 采集按北京时间每日分表同步，保留旧配置表写入适配器供兼容调用。 */
import { CommandTypes, createCommand } from '@fishops/shared'
import { FEISHU_WRITE_MAX_ITEMS } from '../../../shared/types/feishu-write'
import type { FeishuProductWritePreviewResult, FeishuProductWriteExecuteResult } from '../../../shared/types/feishu-write'
import type { CaptureFeishuSyncResult } from '../../../shared/types/capture'
import type { FeishuWriteRuntime } from './feishu-write-runtime'
import { FeishuDataSource, type FeishuTable } from '../../../shared/data-source/feishu-data-source'
import {
  buildCaptureDedupeKey,
  captureDate,
  ensureCaptureTableFields,
  FEISHU_CAPTURE_FIELD_CONFIGS,
  FEISHU_CAPTURE_TABLE_PREFIX,
} from '../../../shared/data-source/feishu-daily-tables'
import { FeishuError, type HttpTransport } from '../../../shared/data-source/feishu-types'
import type { FeishuConfigStore } from '../data-source/feishu-config-store'
import type { Product } from '../../../shared/types/product'

/** 按原采集日期分表同步；实例内串行执行查表、建表、去重与写入，避免本扩展并发重复。 */
export function createDailyCaptureFeishuSync(deps: { feishuConfigStore: FeishuConfigStore; transport?: HttpTransport; now?: () => number }) {
  let pending: Promise<unknown> = Promise.resolve()

  async function sync(products: readonly Product[], shouldContinue: () => Promise<boolean>): Promise<CaptureFeishuSyncResult> {
    const summary = { createdCount: 0, skippedCount: 0 }
    if (products.length === 0) return summary
    const config = await deps.feishuConfigStore.load()
    if (!config) throw new Error('飞书未配置，请先在设置页配置多维表格')
    const source = new FeishuDataSource({ config, ...(deps.transport ? { transport: deps.transport } : {}), ...(deps.now ? { now: deps.now } : {}) })
    const check = async (): Promise<void> => {
      if (!(await shouldContinue())) throw new Error('飞书同步已中止')
      if (JSON.stringify(await deps.feishuConfigStore.load()) !== JSON.stringify(config)) throw new Error('飞书配置已变更，请恢复重试')
    }
    const groups = new Map<string, Product[]>()
    for (const product of products) {
      if (!product.itemId || !product.captureKeyword || !Number.isFinite(product.captureTimeMs) || product.captureTimeMs <= 0) {
        throw new Error('采集快照缺少商品 ID、原始时间或关键字，请重新采集')
      }
      const date = captureDate(product.captureTimeMs)
      const items = groups.get(date) ?? []
      items.push(product)
      groups.set(date, items)
    }
    await check()
    let tables = await source.listTables()
    for (const [date, items] of groups) {
      await check()
      const name = `${FEISHU_CAPTURE_TABLE_PREFIX}${date}`
      if (tables.filter((entry) => entry.name === name).length > 1) throw new FeishuError('每日采集表名称重复', 'INVALID_RESPONSE')
      let table: FeishuTable | undefined = tables.find((entry) => entry.name === name)
      if (!table) {
        await check()
        try {
          table = await source.createTable(name, FEISHU_CAPTURE_FIELD_CONFIGS)
          tables.push(table)
        } catch (error) {
          // 另一客户端可能刚建表；创建响应丢失时也先重新查，不能直接再次创建。
          if (!(error instanceof FeishuError) || (error.feishuCode !== 1254013 && error.category !== 'NETWORK_ERROR')) throw error
          tables = await source.listTables()
          table = tables.find((entry) => entry.name === name)
          if (!table) throw error
        }
      }
      await check()
      await ensureCaptureTableFields(source, table.tableId)
      await check()
      let existing: Set<string>
      try {
        existing = await source.getExistingCaptureKeysStrict(table.tableId)
      } catch (error) {
        // 飞书字段创建存在短暂可见性延迟；若记录查询先报 FieldNameNotFound，重新校验并补字段后再读一次。
        if (!(error instanceof FeishuError) || error.feishuCode !== 1254045) throw error
        await ensureCaptureTableFields(source, table.tableId)
        existing = await source.getExistingCaptureKeysStrict(table.tableId)
      }
      const toCreate: Product[] = []
      for (const product of items) {
        const key = buildCaptureDedupeKey(product.itemId, product.captureTimeMs, product.captureKeyword!)
        if (existing.has(key)) summary.skippedCount += 1
        else { existing.add(key); toCreate.push(product) }
      }
      for (let offset = 0; offset < toCreate.length; offset += FEISHU_WRITE_MAX_ITEMS) {
        await check()
        const batch = toCreate.slice(offset, offset + FEISHU_WRITE_MAX_ITEMS)
        const created = await source.batchCreateRecords(table.tableId, batch.map(FeishuDataSource.convertCapturedProductToFeishuRecord))
        const responseComplete = created.length === batch.length && created.every((record) => typeof record.record_id === 'string' && record.record_id.length > 0)
        if (!responseComplete) {
          // batch_create 可能已落库但响应丢失 / 不完整。重新读取唯一键，避免恢复时重复创建。
          const confirmed = await source.getExistingCaptureKeysStrict(table.tableId)
          const confirmedCount = batch.reduce(
            (count, product) => count + (confirmed.has(buildCaptureDedupeKey(product.itemId, product.captureTimeMs, product.captureKeyword!)) ? 1 : 0),
            0,
          )
          if (confirmedCount === batch.length) {
            summary.createdCount += batch.length
            continue
          }
          throw new Error(`飞书批量写入响应不完整，已确认 ${confirmedCount}/${batch.length} 条；恢复后会自动跳过已存在记录`)
        }
        summary.createdCount += created.length
      }
    }
    return summary
  }

  return (products: readonly Product[], shouldContinue: () => Promise<boolean> = async () => true): Promise<CaptureFeishuSyncResult> => {
    const request = pending.then(() => sync(products, shouldContinue)).catch((error: unknown) => {
      if (!(error instanceof FeishuError)) {
        const safeMessages = [
          '飞书未配置，请先在设置页配置多维表格', '飞书同步已中止', '飞书配置已变更，请恢复重试',
          '采集快照缺少商品 ID、原始时间或关键字，请重新采集', '飞书返回的写入数量不完整，请恢复重试',
        ]
        if (error instanceof Error && (safeMessages.includes(error.message) || error.message.startsWith('飞书批量写入响应不完整'))) throw error
        throw new Error('飞书网络或数据请求失败，请恢复重试')
      }
      // 结构错误已经是脱敏后的固定文案，保留它才能定位到底是表列表、字段还是记录响应异常。
      if (error.category === 'INVALID_RESPONSE' && error.message) throw new Error(error.message)
      if (error.feishuCode === 1254045) throw new Error('飞书每日采集表缺少请求字段，自动补齐后仍未生效，请检查表权限后恢复重试')
      // 底层网络异常可能包含带 app_token 的 URL，任务错误只能保存固定的非敏感提示。
      if (error.category === 'INVALID_PARAM' && error.message.startsWith('每日采集表字段「')) throw new Error(error.message)
      const messages: Partial<Record<FeishuError['category'], string>> = {
        AUTH_FAILED: '飞书鉴权失败，请检查应用配置后恢复重试',
        NETWORK_ERROR: '飞书网络请求失败，请恢复重试',
        INVALID_RESPONSE: '飞书返回结果不完整，请恢复重试',
        RATE_LIMITED: '飞书接口频率超限，请稍后恢复重试',
        INVALID_PARAM: '飞书采集数据或字段不兼容，请检查后恢复重试',
      }
      throw new Error(messages[error.category] ?? '飞书同步失败，请检查应用建表、字段与记录权限、多维表格编辑权限及表数量上限后恢复重试')
    })
    pending = request.catch(() => undefined)
    return request
  }
}

/** 旧配置表兼容适配器；实际采集运行时使用每日快照同步，不再调用此函数。 */
export async function syncCapturedProductsToFeishu(
  runtime: FeishuWriteRuntime,
  itemIds: string[],
  shouldContinue: () => Promise<boolean> = async () => true,
): Promise<CaptureFeishuSyncResult> {
  const uniqueIds = [...new Set(itemIds)]
  const summary = { createdCount: 0, skippedCount: 0 }
  for (let offset = 0; offset < uniqueIds.length; offset += FEISHU_WRITE_MAX_ITEMS) {
    if (!(await shouldContinue())) throw new Error('飞书同步已中止')
    const previewResponse = await runtime.handleCommand(createCommand(
      CommandTypes.FEISHU_PRODUCT_WRITE_PREVIEW,
      { itemIds: uniqueIds.slice(offset, offset + FEISHU_WRITE_MAX_ITEMS) },
    ))
    if (!previewResponse.ok) throw new Error(previewResponse.error?.message ?? '飞书写入预览失败')
    const preview = previewResponse.result as FeishuProductWritePreviewResult
    if (preview.missingItemIds.length > 0) throw new Error('本地采集商品缺失，请重新采集')
    // 采集动作已授权自动同步；继续使用执行阶段的目标、字段和组合键复验。
    if (!(await shouldContinue())) throw new Error('飞书同步已中止')
    const response = await runtime.handleCommand(createCommand(
      CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE,
      { previewId: preview.previewId, confirm: true },
    ))
    if (!response.ok) throw new Error(response.error?.message ?? '飞书写入失败')
    const result = response.result as FeishuProductWriteExecuteResult
    if (result.missingItemIds.length > 0 || result.createdCount + result.alreadyExistsItemIds.length !== result.uniqueCount) {
      throw new Error('飞书返回的写入数量不完整，请恢复后重试')
    }
    summary.createdCount += result.createdCount
    summary.skippedCount += result.alreadyExistsItemIds.length
  }
  return summary
}
