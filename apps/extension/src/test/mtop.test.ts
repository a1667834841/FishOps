import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  MTOP_APP_KEY,
  extractToken,
  generateSignature,
  getFullToken,
  md5,
  parseToken,
} from '../platform/sign.ts'
import {
  buildReadRequest,
  classifyMtopRet,
  classifyReadResponse,
  type ReadRequest,
} from '../platform/mtop.ts'
import { ApiError } from '../errors.ts'

/** node:crypto 作为标准 MD5(UTF-8) 参考实现。 */
function stdMd5(input: string): string {
  return createHash('md5').update(input, 'utf8').digest('hex')
}

const TOKEN = 'legacyToken'
const TS = '1700000000000'

/** 捕获同步抛出的错误，便于断言错误码。 */
function capture(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  return undefined
}

function captureCode(fn: () => unknown): string {
  const error = capture(fn)
  assert.ok(error instanceof ApiError, `应抛出 ApiError，实际：${String(error)}`)
  return error.code
}

test('md5：已知固定向量与标准实现一致', () => {
  assert.equal(md5(''), 'd41d8cd98f00b204e9800998ecf8427e')
  assert.equal(md5('abc'), '900150983cd24fb0d6963f7d28e17f72')
  assert.equal(md5('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0')
  for (const input of ['', '中文测试', '{"itemId":"123"}', 'emoji 🐟 test', 'a'.repeat(1000)]) {
    assert.equal(md5(input), stdMd5(input), `md5 不一致: ${JSON.stringify(input)}`)
  }
})

test('token：从 cookie 解析完整值并只取签名用前缀', () => {
  const cookie = 'a=1; _m_h5_tk=abc_1766679362907; _m_h5_tk_enc=encvalue; b=2'
  assert.equal(getFullToken(cookie), 'abc_1766679362907')
  assert.equal(parseToken('abc_1766679362907'), 'abc')
  assert.equal(extractToken(cookie), 'abc')
  assert.equal(getFullToken('_m_h5_tk_enc=encvalue'), null)
  assert.equal(extractToken('foo=1; bar=2'), null)
})

test('generateSignature：签名公式与 legacy 一致', () => {
  const result = generateSignature({ itemId: '123' }, { token: 'tok', timestamp: TS })
  const expected = `tok&${TS}&${MTOP_APP_KEY}&{"itemId":"123"}`
  assert.equal(result.signString, expected)
  assert.equal(result.sign, stdMd5(expected))
  assert.equal(result.appKey, MTOP_APP_KEY)
})

test('buildReadRequest：item.detail 生成与 legacy 一致的 URL/签名/body', () => {
  const request = buildReadRequest('item.detail', { itemId: '123' }, TOKEN, TS)
  const data = JSON.stringify({ itemId: '123' })
  const sign = stdMd5(`${TOKEN}&${TS}&${MTOP_APP_KEY}&${data}`)
  const expectedUrl =
    'https://h5api.m.goofish.com/h5/mtop.taobao.idle.pc.detail/1.0/' +
    '?jsv=2.7.2' +
    `&appKey=${MTOP_APP_KEY}` +
    `&t=${TS}` +
    `&sign=${sign}` +
    '&v=1.0' +
    '&type=originaljson' +
    '&accountSite=xianyu' +
    '&dataType=json' +
    '&timeout=20000' +
    '&api=mtop.taobao.idle.pc.detail' +
    '&sessionOption=AutoLoginOnly'
  assert.equal(request.url, expectedUrl)
  assert.equal(request.body, 'data=' + encodeURIComponent(data))
  // 浏览器禁止脚本设置 Origin/Referer（forbidden header names），因此只保留这两个头。
  assert.deepEqual(request.headers, {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  })
  assert.ok(!('origin' in request.headers))
  assert.ok(!('referer' in request.headers))
  assert.equal(request.credentials, 'include')
})

test('buildReadRequest：search.items 业务数据与 legacy fetchSearchData 一致', () => {
  const request = buildReadRequest(
    'search.items',
    { keyword: 'iPhone 17', page: 2, rowsPerPage: 10, filter: { publishDays: 14 } },
    TOKEN,
    TS,
  )
  const data = {
    pageNumber: 2,
    keyword: 'iPhone 17',
    fromFilter: false,
    rowsPerPage: 10,
    sortValue: '',
    sortField: '',
    customDistance: '',
    gps: '',
    propValueStr: { searchFilter: 'publishDays:14;' },
    customGps: '',
    searchReqFromPage: 'pcSearch',
    extraFilterValue: '{}',
    userPositionJson: '{}',
  }
  const json = JSON.stringify(data)
  const sign = stdMd5(`${TOKEN}&${TS}&${MTOP_APP_KEY}&${json}`)
  assert.equal(request.body, 'data=' + encodeURIComponent(json))
  assert.ok(request.url.includes(`&sign=${sign}&`))
  assert.ok(request.url.includes('&api=mtop.taobao.idlemtopsearch.pc.search&'))
  assert.ok(
    request.url.startsWith('https://h5api.m.goofish.com/h5/mtop.taobao.idlemtopsearch.pc.search/1.0/?jsv=2.7.2'),
  )
})

test('buildReadRequest：search.items 未指定页码/每页数时使用 legacy 默认值', () => {
  const request = buildReadRequest('search.items', { keyword: 'k', filter: {} }, TOKEN, TS)
  const body = decodeURIComponent(request.body.replace(/^data=/, ''))
  const data = JSON.parse(body) as Record<string, unknown>
  assert.equal(data['pageNumber'], 1)
  assert.equal(data['rowsPerPage'], 30)
  // 空 filter 不附带 legacy 隐式十四天条件。
  assert.deepEqual(data['propValueStr'], { searchFilter: '' })
})

test('buildReadRequest：search.suggest 业务数据与 legacy 默认一致', () => {
  const request = buildReadRequest('search.suggest', { keyword: '手机壳' }, TOKEN, TS)
  const json = decodeURIComponent(request.body.replace(/^data=/, ''))
  assert.deepEqual(JSON.parse(json), {
    inputWords: '手机壳',
    searchReqFromPage: 'xyPcHome',
    bucketId: 30,
    type: 0,
  })
  assert.ok(request.url.includes('&api=mtop.taobao.idlemtopsearch.pc.search.suggest&'))
})

test('搜索 filter：只输出有 legacy 生产依据的 publishDays，其余明确拒绝', () => {
  const withFilter = (filter: Record<string, unknown>): string => {
    const request = buildReadRequest('search.items', { keyword: 'k', filter }, TOKEN, TS)
    const body = decodeURIComponent(request.body.replace(/^data=/, ''))
    const data = JSON.parse(body) as { propValueStr: { searchFilter: string } }
    return data.propValueStr.searchFilter
  }
  // publishDays 有 legacy 生产依据（旧平台层默认 `publishDays:14;`）。
  assert.equal(withFilter({ publishDays: 7 }), 'publishDays:7;')
  assert.equal(withFilter({ publishDays: 365 }), 'publishDays:365;')
  assert.equal(withFilter({}), '')
  // 即使绕过公共 schema，平台层也必须拒绝没有服务端映射的筛选字段。
  assert.equal(captureCode(() => withFilter({ minPrice: 10 })), 'BAD_REQUEST')
  assert.equal(captureCode(() => withFilter({ maxPrice: 20 })), 'BAD_REQUEST')
  assert.equal(captureCode(() => withFilter({ minPrice: 10, maxPrice: 20 })), 'BAD_REQUEST')
  assert.equal(captureCode(() => withFilter({ freeShipping: true })), 'BAD_REQUEST')
  assert.equal(captureCode(() => withFilter({ freeShipping: false })), 'BAD_REQUEST')
  assert.equal(captureCode(() => withFilter({ publishDays: 7, freeShipping: true })), 'BAD_REQUEST')
})

test('buildReadRequest：严格 schema 拒绝非法参数', () => {
  const bad = (fn: () => unknown): void => assert.equal(captureCode(fn), 'BAD_REQUEST')
  bad(() => buildReadRequest('chat.send', { keyword: 'k' }, TOKEN, TS))
  bad(() => buildReadRequest('search.items', { keyword: 'k', maxAgeSec: 60 }, TOKEN, TS))
  bad(() => buildReadRequest('search.items', { page: 1 }, TOKEN, TS))
  bad(() => buildReadRequest('search.items', { keyword: 'k', page: 0 }, TOKEN, TS))
  bad(() => buildReadRequest('search.items', { keyword: 'k', rowsPerPage: 31 }, TOKEN, TS))
  bad(() => buildReadRequest('search.items', { keyword: '   ' }, TOKEN, TS))
  bad(() => buildReadRequest('search.items', { keyword: 'k', filter: { unknown: 1 } }, TOKEN, TS))
  bad(() => buildReadRequest('item.detail', { itemId: '1', page: 1 }, TOKEN, TS))
  bad(() => buildReadRequest('item.detail', { itemId: '' }, TOKEN, TS))
  bad(() => buildReadRequest('search.suggest', { keyword: 'k', page: 1 }, TOKEN, TS))
  bad(() => buildReadRequest('search.suggest', [], TOKEN, TS))
  bad(() => buildReadRequest('item.detail', { itemId: '1' }, '', TS))
  bad(() => buildReadRequest('item.detail', { itemId: '1' }, TOKEN, 'abc'))
  bad(() => buildReadRequest('item.detail', { itemId: '1' }, TOKEN, ''))
})

test('buildReadRequest：返回只含必要字段，不泄露 token 或签名原始拼接', () => {
  const request = buildReadRequest('search.items', { keyword: 'k', filter: {} }, TOKEN, TS)
  assert.deepEqual(Object.keys(request).sort(), ['body', 'credentials', 'headers', 'url'])
  const serialized = JSON.stringify(request)
  const signStringPrefix = `${TOKEN}&${TS}&${MTOP_APP_KEY}`
  assert.ok(!serialized.includes(signStringPrefix), '不得包含签名原始拼接')
  assert.ok(!('token' in request), '不得包含 token 独立字段')
  assert.ok(!('signString' in request), '不得包含 signString 字段')
  assert.ok(!serialized.includes(`"${TOKEN}"`), '不得把 token 作为独立值返回')
})

test('buildReadRequest：构造过程不发起任何网络请求', () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (() => {
    calls += 1
    throw new Error('构造阶段禁止网络')
  }) as unknown as typeof fetch
  let request: ReadRequest | undefined
  try {
    request = buildReadRequest('search.items', { keyword: 'k', filter: {} }, TOKEN, TS)
    buildReadRequest('search.suggest', { keyword: 'k' }, TOKEN, TS)
    buildReadRequest('item.detail', { itemId: '1' }, TOKEN, TS)
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls, 0)
  assert.ok(request !== undefined)
})

