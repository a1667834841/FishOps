/**
 * 直接接口发布「两阶段」后台（prepare / submit）单测。
 *
 * 覆盖：
 * - prepare 跑完准备链路但**绝不 publish**，返回 token + 完整 draft + 候选卡，不写审计；
 * - submit 严格运行时校验草稿（未知字段 / 非候选类目属性 / 伪造图片 / 未知服务一律拒绝）；
 * - 修改后的 draft 真正传入页面（title/描述/价格/规格/图片重排）；
 * - 缺 confirm / token、未知 token（SW 重启）、重复提交、未知锁定、幂等复用；
 * - 账号漂移阻断、提交前违禁词复检拒绝、并发提交锁；
 * - 消息监听 prepare/submit 的 ok 语义。
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
  type DirectPublishScriptingApi,
  type DirectPublishStorageLocalApi,
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

function createTabs(): { api: DirectPublishTabsApi; created: Array<{ url: string; active: boolean }> } {
  const created: Array<{ url: string; active: boolean }> = []
  let nextId = 1000
  const api: DirectPublishTabsApi = {
    async query() {
      return [{ id: 77, url: 'https://www.goofish.com/publish?fishopsDirectPublish=1', status: 'complete', active: false }]
    },
    async create(props) {
      created.push({ url: props.url, active: props.active })
      return { id: nextId++, url: props.url, status: 'complete', active: props.active }
    },
    async get(tabId) {
      return { id: tabId, url: 'https://www.goofish.com/publish?fishopsDirectPublish=1', status: 'complete', active: false }
    },
    onRemoved: { addListener() {} },
  }
  return { api, created }
}

function createScripting(handler: (request: { op: string; [k: string]: unknown }) => DirectPublishPageResult | Promise<DirectPublishPageResult>) {
  const calls: Array<{ op: string; [k: string]: unknown }> = []
  const api: DirectPublishScriptingApi = {
    async executeScript<T>(injection: { args: unknown[] }) {
      const request = injection.args[0] as { op: string; [k: string]: unknown }
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
  { extraInfo: { isH: 'false', isT: 'false', raw: 'false' }, isQrCode: false, url: 'https://img.example.com/u2.jpg', heightSize: 200, widthSize: 200, major: false, type: 0, status: 'done' },
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
      { valueId: '50000001', valueName: '电脑', transportData: { channelCateId: '50000001' }, isCategory: true, catId: '50000001', channelCatId: '50000001', catName: '电脑', leafId: '0', tbCatId: '5002' },
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
    values: [
      { valueId: 'brand-a', valueName: 'UR', transportData: { brandId: 'brand-a' }, isCategory: false },
      { valueId: 'brand-b', valueName: 'ZARA', transportData: { brandId: 'brand-b' }, isCategory: false },
    ],
  },
]

const RAW_CARDS = [
  { cardType: '20401', cardData: { propertyId: '-10000', propertyName: '分类', valuesList: [
    { valueId: '50000000', channelCatId: '50000000', catId: '50000000', catName: '手机', isClicked: '1' },
    { valueId: '50000001', channelCatId: '50000001', catId: '50000001', catName: '电脑', isClicked: '0' },
  ] } },
  { cardType: '20401', cardData: { propertyId: '20000', propertyName: '品牌', valuesList: [
    { valueId: 'brand-a', valueName: 'UR', isClicked: '1' },
    { valueId: 'brand-b', valueName: 'ZARA', isClicked: '0' },
  ] } },
]

function makeDraft(): DirectPublishReviewDraft {
  return {
    title: '测试标题',
    description: '原始描述',
    price: '34',
    specifications: [{ name: '尺码', value: 'M' }],
    category: { catId: '50000000', catName: '手机', channelCatId: '50000000', leafId: '0', tbCatId: '5001' },
    attributes: [
      { propertyId: '-10000', propertyName: '分类', valueId: '50000000', valueName: '手机', transportData: { channelCateId: '50000000' }, text: '手机' },
      { propertyId: '20000', propertyName: '品牌', valueId: 'brand-a', valueName: 'UR', transportData: { brandId: 'brand-a' }, text: 'UR' },
    ],
    address: { ...ADDRESS },
    images: UPLOADED_IMAGES.map((image) => JSON.parse(JSON.stringify(image)) as Record<string, unknown>),
    services: [
      { serviceCode: 'SERVICE_A', enable: false },
      { serviceCode: 'AI_SALE', enable: false },
    ],
  }
}

function makePrepareRequest(overrides: Partial<DirectPublishPrepareRequest> = {}): DirectPublishPrepareRequest {
  return {
    source: { itemId: '1001', imageIndexes: [0, 1] },
    idempotencyKey: 'key-1',
    seller: { address: { ...ADDRESS } },
    confirmedNoQrCodes: true,
    ...overrides,
  }
}

interface PageState {
  accountScope: string
  submitStatus?: 'published' | 'rejected' | 'unknown' | 'action_required'
  submitCode?: string
  submitMessage?: string
}

function pageHandler(state: PageState) {
  return (request: { op: string; [k: string]: unknown }): DirectPublishPageResult => {
    if (request.op === 'account') {
      return { ok: true, op: 'account', status: 'account', accountScope: state.accountScope }
    }
    if (request.op === 'prepare') {
      return {
        ok: true,
        op: 'prepare',
        status: 'prepared',
        payload: { base: true },
        draft: makeDraft() as unknown as Record<string, unknown>,
        propertyCards: PROPERTY_CARDS,
        rawCards: JSON.parse(JSON.stringify(RAW_CARDS)) as unknown[],
        accountScope: state.accountScope,
        itemCount: UPLOADED_IMAGES.length,
        catId: '50000000',
        warnings: ['推荐类目与属性由接口自动识别，需人工核对，不保证精准配置'],
      }
    }
    if (request.op === 'submit') {
      const status = state.submitStatus ?? 'published'
      if (status === 'published') return { ok: true, op: 'submit', status: 'published', itemId: '1087000000001' }
      if (status === 'unknown') {
        return { ok: false, op: 'submit', status: 'unknown', code: state.submitCode ?? 'PUBLISH_TIMEOUT', message: state.submitMessage ?? '超时' }
      }
      if (status === 'action_required') {
        return { ok: false, op: 'submit', status: 'action_required', actionRequired: 'captcha', code: state.submitCode ?? 'CAPTCHA_REQUIRED', message: state.submitMessage ?? '验证码' }
      }
      return { ok: false, op: 'submit', status: 'rejected', code: state.submitCode ?? 'BADWORDS_FORBIDDEN', message: state.submitMessage ?? '违禁词拦截' }
    }
    if (request.op === 'publish') return { ok: true, op: 'publish', status: 'published', itemId: 'legacy' }
    return { ok: false, op: request.op, status: 'unknown', code: 'UNKNOWN', message: 'x' }
  }
}

interface Harness {
  api: DirectPublishApi
  storage: ReturnType<typeof createStorage>
  tabs: ReturnType<typeof createTabs>
  scripting: ReturnType<typeof createScripting>
  state: PageState
}

function setup(
  state: PageState,
  options: {
    storage?: ReturnType<typeof createStorage>
    prepareTtlMs?: number
    now?: () => number
    handler?: (request: { op: string; [k: string]: unknown }) => DirectPublishPageResult | Promise<DirectPublishPageResult>
  } = {},
): Harness {
  const storage = options.storage ?? createStorage()
  const tabs = createTabs()
  const scripting = createScripting(options.handler ?? pageHandler(state))
  const chrome: DirectPublishChromeSubset = { tabs: tabs.api, scripting: scripting.api, storage: { local: storage.local } }
  const api = createDirectPublishApi({
    chrome,
    ...(options.prepareTtlMs === undefined ? {} : { prepareTtlMs: options.prepareTtlMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { api, storage, tabs, scripting, state }
}

const countOp = (harness: Harness, op: string): number =>
  harness.scripting.calls.filter((call) => call.op === op).length

const prepareOps = (harness: Harness, op: string) => harness.scripting.calls.find((call) => call.op === op)

/** 先 prepare 拿 token（断言成功）。 */
async function prepareOk(harness: Harness, request = makePrepareRequest()) {
  const result = await harness.api.prepare!(request)
  assert.equal(result.status, 'prepared', JSON.stringify(result))
  assert.ok(result.prepareToken)
  return result
}

