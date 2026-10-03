/**
 * 聊天同步响应链路回归测试（无 chrome / 无真实网络）。
 *
 * 背景：真实浏览器中 `CHAT_SYNC_CONVERSATIONS` 曾返回空响应，Workbench 报
 * `INVALID_MESSAGE: 扩展返回的响应不是合法 ResponseEnvelope`。根因是聊天同步链路上
 * transport / LWP / 持久化的异常逃出 listener，最终走到 background onMessage 的兜底
 * `sendResponse(undefined)`，客户端 `isResponseEnvelope(undefined) === false` 判为非法消息。
 *
 * 本文件锁定修复后的契约：
 * - 成功 / 业务失败 / 无 tab / LWP 失败 / transport reject / 初始化失败 / 持久化失败，
 *   一律返回结构合法且可展示的 ResponseEnvelope，绝不 sendResponse(undefined) 或 reject；
 * - `result.ok=false` 作为正常响应返回（envelope.ok 仍可为 true），并带可展示错误；
 * - 错误信息不携带 transport 原始 body / token / 聊天正文。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, createCommand, createErrorResponse, isResponseEnvelope } from '@fishops/shared'
import { type LwpRequest, type LwpResponse } from '../../../../shared/chat/index'
import { ChatSocketTransportError } from '../socket-transport'
import { createBackgroundChatTransport } from '../background-transport'
import type { ChatTransport } from '../history'
import { ChatStore, type ChatPersistence } from '../store'
import { createChatRuntime } from '../../background/chat-runtime'
import { handleCommand, type RouterDeps } from '../../background/message-router'

/** 固定返回同一个 LWP 响应的 transport。 */
class FakeTransport implements ChatTransport {
  private readonly responder: (request: LwpRequest) => LwpResponse

  constructor(responder: (request: LwpRequest) => LwpResponse) {
    this.responder = responder
  }

  async send(request: LwpRequest): Promise<LwpResponse> {
    return this.responder(request)
  }
}

/** 直接 reject 的 transport（模拟无 tab / executor 抛错 / 超时等）。 */
class RejectTransport implements ChatTransport {
  private readonly error: unknown

  constructor(error: unknown) {
    this.error = error
  }

  async send(): Promise<LwpResponse> {
    throw this.error
  }
}

/** 组装 message-router 依赖，聊天命令委托给真实 ChatRuntime。 */
function chatDeps(options: { transport?: ChatTransport; persistence?: ChatPersistence } = {}): RouterDeps {
  const runtime = createChatRuntime(options)
  return {
    now: () => 1000,
    workerStartedAt: 500,
    incrementPingCount: async () => 1,
    broadcast: () => 0,
    subscribe: (events) => events,
    unsubscribe: (events) => events,
    chat: { handleCommand: (command) => runtime.handleCommand(command) },
  }
}

/** 固定空会话页的响应。 */
const emptyConversations = (request: LwpRequest): LwpResponse => ({
  code: 200,
  headers: { mid: request.headers.mid },
  body: { userConvs: [], hasMore: false },
})

/**
 * 复刻 background `onMessage` 的响应贯穿（与 `index.ts` 修复后一致）：
 * `handleCommand` 正常返回 envelope；意外异常则由兜底转成结构化 INTERNAL，
 * **绝不 sendResponse(undefined)**。
 */
