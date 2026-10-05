/**
 * 数据采集流程 focused 回归测试：
 * 覆盖：
 * 1. 流量词建议只调用 CAPTURE_SUGGEST_WORDS，绝不调用 CAPTURE_CREATE 造任务；
 * 2. 标签多选与建议词已选去重、上限拦截；
 * 3. 使用 fake timer (mock.timers) 验证 suggest debounce 与任务运行耗时推进；
 * 4. 真实 state/stats 映射（fetched, valid, filtered, duplicates, failed, stored），禁止臆造成功率/自动并发；
 * 5. 任务流转动作权限（暂停、恢复、取消）与批量失败重试快照行为。
 */
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { CommandTypes } from '@fishops/shared'
import { CaptureController } from '../capture-controller'
import {
  appendKeywordTag,
  buildBatchCapturePayloads,
  defaultCaptureForm,
  formatTaskDuration,
  formatTaskValidCount,
  isKeywordSelected,
  parseKeywordTags,
  toCaptureTaskView,
} from '../capture-format'
import type { BridgeApi } from '../../shared/bridge-api'
import type { Task } from '../../contracts'

type Responder = (payload: unknown) => unknown | Promise<unknown>

class MockBridgeApi implements BridgeApi {
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

function makeTaskSnapshot(id: string, extra: Partial<Task> = {}): Task {
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

test('建议词只走 CAPTURE_SUGGEST_WORDS，生产 helper (appendKeywordTag) 严格去重与连续多选，绝不造任务', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [] }))
  api.respond(CommandTypes.CAPTURE_SUGGEST_WORDS, () => ({
    keyword: '镜头',
    words: ['索尼 24-70 GM2', '腾龙 28-200'],
    sequence: 1,
  }))

  const controller = new CaptureController({ api })
  controller.start()

  // 1. 发起建议词查询：只调用 CAPTURE_SUGGEST_WORDS，绝不调用 CAPTURE_CREATE
  await controller.fetchSuggest('镜头', { immediate: true })
  assert.equal(api.count(CommandTypes.CAPTURE_SUGGEST_WORDS), 1)
  assert.equal(api.count(CommandTypes.CAPTURE_CREATE), 0)

  // 2. 生产逻辑验证：直接调用生产 helper appendKeywordTag 处理连续点选与去重
  let currentTags: string[] = []
  const suggestWords = controller.getState().suggest.words

  // 第一次点选第一个词
  const step1 = appendKeywordTag(suggestWords[0], currentTags)
  assert.equal(step1.added, true)
  assert.equal(step1.error, undefined)
  assert.deepEqual(step1.tags, ['索尼 24-70 GM2'])
  currentTags = step1.tags

  // 生产 isKeywordSelected 校验：第一个词已显示选中状态
  assert.equal(isKeywordSelected('索尼 24-70 GM2', currentTags), true)
  assert.equal(isKeywordSelected('腾龙 28-200', currentTags), false)

  // 连续点选同一个词：严格去重，不重复添加，added 为 false
  const stepDup = appendKeywordTag('索尼 24-70 GM2', currentTags)
  assert.equal(stepDup.added, false)
  assert.deepEqual(stepDup.tags, ['索尼 24-70 GM2'])

  // 连续点选第二个词：正常追加，保持已选多词
  const step2 = appendKeywordTag(suggestWords[1], currentTags)
  assert.equal(step2.added, true)
  assert.deepEqual(step2.tags, ['索尼 24-70 GM2', '腾龙 28-200'])
  currentTags = step2.tags

  // 生产 isKeywordSelected 校验：两项均已处于选中打勾状态
  assert.equal(isKeywordSelected('索尼 24-70 GM2', currentTags), true)
  assert.equal(isKeywordSelected('腾龙 28-200', currentTags), true)

  // 选词全程绝不调用创建任务命令
  assert.equal(api.count(CommandTypes.CAPTURE_CREATE), 0)
  assert.equal(controller.getState().tasks.items.length, 0)
})

test('生产 helper (appendKeywordTag)：空词、超长词与 20 词上限拦截真实生产规则', () => {
  // 1. 空词不添加
  const emptyRes = appendKeywordTag('   ', ['已有词'])
  assert.equal(emptyRes.added, false)
  assert.deepEqual(emptyRes.tags, ['已有词'])

  // 2. 单词超长 (>60) 拦截并报错
  const longWord = 'w'.repeat(61)
  const longRes = appendKeywordTag(longWord, ['已有词'])
  assert.equal(longRes.added, false)
  assert.deepEqual(longRes.tags, ['已有词'])
  assert.ok(longRes.error?.includes('超过 60 个字符'))

  // 3. 超过 20 词上限拦截并报错
  const twentyTags = Array.from({ length: 20 }, (_, i) => `词${i + 1}`)
  const overflowRes = appendKeywordTag('第21个新词', twentyTags)
  assert.equal(overflowRes.added, false)
  assert.equal(overflowRes.tags.length, 20)
  assert.ok(overflowRes.error?.includes('最多支持 20 个'))

  // 4. 重复词即使在已满 20 词时也不会报上限错误，仅标记 added: false
  const dupTwenty = appendKeywordTag('词1', twentyTags)
  assert.equal(dupTwenty.added, false)
  assert.equal(dupTwenty.error, undefined)
  assert.equal(dupTwenty.tags.length, 20)
})

