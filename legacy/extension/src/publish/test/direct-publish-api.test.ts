/**
 * 直接接口发布后台 API 单测。
 *
 * 覆盖：来源（itemId / product）、幂等与同 key 不同输入冲突、service worker 重启后
 * 残留 attempting 阻断、审计存储失败 fail-closed、可信来源校验（拒绝 content script）、
 * 发布响应四态归一（published / action_required / rejected / unknown）以及并发锁。
 *
 * **全部使用 mock chrome（tabs / scripting / storage.local），绝不创建真实 tab、
 * 不访问真实网络、不实际发布。**
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DIRECT_PUBLISH_AUDIT_STORAGE_KEY,
  __resetDirectPublishListenerForTests,
  createDirectPublishApi,
  installDirectPublishApiListener,
  type DirectPublishApi,
  type DirectPublishChromeSubset,
  type DirectPublishInput,
  type DirectPublishScriptingApi,
  type DirectPublishSellerAddress,
  type DirectPublishStorageLocalApi,
  type DirectPublishTabsApi,
} from '../../background/direct-publish-api'
import type { DirectPublishPageRequest, DirectPublishPageResult } from '../../background/direct-publish-page'
import { isCommandEnvelope } from '@fishops/shared'

// ==================== 测试夹具 ====================

interface StorageHarness {
  local: DirectPublishStorageLocalApi
  snapshot(): Record<string, unknown>
}

function createStorage(
  initial: Record<string, unknown> = {},
  options: { failGet?: boolean; failSet?: boolean } = {},
): StorageHarness {
  const map = new Map<string, unknown>(Object.entries(initial))
  return {
    local: {
      async get(keys) {
        if (options.failGet) throw new Error('storage read failed')
        if (keys === undefined || keys === null) return Object.fromEntries(map)
        if (typeof keys === 'string') return map.has(keys) ? { [keys]: map.get(keys) } : {}
        if (Array.isArray(keys)) {
          const out: Record<string, unknown> = {}
          for (const key of keys) if (map.has(key)) out[key] = map.get(key)
          return out
        }
        return Object.fromEntries(map)
      },
      async set(items) {
        if (options.failSet) throw new Error('storage write failed')
        for (const [key, value] of Object.entries(items)) map.set(key, value)
      },
    },
    snapshot: () => Object.fromEntries(map),
  }
}

function createTabs(
  initial: Array<{ id?: number; url: string; status?: string; active?: boolean }> = [],
): {
  api: DirectPublishTabsApi
  created: Array<{ url: string; active: boolean }>
} {
  const tabs: Array<{ id: number; url: string; status: string; active: boolean }> = initial.map((tab, index) => ({
    id: tab.id ?? index + 1,
    url: tab.url,
    status: tab.status ?? 'complete',
    active: tab.active ?? false,
  }))
  const created: Array<{ url: string; active: boolean }> = []
  let nextId = 1000
  const api: DirectPublishTabsApi = {
    async query() {
      return tabs.map((tab) => ({ ...tab }))
    },
    async create(props) {
      created.push({ url: props.url, active: props.active })
      const tab = { id: nextId++, url: props.url, status: 'complete', active: props.active }
      tabs.push(tab)
      return { ...tab }
    },
    async get(tabId) {
      const tab = tabs.find((item) => item.id === tabId)
      if (!tab) throw new Error(`no tab ${tabId}`)
      return { ...tab }
    },
    onRemoved: { addListener() {} },
  }
  return { api, created }
}

interface ScriptingHarness {
  api: DirectPublishScriptingApi
  calls: DirectPublishPageRequest[]
  injectedTabIds: number[]
}

function createScripting(
  handler: (request: DirectPublishPageRequest) => DirectPublishPageResult | Promise<DirectPublishPageResult>,
): ScriptingHarness {
  const calls: DirectPublishPageRequest[] = []
  const injectedTabIds: number[] = []
  const api: DirectPublishScriptingApi = {
    async executeScript<T>(injection: {
      target: { tabId: number }
      world: 'MAIN'
      args: unknown[]
      func: (...args: never[]) => unknown
    }) {
      const request = injection.args[0] as DirectPublishPageRequest
      calls.push(request)
      injectedTabIds.push(injection.target.tabId)
      const result = await handler(request)
      return [{ result: result as T }]
    },
  }
  return { api, calls, injectedTabIds }
}

/** 默认成功页面：account → prepared → published。 */
function successPage(
  overrides: Partial<Record<'account' | 'prepare' | 'publish' | 'submit' | 'getProduct' | 'uploadImage', DirectPublishPageResult>> = {},
) {
  return (request: DirectPublishPageRequest): DirectPublishPageResult => {
    const fallback: Record<string, DirectPublishPageResult> = {
      account: { ok: true, op: 'account', status: 'account', accountScope: 'acct-1' },
      prepare: {
        ok: true,
        op: 'prepare',
        status: 'prepared',
        payload: { itemTextDTO: { desc: 'd' }, itemCatDTO: { catId: '50106003' } },
        accountScope: 'acct-1',
        itemCount: 2,
        catId: '50106003',
        warnings: ['推荐类目与属性由接口自动识别，需人工核对，不保证精准配置'],
      },
      publish: { ok: true, op: 'publish', status: 'published', itemId: '1087978938358' },
      uploadImage: { ok: true, op: 'uploadImage', status: 'uploaded', image: { url: 'https://img.example.com/uploaded.jpg' } },
      getProduct: {
        ok: true,
        op: 'getProduct',
        status: 'product',
        product: {
          description: '源商品描述',
          price: '34',
          images: ['https://img.example.com/1.jpg'],
          specifications: [{ name: '品牌', value: 'UR' }],
        },
      },
    }
    return overrides[request.op] ?? (fallback[request.op] as DirectPublishPageResult)
  }
}

