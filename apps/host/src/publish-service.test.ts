import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { HostDatabase } from './database.ts'
import { NativeBridge } from './bridge.ts'
import { encodeFrame } from './framing.ts'
import { isStepWire } from '../../../packages/protocol/src/step.ts'
import { createPublishService, type PublishStepRequest } from './publish-service.ts'

/** 离线夹具常量；所有页面结果都是 mock，不发送任何真实请求。 */
const NOW = 1700000000000
const CONFIRM = { imageNoQr: true as const, addressConfirmed: true as const }
const PREPARE_PAGE = {
  draft: { title: '旧相机', description: null, price: '1200', imageCount: 1, categoryName: null, attributeNames: [], serviceNames: [] },
  candidates: { categoryRefs: ['cat-1'], attributeRefs: ['attr-1'], serviceRefs: ['svc-1'] },
  prepareRef: 'prep.test',
}
const prepareInput = () => ({
  source: { itemId: 'item-source-1' },
  idempotencyKey: 'prepare-key',
  seller: { addressRef: 'addr-1' },
  confirm: CONFIRM,
  draft: { title: '旧相机', price: { kind: 'fixed' as const, amount: 1200, unit: 'CNY' as const }, images: [{ kind: 'url' as const, url: 'https://example.com/a.jpg' }] },
})

type PageCall = { method: string; params: any; context: any }
type PageHandler = (step: PublishStepRequest) => Promise<unknown>

/** prepare + submit 固定成功、myItems 按序返回基线与确认列表的离线脚本。 */
function script(options: { before?: string[]; after?: string[] } = {}): PageHandler {
  let myItemsCalls = 0
  return async (step: PublishStepRequest): Promise<unknown> => {
    if (step.method === 'publish.prepare') return PREPARE_PAGE
    if (step.method === 'publish.submit') return { outcome: 'accepted', itemId: 'item-b' }
    myItemsCalls += 1
    const list = myItemsCalls === 1 ? options.before ?? ['item-a'] : options.after ?? ['item-a', 'item-b']
    return { items: list.map(itemId => ({ itemId })), hasMore: false }
  }
}

function fixture(options: { accountId?: () => string | null; page?: PageHandler; resolvePage?: () => Promise<{ tabId: number; documentId: string }> } = {}) {
  const db = new HostDatabase(':memory:')
  const calls: PageCall[] = []
  const page = options.page ?? script()
  const service = createPublishService({
    db,
    accountId: options.accountId ?? (() => 'account-a'),
    now: () => NOW,
    schedule: async (_input, execute) => execute(),
    resolvePage: options.resolvePage ?? (async () => ({ tabId: 7, documentId: 'doc-1' })),
    executePage: async step => { calls.push(step as PageCall); return page(step) },
  })
  return { db, service, calls }
}

const submitInput = (prepared: { prepareToken: string; draftFingerprint: string }) => ({
  prepareToken: prepared.prepareToken, draftFingerprint: prepared.draftFingerprint, idempotencyKey: 'submit-key', confirm: CONFIRM,
})
const writes = (calls: PageCall[]) => calls.filter(call => call.method === 'publish.submit').length

test('prepare 幂等复用同一脱敏结果，同键异参冲突且不重复派发', async () => {
  const f = fixture()
  try {
    const input = prepareInput()
    const first = await f.service.prepare(input)
    const second = await f.service.prepare(input)
    assert.deepEqual(second, first)
    assert.equal(f.calls.length, 1)
    // 只返回脱敏摘要、候选集合与主机签发的引用，不含 cookie、签名或原始响应。
    assert.deepEqual(Object.keys(first).sort(), ['candidates', 'draft', 'draftFingerprint', 'expiresAt', 'prepareToken'])
    assert.deepEqual(first.draft, PREPARE_PAGE.draft)
    assert.equal(first.expiresAt, NOW + 30 * 60 * 1000)
    assert.equal(/^[A-Za-z0-9._:-]+$/.test(first.prepareToken), true)
    assert.equal(/^[0-9a-f]{64}$/.test(first.draftFingerprint), true)
    assert.equal(JSON.stringify(first).includes('cookie'), false)
    assert.equal(f.db.getOperation('account-a', 'publish.prepare', 'prepare-key')?.status, 'succeeded')
    // 同键异参必须冲突，且不得再次访问页面。
    await assert.rejects(f.service.prepare({ ...input, draft: { ...input.draft, title: '另一个标题' } }), { code: 'IDEMPOTENCY_CONFLICT' })
    assert.equal(f.calls.length, 1)
    // 账号范围隔离：其他账号同键各自独立。
    assert.equal(f.db.getOperation('account-b', 'publish.prepare', 'prepare-key'), null)
  } finally { f.db.close() }
})

