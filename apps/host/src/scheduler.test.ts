import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACCOUNT_INTERVAL_MS, CATEGORY_INTERVAL_MS, Scheduler, type SchedulerSnapshot } from './scheduler.ts'

/** 触发调度链路上的 microtask，测试中禁止真实 sleep。 */
async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await new Promise(resolve => setImmediate(resolve))
}

/** 可控时钟；定时器只在本对象被显式推进时触发。 */
class FakeClock {
  time = 0
  #timers = new Map<number, { at: number; run: () => void }>()
  #nextId = 1
  now = (): number => this.time
  setTimer = (run: () => void, delayMs: number): number => {
    const id = this.#nextId
    this.#nextId += 1
    this.#timers.set(id, { at: this.time + Math.max(0, delayMs), run })
    return id
  }
  clearTimer = (handle: unknown): void => {
    this.#timers.delete(handle as number)
  }
  /** 仍未清理的定时器数量。 */
  get pendingTimers(): number {
    return this.#timers.size
  }
  async advance(delayMs: number): Promise<void> {
    await this.advanceTo(this.time + delayMs)
  }
  /** 推进到目标时刻并按到期顺序触发沿途定时器。 */
  async advanceTo(target: number): Promise<void> {
    for (;;) {
      await flush()
      const due = this.#earliest()
      if (!due || due.at > target) break
      this.#timers.delete(due.id)
      this.time = Math.max(this.time, due.at)
      due.run()
    }
    this.time = Math.max(this.time, target)
    await flush()
  }
  /** 直接改写时钟（可小于当前时间），用于模拟系统时钟回拨。 */
  async jump(target: number): Promise<void> {
    this.time = target
    await flush()
  }
  #earliest(): { id: number; at: number; run: () => void } | undefined {
    let earliest: { id: number; at: number; run: () => void } | undefined
    for (const [id, timer] of this.#timers) if (!earliest || timer.at < earliest.at) earliest = { id, at: timer.at, run: timer.run }
    return earliest
  }
}

/** 内存持久化；写入是同步的，与调度契约一致。 */
class FakeStore {
  snapshots = new Map<string, SchedulerSnapshot>()
  saves: Array<{ accountId: string; snapshot: SchedulerSnapshot }> = []
  saveCalls = 0
  failNextSave = false
  failLoad = false
  /** 同步写入时回调，用于构造“已出队、尚未执行”窗口内的外部动作。 */
  onSave: (() => void) | null = null
  load = async (accountId: string): Promise<SchedulerSnapshot | undefined> => {
    if (this.failLoad) throw Object.assign(new Error('读取调度快照失败'), { code: 'INTERNAL' })
    return this.snapshots.get(accountId)
  }
  save = (accountId: string, snapshot: SchedulerSnapshot): void => {
    this.saveCalls += 1
    if (this.failNextSave) {
      this.failNextSave = false
      throw Object.assign(new Error('磁盘写入失败'), { code: 'INTERNAL' })
    }
    this.snapshots.set(accountId, snapshot)
    this.saves.push({ accountId, snapshot })
    this.onSave?.()
  }
}

/** 组装被测调度器与假依赖。 */
function buildScheduler(options: {
  clock?: FakeClock
  store?: FakeStore
  random?: () => number
  save?: (accountId: string, snapshot: SchedulerSnapshot) => void
  setTimer?: (callback: () => void, delayMs: number) => unknown
} = {}) {
  const clock = options.clock ?? new FakeClock()
  const store = options.store ?? new FakeStore()
  const scheduler = new Scheduler({
    now: clock.now,
    setTimer: options.setTimer ?? clock.setTimer,
    clearTimer: clock.clearTimer,
    load: store.load,
    save: options.save ?? store.save,
    random: options.random ?? (() => 0),
  })
  return { clock, store, scheduler }
}

test('账号无历史时首项立即派发，快照只写时间与预留字段', async () => {
  const { store, scheduler } = buildScheduler()
  let calls = 0
  const pending = scheduler.run({ accountId: 'u1', category: 'search' }, async () => {
    calls += 1
    return 'ok'
  })
  assert.equal(calls, 0, 'run 不得同步执行平台回调')
  assert.equal(await pending, 'ok')
  assert.equal(calls, 1)
  assert.equal(store.saveCalls, 2, '记账预留与终结覆盖各写一次')
  assert.deepEqual(store.saves[0].snapshot, {
    lastStartedAt: 0,
    categories: { search: 0 },
    pending: { category: 'search', reservedAt: 0 },
  })
  assert.deepEqual(store.snapshots.get('u1'), { lastStartedAt: 0, categories: { search: 0 }, pending: null })
  assert.deepEqual(Object.keys(store.saves[0].snapshot).sort(), ['categories', 'lastStartedAt', 'pending'])
})

