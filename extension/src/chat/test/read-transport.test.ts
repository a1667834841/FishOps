import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatReadSocketTransport, createChatReadRequest } from '../read-transport'

class Socket {
  readyState = 1
  sent: string[] = []
  send(value: string): void { this.sent.push(value) }
}

test('clearRedPoint 请求严格使用单会话服务端消息参数', () => {
  assert.deepEqual(createChatReadRequest('abc', 'server-id', 'm'), {
    lwp: '/r/Conversation/clearRedPoint', headers: { mid: 'm' },
    body: [[{ cid: 'abc@goofish', messageId: 'server-id' }]],
  })
  assert.throws(() => createChatReadRequest('abc@other', 'server-id', 'm'))
  assert.throws(() => createChatReadRequest('abc', 'uuid:local', 'm'))
})

test('已读 transport 只发送固定路由，使用 code 200 关联响应', async () => {
  const socket = new Socket()
  const transport = new ChatReadSocketTransport({ getSocket: () => socket, midFactory: () => 'read-1' })
  const pending = transport.markRead('abc', 'server-id')
  const request = JSON.parse(socket.sent[0]) as { lwp: string; body: unknown[] }
  assert.equal(request.lwp, '/r/Conversation/clearRedPoint')
  assert.deepEqual(request.body, [[{ cid: 'abc@goofish', messageId: 'server-id' }]])
  assert.equal(transport.handleMessage(JSON.stringify({ code: 200, headers: { mid: 'read-1' } })), true)
  assert.equal((await pending).code, 200)
  transport.dispose()
})
