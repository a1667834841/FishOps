import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChatOutbox, type OutboxState } from '../chat-outbox.ts'

function fixture() {
  let saved: OutboxState | undefined
  let fail = false
  const storage = { read: async () => structuredClone(saved), write: async (state: OutboxState) => { if (fail) throw new Error('disk'); saved = structuredClone(state) } }
  return { storage, setFail: (value: boolean) => { fail = value } }
}
const entry = { accountId: 'a', sourceId: 'message-1', payload: { sourceId: 'message-1', sessionId: 'session', senderId: 'sender', text: '测试', sentAt: 0 } }

test('先持久化、重复去重、重启恢复、按账号确认', async () => {
  const f = fixture(), box = new ChatOutbox(f.storage)
  assert.deepEqual(await Promise.all([box.enqueue(entry), box.enqueue(entry)]), ['stored', 'duplicate'])
  await box.enqueue({ ...entry, accountId: 'b' })
  const restored = new ChatOutbox(f.storage)
  await restored.acknowledge('a', entry.sourceId)
  assert.equal((await restored.snapshot('a')).entries.length, 0)
  assert.equal((await restored.snapshot('b')).entries.length, 1)
})

test('写入和ACK失败保留原状态，后续操作仍可恢复', async () => {
  const f = fixture(), box = new ChatOutbox(f.storage)
  f.setFail(true)
  await assert.rejects(box.enqueue(entry))
  assert.equal((await box.snapshot('a')).entries.length, 0)
  f.setFail(false)
  await box.enqueue(entry)
  f.setFail(true)
  await assert.rejects(box.acknowledge('a', entry.sourceId))
  assert.equal((await box.snapshot('a')).entries.length, 1)
  f.setFail(false)
  await box.acknowledge('a', entry.sourceId)
  assert.equal((await box.snapshot('a')).entries.length, 0)
})

test('满队列不驱逐消息，缺口跨重启保留，读取快照不泄漏引用', async () => {
  const f = fixture(), box = new ChatOutbox(f.storage)
  for (let n = 0; n < 1000; n++) assert.equal(await box.enqueue({ ...entry, sourceId: String(n), payload: { ...entry.payload, sourceId: String(n) } }), 'stored')
  assert.equal(await box.enqueue({ ...entry, sourceId: 'overflow', payload: { ...entry.payload, sourceId: 'overflow' } }), 'gap')
  const restored = new ChatOutbox(f.storage), view = await restored.snapshot('a')
  assert.equal(view.entries.length, 1000)
  assert.equal(view.syncRequired, true)
  view.entries.length = 0
  assert.equal((await restored.snapshot('a')).entries.length, 1000)
  assert.deepEqual(await restored.snapshot('b'), { entries: [], syncRequired: false })
})

test('非法状态失败关闭，不把损坏队列当成空队列', async () => {
  const box = new ChatOutbox({ read: async () => ({ version: 2 }), write: async () => {} })
  await assert.rejects(box.snapshot('a'), /OUTBOX_INVALID/)
  await assert.rejects(new ChatOutbox(fixture().storage).enqueue({ ...entry, accountId: '' }), /OUTBOX_INPUT/)
})

test('字节上限先于条数上限生效，缺口仍可持久保存', async () => {
  const f = fixture(), box = new ChatOutbox(f.storage)
  let count = 0
  for (; count < 1000; count++) {
    const result = await box.enqueue({ ...entry, sourceId: String(count), payload: { ...entry.payload, sourceId: String(count), text: '中'.repeat(20000) } })
    if (result === 'gap') break
  }
  assert.ok(count > 0 && count < 1000)
  const state = await new ChatOutbox(f.storage).snapshot('a')
  assert.equal(state.entries.length, count)
  assert.equal(state.syncRequired, true)
})


test('损坏 payload、来源不匹配与重复持久键加载时失败关闭', async () => {
  for (const entries of [
    [{ ...entry, payload: {} }],
    [{ ...entry, payload: { ...entry.payload, sourceId: 'other' } }],
    [entry, entry],
  ]) {
    const box = new ChatOutbox({ read: async () => ({ version: 1, entries, gaps: [] }), write: async () => { assert.fail('不得覆盖损坏存储') } })
    await assert.rejects(box.snapshot('a'), /OUTBOX_INVALID/)
  }
})

