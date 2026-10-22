/**
 * 应用级启动初始化 Composable。
 *
 * 职责：
 * 1. 负责在扩展环境下单例持有 RuntimeClient 与 AppChatBootstrapController；
 * 2. 在应用挂载时触发 bootstrap()，通过并发锁避免重复准备与重复同步；
 * 3. 供会话页等业务页面订阅自动同步完成信号并刷新最新本地缓存。
 */

import { onMounted, readonly, shallowRef } from 'vue'
import { createRuntimeClient, type RuntimeClient } from '@fishops/bridge'
import {
  AppChatBootstrapController,
  type AppChatBootstrapState,
} from '../features/chat/app-chat-bootstrap-controller'
import { isExtensionContext } from './useBridgeStatus'

/** 模块级单例，跨组件挂载与热更新保持唯一。 */
let globalClient: RuntimeClient | null = null
let globalController: AppChatBootstrapController | null = null

/** 获取全局单例控制器。 */
export function getAppBootstrapController(): AppChatBootstrapController {
  if (!globalController) {
    const inExt = isExtensionContext()
    if (inExt && !globalClient) {
      // 首次加载与一次自动重载都包含页面加载、host 探测及连接等待。
      globalClient = createRuntimeClient({ timeoutMs: 90000 })
    }
    globalController = new AppChatBootstrapController({
      api: globalClient
        ? {
            call: (type, payload) => globalClient!.call(type, payload),
          }
        : null,
      inExtension: inExt,
    })
  }
  return globalController
}

/** 仅在测试环境用于重置单例。 */
export function resetGlobalBootstrapForTest(): void {
  if (globalController) {
    globalController.dispose()
    globalController = null
  }
  if (globalClient) {
    globalClient.dispose()
    globalClient = null
  }
}

/** 应用级自动初始化 Composable。 */
export function useAppBootstrap() {
  const controller = getAppBootstrapController()
  const state = shallowRef<AppChatBootstrapState>(controller.getState())

  controller.subscribe(() => {
    state.value = controller.getState()
  })

  onMounted(() => {
    void controller.bootstrap()
  })

  return {
    state: readonly(state),
    controller,
  }
}
