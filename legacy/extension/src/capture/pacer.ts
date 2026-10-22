/**
 * 采集搜索节流器（P4 优化）。
 *
 * 与 `platform/rate-limit` 的固定间隔限速器不同，采集搜索需要「基础间隔 + 均匀随机增量」：
 * 固定节奏容易被风控识别，加入抖动可降低风险；同时首页不等待，避免首个请求出现无谓延迟。
 *
 * 语义：
 * - 第一次 `pace()` 立即放行（首页立即）；
 * - 其后每次在**处理结束后**完整等待 `baseMs + [0, jitterMs]` 的均匀随机量，
 *   不扣除上一页处理耗时（防止处理耗时把等待“吸收”掉）。
 */
export interface CapturePacerOptions {
  /** 基础间隔（毫秒）。 */
  baseMs: number
  /** 随机增量上限（毫秒），实际增量 = `floor(random * (jitterMs + 1))` ∈ [0, jitterMs]。 */
  jitterMs: number
  /** 时间源，默认 `Date.now`。 */
  now?: () => number
  /** 休眠实现，默认 `setTimeout`。 */
  sleep?: (ms: number) => Promise<void>
  /** 均匀随机源，返回 [0,1)，默认 `Math.random`；测试可注入以获得确定性。 */
  random?: () => number
}

export interface CapturePacer {
  /** 下一次等待的毫秒数（不含时间差修正）。 */
  nextDelayMs(): number
  /** 放行一次请求；首次立即返回，其后在本次调用点完整等待基础间隔 + 随机增量。 */
  pace(): Promise<void>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 创建一个采集搜索节流器。 */
export function createCapturePacer(options: CapturePacerOptions): CapturePacer {
  const baseMs = Number.isFinite(options.baseMs) ? Math.max(0, Math.floor(options.baseMs)) : 0
  const jitterMs = Number.isFinite(options.jitterMs) ? Math.max(0, Math.floor(options.jitterMs)) : 0
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random

  let lastAt: number | null = null

  const nextDelayMs = (): number => {
    if (jitterMs <= 0) return baseMs
    // random() 理论取值 [0,1)，此处对越界值做防御性夹取。
    const increment = Math.min(jitterMs, Math.max(0, Math.floor(random() * (jitterMs + 1))))
    return baseMs + increment
  }

  return {
    nextDelayMs,
    async pace(): Promise<void> {
      // 首次（首页）立即放行。
      if (lastAt === null) {
        lastAt = now()
        return
      }
      // 处理结束后完整等待，不扣除上一页处理耗时。
      const delay = nextDelayMs()
      if (delay > 0) await sleep(delay)
      lastAt = now()
    },
  }
}
