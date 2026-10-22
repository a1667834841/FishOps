import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { injectDirectPublishInPage } from '../../background/direct-publish-page'
import { createDirectPublishApi } from '../../background/direct-publish-api'

// 在独立页面环境运行真实注入函数，验证 SDK 错误不会把 URL/凭据带入日志。
async function runPage(ret: string) {
  const logs: unknown[][] = []
  const context = vm.createContext({
    window: {
      location: { hostname: 'www.goofish.com' },
      document: { cookie: 'unb=private-user; _m_h5_tk=private-token' },
      lib: { mtop: { request: async () => { throw { ret: [ret] } } } },
    },
    console: { info: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) },
    setTimeout, clearTimeout, TextEncoder, crypto, URL,
  })
  const result = await vm.runInContext(
    `(${injectDirectPublishInPage.toString()})({op:'getProduct',sourceItemId:'123',traceId:'test-trace'})`, context,
  )
  return { result, logs }
}

test('页面验证码错误：记录阶段/接口/错误码，不记录验证码URL或凭据', async () => {
  const { result, logs } = await runPage('FAIL_SYS_USER_VALIDATE::滑块 https://example.com/?x5sec=private-secret');
  assert.equal(result.status, 'action_required')
  assert.equal(result.actionRequired, 'captcha')
  const last = logs.at(-1)?.[1] as Record<string, unknown>
  assert.equal(last.traceId, 'test-trace')
  assert.equal(last.api, 'mtop.taobao.idle.pc.detail')
  assert.equal(last.code, 'FAIL_SYS_USER_VALIDATE')
  assert.equal(last.actionRequired, 'captcha')
  assert.doesNotMatch(JSON.stringify(logs), /private-|https:|x5sec=/)
})

test('页面 TIMEOUT：返回未知，不将超时日志误报为滑块', async () => {
  const { result, logs } = await runPage('TIMEOUT::接口超时')
  assert.equal(result.status, 'unknown')
  const last = logs.at(-1)?.[1] as Record<string, unknown>
  assert.equal(last.code, 'TIMEOUT')
  assert.equal(last.actionRequired, undefined)
})

test('请求开始日志仅表示pending，不表示成功', async () => {
  const { logs } = await runPage('TIMEOUT::接口超时')
  const first = logs[0]?.[1] as Record<string, unknown>
  assert.equal(first.event, 'request_started')
  assert.equal(first.status, 'pending')
})

test('RGV587风控码归类验证码', async () => {
  const { result } = await runPage('FAIL_SYS_RGV587_ERROR::被挤爆')
  assert.equal(result.actionRequired, 'captcha')
})

test('后台记录脱敏阶段结果，traceId传入页面，不打印结果正文', async (t) => {
  const logs: unknown[][] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => logs.push(args))
  t.mock.method(console, 'info', (...args: unknown[]) => logs.push(args))
  let traceId: unknown
  const api = createDirectPublishApi({ chrome: {
    tabs: {
      query: async () => [{ id: 1, status: 'complete', url: 'https://www.goofish.com/publish?fishopsDirectPublish=1' }],
      create: async () => { throw new Error('不应创建') }, get: async () => ({ id: 1, status: 'complete' }),
    },
    scripting: { executeScript: async <T>(injection: { args: unknown[] }) => {
      traceId = (injection.args[0] as { traceId: string }).traceId
      return [{ result: { ok: false, op: 'getProduct', status: 'action_required', code: 'CAPTCHA_REQUIRED',
        actionRequired: 'captcha', message: 'https://example.com/?token=private-secret' } as T }]
    } },
    storage: { local: { get: async () => ({}), set: async () => {} } },
  } })
  const result = await api.getProduct('123')
  assert.equal(result.actionRequired, 'captcha')
  const last = logs.at(-1)?.[1] as Record<string, unknown>
  assert.equal(last.traceId, traceId)
  assert.equal(last.phase, 'getProduct')
  assert.equal(last.actionRequired, 'captcha')
  assert.doesNotMatch(JSON.stringify(logs), /private-|https:|token=/)
})
