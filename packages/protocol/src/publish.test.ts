import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  METHODS,
  decodePublishMyItemsCursor,
  encodePublishMyItemsCursor,
  isPublishMyItemsResult,
  isPublishMyItemsCursor,
  isPublishMyItemsStepParams,
  isPublishPrepareResult,
  isPublishResult,
  isPublishSubmitResult,
  normalizePublishMyItemsParams,
  normalizePublishMyItemsStepParams,
  normalizePublishSubmitStepParams,
  normalizePublishPrepareParams,
  normalizePublishPrepareStepParams,
  isPublishPrepareStepParams,
  isPublishSubmitStepParams,
  normalizePublishSubmitParams,
  publishFingerprint,
  validateParams,
} from './index.ts'

/** 完整合法 prepare 输入；各用例在副本上做单点破坏。 */
const validPrepare = () => ({
  source: { itemId: 'item-1' },
  idempotencyKey: 'key-1',
  seller: { addressRef: 'addr-1' },
  confirm: { imageNoQr: true, addressConfirmed: true },
  draft: {
    title: '九成新机械键盘',
    description: '自用一年，无拆无修',
    price: { kind: 'fixed', amount: 199, unit: 'CNY' },
    images: [{ kind: 'uploaded', ref: 'img-1' }],
    categoryRef: 'cat-1',
    attributeRefs: ['attr-1'],
    specs: [{ key: '成色', value: '九成新' }],
    services: [{ ref: 'svc-1' }],
  },
})

const validSubmit = () => ({
  prepareToken: 'tok-1',
  draftFingerprint: 'fp-1',
  idempotencyKey: 'key-1',
  confirm: { imageNoQr: true, addressConfirmed: true },
})

const validPrepareResult = () => ({
  prepareToken: 'tok-1',
  draftFingerprint: 'fp-1',
  expiresAt: 1700000000000,
  draft: { title: '键盘', description: null, price: '199', imageCount: 1, categoryName: '数码', attributeNames: ['成色'], serviceNames: [] },
  candidates: { categoryRefs: ['cat-1'], attributeRefs: ['attr-1'], serviceRefs: ['svc-1'] },
})

const badPrepare = (patch: Record<string, unknown>) => {
  const input: Record<string, unknown> = { ...validPrepare(), ...patch }
  assert.throws(() => normalizePublishPrepareParams(input), { code: 'BAD_REQUEST' })
  assert.throws(() => validateParams('publish.prepare', input), { code: 'BAD_REQUEST' })
}

test('M5 三个发布方法已注册且仍拒绝未知字段', () => {
  for (const method of ['publish.prepare', 'publish.submit', 'publish.myItems']) assert.equal(METHODS.includes(method as any), true)
  assert.deepEqual(validateParams('publish.prepare', validPrepare()).source, { itemId: 'item-1' })
  assert.deepEqual(validateParams('publish.submit', validSubmit()).prepareToken, 'tok-1')
  assert.deepEqual(validateParams('publish.myItems', {}), { limit: 100, maxWaitMs: 120000 })
  for (const [method, params] of [
    ['publish.prepare', { ...validPrepare(), transportData: { ret: 'SUCCESS' } }],
    ['publish.submit', { ...validSubmit(), payload: { ret: 'SUCCESS' } }],
    ['publish.myItems', { page: 2 }],
  ] as const) assert.throws(() => validateParams(method, params), { code: 'BAD_REQUEST' })
})

test('prepare 严格拒绝未知字段、getter 与隐藏字段', () => {
  badPrepare({ extra: 1 })
  badPrepare({ payload: {} })
  const getter: any = validPrepare()
  Object.defineProperty(getter, 'confirm', { enumerable: true, get: () => ({ imageNoQr: true, addressConfirmed: true }) })
  assert.throws(() => normalizePublishPrepareParams(getter), { code: 'BAD_REQUEST' })
  const hidden: any = validPrepare()
  Object.defineProperty(hidden, 'secret', { value: 1, enumerable: false })
  assert.throws(() => normalizePublishPrepareParams(hidden), { code: 'BAD_REQUEST' })
  badPrepare({ draft: { ...validPrepare().draft, transportData: {} } })
})

test('prepare 必须显式 source.itemId，禁止随机源与整对象源', () => {
  const { source: _omit, ...withoutSource } = validPrepare()
  assert.throws(() => normalizePublishPrepareParams(withoutSource), { code: 'BAD_REQUEST' })
  badPrepare({ source: { itemId: ' ' } })
  badPrepare({ source: { itemId: 'x'.repeat(129) } })
  badPrepare({ source: { itemId: 'item-1', title: '键盘' } })
  badPrepare({ source: 'item-1' })
})

