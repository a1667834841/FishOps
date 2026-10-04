/**
 * 闲鱼运行时会话（background 侧，P8）。
 *
 * 解决的问题：真实发送测试时常常没有已登录的 goofish 页面，导致
 * `platform.currentUserId`（myUserId）与聊天 WebSocket 都不可用，P5/P6 无法工作。
 * 本模块负责「按需准备一个闲鱼运行时」：
 *
 * 1. {@link RuntimeSession.ensureTab}：优先复用已打开的 `https://www.goofish.com/*` tab；
 *    没有则用 `chrome.tabs.create({ url, active: false })` 后台创建（**不抢焦点**），
 *    并等待页面加载完成（`tabs.onUpdated` + bounded timeout）。
 * 2. {@link RuntimeSession.ensureChatRuntimeReady}：在 tab 就绪后等待页面 MAIN world host
 *    就绪（`probeHost`，即 platform.ping）、聊天 WebSocket 变为 open，
 *    并获取当前用户 ID（`fetchUserId`，带 TTL / 退避，由注入方实现）。
 * 3. 处理 tab 关闭 / 加载超时 / 跳转到非 goofish（登录页、验证码页），
 *    返回结构化 `host-unavailable` / `unauthorized` / `captcha`，**不无限重试**。
 *
 * 技术边界（重要）：
 * - 普通 Chrome 扩展无法真正「隐藏」tab；`active:false` 只是不抢焦点，tab 仍会显示在标签栏；
 * - 不绕过登录 / 验证码 / 权限：只复用已有登录态，检测到登录页或风控页时如实报错；
 * - 通过注入 `chrome.*` 子集与计时器，使逻辑可在 Node 中用 mock 测试（不创建真实 tab）。
 */

/** 运行时就绪失败类别（与平台层错误类别同构，便于直接透传给 UI）。 */
export type RuntimeFailureCategory =
  | 'host-unavailable'
  | 'unauthorized'
  | 'token-expired'
  | 'captcha'
  | 'network'
  | 'api'
  | 'unknown'

/** 聊天 WebSocket 状态（与 P5 同构）。 */
export type RuntimeSocketStatus = 'connecting' | 'open' | 'closed' | 'error'

/** 运行时准备用途。 */
export type RuntimePurpose = 'chat' | 'platform'

/** `chrome.tabs.Tab` 的最小子集。 */
export interface RuntimeTabLike {
  id?: number
  url?: string
  status?: string
  active?: boolean
}

/** 注入的 tabs API 子集。 */
export interface RuntimeTabsApi {
  query(queryInfo: { active?: boolean; windowId?: number }): Promise<RuntimeTabLike[]>
  create(createProperties: { url: string; active: boolean }): Promise<RuntimeTabLike>
  get(tabId: number): Promise<RuntimeTabLike>
  /** 重载已有聊天页，让 document_start 监听与页面登录握手重新启动。 */
  reload?(tabId: number): Promise<void>
  onUpdated: {
    addListener(
      listener: (tabId: number, changeInfo: RuntimeTabChangeInfo, tab: RuntimeTabLike) => void,
    ): void
    removeListener?(
      listener: (tabId: number, changeInfo: RuntimeTabChangeInfo, tab: RuntimeTabLike) => void,
    ): void
  }
  onRemoved?: {
    addListener(listener: (tabId: number) => void): void
  }
}

export interface RuntimeTabChangeInfo {
  status?: string
  url?: string
}

/** tab 准备结果。 */
export type EnsureTabResult =
  | { ok: true; tabId: number; created: boolean }
  | { ok: false; category: RuntimeFailureCategory; message: string }

/** myUserId 获取结果（值与失败细节由注入方提供）。 */
export type RuntimeUserOutcome =
  | { ok: true; userId: string }
  | { ok: false; category: RuntimeFailureCategory; message: string }

/**
 * 运行时就绪结果。
 *
 * 三个就绪维度**互相独立**，调用方必须分别判断，不能用一个好消息推断另一个：
 * `platformReady` 只代表 MAIN world host（platform.ping）探测通过，**不代表** WebSocket 已 open；
 * `socketReady` 只在页面真实上报 `CHAT_SOCKET_STATUS` 为 open 后为真。
 */
