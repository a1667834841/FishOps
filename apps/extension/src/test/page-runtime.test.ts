import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPageRuntime, type PageResponseLike, type PageRuntime } from '../page-runtime.ts'
import type { StepWire } from '../../../../packages/protocol/src/step.ts'

const DOCUMENT_ID = 'doc-1'
const ACCOUNT_ID = 'account-1'
const COOKIE = '_m_h5_tk=token-secret_1699999999999; other=1'

type RequestStep = Extract<StepWire, { kind: 'request-step' }>
type StepResult = Extract<StepWire, { kind: 'step-result' }>
type FetchCall = { url: string; init: Record<string, unknown> }

const DETAIL_OK = {
  ret: ['SUCCESS::调用成功'],
  data: {
    itemDO: {
      itemId: '2002',
      title: '详情商品',
      soldPrice: '88.50',
      imageInfos: [{ url: '//img.example.com/detail.jpg' }],
      status: '在售',
      wantCnt: 3,
      gmtCreate: '1699000000000',
      desc: '商品描述',
      browseCnt: '1,234',
    },
    sellerDO: { sellerId: '3003', nick: '卖家B', city: '北京' },
  },
}

const SEARCH_OK = {
  ret: ['SUCCESS::调用成功'],
  data: {
    resultList: [
      {
        data: {
          item: {
            main: {
              exContent: {
                itemId: '1001',
                title: '搜索商品',
                price: '19.90',
                picUrl: '//img.example.com/search.jpg',
                area: '杭州',
                userNickName: '卖家A',
                fishTags: { tagInfo: { tagList: [{ data: { content: '5人想要' } }] } },
              },
              clickParam: { args: { item_id: '1001', publishTime: '1699000000000' } },
            },
          },
        },
      },
    ],
    hasMore: true,
  },
}

const SUGGEST_OK = {
  ret: ['SUCCESS::调用成功'],
  data: { items: [{ suggest: '手机壳' }, { suggest: '手机' }] },
}

/** 假响应：单个 UTF-8 分片，用于覆盖流式读取主路径。 */
function replyText(text: string, status = 200): PageResponseLike {
  const bytes = new TextEncoder().encode(text)
  return {
    status,
    body: {
      getReader: () => {
        let sent = false
        return {
          read: async () => {
            if (sent) return { done: true }
            sent = true
            return { done: false, value: bytes }
          },
          cancel: async () => {},
        }
      },
    },
    text: async () => text,
  }
}

function replyJson(payload: unknown, status = 200): PageResponseLike {
  return replyText(JSON.stringify(payload), status)
}

function runtimeFor(
  scope: Record<string, unknown>,
  options: {
    accountId?: () => string | null | Promise<string | null>
    cookie?: () => string | Promise<string>
    respond?: (call: FetchCall) => Promise<PageResponseLike>
    now?: () => number
    readTimeoutMs?: number
  } = {},
): { runtime: PageRuntime; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const runtime = createPageRuntime({
    scope,
    documentId: DOCUMENT_ID,
    readAccountId: options.accountId ?? (() => ACCOUNT_ID),
    readCookie: options.cookie ?? (() => COOKIE),
    now: options.now ?? (() => 1_700_000_000_000),
    readTimeoutMs: options.readTimeoutMs,
    fetch: async (url, init) => {
      const call: FetchCall = { url, init: { ...init } }
      calls.push(call)
      if (!options.respond) throw new Error('测试未提供响应')
      return options.respond(call)
    },
  })
  return { runtime, calls }
}

let stepSeq = 0
function step(
  method: RequestStep['method'],
  params: Record<string, unknown>,
  id?: string,
): RequestStep {
  stepSeq += 1
  return {
    kind: 'request-step',
    id: id ?? `step-${stepSeq}`,
    requestId: `request-${stepSeq}`,
    method,
    // 测试直接构造业务参数；运行时必须自行校验，不能信任调用方类型。
    params: params as RequestStep['params'],
    context: { accountId: ACCOUNT_ID, tabId: 1, documentId: DOCUMENT_ID },
  }
}

