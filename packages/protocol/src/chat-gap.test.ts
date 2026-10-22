import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceGapOccurrence,
  evaluateGapClear,
  gapScopeCovers,
  isGapCoverageCertificate,
  isGapOccurrence,
  isGapScope,
  requiredGapConfirmations,
  sameGapOccurrenceIdentity,
  type GapCoverageCertificate,
  type GapOccurrence,
} from './chat-gap.ts'

const RUN_ID = '01234567-89ab-cdef-0123-456789abcdef'

function occurrence(overrides: Partial<GapOccurrence> = {}): GapOccurrence {
  return { accountId: 'acct', reason: 'PAGE_GAP', occurrenceId: 'occ-1', generation: 1, scope: { scope: 'account' }, ...overrides }
}

function certificate(overrides: Partial<GapCoverageCertificate> = {}): GapCoverageCertificate {
  return {
    runId: RUN_ID,
    accountId: 'acct',
    reason: 'PAGE_GAP',
    occurrenceId: 'occ-1',
    generation: 1,
    scope: { scope: 'account' },
    unsupported: 0,
    reliableEnd: true,
    committed: true,
    confirmations: ['host', 'outbox', 'page'],
    ...overrides,
  }
}

test('缺口 occurrence 严格校验账号、来源、代次与范围互斥', () => {
  assert.equal(isGapOccurrence(occurrence()), true)
  assert.equal(isGapOccurrence(occurrence({ scope: { scope: 'session', sessionId: 's' } })), true)
  assert.equal(isGapOccurrence(occurrence({ scope: { scope: 'unknown' } })), true)
  for (const value of [
    null, [], 'x',
    { ...occurrence(), reason: 'unknown' },
    { ...occurrence(), accountId: '' },
    { ...occurrence(), occurrenceId: ' ' },
    { ...occurrence(), generation: -1 },
    { ...occurrence(), generation: 1.5 },
    { ...occurrence(), extra: true },
    // 范围互斥：session 缺 sessionId、account/unknown 携带 sessionId 均拒绝。
    { ...occurrence(), scope: { scope: 'session' } },
    { ...occurrence(), scope: { scope: 'account', sessionId: 's' } },
    { ...occurrence(), scope: { scope: 'unknown', sessionId: 's' } },
    { ...occurrence(), scope: { scope: 'other' } },
  ]) assert.equal(isGapOccurrence(value), false)
})

test('范围校验拒绝访问器和隐藏字段，不执行调用者 getter', () => {
  assert.equal(isGapScope({ scope: 'account' }), true)
  assert.equal(isGapScope({ scope: 'account', get sessionId() { return 's' } }), false)
  let called = false
  const trapped = { get scope() { called = true; return 'account' } }
  assert.equal(isGapScope(trapped), false)
  assert.equal(called, false)
  assert.equal(isGapOccurrence(Object.defineProperty({}, 'accountId', { value: 'a' })), false)
})

test('同 occurrence 重投不推进代次，新 occurrence 即使同原因仍推进', () => {
  const first = occurrence({ occurrenceId: 'occ-1', generation: 3 })
  assert.equal(sameGapOccurrenceIdentity(first, occurrence({ occurrenceId: 'occ-1', generation: 3 })), true)
  const replay = advanceGapOccurrence(first, occurrence({ occurrenceId: 'occ-1', generation: 3 }))
  assert.equal(replay.advanced, false)
  assert.equal(replay.occurrence.generation, 3)
  // 同原因新 occurrence：代次至少推进到 current+1，且不倒退。
  const next = advanceGapOccurrence(first, occurrence({ occurrenceId: 'occ-2', generation: 1 }))
  assert.equal(next.advanced, true)
  assert.equal(next.occurrence.generation, 4)
  assert.equal(next.occurrence.occurrenceId, 'occ-2')
  assert.equal(advanceGapOccurrence(null, first).occurrence.generation, 3)
  // 返回值为副本，不共享调用者对象引用。
  assert.notEqual(advanceGapOccurrence(null, first).occurrence.scope, first.scope)
})

