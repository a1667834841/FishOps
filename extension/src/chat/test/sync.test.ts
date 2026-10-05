/**
 * sync.ts 单元测试：实时/历史归一、去重、排序写入 store（纯 Node）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INITIAL_CURSOR, type LwpRequest, type LwpResponse } from '../../../../shared/chat/index'
import { ChatHistoryClient, type ChatTransport } from '../history'
import {
  PeerProfileResolver,
  type PeerProfileRequest,
  type PeerProfileRequester,
} from '../peer-profiles'
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

test('syncHistory：返回 nextCursor/hasMore，调用方可用游标继续向更早翻页', async () => {
  const anchors: unknown[] = []
  const transport = new FakeTransport((request) => {
    anchors.push(request.body[2])
    if (request.body[2] === INITIAL_CURSOR) {
      return { code: 200, body: { userMessageModels: [msgModel('m1', 1000, 'a')], nextCursor: 900 } }
    }
    return { code: 200, body: { userMessageModels: [msgModel('m2', 800, 'b')], nextCursor: 0 } }
  })
  const store = new ChatStore()
  const sync = new ChatSync({
    store,
    history: new ChatHistoryClient({ transport, myUserId: '111' }),
    sleep: async () => {},
  })

  const first = await sync.syncHistory('123', { pages: 1, count: 1 })
  assert.equal(first.ok, true)
  assert.equal(first.hasMore, true)
  assert.equal(first.nextCursor, 900)
  assert.deepEqual(anchors, [INITIAL_CURSOR])

  const second = await sync.syncHistory('123', { pages: 1, count: 1, cursor: first.nextCursor })
  assert.equal(second.ok, true)
  assert.equal(second.hasMore, false, '平台已到最早一页')
  assert.equal(second.nextCursor, undefined, '无更多时不得给出游标')
  assert.deepEqual(anchors, [INITIAL_CURSOR, 900], '第二跳必须带上第一页返回的游标')
  assert.equal(store.messageCount, 2)
})

test('syncHistory：多页成功时返回最后一页的 nextCursor', async () => {
  let call = 0
  const transport = new FakeTransport(() => {
    call += 1
    return call === 1
      ? { code: 200, body: { userMessageModels: [msgModel('m1', 2000, 'a')], nextCursor: 1500 } }
      : { code: 200, body: { userMessageModels: [msgModel('m2', 1000, 'b')], nextCursor: 700 } }
  })
  const sync = new ChatSync({
    store: new ChatStore(),
    history: new ChatHistoryClient({ transport, myUserId: '111' }),
    sleep: async () => {},
  })

  const result = await sync.syncHistory('123', { pages: 2, count: 1 })
  assert.equal(result.ok, true)
  assert.equal(call, 2, '应按 pages 拉满两页')
  assert.equal(result.hasMore, true)
  assert.equal(result.nextCursor, 700, '应给出最后一页的游标')
})

test('syncHistory：游标无进展时返回结构化错误，不宣称耗尽也不死循环', async () => {
  let call = 0
  // 服务端始终返回同一个 nextCursor，模拟「重复页 / 游标卡死」。
  const transport = new FakeTransport(() => {
    call += 1
    return { code: 200, body: { userMessageModels: [msgModel('m1', 1000, 'a')], nextCursor: 500 } }
  })
  const sync = new ChatSync({
    store: new ChatStore(),
    history: new ChatHistoryClient({ transport, myUserId: '111' }),
    sleep: async () => {},
  })

  const result = await sync.syncHistory('123', { pages: 10, count: 1 })
  assert.equal(result.ok, false, '游标无进展必须按失败处理，不得把重复页当终点')
  assert.ok(result.error, '必须给出结构化错误')
  assert.equal(result.hasMore, undefined, '失败结果不得宣称仍有更早历史')
  assert.equal(result.nextCursor, undefined, '失败结果不得给出游标')
  assert.equal(call, 2, '第一页正常推进，第二页游标无进展即停止')
})

test('syncHistory：游标反向（更大）时同样按失败处理，不宣称耗尽', async () => {
  let call = 0
  const transport = new FakeTransport(() => {
    call += 1
    // 第一跳返回 100；第二跳请求 cursor=100 时居然返回更大的 999（反向）。
    return { code: 200, body: { userMessageModels: [msgModel('m1', 1000, 'a')], nextCursor: call === 1 ? 100 : 999 } }
  })
  const sync = new ChatSync({
    store: new ChatStore(),
    history: new ChatHistoryClient({ transport, myUserId: '111' }),
    sleep: async () => {},
  })

  const result = await sync.syncHistory('123', { pages: 5, count: 1 })
  assert.equal(result.ok, false, '反向游标必须按失败处理')
  assert.ok(result.error, '必须给出结构化错误')
  assert.equal(result.hasMore, undefined)
  assert.equal(call, 2)
})

test('syncHistory：初次游标不推进（返回 >= 初始游标）按失败处理', async () => {
  const transport = new FakeTransport(() => ({
    code: 200,
    body: { userMessageModels: [msgModel('m1', 1000, 'a')], nextCursor: INITIAL_CURSOR },
  }))
  const sync = new ChatSync({
    store: new ChatStore(),
    history: new ChatHistoryClient({ transport, myUserId: '111' }),
    sleep: async () => {},
  })

  const result = await sync.syncHistory('123', { pages: 3, count: 1 })
  assert.equal(result.ok, false, '未提供 cursor 时以 INITIAL_CURSOR 为上界，等于上界即无进展')
  assert.ok(result.error)
})

test('syncHistory：失败结果不带游标，调用方不得据此推进分页', async () => {
  const transport = new FakeTransport(() => {
    throw new Error('LWP down')
  })
  const sync = new ChatSync({
    store: new ChatStore(),
    history: new ChatHistoryClient({ transport, myUserId: '111' }),
    sleep: async () => {},
  })

  const result = await sync.syncHistory('123', { pages: 1, count: 1, cursor: 100 })
  assert.equal(result.ok, false)
  assert.equal(result.nextCursor, undefined)
  assert.equal(result.hasMore, undefined)
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

const AVATAR = 'https://img.alicdn.com/bao/uploaded/i2/x-0-mtopupload.jpg'

class FakePeerRequester implements PeerProfileRequester {
  readonly calls: PeerProfileRequest[] = []
  readonly handler: (request: PeerProfileRequest) => unknown | Promise<unknown>

  constructor(handler: (request: PeerProfileRequest) => unknown | Promise<unknown>) {
    this.handler = handler
  }

  async request(request: PeerProfileRequest): Promise<unknown> {
    this.calls.push(request)
    return this.handler(request)
  }
}

/** 会话列表响应：会话 111，reminderUrl 不含 peerUserId（需由 session.sync 补全）。 */
function conversationTransport(): FakeTransport {
  return new FakeTransport(() => ({
    code: 200,
    body: {
      userConvs: [
        {
          singleChatUserConversation: {
            cid: '111@goofish',
            modifyTime: 100,
            lastMessage: {
              message: {
                cid: '111@goofish',
                createAt: 100,
                content: { custom: { summary: 'hi' } },
                extension: { reminderUrl: 'https://x?itemId=456' },
              },
            },
          },
        },
      ],
      hasMore: false,
    },
  }))
}