interface Harness {
  api: DirectPublishApi
  storage: StorageHarness
  tabs: { api: DirectPublishTabsApi; created: Array<{ url: string; active: boolean }> }
  scripting: ScriptingHarness
}

function setup(
  handler: (request: DirectPublishPageRequest) => DirectPublishPageResult | Promise<DirectPublishPageResult>,
  options: {
    storageInitial?: Record<string, unknown>
    storageOptions?: { failGet?: boolean; failSet?: boolean }
    storage?: StorageHarness
    initialTabs?: Array<{ id?: number; url: string; status?: string; active?: boolean }>
    publishUrl?: string
    injectTimeoutMs?: number
  } = {},
): Harness {
  const storage = options.storage ?? createStorage(options.storageInitial, options.storageOptions)
  const tabs = createTabs(options.initialTabs ?? [])
  const scripting = createScripting(handler)
  const chrome: DirectPublishChromeSubset = { tabs: tabs.api, scripting: scripting.api, storage: { local: storage.local } }
  const api = createDirectPublishApi({
    chrome,
    ...(options.publishUrl === undefined ? {} : { publishUrl: options.publishUrl }),
    ...(options.injectTimeoutMs === undefined ? {} : { injectTimeoutMs: options.injectTimeoutMs }),
  })
  return { api, storage, tabs, scripting }
}

const ADDRESS: DirectPublishSellerAddress = {
  prov: '浙江省',
  city: '杭州市',
  area: '西湖区',
  divisionId: '330106',
  poiName: '测试发货点',
  poiId: 'poi-1',
  gps: '30.10,120.20',
}

function itemInput(overrides: Partial<DirectPublishInput> = {}): DirectPublishInput {
  return {
    source: { itemId: '1001' },
    idempotencyKey: 'key-1',
    confirm: true,
    seller: { address: ADDRESS },
    servicePreferences: {},
    confirmedNoQrCodes: true,
    ...overrides,
  }
}

const countOp = (harness: Harness, op: string): number =>
  harness.scripting.calls.filter((call) => call.op === op).length

// ==================== 来源 ====================

