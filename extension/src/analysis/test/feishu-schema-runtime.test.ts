/**
 * 飞书表字段同步后台运行时测试。
 *
 * 验证：
 * 1. 预览只读：并集目标、缺失字段、同名类型冲突、仅飞书存在字段分类正确，返回 previewId；
 * 2. 缺失字段只能由本显式命令创建（预览绝不 POST），创建幂等（重复执行不再创建）；
 * 3. 同名类型冲突缺省拒绝执行、需显式 acceptTypeConflicts 且绝不自动覆盖类型；
 * 4. 删除字段绝不自动执行（仅飞书字段只报告，无 DELETE 请求）；
 * 5. 执行的一次性 previewId、过期、目标表变更复验、串行并发保护；
 * 6. 未配置 / 响应绝不泄露 secret / token。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, createCommand } from '@fishops/shared'
import { createFeishuSchemaRuntime } from '../../background/feishu-schema-runtime'
import { MemoryFeishuConfigStore } from '../../data-source/feishu-config-store'
import {
  FEISHU_PRODUCT_FIELD_CONFIGS,
  type FeishuConfig,
  type HttpTransport,
} from '../../../../shared/data-source/feishu-types'
import { LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION } from '../../../../shared/data-source/feishu-schema-reconcile'
import type {
  FeishuProductSchemaReconcileExecuteResult,
  FeishuProductSchemaReconcilePreviewResult,
} from '../../../../shared/types/feishu-schema-reconcile'

const CONFIG: FeishuConfig = {
  appId: 'cli_app_id',
  appSecret: 'feishu-app-secret-value',
  spreadsheetToken: 'sheet-token-secret-value',
  productTableId: 'tbl_product',
}

/** 本地投影相对既有写入字段配置多出的字段（并集补充项）。 */
const LOCAL_ONLY_FIELDS = ['商品描述', '价格原文', '原价原文', '发布时间原文', '采集时间原文', '浏览量', '收藏数']

interface SchemaHarness {
  transport: HttpTransport
  /** 目标表字段（可变，模拟飞书端变化 / 已被创建）。 */
  fields: Array<{ field_name: string; type: number }>
  /** 本次经 POST 实际创建的字段名。 */
  createdFields: string[]
  fieldPosts: number
  /** DELETE 请求次数（应为 0：绝不删除字段）。 */
  deletes: number
  release?: () => void
}

function defaultFields(): Array<{ field_name: string; type: number }> {
  return FEISHU_PRODUCT_FIELD_CONFIGS
    .filter((field) => field.name !== '商品描述')
    .map((field) => ({ field_name: field.name, type: field.type }))
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** 构造可注入的飞书字段 HTTP Mock。 */
function createHarness(
  options: { fields?: Array<{ field_name: string; type: number }>; deferCreate?: boolean } = {},
): SchemaHarness {
  const harness: SchemaHarness = {
    transport: null as unknown as HttpTransport,
    fields: options.fields ?? defaultFields(),
    createdFields: [],
    fieldPosts: 0,
    deletes: 0,
  }

  let gateResolve: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    gateResolve = resolve
  })
  harness.release = gateResolve

  harness.transport = {
    fetch: async (url, init) => {
      const method = init?.method ?? 'GET'
      if (url.includes('/tenant_access_token/internal')) {
        return jsonResponse({ code: 0, tenant_access_token: 'token', expire: 7200 })
      }
      if (url.includes('/fields')) {
        if (method === 'POST') {
          if (options.deferCreate) await gate
          harness.fieldPosts += 1
          const body = JSON.parse((init?.body as string) || '{}') as { field_name: string; type: number }
          harness.fields.push({ field_name: body.field_name, type: body.type })
          harness.createdFields.push(body.field_name)
          return jsonResponse({ code: 0 })
        }
        if (method === 'DELETE') {
          harness.deletes += 1
          return jsonResponse({ code: 0 })
        }
        return jsonResponse({ code: 0, data: { has_more: false, items: harness.fields } })
      }
      return jsonResponse({})
    },
  }
  return harness
}

type Runtime = ReturnType<typeof createFeishuSchemaRuntime>

function setup(harness: SchemaHarness, store: MemoryFeishuConfigStore, extra: Record<string, unknown> = {}): Runtime {
  return createFeishuSchemaRuntime({ feishuConfigStore: store, transport: harness.transport, ...extra })
}

async function preview(runtime: Runtime) {
  return runtime.handleCommand(createCommand(CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW, {}))
}

async function execute(runtime: Runtime, previewId: string, acceptTypeConflicts = false) {
  return runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE, {
      previewId,
      confirm: true,
      ...(acceptTypeConflicts ? { acceptTypeConflicts: true } : {}),
    }),
  )
}

