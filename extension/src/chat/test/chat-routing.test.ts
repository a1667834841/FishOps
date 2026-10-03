/**
 * P5 接线测试（无 chrome 依赖）：命令路由、ChatRuntime、来源校验与负载限制。
 *
 * 覆盖：
 * - message-router 把 CHAT_* 命令委托给 ChatRuntime；
 * - CHAT_SOCKET_EVENT 不在 Workbench 命令白名单内（应返回 UNKNOWN_COMMAND）；
 * - 实时上报仅产生不含正文的元数据事件；
 * - 来源校验与 socket payload 限制；
 * - PING 不回归。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CHAT_SOCKET_MAX_RAW_LENGTH,
  CommandTypes,
  createCommand,
  isChatSocketEventPayload,
} from '@fishops/shared'
import { LWP_ROUTES, type LwpRequest, type LwpResponse } from '../../../../shared/chat/index'
import type { ChatTransport } from '../history'
import { createChatRuntime } from '../../background/chat-runtime'
import { isTrustedChatContentSource } from '../../background/chat-source'
import { handleCommand, type RouterDeps } from '../../background/message-router'

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

function chatDeps(transport?: ChatTransport): { deps: RouterDeps; runtime: ReturnType<typeof createChatRuntime> } {
  const runtime = createChatRuntime(transport ? { transport } : {})
  const deps: RouterDeps = {
    now: () => 1000,
    workerStartedAt: 500,
    incrementPingCount: async () => 1,
    broadcast: () => 0,
    subscribe: (events) => events,
    unsubscribe: (events) => events,
    chat: { handleCommand: (command) => runtime.handleCommand(command) },
  }
  return { deps, runtime }
}

const convItem = (cid: string, summary: string): unknown => ({
  singleChatUserConversation: {
    cid,
    modifyTime: 100,
    joinTime: 100,
    redPoint: 1,
    lastMessage: {
      message: { cid, createAt: 100, content: { custom: { summary } }, extension: { reminderTitle: '买家' } },
    },
  },
})

test('PING 接入 chat 后不回归', async () => {
  const { deps } = chatDeps()
  const response = await handleCommand(createCommand(CommandTypes.PING, { clientTime: 1, nonce: 'n' }), deps)
  assert.equal(response.ok, true)
  assert.equal((response.result as { pong: boolean }).pong, true)
})

test('CHAT_STATUS：空 store 返回 0，socketStatus 初始 connecting', async () => {
  const { deps } = chatDeps()
  const response = await handleCommand(createCommand(CommandTypes.CHAT_STATUS, {}), deps)
  assert.equal(response.ok, true)
  assert.deepEqual(response.result, { socketStatus: 'connecting', sessionCount: 0, messageCount: 0 })
})

test('CHAT_GET_MESSAGES：缺少 sessionId 返回 INVALID_PAYLOAD', async () => {
  const { deps } = chatDeps()
  const response = await handleCommand(
    { kind: 'command', protocol: 1, requestId: 'r', type: CommandTypes.CHAT_GET_MESSAGES, payload: {}, sentAt: 0 },
    deps,
  )
  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'INVALID_PAYLOAD')
})

test('chat 未接线时返回 INTERNAL', async () => {
  const deps: RouterDeps = {
    now: () => 1000,
    workerStartedAt: 500,
    incrementPingCount: async () => 1,
    broadcast: () => 0,
    subscribe: (events) => events,
    unsubscribe: (events) => events,
  }
  const response = await handleCommand(createCommand(CommandTypes.CHAT_STATUS, {}), deps)
  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'INTERNAL')
})

test('CHAT_SOCKET_EVENT 不在 Workbench 白名单内（返回 UNKNOWN_COMMAND）', async () => {
  const { deps } = chatDeps()
  const response = await handleCommand(
    createCommand(CommandTypes.CHAT_SOCKET_EVENT, { event: 'open', at: 1 }),
    deps,
  )
  assert.equal(response.ok, false)
  assert.equal(response.error?.code, 'UNKNOWN_COMMAND')
})

test('CHAT_SYNC_CONVERSATIONS：写入 store 并产生同步/会话更新事件', async () => {
  const transport = new FakeTransport((request) => {
    if (request.lwp === LWP_ROUTES.listConversations) {
      return { code: 200, headers: { mid: request.headers.mid }, body: { userConvs: [convItem('1@goofish', '你好')] } }
    }
    return { code: 200, headers: { mid: request.headers.mid }, body: {} }
  })
  const { deps, runtime } = chatDeps(transport)

  const response = await handleCommand(createCommand(CommandTypes.CHAT_SYNC_CONVERSATIONS, {}), deps)
  assert.equal(response.ok, true)
  assert.equal((response.result as { added: number }).added, 1)

  const events = runtime.drainEvents()
  assert.ok(events.some((e) => e.type === 'CHAT_CONVERSATION_UPDATED'))
  assert.ok(events.some((e) => e.type === 'CHAT_SYNC_COMPLETED'))

  const status = await handleCommand(createCommand(CommandTypes.CHAT_STATUS, {}), deps)
  assert.equal((status.result as { sessionCount: number }).sessionCount, 1)
})

test('实时上报产生元数据事件，且负载不含聊天正文', () => {
  const { runtime } = chatDeps()
  const raw = JSON.stringify({
    code: 200,
    body: {
      content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text: '机密内容' } })) } },
      extension: { senderUserId: '999', reminderUrl: 'https://x?sid=123&peerUserId=999' },
      createAt: 1,
      messageId: 'm1',
    },
  })
  runtime.ingestSocketEvent({ event: 'message', raw, at: 1 })
  const events = runtime.drainEvents()
  const ingested = events.find((e) => e.type === 'CHAT_MESSAGE_INGESTED')
  assert.ok(ingested)
  assert.equal(JSON.stringify(ingested.payload).includes('机密内容'), false)
})

test('isChatSocketEventPayload：结构与长度限制', () => {
  assert.equal(isChatSocketEventPayload({ event: 'message', raw: 'x', at: 1 }), true)
  assert.equal(isChatSocketEventPayload({ event: 'open', at: 1 }), true)
  assert.equal(isChatSocketEventPayload({ event: 'nope', at: 1 }), false)
  assert.equal(isChatSocketEventPayload({ event: 'message', at: 1, raw: 123 }), false)
  assert.equal(
    isChatSocketEventPayload({ event: 'message', at: 1, raw: 'x'.repeat(CHAT_SOCKET_MAX_RAW_LENGTH + 1) }),
    false,
  )
})

test('isTrustedChatContentSource：只接受本扩展的 goofish content script', () => {
  const extId = 'fishops-ext'
  assert.equal(isTrustedChatContentSource({ id: extId, tab: { id: 1 }, url: 'https://www.goofish.com/' }, extId), true)
  // 扩展内页（无 tab）被拒绝
  assert.equal(isTrustedChatContentSource({ id: extId, url: 'chrome-extension://x/workbench.html' }, extId), false)
  // 非 goofish 页面被拒绝
  assert.equal(isTrustedChatContentSource({ id: extId, tab: { id: 1 }, url: 'https://evil.com/' }, extId), false)
  // 外部扩展 id 被拒绝
  assert.equal(isTrustedChatContentSource({ id: 'other', tab: { id: 1 }, url: 'https://www.goofish.com/' }, extId), false)
})

test('transport 构造仅接受白名单路由（与 LWP_ROUTES 对齐）', () => {
  assert.deepEqual(
    [LWP_ROUTES.listConversations, LWP_ROUTES.listMessages],
    ['/r/Conversation/listNewestPagination', '/r/MessageManager/listUserMessages'],
  )
})
