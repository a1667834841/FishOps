/** 近两个自然日的飞书商品分页：服务端过滤，最多合并两张表的分页缓冲，不拉取全表。 */
import type { FeishuDataSource, FeishuSearchRecordsResult } from '../../../shared/data-source/feishu-data-source'
import { captureDate, FEISHU_CAPTURE_TABLE_PREFIX } from '../../../shared/data-source/feishu-daily-tables'
import { extractFeishuNumber, extractFeishuText, extractFeishuTimeMs, flattenFeishuRecord } from '../../../shared/data-source/feishu-product-mapping'
import { FeishuError } from '../../../shared/data-source/feishu-types'
import { FEISHU_PRODUCTS_DEFAULT_PAGE_SIZE, type FeishuProductsPagePayload, type FeishuProductsPageResult, type FeishuProductsOrder } from '../../../shared/types/feishu-products'

type RecordItem = FeishuSearchRecordsResult['items'][number]
interface TablePage {
  tableId: string
  items: RecordItem[]
  hasMore: boolean
  started: boolean
  pageToken?: string
  total?: number
  visited: string[]
}
interface CursorState {
  identity: string
  scope: string
  keyword: string
  order: FeishuProductsOrder
  pageSize: number
  tables: TablePage[]
  expiresAt: number
}

/** 可重用游标保留未消费的服务端分页；回翻不会修改已保存游标。Worker 重启后需刷新。 */
export function createDailyProductsPager(now: () => number) {
  const cursors = new Map<string, CursorState>()
  const ttl = 10 * 60_000

  function compare(a: RecordItem, b: RecordItem, order: FeishuProductsOrder): number {
    const timeDiff = extractFeishuTimeMs(b.fields['采集时间']) - extractFeishuTimeMs(a.fields['采集时间'])
    if (order === 'captureTimeAsc') return -timeDiff
    if (order === 'wantCntDesc') return extractFeishuNumber(b.fields['想要人数']) - extractFeishuNumber(a.fields['想要人数']) || timeDiff
    if (order === 'priceAsc' || order === 'priceDesc') {
      const diff = extractFeishuNumber(a.fields['价格']) - extractFeishuNumber(b.fields['价格'])
      return (order === 'priceDesc' ? -diff : diff) || timeDiff
    }
    if (order === 'titleAsc' || order === 'titleDesc') {
      const diff = extractFeishuText(a.fields['商品标题']).localeCompare(extractFeishuText(b.fields['商品标题']))
      return order === 'titleDesc' ? -diff : diff
    }
    return timeDiff
  }

  return async (source: FeishuDataSource, identity: string, payload: FeishuProductsPagePayload): Promise<FeishuProductsPageResult> => {
    for (const [key, state] of cursors) if (state.expiresAt <= now()) cursors.delete(key)
    const currentTime = now()
    const today = captureDate(currentTime)
    const names = [today, captureDate(currentTime - 24 * 3600_000)].map((date) => `${FEISHU_CAPTURE_TABLE_PREFIX}${date}`)
    const available = await source.listTables()
    const tables = names.flatMap((name) => {
      const matches = available.filter((table) => table.name === name)
      if (matches.length > 1) throw new FeishuError('每日采集表名称重复，请整理表名后刷新', 'INVALID_RESPONSE')
      return matches
    })
    // 这是分页范围标识，不是单条商品的来源表 ID；行内另带真实 targetTableId。
    const scope = `daily:${today}:${tables.map((table) => table.tableId).join(',')}`
    const pageSize = payload.pageSize ?? FEISHU_PRODUCTS_DEFAULT_PAGE_SIZE
    const keyword = payload.keyword?.trim() ?? ''
    const order = !payload.order || payload.order === 'default' ? 'captureTimeDesc' : payload.order
    if (payload.targetTableId && payload.targetTableId !== scope) throw new FeishuError('商品库日期范围或目标表已变化，请刷新后重试', 'INVALID_PARAM')
    const saved = payload.pageToken ? cursors.get(payload.pageToken) : undefined
    if (payload.pageToken && (!saved || saved.identity !== identity || saved.scope !== scope || saved.keyword !== keyword || saved.order !== order || saved.pageSize !== pageSize)) {
      throw new FeishuError('商品库分页已失效或查询条件变化，请刷新后重试', 'INVALID_PARAM')
    }
    const state: CursorState = saved
      ? { ...saved, tables: saved.tables.map((table) => ({ ...table, items: [...table.items], visited: [...table.visited] })) }
      : { identity, scope, keyword, order, pageSize, expiresAt: now() + ttl, tables: tables.map((table) => ({ tableId: table.tableId, items: [], hasMore: true, started: false, visited: [] })) }

    async function fill(table: TablePage): Promise<void> {
      let attempts = 0
      while (table.items.length === 0 && table.hasMore) {
        if (++attempts > 10) throw new FeishuError('飞书分页连续返回空页，请刷新后重试', 'INVALID_RESPONSE')
        const result = await source.searchRecordsOnce(table.tableId, { pageSize, keyword, order, includeCaptureKeyword: true, ...(table.pageToken ? { pageToken: table.pageToken } : {}) })
        if (result.hasMore && (!result.pageToken || table.visited.includes(result.pageToken))) throw new FeishuError('飞书分页游标未推进', 'INVALID_RESPONSE')
        if (!table.started && result.total !== undefined) table.total = result.total
        table.started = true
        table.items = result.items
        table.hasMore = result.hasMore
        table.pageToken = result.pageToken
        if (result.pageToken) table.visited.push(result.pageToken)
      }
    }

    const rows: FeishuProductsPageResult['rows'] = []
    await Promise.all(state.tables.map(fill))
    while (rows.length < pageSize) {
      const candidates = state.tables.filter((table) => table.items.length > 0)
      if (candidates.length === 0) break
      candidates.sort((a, b) => compare(a.items[0]!, b.items[0]!, order))
      const table = candidates[0]!
      const record = table.items.shift()!
      rows.push({ ...flattenFeishuRecord(record.record_id, record.fields), targetTableId: table.tableId })
      if (rows.length < pageSize) await fill(table)
    }
    const hasMore = state.tables.some((table) => table.items.length > 0 || table.hasMore)
    const result: FeishuProductsPageResult = { rows, hasMore, targetTableId: scope }
    if (state.tables.every((table) => typeof table.total === 'number' && Number.isFinite(table.total) && table.total >= 0)) {
      result.total = state.tables.reduce((sum, table) => sum + table.total!, 0)
    }
    if (hasMore) {
      while (cursors.size >= 64) cursors.delete(cursors.keys().next().value!)
      const token = `daily_${crypto.randomUUID()}`
      state.expiresAt = now() + ttl
      cursors.set(token, state)
      result.nextPageToken = token
    }
    return result
  }
}
