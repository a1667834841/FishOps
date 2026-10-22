import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChatCollector } from '../chat-collector.ts'
const message = (sourceId: string) => ({ sourceId, sessionId: 's', senderId: 'p', text: '测试', sentAt: 1 })
test('逐条持久化后才确认页面，存储失败保留失败项和后续项', async () => {
  const actions: string[] = []
  const collector = createChatCollector({
    source: { peek: async () => ({ messages: [message('1'), message('2'), message('3')], syncRequired: false }), acknowledge: async ids => { actions.push(`ack:${ids[0]}`) } },
    persist: async item => { actions.push(`save:${item.sourceId}`); if (item.sourceId === '2') throw new Error('disk') }, gap: async () => assert.fail(),
  })
  await assert.rejects(collector.collect(), /disk/)
  assert.deepEqual(actions, ['save:1', 'ack:1', 'save:2'])
})
test('缺口先上报，并发采集合并；确认失败可再次去重恢复', async () => {
  let saves = 0, acks = 0, gaps = 0, fail = true
  const collector = createChatCollector({
    source: { peek: async () => ({ messages: [message('1')], syncRequired: true }), acknowledge: async () => { acks++; if (fail) throw new Error('navigate') } },
    persist: async () => { saves++ }, gap: async () => { gaps++ },
  })
  const first = collector.collect(); assert.equal(collector.collect(), first)
  await assert.rejects(first)
  fail = false
  assert.equal(await collector.collect(), 1)
  assert.equal(saves, 2); assert.equal(acks, 2); assert.equal(gaps, 2)
})
test('非法页面批次不保存不确认', async () => {
  const collector = createChatCollector({ source: { peek: async () => ({ messages: [message('')], syncRequired: false }), acknowledge: async () => assert.fail() }, persist: async () => assert.fail(), gap: async () => assert.fail() })
  await assert.rejects(collector.collect(), /CHAT_PAGE_INVALID/)
})

test('稳定页面缺口失败仍持久确认正常消息，重试传递原身份', async () => {
  const occurrence = { accountId: 'a', reason: 'PAGE_GAP' as const, occurrenceId: 'page-gap-1', generation: 1, scope: { scope: 'unknown' as const } }
  let fail = true, acks = 0
  const received: unknown[] = []
  const collector = createChatCollector({ source: { peek: async () => ({ messages: [message('m')], syncRequired: true, occurrences: [occurrence] }), acknowledge: async () => { acks++ } }, persist: async () => {}, gap: async value => { received.push(structuredClone(value)); if (fail) throw new Error('disk') } })
  await assert.rejects(collector.collect(), /disk/)
  assert.equal(acks, 1)
  fail = false
  assert.equal(await collector.collect(), 1)
  assert.deepEqual(received, [occurrence, occurrence])
  assert.equal(acks, 2)
})

test('多个页面缺口按原顺序上报，不能只消费最后一条', async () => {
  const occurrences = [1, 2, 3].map(index => ({
    accountId: 'a', reason: 'PAGE_GAP' as const, occurrenceId: `page-gap-${index}`, generation: index,
    scope: { scope: 'unknown' as const },
  }))
  const seen: string[] = []
  const collector = createChatCollector({
    source: { peek: async () => ({ messages: [], syncRequired: true, occurrences }), acknowledge: async () => {} },
    persist: async () => {},
    gap: async value => { seen.push(value!.occurrenceId) },
  })
  assert.equal(await collector.collect(), 0)
  assert.deepEqual(seen, ['page-gap-1', 'page-gap-2', 'page-gap-3'])
})

test('缺口容量耗尽仍排空正常批次，但不返回成功或隐去缺口错误', async () => {
  const pending = [message('a'), message('b')], stored: string[] = []
  const collector = createChatCollector({ source: { peek: async () => ({ messages: [...pending], syncRequired: true }), acknowledge: async ids => { for (const id of ids) pending.splice(pending.findIndex(item => item.sourceId === id), 1) } }, persist: async item => { stored.push(item.sourceId) }, gap: async () => { throw new Error('OUTBOX_GAP_CAPACITY') } })
  await assert.rejects(collector.collect(), /OUTBOX_GAP_CAPACITY/)
  assert.deepEqual(stored, ['a', 'b'])
  assert.equal(pending.length, 0)
  await assert.rejects(collector.collect(), /OUTBOX_GAP_CAPACITY/)
  assert.deepEqual(stored, ['a', 'b'])
})