test('全部平台请求共用一个在途槽，跨账号也必须串行', async () => {
  const { scheduler } = buildScheduler()
  let active = 0
  let maxActive = 0
  const gates: Array<() => void> = []
  const start = (accountId: string) =>
    scheduler.run({ accountId, category: 'search' }, () => new Promise<string>(resolve => {
      active += 1
      maxActive = Math.max(maxActive, active)
      gates.push(() => {
        active -= 1
        resolve(accountId)
      })
    }))
  const first = start('u1')
  const second = start('u2')
  const third = start('u3')
  await flush()
  assert.equal(active, 1, '同时只能在途一个请求')
  assert.equal(gates.length, 1)
  gates.shift()!()
  await flush()
  assert.equal(active, 1)
  assert.equal(gates.length, 1)
  gates.shift()!()
  await flush()
  assert.equal(gates.length, 1)
  gates.shift()!()
  assert.deepEqual(await Promise.all([first, second, third]), ['u1', 'u2', 'u3'])
  assert.equal(maxActive, 1)
})

test('同账号不同类别仍需满足 1000ms 总间隔', async () => {
  const { clock, scheduler } = buildScheduler()
  const stamps: number[] = []
  await scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  const pending = scheduler.run({ accountId: 'u1', category: 'chatRead' }, async () => { stamps.push(clock.time) })
  await flush()
  assert.deepEqual(stamps, [0], 'chatRead 类别间隔只有 300ms，但总间隔未到不得派发')
  await clock.advance(ACCOUNT_INTERVAL_MS - 1)
  assert.deepEqual(stamps, [0])
  await clock.advance(1)
  await pending
  assert.deepEqual(stamps, [0, ACCOUNT_INTERVAL_MS])
})

test('同账号同类别按强制下限加随机上限冷却', async () => {
  const { clock, scheduler } = buildScheduler({ random: () => 0.5 })
  const stamps: number[] = []
  await scheduler.run({ accountId: 'u1', category: 'detail' }, async () => { stamps.push(clock.time) })
  const pending = scheduler.run({ accountId: 'u1', category: 'detail' }, async () => { stamps.push(clock.time) })
  await flush()
  await clock.advance(1999)
  assert.deepEqual(stamps, [0], 'detail 间隔为 1500+0.5*1000')
  await clock.advance(1)
  await pending
  assert.deepEqual(stamps, [0, 2000])
})

test('随机数下界为 0 时按强制下限派发', async () => {
  const { clock, scheduler } = buildScheduler({ random: () => 0 })
  const stamps: number[] = []
  await scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  const pending = scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  await flush()
  await clock.advance(1499)
  assert.deepEqual(stamps, [0])
  await clock.advance(1)
  await pending
  assert.deepEqual(stamps, [0, CATEGORY_INTERVAL_MS.search.minIntervalMs])
})

test('随机数接近 1 时不超过上限，且在推进过程中不提前派发', async () => {
  const sample = 0.9999999999
  const { clock, scheduler } = buildScheduler({ random: () => sample })
  const stamps: number[] = []
  await scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  const pending = scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  await flush()
  await clock.advance(2999)
  assert.deepEqual(stamps, [0])
  await clock.advance(1)
  await pending
  assert.equal(stamps.length, 2)
  assert.ok(Math.abs(stamps[1] - (1500 + sample * 1500)) < 1e-6, '间隔应为 1500+sample*1500')
})

test('随机数每个队列项只采样一次', async () => {
  let calls = 0
  const { clock, scheduler } = buildScheduler({ random: () => { calls += 1; return 0 } })
  const stamps: number[] = []
  const items = [1, 2, 3].map(() => scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) }))
  await flush()
  assert.equal(calls, 3, '入队时各采样一次，泵入时不得重采样')
  await clock.advance(1500)
  await clock.advance(1500)
  await Promise.all(items)
  assert.deepEqual(stamps, [0, 1500, 3000])
  assert.equal(calls, 3)
})

