import type { Schedule, ScheduleExecutor, ScheduleInput, ScheduleRun, SchedulerState } from '../../../shared/types/scheduler'

/** 调度端口；持久化失败必须 reject，不允许退化为内存成功。 */
export interface SchedulerDeps {
  now(): number
  read(): Promise<SchedulerState | undefined>
  write(state: SchedulerState): Promise<void>
  executors: Readonly<Record<string, ScheduleExecutor>>
}

const MINUTE = 60000
/** alarms 可能延迟；小于一分钟的迟到允许执行，超过后跳过。 */
const LATE_TOLERANCE = MINUTE

function validInput(value: unknown): value is ScheduleInput {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v.id)
    && typeof v.name === 'string' && v.name.trim().length > 0 && v.name.length <= 120
    && typeof v.taskType === 'string' && v.taskType.length <= 80
    && typeof v.enabled === 'boolean' && Number.isInteger(v.intervalMinutes)
    && Number(v.intervalMinutes) >= 1 && Number(v.intervalMinutes) <= 525600
}

function validateState(value: SchedulerState): void {
  if (value.version !== 1 || !Array.isArray(value.schedules) || !Array.isArray(value.runs)
    || !value.schedules.every(s => validInput(s) && Number.isFinite(s.createdAt) && Number.isFinite(s.updatedAt)
      && (s.enabled ? Number.isFinite(s.nextRunAt) : s.nextRunAt === null))
    || new Set(value.schedules.map(s => s.id)).size !== value.schedules.length
    || !value.runs.every(r => typeof r.id === 'string' && typeof r.scheduleId === 'string'
      && Number.isFinite(r.scheduledAt) && Number.isFinite(r.startedAt)
      && (r.finishedAt === null || Number.isFinite(r.finishedAt))
      && ['running', 'succeeded', 'failed', 'skipped', 'interrupted'].includes(r.status))) {
    throw new Error('调度存储格式无效，请先备份并检查数据，不会自动清空')
  }
}

