/**
 * 发布诊断时间线记录器单测（安全、有界、可持久化）。
 *
 * 覆盖：
 * 1. 时间线长度有界：超出上限丢弃最旧记录并累加 `dropped`，绝不无限增长；
 * 2. `code` 白名单：URL / token 等原文形态被过滤，只保留结构化枚举；
 * 3. `counters` / `flags` 严格类型过滤；
 * 4. `readDiagnosticsFromMeta` 续接与非法输入兜底；
 * 5. `snapshotDiagnostics` 深拷贝隔离；
 * 6. `result` 阶段去重（同一任务只保留最后一条结论）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PUBLISH_DIAG_TIMELINE_LIMIT } from '@fishops/shared'
import {
  appendDiagStage,
  beginDiagStage,
  createDiagnostics,
  endDiagStage,
  readDiagnosticsFromMeta,
  sanitizeDiagCode,
  setResultStage,
  snapshotDiagnostics,
} from '../diagnostics'

test('diagnostics: 时间线长度有界，超出丢弃最旧记录并累加 dropped', () => {
  const diag = createDiagnostics()
  for (let i = 0; i < PUBLISH_DIAG_TIMELINE_LIMIT + 5; i++) {
    appendDiagStage(diag, 'fields', 'ok', i, { counters: { seq: i } })
  }
  assert.equal(diag.timeline.length, PUBLISH_DIAG_TIMELINE_LIMIT)
  assert.equal(diag.dropped, 5)
  // 最旧 5 条已丢弃，第一条应为 seq=5
  assert.equal(diag.timeline[0]?.counters?.seq, 5)
  assert.equal(
    diag.timeline[diag.timeline.length - 1]?.counters?.seq,
    PUBLISH_DIAG_TIMELINE_LIMIT + 4,
  )
})

test('diagnostics: code 白名单过滤 URL / token 等原文形态', () => {
  assert.equal(sanitizeDiagCode('SUBMIT_BUTTON_NOT_FOUND'), 'SUBMIT_BUTTON_NOT_FOUND')
  assert.equal(sanitizeDiagCode('https://www.goofish.com/publish?token=abc'), undefined)
  assert.equal(sanitizeDiagCode('token=secret'), undefined)
  assert.equal(sanitizeDiagCode('含中文的页面原文'), undefined)
  assert.equal(sanitizeDiagCode(undefined), undefined)

  const diag = createDiagnostics()
  const entry = beginDiagStage(diag, 'form_validation', 1, {
    code: 'https://evil.example/steal?token=abc',
  })
  endDiagStage(entry, 'failed', 2, { code: 'FORM_VALIDATION_FAILED' })
  const first = diag.timeline[0]!
  assert.equal(first.code, 'FORM_VALIDATION_FAILED')
  assert.ok(!JSON.stringify(diag).includes('evil.example'))
})

test('diagnostics: counters 仅保留有限数值，flags 仅保留布尔', () => {
  const diag = createDiagnostics()
  appendDiagStage(diag, 'images', 'ok', 5, {
    counters: {
      uploaded: 2,
      failed: 0,
      badUrl: 'https://x/y' as unknown as number,
      nan: Number.NaN,
      inf: Infinity,
    },
    flags: { mainImageUploaded: true, bogus: 'yes' as unknown as boolean },
  })
  const entry = diag.timeline[0]!
  assert.deepEqual(entry.counters, { uploaded: 2, failed: 0 })
  assert.deepEqual(entry.flags, { mainImageUploaded: true })
})

test('diagnostics: 从 meta 续接已有时间线，非法输入兜底为空', () => {
  const seed = createDiagnostics()
  appendDiagStage(seed, 'fresh_tab', 'ok', 1)
  const resumed = readDiagnosticsFromMeta({ diagnostics: seed })
  appendDiagStage(resumed, 'load', 'ok', 2)
  assert.equal(resumed.timeline.length, 2)
  // 续接不修改原种子对象
  assert.equal(seed.timeline.length, 1)

  assert.deepEqual(readDiagnosticsFromMeta(undefined).timeline, [])
  assert.deepEqual(readDiagnosticsFromMeta({ diagnostics: { schema: 2 } }).timeline, [])
})

test('diagnostics: snapshot 深拷贝与内存对象相互隔离', () => {
  const diag = createDiagnostics()
  const entry = beginDiagStage(diag, 'load', 10, { counters: { waited: 0 } })
  const snap = snapshotDiagnostics(diag)
  endDiagStage(entry, 'ok', 20, { counters: { waited: 1 } })
  // 快照在后置变更后保持稳定
  assert.equal(snap.timeline[0]?.status, 'started')
  assert.deepEqual(snap.timeline[0]?.counters, { waited: 0 })
  assert.equal(diag.timeline[0]?.status, 'ok')
})

test('diagnostics: result 阶段去重，仅保留最后一次结论', () => {
  const diag = createDiagnostics()
  setResultStage(diag, 'unknown', 1, { counters: { before: 3 } })
  setResultStage(diag, 'ok', 2, { counters: { before: 3, after: 4 } })
  const results = diag.timeline.filter((e) => e.stage === 'result')
  assert.equal(results.length, 1)
  assert.equal(results[0]?.status, 'ok')
  assert.equal(results[0]?.counters?.after, 4)
})
