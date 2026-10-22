import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runSliderDrag, type ChromeDebuggerApi, type SliderRunnerTimers } from '../slider-runner.ts'

type Call = { method: string; params?: Record<string, unknown> }

/** 记录 CDP 调用并可注入失败的假 debugger。 */
class FakeDebugger implements ChromeDebuggerApi {
  calls: Call[] = []
  attached = 0
  detached = 0
  failOn: string | null = null
  async attach(): Promise<void> { this.attached += 1 }
  async detach(): Promise<void> { this.detached += 1 }
  async sendCommand(_target: { tabId: number }, method: string, params?: Record<string, unknown>): Promise<unknown> {
    // failOn 匹配的是鼠标事件类型（mouseMoved 等），不是 CDP 方法名。
    if (this.failOn !== null && params?.type === this.failOn) throw new Error(`注入失败：${this.failOn}`)
    this.calls.push({ method, params })
    return {}
  }
  /** 只取事件类型序列，便于断言。 */
  types(): string[] { return this.calls.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => String(c.params!.type)) }
}

/**
 * 假时钟：按计划延时排序触发，模拟真实时间流逝。
 *
 * 守卫定时器（8000ms）注册在拖动开始前，工作定时器都是百毫秒级；
 * 按延时排序后天然形成「工作先完成、守卫后到期」的真实时序，
 * 避免一次性 flush 让守卫抢先把工作竞争掉。
 */