test('prepare 平台未知记为 unknown 并阻断同键重放', async () => {
  const f = fixture({ page: async () => { throw Object.assign(new Error('超时'), { code: 'TIMEOUT' }) } })
  try {
    await assert.rejects(f.service.prepare(prepareInput()), { code: 'TIMEOUT' })
    const operation = f.db.getOperation('account-a', 'publish.prepare', 'prepare-key')
    assert.equal(operation?.status, 'unknown')
    assert.equal(operation?.errorCode, 'TIMEOUT')
    await assert.rejects(f.service.prepare(prepareInput()), { code: 'RESULT_UNKNOWN' })
    assert.equal(f.calls.length, 1)
  } finally { f.db.close() }
})

test('submit 必须由官方在售列表确认新增 itemId，否则 unknown 且不重放', async () => {
  // 平台接受提交，但在售列表没有新增：不得报告成功。
  const unconfirmed = fixture({ page: async step => step.method === 'publish.prepare' ? PREPARE_PAGE : step.method === 'publish.submit' ? { outcome: 'accepted' } : { items: [{ itemId: 'item-a' }], hasMore: false } })
  try {
    const prepared = await unconfirmed.service.prepare(prepareInput())
    const input = submitInput(prepared)
    await assert.rejects(unconfirmed.service.submit(input), { code: 'RESULT_UNKNOWN' })
    assert.equal(unconfirmed.db.getOperation('account-a', 'publish.submit', 'submit-key')?.status, 'unknown')
    assert.equal(writes(unconfirmed.calls), 1)
    // attempting/unknown 同键只报告锁定状态，不再次发包。
    await assert.rejects(unconfirmed.service.submit(input), { code: 'RESULT_UNKNOWN' })
    assert.equal(writes(unconfirmed.calls), 1)
  } finally { unconfirmed.db.close() }

  // 提交前拿不到完整基线：禁止先发后猜，写请求为 0 次。
  const noBaseline = fixture({ page: async step => {
    if (step.method === 'publish.prepare') return PREPARE_PAGE
    if (step.method === 'publish.submit') return { outcome: 'accepted' }
    throw Object.assign(new Error('在售列表不可用'), { code: 'PAGE_NOT_READY' })
  } })
  try {
    const prepared = await noBaseline.service.prepare(prepareInput())
    await assert.rejects(noBaseline.service.submit(submitInput(prepared)), { code: 'PAGE_NOT_READY' })
    assert.equal(writes(noBaseline.calls), 0)
    assert.equal(noBaseline.db.getOperation('account-a', 'publish.submit', 'submit-key')?.status, 'unknown')
  } finally { noBaseline.db.close() }

  // 页面提交结果形状未知：一律按未知锁定，不判成功也不判拒绝。
  const malformed = fixture({ page: async step => step.method === 'publish.prepare' ? PREPARE_PAGE : step.method === 'publish.submit' ? { ret: 'SUCCESS' } : { items: [{ itemId: 'item-a' }], hasMore: false } })
  try {
    const prepared = await malformed.service.prepare(prepareInput())
    await assert.rejects(malformed.service.submit(submitInput(prepared)), { code: 'RESULT_UNKNOWN' })
    assert.equal(malformed.db.getOperation('account-a', 'publish.submit', 'submit-key')?.status, 'unknown')
  } finally { malformed.db.close() }
})

