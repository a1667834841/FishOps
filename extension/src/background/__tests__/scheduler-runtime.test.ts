/**
 * 通用调度接入层测试（无 chrome 依赖）：
 * - 命令适配：负载校验、错误码区分、底层异常不回显业务配置；
 * - 启动路径：顶层同步注册 alarm 监听、重建 1 分钟唤醒器、启动恢复读取；
 * - alarms API 失败与调度失败只记录日志，不产生未处理拒绝。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, createCommand, type ResponseEnvelope } from '@fishops/shared'
import type { Schedule, ScheduleInput, SchedulerState } from '../../../../shared/types/scheduler'
import { createScheduler, type Scheduler } from '../scheduler'
import {
  SCHEDULER_ALARM_NAME,
  SCHEDULER_COMMANDS,
  handleSchedulerCommand,
  startSchedulerAlarm,
  type SchedulerAlarmPort,
} from '../scheduler-runtime'

const validInput: ScheduleInput = { id: 'plan', name: '测试计划', taskType: 'test', config: {}, intervalMinutes: 5, enabled: true }

/** 内存调度器：本期默认无业务执行器，可按需注册以覆盖成功路径。 */
function memoryScheduler(executors: Record<string, { validate(config: unknown): boolean; execute(): Promise<void> }> = {}, seed?: SchedulerState, now = () => 0) {
  let state: SchedulerState | undefined = seed
  const scheduler = createScheduler({
    now,
    read: async () => structuredClone(state),
    write: async (next: SchedulerState) => { state = structuredClone(next) },
    executors,
  })
  return { scheduler, stored: () => state }
}

function okResult<T>(response: ResponseEnvelope): T {
  assert.equal(response.ok, true, JSON.stringify(response.error))
  return response.result as T
}

function errorCode(response: ResponseEnvelope): string {
  assert.equal(response.ok, false)
  return response.error?.code ?? ''
}

