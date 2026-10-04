/**
 * 业务拒绝（`FAIL_BIZ_*`）恢复回归。
 *
 * 真实用户 bug：最终发布阶段被服务端**明确业务拒绝**（旧独立标题模式下如标题超 30 字
 * `FAIL_BIZ_TITLE_LENGTH_TOO_LONG`）时，旧实现把所有 `mtop.request` reject 一律
 * 归为 `PUBLISH_NETWORK_UNKNOWN`（unknown），前端据此弹「结果未知」并锁死，
 * 无法修改草稿后重试。
 *
 * 注意：此前真实的 30 字错误源自**旧独立标题模式**；两阶段已切换为官方统一描述模式
 * （`itemTextDTO = { desc, title: desc, titleDescSeparate: false }`，无独立标题），
 * 不再触发该 30 字限制。下方 `FAIL_BIZ_TITLE_LENGTH_TOO_LONG` 仅保留为**页面层业务拒绝分类**
 * 回归（代码分类通用，服务端仍可能返回其它 `FAIL_BIZ_*`）。
 *
 * 本文件验证两点：
 * 1. 页面层：SDK reject 带结构 `ret:['FAIL_BIZ_*::msg']`（或受控 `[FAIL_BIZ_*]` 文案）
 *    必须分类为 `rejected`；真正 timeout / network 仍保持 `unknown`；普通含 business
 *    字样的自由文案不得误判。
 * 2. 后台层：明确业务拒绝且审计已持久化后，恢复已 consume 的 prepareToken（清 consumed
 *    标识、保留权威 candidate 与已上传图，不重复 prepare），允许改稿后同 token 重提；
 *    unknown / 审计写失败 / 恢复失败一律 fail-closed，不假装可重试。
 *
 * **全部使用 mock（vm 隔离上下文 / mock chrome），不创建真实 tab、不访问真实网络、不实际发布。**
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import {
  DIRECT_PUBLISH_PREPARED_SESSION_KEY,
  createDirectPublishApi,
  type DirectPublishApi,
  type DirectPublishChromeSubset,
  type DirectPublishScriptingApi,
  type DirectPublishStorageLocalApi,
  type DirectPublishStorageSessionApi,
  type DirectPublishTabsApi,
} from '../../background/direct-publish-api'
import { injectDirectPublishInPage } from '../../background/direct-publish-page'
import type { DirectPublishPageResult } from '../../background/direct-publish-page'
import type {
  DirectPublishPrepareRequest,
  DirectPublishReviewDraft,
  DirectPublishSubmitRequest,
} from '../../../../shared/types/direct-publish'

// ==================== 页面层（vm 真实 opSubmit / opPublish） ====================

interface MtopCall {
  api: string
  data: Record<string, unknown>
}

interface PageRunResult {
  result: { status?: string; code?: string; message?: string; [k: string]: unknown }
  calls: MtopCall[]
}

/** 在隔离 vm 上下文运行真实 `injectDirectPublishInPage`；`mtop` 可返回普通对象，也可 throw（模拟 SDK reject）。 */
async function runPage(request: unknown, mtop: (call: MtopCall) => unknown): Promise<PageRunResult> {
  const calls: MtopCall[] = []
  const mtopRequest = async (options: { api: string; data?: Record<string, unknown> }) => {
    const call: MtopCall = { api: options.api, data: (options.data ?? {}) as Record<string, unknown> }
    calls.push(call)
    return mtop(call)
  }
  const windowObj: Record<string, unknown> = {
    location: { hostname: 'www.goofish.com' },
    document: { cookie: 'unb=user-1' },
    g_config: { syncUser: { userId: 'user-1' } },
    lib: { mtop: { request: mtopRequest } },
    crypto,
    URL,
    TextEncoder,
    setTimeout,
    clearTimeout,
    AbortController,
    fetch: async () => ({ ok: true, status: 200, blob: async () => ({ size: 10, type: 'image/jpeg' }) }),
  }
  const context = vm.createContext({ window: windowObj, console: { info() {}, warn() {} }, ...windowObj })
  const result = (await vm.runInContext(
    `(${injectDirectPublishInPage.toString()})(${JSON.stringify(request)})`,
    context,
  )) as PageRunResult['result']
  return { result, calls }
}

const SELLER_ADDRESS = {
  prov: '浙江省',
  city: '杭州市',
  area: '西湖区',
  divisionId: '330106',
  poiName: '测试发货点',
  poiId: 'poi-1',
  gps: '30.10,120.20',
}