test('推进代次拒绝非法输入与安全整数溢出', () => {
  const base = occurrence({ occurrenceId: 'occ-1', generation: 2 })
  // 未校验输入：非法 incoming 或非法 current 失败关闭。
  assert.throws(() => advanceGapOccurrence(null, { ...base, generation: -1 }), { code: 'BAD_REQUEST' })
  assert.throws(() => advanceGapOccurrence(null, { ...base, reason: 'unknown' } as unknown as GapOccurrence), { code: 'BAD_REQUEST' })
  assert.throws(() => advanceGapOccurrence({ ...base, scope: { scope: 'session' } } as unknown as GapOccurrence, base), { code: 'BAD_REQUEST' })
  // 同来源新 occurrence 但当前代次已达上限：current+1 会溢出，拒绝而不是产生不精确数。
  const maxed = occurrence({ occurrenceId: 'occ-max', generation: Number.MAX_SAFE_INTEGER })
  assert.throws(() => advanceGapOccurrence(maxed, occurrence({ occurrenceId: 'occ-next', generation: 1 })), { code: 'BAD_REQUEST' })
  // 同 occurrence 重投不算推进，即便代次已达上限也允许原样返回。
  assert.equal(advanceGapOccurrence(maxed, occurrence({ occurrenceId: 'occ-max', generation: Number.MAX_SAFE_INTEGER })).advanced, false)
  // 不同来源是独立基线，不触发溢出判断。
  assert.equal(advanceGapOccurrence(maxed, occurrence({ occurrenceId: 'occ-next', reason: 'OUTBOX_CAPACITY', generation: 0 })).occurrence.generation, 0)
})

test('覆盖证书严格校验 runId UUID 分组、occurrenceId 绑定与确认集合', () => {
  assert.equal(isGapCoverageCertificate(certificate()), true)
  assert.equal(isGapCoverageCertificate(certificate({ scope: { scope: 'unknown' } })), true)
  assert.equal(isGapCoverageCertificate(certificate({ confirmations: [] })), true)
  for (const value of [
    null, [],
    certificate({ runId: 'not-a-run-id' }),
    // 36 个连字符不是合法 UUID 分组。
    certificate({ runId: '-'.repeat(36) }),
    certificate({ runId: '0123456789abcdef0123456789abcdef' }),
    certificate({ occurrenceId: '' }),
    certificate({ unsupported: -1 }),
    certificate({ reliableEnd: 'yes' as unknown as boolean }),
    certificate({ committed: 1 as unknown as boolean }),
    certificate({ confirmations: ['host', 'host'] }),
    certificate({ confirmations: ['host', 'unknown' as unknown as 'host'] }),
    certificate({ extra: true } as unknown as Partial<GapCoverageCertificate>),
    { ...certificate(), scope: { scope: 'session' } },
    { ...certificate(), occurrenceId: undefined } as unknown as Partial<GapCoverageCertificate>,
  ]) assert.equal(isGapCoverageCertificate(value), false)
})

test('必需确认端固定为 host/outbox/page，来源不得省略中间持久端', () => {
  assert.deepEqual(requiredGapConfirmations(), ['host', 'outbox', 'page'])
  assert.deepEqual(evaluateGapClear(occurrence(), certificate({ confirmations: ['host', 'page'] })), { clear: false, reject: ['CONFIRMATION_MISSING'] })
  assert.deepEqual(evaluateGapClear(occurrence(), certificate({ confirmations: ['host', 'outbox'] })), { clear: false, reject: ['CONFIRMATION_MISSING'] })
})

test('范围覆盖关系：未知证书不是通配证明，账号不覆盖未知，会话只覆盖同会话', () => {
  // 未知范围不是证明：未知证书不覆盖任何范围。
  assert.equal(gapScopeCovers({ scope: 'unknown' }, { scope: 'unknown' }), false)
  assert.equal(gapScopeCovers({ scope: 'unknown' }, { scope: 'account' }), false)
  assert.equal(gapScopeCovers({ scope: 'unknown' }, { scope: 'session', sessionId: 's' }), false)
  assert.equal(gapScopeCovers({ scope: 'account' }, { scope: 'unknown' }), false)
  assert.equal(gapScopeCovers({ scope: 'account' }, { scope: 'session', sessionId: 's' }), true)
  assert.equal(gapScopeCovers({ scope: 'session', sessionId: 's' }, { scope: 'session', sessionId: 's' }), true)
  assert.equal(gapScopeCovers({ scope: 'session', sessionId: 's' }, { scope: 'session', sessionId: 'other' }), false)
  assert.equal(gapScopeCovers({ scope: 'session', sessionId: 's' }, { scope: 'account' }), false)
})

test('资格判定：完整证书可清除，且来源不影响必需端集合', () => {
  assert.deepEqual(evaluateGapClear(occurrence(), certificate()), { clear: true, reject: [] })
  assert.deepEqual(evaluateGapClear(occurrence({ reason: 'OUTBOX_CAPACITY' }), certificate({ reason: 'OUTBOX_CAPACITY' })), { clear: true, reject: [] })
})