export type EnsureReadyResult =
  | {
      ok: true
      tabId: number
      tabCreated: boolean
      /** 页面 MAIN world host 是否已就绪（真实 probe/ping 成功）。 */
      platformReady: boolean
      socketStatus: RuntimeSocketStatus
      socketReady: boolean
      userIdReady: boolean
    }
  | {
      ok: false
      category: RuntimeFailureCategory
      message: string
      tabId: number | null
      /** 页面 MAIN world host 是否已就绪（真实 probe/ping 成功）。 */
      platformReady: boolean
      socketStatus: RuntimeSocketStatus
      socketReady: boolean
      userIdReady: boolean
    }

/** 运行时只读快照（不含用户 ID 值）。 */
export interface RuntimeSessionStatus {
  tabOpen: boolean
  tabReady: boolean
  hostReady: boolean
  socketStatus: RuntimeSocketStatus
  lastError?: { category: RuntimeFailureCategory; message: string }
}

export interface RuntimeSessionDeps {
  tabs: RuntimeTabsApi
  /**
   * 探测目标 tab 的页面 MAIN world host 是否就绪（platform.ping）。
   * resolve 表示就绪；reject 表示未就绪（不区分原因，统一按 host-unavailable 处理）。
   */
  probeHost: (tabId: number) => Promise<void>
  /** 获取当前用户 ID；失败返回结构化类别，不抛错。 */
  fetchUserId: (force: boolean) => Promise<RuntimeUserOutcome>
  /** 读取页面 transport 的真实连接状态；null 表示 host 或连接尚未捕获。 */
  probeChatSocket?: (tabId: number) => Promise<RuntimeSocketStatus | null>
  /** 后台 tab 打开地址，默认 {@link DEFAULT_GOOFISH_IM_URL}。 */
  goofishImUrl?: string
  /** 等待 tab 加载完成的超时（毫秒）。 */
  loadTimeoutMs?: number
  /** 等待 host 就绪的超时（毫秒）。 */
  hostTimeoutMs?: number
  /** 等待 WebSocket open 的超时（毫秒）。 */
  socketTimeoutMs?: number
  /** host 探测失败后的重试间隔（毫秒）。 */
  probeIntervalMs?: number
  /** WebSocket 状态轮询间隔（毫秒）。 */
  socketPollMs?: number
  /** 时间源，便于测试。 */
  now?: () => number
  /** 延时函数，便于测试。 */
  sleep?: (ms: number) => Promise<void>
  /** 计时器注入，便于测试。 */
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

export interface RuntimeSession {
  /** 复用或后台创建 goofish tab，并等待加载完成。 */
  ensureTab(options?: { purpose?: RuntimePurpose }): Promise<EnsureTabResult>
  /** 只复用已存在的 goofish tab（不创建）；无则返回 null。 */
  resolveTabId(): Promise<number | null>
  /** 发送前准备：tab + host + socket + 用户 ID。 */
  ensureChatRuntimeReady(options?: { purpose?: RuntimePurpose; force?: boolean }): Promise<EnsureReadyResult>
  /**
   * 记录一次针对指定 tab 的**真实 host 探测**（platform.ping）结果。
   * 只有当前目标 tab 的结果会被采纳，避免把旧 tab 的探测结果错记到新 tab 上。
   */
  noteHostProbe(tabId: number, ok: boolean): void
  /** 记录页面上报的 WebSocket 状态。 */
  noteSocketStatus(status: RuntimeSocketStatus): void
  /** tab 被关闭时清理缓存。 */
  handleTabRemoved(tabId: number): void
  /** 只读状态快照。 */
  getStatus(): RuntimeSessionStatus
}

/** 默认后台打开的闲鱼聊天页地址。 */
export const DEFAULT_GOOFISH_IM_URL = 'https://www.goofish.com/im'

const DEFAULT_LOAD_TIMEOUT_MS = 15000
const DEFAULT_HOST_TIMEOUT_MS = 8000
const DEFAULT_SOCKET_TIMEOUT_MS = 10000
const DEFAULT_PROBE_INTERVAL_MS = 500
const DEFAULT_SOCKET_POLL_MS = 250

/** 判断 URL 是否为 goofish.com / 子域。 */
function isGoofishUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const hostname = new URL(url).hostname
    return hostname === 'goofish.com' || hostname.endsWith('.goofish.com')
  } catch {
    return false
  }
}

