/**
 * 生产接线回归：`createChatRuntime` 必须把对方头像补齐器真正注入 `ChatSync`。
 *
 * 背景：`ChatSync` 的 `peerProfiles` 是可选依赖，若组装层漏传，补齐逻辑形同虚设
 * （即便注入了 requester 也不会被调用）。本文件锁定：经 `CHAT_SYNC_CONVERSATIONS`
 * 走完整链路时，注入的 requester 会被实际调用并写回头像。
 *
 * 全程无 chrome / 无真实网络，使用假 LWP transport 与假 mtop requester。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, createCommand } from '@fishops/shared'
import { type LwpRequest, type LwpResponse } from '../../../../shared/chat/index'
import { ChatHistoryClient, type ChatTransport } from '../history'
import { fetchPeerProfileInPage } from '../peer-profiles-main'
import {
  PeerProfileResolver,
  type PeerProfileRequest,
  type PeerProfileRequester,
} from '../peer-profiles'
import { createChatRuntime } from '../../background/chat-runtime'

const AVATAR = 'https://img.alicdn.com/bao/uploaded/i2/x-0-mtopupload.jpg'

class FakeTransport implements ChatTransport {
  private readonly body: unknown
  constructor(body: unknown) {
    this.body = body
  }

  async send(request: LwpRequest): Promise<LwpResponse> {
    return { code: 200, headers: { mid: request.headers.mid }, body: this.body as LwpResponse['body'] }
  }
}

/** 会话列表响应：会话 111；通过 reminderUrl 是否带 peerUserId 控制 peerUserId 已知与否。 */
function conversationsBody(withPeerUserId: boolean): unknown {
  const reminderUrl = withPeerUserId ? 'https://x?itemId=456&peerUserId=999' : 'https://x?itemId=456'
  return {
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
              extension: { reminderUrl },
            },
          },
        },
      },
    ],
    hasMore: false,
  }
}