test('confirm 必须显式为真且字段完整', () => {
  badPrepare({ confirm: undefined })
  badPrepare({ confirm: {} })
  badPrepare({ confirm: { imageNoQr: true } })
  badPrepare({ confirm: { imageNoQr: true, addressConfirmed: false } })
  badPrepare({ confirm: { imageNoQr: 1, addressConfirmed: true } })
  badPrepare({ confirm: { imageNoQr: true, addressConfirmed: true, extra: true } })
})

test('idempotencyKey 必填且长度受限', () => {
  badPrepare({ idempotencyKey: '' })
  badPrepare({ idempotencyKey: ' ' })
  badPrepare({ idempotencyKey: 'x'.repeat(129) })
  assert.throws(() => normalizePublishSubmitParams({ ...validSubmit(), idempotencyKey: '' }), { code: 'BAD_REQUEST' })
  assert.equal(normalizePublishPrepareParams({ ...validPrepare(), idempotencyKey: ' k ' }).idempotencyKey, 'k')
})

test('账号不由调用方指定：任何账号范围字段一律拒绝', () => {
  for (const key of ['accountId', 'account', 'userId', 'accountScope', 'scope', 'token', 'cookie']) {
    badPrepare({ [key]: 'other-account' })
    assert.throws(() => normalizePublishSubmitParams({ ...validSubmit(), [key]: 'x' }), { code: 'BAD_REQUEST' })
    assert.throws(() => normalizePublishMyItemsParams({ [key]: 'x' }), { code: 'BAD_REQUEST' })
  }
})

test('seller 只接受候选地址引用，不猜测地址与坐标', () => {
  const { seller: _omit, ...withoutSeller } = validPrepare()
  assert.throws(() => normalizePublishPrepareParams(withoutSeller), { code: 'BAD_REQUEST' })
  badPrepare({ seller: { addressRef: 'addr-1', latitude: 30.1, longitude: 120.2 } })
  badPrepare({ seller: { addressRef: '' } })
  badPrepare({ seller: { addressRef: '浙江省杭州市西湖区' } })
  badPrepare({ seller: { address: 'addr-1' } })
})

test('draft 价格、图片、规格与服务只接受显式规范字段', () => {
  badPrepare({ draft: { price: { kind: 'fixed', amount: 199 } } })
  badPrepare({ draft: { price: { kind: 'fixed', amount: 0, unit: 'CNY' } } })
  badPrepare({ draft: { price: { kind: 'fixed', amount: 199, unit: 'USD' } } })
  badPrepare({ draft: { price: { kind: 'negotiable', amount: 1 } } })
  badPrepare({ draft: { images: [] } })
  badPrepare({ draft: { images: [{ kind: 'url', url: 'javascript:alert(1)' }] } })
  badPrepare({ draft: { images: [{ kind: 'url', url: 'ftp://example.com/a.png' }] } })
  badPrepare({ draft: { images: [{ kind: 'uploaded', ref: 'img-1', raw: {} }] } })
  badPrepare({ draft: { images: Array(21).fill({ kind: 'uploaded', ref: 'img-1' }) } })
  badPrepare({ draft: { specs: [{ key: '成色', value: '九成新' }, { key: '成色', value: '全新' }] } })
  badPrepare({ draft: { services: [{ ref: 'svc-1' }, { ref: 'svc-1' }] } })
  badPrepare({ draft: { attributeRefs: ['attr 1'] } })
  const normalized = normalizePublishPrepareParams({ ...validPrepare(), draft: { attributeRefs: ['attr-1', 'attr-1'], images: [{ kind: 'url', url: 'https://img.example.com/a.png' }] } })
  assert.deepEqual(normalized.draft?.attributeRefs, ['attr-1'])
  assert.deepEqual(normalized.draft?.images, [{ kind: 'url', url: 'https://img.example.com/a.png' }])
})

test('prepare 允许省略 draft 并只保留显式字段', () => {
  const { draft: _omit, ...withoutDraft } = validPrepare()
  const normalized = normalizePublishPrepareParams(withoutDraft)
  assert.equal(normalized.draft, undefined)
  assert.deepEqual(Object.keys(normalized).sort(), ['confirm', 'idempotencyKey', 'seller', 'source'])
})

