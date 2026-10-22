import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPageClient, type PageScripting } from '../page-client.ts'
import type { StepWire } from '../../../../packages/protocol/src/step.ts'
import type { StepContext } from '../../../../packages/protocol/src/step.ts'

type Request = Extract<StepWire, { kind: 'request-step' }>
type Result = Extract<StepWire, { kind: 'step-result' }>
const request = (id: string, context = { accountId: 'a', tabId: 7, documentId: 'doc' }): Request => ({
  kind: 'request-step', id, requestId: `request-${id}`, method: 'item.detail', params: { itemId: '123' }, context,
})
const terminal = (id: string): Result => ({ kind: 'step-result', id, terminal: true, ok: true, data: { itemId: '123' } })

function fixture(options: { runtime?: boolean; status?: unknown; execute?: (request: Request) => unknown; verify?: () => Promise<StepContext> } = {}) {
  const calls: Array<{ func: (...args: unknown[]) => unknown; args?: unknown[]; target: unknown; world: string }> = []
  const context = {
    bind: async () => ({ accountId: 'a', tabId: 7, documentId: 'doc' }),
    verify: options.verify ?? (async () => ({ accountId: 'a', tabId: 7, documentId: 'doc' } as StepContext)),
  }
  const scripting: PageScripting = {
    executeScript: async details => {
      calls.push(details)
      const fn = details.func.toString()
      assert.ok(!fn.includes('createPageClient'), '注入函数不得依赖模块闭包')
      if (options.runtime === false) return [{ documentId: 'doc', result: undefined }]
      const action = details.args?.[0] as { op: string; request?: Request }
      const result = action.op === 'status' ? (options.status ?? { documentId: 'doc', activeStepId: null, completed: 0 })
        : options.execute ? options.execute(action.request!) : terminal(action.request!.id)
      const settled = await result
      return [{ documentId: 'doc', result: settled }]
    },
  }
  return { client: createPageClient({ scripting, context }), calls }
}

test('绑定固定上下文后在指定 document 的 MAIN world 查询并执行，注入函数自包含', async () => {
  const f = fixture()
  const result = await f.client.execute(request('s1'))
  assert.deepEqual(result, terminal('s1'))
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.calls[0]?.target, { tabId: 7, documentIds: ['doc'] })
  assert.equal(f.calls[0]?.world, 'MAIN')
  assert.deepEqual(f.calls[1]?.args, [{ op: 'execute', request: request('s1') }])
})

test('固定上下文预检与返回后复核；导航或账号变化均不回传页面结果', async () => {
  for (const changed of [
    { accountId: 'a', tabId: 7, documentId: 'new-doc' },
    { accountId: 'other', tabId: 7, documentId: 'doc' },
  ]) {
    let completed = false
    const f = fixture({
    verify: async () => changed,
      execute: (step) => { completed = true; return terminal(step.id) },
    })
    await assert.rejects(f.client.execute(request('s2')), { code: changed.accountId === 'a' ? 'PAGE_NOT_READY' : 'ACCOUNT_CHANGED' })
    assert.equal(completed, false, '上下文 verify 拒绝时不得调用页面')
  }
  const f = fixture({
    execute: step => terminal(step.id),
    verify: async () => { throw Object.assign(new Error('private'), { code: 'PAGE_NOT_READY' }) },
  })
  await assert.rejects(f.client.execute(request('s3')), (e: unknown) => (e as { code?: string }).code === 'PAGE_NOT_READY' && !String(e).includes('private'))
})

test('缺少 runtime、文档不匹配和无效结果固定失败且不伪造终结', async () => {
  await assert.rejects(fixture({ runtime: false }).client.execute(request('s4')), { code: 'PAGE_NOT_READY' })
  const f = fixture({ execute: () => ({ ...terminal('wrong'), id: 'wrong' }) })
  await assert.rejects(f.client.execute(request('s5')), { code: 'PAGE_NOT_READY' })
  const bad = fixture({ execute: () => ({ kind: 'step-result', id: 's6', terminal: false, ok: true, data: null }) })
  await assert.rejects(bad.client.execute(request('s6')), { code: 'PAGE_NOT_READY' })
})

test('在途旧步骤拒绝新步骤，同 id 等待同一结果', async () => {
  let release!: (result: Result) => void
  const pending = new Promise<Result>(resolve => { release = resolve })
  const f = fixture({ execute: () => pending })
  const first = f.client.execute(request('same'))
  await new Promise(resolve => setImmediate(resolve))
  const duplicate = f.client.execute(request('same'))
  await assert.rejects(f.client.execute({ ...request('same'), params: { itemId: 'different' } }), { code: 'PAGE_NOT_READY' })
  await assert.rejects(f.client.execute(request('different')), { code: 'PAGE_NOT_READY' })
  release(terminal('same'))
  assert.deepEqual(await first, await duplicate)
})

test('status 必须完整符合 runtime schema', async () => {
  for (const status of [
    { documentId: 'doc', activeStepId: 42, completed: 0 },
    { documentId: 'doc', activeStepId: null },
    { documentId: 'doc', activeStepId: null, completed: -1 },
    { documentId: 'doc', activeStepId: null, completed: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    await assert.rejects(fixture({ status }).client.execute(request('bad-status')), { code: 'PAGE_NOT_READY' })
  }
})
