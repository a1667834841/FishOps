/**
 * peer-profiles.ts 单元测试（纯 Node，虚构数据，不访问网络）。
 *
 * 覆盖：session.sync 归属判断（排除自己）、https 校验、按 peerId 精确回退、
 * 失败隔离、去重、并发有界、只补缺失（保留已有头像）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Conversation } from '../../../../shared/types/chat'
import {
  PeerProfileResolver,
  parseSessionSyncProfiles,
  parseUserQueryProfile,
  parseItemHeadCover,
  type PeerProfileRequest,
  type PeerProfileRequester,
} from '../peer-profiles'

const AVATAR = 'https://img.alicdn.com/bao/uploaded/i2/x-0-mtopupload.jpg'
const AVATAR2 = 'https://img.alicdn.com/bao/uploaded/i1/y-0-mtopupload.jpg'

class FakeRequester implements PeerProfileRequester {
  readonly calls: PeerProfileRequest[] = []
  private readonly handler: (request: PeerProfileRequest) => unknown | Promise<unknown>

  constructor(handler: (request: PeerProfileRequest) => unknown | Promise<unknown>) {
    this.handler = handler
  }

  async request(request: PeerProfileRequest): Promise<unknown> {
    this.calls.push(request)
    return this.handler(request)
  }
}

function conv(partial: Partial<Conversation> & { sessionId: string }): Conversation {
  return {
    cid: `${partial.sessionId}@goofish`,
    peerUserName: '买家',
    lastMessage: '',
    lastMessageTime: 0,
    unreadCount: 0,
    sortIndex: 0,
    visible: true,
    ...partial,
  }
}

interface SyncSessionInput {
  id: string
  ownerId: string
  ownerLogo?: string
  guestId: string
  guestLogo?: string
}

function syncPayload(sessions: SyncSessionInput[]): unknown {
  return {
    ret: ['SUCCESS::调用成功'],
    data: {
      sessions: sessions.map((s) => ({
        session: {
          sessionId: s.id,
          ownerInfo: { userId: s.ownerId, ...(s.ownerLogo === undefined ? {} : { logo: s.ownerLogo }) },
          userInfo: { userId: s.guestId, ...(s.guestLogo === undefined ? {} : { logo: s.guestLogo }) },
        },
      })),
    },
  }
}

test('parseSessionSyncProfiles：owner 是自己时取 guest 为对方', () => {
  const payload = syncPayload([{ id: '1', ownerId: 'me', ownerLogo: AVATAR, guestId: 'peer', guestLogo: AVATAR2 }])
  assert.deepEqual(parseSessionSyncProfiles(payload, 'me'), [
    { sessionId: '1', peerUserId: 'peer', peerAvatarUrl: AVATAR2 },
  ])
})

test('parseSessionSyncProfiles：guest 是自己时取 owner 为对方', () => {
  const payload = syncPayload([{ id: '1', ownerId: 'peer', ownerLogo: AVATAR2, guestId: 'me', guestLogo: AVATAR }])
  assert.deepEqual(parseSessionSyncProfiles(payload, 'me'), [
    { sessionId: '1', peerUserId: 'peer', peerAvatarUrl: AVATAR2 },
  ])
})

test('parseSessionSyncProfiles：无法确认归属时跳过（不猜、不混淆自己）', () => {
  // 双方都不是自己。
  assert.deepEqual(parseSessionSyncProfiles(syncPayload([{ id: '1', ownerId: 'a', ownerLogo: AVATAR, guestId: 'b', guestLogo: AVATAR2 }]), 'me'), [])
  // 缺 myUserId。
  assert.deepEqual(parseSessionSyncProfiles(syncPayload([{ id: '1', ownerId: 'me', ownerLogo: AVATAR, guestId: 'peer', guestLogo: AVATAR2 }])), [])
})

test('parseSessionSyncProfiles：http（非 https）logo 被拒绝，但仍回传 peerId 用于纠正', () => {
  const payload = syncPayload([{ id: '1', ownerId: 'me', guestId: 'peer', guestLogo: 'http://untrusted.example/x.jpg' }])
  // 非法 logo 不采用（peerAvatarUrl 字段缺席），但归属已验证的 peerUserId 仍回传。
  assert.deepEqual(parseSessionSyncProfiles(payload, 'me'), [{ sessionId: '1', peerUserId: 'peer' }])
})

test('parseUserQueryProfile：提取 data.userInfo 的 logo/昵称并校验 https', () => {
  assert.deepEqual(parseUserQueryProfile({ ret: ['SUCCESS'], data: { userInfo: { logo: AVATAR, fishNick: '买家' } } }), {
    peerAvatarUrl: AVATAR,
    peerUserName: '买家',
  })
  assert.deepEqual(parseUserQueryProfile({ data: { userInfo: { logo: 'http://untrusted.example/x.jpg' } } }), {})
  assert.deepEqual(parseUserQueryProfile({ data: {} }), {})
  assert.deepEqual(parseUserQueryProfile('nope'), {})
})

test('resolveMissing：资料已完备仍批量核对商品，不重复查询用户', async () => {
  const requester = new FakeRequester(() => syncPayload([]))
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me' })
  const updates = await resolver.resolveMissing([
    conv({ sessionId: '1', peerUserId: 'peer', peerUserName: '买家', peerAvatarUrl: AVATAR }),
  ])
  assert.deepEqual(updates, [])
  assert.equal(requester.calls.length, 1)
  assert.equal(requester.calls[0]?.api, 'session.sync')
})

test('resolveMissing：session.sync 批量补齐（按 sessionId 精确映射）', async () => {
  const requester = new FakeRequester((request) => {
    if (request.api === 'session.sync') {
      return syncPayload([
        { id: '1', ownerId: 'me', guestId: 'peerA', guestLogo: AVATAR },
        { id: '2', ownerId: 'peerB', ownerLogo: AVATAR2, guestId: 'me' },
      ])
    }
    return { data: {} }
  })
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me' })
  const updates = await resolver.resolveMissing([conv({ sessionId: '1' }), conv({ sessionId: '2' })])
  assert.deepEqual(updates, [
    { sessionId: '1', peerUserId: 'peerA', peerAvatarUrl: AVATAR },
    { sessionId: '2', peerUserId: 'peerB', peerAvatarUrl: AVATAR2 },
  ])
  // 仅一次 session.sync；缺少新对方昵称时继续查询，不能保留归属不明的旧昵称。
  assert.equal(requester.calls.filter((c) => c.api === 'session.sync').length, 1)
  assert.equal(requester.calls.filter((c) => c.api === 'user.query').length, 2)
})

test('resolveMissing：可信 session.sync 按 sessionId 校正过期 peerUserId', async () => {
  const requester = new FakeRequester((request) =>
    request.api === 'session.sync'
      ? syncPayload([{ id: '1', ownerId: 'me', guestId: 'peer', guestLogo: AVATAR }])
      : { data: {} },
  )
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me' })
  const updates = await resolver.resolveMissing([conv({ sessionId: '1', peerUserId: 'someone-else' })])
  assert.deepEqual(updates, [{ sessionId: '1', peerUserId: 'peer', peerAvatarUrl: AVATAR }])
})

test('PeerProfileResolver：可在运行时更新 myUserId', async () => {
  const requester = new FakeRequester(() => syncPayload([
    { id: '1', ownerId: 'me', guestId: 'peer', guestLogo: AVATAR },
  ]))
  const resolver = new PeerProfileResolver({ requester })
  resolver.setMyUserId('me')
  assert.deepEqual(await resolver.resolveMissing([conv({ sessionId: '1' })]), [
    { sessionId: '1', peerUserId: 'peer', peerAvatarUrl: AVATAR },
  ])
})

test('resolveMissing：失败回报粗粒度诊断，不泄露异常文本', async () => {
  const failures: Array<[string, string]> = []
  const requester = new FakeRequester(() => { throw new Error('secret response') })
  const resolver = new PeerProfileResolver({
    requester,
    onRequestFailure: (api, code) => failures.push([api, code]),
  })
  assert.deepEqual(await resolver.resolveMissing([conv({ sessionId: '1', peerUserId: 'peer' })]), [])
  assert.deepEqual(failures, [['session.sync', 'REQUEST_FAILED'], ['user.query', 'REQUEST_FAILED']])
  assert.equal(JSON.stringify(failures).includes('secret response'), false)
})

test('resolveMissing：session.sync 失败时回退 pc.user.query v4.0（isOwner:false / sessionType:1）', async () => {
  const requester = new FakeRequester((request) => {
    if (request.api === 'session.sync') throw new Error('boom')
    return { data: { userInfo: { logo: AVATAR, fishNick: '买家' } } }
  })
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me' })
  const updates = await resolver.resolveMissing([conv({ sessionId: '1', peerUserId: 'peer' })])
  assert.deepEqual(updates, [{ sessionId: '1', peerAvatarUrl: AVATAR, peerUserName: '买家' }])
  const queryCall = requester.calls.find((c) => c.api === 'user.query')
  assert.deepEqual(queryCall?.data, { type: 0, sessionType: 1, sessionId: '1', isOwner: false })
})

test('resolveMissing：user.query 回退不使用 userId（无自身 ID 回退面）', async () => {
  const requester = new FakeRequester((request) => {
    if (request.api === 'session.sync') throw new Error('boom')
    return { data: { userInfo: { logo: AVATAR } } }
  })
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me' })
  // 会话记录的 peer 正是自己（账号变化遗留）；回退仍按 session 作用域取对方，不按 userId 猜。
  const updates = await resolver.resolveMissing([conv({ sessionId: '1', peerUserId: 'me' })])
  assert.deepEqual(updates, [{ sessionId: '1', peerAvatarUrl: AVATAR }])
  const queryCall = requester.calls.find((c) => c.api === 'user.query')
  assert.equal('userId' in (queryCall?.data ?? {}), false)
})

test('parseSessionSyncProfiles：sessionTypes[1] 普通单聊结构（ownerInfo/userInfo 位于 session 内）', () => {
  const payload = {
    data: {
      sessions: [
        {
          memberFlags: 1,
          message: { summary: 'hi' },
          session: {
            sessionId: 123,
            sessionType: 1,
            ownerInfo: { userId: 'me', logo: AVATAR },
            userInfo: { userId: 'peer', fishNick: '买家', logo: AVATAR2 },
          },
        },
      ],
    },
  }
  assert.deepEqual(parseSessionSyncProfiles(payload, 'me'), [
    { sessionId: '123', peerUserId: 'peer', peerUserName: '买家', peerAvatarUrl: AVATAR2 },
  ])
})

test('parseSessionSyncProfiles：携带 fishNick / nick 作为对方昵称（fishNick 优先）', () => {
  const payload = {
    data: {
      sessions: [
        {
          session: {
            sessionId: '1',
            ownerInfo: { userId: 'me' },
            userInfo: { userId: 'peer', nick: '普通昵称', fishNick: '闲鱼昵称', logo: AVATAR },
          },
        },
      ],
    },
  }
  assert.deepEqual(parseSessionSyncProfiles(payload, 'me'), [
    { sessionId: '1', peerUserId: 'peer', peerUserName: '闲鱼昵称', peerAvatarUrl: AVATAR },
  ])
})

test('parseSessionSyncProfiles：myUserId 带 @goofish 后缀时仍能归一归属', () => {
  // owner 是本人（无后缀），但 myUserId 携带后缀 → 归一后应匹配，不可误跳过。
  const payload = syncPayload([{ id: '1', ownerId: 'me', guestId: 'peer', guestLogo: AVATAR }])
  assert.deepEqual(parseSessionSyncProfiles(payload, 'me@goofish'), [
    { sessionId: '1', peerUserId: 'peer', peerAvatarUrl: AVATAR },
  ])
})

test('parseUserQueryProfile：v4.0 响应不含 userId，按会话作用域返回对方资料', () => {
  assert.deepEqual(parseUserQueryProfile({ data: { userInfo: { logo: AVATAR, fishNick: '闲鱼昵称', nick: '普通' } } }), {
    peerAvatarUrl: AVATAR,
    peerUserName: '闲鱼昵称',
  })
  // 无 logo / 无昵称 → 空对象（表示无可用资料）。
  assert.deepEqual(parseUserQueryProfile({ data: { userInfo: { type: 0 } } }), {})
})

test('resolveMissing：peer 等于自己（账号变化遗留）时用 session.sync 纠正并覆盖错头像', async () => {
  const requester = new FakeRequester((request) => {
    if (request.api === 'session.sync') {
      return syncPayload([{ id: '1', ownerId: 'me', guestId: 'real-peer', guestLogo: AVATAR }])
    }
    return { data: {} }
  })
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me' })
  // 旧缓存把 peer 错记为自己，且带着（错误的）旧头像。
  const updates = await resolver.resolveMissing([
    conv({ sessionId: '1', peerUserId: 'me', peerAvatarUrl: AVATAR2 }),
  ])
  assert.deepEqual(updates, [{ sessionId: '1', peerUserId: 'real-peer', peerAvatarUrl: AVATAR }])
})

test('resolveMissing：session.sync 成功但无 logo 时仍回传 peerId / 昵称', async () => {
  const requester = new FakeRequester((request) => {
    if (request.api === 'session.sync') {
      return {
        data: {
          sessions: [
            { session: { sessionId: '1', ownerInfo: { userId: 'me' }, userInfo: { userId: 'peer', fishNick: '买家' } } },
          ],
        },
      }
    }
    return { data: {} }
  })
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me' })
  const updates = await resolver.resolveMissing([conv({ sessionId: '1', peerUserId: 'peer' })])
  assert.deepEqual(updates, [{ sessionId: '1', peerUserId: 'peer', peerUserName: '买家' }])
})

test('resolveMissing：单条 user.query 失败不影响其它会话', async () => {
  const requester = new FakeRequester((request) => {
    if (request.api === 'session.sync') throw new Error('no sync')
    if (request.data.sessionId === '1') throw new Error('reject')
    return { data: { userInfo: { logo: AVATAR } } }
  })
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me', concurrency: 1 })
  const updates = await resolver.resolveMissing([conv({ sessionId: '1' }), conv({ sessionId: '2' })])
  assert.deepEqual(updates, [{ sessionId: '2', peerAvatarUrl: AVATAR }])
})

test('resolveMissing：同一 sessionId 只查一次（去重）', async () => {
  const requester = new FakeRequester((request) => {
    if (request.api === 'session.sync') throw new Error('no sync')
    return { data: { userInfo: { logo: AVATAR } } }
  })
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me' })
  const updates = await resolver.resolveMissing([conv({ sessionId: '1' }), conv({ sessionId: '1' })])
  assert.equal(updates.length, 1)
  assert.equal(requester.calls.filter((c) => c.api === 'user.query').length, 1)
})

test('resolveMissing：user.query 回退并发有界', async () => {
  let active = 0
  let maxActive = 0
  const requester = new FakeRequester(async (request) => {
    if (request.api === 'session.sync') throw new Error('no sync')
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
    return { data: { userInfo: { logo: AVATAR } } }
  })
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me', concurrency: 2 })
  const conversations = Array.from({ length: 6 }, (_, i) => conv({ sessionId: String(i + 1) }))
  const updates = await resolver.resolveMissing(conversations)
  assert.equal(updates.length, 6)
  assert.ok(maxActive <= 2, `并发应 <= 2，实际 ${maxActive}`)
})

test('真实 session.sync 结构：同一买家不同会话的商品封面独立，图片消息不参与', () => {
  const payload = { data: { sessions: [101, 102].map((id) => ({
    session: { sessionId: id, ownerInfo: { userId: 'me', logo: AVATAR },
      userInfo: { userId: 'buyer', fishNick: '买家', logo: AVATAR2 },
      itemInfo: { itemId: id + 1000, mainPic: `https://img.alicdn.com/item-${id}.jpg` } },
    message: { imageUrl: AVATAR },
  })) } }
  const profiles = parseSessionSyncProfiles(payload, 'me')
  assert.equal(profiles[0]?.itemId, '1101')
  assert.equal(profiles[0]?.itemCoverUrl, 'https://img.alicdn.com/item-101.jpg')
  assert.equal(profiles[1]?.itemCoverUrl, 'https://img.alicdn.com/item-102.jpg')
  assert.equal(profiles[0]?.peerAvatarUrl, AVATAR2)
})

test('商品封面必须有独立商品 ID，非法图片与用户头像不能成为商品封面', () => {
  for (const itemInfo of [{ mainPic: AVATAR }, { itemId: 42, mainPic: 'http://untrusted.example/a.jpg' },
    { itemId: 42, mainPic: 'https://user:pass@img.alicdn.com/a.jpg' }]) {
    const profiles = parseSessionSyncProfiles({ data: { sessions: [{ session: {
      sessionId: 1, ownerInfo: { userId: 'me', logo: AVATAR }, userInfo: { userId: 'buyer', logo: AVATAR2 }, itemInfo,
    } }] } }, 'me')
    assert.equal(profiles[0]?.itemCoverUrl, undefined)
  }
})


test('官方 CDN 的 HTTP 头像转为 HTTPS；凭据及其它 HTTP 地址仍拒绝', () => {
  assert.equal(parseUserQueryProfile({ data: { userInfo: { logo: 'http://img.alicdn.com/buyer.jpg' } } }).peerAvatarUrl,
    'https://img.alicdn.com/buyer.jpg')
  assert.equal(parseUserQueryProfile({ data: { userInfo: { logo: 'http://user:pass@img.alicdn.com/a.jpg' } } }).peerAvatarUrl, undefined)
})

test('商品头信息只使用与请求商品 ID 一致的封面，批量未匹配也能独立回退', async () => {
  const payload = { data: { commonData: { itemId: 42 }, left: { data: { picUrl: 'https://img.alicdn.com/item.jpg' } } } }
  assert.equal(parseItemHeadCover(payload, '43'), undefined)
  assert.equal(parseItemHeadCover(payload, '42'), 'https://img.alicdn.com/item.jpg')
  const requester = new FakeRequester(request => request.api === 'item.headinfo' ? payload : { data: {} })
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me' })
  const updates = await resolver.resolveMissing([conv({ sessionId: '1', itemId: '42', peerUserId: 'buyer', peerAvatarUrl: AVATAR })])
  assert.equal(updates[0]?.itemCoverUrl, 'https://img.alicdn.com/item.jpg')
  assert.deepEqual(requester.calls.find(c => c.api === 'item.headinfo')?.data, { sessionId: '1', itemId: '42', sessionType: 1 })
})
