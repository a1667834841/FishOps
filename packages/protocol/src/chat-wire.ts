import { isChatMessage, type ChatMessage } from './chat.ts'
import { isCursor, keys, object } from './index.ts'
import { isGapOccurrence, type GapOccurrence } from './chat-gap.ts'

/** 消息交付及落库确认；账号只用于匹配，host 仍须与当前 native 账号核对。 */
export type ChatWire =
  | { kind: 'chat-delivery'; accountId: string; message: ChatMessage }
  | { kind: 'chat-gap'; accountId: string; reason: 'OUTBOX_CAPACITY' | 'PAGE_GAP'; occurrence?: GapOccurrence }
  | { kind: 'chat-ack'; accountId: string; sourceId: string; eventSeq: string }

/** 双端严格验证，拒绝未知字段和伪造游标；不自动补齐消息内容。 */
export function isChatWire(value: unknown): value is ChatWire {
  if (!object(value)) return false
  const id = (v: unknown) => typeof v === 'string' && !!v.trim() && v.length <= 128
  if (!id(value.accountId)) return false
  if (value.kind === 'chat-gap') return keys(value, ['kind', 'accountId', 'reason', 'occurrence']) &&
    (value.reason === 'OUTBOX_CAPACITY' || value.reason === 'PAGE_GAP') &&
    (value.occurrence === undefined || (isGapOccurrence(value.occurrence) && value.occurrence.accountId === value.accountId && value.occurrence.reason === value.reason))
  if (value.kind === 'chat-delivery') return keys(value, ['kind', 'accountId', 'message']) && isChatMessage(value.message)
  return value.kind === 'chat-ack' && keys(value, ['kind', 'accountId', 'sourceId', 'eventSeq']) && id(value.sourceId) && isCursor(value.eventSeq) && value.eventSeq !== '0'
}
