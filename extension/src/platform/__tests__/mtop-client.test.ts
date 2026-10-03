import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlatformError } from '../errors'
import { md5 } from '../xianyu/sign'
import {
  MTOP_API_CONFIG,
  buildMtopRequest,
  buildSearchData,
  createMtopClient,
  extractSuggestWords,
} from '../xianyu/mtop-client'
import type { MtopTransport, MtopTransportRequest } from '../xianyu/mtop-client'

function makeTransport(result: unknown): { transport: MtopTransport; calls: MtopTransportRequest[] } {
  const calls: MtopTransportRequest[] = []
  return {
    calls,
    transport: {
      async send(request: MtopTransportRequest): Promise<unknown> {
        calls.push(request)
        return result
      },
    },
  }
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn()
  } catch (error) {
    return error
  }
  return undefined
}

test('buildMtopRequest：URL 参数、签名与请求体与旧实现一致', () => {
  const data = { itemId: '123' }
  const plan = buildMtopRequest('detail', data, { token: 'tok', timestamp: '1700000000000' })

  const expectedString = `tok&1700000000000&34839810&${JSON.stringify(data)}`
  assert.equal(plan.sign.signString, expectedString)
  assert.equal(plan.urlParams.sign, md5(expectedString))
  assert.equal(plan.urlParams.jsv, '2.7.2')
  assert.equal(plan.urlParams.api, 'mtop.taobao.idle.pc.detail')
  assert.equal(plan.urlParams.accountSite, 'xianyu')
  assert.equal(plan.urlParams.sessionOption, 'AutoLoginOnly')
  assert.equal(plan.body, 'data=' + encodeURIComponent(JSON.stringify(data)))
  assert.equal(plan.headers.origin, 'https://www.goofish.com')
  assert.equal(plan.headers.referer, 'https://www.goofish.com/')
  assert.ok(plan.url.startsWith(MTOP_API_CONFIG.detail.baseUrl + '?'))
})

test('buildMtopRequest：URL 参数顺序与旧实现一致', () => {
  const plan = buildMtopRequest('search', { keyword: 'k' }, { token: 'tok', timestamp: '1' })
  const keys = [...new URL(plan.url).searchParams.keys()]
  assert.deepEqual(keys, [
    'jsv',
    'appKey',
    't',
    'sign',
    'v',
    'type',
    'accountSite',
    'dataType',
    'timeout',
    'api',
    'sessionOption',
  ])
})

test('buildSearchData：默认字段与旧 fetchSearchData 对齐', () => {
  const data = buildSearchData({ keyword: 'iPhone 17' })
  assert.equal(data.pageNumber, 1)
  assert.equal(data.keyword, 'iPhone 17')
  assert.equal(data.rowsPerPage, 30)
  assert.equal(data.fromFilter, false)
  assert.deepEqual(data.propValueStr, { searchFilter: 'publishDays:14;' })
  assert.equal(data.searchReqFromPage, 'pcSearch')
})

test('buildSearchData：可覆盖页码 / 每页 / 过滤串', () => {
  const data = buildSearchData({
    keyword: 'k',
    pageNumber: 3,
    rowsPerPage: 10,
    searchFilter: 'freeShipping:true;',
  })
  assert.equal(data.pageNumber, 3)
  assert.equal(data.rowsPerPage, 10)
  assert.deepEqual(data.propValueStr, { searchFilter: 'freeShipping:true;' })
})

test('extractSuggestWords：提取 suggest 并过滤空值', () => {
  const words = extractSuggestWords({
    ret: ['SUCCESS::x'],
    data: { items: [{ suggest: 'a' }, { suggest: '' }, { other: 1 }, { suggest: 'b' }] },
  })
  assert.deepEqual(words, ['a', 'b'])
  assert.deepEqual(extractSuggestWords({ data: {} }), [])
})

test('client.search：POST + credentials include，返回 data', async () => {
  const { transport, calls } = makeTransport({
    ret: ['SUCCESS::调用成功'],
    data: { resultList: [{ a: 1 }] },
  })
  const client = createMtopClient({ transport, getToken: () => 'tok' })

  const data = await client.search({ keyword: 'iPhone', pageNumber: 2 })
  assert.deepEqual(data, { resultList: [{ a: 1 }] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.method, 'POST')
  assert.equal(calls[0]!.credentials, 'include')
  assert.ok(calls[0]!.body!.startsWith('data='))
})

test('client.requestRaw：返回完整原始 JSON（含 ret）', async () => {
  const { transport } = makeTransport({ ret: ['SUCCESS::调用成功'], data: { resultList: [] } })
  const client = createMtopClient({ transport, getToken: () => 'tok' })

  const raw = await client.requestRaw('search', buildSearchData({ keyword: 'k' }))
  assert.deepEqual(raw.ret, ['SUCCESS::调用成功'])
  assert.deepEqual(raw.data, { resultList: [] })
})

test('client：无 token 时抛 unauthorized（默认 requireToken）', async () => {
  const { transport, calls } = makeTransport({ ret: ['SUCCESS::x'], data: {} })
  const client = createMtopClient({ transport, getToken: () => null })

  const error = await captureError(() => client.search({ keyword: 'k' }))
  assert.ok(error instanceof PlatformError)
  assert.equal(error.category, 'unauthorized')
  assert.equal(calls.length, 0, '未登录不应发出请求')
})

test('client：requireToken=false 时允许空 token', async () => {
  const { transport } = makeTransport({ ret: ['SUCCESS::x'], data: { ok: true } })
  const client = createMtopClient({ transport, getToken: () => null, requireToken: false })
  assert.deepEqual(await client.search({ keyword: 'k' }), { ok: true })
})

test('client：ret 失败时按类别抛错（token 过期 / 风控）', async () => {
  const expired = makeTransport({ ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'] })
  const expiredError = await captureError(() =>
    createMtopClient({ transport: expired.transport, getToken: () => 'tok' }).search({ keyword: 'k' }),
  )
  assert.ok(expiredError instanceof PlatformError)
  assert.equal(expiredError.category, 'token-expired')
  assert.equal(expiredError.retCode, 'FAIL_SYS_TOKEN_EXOIRED')

  const captcha = makeTransport({ ret: ['FAIL_SYS_USER_VALIDATE::需要验证'] })
  const captchaError = await captureError(() =>
    createMtopClient({ transport: captcha.transport, getToken: () => 'tok' }).search({ keyword: 'k' }),
  )
  assert.ok(captchaError instanceof PlatformError)
  assert.equal(captchaError.category, 'captcha')
})

test('client.suggest：返回词列表', async () => {
  const { transport } = makeTransport({
    ret: ['SUCCESS::x'],
    data: { items: [{ suggest: 'iPhone 17' }, { suggest: 'iPhone 16' }] },
  })
  const client = createMtopClient({ transport, getToken: () => 'tok' })
  assert.deepEqual(await client.suggest('iPhone'), ['iPhone 17', 'iPhone 16'])
})

test('client：每次请求都经过 rateLimiter.acquire', async () => {
  const { transport } = makeTransport({ ret: ['SUCCESS::x'], data: {} })
  let acquired = 0
  const rateLimiter = {
    minIntervalMs: 1500,
    acquire: async () => {
      acquired += 1
    },
  }
  const client = createMtopClient({ transport, getToken: () => 'tok', rateLimiter })

  await client.search({ keyword: 'a' })
  await client.search({ keyword: 'b' })
  assert.equal(acquired, 2)
})