test('未知范围不可清除：未知证书不是全覆盖证明，账号/单会话证书也不足', () => {
  const unknownGap = occurrence({ scope: { scope: 'unknown' } })
  // 未知范围证书明确按未证明拒绝。
  assert.deepEqual(evaluateGapClear(unknownGap, certificate({ scope: { scope: 'unknown' } })), { clear: false, reject: ['UNKNOWN_SCOPE_UNPROVEN'] })
  // 单会话与账号证书范围不足。
  assert.deepEqual(evaluateGapClear(unknownGap, certificate({ scope: { scope: 'session', sessionId: 's' } })), { clear: false, reject: ['SCOPE_INSUFFICIENT'] })
  assert.deepEqual(evaluateGapClear(unknownGap, certificate({ scope: { scope: 'account' } })), { clear: false, reject: ['SCOPE_INSUFFICIENT'] })
  // 会话缺口只能由同会话证书或更宽范围证书清除。
  const sessionGap = occurrence({ scope: { scope: 'session', sessionId: 's' } })
  assert.deepEqual(evaluateGapClear(sessionGap, certificate({ scope: { scope: 'session', sessionId: 's' } })), { clear: true, reject: [] })
  assert.deepEqual(evaluateGapClear(sessionGap, certificate({ scope: { scope: 'session', sessionId: 'other' } })), { clear: false, reject: ['SCOPE_INSUFFICIENT'] })
  assert.deepEqual(evaluateGapClear(sessionGap, certificate({ scope: { scope: 'account' } })), { clear: true, reject: [] })
})

test('旧证书不清新缺口，且同代次不同 occurrence 拒绝清除', () => {
  const current = occurrence({ occurrenceId: 'occ-2', generation: 5 })
  // 旧代次证书不得清除新缺口；未来代次同样拒绝。
  assert.deepEqual(evaluateGapClear(current, certificate({ occurrenceId: 'occ-2', generation: 4 })), { clear: false, reject: ['GENERATION_MISMATCH'] })
  assert.deepEqual(evaluateGapClear(current, certificate({ occurrenceId: 'occ-2', generation: 6 })), { clear: false, reject: ['GENERATION_MISMATCH'] })
  // 同代次但 occurrenceId 不同（同原因新缺口）拒绝，避免误清。
  assert.deepEqual(evaluateGapClear(current, certificate({ occurrenceId: 'occ-1', generation: 5 })), { clear: false, reject: ['OCCURRENCE_MISMATCH'] })
  // 绑定一致的证书可清除。
  assert.deepEqual(evaluateGapClear(current, certificate({ occurrenceId: 'occ-2', generation: 5 })), { clear: true, reject: [] })
})

test('跨账号、未确认端与 unsupported 全部拒绝，多原因同时列出', () => {
  const current = occurrence({ occurrenceId: 'occ-2', generation: 5 })
  assert.deepEqual(evaluateGapClear(current, certificate({ generation: 5, occurrenceId: 'occ-2', accountId: 'other' })), { clear: false, reject: ['ACCOUNT_MISMATCH'] })
  assert.deepEqual(evaluateGapClear(current, certificate({ generation: 5, occurrenceId: 'occ-2', reason: 'OUTBOX_CAPACITY' })), { clear: false, reject: ['REASON_MISMATCH'] })
  assert.deepEqual(
    evaluateGapClear(current, certificate({ generation: 4, occurrenceId: 'occ-1', accountId: 'other', unsupported: 2, reliableEnd: false, committed: false, confirmations: ['host'] })),
    { clear: false, reject: ['ACCOUNT_MISMATCH', 'OCCURRENCE_MISMATCH', 'GENERATION_MISMATCH', 'UNSUPPORTED_PRESENT', 'RELIABLE_END_REQUIRED', 'COMMIT_REQUIRED', 'CONFIRMATION_MISSING'] },
  )
})

test('unsupported 非零、非可靠末页、未提交都不能清除', () => {
  assert.deepEqual(evaluateGapClear(occurrence(), certificate({ unsupported: 1 })), { clear: false, reject: ['UNSUPPORTED_PRESENT'] })
  assert.deepEqual(evaluateGapClear(occurrence(), certificate({ reliableEnd: false })), { clear: false, reject: ['RELIABLE_END_REQUIRED'] })
  assert.deepEqual(evaluateGapClear(occurrence(), certificate({ committed: false })), { clear: false, reject: ['COMMIT_REQUIRED'] })
})

test('无缺口或非法输入不解除清除资格', () => {
  assert.deepEqual(evaluateGapClear(null, certificate()), { clear: false, reject: ['NO_GAP'] })
  assert.deepEqual(evaluateGapClear(undefined, certificate()), { clear: false, reject: ['NO_GAP'] })
  assert.deepEqual(evaluateGapClear({}, certificate()), { clear: false, reject: ['GAP_INVALID'] })
  assert.deepEqual(evaluateGapClear(occurrence(), { runId: 'bad' }), { clear: false, reject: ['CERTIFICATE_INVALID'] })
  // 自称布尔值不构成授权：范围证据不足的证书即使自称已提交/已到末页仍拒绝。
  assert.deepEqual(evaluateGapClear(occurrence({ scope: { scope: 'unknown' } }), certificate({ scope: { scope: 'account' }, reliableEnd: true, committed: true })), { clear: false, reject: ['SCOPE_INSUFFICIENT'] })
})
