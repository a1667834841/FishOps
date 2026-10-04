/**
 * 真实用户 bug 回归：prepare 后人工审核再 submit 报 `PREPARE_EXPIRED`。
 *
 * 根因（三个待验证假设，本文件分别验证）：
 * 1. **SW 内存丢失（最可能）**：prepared 只存在 service worker 内存，MV3 ~30s 空闲即休眠，
 *    内存被清空 → submit 拿不到 token；
 * 2. **30 分钟 TTL**：超过 `prepareTtlMs` 才应过期；
 * 3. **已 consume**：同一 token 二次提交属于重复提交，而非过期。
 *
 * 修复：prepared 条目落 `chrome.storage.session`（**会话内存、非落盘**，SW 休眠不丢，
 * 浏览器重启 / 扩展重载清空），prepare 成功先持久化再返回 token（失败 fail-closed
 * `PREPARE_STORAGE_UNAVAILABLE` 且不返回 token），submit 先按 token 从 session 恢复。
 *
 * **全部使用 mock chrome（tabs / scripting / storage.local / storage.session），
 * 绝不创建真实 tab、不访问真实网络、不实际发布。**
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DIRECT_PUBLISH_AUDIT_STORAGE_KEY,
  DIRECT_PUBLISH_PREPARED_SESSION_KEY,
  createChromeDirectPublishApi,
  createDirectPublishApi,
  type DirectPublishApi,
  type DirectPublishChromeSubset,
  type DirectPublishScriptingApi,
  type DirectPublishStorageLocalApi,
  type DirectPublishStorageSessionApi,
  type DirectPublishTabsApi,
} from '../../background/direct-publish-api'
import type { DirectPublishPageResult } from '../../background/direct-publish-page'
import type {
  DirectPublishPrepareRequest,
  DirectPublishReviewDraft,
  DirectPublishSubmitRequest,
} from '../../../../shared/types/direct-publish'

// ==================== 夹具 ====================

function createStorage(initial: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(initial))
  const local: DirectPublishStorageLocalApi = {
    async get(keys) {
      if (keys === undefined || keys === null) return Object.fromEntries(map)
      if (typeof keys === 'string') return map.has(keys) ? { [keys]: map.get(keys) } : {}
      const out: Record<string, unknown> = {}
      for (const key of keys) if (map.has(key)) out[key] = map.get(key)
      return out
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) map.set(key, value)
    },
  }
  return { local, snapshot: () => Object.fromEntries(map) }
}

interface SessionHarness {
  api: DirectPublishStorageSessionApi
  snapshot(): Record<string, unknown>
  /** 可动态切换的故障注入（用于验证 fail-closed）。 */
  state: { failGet: boolean; failSet: boolean }
}

/** 共享的 chrome.storage.session mock：同一对象可在「重启后的新实例」间复用（模拟会话内存）。 */
function createSession(initial: Record<string, unknown> = {}): SessionHarness {
  const map = new Map<string, unknown>(Object.entries(initial))
  const state = { failGet: false, failSet: false }
  const api: DirectPublishStorageSessionApi = {
    async get(keys) {
      if (state.failGet) throw new Error('session read failed')
      if (keys === undefined || keys === null) return Object.fromEntries(map)
      if (typeof keys === 'string') return map.has(keys) ? { [keys]: map.get(keys) } : {}
      const out: Record<string, unknown> = {}
      for (const key of keys) if (map.has(key)) out[key] = map.get(key)
      return out
    },
    async set(items) {
      if (state.failSet) throw new Error('session write failed')
      for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value))
    },
  }
  return { api, snapshot: () => Object.fromEntries(map), state }
}

function createTabs(): { api: DirectPublishTabsApi } {
  let nextId = 1000
  return {
    api: {
      async query() {
        return [{ id: 77, url: 'https://www.goofish.com/publish?fishopsDirectPublish=1', status: 'complete', active: false }]
      },
      async create(props) {
        return { id: nextId++, url: props.url, status: 'complete', active: props.active }
      },
      async get(tabId) {
        return { id: tabId, url: 'https://www.goofish.com/publish?fishopsDirectPublish=1', status: 'complete', active: false }
      },
      onRemoved: { addListener() {} },
    },
  }
}

type RawRequest = { op: string; [k: string]: unknown }