/** 让异步队列推进若干轮，用于断言“尚未终结”。 */
async function tick(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

function okData(result: StepResult): unknown {
  assert.equal(result.ok, true, `期望成功，实际：${JSON.stringify(result)}`)
  if (!result.ok) throw new Error('不可达')
  return result.data
}

function errorCode(result: StepResult): string {
  assert.equal(result.ok, false, `期望失败，实际：${JSON.stringify(result)}`)
  if (result.ok) throw new Error('不可达')
  return result.error.code
}

test('三种只读方法成功各发一次 POST，返回归一化数据且不泄露 cookie 与 token', async () => {
  const scope: Record<string, unknown> = {}
  const { runtime, calls } = runtimeFor(scope, {
    respond: async (call) => {
      if (call.url.includes('idle.pc.detail')) return replyJson(DETAIL_OK)
      if (call.url.includes('search.suggest')) return replyJson(SUGGEST_OK)
      return replyJson(SEARCH_OK)
    },
  })

  const detail = await runtime.execute(step('item.detail', { itemId: '2002' }))
  const search = await runtime.execute(step('search.items', { keyword: '手机' }))
  const suggest = await runtime.execute(step('search.suggest', { keyword: '手' }))

  const detailData = okData(detail) as { itemId: string; title: string; browseCnt: number }
  assert.equal(detailData.itemId, '2002')
  assert.equal(detailData.title, '详情商品')
  assert.equal(detailData.browseCnt, 1234)
  const searchData = okData(search) as { items: Array<{ itemId: string; wantCnt: number }>; hasMore: boolean }
  assert.equal(searchData.items.length, 1)
  assert.equal(searchData.items[0]?.itemId, '1001')
  assert.equal(searchData.items[0]?.wantCnt, 5)
  assert.deepEqual(okData(suggest), ['手机壳', '手机'])

  assert.equal(calls.length, 3)
  for (const call of calls) {
    assert.equal(call.init['method'], 'POST')
    assert.equal(call.init['credentials'], 'include')
    assert.equal(call.init['redirect'], 'error')
    assert.equal(typeof call.init['body'], 'string')
    assert.ok(call.url.startsWith('https://h5api.m.goofish.com/h5/'))
  }
  assert.deepEqual(runtime.status(), { documentId: DOCUMENT_ID, activeStepId: null, completed: 3 })

  const serialized = JSON.stringify([detail, search, suggest])
  for (const secret of ['token-secret', '_m_h5_tk', 'other=1', 'signString']) {
    assert.ok(!serialized.includes(secret), `结果不得包含敏感片段：${secret}`)
  }
})

test('正文流真实终结前不返回，超时或断线不伪造终结', async () => {
  let releaseEof!: () => void
  const eofGate = new Promise<void>((resolve) => {
    releaseEof = resolve
  })
  const body = JSON.stringify(DETAIL_OK)
  const { runtime } = runtimeFor({}, {
    respond: async () => ({
      status: 200,
      body: {
        getReader: () => {
          let index = 0
          return {
            read: async () => {
              index += 1
              if (index === 1) return { done: false, value: new TextEncoder().encode(body) }
              await eofGate
              return { done: true }
            },
            cancel: async () => {},
          }
        },
      },
      text: async () => body,
    }),
  })

  let settled = false
  const pending = runtime.execute(step('item.detail', { itemId: '2002' })).then((result) => {
    settled = true
    return result
  })
  await tick()
  assert.equal(settled, false, 'EOF 之前不得返回结果')
  assert.equal(runtime.status().activeStepId !== null, true)
  releaseEof()
  assert.equal((await pending).ok, true)
  assert.equal(runtime.status().activeStepId, null)
})

test('runtime 重建复用文档锁：旧步骤在途拒绝新步骤且不发第二个请求', async () => {
  const scope: Record<string, unknown> = {}
  let finishFirst!: (response: PageResponseLike) => void
  const first = runtimeFor(scope, {
    respond: () => new Promise<PageResponseLike>((resolve) => {
      finishFirst = resolve
    }),
  })
  const request = step('item.detail', { itemId: '2002' }, 'shared-step')
  const pending = first.runtime.execute(request)
  await tick()
  assert.equal(first.calls.length, 1)

  const second = runtimeFor(scope, {})
  assert.equal(second.runtime.status().activeStepId, 'shared-step')
  const blocked = await second.runtime.execute(step('item.detail', { itemId: '2002' }, 'other-step'))
  assert.equal(errorCode(blocked), 'PAGE_NOT_READY')
  assert.equal(second.calls.length, 0)

  const duplicate = second.runtime.execute(request)
  finishFirst(replyJson(DETAIL_OK))
  const [original, replay] = await Promise.all([pending, duplicate])
  assert.deepEqual(replay, original)
  assert.equal(first.calls.length, 1)
  assert.equal(second.calls.length, 0)
  assert.equal(second.runtime.status().completed, 1)
})

test('网络失败映射 TIMEOUT 且异常原文与 cookie 不外泄', async () => {
  const { runtime, calls } = runtimeFor({}, {
    respond: async () => {
      throw new Error('cookie=_m_h5_tk=token-secret; raw-body-secret')
    },
  })
  const result = await runtime.execute(step('item.detail', { itemId: '2002' }))
  assert.equal(errorCode(result), 'TIMEOUT')
  assert.equal(calls.length, 1)
  const serialized = JSON.stringify(result)
  for (const secret of ['token-secret', 'raw-body-secret', 'cookie=']) {
    assert.ok(!serialized.includes(secret), `错误结果不得包含敏感片段：${secret}`)
  }
})

test('页面读取超时返回 TIMEOUT，文档锁保留到真实终结后才释放', async () => {
  const scope: Record<string, unknown> = {}
  let finish!: (response: PageResponseLike) => void
  const first = runtimeFor(scope, {
    readTimeoutMs: 20,
    respond: () => new Promise<PageResponseLike>(resolve => { finish = resolve }),
  })
  const request = step('item.detail', { itemId: '2002' }, 'timeout-step')
  const timedOut = await first.runtime.execute(request)
  assert.equal(errorCode(timedOut), 'TIMEOUT')
  assert.equal(first.runtime.status().activeStepId, 'timeout-step', '超时后锁仍占用')
  const blocked = await first.runtime.execute(step('item.detail', { itemId: '2002' }, 'next-step'))
  assert.equal(errorCode(blocked), 'PAGE_NOT_READY')
  assert.equal(first.calls.length, 1, '超时不得提前发下一个平台请求')
  const duplicate = first.runtime.execute(request)
  finish(replyJson(DETAIL_OK))
  const replayed = await duplicate
  assert.equal(replayed.ok, true, '原步骤真实终结后才能取得结果')
  assert.equal(first.runtime.status().activeStepId, null)
  assert.equal(first.calls.length, 1)
  const settled = await first.runtime.execute(request)
  assert.equal(settled.ok, true, '真实终结后同一请求应可回放')
})

test('平台 ret、拦截页与非 2xx 一律拒绝，不伪装成功且不外泄原文', async () => {
  const risk = runtimeFor({}, {
    respond: async () => replyJson({ ret: ['FAIL_SYS_USER_VALIDATE::请完成验证'], data: {} }),
  })
  const blocked = await risk.runtime.execute(step('item.detail', { itemId: '2002' }))
  assert.equal(errorCode(blocked), 'RISK_BLOCKED')
  assert.ok(!JSON.stringify(blocked).includes('FAIL_SYS_USER_VALIDATE'))

  const html = runtimeFor({}, { respond: async () => replyText('<html>请先登录</html>') })
  assert.equal(errorCode(await html.runtime.execute(step('item.detail', { itemId: '2002' }))), 'LOGIN_REQUIRED')

  const http500 = runtimeFor({}, { respond: async () => replyText('backend boom', 503) })
  const rejected = await http500.runtime.execute(step('item.detail', { itemId: '2002' }))
  assert.equal(errorCode(rejected), 'PLATFORM_REJECTED')
  assert.ok(!JSON.stringify(rejected).includes('backend boom'))

  const missingRet = runtimeFor({}, {
    respond: async () => replyJson({ data: { itemDO: { itemId: '2002' } } }),
  })
  assert.equal(errorCode(await missingRet.runtime.execute(step('item.detail', { itemId: '2002' }))), 'PLATFORM_REJECTED')
})

test('缺少 MTOP token 按未登录拒绝且不发请求', async () => {
  const { runtime, calls } = runtimeFor({}, { cookie: () => 'other=1' })
  const result = await runtime.execute(step('item.detail', { itemId: '2002' }))
  assert.equal(errorCode(result), 'LOGIN_REQUIRED')
  assert.equal(calls.length, 0)
})

test('派发前账号不符不发请求，派发后账号变化不返回旧数据', async () => {
  const mismatch = runtimeFor({}, { accountId: () => 'other-account' })
  const refused = await mismatch.runtime.execute(step('item.detail', { itemId: '2002' }))
  assert.equal(errorCode(refused), 'ACCOUNT_CHANGED')
  assert.equal(mismatch.calls.length, 0)

  let samples = 0
  const switched = runtimeFor({}, {
    accountId: () => {
      samples += 1
      return samples === 1 ? ACCOUNT_ID : 'other-account'
    },
    respond: async () => replyJson(DETAIL_OK),
  })
  const changed = await switched.runtime.execute(step('item.detail', { itemId: '2002' }))
  assert.equal(errorCode(changed), 'ACCOUNT_CHANGED')
  assert.equal(switched.calls.length, 1)
  assert.ok(!JSON.stringify(changed).includes('详情商品'))
})

test('响应超过 1 MiB 时取消读取，等待取消完成后才终结', async () => {
  const chunk = new Uint8Array(600 * 1024)
  let cancelDone = false
  let releaseCancel!: () => void
  const cancelGate = new Promise<void>((resolve) => {
    releaseCancel = resolve
  })
  const { runtime, calls } = runtimeFor({}, {
    respond: async () => ({
      status: 200,
      body: {
        getReader: () => {
          let index = 0
          return {
            read: async () => {
              index += 1
              return index <= 2 ? { done: false, value: chunk } : { done: true }
            },
            cancel: async () => {
              await cancelGate
              cancelDone = true
            },
          }
        },
      },
      text: async () => {
        throw new Error('有 body 时不得回退到 text')
      },
    }),
  })

  let settled = false
  const pending = runtime.execute(step('item.detail', { itemId: '2002' })).then((result) => {
    settled = true
    return result
  })
  await tick()
  assert.equal(settled, false, '取消完成前不得终结')
  assert.equal(cancelDone, false)
  releaseCancel()
  const result = await pending
  assert.equal(errorCode(result), 'PAYLOAD_TOO_LARGE')
  assert.equal(cancelDone, true, '必须等待取消完成后才返回')
  assert.equal(calls.length, 1)
})

test('文档标识不匹配与非法步骤一律拒绝且不请求', async () => {
  const scope: Record<string, unknown> = {}
  const { runtime, calls } = runtimeFor(scope)
  const other = { ...step('item.detail', { itemId: '2002' }), context: { accountId: ACCOUNT_ID, tabId: 1, documentId: 'other-doc' } }
  assert.equal(errorCode(await runtime.execute(other)), 'PAGE_NOT_READY')
  assert.equal(errorCode(await runtime.execute({ kind: 'request-step', id: 'bad' })), 'BAD_REQUEST')
  assert.equal(errorCode(await runtime.execute(null)), 'BAD_REQUEST')
  assert.equal(calls.length, 0)
})

test('HTTP 非 2xx 也必须等正文终结才返回，期间文档锁不释放', async () => {
  const scope: Record<string, unknown> = {}
  let releaseBody!: () => void
  const bodyGate = new Promise<void>((resolve) => {
    releaseBody = resolve
  })
  const { runtime, calls } = runtimeFor(scope, {
    respond: async () => ({
      status: 503,
      body: {
        getReader: () => {
          let index = 0
          return {
            read: async () => {
              index += 1
              if (index === 1) return { done: false, value: new TextEncoder().encode('gateway error') }
              await bodyGate
              return { done: true }
            },
            cancel: async () => {},
          }
        },
      },
      text: async () => 'gateway error',
    }),
  })

  let settled = false
  const pending = runtime.execute(step('item.detail', { itemId: '2002' })).then((result) => {
    settled = true
    return result
  })
  await tick()
  assert.equal(settled, false, '响应头到达不等于正文终结，不得提前返回')

  const other = runtimeFor(scope, {})
  const blocked = await other.runtime.execute(step('item.detail', { itemId: '2002' }, 'late-step'))
  assert.equal(errorCode(blocked), 'PAGE_NOT_READY')
  assert.equal(other.calls.length, 0)

  releaseBody()
  assert.equal(errorCode(await pending), 'PLATFORM_REJECTED')
  assert.equal(calls.length, 1)
})

test('超限取消失败保持失败关闭：不假终结、跨 runtime 拒绝新步骤、同 id 重投不 settle', async () => {
  const scope: Record<string, unknown> = {}
  const chunk = new Uint8Array(600 * 1024)
  const { runtime, calls } = runtimeFor(scope, {
    respond: async () => ({
      status: 200,
      body: {
        getReader: () => {
          let index = 0
          return {
            read: async () => {
              index += 1
              return index <= 2 ? { done: false, value: chunk } : { done: true }
            },
            cancel: async () => {
              throw new Error('取消未确认')
            },
          }
        },
      },
      text: async () => {
        throw new Error('有 body 时不得回退到 text')
      },
    }),
  })

  const poisonRequest = step('item.detail', { itemId: '2002' }, 'poison-step')
  let settled = false
  const pending = runtime.execute(poisonRequest)
  void pending.then(() => {
    settled = true
  })
  await tick()
  assert.equal(settled, false, '取消失败时不得返回终结结果')
  assert.equal(runtime.status().activeStepId, 'poison-step', '文档锁必须继续占用')
  assert.equal(calls.length, 1)

  const fresh = runtimeFor(scope, {})
  assert.equal(errorCode(await fresh.runtime.execute(step('item.detail', { itemId: '2002' }, 'next-step'))), 'RESULT_UNKNOWN')
  // 同一在途步骤的重投只能取回原 Promise：既不执行，也不返回假终结让 host 释放原槽。
  let replaySettled = false
  const replay = fresh.runtime.execute(poisonRequest)
  void replay.then(() => {
    replaySettled = true
  })
  const unfinished = Promise.all([pending, replay])
  await tick()
  assert.equal(replaySettled, false, '同一在途步骤重投不得返回 terminal 结果')
  assert.equal(fresh.calls.length, 0, '失败关闭期间不得派发任何新请求')
  assert.equal(fresh.runtime.status().activeStepId, 'poison-step')
  // 失败关闭 Promise 按设计永不 settle；测试结束前显式结束它，避免 Node 报告事件循环已空但 Promise 仍挂起。
  fresh.runtime.dispose()
  const [originalResult, replayResult] = await unfinished
  assert.equal(errorCode(originalResult), 'RESULT_UNKNOWN')
  assert.equal(errorCode(replayResult), 'RESULT_UNKNOWN')
  assert.equal(fresh.runtime.status().activeStepId, null)
})

test('成功结果重投前重新核验账号，账号切换不回放旧数据', async () => {
  const scope: Record<string, unknown> = {}
  let account = ACCOUNT_ID
  const { runtime, calls } = runtimeFor(scope, {
    accountId: () => account,
    respond: async () => replyJson(DETAIL_OK),
  })
  const request = step('item.detail', { itemId: '2002' }, 'repeat-step')
  assert.equal((await runtime.execute(request)).ok, true)

  account = 'other-account'
  const replay = await runtime.execute(request)
  assert.equal(errorCode(replay), 'ACCOUNT_CHANGED')
  assert.equal(calls.length, 1, '重投命中锁内结果不得再次发包')
  assert.ok(!JSON.stringify(replay).includes('详情商品'))
})

const CHAT_PARAMS = { mode: 'conversations' as const, anchor: '9007199254740991', limit: 10 }
const CHAT_RESULT = { mode: 'conversations' as const, conversations: [], hasMore: false, nextAnchor: null, unsupportedCount: 0 }
function chatRuntime(scope: Record<string, unknown>, callback: NonNullable<Parameters<typeof createPageRuntime>[0]['chatSyncPage']>, account = () => ACCOUNT_ID) {
  return createPageRuntime({ scope, documentId: DOCUMENT_ID, readAccountId: account,
    readCookie: () => { throw Error('聊天不得读取MTOP凭据') },
    fetch: async () => { throw Error('聊天不得走MTOP') }, now: () => 0, readTimeoutMs: 5000,
    chatSyncPage: callback })
}
test('聊天与MTOP共享文档锁，同step去重，成功重投不重复读取', async () => {
  const scope = {}; let count = 0
  let finish!: (value: typeof CHAT_RESULT) => void
  const runtime = chatRuntime(scope, async () => { count++; return new Promise(resolve => { finish = resolve }) })
  const request = step('chat.sync.page', CHAT_PARAMS)
  const first = runtime.execute(request), repeated = runtime.execute(request)
  await tick()
  const other = runtimeFor(scope, { respond: async () => replyJson(DETAIL_OK) })
  const blocked = await other.runtime.execute(step('item.detail', { itemId: '2002' }))
  assert.equal(blocked.ok, false); assert.equal(other.calls.length, 0); assert.equal(count, 1)
  finish(CHAT_RESULT)
  assert.deepEqual(okData(await first), CHAT_RESULT); assert.deepEqual(okData(await repeated), CHAT_RESULT)
  assert.deepEqual(okData(await runtime.execute(request)), CHAT_RESULT); assert.equal(count, 1)
  runtime.dispose()
})
test('MTOP在途时聊天不派发', async () => {
  const scope = {}; let finish!: (value: PageResponseLike) => void
  const mtop = runtimeFor(scope, { respond: () => new Promise(resolve => { finish = resolve }) })
  const first = mtop.runtime.execute(step('item.detail', { itemId: '2002' }))
  await tick()
  let calls = 0
  const runtime = chatRuntime(scope, async () => { calls++; return CHAT_RESULT })
  const blocked = await runtime.execute(step('chat.sync.page', CHAT_PARAMS))
  assert.equal(blocked.ok, false); assert.equal(calls, 0)
  finish(replyJson(DETAIL_OK)); await first; runtime.dispose()
})
test('聊天transport超时拒绝后保留锁，重建不重发，同step不伪造终结', async () => {
  const scope = {}; let calls = 0
  const runtime = chatRuntime(scope, async () => { calls++; throw Object.assign(Error('固定超时'), { code: 'TIMEOUT' }) })
  const request = step('chat.sync.page', CHAT_PARAMS)
  const result = await runtime.execute(request)
  assert.equal(result.ok, false); assert.equal(runtime.status().activeStepId, request.id)
  const rebuilt = chatRuntime(scope, async () => { calls++; return CHAT_RESULT })
  const next = await rebuilt.execute(step('chat.sync.page', CHAT_PARAMS))
  assert.equal(next.ok, false); assert.equal(calls, 1)
  let settled = false
  const repeated = rebuilt.execute(request).then(() => { settled = true })
  await tick(); assert.equal(settled, false)
  runtime.dispose(); await repeated
})
test('聊天外层等待超时后迟到成功不解锁或回放', async () => {
  const scope = {}; let finish!: (value: typeof CHAT_RESULT) => void
  const runtime = chatRuntime(scope, () => new Promise(resolve => { finish = resolve }))
  const request = step('chat.sync.page', CHAT_PARAMS)
  assert.equal((await runtime.execute(request)).ok, false)
  finish(CHAT_RESULT); await tick()
  assert.equal(runtime.status().activeStepId, request.id)
  assert.equal((await runtime.execute(step('chat.sync.page', CHAT_PARAMS))).ok, false)
  runtime.dispose()
})
test('聊天期间账号变化保留锁，错文档不派发', async () => {
  const scope = {}; let account = ACCOUNT_ID, calls = 0
  const runtime = chatRuntime(scope, async () => { calls++; account = 'changed'; return CHAT_RESULT }, () => account)
  const wrong = step('chat.sync.page', CHAT_PARAMS); wrong.context.documentId = 'other-doc'
  assert.equal((await runtime.execute(wrong)).ok, false); assert.equal(calls, 0)
  const request = step('chat.sync.page', CHAT_PARAMS)
  assert.equal((await runtime.execute(request)).ok, false)
  assert.equal(runtime.status().activeStepId, request.id); assert.equal(calls, 1)
  runtime.dispose()
})

/** 限定时间内是否终结；返回 false 表示被失败关闭挂起，不能当成正常结果。 */
async function terminalWithin(promise: Promise<unknown>, ms = 50): Promise<boolean> {
  const hanging = Symbol('hanging')
  const outcome = await Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(hanging), ms))])
  return outcome !== hanging
}

