import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPageChat } from '../page-chat.ts'

function setup() {
  let account: string | null = 'a', created = 0, sends = 0
  class Fake extends EventTarget {
    constructor(_url: string) { super(); created++ }
    send() { sends++ }
  }
  const scope = { WebSocket: Fake as unknown as typeof WebSocket }
  const chat = createPageChat(scope, () => account)
  const socket = new scope.WebSocket('wss://wss-goofish.dingtalk.com/')
  const emit = (id: string, text = '正文') => socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ body: { syncPushPackage: { data: [{ data: { '1': {
    '2': 'session@goofish', '3': id, '5': 1700000000000,
    '10': { senderUserId: 'sender', reminderContent: text, reminderUrl: 'https://www.goofish.com/im?sid=session' },
  } } }] } } }) }))
  return { chat, scope, Fake, emit, socket, setAccount: (value: string | null) => { account = value }, created: () => created, sends: () => sends }
}

test('假页面真实形状帧经过 parser 入队，peek/drain 非破坏且 ack 后移除', () => {
  const f = setup()
  try {
    f.emit('m1'); f.emit('m2')
    const first = f.chat.peek('a', 1)
    assert.equal(first[0].sourceId, 'm1')
    first[0].text = '调用者修改'
    assert.equal(f.chat.drain('a', 1)[0].text, '正文')
    assert.equal(f.chat.status().queued, 2)
    assert.equal(f.chat.ack('a', ['m1']), 1)
    assert.deepEqual(f.chat.peek('a', 100).map(m => m.sourceId), ['m2'])
    assert.equal(f.chat.ack('a', ['m1']), 0)
    assert.equal(f.created(), 1); assert.equal(f.sends(), 0)
    for (const limit of [0, 101, 1.1]) assert.throws(() => f.chat.peek('a', limit))
  } finally { f.chat.dispose() }
})
test('重复不占容量，冲突保留原文并标同步缺口，解析失败不暴露原帧', () => {
  const f = setup()
  try {
    f.emit('m'); f.emit('m'); assert.equal(f.chat.status().queued, 1)
    f.emit('m', '冲突'); assert.equal(f.chat.status().syncRequired, true)
    assert.equal(f.chat.peek('a', 1)[0].text, '正文')
    f.socket.dispatchEvent(new MessageEvent('message', { data: '{secret' }))
    assert.equal(JSON.stringify(f.chat.status()).includes('secret'), false)
  } finally { f.chat.dispose() }
})
test('账号切换不重标旧消息，匿名和读取异常明确标缺口', () => {
  const f = setup()
  try {
    f.emit('same'); f.setAccount('b'); f.emit('same', '乙正文')
    assert.throws(() => f.chat.peek('a', 100), { code: 'ACCOUNT_CHANGED' })
    assert.throws(() => f.chat.ack('a', ['same']), { code: 'ACCOUNT_CHANGED' })
    assert.equal(f.chat.peek('b', 100)[0].text, '乙正文')
    f.chat.ack('b', ['same']); f.setAccount('a')
    assert.equal(f.chat.peek('a', 100)[0].text, '正文')
    f.setAccount(null); f.emit('anonymous'); assert.equal(f.chat.status().syncRequired, true)
  } finally { f.chat.dispose() }
  class Fake extends EventTarget {}
  const scope = { WebSocket: Fake as unknown as typeof WebSocket }
  const chat = createPageChat(scope, () => { throw new Error('secret') })
  new scope.WebSocket('wss://wss-goofish.dingtalk.com/').dispatchEvent(new MessageEvent('message', { data: '{}' }))
  assert.equal(chat.status().syncRequired, true); chat.dispose()
})
test('1000条和4MiB硬上限，溢出不淘汰已有项，ack后仍保留缺口', () => {
  const f = setup()
  try {
    for (let i = 0; i < 1001; i++) f.emit(`m${i}`)
    assert.equal(f.chat.status().queued, 1000); assert.equal(f.chat.status().syncRequired, true)
    f.chat.ack('a', ['m0']); assert.equal(f.chat.status().syncRequired, true)
  } finally { f.chat.dispose() }
  const bytes = setup()
  try {
    for (let i = 0; i < 300; i++) bytes.emit(`m${i}`, 'x'.repeat(20000))
    assert.ok(bytes.chat.status().bytes <= 4 * 1024 * 1024)
    assert.ok(bytes.chat.status().queued < 300); assert.equal(bytes.chat.status().syncRequired, true)
  } finally { bytes.chat.dispose() }
})
test('dispose 清理监听和队列，幂等且不关闭socket或发送', () => {
  const f = setup(); f.emit('m'); f.chat.dispose(); f.chat.dispose(); f.emit('late')
  assert.equal(f.scope.WebSocket, f.Fake)
  assert.equal(f.chat.status().queued, 0); assert.equal(f.chat.status().disposed, true)
  assert.throws(() => f.chat.peek('a', 1), { code: 'PAGE_NOT_READY' })
  assert.equal(f.sends(), 0)
})

