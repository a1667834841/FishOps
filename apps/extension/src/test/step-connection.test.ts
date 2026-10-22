import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NativeBridge } from '../connection.ts'
import { AccountTracker } from '../account.ts'
import { FakeEnv, settle } from './fakes.ts'

const step = { kind: 'request-step', id: 's', requestId: 'r', method: 'item.detail', params: { itemId: '1' }, context: { accountId: 'a', tabId: 1, documentId: 'd' } }
test('单步帧调用独立执行器，直到真实终结才回传', async () => {
  const env = new FakeEnv({ cookies: { unb: 'a' } })
  let finish!: (data: unknown) => void
  let calls = 0
  const bridge = new NativeBridge({ env, account: new AccountTracker(env), dispatch: async () => ({}),
    createStepHandler: () => async (request) => { calls++; const data = await new Promise(resolve => { finish = resolve }); return { kind: 'step-result', id: request.id, terminal: true, ok: true, data } },
  })
  bridge.start(); await settle()
  env.ports[0]!.emitMessage(step); await settle()
  assert.equal(calls, 1)
  assert.equal(env.ports[0]!.outbound.length, 1)
  finish({ itemId: '1' }); await settle()
  assert.deepEqual(env.ports[0]!.outbound.at(-1), { kind: 'step-result', id: 's', terminal: true, ok: true, data: { itemId: '1' } })
  bridge.stop()
})

test('未配置单步执行器时明确拒绝，不断开M1连接', async () => {
  const env = new FakeEnv({ cookies: { unb: 'a' } })
  const bridge = new NativeBridge({ env, account: new AccountTracker(env), dispatch: async () => ({}) })
  bridge.start(); await settle(); env.ports[0]!.emitMessage(step); await settle()
  const result = env.ports[0]!.outbound.at(-1) as any
  assert.equal(result.kind, 'step-result'); assert.equal(result.error.code, 'NOT_FOUND')
  assert.equal(bridge.connected, true)
  bridge.stop()
})

test('连接替换后旧步骤不能回发，新连接重建执行器', async () => {
  const env = new FakeEnv({ cookies: { unb: 'a' } })
  let finish!: () => void
  let factories = 0
  const bridge = new NativeBridge({ env, account: new AccountTracker(env), dispatch: async () => ({}), createStepHandler: () => {
    factories++
    return async request => { await new Promise<void>(resolve => { finish = resolve }); return { kind: 'step-result', id: request.id, terminal: true, ok: true, data: {} } }
  } })
  bridge.start(); await settle(); const old = env.ports[0]!
  old.emitMessage(step); await settle(); old.emitDisconnect(); bridge.ensureConnected(); await settle()
  finish(); await settle()
  assert.equal(factories, 2)
  assert.equal(old.outbound.length, 1)
  assert.equal(env.ports[1]!.outbound.length, 1)
  assert.equal(old.listenerCount, 0)
  bridge.stop()
})
