import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Account } from '../../../../packages/protocol/src/index.ts'
import { AccountReadError, AccountTracker } from '../account.ts'
import { ApiError } from '../errors.ts'
import { systemStatus } from '../modules/system.ts'
import { FakeEnv, settle } from './fakes.ts'

/** 逐条应答挂起的 cookie 读取，用来驱动“读取期间账号切换”的场景。 */
async function drainReads(env: FakeEnv, values: string[]): Promise<void> {
  for (const value of values) {
    await settle(1)
    const pending = env.pendingReads.shift()
    assert.ok(pending, '期望存在挂起的 cookie 读取')
    pending.resolve({ value })
  }
}

describe('AccountTracker', () => {
  it('读取 unb 与百分号编码的 tracknick', async () => {
    const env = new FakeEnv({ cookies: { unb: '2200759506015', tracknick: '%E5%B0%8F%E9%B1%BC' } })
    const tracker = new AccountTracker(env)

    assert.deepEqual(await tracker.read(), { userId: '2200759506015', nick: '小鱼' })
    assert.deepEqual(tracker.current, { userId: '2200759506015', nick: '小鱼' })
  })

  it('未登录返回 null，而不是报错', async () => {
    const env = new FakeEnv({ cookies: { unb: null, tracknick: null } })
    const tracker = new AccountTracker(env)

    assert.equal(await tracker.read(), null)
  })

  it('tracknick 解码失败时保留原值，不判定为退出登录', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: '%E0%A4%A' } })
    const tracker = new AccountTracker(env)

    assert.deepEqual(await tracker.read(), { userId: 'u1', nick: '%E0%A4%A' })
  })

  it('cookie API 异常时抛出 INTERNAL 常量消息，不伪装成退出登录', async () => {
    const env = new FakeEnv({ cookieErrors: ['unb'] })
    const tracker = new AccountTracker(env)

    await assert.rejects(
      () => systemStatus({ env, account: tracker }, {}),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.code, 'INTERNAL')
        assert.equal(error.message, '账号读取失败')
        assert.equal(error.retryable, true)
        return true
      },
    )
    assert.equal(tracker.current, null, '读取失败不得写入观测值')
  })

  it('cookie API 永不应答时有界失败，握手不能永久挂起', async () => {
    const env = new FakeEnv({ deferredCookieReads: true })
    const tracker = new AccountTracker(env, { cookieTimeoutMs: 2000 })
    const reading = tracker.read()
    const assertion = assert.rejects(reading, AccountReadError)

    await settle(1)
    assert.equal(env.pendingReads.length, 1, '读取应先进入挂起状态')
    env.clock.advance(2000)
    await assertion
    assert.equal(env.clock.pendingCount, 0, '超时后必须清理计时器')
  })

  it('nick 读取期间账号切换时重读，不拼接新旧账号', async () => {
    const env = new FakeEnv({ deferredCookieReads: true })
    const tracker = new AccountTracker(env)
    const reading = tracker.read()

    // 第一轮 unb → nick → unb 首尾不一致（读取窗口内切换账号），必须重读。
    await drainReads(env, ['u-old', '%E6%97%A7', 'u-new'])
    await drainReads(env, ['u-new', '%E5%B0%8F%E9%B1%BC', 'u-new'])

    assert.deepEqual(await reading, { userId: 'u-new', nick: '小鱼' })
  })

  it('unb 持续变化时有界失败', async () => {
    const env = new FakeEnv({ deferredCookieReads: true })
    const tracker = new AccountTracker(env)
    const reading = tracker.read()
    const assertion = assert.rejects(reading, AccountReadError)

    for (let round = 0; round < 3; round += 1) await drainReads(env, ['u-a', 'nickA', 'u-b'])

    await assertion
  })

  it('cookie 变化合并为一次读取（300ms）', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' } })
    const tracker = new AccountTracker(env)
    tracker.observe()

    env.emitCookieChange('unb')
    env.emitCookieChange('tracknick')
    env.emitCookieChange('unb')
    env.clock.advance(299)
    await settle()
    assert.deepEqual(env.cookieReads, [], '未到期不应读取')

    env.clock.advance(1)
    await settle()
    assert.deepEqual(env.cookieReads, ['unb', 'tracknick', 'unb'], '合并后只读一次快照')
  })

  it('已上报基线不同时，任何成功观测变化都会通知', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: '%E6%97%A7' } })
    const tracker = new AccountTracker(env)
    const notices: Account[] = []
    tracker.onChange((account) => notices.push(account))
    tracker.markReported({ userId: 'u1', nick: '旧' })
    tracker.observe()
    await tracker.read()

    env.setCookie('tracknick', '%E6%96%B0')
    env.emitCookieChange('tracknick')
    env.clock.advance(300)
    await settle()

    assert.deepEqual(notices, [{ userId: 'u1', nick: '新' }])
    assert.deepEqual(tracker.reported, { userId: 'u1', nick: '新' })
  })

  it('尚未 hello 时只更新观测值，不重复推送事件', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' } })
    const tracker = new AccountTracker(env)
    const notices: Account[] = []
    tracker.onChange((account) => notices.push(account))
    tracker.observe()
    await tracker.read()

    env.setCookie('unb', 'u2')
    env.emitCookieChange('unb')
    env.clock.advance(300)
    await settle()

    assert.deepEqual(notices, [])
    assert.deepEqual(tracker.current, { userId: 'u2', nick: 'A' })
  })
})
