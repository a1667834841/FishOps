/**
 * 发布诊断时间线测试（P8 增强 · Workbench 只读消费侧）。
 *
 * 覆盖：
 * 1. 阶段 / 状态 → 中文映射（全部 stage 均落到具体中文，绝不显示原始英文）；
 * 2. 缺值 / 空时间线 / 非法结构 → 明确“无记录”，绝不造 fake；
 * 3. 安全过滤：URL / token / 商品正文 / 非法 code 一律被丢弃，只留白名单安全字段；
 * 4. 无隐式副作用：getTask 与事件仅读取与更新本地状态，绝不触发 fill / submit / 重试。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandTypes, EventTypes } from '@fishops/shared'
import type { PublishDiagEntry, PublishDiagStage, PublishDiagnostics, PublishTask } from '../../contracts'
import type { BridgeApi } from '../../shared/bridge-api'
import { PublishController } from '../publish-controller'
import {
  buildPublishDiagnosticsView,
  formatDiagStage,
  formatDiagStatus,
  sanitizePublishDiagnostics,
} from '../publish-diagnostics'

const ALL_STAGES: PublishDiagStage[] = [
  'fresh_tab',
  'load',
  'page_check',
  'fields',
  'images',
  'form_validation',
  'baseline',
  'submit_dispatch',
  'official_verify',
  'result',
]

/** 平台写入类命令：任何只读诊断路径都绝不允许出现。 */
const PUBLISH_WRITE_TYPES: readonly string[] = [
  CommandTypes.PUBLISH_CREATE,
  CommandTypes.PUBLISH_FILL_FORM,
  CommandTypes.PUBLISH_SUBMIT,
  CommandTypes.PUBLISH_CANCEL,
  CommandTypes.PUBLISH_CONFIRM_STATUS,
  CommandTypes.PUBLISH_PAUSE,
  CommandTypes.PUBLISH_RESUME,
]

function makeDiag(
  entries: PublishDiagEntry[],
  overrides: Partial<PublishDiagnostics> = {},
): PublishDiagnostics {
  return { schema: 1, timeline: entries, dropped: 0, updatedAt: 1_700_000_000_000, ...overrides }
}

function makeTask(id: string, diagnostics?: PublishDiagnostics): PublishTask {
  return {
    id,
    type: 'publish',
    status: 'waiting_confirmation',
    progress: 100,
    createdAt: 1,
    updatedAt: 1,
    payload: { itemId: 'prod_1' },
    ...(diagnostics ? { meta: { diagnostics } } : {}),
  }
}

/** 支持命令回放 + 事件广播的精简 Bridge 替身。 */
class DiagMockApi implements BridgeApi {
  public sentCommands: Array<{ type: string; payload: unknown }> = []
  public tasksToReturn: PublishTask[] = []
  /** 独立于 task.meta 的 PUBLISH_GET.diag 权威来源，用于验证“读真实 diag”。 */
  public diagById: Record<string, PublishDiagnostics> = {}
  private handlers = new Map<string, Array<(payload: any) => void>>()

  async call(type: any, payload: any): Promise<any> {
    this.sentCommands.push({ type, payload })
    if (type === CommandTypes.PRODUCT_LIST) {
      return { products: [], total: 0 }
    }
    if (type === CommandTypes.PUBLISH_LIST) {
      return { tasks: this.tasksToReturn, total: this.tasksToReturn.length }
    }
    if (type === CommandTypes.PUBLISH_GET) {
      const id = (payload as { id: string }).id
      const task = this.tasksToReturn.find((t) => t.id === id)
      const diag = this.diagById[id]
      return { ...(task ? { task } : {}), ...(diag ? { diag } : {}) }
    }
    return {}
  }

  on(type: any, handler: any): () => void {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
    return () => {
      this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== handler))
    }
  }

  emit(type: any, payload: any): void {
    for (const handler of this.handlers.get(type) ?? []) handler(payload)
  }

  resubscribe(): void {}
}

function writeCommands(api: DiagMockApi): string[] {
  return api.sentCommands
    .map((c) => c.type)
    .filter((t) => PUBLISH_WRITE_TYPES.includes(t))
}

test('诊断阶段与状态映射：全部落到具体中文，未知值有中性兜底', () => {
  for (const stage of ALL_STAGES) {
    const label = formatDiagStage(stage)
    assert.ok(label.length > 0, `阶段 ${stage} 应有中文标签`)
    assert.notEqual(label, '未知阶段', `阶段 ${stage} 不应落到未知兜底`)
  }
  assert.equal(formatDiagStage('not_a_stage'), '未知阶段')

  assert.deepEqual(formatDiagStatus('started'), { label: '进行中', tone: 'accent' })
  assert.deepEqual(formatDiagStatus('ok'), { label: '成功', tone: 'ok' })
  assert.deepEqual(formatDiagStatus('failed'), { label: '失败', tone: 'error' })
  assert.deepEqual(formatDiagStatus('unknown'), { label: '未知', tone: 'warn' })
  assert.deepEqual(formatDiagStatus('whatever'), { label: '未知', tone: 'neutral' })
})

