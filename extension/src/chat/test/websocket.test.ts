/**
 * websocket.ts 单元测试：只读监听行为（纯 Node，使用假 WebSocket，不连真实网络）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ChatWebSocketMonitor,
  extractStringData,
  installChatWebSocketMonitor,
  type ChatSocketStatus,
  type WebSocketConstructorLike,
  type WebSocketLike,
} from '../websocket'

class FakeWebSocket implements WebSocketLike {
  static readonly OPEN = 1
  readonly url: string
  readyState = 0
  readonly sendCalls: string[] = []
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(url: string) {
    this.url = url
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string): void {
    this.sendCalls.push(data)
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const FakeCtor = FakeWebSocket as unknown as WebSocketConstructorLike

test('只监听目标主机，转发 message/open/close/error，且从不发送', () => {
  const messages: string[] = []
  const statuses: ChatSocketStatus[] = []
  let openCount = 0
  const closes: Array<{ code: number; reason: string }> = []
  let errorCount = 0

  const monitor = new ChatWebSocketMonitor({
    onMessage: (data) => messages.push(data),
    onStatus: (status) => statuses.push(status),
    onOpen: () => (openCount += 1),
    onClose: (info) => closes.push(info),
    onError: () => (errorCount += 1),
  })
  const Wrapped = monitor.wrap(FakeCtor)

  const target = new Wrapped('wss://wss-goofish.dingtalk.com/') as unknown as FakeWebSocket
  const other = new Wrapped('wss://example.com/ws') as unknown as FakeWebSocket

  assert.equal(monitor.activeSockets.length, 1, '只应观察目标 socket')

  target.emit('open', {})
  target.emit('message', { data: 'hello' })
  target.emit('message', { data: 123 }) // 非字符串，应忽略
  target.emit('error', new Error('boom'))
  target.emit('close', { code: 1000, reason: 'bye' })

  // 非目标 socket 不应被挂载监听
  other.emit('message', { data: 'nope' })

  assert.deepEqual(messages, ['hello'])
  assert.equal(openCount, 1)
  assert.equal(errorCount, 1)
  assert.deepEqual(closes, [{ code: 1000, reason: 'bye' }])
  assert.ok(statuses.includes('open'))
  assert.ok(statuses.includes('closed'))
  assert.equal(monitor.activeSockets.length, 0, '关闭后应移除 socket')

  // 关键：只读层从不调用 send
  assert.equal(target.sendCalls.length, 0)
  assert.equal(other.sendCalls.length, 0)
})

test('重复 observe 同一 socket 幂等：不重复注册监听（socket open 不重复连接）', () => {
  const statuses: ChatSocketStatus[] = []
  let openCount = 0
  const monitor = new ChatWebSocketMonitor({
    onStatus: (status) => statuses.push(status),
    onOpen: () => (openCount += 1),
  })

  const socket = new FakeWebSocket('wss://wss-goofish.dingtalk.com/')
  monitor.observe(socket)
  monitor.observe(socket)
  monitor.observe(socket)

  // 重复 observe 只登记一次，不会重复挂载监听（也就不会重复“连接”）。
  assert.equal(monitor.activeSockets.length, 1)

  socket.readyState = 1
  socket.emit('open', {})
  assert.equal(openCount, 1)
  assert.equal(statuses.filter((status) => status === 'open').length, 1)
})

test('监听回调抛错不逃逸到调用方', () => {
  const monitor = new ChatWebSocketMonitor({
    onMessage: () => {
      throw new Error('handler failed')
    },
  })
  const Wrapped = monitor.wrap(FakeCtor)
  const socket = new Wrapped('wss://wss-goofish.dingtalk.com/') as unknown as FakeWebSocket
  assert.doesNotThrow(() => socket.emit('message', { data: 'x' }))
})

test('dispose 后不再观察新连接', () => {
  const seen: string[] = []
  const monitor = new ChatWebSocketMonitor({ onMessage: (d) => seen.push(d) })
  monitor.dispose()
  const Wrapped = monitor.wrap(FakeCtor)
  const socket = new Wrapped('wss://wss-goofish.dingtalk.com/') as unknown as FakeWebSocket
  assert.equal(monitor.activeSockets.length, 0)
  socket.emit('message', { data: 'x' })
  assert.deepEqual(seen, [])
})

test('extractStringData：字符串与事件对象', () => {
  assert.equal(extractStringData('raw'), 'raw')
  assert.equal(extractStringData({ data: 'from-event' }), 'from-event')
  assert.equal(extractStringData({ data: 123 }), null)
  assert.equal(extractStringData(null), null)
})

test('installChatWebSocketMonitor：无 WebSocket 环境返回 null 且不抛错', () => {
  const holder = globalThis as unknown as { WebSocket?: unknown }
  const original = holder.WebSocket
  delete holder.WebSocket
  try {
    assert.equal(installChatWebSocketMonitor({}), null)
  } finally {
    holder.WebSocket = original
  }
})