function submitPageRequest(services: Array<{ serviceCode: string; enable: boolean }> = []) {
  return {
    op: 'submit',
    submitCore: {
      title: '标题',
      description: '描述',
      priceYuan: '10',
      specifications: [],
      itemCatDTO: { catId: 'c1', catName: '手机', channelCatId: 'c1', leafId: '0', tbCatId: '' },
      itemLabelExtList: [],
      itemAddrDTO: { ...SELLER_ADDRESS },
      imageInfoDOList: [
        { url: 'https://upload.example.com/1.jpg', widthSize: 100, heightSize: 100, major: true, status: 'done', type: 0, isQrCode: false, extraInfo: {} },
      ],
      services,
    },
    rawCards: [],
  }
}

/** submit / publish 前置阶段的 SUCCESS mock，仅在最终 publish 处按 `final` 行为返回或抛出。 */
function publishDispatcher(final: () => unknown) {
  return (call: MtopCall): unknown => {
    switch (call.api) {
      case 'mtop.idle.pc.idleitem.prepublish.check':
        return { ret: ['SUCCESS::ok'], data: {} }
      case 'mtop.taobao.idleitem.badwords.prepubcheck':
        return { ret: ['SUCCESS::ok'], data: { forbidPublish: false } }
      case 'mtop.idle.item.publish.service.cards.list':
        return { ret: ['SUCCESS::ok'], data: { services: [] } }
      case 'mtop.idle.pc.idleitem.publish':
        return final()
      default:
        return { ret: ['FAIL_SYS_UNKNOWN::未 mock 的接口 ' + call.api] }
    }
  }
}

test('页面 submit：SDK reject 结构 ret FAIL_BIZ_TITLE_LENGTH_TOO_LONG → rejected（不锁 unknown）', async () => {
  const { result } = await runPage(
    submitPageRequest(),
    publishDispatcher(() => {
      throw { ret: ['FAIL_BIZ_TITLE_LENGTH_TOO_LONG::标题不能超过30个字'] }
    }),
  )
  assert.equal(result.status, 'rejected', JSON.stringify(result))
  assert.equal(result.code, 'FAIL_BIZ_TITLE_LENGTH_TOO_LONG')
})

test('页面 submit：受控 `[FAIL_BIZ_*]` 文案（无结构）可解析为 rejected', async () => {
  const { result } = await runPage(
    submitPageRequest(),
    publishDispatcher(() => {
      throw new Error('[FAIL_BIZ_TITLE_LENGTH_TOO_LONG] 标题不能超过30个字')
    }),
  )
  assert.equal(result.status, 'rejected', JSON.stringify(result))
  assert.equal(result.code, 'FAIL_BIZ_TITLE_LENGTH_TOO_LONG')
})

test('页面 submit：真正 timeout / 网络异常仍为 unknown（禁止自动重试）', async () => {
  const timeout = await runPage(
    submitPageRequest(),
    publishDispatcher(() => {
      throw new Error('request timeout')
    }),
  )
  assert.equal(timeout.result.status, 'unknown')
  assert.equal(timeout.result.code, 'PUBLISH_TIMEOUT')

  const network = await runPage(
    submitPageRequest(),
    publishDispatcher(() => {
      throw { ret: ['FAIL_SYS_NETWORK_ERROR::网络异常'] }
    }),
  )
  assert.equal(network.result.status, 'unknown')
  assert.equal(network.result.code, 'PUBLISH_NETWORK_UNKNOWN')
})

test('页面 submit：仅含 business 字样的自由文案不得误判为 rejected', async () => {
  const { result } = await runPage(
    submitPageRequest(),
    publishDispatcher(() => {
      throw new Error('business rules broken without a biz code')
    }),
  )
  assert.equal(result.status, 'unknown', JSON.stringify(result))
  assert.equal(result.code, 'PUBLISH_NETWORK_UNKNOWN')
})

test('页面 publish（旧一步式）：FAIL_BIZ 结构 reject 同样归 rejected', async () => {
  const { result } = await runPage(
    { op: 'publish', preparedPayload: { base: true } },
    publishDispatcher(() => {
      throw { ret: ['FAIL_BIZ_TITLE_LENGTH_TOO_LONG::标题不能超过30个字'] }
    }),
  )
  assert.equal(result.status, 'rejected', JSON.stringify(result))
  assert.equal(result.code, 'FAIL_BIZ_TITLE_LENGTH_TOO_LONG')
})

// ==================== 后台层（恢复 prepareToken） ====================

function createLocalStorage(initial: Record<string, unknown> = {}, failSetAt: number[] = []) {
  const map = new Map<string, unknown>(Object.entries(initial))
  let setCount = 0
  const local: DirectPublishStorageLocalApi = {
    async get(keys) {
      if (keys === undefined || keys === null) return Object.fromEntries(map)
      if (typeof keys === 'string') return map.has(keys) ? { [keys]: map.get(keys) } : {}
      const out: Record<string, unknown> = {}
      for (const key of keys) if (map.has(key)) out[key] = map.get(key)
      return out
    },
    async set(items) {
      const index = setCount
      setCount += 1
      if (failSetAt.includes(index)) throw new Error('local write failed')
      for (const [key, value] of Object.entries(items)) map.set(key, value)
    },
  }
  return { local, snapshot: () => Object.fromEntries(map) }
}

