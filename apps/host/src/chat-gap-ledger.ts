/**
 * M3 缺口持久 ledger（Host 侧）：独立表记录缺口 occurrence，跨重启保留。
 *
 * 边界（当前阶段明确不做的事）：
 * - 只做 ingest 与只读 snapshot；生产 native 缺口回调已接入，**不提供 clear**，不注册公共路由，
 *   不删除现有 state 的缺口标记。
 * - 代次由本 ledger 持久分配：同一（账号,来源）线内的新 occurrence 取“当前最大代次 + 1”。
 *   occurrence 自带的 generation 只作为“来源事实”记录（source_generation），
 *   不作为 Host 全局序号，也不参与主机代次计算。
 * - 去重按账号、来源、occurrenceId 做全历史去重；迟到重投不再推进也不回退。
 * - 复用协议层 `isGapOccurrence` 校验；范围合并保守：不同会话或出现任一 unknown 即合并为 unknown。
 * - 所有从表中读出的原始行都严格校验；任何字段损坏统一按 INTERNAL 失败关闭，
 *   既不默认成 unknown，也不把空 session_id 转成字符串。
 */
import { isGapOccurrence, isGapScope, type GapOccurrence, type GapReason, type GapScope } from '../../../packages/protocol/src/chat-gap.ts'
import type { HostDatabase } from './database.ts'

/** 单条（账号,来源）线上的聚合视图；scope 是该线所有 occurrence 的保守合并结果。 */
export type GapLedgerLine = {
  reason: GapReason
  generation: number
  scope: GapScope
  occurrenceCount: number
  latestOccurrenceId: string
}

/** 账号隔离快照；只包含指定账号的缺口线。 */
export type GapLedgerSnapshot = { accountId: string; lines: GapLedgerLine[] }

/**
 * ingest 结果。注意区分两个范围：
 * - `occurrenceScope`：本次 occurrence 自身的范围。
 * - `lineScope`：本次写入后该（账号,来源）线**保守合并**后的聚合范围。
 * `generation`：`inserted` 时为本 occurrence 新分配到的线代次；`duplicate` 时为该 occurrence 已持久化的代次。
 * `status='duplicate'` 表示同 occurrence 重投，未改变任何持久状态。
 */
export type GapIngestResult = {
  status: 'inserted' | 'duplicate'
  generation: number
  occurrenceScope: GapScope
  lineScope: GapScope
}

/** 已校验的行；生成号与来源代次都已收敛为安全整数。 */
type LedgerRow = {
  reason: GapReason
  occurrenceId: string
  generation: number
  scope: GapScope
  sourceGeneration: number
}

const MAX_GENERATION = Number.MAX_SAFE_INTEGER
const MAX_GENERATION_BIG = BigInt(Number.MAX_SAFE_INTEGER)