test('publish(itemId)：成功发布并写入审计，publish 成功以 itemId 为准', async () => {
  const harness = setup(successPage())
  const result = await harness.api.publish(itemInput())

  assert.equal(result.status, 'published')
  assert.equal(result.itemId, '1087978938358')
  assert.equal(result.reused, undefined)
  // 页面调用顺序：account → prepare → publish
  assert.deepEqual(
    harness.scripting.calls.map((call) => call.op),
    ['account', 'prepare', 'publish'],
  )
  // 只创建一个后台非激活专用 tab
  assert.equal(harness.tabs.created.length, 1)
  assert.equal(harness.tabs.created[0]?.active, false)
  assert.ok(harness.tabs.created[0]?.url.includes('fishopsDirectPublish=1'))
  // 审计持久化
  const ledger = harness.storage.snapshot()[DIRECT_PUBLISH_AUDIT_STORAGE_KEY] as {
    entries: Record<string, { status: string; itemId?: string }>
  }
  assert.equal(ledger.entries['acct-1::key-1']?.status, 'published')
  assert.equal(ledger.entries['acct-1::key-1']?.itemId, '1087978938358')
})

test('publish(product)：第二种入口使用 sourceProduct 走 prepare', async () => {
  const harness = setup(successPage())
  const result = await harness.api.publish(
    itemInput({
      source: {
        product: {
          description: '手写商品描述',
          price: '35000',
          images: ['https://img.example.com/a.jpg'],
          specifications: [{ name: '尺码', value: 'M' }],
        },
      },
      seller: { coordinates: { latitude: 30.1, longitude: 120.2 } },
    }),
  )

  assert.equal(result.status, 'published')
  const prepare = harness.scripting.calls.find((call) => call.op === 'prepare')
  assert.ok(prepare?.sourceProduct)
  assert.equal(prepare?.sourceProduct?.price, '35000')
  assert.equal(prepare?.sourceItemId, undefined)
  assert.deepEqual(prepare?.coordinates, { latitude: 30.1, longitude: 120.2 })
})

test('getProduct：只读返回最小商品字段', async () => {
  const harness = setup(successPage())
  const result = await harness.api.getProduct('1001')

  assert.equal(result.status, 'ok')
  assert.equal(result.product?.price, '34')
  assert.deepEqual(result.product?.images, ['https://img.example.com/1.jpg'])
  // 只读：不进行 prepare / publish
  assert.equal(countOp(harness, 'prepare'), 0)
  assert.equal(countOp(harness, 'publish'), 0)
})

// ==================== 幂等 ====================

test('幂等：同 key 同 input 已成功 → 返回既有 result 且不再请求', async () => {
  const harness = setup(successPage())
  const first = await harness.api.publish(itemInput())
  assert.equal(first.status, 'published')

  const second = await harness.api.publish(itemInput())
  assert.equal(second.status, 'published')
  assert.equal(second.itemId, '1087978938358')
  assert.equal(second.reused, true)
  // 第二次不再注入 prepare / publish（account 也不再需要）
  assert.equal(countOp(harness, 'prepare'), 1)
  assert.equal(countOp(harness, 'publish'), 1)
})

test('幂等：同 key 不同 input → 拒绝（IDEMPOTENCY_KEY_CONFLICT）', async () => {
  const harness = setup(successPage())
  await harness.api.publish(itemInput())

  const conflict = await harness.api.publish(itemInput({ source: { itemId: '2002' } }))
  assert.equal(conflict.status, 'rejected')
  assert.equal(conflict.code, 'IDEMPOTENCY_KEY_CONFLICT')
  assert.equal(countOp(harness, 'publish'), 1)
})

test('幂等：上次结果未知 → 同 key 重试被阻断，无第二次 publish', async () => {
  const harness = setup(
    successPage({ publish: { ok: false, op: 'publish', status: 'unknown', code: 'PUBLISH_TIMEOUT', message: '超时' } }),
  )
  const first = await harness.api.publish(itemInput())
  assert.equal(first.status, 'unknown')

  const second = await harness.api.publish(itemInput())
  assert.equal(second.status, 'unknown')
  assert.equal(second.code, 'PREVIOUS_ATTEMPT_UNKNOWN')
  assert.equal(countOp(harness, 'publish'), 1)
})

