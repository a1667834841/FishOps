import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlatformError } from '../errors'
import { readTrustedUserIdInPage } from '../host-client'
import { md5 } from '../xianyu/sign'
import {
  LOGIN_USER_API,
  buildLoginUserRequest,
  createAuthService,
  extractUserId,
  extractUserIdFromCookie,
  isValidUserId,
} from '../xianyu/auth'
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

const COOKIE = 'a=1; _m_h5_tk=tok_1700000000000; _m_h5_tk_enc=enc; b=2'
const COOKIE_WITH_USER = 'a=1; _m_h5_tk=tok_1700000000000; unb=4188939592; b=2'

test('getAuthState / getToken：有 token 时登录，且 token 去掉时间戳', () => {
  const auth = createAuthService({ readCookie: () => COOKIE, transport: makeTransport({}).transport })
  assert.deepEqual(auth.getAuthState(), { loggedIn: true, hasToken: true })
  assert.equal(auth.getToken(), 'tok')
})

test('getAuthState：无 token 时未登录，且不泄露 cookie', () => {
  const auth = createAuthService({ readCookie: () => 'x=1', transport: makeTransport({}).transport })
  const state = auth.getAuthState()
  assert.deepEqual(state, { loggedIn: false, hasToken: false })
  assert.equal(auth.getToken(), null)
  // 返回的仅是布尔值，不应包含 cookie 内容
  assert.equal(JSON.stringify(state).includes('_m_h5_tk'), false)
})

test('getCurrentUserId：调用 loginuser.get 并返回 userId', async () => {
  const { transport, calls } = makeTransport({
    ret: ['SUCCESS::调用成功'],
    data: { userId: '123456789' },
  })
  const auth = createAuthService({ readCookie: () => COOKIE, transport, now: () => 1700000000000 })

  assert.equal(await auth.getCurrentUserId(), '123456789')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.method, 'GET')
  assert.equal(calls[0]!.credentials, 'include')
  assert.ok(calls[0]!.url.includes(LOGIN_USER_API))
})

test('getCurrentUserId：无 token 时抛 unauthorized，不发请求', async () => {
  const { transport, calls } = makeTransport({})
  const auth = createAuthService({ readCookie: () => '', transport })
  const error = await auth.getCurrentUserId().catch((e: unknown) => e)
  assert.ok(error instanceof PlatformError)
  assert.equal(error.category, 'unauthorized')
  assert.equal(calls.length, 0)
})

test('isValidUserId：拒绝空 / 含 @ 的值（不把会话 cid / 对方 ID 当本人）', () => {
  assert.equal(isValidUserId('4188939592'), true)
  assert.equal(isValidUserId('abc_123-X'), true)
  assert.equal(isValidUserId(''), false)
  assert.equal(isValidUserId('  '), false)
  assert.equal(isValidUserId('peer@goofish'), false)
  assert.equal(isValidUserId('3004743608@goofish'), false)
  assert.equal(isValidUserId(123 as unknown), false)
})

test('extractUserIdFromCookie：解析受信 unb，非法 / 缺失返回 null', () => {
  assert.equal(extractUserIdFromCookie('a=1; unb=4188939592; b=2'), '4188939592')
  assert.equal(extractUserIdFromCookie('unb=abc_123'), 'abc_123')
  assert.equal(extractUserIdFromCookie('a=1'), null)
  // 不作为独立字段名（前面无 ; 分隔）时不命中，避免误判。
  assert.equal(extractUserIdFromCookie('a=unb=999'), null)
  assert.equal(extractUserIdFromCookie('unb='), null)
  assert.equal(extractUserIdFromCookie('unb=peer@goofish'), null)
})

test('parity：注入版 readTrustedUserIdInPage 与 auth.extractUserIdFromCookie 结果一致', () => {
  const havana = Buffer.from(JSON.stringify({ hid: 4188939592, sg: 'x', token: 'y' })).toString('base64')
  const cases = [
    'a=1; unb=4188939592; b=2',
    'unb=abc_123',
    'a=1',
    'a=unb=999',
    'unb=',
    'unb=peer@goofish',
    `_m_h5_tk=tok_1; havana_lgc2_77=${havana}`,
    'havana_lgc2_77=@@@',
    '',
  ]
  for (const cookie of cases) {
    assert.equal(readTrustedUserIdInPage(cookie).userId, extractUserIdFromCookie(cookie), `cookie=${cookie}`)
  }
})

