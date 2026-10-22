/**
 * 只读生命周期观察器的离线单测。
 *
 * 用可注入 probe 与虚拟时间覆盖：正常、未离线、未恢复、历史丢失、账号变化、
 * baseline 无事件、baseline 超时，以及「401 / 403 / 非法 JSON / 结构非法不算离线」。
 * 另用注入 fetch 验证 HTTP probe 的离线判定与 loopback 固定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOOPBACK_HOST,
  createHttpProbe,
  observeLifecycle,
  resolveLoopbackBaseUrl,
  shouldRunLive,
} from './lifecycle-observer.mjs'

/** 虚拟时钟：sleep 推进时间，使阶段超时可控且不真实等待。 */
function makeClock() {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms) => {
      time += Math.max(0, ms)
    },
  }
}

/** 按脚本返回采样，样本耗尽后重复最后一项（模拟持续同一状态）。 */
function scriptedProbe(samples) {
  let index = 0
  return async () => {
    const sample = samples[Math.min(index, samples.length - 1)]
    index += 1
    return sample
  }
}

const online = (seqs, accountId = 'acct-a') => ({ kind: 'online', accountId, seqs })
const offline = { kind: 'offline', reason: 'connection-refused' }
const failed = (reason) => ({ kind: 'error', reason })

function observe(probe) {
  const clock = makeClock()
  return observeLifecycle({ probe, now: clock.now, sleep: clock.sleep, phaseTimeoutMs: 3000, pollIntervalMs: 1000 })
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('正常：在线 → 连接拒绝 → 恢复且历史与账号校验通过', async () => {
  const report = await observe(scriptedProbe([online(['1', '2']), offline, online(['1', '2', '3'])]))
  assert.equal(report.status, 'passed')
  assert.equal(report.reason, 'lifecycle-verified')
  assert.equal(report.historyVerified, true)
  assert.equal(report.accountStable, true)
  assert.equal(report.baselineEventCount, 2)
  assert.equal(report.missingEventCount, 0)
  assert.deepEqual(report.phases.map((phase) => phase.phase), ['baseline', 'offline', 'recovery'])
  assert.equal(JSON.stringify(report).includes('acct-a'), false, '报告不得记录账号值')
})

test('未离线：一直在线不能通过，明确报 never-offline', async () => {
  const report = await observe(scriptedProbe([online(['1'])]))
  assert.equal(report.status, 'failed')
  assert.equal(report.reason, 'never-offline')
  const phase = report.phases.find((entry) => entry.phase === 'offline')
  assert.equal(phase.outcome, 'timeout')
  assert.equal(phase.lastObserved, 'online')
})

test('未恢复：离线后一直离线，明确报 recovery-timeout', async () => {
  const report = await observe(scriptedProbe([online(['1']), offline]))
  assert.equal(report.status, 'failed')
  assert.equal(report.reason, 'recovery-timeout')
  assert.equal(report.phases.find((entry) => entry.phase === 'recovery').outcome, 'timeout')
})

test('历史丢失：恢复缺少 baseline seq，不得通过', async () => {
  const report = await observe(scriptedProbe([online(['10', '11']), offline, online(['12'])]))
  assert.equal(report.status, 'failed')
  assert.equal(report.reason, 'history-lost')
  assert.equal(report.missingEventCount, 2)
  assert.equal(report.baselineEventCount, 2)
})

test('账号变化：恢复账号不同，不得通过且报告不含账号值', async () => {
  const report = await observe(
    scriptedProbe([online(['1'], 'acct-a'), offline, online(['1'], 'acct-b')]),
  )
  assert.equal(report.status, 'failed')
  assert.equal(report.reason, 'account-changed')
  assert.equal(report.accountStable, false)
  const text = JSON.stringify(report)
  assert.equal(text.includes('acct-a') || text.includes('acct-b'), false, '报告不得记录账号值')
})

test('baseline 无真实事件：blocked，不能空集通过', async () => {
  const report = await observe(scriptedProbe([online([])]))
  assert.equal(report.status, 'blocked')
  assert.equal(report.reason, 'no-baseline-events')
  assert.equal(report.phases.find((entry) => entry.phase === 'baseline').eventCount, 0)
})

test('baseline 结构非法：超时失败并给出分类，不泄露原始文本', async () => {
  const report = await observe(scriptedProbe([failed('invalid-status')]))
  assert.equal(report.status, 'failed')
  assert.equal(report.reason, 'baseline-timeout')
  assert.equal(report.phases.find((entry) => entry.phase === 'baseline').lastObserved, 'error:invalid-status')
})

test('401 错误不能被当作离线', async () => {
  const report = await observe(scriptedProbe([online(['1']), failed('unauthorized')]))
  assert.equal(report.status, 'failed')
  assert.equal(report.reason, 'never-offline')
  assert.equal(report.phases.find((entry) => entry.phase === 'offline').lastObserved, 'error:unauthorized')
})

test('HTTP probe：仅连接拒绝算离线', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
  })
  const probe = createHttpProbe({
    baseUrl: `http://${LOOPBACK_HOST}:1234`,
    token: 'never-logged-token',
    fetchImpl: async () => {
      throw refused
    },
  })
  assert.deepEqual(await probe(), { kind: 'offline', reason: 'connection-refused' })
})

