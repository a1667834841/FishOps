/**
 * runtime-session 单测（P8）：tab 复用 / 后台创建 / 并发去重 / 关闭 / 超时 / 跳转分类 / 就绪等待。
 *
 * 全部使用 mock chrome.tabs，**绝不创建真实 tab、不访问真实浏览器**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_GOOFISH_IM_URL,
  createRuntimeSession,
  type RuntimeTabChangeInfo,
  type RuntimeTabLike,
  type RuntimeTabsApi,
  type RuntimeUserOutcome,
} from '../runtime-session'

type UpdatedListener = (tabId: number, changeInfo: RuntimeTabChangeInfo, tab: RuntimeTabLike) => void

interface FakeTabs {
  api: RuntimeTabsApi
  created: Array<{ url: string; active: boolean }>
  emitUpdated(tabId: number, changeInfo: RuntimeTabChangeInfo, tab?: RuntimeTabLike): void
  setCreate(impl: (props: { url: string; active: boolean }) => Promise<RuntimeTabLike>): void
}

function createFakeTabs(initial: RuntimeTabLike[]): FakeTabs {
  const tabs: RuntimeTabLike[] = initial.map((tab) => ({ ...tab }))
  const created: Array<{ url: string; active: boolean }> = []
  const listeners = new Set<UpdatedListener>()
  let nextId = 100
  let createImpl = async (props: { url: string; active: boolean }): Promise<RuntimeTabLike> => {
    created.push({ url: props.url, active: props.active })
    const tab: RuntimeTabLike = { id: nextId++, url: props.url, active: props.active, status: 'loading' }
    tabs.push(tab)
    return { ...tab }
  }

  const api: RuntimeTabsApi = {
    async query() {
      return tabs.map((tab) => ({ ...tab }))
    },
    async create(props) {
      return createImpl(props)
    },
    async get(tabId) {
      const tab = tabs.find((item) => item.id === tabId)
      if (!tab) throw new Error(`no tab ${tabId}`)
      return { ...tab }
    },
    onUpdated: {
      addListener(listener) {
        listeners.add(listener)
      },
      removeListener(listener) {
        listeners.delete(listener)
      },
    },
    onRemoved: { addListener() {} },
  }

  return {
    api,
    created,
    emitUpdated(tabId, changeInfo, tab) {
      const stored = tabs.find((item) => item.id === tabId)
      // 模拟真实导航：同步更新内存中的 tab 快照，便于后续 get/query 读到新地址 / 状态。
      if (stored) {
        if (changeInfo.url !== undefined) stored.url = changeInfo.url
        if (changeInfo.status !== undefined) stored.status = changeInfo.status
      }
      const fallback = stored ?? { id: tabId }
      for (const listener of [...listeners]) listener(tabId, changeInfo, tab ?? fallback)
    },
    setCreate(impl) {
      createImpl = impl
    },
  }
}

function createClock() {
  let current = 0
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms
    },
  }
}

interface HarnessOptions {
  initial?: RuntimeTabLike[]
  probeHost?: (tabId: number) => Promise<void>
  fetchUserId?: (force: boolean) => Promise<RuntimeUserOutcome>
}

function harness(options: HarnessOptions = {}) {
  const tabs = createFakeTabs(options.initial ?? [])
  const clock = createClock()
  const timers = new Map<number, () => void>()
  let timerSeq = 0
  let session: ReturnType<typeof createRuntimeSession>

  session = createRuntimeSession({
    tabs: tabs.api,
    probeHost: options.probeHost ?? (async () => {}),
    fetchUserId: options.fetchUserId ?? (async () => ({ ok: true, userId: 'user-1' })),
    goofishImUrl: DEFAULT_GOOFISH_IM_URL,
    loadTimeoutMs: 1000,
    hostTimeoutMs: 2000,
    socketTimeoutMs: 1000,
    probeIntervalMs: 100,
    socketPollMs: 100,
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms <= 0 ? 1 : ms)
    },
    setTimer: (fn) => {
      const id = ++timerSeq
      timers.set(id, fn)
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (handle) => {
      timers.delete(handle as unknown as number)
    },
  })

  return { session, tabs, clock, timers }
}

/** 等待某个条件成立（基于真实微/宏任务），避免依赖固定 tick 次数。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

test('ensureTab：复用 active 的 goofish tab，不创建新 tab', async () => {
  const h = harness({
    initial: [
      { id: 1, url: 'https://www.goofish.com/item?id=1', active: false, status: 'complete' },
      { id: 2, url: 'https://www.goofish.com/im', active: true, status: 'complete' },
      { id: 3, url: 'https://example.com/', status: 'complete' },
    ],
  })
  const result = await h.session.ensureTab({ purpose: 'chat' })
  assert.deepEqual(result, { ok: true, tabId: 2, created: false })
  assert.equal(h.tabs.created.length, 0)
})

test('ensureTab：无 tab 时后台创建一次（active:false），并等待加载完成', async () => {
  const h = harness({ initial: [{ id: 1, url: 'https://example.com/', status: 'complete' }] })
  const pending = h.session.ensureTab({ purpose: 'chat' })
  await waitFor(() => h.tabs.created.length === 1)
  assert.equal(h.tabs.created.length, 1)
  assert.equal(h.tabs.created[0]?.url, DEFAULT_GOOFISH_IM_URL)
  assert.equal(h.tabs.created[0]?.active, false)

  h.tabs.emitUpdated(100, { status: 'complete' })
  const result = await pending
  assert.deepEqual(result, { ok: true, tabId: 100, created: true })
})

test('ensureTab：并发调用去重，只创建一次 tab', async () => {
  const h = harness({ initial: [] })
  const all = Promise.all([
    h.session.ensureTab({ purpose: 'chat' }),
    h.session.ensureTab({ purpose: 'platform' }),
    h.session.ensureTab({ purpose: 'chat' }),
  ])
  await waitFor(() => h.tabs.created.length === 1)
  assert.equal(h.tabs.created.length, 1)

  h.tabs.emitUpdated(100, { status: 'complete' })
  const results = await all
  for (const result of results) assert.deepEqual(result, { ok: true, tabId: 100, created: true })
})

test('ensureTab：tab 创建后立即关闭 → host-unavailable（不抛错）', async () => {
  const h = harness({ initial: [] })
  h.tabs.setCreate(async () => ({ id: 777, url: DEFAULT_GOOFISH_IM_URL, status: 'loading' }))
  const result = await h.session.ensureTab({ purpose: 'chat' })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.category : '', 'host-unavailable')
})

test('ensureTab：加载超时 → host-unavailable（不无限等待）', async () => {
  const h = harness({ initial: [] })
  const pending = h.session.ensureTab({ purpose: 'chat' })
  await waitFor(() => h.tabs.created.length === 1)
  assert.equal(h.tabs.created.length, 1)

  // 触发加载超时定时器。
  const fire = [...h.timers.values()]
  assert.equal(fire.length, 1)
  fire[0]?.()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.category : '', 'host-unavailable')
})

test('ensureTab：跳转登录页 → unauthorized；跳转验证码页 → captcha', async () => {
  const login = harness({ initial: [] })
  const loginPending = login.session.ensureTab({ purpose: 'chat' })
  await waitFor(() => login.tabs.created.length === 1)
  login.tabs.emitUpdated(100, { status: 'complete', url: 'https://login.taobao.com/member/login.jhtml' })
  const loginResult = await loginPending
  assert.equal(loginResult.ok === false ? loginResult.category : '', 'unauthorized')

  const captcha = harness({ initial: [] })
  const captchaPending = captcha.session.ensureTab({ purpose: 'chat' })
  await waitFor(() => captcha.tabs.created.length === 1)
  captcha.tabs.emitUpdated(100, { status: 'complete', url: 'https://sec.taobao.com/punish/verify' })
  const captchaResult = await captchaPending
  assert.equal(captchaResult.ok === false ? captchaResult.category : '', 'captcha')
})

test('ensureTab：create 抛错 → host-unavailable（不冒泡）', async () => {
  const h = harness({ initial: [] })
  h.tabs.setCreate(async () => {
    throw new Error('tabs.create 被拒绝')
  })
  const result = await h.session.ensureTab({ purpose: 'chat' })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.category : '', 'host-unavailable')
})

test('resolveTabId：只复用不创建；无 goofish tab 时返回 null', async () => {
  const empty = harness({ initial: [{ id: 1, url: 'https://example.com/', status: 'complete' }] })
  assert.equal(await empty.session.resolveTabId(), null)
  assert.equal(empty.tabs.created.length, 0)

  const existing = harness({ initial: [{ id: 5, url: 'https://www.goofish.com/im', status: 'loading' }] })
  assert.equal(await existing.session.resolveTabId(), 5)
})

test('ensureChatRuntimeReady：host + 用户 ID 就绪即成功（socket 超时降级不致命）', async () => {
  const h = harness({ initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }] })
  const result = await h.session.ensureChatRuntimeReady({ purpose: 'chat', force: true })
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.userIdReady, true)
  assert.equal(result.ok && result.socketReady, false)
})

test('ensureChatRuntimeReady：socket 已 open 时 socketReady=true', async () => {
  const h = harness({ initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }] })
  h.session.noteSocketStatus('open')
  const result = await h.session.ensureChatRuntimeReady({ purpose: 'chat' })
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.socketReady, true)
})

test('ensureChatRuntimeReady：host 未就绪 → host-unavailable', async () => {
  const h = harness({
    initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }],
    probeHost: async () => {
      throw new Error('页面未安装 host')
    },
  })
  const result = await h.session.ensureChatRuntimeReady({ purpose: 'chat' })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.category : '', 'host-unavailable')
})

test('ensureChatRuntimeReady：用户 ID 失败时透传类别（captcha）', async () => {
  const h = harness({
    initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }],
    fetchUserId: async () => ({ ok: false, category: 'captcha', message: '需要验证码' }),
  })
  const result = await h.session.ensureChatRuntimeReady({ purpose: 'chat', force: true })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.category : '', 'captcha')
})

test('handleTabRemoved：清理缓存，后续重新查找', async () => {
  const h = harness({ initial: [{ id: 9, url: 'https://www.goofish.com/im', status: 'complete' }] })
  assert.deepEqual(await h.session.ensureTab(), { ok: true, tabId: 9, created: false })
  h.session.handleTabRemoved(9)
  assert.equal(h.session.getStatus().tabReady, false)
})

test('getStatus：初始为未就绪，socket 状态可记录', () => {
  const h = harness({ initial: [] })
  assert.deepEqual(h.session.getStatus(), {
    tabOpen: false,
    tabReady: false,
    hostReady: false,
    socketStatus: 'connecting',
  })
  h.session.noteSocketStatus('closed')
  assert.equal(h.session.getStatus().socketStatus, 'closed')
})

// ---- P8 回归：/im tab 选择、hostReady 生命周期、platformReady/socketReady 分离、结构化失败 ----

test('ensureTab：已有首页但无 /im tab → 后台创建 /im（绝不复用首页）', async () => {
  const h = harness({
    initial: [{ id: 1, url: 'https://www.goofish.com/', active: true, status: 'complete' }],
  })
  const pending = h.session.ensureTab({ purpose: 'chat' })
  await waitFor(() => h.tabs.created.length === 1)
  // 首页是 active 且已加载完成，但聊天路径必须新建 /im。
  assert.equal(h.tabs.created.length, 1)
  assert.equal(h.tabs.created[0]?.url, DEFAULT_GOOFISH_IM_URL)
  assert.equal(h.tabs.created[0]?.active, false)

  h.tabs.emitUpdated(100, { status: 'complete' })
  const result = await pending
  assert.deepEqual(result, { ok: true, tabId: 100, created: true })
})

test('ensureTab：已有首页 + 已有 /im → 优先复用 /im，不创建新 tab', async () => {
  const h = harness({
    initial: [
      { id: 1, url: 'https://www.goofish.com/', active: true, status: 'complete' },
      { id: 2, url: 'https://www.goofish.com/im', active: false, status: 'complete' },
    ],
  })
  const result = await h.session.ensureTab({ purpose: 'chat' })
  assert.deepEqual(result, { ok: true, tabId: 2, created: false })
  assert.equal(h.tabs.created.length, 0)
})

test('ensureTab：/im 带查询串 / 尾部斜杠也识别为聊天页', async () => {
  const h = harness({
    initial: [{ id: 3, url: 'https://www.goofish.com/im/', status: 'complete' }],
  })
  assert.deepEqual(await h.session.ensureTab({ purpose: 'chat' }), {
    ok: true,
    tabId: 3,
    created: false,
  })
  assert.equal(h.tabs.created.length, 0)
})

test('ensureChatRuntimeReady：并发准备共享同一运行时会话，只创建一个 tab', async () => {
  const h = harness({
    initial: [{ id: 1, url: 'https://www.goofish.com/', active: true, status: 'complete' }],
  })
  const all = Promise.all([
    h.session.ensureChatRuntimeReady({ purpose: 'chat', force: true }),
    h.session.ensureChatRuntimeReady({ purpose: 'platform', force: true }),
    h.session.ensureChatRuntimeReady({ purpose: 'chat', force: true }),
  ])
  await waitFor(() => h.tabs.created.length === 1)
  assert.equal(h.tabs.created.length, 1)

  h.tabs.emitUpdated(100, { status: 'complete' })
  const results = await all
  for (const result of results) assert.equal(result.ok, true)
})

test('prepare：区分 platformReady 与 socketReady，socket 未 open 不报 socketReady', async () => {
  const h = harness({ initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }] })
  const result = await h.session.ensureChatRuntimeReady({ purpose: 'chat' })
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.platformReady, true)
  assert.equal(result.ok && result.socketReady, false)
  assert.equal(result.ok && result.socketStatus, 'connecting')
})

test('prepare：socket 真实上报 open 后 socketReady 才为 true', async () => {
  const h = harness({ initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }] })
  h.session.noteSocketStatus('open')
  const result = await h.session.ensureChatRuntimeReady({ purpose: 'chat' })
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.socketReady, true)
  assert.equal(result.ok && result.socketStatus, 'open')
})

test('prepare：host 未就绪 → 结构化失败，platformReady=false', async () => {
  const h = harness({
    initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }],
    probeHost: async () => {
      throw new Error('页面未安装 host')
    },
  })
  const result = await h.session.ensureChatRuntimeReady({ purpose: 'chat' })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.category : '', 'host-unavailable')
  assert.equal(result.ok === false ? result.platformReady : true, false)
  assert.equal(result.ok === false ? result.socketReady : true, false)
  assert.equal(result.ok === false ? result.userIdReady : true, false)
})

test('hostReady：初始 false；真实 probe 成功后 true；ensureTab 不乐观置 true', async () => {
  const h = harness({ initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }] })
  assert.equal(h.session.getStatus().hostReady, false)
  await h.session.ensureTab({ purpose: 'chat' })
  // 仅等待 tab 加载完成不等于 host 就绪。
  assert.equal(h.session.getStatus().hostReady, false)

  const prepared = await h.session.ensureChatRuntimeReady({ purpose: 'chat' })
  assert.equal(prepared.ok, true)
  assert.equal(h.session.getStatus().hostReady, true)
  // 再次复用同一个 tab 时不得把已确认的 host 就绪重置为 false。
  await h.session.ensureTab({ purpose: 'chat' })
  assert.equal(h.session.getStatus().hostReady, true)
})

test('hostReady：platform probe 结果回写，仅采纳当前 tab；tab 关闭后重置', async () => {
  const h = harness({ initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }] })
  await h.session.ensureTab({ purpose: 'chat' })
  assert.equal(h.session.getStatus().hostReady, false)

  h.session.noteHostProbe(1, true)
  assert.equal(h.session.getStatus().hostReady, true)
  // 非当前 tab 的探测结果不被采纳。
  h.session.noteHostProbe(999, true)
  assert.equal(h.session.getStatus().hostReady, true)
  h.session.noteHostProbe(1, false)
  assert.equal(h.session.getStatus().hostReady, false)

  h.session.noteHostProbe(1, true)
  h.session.handleTabRemoved(1)
  assert.equal(h.session.getStatus().hostReady, false)
})

test('hostReady：页面跳转后重置（tab id 不变）', async () => {
  const h = harness({ initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }] })
  await h.session.ensureChatRuntimeReady({ purpose: 'chat' })
  assert.equal(h.session.getStatus().hostReady, true)

  h.tabs.emitUpdated(1, { url: 'https://www.goofish.com/im?tab=2', status: 'loading' })
  assert.equal(h.session.getStatus().hostReady, false)
})

test('hostReady：切换到另一个 /im tab 后重置', async () => {
  const h = harness({
    initial: [
      { id: 1, url: 'https://www.goofish.com/im', active: false, status: 'complete' },
      { id: 2, url: 'https://www.goofish.com/im', active: true, status: 'complete' },
    ],
  })
  await h.session.ensureChatRuntimeReady({ purpose: 'chat' })
  assert.equal(h.session.getStatus().hostReady, true)
  // 关闭当前 active 的 tab（id=2），下次准备会采纳 id=1，host 需要重新探测。
  h.session.handleTabRemoved(2)
  assert.equal(h.session.getStatus().hostReady, false)
})

// ---- 回归：/im 唯一认可、首页不可替代、host/socket 分离、运行时状态一致 ----

test('ensureTab：多个 /im tab 时优先 active 的那个', async () => {
  const h = harness({
    initial: [
      { id: 1, url: 'https://www.goofish.com/im', active: false, status: 'complete' },
      { id: 2, url: 'https://www.goofish.com/im', active: true, status: 'complete' },
    ],
  })
  assert.deepEqual(await h.session.ensureTab({ purpose: 'chat' }), { ok: true, tabId: 2, created: false })
  assert.equal(h.tabs.created.length, 0)
})

test('ensureTab：goofish 商品页不算聊天页，无 /im 时后台创建', async () => {
  const h = harness({
    initial: [{ id: 1, url: 'https://www.goofish.com/item?id=1', active: true, status: 'complete' }],
  })
  const pending = h.session.ensureTab({ purpose: 'chat' })
  await waitFor(() => h.tabs.created.length === 1)
  assert.equal(h.tabs.created[0]?.url, DEFAULT_GOOFISH_IM_URL)
  assert.equal(h.tabs.created[0]?.active, false)

  h.tabs.emitUpdated(100, { status: 'complete' })
  assert.deepEqual(await pending, { ok: true, tabId: 100, created: true })
})

test('resolveTabId：不把 goofish 首页当作聊天 tab（返回 null，不创建）', async () => {
  const h = harness({
    initial: [{ id: 1, url: 'https://www.goofish.com/', active: true, status: 'complete' }],
  })
  assert.equal(await h.session.resolveTabId(), null)
  assert.equal(h.tabs.created.length, 0)
})

test('ensureTab：复用 /im 后跳转到首页 → host-unavailable（绝不用首页替代聊天页）', async () => {
  const h = harness({ initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'loading' }] })
  const pending = h.session.ensureTab({ purpose: 'chat' })
  // /im 被重定向到 goofish 首页（仍是 goofish，但不是聊天页）。
  h.tabs.emitUpdated(1, { status: 'complete', url: 'https://www.goofish.com/' })
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.category : '', 'host-unavailable')
  assert.equal(h.tabs.created.length, 0)
})

test('ensureTab：后台创建的 /im 跳转到首页 → host-unavailable', async () => {
  const h = harness({ initial: [] })
  const pending = h.session.ensureTab({ purpose: 'chat' })
  await waitFor(() => h.tabs.created.length === 1)
  h.tabs.emitUpdated(100, { status: 'complete', url: 'https://www.goofish.com/' })
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.category : '', 'host-unavailable')
})

test('hostReady：socket 上报 open 不会把 hostReady 置为 true', async () => {
  const h = harness({ initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }] })
  await h.session.ensureTab({ purpose: 'chat' })
  h.session.noteSocketStatus('open')
  const status = h.session.getStatus()
  assert.equal(status.socketStatus, 'open')
  assert.equal(status.hostReady, false)
})

test('hostReady：仅真实 probe 置 true；host 就绪不推断 socket', async () => {
  const probeCalls: number[] = []
  const h = harness({
    initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }],
    probeHost: async (tabId) => {
      probeCalls.push(tabId)
    },
  })
  await h.session.ensureTab({ purpose: 'chat' })
  // 仅等待 tab 加载完成（未 ping）时，hostReady 保持 false。
  assert.deepEqual(probeCalls, [])
  assert.equal(h.session.getStatus().hostReady, false)

  const result = await h.session.ensureChatRuntimeReady({ purpose: 'chat' })
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.platformReady, true)
  // host 就绪不等于 socket 就绪。
  assert.equal(result.ok && result.socketReady, false)
  assert.deepEqual(probeCalls, [1])
  assert.equal(h.session.getStatus().hostReady, true)
})

test('状态一致性：当前 tab 关闭后 socket 状态复位为 connecting', async () => {
  const h = harness({ initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }] })
  await h.session.ensureTab({ purpose: 'chat' })
  h.session.noteSocketStatus('open')
  assert.equal(h.session.getStatus().socketStatus, 'open')

  h.session.handleTabRemoved(1)
  const status = h.session.getStatus()
  assert.equal(status.tabReady, false)
  assert.equal(status.socketStatus, 'connecting')
})

test('状态一致性：当前页面导航 / 重载后 socket 状态复位为 connecting', async () => {
  const h = harness({ initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }] })
  await h.session.ensureTab({ purpose: 'chat' })
  h.session.noteSocketStatus('open')
  h.tabs.emitUpdated(1, { status: 'loading', url: 'https://www.goofish.com/im' })
  assert.equal(h.session.getStatus().socketStatus, 'connecting')
})

test('状态一致性：导航到非聊天页后 readyTabId 失效（tabReady=false）', async () => {
  const h = harness({ initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }] })
  await h.session.ensureTab({ purpose: 'chat' })
  assert.equal(h.session.getStatus().tabReady, true)

  h.tabs.emitUpdated(1, { status: 'complete', url: 'https://www.goofish.com/' })
  const status = h.session.getStatus()
  assert.equal(status.tabReady, false)
  assert.equal(status.tabOpen, false)
})

test('状态一致性：host 未就绪时 socketReady/socketStatus 与真实上报一致', async () => {
  const h = harness({
    initial: [{ id: 1, url: 'https://www.goofish.com/im', status: 'complete' }],
    probeHost: async () => {
      throw new Error('页面未安装 host')
    },
  })
  h.session.noteSocketStatus('open')
  const result = await h.session.ensureChatRuntimeReady({ purpose: 'chat' })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false ? result.platformReady : true, false)
  assert.equal(result.socketStatus, 'open')
  assert.equal(result.socketReady, true)
})
