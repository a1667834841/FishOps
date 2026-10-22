import type { StepContext } from '../../../packages/protocol/src/step.ts'
import { ApiError } from './errors.ts'

/** Chrome 主文档观察接口；测试不需真实浏览器。 */
export type PageContextDeps = {
  accountId(): Promise<string | null>
  frame(tabId: number): Promise<{ documentId: string; url: string } | null>
  /** 只返回符合明确查询条件的候选标签页；不能退化为“当前任意 tab”。 */
  tabs?(): Promise<Array<{ id?: number; url?: string }>>
  /** 最后聚焦窗口无候选时，查询全部窗口；仍必须全局恰好一个闲鱼主站页。 */
  allTabs?(): Promise<Array<{ id?: number; url?: string }>>
}

const unavailable = () => new ApiError('PAGE_NOT_READY', '执行上下文不可用或已变化', { phase: 'read', retryable: false })
const changed = () => new ApiError('ACCOUNT_CHANGED', '执行账号已变化', { phase: 'read', retryable: false })
const login = () => new ApiError('LOGIN_REQUIRED', '需要登录闲鱼账号', { phase: 'read', retryable: false })

/** documentId 只接受 Chrome 的稳定标识格式，拒绝空白、控制字符和超长值。 */
function validDocumentId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    value.trim() === value && !/[\u0000-\u0020\u007f]/.test(value)
}

/** URL 必须精确落在闲鱼 HTTPS 主站，不能接受子域伪装或带端口地址。 */
function validMainUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'www.goofish.com' &&
      !url.port && !url.username && !url.password
  } catch {
    return false
  }
}

/** 固定页面上下文，不通过挑选另一个 tab 掩盖导航或账号变化。 */
export function createPageContext(deps: PageContextDeps) {
  async function bind(tabId: number): Promise<StepContext> {
    if (!Number.isSafeInteger(tabId) || tabId < 0) throw unavailable()
    let before: string | null
    try { before = await deps.accountId() } catch { throw unavailable() }
    if (!before) throw login()
    let frame: Awaited<ReturnType<PageContextDeps['frame']>>
    try { frame = await deps.frame(tabId) } catch { throw unavailable() }
    let after: string | null
    try { after = await deps.accountId() } catch { throw unavailable() }
    if (before !== after) throw changed()
    if (!frame || !validDocumentId(frame.documentId) || !validMainUrl(frame.url)) throw unavailable()
    return { accountId: before, tabId, documentId: frame.documentId }
  }
  async function verify(expected: StepContext): Promise<StepContext> {
    // 先核对账号，让切换错误不被导航错误掩盖。
    let account: string | null
    try { account = await deps.accountId() } catch { throw unavailable() }
    if (account !== expected.accountId) throw changed()
    const actual = await bind(expected.tabId)
    if (actual.accountId !== expected.accountId) throw changed()
    if (actual.documentId !== expected.documentId) throw unavailable()
    return actual
  }

  /** 候选必须唯一；没有明确页面时不能用任意当前 tab 猜测。 */
  function uniqueTab(tabs: Array<{ id?: number; url?: string }> | null): number {
    if (!Array.isArray(tabs) || tabs.length !== 1) throw unavailable()
    const tabId = tabs[0]?.id
    if (!Number.isSafeInteger(tabId) || Number(tabId) < 0) throw unavailable()
    return tabId as number
  }

  /**
   * 优先选择最后聚焦窗口里唯一的活动闲鱼主站页。
   * DevTools 等独立窗口会改变 lastFocusedWindow；此时回退到全部窗口，
   * 但仍要求全局恰好一个匹配页，不按激活状态或多页顺序挑选。
   */
  async function resolve(expectedAccountId: string): Promise<StepContext> {
    if (typeof expectedAccountId !== 'string' || !expectedAccountId.trim() || expectedAccountId.length > 128) {
      throw unavailable()
    }
    if (!deps.tabs) throw unavailable()
    let account: string | null
    try { account = await deps.accountId() } catch { throw unavailable() }
    if (!account) throw login()
    if (account !== expectedAccountId) throw changed()
    let tabs: Array<{ id?: number; url?: string }>
    try { tabs = await deps.tabs() } catch { throw unavailable() }
    let tabId: number
    if (Array.isArray(tabs) && tabs.length === 1) {
      tabId = uniqueTab(tabs)
    } else if (Array.isArray(tabs) && tabs.length === 0 && deps.allTabs) {
      let all: Array<{ id?: number; url?: string }>
      try { all = await deps.allTabs() } catch { throw unavailable() }
      tabId = uniqueTab(all)
    } else {
      throw unavailable()
    }
    const context = await bind(tabId)
    if (context.accountId !== expectedAccountId) throw changed()
    return context
  }

  return { bind, verify, resolve }
}

/** 生产适配使用 Chrome documentId，不以 URL 相同判断文档未变化。需要 webNavigation 权限。 */
export function createChromePageContext(
  accountId: () => Promise<string | null>,
  tabs: () => Promise<Array<{ id?: number; url?: string }>>,
  allTabs: () => Promise<Array<{ id?: number; url?: string }>>,
) {
  return createPageContext({
    accountId,
    tabs,
    allTabs,
    frame: async tabId => {
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 })
      return frame ? { documentId: frame.documentId, url: frame.url } : null
    },
  })
}
