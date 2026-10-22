/** 固定间隔计划；业务配置由对应执行器验证，不含调度策略。 */
export interface ScheduleInput {
  id: string
  name: string
  taskType: string
  config: unknown
  /** 整数分钟，范围 1～525600；默认由调用方选择。 */
  intervalMinutes: number
  enabled: boolean
}

/** 持久化计划，停用时下次执行时间为 null。 */
export interface Schedule extends ScheduleInput {
  createdAt: number
  updatedAt: number
  nextRunAt: number | null
}

/** 单次执行或合并跳过区间；id 绑定计划及计划触发时间。 */
export interface ScheduleRun {
  id: string
  scheduleId: string
  scheduledAt: number
  startedAt: number
  finishedAt: number | null
  status: 'running' | 'succeeded' | 'failed' | 'skipped' | 'interrupted'
  reason?: 'missed' | 'overlap' | 'worker-restarted' | 'executor-failed' | 'executor-unavailable'
  missedCount?: number
}

/** 配置与执行记录整包原子提交，避免推进时间后丢失执行记录。 */
export interface SchedulerState {
  version: 1
  schedules: Schedule[]
  runs: ScheduleRun[]
}

/** 可复用执行器：注册仅限代码，不接受客户端传入函数或任意命令。 */
export interface ScheduleExecutor {
  validate(config: unknown): boolean
  /** resolve 表示业务已结束，而非仅加入后台队列；run.id 可用作业务幂等键。 */
  execute(config: unknown, run: Readonly<ScheduleRun>): Promise<void>
}
