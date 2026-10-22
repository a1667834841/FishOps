import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createScheduler } from '../scheduler'
import type { SchedulerState } from '../../../../shared/types/scheduler'

function fixture(execute: () => Promise<void> = async () => {}) {
  let time = 0
  let state: SchedulerState | undefined
  let fail = false
  let maxWrites = Number.POSITIVE_INFINITY
  let writes = 0
  const deps = {
    now: () => time,
    read: async () => structuredClone(state),
    write: async (next: SchedulerState) => {
      writes += 1
      if (fail || writes > maxWrites) throw new Error('quota')
      state = structuredClone(next)
    },
    executors: { test: { validate: (value: unknown) => value !== null, execute } },
  }
  return {
    scheduler: createScheduler(deps),
    restart: () => createScheduler(deps),
    setTime: (value: number) => { time = value },
    fail: () => { fail = true },
    // 允许前 n 次写入成功，用于制造「业务已开始 / 已结束」时的持久化失败。
    allowWrites: (n: number) => { maxWrites = n },
    seed: (value: SchedulerState) => { state = value },
  }
}
const input = { id: 'plan', name: '测试计划', taskType: 'test', config: {}, intervalMinutes: 1, enabled: true }

/** 等待条件成立，用于观察异步启动的执行器调用，不依赖固定 sleep 时长。 */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (condition()) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('等待条件超时')
}

test('保存、重复触发、修改和停用', async () => {
  let calls = 0
  const f = fixture(async () => { calls++ })
  await f.scheduler.save(input)
  assert.equal((await f.scheduler.list())[0]!.nextRunAt, 60000)
  f.setTime(60000)
  await Promise.all([f.scheduler.tick(), f.scheduler.tick()])
  assert.equal(calls, 1)
  assert.equal((await f.scheduler.runs('plan'))[0]!.status, 'succeeded')
  await f.scheduler.save({ ...input, intervalMinutes: 2 })
  assert.equal((await f.scheduler.list())[0]!.nextRunAt, 180000)
  await f.scheduler.setEnabled('plan', false)
  f.setTime(180000)
  await f.scheduler.tick()
  assert.equal(calls, 1)
  assert.equal((await f.scheduler.list())[0]!.nextRunAt, null)
})

test('恢复跳过错过区间，不补跑', async () => {
  let calls = 0
  const f = fixture(async () => { calls++ })
  await f.scheduler.save(input)
  f.setTime(600000)
  const restored = f.restart()
  await restored.tick()
  assert.equal(calls, 0)
  const runs = await restored.runs('plan')
  assert.equal(runs[0]!.status, 'skipped')
  assert.equal(runs[0]!.missedCount, 10)
  assert.equal((await restored.list())[0]!.nextRunAt, 660000)
})

test('同计划运行中跳过，重启后标记中断', async () => {
  let release!: () => void
  const f = fixture(() => new Promise<void>(resolve => { release = resolve }))
  await f.scheduler.save(input)
  f.setTime(60000)
  const pending = f.scheduler.tick()
  while (!release) await new Promise(resolve => setImmediate(resolve))
  f.setTime(120000)
  await f.scheduler.tick()
  assert.equal((await f.scheduler.runs('plan'))[0]!.reason, 'overlap')
  const restored = f.restart()
  assert.ok((await restored.runs('plan')).some(run => run.status === 'interrupted'))
  release()
  await pending
})

test('未知执行器、非法间隔、存储失败拒绝提交', async () => {
  const f = fixture()
  await assert.rejects(f.scheduler.save({ ...input, taskType: 'unknown' }))
  await assert.rejects(f.scheduler.save({ ...input, intervalMinutes: 0 }))
  await assert.rejects(f.scheduler.save({ ...input, intervalMinutes: 1.5 }))
  await assert.rejects(f.scheduler.save({ ...input, config: null }))
  f.fail()
  await assert.rejects(f.scheduler.save(input), /quota/)
  assert.deepEqual(await f.scheduler.list(), [])
})

test('业务失败留下安全原因；重启后记录仍可查询', async () => {
  const f = fixture(async () => { throw new Error('secret token') })
  await f.scheduler.save(input)
  f.setTime(60000)
  await f.scheduler.tick()
  const records = await f.restart().runs('plan')
  assert.equal(records[0]!.status, 'failed')
  assert.equal(records[0]!.reason, 'executor-failed')
  assert.ok(!JSON.stringify(records).includes('secret'))
})

test('多计划独立执行：一个计划运行中不影响另一个计划', async () => {
  let releaseSlow!: () => void
  const fastCalls: number[] = []
  let state: SchedulerState | undefined
  let time = 0
  const scheduler = createScheduler({
    now: () => time,
    read: async () => structuredClone(state),
    write: async (next: SchedulerState) => { state = structuredClone(next) },
    executors: {
      slow: { validate: () => true, execute: () => new Promise<void>(resolve => { releaseSlow = resolve }) },
      fast: { validate: () => true, execute: async () => { fastCalls.push(time) } },
    },
  })
  await scheduler.save({ id: 'a', name: '慢计划', taskType: 'slow', config: {}, intervalMinutes: 1, enabled: true })
  await scheduler.save({ id: 'b', name: '快计划', taskType: 'fast', config: {}, intervalMinutes: 1, enabled: true })
  time = 60000
  const pending = scheduler.tick()
  await until(() => fastCalls.length === 1)
  assert.equal((await scheduler.runs('b'))[0]!.status, 'succeeded')
  assert.equal((await scheduler.runs('a'))[0]!.status, 'running')
  time = 120000
  await scheduler.tick()
  assert.equal((await scheduler.runs('a'))[0]!.reason, 'overlap')
  assert.equal(fastCalls.length, 2)
  releaseSlow()
  await pending
})

