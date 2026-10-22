import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HostDatabase } from './database.ts'
import { createChatSyncService, type ChatSyncServiceDeps } from './chat-sync-service.ts'
import { createSyncCursorCodec } from './sync-cursor.ts'
function fixture() {
  const db = new HostDatabase(':memory:')
  let calls = 0, schedules = 0
  let result: unknown = { mode: 'conversations', conversations: [], hasMore: true, nextAnchor: '10', unsupportedCount: 0 }
  const deps: ChatSyncServiceDeps = { db, accountId: () => 'a', now: () => 1,
    codec: createSyncCursorCodec('0123456789012345', () => 1), resolvePage: async () => ({ tabId: 1, documentId: 'd' }),
    executePage: async () => { calls++; return result }, schedule: async (input, fn) => { schedules++; assert.equal(input.category, 'chatRead'); return fn() } }
  return { db, deps, service: createChatSyncService(deps), calls: () => calls, schedules: () => schedules, result: (v: unknown) => { result = v } }
}
test('单页调度、续页提交重放返回已有结果，不重复派发', async () => {
  const f = fixture()
  try {
    const first = await f.service.call({})
    assert.equal(f.calls(), 1); assert.ok(first.nextCursor)
    assert.deepEqual({ mode: first.mode, sessionId: first.sessionId, committedPages: first.committedPages, gapCleared: first.gapCleared }, { mode: 'conversations', sessionId: null, committedPages: 1, gapCleared: false })
    f.result({ mode: 'conversations', conversations: [], hasMore: false, nextAnchor: null, unsupportedCount: 0 })
    const second = await f.service.call({ cursor: first.nextCursor })
    assert.equal(second.completion, 'complete')
    assert.equal(second.committedPages, 2)
    assert.deepEqual(await createChatSyncService(f.deps).call({ cursor: first.nextCursor }), second)
    assert.equal(f.calls(), 2); assert.equal(f.schedules(), 2)
  } finally { f.db.close() }
})
test('同cursor并发只有一次执行，失败unknown重建不重放', async () => {
  const f = fixture()
  try {
    const first = await f.service.call({})
    let release!: () => void
    f.deps.executePage = async () => { await new Promise<void>(r => { release = r }); throw new Error('secret') }
    const pending = f.service.call({ cursor: first.nextCursor })
    await new Promise(r => setImmediate(r))
    await assert.rejects(createChatSyncService(f.deps).call({ cursor: first.nextCursor }), { code: 'RESULT_UNKNOWN' })
    release(); await assert.rejects(pending, e => !String(e).includes('secret'))
    await assert.rejects(createChatSyncService(f.deps).call({ cursor: first.nextCursor }), { code: 'RESULT_UNKNOWN' })
  } finally { f.db.close() }
})
test('排队取消零执行，unsupported末页仍partial', async () => {
  const f = fixture()
  try {
    const controller = new AbortController(); controller.abort()
    await assert.rejects(f.service.call({}, controller.signal), { code: 'CANCELLED' })
    assert.equal(f.calls(), 0)
    f.result({ mode: 'conversations', conversations: [], hasMore: false, nextAnchor: null, unsupportedCount: 1 })
    const result = await f.service.call({})
    assert.equal(result.partial, true); assert.equal(result.gapCleared, false)
  } finally { f.db.close() }
})
test('续页导航变化拒绝，执行中取消不提交且不重放', async () => {
  const f = fixture()
  try {
    const first = await f.service.call({})
    f.deps.resolvePage = async () => ({ tabId: 2, documentId: 'new' })
    await assert.rejects(f.service.call({ cursor: first.nextCursor }), { code: 'PAGE_NOT_READY' })
    f.deps.resolvePage = async () => ({ tabId: 1, documentId: 'd' })
    const controller = new AbortController()
    f.deps.executePage = async () => { controller.abort(); return { mode: 'conversations', conversations: [], hasMore: false, nextAnchor: null, unsupportedCount: 0 } }
    await assert.rejects(f.service.call({ cursor: first.nextCursor }, controller.signal), { code: 'RESULT_UNKNOWN' })
    await assert.rejects(f.service.call({ cursor: first.nextCursor }), { code: 'RESULT_UNKNOWN' })
  } finally { f.db.close() }
})