test('submit 成功后同键复用结果、引用一次性且绑定 host 权威数据', async () => {
  const f = fixture({ page: script({ before: ['item-a'], after: ['item-a', 'item-b'] }) })
  try {
    const prepared = await f.service.prepare(prepareInput())
    const input = submitInput(prepared)
    const result = await f.service.submit(input)
    assert.deepEqual(result, { state: 'published', itemId: 'item-b', confirmedAt: NOW })
    assert.equal(f.db.getOperation('account-a', 'publish.submit', 'submit-key')?.status, 'succeeded')
    assert.deepEqual(await f.service.submit(input), result)
    assert.equal(writes(f.calls), 1)
    // 状态与 published 字段一致：只有成功才带 itemId 与 confirmedAt。
    assert.deepEqual(Object.keys(result).sort(), ['confirmedAt', 'itemId', 'state'])
    // 步骤只接受 host 组装的规范化 payload，前端伪造字段无法进入提交。
    const step = f.calls.find(call => call.method === 'publish.submit')!
    assert.deepEqual(Object.keys(step.params).sort(), ['confirm', 'draftFingerprint', 'prepareRef', 'prepareToken'])
    assert.equal(step.params.prepareRef, 'prep.test')
    assert.deepEqual(step.params.confirm, CONFIRM)
    // 每次单步都绑定同一定位结果与账号，页面无法自行改写执行上下文。
    assert.deepEqual(f.calls.map(call => call.context), Array.from({ length: f.calls.length }, () => ({ accountId: 'account-a', tabId: 7, documentId: 'doc-1' })))
    // 引用一经成功提交即作废：换幂等键复用同一 token 必须拒绝且不重新发包。
    await assert.rejects(f.service.submit({ ...input, idempotencyKey: 'submit-key-2' }), { code: 'BAD_REQUEST' })
    assert.equal(writes(f.calls), 1)
    // 指纹被篡改或引用不存在都不进入平台写步骤。
    await assert.rejects(f.service.submit({ ...input, idempotencyKey: 'submit-key-3', draftFingerprint: 'f'.repeat(64) }), { code: 'BAD_REQUEST' })
    await assert.rejects(f.service.submit({ ...input, idempotencyKey: 'submit-key-4', prepareToken: 'unknown-token' }), { code: 'BAD_REQUEST' })
    assert.equal(writes(f.calls), 1)
  } finally { f.db.close() }
})

test('prepare 公共结果不泄露内部引用，指纹绑定权威准备数据', async () => {
  const firstPage = {
    ...PREPARE_PAGE,
    prepareRef: 'prep.authority-a',
    candidates: { categoryRefs: ['cat-a'], attributeRefs: ['attr-a'], serviceRefs: ['svc-a'] },
  }
  const secondPage = {
    ...PREPARE_PAGE,
    prepareRef: 'prep.authority-b',
    candidates: { categoryRefs: ['cat-b'], attributeRefs: ['attr-b'], serviceRefs: ['svc-b'] },
  }
  let page = firstPage
  const f = fixture({ page: async step => step.method === 'publish.prepare' ? page : { items: [], hasMore: false } })
  try {
    const first = await f.service.prepare({ ...prepareInput(), idempotencyKey: 'prepare-a' })
    assert.equal(JSON.stringify(first).includes('prepareRef'), false)
    assert.equal(JSON.stringify(first).includes('authority-a'), false)
    page = secondPage
    const second = await f.service.prepare({ ...prepareInput(), idempotencyKey: 'prepare-b' })
    assert.notEqual(second.draftFingerprint, first.draftFingerprint)
    assert.deepEqual(second.candidates, secondPage.candidates)
  } finally { f.db.close() }
})

