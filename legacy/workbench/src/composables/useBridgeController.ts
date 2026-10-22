import { onBeforeUnmount, onMounted, shallowRef, type ShallowRef } from 'vue'
import { createRuntimeClient, type RuntimeClient } from '@fishops/bridge'
import type { EventType } from '@fishops/shared'
import { createBridgeApi, type BridgeApi } from '../features/shared/bridge-api'
import { isExtensionContext } from './useBridgeStatus'

/** 页面控制器需要具备的最小生命周期接口。 */
export interface PageController<S> {
  getState(): S
  subscribe(listener: () => void): () => void
  start(): void
  resubscribe(): void
  dispose(): void
}

export interface BridgeControllerConfig<S, C extends PageController<S>> {
  /** 页面订阅的事件类型；页面回到前台时会重新声明。 */
  events: readonly EventType[]
  /** 单次命令等待上限（毫秒）。发送、分析等较慢的操作需要放宽。 */
  timeoutMs?: number
  /** 用 Bridge（非扩展内页为 null）创建控制器。 */
  create: (api: BridgeApi | null) => C
}

/**
 * 通用 Vue 适配层：
 * - 仅在扩展内页创建 RuntimeClient（普通网页的 postMessage 通道不放行这些命令，也不应发送）；
 * - 页面卸载时同时释放控制器订阅与 Bridge（含事件长连接 Port），避免泄漏与重复订阅；
 * - 页面回到前台时重新声明订阅，应对 service worker 回收导致的 Port 断开。
 */
export function useBridgeController<S, C extends PageController<S>>(
  config: BridgeControllerConfig<S, C>,
): { state: ShallowRef<S>; controller: C; inExtension: boolean } {
  const inExtension = isExtensionContext()
  const timeoutMs = config.timeoutMs ?? 15000
  const client: RuntimeClient | null = inExtension ? createRuntimeClient({ timeoutMs: timeoutMs + 5000 }) : null
  const api = client ? createBridgeApi(client, { events: config.events, timeoutMs }) : null
  const controller = config.create(api)
  const state = shallowRef(controller.getState()) as ShallowRef<S>

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

  return { state, controller, inExtension }
}
