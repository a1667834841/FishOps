import type { StepContext } from '../../../packages/protocol/src/step.ts'
import { ApiError } from './errors.ts'

/**
 * 页面运行时部署适配（MAIN world）。
 *
 * 职责只有一个：把已核验的固定文档部署成可执行的页面运行时，并把文档状态回传给主线程。
 * 约束：
 * - 只依赖注入的 `context` 与 `scripting`，本模块不直接调用 Chrome API，也不发平台请求。
 * - 两次 `executeScript` 都必须固定到 `expected.accountId/tabId/documentId`，返回的
 *   Chrome `documentId` 也要核验；注入到别的文档不能算成功。
 * - 注入的初始化函数必须自包含：Chrome 只序列化函数本身，函数体内不得引用模块作用域变量。
 * - 同一文档重复 prepare 复用已注册的 runtime 与文档锁，不重载页面、不换 tab、不清锁。
 * - 活动步骤未终结（`activeStepId` 非 null）时明确失败，避免在旧请求仍占用文档锁时继续部署。
 * - 所有异常固定脱敏；仅账号变化保留 `ACCOUNT_CHANGED`，其它一律为固定文案的 `PAGE_NOT_READY`。
 */

/** MAIN 入口产物名；只允许这一份，注入时固定到目标文档。 */
export const PAGE_MAIN_FILE = 'page-main.js'

/** 部署后由页面返回的文档状态；`activeStepId` 非 null 表示仍有未终结步骤。 */
export type PageBootstrapStatus = {
  documentId: string
  activeStepId: string | null
  completed: number
}

/**
 * Chrome 脚本注入接口的最小依赖面；测试无需启动浏览器即可验证部署行为。
 * `files` 用于注入 MAIN 入口产物，`func` 用于在同一文档调用初始化入口，两者互斥。
 */
export type PageBootstrapScripting = {
  executeScript(details: {
    /** 固定目标标签与文档；不得更换 tab 或注入到其它文档。 */
    target: { tabId: number; documentIds: string[] }
    world: 'MAIN'
    files?: string[]
    func?: (...args: unknown[]) => unknown
    args?: unknown[]
  }): Promise<Array<{ documentId?: string; result?: unknown }>>
}

/** 页面上下文只做核验，本模块不挑选也不替换 tab。 */
export type PageBootstrapContext = {
  verify(expected: StepContext): Promise<StepContext>
}

export type PageBootstrapDeps = {
  context: PageBootstrapContext
  scripting: PageBootstrapScripting
}

const unavailable = () =>
  new ApiError('PAGE_NOT_READY', '页面执行运行时不可用', { phase: 'read', retryable: false })
const accountChanged = () =>
  new ApiError('ACCOUNT_CHANGED', '执行账号已变化', { phase: 'read', retryable: false })

/** 异常只保留账号变化语义，其余一律折叠为固定文案，避免回传浏览器或页面内部信息。 */
function sanitize(error: unknown): ApiError {
  if (error instanceof ApiError && error.code === 'ACCOUNT_CHANGED') return accountChanged()
  return unavailable()
}

/** 严格核验 expected 形状；非法上下文不发起任何注入。 */
function contextKey(expected: StepContext): string | null {
  if (typeof expected !== 'object' || expected === null) return null
  const { accountId, tabId, documentId } = expected as Partial<StepContext>
  if (typeof accountId !== 'string' || accountId.length === 0) return null
  if (!Number.isSafeInteger(tabId) || (tabId as number) < 0) return null
  if (typeof documentId !== 'string' || documentId.length === 0) return null
  return `${accountId}\u0000${tabId}\u0000${documentId}`
}

/** 严格核验页面返回的状态；活动步骤未终结时不得继续部署。 */
function readStatus(value: unknown, expected: StepContext): PageBootstrapStatus {
  if (typeof value !== 'object' || value === null) throw unavailable()
  const status = value as Record<string, unknown>
  if (status.documentId !== expected.documentId) throw unavailable()
  if (!(status.activeStepId === null || (typeof status.activeStepId === 'string' && status.activeStepId.length > 0))) {
    throw unavailable()
  }
  // 仍有未终结步骤：文档锁被占用，部署与后续平台请求都必须停止。
  if (status.activeStepId !== null) throw unavailable()
  if (!Number.isSafeInteger(status.completed) || (status.completed as number) < 0) throw unavailable()
  return { documentId: status.documentId as string, activeStepId: null, completed: status.completed as number }
}

