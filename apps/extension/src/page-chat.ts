import type { ChatMessage } from '../../../packages/protocol/src/chat.ts'
import type { GapOccurrence } from '../../../packages/protocol/src/chat-gap.ts'
import type { ChatSyncPageParams, ChatSyncPageResult } from '../../../packages/protocol/src/chat-sync.ts'
import { createChatReadTransport, type ChatReadSocket } from './chat-read-transport.ts'
import { createChatWriteTransport, type ChatWriteResult } from './chat-write-transport.ts'
import { normalizeChatSyncPage } from './chat-sync-normalizer.ts'
import { parseChatFrame } from './chat-parser.ts'
import { installChatSocketMonitor, type ChatSocketMonitorScope } from './chat-socket-monitor.ts'

/** 页面队列粗粒度状态；不暴露账号、正文、原始帧或凭据。syncRequired 在实例内只增不减。 */
export type PageChatStatus = { queued: number; bytes: number; syncRequired: boolean; disposed: boolean }
/** 被动消息队列与单页只读入口；drain 非破坏，持久保存成功后才可 ack。 */
export type PageChat = {
  /** 仅返回固定分类计数，不包含原帧、正文、账号或来源 ID。 */
  gapDiagnostics(): Record<string, number>
  /** 只返回当前账号观测代次内唯一 OPEN 连接，不创建或重连。 */
  getSocket(): ChatReadSocket | null
  /** 在已观察连接上读取并归一化单页；调用方必须持有文档执行锁。 */
  queryPage(params: ChatSyncPageParams, accountId: string, mid: string): Promise<ChatSyncPageResult>
  /** 在唯一已观察连接上发送一条文本；myId 始终来自当前页面账号。 */
  chatSend(params: { sessionId: string; receiverId: string; text: string }, accountId: string, mid: string): Promise<ChatWriteResult>
  peek(expectedAccountId: string, limit?: number): ChatMessage[]
  drain(expectedAccountId: string, limit?: number): ChatMessage[]
  ack(expectedAccountId: string, sourceIds: readonly string[]): number
  status(): PageChatStatus
  gapOccurrences(expectedAccountId: string): GapOccurrence[]
  requiresSync(expectedAccountId: string): boolean
  dispose(): void
}
type Entry = { account: string; message: ChatMessage; bytes: number; fingerprint: string }
const MAX_ITEMS = 1000, MAX_BYTES = 4 * 1024 * 1024
/** 页面与 collector 共用的单批缺口上限；超过后保留已有事实，不静默驱逐。 */
export const MAX_PAGE_GAP_OCCURRENCES = 32
const encoder = new TextEncoder()
const error = (code: string) => Object.assign(new Error('页面聊天队列不可用或绑定范围已变化'), { code })

/**
 * 创建页面内被动队列与只读入口；初始化只包装构造器，不创建连接、不发送请求。
 * readAccountId 必须同步返回当前可信账号；每条消息固定接收账号，切换后不重标。
 * 队列只保证当前页面实例内的 peek/ack，页面销毁前尚未持久化的数据不保证恢复。
 */
