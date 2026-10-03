/**
 * reply-engine.ts 单测：优先级、正则 i、商品绑定、冷却、防重、黑名单、自己消息过滤、AI 暂停、安全闸降级。
 * 纯逻辑，不发送、不调用 AI。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_AI_MAX_HISTORY, DEFAULT_REPLY_GLOBAL_CONFIG } from '../../../../shared/types/reply'
import type { KeywordReplyRule, ReplyGlobalConfig, ReplyIncomingMessage } from '../../../../shared/types/reply'
import { DEFAULT_AI_RULE_ID, ReplyEngine } from '../reply-engine'

let clock = 1_000_000
const now = () => clock

function config(patch: Partial<ReplyGlobalConfig> = {}): ReplyGlobalConfig {
  return { ...DEFAULT_REPLY_GLOBAL_CONFIG, enabled: true, ...patch }
}

function rule(patch: Partial<KeywordReplyRule> = {}): KeywordReplyRule {
  return { id: 'r1', type: 'keyword', name: '价格', enabled: true, priority: 1, pattern: '价格|多少钱', reply: '亲，价格可谈', ...patch }
}

function incoming(patch: Partial<ReplyIncomingMessage> = {}): ReplyIncomingMessage {
  return { messageId: 'msg1', sessionId: 's1', senderId: 'peer', receiverId: 'me', direction: 'in', content: '这个多少钱', ...patch }
}

test('默认关闭时跳过（disabled）', () => {
  const engine = new ReplyEngine({ now, config: { ...DEFAULT_REPLY_GLOBAL_CONFIG }, rules: [rule()] })
  assert.equal(engine.getGlobalConfig().mode, 'suggest')
  const decision = engine.decide(incoming())
  assert.equal(decision.kind, 'skip')
  assert.equal(decision.reason, 'disabled')
})

test('显式建议（ignoreGlobalEnabled）：总开关关闭时仍可生成建议，且不发送', () => {
  const engine = new ReplyEngine({ now, config: { ...DEFAULT_REPLY_GLOBAL_CONFIG }, rules: [rule()] })
  const decision = engine.decide(incoming(), { mode: 'suggest', ignoreGlobalEnabled: true })
  assert.equal(decision.kind, 'suggest')
  assert.equal(decision.ruleId, 'r1')
  assert.equal(decision.content, '亲，价格可谈')
})

test('无规则命中：fallbackToAi=false 时 no-match；true 时回退默认 AI 建议（kind 恒为 suggest）', () => {
  const engine = new ReplyEngine({ now, config: config(), rules: [] })
  assert.equal(engine.decide(incoming()).reason, 'no-match')

  const fallback = engine.decide(incoming(), { mode: 'suggest', fallbackToAi: true })
  assert.equal(fallback.kind, 'suggest')
  assert.equal(fallback.ruleType, 'ai')
  assert.equal(fallback.ruleId, DEFAULT_AI_RULE_ID)
  assert.equal(fallback.needsAi, true)
  assert.equal(fallback.maxHistoryMessages, DEFAULT_AI_MAX_HISTORY)

  // 即使全局为 auto，默认 AI 回退也只能是建议，绝不自动发送。
  const autoEngine = new ReplyEngine({ now, config: config({ mode: 'auto' }), rules: [] })
  assert.equal(autoEngine.decide(incoming(), { mode: 'suggest', fallbackToAi: true }).kind, 'suggest')
})

test('关键词命中返回建议（suggest），不自动发送', () => {
  const engine = new ReplyEngine({ now, config: config(), rules: [rule()] })
  const decision = engine.decide(incoming())
  assert.equal(decision.kind, 'suggest')
  assert.equal(decision.content, '亲，价格可谈')
  assert.equal(decision.ruleId, 'r1')
  assert.equal(decision.delayMs, 1000)
})

test('正则使用 i 标志且支持中文', () => {
  const engine = new ReplyEngine({ now, config: config(), rules: [rule({ pattern: 'HELLO' })] })
  assert.equal(engine.decide(incoming({ content: 'say hello' })).kind, 'suggest')
  // 非法正则安全跳过
  const bad = new ReplyEngine({ now, config: config(), rules: [rule({ pattern: '(' })] })
  assert.equal(bad.decide(incoming({ content: 'say hello' })).kind, 'skip')
})

test('优先级降序：高优先级规则先命中', () => {
  const engine = new ReplyEngine({
    now,
    config: config(),
    rules: [rule({ id: 'low', priority: 1, reply: 'low' }), rule({ id: 'high', priority: 10, reply: 'high' })],
  })
  const decision = engine.decide(incoming())
  assert.equal(decision.ruleId, 'high')
  assert.equal(decision.content, 'high')
})

test('商品绑定：itemIds 非空时仅匹配对应 itemId', () => {
  const engine = new ReplyEngine({ now, config: config(), rules: [rule({ itemIds: ['a'] })] })
  assert.equal(engine.decide(incoming({ itemId: 'b' })).kind, 'skip')
  assert.equal(engine.decide(incoming({ itemId: 'a' })).kind, 'suggest')
  assert.equal(engine.decide(incoming({ itemId: undefined })).kind, 'skip')
})

test('黑名单用户被跳过', () => {
  const engine = new ReplyEngine({ now, config: config({ blacklist: ['peer'] }), rules: [rule()] })
  assert.equal(engine.decide(incoming()).reason, 'blacklisted')
})

test('自己消息过滤：senderId===myId 或 direction=out', () => {
  const engine = new ReplyEngine({ now, myId: 'me', config: config(), rules: [rule()] })
  assert.equal(engine.decide(incoming({ senderId: 'me' })).reason, 'self')
  assert.equal(engine.decide(incoming({ direction: 'out' })).reason, 'outgoing')
})

test('decide 不消费防重；commit 后同消息判为 duplicate', () => {
  const engine = new ReplyEngine({ now, config: config(), rules: [rule()] })
  const first = engine.decide(incoming())
  assert.equal(first.kind, 'suggest')
  // 未 commit 前可反复建议
  assert.equal(engine.decide(incoming()).kind, 'suggest')

  engine.commit(incoming(), first)
  assert.equal(engine.decide(incoming()).reason, 'duplicate')
})

test('会话级冷却：commit 后同会话进入冷却，时间过去后恢复', () => {
  const engine = new ReplyEngine({ now, config: config({ defaultCooldown: 60000 }), rules: [rule()] })
  const decision = engine.decide(incoming())
  engine.commit(incoming(), decision)
  assert.equal(engine.decide(incoming({ messageId: 'msg2' })).reason, 'session-cooldown')
  clock += 60001
  assert.equal(engine.decide(incoming({ messageId: 'msg3' })).kind, 'suggest')
})

test('规则级冷却：不同会话同发送者仍受规则冷却', () => {
  const engine = new ReplyEngine({ now, config: config({ defaultCooldown: 60000 }), rules: [rule()] })
  const decision = engine.decide(incoming())
  engine.commit(incoming(), decision)
  // 换会话，绕过会话冷却，但规则冷却仍在。
  assert.equal(engine.decide(incoming({ sessionId: 's2', messageId: 'm2' })).reason, 'no-match')
  clock += 60001
  assert.equal(engine.decide(incoming({ sessionId: 's2', messageId: 'm3' })).kind, 'suggest')
})

test('AI 暂停：非 Web 端 out 消息触发暂停，decide 被拦；respectPause=false 可放行', () => {
  const engine = new ReplyEngine({ now, config: config(), rules: [rule()] })
  const paused = engine.reportNonWebOutMessage({ platform: 'android', direction: 'out' })
  assert.ok(paused && paused.paused)
  assert.equal(paused?.pausedUntil, clock + DEFAULT_REPLY_GLOBAL_CONFIG.aiPauseDurationMs)

  assert.equal(engine.decide(incoming()).reason, 'ai-paused')
  // 用户显式请求建议时可忽略暂停
  assert.equal(engine.decide(incoming(), { respectPause: false }).kind, 'suggest')

  // Web 端 out 消息不触发暂停
  const engine2 = new ReplyEngine({ now, config: config(), rules: [rule()] })
  assert.equal(engine2.reportNonWebOutMessage({ platform: 'web', direction: 'out' }), null)
})

test('自动模式：命中关键词返回 auto；无安全闸限制时允许', () => {
  const engine = new ReplyEngine({ now, config: config({ mode: 'auto' }), rules: [rule()] })
  const decision = engine.decide(incoming())
  assert.equal(decision.kind, 'auto')
  assert.equal(decision.mode, 'auto')
})

test('自动模式安全闸：转人工关键词降级为建议', () => {
  const engine = new ReplyEngine({ now, config: config({ mode: 'auto', handoffKeywords: ['人工', '投诉'] }), rules: [rule()] })
  const decision = engine.decide(incoming({ content: '多少钱，我要人工' }))
  assert.equal(decision.kind, 'suggest')
  assert.equal(decision.reason, 'handoff')
})

test('自动模式安全闸：达到每会话最大自动回复数后降级为建议', () => {
  const engine = new ReplyEngine({ now, config: config({ mode: 'auto', maxAutoRepliesPerSession: 1 }), rules: [rule()] })
  const first = engine.decide(incoming({ messageId: 'a' }))
  assert.equal(first.kind, 'auto')
  engine.commit(incoming({ messageId: 'a' }), first)
  clock += 60001 // 绕过会话/规则冷却，只考察安全闸计数
  const second = engine.decide(incoming({ messageId: 'b' }))
  assert.equal(second.kind, 'suggest')
  assert.equal(second.reason, 'max-auto-replies')
})

test('AI 规则：无关键词条件即命中，返回 needsAi 与提示词/历史条数', () => {
  const engine = new ReplyEngine({
    now,
    config: config(),
    rules: [
      { id: 'ai', type: 'ai', name: 'AI', enabled: true, priority: 5, prompt: '你是客服', maxHistoryMessages: 6 },
    ],
  })
  const decision = engine.decide(incoming({ content: '在吗' }))
  assert.equal(decision.kind, 'suggest')
  assert.equal(decision.ruleType, 'ai')
  assert.equal(decision.needsAi, true)
  assert.equal(decision.prompt, '你是客服')
  assert.equal(decision.maxHistoryMessages, 6)
})