function submitBody(token: string, overrides: Partial<DirectPublishSubmitRequest> = {}, draft?: unknown): DirectPublishSubmitRequest {
  return {
    prepareToken: token,
    draft: (draft ?? makeDraft()) as DirectPublishReviewDraft,
    confirm: true,
    ...overrides,
  }
}

// ==================== prepare ====================

test('prepare：跑完准备链路但绝不 publish/submit，返回 token + draft + 候选卡，且不写审计', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const result = await prepareOk(harness)

  assert.ok(result.prepareToken)
  assert.equal(result.draft?.description, '原始描述')
  assert.equal(result.draft?.price, '34')
  assert.ok(Array.isArray(result.propertyCards) && result.propertyCards.length > 0)
  // 只注入 account + prepare，绝不 publish/submit
  assert.deepEqual(harness.scripting.calls.map((call) => call.op), ['account', 'prepare'])
  // prepare 不写审计（避免污染后续 submit 的幂等判断）
  assert.equal(harness.storage.snapshot()[DIRECT_PUBLISH_AUDIT_STORAGE_KEY], undefined)
})

test('prepare：同 key 不同输入 → IDEMPOTENCY_KEY_CONFLICT，且不重复准备', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  await prepareOk(harness)
  const conflict = await harness.api.prepare!(makePrepareRequest({ source: { itemId: '9999' } }))
  assert.equal(conflict.status, 'rejected')
  assert.equal(conflict.code, 'IDEMPOTENCY_KEY_CONFLICT')
  assert.equal(countOp(harness, 'prepare'), 1)
})