test('聊天未派发PAGE_NOT_READY立即终结，不占锁也不毒化后续读取', async () => {
  const scope: Record<string, unknown> = {}; let calls = 0
  const runtime = chatRuntime(scope, async () => { calls++; throw Object.assign(new Error('无可用连接'), { code: 'PAGE_NOT_READY' }) })
  const first = runtime.execute(step('chat.sync.page', CHAT_PARAMS, 'not-ready-chat'))
  assert.equal(await terminalWithin(first), true, '未派发失败必须终结，不能失败关闭挂起')
  assert.equal(errorCode(await first), 'PAGE_NOT_READY')
  assert.equal(runtime.status().activeStepId, null, '未派发失败不得继续占用文档锁')
  // 页面连接就绪后同一文档必须能重新派发：未派发失败不得毒化文档锁。
  const ready = chatRuntime(scope, async () => { calls++; return CHAT_RESULT })
  assert.deepEqual(okData(await ready.execute(step('chat.sync.page', CHAT_PARAMS, 'ready-chat'))), CHAT_RESULT)
  assert.equal(calls, 2)
  runtime.dispose()
})
test('聊天平台明确停止原样回传，不冒充未知超时也不占锁', async () => {
  for (const code of ['RISK_BLOCKED', 'LOGIN_REQUIRED', 'PLATFORM_REJECTED'] as const) {
    const runtime = chatRuntime({}, async () => { throw Object.assign(new Error(`平台原文-${code}-不得外泄`), { code }) })
    const result = runtime.execute(step('chat.sync.page', CHAT_PARAMS, `stop-${code}`))
    assert.equal(await terminalWithin(result), true, `${code} 必须终结`)
    assert.equal(errorCode(await result), code)
    assert.equal(runtime.status().activeStepId, null, `${code} 已有明确平台判定，不得继续占用文档锁`)
    assert.ok(!JSON.stringify(await result).includes('不得外泄'))
    runtime.dispose()
  }
})
test('聊天已派发但终结未知保持失败关闭，未知码不得当成未派发', async () => {
  const scope: Record<string, unknown> = {}
  const runtime = chatRuntime(scope, async () => { throw Object.assign(new Error('未知失败'), { code: 'UNKNOWN_CHAT_FAILURE' }) })
  const request = step('chat.sync.page', CHAT_PARAMS, 'unknown-chat')
  assert.equal(await terminalWithin(runtime.execute(request), 25), false, '无法证明终结时必须继续占用文档锁')
  assert.equal(runtime.status().activeStepId, request.id)
  runtime.dispose()
})
test('聊天页结果校验失败按未派发失败终结，不被catch吞成永久等待', async () => {
  const scope: Record<string, unknown> = {}
  const runtime = chatRuntime(scope, async () => ({ mode: 'conversations', conversations: [], hasMore: false, nextAnchor: '10', unsupportedCount: 0 } as never))
  const result = runtime.execute(step('chat.sync.page', CHAT_PARAMS, 'invalid-chat'))
  assert.equal(await terminalWithin(result), true, '结果校验失败必须终结，不能被 catch 吞掉')
  assert.equal(errorCode(await result), 'PAGE_NOT_READY')
  assert.equal(runtime.status().activeStepId, null)
  runtime.dispose()
})