test('submit 必须绑定 prepareToken、draftFingerprint 与 confirm', () => {
  assert.throws(() => normalizePublishSubmitParams({ ...validSubmit(), prepareToken: undefined }), { code: 'BAD_REQUEST' })
  assert.throws(() => normalizePublishSubmitParams({ ...validSubmit(), draftFingerprint: undefined }), { code: 'BAD_REQUEST' })
  assert.throws(() => normalizePublishSubmitParams({ ...validSubmit(), prepareToken: '' }), { code: 'BAD_REQUEST' })
  assert.throws(() => normalizePublishSubmitParams({ ...validSubmit(), prepareToken: 'tok 1' }), { code: 'BAD_REQUEST' })
  assert.throws(() => normalizePublishSubmitParams({ ...validSubmit(), draftFingerprint: 'x'.repeat(257) }), { code: 'BAD_REQUEST' })
  assert.throws(() => normalizePublishSubmitParams({ ...validSubmit(), confirm: { imageNoQr: true, addressConfirmed: false } }), { code: 'BAD_REQUEST' })
  const { confirm: _omit, ...withoutConfirm } = validSubmit()
  assert.throws(() => normalizePublishSubmitParams(withoutConfirm), { code: 'BAD_REQUEST' })
})

test('submit 不接受客户端自造 payload 与账号范围', () => {
  assert.throws(() => normalizePublishSubmitParams({ ...validSubmit(), transportData: { ret: ['SUCCESS'] } }), { code: 'BAD_REQUEST' })
  assert.throws(() => normalizePublishSubmitParams({ ...validSubmit(), itemId: 'item-2' }), { code: 'BAD_REQUEST' })
  assert.throws(() => normalizePublishSubmitParams({ ...validSubmit(), accountId: 'a' }), { code: 'BAD_REQUEST' })
})

test('submit 内部单步只额外接受 Host prepareRef，公共 submit 继续拒绝', () => {
  const internal = { ...validSubmit(), prepareRef: 'prep.authority-1' }
  assert.deepEqual(normalizePublishSubmitStepParams(internal).prepareRef, 'prep.authority-1')
  assert.throws(() => normalizePublishSubmitParams(internal), { code: 'BAD_REQUEST' })
  for (const prepareRef of ['', ' ', 'x'.repeat(129), 'pref avec espace', { ref: 'x' }]) {
    assert.throws(() => normalizePublishSubmitStepParams({ ...internal, prepareRef }), { code: 'BAD_REQUEST' })
  }
  assert.throws(() => normalizePublishSubmitStepParams({ ...internal, payload: {} }), { code: 'BAD_REQUEST' })
})

test('发布内部步骤无 key 仍可规范化，公共 API 继续要求 key', () => {
  const { idempotencyKey: _prepareKey, ...prepare } = validPrepare()
  const { idempotencyKey: _submitKey, ...submit } = validSubmit()
  const internalSubmit = { ...submit, prepareRef: 'prep.authority-1' }
  assert.deepEqual(normalizePublishPrepareStepParams(prepare), prepare)
  assert.deepEqual(normalizePublishSubmitStepParams(internalSubmit), internalSubmit)
  assert.equal(isPublishPrepareStepParams(prepare), true)
  assert.equal(isPublishSubmitStepParams(internalSubmit), true)
  assert.throws(() => normalizePublishPrepareParams(prepare), { code: 'BAD_REQUEST' })
  assert.throws(() => normalizePublishSubmitParams(submit), { code: 'BAD_REQUEST' })

  for (const [normalize, params] of [
    [normalizePublishPrepareStepParams, prepare],
    [normalizePublishSubmitStepParams, internalSubmit],
  ] as const) {
    // 旧内部调用可带合法 key，但不能混入公共调度或任意业务字段。
    assert.equal(normalize({ ...params, idempotencyKey: 'legacy-key' }).idempotencyKey, 'legacy-key')
    for (const patch of [
      { idempotencyKey: '' }, { idempotencyKey: 'x'.repeat(129) },
      { maxWaitMs: 1000 }, { minIntervalMs: 100 }, { tag: 'tag' },
      { accountId: 'forged' }, { payload: {} }, { unknown: true },
      { confirm: { imageNoQr: false, addressConfirmed: true } },
    ]) assert.throws(() => normalize({ ...params, ...patch }), { code: 'BAD_REQUEST' })
  }
  assert.throws(() => normalizePublishPrepareStepParams({ ...prepare, source: {} }), { code: 'BAD_REQUEST' })
  assert.throws(() => normalizePublishSubmitStepParams(submit), { code: 'BAD_REQUEST' })
})

