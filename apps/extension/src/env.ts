/** 扩展运行时依赖注入接口：单测注入假实现，生产注入 Chrome API 适配器。 */

// 构建期由 esbuild define 注入本次构建的随机 UUID；源码直接运行时该定义不存在。
// 只用 typeof 判断，Node 源码测试下不会抛 ReferenceError。
declare const __FISHOPS_EXTENSION_BUILD_ID__: string | undefined
declare const __FISHOPS_NATIVE_HOST_NAME__: string | undefined

/** 读取构建注入的 buildId；未经过 esbuild 定义时返回 undefined。 */
function readBuildId(): string | undefined {
  return typeof __FISHOPS_EXTENSION_BUILD_ID__ === 'string' ? __FISHOPS_EXTENSION_BUILD_ID__ : undefined
}

export type CookieQuery = { url: string; name: string }

export type CookieResult = { value?: string } | null

/** `chrome.cookies.onChanged` 的最小信息：只用于判断“哪个 cookie 变了”，不读取 cookie 值。 */
export type CookieChangeEvent = {
  cookie: { name: string; domain?: string }
  cause: string
  removed: boolean
}

export type TabInfo = { id?: number; url?: string }

export interface Timers {
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(handle: number): void
}

/**
 * native Port 的最小接口。
 * `onMessage` / `onDisconnect` 返回取消订阅函数，断开时必须调用，避免旧连接回调泄漏。
 */
export interface NativePortLike {
  postMessage(message: unknown): void
  disconnect(): void
  onMessage(listener: (message: unknown) => void): () => void
  onDisconnect(listener: (info: { message?: string }) => void): () => void
}

export interface ExtensionEnv {
  /** manifest 中的扩展版本，用于 hello 与 system.status。 */
  readonly version: string
  /** 本次构建身份；仅在构建产物中存在，源码测试环境可省略。 */
  readonly buildId?: string
  /** 构建期选择的 native 注册名；默认构建沿用公共协议名称。 */
  readonly hostName?: string
  connectNative(hostName: string): NativePortLike
  cookies: {
    get(query: CookieQuery): Promise<CookieResult>
    onChanged(listener: (change: CookieChangeEvent) => void): () => void
  }
  tabs: {
    /** 查询明确匹配的标签页；页面定位优先最后聚焦窗口，必要时核对全部窗口。 */
    query(pattern: string, options?: { active?: boolean; lastFocusedWindow?: boolean }): Promise<TabInfo[]>
  }
  timers: Timers
  log(level: 'info' | 'warn' | 'error', message: string, details?: Record<string, unknown>): void
}

/** 生产适配器：只包装 Chrome 扩展 API，不发起任何远端请求。 */
export function createChromeEnv(): ExtensionEnv {
  return {
    version: chrome.runtime.getManifest().version,
    buildId: readBuildId(),
    hostName: typeof __FISHOPS_NATIVE_HOST_NAME__ === 'string' ? __FISHOPS_NATIVE_HOST_NAME__ : undefined,
    connectNative(hostName) {
      const port = chrome.runtime.connectNative(hostName)
      return {
        postMessage: (message) => port.postMessage(message),
        disconnect: () => port.disconnect(),
        onMessage(listener) {
          port.onMessage.addListener(listener)
          return () => port.onMessage.removeListener(listener)
        },
        onDisconnect(listener) {
          // Chrome 传入的是 Port 本身，错误原因只在 runtime.lastError；
          // 必须读取 lastError 以消除 “Unchecked runtime.lastError”，且不能把它当成错误对象透传。
          const wrapped = () => {
            const message = chrome.runtime.lastError?.message
            listener(message ? { message } : {})
          }
          port.onDisconnect.addListener(wrapped)
          return () => port.onDisconnect.removeListener(wrapped)
        },
      }
    },
    cookies: {
      get: (query) => chrome.cookies.get({ url: query.url, name: query.name }),
      onChanged(listener) {
        // removed 在 CookieChangeInfo 顶层，不在 cookie 内；这里显式转换，不把完整 cookie 值透传出去。
        const wrapped = (change: chrome.cookies.CookieChangeInfo) =>
          listener({
            cookie: { name: change.cookie.name, domain: change.cookie.domain },
            cause: change.cause,
            removed: change.removed,
          })
        chrome.cookies.onChanged.addListener(wrapped)
        return () => chrome.cookies.onChanged.removeListener(wrapped)
      },
    },
    tabs: {
      query: (pattern, options) => chrome.tabs.query({ url: pattern, ...options }),
    },
    timers: {
      setTimeout: (handler, ms) => setTimeout(handler, ms) as unknown as number,
      clearTimeout: (handle) => clearTimeout(handle),
    },
    log(level, message, details) {
      const line = details ? `${message} ${JSON.stringify(details)}` : message
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.info(line)
    },
  }
}