/**
 * 判断 URL 是否为 goofish **聊天页**（host 为 goofish 且 path 恰为 `/im`）。
 *
 * 与 {@link isGoofishUrl} 的区别（关键）：首页 `https://www.goofish.com/` 也是 goofish，
 * 但**不能**当作聊天 tab 复用 —— 复用首页会让聊天 transport 拿不到聊天页的 socket / DOM。
 * 因此运行时 tab 选择只认 `/im`；没有 `/im` 时后台创建 `/im`，绝不用首页顶替。
 */
function isGoofishImUrl(url: string | undefined): boolean {
  if (!isGoofishUrl(url)) return false
  try {
    // 去掉尾部斜杠后要求 path 恰为 /im（容忍 `.../im/`）。
    const path = new URL(url as string).pathname.replace(/\/+$/, '')
    return path === '/im'
  } catch {
    return false
  }
}

/**
 * 把「跳转到非 goofish 页面」分类为登录 / 验证码 / 其他。
 *
 * 闲鱼登录态失效时会跳到 taobao passport；命中风控时会跳到验证码 / punish 页。
 * 这里只做 URL 特征判断，绝不尝试绕过验证。
 */
function classifyNonGoofishUrl(url: string | undefined): { category: RuntimeFailureCategory; message: string } {
  const lower = (url ?? '').toLowerCase()
  if (/login|passport|signin|havana|__verify/i.test(lower)) {
    return { category: 'unauthorized', message: '闲鱼页面跳转到登录页，请先登录已授权的闲鱼账号' }
  }
  if (/captcha|_tmd_|punish|x5sec|sec\.taobao|verify|安全/.test(lower)) {
    return { category: 'captcha', message: '闲鱼页面出现验证码 / 安全验证，请人工完成后再重试' }
  }
  return { category: 'host-unavailable', message: `闲鱼页面被重定向到非 goofish 地址: ${describeUrl(url)}` }
}