/**
 * 创建页面运行时部署器。
 *
 * @param deps 见 {@link PageBootstrapDeps}；`context` 负责账号与 documentId 核验，`scripting` 负责注入。
 * @returns 提供 `prepare(expected)`：核验上下文、注入 MAIN 入口、初始化 runtime，并返回严格核验后的文档状态。
 */
export function createPageBootstrap({ context, scripting }: PageBootstrapDeps) {
  let active: { key: string; promise: Promise<PageBootstrapStatus> } | null = null

  /** files 注入的返回值同样核验文档：Chrome 报到别的 documentId 时不算成功。 */
  async function injectMainFile(expected: StepContext): Promise<void> {
    const results = await scripting.executeScript({
      target: { tabId: expected.tabId, documentIds: [expected.documentId] },
      world: 'MAIN',
      files: [PAGE_MAIN_FILE],
    })
    if (!Array.isArray(results) || results.length !== 1 || results[0]?.documentId !== expected.documentId) {
      throw unavailable()
    }
  }

  /** 在固定文档调用初始化入口；入口幂等，重复调用复用原 runtime，不重载也不清锁。 */
  async function initializeRuntime(expected: StepContext): Promise<PageBootstrapStatus> {
    // Chrome 只序列化该函数本身；不得引用模块变量或模块作用域函数。
    const initialize = function (documentId: string): unknown {
      const scope = window as unknown as {
        __fishopsInitPageRuntimeV1__?: (documentId: string) => void
        __fishopsPageRuntimeV1__?: { status?: () => unknown }
      }
      const init = scope.__fishopsInitPageRuntimeV1__
      if (typeof init !== 'function') return { __pageBootstrapMissingEntry: true }
      init(documentId)
      const runtime = scope.__fishopsPageRuntimeV1__
      return runtime && typeof runtime.status === 'function' ? runtime.status() : null
    }
    const results = await scripting.executeScript({
      target: { tabId: expected.tabId, documentIds: [expected.documentId] },
      world: 'MAIN',
      func: initialize as unknown as (...args: unknown[]) => unknown,
      args: [expected.documentId],
    })
    if (!Array.isArray(results) || results.length !== 1 || results[0]?.documentId !== expected.documentId) {
      throw unavailable()
    }
    return readStatus(results[0]?.result, expected)
  }

  /** 一次完整部署：核验 → 注入 → 初始化 → 返回前再核验。 */
  async function run(expected: StepContext): Promise<PageBootstrapStatus> {
    try {
      const verified = await context.verify(expected)
      if (verified.accountId !== expected.accountId) throw accountChanged()
      if (verified.tabId !== expected.tabId || verified.documentId !== expected.documentId) throw unavailable()
      await injectMainFile(verified)
      const status = await initializeRuntime(verified)
      // 注入与初始化期间可能发生导航或账号切换；返回前必须重新核验，不能回传旧文档状态。
      const after = await context.verify(verified)
      if (after.accountId !== verified.accountId) throw accountChanged()
      if (after.tabId !== verified.tabId || after.documentId !== verified.documentId) throw unavailable()
      return status
    } catch (error) {
      throw sanitize(error)
    }
  }

  async function prepare(expected: StepContext): Promise<PageBootstrapStatus> {
    const key = contextKey(expected)
    if (key === null) throw unavailable()
    if (active) {
      // 同文档复用同一次在途部署；不同文档在途时拒绝，绝不并发重注入。
      if (active.key === key) return active.promise
      throw unavailable()
    }
    const promise = run(expected)
    active = { key, promise }
    try {
      return await promise
    } finally {
      if (active?.promise === promise) active = null
    }
  }

  return { prepare }
}