class FakeTimers implements SliderRunnerTimers {
  #handles = new Map<number, { at: number; handler: () => void }>()
  #next = 1
  #now = 0
  #startedAt = 0
  setTimeout(handler: () => void, ms: number): number {
    const id = this.#next
    this.#next += 1
    this.#handles.set(id, { at: this.#now + Math.max(0, ms), handler })
    return id
  }
  clearTimeout(handle: number): void { this.#handles.delete(handle) }
  /**
   * 持续推进时钟直到没有任何待触发定时器。
   *
   * 被测代码在 `await delay()` 处会让出事件循环，因此必须用微任务间隙
   * 逐定时器推进，不能一次性同步 flush，否则后续 `await` 永远等不到时钟。
   */
  /**
   * 触发最早到期的定时器，并让出微任务让 await 链继续。
   *
   * 只推进一步，由测试按需反复调用；这样能精确控制在守卫定时器之前停下，
   * 不会无脑推进到 8000ms 把正常完成误判成超时。
   */
  /**
   * 触发最早到期的「节奏」定时器，并让出微任务让 await 链继续。
   *
   * 总预算定时器（延时 >= 8000ms）被单独隔离，不参与节奏推进：
   * 否则它会在拖动正常结束后到期，把已完成的结果改成失败。
   * 只有 `fireBudget()` 会显式触发它，用于构造超时场景。
   */
  async tick(): Promise<boolean> {
    const entries = [...this.#handles.entries()]
      .filter(([, timer]) => timer.at - this.#startedAt < 8000)
      .sort((a, b) => a[1].at - b[1].at)
    if (entries.length === 0) return false
    const [id, timer] = entries[0]!
    this.#handles.delete(id)
    this.#now = timer.at
    timer.handler()
    await Promise.resolve()
    return true
  }

  /** 显式触发总预算定时器，用于验证超时路径。 */
  fireBudget(): void {
    const entries = [...this.#handles.entries()].filter(([, timer]) => timer.at - this.#startedAt >= 8000)
    for (const [id, timer] of entries) {
      this.#handles.delete(id)
      this.#now = timer.at
      timer.handler()
    }
  }

  /**
   * 持续推进时钟直到 `pending` 落定或超过兜底轮数。
   *
   * 用 `settled` 标志判断而非 Promise 状态：被测代码在 `await` 链上注册的
   * 下一个定时器，要等几轮微任务后才出现，因此每次 tick 后都再让出一轮。
   */
  async runUntil(settled: () => boolean, maxRounds = 500): Promise<void> {
    for (let round = 0; round < maxRounds; round += 1) {
      if (settled()) return
      if (!(await this.tick())) await Promise.resolve()
    }
  }
  /**
   * 已流逝毫秒数；被测代码用它判定总预算。
   *
   * 与节奏时钟 `#now` 解耦：节奏推进不应顺带推进预算，
   * 否则正常拖动的累计停顿会被误判成超时。测试用 `advanceBudget` 显式推进。
   */
  #budget = 0
  elapsed(): number { return this.#budget }
  /** 显式推进预算时钟，用于构造超时场景。 */
  advanceBudget(ms: number): void { this.#budget += ms }
}

const PLAN = { from: { x: 180, y: 280 }, path: [
  { x: 190, y: 280 }, { x: 210, y: 280 }, { x: 300, y: 280 }, { x: 320, y: 280 },
] }

test('按 pressed → moved... → released 顺序派发，且 detach 成对', async () => {
  const api = new FakeDebugger()
  const timers = new FakeTimers()
  const pending = runSliderDrag({ api, timers }, 7, PLAN)
  // 以 detach 完成为完成标志：detach 位于 work 的 finally，晚于全部事件派发。
  await timers.runUntil(() => api.detached === 1)
  const result = await pending
  assert.equal(result.ok, true)
  assert.deepEqual(api.types(), ['mousePressed', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseMoved', 'mouseReleased'])
  assert.equal(api.attached, 1)
  assert.equal(api.detached, 1)
})

test('按下点与轨迹点原样进入 CDP 参数，不改写坐标', async () => {
  const api = new FakeDebugger()
  const timers = new FakeTimers()
  const pending = runSliderDrag({ api, timers }, 7, PLAN)
  await timers.runUntil(() => api.detached === 1)
  await pending
  const events = api.calls.filter(c => c.method === 'Input.dispatchMouseEvent')
  assert.deepEqual(events[0]!.params, { type: 'mousePressed', x: 180, y: 280, buttons: 1, clickCount: 1 })
  // 移动与释放阶段必须带 buttons=1，否则平台收不到拖动状态。
  for (const event of events.slice(1)) assert.equal(event.params!.buttons, 1)
  assert.equal(events[events.length - 1]!.params!.x, 320)
})

test('移动阶段失败时也 detach，不残留调试横幅', async () => {
  const api = new FakeDebugger()
  api.failOn = 'mouseMoved'
  const timers = new FakeTimers()
  const pending = runSliderDrag({ api, timers }, 7, PLAN)
  // 以 detach 完成为完成标志：detach 位于 work 的 finally，晚于全部事件派发。
  await timers.runUntil(() => api.detached === 1)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(api.detached, 1, '失败也必须 detach')
})

test('attach 失败时不派发任何事件也不 detach', async () => {
  const api = new FakeDebugger()
  const original = api.attach.bind(api)
  api.attach = async () => { throw new Error('已附加') }
  void original
  const timers = new FakeTimers()
  const pending = runSliderDrag({ api, timers }, 7, PLAN)
  // 以 detach 完成为完成标志：detach 位于 work 的 finally，晚于全部事件派发。
  await timers.runUntil(() => api.detached === 1)
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(api.calls.length, 0)
  assert.equal(api.detached, 0, '未附加成功时不需要 detach')
})

test('tabId 非法或计划为空时直接失败，不附加', async () => {
  const api = new FakeDebugger()
  const timers = new FakeTimers()
  assert.equal((await runSliderDrag({ api, timers }, -1, PLAN)).ok, false)
  assert.equal((await runSliderDrag({ api, timers }, 1.5, PLAN)).ok, false)
  assert.equal((await runSliderDrag({ api, timers }, 7, { from: { x: 0, y: 0 }, path: [] })).ok, false)
  assert.equal(api.attached, 0)
  assert.equal(api.calls.length, 0)
})

test('派发永久挂起时由总预算结束拖动，并 detach', async () => {
  const api = new FakeDebugger()
  // 让派发永不返回：只有预算定时器能让本次拖动结束。
  api.sendCommand = () => new Promise(() => {})
  const timers = new FakeTimers()
  const pending = runSliderDrag({ api, timers }, 7, PLAN)
  // 先让 attach 与 pressed 跑完，再显式触发预算超限。
  await timers.runUntil(() => api.calls.length >= 1)
  timers.fireBudget()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(api.attached, 1, '预算超限前已附加')
  assert.equal(api.detached, 1, '预算超限也必须 detach')
  assert.ok(api.calls.length < 6, `不应派发完整序列，实际 ${api.calls.length} 个事件`)
})
