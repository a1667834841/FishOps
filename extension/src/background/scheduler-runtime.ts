import { CommandTypes, createErrorResponse, createResponse, type CommandEnvelope, type ResponseEnvelope } from '@fishops/shared'
import type { ScheduleInput } from '../../../shared/types/scheduler'
import type { Scheduler } from './scheduler'

/** 专用命令集合，复用后台现有扩展内页来源校验。 */
export const SCHEDULER_COMMANDS: ReadonlySet<string> = new Set([
  CommandTypes.SCHEDULE_LIST, CommandTypes.SCHEDULE_SAVE, CommandTypes.SCHEDULE_SET_ENABLED,
  CommandTypes.SCHEDULE_RUN_LIST, CommandTypes.SCHEDULE_EXECUTOR_LIST,
])

/** 唤醒器名称与周期；chrome.alarms 的最小周期为一分钟。 */
export const SCHEDULER_ALARM_NAME = 'fishops.scheduler.tick'
const SCHEDULER_ALARM_PERIOD_MINUTES = 1

/** chrome.alarms 的最小依赖面，便于在 Node 下验证启动路径，无需启动浏览器。 */
export interface SchedulerAlarmPort {
  onAlarm: { addListener(listener: (alarm: { name: string }) => void): void }
  get(name: string): Promise<{ name: string } | undefined>
  create(name: string, info: { periodInMinutes: number }): Promise<unknown> | void
}

/**
 * 注册通用调度唤醒器并做一次启动恢复。
 *
 * 监听器必须在模块顶层同步注册，保证 MV3 被 alarm 唤醒时事件不丢；
 * 重建 alarm 与恢复读取异步进行，失败只记录日志，不影响后台其他能力。
 * alarms 不是配置真源：浏览器重启后仍从 chrome.storage.local 恢复计划与执行记录。
 */
export function startSchedulerAlarm(
  alarm: SchedulerAlarmPort,
  scheduler: Scheduler,
  report: (message: string) => void = message => console.error(message),
): void {
  alarm.onAlarm.addListener(entry => {
    if (entry.name !== SCHEDULER_ALARM_NAME) return
    void scheduler.tick().catch(() => report('[FishOps:Scheduler] 调度失败，请检查本地存储'))
  })
  void (async () => {
    const existing = await alarm.get(SCHEDULER_ALARM_NAME)
    if (!existing) await alarm.create(SCHEDULER_ALARM_NAME, { periodInMinutes: SCHEDULER_ALARM_PERIOD_MINUTES })
    await scheduler.list()
  })().catch(() => report('[FishOps:Scheduler] 初始化失败，请检查权限与本地调度数据'))
}

/** 构造 INVALID_PAYLOAD：负载形状或字段错误属于客户端问题，与后台失败区分。 */
function invalid(command: CommandEnvelope, message: string): ResponseEnvelope {
  return createErrorResponse(command.requestId, command.type, { code: 'INVALID_PAYLOAD', message })
}

/** 通用调度命令适配；底层异常不回传，避免业务配置或凭据泄露。 */
export async function handleSchedulerCommand(scheduler: Scheduler, command: CommandEnvelope): Promise<ResponseEnvelope> {
  const payload = command.payload
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown> : null
  if (!record) return invalid(command, '调度命令需要对象负载')
  try {
    let result: unknown
    switch (command.type) {
      case CommandTypes.SCHEDULE_LIST:
      case CommandTypes.SCHEDULE_EXECUTOR_LIST:
        if (Object.keys(record).length !== 0) return invalid(command, '该调度命令不接受任何字段')
        result = command.type === CommandTypes.SCHEDULE_LIST ? await scheduler.list() : scheduler.executorTypes()
        break
      case CommandTypes.SCHEDULE_SAVE:
        result = await scheduler.save(record as unknown as ScheduleInput)
        break
      case CommandTypes.SCHEDULE_SET_ENABLED:
        if (typeof record.id !== 'string' || typeof record.enabled !== 'boolean') return invalid(command, '需要 id 字符串与 enabled 布尔值')
        result = await scheduler.setEnabled(record.id, record.enabled)
        break
      case CommandTypes.SCHEDULE_RUN_LIST:
        if (typeof record.scheduleId !== 'string') return invalid(command, '需要 scheduleId 字符串')
        result = await scheduler.runs(record.scheduleId)
        break
      default:
        return createErrorResponse(command.requestId, command.type, { code: 'UNKNOWN_COMMAND', message: '非调度命令' })
    }
    return createResponse(command.requestId, command.type, result)
  } catch {
    return createErrorResponse(command.requestId, command.type, {
      code: 'INTERNAL', message: '调度操作失败：请检查计划 ID、整数分钟间隔、已注册执行器及业务配置；若配置正确，请检查本地存储空间与调度数据。',
    })
  }
}
