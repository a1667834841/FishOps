import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPageBootstrap, PAGE_MAIN_FILE, type PageBootstrapScripting } from '../page-bootstrap.ts'
import { ApiError } from '../errors.ts'
import type { StepContext } from '../../../../packages/protocol/src/step.ts'

type ScriptCall = {
  target: { tabId: number; documentIds: string[] }
  world: string
  files?: string[]
  func?: (...args: unknown[]) => unknown
  args?: unknown[]
}

type FixtureOptions = {
  /** 第 N 次核验返回的上下文；可以抛出账号变化或导航错误。 */
  verify?: (call: number, expected: StepContext) => StepContext | Promise<StepContext>
  /** 页面 runtime 上报的状态；默认全部就绪。 */
  statusOf?: (documentId: string) => unknown
  /** files 注入返回值中的 documentId；用于模拟注入到其它文档。 */
  fileDocumentId?: string
  /** func 注入返回值中的 documentId；用于模拟调用落到其它文档。 */
  initDocumentId?: string
  /** false 表示文档里没有 MAIN 入口产物。 */
  entry?: boolean
  /** 让 executeScript 整体拒绝。 */
  injectError?: Error
  /** func 注入挂起直到该 Promise 完成，用于验证在途重注入。 */
  hold?: Promise<unknown>
}

const bound: StepContext = { accountId: 'a', tabId: 7, documentId: 'doc' }
const hasWindow = 'window' in globalThis
const originalWindow = (globalThis as { window?: unknown }).window

const settle = async () => {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
}

/** 假 MAIN world 与假 scripting：不启动 Chrome，只按注入契约执行被序列化的函数。 */
function fixture(options: FixtureOptions = {}) {
  const calls: ScriptCall[] = []
  const scope: Record<string, unknown> = {}
  let entryInstalled = false
  let initCalls = 0
  let runtimeCreated = 0
  let verifyCalls = 0

  // 模拟 page-main.js：重复注入不覆盖已有入口，初始化也只复用原 runtime。
  const installEntry = () => {
    if (options.entry === false || entryInstalled) return
    entryInstalled = true
    Object.defineProperty(scope, '__fishopsInitPageRuntimeV1__', {
      configurable: false, writable: false,
      value(documentId: string) {
        initCalls += 1
        const existing = scope.__fishopsPageRuntimeV1__ as { documentId: string } | undefined
        if (existing) {
          if (existing.documentId !== documentId) throw new Error('执行文档代次不符')
          return
        }
        runtimeCreated += 1
        Object.defineProperty(scope, '__fishopsPageRuntimeV1__', {
          configurable: false, writable: false,
          value: Object.freeze({
            documentId,
            status: () => (options.statusOf ?? ((id: string) => ({ documentId: id, activeStepId: null, completed: 0 })))(documentId),
          }),
        })
      },
    })
  }
  if (options.entry !== false) installEntry()

  const scripting: PageBootstrapScripting = {
    async executeScript(details) {
      calls.push(details as ScriptCall)
      if (options.injectError) throw options.injectError
      if (details.func && options.hold) await options.hold
      const fn = details.func
      if (!fn) {
        installEntry()
        return [{ documentId: options.fileDocumentId ?? bound.documentId, result: undefined }]
      }
      assert.ok(!String(fn).includes('createPageBootstrap'), '注入函数不得依赖模块闭包')
      return [{ documentId: options.initDocumentId ?? bound.documentId, result: fn(...(details.args ?? [])) }]
    },
  }
  const context = {
    verify: async (expected: StepContext) => {
      verifyCalls += 1
      return options.verify ? options.verify(verifyCalls, expected) : bound
    },
  }

  ;(globalThis as { window?: unknown }).window = scope
  const restoreWindow = () => {
    if (hasWindow) (globalThis as { window?: unknown }).window = originalWindow
    else delete (globalThis as { window?: unknown }).window
  }

  return {
    bootstrap: createPageBootstrap({ context, scripting }),
    calls,
    scope,
    restoreWindow,
    initCalls: () => initCalls,
    runtimeCreated: () => runtimeCreated,
  }
}

test('核验上下文后固定目标文档注入 MAIN 产物并初始化，注入函数自包含', async () => {
  const f = fixture()
  try {
    const status = await f.bootstrap.prepare(bound)
    assert.deepEqual(status, { documentId: 'doc', activeStepId: null, completed: 0 })
    assert.equal(f.calls.length, 2)
    assert.deepEqual(f.calls[0]?.target, { tabId: 7, documentIds: ['doc'] })
    assert.equal(f.calls[0]?.world, 'MAIN')
    assert.deepEqual(f.calls[0]?.files, [PAGE_MAIN_FILE])
    assert.equal(f.calls[0]?.func, undefined)
    assert.deepEqual(f.calls[1]?.target, { tabId: 7, documentIds: ['doc'] })
    assert.equal(f.calls[1]?.world, 'MAIN')
    assert.equal(f.calls[1]?.files, undefined)
    assert.deepEqual(f.calls[1]?.args, ['doc'])
    const source = String(f.calls[1]?.func)
    for (const forbidden of ['createPageBootstrap', 'PAGE_MAIN_FILE', 'ApiError', 'scripting', 'context']) {
      assert.ok(!source.includes(forbidden), `注入函数不得引用模块作用域：${forbidden}`)
    }
  } finally {
    f.restoreWindow()
  }
})

