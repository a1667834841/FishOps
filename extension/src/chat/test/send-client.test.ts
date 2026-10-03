/**
 * send-client.ts 单测：输入校验、成功发送（假 transport）、错误结构化。
 * 使用假 transport，绝不发送真实消息。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LwpRequest, LwpResponse } from '../../../../shared/chat/index'
import { ChatMessageSender } from '../send-client'
import { ChatSendTransportError, type ChatSendTransport } from '../send-transport'

class RecordingTransport implements ChatSendTransport {
  readonly sent: LwpRequest[] = []
  private readonly responder: (request: LwpRequest) => Promise<LwpResponse> | LwpResponse
  constructor(responder: (request: LwpRequest) => Promise<LwpResponse> | LwpResponse) {
    this.responder = responder
  }
  send(request: LwpRequest): Promise<LwpResponse> {
    this.sent.push(request)
    return Promise.resolve(this.responder(request))
  }
}

const input = { sessionId: 's1', receiverId: 'p1', myId: 'm1', content: '你好' }

test('成功发送：mid/uuid 可注入，返回 messageId=uuid', async () => {
  const transport = new RecordingTransport(() => ({ code: 200, body: {} }))
  const sender = new ChatMessageSender({
    transport,
    midFactory: () => 'MID-X',
    uuidFactory: () => 'UUID-X',
    now: () => 123,
  })
  const result = await sender.sendText(input)
  assert.deepEqual(result, { ok: true, messageId: 'UUID-X', sessionId: 's1', receiverId: 'p1', sentAt: 123 })
  assert.equal(transport.sent.length, 1)
  assert.equal(transport.sent[0].headers.mid, 'MID-X')
})

test('LWP 返回失败码 → LWP_ERROR（不回显 body）', async () => {
  const transport = new RecordingTransport(() => ({ code: 500, message: 'boom', body: { secret: 'x' } }))
  const sender = new ChatMessageSender({ transport, midFactory: () => 'm', uuidFactory: () => 'u' })
  const result = await sender.sendText(input)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'LWP_ERROR')
    assert.ok(!result.error.message.includes('secret'))
  }
})

test('transport 超时错误码映射为 TIMEOUT', async () => {
  const transport: ChatSendTransport = {
    send: () => Promise.reject(new ChatSendTransportError('TIMEOUT', '发送超时(10000ms)')),
  }
  const sender = new ChatMessageSender({ transport, midFactory: () => 'm', uuidFactory: () => 'u' })
  const result = await sender.sendText(input)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'TIMEOUT')
})

test('输入非法 → INVALID_INPUT，且不调用 transport', async () => {
  const transport = new RecordingTransport(() => ({ code: 200 }))
  const sender = new ChatMessageSender({ transport, midFactory: () => 'm', uuidFactory: () => 'u' })
  const result = await sender.sendText({ ...input, content: '   ' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'INVALID_INPUT')
  assert.equal(transport.sent.length, 0)
})

test('内容超过长度上限 → INVALID_INPUT', async () => {
  const transport = new RecordingTransport(() => ({ code: 200 }))
  const sender = new ChatMessageSender({ transport, midFactory: () => 'm', uuidFactory: () => 'u', maxContentLength: 3 })
  const result = await sender.sendText({ ...input, content: '1234' })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'INVALID_INPUT')
  assert.equal(transport.sent.length, 0)
})