test('视图构建：正确映射耗时 / 计数 / 标记，缺值优雅降级不造 fake', () => {
  const diag = makeDiag([
    {
      stage: 'fields',
      status: 'ok',
      startedAt: 1000,
      endedAt: 1200,
      latencyMs: 200,
      code: 'FORM_VALIDATION_FAILED',
      counters: { fields: 5, images: 3 },
      flags: { loggedIn: true, captcha: false },
    },
    // 进行中：缺 endedAt / latencyMs / code
    { stage: 'load', status: 'started', startedAt: 2000 },
  ])

  const view = buildPublishDiagnosticsView(diag, { formatTime: (ms) => `T${ms}` })
  assert.equal(view.hasRecords, true)
  assert.equal(view.timeline.length, 2)

  const first = view.timeline[0]!
  assert.equal(first.stageLabel, '字段填充与回读')
  assert.equal(first.statusLabel, '成功')
  assert.equal(first.statusTone, 'ok')
  assert.equal(first.startedAtText, 'T1000')
  assert.equal(first.endedAtText, 'T1200')
  assert.equal(first.latencyText, '200 ms')
  assert.equal(first.code, 'FORM_VALIDATION_FAILED')
  assert.deepEqual(
    first.counters.map((c) => `${c.label}=${c.value}`).sort(),
    ['图片数=3', '字段数=5'],
  )
  assert.deepEqual(
    first.flags.map((f) => `${f.label}=${f.value ? '是' : '否'}`).sort(),
    ['已登录=是', '遇验证码=否'],
  )

  const second = view.timeline[1]!
  assert.equal(second.stageLabel, '等待页面加载')
  assert.equal(second.statusLabel, '进行中')
  assert.equal(second.endedAtText, '')
  assert.equal(second.latencyText, '—')
  assert.equal(second.code, '')
})

test('缺值 / 空时间线 / 非法结构一律明确“无记录”，绝不本地补位', () => {
  assert.equal(buildPublishDiagnosticsView(null).hasRecords, false)
  assert.equal(buildPublishDiagnosticsView(undefined).hasRecords, false)
  assert.equal(buildPublishDiagnosticsView(makeDiag([])).hasRecords, false)
  assert.equal(buildPublishDiagnosticsView(makeDiag([])).timeline.length, 0)

  // 非法结构直接返回 null，视图按“无记录”处理
  assert.equal(sanitizePublishDiagnostics(null), null)
  assert.equal(sanitizePublishDiagnostics({ schema: 2, timeline: [] }), null)
  assert.equal(sanitizePublishDiagnostics({ timeline: [] }), null)
  assert.equal(sanitizePublishDiagnostics('oops'), null)
})

test('安全过滤：URL / token / 商品正文 / 非法 code 一律丢弃，只留白名单安全字段', () => {
  const dirty = {
    schema: 1,
    timeline: [
      {
        stage: 'fields',
        status: 'ok',
        startedAt: 1000,
        endedAt: 1200,
        latencyMs: 200,
        code: 'FORM_VALIDATION_FAILED',
        counters: { fields: 5, rawUrl: 'https://secret.example/x' },
        flags: { loggedIn: true, token: 'tok_123' },
      },
      {
        stage: 'images',
        status: 'failed',
        startedAt: 1300,
        latencyMs: 80,
        code: 'https://evil.example/?token=abc',
        rawUrl: 'https://img.alicdn.com/x.jpg',
        title: '绝密商品正文不应出现',
      },
      // 非法 stage / status / startedAt 直接整条丢弃
      { stage: 'nope', status: 'ok', startedAt: 1 },
      { stage: 'fields', status: 'nope', startedAt: 1 },
      { stage: 'fields', status: 'ok', startedAt: 'x' },
    ],
    // 顶层污染字段
    rawUrl: 'https://secret.example/x',
    token: 'tok_123',
    title: '绝密商品正文不应出现',
    dropped: 0,
    updatedAt: 2000,
  }

  const clean = sanitizePublishDiagnostics(dirty)
  assert.ok(clean, '合法 schema + timeline 应返回结构')
  assert.equal(clean!.timeline.length, 2, '非法条目应被整条丢弃')
  assert.deepEqual(clean!.timeline[0]!.counters, { fields: 5 })
  assert.deepEqual(clean!.timeline[0]!.flags, { loggedIn: true })
  assert.equal(clean!.timeline[0]!.code, 'FORM_VALIDATION_FAILED')
  assert.equal(clean!.timeline[1]!.code, undefined, 'URL 形态 code 必须被丢弃')

  // 序列化后绝不出现任一敏感原文片段
  const json = JSON.stringify(clean)
  for (const secret of ['https://', 'secret.example', 'evil.example', 'tok_123', 'token=abc', '绝密商品正文', 'img.alicdn.com']) {
    assert.ok(!json.includes(secret), `诊断结构不得包含敏感原文：${secret}`)
  }
  // 视图中同样不出现
  const view = buildPublishDiagnosticsView(clean)
  const viewJson = JSON.stringify(view)
  assert.ok(!viewJson.includes('https://'), '视图不得包含 URL')
  assert.ok(!viewJson.includes('绝密商品正文'), '视图不得包含商品正文')
})

