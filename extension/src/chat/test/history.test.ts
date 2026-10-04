/**
 * history.ts 单元测试：LWP 协议构造、分页游标、解析（纯 Node，虚构数据）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INITIAL_CURSOR, type LwpRequest, type LwpResponse } from '../../../../shared/chat/index'
import { ChatHistoryClient, ChatHistoryError, parseConversationItem, type ChatTransport } from '../history'

const b64 = (text: string): string => Buffer.from(text, 'utf-8').toString('base64')

class FakeTransport implements ChatTransport {
  readonly requests: LwpRequest[] = []
  private readonly responder: (request: LwpRequest) => LwpResponse

  constructor(responder: (request: LwpRequest) => LwpResponse) {
    this.responder = responder
  }

  async send(request: LwpRequest): Promise<LwpResponse> {
    this.requests.push(request)
    return this.responder(request)
  }
}

function convItem(cid: string, modifyTime: number, summary: string, title: string): unknown {
  return {
    singleChatUserConversation: {
      cid,
      modifyTime,
      joinTime: modifyTime,
      redPoint: 2,
      lastMessage: {
        message: {
          cid,
          createAt: modifyTime,
          content: { custom: { summary } },
          extension: { reminderTitle: title, reminderUrl: 'https://x?itemId=456&peerUserId=999' },
        },
      },
    },
    singleChatConversation: { extension: {} },
  }
}

function msgModel(messageId: string, createAt: number, text: string, senderUserId: string): unknown {
  return {
    readStatus: 0,
    message: {
      messageId,
      cid: '123@goofish',
      createAt,
      content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text } })) } },
      extension: { senderUserId, reminderTitle: '买家' },
    },
  }
}

test('请求构造：会话列表默认游标与页大小', () => {
  const client = new ChatHistoryClient({ transport: new FakeTransport(() => ({ code: 200 })) })
  assert.deepEqual(client.buildConversationListBody(), [INITIAL_CURSOR, 20])
  assert.equal(INITIAL_CURSOR, 9007199254740991)
})

test('请求构造：消息历史 body 与 cid 归一', () => {
  const client = new ChatHistoryClient({ transport: new FakeTransport(() => ({ code: 200 })) })
  assert.deepEqual(client.buildMessageHistoryBody('123'), ['123@goofish', false, INITIAL_CURSOR, 20, false])
  // 已带后缀时不重复追加
  assert.deepEqual(client.buildMessageHistoryBody('123@goofish')[0], '123@goofish')
})

test('LWP envelope：路由 / mid / body', async () => {
  const transport = new FakeTransport(() => ({ code: 200, body: { userConvs: [] } }))
  const client = new ChatHistoryClient({ transport, midFactory: () => 'MID-1' })
  await client.listConversations()
  assert.equal(transport.requests.length, 1)
  assert.deepEqual(transport.requests[0], {
    lwp: '/r/Conversation/listNewestPagination',
    headers: { mid: 'MID-1' },
    body: [INITIAL_CURSOR, 20],
  })
})

test('会话列表解析与 nextCursor', async () => {
  const transport = new FakeTransport(() => ({
    code: 200,
    body: {
      userConvs: [convItem('111@goofish', 2000, '最新', '买家A'), convItem('222@goofish', 1000, '较早', '买家B')],
      hasMore: true,
    },
  }))
  const client = new ChatHistoryClient({ transport })
  const page = await client.listConversations()
  assert.equal(page.conversations.length, 2)
  assert.equal(page.hasMore, true)
  assert.equal(page.conversations[0].sessionId, '111')
  assert.equal(page.conversations[0].peerUserName, '买家A')
  assert.equal(page.conversations[0].unreadCount, 2)
  assert.equal(page.conversations[0].itemId, '456')
  // nextCursor 取最后一个会话的 sortIndex
  assert.equal(page.nextCursor, 1000)
})

test('会话分页：第二页使用上页 nextCursor 作为游标', async () => {
  const transport = new FakeTransport((request) => {
    const cursor = request.body[0] as number
    if (cursor === INITIAL_CURSOR) {
      return { code: 200, body: { userConvs: [convItem('111@goofish', 5000, 'a', 'A')], hasMore: true } }
    }
    return { code: 200, body: { userConvs: [convItem('222@goofish', cursor, 'b', 'B')], hasMore: false } }
  })
  const client = new ChatHistoryClient({ transport })
  const page1 = await client.listConversations()
  const page2 = await client.listConversations({ cursor: page1.nextCursor })
  assert.equal(page2.conversations[0].sessionId, '222')
  assert.equal(transport.requests[1].body[0], 5000)
})

test('消息历史解析与 hasMore', async () => {
  const transport = new FakeTransport(() => ({
    code: 200,
    body: { userMessageModels: [msgModel('m1', 1000, '第一条', '999'), msgModel('m2', 2000, '第二条', '999')], nextCursor: 900 },
  }))
  const client = new ChatHistoryClient({ transport, myUserId: '111' })
  const page = await client.listMessageHistory('123', { count: 2 })
  assert.equal(page.messages.length, 2)
  assert.equal(page.messages[0].content, '第一条')
  assert.equal(page.messages[0].direction, 'in')
  assert.equal(page.messages[0].source, 'history')
  assert.equal(page.nextCursor, 900)
  assert.equal(page.hasMore, true)
})

test('消息历史：不足一页时 hasMore=false', async () => {
  const transport = new FakeTransport(() => ({
    code: 200,
    body: { userMessageModels: [msgModel('m1', 1000, 'only', '999')], nextCursor: 0 },
  }))
  const client = new ChatHistoryClient({ transport })
  const page = await client.listMessageHistory('123', { count: 20 })
  assert.equal(page.hasMore, false)
})

test('LWP 失败响应抛出结构化 ChatHistoryError', async () => {
  const transport = new FakeTransport(() => ({ code: 500, message: 'boom' }))
  const client = new ChatHistoryClient({ transport })
  await assert.rejects(
    () => client.listConversations(),
    (error: unknown) => error instanceof ChatHistoryError && error.code === 'LWP_ERROR',
  )
})

test('空 sessionId 抛出 INVALID_SESSION', async () => {
  const client = new ChatHistoryClient({ transport: new FakeTransport(() => ({ code: 200 })) })
  await assert.rejects(
    () => client.listMessageHistory(''),
    (error: unknown) => error instanceof ChatHistoryError && error.code === 'INVALID_SESSION',
  )
})

test('自动分页 listAllMessages：跨页拼接并按 id 去重', async () => {
  const transport = new FakeTransport((request) => {
    const cursor = request.body[2]
    if (cursor === INITIAL_CURSOR) {
      return { code: 200, body: { userMessageModels: [msgModel('m1', 1000, 'a', '999'), msgModel('m2', 2000, 'b', '999')], nextCursor: 1500 } }
    }
    // 第二页故意包含重复 m2
    return { code: 200, body: { userMessageModels: [msgModel('m2', 2000, 'b', '999')], nextCursor: 0 } }
  })
  const client = new ChatHistoryClient({ transport, sleep: async () => {} })
  const all = await client.listAllMessages('123', 5)
  assert.equal(all.length, 2)
  assert.deepEqual(all.map((m) => m.messageId).sort(), ['m1', 'm2'])
})

test('会话头像：从 userInfo/ownerInfo.logo 提取，忽略商品 itemMainPic', () => {
  // 真实头像字段 logo 位于 userInfo / ownerInfo 内（见 mtop user.query / session.sync）。
  const avatar = 'https://img.alicdn.com/bao/uploaded/i2/O1CN01FdtcnZ1N8xK86vifa_!!0-mtopupload.jpg'
  const viaUserInfo = parseConversationItem({
    singleChatUserConversation: {
      cid: '123@goofish',
      modifyTime: 1000,
      // 商品主图：绝不能当头像。
      extension: { itemMainPic: 'https://img.alicdn.com/bao/uploaded/i3/x-0-fleamarket.jpg' },
      userInfo: { userId: '999', nick: '买家', logo: avatar },
    },
  })
  assert.equal(viaUserInfo?.peerAvatarUrl, avatar)

  const viaOwnerInfo = parseConversationItem({
    singleChatUserConversation: { cid: '123@goofish', modifyTime: 1000, ownerInfo: { logo: avatar } },
  })
  assert.equal(viaOwnerInfo?.peerAvatarUrl, avatar)
})

test('会话头像：无真实头像字段时保持 undefined（界面回退字母头像）', () => {
  const conv = parseConversationItem({
    singleChatUserConversation: {
      cid: '123@goofish',
      modifyTime: 1000,
      extension: { itemMainPic: 'https://img.alicdn.com/bao/uploaded/i3/x-0-xy_item.jpg' },
    },
  })
  assert.equal(conv?.peerAvatarUrl, undefined)
})

test('setMyUserId：后置解析出当前用户后，历史方向按新 ID 判定（in → out）', async () => {
  const transport = new FakeTransport(() => ({
    code: 200,
    body: { userMessageModels: [msgModel('m1', 1000, '我发的', 'me')], nextCursor: 0 },
  }))
  // 构造时没有 myUserId：方向未知，诚实按 in 处理，不猜。
  const client = new ChatHistoryClient({ transport })
  const before = await client.listMessageHistory('123')
  assert.equal(before.messages[0].direction, 'in')

  // 后置获得当前用户 ID：同一客户端后续解析立即生效。
  client.setMyUserId('me')
  const after = await client.listMessageHistory('123')
  assert.equal(after.messages[0].direction, 'out')
})

test('会话解析：peerUserId 明确等于当前用户时，不把自己当作对方', () => {
  const item = {
    singleChatUserConversation: {
      cid: '111@goofish',
      modifyTime: 1000,
      lastMessage: {
        message: {
          cid: '111@goofish',
          createAt: 1000,
          content: { custom: { summary: 'hi' } },
          extension: { reminderTitle: '我自己', reminderUrl: 'https://x?peerUserId=me' },
        },
      },
    },
  }
  const conv = parseConversationItem(item, 'me')
  assert.equal(conv?.peerUserId, undefined, 'peerUserId 等于自己时不可当作对方')
  assert.equal(conv?.peerUserName, '', '不展示自己昵称作为对方')

  // 未提供 myUserId（无法判定）时，保持原有解析口径，不误删。
  const unknown = parseConversationItem(item)
  assert.equal(unknown?.peerUserId, 'me')
})

test('会话解析：peerUserId 不等于自己时正常保留', () => {
  const item = {
    singleChatUserConversation: {
      cid: '111@goofish',
      modifyTime: 1000,
      lastMessage: {
        message: {
          cid: '111@goofish',
          createAt: 1000,
          content: { custom: { summary: 'hi' } },
          extension: { reminderTitle: '买家', reminderUrl: 'https://x?peerUserId=peer' },
        },
      },
    },
  }
  const conv = parseConversationItem(item, 'me')
  assert.equal(conv?.peerUserId, 'peer')
  assert.equal(conv?.peerUserName, '买家')
})