/** 通用固定间隔调度；串行提交状态，但不持锁等待业务，允许不同计划独立运行。 */
export function createScheduler(deps: SchedulerDeps) {
  let state: SchedulerState | null = null
  let queue: Promise<unknown> = Promise.resolve()

  async function load(): Promise<SchedulerState> {
    if (state) return state
    const stored = await deps.read()
    const next: SchedulerState = stored ? structuredClone(stored) : { version: 1, schedules: [], runs: [] }
    validateState(next)
    let changed = false
    const now = deps.now()
    for (const run of next.runs) {
      if (run.status !== 'running') continue
      run.status = 'interrupted'
      run.reason = 'worker-restarted'
      run.finishedAt = now
      changed = true
    }
    // 重启恢复一律跳过已到期时点；不根据历史 running 重新执行业务副作用。
    for (const plan of next.schedules) {
      if (plan.nextRunAt === null || plan.nextRunAt > now) continue
      skipDue(next, plan, now, 'missed')
      changed = true
    }
    if (changed) await deps.write(next)
    state = next
    return next
  }

  function serialized<T>(operation: (current: SchedulerState) => Promise<T>): Promise<T> {
    const pending = queue.then(async () => operation(await load()))
    queue = pending.catch(() => {})
    return pending
  }

  async function commit(next: SchedulerState): Promise<void> {
    await deps.write(structuredClone(next))
    state = next
  }

  function skipDue(next: SchedulerState, plan: Schedule, now: number, reason: 'missed' | 'overlap'): void {
    const due = plan.nextRunAt!
    const missedCount = Math.floor((now - due) / (plan.intervalMinutes * MINUTE)) + 1
    next.runs.push({ id: `${plan.id}@${due}`, scheduleId: plan.id, scheduledAt: due,
      startedAt: now, finishedAt: now, status: 'skipped', reason, missedCount })
    plan.nextRunAt = due + missedCount * plan.intervalMinutes * MINUTE
  }

  return {
    /** 查询已注册的执行器类型。本期没有内置业务执行器。 */
    executorTypes(): string[] { return Object.keys(deps.executors) },
    async list(): Promise<Schedule[]> {
      return serialized(async current => structuredClone(current.schedules))
    },
    /** 查询某计划执行历史，最新记录优先。 */
    async runs(scheduleId: string): Promise<ScheduleRun[]> {
      return serialized(async current => structuredClone(current.runs.filter(r => r.scheduleId === scheduleId)
        .sort((a, b) => b.scheduledAt - a.scheduledAt)))
    },
    /** 保存完整配置；每次修改重新从当前时刻计算间隔，不补跑旧计划。 */
    async save(input: ScheduleInput): Promise<Schedule> {
      if (!validInput(input)) throw new Error('计划无效：需要 ID、名称、类型、启用状态和 1～525600 整数分钟间隔')
      const executor = Object.hasOwn(deps.executors, input.taskType) ? deps.executors[input.taskType] : undefined
      if (!executor || !executor.validate(input.config)) throw new Error('执行器未注册或业务配置无效')
      // 只允许可持久化 JSON 配置，拒绝循环结构、函数、非有限数值和过大负载。
      const json = JSON.stringify(input.config, (_key, value: unknown) => {
        if (typeof value === 'function' || typeof value === 'undefined' || typeof value === 'symbol'
          || typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('配置必须为 JSON 数据')
        return value
      })
      if (!json || json.length > 65536) throw new Error('配置超过 64 KiB 或为空')
      const config: unknown = JSON.parse(json)
      if (!executor.validate(config)) throw new Error('序列化后的业务配置无效')
      return serialized(async current => {
        const next = structuredClone(current)
        const previous = next.schedules.find(p => p.id === input.id)
        const now = deps.now()
        const plan: Schedule = { id: input.id, name: input.name.trim(), taskType: input.taskType, config,
          intervalMinutes: input.intervalMinutes, enabled: input.enabled,
          createdAt: previous?.createdAt ?? now, updatedAt: now,
          nextRunAt: input.enabled ? now + input.intervalMinutes * MINUTE : null }
        next.schedules = next.schedules.filter(p => p.id !== input.id)
        next.schedules.push(plan)
        await commit(next)
        return structuredClone(plan)
      })
    },
    /** 停用不取消已开始的业务；恢复从当前时刻重新计时。 */
    async setEnabled(id: string, enabled: boolean): Promise<Schedule> {
      if (typeof enabled !== 'boolean') throw new Error('启用状态无效')
      return serialized(async current => {
        const next = structuredClone(current)
        const plan = next.schedules.find(p => p.id === id)
        if (!plan) throw new Error('计划不存在')
        if (plan.enabled !== enabled) {
          plan.enabled = enabled
          plan.updatedAt = deps.now()
          plan.nextRunAt = enabled ? plan.updatedAt + plan.intervalMinutes * MINUTE : null
          await commit(next)
        }
        return structuredClone(plan)
      })
    },
    /** 唤醒处理；运行记录提交成功后才启动业务。重复唤醒不会重复执行。 */
    async tick(): Promise<void> {
      const jobs = await serialized(async current => {
        const next = structuredClone(current)
        const now = deps.now()
        const ready: Array<{ plan: Schedule; run: ScheduleRun; executor: ScheduleExecutor }> = []
        let changed = false
        for (const plan of next.schedules) {
          if (!plan.enabled || plan.nextRunAt === null || plan.nextRunAt > now) continue
          changed = true
          if (next.runs.some(r => r.scheduleId === plan.id && r.status === 'running')) {
            skipDue(next, plan, now, 'overlap')
            continue
          }
          if (now - plan.nextRunAt >= LATE_TOLERANCE) {
            skipDue(next, plan, now, 'missed')
            continue
          }
          const due = plan.nextRunAt
          const executor = Object.hasOwn(deps.executors, plan.taskType) ? deps.executors[plan.taskType] : undefined
          const available = executor && executor.validate(plan.config)
          const run: ScheduleRun = { id: `${plan.id}@${due}`, scheduleId: plan.id, scheduledAt: due,
            startedAt: now, finishedAt: available ? null : now,
            status: available ? 'running' : 'failed', ...(available ? {} : { reason: 'executor-unavailable' as const }) }
          next.runs.push(run)
          plan.nextRunAt = due + plan.intervalMinutes * MINUTE
          if (executor && available) ready.push({ plan: structuredClone(plan), run: structuredClone(run), executor })
        }
        if (changed) await commit(next)
        return ready
      })
      await Promise.all(jobs.map(async ({ plan, run, executor }) => {
        let succeeded = true
        try { await executor.execute(plan.config, Object.freeze(run)) } catch { succeeded = false }
        await serialized(async current => {
          const next = structuredClone(current)
          const record = next.runs.find(r => r.id === run.id)
          if (!record || record.status !== 'running') return
          record.status = succeeded ? 'succeeded' : 'failed'
          record.finishedAt = deps.now()
          if (!succeeded) record.reason = 'executor-failed'
          await commit(next)
        })
      }))
    },
  }
}

/** 调度服务类型，业务运行时通过端口接入，不直接依赖 chrome。 */
export type Scheduler = ReturnType<typeof createScheduler>