test('classifyMtopRet：成功返回 null，失败按类别脱敏映射', () => {
  assert.equal(classifyMtopRet(['SUCCESS::调用成功']), null)
  const risk = classifyMtopRet(['FAIL_SYS_USER_VALIDATE::哎哟喂,被挤爆啦'])
  assert.ok(risk instanceof ApiError)
  assert.equal(risk.code, 'RISK_BLOCKED')
  assert.equal(risk.phase, 'read')
  const rgv = classifyMtopRet(['RGV587_ERROR::SM::被挤爆啦'])
  assert.equal(rgv?.code, 'RISK_BLOCKED')
  assert.equal(classifyMtopRet(['FAIL_SYS_TOKEN_EXOIRED::令牌过期'])?.code, 'LOGIN_REQUIRED')
  assert.equal(classifyMtopRet(['FAIL_SYS_TOKEN_EXPIRED::令牌过期'])?.code, 'LOGIN_REQUIRED')
  assert.equal(classifyMtopRet(['FAIL_SYS_SESSION_EXPIRED::Session expired'])?.code, 'LOGIN_REQUIRED')
  assert.equal(classifyMtopRet(['FAIL_BIZ_ITEM_NOT_FOUND::宝贝不存在'])?.code, 'PLATFORM_REJECTED')
})

