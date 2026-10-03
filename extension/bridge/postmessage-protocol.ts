/**
 * 页面侧（普通网页 / MAIN world）与 content script 之间的 postMessage 包裹协议。
 *
 * 用独立的 source 标识与其他脚本的 window 消息区分开，避免互相干扰。
 */
import { isBridgeMessage, type BridgeMessage } from '@fishops/shared'

/** 包裹信封的 source 标识。 */
export const PAGE_BRIDGE_SOURCE = 'fishops-workbench-bridge' as const

/** 页面 ↔ content script 的包裹信封。 */
export interface PageBridgeEnvelope {
  source: typeof PAGE_BRIDGE_SOURCE
  message: BridgeMessage
}

/** 包裹一条协议消息。 */
export function wrapPageMessage(message: BridgeMessage): PageBridgeEnvelope {
  return { source: PAGE_BRIDGE_SOURCE, message }
}

/** 校验并解包页面消息；非本桥消息返回 null。 */
export function unwrapPageMessage(value: unknown): PageBridgeEnvelope | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { source?: unknown; message?: unknown }
  if (candidate.source !== PAGE_BRIDGE_SOURCE) return null
  if (!isBridgeMessage(candidate.message)) return null
  return { source: PAGE_BRIDGE_SOURCE, message: candidate.message }
}
