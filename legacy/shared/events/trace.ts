import { CommandTypes } from './commands'
import type { CommandEnvelope, ResponseEnvelope } from './protocol'

/** trace 只记录命令边界元数据，不接收负载、响应正文或原始异常文本。 */
export interface TraceRecord {
  time: number
  scope: 'client' | 'content' | 'background'
  stage: 'start' | 'success' | 'error' | 'timeout' | 'rejected'
  traceId: string
  command: string
  durationMs?: number
  code?: string
}

export interface TraceOptions {
  enabled?: boolean
  maxRecords?: number
  sink?: (record: Readonly<TraceRecord>) => void
}

const commands = new Set<string>(Object.values(CommandTypes))
const codes = new Set(['INVALID_MESSAGE', 'UNKNOWN_COMMAND', 'INVALID_PAYLOAD', 'INTERNAL', 'TIMEOUT', 'NO_TRANSPORT', 'PLATFORM_ERROR'])
const stages = new Set(['start', 'success', 'error', 'timeout', 'rejected'])

/** 创建独立、有界的 trace 缓冲；输出失败不能影响业务。 */
export function createTrace(options: TraceOptions = {}) {
  let enabled = options.enabled ?? false
  const limit = Number.isFinite(options.maxRecords)
    ? Math.min(5000, Math.max(1, Math.floor(options.maxRecords!))) : 500
  const records: Readonly<TraceRecord>[] = []
  const sink = options.sink ?? ((record: Readonly<TraceRecord>) => console.debug('[FishOps:Trace]', record))
  return {
    enable() { enabled = true },
    disable() { enabled = false },
    isEnabled() { return enabled },
    clear() { records.length = 0 },
    read(): TraceRecord[] { return records.map((record) => ({ ...record })) },
    exportJson(): string { return JSON.stringify(records) },
    record(entry: TraceRecord): void {
      if (!enabled) return
      try {
        if (!stages.has(entry.stage)) return
        if (!['client', 'content', 'background'].includes(entry.scope)) return
        // 外部消息不能借助自由文本字段将正文或凭据写入 trace。
        const record: TraceRecord = {
          time: Number.isFinite(entry.time) ? entry.time : Date.now(),
          scope: entry.scope,
          stage: entry.stage,
          traceId: /^req_(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9]{10,24})$/i.test(entry.traceId)
            ? entry.traceId : 'untracked',
          command: commands.has(entry.command) ? entry.command : 'UNKNOWN_COMMAND',
        }
        if (Number.isFinite(entry.durationMs) && entry.durationMs! >= 0) record.durationMs = Math.round(entry.durationMs!)
        if (entry.code && codes.has(entry.code)) record.code = entry.code
        const frozen = Object.freeze(record)
        records.push(frozen)
        if (records.length > limit) records.splice(0, records.length - limit)
        try { sink(frozen) } catch { /* 日志输出故障不得阻断命令。 */ }
      } catch { /* 非法日志输入不得影响业务。 */ }
    },
  }
}

export type Trace = ReturnType<typeof createTrace>
export const commandTrace = createTrace()

// 每个 JS 上下文有自己的开关和缓冲；不持久化、不发送到外部服务。
try {
  Object.defineProperty(globalThis, 'FishOpsTrace', { value: commandTrace, configurable: true })
} catch { /* 全局对象不可扩展时仍允许程序内记录。 */ }

/** 开始一个命令 span；返回结束函数，关闭时不读取时间或构造日志。 */
export function startCommandTrace(
  scope: TraceRecord['scope'],
  command: Pick<CommandEnvelope, 'requestId' | 'type'>,
  trace: Trace = commandTrace,
): (stage: Exclude<TraceRecord['stage'], 'start'>, code?: string) => void {
  if (!trace.isEnabled()) return () => {}
  const startedAt = Date.now()
  trace.record({ time: startedAt, scope, stage: 'start', traceId: command.requestId, command: command.type })
  let finished = false
  return (stage, code) => {
    if (finished) return
    finished = true
    const time = Date.now()
    trace.record({ time, scope, stage, traceId: command.requestId, command: command.type, durationMs: Math.max(0, time - startedAt), code })
  }
}

/** 包装命令请求：保留原响应和异常，只补充 trace；超时由调用方原有策略控制。 */
export async function traceCommandCall(
  scope: TraceRecord['scope'],
  command: Pick<CommandEnvelope, 'requestId' | 'type'>,
  call: () => Promise<ResponseEnvelope>,
  trace: Trace = commandTrace,
): Promise<ResponseEnvelope> {
  const finish = startCommandTrace(scope, command, trace)
  try {
    const response = await call()
    finish(response.ok ? 'success' : 'error', response.ok ? undefined : response.error?.code)
    return response
  } catch (error) {
    // 只检查错误码，绝不记录 message、stack 或整个异常对象。
    let code = 'INTERNAL'
    try {
      if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && codes.has(error.code)) code = error.code
    } catch { /* 错误对象的 getter 可能抛出异常。 */ }
    finish(code === 'TIMEOUT' ? 'timeout' : 'error', code)
    throw error
  }
}