/** native 桥用 apiError 携带扩展侧协议错误；服务必须按该字段分类，不能只读 code。 */
const bridgeFailure = (code: string) => Object.assign(new Error('聊天同步未完成'), { apiError: { code, message: '扩展侧固定文案', phase: 'read', retryable: false } })

test('页面未派发失败原样回传，续页预留保留同一cursor可重试', async () => {
  const f = fixture()
  try {
    const first = await f.service.call({})
    const executed: number[] = []
    f.deps.executePage = async () => { executed.push(1); throw bridgeFailure('PAGE_NOT_READY') }
    await assert.rejects(f.service.call({ cursor: first.nextCursor }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PAGE_NOT_READY')
      assert.ok(!String(error).includes('扩展侧固定文案'))
      return true
    })
    // 未派发：同一 cursor 的预留必须保留，页面就绪后可以继续这一页。
    f.deps.executePage = async () => { executed.push(1); return { mode: 'conversations', conversations: [], hasMore: false, nextAnchor: null, unsupportedCount: 0 } }
    const retried = await f.service.call({ cursor: first.nextCursor })
    assert.equal(retried.completion, 'complete'); assert.equal(executed.length, 2)
  } finally { f.db.close() }
})
test('平台风控与登录停止原样回传，未知终结只记unknown不重放', async () => {
  const f = fixture()
  try {
    const first = await f.service.call({})
    f.deps.executePage = async () => { throw bridgeFailure('RISK_BLOCKED') }
    await assert.rejects(f.service.call({ cursor: first.nextCursor }), { code: 'RISK_BLOCKED' })
    // 已派发：即使平台明确停止也不再重放同一预留。
    await assert.rejects(f.service.call({ cursor: first.nextCursor }), { code: 'RESULT_UNKNOWN' })
  } finally { f.db.close() }
})
test('通道关闭等未知终结保留原因码，不塌缩成INTERNAL也不重放', async () => {
  const f = fixture()
  try {
    const first = await f.service.call({})
    f.deps.executePage = async () => { throw bridgeFailure('EXTENSION_OFFLINE') }
    await assert.rejects(f.service.call({ cursor: first.nextCursor }), { code: 'EXTENSION_OFFLINE' })
    await assert.rejects(f.service.call({ cursor: first.nextCursor }), { code: 'RESULT_UNKNOWN' })
  } finally { f.db.close() }
})
test('transport 销毁的 RESULT_UNKNOWN 在服务重建后仍不重放原续页', async () => {
  const f = fixture()
  try {
    const first = await f.service.call({})
    let attempts = 0
    f.deps.executePage = async () => { attempts++; throw bridgeFailure('RESULT_UNKNOWN') }
    await assert.rejects(f.service.call({ cursor: first.nextCursor }), { code: 'RESULT_UNKNOWN' })
    await assert.rejects(createChatSyncService(f.deps).call({ cursor: first.nextCursor }), { code: 'RESULT_UNKNOWN' })
    assert.equal(attempts, 1)
  } finally { f.db.close() }
})
test('签发凭证失败回滚页数据与公共结果，保留unknown且不重放', async () => {
  const f = fixture()
  try {
    f.result({ mode: 'conversations', conversations: [{ sessionId: 'c', peerUserId: null, itemId: null, updatedAt: 1, sortIndex: '10' }], hasMore: true, nextAnchor: '10', unsupportedCount: 0 })
    f.deps.codec.encode = () => { throw new Error('secret') }
    await assert.rejects(f.service.call({}), { code: 'INTERNAL' })
    assert.equal(f.db.chatConversations('a', {}).items.length, 0)
    assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM state WHERE key LIKE 'chat.sync.page:%'").get()!.n, 0)
    const states = f.db.db.prepare("SELECT value FROM state WHERE key LIKE 'chat.sync.service:%'").all() as {value:string}[]
    assert.equal(states.length, 1)
    assert.equal(JSON.parse(states[0]!.value).status, 'unknown')
    assert.equal(f.db.db.isTransaction, false)
  } finally { f.db.close() }
})

