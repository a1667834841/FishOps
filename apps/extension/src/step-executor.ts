import { isStepWire, type StepContext, type StepWire } from '../../../packages/protocol/src/step.ts'
import { ApiError } from './errors.ts'

type Request = Extract<StepWire, { kind: 'request-step' }>
type Result = Extract<StepWire, { kind: 'step-result' }>
/** 单次执行依赖。execute 必须在实际平台请求终结后才 settle，不得自行重试。 */
export type StepExecutorDeps = {
  context: (tabId: number) => Promise<StepContext>
  execute: (request: Request) => Promise<unknown>
}

/** 创建连接代次范围内的去重执行器；连接重建时必须丢弃整个实例。 */
export function createStepExecutor(deps: StepExecutorDeps): (request: Request) => Promise<Result> {
  const seen = new Map<string, { fingerprint: string; result: Promise<Result> }>()
  let active = false
  const failure = (id: string, error: ApiError): Result => ({ kind: 'step-result', id, terminal: true, ok: false, error: error.toWire() })
  function check(expected: StepContext, current: StepContext): void {
    if (current.accountId !== expected.accountId) throw new ApiError('ACCOUNT_CHANGED', '执行账号已变化', { phase: 'read', retryable: false })
    if (current.tabId !== expected.tabId || current.documentId !== expected.documentId) throw new ApiError('PAGE_NOT_READY', '执行文档已变化', { phase: 'read', retryable: false })
  }
  return (request) => {
    if (!isStepWire(request) || request.kind !== 'request-step') return Promise.resolve(failure('invalid-step', new ApiError('BAD_REQUEST', '单步参数无效')))
    const fingerprint = JSON.stringify(request)
    const previous = seen.get(request.id)
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.resolve(failure(request.id, new ApiError('BAD_REQUEST', '单步标识重复且参数不同')))
      return previous.result.then(async result => {
        if (!result.ok) return result
        try { check(request.context, await deps.context(request.context.tabId)); return result }
        catch (error) { return failure(request.id, ApiError.from(error)) }
      })
    }
    // 不淘汰已执行标识以免迟到重投再次发包；达到上限需由 host 结束此连接代次。
    if (seen.size >= 10000) return Promise.resolve(failure(request.id, new ApiError('INTERNAL', '单步去重容量已满')))
    if (active) return Promise.resolve(failure(request.id, new ApiError('BAD_REQUEST', '已有平台步骤在执行')))
    active = true
    const result = (async (): Promise<Result> => {
      try {
        check(request.context, await deps.context(request.context.tabId))
        const data = await deps.execute(request)
        check(request.context, await deps.context(request.context.tabId))
        return { kind: 'step-result', id: request.id, terminal: true, ok: true, data }
      } catch (error) {
        return failure(request.id, ApiError.from(error))
      } finally { active = false }
    })()
    seen.set(request.id, { fingerprint, result })
    return result
  }
}