test('prepare：同 key 顺序重复准备复用同一 token，只准备一次（不重复上传）', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const first = await prepareOk(harness)
  const second = await prepareOk(harness)
  assert.equal(second.prepareToken, first.prepareToken)
  assert.equal(countOp(harness, 'prepare'), 1)
})

test('prepare：同 key 并发准备串行化，只准备一次（锁内幂等）', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const [a, b] = await Promise.all([harness.api.prepare!(makePrepareRequest()), harness.api.prepare!(makePrepareRequest())])
  assert.equal(a.status, 'prepared')
  assert.equal(b.status, 'prepared')
  assert.equal(a.prepareToken, b.prepareToken)
  assert.equal(countOp(harness, 'prepare'), 1)
})

test('prepare：账号切换后同 key 不复用旧 token（按 accountScope 隔离，重新准备）', async () => {
  const state: PageState = { accountScope: 'acct-1' }
  const harness = setup(state)
  const first = await prepareOk(harness)

  state.accountScope = 'acct-2'
  const second = await prepareOk(harness)
  assert.notEqual(second.prepareToken, first.prepareToken)
  // 账号切换后重新准备（不返回上一账号的 token）
  assert.equal(countOp(harness, 'prepare'), 2)
})

test('prepare：两阶段不再要求 confirmedNoQrCodes（图片自动上传），缺省也能准备', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const result = await harness.api.prepare!(makePrepareRequest({ confirmedNoQrCodes: undefined }))
  assert.equal(result.status, 'prepared', JSON.stringify(result))
  assert.equal(countOp(harness, 'prepare'), 1)
})

test('prepare：未提供 seller 时自动取账号官方默认地址（page 请求 reviewMode=true 且不带 seller，不继承卖家地址）', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const result = await harness.api.prepare!(makePrepareRequest({ seller: undefined, confirmedNoQrCodes: undefined }))
  assert.equal(result.status, 'prepared', JSON.stringify(result))
  const prepareCall = prepareOps(harness, 'prepare')
  assert.equal(prepareCall?.reviewMode, true)
  assert.equal(prepareCall?.sellerAddress, null)
  assert.equal(prepareCall?.coordinates, null)
  // 地址来自页面默认 POI 结果（mock draft），不是请求中的 seller。
  assert.equal((result.draft?.address as Record<string, string> | undefined)?.poiId, 'poi-1')
})