test('同一来源ID跨会话冲突整批拒绝，不覆盖已有绑定', () => {
  const f = setup()
  try {
    const data = ['one', 'two'].map(session => ({ data: { '1': {
      '2': `${session}@goofish`, '3': 'same-source', '5': 1,
      '10': { senderUserId: 'sender', reminderContent: '文本' },
    } } }))
    f.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ body: { syncPushPackage: { data } } }) }))
    assert.equal(f.chat.status().queued, 0)
    assert.equal(f.chat.status().bytes, 0)
    assert.equal(f.chat.status().syncRequired, true)
  } finally { f.chat.dispose() }
})

test('冲突和解析失败会唤醒采集，不能只在内存标缺口', () => {
  class Fake extends EventTarget {}
  const scope = { WebSocket: Fake as unknown as typeof WebSocket }
  let notices = 0
  const page = createPageChat(scope, () => 'a', () => { notices++ })
  const socket = new scope.WebSocket('wss://wss-goofish.dingtalk.com/')
  try {
    socket.dispatchEvent(new MessageEvent('message', { data: '{invalid' }))
    assert.equal(notices, 1)
    assert.equal(page.status().syncRequired, true)
  } finally { page.dispose() }
})

function syncSetup() {
  let account = 'a'
  class Socket extends EventTarget {
    readyState = 0
    sent: string[] = []
    respond?: (raw: string) => void
    send(raw: string) {
      this.sent.push(raw)
      if (this.respond) { this.respond(raw); return }
      const { headers } = JSON.parse(raw)
      const body = JSON.parse(raw).lwp === '/r/MessageSend/sendByReceiverScope'
        ? { messageId: 'm1', success: true }
        : { userConvs: [], hasMore: false }
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ headers, code: 200, body }) }))
    }
    reply(mid: string) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ headers: { mid }, code: 200, body: { messageId: 'pm1' } }) })) }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
    close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  }
  const scope = { WebSocket: Socket as unknown as typeof WebSocket }
  const chat = createPageChat(scope, () => account)
  const socket = () => new scope.WebSocket('wss://wss-goofish.dingtalk.com/') as unknown as Socket
  return { chat, socket, account: (value: string) => { account = value } }
}
const syncParams = { mode: 'conversations' as const, anchor: '9007199254740991', limit: 10 }
test('同步仅使用唯一观察到的OPEN连接，归一化单页，不自动创建连接', async () => {
  const f = syncSetup()
  assert.equal(f.chat.getSocket(), null)
  const socket = f.socket()
  assert.equal(f.chat.getSocket(), null)
  socket.open(); assert.equal(f.chat.getSocket(), socket)
  assert.deepEqual(await f.chat.queryPage(syncParams, 'a', 'one'), {
    mode: 'conversations', conversations: [], hasMore: false, nextAnchor: null, unsupportedCount: 0,
  })
  assert.equal(socket.sent.length, 1)
  f.chat.dispose(); assert.equal(f.chat.getSocket(), null)
})
test('多个OPEN时拒绝，未派发失败不毒化；唯一后可按新请求绑定', async () => {
  const f = syncSetup(), one = f.socket(), two = f.socket()
  one.open(); two.open(); assert.equal(f.chat.getSocket(), null)
  await assert.rejects(f.chat.queryPage(syncParams, 'a', 'one'), { code: 'PAGE_NOT_READY' })
  one.close(); assert.equal(f.chat.getSocket(), two)
  await f.chat.queryPage(syncParams, 'a', 'two')
  assert.equal(one.sent.length, 0); assert.equal(two.sent.length, 1); f.chat.dispose()
})
test('账号切换清除观测代次，切回账号不能重新认领旧连接', () => {
  const f = syncSetup(), old = f.socket(); old.open()
  f.account('b'); assert.equal(f.chat.getSocket(), null)
  f.account('a'); assert.equal(f.chat.getSocket(), null)
  old.dispatchEvent(new MessageEvent('message', { data: '{}' }))
  assert.equal(f.chat.getSocket(), null)
  const fresh = f.socket(); fresh.open(); assert.equal(f.chat.getSocket(), fresh)
  f.chat.dispose()
})
test('在途连接被替换时失败关闭，不把旧请求转移到新连接', async () => {
  const f = syncSetup(), old = f.socket(); old.open()
  // send 内模拟旧连接在请求送达前断开，结果无法确认。
  old.send = function (raw: string) { this.sent.push(raw); this.close() }
  await assert.rejects(f.chat.queryPage(syncParams, 'a', 'one'), { code: 'TIMEOUT' })
  const fresh = f.socket(); fresh.open()
  await assert.rejects(f.chat.queryPage(syncParams, 'a', 'two'), { code: 'TIMEOUT' })
  assert.equal(fresh.sent.length, 0); f.chat.dispose()
})
test('空闲旧连接被替换后，同一页面实例可安全绑定新的唯一OPEN连接', async () => {
  const f = syncSetup(), old = f.socket(); old.open()
  await f.chat.queryPage(syncParams, 'a', 'one')
  old.close()
  const fresh = f.socket(); fresh.open()
  await f.chat.queryPage(syncParams, 'a', 'two')
  assert.equal(old.sent.length, 1)
  assert.equal(fresh.sent.length, 1)
  f.chat.dispose()
})
test('页面自行重载后旧观察实例不接收新文档代次的连接', async () => {
  const f = syncSetup(), old = f.socket(); old.open()
  await f.chat.queryPage(syncParams, 'a', 'old')
  // 新文档会创建新的 createPageChat 实例；旧实例仍保留旧 socket 集合。
  const fresh = f.socket(); fresh.open()
  assert.equal(f.chat.getSocket(), null)
  f.chat.dispose()
})

