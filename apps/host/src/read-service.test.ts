import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HostDatabase } from './database.ts'
import { createReadService } from './read-service.ts'

test('详情查询串联规范参数、缓存和单槽派发，缓存不占调度', async () => {
  const db = new HostDatabase(':memory:')
  let count = 0
  const service = createReadService({ db, accountId: () => 'a', now: () => 1000,
    schedule: async (_input, execute) => { count++; return execute() },
    execute: async (method, params) => ({ method, params }), validateResult: () => true,
  })
  try {
    const first = await service.call('item.detail', { itemId: ' 1 ' })
    const second = await service.call('item.detail', { itemId: '1', tag: 'another' })
    assert.deepEqual(first.data, { method: 'item.detail', params: { itemId: '1' } })
    assert.equal(first.cached, false); assert.equal(second.cached, true); assert.equal(count, 1)
    await service.call('item.detail', { itemId: '1', maxAgeSec: 0 })
    assert.equal(count, 2)
  } finally { db.close() }
})
test('排队后账号变化不执行，坏结果不缓存', async () => {
  const db = new HostDatabase(':memory:')
  let account = 'a', calls = 0
  const service = createReadService({ db, accountId: () => account, now: () => 1000,
    schedule: async (_input, execute) => { account = 'b'; return execute() }, execute: async () => { calls++; return {} }, validateResult: () => false,
  })
  try {
    await assert.rejects(service.call('item.detail', { itemId: '1' }), { code: 'ACCOUNT_CHANGED' })
    assert.equal(calls, 0)
    const invalid = createReadService({ db, accountId: () => 'a', now: () => 1000,
      schedule: async (_input, execute) => execute(), execute: async () => ({}), validateResult: () => false })
    await assert.rejects(invalid.call('item.detail', { itemId: '1' }), { code: 'INTERNAL' })
  } finally { db.close() }
})

test('失败不重试，执行后账号变化不保存，建议词不缓存', async () => {
  const db = new HostDatabase(':memory:')
  let account = 'a', calls = 0
  const service = createReadService({ db, accountId: () => account, now: () => 1000,
    schedule: async (_input, execute) => execute(), execute: async () => { calls++; account = 'b'; return {} }, validateResult: () => true })
  try {
    await assert.rejects(service.call('item.detail', { itemId: '1' }), { code: 'ACCOUNT_CHANGED' })
    assert.equal(calls, 1)
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM read_cache').get()?.n, 0)
    const suggest = createReadService({ db, accountId: () => 'a', now: () => 1000,
      schedule: async (_input, execute) => execute(), execute: async () => { calls++; return ['手机'] }, validateResult: () => true })
    await suggest.call('search.suggest', { keyword: '手机' }); await suggest.call('search.suggest', { keyword: '手机' })
    assert.equal(calls, 3)
    assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM read_cache').get()?.n, 0)
  } finally { db.close() }
})

test('内部单步参数只携带调用者显式业务字段，缺省值不伪装成用户输入', async () => {
  const db = new HostDatabase(':memory:')
  const calls: unknown[] = []
  const service = createReadService({ db, accountId: () => 'a', now: () => 1000,
    schedule: async (_input, execute) => execute(),
    execute: async (_method, params) => { calls.push(params); return { items: [], hasMore: null } },
    validateResult: () => true,
  })
  try {
    await service.call('search.items', { keyword: ' 手机 ', tag: 'job', maxWaitMs: 1 })
    assert.deepEqual(calls, [{ keyword: '手机' }])
  } finally { db.close() }
})

test('只读错误返回可诊断的恢复提示，并保持不可自动重试', async () => {
  const db = new HostDatabase(':memory:')
  const service = createReadService({
    db,
    accountId: () => null,
    now: () => 1000,
    schedule: async (_input, execute) => execute(),
    execute: async () => ({}),
  })
  try {
    await assert.rejects(service.call('search.suggest', { keyword: '手机' }), {
      code: 'LOGIN_REQUIRED',
      message: '账号未登录或登录已失效',
      retryable: false,
    })
  } finally {
    db.close()
  }
})

test('HTTP 断开在排队阶段以 CANCELLED 结束且不执行平台步骤', async () => {
  const db = new HostDatabase(':memory:')
  const controller = new AbortController()
  let calls = 0
  const service = createReadService({
    db,
    accountId: () => 'a',
    now: () => 1000,
    schedule: async (_input, execute, signal) => {
      controller.abort()
      assert.equal(signal, controller.signal)
      return execute()
    },
    execute: async () => { calls += 1; return { items: [], hasMore: null } },
    validateResult: () => true,
  })
  try {
    await assert.rejects(service.call('search.items', { keyword: '手机' }, controller.signal), {
      code: 'CANCELLED', phase: 'queue', retryable: false,
    })
    assert.equal(calls, 0)
  } finally { db.close() }
})
