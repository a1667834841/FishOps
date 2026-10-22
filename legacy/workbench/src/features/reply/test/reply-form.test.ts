/**
 * reply-form 单测：规则草稿校验、全局配置差异补丁、自动回复二次确认判定与结果文案。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildGlobalPatch,
  buildRuleFromDraft,
  describeSendFailure,
  describeSuggestionFailure,
  draftFromGlobal,
  emptyRuleDraft,
  patchNeedsAutoConfirm,
} from '../reply-form'
import { DEFAULT_REPLY_GLOBAL_CONFIG } from '../../contracts'

test('buildRuleFromDraft：关键词规则通过，默认停用', () => {
  const built = buildRuleFromDraft(
    { ...emptyRuleDraft('keyword'), name: '关键词规则', priority: '1', pattern: '还在吗|在不在', reply: '在的' },
    { generateId: () => 'rule_x' },
  )
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal(built.rule.id, 'rule_x')
  assert.equal(built.rule.type, 'keyword')
  assert.equal(built.rule.enabled, false)
  assert.equal(built.rule.priority, 1)
})

test('buildRuleFromDraft：非法 / 缺失正则逐项报错', () => {
  const empty = buildRuleFromDraft({ ...emptyRuleDraft('keyword'), name: 'x', pattern: '', reply: 'y' })
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.ok(empty.errors.pattern)

  const broken = buildRuleFromDraft({ ...emptyRuleDraft('keyword'), name: 'x', pattern: '(', reply: 'y' })
  assert.equal(broken.ok, false)
  if (!broken.ok) assert.ok(broken.errors.pattern)
})

test('buildRuleFromDraft：AI 规则正常通过；提示词含疑似密钥被拒绝', () => {
  const ok = buildRuleFromDraft(
    { ...emptyRuleDraft('ai'), name: 'AI 规则', priority: '0', prompt: '友好地回复买家', maxHistoryMessages: '10', model: 'gpt-4o-mini', timeoutSec: '30' },
    { generateId: () => 'rule_ai' },
  )
  assert.equal(ok.ok, true)
  if (ok.ok) assert.equal(ok.rule.type, 'ai')

  const rejected = buildRuleFromDraft({ ...emptyRuleDraft('ai'), name: 'AI 规则', prompt: '使用 sk-1234567890abcdefghij 调用接口' })
  assert.equal(rejected.ok, false)
  if (!rejected.ok) assert.ok(rejected.errors.prompt)
})

test('buildGlobalPatch：无改动时补丁为空，仅发送差异字段', () => {
  const draft = draftFromGlobal(DEFAULT_REPLY_GLOBAL_CONFIG)
  const noop = buildGlobalPatch(draft, DEFAULT_REPLY_GLOBAL_CONFIG)
  assert.equal(noop.ok, true)
  if (noop.ok) assert.deepEqual(noop.patch, {})

  const changed = buildGlobalPatch({ ...draft, mode: 'auto' }, DEFAULT_REPLY_GLOBAL_CONFIG)
  assert.equal(changed.ok, true)
  if (changed.ok) assert.deepEqual(changed.patch, { mode: 'auto' })
})

test('buildGlobalPatch：越界数值报错', () => {
  const draft = { ...draftFromGlobal(DEFAULT_REPLY_GLOBAL_CONFIG), maxAutoRepliesPerSession: '0' }
  const built = buildGlobalPatch(draft, DEFAULT_REPLY_GLOBAL_CONFIG)
  assert.equal(built.ok, false)
  if (!built.ok) assert.ok(built.errors.maxAutoRepliesPerSession)
})

test('patchNeedsAutoConfirm：切到 auto 或打开开关需二次确认，其余改动不需要', () => {
  const current = DEFAULT_REPLY_GLOBAL_CONFIG
  assert.equal(patchNeedsAutoConfirm(current, { mode: 'auto' }), true)
  assert.equal(patchNeedsAutoConfirm(current, { enabled: true, mode: 'auto' }), true)
  assert.equal(patchNeedsAutoConfirm(current, { defaultCooldown: 1000 }), false)
  assert.equal(patchNeedsAutoConfirm({ ...current, mode: 'auto' }, { defaultCooldown: 1000 }), false)
})

test('describeSuggestionFailure / describeSendFailure：给出明确中文说明', () => {
  assert.ok(describeSuggestionFailure({ ok: false, code: 'NO_MATCH', message: 'no match' }).includes('没有规则匹配'))
  assert.ok(describeSuggestionFailure({ ok: false, code: 'SKIPPED', reason: 'disabled', message: '' }).includes('未启用'))
  assert.ok(describeSendFailure({ code: 'NO_SOCKET', message: 'socket closed' }).includes('实时连接'))
})