test('HTTP probe：连接重置与时序错误不算离线', async () => {
  const reset = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
  })
  const probe = createHttpProbe({
    baseUrl: `http://${LOOPBACK_HOST}:1234`,
    token: 'never-logged-token',
    fetchImpl: async () => {
      throw reset
    },
  })
  assert.deepEqual(await probe(), { kind: 'error', reason: 'network-error' })
})

test('HTTP probe：401 / 403 / 非法 JSON / 结构非法均归为错误而非离线', async () => {
  const cases = [
    { response: () => jsonResponse(401, { ok: false, error: { code: 'UNAUTHORIZED' } }), reason: 'unauthorized' },
    { response: () => jsonResponse(403, { ok: false, error: { code: 'ORIGIN_FORBIDDEN' } }), reason: 'forbidden' },
    { response: () => new Response('not json', { status: 200 }), reason: 'invalid-json' },
    { response: () => jsonResponse(200, { ok: true, data: {} }), reason: 'invalid-status' },
    { response: () => jsonResponse(200, { ok: false, error: { code: 'EXTENSION_OFFLINE' } }), reason: 'extension-offline' },
  ]
  for (const item of cases) {
    const probe = createHttpProbe({
      baseUrl: `http://${LOOPBACK_HOST}:1234`,
      token: 'never-logged-token',
      fetchImpl: async () => item.response(),
    })
    assert.deepEqual(await probe(), { kind: 'error', reason: item.reason })
  }
})

test('HTTP probe：合法响应返回账号与 seq，且只访问 127.0.0.1', async () => {
  const calls = []
  const probe = createHttpProbe({
    baseUrl: `http://${LOOPBACK_HOST}:1234`,
    token: 'never-logged-token',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url.includes('system.status')) {
        return jsonResponse(200, {
          ok: true,
          data: { nativeConnected: true, page: { present: true }, chatReady: null, account: { userId: 'u1', nick: 'n' } },
        })
      }
      return jsonResponse(200, { ok: true, data: { items: [{ seq: '7' }], hasMore: false, nextAfterSeq: '7' } })
    },
  })
  const sample = await probe()
  assert.equal(sample.kind, 'online')
  assert.equal(sample.accountId, 'u1')
  assert.deepEqual(sample.seqs, ['7'])
  assert.ok(calls.length >= 2)
  assert.ok(calls.every((call) => call.url.startsWith(`http://${LOOPBACK_HOST}:1234/v1/`)))
  assert.ok(calls.every((call) => call.init.headers.authorization === 'Bearer never-logged-token'))
})

test('HTTP probe：未登录状态 account 为 null 时合法', async () => {
  const probe = createHttpProbe({
    baseUrl: `http://${LOOPBACK_HOST}:1234`,
    token: 'never-logged-token',
    fetchImpl: async (url) =>
      url.includes('system.status')
        ? jsonResponse(200, { ok: true, data: { nativeConnected: true, page: { present: false }, chatReady: null, account: null } })
        : jsonResponse(200, { ok: true, data: { items: [], hasMore: false, nextAfterSeq: '0' } }),
  })
  assert.deepEqual(await probe(), { kind: 'online', accountId: null, seqs: [] })
})

test('resolveLoopbackBaseUrl：拒绝非法 port 且固定 127.0.0.1', () => {
  assert.equal(resolveLoopbackBaseUrl({ port: 18790 }).baseUrl, `http://${LOOPBACK_HOST}:18790`)
  // 配置里带 host 字段也不改变目标地址。
  assert.equal(resolveLoopbackBaseUrl({ port: 8080, host: '0.0.0.0' }).baseUrl, `http://${LOOPBACK_HOST}:8080`)
  for (const config of [{ port: 0 }, { port: 1.5 }, { port: 70000 }, { port: '18790' }, null, {}]) {
    assert.equal(resolveLoopbackBaseUrl(config).error, 'invalid-port', JSON.stringify(config))
  }
})

test('shouldRunLive：只有显式 FISHOPS_LIVE_SMOKE=1 才启用', () => {
  assert.equal(shouldRunLive({ FISHOPS_LIVE_SMOKE: '1' }), true)
  assert.equal(shouldRunLive({ FISHOPS_LIVE_SMOKE: '0' }), false)
  assert.equal(shouldRunLive({}), false)
})
