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
  MESSAGE_PAGE_SIZE,
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

test('选择会话：只读取最近 10 条本地缓存（desc + limit）并升序展示', async () => {
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
  assert.deepEqual(call?.payload, { sessionId: 'a', order: 'desc', limit: MESSAGE_PAGE_SIZE })
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

// ---------------- 历史分页：首次 10 条 / 连续向前 10 条 / 同刻边界 / 耗尽 / 失败 / 竞态 / 释放 ----------------

/** 与扩展侧一致的稳定排序（createAt → messageId → id），用于模拟本地分页语义。 */
function cmp(a: ChatMessage, b: ChatMessage): number {
  if (a.createAt !== b.createAt) return a.createAt - b.createAt
  if (a.messageId !== b.messageId) return a.messageId < b.messageId ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 造一批本地缓存消息；groupSize>1 时若干条共享同一 createAt，用于覆盖同刻边界。 */
function buildPool(sessionId: string, count: number, groupSize = 1): ChatMessage[] {
  return Array.from({ length: count }, (_, index) =>
    msg(sessionId, `${sessionId}-${String(index + 1).padStart(3, '0')}`, `消息${index + 1}`, {
      createAt: 1000 + Math.floor(index / groupSize),
    }),
  )
}

/** 用消息池实现 CHAT_GET_MESSAGES 的分页语义（与扩展侧 getMessagePage 保持一致）。 */
function poolResponder(pools: Record<string, ChatMessage[]>) {
  return (payload: unknown): unknown => {
    const { sessionId, order, limit, before } = payload as {
      sessionId: string
      order?: string
      limit?: number
      before?: { createAt: number; messageId: string; id: string }
    }
    let list = [...(pools[sessionId] ?? [])].sort(cmp)
    if (before) list = list.filter((message) => cmp(message, before as ChatMessage) < 0)
    let hasMore = false
    if (limit !== undefined) {
      hasMore = list.length > limit
      list = list.slice(Math.max(0, list.length - limit))
    }
    if (order === 'desc') list = [...list].reverse()
    return limit === undefined ? { messages: list } : { messages: list, hasMore }
  }
}

function pagingApi(pools: Record<string, ChatMessage[]>): FakeApi {
  const api = baseApi()
  api.respond(CommandTypes.CHAT_GET_MESSAGES, poolResponder(pools))
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => ({ ok: true, added: 0, updated: 0, hasMore: false }))
  return api
}

test('打开会话：只取最近 10 条（desc + limit）并按升序展示，hasMore 表示本地还有更早', async () => {
  const api = pagingApi({ a: buildPool('a', 25) })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  const messages = controller.getState().messages
  assert.equal(messages.phase, 'ready')
  assert.equal(messages.items.length, MESSAGE_PAGE_SIZE)
  assert.deepEqual(
    messages.items.map((m) => m.content),
    Array.from({ length: 10 }, (_, i) => `消息${i + 16}`),
  )
  assert.equal(messages.hasMore, true)
  const first = api.calls.find((c) => c.type === CommandTypes.CHAT_GET_MESSAGES)
  assert.deepEqual(first?.payload, { sessionId: 'a', order: 'desc', limit: MESSAGE_PAGE_SIZE })
  controller.dispose()
})

test('向前翻页：连续 loadOlder 每次前插 10 条、不重复、顺序稳定', async () => {
  const api = pagingApi({ a: buildPool('a', 25) })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  await controller.loadOlder()
  assert.equal(controller.getState().messages.items.length, 20)
  await controller.loadOlder()
  const items = controller.getState().messages.items
  assert.equal(items.length, 25)
  assert.equal(new Set(items.map((m) => m.id)).size, 25, '前插不得重复')
  assert.deepEqual(items.map((m) => m.content), Array.from({ length: 25 }, (_, i) => `消息${i + 1}`))
  controller.dispose()
})

test('同一 timestamp 分组：before 游标带 messageId 排序，不漏同刻消息也不重复', async () => {
  const api = pagingApi({ a: buildPool('a', 25, 5) })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  await controller.loadOlder()
  await controller.loadOlder()
  const items = controller.getState().messages.items
  assert.equal(items.length, 25)
  assert.deepEqual(items.map((m) => m.content), Array.from({ length: 25 }, (_, i) => `消息${i + 1}`))
  controller.dispose()
})

test('耗尽：本地与平台都无更多后 hasMore=false，再调用 loadOlder 不再发请求', async () => {
  const api = pagingApi({ a: buildPool('a', 25) })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  await controller.loadOlder()
  await controller.loadOlder()
  const messages = controller.getState().messages
  assert.equal(messages.items.length, 25)
  assert.equal(messages.hasMore, false)
  assert.equal(messages.olderPhase, 'idle')
  const before = api.calls.length
  await controller.loadOlder()
  assert.equal(api.calls.length, before, '已确认耗尽不得再请求')
  controller.dispose()
})

test('单飞：loadOlder 在途时重复触发只产生一次本地分页请求', async () => {
  const api = pagingApi({ a: buildPool('a', 25) })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  const before = api.count(CommandTypes.CHAT_GET_MESSAGES)
  await Promise.all([controller.loadOlder(), controller.loadOlder(), controller.loadOlder()])
  assert.equal(api.count(CommandTypes.CHAT_GET_MESSAGES), before + 1)
  controller.dispose()
})

test('本地耗尽但平台仍有更早历史：同步一页后继续前插，耗尽后才提示没有更多', async () => {
  const pool = buildPool('a', 15)
  const older = Array.from({ length: 5 }, (_, i) =>
    msg('a', `a-old-${i + 1}`, `更早${i + 1}`, { createAt: 100 + i }),
  )
  const api = pagingApi({ a: pool })
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => {
    // 模拟扩展把平台更早的一页写入本地缓存，供后续本地游标读到。
    pool.unshift(...older)
    return { ok: true, added: older.length, updated: 0, hasMore: false }
  })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  await controller.loadOlder()
  const messages = controller.getState().messages
  assert.equal(messages.items.length, 20, '本地耗尽后应继续按平台同步补更早历史')
  assert.equal(messages.items[0]?.content, '更早1')
  assert.equal(messages.hasMore, false)
  const syncCall = api.calls.find((c) => c.type === CommandTypes.CHAT_SYNC_HISTORY)
  assert.deepEqual(syncCall?.payload, { sessionId: 'a', pages: 1, count: MESSAGE_PAGE_SIZE })
  controller.dispose()
})

test('服务端游标只成功推进：每次 loadOlder 最多补一页，下一页携带上一跳返回的 nextCursor', async () => {
  const pool = buildPool('a', 15)
  const olderA = Array.from({ length: 5 }, (_, i) => msg('a', `a-old-${i + 1}`, `更早${i + 1}`, { createAt: 100 + i }))
  const olderB = Array.from({ length: 5 }, (_, i) => msg('a', `a-older-${i + 1}`, `最旧${i + 1}`, { createAt: 50 + i }))
  const api = pagingApi({ a: pool })
  let hop = 0
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => {
    hop += 1
    if (hop === 1) {
      pool.unshift(...olderA)
      return { ok: true, added: olderA.length, updated: 0, hasMore: true, nextCursor: 7 }
    }
    pool.unshift(...olderB)
    return { ok: true, added: olderB.length, updated: 0, hasMore: false }
  })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()

  // 第一次：本地 5 条 + 平台一跳 5 条 = 10 条，恰好一页；平台仍有更早，不得宣称耗尽。
  await controller.loadOlder()
  let messages = controller.getState().messages
  assert.equal(messages.items.length, 20, '单次 loadOlder 最多新增一页 10 条')
  assert.equal(messages.items[0]?.content, '更早1')
  assert.equal(messages.hasMore, true, '平台仍有更早历史时不得宣称耗尽')

  // 第二次：用上一跳返回的游标继续，再补一页 10 条。
  await controller.loadOlder()
  messages = controller.getState().messages
  assert.equal(messages.items.length, 25)
  assert.equal(messages.items[0]?.content, '最旧1')
  assert.equal(messages.hasMore, false)
  assert.deepEqual(
    api.calls.filter((c) => c.type === CommandTypes.CHAT_SYNC_HISTORY).map((c) => c.payload),
    [
      { sessionId: 'a', pages: 1, count: MESSAGE_PAGE_SIZE },
      { sessionId: 'a', pages: 1, count: MESSAGE_PAGE_SIZE, cursor: 7 },
    ],
  )
  controller.dispose()
})