test('chatSend 只使用唯一观察连接并从页面账号注入 myId', async () => {
  const f = syncSetup(); const socket = f.socket(); socket.open()
  socket.respond = raw => socket.reply(JSON.parse(raw).headers.mid)
  const result = await f.chat.chatSend({ sessionId: 's', receiverId: 'r', text: '询价' }, 'a', 'send-1')
  assert.equal(result.messageId.length > 0, true)
  assert.equal(socket.sent.length, 1)
  const envelope = JSON.parse(socket.sent[0]!)
  assert.deepEqual(envelope.body[1], { actualReceivers: ['r@goofish', 'a@goofish'] })
  f.chat.dispose()
})
test('chatSend 无唯一 socket 不发送，账号变化拒绝', async () => {
  const f = syncSetup()
  await assert.rejects(f.chat.chatSend({ sessionId: 's', receiverId: 'r', text: 'x' }, 'a', 'send-1'), { code: 'PAGE_NOT_READY' })
  const socket = f.socket(); socket.open(); f.account('b')
  await assert.rejects(f.chat.chatSend({ sessionId: 's', receiverId: 'r', text: 'x' }, 'a', 'send-2'), { code: 'ACCOUNT_CHANGED' })
  assert.equal(socket.sent.length, 0); f.chat.dispose()
})