test('调用方只能增大分类下限，取入参与强制下限的较大值', async () => {
  const { clock, scheduler } = buildScheduler()
  const stamps: number[] = []
  await scheduler.run({ accountId: 'u1', category: 'search', minIntervalMs: 100 }, async () => { stamps.push(clock.time) })
  const shortened = scheduler.run({ accountId: 'u1', category: 'search', minIntervalMs: 100 }, async () => { stamps.push(clock.time) })
  await flush()
  await clock.advance(1499)
  assert.deepEqual(stamps, [0], '100ms 不得缩短 1500ms 强制下限')
  await clock.advance(1)
  await shortened
  assert.deepEqual(stamps, [0, 1500])
  await scheduler.run({ accountId: 'u2', category: 'search', minIntervalMs: 5000 }, async () => { stamps.push(clock.time) })
  const raised = scheduler.run({ accountId: 'u2', category: 'search', minIntervalMs: 5000 }, async () => { stamps.push(clock.time) })
  await flush()
  await clock.advance(4999)
  assert.equal(stamps.length, 3, '增大后的下限必须生效')
  await clock.advance(1)
  await raised
  assert.deepEqual(stamps, [0, 1500, 1500, 6500])
})

test('等待队列上限 100 且不把在途请求计入队列', async () => {
  const { scheduler } = buildScheduler()
  const blocking = scheduler.run({ accountId: 'u1', category: 'search' }, () => new Promise<never>(() => {}))
  void blocking.catch(() => {})
  await flush()
  const queued: Array<Promise<number>> = []
  for (let index = 0; index < 100; index += 1) {
    const pending = scheduler.run({ accountId: `q${index}`, category: 'search' }, async () => index)
    pending.catch(() => {})
    queued.push(pending)
  }
  await flush()
  assert.equal(scheduler.pendingCount, 100)
  await assert.rejects(
    () => scheduler.run({ accountId: 'q100', category: 'search' }, async () => 1),
    error => (error as { code?: string }).code === 'BAD_REQUEST',
  )
  assert.equal(scheduler.pendingCount, 100)
  scheduler.close()
  assert.equal(scheduler.pendingCount, 0)
})

test('排队超时返回 TIMEOUT/queue 且不执行回调', async () => {
  const { clock, scheduler } = buildScheduler()
  const stamps: number[] = []
  await scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  const pending = scheduler.run({ accountId: 'u1', category: 'search', maxWaitMs: 1000 }, async () => { stamps.push(clock.time) })
  // 先挂上拒绝观察器，避免超时发生在前置断言期间被判定为未处理拒绝。
  const rejection = assert.rejects(
    () => pending,
    error => (error as { code?: string }).code === 'TIMEOUT' && (error as { phase?: string }).phase === 'queue',
  )
  await flush()
  await clock.advance(999)
  assert.deepEqual(stamps, [0])
  await clock.advance(1)
  await rejection
  assert.deepEqual(stamps, [0], '超时项不得执行平台回调')
})
test('调用方断开只取消排队项，不释放已开始请求的槽位', async () => {
  const { clock, scheduler } = buildScheduler()
  let release!: () => void
  const inFlight = scheduler.run({ accountId: 'u1', category: 'search' }, () => new Promise<string>(resolve => { release = () => resolve('done') }))
  await flush()
  const controller = new AbortController()
  let queuedCalls = 0
  const queued = scheduler.run({ accountId: 'u2', category: 'search' }, async () => { queuedCalls += 1; return 'late' }, controller.signal)
  const rejected = assert.rejects(() => queued, error => (error as { code?: string }).code === 'CANCELLED' && (error as { phase?: string }).phase === 'queue')
  controller.abort()
  const pump = scheduler.run({ accountId: 'u1', category: 'detail' }, async () => 'pump')
  pump.catch(() => undefined)
  await rejected
  assert.equal(scheduler.pendingCount, 1, '已开始请求仍占用调度槽位')
  release()
  assert.equal(await inFlight, 'done')
  await clock.advance(1500)
  await pump
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(queuedCalls, 0, '取消的排队项不得发出平台请求')
  scheduler.close()
})