test('chat.send 与 MTOP 共享文档锁且成功只发送一次', async () => {
  const scope = {}; let sends = 0
  const runtime = createPageRuntime({ scope, documentId: DOCUMENT_ID, readAccountId: () => ACCOUNT_ID, readCookie: () => COOKIE, fetch: async () => { throw Error('不应走MTOP') }, now: () => 0,
    chatSend: async () => { sends++; return { messageId: 'm1', sentAt: 1 } } })
  const request = step('chat.send' as never, { sessionId: 's', receiverId: 'r', text: 'x' }, 'send-step')
  const first = runtime.execute(request), duplicate = runtime.execute(request)
  assert.deepEqual(okData(await first), { messageId: 'm1', sentAt: 1 })
  assert.deepEqual(okData(await duplicate), { messageId: 'm1', sentAt: 1 }); assert.equal(sends, 1)
  runtime.dispose()
})
test('chat.send 无socket失败不发送且不永久锁定', async () => {
  const scope = {}; let sends = 0
  const runtime = createPageRuntime({ scope, documentId: DOCUMENT_ID, readAccountId: () => ACCOUNT_ID, readCookie: () => COOKIE, fetch: async () => { throw Error('不应走MTOP') }, now: () => 0,
    chatSend: async () => { sends++; throw new (class extends Error { code = 'PAGE_NOT_READY' })() } })
  const result = await runtime.execute(step('chat.send' as never, { sessionId: 's', receiverId: 'r', text: 'x' }))
  assert.equal(result.ok, false); assert.equal(sends, 1); assert.equal(runtime.status().activeStepId, null); runtime.dispose()
})
test('chat.send 超时未知后保留锁，重建不得重发', async () => {
  const scope = {}; let sends = 0
  const runtime = createPageRuntime({ scope, documentId: DOCUMENT_ID, readAccountId: () => ACCOUNT_ID, readCookie: () => COOKIE, fetch: async () => { throw Error('不应走MTOP') }, now: () => 0, readTimeoutMs: 10,
    chatSend: async () => { sends++; throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }) } })
  const request = step('chat.send' as never, { sessionId: 's', receiverId: 'r', text: 'x' }, 'timeout-send')
  const result = await runtime.execute(request); assert.equal(result.ok, false); assert.equal(runtime.status().activeStepId, request.id)
  const rebuilt = createPageRuntime({ scope, documentId: DOCUMENT_ID, readAccountId: () => ACCOUNT_ID, readCookie: () => COOKIE, fetch: async () => { throw Error('不应走MTOP') }, now: () => 0,
    chatSend: async () => { sends++; return { messageId: 'new', sentAt: 1 } } })
  let settled = false
  void rebuilt.execute(request).then(() => { settled = true })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, false); assert.equal(sends, 1); runtime.dispose()
})