function createScripting(handler: (request: RawRequest) => DirectPublishPageResult | Promise<DirectPublishPageResult>) {
  const calls: RawRequest[] = []
  const api: DirectPublishScriptingApi = {
    async executeScript<T>(injection: { args: unknown[] }) {
      const request = injection.args[0] as RawRequest
      calls.push(request)
      return [{ result: (await handler(request)) as T }]
    },
  }
  return { api, calls }
}

const ADDRESS = {
  prov: '浙江省',
  city: '杭州市',
  area: '西湖区',
  divisionId: '330106',
  poiName: '测试发货点',
  poiId: 'poi-1',
  gps: '30.10,120.20',
}

const UPLOADED_IMAGES = [
  { extraInfo: { isH: 'false', isT: 'false', raw: 'false' }, isQrCode: false, url: 'https://img.example.com/u1.jpg', heightSize: 100, widthSize: 100, major: true, type: 0, status: 'done' },
]

const PROPERTY_CARDS = [
  {
    cardType: '20401',
    propertyId: '-10000',
    propertyName: '分类',
    isCategory: true,
    isBook: false,
    supportWebPublish: true,
    tips: '',
    values: [
      { valueId: '50000000', valueName: '手机', transportData: { channelCateId: '50000000' }, isCategory: true, catId: '50000000', channelCatId: '50000000', catName: '手机', leafId: '0', tbCatId: '5001' },
    ],
  },
  {
    cardType: '20401',
    propertyId: '20000',
    propertyName: '品牌',
    isCategory: false,
    isBook: false,
    supportWebPublish: true,
    tips: '',
    values: [{ valueId: 'brand-a', valueName: 'UR', transportData: { brandId: 'brand-a' }, isCategory: false }],
  },
]

const RAW_CARDS = [
  { cardType: '20401', cardData: { propertyId: '-10000', propertyName: '分类', valuesList: [{ valueId: '50000000', channelCatId: '50000000', catId: '50000000', catName: '手机', isClicked: '1' }] } },
]

function makeDraft(): DirectPublishReviewDraft {
  return {
    title: '测试标题',
    description: '原始描述',
    price: '34',
    specifications: [{ name: '尺码', value: 'M' }],
    category: { catId: '50000000', catName: '手机', channelCatId: '50000000', leafId: '0', tbCatId: '5001' },
    attributes: [{ propertyId: '20000', propertyName: '品牌', valueId: 'brand-a', valueName: 'UR', transportData: { brandId: 'brand-a' }, text: 'UR' }],
    address: { ...ADDRESS },
    images: UPLOADED_IMAGES.map((image) => JSON.parse(JSON.stringify(image)) as Record<string, unknown>),
    services: [{ serviceCode: 'AI_SALE', enable: false }],
  }
}

function makePrepareRequest(overrides: Partial<DirectPublishPrepareRequest> = {}): DirectPublishPrepareRequest {
  return {
    source: { itemId: '1001', imageIndexes: [0] },
    idempotencyKey: 'key-1',
    seller: { address: { ...ADDRESS } },
    confirmedNoQrCodes: true,
    ...overrides,
  }
}

function pageHandler(accountScope = 'acct-1') {
  return (request: RawRequest): DirectPublishPageResult => {
    if (request.op === 'account') return { ok: true, op: 'account', status: 'account', accountScope }
    if (request.op === 'prepare') {
      return {
        ok: true,
        op: 'prepare',
        status: 'prepared',
        payload: { base: true },
        draft: makeDraft() as unknown as Record<string, unknown>,
        propertyCards: PROPERTY_CARDS,
        rawCards: JSON.parse(JSON.stringify(RAW_CARDS)) as unknown[],
        accountScope,
        itemCount: UPLOADED_IMAGES.length,
        catId: '50000000',
        warnings: [],
      }
    }
    if (request.op === 'submit') return { ok: true, op: 'submit', status: 'published', itemId: '1087000000001' }
    if (request.op === 'publish') return { ok: true, op: 'publish', status: 'published', itemId: 'legacy' }
    return { ok: false, op: request.op, status: 'unknown', code: 'UNKNOWN', message: 'x' }
  }
}

interface Env {
  storage: ReturnType<typeof createStorage>
  session: SessionHarness
  tabs: ReturnType<typeof createTabs>
  scripting: ReturnType<typeof createScripting>
}

