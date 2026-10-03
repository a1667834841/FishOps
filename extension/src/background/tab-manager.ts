/**
 * 闲鱼 tab 管理。
 *
 * 职责：查找已有 goofish.com 标签页、复用、缺失时创建、感知标签页被关闭。
 * 通过 {@link TabsApi} 注入 Chrome API 子集，使逻辑可在 Node 中用 mock 测试；
 * 真实环境传入 `chrome.tabs`（见 docs / README 集成说明）。
 *
 * 说明（与 P1 的边界）：本文件只做 tab 生命周期，不涉及 MTOP / Cookie / 消息路由。
 */

/** `chrome.tabs.Tab` 的最小子集。 */
export interface TabLike {
  id?: number
  url?: string
  active?: boolean
  windowId?: number
  status?: string
}

/** 注入的 tabs API 子集。 */
export interface TabsApi {
  query(queryInfo: { active?: boolean; windowId?: number }): Promise<TabLike[]>
  create(createProperties: { url: string; active?: boolean }): Promise<TabLike>
  get(tabId: number): Promise<TabLike>
  onRemoved: {
    addListener(
      listener: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void,
    ): void
  }
}

export interface TabManagerDeps {
  tabs: TabsApi
  /** 缺失时创建的闲鱼页面地址。 */
  goofishUrl?: string
}

export interface TabManager {
  /** 判断某个 tab 是否指向闲鱼页面。 */
  isGoofishTab(tab: TabLike): boolean
  /** 查找一个可用的闲鱼 tab（优先 active），无则返回 null。 */
  findGoofishTab(): Promise<TabLike | null>
  /** 复用已有闲鱼 tab，或创建一个新的；返回 tab 与是否新建。 */
  ensureGoofishTab(): Promise<{ tab: TabLike; created: boolean }>
  /** 读取 tab；不存在 / 已关闭时返回 null（不抛错）。 */
  getTab(tabId: number): Promise<TabLike | null>
  /** tab 是否仍存活。 */
  isAlive(tabId: number): Promise<boolean>
  /** tab 被关闭时调用，清理缓存。 */
  handleTabRemoved(tabId: number): void
  /** 当前缓存的 tab id（若有）。 */
  getCachedTabId(): number | null
}

/** 默认闲鱼首页地址。 */
export const DEFAULT_GOOFISH_URL = 'https://www.goofish.com/'

const GOOFISH_HOST = 'goofish.com'

/** 判断 URL 的 host 是否为 goofish.com 或其子域。 */
export function isGoofishUrl(url: string | undefined): boolean {
  if (!url) return false
  try {
    const hostname = new URL(url).hostname
    return hostname === GOOFISH_HOST || hostname.endsWith('.' + GOOFISH_HOST)
  } catch {
    return false
  }
}

/** 创建 tab 管理器。 */
export function createTabManager(deps: TabManagerDeps): TabManager {
  const goofishUrl = deps.goofishUrl ?? DEFAULT_GOOFISH_URL
  let cachedTabId: number | null = null

  function isGoofishTab(tab: TabLike): boolean {
    return isGoofishUrl(tab.url)
  }

  async function getTab(tabId: number): Promise<TabLike | null> {
    try {
      return await deps.tabs.get(tabId)
    } catch {
      // tab 已关闭或不存在的 id
      return null
    }
  }

  async function isAlive(tabId: number): Promise<boolean> {
    return (await getTab(tabId)) !== null
  }

  async function findGoofishTab(): Promise<TabLike | null> {
    // 先验证缓存的 tab 是否仍存活，避免指向已关闭页面。
    if (cachedTabId !== null) {
      const cached = await getTab(cachedTabId)
      if (cached && isGoofishTab(cached)) return cached
      cachedTabId = null
    }

    const tabs = await deps.tabs.query({})
    const goofishTabs = tabs.filter((tab) => isGoofishTab(tab) && tab.id !== undefined)
    if (goofishTabs.length === 0) return null

    // 优先复用当前激活的闲鱼 tab。
    const chosen = goofishTabs.find((tab) => tab.active === true) ?? goofishTabs[0]!
    cachedTabId = chosen.id ?? null
    return chosen
  }

  async function ensureGoofishTab(): Promise<{ tab: TabLike; created: boolean }> {
    const existing = await findGoofishTab()
    if (existing) return { tab: existing, created: false }

    const created = await deps.tabs.create({ url: goofishUrl, active: false })
    cachedTabId = created.id ?? null
    return { tab: created, created: true }
  }

  function handleTabRemoved(tabId: number): void {
    if (cachedTabId === tabId) cachedTabId = null
  }

  return {
    isGoofishTab,
    findGoofishTab,
    ensureGoofishTab,
    getTab,
    isAlive,
    handleTabRemoved,
    getCachedTabId: () => cachedTabId,
  }
}