test('平台同步失败：保留已加载消息、标记 error，重试成功后恢复', async () => {
  const api = pagingApi({ a: buildPool('a', 15) })
  let fail = true
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => {
    if (fail) throw new Error('平台超时')
    return { ok: true, added: 0, updated: 0, hasMore: false }
  })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  await controller.loadOlder()
  let messages = controller.getState().messages
  assert.equal(messages.olderPhase, 'error')
  assert.match(messages.olderError ?? '', /平台超时/)
  assert.equal(messages.items.length, 15, '失败必须保留已加载消息')

  fail = false
  await controller.loadOlder()
  messages = controller.getState().messages
  assert.equal(messages.olderPhase, 'idle')
  assert.equal(messages.olderError, null)
  assert.equal(messages.items.length, 15, '重试不得重复插入')
  controller.dispose()
})

test('竞态：loadOlder 在途时切换会话，旧会话的分页结果不污染新会话', async () => {
  const api = pagingApi({ a: buildPool('a', 15), b: buildPool('b', 3) })
  const slowSync = defer<unknown>()
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => slowSync.promise)
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  const pending = controller.loadOlder()
  await settle()
  controller.selectSession('b')
  await settle()
  slowSync.resolve({ ok: true, added: 0, updated: 0, hasMore: false })
  await pending
  const messages = controller.getState().messages
  assert.equal(messages.sessionId, 'b')
  assert.ok(messages.items.every((m) => m.sessionId === 'b'))
  controller.dispose()
})

