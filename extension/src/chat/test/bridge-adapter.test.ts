/**
 * bridge-adapter.ts 单元测试：P1 兼容命令处理与事件队列（纯 Node）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChatBridgeAdapter, ChatBridgeCommands, ChatBridgeEvents } from '../bridge-adapter'
import { ChatStore } from '../store'
import { ChatSync } from '../sync'

const b64 = (text: string): string => Buffer.from(text, 'utf-8').toString('base64')

function realtimePayload(sessionId: string, text: string, messageId: string): string {
  return JSON.stringify({
    code: 200,
    body: {
      content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text } })) } },
      extension: { senderUserId: '999', reminderUrl: `https://x?sid=${sessionId}&peerUserId=999` },
      createAt: 1000,
      messageId,
    },
  })
}

function makeAdapter(): ChatBridgeAdapter {
  const store = new ChatStore()
  const sync = new ChatSync({ store })
  let counter = 0
  return new ChatBridgeAdapter({ sync, store, now: () => 1000, genEventId: () => `e${++counter}` })
}

test('CHAT_STATUS 返回计数', async () => {
  const adapter = makeAdapter()
  const res = await adapter.handleCommand({ kind: 'command', requestId: 'r1', type: ChatBridgeCommands.CHAT_STATUS })
  assert.equal(res.ok, true)
  assert.deepEqual(res.result, { socketStatus: 'connecting', sessionCount: 0, messageCount: 0 })
})

test('CHAT_GET_MESSAGES：缺少 sessionId 返回 INVALID_PAYLOAD', async () => {
  const adapter = makeAdapter()
  const res = await adapter.handleCommand({
    kind: 'command',
    requestId: 'r2',
    type: ChatBridgeCommands.CHAT_GET_MESSAGES,
    payload: {},
  })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
})

test('未知命令返回 UNKNOWN_COMMAND', async () => {
  const adapter = makeAdapter()
  const res = await adapter.handleCommand({ kind: 'command', requestId: 'r3', type: 'NOPE' })
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'UNKNOWN_COMMAND')
})

test('ingestRealtime 排队事件且负载不含正文', () => {
  const adapter = makeAdapter()
  const result = adapter.ingestRealtime(realtimePayload('123', '机密内容', 'm1'))
  assert.equal(result.ok, true)
  const events = adapter.drainEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].type, ChatBridgeEvents.CHAT_MESSAGE_INGESTED)
  assert.equal(events[0].kind, 'event')
  // 事件负载必须可序列化且不包含聊天正文
  const serialized = JSON.stringify(events[0].payload)
  assert.equal(serialized.includes('机密内容'), false)
  // drain 后清空
  assert.deepEqual(adapter.drainEvents(), [])
})

test('reportSocketStatus 排队状态事件', () => {
  const adapter = makeAdapter()
  adapter.reportSocketStatus('open')
  const events = adapter.drainEvents()
  assert.equal(events.length, 1)
  assert.equal(events[0].type, ChatBridgeEvents.CHAT_SOCKET_STATUS)
  assert.deepEqual(events[0].payload, { status: 'open' })
})