class FakeRequester implements PeerProfileRequester {
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

async function syncConversations(runtime: ReturnType<typeof createChatRuntime>): Promise<unknown> {
  await runtime.init()
  const response = await runtime.handleCommand(createCommand(CommandTypes.CHAT_SYNC_CONVERSATIONS, {}))
  return response.result
}

test('生产接线：注入的 peerProfileRequester 在会话同步时被实际调用并写回头像', async () => {
  const requester = new FakeRequester((request) => {
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

  const runtime = createChatRuntime({
    transport: new FakeTransport(conversationsBody(false)),
    myUserId: 'me',
    peerProfileRequester: requester,
  })

  const result = (await syncConversations(runtime)) as { ok: boolean }
  assert.equal(result.ok, true)
  assert.ok(requester.calls.some((c) => c.api === 'session.sync'), '同步应实际调用注入的 requester')
  assert.equal(runtime.getStore().getConversation('111')?.peerAvatarUrl, AVATAR)
  assert.equal(runtime.getStore().getConversation('111')?.peerUserId, 'peer')
})

test('生产接线：普通单聊按 session 作用域回退 user.query（无需 myUserId）', async () => {
  const requester = new FakeRequester((request) => {
    if (request.api === 'session.sync') return { ret: ['SUCCESS'], data: { sessions: [] } }
    return { data: { userInfo: { logo: AVATAR } } }
  })

  // 不传 myUserId：session.sync 路径无法判定归属，由 session 作用域的 user.query 回退。
  const runtime = createChatRuntime({
    transport: new FakeTransport(conversationsBody(true)),
    peerProfileRequester: requester,
  })

  const result = (await syncConversations(runtime)) as { ok: boolean }
  assert.equal(result.ok, true)
  const queryCall = requester.calls.find((c) => c.api === 'user.query')
  assert.ok(queryCall, '无 myUserId 时应走 user.query 回退')
  assert.deepEqual(queryCall?.data, { type: 0, sessionType: 1, sessionId: '111', isOwner: false })
  assert.equal(runtime.getStore().getConversation('111')?.peerAvatarUrl, AVATAR)
})

test('生产接线：显式 peerProfiles 优先于自组 requester', async () => {
  let resolveCalls = 0
  const explicit = {
    async resolveMissing(conversations: readonly { sessionId: string }[]) {
      resolveCalls += 1
      return conversations.map((c) => ({ sessionId: c.sessionId, peerAvatarUrl: AVATAR }))
    },
  } as unknown as PeerProfileResolver

  const neverCalled = new FakeRequester(() => {
    throw new Error('不应被调用')
  })

  const runtime = createChatRuntime({
    transport: new FakeTransport(conversationsBody(false)),
    myUserId: 'me',
    peerProfiles: explicit,
    peerProfileRequester: neverCalled,
  })

  await syncConversations(runtime)
  assert.equal(resolveCalls, 1)
  assert.equal(neverCalled.calls.length, 0)
  assert.equal(runtime.getStore().getConversation('111')?.peerAvatarUrl, AVATAR)
})

test('生产接线：环境无 chrome.scripting 时不注入补齐器，会话同步照常', async () => {
  const savedChrome = (globalThis as { chrome?: unknown }).chrome
  delete (globalThis as { chrome?: unknown }).chrome
  try {
    const runtime = createChatRuntime({
      transport: new FakeTransport(conversationsBody(false)),
      myUserId: 'me',
    })
    const result = (await syncConversations(runtime)) as { ok: boolean }
    assert.equal(result.ok, true)
    assert.equal(runtime.getStore().sessionCount, 1)
    // 无 requester：不补头像，但同步成功、不抛错。
    assert.equal(runtime.getStore().getConversation('111')?.peerAvatarUrl, undefined)
  } finally {
    if (savedChrome !== undefined) (globalThis as { chrome?: unknown }).chrome = savedChrome
  }
})

test('组装层：ChatHistoryClient 与 Fakes 一致（防止 transport 误用）', async () => {
  // 纯防御：确认 FakeTransport 与真实 ChatHistoryClient 契约一致。
  const client = new ChatHistoryClient({ transport: new FakeTransport(conversationsBody(false)) })
  const page = await client.listConversations()
  assert.equal(page.conversations.length, 1)
  assert.equal(page.conversations[0].sessionId, '111')
})

test('生产默认接线：无显式注入时用 chrome.scripting MAIN world 自组 requester', async () => {
  const savedChrome = (globalThis as { chrome?: unknown }).chrome
  const injections: Array<{ world?: string; target?: { tabId?: number }; func?: unknown; args?: unknown[] }> = []
  ;(globalThis as { chrome?: unknown }).chrome = {
    scripting: {
      executeScript: async (injection: { world?: string; target?: { tabId?: number }; func?: unknown; args?: unknown[] }) => {
        injections.push(injection)
        return [
          {
            result: {
              ok: true,
              payload: {
                ret: ['SUCCESS::调用成功'],
                data: {
                  sessions: [
                    { session: { sessionId: '111', ownerInfo: { userId: 'me' }, userInfo: { userId: 'peer', logo: AVATAR } } },
                  ],
                },
              },
            },
          },
        ]
      },
    },
    tabs: { query: async () => [{ id: 7, url: 'https://www.goofish.com/im' }] },
  }
  try {
    const runtime = createChatRuntime({
      transport: new FakeTransport(conversationsBody(false)),
      myUserId: 'me',
    })
    const result = (await syncConversations(runtime)) as { ok: boolean }
    assert.equal(result.ok, true)
    assert.ok(injections.length >= 1, '应通过 chrome.scripting 注入读取')
    assert.equal(injections[0].world, 'MAIN')
    assert.equal(injections[0].target?.tabId, 7)
    assert.equal(injections[0].func, fetchPeerProfileInPage)
    assert.deepEqual(injections[0].args, [{ api: 'session.sync', data: { sessionTypes: [1], fetchNum: 30 } }])
    assert.equal(runtime.getStore().getConversation('111')?.peerAvatarUrl, AVATAR)
  } finally {
    if (savedChrome === undefined) delete (globalThis as { chrome?: unknown }).chrome
    else (globalThis as { chrome?: unknown }).chrome = savedChrome
  }
})