test('同来源异内容显式冲突且保留原数据，字段顺序不影响重复判定', async () => {
  const box = new ChatOutbox(fixture().storage)
  await box.enqueue(entry)
  await assert.rejects(box.enqueue({ ...entry, payload: { ...entry.payload, text: '不同正文' } }), /OUTBOX_CONFLICT/)
  assert.deepEqual((await box.snapshot('a')).entries, [entry])
  const { text, ...rest } = entry.payload
  assert.equal(await box.enqueue({ ...entry, payload: { text, ...rest } }), 'duplicate')
})

test('消息 JSON 恰好64KiB可入队，信封只计入总容量', async () => {
  let text = '\u0000'.repeat(9000) + '中'.repeat(3000)
  const payload = { ...entry.payload, text }
  text += 'a'.repeat(65536 - new TextEncoder().encode(JSON.stringify(payload)).length)
  payload.text = text
  assert.equal(new TextEncoder().encode(JSON.stringify(payload)).length, 65536)
  const box = new ChatOutbox(fixture().storage)
  assert.equal(await box.enqueue({ ...entry, payload }), 'stored')
})

test('页面缺口持久化并跨重启保留原因，旧格式容量缺口仍可读', async () => {
  const f = fixture(), box = new ChatOutbox(f.storage)
  await box.markGap('a')
  assert.deepEqual(await new ChatOutbox(f.storage).snapshot('a'), { entries: [], syncRequired: true, gapReason: 'PAGE_GAP' })
  const legacy = new ChatOutbox({ read: async () => ({ version: 1, entries: [], gaps: ['b'] }), write: async () => {} })
  assert.equal((await legacy.snapshot('b')).gapReason, 'OUTBOX_CAPACITY')
  f.setFail(true)
  await assert.rejects(box.markGap('b'))
  assert.equal((await box.snapshot('b')).syncRequired, false)
})

test('稳定缺口先持久化，重建重投去重且账号隔离', async () => {
  const f = fixture(), box = new ChatOutbox(f.storage)
  const gap = { accountId: 'a', reason: 'PAGE_GAP' as const, occurrenceId: 'doc-event-1', generation: 1, scope: { scope: 'session' as const, sessionId: 's' } }
  assert.equal(await box.recordGap(gap), 'stored')
  const restored = new ChatOutbox(f.storage)
  assert.equal(await restored.recordGap(gap), 'duplicate')
  assert.deepEqual(await restored.gapOccurrences('a'), [gap])
  assert.deepEqual(await restored.gapOccurrences('b'), [])
  const view = await restored.gapOccurrences('a'); view[0]!.occurrenceId = 'tampered'
  assert.equal((await restored.gapOccurrences('a'))[0]!.occurrenceId, gap.occurrenceId)
  await assert.rejects(restored.recordGap({ ...gap, generation: 2 }), /OUTBOX_CONFLICT/)
  assert.equal((await restored.gapOccurrences('a')).length, 1)
})

test('稳定缺口写入失败不污染内存，旧格式标记不清除', async () => {
  const f = fixture(), box = new ChatOutbox(f.storage)
  await box.markGap('legacy')
  const gap = { accountId: 'a', reason: 'PAGE_GAP' as const, occurrenceId: 'event', generation: 1, scope: { scope: 'unknown' as const } }
  f.setFail(true)
  await assert.rejects(box.recordGap(gap))
  assert.deepEqual(await box.gapOccurrences('a'), [])
  assert.equal((await box.snapshot('legacy')).syncRequired, true)
  f.setFail(false)
  await box.recordGap(gap)
  assert.equal((await new ChatOutbox(f.storage).gapOccurrences('a')).length, 1)
})