test('publish prepare 与 submit 经同一页面运行时共享权威引用，提交只写一次', async () => {
  const scope: Record<string, unknown> = {}
  const mtop = async (api: string, _version: string, data: Record<string, unknown>) => {
    if (api === 'mtop.idle.pc.idleitem.prepublish.check') return { ret: ['SUCCESS::ok'], data: { limited: false } }
    if (api === 'mtop.idle.pc.idleitem.preget') return { ret: ['SUCCESS::ok'], data: {} }
    if (api === 'mtop.taobao.idle.pc.detail') {
      return { ret: ['SUCCESS::ok'], data: { itemDO: {
        desc: '九成新机械键盘', soldPrice: '199',
        imageInfos: [{ url: 'https://example.com/source.jpg' }],
        itemLabelExtList: [{ propertyName: '品牌', valueName: '示例品牌' }],
      } } }
    }
    if (api === 'mtop.taobao.idleitem.badwords.prepubcheck') return { ret: ['SUCCESS::ok'], data: { forbidPublish: false } }
    if (api === 'mtop.taobao.idle.kgraph.property.recommend') {
      return { ret: ['SUCCESS::ok'], data: { cardList: [
        { cardType: '20401', cardData: { propertyId: '-10000', propertyName: '类目', supportWebPublish: true,
          valuesList: [{ catId: 'category-1', channelCatId: 'category-1', catName: '键盘', valueId: 'category-1', valueName: '键盘', leafId: 'leaf-1', transportData: {} }] } },
        { cardType: '20401', cardData: { propertyId: 'attribute-card-1', propertyName: '成色', supportWebPublish: true,
          valuesList: [{ valueId: 'attribute-1', valueName: '九成新', transportData: {} }] } },
      ] } }
    }
    if (api === 'mtop.taobao.idle.local.poi.get') {
      return { ret: ['SUCCESS::ok'], data: { selectedPoi: {
        prov: '浙江省', city: '杭州市', area: '西湖区', divisionId: 'division-1',
        poiName: '示例站点', poiId: 'poi-1', gps: '30.1,120.2',
      } } }
    }
    if (api === 'mtop.idle.item.publish.service.cards.list') return { ret: ['SUCCESS::ok'], data: { services: [{ code: 'service-1' }] } }
    if (api === 'mtop.idle.pc.idleitem.publish') {
      assert.equal(typeof data['itemTextDTO'], 'object')
      assert.equal(typeof data['itemAddrDTO'], 'object')
      return { ret: ['SUCCESS::ok'], data: { itemId: 'published-1' } }
    }
    throw new Error(`未预期接口：${api}`)
  }
  const runtime = createPageRuntime({
    scope,
    documentId: DOCUMENT_ID,
    readAccountId: () => ACCOUNT_ID,
    readCookie: () => COOKIE,
    now: () => 1_700_000_000_000,
    fetch: async () => { throw new Error('不应走 MTOP fetch') },
    publish: {
      mtopRequest: mtop,
      createPrepareToken: () => 'page-token',
      uploadedImages: {
        'uploaded-image-1': { url: 'https://example.com/uploaded-1.jpg', widthSize: 800, heightSize: 600 },
      },
    },
  })
  const prepareParams = {
    source: { itemId: 'item-1' },
    idempotencyKey: 'page-step',
    seller: { addressRef: 'poi-1' },
    confirm: { imageNoQr: true, addressConfirmed: true },
    draft: {
      description: '自用一年，无拆无修',
      price: { kind: 'fixed', amount: 199, unit: 'CNY' },
      images: [{ kind: 'uploaded', ref: 'uploaded-image-1' }],
      categoryRef: 'category-1',
      attributeRefs: ['attribute-1'],
      services: [{ ref: 'service-1', value: 'true' }],
    },
  }
  // 页面 prepare 单步参数不带公共幂等键，由执行器内部补占位值。
  const prepared = await runtime.execute(step('publish.prepare', prepareParams))
  const page = okData(prepared) as { prepareRef: string; draft: unknown; candidates: unknown }
  assert.match(page.prepareRef, /^prep\./)
  assert.equal(JSON.stringify(page).includes('uploaded-1.jpg'), false)

  const submit = await runtime.execute(step('publish.submit', {
    prepareToken: 'page-token',
    prepareRef: page.prepareRef,
    draftFingerprint: (await import('node:crypto')).createHash('sha256')
      .update(JSON.stringify([ACCOUNT_ID, 'item-1', prepareParams.seller, prepareParams.draft,
        page.prepareRef, page.draft, page.candidates])).digest('hex'),
    confirm: { imageNoQr: true, addressConfirmed: true },
    idempotencyKey: 'page-step',
  }))
  assert.deepEqual(okData(submit), { outcome: 'accepted', itemId: 'published-1' })
  runtime.dispose()
})

