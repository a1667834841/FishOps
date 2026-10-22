import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AccountTracker } from '../account.ts'
import type { PageBootstrapScripting } from '../page-bootstrap.ts'
import { createBridge } from '../bridge-factory.ts'
import { FakeEnv, settle } from './fakes.ts'

type ScriptCall = {
  target: { tabId: number; documentIds: string[] }
  world: string
  files?: string[]
  func?: (...args: unknown[]) => unknown
  args?: unknown[]
}

test('生产组合为 native 连接创建固定文档的单步执行器', async () => {
  const env = new FakeEnv({ cookies: { unb: 'account-1', tracknick: 'A' } })
  const account = new AccountTracker(env)
  const calls: ScriptCall[] = []
  let frameReads = 0

  // 只模拟浏览器边界；业务组合全部走生产 createBridge。
  ;(globalThis as { chrome?: unknown }).chrome = {
    webNavigation: {
      getFrame: async ({ tabId }: { tabId: number }) => {
        frameReads += 1
        return {
          tabId,
          frameId: 0,
          documentId: 'doc-1',
          url: 'https://www.goofish.com/',
        }
      },
    },
    scripting: {
      executeScript: async (details: ScriptCall) => {
        calls.push(details)
        if (details.files) return [{ documentId: 'doc-1', result: undefined }]
        const input = details.args?.[0] as { op?: string; request?: { id: string } } | undefined
        if (!input?.op) {
          return [{ documentId: 'doc-1', result: { documentId: 'doc-1', activeStepId: null, completed: 0 } }]
        }
        if (input.op === 'status') {
          return [{ documentId: 'doc-1', result: { documentId: 'doc-1', activeStepId: null, completed: 0 } }]
        }
        return [{
          documentId: 'doc-1',
          result: { kind: 'step-result', id: input.request!.id, terminal: true, ok: true, data: { itemId: '123' } },
        }]
      },
    },
  }

  const bridge = createBridge({ env, account, scripting: (globalThis as {
    chrome: { scripting: PageBootstrapScripting }
  }).chrome.scripting })
  bridge.start()
  await settle()

  env.ports[0]!.emitMessage({
    kind: 'request-step',
    id: 'step-1',
    requestId: 'request-1',
    method: 'item.detail',
    params: { itemId: '123' },
    context: { accountId: 'account-1', tabId: 7, documentId: 'doc-1' },
  })
  await settle(12)

  assert.ok(frameReads >= 1)
  assert.ok(env.cookieReads.includes('unb'), '页面上下文必须绑定 AccountTracker 的账号读取')
  assert.ok(calls.some(call => call.files?.[0] === 'page-main.js'), '必须部署 MAIN 入口')
  for (const call of calls) {
    assert.deepEqual(call.target, { tabId: 7, documentIds: ['doc-1'] })
    assert.equal(call.world, 'MAIN')
  }
  assert.deepEqual(env.ports[0]!.outbound.at(-1), {
    kind: 'step-result',
    id: 'step-1',
    terminal: true,
    ok: true,
    data: { itemId: '123' },
  })
  bridge.stop()
  delete (globalThis as { chrome?: unknown }).chrome
})

test('生产组合只返回唯一活动闲鱼页，定位帧不带 URL 或平台请求', async () => {
  const env = new FakeEnv({ cookies: { unb: 'account-1', tracknick: 'A' }, tabIds: [7] })
  const account = new AccountTracker(env)
  ;(globalThis as { chrome?: unknown }).chrome = {
    webNavigation: {
      getFrame: async ({ tabId }: { tabId: number }) => ({
        tabId,
        frameId: 0,
        documentId: 'doc-1',
        url: 'https://www.goofish.com/',
      }),
    },
    scripting: { executeScript: async () => [] },
  }
  const bridge = createBridge({ env, account, scripting: (globalThis as {
    chrome: { scripting: PageBootstrapScripting }
  }).chrome.scripting })
  bridge.start()
  await settle()

  env.ports[0]!.emitMessage({ kind: 'resolve-page', id: 'page-1', accountId: 'account-1' })
  await settle()
  assert.deepEqual(env.ports[0]!.outbound.at(-1), {
    kind: 'page-context',
    id: 'page-1',
    context: { tabId: 7, documentId: 'doc-1' },
  })
  assert.ok(!JSON.stringify(env.ports[0]!.outbound.at(-1)).includes('url'))
  bridge.stop()
  delete (globalThis as { chrome?: unknown }).chrome
})

test('多候选页或账号变化返回脱敏失败原因，不选用户当前任意 tab', async () => {
  for (const [tabIds, accountId, reason] of [
    [[7, 8], 'account-1', 'PAGE_NOT_READY'],
    [[7], 'account-2', 'ACCOUNT_CHANGED'],
  ] as const) {
    const env = new FakeEnv({ cookies: { unb: 'account-1', tracknick: 'A' }, tabIds: [...tabIds] })
    const account = new AccountTracker(env)
    ;(globalThis as { chrome?: unknown }).chrome = {
      webNavigation: {
        getFrame: async ({ tabId }: { tabId: number }) => ({
          tabId, frameId: 0, documentId: 'doc-1', url: 'https://www.goofish.com/',
        }),
      },
      scripting: { executeScript: async () => [] },
    }
    const bridge = createBridge({ env, account, scripting: (globalThis as {
      chrome: { scripting: PageBootstrapScripting }
    }).chrome.scripting })
    bridge.start()
    await settle()
    env.ports[0]!.emitMessage({ kind: 'resolve-page', id: 'page-1', accountId })
    await settle()
    assert.deepEqual(env.ports[0]!.outbound.at(-1), {
      kind: 'page-context', id: 'page-1', context: null, reason,
    })
    bridge.stop()
    delete (globalThis as { chrome?: unknown }).chrome
  }
})
