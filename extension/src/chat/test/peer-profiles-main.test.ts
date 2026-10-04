/**
 * peer-profiles-main.ts 单元测试（纯 Node，mock 页面全局 lib.mtop）。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { PEER_PROFILE_API_MAP, fetchPeerProfileInPage, isPeerProfilePageResult } from '../peer-profiles-main'

type Lib = { mtop?: { request?: (options: unknown) => Promise<unknown> } }

afterEach(() => {
  delete (globalThis as { lib?: Lib }).lib
})

test('fetchPeerProfileInPage：SDK 缺失返回 SDK_MISSING', async () => {
  const result = await fetchPeerProfileInPage({ api: 'session.sync', data: {} })
  assert.deepEqual(result, { ok: false, code: 'SDK_MISSING' })
})

test('fetchPeerProfileInPage：未知接口返回 UNKNOWN_API', async () => {
  ;(globalThis as { lib?: Lib }).lib = { mtop: { request: async () => ({}) } }
  const result = await fetchPeerProfileInPage({ api: 'nope' as never, data: {} })
  assert.deepEqual(result, { ok: false, code: 'UNKNOWN_API' })
})

test('fetchPeerProfileInPage：保留 mtop.request 的 this 绑定（生产页面序列化调用约定）', async () => {
  const mtop = {
    marker: 'bound',
    request(this: { marker?: string }, _options: unknown) {
      if (this.marker !== 'bound') throw new Error('MTOP_CONTEXT_LOST')
      return Promise.resolve({ ret: ['SUCCESS::调用成功'], data: { sessions: [] } })
    },
  }
  ;(globalThis as { lib?: Lib }).lib = { mtop }
  const serialized = eval(`(${fetchPeerProfileInPage.toString()})`) as typeof fetchPeerProfileInPage
  const result = await serialized({ api: 'session.sync', data: { sessionTypes: [3], fetchNum: 30 } })
  assert.equal(result.ok, true)
})

test('fetchPeerProfileInPage：成功透传 payload，且参数固定为官方 SDK 约定', async () => {
  let captured: Record<string, unknown> | null = null
  ;(globalThis as { lib?: Lib }).lib = {
    mtop: {
      request: async (options) => {
        captured = options as Record<string, unknown>
        return { ret: ['SUCCESS::调用成功'], data: { userInfo: { logo: 'https://img.alicdn.com/x.jpg' } } }
      },
    },
  }
  const result = await fetchPeerProfileInPage({ api: 'user.query', data: { type: 0, userId: 'p', sessionId: '1' } })
  assert.equal(result.ok, true)
  assert.equal(captured?.['api'], 'mtop.taobao.idlemessage.user.query')
  assert.equal(captured?.['v'], '1.0')
  assert.equal(captured?.['appKey'], '34839810')
  assert.equal(captured?.['accountSite'], 'xianyu')
  assert.equal(captured?.['needLogin'], true)
  assert.equal(captured?.['type'], 'POST')
})

test('fetchPeerProfileInPage：请求超时返回 TIMEOUT', async () => {
  ;(globalThis as { lib?: Lib }).lib = { mtop: { request: () => new Promise(() => {}) } }
  const result = await fetchPeerProfileInPage({ api: 'session.sync', data: {} })
  assert.deepEqual(result, { ok: false, code: 'TIMEOUT' })
})

test('fetchPeerProfileInPage：SDK reject 返回 MTOP_REJECTED（不透传原文）', async () => {
  ;(globalThis as { lib?: Lib }).lib = {
    mtop: {
      request: async () => {
        throw { ret: ['FAIL_SYS_ILLEGAL_ACCESS'], message: 'boom' }
      },
    },
  }
  const result = await fetchPeerProfileInPage({ api: 'session.sync', data: {} })
  assert.deepEqual(result, { ok: false, code: 'MTOP_REJECTED' })
})

test('PEER_PROFILE_API_MAP / isPeerProfilePageResult：契约稳定', () => {
  assert.equal(PEER_PROFILE_API_MAP['session.sync'].api, 'mtop.taobao.idlemessage.pc.session.sync')
  assert.equal(PEER_PROFILE_API_MAP['session.sync'].v, '3.0')
  assert.equal(PEER_PROFILE_API_MAP['user.query'].api, 'mtop.taobao.idlemessage.user.query')
  assert.equal(PEER_PROFILE_API_MAP['user.query'].v, '1.0')
  assert.equal(isPeerProfilePageResult({ ok: true, payload: {} }), true)
  assert.equal(isPeerProfilePageResult({ ok: false, code: 'SDK_MISSING' }), true)
  assert.equal(isPeerProfilePageResult({}), false)
  assert.equal(isPeerProfilePageResult(null), false)
})
