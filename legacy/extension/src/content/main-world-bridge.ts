/**
 * MAIN world 注入脚本：在页面上下文暴露一个最小 Bridge 客户端。
 *
 * MAIN world 没有 chrome.runtime，因此所有消息经 window.postMessage 交给
 * ISOLATED world 的 isolated-bridge，再转发到 background。
 * P1 仅提供 call/emit/ping 骨架，供 P3/P4 注入闲鱼页面逻辑时复用。
 */
import {
  createCommand,
  createEvent,
  genRequestId,
  isResponseEnvelope,
  type CommandPayloadMap,
  type CommandResultMap,
  type CommandType,
  type EventType,
  type ResponseEnvelope,
} from '@fishops/shared'
import { unwrapPageMessage, wrapPageMessage } from '../../bridge/postmessage-protocol'

const LOG_PREFIX = '[FishOps:Bridge:MAIN]'
const TIMEOUT_MS = 8000

interface Pending {
  resolve: (response: ResponseEnvelope) => void
  reject: (error: unknown) => void
  timer: number
}

const pending = new Map<string, Pending>()

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return
  const envelope = unwrapPageMessage(event.data)
  if (!envelope) return
  if (!isResponseEnvelope(envelope.message)) return

  const entry = pending.get(envelope.message.requestId)
  if (!entry) return
  window.clearTimeout(entry.timer)
  pending.delete(envelope.message.requestId)
  entry.resolve(envelope.message)
})

/** 发送命令并等待 background 响应。 */
function call<T extends CommandType>(
  type: T,
  payload: CommandPayloadMap[T],
): Promise<CommandResultMap[T]> {
  return new Promise<CommandResultMap[T]>((resolve, reject) => {
    const command = createCommand(type, payload)
    const timer = window.setTimeout(() => {
      pending.delete(command.requestId)
      reject(new Error(`[FishOps] 命令 ${type} 超时`))
    }, TIMEOUT_MS)
    pending.set(command.requestId, {
      resolve: (response) => resolve(response.result as CommandResultMap[T]),
      reject,
      timer,
    })
    window.postMessage(wrapPageMessage(command), window.location.origin)
  })
}

/** 向 background 单向上报事件（P1 预留）。 */
function emit(type: EventType, payload: unknown): void {
  window.postMessage(wrapPageMessage(createEvent(type, payload)), window.location.origin)
}

const bridge = {
  call,
  emit,
  /** 便捷连通性探测。 */
  ping: () => call('PING', { clientTime: Date.now(), nonce: genRequestId() }),
}

declare global {
  interface Window {
    __FISHOPS_MAIN_BRIDGE__?: typeof bridge
  }
}

window.__FISHOPS_MAIN_BRIDGE__ = bridge

console.info(LOG_PREFIX, 'main world bridge 已加载')