const LEDGER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_gap_ledger(
    account_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    occurrence_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    scope_kind TEXT NOT NULL CHECK(scope_kind IN ('unknown','account','session')),
    session_id TEXT,
    source_generation INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    CHECK((scope_kind='session' AND session_id IS NOT NULL) OR (scope_kind<>'session' AND session_id IS NULL)),
    PRIMARY KEY(account_id,reason,occurrence_id)
  );
  CREATE INDEX IF NOT EXISTS chat_gap_ledger_line ON chat_gap_ledger(account_id,reason,generation);`

function bad(message: string): never {
  throw Object.assign(new Error(message), { code: 'BAD_REQUEST' })
}

/** 账本记录损坏；所有读取路径的损坏统一走这里，失败关闭而不是猜测字段。 */
function internal(message: string): never {
  throw Object.assign(new Error(message), { code: 'INTERNAL' })
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

function cloneScope(scope: GapScope): GapScope {
  return scope.scope === 'session' ? { scope: 'session', sessionId: scope.sessionId } : { scope: scope.scope }
}

function scopeEquals(left: GapScope, right: GapScope): boolean {
  return left.scope === right.scope && (left.scope !== 'session' || right.scope !== 'session' || left.sessionId === right.sessionId)
}

/**
 * 保守合并范围：同一会话保持会话；同为账号范围保持账号；
 * 出现任一 unknown、或不同会话、或账号与会话混合时，一律退化为 unknown。
 */
function mergeScope(current: GapScope, next: GapScope): GapScope {
  if (current.scope === 'unknown' || next.scope === 'unknown') return { scope: 'unknown' }
  if (current.scope === 'session' && next.scope === 'session' && current.sessionId === next.sessionId) return { scope: 'session', sessionId: current.sessionId }
  if (current.scope === 'account' && next.scope === 'account') return { scope: 'account' }
  return { scope: 'unknown' }
}

/**
 * 将读出的整数值收敛为安全整数；BigInt 先做范围判断再转 Number，避免精度丢失。
 * 非整数、超出 [min, MAX_SAFE_INTEGER] 都视为损坏。
 */
function toSafeInt(value: unknown, min: number, field: string): number {
  let big: bigint
  if (typeof value === 'bigint') big = value
  else if (typeof value === 'number' && Number.isSafeInteger(value)) big = BigInt(value)
  else return internal(`缺口账本 ${field} 非法`)
  if (big < BigInt(min) || big > MAX_GENERATION_BIG) internal(`缺口账本 ${field} 超出安全范围`)
  return Number(big)
}

/** 严格校验一条原始行；未知 scope_kind、空 session_id、越界代次一律按损坏拒绝。 */
function decodeRow(raw: Record<string, unknown>): LedgerRow {
  const kind = raw.scope_kind
  if (kind !== 'unknown' && kind !== 'account' && kind !== 'session') internal('缺口账本范围类型非法')
  if (raw.reason !== 'PAGE_GAP' && raw.reason !== 'OUTBOX_CAPACITY') internal('缺口账本来源非法')
  if (!validId(raw.occurrence_id)) internal('缺口账本 occurrenceId 非法')
  let scope: GapScope
  if (kind === 'session') {
    if (!validId(raw.session_id)) internal('缺口账本会话范围缺少 sessionId')
    scope = { scope: 'session', sessionId: raw.session_id }
  } else {
    if (raw.session_id !== null && raw.session_id !== undefined) internal('缺口账本非会话范围携带 sessionId')
    scope = { scope: kind }
  }
  if (!isGapScope(scope)) internal('缺口账本范围非法')
  return {
    reason: raw.reason,
    occurrenceId: raw.occurrence_id,
    generation: toSafeInt(raw.generation, 1, 'generation'),
    scope,
    sourceGeneration: toSafeInt(raw.source_generation, 0, 'source_generation'),
  }
}

const ROW_COLUMNS = 'reason,occurrence_id,generation,source_generation,scope_kind,session_id'

/**
 * 缺口 ledger：基于既有 HostDatabase 连接，使用独立表 additive 建表，不触碰其他表。
 * 构造时只做 `CREATE TABLE IF NOT EXISTS`，不迁移、不修改既有 state。
 */
export class ChatGapLedger {
  #db: HostDatabase

  constructor(db: HostDatabase) {
    this.#db = db
    db.db.exec(LEDGER_SCHEMA)
  }

  #row(accountId: string, reason: GapReason, occurrenceId: string): LedgerRow | null {
    const statement = this.#db.db.prepare(`SELECT ${ROW_COLUMNS} FROM chat_gap_ledger WHERE account_id=? AND reason=? AND occurrence_id=?`)
    statement.setReadBigInts(true)
    const raw = statement.get(accountId, reason, occurrenceId) as Record<string, unknown> | undefined
    return raw === undefined ? null : decodeRow(raw)
  }

  #lineRows(accountId: string, reason: GapReason): LedgerRow[] {
    const statement = this.#db.db.prepare(`SELECT ${ROW_COLUMNS} FROM chat_gap_ledger WHERE account_id=? AND reason=? ORDER BY generation`)
    statement.setReadBigInts(true)
    return (statement.all(accountId, reason) as Array<Record<string, unknown>>).map(decodeRow)
  }

  /** 读取该线最大代次；损坏（负值、非整数、超过安全整数）统一 INTERNAL。 */
  #lineMax(accountId: string, reason: GapReason): number | null {
    const statement = this.#db.db.prepare('SELECT MAX(generation) AS max FROM chat_gap_ledger WHERE account_id=? AND reason=?')
    statement.setReadBigInts(true)
    const row = statement.get(accountId, reason) as { max: unknown }
    if (row?.max === null || row?.max === undefined) return null
    return toSafeInt(row.max, 1, 'generation')
  }

  /** 该线保守合并后的聚合范围；空线按损坏拒绝。 */
  #lineScope(accountId: string, reason: GapReason): GapScope {
    const rows = this.#lineRows(accountId, reason)
    if (rows.length === 0) internal('缺口账本状态异常：线内无记录')
    let scope = cloneScope(rows[0].scope)
    for (let index = 1; index < rows.length; index++) scope = mergeScope(scope, rows[index].scope)
    return scope
  }

  /**
   * 记录一次缺口 occurrence。
   * - 同（账号,来源,occurrenceId）已存在且内容一致：幂等重投，返回 duplicate，不推进代次。
   * - 同 occurrenceId 但内容（范围或来源代次）冲突：拒绝，事务回滚。
   * - 新 occurrence：在事务内按线最大代次 + 1 推进并保守合并范围；代次已达安全整数上限时拒绝且不丢既有标记。
   * - 任何读取到的损坏行都会在提交前触发 INTERNAL 回滚，保证零新增且保留原状态。
   */
  ingest(occurrence: GapOccurrence): GapIngestResult {
    if (!isGapOccurrence(occurrence)) bad('缺口 occurrence 无效')
    const ownsTransaction = !this.#db.db.isTransaction
    if (ownsTransaction) this.#db.db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#row(occurrence.accountId, occurrence.reason, occurrence.occurrenceId)
      if (existing) {
        if (!scopeEquals(existing.scope, occurrence.scope) || existing.sourceGeneration !== occurrence.generation) bad('缺口 occurrence 内容冲突')
        const lineScope = this.#lineScope(occurrence.accountId, occurrence.reason)
        if (ownsTransaction) this.#db.db.exec('COMMIT')
        return { status: 'duplicate', generation: existing.generation, occurrenceScope: cloneScope(existing.scope), lineScope }
      }
      const maxGeneration = this.#lineMax(occurrence.accountId, occurrence.reason)
      // 上限代次无法再加一，拒绝而不是写入不精确数；事务回滚保证既有标记不丢。
      if (maxGeneration === MAX_GENERATION) bad('缺口代次已达上限，无法推进')
      const generation = maxGeneration === null ? 1 : maxGeneration + 1
      this.#db.db.prepare('INSERT INTO chat_gap_ledger(account_id,reason,occurrence_id,generation,scope_kind,session_id,source_generation,recorded_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(occurrence.accountId, occurrence.reason, occurrence.occurrenceId, generation, occurrence.scope.scope, occurrence.scope.scope === 'session' ? occurrence.scope.sessionId : null, occurrence.generation, Date.now())
      // 聚合范围必须在提交前算出：若写入后才发现同行存在损坏记录，异常会回滚本次插入。
      const lineScope = this.#lineScope(occurrence.accountId, occurrence.reason)
      if (ownsTransaction) this.#db.db.exec('COMMIT')
      return { status: 'inserted', generation, occurrenceScope: cloneScope(occurrence.scope), lineScope }
    } catch (error) {
      if (ownsTransaction) this.#db.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 只读快照；严格按账号隔离，绝不返回其他账号的缺口；任一行损坏即 INTERNAL。 */
  snapshot(accountId: string): GapLedgerSnapshot {
    if (!validId(accountId)) bad('账号无效')
    const statement = this.#db.db.prepare(`SELECT ${ROW_COLUMNS} FROM chat_gap_ledger WHERE account_id=? ORDER BY reason,generation`)
    statement.setReadBigInts(true)
    const rows = (statement.all(accountId) as Array<Record<string, unknown>>).map(decodeRow)
    const lines: GapLedgerLine[] = []
    let current: GapLedgerLine | null = null
    for (const row of rows) {
      if (current === null || current.reason !== row.reason) {
        current = { reason: row.reason, generation: row.generation, scope: cloneScope(row.scope), occurrenceCount: 1, latestOccurrenceId: row.occurrenceId }
        lines.push(current)
        continue
      }
      current.generation = row.generation
      current.scope = mergeScope(current.scope, row.scope)
      current.occurrenceCount += 1
      current.latestOccurrenceId = row.occurrenceId
    }
    return { accountId, lines }
  }
}

/** 工厂：在既有 HostDatabase 连接上创建缺口 ledger。 */
export function createChatGapLedger(db: HostDatabase): ChatGapLedger {
  return new ChatGapLedger(db)
}