test('回调失败仍归还槽位并计间隔，失败不重放', async () => {
  const { clock, store, scheduler } = buildScheduler()
  const executed: string[] = []
  const failing = scheduler.run({ accountId: 'u1', category: 'search' }, async () => {
    executed.push('a')
    throw new Error('平台读取失败')
  })
  await assert.rejects(() => failing, /平台读取失败/)
  assert.deepEqual(executed, ['a'])
  assert.equal(store.snapshots.get('u1')?.lastStartedAt, 0, '失败的已派发尝试仍计间隔')
  const next = scheduler.run({ accountId: 'u1', category: 'search' }, async () => { executed.push('b'); return 'ok' })
  await flush()
  assert.deepEqual(executed, ['a'], '失败不得立即重放')
  await clock.advance(1500)
  assert.equal(await next, 'ok')
  assert.deepEqual(executed, ['a', 'b'])
})

test('cancelAccount 只拒绝该账号排队项，不取消已派发请求', async () => {
  const { scheduler } = buildScheduler()
  let release: (() => void) | undefined
  const inFlight = scheduler.run({ accountId: 'u1', category: 'search' }, () => new Promise<string>(resolve => { release = () => resolve('done') }))
  await flush()
  const sameAccount = scheduler.run({ accountId: 'u1', category: 'detail' }, async () => 'same-account')
  const victim = scheduler.run({ accountId: 'u2', category: 'search' }, async () => 'should-not-run')
  await flush()
  assert.equal(scheduler.cancelAccount('u2'), 1)
  await assert.rejects(() => victim, error => (error as { code?: string }).code === 'ACCOUNT_CHANGED')
  assert.equal(scheduler.pendingCount, 1)
  release!()
  assert.equal(await inFlight, 'done', '在途请求不得被取消')
  assert.equal(scheduler.cancelAccount('u1'), 1)
  await assert.rejects(() => sameAccount, error => (error as { code?: string }).code === 'ACCOUNT_CHANGED')
})

test('close 拒绝所有排队项并清理计时器，不虚假取消已发生请求', async () => {
  const { clock, scheduler } = buildScheduler()
  let release: (() => void) | undefined
  const inFlight = scheduler.run({ accountId: 'u1', category: 'search' }, () => new Promise<string>(resolve => { release = () => resolve('done') }))
  await flush()
  const queued = [1, 2, 3].map(() => scheduler.run({ accountId: 'u2', category: 'search' }, async () => 'queued'))
  await flush()
  assert.equal(scheduler.pendingCount, 3)
  assert.equal(clock.pendingTimers, 1)
  scheduler.close()
  assert.equal(scheduler.pendingCount, 0)
  assert.equal(clock.pendingTimers, 0)
  for (const pending of queued) {
    await assert.rejects(() => pending, error => (error as { code?: string }).code === 'EXTENSION_OFFLINE')
  }
  release!()
  assert.equal(await inFlight, 'done', '已发生的请求保持原状')
  await assert.rejects(
    () => scheduler.run({ accountId: 'u3', category: 'search' }, async () => 'late'),
    error => (error as { code?: string }).code === 'EXTENSION_OFFLINE',
  )
})

test('在途请求不因时间推进释放槽位，也不触发内部超时', async () => {
  const { clock, scheduler } = buildScheduler()
  let release: (() => void) | undefined
  const inFlight = scheduler.run({ accountId: 'u1', category: 'search' }, () => new Promise<string>(resolve => { release = () => resolve('done') }))
  await flush()
  const queued = scheduler.run({ accountId: 'u2', category: 'search' }, async () => 'second')
  await flush()
  await clock.advance(60_000)
  assert.equal(scheduler.pendingCount, 1, '平台槽位仍被在途请求占用')
  release!()
  assert.equal(await inFlight, 'done')
  assert.equal(await queued, 'second')
})

test('save 失败时禁止派发且不自动重试', async () => {
  const { store, scheduler } = buildScheduler()
  let calls = 0
  store.failNextSave = true
  await assert.rejects(
    () => scheduler.run({ accountId: 'u1', category: 'search' }, async () => { calls += 1; return 'ok' }),
    error => (error as { code?: string }).code === 'INTERNAL',
  )
  assert.equal(calls, 0, '保存失败不得发生平台请求')
  assert.equal(store.saveCalls, 1, '保存失败不得自动重试')
  assert.equal(store.saves.length, 0)
  assert.equal(await scheduler.run({ accountId: 'u1', category: 'search' }, async () => 'retry'), 'retry')
})

