/**
 * reply-safety.ts 单测：全局开关、转人工关键词、每会话频率上限、窗口滑动。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AutoReplySafetyGate, matchesHandoff } from '../reply-safety'

let clock = 0
const now = () => clock

test('matchesHandoff：大小写不敏感子串匹配，忽略空白关键词', () => {
  assert.equal(matchesHandoff('我要人工服务', ['人工']), true)
  assert.equal(matchesHandoff('I want HUMAN', ['human']), true)
  assert.equal(matchesHandoff('正常咨询', ['人工', '  ']), false)
  assert.equal(matchesHandoff('任意内容', []), false)
})

test('全局关闭时不允许自动回复', () => {
  const gate = new AutoReplySafetyGate({ enabled: false }, now)
  const verdict = gate.check({ sessionId: 's1', content: 'hi' })
  assert.equal(verdict.allowed, false)
  assert.equal(verdict.reason, 'disabled')
})

test('命中转人工关键词时不允许自动回复', () => {
  const gate = new AutoReplySafetyGate({ enabled: true, handoffKeywords: ['人工'] }, now)
  assert.deepEqual(gate.check({ sessionId: 's1', content: '转人工' }), { allowed: false, reason: 'handoff' })
  assert.equal(gate.check({ sessionId: 's1', content: '正常问题' }).allowed, true)
})

test('达到每会话上限后不允许自动回复', () => {
  const gate = new AutoReplySafetyGate({ enabled: true, maxAutoRepliesPerSession: 2, windowMs: 1000 }, now)
  assert.equal(gate.check({ sessionId: 's1', content: 'q' }).allowed, true)
  gate.record('s1')
  gate.record('s1')
  assert.deepEqual(gate.check({ sessionId: 's1', content: 'q' }), { allowed: false, reason: 'max-auto-replies' })
  // 其它会话不受影响
  assert.equal(gate.check({ sessionId: 's2', content: 'q' }).allowed, true)
})

test('窗口滑动：过期计数不再计入', () => {
  const gate = new AutoReplySafetyGate({ enabled: true, maxAutoRepliesPerSession: 1, windowMs: 1000 }, now)
  gate.record('s1')
  assert.equal(gate.check({ sessionId: 's1', content: 'q' }).allowed, false)
  clock += 1001
  assert.equal(gate.countFor('s1'), 0)
  assert.equal(gate.check({ sessionId: 's1', content: 'q' }).allowed, true)
})

test('reset 清空计数', () => {
  const gate = new AutoReplySafetyGate({ enabled: true, maxAutoRepliesPerSession: 1 }, now)
  gate.record('s1')
  gate.reset()
  assert.equal(gate.countFor('s1'), 0)
})