test('syncConversations：会话同步后按 session.sync 补齐对方头像并写回 store', async () => {
  const requester = new FakePeerRequester((request) => {
    if (request.api === 'session.sync') {
      return {
        ret: ['SUCCESS::调用成功'],
        data: {
          sessions: [
            { session: { sessionId: '111', ownerInfo: { userId: 'me' }, userInfo: { userId: 'peer', logo: AVATAR } } },
          ],
        },
      }
    }
    return { data: {} }
  })
  const store = new ChatStore()
  const sync = new ChatSync({
    store,
    history: new ChatHistoryClient({ transport: conversationTransport() }),
    peerProfiles: new PeerProfileResolver({ requester, myUserId: 'me' }),
  })

  const result = await sync.syncConversations()
  assert.equal(result.ok, true)
  assert.equal(result.added, 1)
  assert.equal(store.getConversation('111')?.peerAvatarUrl, AVATAR)
  assert.equal(store.getConversation('111')?.peerUserId, 'peer')
  assert.ok((result.notes ?? []).some((n) => n.includes('头像')))
})

test('syncConversations：已有头像不被覆盖，但仍用 session.sync 校验 peer 归属', async () => {
  // session.sync 返回的会话不含目标 sessionId 111（无法提供新结果）→ 不产生更新。
  const requester = new FakePeerRequester((request) => {
    if (request.api === 'session.sync') return { ret: ['SUCCESS'], data: { sessions: [] } }
    return { data: {} }
  })
  const store = new ChatStore()
  // 预置一个已有头像的会话（sessionId 111）。
  store.upsertConversations([
    {
      sessionId: '111',
      cid: '111@goofish',
      peerUserName: '买家',
      peerAvatarUrl: AVATAR,
      lastMessage: 'old',
      lastMessageTime: 1,
      unreadCount: 0,
      sortIndex: 1,
      visible: true,
    },
  ])
  const sync = new ChatSync({
    store,
    history: new ChatHistoryClient({ transport: conversationTransport() }),
    peerProfiles: new PeerProfileResolver({ requester, myUserId: 'me' }),
  })

  const result = await sync.syncConversations()
  assert.equal(result.ok, true)
  assert.equal(store.getConversation('111')?.peerAvatarUrl, AVATAR, '旧头像不得被覆盖')
  // 新行为：会发起 session.sync 校验 peer 归属（不再仅凭「有头像」就跳过）。
  assert.ok(requester.calls.some((c) => c.api === 'session.sync'))
})

