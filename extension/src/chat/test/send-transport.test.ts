/**
 * send-transport.ts 单测：发送白名单、mid 关联、10 秒超时、无 socket、重复 mid、释放。
 * 使用假 WebSocket，绝不连接真实网络、绝不发送真实消息。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSendMessageLwpRequest, generateSendMid, generateSendUuid } from '../send-protocol'
import { ChatSendSocketTransport, ChatSendTransportError } from '../send-transport'
import type { WebSocketLike } from '../websocket'

class FakeSocket implements WebSocketLike {
  readyState = 1
  readonly sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
}

function buildRequest(mid: string) {
  return buildSendMessageLwpRequest({
    sessionId: 's1',
    receiverId: 'p1',
    myId: 'm1',
    content: 'hello',
    mid,
    uuid: generateSendUuid(1700000000000, 0.1),
  })
}

test('发送标准信封并按 mid 关联响应', async () => {
  const socket = new FakeSocket()
  const transport = new ChatSendSocketTransport({ getSocket: () => socket })
  const request = buildRequest('mid-1')

  const promise = transport.send(request)
  assert.equal(socket.sent.length, 1)
  assert.equal(transport.pendingCount, 1)

  // 其它 mid 不消化
  assert.equal(transport.handleMessage(JSON.stringify({ code: 200, headers: { mid: 'other' }, body: {} })), false)
  assert.equal(transport.handleMessage(JSON.stringify({ code: 200, headers: { mid: 'mid-1' }, body: {} })), true)

  const response = await promise
  assert.equal(response.code, 200)
  assert.equal(transport.pendingCount, 0)
})

test('默认超时为 10 秒，且超时返回结构化 TIMEOUT', async () => {
  const socket = new FakeSocket()
  let fire: (() => void) | null = null
  let registeredMs = 0
  const transport = new ChatSendSocketTransport({
    getSocket: () => socket,
    setTimer: (fn, ms) => {
      fire = fn
      registeredMs = ms
      return 0 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {},
  })

  const promise = transport.send(buildRequest('mid-timeout'))
  assert.equal(registeredMs, 10000)
  assert.ok(fire)
  ;(fire as unknown as () => void)()
  await assert.rejects(
    () => promise,
    (error: unknown) => error instanceof ChatSendTransportError && error.code === 'TIMEOUT',
  )
})

test('无可用 socket 返回 NO_SOCKET，且不触碰 socket', async () => {
  const transport = new ChatSendSocketTransport({ getSocket: () => null })
  await assert.rejects(
    () => transport.send(buildRequest('m')),
    (error: unknown) => error instanceof ChatSendTransportError && error.code === 'NO_SOCKET',
  )
})

test('非发送路由 / 非标准信封被拒绝，且不发送', async () => {
  const socket = new FakeSocket()
  const transport = new ChatSendSocketTransport({ getSocket: () => socket })
  const readRoute = { lwp: '/r/Conversation/listNewestPagination', headers: { mid: 'm' }, body: [1, 20] }
  await assert.rejects(
    () => transport.send(readRoute as never),
    (error: unknown) => error instanceof ChatSendTransportError && error.code === 'ROUTE_NOT_ALLOWED',
  )
  assert.equal(socket.sent.length, 0)
})

test('同一 mid 重复发送被拒绝', async () => {
  const socket = new FakeSocket()
  const transport = new ChatSendSocketTransport({ getSocket: () => socket })
  const pending = transport.send(buildRequest('same'))
  await assert.rejects(
    () => transport.send(buildRequest('same')),
    (error: unknown) => error instanceof ChatSendTransportError && error.code === 'DUPLICATE_MID',
  )
  transport.dispose()
  await assert.rejects(() => pending)
})

test('dispose 后拒绝所有发送', async () => {
  const socket = new FakeSocket()
  const transport = new ChatSendSocketTransport({ getSocket: () => socket })
  transport.dispose()
  await assert.rejects(
    () => transport.send(buildRequest(generateSendMid(1, 0))),
    (error: unknown) => error instanceof ChatSendTransportError && error.code === 'NO_SOCKET',
  )
})
