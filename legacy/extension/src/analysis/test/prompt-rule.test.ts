/**
 * PromptRule 与规则存储单元测试。
 *
 * 验证：
 * 1. 模板变量解析与未知变量拦截；
 * 2. 敏感信息检查（API Key、Secret、密码拦截）；
 * 3. 基础必填字段完整性校验；
 * 4. MemoryPromptRuleStore 与 StoragePromptRuleStore 的 CRUD 操作。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  extractTemplateVariables,
  validateNoSecrets,
  validatePromptRule,
} from '../../../../shared/analysis/prompt-rule-validator'
import {
  MemoryPromptRuleStore,
  StoragePromptRuleStore,
  type KeyValueStorage,
} from '../../../../shared/analysis/prompt-rule-store'
import type { PromptRule } from '../../../../shared/types/analysis'

test('PromptRule: 模板变量提取', () => {
  const template = '请分析以下数据：\n{{summary}}\n样本如下：\n{{dataset}}\n{{customInstructions}}'
  const vars = extractTemplateVariables(template)
  assert.deepEqual(vars.sort(), ['customInstructions', 'dataset', 'summary'].sort())
})

test('PromptRule: 未知变量被拒绝', () => {
  const rule: Partial<PromptRule> = {
    id: 'test_rule',
    name: '测试规则',
    systemPrompt: 'System',
    userPromptTemplate: '内容: {{dataset}} 和未知变量 {{unknownVariable}}',
  }
  const result = validatePromptRule(rule)
  assert.equal(result.valid, false)
  assert.equal(result.errors.some((e) => e.includes('未知或不受支持的模板变量')), true)
})

test('PromptRule: 包含 API Key / Secret 时被拒绝保存', () => {
  // 1. OpenAI Key
  const ruleWithOpenAiKey: Partial<PromptRule> = {
    id: 'r1',
    name: '带Key的规则',
    systemPrompt: '这里偷偷写了 sk-abcdefghijklmnopqrstuvwxyz0123456789',
    userPromptTemplate: '{{dataset}}',
  }
  const check1 = validatePromptRule(ruleWithOpenAiKey)
  assert.equal(check1.valid, false)
  assert.equal(check1.errors.some((e) => e.includes('疑似 API Key')), true)

  // 2. AppSecret
  const check2 = validateNoSecrets('app_secret: "abc1234567890"')
  assert.equal(check2.valid, false)
})

test('PromptRule: MemoryPromptRuleStore CRUD 流程', async () => {
  const store = new MemoryPromptRuleStore()
  // 初始应有默认内置规则
  const initial = await store.list()
  assert.equal(initial.length >= 2, true)

  const newRule: PromptRule = {
    id: 'custom_rule_1',
    name: '自定义品类分析',
    description: '用于测试的规则',
    systemPrompt: '请以 JSON 格式输出分析',
    userPromptTemplate: '分析样本: {{dataset}} 概况: {{summary}}',
    variables: ['dataset', 'summary'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  // Upsert
  const saved = await store.upsert(newRule)
  assert.equal(saved.id, 'custom_rule_1')

  // Get
  const fetched = await store.get('custom_rule_1')
  assert.equal(fetched?.name, '自定义品类分析')

  // List 包含新规则
  const updatedList = await store.list()
  assert.equal(updatedList.some((r) => r.id === 'custom_rule_1'), true)

  // Delete
  const deleted = await store.delete('custom_rule_1')
  assert.equal(deleted, true)
  const afterDelete = await store.get('custom_rule_1')
  assert.equal(afterDelete, null)
})

test('PromptRule: StoragePromptRuleStore 适配持久化存储', async () => {
  const memoryMap: Record<string, unknown> = {}
  const mockStorage: KeyValueStorage = {
    get: async (keys) => {
      const res: Record<string, unknown> = {}
      for (const k of keys) {
        if (memoryMap[k] !== undefined) res[k] = memoryMap[k]
      }
      return res
    },
    set: async (items) => {
      Object.assign(memoryMap, items)
    },
  }

  const store = new StoragePromptRuleStore(mockStorage)
  const list = await store.list()
  // 首次应自动种子化内置规则到 storage
  assert.equal(list.length >= 2, true)
  assert.notEqual(memoryMap['fishops.prompt_rules'], undefined)

  const rule: PromptRule = {
    id: 'rule_saved_to_storage',
    name: '存储规则',
    systemPrompt: 'System',
    userPromptTemplate: '{{summary}}',
    variables: ['summary'],
    createdAt: 1000,
    updatedAt: 1000,
  }

  await store.upsert(rule)
  const found = await store.get('rule_saved_to_storage')
  assert.equal(found?.id, 'rule_saved_to_storage')
})
