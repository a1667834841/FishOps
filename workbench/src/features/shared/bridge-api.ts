/**
 * 控制器依赖的最小 Bridge 接口，以及把 `RuntimeClient` 适配成该接口的工厂。
 *
 * 为什么不直接调用 `client.call`：
 * 它抛出的 `BridgeError` 会丢掉 `PLATFORM_ERROR` 的 `category` / `retCode`，
 * 这里改为直接走 `client.transport.call` 并自行处理超时，保留完整的协议错误。
 * 本文件不依赖 Vue / chrome，可在 Node 下测试。
 */
import {
  createCommand,
  traceCommandCall,
  type CommandEnvelope,
  type CommandPayloadMap,
  type CommandResultMap,
  type CommandType,
  type EventPayloadMap,
  type EventType,
  type ResponseEnvelope,
} from '@fishops/shared'
import { CommandError } from './error-format'

/** 控制器使用的 Bridge 抽象；生产由 RuntimeClient 适配，测试用 mock。 */
export interface BridgeApi {
  call<T extends CommandType>(type: T, payload: CommandPayloadMap[T]): Promise<CommandResultMap[T]>
  /** 订阅事件，返回取消订阅函数。 */
  on<T extends EventType>(type: T, handler: (payload: EventPayloadMap[T]) => void): () => void
  /** 重新声明订阅（Port 因 service worker 回收断开后用于重连）；必须幂等。 */
  resubscribe(): void
}

/** `RuntimeClient` 中本适配层用到的最小子集（便于测试替身）。 */
export interface RuntimeClientLike {
  readonly transport: { call(command: CommandEnvelope): Promise<ResponseEnvelope> }
  on<T extends EventType>(type: T, handler: (payload: EventPayloadMap[T]) => void): () => void
  subscribe(events: EventType[]): void
}

/** 给 Promise 加超时；超时仅停止等待，不会取消 background 里已经开始的操作。 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new CommandError('TIMEOUT', `命令 ${label} 等待超时`)), ms)
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

/**
 * 适配 RuntimeClient。
 *
 * @param events 页面关心的事件类型，`resubscribe` 时重新声明。
 * @param timeoutMs 单次命令的等待上限。
 */
export function createBridgeApi(
  client: RuntimeClientLike,
  options: { events: readonly EventType[]; timeoutMs: number },
): BridgeApi {
  return {
    async call(type, payload) {
      const command = createCommand(type, payload)
      const response = await traceCommandCall('client', command, () =>
        withTimeout(client.transport.call(command), options.timeoutMs, type),
      )
      if (!response.ok) {
        const error = response.error
        throw new CommandError(
          error?.code ?? 'INTERNAL',
          error?.message ?? '未知错误',
          error?.category,
          error?.retCode,
          error?.businessCode,
        )
      }
      return response.result as CommandResultMap[typeof type]
    },
    on: (type, handler) => client.on(type, (payload) => handler(payload)),
    resubscribe: () => client.subscribe([...options.events]),
  }
}