test('缺字段不能 submit：prepare 缺地址 → 无 prepareToken（返回 partial draft + failureStage），无法提交', async () => {
  const partialDraft = {
    title: '标题',
    description: '描述',
    price: '10',
    specifications: [],
    category: {},
    attributes: [],
    address: {},
    images: [{ url: 'https://img.example.com/u1.jpg', pending: true }],
    services: [],
  }
  const handler = (request: { op: string; [k: string]: unknown }): DirectPublishPageResult => {
    if (request.op === 'account') return { ok: true, op: 'account', status: 'account', accountScope: 'acct-1' }
    if (request.op === 'prepare') {
      return {
        ok: false,
        op: 'prepare',
        status: 'rejected',
        code: 'ADDRESS_REQUIRED',
        message: '未取得账号默认发货地址（POI 候选为空）',
        failureStage: 'address',
        missingFields: ['address', 'poiId'],
        draft: partialDraft,
        warnings: [],
      }
    }
    return { ok: false, op: request.op, status: 'unknown', code: 'UNKNOWN', message: 'x' }
  }
  const harness = setup({ accountScope: 'acct-1' }, { handler })
  const result = await harness.api.prepare!(makePrepareRequest({ seller: undefined }))
  assert.equal(result.status, 'rejected')
  assert.equal(result.prepareToken, undefined)
  assert.equal(result.failureStage, 'address')
  assert.deepEqual(result.missingFields, ['address', 'poiId'])
  // partial draft 保留（非空白技术表单）
  assert.ok(result.draft)
  assert.equal(result.draft?.description, '描述')
  // 无 prepareToken → 无法提交
  const submit = await harness.api.submit!({ prepareToken: '', draft: makeDraft(), confirm: true })
  assert.equal(submit.code, 'PREPARE_TOKEN_REQUIRED')
})

test('prepare：preget 异常不隐藏（作为 warning 透传到 prepare 结果，不吞异常）', async () => {
  const handler = (request: { op: string; [k: string]: unknown }): DirectPublishPageResult => {
    if (request.op === 'account') return { ok: true, op: 'account', status: 'account', accountScope: 'acct-1' }
    if (request.op === 'prepare') {
      return {
        ok: true,
        op: 'prepare',
        status: 'prepared',
        payload: { base: true },
        draft: makeDraft() as unknown as Record<string, unknown>,
        propertyCards: PROPERTY_CARDS,
        rawCards: [],
        accountScope: 'acct-1',
        warnings: ['preget 异常：FAIL_SYS_ILLEGAL_ACCESS 接口失败'],
      }
    }
    return { ok: false, op: request.op, status: 'unknown', code: 'UNKNOWN', message: 'x' }
  }
  const harness = setup({ accountScope: 'acct-1' }, { handler })
  const result = await harness.api.prepare!(makePrepareRequest())
  assert.equal(result.status, 'prepared')
  assert.ok((result.warnings ?? []).some((w) => w.includes('preget 异常')))
})

// ==================== submit：修改后的 draft 真正传入 ====================

test('submit：修改后的 draft（描述/价格/规格/图片重排）真正传入页面，成功以 itemId 为准', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const prepared = await prepareOk(harness)

  const edited = makeDraft()
  // 描述模式：旧 title 被**忽略**（不校验、不拼接、不参与指纹）；核心 title 以 description 填充。
  edited.title = '改后的标题（应被忽略）'
  edited.description = '改后的描述'
  edited.price = '88.50'
  edited.specifications = [{ name: '颜色', value: '黑' }]
  // 图片重排：u2 放最前，删除 u1（只剩 1 张）
  edited.images = [edited.images[1] as Record<string, unknown>]
  edited.services = [{ serviceCode: 'SERVICE_A', enable: true }]

  const result = await harness.api.submit!(submitBody(prepared.prepareToken as string, {}, edited))
  assert.equal(result.status, 'published')
  assert.equal(result.itemId, '1087000000001')

  const submitCall = prepareOps(harness, 'submit')
  assert.ok(submitCall)
  const core = submitCall.submitCore as {
    title: string
    description: string
    priceYuan: string
    specifications: Array<{ name: string; value: string }>
    imageInfoDOList: Array<Record<string, unknown>>
    services: Array<{ serviceCode: string; enable: boolean }>
    itemLabelExtList: Array<Record<string, unknown>>
  }
  assert.equal(core.title, '改后的描述')
  assert.equal(core.description, '改后的描述')
  assert.equal(core.priceYuan, '88.50')
  assert.deepEqual(core.specifications, [{ name: '颜色', value: '黑' }])
  // 图片只保留重排后的 u2，并被标记为封面
  assert.equal(core.imageInfoDOList.length, 1)
  assert.equal(core.imageInfoDOList[0]?.url, 'https://img.example.com/u2.jpg')
  assert.equal(core.imageInfoDOList[0]?.major, true)
  // 服务取自已准备候选，允许启用
  assert.deepEqual(core.services, [{ serviceCode: 'SERVICE_A', enable: true }])
  // 类目 label item 由后台候选重建
  assert.ok(core.itemLabelExtList.some((item) => item['propertyId'] === '-10000'))
  // 审计 published
  const ledger = harness.storage.snapshot()[DIRECT_PUBLISH_AUDIT_STORAGE_KEY] as { entries: Record<string, { status: string; itemId?: string }> }
  assert.equal(ledger.entries['acct-1::key-1']?.status, 'published')
  assert.equal(ledger.entries['acct-1::key-1']?.itemId, '1087000000001')
})

