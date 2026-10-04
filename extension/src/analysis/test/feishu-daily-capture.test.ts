/** 每日采集的端到端 HTTP 模拟：建表、补字段、重试去重、关键字检索与跨表分页。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDailyCaptureFeishuSync } from '../../background/capture-feishu-sync'
import { createFeishuProductsRuntime } from '../../background/feishu-products-runtime'
import { MemoryFeishuConfigStore } from '../../data-source/feishu-config-store'
import { captureDate, buildCaptureDedupeKey, FEISHU_CAPTURE_FIELD_CONFIGS } from '../../../../shared/data-source/feishu-daily-tables'
import { FeishuDataSource } from '../../../../shared/data-source/feishu-data-source'
import type { FeishuConfig, HttpTransport } from '../../../../shared/data-source/feishu-types'
import type { Product } from '../../../../shared/types/product'
import { CommandTypes, createCommand } from '@fishops/shared'

const CONFIG: FeishuConfig = { appId: 'app', appSecret: 'secret-hidden', spreadsheetToken: 'base-hidden', productTableId: 'legacy' }
const NOW = Date.parse('2026-10-05T12:00:00+08:00')
const stamp = (date: string) => Date.parse(`${date}+08:00`)

function product(time: number, keyword = '手机', itemId = 'A'): Product {
  return { itemId, title: `商品${itemId}`, price: '¥10', priceNumber: 10, originalPrice: '', originalPriceNumber: 0, wantCnt: 1, publishTime: '', publishTimeMs: 0, captureTime: '', captureTimeMs: time, captureKeyword: keyword, sellerNick: '', sellerCity: '', freeShip: '否', tags: '', coverUrl: '', detailUrl: '', desc: '当次描述' }
}

interface Table {
  table_id: string
  name: string
  fields: Array<{ field_name: string; type: number }>
  records: Array<{ record_id: string; fields: Record<string, unknown> }>
}

function harness() {
  const tables: Table[] = [{ table_id: 'legacy', name: '原商品表', fields: [], records: [] }]
  const calls: Array<{ path: string; method: string; body: Record<string, any> }> = []
  const faults = { loseBatchResponse: false, emptyBatchResponse: false, loseCreateResponse: false, denyList: false, repeatToken: false }
  let nextRecord = 0
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
  const transport: HttpTransport = {
    async fetch(raw, init) {
      const url = new URL(raw)
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
      const method = init?.method ?? 'GET'
      calls.push({ path: url.pathname, method, body })
      if (url.pathname.includes('/tenant_access_token/')) return json({ code: 0, tenant_access_token: 'token-hidden', expire: 7200 })
      const tail = url.pathname.split('/tables')[1]!
      if (tail === '' && method === 'GET') {
        if (faults.denyList) return json({ code: 999, msg: CONFIG.appSecret })
        // 强制分成小页，确保实现不是只看数据表列表首页。
        const offset = Number(url.searchParams.get('page_token') ?? 0)
        return json({ code: 0, data: { items: tables.slice(offset, offset + 1), has_more: offset + 1 < tables.length, page_token: String(offset + 1) } })
      }
      if (tail === '' && method === 'POST') {
        const table = { table_id: `tbl${tables.length}`, name: body.table.name, fields: body.table.fields, records: [] }
        tables.push(table)
        if (faults.loseCreateResponse) { faults.loseCreateResponse = false; throw new Error(`network ${CONFIG.spreadsheetToken}`) }
        return json({ code: 0, data: { table_id: table.table_id } })
      }
      const [id, kind, action] = tail.split('/').slice(1)
      const table = tables.find((item) => item.table_id === id)
      assert.ok(table, `未预期的数据表 ${id}`)
      if (kind === 'fields') {
        if (method === 'POST') table.fields.push(body as Table['fields'][number])
        return json({ code: 0, data: { items: table.fields, has_more: false } })
      }
      if (action === 'batch_create') {
        const created = body.records.map((item: { fields: Record<string, unknown> }) => ({ record_id: `rec${++nextRecord}`, fields: item.fields }))
        table.records.push(...created)
        if (faults.emptyBatchResponse) { faults.emptyBatchResponse = false; return json({ code: 0, data: {} }) }
        if (faults.loseBatchResponse) { faults.loseBatchResponse = false; throw new Error(`network ${CONFIG.spreadsheetToken}`) }
        return json({ code: 0, data: { records: created } })
      }
      if (action && action !== 'search') {
        const record = table.records.find((item) => item.record_id === action)
        return record ? json({ code: 0, data: { record } }) : json({ code: 1254005 })
      }
      let records = [...table.records]
      if (body.filter) records = records.filter((record) => body.filter.conditions.some((condition: { field_name: string; value: string[] }) => String(record.fields[condition.field_name] ?? '').includes(condition.value[0]!)))
      if (body.sort) records.sort((a, b) => {
        for (const sort of body.sort) {
          const diff = Number(a.fields[sort.field_name]) - Number(b.fields[sort.field_name])
          if (diff) return sort.desc ? -diff : diff
        }
        return 0
      })
      const offset = Number(url.searchParams.get('page_token') ?? 0)
      const size = Number(url.searchParams.get('page_size') ?? 20)
      return json({ code: 0, data: { items: records.slice(offset, offset + size), total: records.length, has_more: offset + size < records.length, page_token: String(faults.repeatToken ? offset : offset + size) } })
    },
  }
  const store = new MemoryFeishuConfigStore(CONFIG)
  const sync = createDailyCaptureFeishuSync({ feishuConfigStore: store, transport, now: () => NOW })
  const runtime = createFeishuProductsRuntime({ feishuConfigStore: store, transport, now: () => NOW })
  return { tables, calls, faults, transport, store, sync, runtime }
}

test('北京时间日期与小时唯一键不受本机时区影响，关键字分别标识记录', () => {
  assert.equal(captureDate(Date.parse('2026-10-04T16:00:00Z')), '2026-10-05')
  assert.equal(buildCaptureDedupeKey('A', stamp('2026-10-05T10:01:00'), '手机'), buildCaptureDedupeKey('A', stamp('2026-10-05T10:59:59'), '手机'))
  assert.notEqual(buildCaptureDedupeKey('A', stamp('2026-10-05T10:01:00'), '手机'), buildCaptureDedupeKey('A', stamp('2026-10-05T10:01:00'), '平板'))
})

test('当天建表并追加：同商品同小时同关键字跳过，跨小时或关键字新增，旧表不写入', async () => {
  const h = harness()
  const first = product(stamp('2026-10-04T10:01:00'))
  assert.deepEqual(await h.sync([first]), { createdCount: 1, skippedCount: 0 })
  const newer = { ...product(stamp('2026-10-04T10:59:00')), priceNumber: 88 }
  assert.deepEqual(await h.sync([newer, product(stamp('2026-10-04T11:00:00')), product(first.captureTimeMs, '平板')]), { createdCount: 2, skippedCount: 1 })
  assert.equal(h.tables.length, 2)
  const table = h.tables[1]!
  assert.equal(table.name, '商品采集_2026-10-04')
  assert.equal(table.records[0]!.fields['价格'], 10)
  assert.equal(table.records[0]!.fields['商品描述'], '当次描述')
  assert.equal(table.records[0]!.fields['采集关键字'], '手机')
  assert.equal(h.tables[0]!.records.length, 0)
  assert.deepEqual(table.fields.map((field) => field.field_name), FEISHU_CAPTURE_FIELD_CONFIGS.map((field) => field.name))
})

test('响应丢失后重试：已创建的表与记录被复用，昨天采集仍写昨天', async () => {
  const h = harness()
  h.faults.loseCreateResponse = true
  h.faults.loseBatchResponse = true
  const items = [product(stamp('2026-10-04T23:59:59'))]
  await assert.rejects(h.sync(items), (error: Error) => error.message.includes('网络') && !error.message.includes(CONFIG.spreadsheetToken))
  assert.deepEqual(await h.sync(items), { createdCount: 0, skippedCount: 1 })
  assert.equal(h.tables.length, 2)
  assert.equal(h.tables[1]!.records.length, 1)
  assert.equal(h.tables[1]!.name, '商品采集_2026-10-04')
})

test('批量接口响应缺少 records 但记录已落库：重新核对唯一键后视为成功', async () => {
  const h = harness()
  h.faults.emptyBatchResponse = true
  assert.deepEqual(await h.sync([product(NOW)]), { createdCount: 1, skippedCount: 0 })
  assert.equal(h.tables[1]!.records.length, 1)
  assert.deepEqual(await h.sync([product(NOW)]), { createdCount: 0, skippedCount: 1 })
})

test('自动补字段，类型冲突停止，查表失败不会建表且不泄露凭据', async () => {
  const h = harness()
  const table: Table = { table_id: 'today', name: '商品采集_2026-10-05', fields: [{ field_name: '商品ID', type: 1 }], records: [] }
  h.tables.push(table)
  await h.sync([product(NOW)])
  assert.equal(table.fields.length, FEISHU_CAPTURE_FIELD_CONFIGS.length)
  table.fields.find((field) => field.field_name === '商品描述')!.type = 2
  await assert.rejects(h.sync([product(NOW, '其它')]), /商品描述.*类型不兼容/)
  assert.equal(table.records.length, 1)
  h.faults.denyList = true
  await assert.rejects(h.sync([product(NOW)]), (error: Error) => !error.message.includes(CONFIG.appSecret))
  assert.equal(h.tables.length, 2)
})

test('分页按采集时间倒序展示今天和昨天全部记录，关键字服务端搜索，保留每行来源表', async () => {
  const h = harness()
  await h.sync([product(stamp('2026-10-03T10:00:00')), product(stamp('2026-10-04T11:00:00')), product(stamp('2026-10-05T10:00:00')), product(stamp('2026-10-05T11:00:00'), '平板')])
  const first = await h.runtime.dailyPage({ pageSize: 1 })
  assert.equal(first.total, 3)
  assert.equal(first.rows[0]!['采集关键字'], '平板')
  assert.ok(first.rows[0]!['targetTableId'])
  const second = await h.runtime.dailyPage({ pageSize: 1, pageToken: first.nextPageToken!, targetTableId: first.targetTableId })
  const third = await h.runtime.dailyPage({ pageSize: 1, pageToken: second.nextPageToken!, targetTableId: second.targetTableId })
  assert.equal(third.hasMore, false)
  assert.notEqual(first.rows[0]!['recordId'], second.rows[0]!['recordId'])
  assert.notEqual(second.rows[0]!['targetTableId'], third.rows[0]!['targetTableId'])
  const back = await h.runtime.dailyPage({ pageSize: 1, pageToken: first.nextPageToken!, targetTableId: first.targetTableId })
  assert.deepEqual(back.rows, second.rows)
  const filtered = await h.runtime.dailyPage({ keyword: '平板' })
  assert.equal(filtered.rows.length, 1)
  const search = h.calls.filter((call) => call.path.endsWith('/search')).at(-1)!
  assert.ok(search.body.filter.conditions.some((condition: { field_name: string }) => condition.field_name === '采集关键字'))
  assert.equal(JSON.stringify(first).includes(CONFIG.spreadsheetToken), false)
  const remote = await h.runtime.handleCommand(createCommand(CommandTypes.FEISHU_PRODUCT_GET, { recordId: String(first.rows[0]!['recordId']), targetTableId: String(first.rows[0]!['targetTableId']) }))
  assert.equal(remote.ok, true)
})

test('跨表其它排序合并分页、游标条件绑定与配置漂移校验', async () => {
  const h = harness()
  await h.sync([{ ...product(stamp('2026-10-04T10:00:00')), wantCnt: 100 }, { ...product(NOW, '其它'), wantCnt: 3 }])
  const first = await h.runtime.dailyPage({ pageSize: 1, order: 'wantCntDesc' })
  assert.equal(first.rows[0]!['想要人数'], 100)
  await assert.rejects(h.runtime.dailyPage({ pageSize: 1, pageToken: first.nextPageToken!, targetTableId: first.targetTableId, keyword: '其它' }), /查询条件变化/)
  await h.store.save({ ...CONFIG, appSecret: 'rotated-secret' })
  await assert.rejects(h.runtime.dailyPage({ pageSize: 1, order: 'wantCntDesc', pageToken: first.nextPageToken!, targetTableId: first.targetTableId }), /查询条件变化/)
})

test('数据表不存在时返回空商品库，不读取原配置商品表', async () => {
  const h = harness()
  assert.deepEqual(await h.runtime.dailyPage({}), { rows: [], hasMore: false, total: 0, targetTableId: 'daily:2026-10-05:' })
  assert.equal(h.calls.filter((call) => call.path.includes('/records')).length, 0)
  assert.deepEqual(await h.sync([]), { createdCount: 0, skippedCount: 0 })
})

test('只配置多维表格即可建每日表，连接测试不创建表', async () => {
  const h = harness()
  await h.store.save({ ...CONFIG, productTableId: '' })
  const source = new FeishuDataSource({ config: (await h.store.load())!, transport: h.transport })
  const schema = await source.getSchema()
  assert.ok(schema.fields.some((field) => field.name === '采集关键字'))
  assert.equal(h.tables.length, 1)
  await h.sync([product(NOW)])
  assert.equal((await h.runtime.dailyPage({})).rows.length, 1)
})

test('本扩展并发同步串行化，已中止任务不发写入请求', async () => {
  const h = harness()
  const results = await Promise.all([h.sync([product(NOW)]), h.sync([product(NOW)])])
  assert.equal(results.reduce((sum, result) => sum + result.createdCount, 0), 1)
  await assert.rejects(h.sync([product(NOW, '取消')], async () => false), /已中止/)
  assert.equal(h.tables[1]!.records.length, 1)
})

test('严格去重分页不推进时拒绝写入，避免无限循环', async () => {
  const h = harness()
  await h.sync(Array.from({ length: 501 }, (_, index) => product(NOW, '手机', String(index))))
  h.faults.repeatToken = true
  const source = new FeishuDataSource({ config: CONFIG, transport: h.transport })
  await assert.rejects(source.getExistingCaptureKeysStrict(h.tables[1]!.table_id), /分页游标异常/)
})