test('load 失败后按失败关闭处理，不把未知历史当无历史', async () => {
  const { store, scheduler } = buildScheduler()
  store.failLoad = true
  let calls = 0
  await assert.rejects(
    () => scheduler.run({ accountId: 'u1', category: 'search' }, async () => { calls += 1; return 'ok' }),
    error => (error as { code?: string }).code === 'INTERNAL',
  )
  assert.equal(calls, 0, '快照不可用时不得派发')
  store.failLoad = false
  await assert.rejects(
    () => scheduler.run({ accountId: 'u1', category: 'search' }, async () => { calls += 1; return 'ok' }),
    error => (error as { code?: string }).code === 'INTERNAL',
  )
  assert.equal(calls, 0, '失败关闭后同账号请求仍不得放行')
  assert.equal(await scheduler.run({ accountId: 'u2', category: 'search' }, async () => 'other'), 'other', '其他账号不受影响')
})

test('损坏的调度快照按失败关闭处理', async () => {
  const { store, scheduler } = buildScheduler()
  store.snapshots.set('bad-time', { lastStartedAt: 'yesterday', categories: {} } as unknown as SchedulerSnapshot)
  store.snapshots.set('bad-category', { lastStartedAt: 1, categories: { nope: 1 } } as unknown as SchedulerSnapshot)
  store.snapshots.set('bad-pending', { lastStartedAt: 1, categories: {}, pending: { category: 'nope', reservedAt: 1 } } as unknown as SchedulerSnapshot)
  let calls = 0
  for (const accountId of ['bad-time', 'bad-category', 'bad-pending']) {
    await assert.rejects(
      () => scheduler.run({ accountId, category: 'search' }, async () => { calls += 1 }),
      error => (error as { code?: string }).code === 'INTERNAL',
    )
  }
  assert.equal(calls, 0)
})

test('旧快照缺少 pending 字段时按无预留守恒迁移', async () => {
  const clock = new FakeClock()
  const store = new FakeStore()
  store.snapshots.set('u1', { lastStartedAt: 0, categories: { search: 0 } } as unknown as SchedulerSnapshot)
  const { scheduler } = buildScheduler({ clock, store })
  const stamps: number[] = []
  const pending = scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  await flush()
  assert.deepEqual(stamps, [], '旧快照仍要延续间隔')
  await clock.advanceTo(1499)
  assert.deepEqual(stamps, [])
  await clock.advanceTo(1500)
  await pending
  assert.deepEqual(stamps, [1500])
})

test('恢复看到 pending 预留时按启动时刻等候完整间隔', async () => {
  const clock = new FakeClock()
  const store = new FakeStore()
  // 模拟上次派发在平台请求期间崩溃：持久化留下偏早时间与未清除的预留。
  store.snapshots.set('u1', {
    lastStartedAt: 0,
    categories: { search: 0 },
    pending: { category: 'search', reservedAt: 0 },
  } as unknown as SchedulerSnapshot)
  clock.time = 100_000
  const { scheduler } = buildScheduler({ clock, store })
  const stamps: number[] = []
  const pending = scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  await flush()
  assert.deepEqual(stamps, [], '恢复后不得按偏早记录放行')
  await clock.advanceTo(100_000 + 1500 - 1)
  assert.deepEqual(stamps, [])
  await clock.advanceTo(100_000 + 1500)
  await pending
  assert.deepEqual(stamps, [100_000 + 1500], '按启动时刻重新起算完整间隔')
})

test('派发先写 pending 预留，终结后才清除', async () => {
  const { store, scheduler } = buildScheduler()
  const seen: SchedulerSnapshot[] = []
  store.onSave = () => { seen.push(structuredClone(store.saves.at(-1)!.snapshot)) }
  await scheduler.run({ accountId: 'u1', category: 'light' }, async () => 'ok')
  assert.equal(seen.length, 2)
  assert.deepEqual(seen[0].pending, { category: 'light', reservedAt: 0 })
  assert.equal(seen[1].pending, null)
})

test('记账写期间 close 后不得发出平台请求', async () => {
  const { store, scheduler } = buildScheduler()
  let calls = 0
  store.onSave = () => scheduler.close()
  const pending = scheduler.run({ accountId: 'u1', category: 'search' }, async () => { calls += 1; return 'ok' })
  const rejection = assert.rejects(() => pending, error => (error as { code?: string }).code === 'EXTENSION_OFFLINE')
  await flush()
  await rejection
  assert.equal(calls, 0, 'close 后尚未发出的请求不得执行回调')
})