test('dispose：loadOlder 在途返回后不再写入状态', async () => {
  const api = pagingApi({ a: buildPool('a', 15) })
  const slowSync = defer<unknown>()
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => slowSync.promise)
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  const pending = controller.loadOlder()
  await settle()
  controller.dispose()
  slowSync.resolve({ ok: true, added: 0, updated: 0, hasMore: false })
  await pending
  // 本地分页请求已先返回并合并，此处断言在途平台同步未继续写入。
  assert.equal(controller.getState().messages.items.length, 15)
})

test('实时刷新：只取最近 10 条，但不缩回已展开窗口，并合并平台新消息', async () => {
  const pool = buildPool('a', 25)
  const api = pagingApi({ a: pool })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  await controller.loadOlder()
  assert.equal(controller.getState().messages.items.length, 20)

  api.respond(
    CommandTypes.CHAT_GET_MESSAGES,
    poolResponder({ a: [...pool, msg('a', 'a-999', '新消息', { createAt: 2000 })] }),
  )
  api.emit(EventTypes.CHAT_MESSAGE_INGESTED, { kind: 'message', added: 1, updated: 0 })
  await settle()
  const items = controller.getState().messages.items
  assert.equal(items.length, 21, '刷新不得把窗口缩回 10 条')
  assert.equal(items.at(-1)?.content, '新消息')
  assert.deepEqual(items.map((m) => m.content), [
    ...Array.from({ length: 20 }, (_, i) => `消息${i + 6}`),
    '新消息',
  ])
  controller.dispose()
})

// ---------------- 手动同步历史（refresh）在分页窗口下仍不缩水 ----------------

test('手动同步历史：同步成功后重读本地最近 10 条但不覆盖已展开窗口', async () => {
  const api = pagingApi({ a: buildPool('a', 25) })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  await controller.loadOlder()
  assert.equal(controller.getState().messages.items.length, 20)
  await controller.syncHistory()
  const items = controller.getState().messages.items
  assert.equal(items.length, 20, '同步历史不得让已展开的窗口缩回')
  assert.deepEqual(items.map((m) => m.content), Array.from({ length: 20 }, (_, i) => `消息${i + 6}`))
  controller.dispose()
})

test('加载到底后刷新不会重新开启 hasMore，之后翻页不再发请求', async () => {
  const api = pagingApi({ a: buildPool('a', 25) })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  await controller.loadOlder()
  await controller.loadOlder()
  assert.equal(controller.getState().messages.items.length, 25)
  assert.equal(controller.getState().messages.hasMore, false, '本地与平台都耗尽后 hasMore 必须为假')

  // 实时刷新只读最近 10 条；本地库仍比这一页多，但这不代表窗口最旧消息之前还有数据。
  api.emit(EventTypes.CHAT_MESSAGE_INGESTED, { kind: 'message', added: 1, updated: 0 })
  await settle()
  assert.equal(controller.getState().messages.items.length, 25, '刷新不得缩回窗口')
  assert.equal(controller.getState().messages.hasMore, false, '刷新不得重新开启 hasMore')

  const countBefore = api.calls.filter((c) => c.type === CommandTypes.CHAT_GET_MESSAGES).length
  await controller.loadOlder()
  const countAfter = api.calls.filter((c) => c.type === CommandTypes.CHAT_GET_MESSAGES).length
  assert.equal(countAfter, countBefore, '已确认耗尽后不得再发分页请求')
  controller.dispose()
})

