import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { createChatPageSource } from '../chat-page-source.ts'
import { createChatCollector } from '../chat-collector.ts'
import type { PageBootstrapScripting } from '../page-bootstrap.ts'

const expected = { accountId: 'a', tabId: 7, documentId: 'doc' }
const message = { sourceId: 'm', sessionId: 's', senderId: 'p', text: '测试', sentAt: 1 }
function setup() {
  let verifies = 0, acked = 0, documentId = 'doc', payload: unknown = { messages: [message], syncRequired: true }
  let verify: () => unknown = () => expected
  const calls: any[] = []
  const scripting: PageBootstrapScripting = { async executeScript(details) {
    calls.push(details)
    // 序列化后在独立全局执行，不能依赖模块闭包。
    const result = await runInNewContext(`(${details.func!.toString()})(...args)`, { args: details.args,
      window: { __fishopsPageChatV1__: {
        peek: (account: string, limit: number) => { assert.equal(account, 'a'); assert.equal(limit, 100); return (payload as any).messages },
        status: () => ({ syncRequired: (payload as any).syncRequired }),
        ack: (account: string, ids: string[]) => { assert.equal(account, 'a'); acked++; return ids.length },
      } },
    })
    return [{ documentId, result }]
  } }
  const source = createChatPageSource({ context: { verify: async () => { verifies++; return verify() as typeof expected } }, scripting }, expected)
  return { source, calls, verifies: () => verifies, acked: () => acked,
    setVerify: (fn: () => unknown) => { verify = fn }, setDocument: (id: string) => { documentId = id }, setPayload: (p: unknown) => { payload = p } }
}
test('固定文档peek/ack、自包含序列化与前后核验', async () => {
  const f = setup()
  const batch = await f.source.peek()
  assert.deepEqual(JSON.parse(JSON.stringify(batch)), { messages: [message], syncRequired: true })
  await f.source.acknowledge(['m'])
  assert.equal(f.verifies(), 4); assert.equal(f.acked(), 1)
  for (const details of f.calls) {
    assert.deepEqual(details.target, { tabId: 7, documentIds: ['doc'] }); assert.equal(details.world, 'MAIN'); assert.equal(details.files, undefined)
  }
})
test('导航前后、账号变化与Chrome错文档均失败且脱敏', async () => {
  for (const after of [false, true]) {
    const f = setup(); let count = 0
    f.setVerify(() => ++count === (after ? 2 : 1) ? { ...expected, documentId: 'changed' } : expected)
    await assert.rejects(f.source.peek(), { code: 'PAGE_NOT_READY' })
    assert.equal(f.calls.length, after ? 1 : 0)
  }
  const account = setup(); account.setVerify(() => ({ ...expected, accountId: 'b' }))
  await assert.rejects(account.source.peek(), { code: 'ACCOUNT_CHANGED' })
  const wrong = setup(); wrong.setDocument('wrong'); await assert.rejects(wrong.source.peek(), { code: 'PAGE_NOT_READY' })
  const secret = setup(); secret.setVerify(() => { throw new Error('secret') })
  await assert.rejects(secret.source.peek(), (e: any) => e.code === 'PAGE_NOT_READY' && !e.message.includes('secret'))
})
test('坏消息、超量、未知字段和非布尔syncRequired拒绝', async () => {
  for (const payload of [{ messages: [{ ...message, token: 'secret' }], syncRequired: false },
    { messages: Array(101).fill(message), syncRequired: false }, { messages: [], syncRequired: 'yes' },
    { messages: [{ ...message, sourceId: '' }], syncRequired: false }]) {
    const f = setup(); f.setPayload(payload); await assert.rejects(f.source.peek(), { code: 'PAGE_NOT_READY' })
  }
})
test('返回包必须唯一且严格，ack结果必须非负安全整数不超过请求数量', async () => {
  for (const responses of [[], [{ documentId: 'doc', result: {} }, { documentId: 'doc', result: {} }],
    [{ documentId: 'doc', result: { messages: [], syncRequired: false, token: 'secret' } }]]) {
    const source = createChatPageSource({ context: { verify: async () => expected }, scripting: { executeScript: async () => responses } }, expected)
    await assert.rejects(source.peek(), { code: 'PAGE_NOT_READY' })
  }
  for (const result of [-1, 1.1, 2, NaN, '1']) {
    const source = createChatPageSource({ context: { verify: async () => expected }, scripting: { executeScript: async () => [{ documentId: 'doc', result }] } }, expected)
    await assert.rejects(source.acknowledge(['m']), { code: 'PAGE_NOT_READY' })
  }
})
test('collector持久化失败绝不ACK；成功后才确认', async () => {
  const f = setup(); let fail = true
  const collector = createChatCollector({ source: f.source, gap: async () => {}, persist: async () => { if (fail) throw new Error('存储失败') } })
  await assert.rejects(collector.collect()); assert.equal(f.acked(), 0)
  fail = false; assert.equal(await collector.collect(), 1); assert.equal(f.acked(), 1)
})