/** 让异步启动链（get → create → list）跑完。 */
async function drain(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

function fakeAlarm(existing: boolean) {
  const listeners: Array<(alarm: { name: string }) => void> = []
  const created: Array<{ name: string; periodInMinutes: number }> = []
  const port: SchedulerAlarmPort = {
    onAlarm: { addListener: listener => { listeners.push(listener) } },
    get: async name => (existing ? { name } : undefined),
    create: async (name, info) => { created.push({ name, periodInMinutes: info.periodInMinutes }) },
  }
  return { port, listeners, created, fire: (name: string) => { for (const listener of listeners) listener({ name }) } }
}

/** 收集未处理拒绝，覆盖「失败路径不得泄漏 Promise」的约束。 */
async function withUnhandledTracking(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    await run()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return unhandled
}

test('调度命令集合只登记本期五条命令', () => {
  assert.deepEqual([...SCHEDULER_COMMANDS].sort(), [
    CommandTypes.SCHEDULE_EXECUTOR_LIST,
    CommandTypes.SCHEDULE_LIST,
    CommandTypes.SCHEDULE_RUN_LIST,
    CommandTypes.SCHEDULE_SAVE,
    CommandTypes.SCHEDULE_SET_ENABLED,
  ])
  assert.equal(SCHEDULER_COMMANDS.has(CommandTypes.PING), false)
})

test('本期无业务执行器：执行器列表为空，保存被拒绝', async () => {
  const { scheduler } = memoryScheduler()
  const types = await handleSchedulerCommand(scheduler, createCommand(CommandTypes.SCHEDULE_EXECUTOR_LIST, {}))
  assert.deepEqual(okResult<string[]>(types), [])
  const saved = await handleSchedulerCommand(scheduler, createCommand(CommandTypes.SCHEDULE_SAVE, validInput))
  assert.equal(errorCode(saved), 'INTERNAL')
})

test('已注册执行器：保存、查询与启停走通', async () => {
  const { scheduler } = memoryScheduler({ test: { validate: () => true, execute: async () => {} } })
  const saved = await handleSchedulerCommand(scheduler, createCommand(CommandTypes.SCHEDULE_SAVE, validInput))
  const plan = okResult<Schedule>(saved)
  assert.equal(plan.id, 'plan')
  assert.equal(plan.nextRunAt, 5 * 60000)
  const listed = await handleSchedulerCommand(scheduler, createCommand(CommandTypes.SCHEDULE_LIST, {}))
  assert.equal(okResult<Schedule[]>(listed).length, 1)
  const disabled = await handleSchedulerCommand(scheduler, createCommand(CommandTypes.SCHEDULE_SET_ENABLED, { id: 'plan', enabled: false }))
  assert.equal(okResult<Schedule>(disabled).nextRunAt, null)
  const runs = await handleSchedulerCommand(scheduler, createCommand(CommandTypes.SCHEDULE_RUN_LIST, { scheduleId: 'plan' }))
  assert.deepEqual(okResult<unknown[]>(runs), [])
})

test('负载形状错误返回 INVALID_PAYLOAD，未知命令返回 UNKNOWN_COMMAND', async () => {
  const { scheduler } = memoryScheduler()
  for (const payload of [null, [], 'x', 3]) {
    const response = await handleSchedulerCommand(scheduler, createCommand(CommandTypes.SCHEDULE_LIST, payload as unknown as Record<string, never>))
    assert.equal(errorCode(response), 'INVALID_PAYLOAD')
  }
  const extra = await handleSchedulerCommand(scheduler, createCommand(CommandTypes.SCHEDULE_EXECUTOR_LIST, { x: 1 } as unknown as Record<string, never>))
  assert.equal(errorCode(extra), 'INVALID_PAYLOAD')
  const missingId = await handleSchedulerCommand(scheduler, createCommand(CommandTypes.SCHEDULE_SET_ENABLED, { enabled: true } as unknown as { id: string; enabled: boolean }))
  assert.equal(errorCode(missingId), 'INVALID_PAYLOAD')
  const missingSchedule = await handleSchedulerCommand(scheduler, createCommand(CommandTypes.SCHEDULE_RUN_LIST, {} as unknown as { scheduleId: string }))
  assert.equal(errorCode(missingSchedule), 'INVALID_PAYLOAD')
  const unknown = await handleSchedulerCommand(scheduler, createCommand(CommandTypes.PING, { clientTime: 0, nonce: 'n' }))
  assert.equal(errorCode(unknown), 'UNKNOWN_COMMAND')
})

test('命令失败不回显业务配置或凭据', async () => {
  const { scheduler } = memoryScheduler()
  const secret = 'sk-secret-token'
  const invalidPlan = { ...validInput, taskType: 'unregistered', config: { token: secret } }
  const response = await handleSchedulerCommand(scheduler, createCommand(CommandTypes.SCHEDULE_SAVE, invalidPlan))
  assert.equal(errorCode(response), 'INTERNAL')
  assert.ok(!JSON.stringify(response).includes(secret))
})

test('启动：顶层同步注册监听，重建 1 分钟 alarm，并做一次恢复读取', async () => {
  const { scheduler, stored } = memoryScheduler({}, {
    version: 1,
    schedules: [{ id: 'p', name: 'p', taskType: 'none', config: {}, intervalMinutes: 1, enabled: true, createdAt: 0, updatedAt: 0, nextRunAt: 60000 }],
    runs: [{ id: 'old', scheduleId: 'p', scheduledAt: 0, startedAt: 0, finishedAt: null, status: 'running' }],
  }, () => 600000)
  const f = fakeAlarm(false)
  const reports: string[] = []
  startSchedulerAlarm(f.port, scheduler, message => reports.push(message))
  assert.equal(f.listeners.length, 1, '监听必须在调用时同步注册')
  assert.deepEqual(f.created, [], 'create 在异步 get 之后，不应同步调用')
  await drain()
  assert.deepEqual(f.created, [{ name: SCHEDULER_ALARM_NAME, periodInMinutes: 1 }])
  assert.deepEqual(reports, [])
  const runs = await scheduler.runs('p')
  assert.ok(runs.some(run => run.status === 'interrupted' && run.reason === 'worker-restarted'))
  assert.ok(runs.some(run => run.status === 'skipped' && run.reason === 'missed'))
  assert.equal(stored()!.runs.length, 2)
})

test('启动：已存在 alarm 时不重复创建', async () => {
  const { scheduler } = memoryScheduler()
  const f = fakeAlarm(true)
  startSchedulerAlarm(f.port, scheduler, () => {})
  await drain()
  assert.deepEqual(f.created, [])
})

test('alarm 名称不匹配不触发；触发与初始化失败只上报，不产生未处理拒绝', async () => {
  const unhandled = await withUnhandledTracking(async () => {
    let ticks = 0
    const scheduler = {
      list: async () => { throw new Error('list-fail') },
      tick: async () => { ticks += 1; throw new Error('tick-fail') },
    } as unknown as Scheduler
    const reports: string[] = []
    const f = fakeAlarm(true)
    startSchedulerAlarm(f.port, scheduler, message => reports.push(message))
    f.fire('fishops.other.event')
    await drain()
    assert.equal(ticks, 0)
    f.fire(SCHEDULER_ALARM_NAME)
    await drain()
    assert.equal(ticks, 1)
    assert.equal(reports.length, 2)
    assert.ok(reports.every(message => message.startsWith('[FishOps:Scheduler]')))
  })
  assert.deepEqual(unhandled, [])
})

test('alarms API 失败：上报且不抛出，不产生未处理拒绝', async () => {
  const unhandled = await withUnhandledTracking(async () => {
    const reports: string[] = []
    const port: SchedulerAlarmPort = {
      onAlarm: { addListener: () => {} },
      get: async () => { throw new Error('alarms 不可用') },
      create: async () => { throw new Error('不应被调用') },
    }
    startSchedulerAlarm(port, { list: async () => [], tick: async () => {} } as unknown as Scheduler, message => reports.push(message))
    await drain()
    assert.equal(reports.length, 1)
    assert.ok(reports[0]!.includes('初始化失败'))
  })
  assert.deepEqual(unhandled, [])
})

test('创建 alarm 失败：上报且不抛出', async () => {
  const reports: string[] = []
  const port: SchedulerAlarmPort = {
    onAlarm: { addListener: () => {} },
    get: async () => undefined,
    create: async () => { throw new Error('create 失败') },
  }
  startSchedulerAlarm(port, { list: async () => [], tick: async () => {} } as unknown as Scheduler, message => reports.push(message))
  await drain()
  assert.equal(reports.length, 1)
  assert.ok(reports[0]!.includes('初始化失败'))
})