test('classifyReadResponse：拒绝缺 ret，且不返回原始 ret 正文', () => {
  assert.equal(classifyReadResponse({ ret: ['SUCCESS::调用成功'], data: {} }), null)
  const missing = classifyReadResponse({ data: {} })
  assert.equal(missing?.code, 'PLATFORM_REJECTED')
  assert.equal(classifyReadResponse(null)?.code, 'PLATFORM_REJECTED')
  assert.equal(classifyReadResponse('plain text')?.code, 'PLATFORM_REJECTED')
  assert.equal(classifyReadResponse({ ret: 'SUCCESS' })?.code, 'PLATFORM_REJECTED')
  assert.equal(classifyReadResponse({ ret: null })?.code, 'PLATFORM_REJECTED')
  assert.equal(classifyReadResponse('<html>x5sec challenge</html>')?.code, 'RISK_BLOCKED')
  const rejected = classifyReadResponse({ ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'] })
  assert.equal(rejected?.code, 'LOGIN_REQUIRED')
  const bizRejected = classifyReadResponse({ ret: ['FAIL_BIZ_ITEM_NOT_FOUND::宝贝不存在'] })
  assert.equal(bizRejected?.code, 'PLATFORM_REJECTED')
  // 分类结果不得回传平台原始 ret 文本。
  assert.ok(!JSON.stringify(rejected).includes('FAIL_SYS'))
  assert.ok(!JSON.stringify(bizRejected).includes('FAIL_BIZ'))
  assert.equal(missing?.message, '闲鱼接口拒绝了本次请求')
})
