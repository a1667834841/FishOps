/**
 * 采集闭环 smoke 场景（可执行、无真实网络）。
 *
 * 由 `scripts/capture-smoke.mjs` 调用；覆盖：create → progress → pause → resume → cancel、
 * 去重 / 过滤 / 入库、平台不可用的初始化错误、启动恢复不自动续跑、
 * 任务历史（TASK_LIST）与流量词 suggest（去重 / 空输入不调用 / 平台错误）。
 */
import { CommandTypes, EventTypes } from '@fishops/shared'
import type { CommandEnvelope, TaskChangedPayload } from '@fishops/shared'
import { MemoryTaskStore, TaskManager } from '../../../../shared/task/index'
import type { Task } from '../../../../shared/task/index'
import { MemoryProductRepository } from '../../../../shared/capture/product-repository'
import type { CaptureCheckpoint, CaptureResult, CaptureSuggestWordsResult } from '../../../../shared/types/capture'
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

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

function setup(available = true) {
  const store = new MemoryTaskStore()
  const tasks = new TaskManager({ store })
  const repository = new MemoryProductRepository()
  const platform = new MockPlatform()
  platform.available = available
  const events: CaptureEventEnvelope[] = []
  const runtime = createCaptureRuntime({
    platform,
    repository,
    tasks,
    sleep: async () => {},
    onEvent: (event) => events.push(event),
  })
  return { store, tasks, repository, platform, events, runtime }
}

