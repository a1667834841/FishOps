/**
 * chat-host.ts 单元测试：MAIN world host 的监听、上报与只读 transport 复用。
 * 纯 Node，使用假 WebSocket，不连真实网络；关键：不改动页面行为、monitor 从不 send。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CHAT_SOCKET_MAX_RAW_LENGTH, type ChatSocketEventPayload } from '@fishops/shared'
import { createLwpRequest, LWP_ROUTES } from '../../../../shared/chat/index'
import { createChatHost } from '../chat-host'
import { probeChatSocketInPage } from '../socket-readiness'
import { ChatWebSocketMonitor, type WebSocketConstructorLike, type WebSocketLike } from '../websocket'

class FakeWebSocket implements WebSocketLike {
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
    if (type === 'open') this.readyState = 1
    if (type === 'close') this.readyState = 3
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const FakeCtor = FakeWebSocket as unknown as WebSocketConstructorLike
const TARGET = 'wss://wss-goofish.dingtalk.com/'

function setup() {
  const reported: ChatSocketEventPayload[] = []
  const host = createChatHost({ report: (payload) => reported.push(payload), now: () => 1000 })
  const monitor = new ChatWebSocketMonitor(host.handlers)
  const Wrapped = monitor.wrap(FakeCtor)
  const socket = new Wrapped(TARGET) as unknown as FakeWebSocket
  return { reported, host, monitor, socket }
}

test('只读监听：转发实时消息 / open / close / error，且 monitor 从不 send', () => {
  const { reported, socket } = setup()

  socket.emit('open', {})
  socket.emit('message', { data: '{"code":200,"body":{"content":{"custom":{}}}}' })
  socket.emit('close', { code: 1000, reason: 'bye' })
  socket.emit('error', new Error('boom'))

  assert.deepEqual(
    reported.map((event) => event.event),
    ['open', 'message', 'close', 'error'],
  )
  assert.equal(reported[1].raw, '{"code":200,"body":{"content":{"custom":{}}}}')
  assert.equal(reported[2].code, 1000)
  assert.equal(reported[2].reason, 'bye')
  // monitor 只监听，从不写 socket
  assert.equal(socket.sendCalls.length, 0)
})

test('只读 LWP 响应被 transport 消化，不作为实时消息上报', async () => {
  const { reported, host, socket } = setup()
  const request = createLwpRequest(LWP_ROUTES.listMessages, ['1@goofish', false, 0, 20, false], 'mid-lwp')

  socket.emit('open', {})
  reported.length = 0
  const pending = host.transport.send(request)
  // transport 复用已建立 socket 发送白名单请求（这是唯一的写 socket 位置）
  assert.equal(socket.sendCalls.length, 1)

  socket.emit('message', { data: JSON.stringify({ code: 200, headers: { mid: 'mid-lwp' }, body: { ok: 1 } }) })
  const response = await pending
  assert.equal(response.code, 200)
  assert.equal(reported.length, 0, 'LWP 响应不应触发实时消息上报')
})

test('超长帧上报但不带 raw（避免拖垮 background）', () => {
  const { reported, host } = setup()
  host.handleSocketMessage('x'.repeat(CHAT_SOCKET_MAX_RAW_LENGTH + 1))
  assert.equal(reported.length, 1)
  assert.equal(reported[0].event, 'message')
  assert.equal('raw' in reported[0], false)
})

test('reportStatus：connecting 不上报，open/closed/error 上报', () => {
  const { reported, host } = setup()
  host.reportStatus('connecting')
  host.reportStatus('open')
  host.reportStatus('closed')
  host.reportStatus('error')
  assert.deepEqual(
    reported.map((event) => event.event),
    ['open', 'close', 'error'],
  )
})

test('连接快照：直接读取 transport 的真实连接状态，不依赖已上报事件', () => {
  const host = createChatHost({ report: () => {} })
  assert.equal(host.getSocketStatus(), null)
  const socket = new FakeWebSocket(TARGET)
  host.attachSocket(socket)
  assert.equal(host.getSocketStatus(), 'connecting')
  socket.readyState = 1
  assert.equal(host.getSocketStatus(), 'open')
  socket.readyState = 2
  assert.equal(host.getSocketStatus(), 'closed')
  socket.readyState = 3
  assert.equal(host.getSocketStatus(), 'closed')
  assert.equal(socket.sendCalls.length, 0)
  host.dispose()
})

test('页面连接探测：host 缺失或旧版 host 返回 null，新版只返回合法状态', () => {
  const page = globalThis as Record<string, unknown>
  const original = page.__FISHOPS_CHAT_TRANSPORT__
  try {
    delete page.__FISHOPS_CHAT_TRANSPORT__
    assert.equal(probeChatSocketInPage(), null)
    page.__FISHOPS_CHAT_TRANSPORT__ = { send: () => {} }
    assert.equal(probeChatSocketInPage(), null)
    page.__FISHOPS_CHAT_TRANSPORT__ = { getSocketStatus: () => 'open' }
    assert.equal(probeChatSocketInPage(), 'open')
    page.__FISHOPS_CHAT_TRANSPORT__ = { getSocketStatus: () => ({ secret: '不得透传' }) }
    assert.equal(probeChatSocketInPage(), null)
  } finally {
    if (original === undefined) delete page.__FISHOPS_CHAT_TRANSPORT__
    else page.__FISHOPS_CHAT_TRANSPORT__ = original
  }
})

test('消息携带宿主连接边界，时间推进不重置；新连接重新记录', () => {
  let time = 100
  const events: ChatSocketEventPayload[] = []
  const host = createChatHost({ report: p => events.push(p), now: () => time })
  host.reportStatus('open')
  time = 200
  host.handleSocketMessage('{}')
  assert.equal(events.at(-1)?.connectedAt, 100)
  time = 300
  host.attachSocket(new FakeWebSocket(TARGET))
  time = 400
  host.handleSocketMessage('{}')
  assert.equal(events.at(-1)?.connectedAt, 300)
})