/** 只保留 URL 的 host（避免把完整 URL / 查询串写入日志）。 */
function describeUrl(url: string | undefined): string {
  if (!url) return '(空)'
  try {
    return new URL(url).hostname
  } catch {
    return '(非法 URL)'
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 创建闲鱼运行时会话。 */
export function createRuntimeSession(deps: RuntimeSessionDeps): RuntimeSession {
  const goofishImUrl = deps.goofishImUrl ?? DEFAULT_GOOFISH_IM_URL
  const loadTimeoutMs = deps.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS
  const hostTimeoutMs = deps.hostTimeoutMs ?? DEFAULT_HOST_TIMEOUT_MS
  const socketTimeoutMs = deps.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS
  const probeIntervalMs = deps.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS
  const socketPollMs = deps.socketPollMs ?? DEFAULT_SOCKET_POLL_MS
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle))

  /** 已确认可复用（加载完成且为 goofish）的 tab id。 */
  let readyTabId: number | null = null
  /** 最近一次使用过的 goofish tab id（可能是加载中的）。 */
  let cachedTabId: number | null = null
  /** 页面上报的 WebSocket 状态。 */
  let socketStatus: RuntimeSocketStatus = 'connecting'
  /** host 探测成功对应的 tab id；null 表示当前目标 tab 尚无已确认就绪的 host。 */
  let hostReadyTabId: number | null = null
  /** 最近一次失败（成功后清空）。 */
  let lastError: { category: RuntimeFailureCategory; message: string } | undefined
  /** 进行中的 tab 准备 promise（并发去重，限制并发创建）。 */
  let tabInFlight: Promise<EnsureTabResult> | null = null
  /** 按用途与用户 ID 刷新策略合并并发准备，避免不同就绪条件互相复用结果。 */
  const readyInFlight = new Map<string, Promise<EnsureReadyResult>>()
  /** 不同刷新策略的准备请求也共享同一次页面恢复，避免连续重载打断握手。 */
  const recoveryInFlight = new Map<number, Promise<EnsureTabResult>>()

  /** 清空 host 就绪标记（tab / 页面变化后必须重新探测，避免沿用旧值）。 */
  function resetHostState(): void {
    hostReadyTabId = null
  }

  /**
   * 页面上下文失效（导航 / 重载 / tab 关闭）后，socket 状态不再可信，回到未知。
   *
   * socket 上报只描述**当前页面**；上一个页面的 open 绝不能被沿用，否则会出现
   * 「hostReady 已重置为 false，但 socketStatus 仍为 open」的状态不一致。
   */
  function resetSocketState(): void {
    socketStatus = 'connecting'
  }

  /** 当前目标 tab（已确认加载完成的优先，其次最近使用过的）。 */
  function currentTabId(): number | null {
    return readyTabId ?? cachedTabId
  }

  /** host 是否对**当前目标 tab**就绪（由真实 probe/ping 成功设置）。 */
  function isHostReady(): boolean {
    const target = currentTabId()
    return hostReadyTabId !== null && target !== null && hostReadyTabId === target
  }

  /** 采纳目标 tab：目标变化时重置 host 就绪标记，避免张冠李戴。 */
  function adoptTabId(tabId: number | null): void {
    if (cachedTabId === tabId) return
    cachedTabId = tabId
    // 目标 tab 变化后，上一次针对旧 tab 的「已就绪」结论不再适用。
    if (readyTabId !== null && readyTabId !== tabId) readyTabId = null
    resetHostState()
  }

  // 页面开始导航或 URL 变化时，之前的 host / socket 结论立即失效（即使 tab id 未变）。
  deps.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (tabId !== cachedTabId && tabId !== readyTabId) return
    const url = changeInfo.url ?? tab.url
    if (changeInfo.url !== undefined || changeInfo.status === 'loading') {
      resetHostState()
      resetSocketState()
      // 导航到非聊天页（首页 / 商品页 / 登录页）：当前 tab 不再是有效聊天运行时，清缓存待下次重选。
      if (url !== undefined && !isGoofishImUrl(url)) {
        if (cachedTabId === tabId) cachedTabId = null
        if (readyTabId === tabId) readyTabId = null
      }
    }
  })

  async function safeGet(tabId: number): Promise<RuntimeTabLike | null> {
    try {
      return await deps.tabs.get(tabId)
    } catch {
      return null
    }
  }

  /**
   * 查找一个可复用的 **goofish 聊天页（/im）** tab（优先 active，其次缓存顺序）。
   * 只认 `/im`：首页等非聊天 goofish 页不参与复用，避免聊天路径拿到非聊天页。
   */
  async function findReusableTab(): Promise<RuntimeTabLike | null> {
    if (cachedTabId !== null) {
      const cached = await safeGet(cachedTabId)
      if (cached && typeof cached.id === 'number' && isGoofishImUrl(cached.url)) return cached
      adoptTabId(null)
    }

    const tabs = await deps.tabs.query({})
    const imTabs = tabs.filter((tab): tab is RuntimeTabLike & { id: number } => {
      return typeof tab.id === 'number' && isGoofishImUrl(tab.url)
    })
    if (imTabs.length === 0) return null

    const chosen = imTabs.find((tab) => tab.active === true) ?? imTabs[0]!
    adoptTabId(chosen.id)
    return chosen
  }

  /**
   * 等待 tab 加载完成；期间处理关闭 / 超时 / 跳转非 goofish。
   * 返回 ok 表示已确认为加载完成的 goofish 页面。
   */
  function waitForTabComplete(
    tabId: number,
  ): Promise<{ ok: true } | { ok: false; category: RuntimeFailureCategory; message: string }> {
    return new Promise((resolve) => {
      let settled = false

      const cleanup = (): void => {
        deps.tabs.onUpdated.removeListener?.(onUpdated)
        clearTimer(timer)
      }
      const finish = (
        result: { ok: true } | { ok: false; category: RuntimeFailureCategory; message: string },
      ): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }

      /** 检查一个 tab 快照；命中终态时返回 true。 */
      const inspect = (tab: RuntimeTabLike): boolean => {
        if (!isGoofishUrl(tab.url)) {
          finish({ ok: false, ...classifyNonGoofishUrl(tab.url) })
          return true
        }
        if (tab.status === 'complete') {
          // 必须是聊天页 /im：goofish 首页 / 商品页等**不能**当作聊天运行时 tab。
          if (!isGoofishImUrl(tab.url)) {
            finish({
              ok: false,
              category: 'host-unavailable',
              message: `闲鱼页面被重定向到非聊天页: ${describeUrl(tab.url)}`,
            })
            return true
          }
          finish({ ok: true })
          return true
        }
        return false
      }

      const onUpdated = (updatedId: number, changeInfo: RuntimeTabChangeInfo, tab: RuntimeTabLike): void => {
        if (updatedId !== tabId) return
        const url = changeInfo.url ?? tab.url
        if (changeInfo.status === 'complete' || (changeInfo.url !== undefined && !isGoofishUrl(url))) {
          inspect({ id: tabId, status: changeInfo.status ?? tab.status, url })
        }
      }

      deps.tabs.onUpdated.addListener(onUpdated)

      // 超时兜底：不无限等待。
      const timer = setTimer(() => {
        finish({ ok: false, category: 'host-unavailable', message: `等待闲鱼页面加载超时（${loadTimeoutMs}ms）` })
      }, loadTimeoutMs)

      void safeGet(tabId).then((tab) => {
        if (tab) {
          inspect(tab)
        } else {
          finish({ ok: false, category: 'host-unavailable', message: '闲鱼标签页已关闭' })
        }
      })
    })
  }

  async function ensureTabInternal(): Promise<EnsureTabResult> {
    const existing = await findReusableTab()
    if (existing && typeof existing.id === 'number') {
      // 复用同一个已就绪 tab 时保留已有 host 探测结果；只有 findReusableTab 采纳了
      // 不同的 tab 时才会重置（见 adoptTabId），避免“每次 ensureTab 都乐观置 false”。
      if (existing.status === 'complete') {
        readyTabId = existing.id
        return { ok: true, tabId: existing.id, created: false }
      }
      const waited = await waitForTabComplete(existing.id)
      if (!waited.ok) {
        lastError = { category: waited.category, message: waited.message }
        // 该 tab 未能确认为可用聊天页：清掉可能残留的「已就绪」标记，保持状态一致。
        if (readyTabId === existing.id) readyTabId = null
        return waited
      }
      readyTabId = existing.id
      return { ok: true, tabId: existing.id, created: false }
    }

    let created: RuntimeTabLike
    try {
      // active:false —— 不抢焦点、切换到后台创建；注意这不是「隐藏」，tab 仍会出现在标签栏。
      created = await deps.tabs.create({ url: goofishImUrl, active: false })
    } catch (error) {
      const message = `创建后台闲鱼页面失败: ${messageOf(error)}`
      lastError = { category: 'host-unavailable', message }
      return { ok: false, category: 'host-unavailable', message }
    }

    if (typeof created.id !== 'number') {
      const message = '创建的后台闲鱼页面缺少 tab id'
      lastError = { category: 'host-unavailable', message }
      return { ok: false, category: 'host-unavailable', message }
    }

    adoptTabId(created.id)
    readyTabId = null

    const waited = await waitForTabComplete(created.id)
    if (!waited.ok) {
      lastError = { category: waited.category, message: waited.message }
      return waited
    }
    readyTabId = created.id
    return { ok: true, tabId: created.id, created: true }
  }

  function ensureTab(): Promise<EnsureTabResult> {
    // 并发去重：多个并发准备请求共享同一次 tab 创建 / 查找，避免重复创建 tab。
    if (tabInFlight) return tabInFlight
    const run = ensureTabInternal()
    tabInFlight = run.finally(() => {
      tabInFlight = null
    })
    return tabInFlight
  }

  async function resolveTabId(): Promise<number | null> {
    // 优先复用已确认就绪的 tab；否则查找现有 goofish 聊天页（不创建）。
    if (readyTabId !== null) {
      const tab = await safeGet(readyTabId)
      if (tab && isGoofishImUrl(tab.url)) return readyTabId
      readyTabId = null
      resetHostState()
    }
    const existing = await findReusableTab()
    return existing && typeof existing.id === 'number' ? existing.id : null
  }

  /** 轮询等待 host 就绪（有限次数，受 deadline 约束，不无限重试）。 */
  async function waitForHost(tabId: number): Promise<{ ok: true } | { ok: false; message: string }> {
    const deadline = now() + hostTimeoutMs
    let lastMessage = '页面 host 未就绪'
    for (;;) {
      try {
        await deps.probeHost(tabId)
        // 只有真实 probe 成功才置为就绪。
        hostReadyTabId = tabId
        return { ok: true }
      } catch (error) {
        lastMessage = `页面 host 未就绪: ${messageOf(error)}`
      }
      if (now() + probeIntervalMs >= deadline) break
      await sleep(probeIntervalMs)
    }
    resetHostState()
    return { ok: false, message: lastMessage }
  }

  /** 页面上报的 WebSocket 状态（用 getter 读取，避免 TS 对闭包 let 的错误收窄）。 */
  function currentSocketStatus(): RuntimeSocketStatus {
    return socketStatus
  }

  /** 有限等待 socket open；聊天同步依赖该连接，平台 API 准备则不依赖。 */
  async function refreshSocketStatus(tabId: number): Promise<RuntimeSocketStatus | null> {
    if (!deps.probeChatSocket) return currentSocketStatus()
    try {
      const status = await deps.probeChatSocket(tabId)
      if (currentTabId() !== tabId) return null
      socketStatus = status ?? 'connecting'
      return status
    } catch {
      // 注入失败时不把旧的 open 当成当前连接，后续由页面恢复流程处理。
      resetSocketState()
      return null
    }
  }

  async function waitForSocketOpen(tabId: number): Promise<boolean> {
    if (currentSocketStatus() === 'open') return true
    const deadline = now() + socketTimeoutMs
    while (now() < deadline) {
      await sleep(socketPollMs)
      await refreshSocketStatus(tabId)
      if (currentSocketStatus() === 'open') return true
    }
    return currentSocketStatus() === 'open'
  }

  function recoverChatPage(tabId: number): Promise<EnsureTabResult> {
    const existing = recoveryInFlight.get(tabId)
    if (existing) return existing
    const run = (async (): Promise<EnsureTabResult> => {
      if (!deps.tabs.reload) return { ok: false, category: 'host-unavailable', message: '无法自动重载闲鱼聊天页' }
      resetHostState()
      resetSocketState()
      readyTabId = null
      try {
        await deps.tabs.reload(tabId)
      } catch (error) {
        return { ok: false, category: 'host-unavailable', message: `重载闲鱼聊天页失败: ${messageOf(error)}` }
      }
      const loaded = await waitForTabComplete(tabId)
      if (!loaded.ok) return loaded
      readyTabId = tabId
      const host = await waitForHost(tabId)
      return host.ok
        ? { ok: true, tabId, created: false }
        : { ok: false, category: 'host-unavailable', message: host.message }
    })()
    const shared = run.finally(() => {
      if (recoveryInFlight.get(tabId) === shared) recoveryInFlight.delete(tabId)
    })
    recoveryInFlight.set(tabId, shared)
    return shared
  }

  async function ensureChatRuntimeReadyInternal(options: {
    purpose?: RuntimePurpose
    force?: boolean
  } = {}): Promise<EnsureReadyResult> {
    const tab = await ensureTab()
    if (!tab.ok) {
      lastError = { category: tab.category, message: tab.message }
      return {
        ok: false,
        category: tab.category,
        message: tab.message,
        tabId: null,
        platformReady: false,
        socketStatus: currentSocketStatus(),
        socketReady: currentSocketStatus() === 'open',
        userIdReady: false,
      }
    }

    const needsSocket = options.purpose !== 'platform'
    let recovered = false
    let host = await waitForHost(tab.tabId)
    if (!host.ok && needsSocket && deps.tabs.reload) {
      recovered = true
      const recovery = await recoverChatPage(tab.tabId)
      if (!recovery.ok) {
        lastError = { category: recovery.category, message: recovery.message }
        return { ok: false, ...lastError, tabId: tab.tabId, platformReady: false,
          socketStatus: currentSocketStatus(), socketReady: false, userIdReady: false }
      }
      host = { ok: true }
    }
    if (!host.ok) {
      lastError = { category: 'host-unavailable', message: host.message }
      return {
        ok: false,
        category: 'host-unavailable',
        message: host.message,
        tabId: tab.tabId,
        platformReady: false,
        socketStatus: currentSocketStatus(),
        socketReady: currentSocketStatus() === 'open',
        userIdReady: false,
      }
    }

    // host 已就绪：platformReady 为真。socket 与 userId 仍需分别判定，不能因 host 成功而推断。
    const user = await deps.fetchUserId(Boolean(options.force))
    if (!user.ok) {
      lastError = { category: user.category, message: user.message }
      return {
        ok: false,
        category: user.category,
        message: user.message,
        tabId: tab.tabId,
        platformReady: true,
        socketStatus: currentSocketStatus(),
        socketReady: currentSocketStatus() === 'open',
        userIdReady: false,
      }
    }

    const pageStatus = await refreshSocketStatus(tab.tabId)
    let socketReady = currentSocketStatus() === 'open'
    if (needsSocket && !socketReady) {
      // 新页面先等原站初始化。旧页面没有捕获连接时直接恢复，避免只等一个不会再发的 open 事件。
      if (tab.created || recovered || pageStatus === 'connecting' || !deps.probeChatSocket) {
        socketReady = await waitForSocketOpen(tab.tabId)
      }
      if (!socketReady && !recovered && deps.tabs.reload) {
        const recovery = await recoverChatPage(tab.tabId)
        if (!recovery.ok) {
          lastError = { category: recovery.category, message: recovery.message }
          return { ok: false, ...lastError, tabId: tab.tabId, platformReady: isHostReady(),
            socketStatus: currentSocketStatus(), socketReady: false, userIdReady: true }
        }
        await refreshSocketStatus(tab.tabId)
        socketReady = await waitForSocketOpen(tab.tabId)
      }
    }

    // 会话同步必须复用真实聊天 WebSocket。把 socket 超时降级为成功会让启动流程
    // 继续发起必然返回 NO_SOCKET 的同步，并把空缓存误显示成正常空列表。
    if (options.purpose !== 'platform' && !socketReady) {
      const message = `聊天 WebSocket 尚未建立（当前状态：${currentSocketStatus()}），请稍后重试`
      lastError = { category: 'host-unavailable', message }
      return {
        ok: false,
        category: 'host-unavailable',
        message,
        tabId: tab.tabId,
        platformReady: true,
        socketStatus: currentSocketStatus(),
        socketReady: false,
        userIdReady: true,
      }
    }

    lastError = undefined
    return {
      ok: true,
      tabId: tab.tabId,
      tabCreated: tab.created,
      platformReady: true,
      socketStatus: currentSocketStatus(),
      socketReady,
      userIdReady: true,
    }
  }

  function ensureChatRuntimeReady(options: {
    purpose?: RuntimePurpose
    force?: boolean
  } = {}): Promise<EnsureReadyResult> {
    // 同用途、同刷新策略的并发 prepare 共用一次探测；chat 与 platform 的 socket
    // 要求不同，必须分开，避免 platform 的成功结果绕过 chat 的 socket 检查。
    // 完成后清空，后续调用（含失败重试）会重新走完整流程，不会长期缓存失败结果。
    const purpose = options.purpose ?? 'chat'
    const key = `${purpose}:${Boolean(options.force)}`
    const existing = readyInFlight.get(key)
    if (existing) return existing
    const run = ensureChatRuntimeReadyInternal(options)
    let shared: Promise<EnsureReadyResult>
    shared = run.finally(() => {
      if (readyInFlight.get(key) === shared) readyInFlight.delete(key)
    })
    readyInFlight.set(key, shared)
    return shared
  }

  return {
    ensureTab: () => ensureTab(),
    resolveTabId,
    ensureChatRuntimeReady,
    noteHostProbe(tabId: number, ok: boolean): void {
      // 只采纳当前目标 tab 的探测结果。
      if (tabId !== currentTabId()) return
      hostReadyTabId = ok ? tabId : null
    },
    noteSocketStatus(status: RuntimeSocketStatus): void {
      socketStatus = status
    },
    handleTabRemoved(tabId: number): void {
      const wasCurrent = tabId === cachedTabId || tabId === readyTabId
      if (cachedTabId === tabId) cachedTabId = null
      if (readyTabId === tabId) readyTabId = null
      if (hostReadyTabId === tabId) resetHostState()
      // 当前 tab 被关闭，其页面的 socket 也随之失效，状态回到未知。
      if (wasCurrent) resetSocketState()
    },
    getStatus(): RuntimeSessionStatus {
      return {
        tabOpen: cachedTabId !== null || readyTabId !== null,
        tabReady: readyTabId !== null,
        // 只反映真实探测结果，不做乐观推断。
        hostReady: isHostReady(),
        socketStatus,
        ...(lastError === undefined ? {} : { lastError }),
      }
    },
  }
}