function makeEnv(options: { session?: SessionHarness; storage?: ReturnType<typeof createStorage> } = {}): Env {
  return {
    storage: options.storage ?? createStorage(),
    session: options.session ?? createSession(),
    tabs: createTabs(),
    scripting: createScripting(pageHandler()),
  }
}

/** 组装 API；`withSession: false` 模拟旧 mock / 无会话能力环境。 */
function apiFor(env: Env, options: { now?: () => number; prepareTtlMs?: number; withSession?: boolean } = {}): DirectPublishApi {
  const storage: DirectPublishChromeSubset['storage'] =
    options.withSession === false
      ? { local: env.storage.local }
      : { local: env.storage.local, session: env.session.api }
  const chrome: DirectPublishChromeSubset = { tabs: env.tabs.api, scripting: env.scripting.api, storage }
  return createDirectPublishApi({
    chrome,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.prepareTtlMs === undefined ? {} : { prepareTtlMs: options.prepareTtlMs }),
  })
}

/** 模拟 MV3 service worker 重启：新 API 实例（内存清空），共享同一 storage.local / session。 */
const restart = (env: Env, options: { now?: () => number } = {}): DirectPublishApi => apiFor(env, options)

const countOp = (env: Env, op: string): number => env.scripting.calls.filter((call) => call.op === op).length

async function prepareOk(api: DirectPublishApi, request = makePrepareRequest()) {
  const result = await api.prepare!(request)
  assert.equal(result.status, 'prepared', JSON.stringify(result))
  assert.ok(result.prepareToken)
  return result
}

function submitBody(token: string, draft: DirectPublishReviewDraft = makeDraft()): DirectPublishSubmitRequest {
  return { prepareToken: token, draft, confirm: true }
}

// ==================== 假设 1：SW 内存丢失（主 bug） ====================

test('H1 复现：prepare → SW 重启 → submit 同 token 必须成功（session 恢复）', async () => {
  const env = makeEnv()
  const first = apiFor(env)
  const prepared = await prepareOk(first)
  const token = prepared.prepareToken as string

  // 重启：新实例内存为空，但共享 storage.session。
  const restarted = restart(env)
  const result = await restarted.submit!(submitBody(token))

  assert.equal(result.status, 'published', JSON.stringify(result))
  assert.equal(result.itemId, '1087000000001')
  // 真正注入 submit（恢复成功才会进入页面提交）
  assert.equal(countOp(env, 'submit'), 1)
})

test('H1 佐证：session 索引使重启后同 key 重新 prepare 复用同一 token（不重复上传）', async () => {
  const env = makeEnv()
  const first = apiFor(env)
  const a = await prepareOk(first)

  const restarted = restart(env)
  const b = await restarted.prepare!(makePrepareRequest())

  assert.equal(b.status, 'prepared')
  assert.equal(b.prepareToken, a.prepareToken)
  assert.equal(countOp(env, 'prepare'), 1)
})

test('H1 佐证：session 中的无标题 draft（title 可选）可恢复并 submit，不因缺 title 失败', async () => {
  const env = makeEnv()
  const storedDraft = { ...makeDraft() } as Record<string, unknown>
  delete storedDraft.title
  await env.session.api.set({
    [DIRECT_PUBLISH_PREPARED_SESSION_KEY]: {
      version: 1,
      entries: {
        dpp_no_title: {
          token: 'dpp_no_title',
          accountScope: 'acct-1',
          idempotencyKey: 'key-1',
          inputFingerprint: 'fp',
          createdAt: Date.now(),
          tabId: 77,
          draft: storedDraft,
          images: JSON.parse(JSON.stringify(UPLOADED_IMAGES)) as Array<Record<string, unknown>>,
          propertyCards: JSON.parse(JSON.stringify(PROPERTY_CARDS)) as unknown[],
          rawCards: JSON.parse(JSON.stringify(RAW_CARDS)) as unknown[],
          services: [{ serviceCode: 'AI_SALE', enable: false }],
          address: { ...ADDRESS },
        },
      },
      byKey: { 'acct-1::key-1': 'dpp_no_title' },
    },
  })
  const api = apiFor(env)

  // 提交时 draft 也**不带 title**（描述模式无独立标题）→ 仍可成功；旧 title 不再被校验 / 使用。
  const submitDraft = { ...makeDraft() } as Record<string, unknown>
  delete submitDraft.title
  const result = await api.submit!(submitBody('dpp_no_title', submitDraft as unknown as DirectPublishReviewDraft))

  assert.equal(result.status, 'published', JSON.stringify(result))
  assert.equal(result.itemId, '1087000000001')
})

