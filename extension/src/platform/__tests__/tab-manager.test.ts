import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_GOOFISH_URL,
  createTabManager,
  isGoofishUrl,
} from '../../background/tab-manager'
import type { TabLike, TabsApi } from '../../background/tab-manager'

function makeTabs(initial: TabLike[]) {
  const tabs: TabLike[] = initial.map((tab) => ({ ...tab }))
  let nextId = 100
  const createdUrls: string[] = []
  const api: TabsApi = {
    async query() {
      return tabs.map((tab) => ({ ...tab }))
    },
    async create(properties) {
      createdUrls.push(properties.url)
      const tab: TabLike = { id: nextId++, url: properties.url, active: properties.active ?? false }
      tabs.push(tab)
      return tab
    },
    async get(tabId) {
      const tab = tabs.find((item) => item.id === tabId)
      if (!tab) throw new Error(`no tab ${tabId}`)
      return tab
    },
    onRemoved: { addListener() {} },
  }
  return { api, tabs, createdUrls }
}

test('isGoofishUrl：匹配 goofish.com 及其子域', () => {
  assert.equal(isGoofishUrl('https://www.goofish.com/item?id=1'), true)
  assert.equal(isGoofishUrl('https://goofish.com/'), true)
  assert.equal(isGoofishUrl('https://h5api.m.goofish.com/h5/x'), true)
  assert.equal(isGoofishUrl('https://example.com/'), false)
  assert.equal(isGoofishUrl(undefined), false)
  assert.equal(isGoofishUrl('not a url'), false)
})

test('findGoofishTab：优先复用 active 的闲鱼 tab', async () => {
  const { api } = makeTabs([
    { id: 1, url: 'https://www.goofish.com/a', active: false },
    { id: 2, url: 'https://www.goofish.com/b', active: true },
    { id: 3, url: 'https://example.com/' },
  ])
  const manager = createTabManager({ tabs: api })

  const tab = await manager.findGoofishTab()
  assert.equal(tab?.id, 2)
  assert.equal(manager.getCachedTabId(), 2)
})

test('findGoofishTab：没有闲鱼 tab 时返回 null', async () => {
  const { api } = makeTabs([{ id: 1, url: 'https://example.com/' }])
  const manager = createTabManager({ tabs: api })
  assert.equal(await manager.findGoofishTab(), null)
  assert.equal(manager.getCachedTabId(), null)
})

test('ensureGoofishTab：无 tab 时创建，返回 created=true', async () => {
  const { api, createdUrls } = makeTabs([{ id: 1, url: 'https://example.com/' }])
  const manager = createTabManager({ tabs: api })

  const result = await manager.ensureGoofishTab()
  assert.equal(result.created, true)
  assert.equal(result.tab.url, DEFAULT_GOOFISH_URL)
  assert.deepEqual(createdUrls, [DEFAULT_GOOFISH_URL])
})

test('ensureGoofishTab：已有 tab 时复用，不创建', async () => {
  const { api, createdUrls } = makeTabs([{ id: 7, url: 'https://www.goofish.com/', active: true }])
  const manager = createTabManager({ tabs: api })

  const result = await manager.ensureGoofishTab()
  assert.equal(result.created, false)
  assert.equal(result.tab.id, 7)
  assert.deepEqual(createdUrls, [])
})

test('isAlive / getTab：tab 关闭后返回 false / null', async () => {
  const { api, tabs } = makeTabs([{ id: 5, url: 'https://www.goofish.com/' }])
  const manager = createTabManager({ tabs: api })

  assert.equal(await manager.isAlive(5), true)
  tabs.splice(0, 1)
  assert.equal(await manager.isAlive(5), false)
  assert.equal(await manager.getTab(5), null)
})

test('handleTabRemoved：清理缓存', async () => {
  const { api } = makeTabs([{ id: 9, url: 'https://www.goofish.com/' }])
  const manager = createTabManager({ tabs: api })

  await manager.findGoofishTab()
  assert.equal(manager.getCachedTabId(), 9)

  manager.handleTabRemoved(9)
  assert.equal(manager.getCachedTabId(), null)
})

test('findGoofishTab：缓存 tab 被关闭后自动失效并重新查找', async () => {
  const { api, tabs } = makeTabs([{ id: 1, url: 'https://www.goofish.com/' }])
  const manager = createTabManager({ tabs: api })

  assert.equal((await manager.findGoofishTab())?.id, 1)
  tabs.splice(0, 1)
  assert.equal(await manager.findGoofishTab(), null)
  assert.equal(manager.getCachedTabId(), null)
})
