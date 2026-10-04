import {
  createCommand,
  EVENT_PORT_NAME,
  isEventEnvelope,
  isResponseEnvelope,
  type CommandEnvelope,
  type EventEnvelope,
  type RequestId,
  type ResponseEnvelope,
} from '@fishops/shared'
import { BridgeError } from './errors'
import { unwrapPageMessage, wrapPageMessage } from './postmessage-protocol'

/**
 * Bridge 传输层抽象：把「发请求 / 收事件」从具体载体
 * （chrome.runtime 或 window.postMessage）解耦出来，便于替换与测试。
 */
export interface Transport {
  readonly name: string
  /** 发起一次命令并等待响应。 */
  call(command: CommandEnvelope): Promise<ResponseEnvelope>
  /** 订阅事件，返回取消订阅函数。 */
  onEvent(handler: (event: EventEnvelope) => void): () => void
  /** 声明本端关心的事件类型，供扩展精确投递。 */
  setSubscription(events: string[]): void
  /** 释放底层资源。 */
  dispose(): void
}

/**
 * 扩展内页（chrome-extension://）使用的传输层。
 *
 * - 命令：`chrome.runtime.sendMessage`，由 background 异步 sendResponse 回。
 * - 事件：`chrome.runtime.connect` 长连接 Port；service worker 被回收时 Port 断开，
 *   下次 onEvent 会自动重连，符合 MV3 生命周期。
 */
export class ChromeRuntimeTransport implements Transport {
  readonly name = 'chrome-runtime'
  private port: chrome.runtime.Port | null = null
  private readonly handlers = new Set<(event: EventEnvelope) => void>()

  private readonly onPortMessage = (message: unknown): void => {
    if (!isEventEnvelope(message)) return
    for (const handler of this.handlers) handler(message)
  }

  private readonly onPortDisconnect = (): void => {
    // service worker 被回收或端口被关闭时触发；此处只清理引用，下次 onEvent 会重连。
    this.port = null
  }

  call(command: CommandEnvelope): Promise<ResponseEnvelope> {
    return new Promise<ResponseEnvelope>((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(command, (response: unknown) => {
          const lastError = chrome.runtime.lastError
          if (lastError) {
            reject(new BridgeError('INTERNAL', lastError.message ?? 'chrome.runtime.sendMessage 失败'))
            return
          }
          if (!isResponseEnvelope(response)) {
            reject(new BridgeError('INVALID_MESSAGE', '扩展返回的响应不是合法 ResponseEnvelope'))
            return
          }
          resolve(response)
        })
      } catch (error) {
        reject(error instanceof Error ? error : new BridgeError('INTERNAL', String(error)))
      }
    })
  }

  onEvent(handler: (event: EventEnvelope) => void): () => void {
    this.handlers.add(handler)
    this.ensurePort()
    return () => {
      this.handlers.delete(handler)
      if (this.handlers.size === 0) this.closePort()
    }
  }

  setSubscription(events: string[]): void {
    this.ensurePort().postMessage({ kind: 'subscribe', events })
  }

  dispose(): void {
    this.handlers.clear()
    this.closePort()
  }

  private ensurePort(): chrome.runtime.Port {
    if (this.port) return this.port
    const port = chrome.runtime.connect({ name: EVENT_PORT_NAME })
    port.onMessage.addListener(this.onPortMessage)
    port.onDisconnect.addListener(this.onPortDisconnect)
    this.port = port
    return port
  }

  private closePort(): void {
    if (!this.port) return
    this.port.onMessage.removeListener(this.onPortMessage)
    this.port.onDisconnect.removeListener(this.onPortDisconnect)
    this.port.disconnect()
    this.port = null
  }
}

/**
 * 普通网页（如 localhost 开发页）使用的传输层：全部经 window.postMessage，
 * 由 content script（isolated bridge）转发到 background。
 */
export class PostMessageTransport implements Transport {
  readonly name = 'postmessage'
  private readonly handlers = new Set<(event: EventEnvelope) => void>()
  private readonly pending = new Map<
    RequestId,
    { resolve: (response: ResponseEnvelope) => void; reject: (error: unknown) => void; timer: number }
  >()

  private readonly timeoutMs: number

  constructor(timeoutMs = 8000) {
    this.timeoutMs = timeoutMs
    window.addEventListener('message', this.onWindowMessage)
  }

  private readonly onWindowMessage = (event: MessageEvent): void => {
    if (event.source !== window) return
    const envelope = unwrapPageMessage(event.data)
    if (!envelope) return
    if (isEventEnvelope(envelope.message)) {
      for (const handler of this.handlers) handler(envelope.message)
      return
    }
    if (isResponseEnvelope(envelope.message)) this.settle(envelope.message)
  }

  call(command: CommandEnvelope): Promise<ResponseEnvelope> {
    return new Promise<ResponseEnvelope>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(command.requestId)
        reject(new BridgeError('TIMEOUT', `页面侧命令 ${command.type} 超时`))
      }, this.timeoutMs)
      this.pending.set(command.requestId, { resolve, reject, timer })
      window.postMessage(wrapPageMessage(command), window.location.origin)
    })
  }

  onEvent(handler: (event: EventEnvelope) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  setSubscription(events: string[]): void {
    void this.call(createCommand('SUBSCRIBE', { events })).catch(() => {
      // 页面侧若没有 content bridge 接收，订阅会超时；属于预期情况，忽略。
    })
  }

  dispose(): void {
    window.removeEventListener('message', this.onWindowMessage)
    for (const { reject, timer } of this.pending.values()) {
      window.clearTimeout(timer)
      reject(new BridgeError('NO_TRANSPORT', 'transport 已释放'))
    }
    this.pending.clear()
    this.handlers.clear()
  }

  private settle(response: ResponseEnvelope): void {
    const entry = this.pending.get(response.requestId)
    if (!entry) return
    window.clearTimeout(entry.timer)
    this.pending.delete(response.requestId)
    entry.resolve(response)
  }
}

/** 依据运行环境选择默认传输层：扩展内页用 chrome.runtime，普通网页用 postMessage。 */
export function createDefaultTransport(timeoutMs = 8000): Transport {
  const hasChromeRuntime =
    typeof chrome !== 'undefined' && Boolean(chrome.runtime) && Boolean(chrome.runtime.id)
  if (hasChromeRuntime) return new ChromeRuntimeTransport()
  if (typeof window !== 'undefined') return new PostMessageTransport(timeoutMs)
  throw new BridgeError('NO_TRANSPORT', '当前环境既没有 chrome.runtime 也没有 window，无法建立 Bridge')
}