interface SessionHarness {
  api: DirectPublishStorageSessionApi
  snapshot(): Record<string, unknown>
}

function createSession(initial: Record<string, unknown> = {}): SessionHarness {
  const map = new Map<string, unknown>(Object.entries(initial))
  const api: DirectPublishStorageSessionApi = {
    async get(keys) {
      if (keys === undefined || keys === null) return Object.fromEntries(map)
      if (typeof keys === 'string') return map.has(keys) ? { [keys]: map.get(keys) } : {}
      const out: Record<string, unknown> = {}
      for (const key of keys) if (map.has(key)) out[key] = map.get(key)
      return out
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value))
    },
  }
  return { api, snapshot: () => Object.fromEntries(map) }
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

function makeDraft(overrides: Partial<DirectPublishReviewDraft> = {}): DirectPublishReviewDraft {
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
    ...overrides,
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

interface Env {
  storage: ReturnType<typeof createLocalStorage>
  session: SessionHarness
  tabs: ReturnType<typeof createTabs>
  scripting: ReturnType<typeof createScripting>
}

/** 组装 env；`submit` 行为由 `submitHandler` 决定（便于模拟拒绝 / 未知 / 成功）。 */
function makeEnv(
  submitHandler: (request: RawRequest) => DirectPublishPageResult,
  options: { failSetAt?: number[] } = {},
): Env {
  const storage = createLocalStorage({}, options.failSetAt ?? [])
  const session = createSession()
  const tabs = createTabs()
  const scripting = createScripting((request) => {
    if (request.op === 'account') return { ok: true, op: 'account', status: 'account', accountScope: 'acct-1' }
    if (request.op === 'prepare') {
      return {
        ok: true,
        op: 'prepare',
        status: 'prepared',
        payload: { base: true },
        draft: makeDraft() as unknown as Record<string, unknown>,
        propertyCards: PROPERTY_CARDS,
        rawCards: JSON.parse(JSON.stringify(RAW_CARDS)) as unknown[],
        accountScope: 'acct-1',
        itemCount: UPLOADED_IMAGES.length,
        catId: '50000000',
        warnings: [],
      }
    }
    if (request.op === 'submit') return submitHandler(request)
    return { ok: false, op: request.op, status: 'unknown', code: 'UNKNOWN', message: 'x' }
  })
  return { storage, session, tabs, scripting }
}

function apiFor(env: Env): DirectPublishApi {
  const chrome: DirectPublishChromeSubset = {
    tabs: env.tabs.api,
    scripting: env.scripting.api,
    storage: { local: env.storage.local, session: env.session.api },
  }
  return createDirectPublishApi({ chrome })
}

/** 模拟 MV3 service worker 重启：新 API 实例（内存清空），共享同一 storage.local / session。 */
const restart = (env: Env): DirectPublishApi => apiFor(env)

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

type SubmitResultWithFlags = { retryable?: boolean; prepareTokenValid?: boolean }

const REJECT_RESULT: DirectPublishPageResult = {
  ok: false,
  op: 'submit',
  status: 'rejected',
  code: 'FAIL_BIZ_TITLE_LENGTH_TOO_LONG',
  message: '标题不能超过30个字',
}

const PUBLISHED_RESULT: DirectPublishPageResult = { ok: true, op: 'submit', status: 'published', itemId: '1087000000001' }

/** 读取 session prepared 存储（断言 consumed 是否被恢复）。 */
function readPreparedStore(env: Env): { entries: Record<string, unknown>; byKey: Record<string, string>; consumed: Record<string, number> } {
  const snapshot = env.session.snapshot() as Record<string, { entries: Record<string, unknown>; byKey: Record<string, string>; consumed: Record<string, number> }>
  return snapshot[DIRECT_PUBLISH_PREPARED_SESSION_KEY]
}

test('恢复：业务拒绝 → 后台新实例 + 改稿同 token → published，且不重复 prepare 上传', async () => {
  let outcome: DirectPublishPageResult = REJECT_RESULT
  const env = makeEnv(() => outcome)

  const first = apiFor(env)
  const prepared = await prepareOk(first)
  const token = prepared.prepareToken as string

  const rejected = await first.submit!(submitBody(token))
  assert.equal(rejected.status, 'rejected', JSON.stringify(rejected))
  assert.equal(rejected.code, 'FAIL_BIZ_TITLE_LENGTH_TOO_LONG')
  assert.equal((rejected as SubmitResultWithFlags).retryable, true)
  assert.equal((rejected as SubmitResultWithFlags).prepareTokenValid, true)
  // token 已恢复：entries 含 token、consumed 已清空。
  const store = readPreparedStore(env)
  assert.ok(store.entries[token], '恢复后 entries 应含该 token')
  assert.equal(store.consumed[token], undefined, '恢复后 consumed 应清空')

  // SW 重启（新实例，共享 session）+ 改稿（描述变化 → 新 fingerprint）→ 同 token 成功。
  outcome = PUBLISHED_RESULT
  const restarted = restart(env)
  const published = await restarted.submit!(submitBody(token, makeDraft({ description: '改名后的描述' })))
  assert.equal(published.status, 'published', JSON.stringify(published))

  // 未重复 prepare（权威 candidate 与已上传图沿用，图片上传只发生一次）。
  assert.equal(countOp(env, 'prepare'), 1)
  assert.equal(countOp(env, 'submit'), 2)
})

test('恢复：unknown 结果不恢复 token（同 token 二次提交 → SUBMIT_DUPLICATE）', async () => {
  const env = makeEnv(() => ({ ok: false, op: 'submit', status: 'unknown', code: 'PUBLISH_NETWORK_UNKNOWN', message: '结果未知' }))
  const api = apiFor(env)
  const prepared = await prepareOk(api)
  const token = prepared.prepareToken as string

  const first = await api.submit!(submitBody(token))
  assert.equal(first.status, 'unknown')
  assert.equal((first as SubmitResultWithFlags).prepareTokenValid, false)
  assert.equal(readPreparedStore(env).consumed[token] !== undefined, true, 'unknown 不应清 consumed')

  const second = await api.submit!(submitBody(token))
  assert.equal(second.status, 'rejected')
  assert.equal(second.code, 'SUBMIT_DUPLICATE')
  assert.equal(countOp(env, 'submit'), 1)
})

test('恢复：连续两次业务拒绝都可恢复（可反复改稿重试）', async () => {
  const env = makeEnv(() => REJECT_RESULT)
  const api = apiFor(env)
  const prepared = await prepareOk(api)
  const token = prepared.prepareToken as string

  const first = await api.submit!(submitBody(token))
  assert.equal(first.status, 'rejected')
  assert.equal((first as SubmitResultWithFlags).retryable, true)

  const second = await api.submit!(submitBody(token, makeDraft({ description: '改一次的描述' })))
  assert.equal(second.status, 'rejected')
  assert.equal((second as SubmitResultWithFlags).retryable, true)
  assert.equal(readPreparedStore(env).entries[token] !== undefined, true)
})

test('fail-closed：审计 rejected 写入失败时不恢复 token，返回 unknown', async () => {
  // local.set 第 0 次为 attempting（成功），第 1 次为最终 rejected（失败）。
  const env = makeEnv(() => REJECT_RESULT, { failSetAt: [1] })
  const api = apiFor(env)
  const prepared = await prepareOk(api)
  const token = prepared.prepareToken as string

  const result = await api.submit!(submitBody(token))
  assert.equal(result.status, 'unknown', JSON.stringify(result))
  assert.equal(result.code, 'REJECT_RESTORE_UNAVAILABLE')
  assert.equal((result as SubmitResultWithFlags).prepareTokenValid, false)
  assert.equal(readPreparedStore(env).entries[token], undefined, '审计失败不得恢复 token')
  assert.equal(readPreparedStore(env).consumed[token] !== undefined, true, 'token 应保持已消耗')

  const second = await api.submit!(submitBody(token, makeDraft({ description: '再试的描述' })))
  assert.equal(second.status, 'rejected')
  assert.equal(second.code, 'SUBMIT_DUPLICATE')
})

test('预检：最终描述（含规格拼接）超过上限在 consume 前被拒（DRAFT_DESCRIPTION_INVALID），token 仍可复用', async () => {
  const env = makeEnv(() => PUBLISHED_RESULT)
  const api = apiFor(env)
  const prepared = await prepareOk(api)
  const token = prepared.prepareToken as string

  // 描述模式无独立标题：改以「描述 + 规格追加」的最终长度校验（上限 5000 字），不再用旧独立标题 30 字阈值。
  const tooLong = await api.submit!(submitBody(token, makeDraft({ description: '描'.repeat(5001) })))
  assert.equal(tooLong.status, 'rejected')
  assert.equal(tooLong.code, 'DRAFT_DESCRIPTION_INVALID')
  // 校验拒绝发生在 consume 之前：token 未被消耗，改短后可直接重提。
  assert.equal(countOp(env, 'submit'), 0)

  const ok = await api.submit!(submitBody(token, makeDraft({ description: '描'.repeat(30) })))
  assert.equal(ok.status, 'published')
})