export async function runCaptureSmoke(): Promise<boolean> {
  let passed = 0
  let failed = 0
  const check = (label: string, condition: boolean): void => {
    if (condition) {
      passed += 1
      console.log(`  ✓ ${label}`)
    } else {
      failed += 1
      console.error(`  ✗ ${label}`)
    }
  }

  // ---- 1. create → progress → completed（跨页去重 + 过滤）----
  console.log('1) create → progress → completed（去重 / 过滤 / 入库）')
  const s1 = setup()
  s1.platform.pages.set(1, makePage([makeListItem({ itemId: 'A', wantCnt: 10 }), makeListItem({ itemId: 'B', wantCnt: 10 })]))
  s1.platform.pages.set(2, makePage([makeListItem({ itemId: 'B', wantCnt: 10 }), makeListItem({ itemId: 'C', wantCnt: 1 })]))
  const createRes = await s1.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'iPhone', pages: 2, filter: { minWantCnt: 5 } }),
  )
  check('CAPTURE_CREATE 成功', createRes.ok === true)
  const taskId = (createRes.result as { task: Task }).task.id
  await waitFor(() =>
    s1.events.some(
      (event) =>
        event.type === EventTypes.TASK_CHANGED &&
        (event.payload as TaskChangedPayload).task.id === taskId &&
        (event.payload as TaskChangedPayload).task.status === 'completed',
    ),
  )
  const getRes = await s1.runtime.handleCommand(cmd(CommandTypes.CAPTURE_GET, { id: taskId }))
  const task = (getRes.result as { task: Task }).task
  const result = task.result as unknown as CaptureResult
  check('任务 completed 且 progress=100', task.status === 'completed' && task.progress === 100)
  check('跨页 itemId B 计为 duplicate', result.duplicates === 1)
  check('wantCnt<5 的 C 被过滤', result.filtered === 1 && result.valid === 2)
  const products = await s1.runtime.handleCommand(cmd(CommandTypes.PRODUCT_LIST, { source: 'all' }))
  check('商品库去重后 2 条', (products.result as { total: number }).total === 2)
  const hist1 = await s1.runtime.handleCommand(cmd(CommandTypes.TASK_LIST, { type: 'capture' }))
  const hist1Tasks = (hist1.result as { tasks: Task[] }).tasks
  check(
    'TASK_LIST 历史可见已完成任务',
    hist1Tasks.length === 1 && hist1Tasks[0]?.id === taskId && hist1Tasks[0]?.status === 'completed',
  )

  // ---- 2. pause → resume（断点续采）----
  console.log('2) pause → resume（inflight 暂停、断点续采）')
  const s2 = setup()
  s2.platform.pages.set(1, makePage([makeListItem({ itemId: 'P1' })]))
  s2.platform.pages.set(2, makePage([makeListItem({ itemId: 'P2' })]))
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  s2.platform.hooks.set(2, () => gate)
  const c2 = await s2.runtime.handleCommand(cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 2 }))
  const id2 = (c2.result as { task: Task }).task.id
  await waitFor(() => s2.platform.searchCalls.includes(2))
  const paused = await s2.runtime.handleCommand(cmd(CommandTypes.CAPTURE_PAUSE, { id: id2, reason: '暂停' }))
  check('暂停后状态 paused', (paused.result as { task: Task }).task.status === 'paused')
  release()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const resumed = await s2.runtime.handleCommand(cmd(CommandTypes.CAPTURE_RESUME, { id: id2 }))
  const resumedTask = (resumed.result as { task: Task }).task
  check('恢复后 completed', resumedTask.status === 'completed')
  check('断点推进到第 3 页', (resumedTask.meta as { capture: CaptureCheckpoint }).capture.nextPage === 3)

  // ---- 3. cancel（inflight 取消不变 completed）----
  console.log('3) cancel（inflight 取消保持 cancelled）')
  const s3 = setup()
  s3.platform.pages.set(1, makePage([makeListItem({ itemId: 'X' })]))
  let release3!: () => void
  const gate3 = new Promise<void>((resolve) => {
    release3 = resolve
  })
  s3.platform.hooks.set(1, () => gate3)
  const c3 = await s3.runtime.handleCommand(cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k', pages: 1 }))
  const id3 = (c3.result as { task: Task }).task.id
  await waitFor(() => s3.platform.searchCalls.includes(1))
  await s3.runtime.handleCommand(cmd(CommandTypes.CAPTURE_CANCEL, { id: id3, reason: '取消' }))
  release3()
  await new Promise((resolve) => setTimeout(resolve, 10))
  const final3 = await s3.runtime.handleCommand(cmd(CommandTypes.CAPTURE_GET, { id: id3 }))
  check('取消后状态 cancelled', (final3.result as { task: Task }).task.status === 'cancelled')
  const hist3 = await s3.runtime.handleCommand(cmd(CommandTypes.TASK_LIST, { type: 'capture' }))
  const hist3Tasks = (hist3.result as { tasks: Task[] }).tasks
  check(
    'TASK_LIST 历史可见已取消任务',
    hist3Tasks.length === 1 && hist3Tasks[0]?.id === id3 && hist3Tasks[0]?.status === 'cancelled',
  )

  // ---- 4. 平台不可用：初始化错误而非假成功 ----
  console.log('4) 平台不可用 → PLATFORM_ERROR(host-unavailable)')
  const s4 = setup(false)
  const unavailableRes = await s4.runtime.handleCommand(cmd(CommandTypes.CAPTURE_CREATE, { keyword: 'k' }))
  check('返回错误而非成功', unavailableRes.ok === false)
  check(
    '错误码为 PLATFORM_ERROR/host-unavailable',
    unavailableRes.error?.code === 'PLATFORM_ERROR' && unavailableRes.error?.category === 'host-unavailable',
  )
  check('未创建任务', (await s4.tasks.list()).length === 0)

  // ---- 5. 启动恢复：running → paused 且不自动续跑 ----
  console.log('5) 启动恢复：running → paused（不自动续跑）')
  const store5 = new MemoryTaskStore()
  const writer = new TaskManager({ store: store5 })
  const checkpoint: CaptureCheckpoint = {
    keyword: 'x',
    startPage: 1,
    totalPages: 3,
    nextPage: 2,
    pagesCompleted: 1,
    stats: { fetched: 2, valid: 2, filtered: 0, duplicates: 0, failed: 0 },
  }
  const created5 = await writer.create({ type: 'capture', payload: { keyword: 'x', pages: 3 }, meta: { capture: checkpoint } })
  await writer.start(created5.id)
  await writer.updateProgress(created5.id, 40, { capture: checkpoint })
  const s5 = setup()
  // 复用同一 store
  const runtime5 = createCaptureRuntime({
    platform: s5.platform,
    repository: s5.repository,
    tasks: new TaskManager({ store: store5 }),
    sleep: async () => {},
  })
  await runtime5.init()
  const [recovered] = await writer.list({ type: 'capture' })
  check('恢复为 paused', recovered?.status === 'paused')
  check('保留断点 nextPage=2', (recovered?.meta as { capture: CaptureCheckpoint }).capture.nextPage === 2)
  check('未自动发起搜索', s5.platform.searchCalls.length === 0)

  // ---- 6. 流量词 suggest：mock 返回 / 去重 / 空输入不调用 / 平台错误 ----
  console.log('6) 流量词 suggest（mock，无真实网络）')
  const s6 = setup()
  s6.platform.suggestWords = ['iPhone', 'iphone', 'iPad']
  const sug = await s6.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword: 'iph', queryId: 'q1' }),
  )
  const sugResult = sug.result as CaptureSuggestWordsResult
  check('suggest 成功且去重后 2 条', sug.ok === true && sugResult.words.length === 2)
  check('suggest 保留首次出现并回显 queryId + sequence', sugResult.words[0] === 'iPhone' && sugResult.queryId === 'q1' && sugResult.sequence >= 1)
  check('suggest 不创建采集任务', (await s6.tasks.list()).length === 0)
  const emptySug = await s6.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword: '   ' }),
  )
  check('suggest 空输入不调用平台且回 INVALID_PAYLOAD', emptySug.ok === false && s6.platform.suggestCalls.length === 1)
  const s6b = setup(false)
  const sugUnavailable = await s6b.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword: 'k' }),
  )
  check(
    'suggest 平台不可用回 PLATFORM_ERROR(host-unavailable)',
    sugUnavailable.error?.code === 'PLATFORM_ERROR' && sugUnavailable.error?.category === 'host-unavailable',
  )
  check('suggest 平台不可用时不调用平台', s6b.platform.suggestCalls.length === 0)

  console.log(`\n采集闭环 smoke：${passed} 通过，${failed} 失败`)
  return failed === 0
}
