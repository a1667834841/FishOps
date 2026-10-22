import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPlatformExecutor } from '../platform-executor.ts'
import type { StepWire } from '../../../../packages/protocol/src/step.ts'

const request: Extract<StepWire, { kind: 'request-step' }> = { kind: 'request-step', id: 's', requestId: 'r', method: 'item.detail', params: { itemId: '1' }, context: { accountId: 'a', tabId: 1, documentId: 'd' } }
test('组合执行按核验、部署、核验、调用顺序，重复步骤不再次部署', async () => {
  const order: string[] = []
  const run = createPlatformExecutor({
    context: { bind: async () => request.context, verify: async c => { order.push('verify'); return c } },
    bootstrap: { prepare: async () => { order.push('prepare') } },
    client: { execute: async r => { order.push('execute'); return { kind: 'step-result', id: r.id, terminal: true, ok: true, data: { itemId: '1' } } } },
  })
  assert.equal((await run(request)).ok, true)
  assert.equal((await run(request)).ok, true)
  assert.deepEqual(order, ['verify', 'prepare', 'verify', 'execute'])
})
test('部署失败不调用页面请求，平台错误不转换成成功', async () => {
  let calls = 0
  const run = createPlatformExecutor({ context: { bind: async () => request.context, verify: async c => c },
    bootstrap: { prepare: async () => { throw new Error('private') } },
    client: { execute: async () => { calls++; throw new Error('unexpected') } },
  })
  const result = await run(request)
  assert.equal(result.ok, false); assert.equal(calls, 0)
  assert.ok(!JSON.stringify(result).includes('private'))
})

test('RISK_BLOCKED 直接失败且不重放原步骤', async () => {
  let calls = 0
  const run = createPlatformExecutor({
    context: { bind: async () => request.context, verify: async c => c },
    bootstrap: { prepare: async () => {} },
    client: { execute: async r => { calls++; return { kind: 'step-result', id: r.id, terminal: true, ok: false,
      error: { kind: 'res', id: r.id, ok: false, code: 'RISK_BLOCKED', message: 'x', phase: 'read', retryable: false } } } },
  })
  const result = await run(request)
  assert.equal(result.ok, false)
  assert.equal(calls, 1)
})
