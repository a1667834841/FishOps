/**
 * reply-config.ts / reply-config-chrome.ts 单测：规则与全局分离、凭据隔离、字段白名单净化、非法回退。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_REPLY_GLOBAL_CONFIG, type KeywordReplyRule } from '../../../../shared/types/reply'
import {
  MemoryReplyConfigStore,
  REPLY_AI_PROVIDER_KEY,
  REPLY_GLOBAL_CONFIG_KEY,
  REPLY_RULES_KEY,
  mergeReplyGlobalConfig,
  normalizeReplyRules,
} from '../reply-config'
import { ChromeReplyConfigStore, type StorageLocalLike } from '../reply-config-chrome'

/** 规则里混入敏感字段，用于验证净化（模拟旧数据 / 手工写入）。 */
const dirtyRule = {
  id: 'r1',
  type: 'keyword',
  name: 'x',
  enabled: true,
  priority: 1,
  pattern: 'hi',
  reply: 'hello',
  aiApiKey: 'sk-should-not-persist',
} as unknown as KeywordReplyRule

test('normalizeReplyRules：字段白名单 + 去重 ID', () => {
  const rules = normalizeReplyRules([dirtyRule, { ...dirtyRule }])
  assert.equal(rules.length, 1)
  assert.ok(!('aiApiKey' in rules[0]))
})

test('mergeReplyGlobalConfig：仅覆盖提供的字段', () => {
  const merged = mergeReplyGlobalConfig(DEFAULT_REPLY_GLOBAL_CONFIG, { enabled: true })
  assert.equal(merged.enabled, true)
  assert.equal(merged.defaultCooldown, DEFAULT_REPLY_GLOBAL_CONFIG.defaultCooldown)
})

class FakeStorage implements StorageLocalLike {
  readonly data = new Map<string, unknown>()
  async get(keys: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>> {
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys)
    const out: Record<string, unknown> = {}
    for (const key of list) if (this.data.has(key)) out[key] = this.data.get(key)
    return out
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, value)
  }
}

test('ChromeReplyConfigStore：规则/全局/凭据分开存储，规则净化不含 key', async () => {
  const storage = new FakeStorage()
  const store = new ChromeReplyConfigStore(storage)

  await store.saveRules([dirtyRule])
  await store.saveGlobalConfig({ ...DEFAULT_REPLY_GLOBAL_CONFIG, enabled: true })
  await store.saveAiProvider({ apiKey: 'sk-secret', baseUrl: 'https://x/v1', model: 'm', timeoutMs: 1000 })

  // 三个独立键。
  assert.ok(storage.data.has(REPLY_RULES_KEY))
  assert.ok(storage.data.has(REPLY_GLOBAL_CONFIG_KEY))
  assert.ok(storage.data.has(REPLY_AI_PROVIDER_KEY))

  // 规则里绝不能出现 key。
  const storedRules = JSON.stringify(storage.data.get(REPLY_RULES_KEY))
  assert.ok(!storedRules.includes('sk-should-not-persist'))
  assert.ok(!storedRules.includes('aiApiKey'))

  const rules = await store.loadRules()
  assert.equal(rules.length, 1)
  assert.ok(!('aiApiKey' in rules[0]))

  assert.equal((await store.loadGlobalConfig()).enabled, true)
  assert.equal((await store.loadAiProvider()).apiKey, 'sk-secret')
})

test('ChromeReplyConfigStore：非法数据回退默认值，不抛错', async () => {
  const storage = new FakeStorage()
  const warnings: string[] = []
  const store = new ChromeReplyConfigStore(storage, { onWarn: (m) => warnings.push(m) })

  storage.data.set(REPLY_RULES_KEY, [{ totally: 'broken' }])
  storage.data.set(REPLY_GLOBAL_CONFIG_KEY, { enabled: 'yes' })
  storage.data.set(REPLY_AI_PROVIDER_KEY, { apiKey: 123 })

  assert.deepEqual(await store.loadRules(), [])
  assert.equal((await store.loadGlobalConfig()).enabled, DEFAULT_REPLY_GLOBAL_CONFIG.enabled)
  assert.equal((await store.loadAiProvider()).apiKey, '')
  assert.equal(warnings.length, 3)
})

test('MemoryReplyConfigStore：独立副本，外部修改不影响内部', async () => {
  const store = new MemoryReplyConfigStore({ rules: [dirtyRule] })
  const rules = await store.loadRules()
  rules[0].name = 'mutated'
  assert.equal((await store.loadRules())[0].name, 'x')
  assert.ok(!('aiApiKey' in (await store.loadRules())[0]))
})
