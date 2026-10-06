import { CommandTypes, EVENT_PORT_NAME, EventTypes, PROTOCOL_VERSION } from '@fishops/shared'

/** 仅供 workbench/test/direct-runtime.html 使用；所有数据均为内存 fixture。 */
declare global {
  interface Window {
    __FISHOPS_TEST_HARNESS__: {
      mode: 'local-memory-only'
      calls: Array<{ channel: string; type: string; request?: unknown }>
      prepareCount: number
      submitCount: number
      failNextPrepareFor: string | null
      returnUnknownFor: string | null
      jobs: Array<{ idempotencyKey: string; status: string; itemId: string; at: string }>
      emit: (type: string, payload: unknown) => void
    }
  }
}

const fixture = {
  source: 'my_published',
  itemId: 'TEST-ITEM-2048',
  title: '本地测试商品：手作帆布包',
  desc: '仅用于浏览器验证的本地商品数据。',
  price: '¥39',
  priceNumber: 39,
  originalPrice: '¥59',
  originalPriceNumber: 59,
  wantCnt: 12,
  coverUrl: '',
  detailUrl: '',
  images: [],
  sellerNick: '测试卖家',
  sellerCity: '杭州',
  freeShip: '是',
  tags: '',
  captureTimeMs: Date.now(),
}
/** 仅在专用验收 URL 启用图片 fixture，不访问外部图片或修改其他验收数据。 */
const previewProducts = new URLSearchParams(location.search).has('image-preview')
  ? [6, 26, 0, undefined, 2, 3].map((wantCnt, index) => ({
      ...fixture,
      itemId: `PREVIEW-${index}`,
      title: `图片预览验收 ${index}`,
      wantCnt,
      coverUrl: index === 3 ? '' : index === 4 ? '/test/missing-preview-image.png'
        : `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${index === 1 ? 120 : 320}" height="${index === 1 ? 320 : 120}"><rect width="100%" height="100%" fill="${index === 1 ? '#92c9d8' : '#f5c400'}"/></svg>`)}`,
    }))
  : null

const calls: Window['__FISHOPS_TEST_HARNESS__']['calls'] = []
let eventSeq = 0
const listeners = new Map<string, Set<(message: unknown) => void>>()
const ports: Array<{ onMessage: ListenerSet; onDisconnect: ListenerSet; subscribes: Set<string>; postMessage: (message: unknown) => void; disconnect: () => void; emit: (message: unknown) => void }> = []
type ListenerSet = { addListener: (listener: (message: unknown) => void) => void; removeListener: (listener: (message: unknown) => void) => void }
const listenerSet = (set: Set<(message: unknown) => void>): ListenerSet => ({
  addListener: (listener) => set.add(listener),
  removeListener: (listener) => set.delete(listener),
})
const jobs: Window['__FISHOPS_TEST_HARNESS__']['jobs'] = []
const preparedItems = new Map<string, string>()
const eventSubscribers = new Set<string>()

const unknown = (type: string): never => {
  throw new Error(`TEST HARNESS 拒绝未知命令: ${type}`)
}

// ---------------- 聊天历史分页 fixture（仅内存：不发送、不访问平台、不含真实正文） ----------------

/** 固定会话 ID；所有 fixture 消息都属于它。 */
const CHAT_SESSION_ID = 'test-session-1'

interface FixtureChatMessage {
  id: string
  cid: string
  sessionId: string
  messageId: string
  senderId: string
  senderName: string
  receiverId: string
  direction: 'in' | 'out'
  kind: 'text'
  contentType: number
  content: string
  createAt: number
  source: 'history' | 'realtime'
}

/** 造一条可预测的 fixture 消息（正文只是编号，不含任何真实聊天内容）。 */
function chatMessage(prefix: string, index: number, createAt: number, source: 'history' | 'realtime'): FixtureChatMessage {
  const messageId = `${prefix}${String(index).padStart(3, '0')}`
  return {
    id: messageId,
    cid: `${CHAT_SESSION_ID}@goofish`,
    sessionId: CHAT_SESSION_ID,
    messageId,
    senderId: index % 2 === 0 ? 'local-buyer' : 'local-me',
    senderName: index % 2 === 0 ? '本地测试买家' : '我',
    receiverId: index % 2 === 0 ? 'local-me' : 'local-buyer',
    direction: index % 2 === 0 ? 'in' : 'out',
    kind: 'text',
    contentType: 1,
    content: `本地测试消息 ${messageId}`,
    createAt,
    source,
  }
}

/** 平台侧更早的历史（p001 最旧 .. p020 最新，按时间升序）。 */
const CHAT_PLATFORM_MESSAGES: FixtureChatMessage[] = Array.from({ length: 20 }, (_, i) =>
  chatMessage('p', i + 1, 1000 + i * 10, 'history'),
)
/** 本地缓存（t001 最旧 .. t035 最新）；打开会话只应看到最后 10 条 t026..t035。 */
const chatLocal: FixtureChatMessage[] = Array.from({ length: 35 }, (_, i) =>
  chatMessage('t', i + 1, 100000 + i * 1000, 'history'),
)

/** 与扩展侧 ChatStore.compareMessages 同构的稳定排序（createAt → messageId → id）。 */
function compareChatMessages(a: FixtureChatMessage, b: FixtureChatMessage): number {
  if (a.createAt !== b.createAt) return a.createAt - b.createAt
  if (a.messageId !== b.messageId) return a.messageId < b.messageId ? -1 : 1
  if (a.id === b.id) return 0
  return a.id < b.id ? -1 : 1
}

/** 失败哨兵：让 harness 返回 ok:false，用于验证「失败保留消息 + 可重试」。 */
const chatFailure = (code: string, message: string): unknown => ({ __chatFailure: { code, message } })
const isChatFailure = (value: unknown): value is { __chatFailure: { code: string; message: string } } =>
  typeof value === 'object' && value !== null && '__chatFailure' in value

/** 暴露给浏览器验收脚本的只读统计 + 受控失败注入（无任何平台副作用）。 */
interface ChatFixtureHooks {
  failOlderRequests: number
  /** 向前分页请求的人为延迟（毫秒）；用于在真实 DOM 上观察「正在加载更早的消息…」。 */
  olderDelayMs: number
  getRequests: Array<{ order: string; limit?: number; before?: string }>
  syncRequests: Array<{ cursor?: number; count: number }>
  injectRealtime: () => void
  /** 清空本地缓存（仅内存）；用于验证「本地为空时仍能取到平台最近一页」。 */
  clearLocal: () => void
}

const chatFixtureHooks: ChatFixtureHooks = {
  failOlderRequests: 0,
  olderDelayMs: 0,
  getRequests: [],
  syncRequests: [],
  injectRealtime: () => undefined,
  clearLocal: () => undefined,
}

/** CHAT_STATUS：报告内存 fixture 的规模。 */
function chatStatus(): unknown {
  return { socketStatus: 'open', sessionCount: 1, messageCount: chatLocal.length }
}

/** CHAT_LIST_CONVERSATIONS：单个固定会话。 */
function chatConversations(): unknown {
  const sorted = [...chatLocal].sort(compareChatMessages)
  const last = sorted[sorted.length - 1]
  return {
    conversations: [
      {
        sessionId: CHAT_SESSION_ID,
        cid: `${CHAT_SESSION_ID}@goofish`,
        peerUserId: 'local-buyer',
        peerUserName: '本地测试买家',
        lastMessage: last ? last.content : '',
        lastMessageTime: last ? last.createAt : 0,
        unreadCount: 0,
        sortIndex: 1,
        visible: true,
      },
    ],
  }
}

/** CHAT_GET_MESSAGES：与扩展 store.getMessagePage 同语义（窗口内最近 N 条 + before 严格更早）。 */
function chatGetMessages(payload: Record<string, any>): unknown {
  const before = payload.before
  // 仅向前分页可注入延迟，用于肉眼/快照验证「加载中」状态。
  if (before && chatFixtureHooks.olderDelayMs > 0) {
    return new Promise((resolve) => setTimeout(() => resolve(chatGetMessagesNow(payload)), chatFixtureHooks.olderDelayMs))
  }
  return chatGetMessagesNow(payload)
}

function chatGetMessagesNow(payload: Record<string, any>): unknown {
  const order = payload.order === 'desc' ? 'desc' : 'asc'
  const limit = typeof payload.limit === 'number' ? payload.limit : undefined
  const before = payload.before as { createAt: number; messageId: string; id: string } | undefined
  chatFixtureHooks.getRequests.push({
    order,
    ...(limit === undefined ? {} : { limit }),
    ...(before ? { before: before.messageId } : {}),
  })
  if (before && chatFixtureHooks.failOlderRequests > 0) {
    chatFixtureHooks.failOlderRequests -= 1
    return chatFailure('TEST_OLDER_FAIL', '本地模拟向前分页失败')
  }
  let window = [...chatLocal].sort(compareChatMessages)
  if (before) window = window.filter((message) => compareChatMessages(message, before as FixtureChatMessage) < 0)
  const hasMore = limit !== undefined && window.length > limit
  const page = limit === undefined ? window : window.slice(Math.max(0, window.length - limit))
  const ordered = order === 'desc' ? [...page].reverse() : page
  return { messages: ordered, hasMore }
}

/**
 * CHAT_SYNC_HISTORY：按游标把平台历史页写入本地缓存（模拟 background 的行为）。
 *
 * `cursor` 表示「平台侧从最新往前已经消费的条数」；不传时从最新一页开始。
 */
function chatSyncHistory(payload: Record<string, any>): unknown {
  const count = typeof payload.count === 'number' ? payload.count : 10
  const cursor = typeof payload.cursor === 'number' ? payload.cursor : undefined
  chatFixtureHooks.syncRequests.push({ ...(cursor === undefined ? {} : { cursor }), count })
  const end = cursor === undefined ? CHAT_PLATFORM_MESSAGES.length : Math.max(0, Math.min(cursor, CHAT_PLATFORM_MESSAGES.length))
  const start = Math.max(0, end - count)
  const page = CHAT_PLATFORM_MESSAGES.slice(start, end)
  let added = 0
  for (const message of page) {
    if (chatLocal.some((item) => item.id === message.id)) continue
    chatLocal.push(message)
    added += 1
  }
  const hasMore = start > 0
  return { ok: true, added, updated: 0, hasMore, ...(hasMore ? { nextCursor: start } : {}) }
}

const commandResult = (type: string, payload: Record<string, any> = {}): unknown => {
  switch (type) {
    case CommandTypes.PING: return { pong: true, nonce: payload.nonce, serverTime: Date.now() }
    case CommandTypes.SUBSCRIBE: eventSubscribers.clear(); for (const event of payload.events ?? []) eventSubscribers.add(event); return { subscribed: [...eventSubscribers] }
    case CommandTypes.UNSUBSCRIBE: return { unsubscribed: true }
    case CommandTypes.CHAT_RUNTIME_PREPARE: return {
      ok: true,
      tabId: null,
      tabCreated: false,
      platformReady: true,
      socketReady: true,
      socketStatus: 'open',
      userIdReady: true,
    }
    case CommandTypes.CHAT_STATUS: return chatStatus()
    case CommandTypes.CHAT_LIST_CONVERSATIONS: return chatConversations()
    case CommandTypes.CHAT_SYNC_CONVERSATIONS: return { ok: true, added: 0, updated: 0 }
    case CommandTypes.CHAT_GET_MESSAGES: return chatGetMessages(payload)
    case CommandTypes.CHAT_SYNC_HISTORY: return chatSyncHistory(payload)
    case CommandTypes.CHAT_MARK_READ: return { ok: true, updated: true }
    case CommandTypes.RUNTIME_STATUS: return { status: 'disconnected', connected: false }
    case CommandTypes.PRODUCT_CATALOG_QUERY: {
      const products = payload.source === 'my_published' ? previewProducts ?? [fixture, { ...fixture, itemId: 'TEST-ITEM-UNKNOWN-9', title: '独立 unknown 测试商品' }, { ...fixture, itemId: 'TEST-ITEM-TIMEOUT-7', title: '独立 timeout 测试商品' }] : []
      return { source: payload.source, products, total: products.length, page: payload.page ?? 0, pageSize: payload.pageSize ?? 20, hasMore: false }
    }
    case CommandTypes.PRODUCT_LIST: return { products: [fixture, { ...fixture, itemId: 'TEST-ITEM-UNKNOWN-9', title: '独立 unknown 测试商品' }, { ...fixture, itemId: 'TEST-ITEM-TIMEOUT-7', title: '独立 timeout 测试商品' }] }
    case CommandTypes.TASK_LIST: return { tasks: [], total: 0 }
    case CommandTypes.PUBLISH_LIST: return { tasks: [], total: 0 }
    case CommandTypes.DATA_SOURCE_LIST: return { dataSources: [] }
    case CommandTypes.FEISHU_CONFIG_STATUS: return { configured: false }
    case CommandTypes.AI_CONFIG_STATUS: return { configured: false }
    default: return unknown(type)
  }
}

const runtime = {
  id: 'fishops-test-harness-only',
  lastError: undefined as { message?: string } | undefined,
  async sendMessage(message: any, callback?: (response: unknown) => void): Promise<unknown> {
    if (message?.kind === 'fishops-direct-publish') {
      const { method, request } = message
      const testApi = window.__FISHOPS_TEST_HARNESS__
      if (!['prepare', 'submit', 'getJob', 'getProduct', 'uploadImage'].includes(method)) {
        return Promise.reject(new Error(`TEST HARNESS 拒绝未知 direct-publish method: ${String(method)}`))
      }
      calls.push({ channel: 'direct-publish', type: method, request })
      const itemId = String(request?.source?.itemId || request?.itemId || request?.draft?.itemId || fixture.itemId)
      const respond = (result: unknown) => ({ kind: 'fishops-direct-publish', method, result })
      if (method === 'prepare') {
        testApi.prepareCount++
        if (testApi.failNextPrepareFor === itemId) {
          testApi.failNextPrepareFor = null
          return Promise.resolve({ kind: 'fishops-direct-publish', method, error: { code: 'PREPARE_TIMEOUT', message: `本地模拟 prepare timeout：测试来源 ${itemId}` } })
        }
        const prepareToken = `TEST-PREPARE-${itemId}`
        preparedItems.set(prepareToken, itemId)
        const draft = {
          itemId,
          title: `测试草稿 ${itemId}`, description: fixture.desc, price: '39',
          images: [{ url: `memory://test/${itemId}/image-1` }], specifications: [{ name: '款式', value: '测试款' }],
          category: { catId: 'TEST-CAT-1', catName: '测试类目' },
          attributes: [], address: { prov: '测试省', city: '测试市', area: '测试区', divisionId: 'TEST-DIV-1', poiName: '本地测试地点', poiId: 'TEST-POI-1', gps: '120.100000,30.200000' },
          services: [],
        }
        return Promise.resolve(respond({ status: 'prepared', prepareToken, draft, propertyCards: [{ isCategory: true, propertyId: '-10000', propertyName: '类目', values: [{ isCategory: true, valueId: 'TEST-CAT-1', valueName: '测试类目', catId: 'TEST-CAT-1', channelCatId: 'TEST-CAT-1', catName: '测试类目', leafId: 'TEST-LEAF-1', tbCatId: 'TEST-TB-1', transportData: {} }] }], warnings: [] }))
      }
      if (method === 'submit') {
        const submittedItemId = String(request?.draft?.itemId || preparedItems.get(request?.prepareToken) || itemId)
        if (request?.prepareToken !== `TEST-PREPARE-${submittedItemId}` || request?.confirm !== true) {
          return Promise.reject(new Error('TEST HARNESS 拒绝未确认或非本地 prepareToken 的提交'))
        }
        testApi.submitCount++
        const idempotencyKey = `test-submit-${testApi.submitCount}-${submittedItemId}`
        if (testApi.returnUnknownFor === submittedItemId) {
          return Promise.resolve(respond({ status: 'unknown', itemId: submittedItemId, idempotencyKey, code: 'TEST_UNKNOWN', message: `本地模拟提交结果未知：${submittedItemId}` }))
        }
        jobs.push({ idempotencyKey, status: 'published', itemId: submittedItemId, at: new Date().toISOString() })
        return Promise.resolve(respond({ status: 'published', itemId: submittedItemId, idempotencyKey }))
      }
      if (method === 'getJob') return Promise.resolve(respond({ ok: true, jobs: [...jobs] }))
      if (method === 'getProduct') return Promise.resolve(respond({ status: 'ok', itemId, product: { description: fixture.desc, price: '39', images: [] } }))
      if (method === 'uploadImage') return Promise.resolve(respond({ status: 'ok', url: 'memory://test-image' }))
      return Promise.reject(new Error(`TEST HARNESS 拒绝未知 direct-publish method: ${String(method)}`))
    }
    if (!message || message.kind !== 'command' || typeof message.type !== 'string' || typeof message.requestId !== 'string') {
      return Promise.reject(new Error('TEST HARNESS 拒绝未知消息格式'))
    }
    const type = message.type
    let result: unknown
    try { result = commandResult(type, message?.payload ?? {}) } catch (error) { return Promise.reject(error) }
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      try { result = await (result as Promise<unknown>) } catch (error) { return Promise.reject(error) }
    }
    calls.push({ channel: 'command', type, request: message?.payload })
    if (isChatFailure(result)) {
      const failure = { kind: 'response', protocol: 1, requestId: message?.requestId, type, ok: false, error: result.__chatFailure, respondedAt: Date.now() }
      if (callback) { queueMicrotask(() => callback(failure)); return }
      return Promise.resolve(failure)
    }
    const response = { kind: 'response', protocol: 1, requestId: message?.requestId, type, ok: true, result, respondedAt: Date.now() }
    if (callback) { queueMicrotask(() => callback(response)); return }
    return Promise.resolve(response)
  },
  connect(options?: { name?: string }) {
    if (options?.name !== EVENT_PORT_NAME) throw new Error(`TEST HARNESS 拒绝未知 Port: ${String(options?.name)}`)
    const onMessageListeners = new Set<(message: unknown) => void>()
    const onDisconnectListeners = new Set<(message: unknown) => void>()
    const port = {
      onMessage: listenerSet(onMessageListeners),
      onDisconnect: listenerSet(onDisconnectListeners),
      // 订阅按 Port 隔离（与 background 精确投递一致）：多个客户端的订阅不得互相覆盖。
      subscribes: new Set<string>(),
      emit(message: unknown) { for (const listener of onMessageListeners) listener(message) },
      postMessage(message: any) {
        if (message?.kind !== 'subscribe' || !Array.isArray(message.events)) throw new Error('TEST HARNESS 拒绝未知 Port 消息')
        port.subscribes.clear(); for (const event of message.events) port.subscribes.add(event)
      },
      disconnect() { ports.splice(ports.indexOf(port), 1); for (const listener of onDisconnectListeners) listener(undefined) },
    }
    ports.push(port)
    return port
  },
  onMessage: listenerSet(new Set<(message: unknown) => void>()),
}