test('myItems 只读分页参数与账号边界', () => {
  assert.deepEqual(normalizePublishMyItemsParams({ limit: 200, minIntervalMs: 0, tag: '任务' }), { limit: 200, maxWaitMs: 120000, minIntervalMs: 0, tag: '任务' })
  const cursor = encodePublishMyItemsCursor({ groupId: 14645107, pageNumber: 2, pageSize: 20 })
  for (const params of [
    { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { maxWaitMs: 0 }, { maxWaitMs: 600001 },
    { maxWaitMs: 1.5 }, { maxWaitMs: '120000' },
    { minIntervalMs: -1 }, { tag: '' }, { tag: 'x'.repeat(129) }, { accountId: 'b' },
    { limit: 20, page: 2 }, { limit: 20, pageNumber: 2 }, { limit: 20, pageSize: 20 },
    { limit: 20, groupId: 14645107 }, { limit: 20, nextPage: cursor },
  ]) {
    assert.throws(() => normalizePublishMyItemsParams(params), { code: 'BAD_REQUEST' })
  }
  const normalized = normalizePublishMyItemsParams({})
  assert.deepEqual(Object.keys(normalized).sort(), ['limit', 'maxWaitMs'])
})

test('myItems 公共参数同一份校验入口必须幂等，且显式调度字段仍受边界约束', () => {
  // 真实调用链先由 validateParams 补默认值，Host 编排层再规范化一次；
  // 规范化器必须接受自己的输出，否则公共 publish.myItems 必然 BAD_REQUEST。
  const validated = validateParams('publish.myItems', {})
  assert.deepEqual(validated, { limit: 100, maxWaitMs: 120000 })
  assert.deepEqual(normalizePublishMyItemsParams(validated), validated)
  const explicit = { limit: 5, maxWaitMs: 600000, minIntervalMs: 0, tag: '任务' }
  assert.deepEqual(normalizePublishMyItemsParams(explicit), explicit)
  assert.deepEqual(normalizePublishMyItemsParams(normalizePublishMyItemsParams(explicit)), explicit)
  // 幂等只覆盖合法输出：越界值、非整数与未知字段仍被拒绝。
  for (const params of [{ maxWaitMs: 0 }, { maxWaitMs: 600001 }, { maxWaitMs: 1.5 }, { maxWaitMs: 120000, page: 2 }]) {
    assert.throws(() => normalizePublishMyItemsParams(params), { code: 'BAD_REQUEST' })
  }
})

test('发布参数只接受本 realm 的规范普通对象，原型校验不为跨 realm 引用而放宽', () => {
  // Chrome 以 `(<func>)(<json args>)` 把 executeScript 参数注入 MAIN world，
  // 页面执行器收到的是该 realm 解析出的普通对象；参数必须能经 JSON 往返。
  // 跨 realm 引用对象只可能来自测试替身或注入旁路，仍按伪装对象拒绝。
  const foreignPlain = runInNewContext('({ limit: 100, maxWaitMs: 120000 })') as Record<string, unknown>
  assert.notEqual(Object.getPrototypeOf(foreignPlain), Object.prototype)
  assert.throws(() => normalizePublishMyItemsParams(foreignPlain), { code: 'BAD_REQUEST' })
  assert.throws(() => normalizePublishMyItemsStepParams(runInNewContext('({ limit: 100 })')), { code: 'BAD_REQUEST' })
  // null 原型对象是规范纯数据，跨 realm 也一样接受。
  const foreignNullProto = runInNewContext('Object.assign(Object.create(null), { limit: 100 })')
  assert.deepEqual(normalizePublishMyItemsParams(foreignNullProto), { limit: 100, maxWaitMs: 120000 })
})

test('内部 myItems 游标携带受控 pageSize、pageNumber 与 groupId', () => {
  const cursor = encodePublishMyItemsCursor({ groupId: 14645107, pageNumber: 2, pageSize: 20 })
  assert.match(cursor, /^v1\.[A-Za-z0-9_-]+$/)
  assert.deepEqual(decodePublishMyItemsCursor(cursor), { groupId: 14645107, pageNumber: 2, pageSize: 20 })
  assert.equal(isPublishMyItemsCursor(cursor), true)
  assert.deepEqual(normalizePublishMyItemsStepParams({ limit: 200 }), { limit: 200 })
  assert.deepEqual(normalizePublishMyItemsStepParams({ limit: 200, nextPage: cursor }), { limit: 200, nextPage: cursor })
  assert.equal(isPublishMyItemsStepParams({ limit: 200, nextPage: cursor }), true)
})

test('内部 myItems 游标拒绝空串、非法字符、超长和非法语义', () => {
  const oversizedPage = `v1.${btoa('[1,1,1,21]').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`
  for (const value of [
    '', 'v1.', 'v1.****', 'v2.AQ', 'v1.AQ=', 'v1.AQ==', `v1.${'A'.repeat(253)}`,
    'v1.bm90LWpzb24', oversizedPage,
  ]) {
    assert.equal(isPublishMyItemsCursor(value), false)
    assert.throws(() => decodePublishMyItemsCursor(value), { code: 'BAD_REQUEST' })
  }
  for (const value of [
    { groupId: 0, pageNumber: 1, pageSize: 20 },
    { groupId: 1.5, pageNumber: 1, pageSize: 20 },
    { groupId: 1, pageNumber: 0, pageSize: 20 },
    { groupId: 1, pageNumber: 1, pageSize: 0 },
    { groupId: 1, pageNumber: 1, pageSize: 21 },
    { groupId: 1, pageNumber: 1, pageSize: 20, extra: true },
  ]) {
    assert.throws(() => encodePublishMyItemsCursor(value), { code: 'BAD_REQUEST' })
  }
})

test('内部 myItems 步骤拒绝公共调度字段和直接平台分页字段', () => {
  const cursor = encodePublishMyItemsCursor({ groupId: 14645107, pageNumber: 2, pageSize: 20 })
  assert.equal(isPublishMyItemsStepParams({ limit: 20 }), true)
  for (const params of [
    {}, { limit: 0 }, { limit: 201 }, { limit: 20, nextPage: '' }, { limit: 20, nextPage: 'raw' },
    { limit: 20, nextPage: `v1.${'A'.repeat(253)}` }, { limit: 20, pageNumber: 2 },
    { limit: 20, groupId: 1 }, { limit: 20, pageSize: 20 }, { limit: 20, maxWaitMs: 1 },
    { limit: 20, tag: 'x' }, { limit: 20, accountId: 'a' }, { limit: 20, nextPage: cursor, extra: true },
  ]) {
    assert.equal(isPublishMyItemsStepParams(params), false)
    assert.throws(() => normalizePublishMyItemsStepParams(params), { code: 'BAD_REQUEST' })
  }
})

test('指纹包含账号与业务参数，不含 tag 与调度元信息', () => {
  const base = publishFingerprint('acct-A', 'publish.prepare', validPrepare())
  assert.deepEqual(base, {
    accountId: 'acct-A',
    method: 'publish.prepare',
    idempotencyKey: 'key-1',
    fingerprint: JSON.stringify(['acct-A', 'publish.prepare', 'key-1', { source: { itemId: 'item-1' }, seller: { addressRef: 'addr-1' }, confirm: { imageNoQr: true, addressConfirmed: true }, draft: normalizePublishPrepareParams(validPrepare()).draft }]),
  })
  const withMeta = publishFingerprint('acct-A', 'publish.prepare', { ...validPrepare(), tag: 't', maxWaitMs: 1, minIntervalMs: 0 })
  assert.equal(withMeta.fingerprint, base.fingerprint)
  const otherAccount = publishFingerprint('acct-B', 'publish.prepare', validPrepare())
  assert.notEqual(otherAccount.fingerprint, base.fingerprint)
  const submit = publishFingerprint('acct-A', 'publish.submit', validSubmit())
  assert.equal(submit.method, 'publish.submit')
  assert.equal(submit.idempotencyKey, 'key-1')
  assert.throws(() => publishFingerprint('', 'publish.prepare', validPrepare()), { code: 'BAD_REQUEST' })
  assert.throws(() => publishFingerprint('acct-A', 'publish.myItems' as any, {}), { code: 'BAD_REQUEST' })
})

test('prepare 结果 schema：脱敏字段、严格边界', () => {
  assert.ok(isPublishPrepareResult(validPrepareResult()))
  assert.equal(isPublishPrepareResult({ ...validPrepareResult(), cookie: 'x' }), false)
  assert.equal(isPublishPrepareResult({ ...validPrepareResult(), prepareToken: '' }), false)
  assert.equal(isPublishPrepareResult({ ...validPrepareResult(), prepareToken: 'x'.repeat(513) }), false)
  assert.equal(isPublishPrepareResult({ ...validPrepareResult(), expiresAt: -1 }), false)
  assert.equal(isPublishPrepareResult({ ...validPrepareResult(), expiresAt: 1.5 }), false)
  const { draft: _omit, ...withoutDraft } = validPrepareResult()
  assert.equal(isPublishPrepareResult(withoutDraft), false)
  assert.equal(isPublishPrepareResult({ ...validPrepareResult(), draft: { ...validPrepareResult().draft, title: '  ' } }), false)
  assert.equal(isPublishPrepareResult({ ...validPrepareResult(), candidates: { categoryRefs: ['cat-1'], attributeRefs: [], serviceRefs: ['svc 1'] } }), false)
  assert.equal(isPublishPrepareResult({ ...validPrepareResult(), candidates: { categoryRefs: ['cat-1'], attributeRefs: ['attr-1', 'attr-1'], serviceRefs: [] } }), false)
  assert.ok(isPublishPrepareResult({ ...validPrepareResult(), draft: { title: null, description: null, price: null, imageCount: 0, categoryName: null, attributeNames: [], serviceNames: [] } }))
})

test('submit 结果 schema：只有 published 才携带 itemId 与 confirmedAt', () => {
  assert.ok(isPublishSubmitResult({ state: 'published', itemId: 'item-9', confirmedAt: 1700000000000 }))
  assert.ok(isPublishSubmitResult({ state: 'rejected' }))
  assert.ok(isPublishSubmitResult({ state: 'unknown' }))
  assert.equal(isPublishSubmitResult({ state: 'published' }), false)
  assert.equal(isPublishSubmitResult({ state: 'published', itemId: '' , confirmedAt: 0 }), false)
  assert.equal(isPublishSubmitResult({ state: 'unknown', itemId: 'item-9' }), false)
  assert.equal(isPublishSubmitResult({ state: 'rejected', confirmedAt: 0 }), false)
  assert.equal(isPublishSubmitResult({ state: 'succeeded' }), false)
  assert.equal(isPublishSubmitResult({ state: 'published', itemId: 'item-9', confirmedAt: 0, cookie: 'x' }), false)
})

test('myItems 结果 schema：itemId 去重、标题辅助、hasMore 显式', () => {
  assert.ok(isPublishMyItemsResult({ items: [], total: 0, hasMore: false }))
  assert.ok(isPublishMyItemsResult({ items: [{ itemId: 'i1' }, { itemId: 'i2', title: '键盘' }], total: 2, hasMore: false }))
  assert.equal(isPublishMyItemsResult({ items: [{ itemId: 'i1' }, { itemId: 'i1' }], total: 2, hasMore: false }), false)
  assert.equal(isPublishMyItemsResult({ items: [{ title: '键盘' }], total: 1, hasMore: false }), false)
  assert.equal(isPublishMyItemsResult({ items: [{ itemId: 'i1' }], total: 1 }), false)
  assert.equal(isPublishMyItemsResult({ items: [{ itemId: 'i1' }], total: 1, hasMore: 'yes' }), false)
  assert.equal(isPublishMyItemsResult({ items: [{ itemId: 'i1' }], total: -1, hasMore: false }), false)
  assert.equal(isPublishMyItemsResult({ items: [{ itemId: 'i1', shopId: 's' }], total: 1, hasMore: false }), false)
  assert.equal(isPublishMyItemsResult({ items: [{ itemId: 'i1' }], total: 1, hasMore: false, raw: {} }), false)
})

test('isPublishResult 分派三类结果并拒绝未知方法', () => {
  assert.ok(isPublishResult('publish.prepare', validPrepareResult()))
  assert.ok(isPublishResult('publish.submit', { state: 'unknown' }))
  assert.ok(isPublishResult('publish.myItems', { items: [], total: 0, hasMore: false }))
  assert.equal(isPublishResult('publish.prepare', { state: 'unknown' }), false)
  assert.equal(isPublishResult('publish.submit', validPrepareResult()), false)
  assert.equal(isPublishResult('publish.unknown' as any, { items: [] }), false)
})

test('prepare 结果不泄露 token 原文、签名或原始响应', () => {
  const leaked = { ...validPrepareResult(), sign: 'a=1&b=2', raw: { ret: ['SUCCESS'] }, _m_h5_tk: 'token' }
  assert.equal(isPublishPrepareResult(leaked), false)
  assert.equal(isPublishResult('publish.prepare', leaked), false)
})
