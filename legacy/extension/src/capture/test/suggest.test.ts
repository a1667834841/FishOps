/**
 * CAPTURE_SUGGEST_WORDS（闲鱼流量词）单测（全 mock，无真实网络）。
 *
 * 覆盖：
 * - mock 平台返回建议词：去重（大小写不敏感）、限长、限条数；
 * - 空输入不调用平台，且回结构化错误；
 * - 平台不可用 / 平台错误 → 结构化 PLATFORM_ERROR（带 category）；
 * - 并发乱序：旧请求后返回时其 sequence 更小，UI 可据此丢弃（不覆盖新 query）；
 * - 只查询建议词，**不创建采集任务**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CommandTypes } from '@fishops/shared'
import type { CommandEnvelope } from '@fishops/shared'
import { MemoryTaskStore, TaskManager } from '../../../../shared/task/index'
import { MemoryProductRepository } from '../../../../shared/capture/product-repository'
import { CAPTURE_LIMITS } from '../../../../shared/types/capture'
import type { CaptureSuggestWordsResult } from '../../../../shared/types/capture'
import { PlatformError } from '../../platform/errors'
import { createCaptureRuntime } from '../../background/capture-runtime'
import { MockPlatform } from './fixtures'

function cmd(type: string, payload: unknown): CommandEnvelope {
  return {
    kind: 'command',
    protocol: 1,
    requestId: `req_${Math.random().toString(36).slice(2)}`,
    type,
    payload,
    sentAt: Date.now(),
  }
}

function setup(options: { available?: boolean } = {}) {
  const tasks = new TaskManager({ store: new MemoryTaskStore() })
  const repository = new MemoryProductRepository()
  const platform = new MockPlatform()
  if (options.available === false) platform.available = false
  const runtime = createCaptureRuntime({ platform, repository, tasks, sleep: async () => {} })
  return { tasks, platform, runtime }
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

test('suggest：去重（大小写不敏感）、截断单条长度、限制条数', async () => {
  const s = setup()
  const longWord = 'x'.repeat(CAPTURE_LIMITS.suggestWordMaxLength + 20)
  s.platform.suggestWords = ['iPhone', 'iphone', '  iPhone  ', '', 'ipad', longWord, 42 as unknown as string]

  const response = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword: '  iph ', queryId: 'q1', limit: 3 }),
  )
  assert.equal(response.ok, true)
  const result = response.result as CaptureSuggestWordsResult
  assert.equal(result.keyword, 'iph') // trim
  assert.equal(result.queryId, 'q1')
  assert.equal(result.sequence, 1)
  // 去重后：iPhone / ipad / longWord（限 3 条），longWord 被截断到上限
  assert.equal(result.words.length, 3)
  assert.equal(result.words[0], 'iPhone')
  assert.equal(result.words[1], 'ipad')
  assert.equal(result.words[2].length, CAPTURE_LIMITS.suggestWordMaxLength)
  // 传入的真实关键词（非空）
  assert.deepEqual(s.platform.suggestCalls, ['iph'])
  // 不创建采集任务
  assert.equal((await s.tasks.list()).length, 0)
})

test('suggest：limit 受 suggestMaxWords 上限约束', async () => {
  const s = setup()
  s.platform.suggestWords = Array.from({ length: 50 }, (_, i) => `w${i}`)
  const response = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword: 'k', limit: 1000 }),
  )
  const result = response.result as CaptureSuggestWordsResult
  assert.equal(result.words.length, CAPTURE_LIMITS.suggestMaxWords)
})

test('suggest：空输入不调用平台', async () => {
  const s = setup()
  for (const keyword of ['', '   ', '\t\n']) {
    const response = await s.runtime.handleCommand(
      cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword }),
    )
    assert.equal(response.ok, false)
    assert.equal(response.error?.code, 'INVALID_PAYLOAD')
  }
  assert.equal(s.platform.suggestCalls.length, 0)
  assert.equal((await s.tasks.list()).length, 0)
})

test('suggest：非法负载被拒绝', async () => {
  const s = setup()
  const response = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword: 123 }),
  )
  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'INVALID_PAYLOAD')
  assert.equal(s.platform.suggestCalls.length, 0)
})

test('suggest：平台不可用 → 结构化 PLATFORM_ERROR(host-unavailable)，不调用平台', async () => {
  const s = setup({ available: false })
  const response = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword: 'k' }),
  )
  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'PLATFORM_ERROR')
  assert.equal(response.error?.category, 'host-unavailable')
  assert.equal(s.platform.suggestCalls.length, 0)
  assert.equal((await s.tasks.list()).length, 0)
})

test('suggest：平台抛错 → PLATFORM_ERROR（带类别）/ INTERNAL', async () => {
  const s = setup()
  s.platform.suggestError = new PlatformError('captcha', '被风控拦截', { retCode: 'RGV587' })
  const captcha = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword: 'k' }),
  )
  assert.equal(captcha.ok, false)
  assert.equal(captcha.error?.code, 'PLATFORM_ERROR')
  assert.equal(captcha.error?.category, 'captcha')
  assert.equal(captcha.error?.retCode, 'RGV587')

  s.platform.suggestError = new Error('boom')
  const internal = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword: 'k' }),
  )
  assert.equal(internal.ok, false)
  assert.equal(internal.error?.code, 'INTERNAL')
})

test('suggest：并发乱序——旧请求后返回，sequence 更小，可被 UI 丢弃', async () => {
  const s = setup()
  const gates = new Map<string, () => void>()
  s.platform.suggestImpl = (keyword) =>
    new Promise<string[]>((resolve) => {
      gates.set(keyword, () => resolve([`${keyword}-word`]))
    })

  // 先发 old，再发 new
  const pOld = s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword: 'old', queryId: 'q-old' }),
  )
  const pNew = s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword: 'new', queryId: 'q-new' }),
  )
  await waitFor(() => gates.size === 2)

  // new 先返回，old 后返回（故意乱序）
  gates.get('new')!()
  gates.get('old')!()

  const oldRes = (await pOld).result as CaptureSuggestWordsResult
  const newRes = (await pNew).result as CaptureSuggestWordsResult
  // 序号按请求到达顺序分配：new 的序号更大，UI 只认更大序号 → old 不覆盖 new
  assert.ok(newRes.sequence > oldRes.sequence)
  assert.equal(oldRes.queryId, 'q-old')
  assert.equal(newRes.queryId, 'q-new')
  assert.deepEqual(newRes.words, ['new-word'])
  assert.deepEqual(oldRes.words, ['old-word'])
})

test('suggest：序号跨多次调用单调递增，queryId 超长被截断', async () => {
  const s = setup()
  s.platform.suggestWords = ['a']
  const longQueryId = 'q'.repeat(CAPTURE_LIMITS.suggestQueryIdMaxLength + 30)
  const first = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword: 'k1' }),
  )
  const second = await s.runtime.handleCommand(
    cmd(CommandTypes.CAPTURE_SUGGEST_WORDS, { keyword: 'k2', queryId: longQueryId }),
  )
  const r1 = first.result as CaptureSuggestWordsResult
  const r2 = second.result as CaptureSuggestWordsResult
  assert.equal(r2.sequence, r1.sequence + 1)
  assert.equal(r2.queryId!.length, CAPTURE_LIMITS.suggestQueryIdMaxLength)
  // 未传 queryId 时不回传该字段
  assert.equal('queryId' in r1, false)
})