test('submit 已派发后换幂等键复用同一引用：第二次 0 次写，不能再提交', async () => {
  const f = fixture({
    page: async step => {
      if (step.method === 'publish.prepare') return PREPARE_PAGE
      if (step.method === 'publish.submit') return { outcome: 'accepted', itemId: 'item-b' }
      return { items: [{ itemId: 'item-a' }], hasMore: false }
    },
  })
  try {
    const prepared = await f.service.prepare(prepareInput())
    const first = submitInput(prepared)
    await assert.rejects(f.service.submit(first), { code: 'RESULT_UNKNOWN' })
    assert.equal(writes(f.calls), 1)
    await assert.rejects(f.service.submit({ ...first, idempotencyKey: 'submit-key-2' }), { code: 'BAD_REQUEST' })
    assert.equal(writes(f.calls), 1)
  } finally { f.db.close() }
})

test('submit 并发同一引用只有一个调用能派发写步骤', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let writesStarted = 0
  const f = fixture({
    page: async step => {
      if (step.method === 'publish.prepare') return PREPARE_PAGE
      if (step.method === 'publish.submit') {
        writesStarted += 1
        await gate
        return { outcome: 'accepted', itemId: 'item-b' }
      }
      return { items: [{ itemId: 'item-a' }], hasMore: false }
    },
  })
  try {
    const prepared = await f.service.prepare(prepareInput())
    const base = submitInput(prepared)
    const first = f.service.submit(base)
    await new Promise(resolve => setImmediate(resolve))
    const second = f.service.submit({ ...base, idempotencyKey: 'submit-key-2' })
    await assert.rejects(second, { code: 'BAD_REQUEST' })
    release()
    await assert.rejects(first, { code: 'RESULT_UNKNOWN' })
    assert.equal(writesStarted, 1)
  } finally { f.db.close() }
})

test('submit 页面 itemId 与新增列表不一致时 unknown，绝不假成功', async () => {
  const f = fixture({
    page: async step => {
      if (step.method === 'publish.prepare') return PREPARE_PAGE
      if (step.method === 'publish.submit') return { outcome: 'accepted', itemId: 'item-page' }
      return { items: [{ itemId: 'item-a' }], hasMore: false }
    },
  })
  try {
    const prepared = await f.service.prepare(prepareInput())
    await assert.rejects(f.service.submit(submitInput(prepared)), { code: 'RESULT_UNKNOWN' })
    assert.equal(f.db.getOperation('account-a', 'publish.submit', 'submit-key')?.status, 'unknown')
  } finally { f.db.close() }
})

test('myItems 重复游标或 hasMore 无下一游标时失败关闭', async () => {
  const repeated = fixture({
    page: async step => {
      if (step.method === 'publish.prepare') return PREPARE_PAGE
      return { items: [{ itemId: 'item-a' }], hasMore: true, nextPage: 'v1.same' }
    },
  })
  try {
    const prepared = await repeated.service.prepare(prepareInput())
    await assert.rejects(repeated.service.submit(submitInput(prepared)), { code: 'RESULT_UNKNOWN' })
    assert.equal(writes(repeated.calls), 0)
  } finally { repeated.db.close() }
})

test('submit 平台明确拒绝记 failed，不加锁也不改写为成功', async () => {
  const f = fixture({ page: async step => step.method === 'publish.prepare' ? PREPARE_PAGE : step.method === 'publish.submit' ? { outcome: 'rejected' } : { items: [{ itemId: 'item-a' }], hasMore: false } })
  try {
    const prepared = await f.service.prepare(prepareInput())
    await assert.rejects(f.service.submit(submitInput(prepared)), { code: 'PLATFORM_REJECTED' })
    const operation = f.db.getOperation('account-a', 'publish.submit', 'submit-key')
    assert.equal(operation?.status, 'failed')
    assert.equal(operation?.errorCode, 'PLATFORM_REJECTED')
  } finally { f.db.close() }
})