window.__FISHOPS_TEST_HARNESS__ = {
  mode: 'local-memory-only', calls, prepareCount: 0, submitCount: 0, failNextPrepareFor: null, returnUnknownFor: null, jobs,
  emit(type, payload) {
    // 必须构造合法 EventEnvelope：RuntimeClient 会用 isEventEnvelope 校验，
    // 缺 kind/eventId 或字段名不对（timestamp≠emittedAt）会被静默丢弃。
    const envelope = {
      kind: 'event',
      protocol: PROTOCOL_VERSION,
      type,
      eventId: `harness-event-${(eventSeq += 1)}`,
      payload,
      emittedAt: Date.now(),
    }
    for (const port of ports) {
      if (port.subscribes.has(type)) port.emit(envelope)
    }
  },
}
// 保留 chrome.runtime 的真实生产探测及 RuntimeClient 入口，但标识与行为仅限此 harness。
;(window as any).chrome = { runtime }
;(globalThis as any).chrome = (window as any).chrome

// 追加一条本地实时消息并广播 CHAT_MESSAGE_INGESTED（仅内存；用于验证「新消息追加到底部」）。
chatFixtureHooks.injectRealtime = (): void => {
  const sorted = [...chatLocal].sort(compareChatMessages)
  const lastAt = sorted.length > 0 ? sorted[sorted.length - 1].createAt : 0
  const realtimeIndex = chatLocal.filter((message) => message.source === 'realtime').length + 1
  const message = chatMessage('r', realtimeIndex, lastAt + 1000, 'realtime')
  chatLocal.push(message)
  // 事件负载只携带元数据，不含正文（与真实协议一致）。
  window.__FISHOPS_TEST_HARNESS__.emit(EventTypes.CHAT_MESSAGE_INGESTED, {
    kind: 'message',
    added: 1,
    updated: 0,
  })
}
// 清空本地缓存（仅内存；用于验证「本地为空时仍能取到平台最近一页」）。
chatFixtureHooks.clearLocal = (): void => {
  chatLocal.length = 0
}
;(globalThis as any).__FISHOPS_CHAT_FIXTURE__ = chatFixtureHooks
;(window as any).__FISHOPS_CHAT_FIXTURE__ = chatFixtureHooks
