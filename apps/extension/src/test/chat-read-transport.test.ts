import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatReadTransport } from '../chat-read-transport.ts'

class Socket extends EventTarget {
  readyState = 1
  sent: string[] = []
  respond?: (raw: string) => void
  send(raw: string) { this.sent.push(raw); this.respond?.(raw) }
  reply(mid = '00 0', extra: object = {}) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ headers: { mid }, code: 200, body: {}, ...extra }) }))
  }
}
const params = { mode: 'conversations' as const, anchor: '9007199254740991', limit: 10 }
function setup() {
  const socket = new Socket()
  let account = 'a'
  let timer: (() => void) | undefined
  let clears = 0
  const transport = createChatReadTransport({ getSocket: () => socket, readAccountId: () => account,
    setTimer: (fn, ms) => { assert.equal(ms, 15000); timer = fn; return 1 },
    clearTimer: () => { clears++ }, now: () => 0, random: () => 0 })
  return { socket, transport, change: () => { account = 'b' }, timeout: () => timer!(), clears: () => clears }
}
const code = (value: string) => (error: unknown) => !!error && (error as { code: string }).code === value

test('读取响应允许超过推送帧256KiB的合法分页正文', async () => {
  const f = setup()
  const pending = f.transport.query(params, 'a', 'large-read')
  const body = { padding: 'x'.repeat(300 * 1024) }
  f.socket.reply('00 0', { body })
  const settled = await Promise.race([pending.then(() => true), Promise.resolve(false)])
  if (!settled) f.timeout()
  try { assert.deepEqual(await pending, body) } finally { f.transport.dispose() }
})
test('读取信封超预算或无关 mid 仍不能终结当前请求', async () => {
  const f = setup()
  const pending = f.transport.query(params, 'a', 'bounded-read')
  let settled = false
  void pending.then(() => { settled = true }, () => { settled = true })
  f.socket.reply('00 0', { body: { padding: 'x'.repeat(528 * 1024) } })
  f.socket.reply('other', { body: { padding: 'x'.repeat(300 * 1024) } })
  await Promise.resolve()
  assert.equal(settled, false)
  f.socket.reply()
  assert.deepEqual(await pending, {})
  assert.equal(f.socket.sent.length, 1)
  f.transport.dispose()
})
test('读取信封按 UTF-8 字节限制，不能只检查字符串长度', async () => {
  const f = setup()
  const pending = f.transport.query(params, 'a', 'utf8-read')
  f.socket.reply('00 0', { body: { padding: '中'.repeat(190 * 1024) } })
  f.timeout()
  await assert.rejects(pending, code('TIMEOUT'))
  await assert.rejects(f.transport.query(params, 'a', 'after-timeout'), code('TIMEOUT'))
  assert.equal(f.socket.sent.length, 1)
  f.transport.dispose()
})