test('下一页预留保留 unsupported 缺口，末页仍报告 partial', async () => {
  const f = fixture()
  try {
    f.result({ mode: 'conversations', conversations: [], hasMore: true, nextAnchor: '10', unsupportedCount: 1 })
    const first = await f.service.call({})
    assert.equal(first.partial, true)
    const row = f.db.db.prepare("SELECT value FROM state WHERE key LIKE 'chat.sync.service:%'").all() as Array<{ value: string }>
    const reserved = row.map(r => JSON.parse(r.value)).find(v => v.status === 'reserved')
    assert.equal(reserved?.partial, true)
    f.result({ mode: 'conversations', conversations: [], hasMore: false, nextAnchor: null, unsupportedCount: 0 })
    const last = await f.service.call({ cursor: first.nextCursor })
    assert.equal(last.completion, 'complete')
    assert.equal(last.partial, true)
  } finally { f.db.close() }
})

test('正常多页同步到达末页后不再报告 partial', async () => {
  const f = fixture()
  try {
    f.result({ mode: 'conversations', conversations: [], hasMore: true, nextAnchor: '10', unsupportedCount: 0 })
    const first = await f.service.call({})
    assert.equal(first.partial, true)
    f.result({ mode: 'conversations', conversations: [], hasMore: false, nextAnchor: null, unsupportedCount: 0 })
    const last = await f.service.call({ cursor: first.nextCursor })
    assert.equal(last.completion, 'complete')
    assert.equal(last.partial, false)
    assert.equal(last.gapCleared, false)
  } finally { f.db.close() }
})

test('覆盖事实跨页持久累计，起始缺口不被同步期间新缺口替换', async () => {
  const { ChatGapLedger } = await import('./chat-gap-ledger.ts')
  const f = fixture()
  try {
    const ledger = new ChatGapLedger(f.db)
    ledger.ingest({ accountId: 'a', reason: 'PAGE_GAP', occurrenceId: 'start', generation: 1, scope: { scope: 'unknown' } })
    f.result({ mode: 'conversations', conversations: [], hasMore: true, nextAnchor: '10', unsupportedCount: 2 })
    const first = await f.service.call({})
    ledger.ingest({ accountId: 'a', reason: 'PAGE_GAP', occurrenceId: 'later', generation: 2, scope: { scope: 'unknown' } })
    f.result({ mode: 'conversations', conversations: [], hasMore: false, nextAnchor: null, unsupportedCount: 3 })
    const last = await createChatSyncService(f.deps).call({ cursor: first.nextCursor })
    const rows = f.db.db.prepare("SELECT value FROM state WHERE key LIKE 'chat.sync.service:%'").all() as { value: string }[]
    const state = rows.map(row => JSON.parse(row.value)).find(value => value.result?.completion === 'complete')
    assert.equal(state.coverage.unsupportedCount, 5)
    assert.equal(state.coverage.terminal, true)
    assert.equal(state.coverage.documentId, 'd')
    assert.equal(state.coverage.startGaps.lines[0].latestOccurrenceId, 'start')
    assert.equal(ledger.snapshot('a').lines[0].latestOccurrenceId, 'later')
    assert.equal(last.gapCleared, false)
    assert.equal(last.partial, true)
    assert.deepEqual(await f.service.call({ cursor: first.nextCursor }), last)
  } finally { f.db.close() }
})