test('submit：cpvList 同步最终选择（从原始推荐卡克隆更新 isClicked），绝不传旧推荐状态', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const prepared = await prepareOk(harness)

  const edited = makeDraft()
  // 改为「电脑」类目 + 「ZARA」品牌
  edited.category = { catId: '50000001', catName: '电脑', channelCatId: '50000001', leafId: '0', tbCatId: '5002' }
  edited.attributes = [{ propertyId: '20000', propertyName: '品牌', valueId: 'brand-b', valueName: 'ZARA' }]

  const result = await harness.api.submit!(submitBody(prepared.prepareToken as string, {}, edited))
  assert.equal(result.status, 'published')

  const submitCall = prepareOps(harness, 'submit')
  const rawCards = submitCall?.rawCards as Array<{ cardData: { propertyId: string; valuesList: Array<{ valueId: string; isClicked?: string }> } }>
  const categoryCard = rawCards.find((c) => c.cardData.propertyId === '-10000')
  const brandCard = rawCards.find((c) => c.cardData.propertyId === '20000')
  assert.equal(categoryCard?.cardData.valuesList.find((v) => v.valueId === '50000001')?.isClicked, '1')
  assert.equal(categoryCard?.cardData.valuesList.find((v) => v.valueId === '50000000')?.isClicked, '0')
  assert.equal(brandCard?.cardData.valuesList.find((v) => v.valueId === 'brand-b')?.isClicked, '1')
  assert.equal(brandCard?.cardData.valuesList.find((v) => v.valueId === 'brand-a')?.isClicked, '0')
  // submitCore.services 仍为已准备服务（未被自动改变）
  const services = (submitCall?.submitCore as { services: Array<{ serviceCode: string; enable: boolean }> }).services
  assert.deepEqual(services, [{ serviceCode: 'SERVICE_A', enable: false }, { serviceCode: 'AI_SALE', enable: false }])
})

test('submit：页面复查服务不可用 → SERVICE_UNAVAILABLE 拒绝（不静默删除/不改变已确认数据）', async () => {
  // 模拟页面 opSubmit 在复查后发现已开启服务不可用而返回 rejected
  const harness = setup({ accountScope: 'acct-1', submitStatus: 'rejected', submitCode: 'SERVICE_UNAVAILABLE', submitMessage: '所选服务不可用' })
  const prepared = await prepareOk(harness)
  const draft = makeDraft()
  draft.services = [{ serviceCode: 'SERVICE_A', enable: true }]
  const result = await harness.api.submit!(submitBody(prepared.prepareToken as string, {}, draft))
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'SERVICE_UNAVAILABLE')
  assert.equal(result.itemId, undefined)
})

// ==================== submit：确认门禁与 token ====================