test('H1 佐证：旧 mock（无 storage.session）重启仍是内存路径 → PREPARE_EXPIRED（保持兼容）', async () => {
  const env = makeEnv()
  const first = apiFor(env, { withSession: false })
  const prepared = await prepareOk(first)

  const restarted = apiFor(env, { withSession: false })
  const result = await restarted.submit!(submitBody(prepared.prepareToken as string))

  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'PREPARE_EXPIRED')
  assert.equal(countOp(env, 'submit'), 0)
})

// ==================== 假设 2：30 分钟 TTL ====================

test('H2 对照：session 中未超过 TTL（25 分钟）的 prepared 仍可恢复', async () => {
  let clock = 1_000_000
  const now = () => clock
  const env = makeEnv()
  const first = apiFor(env, { now })
  const prepared = await prepareOk(first)

  clock += 25 * 60 * 1000
  const restarted = restart(env, { now })
  const result = await restarted.submit!(submitBody(prepared.prepareToken as string))
  assert.equal(result.status, 'published')
})

test('H2 证实：超过 TTL（30 分钟）→ PREPARE_EXPIRED，不注入 submit', async () => {
  let clock = 1_000_000
  const now = () => clock
  const env = makeEnv()
  const first = apiFor(env, { now })
  const prepared = await prepareOk(first)

  clock += 30 * 60 * 1000 + 1
  const restarted = restart(env, { now })
  const result = await restarted.submit!(submitBody(prepared.prepareToken as string))

  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'PREPARE_EXPIRED')
  assert.equal(countOp(env, 'submit'), 0)
})

// ==================== 假设 3：已 consume（重复提交） ====================

test('H3 证实：同一 token 二次提交 → SUBMIT_DUPLICATE，只真正提交一次', async () => {
  const env = makeEnv()
  const api = apiFor(env)
  const prepared = await prepareOk(api)
  const token = prepared.prepareToken as string

  const first = await api.submit!(submitBody(token))
  assert.equal(first.status, 'published')

  const second = await api.submit!(submitBody(token))
  assert.equal(second.status, 'rejected')
  assert.equal(second.code, 'SUBMIT_DUPLICATE')
  assert.equal(countOp(env, 'submit'), 1)
})

test('分类：session 中不存在的 token → PREPARE_NOT_FOUND（区别于已过期 / 已消耗）', async () => {
  const env = makeEnv()
  const api = apiFor(env)
  const result = await api.submit!(submitBody('dpp_never-prepared'))

  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'PREPARE_NOT_FOUND')
  assert.equal(countOp(env, 'submit'), 0)
})

// ==================== fail-closed 与 schema 校验 ====================

test('fail-closed：prepare 成功后 session 写入失败 → PREPARE_STORAGE_UNAVAILABLE 且不返回 token', async () => {
  const env = makeEnv()
  env.session.state.failSet = true
  const api = apiFor(env)

  const result = await api.prepare!(makePrepareRequest())

  assert.equal(result.status, 'unknown')
  assert.equal(result.code, 'PREPARE_STORAGE_UNAVAILABLE')
  assert.equal(result.prepareToken, undefined)
  assert.equal(countOp(env, 'prepare'), 1)
  assert.equal(countOp(env, 'submit'), 0)
})

test('fail-closed：session 根结构损坏（版本不支持）→ submit 拒绝，不注入 submit', async () => {
  const env = makeEnv()
  await env.session.api.set({ [DIRECT_PUBLISH_PREPARED_SESSION_KEY]: { version: 2, entries: {}, byKey: {} } })
  const api = apiFor(env)

  const result = await api.submit!(submitBody('dpp_whatever'))

  assert.equal(result.status, 'unknown')
  assert.equal(result.code, 'PREPARE_STORAGE_UNAVAILABLE')
  assert.equal(countOp(env, 'submit'), 0)
})

