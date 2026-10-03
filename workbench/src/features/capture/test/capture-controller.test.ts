/**
 * CaptureController 纯逻辑单测：
 * 覆盖：
 * - 任务历史保留与合并（按 id + updatedAt，不覆盖更新的快照，不丢弃已有历史）
 * - 允许已有 active 任务时新增任务（防重复提交，不因 active 禁用新建）
 * - suggest debounce / 立即查询 / 空输入不调用
 * - 旧响应按 sequence / queryId 丢弃（防乱序与过期覆盖）
 * - 点击建议词填充但不自动提交任务
 * - 非扩展环境安全
 * 无真实网络，纯 Node 环境。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, EventTypes } from '@fishops/shared'
import {
  CaptureController,
} from '../capture-controller'
import type { BridgeApi } from '../../shared/bridge-api'
import type { Task } from '../../contracts'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Responder = (payload: unknown) => unknown | Promise<unknown>

class FakeBridgeApi implements BridgeApi {
  readonly calls: Array<{ type: string; payload: unknown }> = []
  readonly handlers = new Map<string, Set<(payload: unknown) => void>>()
  private readonly responders = new Map<string, Responder>()

  respond(type: string, responder: Responder): void {
    this.responders.set(type, responder)
  }

  async call(type: never, payload: never): Promise<never> {
    this.calls.push({ type, payload })
    const responder = this.responders.get(type)
    if (!responder) throw new Error(`未配置 ${type} 的响应`)
    return (await responder(payload)) as never
  }

  on(type: never, handler: (payload: never) => void): () => void {
    const set = this.handlers.get(type) ?? new Set()
    set.add(handler as (payload: unknown) => void)
    this.handlers.set(type, set)
    return () => {
      set.delete(handler as (payload: unknown) => void)
    }
  }

  resubscribe(): void {}

  emit(type: string, payload: unknown): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) {
      handler(payload)
    }
  }

  count(type: string): number {
    return this.calls.filter((c) => c.type === type).length
  }
}

function makeTask(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    type: 'capture',
    status: 'running',
    progress: 10,
    createdAt: 1000,
    updatedAt: 1000,
    payload: { keyword: `kw-${id}` },
    ...extra,
  }
}

test('非扩展环境：状态为 unavailable，不发起任何请求', async () => {
  const controller = new CaptureController({ api: null })
  controller.start()
  assert.equal(controller.getState().availability, 'unavailable')
  assert.equal(controller.getState().tasks.items.length, 0)
  // 不发起 suggest
  await controller.fetchSuggest('test', { immediate: true })
  assert.equal(controller.getState().suggest.phase, 'idle')
  // 不发起 create
  const created = await controller.createTask({ keyword: 'test' })
  assert.equal(created, false)
})

test('任务历史保留：多次创建任务均保留在历史列表中，按 createdAt 倒序', async () => {
  const api = new FakeBridgeApi()
  api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [] }))

  let idCounter = 1
  api.respond(CommandTypes.CAPTURE_CREATE, (payload: unknown) => {
    const p = payload as { keyword: string }
    const id = `t_${idCounter++}`
    return {
      task: makeTask(id, {
        payload: { keyword: p.keyword },
        createdAt: 1000 * idCounter,
        updatedAt: 1000 * idCounter,
      }),
    }
  })

  const controller = new CaptureController({ api })
  controller.start()
  await new Promise((r) => setTimeout(r, 10))

  // 创建任务 1
  const ok1 = await controller.createTask({ keyword: '苹果' })
  assert.equal(ok1, true)
  assert.equal(controller.getState().tasks.items.length, 1)
  assert.equal(controller.getState().selectedId, 't_1')

  // 任务 1 仍在 running 时，允许继续创建任务 2
  const ok2 = await controller.createTask({ keyword: '华为' })
  assert.equal(ok2, true)
  assert.equal(controller.getState().tasks.items.length, 2)
  // 最新创建的在前
  assert.equal(controller.getState().tasks.items[0].id, 't_2')
  assert.equal(controller.getState().tasks.items[1].id, 't_1')
  assert.equal(controller.getState().selectedId, 't_2')
})

test('任务历史合并：TASK_LIST 刷新时不丢失本地历史，且按 id + updatedAt 优先保留最新快照', async () => {
  const api = new FakeBridgeApi()
  const controller = new CaptureController({ api })

  const taskA_v1 = makeTask('t_a', { updatedAt: 100, createdAt: 100 })
  const taskB_local = makeTask('t_b', { updatedAt: 200, createdAt: 200 })

  api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [taskA_v1] }))
  controller.start()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(controller.getState().tasks.items.length, 1)

  // 模拟本地通过事件更新了 taskA 到 v2 (updatedAt: 300)，并新增了 taskB (updatedAt: 200)
  api.emit(EventTypes.TASK_CHANGED, {
    task: makeTask('t_a', { updatedAt: 300, createdAt: 100, progress: 80 }),
  })
  api.emit(EventTypes.TASK_CHANGED, { task: taskB_local })

  assert.equal(controller.getState().tasks.items.length, 2)
  assert.equal(controller.getState().tasks.items.find((t) => t.id === 't_a')?.progress, 80)

  // 模拟远端 TASK_LIST 返回：taskA 仍然是旧的 (updatedAt: 150)，且远端暂时未包含 taskB
  api.respond(CommandTypes.TASK_LIST, () => ({
    tasks: [makeTask('t_a', { updatedAt: 150, createdAt: 100, progress: 20 })],
  }))

  await controller.refresh()

  // 合并后：
  // 1. taskA 本地 updatedAt 300 > 远端 150，保留本地较新快照（progress 80，不被覆盖）
  const a = controller.getState().tasks.items.find((t) => t.id === 't_a')
  assert.equal(a?.updatedAt, 300)
  assert.equal(a?.progress, 80)

  // 2. taskB 本地历史未被抹除，依然存在
  const b = controller.getState().tasks.items.find((t) => t.id === 't_b')
  assert.ok(b)
  assert.equal(b?.id, 't_b')
})

test('WORKER_STARTED 事件触发对账合并，不丢失更新快照', async () => {
  const api = new FakeBridgeApi()
  const controller = new CaptureController({ api })

  api.respond(CommandTypes.TASK_LIST, () => ({
    tasks: [makeTask('t1', { updatedAt: 100 })],
  }))
  controller.start()
  await new Promise((r) => setTimeout(r, 10))

  // 更新本地快照
  api.emit(EventTypes.TASK_CHANGED, {
    task: makeTask('t1', { updatedAt: 500, progress: 99 }),
  })

  // 后台重启，上报 updatedAt: 400 的旧快照
  api.respond(CommandTypes.TASK_LIST, () => ({
    tasks: [makeTask('t1', { updatedAt: 400, progress: 50 })],
  }))

  api.emit(EventTypes.WORKER_STARTED, {})
  await new Promise((r) => setTimeout(r, 10))

  const task = controller.getState().tasks.items.find((t) => t.id === 't1')
  assert.equal(task?.updatedAt, 500)
  assert.equal(task?.progress, 99)
})

test('suggest 空输入不调用后台，清空并保持 idle', async () => {
  const api = new FakeBridgeApi()
  api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [] }))
  api.respond(CommandTypes.CAPTURE_SUGGEST_WORDS, () => ({
    keyword: 'test',
    words: ['a', 'b'],
    sequence: 1,
  }))

  const controller = new CaptureController({ api })
  controller.start()

  // 连续传空字符串或空格
  await controller.fetchSuggest('', { immediate: true })
  await controller.fetchSuggest('   ', { immediate: true })

  assert.equal(api.count(CommandTypes.CAPTURE_SUGGEST_WORDS), 0)
  assert.equal(controller.getState().suggest.phase, 'idle')
  assert.deepEqual(controller.getState().suggest.words, [])
})

test('suggest debounce：防抖时间内多次输入只发出最后一次请求', async () => {
  const api = new FakeBridgeApi()
  api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [] }))
  api.respond(CommandTypes.CAPTURE_SUGGEST_WORDS, (p) => {
    const payload = p as { keyword: string }
    return {
      keyword: payload.keyword,
      words: [`${payload.keyword}-词1`, `${payload.keyword}-词2`],
      sequence: 1,
    }
  })

  const controller = new CaptureController({ api })
  controller.start()

  // 模拟快速键入
  controller.fetchSuggest('i', { debounceMs: 50 })
  controller.fetchSuggest('ip', { debounceMs: 50 })
  const p = controller.fetchSuggest('iph', { debounceMs: 50 })

  await p

  assert.equal(api.count(CommandTypes.CAPTURE_SUGGEST_WORDS), 1)
  assert.equal(controller.getState().suggest.words[0], 'iph-词1')
})

test('suggest 立即调用（点击按钮）：不等待防抖直接发起命令', async () => {
  const api = new FakeBridgeApi()
  api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [] }))
  api.respond(CommandTypes.CAPTURE_SUGGEST_WORDS, () => ({
    keyword: '手机',
    words: ['手机壳', '手机支架'],
    sequence: 1,
  }))

  const controller = new CaptureController({ api })
  controller.start()

  await controller.fetchSuggest('手机', { immediate: true })

  assert.equal(api.count(CommandTypes.CAPTURE_SUGGEST_WORDS), 1)
  assert.equal(controller.getState().suggest.phase, 'ok')
  assert.deepEqual(controller.getState().suggest.words, ['手机壳', '手机支架'])
})

test('suggest 旧响应丢弃：sequence 较小的乱序响应被丢弃，不覆盖已渲染的新结果', async () => {
  const api = new FakeBridgeApi()
  api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [] }))

  const d1 = defer<{ keyword: string; words: string[]; sequence: number }>()
  const d2 = defer<{ keyword: string; words: string[]; sequence: number }>()

  let callIndex = 0
  api.respond(CommandTypes.CAPTURE_SUGGEST_WORDS, () => {
    callIndex++
    if (callIndex === 1) return d1.promise
    return d2.promise
  })

  const controller = new CaptureController({ api })
  controller.start()

  // 请求 1（先发出，后台分配 sequence 1）
  const p1 = controller.fetchSuggest('q1', { immediate: true, queryId: 'q1' })
  // 请求 2（后发出，后台分配 sequence 2）
  const p2 = controller.fetchSuggest('q2', { immediate: true, queryId: 'q2' })

  // 请求 2 先返回
  d2.resolve({ keyword: 'q2', words: ['word-2'], sequence: 2 })
  await p2
  assert.equal(controller.getState().suggest.phase, 'ok')
  assert.deepEqual(controller.getState().suggest.words, ['word-2'])

  // 请求 1 迟到返回，sequence 为 1 <= 已渲染 sequence 2，应当被丢弃
  d1.resolve({ keyword: 'q1', words: ['stale-1'], sequence: 1 })
  await p1

  assert.deepEqual(controller.getState().suggest.words, ['word-2'])
  assert.equal(controller.getState().suggest.query, 'q2')
})

test('suggest 点击建议词：仅填充并关闭建议，绝不触发任务创建', async () => {
  const api = new FakeBridgeApi()
  api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [] }))
  api.respond(CommandTypes.CAPTURE_SUGGEST_WORDS, () => ({
    keyword: 'ipad',
    words: ['ipad pro', 'ipad air'],
    sequence: 1,
  }))

  const controller = new CaptureController({ api })
  controller.start()

  await controller.fetchSuggest('ipad', { immediate: true })
  assert.equal(controller.getState().suggest.phase, 'ok')
  assert.equal(controller.getState().suggest.words.length, 2)

  // 用户点击某个建议词
  const selected = controller.selectSuggestWord('ipad pro')
  assert.equal(selected, 'ipad pro')

  // 建议词状态被清空关闭
  assert.equal(controller.getState().suggest.phase, 'idle')
  assert.deepEqual(controller.getState().suggest.words, [])

  // 验证绝对没有调用 CAPTURE_CREATE
  assert.equal(api.count(CommandTypes.CAPTURE_CREATE), 0)
  assert.equal(controller.getState().tasks.items.length, 0)
})
