import { onBeforeUnmount, onMounted, shallowRef, type ShallowRef } from 'vue'
import { createRuntimeClient, type RuntimeClient } from '@fishops/bridge'
import {
  CHAT_CENTER_EVENTS,
  ChatCenterController,
  type ChatCenterApi,
  type ChatCenterState,
} from '../features/chat/chat-center-controller'
import { isExtensionContext } from './useBridgeStatus'

/**
 * 同步命令会走「background → 闲鱼页面 MAIN world → LWP」，分页时可能超过默认 8 秒，
 * 因此本页面的 Bridge 单独放宽到 30 秒。超时只影响本次等待，不会取消 background 里的同步。
 */
const CHAT_CALL_TIMEOUT_MS = 30000

function createApi(client: RuntimeClient): ChatCenterApi {
  return {
    call: (type, payload) => client.call(type, payload),
    on: (type, handler) => client.on(type, (payload) => handler(payload)),
    resubscribe: () => client.subscribe([...CHAT_CENTER_EVENTS]),
  }
}

/**
 * 聊天中心页面的 Vue 适配层：
 * - 仅在扩展内页创建 Bridge 客户端（普通网页的 postMessage 通道不放行 CHAT_* 命令）；
 * - 页面卸载时同时释放控制器订阅与 Bridge（含事件长连接 Port），避免泄漏；
 * - 页面回到前台时重新声明订阅，应对 service worker 回收导致的 Port 断开。
 */
export function useChatCenter(): {
  state: ShallowRef<ChatCenterState>
  controller: ChatCenterController
} {
  const client = isExtensionContext() ? createRuntimeClient({ timeoutMs: CHAT_CALL_TIMEOUT_MS }) : null
  const controller = new ChatCenterController({ api: client ? createApi(client) : null })
  const state = shallowRef<ChatCenterState>(controller.getState())

  const stopState = controller.subscribe(() => {
    state.value = controller.getState()
  })

  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') controller.resubscribe()
  }

  onMounted(() => {
    controller.start()
    document.addEventListener('visibilitychange', onVisibility)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisibility)
    stopState()
    controller.dispose()
    client?.dispose()
  })

  return { state, controller }
}