test('幂等：service worker 重启后残留 attempting 阻断同 key 发布', async () => {
  const harness = setup(
    successPage({ publish: { ok: false, op: 'publish', status: 'unknown', code: 'PUBLISH_TIMEOUT', message: '超时' } }),
  )
  await harness.api.publish(itemInput())

  // 模拟 service worker 重启：新建 API 实例（内存状态清空），复用同一 storage.local。
  const restarted: DirectPublishChromeSubset = {
    tabs: harness.tabs.api,
    scripting: harness.scripting.api,
    storage: { local: harness.storage.local },
  }
  const restartedApi = createDirectPublishApi({ chrome: restarted })
  const result = await restartedApi.publish(itemInput())
  assert.equal(result.status, 'unknown')
  assert.equal(result.code, 'PREVIOUS_ATTEMPT_UNKNOWN')
  assert.equal(countOp(harness, 'publish'), 1)
})

test('幂等：action_required 允许修正后重试', async () => {
  let publishCall = 0
  const harness = setup((request) => {
    if (request.op === 'publish') {
      publishCall += 1
      if (publishCall === 1) {
        return { ok: false, op: 'publish', status: 'action_required', actionRequired: 'captcha', code: 'CAPTCHA_REQUIRED', message: '验证码' }
      }
      return { ok: true, op: 'publish', status: 'published', itemId: '999' }
    }
    return successPage()(request)
  })

  const first = await harness.api.publish(itemInput())
  assert.equal(first.status, 'action_required')
  assert.equal(first.actionRequired, 'captcha')

  const second = await harness.api.publish(itemInput())
  assert.equal(second.status, 'published')
  assert.equal(countOp(harness, 'publish'), 2)
})

// ==================== fail-closed ====================

test('fail-closed：审计读取失败 → unknown 且不进入 prepare / publish', async () => {
  const harness = setup(successPage(), { storageOptions: { failGet: true } })
  const result = await harness.api.publish(itemInput())

  assert.equal(result.status, 'unknown')
  assert.equal(result.code, 'AUDIT_STORAGE_UNAVAILABLE')
  assert.equal(countOp(harness, 'account'), 1)
  assert.equal(countOp(harness, 'prepare'), 0)
  assert.equal(countOp(harness, 'publish'), 0)
})

test('fail-closed：attempting 写入失败 → unknown 且不进入 publish', async () => {
  let setCalls = 0
  const storage = createStorage()
  const realSet = storage.local.set
  storage.local.set = async (items) => {
    setCalls += 1
    if (setCalls >= 1) throw new Error('write failed')
    return realSet(items)
  }
  const harness = setup(successPage(), { storage })
  const result = await harness.api.publish(itemInput())

  assert.equal(result.status, 'unknown')
  assert.equal(result.code, 'AUDIT_STORAGE_UNAVAILABLE')
  assert.equal(countOp(harness, 'prepare'), 1)
  assert.equal(countOp(harness, 'publish'), 0)
})

// ==================== 发布响应归一 ====================

test('响应归一：SUCCESS 但缺 itemId → unknown', async () => {
  const harness = setup(successPage({ publish: { ok: true, op: 'publish', status: 'published' } }))
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'unknown')
})

test('响应归一：业务拒绝 FAIL_BIZ_ → rejected', async () => {
  const harness = setup(
    successPage({
      publish: { ok: false, op: 'publish', status: 'rejected', code: 'FAIL_BIZ_ITEM_DESC_INVALID', message: '描述不合法' },
    }),
  )
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'FAIL_BIZ_ITEM_DESC_INVALID')
})

test('响应归一：STRONG_VALID_VERIFY_INFO → action_required/verification', async () => {
  const harness = setup(
    successPage({
      publish: {
        ok: false,
        op: 'publish',
        status: 'action_required',
        actionRequired: 'verification',
        code: 'VERIFICATION_REQUIRED',
        message: '需实人认证',
      },
    }),
  )
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'action_required')
  assert.equal(result.actionRequired, 'verification')
})