test('发布三个步骤保留官方风控和登录分类，不吞成未知超时', async () => {
  for (const method of ['publish.prepare', 'publish.submit', 'publish.myItems'] as const) {
    for (const [ret, expected] of [
      ['FAIL_SYS_USER_VALIDATE::需验证', 'RISK_BLOCKED'],
      ['FAIL_SYS_SESSION_EXPIRED::需登录', 'LOGIN_REQUIRED'],
    ]) {
      const fingerprint = 'f'.repeat(64)
      const runtime = createPageRuntime({
        scope: {}, documentId: DOCUMENT_ID, readAccountId: () => ACCOUNT_ID,
        readCookie: () => COOKIE, now: () => 1, readTimeoutMs: 100,
        fetch: async () => { throw new Error('禁止真实请求') },
        publish: {
          mtopRequest: async () => ({ ret: [ret!] }),
          preparedStore: {
            get: () => ({ accountId: ACCOUNT_ID, sourceItemId: '1', expiresAt: 999,
              prepareRef: 'prep.risk', draftFingerprint: fingerprint, rawCards: [],
              core: {} as never }),
            set: () => {}, delete: () => {},
          },
        },
      })
      const params = method === 'publish.prepare'
        ? { source: { itemId: '1' }, seller: { addressRef: 'poi' }, idempotencyKey: 'k', confirm: { imageNoQr: true, addressConfirmed: true } }
        : method === 'publish.submit'
          ? { prepareToken: 'p', prepareRef: 'prep.risk', draftFingerprint: fingerprint, idempotencyKey: 'k', confirm: { imageNoQr: true, addressConfirmed: true } }
          : { limit: 20 }
      const result = await runtime.execute(step(method, params))
      assert.equal(errorCode(result), expected, method)
      assert.equal(runtime.status().activeStepId, null)
      runtime.dispose()
    }
  }
})