test('fail-closed：session 条目缺关键数据（缺 propertyCards）→ 拒绝，绝不使用前端伪造 candidate', async () => {
  const env = makeEnv()
  await env.session.api.set({
    [DIRECT_PUBLISH_PREPARED_SESSION_KEY]: {
      version: 1,
      entries: {
        dpp_x: {
          token: 'dpp_x',
          accountScope: 'acct-1',
          idempotencyKey: 'key-1',
          inputFingerprint: 'fp',
          createdAt: 1,
          tabId: 77,
          draft: {},
          images: [],
          rawCards: [],
          services: [],
          address: {},
        },
      },
      byKey: {},
    },
  })
  const api = apiFor(env)

  const result = await api.submit!(submitBody('dpp_x'))

  assert.equal(result.status, 'unknown')
  assert.equal(result.code, 'PREPARE_STORAGE_UNAVAILABLE')
  assert.equal(countOp(env, 'submit'), 0)
})

// ==================== 隐私与容量 ====================

test('隐私：prepared 只落 session（非落盘），storage.local 不出现个人地址 / 正文', async () => {
  const env = makeEnv()
  const api = apiFor(env)
  const prepared = await prepareOk(api)

  // prepare 阶段不写 local（审计只由 submit 写）。
  assert.deepEqual(Object.keys(env.storage.snapshot()), [])
  const store = env.session.snapshot()[DIRECT_PUBLISH_PREPARED_SESSION_KEY] as { version: number; entries: Record<string, unknown> }
  assert.equal(store.version, 1)
  assert.equal(Object.keys(store.entries).length, 1)

  const submitted = await api.submit!(submitBody(prepared.prepareToken as string))
  assert.equal(submitted.status, 'published')
  // 落盘仅审计（脱敏），绝不含个人地址 / 正文。
  assert.deepEqual(Object.keys(env.storage.snapshot()), [DIRECT_PUBLISH_AUDIT_STORAGE_KEY])
  const localText = JSON.stringify(env.storage.snapshot())
  assert.ok(!localText.includes('测试发货点'))
  assert.ok(!localText.includes('原始描述'))
  // token 已消耗：session 中条目清空，仅保留 consumed 记录（用于区分重复提交）。
  const after = env.session.snapshot()[DIRECT_PUBLISH_PREPARED_SESSION_KEY] as { entries: Record<string, unknown>; consumed: Record<string, number> }
  assert.equal(Object.keys(after.entries).length, 0)
  assert.ok(prepared.prepareToken! in after.consumed)
})

test('容量：prepared 会话条目上限 50，超限按最旧淘汰（保护 10MB 配额）', async () => {
  const env = makeEnv()
  const api = apiFor(env)
  let firstToken = ''
  for (let i = 0; i < 55; i += 1) {
    const result = await api.prepare!(makePrepareRequest({ idempotencyKey: `key-${i}` }))
    assert.equal(result.status, 'prepared')
    if (i === 0) firstToken = result.prepareToken as string
  }
  const store = env.session.snapshot()[DIRECT_PUBLISH_PREPARED_SESSION_KEY] as { entries: Record<string, unknown> }
  assert.equal(Object.keys(store.entries).length, 50)
  assert.equal(firstToken in store.entries, false)

  // 被淘汰的 token 在重启后不可恢复（session 权威），且绝不误用其它条目。
  const restarted = restart(env)
  const result = await restarted.submit!(submitBody(firstToken))
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'PREPARE_NOT_FOUND')
})

// ==================== 真实接线 ====================

test('真实接线：透传 storage.session 并显式限定 TRUSTED_CONTEXTS（绝不扩到 content）', () => {
  const accessLevels: string[] = []
  const env = makeEnv()
  ;(globalThis as { chrome?: unknown }).chrome = {
    tabs: env.tabs.api,
    scripting: env.scripting.api,
    storage: {
      local: env.storage.local,
      session: {
        get: env.session.api.get,
        set: env.session.api.set,
        setAccessLevel: (options: { accessLevel: string }) => {
          accessLevels.push(options.accessLevel)
          return Promise.resolve()
        },
      },
    },
  }
  try {
    const api = createChromeDirectPublishApi()
    assert.ok(api)
    assert.deepEqual(accessLevels, ['TRUSTED_CONTEXTS'])
  } finally {
    delete (globalThis as { chrome?: unknown }).chrome
  }
})
