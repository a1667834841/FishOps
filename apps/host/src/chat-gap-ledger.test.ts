import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostDatabase } from './database.ts'
import { ChatGapLedger, createChatGapLedger } from './chat-gap-ledger.ts'
import type { GapOccurrence, GapScope } from '../../../packages/protocol/src/chat-gap.ts'

function occ(overrides: Partial<GapOccurrence> = {}): GapOccurrence {
  return { accountId: 'acct', reason: 'PAGE_GAP', occurrenceId: 'A', generation: 1, scope: { scope: 'account' }, ...overrides }
}

const INSERT_ROW = 'INSERT INTO chat_gap_ledger(account_id,reason,occurrence_id,generation,scope_kind,session_id,source_generation,recorded_at) VALUES(?,?,?,?,?,?,?,?)'

function rowCount(db: HostDatabase, accountId: string): number {
  const statement = db.db.prepare('SELECT COUNT(*) AS n FROM chat_gap_ledger WHERE account_id=?')
  statement.setReadBigInts(true)
  return Number((statement.get(accountId) as { n: bigint | number }).n)
}

/** 绕过 CHECK 约束写入损坏行，仅用于测试损坏读取路径。 */
function corruptRow(db: HostDatabase, accountId: string, occurrenceId: string, generation: bigint | number, scopeKind: string, sessionId: string | null, sourceGeneration: bigint | number): void {
  db.db.prepare(INSERT_ROW).run(accountId, 'PAGE_GAP', occurrenceId, generation, scopeKind, sessionId, sourceGeneration, 0)
}