test('syncConversations：账号变化遗留的错 peer（等于自己）被纠正并覆盖旧头像', async () => {
  const corrected = 'https://img.alicdn.com/bao/uploaded/i1/correct-0-mtopupload.jpg'
  const requester = new FakePeerRequester((request) => {
    if (request.api === 'session.sync') {
      return {
        data: {
          sessions: [
            { session: { sessionId: '111', ownerInfo: { userId: 'me' }, userInfo: { userId: 'real-peer', fishNick: '真买家', logo: corrected } } },
          ],
        },
      }
    }
    return { data: {} }
  })
  const store = new ChatStore()
  // 旧缓存把 peer 错记为自己，并带着错误的旧头像。
  store.upsertConversations([
    {
      sessionId: '111',
      cid: '111@goofish',
      peerUserId: 'me',
      peerUserName: '我自己',
      peerAvatarUrl: AVATAR,
      lastMessage: 'old',
      lastMessageTime: 1,
      unreadCount: 0,
      sortIndex: 1,
      visible: true,
    },
  ])
  const sync = new ChatSync({
    store,
    history: new ChatHistoryClient({ transport: conversationTransport() }),
    peerProfiles: new PeerProfileResolver({ requester, myUserId: 'me' }),
  })

  const result = await sync.syncConversations()
  assert.equal(result.ok, true)
  const conv = store.getConversation('111')
  assert.equal(conv?.peerUserId, 'real-peer', '错 peer 应被纠正')
  assert.equal(conv?.peerUserName, '真买家', '昵称应被纠正')
  assert.equal(conv?.peerAvatarUrl, corrected, '错 peer 的旧头像应被覆盖为准确 peer 的 logo')
})

test('syncConversations：头像仍无返回时给出可见粗粒度提示（不静默、不假成功）', async () => {
  const requester = new FakePeerRequester(() => {
    throw new Error('mtop down')
  })
  const store = new ChatStore()
  const sync = new ChatSync({
    store,
    history: new ChatHistoryClient({ transport: conversationTransport() }),
    peerProfiles: new PeerProfileResolver({ requester, myUserId: 'me' }),
  })

  const result = await sync.syncConversations()
  assert.equal(result.ok, true, '会话同步本身仍成功')
  assert.equal(store.sessionCount, 1)
  assert.equal(store.getConversation('111')?.peerAvatarUrl, undefined)
  assert.ok((result.notes ?? []).some((n) => n.includes('仍未取到对方头像')), '应给出可见的缺字段/失败提示')
})

test('syncConversations：resolver 抛错不中断会话同步（走兜底提示）', async () => {
  const throwingResolver = {
    resolveMissing: async () => {
      throw new Error('mtop down')
    },
  } as unknown as PeerProfileResolver
  const store = new ChatStore()
  const sync = new ChatSync({
    store,
    history: new ChatHistoryClient({ transport: conversationTransport() }),
    peerProfiles: throwingResolver,
  })

  const result = await sync.syncConversations()
  assert.equal(result.ok, true)
  assert.equal(result.added, 1)
  assert.equal(store.sessionCount, 1)
  assert.ok((result.notes ?? []).some((n) => n.includes('失败')))
})
