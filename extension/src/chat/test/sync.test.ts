/**
 * sync.ts 单元测试：实时/历史归一、去重、排序写入 store（纯 Node）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INITIAL_CURSOR, type LwpRequest, type LwpResponse } from '../../../../shared/chat/index'
import { ChatHistoryClient, type ChatTransport } from '../history'
import { ChatStore } from '../store'
import { ChatSync } from '../sync'

const b64 = (text: string): string => Buffer.from(text, 'utf-8').toString('base64')

class FakeTransport implements ChatTransport {
  private readonly responder: (request: LwpRequest) => LwpResponse

  constructor(responder: (request: LwpRequest) => LwpResponse) {
    this.responder = responder
  }

  async send(request: LwpRequest): Promise<LwpResponse> {
    return this.responder(request)
  }
}

function realtimeTextPayload(sessionId: string, text: string, createAt: number, messageId: string): string {
  return JSON.stringify({
    code: 200,
    body: {
      content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text } })) } },
      extension: { senderUserId: '999', reminderUrl: `https://x?sid=${sessionId}&peerUserId=999` },
      createAt,
      messageId,
    },
  })
}

function msgModel(messageId: string, createAt: number, text: string): unknown {
  return {
    message: {
      messageId,
      cid: '123@goofish',
      createAt,
      content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text } })) } },
      extension: { senderUserId: '999', reminderTitle: '买家' },
    },
  }
}

test('ingestRealtime：写入并在重复时去重', () => {
  const store = new ChatStore()
  const sync = new ChatSync({ store })
  const raw = realtimeTextPayload('123', '你好', 1000, 'm1')

  const first = sync.ingestRealtime(raw)
  assert.equal(first.ok, true)
  assert.equal(first.added, 1)
  assert.equal(store.messageCount, 1)

  const second = sync.ingestRealtime(raw)
  assert.equal(second.ok, true)
  assert.equal(second.added, 0)
  assert.equal(second.updated, 1)
  assert.equal(store.messageCount, 1)
})

test('ingestRealtime：解析失败不写入 store，返回结构化错误', () => {
  const store = new ChatStore()
  const sync = new ChatSync({ store })
  const result = sync.ingestRealtime('{bad json')
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'NOT_JSON')
  assert.equal(store.messageCount, 0)
})

test('syncHistory：跨页归一、去重、按时间排序', async () => {
  const transport = new FakeTransport((request) => {
    const anchor = request.body[2]
    if (anchor === INITIAL_CURSOR) {
      return { code: 200, body: { userMessageModels: [msgModel('m1', 1000, 'a'), msgModel('m2', 2000, 'b')], nextCursor: 1500 } }
    }
    // 第二页包含重复的 m2
    return { code: 200, body: { userMessageModels: [msgModel('m3', 3000, 'c'), msgModel('m2', 2000, 'b')], nextCursor: 0 } }
  })
  const store = new ChatStore()
  const history = new ChatHistoryClient({ transport, myUserId: '111' })
  const sync = new ChatSync({ store, history })

  const result = await sync.syncHistory('123', { pages: 5, count: 2 })
  assert.equal(result.ok, true)
  assert.equal(result.added, 3)
  assert.equal(result.updated, 1)
  assert.equal(store.messageCount, 3)
  assert.deepEqual(
    store.getMessages('123').map((m) => m.messageId),
    ['m1', 'm2', 'm3'],
  )
})

test('syncHistory：未配置 history 时返回结构化错误', async () => {
  const sync = new ChatSync({ store: new ChatStore() })
  const result = await sync.syncHistory('123')
  assert.equal(result.ok, false)
})

test('syncConversations：分页写入会话', async () => {
  const transport = new FakeTransport(() => ({
    code: 200,
    body: {
      userConvs: [
        {
          singleChatUserConversation: {
            cid: '111@goofish',
            modifyTime: 100,
            lastMessage: { message: { cid: '111@goofish', createAt: 100, content: { custom: { summary: 'hi' } }, extension: {} } },
          },
        },
      ],
      hasMore: false,
    },
  }))
  const store = new ChatStore()
  const sync = new ChatSync({ store, history: new ChatHistoryClient({ transport }) })
  const result = await sync.syncConversations({ pages: 2 })
  assert.equal(result.ok, true)
  assert.equal(result.added, 1)
  assert.equal(store.sessionCount, 1)
})

test('ingestMessages：归一后写入', () => {
  const store = new ChatStore()
  const sync = new ChatSync({ store })
  const result = sync.ingestMessages([
    {
      id: '',
      messageId: 'x1',
      sessionId: '1',
      cid: '1@goofish',
      senderId: '999',
      senderName: '  买家  ',
      receiverId: '111',
      direction: 'in',
      kind: 'text',
      contentType: 1,
      content: 'hello',
      createAt: 100,
      source: 'history',
    },
  ])
  assert.equal(result.added, 1)
  assert.equal(store.getMessages('1')[0].senderName, '买家')
})