test('平台只返回超时但页面可见人机验证时，发布步骤改判 RISK_BLOCKED 并保持 poison', async () => {
  let challenge = true
  const scope: Record<string, unknown> = {}
  const runtime = createPageRuntime({
    scope, documentId: DOCUMENT_ID, readAccountId: () => ACCOUNT_ID,
    readCookie: () => COOKIE, now: () => 1, readTimeoutMs: 100,
    fetch: async () => { throw new Error('禁止真实请求') },
    detectRiskChallenge: () => challenge,
    publish: { mtopRequest: async () => ({ ret: ['TIMEOUT::接口超时'] }) },
  })
  const params = { source: { itemId: '1' }, seller: { addressRef: 'poi' }, idempotencyKey: 'k', confirm: { imageNoQr: true, addressConfirmed: true } }
  assert.equal(errorCode(await runtime.execute(step('publish.prepare', params))), 'RISK_BLOCKED')
  // 结果未知的步骤已 poison：即使验证消失，也不能放行同文档的新平台步骤。
  challenge = false
  assert.notEqual(errorCode(await runtime.execute(step('publish.myItems', { limit: 20 }, 'next'))), null)
  runtime.dispose()
})


test('默认风控检测只认可见的 baxia 或验证 iframe', async () => {
  const scope = (nodes: Array<{ offsetWidth: number; offsetHeight: number }>) => ({
    document: { querySelectorAll: (selector: string) => selector === '.baxia-dialog, iframe[src*="punish"], iframe[src*="captcha"], #nocaptcha' ? nodes : [] },
  })
  for (const [nodes, expected] of [
    [[], 'TIMEOUT'],
    [[{ offsetWidth: 0, offsetHeight: 0 }], 'TIMEOUT'],
    [[{ offsetWidth: 420, offsetHeight: 320 }], 'RISK_BLOCKED'],
  ] as const) {
    const runtime = createPageRuntime({
      scope: scope([...nodes]), documentId: DOCUMENT_ID, readAccountId: () => ACCOUNT_ID,
      readCookie: () => COOKIE, now: () => 1, readTimeoutMs: 100,
      fetch: async () => { throw Object.assign(new Error('平台超时'), { code: 'TIMEOUT' }) },
    })
    assert.equal(errorCode(await runtime.execute(step('search.suggest', { keyword: '手机' }))), expected)
    runtime.dispose()
  }
})

