import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Account, ExtensionStatus } from '../../../../packages/protocol/src/index.ts'
import { AccountTracker } from '../account.ts'
import { NativeBridge } from '../connection.ts'
import { createDispatcher, type MethodDispatcher } from '../dispatch.ts'
import { FakeEnv, settle, type FakeEnvOptions } from './fakes.ts'

/** 带构建身份的假环境：模拟生产 env（createChromeEnv）注入 define 值。 */
class BuildIdEnv extends FakeEnv {
  readonly buildId: string

  constructor(buildId: string, options: FakeEnvOptions = {}) {
    super(options)
    this.buildId = buildId
  }
}

function createBridge(env: FakeEnv, dispatch?: MethodDispatcher) {
  const account = new AccountTracker(env)
  const bridge = new NativeBridge({
    env,
    account,
    dispatch: dispatch ?? createDispatcher({ env, account }),
  })
  return { bridge, account }
}

describe('NativeBridge', () => {
  it('生产 env 的隔离注册名真正用于连接，显式 options 优先', async () => {
    class IsolatedEnv extends FakeEnv { readonly hostName = 'top.ggball.fishops.e2e' }
    const env = new IsolatedEnv()
    const { bridge } = createBridge(env)
    bridge.start()
    await settle()
    assert.deepEqual(env.hostNames, ['top.ggball.fishops.e2e'])
    bridge.stop()
    const account = new AccountTracker(env)
    const override = new NativeBridge({ env, account, dispatch: createDispatcher({ env, account }), hostName: 'top.ggball.fishops.override' })
    override.start()
    await settle()
    assert.equal(env.hostNames.at(-1), 'top.ggball.fishops.override')
    override.stop()
  })
  it('start 建立连接并先读 cookie 再发送 hello', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: '%E9%B1%BC' } })
    const { bridge } = createBridge(env)

    bridge.start()
    await settle()

    assert.deepEqual(env.hostNames, ['top.ggball.fishops'])
    const hello = env.ports[0]?.hello()
    assert.ok(hello)
    assert.deepEqual(hello, {
      kind: 'hello',
      protocolVersion: 1,
      extensionVersion: '0.2.0',
      account: { userId: 'u1', nick: '鱼' },
    })
    assert.equal(bridge.connected, true)
  })

  it('生产 env 提供构建身份时 hello 上报 extensionBuildId', async () => {
    const buildId = 'fa0dbb11-0c0d-46b9-b6c1-7e5de5113ee3'
    const env = new BuildIdEnv(buildId, { cookies: { unb: 'u1', tracknick: '鱼' } })
    const { bridge } = createBridge(env)

    bridge.start()
    await settle()

    assert.deepEqual(env.ports[0]?.hello(), {
      kind: 'hello',
      protocolVersion: 1,
      extensionVersion: '0.2.0',
      extensionBuildId: buildId,
      account: { userId: 'u1', nick: '鱼' },
    })
  })

  it('未构建环境省略构建身份，非法值也不冒充', async () => {
    // FakeEnv 默认没有 buildId，模拟未注入 define 的源码测试环境。
    const plainEnv = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' } })
    const plain = createBridge(plainEnv)
    plain.bridge.start()
    await settle()
    assert.equal('extensionBuildId' in (plainEnv.ports[0]?.hello() ?? {}), false)
    plain.bridge.stop()

    const invalidEnv = new BuildIdEnv('not-a-build-id', { cookies: { unb: 'u1', tracknick: 'A' } })
    const invalid = createBridge(invalidEnv)
    invalid.bridge.start()
    await settle()
    assert.equal('extensionBuildId' in (invalidEnv.ports[0]?.hello() ?? {}), false, '非法值不得写入 hello')
    invalid.bridge.stop()
  })

  it('cookie 读取异常：不发 hello、断开退避，且不推送假退出', async () => {
    const env = new FakeEnv({ failAllCookies: true })
    const { bridge } = createBridge(env)

    bridge.start()
    await settle()

    assert.equal(env.ports.length, 1)
    assert.deepEqual(env.ports[0]?.outbound, [], '读取失败不得外发 hello')
    assert.equal(env.ports[0]?.disconnected, true, '读取失败应立即断开')
    assert.equal(env.clock.pendingCount, 1, '断开后按退避重连')
    assert.equal(bridge.connected, false)

    env.clock.advance(1000)
    await settle()
    assert.equal(env.ports.length, 2, '退避 1s 后重连')
    assert.deepEqual(env.ports[0]?.events(), [], '不得把读取异常当作退出登录')
    assert.deepEqual(env.ports[1]?.outbound, [], '第二次仍读取失败，继续退避')
  })

  it('连续重连退避为 1/2/4/8/16/30/30 秒', async () => {
    const env = new FakeEnv({ failAllCookies: true })
    const { bridge } = createBridge(env)
    bridge.start()
    await settle()

    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000]
    for (const [index, delay] of delays.entries()) {
      assert.equal(env.ports.length, index + 1)
      env.clock.advance(delay - 1)
      await settle()
      assert.equal(env.ports.length, index + 1, `第 ${index + 1} 次退避未到期不应重连`)
      env.clock.advance(1)
      await settle()
      assert.equal(env.ports.length, index + 2, `第 ${index + 1} 次退避应为 ${delay}ms`)
    }
  })

  it('hello 成功后断开，退避从 1s 重新开始', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' } })
    const { bridge } = createBridge(env)
    bridge.start()
    await settle()
    assert.ok(env.ports[0]?.hello())

    env.ports[0]?.emitDisconnect({ message: 'host 退出' })
    await settle()
    env.clock.advance(1000)
    await settle()
    assert.equal(env.ports.length, 2)
    assert.ok(env.ports[1]?.hello(), '重连后重新发送 hello')

    env.ports[1]?.emitDisconnect()
    env.clock.advance(999)
    await settle()
    assert.equal(env.ports.length, 2)
    env.clock.advance(1)
    await settle()
    assert.equal(env.ports.length, 3)
  })

  it('旧握手的读取失败不影响新连接', async () => {
    const env = new FakeEnv({ deferredCookieReads: true })
    const { bridge } = createBridge(env)
    bridge.start()
    await settle()

    const stale = env.pendingReads.shift()
    assert.ok(stale)
    env.ports[0]?.emitDisconnect()
    env.clock.advance(1000)
    await settle()
    assert.equal(env.ports.length, 2)

    stale.reject(new Error('cookie 读取失败'))
    await settle()

    assert.equal(env.ports.length, 2, '旧握手失败不得丢弃新连接')
    assert.equal(env.ports[1]?.disconnected, false)
    assert.equal(bridge.epoch, 2, '连接代次随每次连接递增')
  })

  it('stop 后旧握手不回发 hello，并清理订阅与监听', async () => {
    const env = new FakeEnv({ deferredCookieReads: true })
    const { bridge } = createBridge(env)
    bridge.start()
    await settle()

    const pending = env.pendingReads.shift()
    assert.ok(pending)
    bridge.stop()
    pending.resolve({ value: 'u1' })
    await settle()

    assert.deepEqual(env.ports[0]?.outbound, [])
    assert.equal(env.clock.pendingCount, 0)
    assert.equal(env.activeChangeListeners, 0)
    assert.equal(env.ports[0]?.listenerCount, 0)
  })

  it('ensureConnected 不产生重复 Port', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' } })
    const { bridge } = createBridge(env)
    bridge.start()
    await settle()

    bridge.ensureConnected()
    bridge.ensureConnected()
    await settle()

    assert.equal(env.ports.length, 1)
  })

  it('req → res：system.status 成功，未知方法 NOT_FOUND 且连接保持', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' }, tabCount: 1 })
    const { bridge } = createBridge(env)
    bridge.start()
    await settle()

    const port = env.ports[0]
    assert.ok(port)
    port.emitMessage({ kind: 'req', id: 'r1', method: 'system.status', params: {} })
    port.emitMessage({ kind: 'req', id: 'r2', method: 'search.items', params: {} })
    await settle()

    // 并发响应按 id 匹配，不保证到达顺序：不能假设 r1 先返回。
    const responses = port.responses()
    assert.equal(responses.length, 2)
    const statusResponse = responses.find((response) => response.id === 'r1')
    const notFoundResponse = responses.find((response) => response.id === 'r2')
    assert.ok(statusResponse)
    assert.ok(notFoundResponse)

    assert.equal(statusResponse.ok, true)
    const data = statusResponse.data as ExtensionStatus
    assert.equal(data.extensionVersion, '0.2.0')
    assert.deepEqual(data.account, { userId: 'u1', nick: 'A' })
    assert.deepEqual(data.page, { present: true })
    assert.equal(data.chatReady, null)

    assert.equal(notFoundResponse.ok, false)
    assert.deepEqual(notFoundResponse.error, { code: 'NOT_FOUND', message: '未实现的方法：search.items' })
    assert.equal(port.disconnected, false)
  })

  it('hello 后账号变化推送 account.changed', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' } })
    const { bridge } = createBridge(env)
    bridge.start()
    await settle()

    env.setCookie('unb', 'u2')
    env.setCookie('tracknick', 'B')
    env.emitCookieChange('unb')
    env.clock.advance(300)
    await settle()

    const events = env.ports[0]?.events() ?? []
    assert.equal(events.length, 1)
    assert.equal(events[0]?.type, 'account.changed')
    assert.deepEqual(events[0]?.data, { account: { userId: 'u2', nick: 'B' } })
    assert.equal(env.ports.length, 1, '账号变化不重连')
  })

  it('system.status 先于 debounce 观测到新账号时，事件恰好推送一次', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' } })
    const { bridge } = createBridge(env)
    bridge.start()
    await settle()

    // 直接改 cookie 值但不通知订阅，模拟 status 抢先读到新账号。
    env.setCookie('unb', 'u2')
    env.setCookie('tracknick', 'B')
    const port = env.ports[0]
    assert.ok(port)
    port.emitMessage({ kind: 'req', id: 'r1', method: 'system.status', params: {} })
    await settle()

    assert.equal(port.events().length, 1, '成功观测到账号变化必须立即通知 host')
    const payload = port.events()[0]?.data as { account: Account }
    assert.deepEqual(payload.account, { userId: 'u2', nick: 'B' })

    env.emitCookieChange('unb')
    env.clock.advance(300)
    await settle()
    assert.equal(port.events().length, 1, 'debounce 刷新不得重复推送同一账号')
  })
})
