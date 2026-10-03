/**
 * 当前用户 ID（myUserId）解析器（background 侧，P8）。
 *
 * 背景：P5/P6 需要 `platform.currentUserId` 判断聊天方向、构造发送信封。旧实现把
 * **失败结果也缓存到整个 service worker 生命周期**，导致真实发送时若无 goofish tab
 * 就永久报「当前用户 ID 未就绪」，直到 worker 被回收。
 *
 * 本模块修正缓存策略：
 * - 成功缓存固定 TTL（默认 5 分钟），过期后重新获取；
 * - 失败只缓存短退避窗口（指数退避，5s → … → 上限 60s），窗口内非强制调用不重复请求；
 * - **用户显式发送/准备（`force: true`）时忽略失败退避，重新尝试一次**（允许重试），
 *   但每次调用只发起一次请求，不做内部循环，因此不会无限重试；
 * - 并发去重：同一时刻只允许一个进行中的请求被多个调用方共享。
 *
 * 安全：本模块只在返回结果里暴露 `userId` 给**发送流程内部使用**；对外的
 * {@link MyUserIdResolver.peek} 只给布尔与状态，**绝不输出用户 ID 值**。
 */
import { PlatformError, classifyThrownError, type PlatformErrorCategory } from '../platform/errors'

/** 获取结果：成功带 userId，失败带结构化类别（不抛错）。retCode 用于诊断透传（不含凭据）。 */
export type MyUserIdOutcome =
  | { ok: true; userId: string; fromCache: boolean }
  | { ok: false; category: PlatformErrorCategory; message: string; retCode?: string }

/** 只读快照（不含 userId 值）。 */
export interface MyUserIdPeek {
  /** 是否持有可用的用户 ID。 */
  hasUserId: boolean
  /** 成功缓存过期时间（毫秒）；无成功缓存时为 null。 */
  expiresAt: number | null
  /** 是否处于失败退避窗口内。 */
  failing: boolean
  /** 退避窗口结束时间（毫秒）；不在退避时为 null。 */
  failureUntil: number | null
  /** 最近一次失败类别（若有）。 */
  category?: PlatformErrorCategory
  /** 最近一次失败信息（若有）。 */
  message?: string
  /** 最近一次失败的 MTOP ret 码（若有，不含凭据）。 */
  retCode?: string
}

export interface MyUserIdResolverDeps {
  /** 真正的获取实现；成功返回非空 userId，失败抛错（PlatformError 会被按类别归类）。 */
  fetch: () => Promise<string>
  now?: () => number
  /** 成功缓存 TTL，默认 5 分钟。 */
  successTtlMs?: number
  /** 首次失败退避，默认 5 秒。 */
  initialBackoffMs?: number
  /** 失败退避上限，默认 60 秒。 */
  maxBackoffMs?: number
}

export interface MyUserIdResolver {
  /** 获取当前用户 ID；`force` 为真时忽略失败退避窗口重试。 */
  get(options?: { force?: boolean }): Promise<MyUserIdOutcome>
  /** 只读快照（不含 userId 值）。 */
  peek(): MyUserIdPeek
  /** 清空缓存（用于测试）。 */
  reset(): void
}

const DEFAULT_SUCCESS_TTL_MS = 5 * 60 * 1000
const DEFAULT_INITIAL_BACKOFF_MS = 5000
const DEFAULT_MAX_BACKOFF_MS = 60000

/** 创建 myUserId 解析器。 */
export function createMyUserIdResolver(deps: MyUserIdResolverDeps): MyUserIdResolver {
  const now = deps.now ?? (() => Date.now())
  const successTtlMs = deps.successTtlMs ?? DEFAULT_SUCCESS_TTL_MS
  const initialBackoffMs = deps.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS
  const maxBackoffMs = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS

  let cachedUserId: string | null = null
  let expiresAt: number | null = null
  let failureUntil: number | null = null
  let backoffMs = initialBackoffMs
  let lastFailure: { category: PlatformErrorCategory; message: string; retCode?: string } | null = null
  let inFlight: Promise<MyUserIdOutcome> | null = null

  function failureOutcome(): MyUserIdOutcome {
    const failure = lastFailure ?? { category: 'unknown' as PlatformErrorCategory, message: '获取用户 ID 失败' }
    return {
      ok: false,
      category: failure.category,
      message: failure.message,
      ...(failure.retCode === undefined ? {} : { retCode: failure.retCode }),
    }
  }

  async function fetchOnce(): Promise<MyUserIdOutcome> {
    try {
      const userId = await deps.fetch()
      if (typeof userId !== 'string' || userId.length === 0) {
        throw new PlatformError('unknown', '登录用户接口未返回有效的用户 ID')
      }
      cachedUserId = userId
      expiresAt = now() + successTtlMs
      // 成功后重置退避。
      failureUntil = null
      backoffMs = initialBackoffMs
      lastFailure = null
      return { ok: true, userId, fromCache: false }
    } catch (error) {
      const payload = error instanceof PlatformError ? error.toPayload() : classifyThrownError(error)
      lastFailure = {
        category: payload.category,
        message: payload.message,
        ...(payload.retCode === undefined ? {} : { retCode: payload.retCode }),
      }
      failureUntil = now() + backoffMs
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
      return {
        ok: false,
        category: payload.category,
        message: payload.message,
        ...(payload.retCode === undefined ? {} : { retCode: payload.retCode }),
      }
    }
  }

  return {
    get(options = {}): Promise<MyUserIdOutcome> {
      const at = now()

      // 并发去重：进行中的请求优先复用。
      if (inFlight) return inFlight

      // 成功缓存仍在 TTL 内：直接命中（force 也不例外，避免无谓请求）。
      if (cachedUserId !== null && expiresAt !== null && at < expiresAt) {
        return Promise.resolve({ ok: true, userId: cachedUserId, fromCache: true })
      }

      // 失败退避窗口内且非强制：不重复请求（避免无限重试）。
      if (!options.force && failureUntil !== null && at < failureUntil) {
        return Promise.resolve(failureOutcome())
      }

      const run = fetchOnce()
      inFlight = run.finally(() => {
        inFlight = null
      })
      return inFlight
    },

    peek(): MyUserIdPeek {
      const at = now()
      const hasUserId = cachedUserId !== null && expiresAt !== null && at < expiresAt
      const failing = !hasUserId && failureUntil !== null && at < failureUntil
      return {
        hasUserId,
        expiresAt: cachedUserId === null ? null : expiresAt,
        failing,
        failureUntil: failing ? failureUntil : null,
        ...(lastFailure === null ? {} : { category: lastFailure.category, message: lastFailure.message }),
        ...(lastFailure?.retCode === undefined ? {} : { retCode: lastFailure.retCode }),
      }
    },

    reset(): void {
      cachedUserId = null
      expiresAt = null
      failureUntil = null
      backoffMs = initialBackoffMs
      lastFailure = null
      inFlight = null
    },
  }
}
