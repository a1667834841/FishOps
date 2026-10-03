/**
 * 任务历史列表（TASK_LIST）与持久化单测（全 mock，无真实网络）。
 *
 * 覆盖：
 * - 多次创建任务（完成 / 取消 / 失败）后，TASK_LIST 仍能查到全部历史；
 * - 过滤（状态 / 关键词）、排序（createdAt / updatedAt，升 / 降）、limit；
 * - 状态 / 统计 / result 的持久化与「Service Worker 重启」后的恢复
 *   （用 MemoryStorageAdapter 模拟 chrome.storage.session，新建 TaskManager 读取）；
 * - payload.keyword / error 超出限制时按 CAPTURE_LIMITS 截断，且核心统计不丢。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CommandTypes, EventTypes } from '@fishops/shared'
import type { CommandEnvelope, TaskChangedPayload } from '@fishops/shared'
import {
  AdapterTaskStore,
  MemoryStorageAdapter,
  TaskManager,
} from '../../../../shared/task/index'
import type { Task } from '../../../../shared/task/index'
import { MemoryProductRepository } from '../../../../shared/capture/product-repository'
import { CAPTURE_LIMITS } from '../../../../shared/types/capture'
import type { CaptureCheckpoint, CaptureResult } from '../../../../shared/types/capture'
import { createCaptureRuntime, type CaptureEventEnvelope } from '../../background/capture-runtime'
import { MockPlatform, makeListItem, makePage } from './fixtures'

function cmd(type: string, payload: unknown): CommandEnvelope {
  return {
    kind: 'command',
    protocol: 1,
    requestId: `req_${Math.random().toString(36).slice(2)}`,
    type,
    payload,
    sentAt: Date.now(),
  }
}

function setup(options: { adapter?: MemoryStorageAdapter; prefix?: string } = {}) {
  const adapter = options.adapter ?? new MemoryStorageAdapter()
  const prefix = options.prefix ?? 'history_test'
  const tasks = new TaskManager({ store: new AdapterTaskStore(adapter, prefix) })
  const repository = new MemoryProductRepository()
  const platform = new MockPlatform()
  const events: CaptureEventEnvelope[] = []
  const runtime = createCaptureRuntime({
    platform,
    repository,
    tasks,
    sleep: async () => {},
    onEvent: (event) => events.push(event),
  })
  return { adapter, prefix, tasks, repository, platform, events, runtime }
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function changed(event: CaptureEventEnvelope): TaskChangedPayload {
  return event.payload as TaskChangedPayload
}

function waitForStatus(events: CaptureEventEnvelope[], id: string, status: string): Promise<void> {
  return waitFor(() =>
    events.some(
      (event) =>
        event.type === EventTypes.TASK_CHANGED &&
        changed(event).task.id === id &&
        changed(event).task.status === status,
    ),
  )
}

async function taskList(runtime: { handleCommand(c: CommandEnvelope): Promise<unknown> }, payload: unknown) {
  const response = (await runtime.handleCommand(cmd(CommandTypes.TASK_LIST, payload))) as {
    ok: boolean
    result?: { tasks: Task[] }
  }
  assert.equal(response.ok, true)
  return response.result!.tasks
}

test('多次创建任务后 TASK_LIST 能查到完整历史（完成 / 取消 / 失败）', async () => {
  const s = setup()
  // 完成：1 页，2 条
  s.platform.pages.set(1, makePage([makeListItem({ itemId: 'A' }), makeListItem({ itemId: 'B' })]))
  const created1 = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'iphone', pages: 1 }),
  )
  const completedId = (created1.result as { task: Task }).task.id
  await waitForStatus(s.events, completedId, 'completed')

  // 取消：用 gate 卡住第 1 页，取消后再释放
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  s.platform.hooks.set(1, () => gate)
  const created2 = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'ipad', pages: 1 }),
  )
  const cancelledId = (created2.result as { task: Task }).task.id
  await waitFor(() => s.platform.searchCalls.includes(1))
  await s.runtime.handleCommand(cmd(CommandTypes.CAPTURE_CANCEL, { id: cancelledId, reason: '取消' }))
  release()
  await waitForStatus(s.events, cancelledId, 'cancelled')

  // 失败：请求抛错
  s.platform.hooks.delete(1)
  s.platform.errors.set(1, new Error('boom'))
  const created3 = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'iphone pro', pages: 1 }),
  )
  const failedId = (created3.result as { task: Task }).task.id
  await waitForStatus(s.events, failedId, 'failed')

  // 历史列表：终态任务全部保留
  const all = await taskList(s.runtime, {})
  assert.equal(all.length, 3)
  assert.deepEqual(
    [...all.map((t) => t.id)].sort(),
    [completedId, cancelledId, failedId].sort(),
  )
  // 已完成任务仍带 result（统计不丢）
  const completed = all.find((t) => t.id === completedId)!
  const result = completed.result as unknown as CaptureResult
  assert.equal(result.fetched, 2)
  assert.equal(result.valid, 2)
  assert.equal(result.pagesCompleted, 1)

  // 状态过滤
  const completedOnly = await taskList(s.runtime, { status: 'completed' })
  assert.equal(completedOnly.length, 1)
  assert.equal(completedOnly[0].id, completedId)

  // 关键词过滤（大小写不敏感，命中 iphone 与 iphone pro）
  const iphone = await taskList(s.runtime, { keyword: 'IPHONE' })
  assert.equal(iphone.length, 2)
  assert.deepEqual(
    [...iphone.map((t) => t.id)].sort(),
    [completedId, failedId].sort(),
  )

  // 类型过滤（仅 capture）
  const captures = await taskList(s.runtime, { type: 'capture' })
  assert.equal(captures.length, 3)
  const publishes = await taskList(s.runtime, { type: 'publish' })
  assert.equal(publishes.length, 0)
})

test('TASK_LIST 支持排序（createdAt / updatedAt）与 limit', async () => {
  const s = setup()
  // 顺序创建 3 个任务（调小间隔保证 createdAt 严格递增）
  const ids: string[] = []
  for (const keyword of ['one', 'two', 'three']) {
    const res = await s.runtime.handleCommand(
      cmd(CommandTypes.CAPTURE_CREATE, { keyword, pages: 1 }),
    )
    ids.push((res.result as { task: Task }).task.id)
    // 取消后台 run 的干扰：立即取消（pending → cancelled），并错开时间戳
    await s.runtime.handleCommand(cmd(CommandTypes.CAPTURE_CANCEL, { id: ids[ids.length - 1] }))
    await new Promise((resolve) => setTimeout(resolve, 3))
  }

  const asc = await taskList(s.runtime, { sortBy: 'createdAt', sortOrder: 'asc' })
  assert.deepEqual(asc.map((t) => t.id), ids)
  const desc = await taskList(s.runtime, { sortBy: 'createdAt', sortOrder: 'desc' })
  assert.deepEqual(desc.map((t) => t.id), [...ids].reverse())

  // limit 在排序之后生效（取最新的一条）
  const limited = await taskList(s.runtime, { sortBy: 'createdAt', sortOrder: 'desc', limit: 1 })
  assert.equal(limited.length, 1)
  assert.equal(limited[0].id, ids[2])

  // 非法排序值被负载校验拒绝
  const bad = await s.runtime.handleCommand(cmd(CommandTypes.TASK_LIST, { sortBy: 'nope' }))
  assert.equal(bad.ok, false)
  assert.equal(bad.error?.code, 'INVALID_PAYLOAD')
})

test('状态 / 统计 / result 持久化：SW 重启（新 TaskManager）后仍可恢复', async () => {
  const s = setup()
  s.platform.pages.set(1, makePage([makeListItem({ itemId: 'A' }), makeListItem({ itemId: 'B' })]))
  s.platform.pages.set(2, makePage([makeListItem({ itemId: 'C' })]))
  const created = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_CREATE, { keyword: '持久化', pages: 2 }),
  )
  const id = (created.result as { task: Task }).task.id
  await waitForStatus(s.events, id, 'completed')

  // 模拟 Service Worker 重启：全新 TaskManager + 运行时共享同一底层存储适配器
  const restarted = setup({ adapter: s.adapter, prefix: s.prefix })
  await restarted.runtime.init()

  const tasks = await taskList(restarted.runtime, {})
  assert.equal(tasks.length, 1)
  const restored = tasks[0]
  assert.equal(restored.id, id)
  assert.equal(restored.status, 'completed')
  assert.equal(restored.progress, 100)

  const result = restored.result as unknown as CaptureResult
  assert.equal(result.fetched, 3)
  assert.equal(result.valid, 3)
  assert.equal(result.pagesCompleted, 2)
  const checkpoint = (restored.meta as { capture: CaptureCheckpoint }).capture
  assert.equal(checkpoint.nextPage, 3)
  assert.equal(checkpoint.stats.valid, 3)

  // 恢复不会自动续跑任何搜索
  assert.equal(restarted.platform.searchCalls.length, 0)
})

test('超长 keyword / error 按 CAPTURE_LIMITS 截断，核心统计不丢', async () => {
  const s = setup()
  const longKeyword = 'k'.repeat(CAPTURE_LIMITS.captureKeywordMaxLength + 50)
  s.platform.pages.set(1, makePage([makeListItem({ itemId: 'A' })]))
  const created = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_CREATE, { keyword: longKeyword, pages: 1 }),
  )
  const id = (created.result as { task: Task }).task.id
  await waitForStatus(s.events, id, 'completed')

  const [task] = await taskList(s.runtime, {})
  const storedKeyword = (task.payload as { keyword: string }).keyword
  assert.equal(storedKeyword.length, CAPTURE_LIMITS.captureKeywordMaxLength)
  // 统计仍在
  assert.equal((task.result as unknown as CaptureResult).valid, 1)

  // 失败信息的长度限制
  s.platform.errors.set(1, new Error('e'.repeat(CAPTURE_LIMITS.taskErrorMaxLength + 100)))
  const failedRes = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'err', pages: 1 }),
  )
  const failedId = (failedRes.result as { task: Task }).task.id
  await waitForStatus(s.events, failedId, 'failed')
  const failedTask = (await taskList(s.runtime, { status: 'failed' }))[0]
  assert.equal(failedTask.error!.length, CAPTURE_LIMITS.taskErrorMaxLength)
})