export function createPageChat(scope: ChatSocketMonitorScope, readAccountId: () => string | null, onAvailable: () => void = () => {}): PageChat {
  const queue = new Map<string, Entry>()
  let bytes = 0, syncRequired = false, disposed = false
  const sockets = new Set<ChatReadSocket>()
  let observedAccount: string | null = null
  /** 页面缺口事实：每账号保留有界 FIFO，不能只留最后一条而静默丢掉前一次丢失。 */
  const gaps = new Map<string, GapOccurrence[]>()
  const gapCounts: Record<string, number> = Object.create(null)
  function countGap(reason: string): void {
    // 诊断不能随未知结构组合无限增长；为溢出分类预留一个槽位。
    const key = Object.hasOwn(gapCounts, reason) || Object.keys(gapCounts).length < 63 ? reason : 'DIAGNOSTIC_OVERFLOW'
    gapCounts[key] = Math.min(Number.MAX_SAFE_INTEGER, (gapCounts[key] ?? 0) + 1)
  }
  function account(): string | null {
    try {
      const value = readAccountId()
      const current = typeof value === 'string' && value.trim().length > 0 && value.length <= 128 ? value : null
      if (current !== observedAccount) { sockets.clear(); observedAccount = current }
      return current
    } catch { sockets.clear(); observedAccount = null; syncRequired = true; return null }
  }
  function getSocket(): ChatReadSocket | null {
    if (disposed || !account()) return null
    const open = [...sockets].filter(socket => socket.readyState === 1)
    return open.length === 1 ? open[0] : null
  }
  const transport = createChatReadTransport({ getSocket, readAccountId: account })
  const writeTransport = createChatWriteTransport({ readAccountId: account })
  function verify(expected: string): void {
    if (disposed) throw error('PAGE_NOT_READY')
    if (typeof expected !== 'string' || !expected.trim() || expected.length > 128) throw error('BAD_REQUEST')
    if (account() !== expected) throw error('ACCOUNT_CHANGED')
  }
  function gap(reason: string): void {
    syncRequired = true
    countGap(reason)
    // 匿名事件不能归属给下一个登录账号；仍保留粗粒度告警。
    if (observedAccount) {
      const occurrences = gaps.get(observedAccount) ?? []
      const previous = occurrences.at(-1)
      const generation = (previous?.generation ?? 0) + 1
      if (Number.isSafeInteger(generation) && occurrences.length < MAX_PAGE_GAP_OCCURRENCES) {
        occurrences.push({
          accountId: observedAccount, reason: 'PAGE_GAP', occurrenceId: crypto.randomUUID(), generation, scope: { scope: 'unknown' },
        })
        gaps.set(observedAccount, occurrences)
      }
    }
    try { onAvailable() } catch {}
  }
  const monitor = installChatSocketMonitor(scope, {
    onDropped(reason) { if (!disposed) { account(); gap(`MONITOR_${reason}`) } },
    onOpen(socket) { if (account()) sockets.add(socket) },
    onClose(socket) { account(); sockets.delete(socket) },
    onMessage(raw) {
      if (disposed) return
      const receivedAccount = account()
      if (!receivedAccount) { gap('ACCOUNT_UNAVAILABLE'); return }
      const result = parseChatFrame(raw, stage => {
        const key = `DETAIL_${stage}`
        countGap(key)
      })
      if (result.kind === 'error') { gap(`PARSE_${result.code}`); return }
      if (result.kind === 'ignored') return
      // 先检查整个批次，容量或冲突失败时不部分入队，不淘汰未确认消息。
      const additions = new Map<string, Entry>()
      let addedBytes = 0
      for (const message of result.messages) {
        const key = JSON.stringify([receivedAccount, message.sourceId])
        const fingerprint = JSON.stringify(message)
        const previous = queue.get(key) ?? additions.get(key)
        if (previous) {
          if (previous.fingerprint !== fingerprint) { gap('SOURCE_CONFLICT'); return }
          continue
        }
        const size = encoder.encode(JSON.stringify({ account: receivedAccount, message })).byteLength
        additions.set(key, { account: receivedAccount, message, bytes: size, fingerprint })
        addedBytes += size
      }
      if (queue.size + additions.size > MAX_ITEMS || bytes + addedBytes > MAX_BYTES) { gap('QUEUE_CAPACITY'); return }
      for (const [key, entry] of additions) queue.set(key, entry)
      bytes += addedBytes
      try { onAvailable() } catch {}
    },
  })
  function peek(expectedAccountId: string, limit = 100): ChatMessage[] {
    verify(expectedAccountId)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw error('BAD_REQUEST')
    const messages: ChatMessage[] = []
    for (const entry of queue.values()) {
      if (entry.account !== expectedAccountId) continue
      messages.push({ ...entry.message })
      if (messages.length === limit) break
    }
    return messages
  }
  return {
    gapDiagnostics: () => ({ ...gapCounts }),
    getSocket,
    async queryPage(params, accountId, mid) {
      verify(accountId)
      const body = await transport.query(params, accountId, mid)
      verify(accountId)
      return normalizeChatSyncPage(params, body, accountId)
    },
    async chatSend(params, accountId, mid) {
      verify(accountId)
      const socket = getSocket()
      if (!socket) throw error('PAGE_NOT_READY')
      const body = await writeTransport.send({ ...params, myId: accountId }, accountId, socket)
      verify(accountId)
      return body
    },
    peek,
    gapOccurrences(expectedAccountId) {
      verify(expectedAccountId)
      return structuredClone(gaps.get(expectedAccountId) ?? [])
    },
    requiresSync(expectedAccountId) {
      verify(expectedAccountId)
      return Boolean(gaps.get(expectedAccountId)?.length)
    },
    drain: peek,
    ack(expectedAccountId, sourceIds) {
      verify(expectedAccountId)
      if (!Array.isArray(sourceIds) || sourceIds.length > 100 || sourceIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128)) throw error('BAD_REQUEST')
      let removed = 0
      for (const id of new Set(sourceIds)) {
        const key = JSON.stringify([expectedAccountId, id]), entry = queue.get(key)
        if (!entry) continue
        bytes -= entry.bytes; queue.delete(key); removed++
      }
      return removed
    },
    status: () => ({ queued: queue.size, bytes, syncRequired, disposed }),
    dispose() {
      if (disposed) return
      disposed = true
      if (queue.size) syncRequired = true
      transport.dispose(); writeTransport.dispose(); sockets.clear(); monitor.dispose(); queue.clear(); bytes = 0
    },
  }
}
