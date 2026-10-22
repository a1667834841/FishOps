import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPageLock, installPageLock } from '../page-lock.ts'

test('文档锁保留旧请求，重建客户端不能重复执行或清锁', async () => {
  const lock = createPageLock('document-a')
  let finish!: (value: unknown) => void
  let calls = 0
  const original = lock.run('s1', 'fingerprint', async () => { calls++; return new Promise(resolve => { finish = resolve }) })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(lock.status(), { documentId: 'document-a', activeStepId: 's1', completed: 0 })
  await assert.rejects(lock.run('s2', 'other', async () => { calls++; return {} }), /执行/)
  const duplicate = lock.run('s1', 'fingerprint', async () => { calls++; return {} })
  finish({ ok: true })
  assert.deepEqual(await original, await duplicate)
  assert.deepEqual(await lock.run('s1', 'fingerprint', async () => { calls++; return {} }), { ok: true })
  assert.equal(calls, 1)
  assert.equal(lock.status().activeStepId, null)
})

test('失败也保留去重，异参冲突拒绝，容量满不淘汰已执行步骤', async () => {
  const lock = createPageLock('d', 1)
  await assert.rejects(lock.run('s', 'f', async () => { throw new Error('failed') }), /failed/)
  await assert.rejects(lock.run('s', 'f', async () => ({})), /failed/)
  await assert.rejects(lock.run('s', 'other', async () => ({})), /参数/)
  await assert.rejects(lock.run('new', 'f', async () => ({})), /容量/)
  assert.equal(lock.status().completed, 1)
})

test('重新注入复用原锁，不能通过新文档标识覆盖旧请求', async () => {
  const scope = {}
  const lock = installPageLock(scope, 'd')
  let finish!: () => void
  const request = lock.run('s', 'f', async () => new Promise<void>(resolve => { finish = resolve }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(installPageLock(scope, 'd'), lock)
  assert.throws(() => installPageLock(scope, 'new'), /代次/)
  assert.equal(installPageLock(scope, 'd').status().activeStepId, 's')
  finish(); await request
})