test('响应归一：登录失效 → action_required/login', async () => {
  const harness = setup(
    successPage({
      publish: {
        ok: false,
        op: 'publish',
        status: 'action_required',
        actionRequired: 'login',
        code: 'LOGIN_REQUIRED',
        message: '登录失效',
      },
    }),
  )
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'action_required')
  assert.equal(result.actionRequired, 'login')
})

test('prepare 阶段 login → 直接 action_required 且不提交', async () => {
  const harness = setup(
    successPage({
      prepare: { ok: false, op: 'prepare', status: 'action_required', actionRequired: 'login', code: 'NO_LOGIN', message: '未登录' },
    }),
  )
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'action_required')
  assert.equal(result.actionRequired, 'login')
  assert.equal(countOp(harness, 'publish'), 0)
})

// ==================== 入参校验与并发 ====================

test('入参校验：confirm 非 true → rejected', async () => {
  const harness = setup(successPage())
  const result = await harness.api.publish(itemInput({ confirm: false }))
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'CONFIRM_REQUIRED')
  assert.equal(harness.scripting.calls.length, 0)
})

test('入参校验：seller 缺少 address/coordinates → rejected', async () => {
  const harness = setup(successPage())
  const result = await harness.api.publish(itemInput({ seller: {} }))
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'SELLER_REQUIRED')
})

test('并发锁：已有发布在途时第二次调用被拒绝', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const harness = setup(async (request) => {
    if (request.op === 'account') {
      await gate
      return { ok: true, op: 'account', status: 'account', accountScope: 'acct-1' }
    }
    return successPage()(request)
  })

  const first = harness.api.publish(itemInput())
  const second = await harness.api.publish(itemInput({ idempotencyKey: 'key-2' }))
  assert.equal(second.status, 'rejected')
  assert.equal(second.code, 'CONCURRENT_LOCK')

  release()
  const firstResult = await first
  assert.equal(firstResult.status, 'published')
})

test('getJob：可查询审计记录', async () => {
  const harness = setup(successPage())
  await harness.api.publish(itemInput())
  const jobs = await harness.api.getJob('key-1')
  assert.equal(jobs.ok, true)
  assert.equal(jobs.jobs.length, 1)
  assert.equal(jobs.jobs[0]?.status, 'published')
  assert.equal(jobs.jobs[0]?.itemId, '1087978938358')
})

// ==================== 监听器与可信来源 ====================

function installCapture(options: { createApi?: () => DirectPublishApi | null } = {}): {
  listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean
  listeners: Array<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean>
} {
  const listeners: Array<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean> = []
  const chromeMock = {
    runtime: {
      id: 'ext-id',
      onMessage: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) },
    },
  }
  ;(globalThis as { chrome?: unknown }).chrome = chromeMock
  __resetDirectPublishListenerForTests()
  installDirectPublishApiListener(options)
  return { listener: listeners[0]!, listeners }
}

function invokeListener(
  listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean,
  message: unknown,
  sender: unknown,
): { returned: boolean; response: Promise<unknown> } {
  let resolveResponse: (value: unknown) => void = () => {}
  const response = new Promise<unknown>((resolve) => {
    resolveResponse = resolve
  })
  const returned = listener(message, sender, resolveResponse)
  return { returned, response }
}

test('监听器：拒绝 content script 来源', () => {
  const harness = setup(successPage())
  const { listener } = installCapture({ createApi: () => harness.api })
  try {
    const { returned } = invokeListener(
      listener,
      { kind: 'fishops-direct-publish', method: 'publish', request: itemInput() },
      { id: 'ext-id', url: 'https://www.goofish.com/im', tab: { id: 1 } },
    )
    assert.equal(returned, false)
  } finally {
    delete (globalThis as { chrome?: unknown }).chrome
  }
})