test('字段同步: 预览按并集分类且只读（不创建字段）', async () => {
  const harness = createHarness({ fields: [...defaultFields(), { field_name: '飞书独有字段', type: 1 }] })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG))

  const res = await preview(runtime)
  assert.equal(res.ok, true)
  const result = res.result as FeishuProductSchemaReconcilePreviewResult

  assert.equal(result.strategy, 'UNION')
  assert.equal(result.targetTableId, 'tbl_product')
  assert.equal(result.localFieldCount, LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION.length)
  // 飞书实际 = 13（配置）+ 1（独有）。
  assert.equal(result.feishuFieldCount, 14)
  // 目标并集 = 本地投影 ∪ 飞书实际。
  assert.equal(result.targetFieldCount, LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION.length + 1)

  // 本地多出的字段进入待创建（并集补充，不破坏性覆盖）。
  assert.deepEqual(result.toCreate.map((field) => field.name), LOCAL_ONLY_FIELDS)
  // 仅飞书存在字段只报告，绝不删除。
  assert.deepEqual(result.feishuOnly, ['飞书独有字段'])
  assert.equal(result.typeConflicts.length, 0)
  assert.equal(result.requiresConfirmation, false)
  assert.equal(result.canAutoApply, true)
  assert.equal(result.manualActions.some((action) => action.includes('绝不删除')), true)

  // 飞书字段 API 能力：可创建、不可安全改类型、绝不删除。
  assert.equal(result.fieldApiCapability.canCreateField, true)
  assert.equal(result.fieldApiCapability.canUpdateFieldType, false)
  assert.equal(result.fieldApiCapability.canDeleteField, false)

  // 预览绝不创建字段。
  assert.equal(harness.fieldPosts, 0)
  assert.equal(harness.deletes, 0)
  assert.equal(typeof result.previewId, 'string')
  assert.equal(result.previewId.length > 0, true)
})

test('字段同步: 执行仅创建缺失字段且幂等（重复执行不再创建）', async () => {
  const harness = createHarness()
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG))

  const previewId = ((await preview(runtime)).result as FeishuProductSchemaReconcilePreviewResult).previewId
  const res = await execute(runtime, previewId)
  assert.equal(res.ok, true)
  const result = res.result as FeishuProductSchemaReconcileExecuteResult
  assert.deepEqual(result.createdFields, LOCAL_ONLY_FIELDS)
  assert.deepEqual(result.skippedExistingFields, [])
  assert.equal(harness.fieldPosts, LOCAL_ONLY_FIELDS.length)
  assert.equal(harness.deletes, 0)

  // 再次预览：缺失字段已补齐，待创建为空。
  const second = await preview(runtime)
  const secondResult = second.result as FeishuProductSchemaReconcilePreviewResult
  assert.deepEqual(secondResult.toCreate, [])
  assert.equal(secondResult.inSync.length, LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION.length)
  assert.equal(secondResult.targetFieldCount, LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION.length)

  // 再次执行：不再创建任何字段（幂等）。
  const before = harness.fieldPosts
  const res2 = await execute(runtime, secondResult.previewId)
  assert.equal(res2.ok, true)
  assert.deepEqual((res2.result as FeishuProductSchemaReconcileExecuteResult).createdFields, [])
  assert.equal(harness.fieldPosts, before)
})

test('字段同步: 类型冲突缺省拒绝执行，不静默覆盖', async () => {
  const harness = createHarness({
    fields: defaultFields().map((field) => (field.field_name === '价格' ? { ...field, type: 1 } : field)),
  })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG))

  const previewRes = await preview(runtime)
  assert.equal(previewRes.ok, true)
  const previewResult = previewRes.result as FeishuProductSchemaReconcilePreviewResult
  assert.equal(previewResult.requiresConfirmation, true)
  assert.equal(previewResult.canAutoApply, false)
  assert.deepEqual(previewResult.typeConflicts, [{ name: '价格', expectedType: 2, actualType: 1 }])
  assert.equal(previewResult.manualActions.some((action) => action.includes('不会自动覆盖字段类型')), true)

  const res = await execute(runtime, previewResult.previewId)
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  assert.equal(res.error?.message.includes('类型冲突'), true)
  assert.equal(res.error?.message.includes('acceptTypeConflicts'), true)
  // 冲突未确认时：不创建、更不覆盖类型。
  assert.equal(harness.fieldPosts, 0)
})

