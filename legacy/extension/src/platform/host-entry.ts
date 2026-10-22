/**
 * MAIN world runtime host 的页面挂载层。
 *
 * 本模块把 {@link RuntimeHost} 暴露到页面：既挂到 `window.__FISHOPS_PLATFORM_HOST__`
 * （供 `chrome.scripting.executeScript` 直接调用），也监听 `window` message
 * （供 ISOLATED content bridge 转发调用，信封用 {@link PLATFORM_CHANNEL} 与 P1 消息区分）。
 *
 * 为保持无副作用、可测试，核心的 {@link respondToPlatformCall} 不接触 `window`。
 */
import { isPlatformCallRequest, type PlatformCallResponse } from './protocol'
import type { RuntimeHost } from './runtime-host'

/** 页面 message 事件的最小形状。 */
export interface PlatformMessageEvent {
  data: unknown
  origin?: string
  source?: unknown
}

/**
 * `window` 的最小抽象。
 *
 * 真实页面挂载时传入 `window as unknown as HostWindowLike`（DOM 的 `Window` 类型
 * 与这里的结构签名不完全一致，属于有意的最小化）。
 */
export interface HostWindowLike {
  addEventListener(type: 'message', listener: (event: PlatformMessageEvent) => void): void
  removeEventListener?(type: 'message', listener: (event: PlatformMessageEvent) => void): void
  postMessage(message: unknown, targetOrigin?: string): void
  __FISHOPS_PLATFORM_HOST__?: unknown
}

export interface InstallOptions {
  /** 只接受来自该窗口的消息（通常是页面自身 window）。 */
  selfWindow?: unknown
  /** 允许的 origin 白名单；提供后不匹配的消息会被忽略。 */
  allowedOrigins?: string[]
}

export interface InstalledRuntimeHost {
  /** 手动处理一条 message 数据并返回响应（null 表示不是平台调用）。 */
  handleMessage(data: unknown): Promise<PlatformCallResponse | null>
  /** 卸载监听。 */
  dispose(): void
}

/**
 * 纯函数核心：若 `data` 是平台调用信封，则交由 host 处理并返回结构化响应，否则返回 null。
 */
export async function respondToPlatformCall(
  host: RuntimeHost,
  data: unknown,
): Promise<PlatformCallResponse | null> {
  if (!isPlatformCallRequest(data)) return null
  return host.handleCall(data)
}

/**
 * 把 runtime host 挂载到页面窗口。
 *
 * @param win 页面 window（或测试用 mock）。
 */
export function installRuntimeHost(
  win: HostWindowLike,
  host: RuntimeHost,
  options: InstallOptions = {},
): InstalledRuntimeHost {
  const selfWindow = options.selfWindow ?? win
  const allowedOrigins = options.allowedOrigins

  const listener = (event: PlatformMessageEvent): void => {
    if (event.source !== selfWindow) return
    if (allowedOrigins && (!event.origin || !allowedOrigins.includes(event.origin))) return

    void respondToPlatformCall(host, event.data).then((response) => {
      if (!response) return
      // 回给页面自身；origin 不可用时退化为 '*'（MAIN world 内部消息，不跨标签页）。
      const targetOrigin = event.origin && event.origin !== 'null' ? event.origin : '*'
      win.postMessage(response, targetOrigin)
    })
  }

  win.addEventListener('message', listener)
  win.__FISHOPS_PLATFORM_HOST__ = host

  return {
    handleMessage(data: unknown): Promise<PlatformCallResponse | null> {
      return respondToPlatformCall(host, data)
    },
    dispose(): void {
      win.removeEventListener?.('message', listener)
      if (win.__FISHOPS_PLATFORM_HOST__ === host) delete win.__FISHOPS_PLATFORM_HOST__
    },
  }
}
