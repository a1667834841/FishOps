import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_MIN_INTERVAL_MS, createRateLimiter } from '../rate-limit'

/** 可确定控制的时钟与 sleep。 */
function makeClock() {
  let time = 0
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => time,
    sleep: async (ms: number) => {
      sleeps.push(ms)
      time += ms
    },
  }
}

test('默认最小间隔为 1500ms', () => {
  assert.equal(DEFAULT_MIN_INTERVAL_MS, 1500)
  assert.equal(createRateLimiter().minIntervalMs, 1500)
})

test('首次放行不等待，后续请求按最小间隔等待', async () => {
  const clock = makeClock()
  const limiter = createRateLimiter({ minIntervalMs: 1500, now: clock.now, sleep: clock.sleep })

  await limiter.acquire()
  assert.deepEqual(clock.sleeps, [])

  await limiter.acquire()
  await limiter.acquire()
  assert.deepEqual(clock.sleeps, [1500, 1500])
})

test('并发 acquire 被串行化，不会并发穿透', async () => {
  const clock = makeClock()
  const order: number[] = []
  const limiter = createRateLimiter({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep })

  await Promise.all(
    [0, 1, 2].map(async (index) => {
      await limiter.acquire()
      order.push(index)
    }),
  )

  assert.deepEqual(order, [0, 1, 2])
  assert.deepEqual(clock.sleeps, [1000, 1000])
})

test('已在间隔内的请求只等待剩余时间', async () => {
  let time = 0
  const sleeps: number[] = []
  const limiter = createRateLimiter({
    minIntervalMs: 1000,
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms)
      time += ms
    },
  })

  await limiter.acquire() // t=0
  time = 400 // 模拟中间经过了 400ms
  await limiter.acquire()
  assert.deepEqual(sleeps, [600])
})

test('默认 sleep 真实等待（用极小间隔快速验证）', async () => {
  const limiter = createRateLimiter({ minIntervalMs: 5 })
  await limiter.acquire()
  const start = Date.now()
  await limiter.acquire()
  assert.ok(Date.now() - start >= 4, '应至少等待约 5ms')
})

test('随机增量：实际间隔 = 最小间隔 + [0, jitterMs]', async () => {
  const clock = makeClock()
  const limiter = createRateLimiter({
    minIntervalMs: 500,
    jitterMs: 500,
    random: () => 0.5, // floor(0.5 * 501) = 250
    now: clock.now,
    sleep: clock.sleep,
  })
  await limiter.acquire()
  await limiter.acquire()
  assert.deepEqual(clock.sleeps, [750])
})

test('随机增量：random=0 时退化为固定最小间隔', async () => {
  const clock = makeClock()
  const limiter = createRateLimiter({
    minIntervalMs: 1500,
    jitterMs: 500,
    random: () => 0,
    now: clock.now,
    sleep: clock.sleep,
  })
  await limiter.acquire()
  await limiter.acquire()
  assert.deepEqual(clock.sleeps, [1500])
})
