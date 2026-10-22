import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installChatSocketMonitor } from '../chat-socket-monitor.ts'

function fixture() {
  let created = 0, sends = 0
  class FakeSocket extends EventTarget {
    static readonly OPEN = 1
    static readonly CONNECTING = 0
    static marker = Symbol('静态属性')
    constructor(publicUrl: string | URL, protocols?: string | string[]) {
      super(); void publicUrl; void protocols; created++
    }
    send() { sends++ }
  }
  const scope = { WebSocket: FakeSocket as unknown as typeof WebSocket }
  return { scope, FakeSocket, created: () => created, sends: () => sends }
}
const target = 'wss://wss-goofish.dingtalk.com/'

test('仅页面 new 时委托一次，保留静态属性、instanceof 与子类，绝不 send', () => {
  const f = fixture(), messages: string[] = []
  const monitor = installChatSocketMonitor(f.scope, { onMessage: data => messages.push(data) })
  assert.equal(f.created(), 0)
  assert.equal(f.scope.WebSocket.OPEN, 1)
  assert.equal((f.scope.WebSocket as any).marker, f.FakeSocket.marker)
  const socket = new f.scope.WebSocket(target)
  assert.equal(f.created(), 1)
  assert.ok(socket instanceof f.scope.WebSocket)
  assert.ok(socket instanceof f.FakeSocket)
  class Derived extends f.scope.WebSocket {}
  const derived = new Derived(target)
  assert.ok(derived instanceof Derived)
  assert.equal(f.created(), 2)
  socket.dispatchEvent(new MessageEvent('message', { data: '消息' }))
  assert.deepEqual(messages, ['消息']); assert.equal(f.sends(), 0)
  monitor.dispose()
})

test('精确目标 wss、默认端口；拒绝 userinfo、非默认端口与相似域名', () => {
  const f = fixture(), messages: string[] = []
  const monitor = installChatSocketMonitor(f.scope, { onMessage: data => messages.push(data) })
  for (const url of [target, 'wss://wss-goofish.dingtalk.com:443/path',
    'ws://wss-goofish.dingtalk.com/', 'https://wss-goofish.dingtalk.com/',
    'wss://wss-goofish.dingtalk.com.evil.test/', 'wss://evil.test/wss-goofish.dingtalk.com',
    'wss://name@wss-goofish.dingtalk.com/', 'wss://name:secret@wss-goofish.dingtalk.com/',
    'wss://wss-goofish.dingtalk.com:444/']) {
    const socket = new f.scope.WebSocket(url)
    socket.dispatchEvent(new MessageEvent('message', { data: '消息' }))
  }
  assert.equal(messages.length, 2); assert.equal(f.sends(), 0)
  monitor.dispose()
})

test('字符串帧按 UTF-8 字节限制 256 KiB，非字符串不交给解析器', () => {
  const f = fixture(), lengths: number[] = []
  const monitor = installChatSocketMonitor(f.scope, { onMessage: data => lengths.push(data.length) })
  const socket = new f.scope.WebSocket(new URL(target))
  for (const data of ['a'.repeat(262144), 'a'.repeat(262145), '中'.repeat(87381),
    '中'.repeat(87382), new Uint8Array(1), new Blob(['x']), null]) {
    socket.dispatchEvent(new MessageEvent('message', { data }))
  }
  assert.deepEqual(lengths, [262144, 87381]); assert.equal(f.sends(), 0)
  monitor.dispose()
})

test('open/close 回调、关闭后释放监听，dispose 幂等且不关闭页面 socket', () => {
  const f = fixture(), events: string[] = []
  const monitor = installChatSocketMonitor(f.scope, {
    onOpen: () => events.push('open'), onClose: () => events.push('close'), onMessage: () => events.push('message'),
  })
  const socket = new f.scope.WebSocket(target)
  socket.dispatchEvent(new Event('open')); socket.dispatchEvent(new Event('close'))
  socket.dispatchEvent(new MessageEvent('message', { data: 'late' }))
  assert.deepEqual(events, ['open', 'close'])
  const other = new f.scope.WebSocket(target)
  monitor.dispose(); monitor.dispose()
  other.dispatchEvent(new Event('open')); other.dispatchEvent(new MessageEvent('message', { data: 'late' }))
  assert.deepEqual(events, ['open', 'close'])
  assert.equal(f.scope.WebSocket, f.FakeSocket); assert.equal(f.sends(), 0)
})

test('回调异常不影响页面；dispose 不覆盖第三方 wrapper，旧 wrapper 不再监听', () => {
  const f = fixture()
  const monitor = installChatSocketMonitor(f.scope, { onMessage: () => { throw new Error('测试异常') } })
  const old = f.scope.WebSocket, socket = new old(target)
  assert.doesNotThrow(() => socket.dispatchEvent(new MessageEvent('message', { data: 'x' })))
  const third = new Proxy(old, {})
  f.scope.WebSocket = third
  monitor.dispose()
  assert.equal(f.scope.WebSocket, third)
  new third(target)
  assert.equal(f.created(), 2); assert.equal(f.sends(), 0)
})

test('不可消费帧仅上报固定丢失原因，不把内容交给解析或日志', () => {
  const f = fixture(), reasons: string[] = []
  const monitor = installChatSocketMonitor(f.scope, { onMessage: () => assert.fail(), onDropped: reason => reasons.push(reason) })
  const socket = new f.scope.WebSocket(target)
  socket.dispatchEvent(new MessageEvent('message', { data: new Blob(['secret']) }))
  socket.dispatchEvent(new MessageEvent('message', { data: '中'.repeat(100000) }))
  assert.deepEqual(reasons, ['NON_STRING_FRAME', 'FRAME_TOO_LARGE'])
  monitor.dispose()
  socket.dispatchEvent(new MessageEvent('message', { data: null }))
  assert.equal(reasons.length, 2)
  assert.equal(f.sends(), 0)
})