test('容量丢失身份在重建与重投后稳定，新丢失推进代次', async () => {
  const full = Array.from({ length: 1000 }, (_, n) => ({ ...entry, sourceId: String(n), payload: { ...entry.payload, sourceId: String(n) } }))
  let saved: OutboxState = { version: 1, entries: full, gaps: [] }
  const storage = { read: async () => structuredClone(saved), write: async (value: OutboxState) => { saved = structuredClone(value) } }
  const loss = { ...entry, sourceId: 'lost', payload: { ...entry.payload, sourceId: 'lost' } }
  assert.equal(await new ChatOutbox(storage).enqueue(loss), 'gap')
  const first = await new ChatOutbox(storage).gapOccurrences('a')
  assert.equal(first.length, 1)
  assert.equal(first[0].generation, 1)
  assert.equal(await new ChatOutbox(storage).enqueue(loss), 'gap')
  assert.deepEqual(await new ChatOutbox(storage).gapOccurrences('a'), first)
  await assert.rejects(new ChatOutbox(storage).enqueue({ ...loss, payload: { ...loss.payload, text: '冲突' } }), /OUTBOX_CONFLICT/)
  await new ChatOutbox(storage).enqueue({ ...entry, sourceId: 'lost2', payload: { ...entry.payload, sourceId: 'lost2' } })
  assert.equal((await new ChatOutbox(storage).gapOccurrences('a'))[1].generation, 2)
  await new ChatOutbox(storage).enqueue({ ...loss, accountId: 'b' })
  assert.equal((await new ChatOutbox(storage).gapOccurrences('b'))[0].generation, 1)
  assert.equal(saved.entries.length, 1000)
})

test('损坏丢失摘要失败关闭，不把损坏身份当成可重投证据', async () => {
  const occurrence = { accountId: 'a', reason: 'OUTBOX_CAPACITY', occurrenceId: 'loss', generation: 1, scope: { scope: 'session', sessionId: 'session' } }
  const raw = { version: 1, entries: [], gaps: ['a'], occurrences: [occurrence], losses: [{ accountId: 'a', sourceId: 'lost', occurrenceId: 'loss', fingerprint: '' }] }
  let writes = 0
  const box = new ChatOutbox({ read: async () => raw, write: async () => { writes++ } })
  await assert.rejects(box.snapshot('a'), /OUTBOX_INVALID/)
  assert.equal(writes, 0)
})

test('缺口元数据耗尽拒绝新丢失且不驱逐原队列，已有丢失仍可重投', async () => {
  const full = Array.from({ length: 1000 }, (_, n) => ({ ...entry, sourceId: String(n), payload: { ...entry.payload, sourceId: String(n) } }))
  let saved: OutboxState = { version: 1, entries: full, gaps: ['a'], occurrences: Array.from({ length: 511 }, (_, n) => ({ accountId: 'a', reason: 'OUTBOX_CAPACITY', occurrenceId: `loss-${n}`, generation: n + 1, scope: { scope: 'session', sessionId: 'session' } })) }
  let fail = true
  const storage = { read: async () => structuredClone(saved), write: async (value: OutboxState) => { if (fail) throw new Error('disk'); saved = structuredClone(value) } }
  const lost = { ...entry, sourceId: 'last', payload: { ...entry.payload, sourceId: 'last' } }
  const box = new ChatOutbox(storage)
  await assert.rejects(box.enqueue(lost), /disk/)
  assert.equal((await box.gapOccurrences('a')).length, 511)
  fail = false
  assert.equal(await box.enqueue(lost), 'gap')
  const snapshot = structuredClone(saved)
  assert.equal(await new ChatOutbox(storage).enqueue(lost), 'gap')
  await assert.rejects(new ChatOutbox(storage).enqueue({ ...entry, sourceId: 'beyond', payload: { ...entry.payload, sourceId: 'beyond' } }), /OUTBOX_GAP_CAPACITY/)
  assert.deepEqual(saved, snapshot)
  assert.equal(saved.entries.length, 1000)
})

test('新身份不生成旧标记，旧状态与显式旧通知仍保守保留', async () => {
  const f = fixture(), box = new ChatOutbox(f.storage)
  await box.recordGap({ accountId: 'a', reason: 'PAGE_GAP', occurrenceId: 'new', generation: 1, scope: { scope: 'unknown' } })
  assert.equal(await box.legacyGapRequired('a'), false)
  assert.equal(await new ChatOutbox(f.storage).legacyGapRequired('a'), false)
  await box.markGap('a')
  assert.equal(await new ChatOutbox(f.storage).legacyGapRequired('a'), true)
  const legacy = new ChatOutbox({ read: async () => ({ version: 1, entries: [], gaps: ['b'] }), write: async () => {} })
  assert.equal(await legacy.legacyGapRequired('b'), true)
  assert.equal(await legacy.legacyGapRequired('a'), false)
})