test('监听器：拒绝非本扩展 id 来源', () => {
  const harness = setup(successPage())
  const { listener } = installCapture({ createApi: () => harness.api })
  try {
    const { returned } = invokeListener(
      listener,
      { kind: 'fishops-direct-publish', method: 'publish', request: itemInput() },
      { id: 'other', url: 'chrome-extension://ext-id/workbench.html' },
    )
    assert.equal(returned, false)
  } finally {
    delete (globalThis as { chrome?: unknown }).chrome
  }
})

test('监听器：忽略其它 kind 消息（不影响既有命令）', () => {
  const harness = setup(successPage())
  const { listener } = installCapture({ createApi: () => harness.api })
  try {
    const { returned } = invokeListener(
      listener,
      { kind: 'command', type: 'PING', request: {} },
      { id: 'ext-id', url: 'chrome-extension://ext-id/workbench.html' },
    )
    assert.equal(returned, false)
  } finally {
    delete (globalThis as { chrome?: unknown }).chrome
  }
})

test('监听器：接受扩展内页 publish 并返回结构化结果', async () => {
  const harness = setup(successPage())
  const { listener } = installCapture({ createApi: () => harness.api })
  try {
    const { returned, response } = invokeListener(
      listener,
      { kind: 'fishops-direct-publish', method: 'publish', request: itemInput() },
      { id: 'ext-id', url: 'chrome-extension://ext-id/workbench.html' },
    )
    assert.equal(returned, true)
    const payload = (await response) as { ok: boolean; result?: { status: string; itemId?: string } }
    assert.equal(payload.ok, true)
    assert.equal(payload.result?.status, 'published')
    assert.equal(payload.result?.itemId, '1087978938358')
  } finally {
    delete (globalThis as { chrome?: unknown }).chrome
  }
})

test('监听器：接受扩展内页 getProduct 并返回最小商品', async () => {
  const harness = setup(successPage())
  const { listener } = installCapture({ createApi: () => harness.api })
  try {
    const { returned, response } = invokeListener(
      listener,
      { kind: 'fishops-direct-publish', method: 'getProduct', request: { itemId: '1001' } },
      { id: 'ext-id', url: 'chrome-extension://ext-id/workbench.html' },
    )
    assert.equal(returned, true)
    const payload = (await response) as { ok: boolean; result?: { status: string; product?: { price: string } } }
    assert.equal(payload.ok, true)
    assert.equal(payload.result?.status, 'ok')
    assert.equal(payload.result?.product?.price, '34')
  } finally {
    delete (globalThis as { chrome?: unknown }).chrome
  }
})

