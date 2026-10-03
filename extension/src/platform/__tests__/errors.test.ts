import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PlatformError,
  classifyMtopPayload,
  classifyMtopRet,
  classifyThrownError,
  defaultMessageFor,
  isMtopSuccess,
  toPlatformError,
} from '../errors'

test('isMtopSuccess：仅 SUCCESS 前缀视为成功', () => {
  assert.equal(isMtopSuccess(['SUCCESS::调用成功']), true)
  assert.equal(isMtopSuccess(['FAIL_SYS_TOKEN_EXOIRED::令牌过期']), false)
  assert.equal(isMtopSuccess('SUCCESS::调用成功'), false)
  assert.equal(isMtopSuccess(undefined), false)
})

test('classifyMtopRet：成功返回 null', () => {
  assert.equal(classifyMtopRet(['SUCCESS::调用成功']), null)
  assert.equal(classifyMtopRet(null), null)
})

test('classifyMtopRet：token 过期 / 为空', () => {
  assert.deepEqual(classifyMtopRet(['FAIL_SYS_TOKEN_EXOIRED::令牌过期']), {
    category: 'token-expired',
    retCode: 'FAIL_SYS_TOKEN_EXOIRED',
  })
  assert.equal(classifyMtopRet(['FAIL_SYS_TOKEN_EXPIRED::x'])?.category, 'token-expired')
  assert.equal(classifyMtopRet(['FAIL_SYS_TOKEN_EMPTY::x'])?.category, 'token-expired')
})

test('classifyMtopRet：验证码 / 风控', () => {
  assert.equal(classifyMtopRet(['FAIL_SYS_USER_VALIDATE::需要验证'])?.category, 'captcha')
  assert.equal(
    classifyMtopRet(['RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试'])?.category,
    'captcha',
  )
})

test('classifyMtopRet：未登录 / 会话失效', () => {
  assert.equal(classifyMtopRet(['FAIL_SYS_SESSION_EXPIRED::会话失效'])?.category, 'unauthorized')
  assert.equal(classifyMtopRet(['FAIL_SYS_NOT_LOGIN::请先登录'])?.category, 'unauthorized')
})

test('classifyMtopRet：无法归类的业务错误落到 api', () => {
  const matched = classifyMtopRet(['FAIL_BIZ_SOMETHING::未知错误'])
  assert.equal(matched?.category, 'api')
  assert.equal(matched?.retCode, 'FAIL_BIZ_SOMETHING')
})

test('classifyMtopPayload：正常成功响应返回 null', () => {
  assert.equal(classifyMtopPayload({ ret: ['SUCCESS::调用成功'], data: { a: 1 } }), null)
})

test('classifyMtopPayload：缺少 ret 视为被拦截', () => {
  const payload = classifyMtopPayload({ data: { a: 1 } })
  assert.equal(payload?.category, 'api')
})

test('classifyMtopPayload：HTML / 文本风控页按特征识别', () => {
  assert.equal(classifyMtopPayload('<html>..._tmd_...punish...</html>')?.category, 'captcha')
  assert.equal(classifyMtopPayload('something else')?.category, 'unknown')
})

test('classifyMtopPayload：非对象输入为 unknown', () => {
  assert.equal(classifyMtopPayload(null)?.category, 'unknown')
  assert.equal(classifyMtopPayload(42)?.category, 'unknown')
})

test('classifyThrownError：网络错误与超时', () => {
  assert.equal(classifyThrownError(new TypeError('Failed to fetch')).category, 'network')
  const abortError = new Error('aborted')
  abortError.name = 'AbortError'
  assert.equal(classifyThrownError(abortError).category, 'network')
})

test('PlatformError.toPayload：只含安全文本，不带凭据', () => {
  const error = new PlatformError('token-expired', defaultMessageFor('token-expired'), {
    retCode: 'FAIL_SYS_TOKEN_EXOIRED',
  })
  assert.deepEqual(error.toPayload(), {
    category: 'token-expired',
    message: defaultMessageFor('token-expired'),
    retCode: 'FAIL_SYS_TOKEN_EXOIRED',
  })
  assert.equal(error instanceof Error, true)
  assert.equal(error.name, 'PlatformError')
})

test('toPlatformError：普通异常被归一为 PlatformError', () => {
  const normalized = toPlatformError(new TypeError('Failed to fetch'))
  assert.equal(normalized instanceof PlatformError, true)
  assert.equal(normalized.category, 'network')

  const already = new PlatformError('captcha', 'x')
  assert.equal(toPlatformError(already), already)
})
