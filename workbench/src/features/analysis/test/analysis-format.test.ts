/**
 * analysis-format 单测：过滤器校验、抽样上限、结果解析、失败文案、PromptRule 组装（拒绝密钥）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildDatasetFilter,
  buildPromptRule,
  cellLink,
  describeAnalysisFailure,
  emptyPromptRuleDraft,
  formatCell,
  parseAnalysisResult,
  parseSampleLimit,
} from '../analysis-format'
import { DATASET_DEFAULT_LIMIT } from '../../contracts'

test('buildDatasetFilter：默认条数与字段组装', () => {
  const built = buildDatasetFilter({ keyword: 'x', minPrice: '10', maxPrice: '20', minWantCnt: '3', maxWantCnt: '', onlyFreeShip: true, limit: '' })
  assert.equal(built.ok, true)
  if (!built.ok) return
  assert.equal(built.filter.keyword, 'x')
  assert.equal(built.filter.minPrice, 10)
  assert.equal(built.filter.maxPrice, 20)
  assert.equal(built.filter.minWantCnt, 3)
  assert.equal(built.filter.onlyFreeShip, true)
  assert.equal(built.filter.limit, DATASET_DEFAULT_LIMIT)
})

test('buildDatasetFilter：区间颠倒与非法条数逐项报错', () => {
  const swapped = buildDatasetFilter({ keyword: '', minPrice: '9', maxPrice: '1', minWantCnt: '', maxWantCnt: '', onlyFreeShip: false, limit: '100' })
  assert.equal(swapped.ok, false)
  if (!swapped.ok) assert.ok(swapped.errors.maxPrice)

  const badLimit = buildDatasetFilter({ keyword: '', minPrice: '', maxPrice: '', minWantCnt: '', maxWantCnt: '', onlyFreeShip: false, limit: '0' })
  assert.equal(badLimit.ok, false)
  if (!badLimit.ok) assert.ok(badLimit.errors.limit)
})

test('parseSampleLimit：限定 1 到 50', () => {
  assert.equal(parseSampleLimit('20').value, 20)
  assert.ok(parseSampleLimit('0').error)
  assert.ok(parseSampleLimit('51').error)
})

test('formatCell / cellLink：按字段类型格式化，URL 只放行 https', () => {
  assert.equal(formatCell({ type: 'boolean' }, true), '是')
  assert.equal(formatCell({ type: 'string' }, ''), '')
  assert.equal(cellLink({ type: 'url' }, 'https://example.com/x'), 'https://example.com/x')
  assert.equal(cellLink({ type: 'url' }, 'http://example.com/x'), null)
})

const VALID_RESULT = {
  result: {
    ruleId: 'r1',
    ruleName: '默认规则',
    sampleCount: 10,
    totalCount: 40,
    analyzedAt: 1000,
    output: { summary: '概述', keyFindings: ['a'], opportunities: ['b'], risks: ['c'] },
    modelUsed: 'gpt-4o-mini',
  },
}

test('parseAnalysisResult：合法结果通过，缺字段返回明确原因', () => {
  assert.equal(parseAnalysisResult(VALID_RESULT).ok, true)
  assert.equal(parseAnalysisResult({ result: null }).ok, false)

  const noSummary = { result: { ...VALID_RESULT.result, output: { ...VALID_RESULT.result.output, summary: '' } } }
  const parsed = parseAnalysisResult(noSummary)
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.ok(parsed.reason.includes('summary'))

  const badPrice = {
    result: {
      ...VALID_RESULT.result,
      output: { ...VALID_RESULT.result.output, priceAnalysis: { avgPrice: 'x', medianPrice: 1, priceRange: '' } },
    },
  }
  assert.equal(parseAnalysisResult(badPrice).ok, false)
})

test('describeAnalysisFailure：识别未配置 LLM 与数据为空', () => {
  assert.equal(describeAnalysisFailure('CONFIG_ERROR: 未配置 AI API Key').title, 'AI 模型未配置')
  assert.equal(describeAnalysisFailure('数据源查询结果为空').title, '数据源没有可分析的数据')
})

test('buildPromptRule：正常规则通过；含疑似密钥被拒绝', () => {
  const ok = buildPromptRule(
    { ...emptyPromptRuleDraft(), name: '测试规则', systemPrompt: '你是分析助手', userPromptTemplate: '分析 {{dataset}} 与 {{summary}}' },
    { generateId: () => 'prompt_test', now: 1000 },
  )
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.rule.id, 'prompt_test')
    assert.deepEqual([...ok.rule.variables].sort(), ['dataset', 'summary'])
    assert.equal(ok.rule.createdAt, 1000)
  }

  const rejected = buildPromptRule({
    ...emptyPromptRuleDraft(),
    name: '测试规则',
    systemPrompt: '请使用密钥 sk-1234567890abcdefghij 调用接口',
    userPromptTemplate: '分析 {{dataset}}',
  })
  assert.equal(rejected.ok, false)
})