test('单次 loadOlder 新增上限：本地不足时逐轮补同步，但一次最多前插一页 10 条', async () => {
  const pool = buildPool('a', 15)
  // 平台共有 20 条更早历史，按 5 条一批返回，模拟「平台明显还有多页」的情形。
  const platform = Array.from({ length: 20 }, (_, i) =>
    msg('a', `a-p-${String(i + 1).padStart(2, '0')}`, `平台${i + 1}`, { createAt: 100 + i }),
  )
  const api = pagingApi({ a: pool })
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, (payload) => {
    const cursor = (payload as { cursor?: number }).cursor
    const end = cursor ?? platform.length
    const start = Math.max(0, end - MESSAGE_PAGE_SIZE)
    const batch = platform.slice(start, end)
    for (const message of batch) if (!pool.some((existing) => existing.id === message.id)) pool.push(message)
    const hasMore = start > 0
    return { ok: true, added: batch.length, updated: 0, hasMore, ...(hasMore ? { nextCursor: start } : {}) }
  })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  assert.equal(controller.getState().messages.items.length, MESSAGE_PAGE_SIZE)

  await controller.loadOlder()
  const messages = controller.getState().messages
  assert.equal(messages.items.length, 20, '本地 15 条 + 平台一跳 5 条 = 一页 10 条，不得一次拉完平台全部 20 条')
  assert.equal(api.count(CommandTypes.CHAT_SYNC_HISTORY), 1, '本地不足只补一轮同步即达上限')
  assert.equal(new Set(messages.items.map((m) => m.id)).size, 20, '前插不得重复')
  assert.equal(messages.hasMore, true)
  controller.dispose()
})

test('并发实时 append：新增计数只算本次真正更早页，单次 loadOlder 仍前插满一页 10 条', async () => {
  // 本地 14 条 = 窗口最近 10 条（消息 5..14）+ 更早 4 条（消息 1..4）；平台另有 6 条更早，在同步时写入本地。
  const pool = buildPool('a', 14)
  const platform = Array.from({ length: 6 }, (_, i) =>
    msg('a', `a-p-${String(i + 1).padStart(2, '0')}`, `平台${i + 1}`, { createAt: 100 + i }),
  )
  const live = Array.from({ length: 6 }, (_, i) =>
    msg('a', `a-live-${String(i + 1).padStart(2, '0')}`, `实时${i + 1}`, { createAt: 2000 + i }),
  )
  const api = pagingApi({ a: pool })
  let controller!: ChatCenterController
  let injected = false
  const localPaging = poolResponder({ a: pool })
  api.respond(CommandTypes.CHAT_GET_MESSAGES, async (payload) => {
    // 只在带 before 的向前分页请求在途时注入实时消息：模拟分页与实时 append 并存。
    // 刷新走无 before 的请求，不重复注入。
    if (!injected && 'before' in (payload as Record<string, unknown>)) {
      injected = true
      pool.push(...live)
      await controller.refresh()
    }
    return localPaging(payload)
  })
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => {
    for (const message of platform) if (!pool.some((m) => m.id === message.id)) pool.push(message)
    return { ok: true, added: platform.length, updated: 0, hasMore: false }
  })
  controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  assert.equal(controller.getState().messages.items.length, MESSAGE_PAGE_SIZE)

  await controller.loadOlder()
  const messages = controller.getState().messages
  assert.equal(
    messages.items.length,
    MESSAGE_PAGE_SIZE * 2 + live.length,
    '窗口 = 原一页 + 一页更早 + 实时新消息，实时消息不得替代更早页',
  )
  // 最旧一条应是平台第 1 条（createAt 100），说明本地 4 条 + 平台 6 条更早已全部前插。
  assert.equal(messages.items[0]?.content, '平台1', '并发实时 append 不得虚增计数、导致本次少前插更早页')
  assert.equal(messages.hasMore, false)
  controller.dispose()
})