test('submit：只要求 confirm: true；缺 confirm / token 拒绝，缺 categoryConfirmed/confirmedNoQrCodes 不再阻断', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const { prepareToken } = await prepareOk(harness)

  const noConfirm = await harness.api.submit!(submitBody(prepareToken as string, { confirm: false as unknown as true }))
  assert.equal(noConfirm.code, 'CONFIRM_REQUIRED')
  const noToken = await harness.api.submit!(submitBody('', {}))
  assert.equal(noToken.code, 'PREPARE_TOKEN_REQUIRED')
  assert.equal(countOp(harness, 'submit'), 0)

  // 仅 confirm: true（不发送旧 categoryConfirmed / confirmedNoQrCodes）即可成功提交。
  const ok = await harness.api.submit!({
    prepareToken: prepareToken as string,
    draft: makeDraft(),
    confirm: true,
  })
  assert.equal(ok.status, 'published')
  assert.equal(ok.itemId, '1087000000001')
  assert.equal(countOp(harness, 'submit'), 1)
})

test('submit：未知 token（service worker 重启）→ PREPARE_EXPIRED，不注入页面', async () => {
  const storage = createStorage()
  const first = setup({ accountScope: 'acct-1' }, { storage })
  const prepared = await prepareOk(first)

  // 模拟 SW 重启：新建 API（内存 token 清空），复用同一 storage。
  const restarted = setup({ accountScope: 'acct-1' }, { storage })
  const result = await restarted.api.submit!(submitBody(prepared.prepareToken as string))
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'PREPARE_EXPIRED')
  assert.equal(countOp(restarted, 'submit'), 0)
})

// ==================== submit：防重复 / 未知锁定 / 幂等复用 ====================

test('submit：重复提交同一 token → 第二次 PREPARE_EXPIRED，只真正提交一次', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const prepared = await prepareOk(harness)
  const first = await harness.api.submit!(submitBody(prepared.prepareToken as string))
  assert.equal(first.status, 'published')

  const second = await harness.api.submit!(submitBody(prepared.prepareToken as string))
  assert.equal(second.status, 'rejected')
  assert.equal(second.code, 'PREPARE_EXPIRED')
  assert.equal(countOp(harness, 'submit'), 1)
})

test('submit：结果未知 → 审计 unknown；同 key 重新准备后提交被 PREVIOUS_ATTEMPT_UNKNOWN 阻断', async () => {
  const harness = setup({ accountScope: 'acct-1', submitStatus: 'unknown' })
  const prepared = await prepareOk(harness)
  const first = await harness.api.submit!(submitBody(prepared.prepareToken as string))
  assert.equal(first.status, 'unknown')

  // 重新 prepare（同 key 同输入）拿新 token，模拟用户修正后重试
  const rePrepared = await prepareOk(harness)
  const second = await harness.api.submit!(submitBody(rePrepared.prepareToken as string))
  assert.equal(second.status, 'unknown')
  assert.equal(second.code, 'PREVIOUS_ATTEMPT_UNKNOWN')
  assert.equal(countOp(harness, 'submit'), 1)
})

test('submit：先成功后同 key 重新准备再提交 → 返回既有 itemId（reused:true），不再次提交', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const prepared = await prepareOk(harness)
  const first = await harness.api.submit!(submitBody(prepared.prepareToken as string))
  assert.equal(first.status, 'published')
  assert.equal(first.reused, undefined)

  const rePrepared = await prepareOk(harness)
  const second = await harness.api.submit!(submitBody(rePrepared.prepareToken as string))
  assert.equal(second.status, 'published')
  assert.equal(second.itemId, '1087000000001')
  assert.equal(second.reused, true)
  assert.equal(countOp(harness, 'submit'), 1)
})

test('submit：并发提交第二次被 CONCURRENT_LOCK 拒绝', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const harness = setup({ accountScope: 'acct-1' })
  const prepared = await prepareOk(harness)
  // 让 account 在 submit 阶段阻塞
  const realHandler = pageHandler({ accountScope: 'acct-1' })
  harness.scripting.api.executeScript = async <T>(injection: { args: unknown[] }) => {
    const request = injection.args[0] as { op: string; [k: string]: unknown }
    harness.scripting.calls.push(request)
    if (request.op === 'account' && harness.scripting.calls.filter((c) => c.op === 'account').length > 1) {
      await gate
    }
    return [{ result: realHandler(request) as T }]
  }

  const first = harness.api.submit!(submitBody(prepared.prepareToken as string))
  const second = await harness.api.submit!(submitBody(prepared.prepareToken as string))
  assert.equal(second.status, 'rejected')
  assert.equal(second.code, 'CONCURRENT_LOCK')
  release()
  const firstResult = await first
  assert.equal(firstResult.status, 'published')
})