test('同步响应不会抢跑，信封固定，重复 mid 拒绝', async () => {
  const { socket, transport } = setup()
  socket.respond = () => socket.reply()
  assert.deepEqual(await transport.query(params, 'a', 'm1'), {})
  assert.deepEqual(JSON.parse(socket.sent[0]!), { lwp: '/r/Conversation/listNewestPagination', headers: { mid: '00 0' }, body: [Number.MAX_SAFE_INTEGER, 10] })
  await assert.rejects(transport.query(params, 'a', 'm1'), code('BAD_REQUEST'))
  transport.dispose()
})
test('错 mid 或 route 忽略，单 pending 不重复发送', async () => {
  const { socket, transport } = setup()
  const result = transport.query(params, 'a', 'm1')
  socket.reply('other'); socket.reply('m1'); socket.reply('00 0', { lwp: '/wrong' })
  await assert.rejects(transport.query(params, 'a', 'm2'), code('PAGE_NOT_READY'))
  assert.equal(socket.sent.length, 1)
  socket.reply(); await result; transport.dispose()
})
// 已派发后的错误码必须表达“终结未确认”（TIMEOUT）或“账号不可复用”（ACCOUNT_CHANGED）：
// 不能再用表示“未派发”的 PAGE_NOT_READY，否则页面运行时会误判为可安全重放的未派发失败。
const inFlightCodes = { close: 'TIMEOUT', error: 'TIMEOUT', timeout: 'TIMEOUT', account: 'ACCOUNT_CHANGED', send: 'TIMEOUT' } as const
for (const event of ['close', 'error', 'timeout', 'account', 'send'] as const) {
  test(`${event} 后永久停用，不关闭或重试页面连接`, async () => {
    const f = setup()
    if (event === 'send') f.socket.respond = () => { throw Error('敏感原文') }
    const result = f.transport.query(params, 'a', 'm1')
    if (event === 'timeout') f.timeout()
    else if (event === 'account') { f.change(); f.socket.reply() }
    else if (event !== 'send') f.socket.dispatchEvent(new Event(event))
    await assert.rejects(result, code(inFlightCodes[event]))
    f.socket.reply()
    await assert.rejects(f.transport.query(params, 'a', 'm2'))
    assert.equal(f.socket.sent.length, 1)
    f.transport.dispose(); f.transport.dispose()
  })
}
test('无连接和非法参数不会发送', async () => {
  const transport = createChatReadTransport({ getSocket: () => null, readAccountId: () => 'a' })
  await assert.rejects(transport.query(params, 'a', 'm1'), code('PAGE_NOT_READY'))
  const f = setup()
  await assert.rejects(f.transport.query({ ...params, route: '/send' } as typeof params, 'a', 'm1'), code('BAD_REQUEST'))
  await assert.rejects(f.transport.query({ mode: 'messages', sessionId: 'x@other', anchor: '0', limit: 1 }, 'a', 'm2'), code('BAD_REQUEST'))
  assert.equal(f.socket.sent.length, 0)
})
test('首屏成功后空闲连接被替换时，可安全绑定新的唯一OPEN连接', async () => {
  const first = new Socket(), second = new Socket()
  let current = first
  const transport = createChatReadTransport({ getSocket: () => current, readAccountId: () => 'a',
    now: () => 0, random: () => 0 })
  first.respond = () => first.reply()
  await transport.query(params, 'a', 'm1')
  first.readyState = 3
  current = second
  second.respond = () => second.reply('00 1')
  assert.deepEqual(await transport.query(params, 'a', 'm2'), {})
  assert.equal(second.sent.length, 1)
  transport.dispose()
})
test('历史路由和参数固定，响应 body 仍未归一化', async () => {
  const f = setup()
  f.socket.respond = () => f.socket.reply('00 0', { body: { userMessageModels: [] }, code: 0 })
  assert.deepEqual(await f.transport.query({ mode: 'messages', sessionId: 'cid', anchor: '9', limit: 2 }, 'a', 'm1'), { userMessageModels: [] })
  assert.deepEqual(JSON.parse(f.socket.sent[0]!).body, ['cid@goofish', false, 9, 2, false])
  f.transport.dispose()
})
test('平台明确拒绝后释放绑定，下一独立读取可正常终结', async () => {
  const f = setup()
  f.socket.respond = () => f.socket.reply('00 0', { code: 400 })
  await assert.rejects(f.transport.query(params, 'a', 'rejected'), code('PLATFORM_REJECTED'))
  assert.equal(f.clears(), 1)
  f.socket.respond = () => f.socket.reply('00 1', { body: { recovered: true } })
  assert.deepEqual(await f.transport.query(params, 'a', 'new-read'), { recovered: true })
  assert.equal(f.socket.sent.length, 2)
  assert.equal(f.clears(), 2)
  f.transport.dispose()
})
for (const [response, expected] of [
  [{ code: '200' }, 'PLATFORM_REJECTED'], [{ body: null }, 'PLATFORM_REJECTED'],
  [{ code: 403, message: 'captcha 敏感原文' }, 'RISK_BLOCKED'],
  [{ code: 401, message: 'TOKEN_EXPIRED 敏感原文' }, 'LOGIN_REQUIRED'],
] as const) test(`响应严格分类 ${expected}`, async () => {
  const f = setup(); f.socket.respond = () => f.socket.reply('00 0', response)
  await assert.rejects(f.transport.query(params, 'a', 'm1'), (error: unknown) => {
    assert.ok(code(expected)(error)); assert.ok(!String(error).includes('敏感原文')); return true
  }); f.transport.dispose()
})
test('dispose 清理监听和定时器，重复调用安全', async () => {
  const f = setup(); let removed = 0
  const original = f.socket.removeEventListener.bind(f.socket)
  f.socket.removeEventListener = (...args) => { removed++; original(...args) }
  const result = f.transport.query(params, 'a', 'm1')
  f.transport.dispose(); f.transport.dispose()
  await assert.rejects(result, code('RESULT_UNKNOWN'))
  assert.equal(removed, 3); assert.equal(f.clears(), 1)
  await assert.rejects(f.transport.query(params, 'a', 'm2'))
})
test('空闲 dispose 不产生在途未知；在途 dispose 的后续请求保持未知且不再发送', async () => {
  const idle = setup()
  idle.transport.dispose()
  await assert.rejects(idle.transport.query(params, 'a', 'idle'), code('PAGE_NOT_READY'))
  assert.equal(idle.socket.sent.length, 0)

  const active = setup()
  const pending = active.transport.query(params, 'a', 'first')
  active.transport.dispose()
  await assert.rejects(pending, code('RESULT_UNKNOWN'))
  active.transport.dispose()
  await assert.rejects(active.transport.query(params, 'a', 'next'), code('RESULT_UNKNOWN'))
  assert.equal(active.socket.sent.length, 1)
})
// 监听注册只完成一部分时必须回滚已注册部分：残留的 message 处理器会在后续请求
// 期间被旧连接触发，把无关消息当成当前在途响应，造成提前失败关闭。
test('listener 注册中途失败要摘除已注册监听，不污染后续绑定', async () => {
  const first = new Socket()
  const added: string[] = [], removed: string[] = []
  const originalAdd = first.addEventListener.bind(first)
  const originalRemove = first.removeEventListener.bind(first)
  first.addEventListener = ((type: string, listener: EventListener) => {
    if (type === 'close') throw new Error('页面连接拒绝注册监听')
    added.push(type)
    originalAdd(type, listener)
  }) as typeof first.addEventListener
  first.removeEventListener = ((type: string, listener: EventListener) => {
    removed.push(type)
    originalRemove(type, listener)
  }) as typeof first.removeEventListener

  let current = first
  const transport = createChatReadTransport({ getSocket: () => current, readAccountId: () => 'a', now: () => 0, random: () => 0 })
  await assert.rejects(transport.query(params, 'a', 'm1'), code('PAGE_NOT_READY'))
  assert.deepEqual(added, ['message'])
  assert.equal(first.sent.length, 0)
  assert.ok(removed.includes('message'))

  // 换到新连接后，旧连接上的同格式消息不得终结新连接上的在途请求。
  const second = new Socket(); current = second
  const result = transport.query(params, 'a', 'm2')
  let settled: unknown = 'pending'
  void result.then(value => { settled = value }, error => { settled = error })
  first.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ headers: { mid: '00 0' }, code: 200, body: {} }) }))
  await Promise.resolve()
  assert.equal(settled, 'pending')
  second.reply('00 0')
  assert.deepEqual(await result, {})
  transport.dispose()
})

