import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes } from '@fishops/shared'
import { CaptureController } from '../capture-controller'
import { buildBatchCapturePayloads, buildCapturePayload, defaultCaptureForm } from '../capture-format'
import type { BridgeApi } from '../../shared/bridge-api'
import type { Task } from '../../contracts'

class MockBridge implements BridgeApi {
  readonly calls: Array<{ type: string; payload: unknown }> = []
  readonly responders = new Map<string, (payload: unknown) => unknown>()

  async call(type: never, payload: never): Promise<never> {
    this.calls.push({ type, payload })
    const result = this.responders.get(type)?.(payload)
    if (result === undefined) throw new Error(`未配置 ${type} 响应`)
    return result as never
  }

  on(): () => void { return () => {} }
  resubscribe(): void {}
}

function editedForm() {
  return {
    ...defaultCaptureForm(),
    keywords: ['Sony A7M4'],
    // Vue 对 v-model 绑定的 type="number" 输入会把有效值转换为 number。
    startPage: 2,
    pages: 3,
    rowsPerPage: 20,
    minWantCnt: 4,
    minPrice: 12.5,
    maxPrice: 99,
    baseIntervalSec: 1.5,
    randomIntervalSec: 2,
  }
}

test('批量采集 builder 接受 number 输入，保留校验及数值换算', () => {
  const result = buildBatchCapturePayloads(editedForm())
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.payloads[0], {
    keyword: 'Sony A7M4',
    startPage: 2,
    pages: 3,
    rowsPerPage: 20,
    fetchDetail: false,
    minIntervalMs: 1500,
    intervalJitterMs: 2000,
    filter: { minWantCnt: 4, minPrice: 12.5, maxPrice: 99 },
  })
})

test('单关键词 builder 接受 number 输入及数值毫秒字段，显式 0 优先于秒字段', () => {
  const result = buildCapturePayload({
    ...editedForm(),
    keyword: 'single-camera',
    baseIntervalMs: 0,
    randomIntervalMs: 2500,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.payload, {
    keyword: 'single-camera',
    startPage: 2,
    pages: 3,
    rowsPerPage: 20,
    fetchDetail: false,
    minIntervalMs: 0,
    intervalJitterMs: 2500,
    filter: { minWantCnt: 4, minPrice: 12.5, maxPrice: 99 },
  })
})

test('非法数字仍返回字段错误，不吞值', () => {
  const result = buildBatchCapturePayloads({ ...editedForm(), pages: Number.NaN })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.ok(result.errors.pages)
})

test('可选数字字段清空后省略过滤条件，随后仍可再次构建', () => {
  const blank = buildBatchCapturePayloads({
    ...editedForm(),
    minWantCnt: '',
    minPrice: '',
    maxPrice: '',
  })
  assert.equal(blank.ok, true)
  if (blank.ok) assert.equal('filter' in blank.payloads[0], false)

  const next = buildBatchCapturePayloads({ ...editedForm(), pages: 4 })
  assert.equal(next.ok, true)
  if (next.ok) assert.equal(next.payloads[0].pages, 4)
})

test('编辑 number 值后提交批量任务走 mock bridge；非法输入不发请求，随后可再次提交', async () => {
  const api = new MockBridge()
  api.responders.set(CommandTypes.TASK_LIST, () => ({ tasks: [] }))
  api.responders.set(CommandTypes.CAPTURE_CREATE, (payload) => {
    const capture = payload as { keyword: string; pages: number }
    const task: Task = {
      id: `task-${api.calls.length}`,
      type: 'capture',
      status: 'pending',
      progress: 0,
      createdAt: 1,
      updatedAt: 1,
      payload: capture,
    }
    return { task }
  })
  const controller = new CaptureController({ api })
  controller.start()

  const first = buildBatchCapturePayloads(editedForm())
  assert.equal(first.ok, true)
  if (!first.ok) return
  const submitted = await controller.createBatchTasks(first.payloads)
  assert.equal(submitted.successes.length, 1)
  assert.equal(api.calls.filter((call) => call.type === CommandTypes.CAPTURE_CREATE).length, 1)
  assert.equal((api.calls.find((call) => call.type === CommandTypes.CAPTURE_CREATE)?.payload as { pages: number }).pages, 3)

  const invalid = buildBatchCapturePayloads({ ...editedForm(), pages: Number.NaN })
  assert.equal(invalid.ok, false)
  assert.equal(api.calls.filter((call) => call.type === CommandTypes.CAPTURE_CREATE).length, 1)

  const afterClear = buildBatchCapturePayloads({ ...editedForm(), minWantCnt: '', minPrice: '', maxPrice: '' })
  assert.equal(afterClear.ok, true)
  if (!afterClear.ok) return
  await controller.createBatchTasks(afterClear.payloads)
  const creates = api.calls.filter((call) => call.type === CommandTypes.CAPTURE_CREATE)
  assert.equal(creates.length, 2)
  assert.equal('filter' in (creates[1].payload as object), false)
  controller.dispose()
})