// ==================== submit：账号漂移 ====================

test('submit：提交前账号漂移 → action_required/ACCOUNT_CHANGED，不注入 submit', async () => {
  const state: PageState = { accountScope: 'acct-1' }
  const harness = setup(state)
  const prepared = await prepareOk(harness)

  // 同一 API 实例（同缓存）下账号变化
  state.accountScope = 'acct-2'
  const result = await harness.api.submit!(submitBody(prepared.prepareToken as string))
  assert.equal(result.status, 'action_required')
  assert.equal(result.code, 'ACCOUNT_CHANGED')
  assert.equal(countOp(harness, 'submit'), 0)
})

// ==================== submit：恶意 draft 拒绝 ====================

test('submit：类目不在已准备候选内 → DRAFT_CATEGORY_INVALID，不注入 submit', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const prepared = await prepareOk(harness)
  const draft = makeDraft()
  draft.category = { catId: '99999999', catName: '伪造类目', channelCatId: '99999999' }
  const result = await harness.api.submit!(submitBody(prepared.prepareToken as string, {}, draft))
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'DRAFT_CATEGORY_INVALID')
  assert.equal(countOp(harness, 'submit'), 0)
})

test('submit：属性取值非候选 → DRAFT_ATTRIBUTE_INVALID，不注入 submit', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const prepared = await prepareOk(harness)
  const draft = makeDraft()
  draft.attributes = [{ propertyId: '20000', propertyName: '品牌', valueId: 'brand-forged', valueName: '伪造品牌' }]
  const result = await harness.api.submit!(submitBody(prepared.prepareToken as string, {}, draft))
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'DRAFT_ATTRIBUTE_INVALID')
  assert.equal(countOp(harness, 'submit'), 0)
})

test('submit：图片 url 不在已上传集合内 → DRAFT_IMAGE_INVALID（禁止伪造上传图片数据）', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const prepared = await prepareOk(harness)
  const draft = makeDraft()
  draft.images = [{ url: 'https://evil.example.com/forged.jpg', widthSize: 1, heightSize: 1 }]
  const result = await harness.api.submit!(submitBody(prepared.prepareToken as string, {}, draft))
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'DRAFT_IMAGE_INVALID')
  assert.equal(countOp(harness, 'submit'), 0)
})

test('submit：地址 gps 数值超范围 → DRAFT_ADDRESS_INVALID（格式 / 数值范围校验），不注入 submit', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const prepared = await prepareOk(harness)
  const draft = makeDraft()
  draft.address = { ...ADDRESS, gps: '120.0,999.9' }
  const result = await harness.api.submit!(submitBody(prepared.prepareToken as string, {}, draft))
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'DRAFT_ADDRESS_INVALID')
  assert.equal(countOp(harness, 'submit'), 0)
})

test('submit：未知服务 → DRAFT_SERVICE_INVALID；未知字段被忽略且不进入最终 payload', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const prepared = await prepareOk(harness)
  const badDraft = makeDraft()
  badDraft.services = [{ serviceCode: 'NOT_AVAILABLE', enable: true }]
  const rejected = await harness.api.submit!(submitBody(prepared.prepareToken as string, {}, badDraft))
  assert.equal(rejected.code, 'DRAFT_SERVICE_INVALID')

  // 注入未知字段应被忽略（白名单重建），但仍能成功
  const prepared2 = await prepareOk(harness)
  const draft = makeDraft()
  ;(draft as unknown as Record<string, unknown>)['evilField'] = 'x'
  ;(draft.attributes[1] as Record<string, unknown>)['evil'] = { a: 1 }
  const result = await harness.api.submit!(submitBody(prepared2.prepareToken as string, {}, draft))
  assert.equal(result.status, 'published')
  const core = prepareOps(harness, 'submit')?.submitCore as { itemLabelExtList: Array<Record<string, unknown>> }
  assert.equal(JSON.stringify(core).includes('evilField'), false)
  assert.equal(JSON.stringify(core).includes('"evil"'), false)
})

