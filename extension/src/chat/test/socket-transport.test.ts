/**
 * socket-transport.ts 单元测试：只读 LWP transport 的白名单、mid 关联、超时与拒绝逻辑。
 * 纯 Node，使用假 WebSocket，不连真实网络、不发送聊天消息。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLwpRequest, LWP_ROUTES, type LwpResponse } from '../../../../shared/chat/index'
import {
  ChatSocketTransport,
  ChatSocketTransportError,
  parseLwpResponse,
  validateAllowedLwpRequest,
} from '../socket-transport'
import type { WebSocketLike } from '../websocket'

class FakeSocket implements WebSocketLike {
  readonly sent: string[] = []
  send(data: string): void {
    this.sent.push(data)
  }
}

const listMessages = (mid: string) =>
  createLwpRequest(LWP_ROUTES.listMessages, ['123@goofish', false, 0, 20, false], mid)

test('白名单路由：发送标准信封并按 headers.mid 关联响应', async () => {
  const socket = new FakeSocket()
  const transport = new ChatSocketTransport({ getSocket: () => socket })
  const request = listMessages('mid-1')

  const promise = transport.send(request)
  assert.equal(socket.sent.length, 1)
  assert.deepEqual(JSON.parse(socket.sent[0]), request)
  assert.equal(transport.pendingCount, 1)

  // 未匹配的 mid 不消化
  assert.equal(transport.handleMessage(JSON.stringify({ code: 200, headers: { mid: 'other' }, body: {} })), false)
  assert.equal(
    transport.handleMessage(JSON.stringify({ code: 200, headers: { mid: 'mid-1' }, body: { ok: true } })),
    true,
  )

  const response: LwpResponse = await promise
  assert.equal(response.code, 200)
  assert.equal(transport.pendingCount, 0)
})

test('非白名单路由被拒绝，且不触碰 socket', async () => {
  const socket = new FakeSocket()
  const transport = new ChatSocketTransport({ getSocket: () => socket })
  const request = createLwpRequest('/r/MessageSend/sendByReceiverScope', ['x'], 'mid-2')

  await assert.rejects(
    () => transport.send(request),
    (error: unknown) => error instanceof ChatSocketTransportError && error.code === 'ROUTE_NOT_ALLOWED',
  )
  assert.equal(socket.sent.length, 0)
})

test('信封多字段 / headers 多字段 / body 非数组都被拒绝', () => {
  const base = listMessages('m')
  assert.ok(validateAllowedLwpRequest(base) === null)
  // 多余字段（任意 payload 注入）
  assert.equal(validateAllowedLwpRequest({ ...base, extra: 'x' })?.code, 'INVALID_REQUEST')
  // headers 含额外字段
  assert.equal(
    validateAllowedLwpRequest({ ...base, headers: { mid: 'm', sid: '1' } })?.code,
    'INVALID_REQUEST',
  )
  // body 非数组
  assert.equal(validateAllowedLwpRequest({ ...base, body: 'nope' })?.code, 'INVALID_REQUEST')
})

test('无可用 socket 时 reject NO_SOCKET', async () => {
  const transport = new ChatSocketTransport({ getSocket: () => null })
  await assert.rejects(
    () => transport.send(listMessages('m')),
    (error: unknown) => error instanceof ChatSocketTransportError && error.code === 'NO_SOCKET',
  )
})

test('同一 mid 重复发送被拒绝', async () => {
  const socket = new FakeSocket()
  const transport = new ChatSocketTransport({ getSocket: () => socket })
  const pending = transport.send(listMessages('same'))
  await assert.rejects(
    () => transport.send(listMessages('same')),
    (error: unknown) => error instanceof ChatSocketTransportError && error.code === 'DUPLICATE_MID',
  )
  transport.dispose()
  await assert.rejects(() => pending)
})

test('超时（15s 默认）触发 TIMEOUT', async () => {
  const socket = new FakeSocket()
  let fireTimeout: (() => void) | null = null
  const transport = new ChatSocketTransport({
    getSocket: () => socket,
    setTimer: (fn) => {
      fireTimeout = fn
      return 0 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {},
  })

  const promise = transport.send(listMessages('mid-timeout'))
  assert.ok(fireTimeout, '应注册超时回调')
  ;(fireTimeout as unknown as () => void)()
  await assert.rejects(
    () => promise,
    (error: unknown) => error instanceof ChatSocketTransportError && error.code === 'TIMEOUT',
  )
})

test('实时消息帧不被当作 LWP 响应', () => {
  assert.equal(parseLwpResponse('{"code":200,"body":{}}'), null)
  assert.equal(parseLwpResponse('not-json'), null)
  assert.equal(parseLwpResponse('{"headers":{"mid":"m"}}')?.headers?.mid, 'm')
})

test('dispose 拒绝所有挂起请求', async () => {
  const socket = new FakeSocket()
  const transport = new ChatSocketTransport({ getSocket: () => socket })
  const promise = transport.send(listMessages('mid-dispose'))
  transport.dispose()
  await assert.rejects(
    () => promise,
    (error: unknown) => error instanceof ChatSocketTransportError && error.code === 'NO_SOCKET',
  )
})