test('账号切换：prepare 期间换号记 unknown，跨账号引用按 ACCOUNT_CHANGED 拒绝', async () => {
  let account = 'account-a'
  const switched = fixture({ accountId: () => account, page: async step => { if (step.method === 'publish.prepare') { account = 'account-b'; return PREPARE_PAGE } return null } })
  try {
    await assert.rejects(switched.service.prepare(prepareInput()), { code: 'ACCOUNT_CHANGED' })
    // 结果未确认，旧账号的键必须锁定，避免把未确认的准备当成可用引用。
    assert.equal(switched.db.getOperation('account-a', 'publish.prepare', 'prepare-key')?.status, 'unknown')
  } finally { switched.db.close() }

  let current = 'account-a'
  const f = fixture({ accountId: () => current, page: script() })
  try {
    const prepared = await f.service.prepare(prepareInput())
    current = 'account-b'
    await assert.rejects(f.service.submit(submitInput(prepared)), { code: 'ACCOUNT_CHANGED' })
    assert.equal(writes(f.calls), 0)
    // 新账号范围只记录自己的 operation，不迁移也不复用旧账号的引用。
    const operation = f.db.getOperation('account-b', 'publish.submit', 'submit-key')
    assert.equal(operation?.status, 'unknown')
    assert.equal(operation?.errorCode, 'ACCOUNT_CHANGED')
    assert.equal(f.db.getOperation('account-a', 'publish.submit', 'submit-key'), null)
  } finally { f.db.close() }
})

test('排队取消在发包前终结 claim，同键可重新派发', async () => {
  const f = fixture()
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(f.service.prepare(prepareInput(), controller.signal), { code: 'CANCELLED' })
    assert.equal(f.calls.length, 0)
    const operation = f.db.getOperation('account-a', 'publish.prepare', 'prepare-key')
    assert.equal(operation?.status, 'failed')
    assert.equal(operation?.errorCode, 'CANCELLED')
    const prepared = await f.service.prepare(prepareInput())
    assert.equal(f.calls.length, 1)

    // submit 排队阶段取消同样零派发、零写入，并终结自己的 claim。
    const submitController = new AbortController()
    submitController.abort()
    await assert.rejects(f.service.submit(submitInput(prepared), submitController.signal), { code: 'CANCELLED' })
    assert.equal(writes(f.calls), 0)
    const claimed = f.db.getOperation('account-a', 'publish.submit', 'submit-key')
    assert.equal(claimed?.status, 'failed')
    assert.equal(claimed?.errorCode, 'CANCELLED')
  } finally { f.db.close() }
})

test('固定文档在发包前被替换：不发送写步骤并锁定为 unknown', async () => {
  let resolved = 0
  // 第一次定位用于基线；写步骤重新定位时页面已被替换，文档不再一致。
  const f = fixture({ page: script(), resolvePage: async () => ({ tabId: 7, documentId: resolved++ === 0 ? 'doc-1' : 'doc-2' }) })
  try {
    const prepared = await f.service.prepare(prepareInput())
    resolved = 0
    await assert.rejects(f.service.submit(submitInput(prepared)), { code: 'RESULT_UNKNOWN' })
    assert.equal(writes(f.calls), 0)
    const operation = f.db.getOperation('account-a', 'publish.submit', 'submit-key')
    assert.equal(operation?.status, 'unknown')
    assert.equal(operation?.errorCode, 'RESULT_UNKNOWN')
  } finally { f.db.close() }

  // 固定页无法定位时同样零步骤，并把无法确认的准备锁定为 unknown。
  const unavailable = fixture({ page: script(), resolvePage: async () => { throw Object.assign(new Error('页面不可用'), { code: 'PAGE_NOT_READY' }) } })
  try {
    await assert.rejects(unavailable.service.prepare(prepareInput()), { code: 'PAGE_NOT_READY' })
    assert.equal(unavailable.calls.length, 0)
    assert.equal(unavailable.db.getOperation('account-a', 'publish.prepare', 'prepare-key')?.status, 'unknown')
  } finally { unavailable.db.close() }
})

