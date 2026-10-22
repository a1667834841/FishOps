import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { TextDecoder, TextEncoder } from 'node:util'

test('MAIN产物加载和初始化无网络，重复加载不覆盖运行时', () => {
  const source = readFileSync(new URL('../../apps/extension/dist/page-main.js', import.meta.url), 'utf8')
  let cookieReads = 0
  const document = { get cookie() { cookieReads++; return 'unb=123' } }
  const scope = { TextEncoder, TextDecoder, WebSocket: class { constructor() { throw new Error('禁止主动建连') } }, document, location: { origin: 'https://www.goofish.com' }, fetch() { throw new Error('不允许启动探测') } }
  runInNewContext(source, scope)
  assert.equal(cookieReads, 0)
  scope.__fishopsInitPageRuntimeV1__('d')
  const runtime = scope.__fishopsPageRuntimeV1__
  assert.equal(runtime.status().documentId, 'd')
  assert.equal(cookieReads, 0)
  runInNewContext(source, scope)
  scope.__fishopsInitPageRuntimeV1__('d')
  assert.equal(scope.__fishopsPageRuntimeV1__, runtime)
  assert.throws(() => scope.__fishopsInitPageRuntimeV1__('different'), /代次/)
})

test('MAIN产物在固定 documentId 内单次执行并返回归一化建议词', async () => {
  const source = readFileSync(new URL('../../apps/extension/dist/page-main.js', import.meta.url), 'utf8')
  const calls = []
  const scope = {
    TextDecoder,
    TextEncoder,
    URLSearchParams,
    WebSocket: class { constructor() { throw new Error('禁止主动建连') } },
    setTimeout,
    clearTimeout,
    document: {
      cookie:
        'unb=123456; _m_h5_tk=token-from-cookie_1699999999999; sensitive-cookie=must-not-leak',
    },
    location: { origin: 'https://www.goofish.com' },
    fetch: async (url, init) => {
      calls.push({ url, init })
      return {
        status: 200,
        async text() {
          return JSON.stringify({
            ret: ['SUCCESS::调用成功'],
            data: { items: [{ suggest: ' iPhone 17 ' }, { suggest: 'iphone 17' }, { suggest: 'iPad' }] },
          })
        },
      }
    },
  }
  runInNewContext(source, scope)
  scope.__fishopsInitPageRuntimeV1__('doc-main-1')
  const request = {
    kind: 'request-step',
    id: 'step-main-1',
    requestId: 'request-main-1',
    method: 'search.suggest',
    params: { keyword: 'iPhone' },
    context: { accountId: '123456', tabId: 9, documentId: 'doc-main-1' },
  }

  const result = await scope.__fishopsPageRuntimeV1__.execute(request)
  assert.equal(result.ok, true)
  // 跨 vm realm 的数组原型不同，按可序列化值比较实际输出。
  assert.equal(JSON.stringify(result.data), JSON.stringify(['iPhone 17', 'iPad']))
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /mtop\.taobao\.idlemtopsearch\.pc\.search\.suggest/)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.credentials, 'include')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(JSON.stringify(result).includes('token-from-cookie'), false)
  assert.equal(JSON.stringify(result).includes('sensitive-cookie'), false)
})