test('长度有界：超出上限截断最旧记录并累加 dropped', () => {
  const entries: PublishDiagEntry[] = Array.from({ length: 70 }, (_, i) => ({
    stage: 'fields',
    status: 'ok',
    startedAt: i,
  }))
  const clean = sanitizePublishDiagnostics(makeDiag(entries, { dropped: 3 }))
  assert.ok(clean)
  assert.equal(clean!.timeline.length, 64, '时间线必须被截断到 64 条上限')
  assert.equal(clean!.dropped, 3 + 6, '被截断的 6 条应累加进 dropped')
  assert.equal(clean!.timeline[0]!.startedAt, 6, '截断的是最旧记录')
})

test('只读路径无隐式副作用：getTask 与诊断事件绝不触发 fill / submit / 重试', async () => {
  const api = new DiagMockApi()
  const controller = new PublishController({ api })
  const task = makeTask('pub_readonly')
  api.tasksToReturn = [task]

  controller.start()
  controller.setCurrentTask(task)

  const diag = makeDiag([
    { stage: 'baseline', status: 'ok', startedAt: 1, latencyMs: 10 },
    { stage: 'official_verify', status: 'unknown', startedAt: 2, latencyMs: 20, code: 'VERIFY_UNAVAILABLE' },
  ])

  // 1) getTask 携带 PUBLISH_GET.diag → 同步到状态
  api.diagById['pub_readonly'] = diag
  await controller.getTask('pub_readonly')
  assert.equal(controller.getState().diagnostics?.timeline.length, 2, 'getTask 应消费 PUBLISH_GET.diag')

  // 2) 事件携带 meta.diagnostics → 更新状态
  const updated = makeTask('pub_readonly', makeDiag([
    { stage: 'official_verify', status: 'ok', startedAt: 3, latencyMs: 30, counters: { afterCount: 6 } },
  ]))
  api.emit(EventTypes.TASK_CHANGED, {
    eventType: 'updated',
    task: updated,
    previousStatus: 'waiting_confirmation',
    timestamp: Date.now(),
  })
  const afterEvent = controller.getState().diagnostics
  assert.equal(afterEvent?.timeline.length, 1)
  assert.equal(afterEvent?.timeline[0]!.stage, 'official_verify')

  // 3) 全程绝不允许出现任何平台写入类命令
  assert.deepEqual(writeCommands(api), [], '只读诊断路径不得触发任何发布写命令')
})

test('老任务（无 diagnostics）明确无记录，事件回滚后权威快照覆盖为 null', async () => {
  const api = new DiagMockApi()
  const controller = new PublishController({ api })
  const legacy = makeTask('pub_legacy')
  api.tasksToReturn = [legacy]

  controller.start()
  controller.setCurrentTask(legacy)
  assert.equal(controller.getState().diagnostics, null, '老任务不得凭空出现诊断')
  assert.equal(buildPublishDiagnosticsView(controller.getState().diagnostics).hasRecords, false)

  // 事件带来诊断后再以权威空快照覆盖，应回到“无记录”，绝不保留旧时间线
  api.emit(EventTypes.TASK_CHANGED, {
    eventType: 'updated',
    task: makeTask('pub_legacy', makeDiag([{ stage: 'result', status: 'failed', startedAt: 1, code: 'FORM_VALIDATION_FAILED' }])),
    timestamp: Date.now(),
  })
  assert.equal(controller.getState().diagnostics?.timeline.length, 1)

  api.emit(EventTypes.TASK_CHANGED, {
    eventType: 'updated',
    task: makeTask('pub_legacy'),
    timestamp: Date.now(),
  })
  assert.equal(controller.getState().diagnostics, null, '权威空快照应清空旧时间线')
})

test('切换聚焦 / 编辑草稿会清空诊断，绝不让旧任务时间线残留', () => {
  const api = new DiagMockApi()
  const controller = new PublishController({ api })
  const task = makeTask('pub_switch', makeDiag([{ stage: 'fields', status: 'ok', startedAt: 1 }]))

  controller.setCurrentTask(task)
  assert.equal(controller.getState().diagnostics?.timeline.length, 1)

  // 编辑草稿使旧任务失效 → 诊断同步清空
  controller.updateDraftField({ title: '新标题' })
  assert.equal(controller.getState().currentTask, null)
  assert.equal(controller.getState().diagnostics, null, '编辑草稿必须清空旧任务诊断')

  controller.setCurrentTask(task)
  assert.equal(controller.getState().diagnostics?.timeline.length, 1)
  controller.selectProduct('')
  assert.equal(controller.getState().diagnostics, null, '清空选择必须清空诊断')
})
