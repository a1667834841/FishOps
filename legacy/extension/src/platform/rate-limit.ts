/**
 * 请求限速。
 *
 * 闲鱼 MTOP 的请求频率过高会触发风控，旧代码（inject.js 的 autoCrawl）默认每页等待 1500ms。
 * 这里把“串行 + 固定最小间隔”的限速逻辑独立出来，默认间隔 {@link DEFAULT_MIN_INTERVAL_MS}，
 * 并注入 now/sleep 以便在 Node 中做确定性测试。
 */

/** 默认最小请求间隔（毫秒），与原 autoCrawl 的 1500ms 一致。 */
export const DEFAULT_MIN_INTERVAL_MS = 1500

export interface RateLimiterOptions {
  /** 最小间隔，默认 1500ms。 */
  minIntervalMs?: number
  /** 随机增量上限（毫秒），默认 0（即固定间隔）。实际间隔 = minInterval + [0, jitterMs]。 */
  jitterMs?: number
  /** 当前时间来源，默认 Date.now。 */
  now?: () => number
  /** 休眠实现，默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>
  /** 均匀随机源，返回 [0,1)，默认 Math.random。 */
  random?: () => number
}

export interface RateLimiter {
  /** 最小间隔（毫秒）。 */
  readonly minIntervalMs: number
  /**
   * 获取一个“放行令牌”：调用方在发起请求前 await 它。
   * 多个并发调用会按到达顺序串行等待，保证相邻请求间隔不小于 minIntervalMs。
   */
  acquire(): Promise<void>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 创建一个限速器。 */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const jitterMs = options.jitterMs && options.jitterMs > 0 ? Math.floor(options.jitterMs) : 0
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random

  /** 本次允许的最小间隔：固定间隔 + [0, jitterMs] 均匀随机增量。 */
  const nextInterval = (): number => {
    if (jitterMs <= 0) return minIntervalMs
    const increment = Math.min(jitterMs, Math.max(0, Math.floor(random() * (jitterMs + 1))))
    return minIntervalMs + increment
  }

  // 串行队列：后一次 acquire 挂在前一次之后；错误不影响后续。
  let tail: Promise<void> = Promise.resolve()
  let lastAt: number | null = null

  return {
    minIntervalMs,
    acquire(): Promise<void> {
      const run = tail.then(async () => {
        if (lastAt !== null) {
          const wait = nextInterval() - (now() - lastAt)
          if (wait > 0) await sleep(wait)
        }
        lastAt = now()
      })
      // 无论本次成功与否，队列继续，避免一次异常卡死后续请求。
      tail = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },
  }
}
