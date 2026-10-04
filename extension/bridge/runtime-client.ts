import {
  createCommand,
  traceCommandCall,
  genRequestId,
  type CommandPayloadMap,
  type CommandResultMap,
  type CommandType,
  type EventEnvelope,
  type EventPayloadMap,
  type EventType,
} from '@fishops/shared'
import { BridgeError } from './errors'
import { createDefaultTransport, type Transport } from './transport'

export interface RuntimeClientOptions {
  /** 自定义传输层；默认根据运行环境自动选择。 */
  transport?: Transport
  /** 单次命令超时（毫秒）。 */
  timeoutMs?: number
}

/**
 * Workbench 侧运行时 SDK。
 *
 * 业务代码只依赖它，不直接接触 chrome.runtime 或 postMessage：
 * - 请求/响应：`client.call('PING', ...)` / `client.ping()`
 * - 事件：`client.on(type, handler)` / `client.onAny(handler)` / `client.subscribe([...])`
 * - 发布：`client.publish(type, payload)`
 */
export class RuntimeClient {
  readonly transport: Transport
  private readonly timeoutMs: number
  private readonly handlers = new Map<string, Set<(payload: unknown, event: EventEnvelope) => void>>()
  private readonly anyHandlers = new Set<(event: EventEnvelope) => void>()
  private readonly subscription = new Set<string>()
  private stopTransportEvents: (() => void) | null = null

  constructor(options: RuntimeClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 8000
    this.transport = options.transport ?? createDefaultTransport(this.timeoutMs)
  }

  /** 当前传输层名称，便于在 UI 上提示运行环境。 */
  get transportName(): string {
    return this.transport.name
  }

  /** 发送命令并等待结果；失败或超时抛出 BridgeError。 */
  async call<T extends CommandType>(type: T, payload: CommandPayloadMap[T]): Promise<CommandResultMap[T]> {
    const command = createCommand(type, payload)
    const response = await traceCommandCall('client', command, () =>
      this.withTimeout(this.transport.call(command), `命令 ${type} 超时`),
    )
    if (!response.ok) {
      throw new BridgeError(response.error?.code ?? 'INTERNAL', response.error?.message ?? '未知错误')
    }
    return response.result as CommandResultMap[T]
  }

  /** PING 便捷方法。 */
  async ping(nonce: string = genRequestId()): Promise<CommandResultMap['PING']> {
    return this.call('PING', { clientTime: Date.now(), nonce })
  }

  /** 订阅单个事件类型，返回取消订阅函数。 */
  on<T extends EventType>(
    eventType: T,
    handler: (payload: EventPayloadMap[T], event: EventEnvelope) => void,
  ): () => void {
    this.ensureEventPump()
    const wrapped = handler as (payload: unknown, event: EventEnvelope) => void
    const set = this.handlers.get(eventType) ?? new Set()
    set.add(wrapped)
    this.handlers.set(eventType, set)
    this.subscription.add(eventType)
    this.flushSubscription()
    return () => {
      set.delete(wrapped)
      if (set.size === 0) this.handlers.delete(eventType)
    }
  }

  /** 订阅所有事件，主要用于日志面板。 */
  onAny(handler: (event: EventEnvelope) => void): () => void {
    this.ensureEventPump()
    this.anyHandlers.add(handler)
    return () => this.anyHandlers.delete(handler)
  }

  /** 显式声明订阅的事件类型集合。 */
  subscribe(events: EventType[]): void {
    for (const event of events) this.subscription.add(event)
    this.flushSubscription()
  }

  /** 发布事件（经扩展广播给所有订阅者），返回投递数量。 */
  async publish(event: EventType, payload: unknown): Promise<CommandResultMap['PUBLISH']> {
    return this.call('PUBLISH', { event, payload })
  }

  /** 释放事件监听与底层传输资源。 */
  dispose(): void {
    this.stopTransportEvents?.()
    this.stopTransportEvents = null
    this.anyHandlers.clear()
    this.handlers.clear()
    this.transport.dispose()
  }

  private ensureEventPump(): void {
    if (this.stopTransportEvents) return
    this.stopTransportEvents = this.transport.onEvent((event) => this.dispatch(event))
  }

  private flushSubscription(): void {
    this.transport.setSubscription([...this.subscription])
  }

  private dispatch(event: EventEnvelope): void {
    for (const handler of this.anyHandlers) handler(event)
    const set = this.handlers.get(event.type)
    if (!set) return
    for (const handler of set) handler(event.payload, event)
  }

  private withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new BridgeError('TIMEOUT', message)), this.timeoutMs)
      promise.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error: unknown) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }
}

/** 创建 RuntimeClient 的便捷工厂。 */
export function createRuntimeClient(options?: RuntimeClientOptions): RuntimeClient {
  return new RuntimeClient(options)
}
