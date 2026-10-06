/** 共享默认 Session 存储的启动恢复回归；仅替换 Chrome 边界，不执行采集或 LLM。 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { TaskManager } from '../../../../shared/task/task-manager'
import type { TaskChangeEvent } from '../../../../shared/types/task'
import { MemoryProductRepository } from '../../../../shared/capture/product-repository'
import { createAnalysisRuntime } from '../analysis-runtime'
import { createCaptureRuntime } from '../capture-runtime'
import { MockPlatform } from '../../capture/test/fixtures'

async function setup(t: TestContext) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
  const data = new Map<string, unknown>()
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { session: {
    async get(key: string | null) {
      return structuredClone(key === null ? Object.fromEntries(data) : { [key]: data.get(key) })
    },
    async set(items: Record<string, unknown>) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value))
    },
    async remove(key: string) { data.delete(key) },
  } } } })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'chrome', previous)
    else Reflect.deleteProperty(globalThis, 'chrome')
  })
  const writer = new TaskManager()
  const checkpoint = {
    keyword: 'synthetic', startPage: 1, totalPages: 3, nextPage: 2, pagesCompleted: 1,
    stats: { fetched: 2, valid: 2, filtered: 0, duplicates: 0, failed: 0 },
  }
  const capture = await writer.create({ type: 'capture', payload: { keyword: 'synthetic', pages: 3 }, meta: { capture: checkpoint } })
  await writer.start(capture.id)
  await writer.updateProgress(capture.id, 40)
  const analysis = await writer.create({ type: 'analysis', payload: { ruleId: 'synthetic', dataSourceType: 'feishu' } })
  await writer.start(analysis.id)
  await writer.updateProgress(analysis.id, 25)
  const publish = await writer.create({ type: 'publish', payload: {} })
  await writer.start(publish.id)
  const paused = await writer.create({ type: 'capture', payload: {} })
  await writer.start(paused.id)
  await writer.pause(paused.id, '原暂停原因')
  const pending = await writer.create({ type: 'analysis', payload: {} })
  const untouched = await Promise.all([publish, paused, pending].map(task => writer.getById(task.id)))
  const platform = new MockPlatform()
  const captureRuntime = createCaptureRuntime({ platform, repository: new MemoryProductRepository() })
  const analysisRuntime = createAnalysisRuntime({})
  return { writer, capture, analysis, checkpoint, untouched, platform, captureRuntime, analysisRuntime }
}

test('分析初始化不改写采集快照；采集初始化不改写分析快照', async t => {
  const s = await setup(t)
  const captureBefore = await s.writer.getById(s.capture.id)
  await s.analysisRuntime.init()
  assert.deepEqual(await s.writer.getById(s.capture.id), captureBefore)
  const analysisAfter = await s.writer.getById(s.analysis.id)
  assert.equal(analysisAfter?.status, 'failed')
  await s.captureRuntime.init()
  assert.deepEqual(await s.writer.getById(s.analysis.id), analysisAfter)
})

test('采集单独初始化不改写运行中分析任务的任何字段', async t => {
  const s = await setup(t)
  const analysisBefore = await s.writer.getById(s.analysis.id)
  await s.captureRuntime.init()
  assert.deepEqual(await s.writer.getById(s.analysis.id), analysisBefore)
  assert.equal((await s.writer.getById(s.capture.id))?.status, 'paused')
})

for (const order of ['capture-first', 'analysis-first', 'parallel'] as const) {
  test(`共享默认存储：${order} 按类型恢复且再次 init 不改写`, async t => {
    const s = await setup(t)
    if (order === 'parallel') await Promise.all([s.captureRuntime.init(), s.analysisRuntime.init()])
    else if (order === 'capture-first') { await s.captureRuntime.init(); await s.analysisRuntime.init() }
    else { await s.analysisRuntime.init(); await s.captureRuntime.init() }
    const capture = await s.writer.getById(s.capture.id)
    const analysis = await s.writer.getById(s.analysis.id)
    assert.equal(capture?.status, 'paused')
    assert.equal(capture?.progress, 40)
    assert.deepEqual(capture?.meta?.capture, s.checkpoint)
    assert.equal(capture?.meta?.recoveryNote, 'Service Worker 重启，采集任务已挂起，等待手动续采')
    assert.equal(analysis?.status, 'failed')
    assert.equal(analysis?.progress, 25)
    assert.equal(analysis?.error, 'Service Worker 重启，未完成的分析任务已中止')
    for (const task of s.untouched) assert.deepEqual(await s.writer.getById(task!.id), task)
    assert.equal(s.platform.searchCalls.length, 0)
    await Promise.all([s.captureRuntime.init(), s.analysisRuntime.init()])
    assert.deepEqual(await s.writer.getById(s.capture.id), capture)
    assert.deepEqual(await s.writer.getById(s.analysis.id), analysis)
  })
}

test('TaskManager 类型过滤只恢复并通知命中的 running 任务，空匹配无副作用', async t => {
  const s = await setup(t)
  const manager = new TaskManager()
  const events: TaskChangeEvent[] = []
  manager.subscribe(event => events.push(event))
  const analysisBefore = await s.writer.getById(s.analysis.id)
  const recovered = await manager.recoverOnStartup({ type: 'capture', timestamp: 12345 })
  assert.deepEqual(recovered.map(task => task.id), [s.capture.id])
  assert.deepEqual(events.map(event => event.task.id), [s.capture.id])
  assert.equal(recovered[0]?.meta?.recoveredAt, 12345)
  assert.deepEqual(await s.writer.getById(s.analysis.id), analysisBefore)
  assert.deepEqual(await manager.recoverOnStartup({ type: 'capture' }), [])
  assert.equal(events.length, 1)
})

test('TaskManager 不传类型时保留全类型恢复兼容行为', async t => {
  const s = await setup(t)
  const recovered = await s.writer.recoverOnStartup()
  assert.deepEqual(new Set(recovered.map(task => task.id)), new Set([s.capture.id, s.analysis.id, s.untouched[0]!.id]))
  assert.ok(recovered.every(task => task.status === 'paused'))
})