test('真实多监听器链：Workbench envelope 不匹配时 getJob listener 异步响应账本', async () => {
  const harness = setup(successPage())
  await harness.api.publish(itemInput())
  const { listeners } = installCapture({ createApi: () => harness.api })
  const unrelatedResponses: unknown[] = []
  const workbenchListener = (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => {
    if (!isCommandEnvelope(message)) return false
    sendResponse({ kind: 'response', protocol: 1 })
    return true
  }
  listeners.unshift(workbenchListener)
  try {
    const { returned, response } = invokeListener(
      listeners[1]!,
      { kind: 'fishops-direct-publish', method: 'getJob', request: {} },
      { id: 'ext-id', url: 'chrome-extension://ext-id/workbench.html' },
    )
    assert.equal(returned, true)
    const workbenchReturned = listeners[0]!({ kind: 'fishops-direct-publish', method: 'getJob', request: {} }, { id: 'ext-id', url: 'chrome-extension://ext-id/workbench.html' }, (value) => unrelatedResponses.push(value))
    assert.equal(workbenchReturned, false)
    assert.equal(unrelatedResponses.length, 0)
    const payload = (await response) as { kind: string; method: string; ok: boolean; result?: { ok: boolean; jobs: Array<{ status: string; itemId?: string }> } }
    assert.equal(payload.kind, 'fishops-direct-publish')
    assert.equal(payload.method, 'getJob')
    assert.equal(payload.ok, true)
    assert.equal(payload.result?.ok, true)
    assert.equal(payload.result?.jobs.length, 1)
    assert.equal(payload.result?.jobs[0]?.status, 'published')
    assert.equal(payload.result?.jobs[0]?.itemId, '1087978938358')
  } finally {
    delete (globalThis as { chrome?: unknown }).chrome
  }
})

test('监听器：依赖缺失时返回 DEPENDENCIES_MISSING', async () => {
  const { listener } = installCapture({ createApi: () => null })
  try {
    const { returned, response } = invokeListener(
      listener,
      { kind: 'fishops-direct-publish', method: 'getProduct', request: { itemId: '1001' } },
      { id: 'ext-id', url: 'chrome-extension://ext-id/workbench.html' },
    )
    assert.equal(returned, true)
    const payload = (await response) as { ok: boolean; error?: { code: string } }
    assert.equal(payload.ok, false)
    assert.equal(payload.error?.code, 'DEPENDENCIES_MISSING')
  } finally {
    delete (globalThis as { chrome?: unknown }).chrome
  }
})

// ==================== 审计账本损坏（fail-closed） ====================

const ledgerWith = (value: unknown): Record<string, unknown> => ({ [DIRECT_PUBLISH_AUDIT_STORAGE_KEY]: value })

function readEntry(harness: Harness, key: string): { status: string } | undefined {
  const ledger = harness.storage.snapshot()[DIRECT_PUBLISH_AUDIT_STORAGE_KEY] as
    | { entries?: Record<string, { status: string }> }
    | undefined
  return ledger?.entries?.[key]
}

test('损坏 ledger：根节点非对象 → unknown AUDIT_STORAGE_UNAVAILABLE 且不 prepare', async () => {
  const harness = setup(successPage(), { storageInitial: ledgerWith('corrupted') })
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'unknown')
  assert.equal(result.code, 'AUDIT_STORAGE_UNAVAILABLE')
  assert.equal(countOp(harness, 'prepare'), 0)
  assert.equal(countOp(harness, 'publish'), 0)
})

test('损坏 ledger：版本不支持 → fail-closed 拒绝', async () => {
  const harness = setup(successPage(), { storageInitial: ledgerWith({ version: 2, entries: {} }) })
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'unknown')
  assert.equal(result.code, 'AUDIT_STORAGE_UNAVAILABLE')
  assert.equal(countOp(harness, 'prepare'), 0)
})

test('损坏 ledger：单项缺少关键字段 → fail-closed 拒绝', async () => {
  const harness = setup(successPage(), {
    storageInitial: ledgerWith({
      version: 1,
      entries: {
        'acct-1::old': { accountScope: 'acct-1', idempotencyKey: 'old', status: 'published', at: '2026-01-01T00:00:00Z' },
      },
    }),
  })
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'unknown')
  assert.equal(result.code, 'AUDIT_STORAGE_UNAVAILABLE')
  assert.equal(countOp(harness, 'prepare'), 0)
})

test('损坏 ledger：键不存在时才初始化空账本', async () => {
  const harness = setup(successPage())
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'published')
  assert.equal(readEntry(harness, 'acct-1::key-1')?.status, 'published')
})

// ==================== 专用 tab 严格校验 ====================

test('严格 tab：相似 / 恶意 URL 一律不复用，只新建自己的专用 tab', async () => {
  const harness = setup(successPage(), {
    initialTabs: [
      { url: 'https://www.goofish.com.evil.com/publish?fishopsDirectPublish=1' },
      { url: 'https://www.goofish.com/publish?fishopsDirectPublish=10' },
      { url: 'http://www.goofish.com/publish?fishopsDirectPublish=1' },
      { url: 'https://www.goofish.com/publish' },
      { url: 'https://evil.example.com/publish?fishopsDirectPublish=1' },
    ],
  })
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'published')
  assert.equal(harness.tabs.created.length, 1)
  assert.ok((harness.tabs.created[0]?.url ?? '').includes('fishopsDirectPublish=1'))
  // 注入只发生在新建的专用 tab（id 由 1000 起），绝不注入恶意 / 用户 tab。
  assert.ok(harness.scripting.injectedTabIds.length > 0)
  assert.ok(harness.scripting.injectedTabIds.every((id) => id === 1000))
})