test('submit：价格非法 / 描述为空 → 拒绝，不注入 submit', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const prepared = await prepareOk(harness)
  const badPrice = makeDraft()
  badPrice.price = '1.234'
  assert.equal((await harness.api.submit!(submitBody(prepared.prepareToken as string, {}, badPrice))).code, 'DRAFT_PRICE_INVALID')
  const emptyDesc = makeDraft()
  emptyDesc.description = '   '
  assert.equal((await harness.api.submit!(submitBody(prepared.prepareToken as string, {}, emptyDesc))).code, 'DRAFT_DESCRIPTION_INVALID')
  assert.equal(countOp(harness, 'submit'), 0)
})

// ==================== submit：文案更新后违禁词复检 ====================

test('submit：修改文案后页面违禁词复检拦截 → rejected/BADWORDS_FORBIDDEN，不产出 itemId', async () => {
  const harness = setup({ accountScope: 'acct-1', submitStatus: 'rejected', submitCode: 'BADWORDS_FORBIDDEN', submitMessage: '违禁词拦截' })
  const prepared = await prepareOk(harness)
  const draft = makeDraft()
  draft.description = '包含敏感词的描述'
  const result = await harness.api.submit!(submitBody(prepared.prepareToken as string, {}, draft))
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'BADWORDS_FORBIDDEN')
  assert.equal(result.itemId, undefined)
  // 页面确实收到 submit（复检发生在页面内）
  assert.equal(countOp(harness, 'submit'), 1)
  const ledger = harness.storage.snapshot()[DIRECT_PUBLISH_AUDIT_STORAGE_KEY] as { entries: Record<string, { status: string }> }
  assert.equal(ledger.entries['acct-1::key-1']?.status, 'rejected')
})

test('submit：token 过期 → PREPARE_EXPIRED（需重新准备）', async () => {
  let clock = 1_000
  const harness = setup({ accountScope: 'acct-1' }, { prepareTtlMs: 100, now: () => clock })
  const prepared = await harness.api.prepare!(makePrepareRequest())
  assert.equal(prepared.status, 'prepared')
  clock += 10_000
  const result = await harness.api.submit!(submitBody(prepared.prepareToken as string))
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'PREPARE_EXPIRED')
})

// ==================== 消息监听 ====================

function installCapture(options: { createApi?: () => DirectPublishApi | null } = {}) {
  const listeners: Array<(message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean> = []
  ;(globalThis as { chrome?: unknown }).chrome = {
    runtime: { id: 'ext-id', onMessage: { addListener: (listener: (typeof listeners)[number]) => listeners.push(listener) } },
  }
  __resetDirectPublishListenerForTests()
  installDirectPublishApiListener(options)
  return listeners[0] as (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean
}

function invoke(listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean, message: unknown) {
  let resolveResponse: (value: unknown) => void = () => {}
  const response = new Promise<unknown>((resolve) => {
    resolveResponse = resolve
  })
  const returned = listener(message, { id: 'ext-id', url: 'chrome-extension://ext-id/workbench.html' }, resolveResponse)
  return { returned, response }
}

test('监听器：prepare 返回 ok=status prepared；submit 返回 ok=status published', async () => {
  const harness = setup({ accountScope: 'acct-1' })
  const listener = installCapture({ createApi: () => harness.api })
  try {
    const prepareInvoke = invoke(listener, { kind: 'fishops-direct-publish', method: 'prepare', request: makePrepareRequest() })
    assert.equal(prepareInvoke.returned, true)
    const preparedPayload = (await prepareInvoke.response) as { ok: boolean; result?: { status: string; prepareToken?: string } }
    assert.equal(preparedPayload.ok, true)
    assert.equal(preparedPayload.result?.status, 'prepared')
    const token = preparedPayload.result?.prepareToken as string

    const submitInvoke = invoke(listener, { kind: 'fishops-direct-publish', method: 'submit', request: submitBody(token) })
    assert.equal(submitInvoke.returned, true)
    const submitPayload = (await submitInvoke.response) as { ok: boolean; result?: { status: string; itemId?: string } }
    assert.equal(submitPayload.ok, true)
    assert.equal(submitPayload.result?.status, 'published')
    assert.equal(submitPayload.result?.itemId, '1087000000001')
  } finally {
    delete (globalThis as { chrome?: unknown }).chrome
  }
})