test('重复 prepare 复用文档 runtime，不重载页面也不替换入口', async () => {
  const f = fixture()
  try {
    const first = await f.bootstrap.prepare(bound)
    const runtime = f.scope.__fishopsPageRuntimeV1__
    const second = await f.bootstrap.prepare(bound)
    assert.deepEqual(second, first)
    assert.equal(f.scope.__fishopsPageRuntimeV1__, runtime, '重复部署必须复用原 runtime')
    assert.equal(f.runtimeCreated(), 1)
    assert.equal(f.calls.length, 4)
    for (const call of f.calls) assert.deepEqual(call.target, { tabId: 7, documentIds: ['doc'] })
  } finally {
    f.restoreWindow()
  }
})

test('在途重复注入复用同文档结果，不同文档拒绝且不产生第二次注入', async () => {
  const gate = deferred<void>()
  const f = fixture({ hold: gate.promise })
  try {
    const first = f.bootstrap.prepare(bound)
    await settle()
    assert.equal(f.calls.length, 2, 'files 注入完成后应在 func 注入处挂起')
    const duplicate = f.bootstrap.prepare({ ...bound })
    await assert.rejects(f.bootstrap.prepare({ ...bound, documentId: 'other' }), { code: 'PAGE_NOT_READY' })
    assert.equal(f.calls.length, 2, '在途拒绝不得触发第二次注入')
    gate.resolve()
    assert.deepEqual(await first, await duplicate)
    assert.equal(f.runtimeCreated(), 1)
  } finally {
    f.restoreWindow()
  }
})

test('注入落到其它文档或账号变化时不当作成功', async () => {
  const cases: Array<{ options: FixtureOptions; code: string; calls: number }> = [
    { options: { fileDocumentId: 'other' }, code: 'PAGE_NOT_READY', calls: 1 },
    { options: { initDocumentId: 'other' }, code: 'PAGE_NOT_READY', calls: 2 },
    { options: { verify: () => ({ ...bound, documentId: 'other' }) }, code: 'PAGE_NOT_READY', calls: 0 },
    { options: { verify: call => (call === 1 ? bound : { ...bound, documentId: 'other' }) }, code: 'PAGE_NOT_READY', calls: 2 },
    { options: { verify: () => ({ ...bound, accountId: 'b' }) }, code: 'ACCOUNT_CHANGED', calls: 0 },
    { options: { verify: () => { throw new ApiError('ACCOUNT_CHANGED', '私有账号信息') } }, code: 'ACCOUNT_CHANGED', calls: 0 },
    {
      options: { verify: call => { if (call === 2) throw new ApiError('ACCOUNT_CHANGED', '私有账号信息'); return bound } },
      code: 'ACCOUNT_CHANGED',
      calls: 2,
    },
  ]
  for (const { options, code, calls } of cases) {
    const f = fixture(options)
    try {
      await assert.rejects(f.bootstrap.prepare(bound), error => {
        assert.equal((error as { code?: string }).code, code)
        assert.ok(!String(error).includes('私有账号信息'))
        return true
      })
      assert.equal(f.calls.length, calls)
    } finally {
      f.restoreWindow()
    }
  }
})

test('活动步骤未终结、状态不完整或入口缺失时固定失败', async () => {
  const statuses: Array<(documentId: string) => unknown> = [
    () => undefined,
    () => ({ documentId: 'other', activeStepId: null, completed: 0 }),
    () => ({ documentId: 'doc', activeStepId: 'step-1', completed: 0 }),
    () => ({ documentId: 'doc', activeStepId: 3, completed: 0 }),
    () => ({ documentId: 'doc', activeStepId: null, completed: -1 }),
    () => ({ documentId: 'doc', activeStepId: null, completed: 1.5 }),
    () => ({ documentId: 'doc', activeStepId: null, completed: Number.MAX_SAFE_INTEGER + 1 }),
  ]
  for (const statusOf of statuses) {
    const f = fixture({ statusOf })
    try {
      await assert.rejects(f.bootstrap.prepare(bound), { code: 'PAGE_NOT_READY', message: '页面执行运行时不可用' })
    } finally {
      f.restoreWindow()
    }
  }
  // 每个 fixture 会接管 globalThis.window，因此逐段创建并在断言后归还。
  const missing = fixture({ entry: false })
  try {
    await assert.rejects(missing.bootstrap.prepare(bound), { code: 'PAGE_NOT_READY', message: '页面执行运行时不可用' })
  } finally {
    missing.restoreWindow()
  }
  const blank = fixture()
  try {
    await assert.rejects(blank.bootstrap.prepare({ accountId: '', tabId: 7, documentId: 'doc' }), { code: 'PAGE_NOT_READY' })
    await assert.rejects(blank.bootstrap.prepare({ accountId: 'a', tabId: -1, documentId: 'doc' }), { code: 'PAGE_NOT_READY' })
    assert.equal(blank.calls.length, 0, '非法上下文不得发起注入')
  } finally {
    blank.restoreWindow()
  }
})

test('注入或核验抛错时固定脱敏，不泄漏浏览器与页面内部信息', async () => {
  const injected = fixture({ injectError: new Error('private-browser-info') })
  const broken = fixture({ verify: () => { throw new Error('private-account-info') } })
  try {
    await assert.rejects(injected.bootstrap.prepare(bound), error => {
      assert.equal((error as { code?: string }).code, 'PAGE_NOT_READY')
      assert.equal((error as Error).message, '页面执行运行时不可用')
      assert.ok(!String(error).includes('private-browser-info'))
      return true
    })
    await assert.rejects(broken.bootstrap.prepare(bound), error => {
      assert.equal((error as { code?: string }).code, 'PAGE_NOT_READY')
      assert.ok(!String(error).includes('private-account-info'))
      return true
    })
  } finally {
    injected.restoreWindow()
    broken.restoreWindow()
  }
})