test('页面缺口身份重复读取稳定，新缺口推进且账号隔离', () => {
  const f = setup()
  try {
    f.emit('m'); f.emit('m', '冲突')
    const first = f.chat.gapOccurrences('a')
    assert.equal(first.length, 1)
    assert.equal(first[0].generation, 1)
    assert.deepEqual(f.chat.gapOccurrences('a'), first)
    first[0].generation = 99
    assert.equal(f.chat.gapOccurrences('a')[0].generation, 1)
    f.socket.dispatchEvent(new MessageEvent('message', { data: '{invalid' }))
    const gaps = f.chat.gapOccurrences('a')
    assert.equal(gaps.length, 2)
    const next = gaps[1]
    assert.equal(next.generation, 2)
    assert.notEqual(next.occurrenceId, first[0].occurrenceId)
    f.setAccount('b')
    assert.deepEqual(f.chat.gapOccurrences('b'), [])
    assert.equal(f.chat.requiresSync('b'), false)
    assert.throws(() => f.chat.gapOccurrences('a'), { code: 'ACCOUNT_CHANGED' })
    f.setAccount('a')
    assert.deepEqual(f.chat.gapOccurrences('a'), gaps)
    assert.equal(f.chat.requiresSync('a'), true)
    assert.equal(f.sends(), 0)
  } finally { f.chat.dispose() }
})

test('连续缺口全部保留为有界 FIFO，不静默覆盖前一次丢失', () => {
  const f = setup()
  try {
    f.emit('m'); f.emit('m', '冲突')
    f.socket.dispatchEvent(new MessageEvent('message', { data: '{invalid' }))
    const gaps = f.chat.gapOccurrences('a')
    assert.equal(gaps.length, 2)
    assert.notEqual(gaps[0].occurrenceId, gaps[1].occurrenceId)
    assert.deepEqual(gaps.map(item => item.generation), [1, 2])
    assert.equal(f.chat.requiresSync('a'), true)
    const copy = f.chat.gapOccurrences('a'); copy[0].generation = 99
    assert.equal(f.chat.gapOccurrences('a')[0].generation, 1)
    assert.equal(f.sends(), 0)
  } finally { f.chat.dispose() }
})

test('缺口诊断仅含固定原因计数，读取副本不泄漏原帧', () => {
  const f = setup()
  try {
    f.emit('m'); f.emit('m', '冲突')
    f.socket.dispatchEvent(new MessageEvent('message', { data: '{secret-token' }))
    assert.deepEqual(f.chat.gapDiagnostics(), { SOURCE_CONFLICT: 1, DETAIL_FRAME: 1, PARSE_INVALID_JSON: 1 })
    const view = f.chat.gapDiagnostics(); view.SOURCE_CONFLICT = 99
    assert.equal(f.chat.gapDiagnostics().SOURCE_CONFLICT, 1)
    assert.equal(JSON.stringify(f.chat.gapDiagnostics()).includes('secret'), false)
  } finally { f.chat.dispose() }
})

test('监视器拒绝帧会建立当前账号缺口并唤醒，不能静默丢失', () => {
  const f = setup()
  try {
    f.socket.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([1]) }))
    assert.equal(f.chat.requiresSync('a'), true)
    assert.equal(f.chat.gapOccurrences('a').length, 1)
    assert.deepEqual(f.chat.gapDiagnostics(), { MONITOR_NON_STRING_FRAME: 1 })
    f.socket.dispatchEvent(new MessageEvent('message', { data: 'x'.repeat(262145) }))
    const gaps = f.chat.gapOccurrences('a')
    assert.equal(gaps.length, 2)
    assert.equal(gaps[1].generation, 2)
    assert.equal(f.chat.gapDiagnostics().MONITOR_FRAME_TOO_LARGE, 1)
    assert.equal(f.sends(), 0)
  } finally { f.chat.dispose() }
})

test('未知结构组合诊断最多64类，不随输入持续增长', () => {
  const f = setup()
  try {
    for (let n = 0; n < 200; n++) {
      const data: Record<string, unknown> = {}
      for (const [bit, key] of ['2', '3', '4', '5', '6', '10', 'message', 'cid'].entries()) if (n & (1 << bit)) data[key] = true
      f.socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ body: { syncPushPackage: { data: [{ data }] } } }) }))
    }
    const counts = f.chat.gapDiagnostics()
    assert.ok(Object.keys(counts).length <= 64)
    assert.ok(counts.DIAGNOSTIC_OVERFLOW > 0)
    assert.equal(counts.PARSE_INVALID_MESSAGE, 200)
    assert.equal(f.sends(), 0)
  } finally { f.chat.dispose() }
})
