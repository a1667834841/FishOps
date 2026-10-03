/**
 * 闲鱼聊天 WebSocket 只读监听（P5）。
 *
 * 迁移自 `chat` 分支 `inject/websocket/websocket-data-source.js`，但严格收敛为「只读」：
 * - 仅拦截精确主机 `wss-goofish.dingtalk.com` 的连接并转发 message / open / close / error；
 * - **不实现 send / 发送器**，不在本模块内调用任何写操作（sender 属 P6）；
 * - 解析失败不抛出到全局，交给上层的结构化解析结果处理。
 *
 * 使用方式（已接入）：
 *   `content/chat-main.ts` 在 document_start 调用
 *   `installChatWebSocketMonitor(createChatHost(...).handlers)`，
 *   由 `chat-host.ts` 把原始消息/状态上报到 background。
 * 本函数会包装 `window.WebSocket`；P5 不改动 P1 任何文件，只导出可被注入脚本调用的入口。
 *
 * 健壮性约定：
 * - 目标匹配使用**精确 hostname**（不做 `includes` 子串匹配，避免误伤相似域名）；
 * - 重复 `observe` 同一 socket 幂等，不会重复注册回调；
 * - `dispose` 会移除已注册回调，且只恢复「本次安装」的 wrapper，不会覆盖其它 hook。
 */
import { isTargetChatWebSocket } from '../../../shared/chat/index'

/** 最小 WebSocket 结构（仅声明只读监听用到的成员）。 */
export interface WebSocketLike {
  readyState?: number
  url?: string
  // send 仅由未来 sender 使用，P5 不调用；为兼容真实 socket 类型而声明。
  send?: (data: string) => void
  close?: (code?: number, reason?: string) => void
  addEventListener?: (type: string, listener: (event: unknown) => void) => void
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void
}

/** WebSocket 构造器结构。 */
export interface WebSocketConstructorLike {
  new (url: string, protocols?: string | string[]): WebSocketLike
}

/** 连接状态。 */
export type ChatSocketStatus = 'connecting' | 'open' | 'closed' | 'error'

/** 监听回调集合。 */
export interface ChatWebSocketMonitorHandlers {
  /** 收到目标连接的消息（仅字符串）。 */
  onMessage?: (data: string, socket: WebSocketLike) => void
  /** 目标连接打开。 */
  onOpen?: (socket: WebSocketLike) => void
  /** 目标连接关闭。 */
  onClose?: (info: { code: number; reason: string }, socket: WebSocketLike) => void
  /** 目标连接出错。 */
  onError?: (error: unknown, socket: WebSocketLike) => void
  /** 连接状态变化，便于 UI 提示。 */
  onStatus?: (status: ChatSocketStatus) => void
  /**
   * 检测到目标 socket 时回调，用于未来 sender 复用该连接（P6）。
   * P5 只提供引用，不在此发送任何消息。
   */
  onSocket?: (socket: WebSocketLike) => void
}

/** 监听器选项。 */
export interface ChatWebSocketMonitorOptions {
  /** 自定义目标匹配（默认精确匹配 `wss-goofish.dingtalk.com`）。 */
  isTarget?: (url: string) => boolean
}

/** 默认目标匹配：精确比较 hostname，避免 `includes` 子串误判。 */
function defaultIsTarget(url: string): boolean {
  return isTargetChatWebSocket(url)
}

/** 构造器上不应被复制的成员（函数自身元属性，复制可能报错或破坏语义）。 */
const SKIPPED_STATIC_KEYS = new Set(['prototype', 'length', 'name', 'caller', 'arguments'])

/**
 * 复制原生构造器的静态属性（如 `WebSocket.OPEN` / `CONNECTING` 等常量）。
 * 使用 `getOwnPropertyNames` + 描述符复制，保证不可枚举常量也能继承；
 * 个别不可配置属性复制失败时忽略，不影响监听。
 */
