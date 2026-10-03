import { readonly, ref } from 'vue'

/**
 * Bridge 连接状态的共享出口。
 * BridgeDemo（开发诊断）是唯一的写入方，顶部栏、设置页等只读展示。
 */
export type BridgeState = 'unavailable' | 'idle' | 'checking' | 'online' | 'error'

export interface BridgeStatusInfo {
  state: BridgeState
  /** 最近一次 PING 往返耗时（毫秒） */
  rtt: number | null
  /** 最近一次错误信息 */
  message: string | null
}

/** 当前页面是否运行在扩展内页（存在 chrome.runtime.id）。 */
export function isExtensionContext(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.runtime) && Boolean(chrome.runtime.id)
}

const status = ref<BridgeStatusInfo>({
  state: isExtensionContext() ? 'idle' : 'unavailable',
  rtt: null,
  message: null,
})

export function setBridgeStatus(next: Partial<BridgeStatusInfo> & Pick<BridgeStatusInfo, 'state'>): void {
  status.value = { ...status.value, ...next }
}

export function useBridgeStatus() {
  return { status: readonly(status), inExtension: isExtensionContext() }
}