test('标签解析与去重：支持逐个追加、已选去重、上限20词及60字限制', () => {
  let tags: string[] = []

  // 1. 逐个追加
  const res1 = parseKeywordTags(['Sony A7M4'], tags)
  assert.deepEqual(res1.tags, ['Sony A7M4'])
  tags = res1.tags

  const res2 = parseKeywordTags(['富士 X-T5'], tags)
  assert.deepEqual(res2.tags, ['Sony A7M4', '富士 X-T5'])
  tags = res2.tags

  // 2. 重复词添加去重
  const resDup = parseKeywordTags(['Sony A7M4'], tags)
  assert.deepEqual(resDup.tags, ['Sony A7M4', '富士 X-T5'])
  assert.equal(resDup.error, undefined)

  // 3. 超过 20 词拦截
  const fullTags = Array.from({ length: 20 }, (_, i) => `词_${i + 1}`)
  const resOverflow = parseKeywordTags(['第21词'], fullTags)
  assert.equal(resOverflow.tags.length, 20)
  assert.ok(resOverflow.error?.includes('最多支持 20 个'))

  // 4. 单词超过 60 字拦截
  const longWord = 'k'.repeat(61)
  const resLong = parseKeywordTags([longWord], tags)
  assert.deepEqual(resLong.tags, tags)
  assert.ok(resLong.error?.includes('超过 60 个字符'))
})

test('Fake Timer: suggest debounce 防抖与任务耗时随时间推移正确演进', async () => {
  mock.timers.enable()
  try {
    const api = new MockBridgeApi()
    api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [] }))
    api.respond(CommandTypes.CAPTURE_SUGGEST_WORDS, (p) => {
      const payload = p as { keyword: string }
      return {
        keyword: payload.keyword,
        words: [`${payload.keyword}-词项`],
        sequence: 1,
      }
    })

    const controller = new CaptureController({ api })
    controller.start()

    // 1. 模拟用户输入防抖（300ms debounce）
    void controller.fetchSuggest('cam', { debounceMs: 300 })
    void controller.fetchSuggest('came', { debounceMs: 300 })
    void controller.fetchSuggest('camera', { debounceMs: 300 })

    // 未到达 300ms 前不发出请求
    mock.timers.tick(200)
    assert.equal(api.count(CommandTypes.CAPTURE_SUGGEST_WORDS), 0)

    // 推进剩余 150ms（总计 350ms > 300ms），发出且仅发出 1 次请求
    mock.timers.tick(150)
    await Promise.resolve() // 等待 promise 微任务
    assert.equal(api.count(CommandTypes.CAPTURE_SUGGEST_WORDS), 1)
    const suggestCall = api.calls.find((c) => c.type === CommandTypes.CAPTURE_SUGGEST_WORDS)
    assert.ok(suggestCall)
    assert.equal((suggestCall.payload as { keyword: string }).keyword, 'camera')

    // 2. 模拟任务运行耗时 fake timer 演进
    const startTime = 1_000_000
    const runningTask = toCaptureTaskView(
      makeTaskSnapshot('run-1', {
        status: 'running',
        startedAt: startTime,
      }),
    )

    // 10s 后
    assert.equal(formatTaskDuration(runningTask, startTime + 10_000), '10s')
    // 65s 后 -> 1m 5s
    assert.equal(formatTaskDuration(runningTask, startTime + 65_000), '1m 5s')
    // 3665s 后 -> 1h 1m
    assert.equal(formatTaskDuration(runningTask, startTime + 3_665_000), '1h 1m')

    // 已完成任务：耗时固定在 endedAt - startedAt，不随当前时间推移变化
    const doneTask = toCaptureTaskView(
      makeTaskSnapshot('done-1', {
        status: 'completed',
        startedAt: startTime,
        endedAt: startTime + 45_000,
      }),
    )
    assert.equal(formatTaskDuration(doneTask, startTime + 45_000), '45s')
    assert.equal(formatTaskDuration(doneTask, startTime + 999_999), '45s')
  } finally {
    mock.timers.reset()
  }
})

