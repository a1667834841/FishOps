import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStepExecutor } from '../step-executor.ts'
import type { StepWire } from '../../../../packages/protocol/src/step.ts'
import { ApiError } from '../errors.ts'

const request: Extract<StepWire, { kind: 'request-step' }> = { kind: 'request-step', id: 's1', requestId: 'r', method: 'item.detail', params: { itemId: '1' }, context: { accountId: 'a', tabId: 1, documentId: 'd' } }
test('重复步骤只执行一次，在途拒绝其他步骤，终结后不重放', async () => {
  let calls = 0
  let finish!: (value: unknown) => void
  const run = createStepExecutor({ context: async () => request.context, execute: async () => { calls++; return new Promise(resolve => { finish = resolve }) } })
  const first = run(request)
  await new Promise(resolve => setImmediate(resolve))
  const duplicate = run(request)
  const other = await run({ ...request, id: 's2' })
  assert.equal(other.ok, false)
  finish({ itemId: '1' })
  assert.deepEqual(await first, await duplicate)
  assert.deepEqual(await run(request), await first)
  assert.equal(calls, 1)
})
test('账号或文档变化不派发，执行后变化不返回旧数据', async () => {
  let calls = 0
  const run = createStepExecutor({ context: async () => ({ ...request.context, documentId: 'new' }), execute: async () => { calls++; return {} } })
  const res = await run(request)
  assert.equal(res.ok, false); assert.equal(calls, 0)
  let samples = 0
  const changed = createStepExecutor({ context: async () => ({ ...request.context, accountId: ++samples === 1 ? 'a' : 'b' }), execute: async () => ({ secret: 'old-account' }) })
  const result = await changed(request)
  assert.equal(result.ok, false)
  assert.ok(!JSON.stringify(result).includes('old-account'))
})

test('失败步骤也去重，原始异常脱敏，随后新步骤仍能执行', async () => {
  let calls = 0
  const run = createStepExecutor({ context: async () => request.context, execute: async () => { calls++; throw new Error('cookie=private-value') } })
  const failed = await run(request)
  assert.equal(failed.ok, false)
  assert.ok(!JSON.stringify(failed).includes('private-value'))
  assert.deepEqual(await run(request), failed)
  await run({ ...request, id: 'next' })
  assert.equal(calls, 2)
  const conflict = await run({ ...request, params: { itemId: '2' } })
  assert.equal(conflict.ok, false); assert.equal(calls, 2)
})

test('明确平台错误保留错误码，context异常不执行网络', async () => {
  const run = createStepExecutor({ context: async () => request.context, execute: async () => { throw new ApiError('RISK_BLOCKED', '平台要求验证', { phase: 'read', retryable: false }) } })
  const result = await run(request)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'RISK_BLOCKED')
  let calls = 0
  const invalid = createStepExecutor({ context: async () => { throw new Error('private') }, execute: async () => { calls++; return {} } })
  assert.equal((await invalid(request)).ok, false)
  assert.equal(calls, 0)
})

test('连接内旧成功结果重放前也核验账号，不返回旧账号data', async () => {
  let accountId = 'a'
  const run = createStepExecutor({ context: async () => ({ ...request.context, accountId }), execute: async () => ({ privateData: 'old' }) })
  assert.equal((await run(request)).ok, true)
  accountId = 'b'
  const replay = await run(request)
  assert.equal(replay.ok, false)
  assert.ok(!JSON.stringify(replay).includes('privateData'))
})
