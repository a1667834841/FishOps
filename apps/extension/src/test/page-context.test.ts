import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPageContext } from '../page-context.ts'

test('固定tab与主文档，不自动换页；账号与导航变化明确报错', async () => {
  let account: string | null = 'a'
  let frame = { documentId: 'd', url: 'https://www.goofish.com/' }
  const context = createPageContext({ accountId: async () => account, frame: async () => frame })
  assert.deepEqual(await context.bind(1), { accountId: 'a', tabId: 1, documentId: 'd' })
  const bound = await context.bind(1)
  frame = { ...frame, documentId: 'new' }
  await assert.rejects(context.verify(bound), { code: 'PAGE_NOT_READY' })
  account = 'b'
  await assert.rejects(context.verify(bound), { code: 'ACCOUNT_CHANGED' })
})
test('只接受精确闲鱼HTTPS主站，读取期间账号变化不生成快照', async () => {
  for (const url of ['http://www.goofish.com/', 'https://www.goofish.com.evil.test/', 'https://evil.test/', 'chrome://extensions']) {
    const context = createPageContext({ accountId: async () => 'a', frame: async () => ({ documentId: 'd', url }) })
    await assert.rejects(context.bind(1), { code: 'PAGE_NOT_READY' })
  }
  let calls = 0
  const context = createPageContext({ accountId: async () => ++calls === 1 ? 'a' : 'b', frame: async () => ({ documentId: 'd', url: 'https://www.goofish.com/' }) })
  await assert.rejects(context.bind(1), { code: 'ACCOUNT_CHANGED' })
})

test('关闭、未登录与非法tab不绑定，原始浏览器异常不泄露', async () => {
  const missing = createPageContext({ accountId: async () => 'a', frame: async () => null })
  await assert.rejects(missing.bind(1), { code: 'PAGE_NOT_READY' })
  await assert.rejects(missing.bind(-1), { code: 'PAGE_NOT_READY' })
  const loggedOut = createPageContext({ accountId: async () => null, frame: async () => null })
  await assert.rejects(loggedOut.bind(1), { code: 'LOGIN_REQUIRED' })
  const broken = createPageContext({ accountId: async () => 'a', frame: async () => { throw new Error('private-browser-info') } })
  await assert.rejects(broken.bind(1), error => {
    assert.ok(!String(error).includes('private-browser-info'))
    return true
  })
})

const mainFrame = { documentId: 'doc-1', url: 'https://www.goofish.com/' }

test('只使用唯一活动闲鱼页；0 个、多个、无 id 都拒绝', async () => {
  let tabs: Array<{ id?: number; url?: string }> = [{ id: 7, url: 'https://www.goofish.com/' }]
  const context = createPageContext({
    accountId: async () => 'a',
    tabs: async () => tabs,
    frame: async tabId => ({ ...mainFrame, documentId: `doc-${tabId}` }),
  })
  assert.deepEqual(await context.resolve('a'), { accountId: 'a', tabId: 7, documentId: 'doc-7' })
  tabs = []
  await assert.rejects(context.resolve('a'), { code: 'PAGE_NOT_READY' })
  tabs = [{ id: 7, url: 'https://www.goofish.com/' }, { id: 8, url: 'https://www.goofish.com/item?id=1' }]
  await assert.rejects(context.resolve('a'), { code: 'PAGE_NOT_READY' })
  tabs = [{}]
  await assert.rejects(context.resolve('a'), { code: 'PAGE_NOT_READY' })
})

test('最后聚焦窗口无候选时回退全部窗口，但仍要求全局唯一', async () => {
  let focused: Array<{ id?: number; url?: string }> = []
  let all: Array<{ id?: number; url?: string }> = [{ id: 7, url: 'https://www.goofish.com/' }]
  const context = createPageContext({
    accountId: async () => 'a',
    tabs: async () => focused,
    allTabs: async () => all,
    frame: async tabId => ({ ...mainFrame, documentId: `doc-${tabId}` }),
  })
  assert.deepEqual(await context.resolve('a'), { accountId: 'a', tabId: 7, documentId: 'doc-7' })
  all = []
  await assert.rejects(context.resolve('a'), { code: 'PAGE_NOT_READY' })
  all = [
    { id: 7, url: 'https://www.goofish.com/' },
    { id: 8, url: 'https://www.goofish.com/item?id=1' },
  ]
  await assert.rejects(context.resolve('a'), { code: 'PAGE_NOT_READY' })
  focused = [{ id: 9, url: 'https://www.goofish.com/' }]
  assert.deepEqual(await context.resolve('a'), { accountId: 'a', tabId: 9, documentId: 'doc-9' })
})

test('页面定位再次核验账号与主站 URL，非法 documentId 不返回', async () => {
  let account: string | null = 'a'
  let frame = mainFrame
  const context = createPageContext({
    accountId: async () => account,
    tabs: async () => [{ id: 7, url: 'https://www.goofish.com/' }],
    frame: async () => frame,
  })
  account = 'b'
  await assert.rejects(context.resolve('a'), { code: 'ACCOUNT_CHANGED' })
  account = 'a'
  frame = { ...mainFrame, url: 'https://www.goofish.com.evil.test/' }
  await assert.rejects(context.resolve('a'), { code: 'PAGE_NOT_READY' })
  frame = { ...mainFrame, documentId: 'doc 1' }
  await assert.rejects(context.resolve('a'), { code: 'PAGE_NOT_READY' })
  frame = mainFrame
  await assert.deepEqual(await context.resolve('a'), { accountId: 'a', tabId: 7, documentId: 'doc-1' })
  account = null
  await assert.rejects(context.resolve('a'), { code: 'LOGIN_REQUIRED' })
})

test('页面定位不发生 frame 读取时账号变化不生成上下文', async () => {
  let reads = 0
  const context = createPageContext({
    accountId: async () => (reads++ === 0 ? 'a' : 'b'),
    tabs: async () => [{ id: 7, url: 'https://www.goofish.com/' }],
    frame: async () => mainFrame,
  })
  await assert.rejects(context.resolve('a'), { code: 'ACCOUNT_CHANGED' })
})

test('唯一候选但主文档缺失或标签页查询失败时固定失败', async () => {
  const missing = createPageContext({
    accountId: async () => 'a',
    tabs: async () => [{ id: 7, url: 'https://www.goofish.com/' }],
    frame: async () => null,
  })
  await assert.rejects(missing.resolve('a'), { code: 'PAGE_NOT_READY' })
  const broken = createPageContext({
    accountId: async () => 'a',
    tabs: async () => { throw new Error('private-tab-info') },
    frame: async () => mainFrame,
  })
  await assert.rejects(broken.resolve('a'), error => {
    assert.ok(!String(error).includes('private-tab-info'))
    return true
  })
})