async function respondLikeBackground(
  command: Parameters<typeof handleCommand>[0],
  deps: RouterDeps,
): Promise<unknown> {
  try {
    return await handleCommand(command, deps)
  } catch (error) {
    return createErrorResponse(command.requestId, command.type, {
      code: 'INTERNAL',
      message: `命令处理失败: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

test('对照：undefined 响应会被客户端判为 INVALID_MESSAGE（原缺陷触发点）', () => {
  // ChromeRuntimeTransport.call 用 isResponseEnvelope 判定；undefined 非合法 envelope。
  assert.equal(isResponseEnvelope(undefined), false)
  assert.equal(isResponseEnvelope(createErrorResponse('r', CommandTypes.CHAT_SYNC_CONVERSATIONS, { code: 'INTERNAL', message: 'x' })), true)
})

test('回归：聊天层抛异常时 background 仍返回合法 envelope（不再 undefined）', async () => {
  const deps: RouterDeps = {
    ...chatDeps(),
    // 模拟 transport / 归一层漏网异常。
    chat: {
      handleCommand: async () => {
        throw new Error('意外异常')
      },
    },
  }
  const response = await respondLikeBackground(createCommand(CommandTypes.CHAT_SYNC_CONVERSATIONS, {}), deps)
  assert.equal(isResponseEnvelope(response), true)
  const envelope = response as { ok: boolean; error?: { code: string } }
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error?.code, 'INTERNAL')
})

test('正常空结果：envelope.ok=true 且 result.ok=true（added/updated=0）', async () => {
  const deps = chatDeps({ transport: new FakeTransport(emptyConversations) })
  const response = await respondLikeBackground(createCommand(CommandTypes.CHAT_SYNC_CONVERSATIONS, {}), deps)
  assert.equal(isResponseEnvelope(response), true)
  const envelope = response as { ok: boolean; result: { ok: boolean; added: number; updated: number } }
  assert.equal(envelope.ok, true)
  assert.deepEqual({ ok: envelope.result.ok, added: envelope.result.added, updated: envelope.result.updated }, { ok: true, added: 0, updated: 0 })
})

test('无 goofish tab：结构化失败作为正常响应返回，不 reject', async () => {
  // background-transport 在 resolveTabId 为 null 时 reject NO_SOCKET（且不调用 executor）。
  const transport = createBackgroundChatTransport({
    executor: {
      execute: async () => {
        throw new Error('不应被调用（无 tab）')
      },
    },
    resolveTabId: async () => null,
  })
  const deps = chatDeps({ transport })
  const response = await respondLikeBackground(createCommand(CommandTypes.CHAT_SYNC_CONVERSATIONS, {}), deps)
  assert.equal(isResponseEnvelope(response), true)
  const envelope = response as { ok: boolean; result: { ok: boolean; error?: { code: string; message: string } } }
  assert.equal(envelope.ok, true, '命令被正常处理，envelope.ok 为 true')
  assert.equal(envelope.result.ok, false)
  assert.equal(envelope.result.error?.code, 'NO_SOCKET')
  assert.ok((envelope.result.error?.message ?? '').length > 0, '错误需可展示')
})

test('transport reject（普通异常）：归一为 INTERNAL，不逃逸', async () => {
  const deps = chatDeps({ transport: new RejectTransport(new Error('socket 断了')) })
  const response = await respondLikeBackground(createCommand(CommandTypes.CHAT_SYNC_CONVERSATIONS, {}), deps)
  assert.equal(isResponseEnvelope(response), true)
  const envelope = response as { ok: boolean; result: { ok: boolean; error?: { code: string } } }
  assert.equal(envelope.ok, true)
  assert.equal(envelope.result.ok, false)
  assert.equal(envelope.result.error?.code, 'INTERNAL')
})

test('transport 抛结构化错误：保留 code（TIMEOUT）', async () => {
  const deps = chatDeps({ transport: new RejectTransport(new ChatSocketTransportError('TIMEOUT', 'LWP 请求超时')) })
  const response = await respondLikeBackground(createCommand(CommandTypes.CHAT_SYNC_CONVERSATIONS, {}), deps)
  const envelope = response as { result: { ok: boolean; error?: { code: string } } }
  assert.equal(envelope.result.ok, false)
  assert.equal(envelope.result.error?.code, 'TIMEOUT')
})

test('LWP 失败：归一 LWP_ERROR，且不把响应 body（token/正文）带出', async () => {
  const leakyBody = { token: 'SECRET-TOKEN', text: '机密聊天正文' }
  const transport = new FakeTransport((request) => ({
    code: 500,
    message: '服务端错误',
    headers: { mid: request.headers.mid },
    body: leakyBody,
  }))
  const deps = chatDeps({ transport })
  const response = await respondLikeBackground(createCommand(CommandTypes.CHAT_SYNC_CONVERSATIONS, {}), deps)
  assert.equal(isResponseEnvelope(response), true)
  const serialized = JSON.stringify(response)
  assert.equal(serialized.includes('SECRET-TOKEN'), false, '响应不得携带 token')
  assert.equal(serialized.includes('机密聊天正文'), false, '响应不得携带聊天正文')
  const envelope = response as { result: { ok: boolean; error?: { code: string } } }
  assert.equal(envelope.result.ok, false)
  assert.equal(envelope.result.error?.code, 'LWP_ERROR')
})

test('初始化失败（storage load 抛错）：返回结构化 INTERNAL，不 reject', async () => {
  const failLoad: ChatPersistence = {
    loadMessages: async () => [],
    loadConversations: async () => {
      throw new Error('mock storage unavailable')
    },
    saveMessages: async () => {},
    saveConversations: async () => {},
  }
  const deps = chatDeps({ transport: new FakeTransport(emptyConversations), persistence: failLoad })
  const response = await respondLikeBackground(createCommand(CommandTypes.CHAT_SYNC_CONVERSATIONS, {}), deps)
  assert.equal(isResponseEnvelope(response), true)
  const envelope = response as { ok: boolean; error?: { code: string; message: string } }
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error?.code, 'INTERNAL')
  assert.ok((envelope.error?.message ?? '').length > 0)
})

test('持久化失败（storage save 抛错）：业务失败作为正常响应返回', async () => {
  const failSave: ChatPersistence = {
    loadMessages: async () => [],
    loadConversations: async () => [],
    saveMessages: async () => {},
    saveConversations: async () => {
      throw new Error('mock storage write failed')
    },
  }
  const transport = new FakeTransport((request) => ({
    code: 200,
    headers: { mid: request.headers.mid },
    body: {
      userConvs: [
        {
          singleChatUserConversation: {
            cid: '1@goofish',
            modifyTime: 100,
            lastMessage: { message: { cid: '1@goofish', createAt: 100, content: { custom: { summary: 'hi' } }, extension: {} } },
          },
        },
      ],
      hasMore: false,
    },
  }))
  const deps = chatDeps({ transport, persistence: failSave })
  const response = await respondLikeBackground(createCommand(CommandTypes.CHAT_SYNC_CONVERSATIONS, {}), deps)
  assert.equal(isResponseEnvelope(response), true)
  const envelope = response as { ok: boolean; result: { ok: boolean; added: number; error?: { message: string } } }
  assert.equal(envelope.ok, true, '命令被正常处理')
  assert.equal(envelope.result.ok, false, '业务失败体现在 result.ok=false')
  assert.ok((envelope.result.error?.message ?? '').length > 0)
})

test('CHAT_SYNC_HISTORY：同样返回合法 envelope（无 tab 场景）', async () => {
  const transport = createBackgroundChatTransport({
    executor: { execute: async () => ({ ok: false, error: { code: 'NO_SOCKET', message: '页面未安装 transport' } }) },
    resolveTabId: async () => 7,
  })
  const deps = chatDeps({ transport })
  const response = await respondLikeBackground(
    createCommand(CommandTypes.CHAT_SYNC_HISTORY, { sessionId: '1' }),
    deps,
  )
  assert.equal(isResponseEnvelope(response), true)
  const envelope = response as { ok: boolean; result: { ok: boolean } }
  assert.equal(envelope.result.ok, false)
})

test('chat 未接线：仍返回结构合法 INTERNAL', async () => {
  const deps: RouterDeps = {
    now: () => 1000,
    workerStartedAt: 500,
    incrementPingCount: async () => 1,
    broadcast: () => 0,
    subscribe: (events) => events,
    unsubscribe: (events) => events,
  }
  const response = await respondLikeBackground(createCommand(CommandTypes.CHAT_SYNC_CONVERSATIONS, {}), deps)
  assert.equal(isResponseEnvelope(response), true)
  assert.equal((response as { error?: { code: string } }).error?.code, 'INTERNAL')
})

test('ChatSync 归一：transport reject 不抛，返回 SyncResult 结构化错误', async () => {
  // 直接覆盖 sync 层契约（不经过 router）。
  const store = new ChatStore()
  const { ChatSync } = await import('../sync')
  const { ChatHistoryClient } = await import('../history')
  const sync = new ChatSync({ store, history: new ChatHistoryClient({ transport: new RejectTransport(new ChatSocketTransportError('NO_SOCKET', '无 tab')) }) })
  const result = await sync.syncConversations({ pages: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'NO_SOCKET')
  assert.equal(`${result.error?.message}`.includes('@goofish'), false)
})

// ---------------- CHAT_SYNC_HISTORY：与 CONVERSATIONS 同等强度的失败契约 ----------------

/** 构造一页合法的历史消息响应（至少一条，避免误判为空成功）。 */
const historyPage = (request: LwpRequest): LwpResponse => ({
  code: 200,
  headers: { mid: request.headers.mid },
  body: {
    userMessageModels: [
      {
        message: {
          messageId: 'm1',
          cid: '1@goofish',
          createAt: 100,
          content: { custom: { contentType: 1, data: Buffer.from(JSON.stringify({ contentType: 1, text: { text: 'hi' } }), 'utf-8').toString('base64') } },
          extension: { senderUserId: '999', reminderTitle: '买家' },
        },
      },
    ],
    nextCursor: 0,
  },
})

test('CHAT_SYNC_HISTORY：缺少 sessionId → 结构化 INVALID_PAYLOAD（合法 envelope，不 undefined）', async () => {
  const deps = chatDeps({ transport: new FakeTransport(historyPage) })
  const response = await respondLikeBackground(
    { kind: 'command', protocol: 1, requestId: 'r', type: CommandTypes.CHAT_SYNC_HISTORY, payload: {}, sentAt: 0 },
    deps,
  )
  assert.equal(isResponseEnvelope(response), true)
  const envelope = response as { ok: boolean; error?: { code: string; message: string } }
  assert.equal(envelope.ok, false)
  assert.equal(envelope.error?.code, 'INVALID_PAYLOAD')
  assert.ok((envelope.error?.message ?? '').length > 0, '错误需可展示')
})

test('CHAT_SYNC_HISTORY：LWP 失败 → result.ok=false + LWP_ERROR，且不泄露响应体', async () => {
  const leakyBody = { token: 'SECRET-TOKEN', text: '机密聊天正文' }
  const transport = new FakeTransport((request) => ({
    code: 500,
    message: '服务端错误',
    headers: { mid: request.headers.mid },
    body: leakyBody,
  }))
  const deps = chatDeps({ transport })
  const response = await respondLikeBackground(createCommand(CommandTypes.CHAT_SYNC_HISTORY, { sessionId: '1' }), deps)
  assert.equal(isResponseEnvelope(response), true)
  const serialized = JSON.stringify(response)
  assert.equal(serialized.includes('SECRET-TOKEN'), false, '响应不得携带 token')
  assert.equal(serialized.includes('机密聊天正文'), false, '响应不得携带聊天正文')
  const envelope = response as { ok: boolean; result: { ok: boolean; error?: { code: string } } }
  assert.equal(envelope.ok, true, '命令被正常处理，envelope.ok 为 true')
  assert.equal(envelope.result.ok, false, '业务失败体现在 result.ok=false')
  assert.equal(envelope.result.error?.code, 'LWP_ERROR')
})

test('CHAT_SYNC_HISTORY：响应 body 非法 → result.ok=false + INVALID_RESPONSE', async () => {
  const transport = new FakeTransport(() => ({ code: 200, body: 'not-a-record' as unknown }))
  const deps = chatDeps({ transport })
  const response = await respondLikeBackground(createCommand(CommandTypes.CHAT_SYNC_HISTORY, { sessionId: '1' }), deps)
  assert.equal(isResponseEnvelope(response), true)
  const envelope = response as { ok: boolean; result: { ok: boolean; error?: { code: string; message: string } } }
  assert.equal(envelope.ok, true)
  assert.equal(envelope.result.ok, false)
  assert.equal(envelope.result.error?.code, 'INVALID_RESPONSE')
  assert.ok((envelope.result.error?.message ?? '').length > 0)
})

test('CHAT_SYNC_HISTORY：transport 返回 undefined → 归一为结构化错误，不 reject', async () => {
  const transport = new FakeTransport(() => undefined as unknown as LwpResponse)
  const deps = chatDeps({ transport })
  const response = await respondLikeBackground(createCommand(CommandTypes.CHAT_SYNC_HISTORY, { sessionId: '1' }), deps)
  assert.equal(isResponseEnvelope(response), true)
  const envelope = response as { ok: boolean; result?: { ok?: boolean; error?: { code: string; message: string } } }
  assert.ok(envelope.result, 'ok 响应必须带 result，不能是 undefined')
  assert.equal(envelope.result?.ok, false)
  assert.equal(envelope.result?.error?.code, 'INTERNAL')
  assert.ok((envelope.result?.error?.message ?? '').length > 0)
})

/**
 * 失败契约巡检：两个同步命令 × 多种 transport 失败形态，都必须返回结构合法的 envelope，
 * 且业务失败只体现在 `result.ok=false`（或 `envelope.ok=false`），绝不出现 `result=undefined`。
 */
test('失败契约巡检：CHAT_SYNC_* × 多种 transport 失败都返回合法 envelope', async () => {
  const scenarios: Array<{ name: string; transport: ChatTransport }> = [
    { name: 'reject 普通异常', transport: new RejectTransport(new Error('boom')) },
    { name: 'reject 结构化 NO_SOCKET', transport: new RejectTransport(new ChatSocketTransportError('NO_SOCKET', '无 tab')) },
    { name: 'LWP 业务失败', transport: new FakeTransport((r) => ({ code: 403, message: '受限', headers: { mid: r.headers.mid }, body: { token: 'x' } })) },
    { name: '返回 undefined', transport: new FakeTransport(() => undefined as unknown as LwpResponse) },
    { name: 'code 缺失', transport: new FakeTransport(() => ({} as LwpResponse)) },
  ]
  const commands = [
    createCommand(CommandTypes.CHAT_SYNC_CONVERSATIONS, {}),
    createCommand(CommandTypes.CHAT_SYNC_HISTORY, { sessionId: '1' }),
  ]
  for (const scenario of scenarios) {
    for (const command of commands) {
      const label = `${scenario.name} / ${command.type}`
      const response = await respondLikeBackground(command, chatDeps({ transport: scenario.transport }))
      assert.equal(isResponseEnvelope(response), true, `${label}: 响应不是合法 envelope`)
      const envelope = response as { ok: boolean; result?: { ok?: unknown }; error?: unknown }
      if (envelope.ok) {
        assert.ok(envelope.result && typeof envelope.result === 'object', `${label}: ok=true 但 result 非法`)
        assert.equal(envelope.result?.ok, false, `${label}: 业务失败应体现在 result.ok=false`)
      } else {
        assert.ok(envelope.error, `${label}: ok=false 但缺结构化 error`)
      }
    }
  }
})
