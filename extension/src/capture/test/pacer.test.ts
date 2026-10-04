/**
 * 采集搜索节流器单测：首页立即；其后在**处理结束后完整等待**基础间隔 + 随机增量，
 * 不扣除上一页处理耗时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCapturePacer } from '../pacer'
import { makeClock } from './fixtures'

test('pacer：首页立即，其后完整等待基础间隔 + 随机增量（不扣处理耗时）', async () => {
  const clock = makeClock()
  const pacer = createCapturePacer({
    baseMs: 500,
    jitterMs: 500,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5, // floor(0.5 * 501) = 250
  })

  await pacer.pace() // 首页：立即
  assert.deepEqual(clock.sleeps, [])

  clock.advance(3000) // 模拟上一页处理耗时 3s
  await pacer.pace()
  assert.deepEqual(clock.sleeps, [750]) // 完整等待 500 + 250，不扣 3000

  await pacer.pace()
  assert.deepEqual(clock.sleeps, [750, 750])
})

test('pacer：基础间隔为 0 且无随机增量时不再等待', async () => {
  const clock = makeClock()
  const pacer = createCapturePacer({
    baseMs: 0,
    jitterMs: 0,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0,
  })
  await pacer.pace()
  await pacer.pace()
  assert.deepEqual(clock.sleeps, [])
})