/** 构造带滑块弹窗的 scope；querySelector 只服务滑块定位与弹窗可见性判断。 */
function sliderScope(options: { dialog: boolean; slider?: boolean; gap?: boolean }): Record<string, unknown> {
  const table: Record<string, { getBoundingClientRect: () => { left: number; top: number; width: number; height: number } } | null> = {
    '.baxia-dialog': options.dialog ? { getBoundingClientRect: () => ({ left: 100, top: 100, width: 400, height: 300 }) } : null,
  }
  if (options.slider) {
    table['#nc_1_n1z'] = { getBoundingClientRect: () => ({ left: 160, top: 260, width: 40, height: 40 }) }
    table['.nc_scale'] = { getBoundingClientRect: () => ({ left: 140, top: 250, width: 300, height: 50 }) }
    if (options.gap) table['.nc_1_n1t'] = { getBoundingClientRect: () => ({ left: 300, top: 210, width: 40, height: 40 }) }
  }
  const elements = new Map(Object.entries(table))
  const document = {
    querySelector: (selector: string) => elements.get(selector) ?? null,
  }
  return {
    document,
  }
}

test('页面可见滑块且 solveSlider 成功时，步骤改判已自动通过并停止', async () => {
  const scope = sliderScope({ dialog: true, slider: true, gap: true })
  let solved = 0
  const runtime = createPageRuntime({
    scope, documentId: DOCUMENT_ID, readAccountId: () => ACCOUNT_ID,
    readCookie: () => COOKIE, now: () => 1,
    fetch: async () => { throw new Error('禁止真实请求') },
    detectRiskChallenge: () => true,
    solveSlider: async () => {
      solved += 1
      const document = scope.document as { querySelector: (selector: string) => unknown }
      const previous = document.querySelector
      document.querySelector = (selector) => selector === '.baxia-dialog' ? null : previous(selector)
      return true
    },
  })
  const result = await runtime.execute(step('item.detail', { itemId: '2002' }, 'slider-passed'))
  console.log('R1', JSON.stringify(result))
  assert.equal(errorCode(result), 'RISK_BLOCKED')
  assert.equal(solved, 1, '应尝试一次自动滑块')
  // 自动通过后仍必须停止并不得伪装业务成功，但文案要能让调用方区分状态。
  assert.match(JSON.stringify(result), /已自动通过/)
  runtime.dispose()
})

test('solveSlider 失败时保持人工验证语义，且只尝试一次', async () => {
  const scope = sliderScope({ dialog: true, slider: true })
  let solved = 0
  const runtime = createPageRuntime({
    scope, documentId: DOCUMENT_ID, readAccountId: () => ACCOUNT_ID,
    readCookie: () => COOKIE, now: () => 1,
    fetch: async () => { throw new Error('禁止真实请求') },
    detectRiskChallenge: () => true,
    solveSlider: async () => { solved += 1; return false },
  })
  const result = await runtime.execute(step('item.detail', { itemId: '2002' }, 'slider-failed'))
  assert.equal(errorCode(result), 'RISK_BLOCKED')
  assert.equal(solved, 1, '不得循环重试滑块')
  assert.match(JSON.stringify(result), /需要人工完成验证/)
  runtime.dispose()
})

test('solveSlider 抛异常时按人工验证处理，不向调用方外传异常', async () => {
  const scope = sliderScope({ dialog: true, slider: true })
  const runtime = createPageRuntime({
    scope, documentId: DOCUMENT_ID, readAccountId: () => ACCOUNT_ID,
    readCookie: () => COOKIE, now: () => 1,
    fetch: async () => { throw new Error('禁止真实请求') },
    detectRiskChallenge: () => true,
    solveSlider: async () => { throw new Error('cdp attach failed') },
  })
  const result = await runtime.execute(step('item.detail', { itemId: '2002' }, 'slider-threw'))
  assert.equal(errorCode(result), 'RISK_BLOCKED')
  assert.ok(!JSON.stringify(result).includes('cdp attach failed'))
  runtime.dispose()
})

test('页面是弹窗但无滑块元素时不调用 solveSlider，直接转人工', async () => {
  const scope = sliderScope({ dialog: true })
  let solved = 0
  const runtime = createPageRuntime({
    scope, documentId: DOCUMENT_ID, readAccountId: () => ACCOUNT_ID,
    readCookie: () => COOKIE, now: () => 1,
    fetch: async () => { throw new Error('禁止真实请求') },
    detectRiskChallenge: () => true,
    solveSlider: async () => { solved += 1; return true },
  })
  const result = await runtime.execute(step('item.detail', { itemId: '2002' }, 'slider-noelement'))
  assert.equal(errorCode(result), 'RISK_BLOCKED')
  // 短信/扫码等非滑块类型：没有可拖动元素，不得尝试拖动。
  assert.equal(solved, 0)
  runtime.dispose()
})
test('自动通过后弹窗未消失时不谎报通过', async () => {
  // solveSlider 返回 true，但弹窗仍在：必须判为未通过。
  const scope = sliderScope({ dialog: true, slider: true })
  const runtime = createPageRuntime({
    scope, documentId: DOCUMENT_ID, readAccountId: () => ACCOUNT_ID,
    readCookie: () => COOKIE, now: () => 1,
    fetch: async () => { throw new Error('禁止真实请求') },
    detectRiskChallenge: () => true,
    solveSlider: async () => true,
  })
  const result = await runtime.execute(step('item.detail', { itemId: '2002' }, 'slider-dialogstays'))
  assert.equal(errorCode(result), 'RISK_BLOCKED')
  assert.match(JSON.stringify(result), /需要人工完成验证/)
  runtime.dispose()
})