test('严格 tab：合法的专用 tab 会被复用（不新建）', async () => {
  const harness = setup(successPage(), {
    initialTabs: [{ id: 77, url: 'https://www.goofish.com/publish?fishopsDirectPublish=1', status: 'complete' }],
  })
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'published')
  assert.equal(harness.tabs.created.length, 0)
  assert.ok(harness.scripting.injectedTabIds.every((id) => id === 77))
})

test('严格 tab：自定义 publishUrl 非法 → TAB_UNAVAILABLE 且不注入', async () => {
  const harness = setup(successPage(), { publishUrl: 'https://evil.com/publish?fishopsDirectPublish=1' })
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'unknown')
  assert.equal(result.code, 'TAB_UNAVAILABLE')
  assert.equal(harness.scripting.calls.length, 0)
  assert.equal(harness.tabs.created.length, 0)
})

// ==================== 账号漂移 ====================

test('账号漂移：prepare 返回 accountScope 与探测不一致 → action_required/ACCOUNT_CHANGED 且不提交', async () => {
  const harness = setup(
    successPage({
      prepare: { ok: true, op: 'prepare', status: 'prepared', payload: { a: 1 }, accountScope: 'acct-2' },
    }),
  )
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'action_required')
  assert.equal(result.code, 'ACCOUNT_CHANGED')
  assert.equal(countOp(harness, 'publish'), 0)
  assert.equal(readEntry(harness, 'acct-1::key-1')?.status, 'action_required')
})

test('账号防漂移：expectedAccountScope 透传给 prepare 与 publish，并透传核对 warnings', async () => {
  const harness = setup(successPage())
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'published')
  const prepareCall = harness.scripting.calls.find((call) => call.op === 'prepare')
  const publishCall = harness.scripting.calls.find((call) => call.op === 'publish')
  assert.equal(prepareCall?.expectedAccountScope, 'acct-1')
  assert.equal(publishCall?.expectedAccountScope, 'acct-1')
  assert.ok((result.warnings ?? []).some((w) => w.includes('需人工核对')))
})

// ==================== 入参 schema（价格 / 规格） ====================

test('入参：specifications 逐项非空，非法项被拒绝而非静默丢弃', async () => {
  const harness = setup(successPage())
  const result = await harness.api.publish(
    itemInput({
      source: {
        product: {
          description: 'd',
          price: '10',
          images: ['https://img.example.com/a.jpg'],
          specifications: [{ name: '', value: 'M' }],
        },
      },
    }),
  )
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'PRODUCT_SPECIFICATIONS_INVALID')
  assert.equal(harness.scripting.calls.length, 0)
})

test('入参：价格超 2 位小数或为 0 → rejected，不静默归 0', async () => {
  const tooPrecise = setup(successPage())
  const r1 = await tooPrecise.api.publish(
    itemInput({ source: { product: { description: 'd', price: '1.234', images: ['https://x/a.jpg'] } } }),
  )
  assert.equal(r1.status, 'rejected')
  assert.equal(r1.code, 'PRODUCT_PRICE_INVALID')

  const zero = setup(successPage())
  const r2 = await zero.api.publish(
    itemInput({ source: { product: { description: 'd', price: '0.00', images: ['https://x/a.jpg'] } } }),
  )
  assert.equal(r2.status, 'rejected')
  assert.equal(r2.code, 'PRODUCT_PRICE_INVALID')
})

// ==================== 注入超时 ====================

test('注入超时：归 unknown/PAGE_INJECTION_TIMEOUT 且不自动重试', async () => {
  const harness = setup(
    (request) => {
      if (request.op === 'account') return new Promise<DirectPublishPageResult>(() => {})
      return successPage()(request)
    },
    { injectTimeoutMs: 10 },
  )
  const result = await harness.api.publish(itemInput())
  assert.equal(result.status, 'unknown')
  assert.equal(result.code, 'PAGE_INJECTION_TIMEOUT')
  assert.equal(countOp(harness, 'publish'), 0)
})
