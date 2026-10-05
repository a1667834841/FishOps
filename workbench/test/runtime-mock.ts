import { CommandTypes, EVENT_PORT_NAME } from '@fishops/shared'

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
const calls: Window['__FISHOPS_TEST_HARNESS__']['calls'] = []
const listeners = new Map<string, Set<(message: unknown) => void>>()
const ports: Array<{ onMessage: ListenerSet; onDisconnect: ListenerSet; postMessage: (message: unknown) => void; disconnect: () => void; emit: (message: unknown) => void }> = []
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
const commandResult = (type: string, payload: Record<string, any> = {}): unknown => {
  switch (type) {
    case CommandTypes.PING: return { pong: true, nonce: payload.nonce, serverTime: Date.now() }
    case CommandTypes.SUBSCRIBE: eventSubscribers.clear(); for (const event of payload.events ?? []) eventSubscribers.add(event); return { subscribed: [...eventSubscribers] }
    case CommandTypes.UNSUBSCRIBE: return { unsubscribed: true }
    case CommandTypes.CHAT_RUNTIME_PREPARE: return { status: 'ready', connected: false }
    case CommandTypes.RUNTIME_STATUS: return { status: 'disconnected', connected: false }
    case CommandTypes.PRODUCT_CATALOG_QUERY: {
      const products = payload.source === 'my_published' ? [fixture, { ...fixture, itemId: 'TEST-ITEM-UNKNOWN-9', title: '独立 unknown 测试商品' }, { ...fixture, itemId: 'TEST-ITEM-TIMEOUT-7', title: '独立 timeout 测试商品' }] : []
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
  sendMessage(message: any, callback?: (response: unknown) => void): Promise<unknown> | void {
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
    calls.push({ channel: 'command', type, request: message?.payload })
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
      emit(message: unknown) { for (const listener of onMessageListeners) listener(message) },
      postMessage(message: any) {
        if (message?.kind !== 'subscribe' || !Array.isArray(message.events)) throw new Error('TEST HARNESS 拒绝未知 Port 消息')
        eventSubscribers.clear(); for (const event of message.events) eventSubscribers.add(event)
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
    if (!eventSubscribers.has(type)) return
    const envelope = { type, payload, timestamp: Date.now() }
    for (const port of ports) port.emit(envelope)
  },
}
// 保留 chrome.runtime 的真实生产探测及 RuntimeClient 入口，但标识与行为仅限此 harness。
;(window as any).chrome = { runtime }
;(globalThis as any).chrome = (window as any).chrome