test('空缓存：窗口为空时 loadOlder 仍取最近一页（无 before），不被 hasMore=false 永久卡死', async () => {
  const pool: ChatMessage[] = []
  const api = pagingApi({ a: pool })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  assert.equal(controller.getState().messages.items.length, 0)

  // 第一步：空窗口先探明本地与平台都没有更早历史（无 before 查询 + 一轮同步），hasMore 转为 false。
  await controller.loadOlder()
  assert.equal(controller.getState().messages.items.length, 0)
  assert.equal(controller.getState().messages.hasMore, false, '平台确认耗尽后 hasMore 为假')

  // 第二步：后台把历史写入本地缓存（模拟其他入口补全缓存）。
  pool.push(...buildPool('a', 15))

  // 第三步：即使 hasMore=false 且窗口为空，loadOlder 仍必须发起一次无 before 的最近一页读取。
  await controller.loadOlder()
  const messages = controller.getState().messages
  assert.equal(messages.items.length, MESSAGE_PAGE_SIZE, '空窗口应取到最近一页 10 条')
  assert.equal(messages.hasMore, true)
  const pagingCalls = api.calls.filter((c) => c.type === CommandTypes.CHAT_GET_MESSAGES)
  assert.ok(pagingCalls.length >= 3, `选择会话 1 次 + loadOlder 至少 2 次，实际 ${pagingCalls.length}`)
  const lastPayload = pagingCalls.at(-1)?.payload as Record<string, unknown>
  assert.equal('before' in lastPayload, false, '空窗口没有边界游标，应无 before 查询最近一页')
  controller.dispose()
})

test('刷新保留分页失败态：不自动重试，只有显式重试才恢复', async () => {
  const api = pagingApi({ a: buildPool('a', 15) })
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => {
    throw new Error('平台超时')
  })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  await controller.loadOlder()
  assert.equal(controller.getState().messages.olderPhase, 'error')
  const syncBefore = api.count(CommandTypes.CHAT_SYNC_HISTORY)

  // 实时事件触发 refresh（重读最近一页）后，失败态与可重试性必须保留。
  api.emit(EventTypes.CHAT_MESSAGE_INGESTED, { kind: 'message', added: 1, updated: 0 })
  await settle()
  const messages = controller.getState().messages
  assert.equal(messages.olderPhase, 'error', 'refresh 不得清除分页失败态')
  assert.match(messages.olderError ?? '', /平台超时/)
  assert.equal(messages.hasMore, true, '失败后仍应可重试，不得宣称耗尽')
  assert.equal(api.count(CommandTypes.CHAT_SYNC_HISTORY), syncBefore, 'refresh 不得自动重试平台同步')

  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => ({ ok: true, added: 0, updated: 0, hasMore: false }))
  await controller.loadOlder()
  assert.equal(controller.getState().messages.olderPhase, 'idle', '显式重试成功后恢复')
  assert.equal(controller.getState().messages.olderError, null)
  controller.dispose()
})

test('平台游标无进展或反向：按失败处理，不得宣称耗尽或继续推进', async () => {
  const api = pagingApi({ a: buildPool('a', 15) })
  let hop = 0
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => {
    hop += 1
    // 第一跳给出有效游标；后续跳返回不前进（同值）或反向（更大）的非法游标。
    if (hop === 1) return { ok: true, added: 0, updated: 0, hasMore: true, nextCursor: 100 }
    return { ok: true, added: 0, updated: 0, hasMore: true, nextCursor: 100 }
  })
  const controller = make(api)
  controller.start()
  await settle()
  controller.selectSession('a')
  await settle()
  await controller.loadOlder()
  const stalled = controller.getState().messages
  assert.equal(stalled.olderPhase, 'error', '游标无进展必须按失败处理，而不是沉默耗尽')
  assert.equal(stalled.hasMore, true, '不得宣称没有更多')

  hop = 0
  api.respond(CommandTypes.CHAT_SYNC_HISTORY, () => {
    hop += 1
    if (hop === 1) return { ok: true, added: 0, updated: 0, hasMore: true, nextCursor: 100 }
    return { ok: true, added: 0, updated: 0, hasMore: true, nextCursor: 999 }
  })
  const second = make(api)
  second.start()
  await settle()
  second.selectSession('a')
  await settle()
  await second.loadOlder()
  assert.equal(second.getState().messages.olderPhase, 'error', '反向游标必须按失败处理')
  assert.match(second.getState().messages.olderError ?? '', /游标/)
  controller.dispose()
  second.dispose()
})

test('账号过滤或相同 sessionId 归属变化后清除旧选择与消息', async () => {
  for (const next of [[], [conv('a', { accountUserId: 'new' })]]) {
    const api = baseApi()
    api.respond(CommandTypes.CHAT_LIST_CONVERSATIONS, () => ({ conversations: [conv('a', { accountUserId: 'old' })] }))
    const controller = new ChatCenterController({ api })
    controller.start()
    await settle()
    controller.selectSession('a')
    await settle()
    assert.equal(controller.getState().selectedId, 'a')
    api.respond(CommandTypes.CHAT_LIST_CONVERSATIONS, () => ({ conversations: next }))
    await controller.refresh()
    assert.equal(controller.getState().selectedId, null)
    assert.deepEqual(controller.getState().messages.items, [])
    controller.dispose()
  }
})