test('连接替换后拒绝旧连接响应，不向新连接重发', async () => {
  const first = new Socket(), second = new Socket()
  let current = first
  const transport = createChatReadTransport({ getSocket: () => current, readAccountId: () => 'a' })
  const result = transport.query(params, 'a', 'm1')
  current = second
  second.reply()
  first.reply()
  // 旧连接上的在途请求无法确认终结，只能按未知超时失败关闭，不能冒充未派发。
  await assert.rejects(result, code('TIMEOUT'))
  assert.equal(first.sent.length, 1); assert.equal(second.sent.length, 0)
  transport.dispose()
})
test('成功后的账号切换也会永久停用实例', async () => {
  const f = setup(); f.socket.respond = () => f.socket.reply()
  await f.transport.query(params, 'a', 'm1')
  f.change()
  await assert.rejects(f.transport.query(params, 'b', 'm2'), code('ACCOUNT_CHANGED'))
  assert.equal(f.socket.sent.length, 1)
})
test('迟到同步响应按时钟判定超时，定时器调度延迟不放行', async () => {
  const socket = new Socket(); let clock = 0
  const transport = createChatReadTransport({ getSocket: () => socket, readAccountId: () => 'a', now: () => clock, random: () => 0 })
  const result = transport.query(params, 'a', 'm1')
  clock = 15000; socket.reply()
  await assert.rejects(result, code('TIMEOUT'))
  transport.dispose()
})
test('线上 mid 采用平台格式并只精确匹配本请求', async () => {
  const { socket, transport } = setup()
  const result = transport.query(params, 'a', 'caller-uuid')
  assert.equal(JSON.parse(socket.sent[0]!).headers.mid, '00 0')
  socket.reply('caller-uuid'); socket.reply('00 1'); socket.reply('x00 0')
  socket.reply('00 0', { body: { ok: 1 } })
  assert.deepEqual(await result, { ok: 1 })
  transport.dispose()
})