test('记账写期间 cancelAccount 后不得发出平台请求', async () => {
  const { store, scheduler } = buildScheduler()
  let calls = 0
  store.onSave = () => scheduler.cancelAccount('u1')
  const pending = scheduler.run({ accountId: 'u1', category: 'search' }, async () => { calls += 1; return 'ok' })
  const rejection = assert.rejects(() => pending, error => (error as { code?: string }).code === 'ACCOUNT_CHANGED')
  await flush()
  await rejection
  assert.equal(calls, 0, '取消账号后尚未发出的请求不得执行回调')
})

test('异步 save 违反同步契约时失败关闭，不执行回调', async () => {
  const store = new FakeStore()
  let calls = 0
  const scheduler = new Scheduler({
    now: () => 0,
    setTimer: () => 1,
    clearTimer: () => {},
    load: store.load,
    save: (async () => {}) as unknown as (accountId: string, snapshot: SchedulerSnapshot) => void,
  })
  const pending = scheduler.run({ accountId: 'u1', category: 'search' }, async () => { calls += 1; return 'ok' })
  await assert.rejects(() => pending, error => (error as { code?: string }).code === 'INTERNAL')
  await flush()
  assert.equal(calls, 0, '契约违约时不得发出平台请求')
})

test('记账写与回写都耗时时，记录值等于真实执行时刻', async () => {
  const { clock, store, scheduler } = buildScheduler()
  const stamps: number[] = []
  let writes = 0
  // 每次同步写入消耗 500ms，模拟两次写都耗时。
  store.onSave = () => { clock.time += 500; writes += 1 }
  await scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  assert.deepEqual(stamps, [500], 'execute 发生在记账写之后')
  assert.equal(store.snapshots.get('u1')?.lastStartedAt, 500, '记录值必须等于真实执行时刻')
  assert.equal(writes, 2, '记账写与回写各一次')
  store.onSave = null
  const next = scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  await flush()
  assert.deepEqual(stamps, [500], '下一项不得提前派发')
  await clock.advanceTo(1999)
  assert.deepEqual(stamps, [500])
  await clock.advanceTo(2000)
  await next
  assert.deepEqual(stamps, [500, 2000], '间隔按真实执行时刻 500+1500 起算')
})

test('记账写与回写都耗时后，重建仍按真实执行时刻延续间隔', async () => {
  const clock = new FakeClock()
  const store = new FakeStore()
  const first = buildScheduler({ clock, store })
  const stamps: number[] = []
  store.onSave = () => { clock.time += 500 }
  await first.scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  assert.equal(store.snapshots.get('u1')?.lastStartedAt, 500)
  first.scheduler.close()
  store.onSave = null
  const rebuilt = buildScheduler({ clock, store })
  const rebuiltStamps: number[] = []
  const pending = rebuilt.scheduler.run({ accountId: 'u1', category: 'search' }, async () => { rebuiltStamps.push(clock.time) })
  await flush()
  await clock.advanceTo(1999)
  assert.deepEqual(rebuiltStamps, [], '重建后不得按偏早时间提前派发')
  await clock.advanceTo(2000)
  await pending
  assert.deepEqual(rebuiltStamps, [2000])
})

test('定时器依赖抛错时明确失败所有排队项', async () => {
  const clock = new FakeClock()
  const store = new FakeStore()
  let calls = 0
  const scheduler = new Scheduler({
    now: clock.now,
    setTimer: () => { throw new Error('定时器不可用') },
    clearTimer: clock.clearTimer,
    load: store.load,
    save: store.save,
  })
  assert.equal(await scheduler.run({ accountId: 'u1', category: 'search' }, async () => { calls += 1; return 'first' }), 'first')
  assert.equal(calls, 1)
  const pending = scheduler.run({ accountId: 'u1', category: 'search' }, async () => { calls += 1; return 'second' })
  await assert.rejects(
    () => pending,
    error => (error as { code?: string }).code === 'INTERNAL' && /定时器不可用/.test((error as Error).message),
  )
  assert.equal(calls, 1, '依赖不可用时不得派发排队项')
})

test('重建调度器后按持久化快照延续间隔', async () => {
  const clock = new FakeClock()
  const store = new FakeStore()
  const first = buildScheduler({ clock, store })
  const stamps: number[] = []
  await first.scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  assert.equal(store.snapshots.get('u1')?.categories.search, 0)
  first.scheduler.close()
  const second = buildScheduler({ clock, store })
  const pending = second.scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  await flush()
  assert.deepEqual(stamps, [0], '恢复后不得立刻派发')
  await clock.advance(1499)
  assert.deepEqual(stamps, [0])
  await clock.advance(1)
  await pending
  assert.deepEqual(stamps, [0, 1500])
})

