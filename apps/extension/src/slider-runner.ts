/**
 * 滑块自动拖动执行器（SW 侧，只依赖 `chrome.debugger`）。
 *
 * 为什么用 CDP 而不是页面内合成事件：
 * - 平台滑块监听的是真实输入链路；MAIN world 里 `dispatchEvent(new MouseEvent(...))`
 *   缺少 `isTrusted`，且事件不经浏览器输入管线，极易被判为脚本。
 * - `chrome.debugger.sendCommand` 走的是浏览器原生输入通道，与真人操作同源，
 *   这是 reverse-skill field-journal 记录中成功率最高的方案。
 *
 * 边界：
 * - 只在调用方指定的 tabId 上附加，绝不在用户当前活跃页面之外操作；detach 必须成对执行。
 * - 位移与轨迹完全来自页面侧 {@link locateSlider} 的计算，本模块不改写数值。
 * - 任何失败都返回 `false` 由调用方回落人工验证，绝不重试、绝不伪造通过。
 */
import { sliderMoveTrack, type Point } from './slider-plan.ts'

/** `chrome.debugger` 的最小使用面；测试注入替身，不启动 Chrome。 */
export interface ChromeDebuggerApi {
  attach(target: { tabId: number }, version: string): Promise<void>
  detach(target: { tabId: number }): Promise<void>
  sendCommand(target: { tabId: number }, method: string, params?: Record<string, unknown>): Promise<unknown>
}

/** 单步之间的间隔；过快会退化成瞬时位移，与轨迹的拟人设计矛盾。 */
const STEP_INTERVAL_MS = 12
/** 按下后的停顿；真人从按下到移动有反应时间。 */
const PRESS_SETTLE_MS = 90
/** 释放前的停顿；模拟到位后的确认。 */
const RELEASE_SETTLE_MS = 140
/** 单次拖动的总时长上限；超时即失败，绝不无限等待。 */
const TOTAL_TIMEOUT_MS = 8_000

/**
 * 只暴露本模块需要的计时函数，便于测试用假时钟控制。
 *
 * 两个时钟必须分离，否则测试里推进节奏会顺带触发总预算、把正常拖动误判为超时：
 * - `setTimeout` / `clearTimeout` 只承载拖动节奏（按下停顿、步进间隔、释放停顿）；
 * - `elapsed()` 是单调递增的真实经过时间，只用于总预算判定。
 */
export interface SliderRunnerTimers {
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(handle: number): void
  /** 单调递增的已流逝毫秒数；测试可用可控值源，不参与节奏推进。 */
  elapsed(): number
}

export interface SliderRunnerDeps {
  api: ChromeDebuggerApi
  timers: SliderRunnerTimers
}

/** 拖动结果；成功只表示事件已派发，是否真正通过验证由页面侧轮询判定。 */
export interface DragOutcome {
  ok: boolean
}

/**
 * 节奏等待；同时承担总预算判定。
 *
 * 每次等待前检查是否已超总预算：超预算立即 reject，由调用方统一 detach 并回落。
 * 这样守卫不依赖独立定时器，测试推进节奏时钟不会顺带触发总超时。
 */
function delay(timers: SliderRunnerTimers, ms: number, deadline: number): Promise<void> {
  if (timers.elapsed() >= deadline) return Promise.reject(new Error('滑块拖动超出总时长预算'))
  return new Promise<void>((resolve, reject) => {
    const handle = timers.setTimeout(() => {
      if (timers.elapsed() >= deadline) { reject(new Error('滑块拖动超出总时长预算')); return }
      resolve()
    }, ms)
    // 没有取消路径：定时器一定会触发，handle 仅为接口完整性保留。
    void handle
  })
}

/**
 * 给单次 CDP 派发套上预算上限。
 *
 * `chrome.debugger.sendCommand` 在目标页崩溃或调试器被占用时会永久挂起，
 * 若不设上限，整个拖动会无限等待并一直占住文档锁。这里用「预算到期即 reject」
 * 的方式打断等待；注意 reject 后原 CDP 调用仍在后台，但已无法再影响结果，
 * 且 finally 里的 detach 会随本次调用结束而执行。
 */
