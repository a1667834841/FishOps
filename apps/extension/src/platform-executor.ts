import type { StepContext, StepWire } from '../../../packages/protocol/src/step.ts'
import { ApiError } from './errors.ts'
import { createStepExecutor } from './step-executor.ts'

type Request = Extract<StepWire, { kind: 'request-step' }>
type Result = Extract<StepWire, { kind: 'step-result' }>
/** 平台单步组合依赖；文档准备与执行都必须固定相同 Chrome documentId。 */
export type PlatformExecutorDeps = {
  context: { bind(tabId: number): Promise<StepContext>; verify(expected: StepContext): Promise<StepContext> }
  bootstrap: { prepare(expected: StepContext): Promise<unknown> }
  client: { execute(request: Request): Promise<Result> }
}
/** 连接范围的业务执行器；页面级锁仍由文档 runtime 跨连接保存。 */
export function createPlatformExecutor(deps: PlatformExecutorDeps) {
  return createStepExecutor({
    context: tabId => deps.context.bind(tabId),
    execute: async request => {
      await deps.context.verify(request.context)
      await deps.bootstrap.prepare(request.context)
      await deps.context.verify(request.context)
      // 风控（RISK_BLOCKED）不自动处理也不重放：交由人工验证后由调用方以新幂等语义恢复。
      const result = await deps.client.execute(request)
      // client 只有在收到真实终结或确定未派发时才能完成；未知执行状态应保持等待。
      if (!result.ok) throw new ApiError(result.error.code, result.error.message, { phase: result.error.phase, retryable: result.error.retryable })
      return result.data
    },
  })
}