test('myItems 只读完整基线：去重、截断与失败都不伪造成完整列表', async () => {
  const f = fixture({ page: async () => ({ items: [{ itemId: 'item-a', title: '甲' }, { itemId: 'item-a' }, { itemId: 'item-b' }], hasMore: false }) })
  try {
    assert.deepEqual(await f.service.myItems({ limit: 10 }), { items: [{ itemId: 'item-a', title: '甲' }, { itemId: 'item-b' }], total: 2, hasMore: false })
    assert.deepEqual(f.calls[0]!.params, { limit: 10 })
  } finally { f.db.close() }

  // 分页被安全上限截断：报告未知，不返回截断列表。
  let page = 0
  const truncated = fixture({ page: async () => ({ items: [{ itemId: `item-${page += 1}` }], hasMore: true, nextPage: `cursor-${page}` }) })
  try {
    await assert.rejects(truncated.service.myItems({ limit: 10 }), { code: 'RESULT_UNKNOWN' })
    assert.equal(truncated.calls.length, 20)
  } finally { truncated.db.close() }

  // 缺 hasMore/nextPage 或响应结构不完整的页不能当作完整基线。
  const broken = fixture({ page: async step => step.method === 'publish.myItems' ? { items: [{ itemId: 'item-a' }], hasMore: true } : null })
  try {
    await assert.rejects(broken.service.myItems({}), { code: 'INTERNAL' })
  } finally { broken.db.close() }

  const login = fixture({ accountId: () => null })
  try {
    await assert.rejects(login.service.myItems({}), { code: 'LOGIN_REQUIRED' })
  } finally { login.db.close() }
})