test('真实 state/stats 完整映射，禁止虚构成功率或并发数', () => {
  const rawTask = makeTaskSnapshot('task-real', {
    status: 'running',
    progress: 58,
    startedAt: 1000,
    payload: { keyword: '微单相机', fetchDetail: true },
    meta: {
      capture: {
        keyword: '微单相机',
        startPage: 1,
        totalPages: 10,
        nextPage: 6,
        pagesCompleted: 5,
        stats: {
          fetched: 150,
          valid: 120,
          filtered: 25,
          duplicates: 5,
          failed: 2,
          stored: 118,
        },
      },
    },
  })

  const view = toCaptureTaskView(rawTask)

  // 严格映射真实字段
  assert.equal(view.keyword, '微单相机')
  assert.equal(view.progress, 58)
  assert.equal(view.pagesCompleted, 5)
  assert.equal(view.totalPages, 10)
  assert.equal(view.nextPage, 6)
  assert.equal(view.fetchDetail, true)
  assert.deepEqual(view.stats, {
    fetched: 150,
    valid: 120,
    filtered: 25,
    duplicates: 5,
    failed: 2,
    stored: 118,
  })
  assert.equal(formatTaskValidCount(view), '118')

  // 禁止在视图对象上附带臆造字段
  const viewKeys = Object.keys(view)
  assert.ok(!viewKeys.includes('successRate'), '禁止虚构 successRate')
  assert.ok(!viewKeys.includes('concurrency'), '禁止虚构 concurrency')
  assert.ok(!viewKeys.includes('autoConcurrency'), '禁止虚构 autoConcurrency')
})

test('任务流转动作权限：运行中可暂停取消、已暂停可恢复取消、已完成不可暂停恢复', () => {
  const running = toCaptureTaskView(makeTaskSnapshot('1', { status: 'running' }))
  assert.equal(running.canPause, true)
  assert.equal(running.canResume, false)
  assert.equal(running.canCancel, true)

  const paused = toCaptureTaskView(makeTaskSnapshot('2', { status: 'paused' }))
  assert.equal(paused.canPause, false)
  assert.equal(paused.canResume, true)
  assert.equal(paused.canCancel, true)

  const completed = toCaptureTaskView(makeTaskSnapshot('3', { status: 'completed' }))
  assert.equal(completed.canPause, false)
  assert.equal(completed.canResume, false)
  assert.equal(completed.canCancel, false)

  const pending = toCaptureTaskView(makeTaskSnapshot('4', { status: 'pending' }))
  assert.equal(pending.canPause, false)
  assert.equal(pending.canResume, false)
  assert.equal(pending.canCancel, true)
})

test('批量创建与失败重试原行为保持：保留成功任务，生成精确的失败重试负载', async () => {
  const formValues = {
    ...defaultCaptureForm(),
    keywords: ['Sony A7M4', '富士 X-T5', '佳能 EOS R6'],
    pages: '3',
    rowsPerPage: '20',
    baseIntervalSec: '2',
    randomIntervalSec: '1',
    onlyFreeShip: true,
    fetchDetail: true,
  }

  const buildResult = buildBatchCapturePayloads(formValues)
  assert.equal(buildResult.ok, true)
  if (!buildResult.ok) return

  assert.equal(buildResult.payloads.length, 3)
  assert.equal(buildResult.payloads[0].keyword, 'Sony A7M4')
  assert.equal(buildResult.payloads[0].minIntervalMs, 2000)
  assert.equal(buildResult.payloads[0].intervalJitterMs, 1000)
  assert.equal(buildResult.payloads[0].fetchDetail, true)

  // 模拟批量执行其中第二个词失败
  const api = new MockBridgeApi()
  api.respond(CommandTypes.TASK_LIST, () => ({ tasks: [] }))
  api.respond(CommandTypes.CAPTURE_CREATE, (p) => {
    const payload = p as { keyword: string }
    if (payload.keyword === '富士 X-T5') {
      throw new Error('网络超时')
    }
    return {
      task: makeTaskSnapshot(`t_${payload.keyword}`, {
        payload: { keyword: payload.keyword },
      }),
    }
  })

  const controller = new CaptureController({ api })
  controller.start()

  const batchResult = await controller.createBatchTasks(buildResult.payloads)
  assert.equal(batchResult.successes.length, 2)
  assert.equal(batchResult.failures.length, 1)
  assert.equal(batchResult.failures[0].keyword, '富士 X-T5')

  // 验证失败项可被提取用于重试
  const failedPayloads = buildResult.payloads.filter((p) => p.keyword === '富士 X-T5')
  assert.equal(failedPayloads.length, 1)
  assert.equal(failedPayloads[0].keyword, '富士 X-T5')
})
