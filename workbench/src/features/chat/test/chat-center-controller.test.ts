/**
 * ChatCenterController 单测：用最小 mock Bridge 覆盖加载 / 错误 / 竞态 / 同步 / 事件 / 释放。
 * 纯 Node 运行，不依赖浏览器、Vue 或真实扩展。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, EventTypes } from '@fishops/shared'
import {
  CHAT_CENTER_EVENTS,
  ChatCenterController,
  type ChatCenterApi,
  type ChatCenterEventType,
  type ChatCommandType,
} from '../chat-center-controller'
import type { ChatMessage, Conversation } from '../types'

// ---------------- 测试替身 ----------------

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Responder = (payload: unknown) => unknown | Promise<unknown>

class FakeApi implements ChatCenterApi {
  readonly calls: Array<{ type: string; payload: unknown }> = []
  readonly handlers = new Map<string, Set<(payload: unknown) => void>>()
  resubscribeCount = 0
  onThrows = false
  private readonly responders = new Map<string, Responder>()

  respond(type: ChatCommandType, responder: Responder): void {
    this.responders.set(type, responder)
  }

  async call(type: ChatCommandType, payload: unknown): Promise<never> {
    this.calls.push({ type, payload })
    const responder = this.responders.get(type)
    if (!responder) throw new Error(`未配置 ${type} 的响应`)
    return (await responder(payload)) as never
  }

  on(type: ChatCenterEventType, handler: (payload: never) => void): () => void {
    if (this.onThrows) throw new Error('connect 失败')
    const set = this.handlers.get(type) ?? new Set()
    set.add(handler as (payload: unknown) => void)
    this.handlers.set(type, set)
    return () => {
      set.delete(handler as (payload: unknown) => void)
    }
  }

  resubscribe(): void {
    this.resubscribeCount++
  }

  emit(type: ChatCenterEventType, payload: unknown): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler(payload)
  }

  handlerCount(): number {
    let total = 0
    for (const set of this.handlers.values()) total += set.size
    return total
  }

  count(type: ChatCommandType): number {
    return this.calls.filter((c) => c.type === type).length
  }
}

function conv(sessionId: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    sessionId,
    cid: `${sessionId}@goofish`,
    peerUserName: `买家${sessionId}`,
    lastMessage: '你好',
    lastMessageTime: 1000,
    unreadCount: 0,
    sortIndex: 1,
    visible: true,
    ...extra,
  }
}

function msg(sessionId: string, id: string, content: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    messageId: id,
    sessionId,
    cid: `${sessionId}@goofish`,
    senderId: 'u1',
    senderName: '买家',
    receiverId: 'me',
    direction: 'in',
    kind: 'text',
    contentType: 1,
    content,
    createAt: 1000,
    source: 'history',
    ...extra,
  }
}

const OK_STATUS = { socketStatus: 'open', sessionCount: 2, messageCount: 5 }

function baseApi(): FakeApi {
  const api = new FakeApi()
  api.respond(CommandTypes.CHAT_STATUS, () => OK_STATUS)
  api.respond(CommandTypes.CHAT_LIST_CONVERSATIONS, () => ({ conversations: [conv('a'), conv('b')] }))
  api.respond(CommandTypes.CHAT_GET_MESSAGES, (p) => {
    const sessionId = (p as { sessionId: string }).sessionId
    return { messages: [msg(sessionId, `${sessionId}-1`, `来自${sessionId}的消息`)] }
  })
  api.respond(CommandTypes.CHAT_MARK_READ, () => ({ ok: true }))
  return api
}

function make(api: FakeApi | null): ChatCenterController {
  return new ChatCenterController({ api, debounceMs: 0 })
}

/** 等待若干宏任务，让 mock 的 Promise 与 debounce 定时器全部落地。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15))

// ---------------- 用例 ----------------

test('非扩展环境：状态为 unavailable，不发起任何请求，也不展示数据', async () => {
  const controller = make(null)
  controller.start()
  await settle()
  const state = controller.getState()
  assert.equal(state.availability, 'unavailable')
  assert.equal(state.conversations.items.length, 0)
  assert.equal(state.conversations.phase, 'idle')
  // 不可用时的所有操作都应是安全的空操作。
  controller.selectSession('a')
  await controller.syncConversations()
  await controller.refresh()
  assert.equal(controller.getState().selectedId, null)
})

test('start：自动读取本地缓存的状态与会话列表，且不触发任何平台同步', async () => {
  const api = baseApi()
  const controller = make(api)
  controller.start()
  assert.equal(controller.getState().conversations.phase, 'loading')
  await settle()
  const state = controller.getState()
  assert.equal(state.status.phase, 'ready')
  assert.deepEqual(state.status.data, OK_STATUS)
  assert.equal(state.socketStatus, 'open')
  assert.equal(state.conversations.phase, 'ready')
  assert.deepEqual(state.conversations.items.map((c) => c.sessionId), ['a', 'b'])
  assert.equal(api.count(CommandTypes.CHAT_SYNC_CONVERSATIONS), 0)
  assert.equal(api.count(CommandTypes.CHAT_SYNC_HISTORY), 0)
  controller.dispose()
})

test('start 幂等：重复调用不会重复订阅；刷新只重新查询、不新增订阅', async () => {
  const api = baseApi()
  const controller = make(api)
  controller.start()
  controller.start()
  await settle()
  assert.equal(api.handlerCount(), CHAT_CENTER_EVENTS.length)
  for (const type of CHAT_CENTER_EVENTS) assert.equal(api.handlers.get(type)?.size, 1)

  await controller.refresh()
  await controller.refresh()
  assert.equal(api.handlerCount(), CHAT_CENTER_EVENTS.length)
  assert.ok(api.count(CommandTypes.CHAT_LIST_CONVERSATIONS) >= 3)
  controller.dispose()
})

test('空列表：phase=ready 且 items 为空（界面据此显示空状态，而非伪造会话）', async () => {
  const api = baseApi()
  api.respond(CommandTypes.CHAT_LIST_CONVERSATIONS, () => ({ conversations: [] }))
  const controller = make(api)
  controller.start()
  await settle()
  assert.equal(controller.getState().conversations.phase, 'ready')
  assert.deepEqual(controller.getState().conversations.items, [])
  controller.dispose()
})

test('列表读取失败：进入 error 状态并保留错误文案；重试成功后恢复', async () => {
  const api = baseApi()
  let fail = true
  api.respond(CommandTypes.CHAT_LIST_CONVERSATIONS, () => {
    if (fail) throw new Error('chat 未接线')
    return { conversations: [conv('a')] }
  })
  const controller = make(api)
  controller.start()
  await settle()
  assert.equal(controller.getState().conversations.phase, 'error')
  assert.match(controller.getState().conversations.error ?? '', /chat 未接线/)

  fail = false
  await controller.refresh()
  assert.equal(controller.getState().conversations.phase, 'ready')
  assert.equal(controller.getState().conversations.error, null)
  controller.dispose()
})

test('返回结构非法：按错误处理，不把脏数据当作会话', async () => {
  const api = baseApi()
  api.respond(CommandTypes.CHAT_LIST_CONVERSATIONS, () => ({ conversations: [{ nope: 1 }] }))
  api.respond(CommandTypes.CHAT_STATUS, () => ({ socketStatus: 'weird' }))
  const controller = make(api)
  controller.start()
  await settle()
  assert.equal(controller.getState().conversations.phase, 'error')
  assert.equal(controller.getState().conversations.items.length, 0)
  assert.equal(controller.getState().status.phase, 'error')
  controller.dispose()
})

test('已有数据时刷新失败：保留旧列表并附带错误，不清空界面', async () => {
  const api = baseApi()
  const controller = make(api)
  controller.start()
  await settle()
  api.respond(CommandTypes.CHAT_LIST_CONVERSATIONS, () => {
    throw new Error('临时失败')
  })
  await controller.refresh()
  const state = controller.getState().conversations
  assert.equal(state.phase, 'ready')
  assert.equal(state.items.length, 2)
  assert.match(state.error ?? '', /临时失败/)
  controller.dispose()
})

test('选择会话：按 asc 读取其本地缓存消息', async () => {
  const api = baseApi()
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  assert.equal(controller.getState().messages.phase, 'loading')
  await settle()
  const state = controller.getState()
  assert.equal(state.messages.sessionId, 'a')
  assert.equal(state.messages.phase, 'ready')
  assert.deepEqual(state.messages.items.map((m) => m.content), ['来自a的消息'])
  const call = api.calls.find((c) => c.type === CommandTypes.CHAT_GET_MESSAGES)
  assert.deepEqual(call?.payload, { sessionId: 'a', order: 'asc' })
  controller.dispose()
})

test('竞态：快速切换会话，先发出的旧会话响应后返回时不得覆盖新会话', async () => {
  const api = baseApi()
  const slowA = defer<unknown>()
  api.respond(CommandTypes.CHAT_GET_MESSAGES, (p) => {
    const sessionId = (p as { sessionId: string }).sessionId
    if (sessionId === 'a') return slowA.promise
    return { messages: [msg('b', 'b-1', '来自b的消息')] }
  })
  const controller = make(api)
  controller.start()
  await settle()

  controller.selectSession('a')
  controller.selectSession('b')
  await settle()
  assert.equal(controller.getState().messages.sessionId, 'b')

  // 旧会话 A 的响应此时才返回。
  slowA.resolve({ messages: [msg('a', 'a-1', '来自a的消息')] })
  await settle()
  const state = controller.getState()
  assert.equal(state.selectedId, 'b')
  assert.equal(state.messages.sessionId, 'b')
  assert.deepEqual(state.messages.items.map((m) => m.content), ['来自b的消息'])
  controller.dispose()
})

test('竞态：旧会话的失败响应同样不会污染新会话', async () => {
  const api = baseApi()
  const slowA = defer<unknown>()
  api.respond(CommandTypes.CHAT_GET_MESSAGES, (p) => {
    if ((p as { sessionId: string }).sessionId === 'a') return slowA.promise
    return { messages: [msg('b', 'b-1', 'ok')] }
  })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  controller.selectSession('b')
  await settle()
  slowA.reject(new Error('A 超时'))
  await settle()
  assert.equal(controller.getState().messages.phase, 'ready')
  assert.equal(controller.getState().messages.error, null)
  controller.dispose()
})

test('消息读取失败：显示错误，retryMessages 可恢复', async () => {
  const api = baseApi()
  let fail = true
  api.respond(CommandTypes.CHAT_GET_MESSAGES, () => {
    if (fail) throw new Error('读取失败')
    return { messages: [msg('a', 'a-1', '恢复了')] }
  })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  assert.equal(controller.getState().messages.phase, 'error')
  fail = false
  await controller.retryMessages()
  assert.equal(controller.getState().messages.phase, 'ready')
  assert.equal(controller.getState().messages.items[0].content, '恢复了')
  controller.dispose()
})

test('同步会话：result.ok=false 必须显示失败，而不是当作成功', async () => {
  const api = baseApi()
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => ({
    ok: false,
    added: 0,
    updated: 0,
    error: { code: 'HOST_UNAVAILABLE', message: '请先打开闲鱼页面' },
  }))
  const controller = make(api)
  controller.start()
  await settle()
  await controller.syncConversations()
  const sync = controller.getState().conversationSync
  assert.equal(sync.phase, 'failed')
  assert.match(sync.error ?? '', /HOST_UNAVAILABLE/)
  assert.match(sync.error ?? '', /请先打开闲鱼页面/)
  controller.dispose()
})

test('同步会话：命令抛错（超时 / 传输失败）同样显示失败', async () => {
  const api = baseApi()
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => {
    throw new Error('命令超时')
  })
  const controller = make(api)
  controller.start()
  await settle()
  await controller.syncConversations()
  assert.equal(controller.getState().conversationSync.phase, 'failed')
  assert.match(controller.getState().conversationSync.error ?? '', /命令超时/)
  controller.dispose()
})

test('同步会话：成功后记录新增/更新数量并重新读取本地缓存', async () => {
  const api = baseApi()
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => ({ ok: true, added: 3, updated: 1 }))
  const controller = make(api)
  controller.start()
  await settle()
  const before = api.count(CommandTypes.CHAT_LIST_CONVERSATIONS)
  await controller.syncConversations()
  await settle()
  const sync = controller.getState().conversationSync
  assert.equal(sync.phase, 'ok')
  assert.equal(sync.added, 3)
  assert.equal(sync.updated, 1)
  assert.ok(api.count(CommandTypes.CHAT_LIST_CONVERSATIONS) > before)
  controller.dispose()
})

test('syncRecent 显式同步平台会话与选中会话历史，且并发触发只执行一轮', async () => {
  const api = baseApi()
  const conversations = defer<unknown>()
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => conversations.promise)
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => ({ ok: true, added: 2, updated: 0 }))
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  const beforeList = api.count(CommandTypes.CHAT_LIST_CONVERSATIONS)
  const beforeMessages = api.count(CommandTypes.CHAT_GET_MESSAGES)
  const first = controller.syncRecent()
  const second = controller.syncRecent()
  assert.equal(api.count(CommandTypes.CHAT_SYNC_CONVERSATIONS), 1)
  conversations.resolve({ ok: true, added: 1, updated: 0 })
  await Promise.all([first, second])
  assert.equal(api.count(CommandTypes.CHAT_SYNC_HISTORY), 1)
  assert.ok(api.count(CommandTypes.CHAT_LIST_CONVERSATIONS) > beforeList)
  assert.ok(api.count(CommandTypes.CHAT_GET_MESSAGES) > beforeMessages)
  controller.dispose()
})

test('syncRecent：切换会话后不为旧会话同步历史', async () => {
  const api = baseApi()
  const conversations = defer<unknown>()
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => conversations.promise)
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  const syncing = controller.syncRecent()
  controller.selectSession('b')
  conversations.resolve({ ok: true, added: 0, updated: 0 })
  await syncing
  assert.equal(api.count(CommandTypes.CHAT_SYNC_HISTORY), 0)
  controller.dispose()
})

test('同步进行中重复触发会被忽略（不重复拉取平台数据）', async () => {
  const api = baseApi()
  const pending = defer<unknown>()
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => pending.promise)
  const controller = make(api)
  controller.start()
  await settle()
  const first = controller.syncConversations()
  void controller.syncConversations()
  assert.equal(controller.getState().conversationSync.phase, 'running')
  assert.equal(api.count(CommandTypes.CHAT_SYNC_CONVERSATIONS), 1)
  pending.resolve({ ok: true, added: 0, updated: 0 })
  await first
  controller.dispose()
})

test('同步结构非法：按失败处理', async () => {
  const api = baseApi()
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => ({ hello: 'world' }))
  const controller = make(api)
  controller.start()
  await settle()
  await controller.syncConversations()
  assert.equal(controller.getState().conversationSync.phase, 'failed')
  controller.dispose()
})

test('同步历史：携带 sessionId，失败结果归属于该会话，切会话后不串号', async () => {
  const api = baseApi()
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => ({
    ok: false,
    added: 0,
    updated: 0,
    error: { code: 'TIMEOUT', message: 'LWP 超时' },
  }))
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  await controller.syncHistory()
  const call = api.calls.find((c) => c.type === CommandTypes.CHAT_SYNC_HISTORY)
  assert.deepEqual(call?.payload, { sessionId: 'a' })
  const sync = controller.getState().historySync
  assert.equal(sync.phase, 'failed')
  assert.equal(sync.sessionId, 'a')
  assert.match(sync.error ?? '', /LWP 超时/)
  controller.dispose()
})

test('同步历史期间切换会话：不会为旧会话重读消息，也不会覆盖新会话', async () => {
  const api = baseApi()
  const pending = defer<unknown>()
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => pending.promise)
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  const syncing = controller.syncHistory()
  controller.selectSession('b')
  await settle()
  const getBefore = api.calls.filter(
    (c) => c.type === CommandTypes.CHAT_GET_MESSAGES && (c.payload as { sessionId: string }).sessionId === 'a',
  ).length

  // 同一时刻只允许一个历史同步：完成前为会话 b 再发起会被忽略。
  await controller.syncHistory()
  assert.equal(api.count(CommandTypes.CHAT_SYNC_HISTORY), 1)

  pending.resolve({ ok: true, added: 2, updated: 0 })
  await syncing
  await settle()
  const getAfter = api.calls.filter(
    (c) => c.type === CommandTypes.CHAT_GET_MESSAGES && (c.payload as { sessionId: string }).sessionId === 'a',
  ).length
  assert.equal(getAfter, getBefore)
  assert.equal(controller.getState().messages.sessionId, 'b')
  assert.equal(controller.getState().historySync.sessionId, 'a')
  controller.dispose()
})

test('实时事件：只作为信号触发重新读 store，状态中不出现事件携带的任何内容', async () => {
  const api = baseApi()
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()

  const listBefore = api.count(CommandTypes.CHAT_LIST_CONVERSATIONS)
  const getBefore = api.count(CommandTypes.CHAT_GET_MESSAGES)
  api.respond(CommandTypes.CHAT_GET_MESSAGES, () => ({ messages: [msg('a', 'a-1', 'store 中的新消息')] }))

  // 恶意/意外携带正文的事件负载：控制器不得读取或保存它。
  api.emit(EventTypes.CHAT_MESSAGE_INGESTED, { added: 1, updated: 0, content: '机密正文-不应出现' })
  api.emit(EventTypes.CHAT_MESSAGE_INGESTED, { added: 1, updated: 0 })
  await settle()

  assert.equal(api.count(CommandTypes.CHAT_LIST_CONVERSATIONS), listBefore + 1, '多次事件应被合并为一次重读')
  assert.equal(api.count(CommandTypes.CHAT_GET_MESSAGES), getBefore + 1)
  const state = controller.getState()
  assert.deepEqual(state.messages.items.map((m) => m.content), ['store 中的新消息'])
  assert.equal(JSON.stringify(state).includes('机密正文'), false)
  // 事件不会触发平台同步。
  assert.equal(api.count(CommandTypes.CHAT_SYNC_CONVERSATIONS), 0)
  assert.equal(api.count(CommandTypes.CHAT_SYNC_HISTORY), 0)
  controller.dispose()
})

test('CHAT_SYNC_COMPLETED / CHAT_CONVERSATION_UPDATED / WORKER_STARTED 都会重新读取本地缓存', async () => {
  const api = baseApi()
  const controller = make(api)
  controller.start()
  await settle()
  for (const type of [
    EventTypes.CHAT_SYNC_COMPLETED,
    EventTypes.CHAT_CONVERSATION_UPDATED,
    EventTypes.WORKER_STARTED,
  ] as const) {
    const before = api.count(CommandTypes.CHAT_LIST_CONVERSATIONS)
    api.emit(type, {})
    await settle()
    assert.equal(api.count(CommandTypes.CHAT_LIST_CONVERSATIONS), before + 1, `${type} 应触发重读`)
  }
  controller.dispose()
})

test('CHAT_SOCKET_STATUS：更新连接状态，非法值被忽略；较晚返回的旧 STATUS 不覆盖事件', async () => {
  const api = baseApi()
  const slowStatus = defer<unknown>()
  let first = true
  api.respond(CommandTypes.CHAT_STATUS, () => {
    if (first) {
      first = false
      return slowStatus.promise
    }
    return OK_STATUS
  })
  const controller = make(api)
  controller.start()
  await settle()

  api.emit(EventTypes.CHAT_SOCKET_STATUS, { status: 'closed' })
  assert.equal(controller.getState().socketStatus, 'closed')
  api.emit(EventTypes.CHAT_SOCKET_STATUS, { status: 'bogus' })
  assert.equal(controller.getState().socketStatus, 'closed')

  slowStatus.resolve({ socketStatus: 'connecting', sessionCount: 0, messageCount: 0 })
  await settle()
  assert.equal(controller.getState().socketStatus, 'closed')
  controller.dispose()
})

test('dispose：释放全部订阅；之后的事件与在途响应都不再改变状态', async () => {
  const api = baseApi()
  const slowList = defer<unknown>()
  api.respond(CommandTypes.CHAT_LIST_CONVERSATIONS, () => slowList.promise)
  const controller = make(api)
  let notified = 0
  controller.subscribe(() => notified++)
  controller.start()
  await settle()
  const captured = [...(api.handlers.get(EventTypes.CHAT_MESSAGE_INGESTED) ?? [])]
  assert.equal(api.handlerCount(), CHAT_CENTER_EVENTS.length)

  // 已排队的防抖刷新在 dispose 后也必须被取消。
  api.emit(EventTypes.CHAT_MESSAGE_INGESTED, {})
  controller.dispose()
  assert.equal(api.handlerCount(), 0)

  const callsAfterDispose = api.calls.length
  const notifiedAfterDispose = notified
  for (const handler of captured) handler({})
  slowList.resolve({ conversations: [conv('late')] })
  await settle()

  assert.equal(api.calls.length, callsAfterDispose, '释放后不应再发起请求')
  assert.equal(notified, notifiedAfterDispose, '释放后不应再通知界面')
  assert.equal(controller.getState().conversations.items.length, 0)
  // 重复 dispose 安全。
  controller.dispose()
})

test('实时订阅失败：给出说明但页面仍可手动刷新', async () => {
  const api = baseApi()
  api.onThrows = true
  const controller = make(api)
  controller.start()
  await settle()
  assert.match(controller.getState().realtimeError ?? '', /实时更新不可用/)
  assert.equal(controller.getState().conversations.phase, 'ready')
  controller.dispose()
})

test('resubscribe：委托给 Bridge 重新声明订阅，不新增监听', async () => {
  const api = baseApi()
  const controller = make(api)
  controller.start()
  await settle()
  controller.resubscribe()
  assert.equal(api.resubscribeCount, 1)
  assert.equal(api.handlerCount(), CHAT_CENTER_EVENTS.length)
  controller.dispose()
  controller.resubscribe()
  assert.equal(api.resubscribeCount, 1)
})

test('选择会话后先同步最近历史再请求已读；只在成功后刷新未读状态', async () => {
  const api = baseApi()
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => ({ ok: true, added: 1, updated: 0 }))
  api.respond(CommandTypes.CHAT_MARK_READ, () => ({ ok: true }))
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  assert.equal(api.count(CommandTypes.CHAT_MARK_READ), 1)
  assert.deepEqual(api.calls.find((call) => call.type === CommandTypes.CHAT_MARK_READ)?.payload, { sessionId: 'a' })
  controller.dispose()
})

test('缓存无历史时仍触发后台已读（由后台补同步最近一页），不因页面消息为空而永远未读', async () => {
  const api = baseApi()
  api.respond(CommandTypes.CHAT_GET_MESSAGES, () => ({ messages: [] }))
  api.respond(CommandTypes.CHAT_MARK_READ, () => ({ ok: true }))
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  assert.equal(api.count(CommandTypes.CHAT_MARK_READ), 1, '即使本地无消息也应请求后台已读')
  assert.deepEqual(api.calls.find((call) => call.type === CommandTypes.CHAT_MARK_READ)?.payload, { sessionId: 'a' })
  controller.dispose()
})

test('打开当前会话后请求已读一次，失败显示提示且切换后的旧响应不改状态', async () => {
  const api = baseApi()
  const read = defer<unknown>()
  let readCalls = 0
  // A 的已读延迟到切到 B 之后再结算；B 自身的已读立即成功。
  api.respond(CommandTypes.CHAT_MARK_READ, () => {
    readCalls += 1
    return readCalls === 1 ? read.promise : { ok: true }
  })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  assert.equal(api.count(CommandTypes.CHAT_MARK_READ), 1)
  assert.deepEqual(api.calls.find((call) => call.type === CommandTypes.CHAT_MARK_READ)?.payload, { sessionId: 'a' })
  controller.selectSession('b')
  assert.equal(controller.getState().markReadError, null, '切换会话应立即清除旧错误状态')
  await settle()
  // A settle 后为 B 补一次已读（A 的失败不得污染 B）。
  read.resolve({ ok: false, error: { message: '平台拒绝' } })
  await settle()
  assert.equal(controller.getState().markReadError, null, '旧会话响应不得覆盖新会话状态')
  assert.equal(api.count(CommandTypes.CHAT_MARK_READ), 2, 'A settle 后应为 B 补一次已读')
  assert.deepEqual(
    api.calls.filter((call) => call.type === CommandTypes.CHAT_MARK_READ).map((call) => call.payload),
    [{ sessionId: 'a' }, { sessionId: 'b' }],
  )
  controller.dispose()
})

test('CHAT_MARK_READ 失败保留可见错误', async () => {
  const api = baseApi()
  api.respond(CommandTypes.CHAT_MARK_READ, () => ({ ok: false, error: { message: '平台拒绝' } }))
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  assert.match(controller.getState().markReadError ?? '', /平台拒绝/)
  controller.dispose()
})

test('已读命令只在选中会话打开时触发，不因内部缓存刷新重复调用', async () => {
  const api = baseApi()
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  await controller.refresh()
  await settle()
  assert.equal(api.count(CommandTypes.CHAT_MARK_READ), 1)
  controller.dispose()
})

test('只读保证：交互仅调用只读命令与受控 CHAT_MARK_READ', async () => {
  const api = baseApi()
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => ({ ok: true, added: 0, updated: 0 }))
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => ({ ok: true, added: 0, updated: 0 }))
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  await controller.syncConversations()
  await controller.syncHistory()
  await controller.refresh()
  const allowed = new Set<string>([
    CommandTypes.CHAT_STATUS,
    CommandTypes.CHAT_LIST_CONVERSATIONS,
    CommandTypes.CHAT_GET_MESSAGES,
    CommandTypes.CHAT_SYNC_CONVERSATIONS,
    CommandTypes.CHAT_SYNC_HISTORY,
    CommandTypes.CHAT_MARK_READ,
  ])
  for (const call of api.calls) assert.ok(allowed.has(call.type), `不应调用 ${call.type}`)
  controller.dispose()
})

// ---------------- 已读单飞：settle 后对最新选中会话 / 新水位补一次 ----------------

test('已读单飞：A 在途时选 B，A settle 后无需再点击自动为 B 补一次已读', async () => {
  const api = baseApi()
  const readA = defer<unknown>()
  let readCalls = 0
  api.respond(CommandTypes.CHAT_MARK_READ, () => {
    readCalls += 1
    return readCalls === 1 ? readA.promise : { ok: true }
  })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  assert.equal(api.count(CommandTypes.CHAT_MARK_READ), 1, 'A 首次应发起一次已读')

  controller.selectSession('b')
  await settle()
  assert.equal(api.count(CommandTypes.CHAT_MARK_READ), 1, 'A 在途时 B 不得并发发起')

  readA.resolve({ ok: true })
  await settle()
  assert.equal(api.count(CommandTypes.CHAT_MARK_READ), 2, 'A settle 后应自动为 B 补一次已读，不依赖用户再点')
  assert.deepEqual(
    api.calls.filter((call) => call.type === CommandTypes.CHAT_MARK_READ).map((call) => call.payload),
    [{ sessionId: 'a' }, { sessionId: 'b' }],
  )
  controller.dispose()
})

test('已读单飞：dispose 后 A settle 不再补 B 请求', async () => {
  const api = baseApi()
  const readA = defer<unknown>()
  let readCalls = 0
  api.respond(CommandTypes.CHAT_MARK_READ, () => {
    readCalls += 1
    return readCalls === 1 ? readA.promise : { ok: true }
  })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  controller.selectSession('b')
  await settle()
  assert.equal(api.count(CommandTypes.CHAT_MARK_READ), 1)

  controller.dispose()
  readA.resolve({ ok: true })
  await settle()
  assert.equal(api.count(CommandTypes.CHAT_MARK_READ), 1, 'dispose 后不得再补发请求')
})

test('已读单飞：ACK 期间同会话出现新水位，settle 后按新水位补一次', async () => {
  const api = baseApi()
  const readA = defer<unknown>()
  let readCalls = 0
  api.respond(CommandTypes.CHAT_MARK_READ, () => {
    readCalls += 1
    return readCalls === 1 ? readA.promise : { ok: true }
  })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  assert.equal(api.count(CommandTypes.CHAT_MARK_READ), 1)

  // ACK 未返回期间：同会话新入站消息入库，触发事件→重读消息→出现新水位。
  api.respond(CommandTypes.CHAT_GET_MESSAGES, (payload) => ({
    messages: [msg((payload as { sessionId: string }).sessionId, 'a-2', '新消息')],
  }))
  api.emit(EventTypes.CHAT_MESSAGE_INGESTED, { kind: 'message', added: 1, updated: 0 })
  await settle()
  assert.equal(api.count(CommandTypes.CHAT_MARK_READ), 1, 'A 在途时不得并发发起')

  readA.resolve({ ok: true })
  await settle()
  assert.equal(api.count(CommandTypes.CHAT_MARK_READ), 2, '同会话新水位应在 settle 后补一次')
  controller.dispose()
})