/** 启动真实 HostServer，但不连接任何平台；publishService 由用例注入或按桥接构造。 */
async function startHost(t: any, create?: (bridge: NativeBridge, db: HostDatabase) => unknown) {
  const { HostServer } = await import('./server.ts')
  const db = new HostDatabase(':memory:')
  const input = new PassThrough()
  const output = new PassThrough()
  const sent: any[] = []
  output.on('data', chunk => sent.push(JSON.parse(chunk.subarray(4, 4 + chunk.readUInt32LE()).toString('utf8'))))
  // 账号范围与生产一致：hello/账号事件先落到 state，路由才能按当前账号记录请求。
  const bridge = new NativeBridge(input, output, (type, data) => { if (type === 'account.changed') db.setAccount((data as any).account) }, 1000)
  const server = new HostServer(0, 'p'.repeat(32), bridge, db, undefined, undefined, undefined, undefined, create?.(bridge, db) as any)
  t.after(async () => { await server.close(); bridge.close(); input.destroy(); output.destroy(); db.close() })
  const port = await server.listen()
  const call = async (method: string, params: unknown = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'p'.repeat(32)}`, 'content-type': 'application/json' },
      body: JSON.stringify(params),
    })
    return { status: response.status, body: await response.json() as any }
  }
  const hello = async () => {
    input.write(encodeFrame({ kind: 'hello', protocolVersion: 1, extensionVersion: '0.2.0', account: { userId: 'account-a', nick: '甲' } }))
    await new Promise(resolve => setImmediate(resolve))
  }
  return { server, db, call, hello, sent, input }
}

test('公共发布路由：真实桥接接受无公共幂等键的 prepare/submit 并复用成功结果', { timeout: 10000 }, async t => {
  // 与 main.ts 相同的接线：先定位唯一执行页，再用固定账户与页面上下文发单步。
  const host = await startHost(t, (bridge, db) => createPublishService({
    db,
    accountId: () => 'account-a',
    now: () => NOW,
    schedule: async (_input, execute) => execute(),
    resolvePage: accountId => bridge.callResolvePage(accountId),
    executePage: (step: { method: string; params: unknown; context: { accountId: string; tabId: number; documentId: string } }) =>
      bridge.callStep({ requestId: randomUUID(), method: step.method, params: step.params, context: step.context } as Parameters<NativeBridge['callStep']>[0]),
  }))
  await host.hello()
  // 仅模拟扩展终结帧；Host、协议校验和 NativeBridge 使用真实实现。
  const page = script()
  const answered = new Set<string>()
  const answer = async (frame: any) => {
    if (frame.kind === 'resolve-page') {
      host.input.write(encodeFrame({ kind: 'page-context', id: frame.id, context: { tabId: 7, documentId: 'doc-1' } }))
    } else if (frame.kind === 'request-step') {
      assert.equal(isStepWire(frame), true)
      assert.deepEqual(frame.context, { accountId: 'account-a', tabId: 7, documentId: 'doc-1' })
      const data = await page(frame)
      host.input.write(encodeFrame({ kind: 'step-result', id: frame.id, terminal: true, ok: true, data }))
    }
  }
  const answers = setInterval(() => {
    for (const frame of host.sent) {
      if (answered.has(frame.id)) continue
      answered.add(frame.id)
      void answer(frame)
    }
  }, 1)
  t.after(() => clearInterval(answers))
  const prepared = await host.call('publish.prepare', prepareInput())
  assert.equal(prepared.status, 200)
  const submitted = await host.call('publish.submit', submitInput(prepared.body.data))
  assert.equal(submitted.status, 200)
  assert.equal(submitted.body.data.state, 'published')
  assert.equal(submitted.body.data.itemId, 'item-b')
  const steps = host.sent.filter(frame => frame.kind === 'request-step')
  assert.deepEqual(steps.map(frame => frame.method), ['publish.prepare', 'publish.myItems', 'publish.submit', 'publish.myItems'])
  const { idempotencyKey: _key, ...business } = prepareInput()
  assert.deepEqual(steps[0].params, business)
  assert.deepEqual(steps[2].params, {
    prepareToken: prepared.body.data.prepareToken,
    prepareRef: PREPARE_PAGE.prepareRef,
    draftFingerprint: prepared.body.data.draftFingerprint,
    confirm: CONFIRM,
  })
  assert.equal(host.db.getOperation('account-a', 'publish.prepare', 'prepare-key')?.status, 'succeeded')
  assert.equal(host.db.getOperation('account-a', 'publish.submit', 'submit-key')?.status, 'succeeded')
  assert.deepEqual((await host.call('publish.prepare', prepareInput())).body.data, prepared.body.data)
  assert.deepEqual((await host.call('publish.submit', submitInput(prepared.body.data))).body.data, submitted.body.data)
  assert.equal(host.sent.filter(frame => frame.kind === 'request-step').length, 4)

})

test('公共发布路由：错误码映射到 HTTP，写方法先落请求记录，参数非法不落库', { timeout: 10000 }, async t => {
  let code = 'BAD_REQUEST'
  const stub = {
    prepare: async () => { throw Object.assign(new Error('测试失败'), { code }) },
    submit: async () => { throw Object.assign(new Error('测试失败'), { code }) },
    myItems: async () => { throw Object.assign(new Error('测试失败'), { code }) },
  }
  const host = await startHost(t, () => stub)
  await host.hello()
  const table: Array<[string, number]> = [
    ['BAD_REQUEST', 400], ['LOGIN_REQUIRED', 503], ['PAGE_NOT_READY', 503], ['TIMEOUT', 504], ['RESULT_UNKNOWN', 409],
    ['IDEMPOTENCY_CONFLICT', 409], ['ACCOUNT_CHANGED', 409], ['PLATFORM_REJECTED', 409], ['CANCELLED', 499], ['INTERNAL', 500],
  ]
  for (const [item, status] of table) {
    code = item
    const response = await host.call('publish.prepare', prepareInput())
    assert.equal(response.status, status)
    assert.equal(response.body.error.code, item)
    assert.equal(response.body.error.retryable, false)
  }
  code = 'RESULT_UNKNOWN'
  assert.equal((await host.call('publish.submit', submitInput({ prepareToken: 'tok', draftFingerprint: 'f'.repeat(64) }))).status, 409)
  assert.equal((await host.call('publish.myItems', { limit: 10 })).status, 409)
  // 参数非法在路由层被拒绝，不进入编排，也不写入请求历史。
  assert.equal((await host.call('publish.prepare', { source: { itemId: 'item-1' } })).status, 400)
  assert.equal((await host.call('publish.myItems', { page: 2 })).status, 400)
  const rows = host.db.requests({ afterId: '0', limit: 100 }, 'account-a').items
  assert.equal(rows.filter(row => row.method === 'publish.prepare').length, table.length)
  assert.equal(rows.every(row => row.status === 'failed'), true)
})

test('公共发布路由：RISK_BLOCKED 与 LOGIN_REQUIRED 发布脱敏 risk.signal', { timeout: 10000 }, async t => {
  let code = 'RISK_BLOCKED'
  let phase = 'write'
  const stub = {
    prepare: async () => { throw Object.assign(new Error('平台敏感原文不外出'), { code, phase }) },
    submit: async () => { throw Object.assign(new Error('平台敏感原文不外出'), { code, phase }) },
    myItems: async () => { throw Object.assign(new Error('平台敏感原文不外出'), { code, phase }) },
  }
  const host = await startHost(t, () => stub)
  await host.hello()
  const cases: Array<[string, string, string, string]> = [
    ['publish.prepare', 'RISK_BLOCKED', 'blocked', 'CAPTCHA'],
    ['publish.submit', 'RISK_BLOCKED', 'blocked', 'CAPTCHA'],
    ['publish.prepare', 'LOGIN_REQUIRED', 'caution', 'LOGIN_REQUIRED'],
    ['publish.myItems', 'LOGIN_REQUIRED', 'caution', 'LOGIN_REQUIRED'],
  ]
  for (const [method, errorCode, level, signal] of cases) {
    code = errorCode
    phase = method === 'publish.myItems' ? 'read' : 'write'
    // 每个用例前清除熔断，单独验证事件脱敏；熔断本身由 host.test.ts 覆盖。
    host.server.clearRisk()
    const response = await host.call(method, method === 'publish.prepare' ? prepareInput() : method === 'publish.submit' ? submitInput({ prepareToken: 'tok', draftFingerprint: 'f'.repeat(64) }) : {})
    assert.equal(response.body.error.code, errorCode)
    const events = host.db.events({ afterSeq: '0', types: ['risk.signal'] }, 'account-a')
    assert.equal(events.items.at(-1)?.data && JSON.stringify(events.items.at(-1)?.data).includes('敏感原文'), false)
    assert.deepEqual(events.items.at(-1)?.data, { level, signal })
  }
})

test('公共发布路由：未配置发布编排时明确 503，不伪装成功', { timeout: 5000 }, async t => {
  const host = await startHost(t, undefined)
  await host.hello()
  for (const method of ['publish.prepare', 'publish.submit', 'publish.myItems']) {
    const response = await host.call(method, method === 'publish.prepare' ? prepareInput() : method === 'publish.submit' ? submitInput({ prepareToken: 'tok', draftFingerprint: 'f'.repeat(64) }) : {})
    assert.equal(response.status, 503)
    assert.equal(response.body.error.code, 'PAGE_NOT_READY')
  }
})

test('prepare 授权不能在刷新后的同账号新文档使用，基线和写步骤均不派发', async () => {
  let documentId = 'doc-1'
  const f = fixture({ resolvePage: async () => ({ tabId: 7, documentId }) })
  try {
    const prepared = await f.service.prepare(prepareInput())
    documentId = 'doc-2'
    await assert.rejects(f.service.submit(submitInput(prepared)), { code: 'RESULT_UNKNOWN' })
    assert.equal(f.calls.length, 1)
    assert.equal(writes(f.calls), 0)
  } finally { f.db.close() }
})

test('prepare 成功记录落库失败时原子回滚引用，不留下可提交的孤立授权', async () => {
  const f = fixture()
  try {
    f.db.db.exec("CREATE TRIGGER fail_prepare_success BEFORE UPDATE ON operations WHEN NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'fixture'); END")
    await assert.rejects(f.service.prepare(prepareInput()))
    const row = f.db.db.prepare("SELECT COUNT(*) AS count FROM state WHERE key LIKE 'publish.prepared:%'").get() as { count: number }
    assert.equal(row.count, 0)
    assert.equal(f.db.getOperation('account-a', 'publish.prepare', 'prepare-key')?.status, 'unknown')
  } finally { f.db.close() }
})
