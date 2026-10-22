import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installChatWakeup } from '../chat-wakeup.ts'
import { CHAT_NOTICE } from '../chat-notice.ts'
import type { NativeBridge } from '../connection.ts'
import { settle } from './fakes.ts'

function fixture(initial = 0) {
  let listener!: (m: unknown, s: any) => void
  let documentId = 'doc', count = initial, peeks = 0, saved = 0
  let hook: (() => void) | undefined
  const sender = { id: 'ext', frameId: 0, documentId: 'doc', url: 'https://www.goofish.com/im', tab: { id: 7 } }
  const original = (globalThis as any).chrome
  ;(globalThis as any).chrome = {
    runtime: { id: 'ext', onMessage: { addListener: (fn: typeof listener) => { listener = fn } } },
    cookies: { get: async () => ({ value: 'a' }) },
    tabs: { query: async () => [{ id: 7 }] },
    webNavigation: { getFrame: async () => ({ documentId, url: sender.url }) },
  }
  const bridge = { ingestChatMessage: async () => { saved++; hook?.(); hook = undefined }, reportChatGap: async () => {} } as unknown as NativeBridge
  installChatWakeup(bridge, { executeScript: async details => {
    const input = details.args![0] as any
    if (input.op === 'ack') { count--; return [{ documentId, result: 1 }] }
    peeks++
    return [{ documentId, result: { messages: Array.from({ length: Math.min(count, 100) }, (_, n) => ({ sourceId: String(n), sessionId: 's', senderId: 'p', text: '', sentAt: 0 })), syncRequired: false } }]
  } })
  return { sender, notice: (s = sender) => listener({ kind: CHAT_NOTICE }, s), count: () => count, peeks: () => peeks, saved: () => saved,
    add: (n: number) => { count += n }, hook: (fn: () => void) => { hook = fn }, navigate: () => { documentId = 'new' }, restore: () => { (globalThis as any).chrome = original } }
}

test('首次SW无需通知恢复已有页面消息', async () => {
  const f = fixture(1)
  try { await settle(20); assert.equal(f.saved(), 1) } finally { f.restore() }
})
test('active期间通知保留重跑，短批次后新增消息不滞留', async () => {
  const f = fixture()
  try {
    await settle(10); f.add(1)
    f.hook(() => { f.add(1); f.notice() })
    f.notice(); await new Promise(r => setTimeout(r, 20)); await settle(10)
    assert.equal(f.count(), 0); assert.equal(f.saved(), 2)
  } finally { f.restore() }
})
test('连续满100条超过10批仍续跑排空', async () => {
  const f = fixture(1101)
  try {
    f.notice()
    for (let n = 0; n < 100 && f.count(); n++) await new Promise(r => setTimeout(r, 5))
    assert.equal(f.count(), 0)
  } finally { f.restore() }
})
test('拒绝错误sender和导航旧文档，不采集其他文档', async () => {
  const f = fixture()
  try {
    await settle(10); const before = f.peeks()
    for (const patch of [{ id: 'other' }, { frameId: 1 }, { tab: { id: -1 } }, { url: 'https://u:p@www.goofish.com/' }, { documentId: '' }]) f.notice({ ...f.sender, ...patch })
    await settle(10); assert.equal(f.peeks(), before)
    f.navigate(); f.notice(); await settle(10); assert.equal(f.peeks(), before)
  } finally { f.restore() }
})

test('恢复和采集错误只记录固定文案，不泄漏原始异常', async () => {
  const original = console.warn, logs: unknown[][] = []
  console.warn = (...args) => { logs.push(args) }
  const f = fixture()
  try {
    await settle(10)
    ;(globalThis as any).chrome.cookies.get = async () => { throw new Error('secret-token-正文') }
    f.notice(); await settle(10)
    assert.deepEqual(logs, [['页面聊天采集未完成']])
  } finally { f.restore(); console.warn = original }
})
