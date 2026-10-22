import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChatWriteTransport, type ChatWriteSocket } from '../chat-write-transport.ts'
class Socket extends EventTarget implements ChatWriteSocket {
  readyState = 1; sent: string[] = []; respond?: (raw: string) => void
  send(raw: string) { this.sent.push(raw); this.respond?.(raw) }
  reply(mid: string, patch: Record<string, unknown> = {}) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ headers: { mid }, code: 200, body: { messageId: 'pm1' }, ...patch }) })) }
}
const input = { sessionId: 's', receiverId: 'r', myId: 'a', text: '你好' }
function setup() { const socket = new Socket(); let fire!: () => void; const t = createChatWriteTransport({ now: () => 123, random: () => .1, setTimer: fn => { fire = fn; return 1 }, clearTimer: () => {} }); return { socket, t, fire: () => fire() } }
const code = (value: string) => (e: unknown) => !!e && (e as { code?: string }).code === value

test('严格构造固定 envelope、base64 文本和双 receiver，send 一次', async () => { const f = setup(); f.socket.respond = raw => f.socket.reply(JSON.parse(raw).headers.mid); const result = await f.t.send(input, 'a', f.socket); const e = JSON.parse(f.socket.sent[0]); assert.equal(f.socket.sent.length, 1); assert.deepEqual(Object.keys(e), ['lwp', 'headers', 'body']); assert.equal(e.lwp, '/r/MessageSend/sendByReceiverScope'); assert.deepEqual(e.body[1], { actualReceivers: ['r@goofish', 'a@goofish'] }); assert.equal(result.messageId, 'pm1'); f.t.dispose() })
test('同步抢跑和错 mid 忽略，错 route 永久关闭', async () => { const f = setup(); f.socket.respond = raw => { const mid = JSON.parse(raw).headers.mid; f.socket.reply('other'); f.socket.reply(mid, { lwp: '/wrong' }) }; await assert.rejects(f.t.send(input, 'a', f.socket), code('RESULT_UNKNOWN')); await assert.rejects(f.t.send(input, 'a', f.socket), code('RESULT_UNKNOWN')) })
test('同步响应在 send 内抢跑也能完成', async () => { const f = setup(); f.socket.respond = raw => f.socket.reply(JSON.parse(raw).headers.mid); assert.deepEqual(await f.t.send(input, 'a', f.socket), { messageId: 'pm1', sentAt: 123 }); f.t.dispose() })
for (const bad of [{ sessionId: '' }, { receiverId: 'r@goofish' }, { myId: 'b' }, { text: ' ' }, { text: 'x'.repeat(20001) }]) test('输入严格拒绝', async () => { const f = setup(); await assert.rejects(f.t.send({ ...input, ...bad }, 'a', f.socket), code('BAD_REQUEST')); assert.equal(f.socket.sent.length, 0) })
test('无 socket、未开放 socket 和重复 pending 拒绝', async () => { const f = setup(); await assert.rejects(f.t.send(input, 'a', null as never), code('PAGE_NOT_READY')); f.socket.readyState = 0; await assert.rejects(f.t.send(input, 'a', f.socket), code('PAGE_NOT_READY')); f.socket.readyState = 1; const p = f.t.send(input, 'a', f.socket); await assert.rejects(f.t.send(input, 'a', f.socket), code('PAGE_NOT_READY')); f.t.dispose(); await assert.rejects(p) })
test('timeout 后永久 poison，不重试且不关闭 socket', async () => { const f = setup(); const p = f.t.send(input, 'a', f.socket); f.fire(); await assert.rejects(p, code('TIMEOUT')); f.socket.reply('anything'); await assert.rejects(f.t.send(input, 'a', f.socket), code('TIMEOUT')); assert.equal(f.socket.readyState, 1) })
test('close/error、账号变化和 send 异常均未知关闭', async () => { for (const kind of ['close', 'error'] as const) { const f = setup(); const p = f.t.send(input, 'a', f.socket); f.socket.dispatchEvent(new Event(kind)); await assert.rejects(p, code('RESULT_UNKNOWN')); await assert.rejects(f.t.send(input, 'a', f.socket), code('RESULT_UNKNOWN')) } const g = createChatWriteTransport({ readAccountId: () => 'b' }); await assert.rejects(g.send(input, 'a', new Socket()), code('ACCOUNT_CHANGED')); const h = setup(); h.socket.send = () => { throw Error('secret') }; await assert.rejects(h.t.send(input, 'a', h.socket), code('RESULT_UNKNOWN')) })
test('坏响应和固定失败分类不泄漏原文', async () => { for (const patch of [{ body: { secret: 'x' } }, { code: 500, message: 'captcha secret' }, { code: 500, message: 'TOKEN_EXPIRED secret' }, { code: 500, message: '平台 secret' }]) { const f = setup(); const p = f.t.send(input, 'a', f.socket); const mid = JSON.parse(f.socket.sent[0]).headers.mid; f.socket.reply(mid, patch); await assert.rejects(p, (e: unknown) => { assert.ok(!String(e).includes('secret')); return true }) } })
test('dispose 幂等清理、不关闭 socket', async () => { const f = setup(); const p = f.t.send(input, 'a', f.socket); f.t.dispose(); f.t.dispose(); await assert.rejects(p, code('PAGE_NOT_READY')); assert.equal(f.socket.readyState, 1) })
test('真实平台成功响应含多余字段时按 messageId 判定成功，uuid 不符或缺 messageId 视为未知', async () => {
  const ok = setup()
  ok.socket.respond = raw => { const e = JSON.parse(raw); ok.socket.reply(e.headers.mid, { body: { messageId: 'pm', uuid: e.body[0].uuid, extension: {}, receiverCount: 2, createAt: 1, content: {}, unreadCount: 1, msgReadStatusSetting: 1, msgReadStatusDowngrade: 0 } }) }
  assert.deepEqual(await ok.t.send(input, 'a', ok.socket), { messageId: 'pm', sentAt: 123 })
  for (const body of [{ messageId: 'pm', uuid: 'other' }, { uuid: '-1231000' }]) {
    const f = setup(); const p = f.t.send(input, 'a', f.socket)
    f.socket.reply(JSON.parse(f.socket.sent[0]).headers.mid, { body })
    await assert.rejects(p, code('RESULT_UNKNOWN'))
  }
})
test('新发送返回平台 messageId，不回传本地 uuid', async () => {
  const f = setup(); let localUuid = ''
  f.socket.respond = raw => { const e = JSON.parse(raw); localUuid = e.body[0].uuid; f.socket.reply(e.headers.mid, { body: { messageId: 'platform-9001', uuid: e.body[0].uuid } }) }
  const result = await f.t.send(input, 'a', f.socket)
  assert.deepEqual(result, { messageId: 'platform-9001', sentAt: 123 })
  assert.equal(localUuid, '-1231000')
  assert.notEqual(result.messageId, localUuid)
  f.t.dispose()
})
test('平台 messageId 与本地 uuid 相同或不同都按平台值返回', async () => {
  for (const platformId of ['pm-a', '-1231000']) {
    const f = setup()
    f.socket.respond = raw => f.socket.reply(JSON.parse(raw).headers.mid, { body: { messageId: platformId } })
    assert.deepEqual(await f.t.send(input, 'a', f.socket), { messageId: platformId, sentAt: 123 })
    f.t.dispose()
  }
})
test('非法平台 messageId 一律失败关闭，uuid 相符也不能放行', async () => {
  for (const messageId of ['', 'a'.repeat(129), 123, null, 'bad id', {}, true]) {
    const f = setup(); const p = f.t.send(input, 'a', f.socket)
    const e = JSON.parse(f.socket.sent[0])
    f.socket.reply(e.headers.mid, { body: { messageId, uuid: e.body[0].uuid } })
    await assert.rejects(p, code('RESULT_UNKNOWN'))
    assert.equal(f.socket.sent.length, 1)
    f.t.dispose()
  }
})