test('真实临时 SQLite 关闭重开后保留缺口，迟到重投不回退', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gap-ledger-'))
  const path = join(dir, 'host.db')
  try {
    const first = new HostDatabase(path)
    const ledger = createChatGapLedger(first)
    assert.deepEqual(ledger.ingest(occ({ occurrenceId: 'A' })), { status: 'inserted', generation: 1, occurrenceScope: { scope: 'account' }, lineScope: { scope: 'account' } })
    assert.equal(ledger.ingest(occ({ occurrenceId: 'B', generation: 9 })).generation, 2)
    // ledger 不产生任何事件，说明尚未接入生产链路。
    assert.equal(first.events({ types: ['chat.gap'] }, 'acct').items.length, 0)
    first.close()

    const reopened = new HostDatabase(path)
    try {
      const ledgerAfter = new ChatGapLedger(reopened)
      const line = ledgerAfter.snapshot('acct').lines[0]
      assert.equal(line.generation, 2)
      assert.equal(line.occurrenceCount, 2)
      assert.equal(line.latestOccurrenceId, 'B')
      // 重开后迟到重投仍识别为同 occurrence，不推进也不回退。
      assert.deepEqual(ledgerAfter.ingest(occ({ occurrenceId: 'A' })), { status: 'duplicate', generation: 1, occurrenceScope: { scope: 'account' }, lineScope: { scope: 'account' } })
      assert.equal(ledgerAfter.snapshot('acct').lines[0].generation, 2)
      // 重开后新 occurrence 继续推进。
      assert.equal(ledgerAfter.ingest(occ({ occurrenceId: 'C' })).generation, 3)
    } finally { reopened.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('迟到重投 A→B→A 不推进、不新增、不回退', () => {
  const db = new HostDatabase(':memory:')
  try {
    const ledger = new ChatGapLedger(db)
    const lateA = occ({ occurrenceId: 'A', scope: { scope: 'session', sessionId: 's1' } })
    ledger.ingest(lateA)
    ledger.ingest(occ({ occurrenceId: 'B', scope: { scope: 'session', sessionId: 's1' } }))
    assert.deepEqual(ledger.ingest(lateA), { status: 'duplicate', generation: 1, occurrenceScope: { scope: 'session', sessionId: 's1' }, lineScope: { scope: 'session', sessionId: 's1' } })
    const line = ledger.snapshot('acct').lines[0]
    assert.equal(line.generation, 2)
    assert.equal(line.occurrenceCount, 2)
    assert.equal(line.latestOccurrenceId, 'B')
    assert.deepEqual(line.scope, { scope: 'session', sessionId: 's1' })
  } finally { db.close() }
})

test('ingest 区分单条 occurrenceScope 与线内聚合 lineScope', () => {
  const db = new HostDatabase(':memory:')
  try {
    const ledger = new ChatGapLedger(db)
    assert.deepEqual(ledger.ingest(occ({ occurrenceId: 'o1', scope: { scope: 'session', sessionId: 's1' } })).lineScope, { scope: 'session', sessionId: 's1' })
    const second = ledger.ingest(occ({ occurrenceId: 'o2', scope: { scope: 'session', sessionId: 's2' } }))
    // 本条范围仍是 s2，但线内已合并为 unknown，两者必须可区分。
    assert.deepEqual(second.occurrenceScope, { scope: 'session', sessionId: 's2' })
    assert.deepEqual(second.lineScope, { scope: 'unknown' })
    assert.deepEqual(ledger.snapshot('acct').lines[0].scope, { scope: 'unknown' })
  } finally { db.close() }
})

test('账号与来源相互隔离，同 occurrenceId 跨账号不冲突', () => {
  const db = new HostDatabase(':memory:')
  try {
    const ledger = new ChatGapLedger(db)
    ledger.ingest(occ({ accountId: 'a', occurrenceId: 'X' }))
    ledger.ingest(occ({ accountId: 'b', occurrenceId: 'X' }))
    ledger.ingest(occ({ accountId: 'a', reason: 'OUTBOX_CAPACITY', occurrenceId: 'X' }))
    assert.deepEqual(ledger.snapshot('a').lines.map(line => [line.reason, line.generation]), [['OUTBOX_CAPACITY', 1], ['PAGE_GAP', 1]])
    assert.deepEqual(ledger.snapshot('b').lines.map(line => [line.reason, line.generation]), [['PAGE_GAP', 1]])
    assert.deepEqual(ledger.snapshot('c'), { accountId: 'c', lines: [] })
    assert.throws(() => ledger.snapshot(''), { code: 'BAD_REQUEST' })
  } finally { db.close() }
})

test('范围保守合并：同会话保持，不同会话或 unknown 变 unknown', () => {
  const cases: Array<{ scopes: GapScope[]; expected: GapScope }> = [
    { scopes: [{ scope: 'session', sessionId: 's1' }, { scope: 'session', sessionId: 's1' }], expected: { scope: 'session', sessionId: 's1' } },
    { scopes: [{ scope: 'session', sessionId: 's1' }, { scope: 'session', sessionId: 's2' }], expected: { scope: 'unknown' } },
    { scopes: [{ scope: 'account' }, { scope: 'account' }], expected: { scope: 'account' } },
    // 账号范围与会话范围混合没有可证明的边界，保守为 unknown。
    { scopes: [{ scope: 'account' }, { scope: 'session', sessionId: 's1' }], expected: { scope: 'unknown' } },
    { scopes: [{ scope: 'unknown' }, { scope: 'session', sessionId: 's1' }], expected: { scope: 'unknown' } },
    { scopes: [{ scope: 'unknown' }, { scope: 'account' }], expected: { scope: 'unknown' } },
  ]
  for (const { scopes, expected } of cases) {
    const db = new HostDatabase(':memory:')
    try {
      const ledger = new ChatGapLedger(db)
      scopes.forEach((scope, index) => ledger.ingest(occ({ occurrenceId: `o${index}`, scope })))
      const line = ledger.snapshot('acct').lines[0]
      assert.deepEqual(line.scope, expected, JSON.stringify(scopes))
      assert.equal(line.occurrenceCount, scopes.length)
      assert.equal(line.generation, scopes.length)
    } finally { db.close() }
  }
})

test('同 occurrence 内容冲突拒绝并回滚，不推进代次', () => {
  const db = new HostDatabase(':memory:')
  try {
    const ledger = new ChatGapLedger(db)
    ledger.ingest(occ({ occurrenceId: 'A', scope: { scope: 'session', sessionId: 's1' } }))
    // 相同 occurrenceId 但范围冲突。
    assert.throws(() => ledger.ingest(occ({ occurrenceId: 'A', scope: { scope: 'session', sessionId: 's2' } })), { code: 'BAD_REQUEST' })
    // 相同 occurrenceId 但来源代次冲突。
    assert.throws(() => ledger.ingest(occ({ occurrenceId: 'A', generation: 7, scope: { scope: 'session', sessionId: 's1' } })), { code: 'BAD_REQUEST' })
    const line = ledger.snapshot('acct').lines[0]
    assert.equal(line.generation, 1)
    assert.equal(line.occurrenceCount, 1)
    assert.deepEqual(line.scope, { scope: 'session', sessionId: 's1' })
    // 冲突后事务已回滚，账本仍可继续接受新 occurrence。
    assert.equal(ledger.ingest(occ({ occurrenceId: 'B' })).generation, 2)
    assert.equal(ledger.snapshot('acct').lines[0].occurrenceCount, 2)
  } finally { db.close() }
})

test('代次溢出拒绝且不丢既有标记', () => {
  const db = new HostDatabase(':memory:')
  try {
    const ledger = new ChatGapLedger(db)
    ledger.ingest(occ({ occurrenceId: 'A' }))
    // 直接落一条已达安全整数上限的标记，模拟历史/异常数据。
    corruptRow(db, 'acct', 'maxed', Number.MAX_SAFE_INTEGER, 'account', null, 1)
    assert.throws(() => ledger.ingest(occ({ occurrenceId: 'next' })), { code: 'BAD_REQUEST' })
    // 拒绝后既有标记与代次保持不变，未被删除或回退。
    const line = ledger.snapshot('acct').lines[0]
    assert.equal(line.generation, Number.MAX_SAFE_INTEGER)
    assert.equal(line.occurrenceCount, 2)
    // 其他账号不受影响。
    assert.equal(ledger.ingest(occ({ accountId: 'other', occurrenceId: 'x' })).generation, 1)
  } finally { db.close() }
})

test('损坏范围字段统一 INTERNAL：非法 scope_kind、空 session_id、非会话携带 session_id', () => {
  const db = new HostDatabase(':memory:')
  try {
    const ledger = new ChatGapLedger(db)
    ledger.ingest(occ({ accountId: 'keep', occurrenceId: 'ok' }))
    db.db.exec('PRAGMA ignore_check_constraints=ON')
    corruptRow(db, 'acct', 'bad-kind', 1, 'bogus', null, 1)
    corruptRow(db, 'acct', 'bad-session-null', 1, 'session', null, 1)
    corruptRow(db, 'acct', 'bad-session-empty', 1, 'session', '', 1)
    corruptRow(db, 'acct', 'bad-extra-session', 1, 'account', 's', 1)
    corruptRow(db, 'acct', 'bad-unknown-session', 1, 'unknown', 's', 1)
    db.db.exec('PRAGMA ignore_check_constraints=OFF')
    // 任一行损坏即失败关闭，不默认成 unknown、不把 null 变成字符串。
    assert.throws(() => ledger.snapshot('acct'), { code: 'INTERNAL' })
    assert.throws(() => ledger.ingest(occ({ occurrenceId: 'fresh' })), { code: 'INTERNAL' })
    // 账号隔离：其他账号读取不受影响。
    assert.deepEqual(ledger.snapshot('keep').lines.map(line => line.reason), ['PAGE_GAP'])
  } finally { db.close() }
})

test('损坏代次与来源代次统一 INTERNAL，ingest 零新增且保留原状态', () => {
  const db = new HostDatabase(':memory:')
  try {
    const ledger = new ChatGapLedger(db)
    ledger.ingest(occ({ accountId: 'acct', occurrenceId: 'A' }))
    const before = rowCount(db, 'acct')
    db.db.exec('PRAGMA ignore_check_constraints=ON')
    corruptRow(db, 'acct', 'bad-high', BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'account', null, 1)
    corruptRow(db, 'acct', 'bad-zero', 0, 'account', null, 1)
    corruptRow(db, 'acct', 'bad-negative', -5, 'account', null, 1)
    corruptRow(db, 'acct', 'bad-source-negative', 4, 'account', null, -1)
    corruptRow(db, 'acct', 'bad-source-high', 5, 'account', null, BigInt(Number.MAX_SAFE_INTEGER) + 1n)
    db.db.exec('PRAGMA ignore_check_constraints=OFF')
    assert.throws(() => ledger.snapshot('acct'), { code: 'INTERNAL' })
    // ingest 读取到损坏行必须失败关闭：零新增，且保留原有记录（含合法行与损坏行）。
    assert.throws(() => ledger.ingest(occ({ accountId: 'acct', occurrenceId: 'fresh' })), { code: 'INTERNAL' })
    assert.equal(rowCount(db, 'acct'), before + 5)
    const kept = db.db.prepare("SELECT COUNT(*) AS n FROM chat_gap_ledger WHERE account_id='acct' AND occurrence_id='A'").get() as { n: number | bigint }
    assert.equal(Number(kept.n), 1)
    // 其他账号不受影响的 ingest 仍可推进。
    assert.equal(ledger.ingest(occ({ accountId: 'other', occurrenceId: 'x' })).generation, 1)
  } finally { db.close() }
})

test('非法 occurrence 与非法账号被拒绝，不写入任何记录', () => {
  const db = new HostDatabase(':memory:')
  try {
    const ledger = new ChatGapLedger(db)
    assert.throws(() => ledger.ingest({ ...occ(), reason: 'unknown' } as unknown as GapOccurrence), { code: 'BAD_REQUEST' })
    assert.throws(() => ledger.ingest({ ...occ(), occurrenceId: '' } as unknown as GapOccurrence), { code: 'BAD_REQUEST' })
    assert.throws(() => ledger.ingest({ ...occ(), scope: { scope: 'account', sessionId: 's' } } as unknown as GapOccurrence), { code: 'BAD_REQUEST' })
    assert.deepEqual(ledger.snapshot('acct'), { accountId: 'acct', lines: [] })
  } finally { db.close() }
})
