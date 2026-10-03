/**
 * Vue Composable: 发布中心控制器适配（P8）。
 *
 * 通过 useBridgeController 把 PublishController 状态映射到 Vue 的响应式引用，
 * 并在组件生命周期中自动管理事件订阅与注销。
 */

import {
  PublishController,
  PUBLISH_EVENTS,
  type PublishState,
} from '../features/publish/publish-controller'
import { useBridgeController } from './useBridgeController'
import type { ShallowRef } from 'vue'

export function usePublish(): {
  state: ShallowRef<PublishState>
  controller: PublishController
  inExtension: boolean
} {
  return useBridgeController<PublishState, PublishController>({
    events: PUBLISH_EVENTS,
    timeoutMs: 30000,
    create: (api) => new PublishController({ api }),
  })
}