test('系统时钟回拨不缩短等待', async () => {
  const { clock, scheduler } = buildScheduler()
  const stamps: number[] = []
  await scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  await clock.advance(300)
  const pending = scheduler.run({ accountId: 'u1', category: 'search' }, async () => { stamps.push(clock.time) })
  await flush()
  assert.deepEqual(stamps, [0])
  await clock.jump(100)
  assert.deepEqual(stamps, [0], '回拨后仍不得提前派发')
  await clock.advanceTo(1500)
  await pending
  assert.deepEqual(stamps, [0, 1500])
})

test('长类别冷却不阻塞其他类别', async () => {
  const { clock, scheduler } = buildScheduler()
  const stamps: Array<{ accountId: string; at: number }> = []
  const track = (accountId: string) => async () => { stamps.push({ accountId, at: clock.time }) }
  await scheduler.run({ accountId: 'u1', category: 'publish' }, track('u1-publish-1'))
  const light = scheduler.run({ accountId: 'u1', category: 'light' }, track('u1-light'))
  // publish 强制间隔 300000ms，超过默认排队上限，这里显式放宽等待上限。
  const secondPublish = scheduler.run({ accountId: 'u1', category: 'publish', maxWaitMs: 600_000 }, track('u1-publish-2'))
  const done = Promise.all([light, secondPublish])
  await flush()
  assert.deepEqual(stamps, [{ accountId: 'u1-publish-1', at: 0 }])
  await clock.advanceTo(1000)
  assert.deepEqual(stamps, [{ accountId: 'u1-publish-1', at: 0 }, { accountId: 'u1-light', at: 1000 }])
  await clock.advanceTo(300_000)
  await done
  assert.deepEqual(stamps.at(-1), { accountId: 'u1-publish-2', at: 300_000 })
})

test('同刻就绪时按入队顺序派发', async () => {
  const { clock, scheduler } = buildScheduler()
  const order: string[] = []
  const track = (name: string) => async () => { order.push(name) }
  const tasks = [
    scheduler.run({ accountId: 'a', category: 'search' }, track('a1')),
    scheduler.run({ accountId: 'b', category: 'search' }, track('b1')),
    scheduler.run({ accountId: 'a', category: 'search' }, track('a2')),
  ]
  await flush()
  assert.deepEqual(order, ['a1', 'b1'], 'a2 受账号间隔约束，不得插队')
  assert.equal(clock.time, 0)
  await clock.advanceTo(1500)
  await Promise.all(tasks)
  assert.deepEqual(order, ['a1', 'b1', 'a2'])
})

test('参数非法一律返回 BAD_REQUEST 且不入队', async () => {
  const { scheduler } = buildScheduler()
  const badRequests: Array<() => Promise<unknown>> = [
    () => scheduler.run({ accountId: '', category: 'search' }, async () => 1),
    () => scheduler.run({ accountId: 'u1', category: 'unknown' as never }, async () => 1),
    () => scheduler.run({ accountId: 'u1', category: 'search', maxWaitMs: 0 }, async () => 1),
    () => scheduler.run({ accountId: 'u1', category: 'search', maxWaitMs: 600_001 }, async () => 1),
    () => scheduler.run({ accountId: 'u1', category: 'search', maxWaitMs: 1.5 }, async () => 1),
    () => scheduler.run({ accountId: 'u1', category: 'search', minIntervalMs: -1 }, async () => 1),
    () => scheduler.run({ accountId: 'u1', category: 'search', minIntervalMs: 600_001 }, async () => 1),
    () => scheduler.run({ accountId: 'u1', category: 'search', minIntervalMs: 1.5 }, async () => 1),
    () => scheduler.run({ accountId: 'u1', category: 'search' }, 'not-a-function' as never),
  ]
  for (const call of badRequests) {
    await assert.rejects(call, error => (error as { code?: string }).code === 'BAD_REQUEST')
  }
  assert.equal(scheduler.pendingCount, 0)
  assert.equal((await scheduler.run({ accountId: 'u1', category: 'light' }, async () => 'ok')), 'ok')
})

