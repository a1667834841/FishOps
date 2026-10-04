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
  parseUserQueryAvatar,
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

test('parseSessionSyncProfiles：http（非 https）logo 被拒绝', () => {
  const payload = syncPayload([{ id: '1', ownerId: 'me', guestId: 'peer', guestLogo: 'http://img.alicdn.com/x.jpg' }])
  assert.deepEqual(parseSessionSyncProfiles(payload, 'me'), [])
})

test('parseUserQueryAvatar：提取 data.userInfo.logo 并校验 https', () => {
  assert.equal(parseUserQueryAvatar({ ret: ['SUCCESS'], data: { userInfo: { logo: AVATAR } } }), AVATAR)
  assert.equal(parseUserQueryAvatar({ data: { userInfo: { logo: 'http://img.alicdn.com/x.jpg' } } }), undefined)
  assert.equal(parseUserQueryAvatar({ data: {} }), undefined)
  assert.equal(parseUserQueryAvatar('nope'), undefined)
})

test('resolveMissing：会话已有头像时不发起任何请求', async () => {
  const requester = new FakeRequester(() => syncPayload([]))
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me' })
  const updates = await resolver.resolveMissing([conv({ sessionId: '1', peerAvatarUrl: AVATAR })])
  assert.deepEqual(updates, [])
  assert.equal(requester.calls.length, 0)
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
  // 仅一次 session.sync，且不含 user.query（已被批量覆盖）。
  assert.equal(requester.calls.filter((c) => c.api === 'session.sync').length, 1)
  assert.equal(requester.calls.filter((c) => c.api === 'user.query').length, 0)
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

test('resolveMissing：session.sync 失败时回退 user.query（按 peerId）', async () => {
  const requester = new FakeRequester((request) => {
    if (request.api === 'session.sync') throw new Error('boom')
    return { data: { userInfo: { logo: AVATAR } } }
  })
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me' })
  const updates = await resolver.resolveMissing([conv({ sessionId: '1', peerUserId: 'peer' })])
  assert.deepEqual(updates, [{ sessionId: '1', peerUserId: 'peer', peerAvatarUrl: AVATAR }])
  const queryCall = requester.calls.find((c) => c.api === 'user.query')
  assert.deepEqual(queryCall?.data, { type: 0, userId: 'peer', sessionId: '1' })
})

test('resolveMissing：单条 user.query 失败不影响其它会话', async () => {
  const requester = new FakeRequester((request) => {
    if (request.api === 'session.sync') throw new Error('no sync')
    if (request.data.userId === 'bad') throw new Error('reject')
    return { data: { userInfo: { logo: AVATAR } } }
  })
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me', concurrency: 1 })
  const updates = await resolver.resolveMissing([
    conv({ sessionId: '1', peerUserId: 'bad' }),
    conv({ sessionId: '2', peerUserId: 'good' }),
  ])
  assert.deepEqual(updates, [{ sessionId: '2', peerUserId: 'good', peerAvatarUrl: AVATAR }])
})

test('resolveMissing：同一 sessionId 只查一次（去重）', async () => {
  const requester = new FakeRequester((request) => {
    if (request.api === 'session.sync') throw new Error('no sync')
    return { data: { userInfo: { logo: AVATAR } } }
  })
  const resolver = new PeerProfileResolver({ requester, myUserId: 'me' })
  const updates = await resolver.resolveMissing([
    conv({ sessionId: '1', peerUserId: 'peer' }),
    conv({ sessionId: '1', peerUserId: 'peer' }),
  ])
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
  const conversations = Array.from({ length: 6 }, (_, i) => conv({ sessionId: String(i + 1), peerUserId: `peer${i}` }))
  const updates = await resolver.resolveMissing(conversations)
  assert.equal(updates.length, 6)
  assert.ok(maxActive <= 2, `并发应 <= 2，实际 ${maxActive}`)
})