function withDeadline<T>(timers: SliderRunnerTimers, promise: Promise<T>, deadline: number): Promise<T> {
  if (timers.elapsed() >= deadline) return Promise.reject(new Error('滑块拖动超出总时长预算'))
  return new Promise<T>((resolve, reject) => {
    let stopped = false
    const finish = (settle: () => void): void => {
      if (stopped) return
      stopped = true
      settle()
    }
    // 只注册一个「到预算终点即失败」的定时器，不做周期轮询：
    // 轮询会让时钟自我续期，既拖长拖动，也让测试时钟无法收敛。
    // 真实 CDP 调用若已在此之前返回，定时器会在 finish 中被清理。
    const handle = timers.setTimeout(
      () => finish(() => reject(new Error('滑块拖动超出总时长预算'))),
      Math.max(0, deadline - timers.elapsed()),
    )
    promise.then(
      value => { timers.clearTimeout(handle); finish(() => resolve(value)) },
      error => { timers.clearTimeout(handle); finish(() => reject(error)) },
    )
  })
}

/** 派发一个鼠标事件；失败直接抛出，由调用方统一 detach 并回落。 */
async function dispatch(
  api: ChromeDebuggerApi,
  tabId: number,
  type: string,
  point: Point,
  buttons: number,
): Promise<void> {
  await api.sendCommand(
    { tabId },
    'Input.dispatchMouseEvent',
    { type, x: point.x, y: point.y, buttons, clickCount: 1 },
  )
}

/**
 * 在指定标签页按计划派发一次完整拖动。
 *
 * @param tabId 目标标签页；必须与当前执行上下文一致，不得更换
 * @param plan 页面侧计算的拖动计划
 * @returns 事件全部派发成功返回 `{ ok: true }`；任何阶段失败返回 `{ ok: false }`
 */
export async function runSliderDrag(
  deps: SliderRunnerDeps,
  tabId: number,
  plan: { from: Point; path: readonly Point[] },
): Promise<DragOutcome> {
  const { api, timers } = deps
  if (!Number.isSafeInteger(tabId) || tabId < 0) return { ok: false }
  if (!plan || !plan.from || !Array.isArray(plan.path) || plan.path.length === 0) return { ok: false }
  let attached = false
  // 总时长预算：从本函数进入开始计时，覆盖 attach 与全部派发。
  // 预算判定内嵌在每次节奏等待里，不需要独立定时器，因此不存在
  // 「守卫定时器与节奏定时器混在同一时钟」的误触发问题。
  const deadline = timers.elapsed() + TOTAL_TIMEOUT_MS
  const work = (async (): Promise<DragOutcome> => {
    try {
      await withDeadline(timers, api.attach({ tabId }, '1.3'), deadline)
      attached = true
      // buttons=1 表示左键按下；移动与释放阶段都必须带上，否则平台收不到拖动状态。
      await withDeadline(timers, dispatch(api, tabId, 'mousePressed', plan.from, 1), deadline)
      await delay(timers, PRESS_SETTLE_MS, deadline)
      for (const point of plan.path) {
        await withDeadline(timers, dispatch(api, tabId, 'mouseMoved', point, 1), deadline)
        await delay(timers, STEP_INTERVAL_MS, deadline)
      }
      await delay(timers, RELEASE_SETTLE_MS, deadline)
      await withDeadline(timers, dispatch(api, tabId, 'mouseReleased', plan.path[plan.path.length - 1]!, 1), deadline)
      return { ok: true }
    } catch {
      return { ok: false }
    } finally {
      if (attached) {
        // detach 失败不影响本次结果判定，但必须尝试，否则标签页顶部会残留调试横幅。
        try { await api.detach({ tabId }) } catch {}
      }
    }
  })()
  return work
}

/** 重新导出轨迹生成，便于 SW 侧调试与测试复用同一实现。 */
export { sliderMoveTrack }