test('字段同步: 显式 acceptTypeConflicts 后创建缺失字段，但仍不覆盖类型', async () => {
  const harness = createHarness({
    fields: defaultFields().map((field) => (field.field_name === '价格' ? { ...field, type: 1 } : field)),
  })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG))

  const previewId = ((await preview(runtime)).result as FeishuProductSchemaReconcilePreviewResult).previewId
  const res = await execute(runtime, previewId, true)
  assert.equal(res.ok, true)
  const result = res.result as FeishuProductSchemaReconcileExecuteResult

  // 缺失字段照常创建。
  assert.deepEqual(result.createdFields, LOCAL_ONLY_FIELDS)
  // 冲突字段仍在结果中，需人工处理，绝不被自动覆盖。
  assert.deepEqual(result.typeConflicts, [{ name: '价格', expectedType: 2, actualType: 1 }])
  assert.equal(result.manualActions.some((action) => action.includes('价格')), true)
  // 冲突字段本就在飞书存在，不进入创建列表。
  assert.equal(harness.createdFields.includes('价格'), false)
  assert.equal(harness.deletes, 0)
})

test('字段同步: 预览过期 / previewId 一次性 / 目标表变更均被复验', async () => {
  // 过期
  const harness = createHarness()
  let currentTime = 1_000_000
  const store = new MemoryFeishuConfigStore(CONFIG)
  const runtime = setup(harness, store, { now: () => currentTime, previewTtlMs: 1000 })
  const previewId = ((await preview(runtime)).result as FeishuProductSchemaReconcilePreviewResult).previewId
  currentTime += 5000
  const expired = await execute(runtime, previewId)
  assert.equal(expired.ok, false)
  assert.equal(expired.error?.message.includes('过期'), true)
  assert.equal(harness.fieldPosts, 0)

  // 一次性（重放）
  const harness2 = createHarness()
  const runtime2 = setup(harness2, new MemoryFeishuConfigStore(CONFIG))
  const id2 = ((await preview(runtime2)).result as FeishuProductSchemaReconcilePreviewResult).previewId
  assert.equal((await execute(runtime2, id2)).ok, true)
  const replay = await execute(runtime2, id2)
  assert.equal(replay.ok, false)
  assert.equal(replay.error?.message.includes('已失效'), true)

  // 目标表变更
  const harness3 = createHarness()
  const store3 = new MemoryFeishuConfigStore(CONFIG)
  const runtime3 = setup(harness3, store3)
  const id3 = ((await preview(runtime3)).result as FeishuProductSchemaReconcilePreviewResult).previewId
  await store3.save({ ...CONFIG, productTableId: 'tbl_other' })
  const changed = await execute(runtime3, id3)
  assert.equal(changed.ok, false)
  assert.equal(changed.error?.message.includes('目标表已变更'), true)
  assert.equal(harness3.fieldPosts, 0)
})

test('字段同步: 串行并发保护（进行中的同步拒绝第二次执行）', async () => {
  const harness = createHarness({ deferCreate: true })
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG))

  const id1 = ((await preview(runtime)).result as FeishuProductSchemaReconcilePreviewResult).previewId
  const id2 = ((await preview(runtime)).result as FeishuProductSchemaReconcilePreviewResult).previewId

  const first = execute(runtime, id1)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const second = await execute(runtime, id2)
  assert.equal(second.ok, false)
  assert.equal(second.error?.message.includes('正在进行'), true)

  harness.release?.()
  assert.equal((await first).ok, true)
})

test('字段同步: 未配置飞书时回结构化错误且不泄露配置', async () => {
  const harness = createHarness()
  const runtime = setup(harness, new MemoryFeishuConfigStore(null))

  const res = await preview(runtime)
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  assert.equal(res.error?.message.includes('未配置'), true)
  assert.equal(harness.fieldPosts, 0)
})

test('字段同步: 响应与错误绝不泄露凭据', async () => {
  const harness = createHarness()
  const runtime = setup(harness, new MemoryFeishuConfigStore(CONFIG))

  const previewRes = await preview(runtime)
  const json = JSON.stringify(previewRes)
  assert.equal(json.includes(CONFIG.appSecret), false)
  assert.equal(json.includes(CONFIG.spreadsheetToken), false)
  assert.equal(json.includes(CONFIG.appId), false)

  const previewId = (previewRes.result as FeishuProductSchemaReconcilePreviewResult).previewId
  const execRes = await execute(runtime, previewId)
  const execJson = JSON.stringify(execRes)
  assert.equal(execJson.includes(CONFIG.appSecret), false)
  assert.equal(execJson.includes(CONFIG.spreadsheetToken), false)
  assert.equal(execJson.includes(CONFIG.appId), false)
})