test('extractUserIdFromCookie：unb 缺失时回退 havana_lgc2_* 的 hid（只取 hid）', () => {
  const havana = Buffer.from(JSON.stringify({ hid: 4188939592, sg: 'x', token: 'secret' })).toString('base64')
  assert.equal(extractUserIdFromCookie(`a=1; havana_lgc2_77=${havana}; b=2`), '4188939592')
  // 非法 hid（含 @）不接受
  const bad = Buffer.from(JSON.stringify({ hid: 'peer@goofish' })).toString('base64')
  assert.equal(extractUserIdFromCookie(`havana_lgc2_77=${bad}`), null)
  // 非 JSON base64 不抛错、返回 null
  assert.equal(extractUserIdFromCookie('havana_lgc2_77=@@@'), null)
})

test('getCurrentUserId：unb 缺失但有 havana hid 时返回 hid，不调用 MTOP', async () => {
  const havana = Buffer.from(JSON.stringify({ hid: 4188939592 })).toString('base64')
  const { transport, calls } = makeTransport({ ret: ['SUCCESS::调用成功'], data: { userId: 'wrong' } })
  const auth = createAuthService({ readCookie: () => `_m_h5_tk=tok_1; havana_lgc2_77=${havana}`, transport })
  assert.equal(await auth.getCurrentUserId(), '4188939592')
  assert.equal(calls.length, 0)
})

test('getCurrentUserId：优先受信 unb cookie，不调用 MTOP', async () => {
  const { transport, calls } = makeTransport({ ret: ['SUCCESS::调用成功'], data: { userId: '999999999' } })
  const auth = createAuthService({ readCookie: () => COOKIE_WITH_USER, transport })
  assert.equal(await auth.getCurrentUserId(), '4188939592')
  assert.equal(calls.length, 0)
})

test('getCurrentUserId：无 unb 时回退 MTOP（保留错误类别透传）', async () => {
  const { transport, calls } = makeTransport({ ret: ['FAIL_SYS_ILLEGAL_ACCESS::非法访问'] })
  const auth = createAuthService({ readCookie: () => COOKIE, transport })
  const error = await auth.getCurrentUserId().catch((e: unknown) => e)
  assert.ok(error instanceof PlatformError)
  assert.equal(error.category, 'api')
  assert.equal(error.retCode, 'FAIL_SYS_ILLEGAL_ACCESS')
  assert.equal(calls.length, 1)
})

test('getCurrentUserId：ret 失败时按类别抛错', async () => {
  const { transport } = makeTransport({ ret: ['FAIL_SYS_SESSION_EXPIRED::会话失效'] })
  const auth = createAuthService({ readCookie: () => COOKIE, transport })
  const error = await auth.getCurrentUserId().catch((e: unknown) => e)
  assert.ok(error instanceof PlatformError)
  assert.equal(error.category, 'unauthorized')
})

test('buildLoginUserRequest：GET 请求、URL 参数与签名与旧 user-api 一致', () => {
  const request = buildLoginUserRequest('tok', '1700000000000')
  assert.equal(request.method, 'GET')
  assert.equal(request.credentials, 'include')

  const url = new URL(request.url)
  const entries = [...url.searchParams.entries()]
  assert.equal(url.searchParams.get('api'), LOGIN_USER_API)
  assert.equal(url.searchParams.get('appKey'), '34839810')
  assert.equal(url.searchParams.get('t'), '1700000000000')
  assert.equal(url.searchParams.get('spm_cnt'), 'a21ybx.im.0.0')

  // 重建签名串：签名的 sign 参与方式为空串
  const signData = entries.map(([key, value]) => `${key}=${key === 'sign' ? '' : value}`).join('&')
  assert.equal(
    url.searchParams.get('sign'),
    md5(`tok&1700000000000&34839810&${signData}`),
  )
})

test('extractUserId：支持字符串 / 数字，缺失返回 null', () => {
  assert.equal(extractUserId({ data: { userId: '42' } }), '42')
  assert.equal(extractUserId({ data: { userId: 42 } }), '42')
  assert.equal(extractUserId({ data: {} }), null)
  assert.equal(extractUserId(null), null)
})