test('迟到在容差内执行，超过容差跳过一次并按间隔推进', async () => {
  let calls = 0
  const f = fixture(async () => { calls++ })
  await f.scheduler.save(input)
  f.setTime(119999)
  await f.scheduler.tick()
  assert.equal(calls, 1)
  assert.equal((await f.scheduler.runs('plan'))[0]!.status, 'succeeded')
  f.setTime(120000 + 60000)
  await f.scheduler.tick()
  assert.equal(calls, 1)
  assert.equal((await f.scheduler.runs('plan'))[0]!.reason, 'missed')
  assert.equal((await f.scheduler.list())[0]!.nextRunAt, 240000)
})

test('无效计划与配置被拒绝，边界间隔可接受', async () => {
  const f = fixture()
  await assert.rejects(f.scheduler.save({ ...input, id: 'has space' }))
  await assert.rejects(f.scheduler.save({ ...input, id: '' }))
  await assert.rejects(f.scheduler.save({ ...input, name: '   ' }))
  await assert.rejects(f.scheduler.save({ ...input, taskType: 'x'.repeat(81) }))
  await assert.rejects(f.scheduler.save({ ...input, intervalMinutes: 525601 }))
  await assert.rejects(f.scheduler.save({ ...input, enabled: 'yes' as unknown as boolean }))
  await assert.rejects(f.scheduler.save({ ...input, config: { fn: () => 1 } }))
  await assert.rejects(f.scheduler.save({ ...input, config: { n: Number.NaN } }))
  await assert.rejects(f.scheduler.save({ ...input, config: { big: 1n } }))
  await assert.rejects(f.scheduler.save({ ...input, config: { blob: 'x'.repeat(70000) } }))
  const shortest = await f.scheduler.save({ ...input, intervalMinutes: 1 })
  assert.equal(shortest.nextRunAt, 60000)
  const longest = await f.scheduler.save({ ...input, id: 'long', intervalMinutes: 525600 })
  assert.equal(longest.nextRunAt, 525600 * 60000)
  assert.deepEqual(f.scheduler.executorTypes(), ['test'])
})

test('持久化内容非法时拒绝静默清空', async () => {
  const f = fixture()
  f.seed({ version: 2 as unknown as 1, schedules: [], runs: [] })
  await assert.rejects(f.scheduler.list(), /调度存储格式无效/)
  const duplicated = fixture()
  duplicated.seed({
    version: 1,
    schedules: [
      { ...input, createdAt: 0, updatedAt: 0, nextRunAt: 60000 },
      { ...input, createdAt: 0, updatedAt: 0, nextRunAt: 60000 },
    ],
    runs: [],
  })
  await assert.rejects(duplicated.scheduler.list(), /调度存储格式无效/)
  const badRun = fixture()
  badRun.seed({ version: 1, schedules: [], runs: [{ id: 'r', scheduleId: 'x', scheduledAt: 0, startedAt: 0, finishedAt: null, status: 'bogus' as unknown as 'running' }] })
  await assert.rejects(badRun.scheduler.list(), /调度存储格式无效/)
})

test('触发时持久化失败：不启动业务，也不冒充成功', async () => {
  let calls = 0
  const f = fixture(async () => { calls++ })
  await f.scheduler.save(input)
  f.setTime(60000)
  f.fail()
  await assert.rejects(f.scheduler.tick())
  assert.equal(calls, 0)
  assert.ok(!(await f.scheduler.runs('plan')).some(run => run.status === 'succeeded'))
})

test('业务结束后记录写入失败：不把本次标记为成功，保留运行中', async () => {
  let calls = 0
  const f = fixture(async () => { calls++ })
  await f.scheduler.save(input)          // 第 1 次写入：保存计划
  f.allowWrites(2)                       // 第 2 次写入提交「运行中」后，第 3 次写入失败
  f.setTime(60000)
  await assert.rejects(f.scheduler.tick())
  assert.equal(calls, 1)
  const records = await f.scheduler.runs('plan')
  assert.equal(records[0]!.status, 'running')
  assert.ok(!records.some(run => run.status === 'succeeded'))
})

test('停用计划不触发；未知计划启停报错；执行记录按时间倒序', async () => {
  let calls = 0
  const f = fixture(async () => { calls++ })
  await f.scheduler.save({ ...input, enabled: false })
  assert.equal((await f.scheduler.list())[0]!.nextRunAt, null)
  f.setTime(600000)
  await f.scheduler.tick()
  assert.equal(calls, 0)
  assert.deepEqual(await f.scheduler.runs('plan'), [])
  await assert.rejects(f.scheduler.setEnabled('missing', true))
  await assert.rejects(f.scheduler.setEnabled('plan', 'no' as unknown as boolean))
  await f.scheduler.setEnabled('plan', true)
  f.setTime(660000)
  await f.scheduler.tick()
  f.setTime(720000)
  await f.scheduler.tick()
  const records = await f.scheduler.runs('plan')
  assert.deepEqual(records.map(run => run.scheduledAt), [720000, 660000])
})
