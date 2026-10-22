import { isStepWire, type StepContext, type StepWire } from '../../../packages/protocol/src/step.ts'
import { ApiError } from './errors.ts'

type RequestStep = Extract<StepWire, { kind: 'request-step' }>
type StepResult = Extract<StepWire, { kind: 'step-result' }>
type PageStatus = { documentId: string; activeStepId: string | null; completed: number }

/** executeScript 的最小依赖面，便于在不启动 Chrome 时验证适配行为。 */
export type PageScripting = {
  executeScript(details: {
    target: { tabId: number; documentIds: string[] }
    world: 'MAIN'
  func: (...args: unknown[]) => unknown
    args?: unknown[]
  }): Promise<Array<{ documentId?: string; result?: unknown }>>
}
/** 页面上下文由 page-context 绑定并核验，不在此处选择或替换 tab。 */
export type PageClientContext = {
  bind(tabId: number): Promise<StepContext>
  verify(expected: StepContext): Promise<StepContext>
}
export type PageClientDeps = { scripting: PageScripting; context: PageClientContext }

const unavailable = () => new ApiError('PAGE_NOT_READY', '页面执行上下文不可用', { phase: 'read', retryable: false })

/** 将固定页面上下文适配到 Chrome scripting；不负责注入运行时或发起网络请求。 */
export function createPageClient({ scripting, context }: PageClientDeps) {
  let active: { id: string; fingerprint: string; promise: Promise<StepResult> } | null = null

  async function runInPage(op: 'status' | 'execute', expected: StepContext, request?: RequestStep): Promise<unknown> {
    // Chrome 只序列化该函数本身；不得引用模块变量或模块作用域函数。
    const invoke = function (input: { op: 'status' | 'execute'; request?: RequestStep }): unknown {
      const runtime = (window as unknown as { __fishopsPageRuntimeV1__?: {
        status?: () => unknown
        execute?: (step: RequestStep) => unknown
      } }).__fishopsPageRuntimeV1__
      if (!runtime) return { __pageClientMissingRuntime: true }
      if (input.op === 'status') return typeof runtime.status === 'function' ? runtime.status() : null
      if (!input.request || typeof runtime.execute !== 'function') return null
      return runtime.execute(input.request)
    }
    const results = await scripting.executeScript({
      target: { tabId: expected.tabId, documentIds: [expected.documentId] },
      world: 'MAIN',
      func: invoke as unknown as (...args: unknown[]) => unknown,
      args: [{ op, ...(request ? { request } : {}) }],
    })
    if (!Array.isArray(results) || results.length !== 1 || results[0]?.documentId !== expected.documentId) throw unavailable()
    return results[0].result
  }

  async function execute(request: RequestStep): Promise<StepResult> {
    if (!isStepWire(request) || request.kind !== 'request-step') throw unavailable()
    if (active) {
      if (active.id === request.id && active.fingerprint === JSON.stringify(request)) return active.promise
      throw unavailable()
    }
    const promise = (async () => {
      let expected: StepContext | undefined
      try {
        try { expected = await context.verify(request.context) } catch (error) {
          if (error instanceof ApiError && error.code === 'ACCOUNT_CHANGED') throw error
          throw unavailable()
        }
        if (expected.accountId !== request.context.accountId) throw new ApiError('ACCOUNT_CHANGED', '执行账号已变化', { phase: 'read', retryable: false })
        if (expected.tabId !== request.context.tabId || expected.documentId !== request.context.documentId) throw unavailable()
        const statusValue = await runInPage('status', expected)
        if (statusValue === null || typeof statusValue !== 'object' || (statusValue as { __pageClientMissingRuntime?: boolean }).__pageClientMissingRuntime) throw unavailable()
        const status = statusValue as PageStatus
        if (status.documentId !== expected.documentId ||
          !(status.activeStepId === null || (typeof status.activeStepId === 'string' && status.activeStepId.length > 0)) ||
          !Number.isSafeInteger(status.completed) || status.completed < 0 ||
          (status.activeStepId !== null && status.activeStepId !== request.id)) throw unavailable()
        const raw = await runInPage('execute', expected, request)
        if (!isStepWire(raw) || raw.kind !== 'step-result' || raw.id !== request.id || raw.terminal !== true) throw unavailable()
        try {
          const verified = await context.verify(expected)
          if (verified.accountId !== expected.accountId) throw new ApiError('ACCOUNT_CHANGED', '执行账号已变化', { phase: 'read', retryable: false })
          if (verified.tabId !== expected.tabId || verified.documentId !== expected.documentId) throw unavailable()
        } catch (error) {
          if (error instanceof ApiError && error.code === 'ACCOUNT_CHANGED') throw error
          throw unavailable()
        }
        return raw
      } catch (error) {
        if (error instanceof ApiError && error.code === 'ACCOUNT_CHANGED') throw error
        throw unavailable()
      }
    })()
    active = { id: request.id, fingerprint: JSON.stringify(request), promise }
    try { return await promise } finally { if (active?.promise === promise) active = null }
  }

  return { execute }
}