function copyStaticMembers(from: WebSocketConstructorLike, to: Record<string, unknown>): void {
  const source = from as unknown as Record<string, unknown>
  for (const key of Object.getOwnPropertyNames(source)) {
    if (SKIPPED_STATIC_KEYS.has(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (!descriptor) continue
    try {
      Object.defineProperty(to, key, descriptor)
    } catch {
      // 只读/不可配置属性，忽略。
    }
  }
  for (const symbol of Object.getOwnPropertySymbols(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, symbol)
    if (!descriptor) continue
    try {
      Object.defineProperty(to, symbol, descriptor)
    } catch {
      // 同上。
    }
  }
}

interface RegisteredListener {
  type: string
  listener: (event: unknown) => void
}

/**
 * 包装 WebSocket 构造器，观察目标连接。
 * 返回的构造器与原构造器行为一致（`new` 返回真实 socket），仅额外挂载只读监听。
 */
export class ChatWebSocketMonitor {
  private readonly handlers: ChatWebSocketMonitorHandlers
  private readonly isTarget: (url: string) => boolean
  /** 已观察的 socket → 已注册的回调，便于 dispose 时精确移除。 */
  private readonly observed = new Map<WebSocketLike, RegisteredListener[]>()
  private disposed = false

  constructor(handlers: ChatWebSocketMonitorHandlers = {}, options: ChatWebSocketMonitorOptions = {}) {
    this.handlers = handlers
    this.isTarget = options.isTarget ?? defaultIsTarget
  }

  /** 当前处于连接状态的目标 socket（只读用途）。 */
  get activeSockets(): readonly WebSocketLike[] {
    return [...this.observed.keys()]
  }

  /** 包装一个 WebSocket 构造器。 */
  wrap(Original: WebSocketConstructorLike): WebSocketConstructorLike {
    const monitor = this
    const Wrapped = function (this: unknown, url: string, protocols?: string | string[]): WebSocketLike {
      if (new.target === undefined) {
        throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator")
      }
      const socket = new Original(url, protocols)
      if (!monitor.disposed && monitor.isTarget(url)) monitor.observe(socket)
      return socket
    }

    // 复制原型与静态成员，保持与原生 WebSocket 一致（含不可枚举常量）。
    const wrapped = Wrapped as unknown as WebSocketConstructorLike & Record<string, unknown>
    const originalRecord = Original as unknown as Record<string, unknown>
    wrapped.prototype = originalRecord.prototype
    copyStaticMembers(Original, wrapped)
    return wrapped
  }

  /** 对已检测到的目标 socket 挂载只读监听；对同一 socket 重复调用幂等。 */
  observe(socket: WebSocketLike): void {
    if (this.disposed) return
    if (this.observed.has(socket)) return
    const registered: RegisteredListener[] = []
    this.observed.set(socket, registered)

    const safe = (fn: () => void): void => {
      try {
        fn()
      } catch {
        // 监听回调异常不得逃逸到页面主流程。
      }
    }

    const register = (type: string, listener: (event: unknown) => void): void => {
      if (typeof socket.addEventListener !== 'function') return
      socket.addEventListener(type, listener)
      registered.push({ type, listener })
    }

    register('open', () => {
      safe(() => this.emitStatus('open'))
      safe(() => this.handlers.onOpen?.(socket))
    })
    register('message', (event: unknown) => {
      const data = extractStringData(event)
      if (data === null) return
      safe(() => this.handlers.onMessage?.(data, socket))
    })
    register('close', (event: unknown) => {
      // 关闭后释放引用；回调已触发完毕，无需再移除。
      this.observed.delete(socket)
      const info = extractCloseInfo(event)
      safe(() => this.emitStatus('closed'))
      safe(() => this.handlers.onClose?.(info, socket))
    })
    register('error', (event: unknown) => {
      safe(() => this.emitStatus('error'))
      safe(() => this.handlers.onError?.(event, socket))
    })

    safe(() => this.emitStatus('connecting'))
    safe(() => this.handlers.onSocket?.(socket))
  }

  /** 释放监听：移除所有已注册回调，并清空引用。 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const [socket, listeners] of this.observed) {
      if (typeof socket.removeEventListener !== 'function') continue
      for (const { type, listener } of listeners) {
        try {
          socket.removeEventListener(type, listener)
        } catch {
          // 移除失败不影响整体释放。
        }
      }
    }
    this.observed.clear()
  }

  private emitStatus(status: ChatSocketStatus): void {
    this.handlers.onStatus?.(status)
  }
}

/** 从 message 事件中提取字符串数据；非字符串返回 null。 */
export function extractStringData(event: unknown): string | null {
  if (typeof event === 'string') return event
  if (typeof event === 'object' && event !== null) {
    const data = (event as { data?: unknown }).data
    if (typeof data === 'string') return data
  }
  return null
}

/** 从 close 事件中提取 code/reason。 */
function extractCloseInfo(event: unknown): { code: number; reason: string } {
  if (typeof event === 'object' && event !== null) {
    const code = (event as { code?: unknown }).code
    const reason = (event as { reason?: unknown }).reason
    return {
      code: typeof code === 'number' ? code : 0,
      reason: typeof reason === 'string' ? reason : '',
    }
  }
  return { code: 0, reason: '' }
}

/** 安装结果：dispose 时释放监听并恢复原 WebSocket。 */
export interface InstalledMonitor {
  monitor: ChatWebSocketMonitor
  dispose: () => void
}

/**
 * 在 MAIN world 安装 WebSocket 监听：包装 `globalThis.WebSocket`。
 * 若当前环境没有 WebSocket（如纯 Node），返回 null，不抛错。
 *
 * dispose 时**仅在当前全局 WebSocket 仍是本次安装的 wrapper 时**才恢复原构造器，
 * 避免覆盖安装期间由其它脚本/扩展叠加的 hook。
 */
export function installChatWebSocketMonitor(
  handlers: ChatWebSocketMonitorHandlers = {},
  options: ChatWebSocketMonitorOptions = {},
): InstalledMonitor | null {
  const target = globalThis as { WebSocket?: WebSocketConstructorLike }
  const Original = target.WebSocket
  if (typeof Original !== 'function') return null

  const monitor = new ChatWebSocketMonitor(handlers, options)
  const wrapped = monitor.wrap(Original)
  target.WebSocket = wrapped
  return {
    monitor,
    dispose: () => {
      monitor.dispose()
      // 仅恢复自己安装的 wrapper：若期间被别人再次包装，保留对方 wrapper，不强行覆盖。
      if (target.WebSocket === wrapped) target.WebSocket = Original
    },
  }
}
