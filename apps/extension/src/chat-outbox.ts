import { isChatMessage, type ChatMessage } from '../../../packages/protocol/src/chat.ts'
import { isGapOccurrence, type GapOccurrence, type GapReason, type GapScope } from '../../../packages/protocol/src/chat-gap.ts'

/** outbox 存储适配器；生产环境必须使用持久存储，不允许以内存替代。 */
export interface OutboxStorage {
  read(): Promise<unknown>
  write(value: OutboxState): Promise<void>
}
export type OutboxEntry = { accountId: string; sourceId: string; payload: unknown }
/**
 * 持久缺口 occurrence：复用协议类型。来源代次由本 outbox 按（账号,来源）线分配，
 * 不属于该线且无 occurrence 身份的旧 markGap 通知不会写入此数组。
 */
export type OutboxOccurrence = GapOccurrence
/**
 * 持久 outbox 状态。`gaps`/`pageGaps` 是 v1 旧账号级标记，保持兼容且不删除；
 * `occurrences` 为新增的可持久 occurrence 元数据（可选，旧状态缺失即为无）。
 */
type CapacityLoss = { accountId: string; sourceId: string; fingerprint: string; occurrenceId: string }
export type OutboxState = { version: 1; entries: OutboxEntry[]; gaps: string[]; pageGaps?: string[]; occurrences?: OutboxOccurrence[]; losses?: CapacityLoss[]; legacyGaps?: string[] }
export type OutboxSnapshot = { entries: OutboxEntry[]; syncRequired: boolean; gapReason?: GapReason }
const MAX_ENTRIES = 1000
const MAX_BYTES = 4 * 1024 * 1024
/** occurrence 元数据条数上限；与字节上限共同保证缺口状态有界。 */
export const MAX_OCCURRENCES = 512
/** 容量丢失时为新 occurrence 预留的空间，避免补记元数据时把状态顶出字节上限。 */
const GAP_RESERVE = 32768
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 128
const copy = <T>(value: T): T => structuredClone(value)
const validEntry = (entry: OutboxEntry) => entry && id(entry.accountId) && id(entry.sourceId) &&
  isChatMessage(entry.payload) && entry.sourceId === entry.payload.sourceId
const sameScope = (left: GapScope, right: GapScope) => left.scope === right.scope &&
  (left.scope !== 'session' || right.scope !== 'session' || left.sessionId === right.sessionId)
/** 同 occurrence 身份（账号/来源/occurrenceId）且内容（范围与代次）一致才算重投。 */
const sameOccurrence = (left: OutboxOccurrence, right: OutboxOccurrence) => left.accountId === right.accountId &&
  left.reason === right.reason && left.occurrenceId === right.occurrenceId && left.generation === right.generation && sameScope(left.scope, right.scope)
// 固定字段顺序比较规范内容，不把对象键插入顺序当作消息冲突。
const fingerprint = (m: ChatMessage) => JSON.stringify([
  m.sourceId, m.sessionId, m.senderId, m.text, m.sentAt, m.itemId ?? null, m.peerUserId ?? null,
])
/** 丢失索引只保存摘要，避免大正文耗尽为缺口预留的空间。 */
const lossFingerprint = async (message: ChatMessage) => Array.from(new Uint8Array(
  await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint(message))),
), byte => byte.toString(16).padStart(2, '0')).join('')

/** 串行持久队列；所有成功返回的状态变更都已经写入存储。 */
export class ChatOutbox {
  private queue: Promise<unknown> = Promise.resolve()
  private state: OutboxState | null = null
  private storage: OutboxStorage
  constructor(storage: OutboxStorage) { this.storage = storage }

  private run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action)
    this.queue = result.catch(() => {})
    return result
  }

  private async load(): Promise<OutboxState> {
    if (this.state) return this.state
    const raw = await this.storage.read()
    if (raw === undefined || raw === null) return this.state = { version: 1, entries: [], gaps: [], legacyGaps: [] }
    const value = raw as OutboxState
    if (typeof value !== 'object' || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.entries) || !Array.isArray(value.gaps) ||
      !value.gaps.every(id) || (value.pageGaps !== undefined && (!Array.isArray(value.pageGaps) || !value.pageGaps.every(accountId => id(accountId) && value.gaps.includes(accountId)))) || value.entries.some(entry => !validEntry(entry)) ||
      bytes(value) > MAX_BYTES || value.entries.length > MAX_ENTRIES) throw new Error('OUTBOX_INVALID')
    const seen = new Set<string>()
    if (value.legacyGaps !== undefined && (!Array.isArray(value.legacyGaps) || !value.legacyGaps.every(accountId => id(accountId) && value.gaps.includes(accountId)))) throw new Error('OUTBOX_INVALID')
    const occurrences = value.occurrences ?? []
    if (!Array.isArray(occurrences) || occurrences.length > MAX_OCCURRENCES) throw new Error('OUTBOX_INVALID')
    const occurrenceKeys = new Set<string>()
    for (const occurrence of occurrences) {
      if (!isGapOccurrence(occurrence) || !value.gaps.includes(occurrence.accountId)) throw new Error('OUTBOX_INVALID')
      const key = JSON.stringify([occurrence.accountId, occurrence.reason, occurrence.occurrenceId])
      if (occurrenceKeys.has(key)) throw new Error('OUTBOX_INVALID')
      occurrenceKeys.add(key)
    }
    if (value.losses !== undefined) {
      if (!Array.isArray(value.losses) || value.losses.length > MAX_OCCURRENCES) throw new Error('OUTBOX_INVALID')
      const losses = new Set<string>()
      for (const loss of value.losses) {
        if (!loss || !id(loss.accountId) || !id(loss.sourceId) || typeof loss.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(loss.fingerprint) ||
          !occurrences.some(item => item.accountId === loss.accountId && item.reason === 'OUTBOX_CAPACITY' && item.occurrenceId === loss.occurrenceId)) throw new Error('OUTBOX_INVALID')
        const key = JSON.stringify([loss.accountId, loss.sourceId])
        if (losses.has(key)) throw new Error('OUTBOX_INVALID')
        losses.add(key)
      }
    }
    for (const entry of value.entries) {
      const key = JSON.stringify([entry.accountId, entry.sourceId])
      if (seen.has(key)) throw new Error('OUTBOX_INVALID')
      seen.add(key)
    }
    this.state = copy(value)
    // 无来源身份的旧状态不能凭新 occurrence 猜测已被覆盖；只迁移为不可自动清除的旧标记。
    this.state.legacyGaps ??= [...value.gaps]
    return this.state
  }

  private async save(next: OutboxState): Promise<void> {
    await this.storage.write(copy(next))
    this.state = next
  }

  /** 显式稳定事件先持久化；重投不写入，冲突或容量不足保留原状态。 */
  recordGap(occurrence: GapOccurrence): Promise<'stored' | 'duplicate'> {
    if (!isGapOccurrence(occurrence)) return Promise.reject(new Error('OUTBOX_INPUT'))
    const input = copy(occurrence)
    return this.run(async () => {
      const state = await this.load()
      const existing = state.occurrences?.find(item => item.accountId === input.accountId && item.reason === input.reason && item.occurrenceId === input.occurrenceId)
      if (existing) {
        if (!sameOccurrence(existing, input)) throw new Error('OUTBOX_CONFLICT')
        return 'duplicate'
      }
      const next = copy(state)
      next.occurrences ??= []
      if (next.occurrences.length >= MAX_OCCURRENCES) throw new Error('OUTBOX_GAP_CAPACITY')
      next.occurrences.push(input)
      if (!next.gaps.includes(input.accountId)) next.gaps.push(input.accountId)
      if (input.reason === 'PAGE_GAP') {
        next.pageGaps ??= []
        if (!next.pageGaps.includes(input.accountId)) next.pageGaps.push(input.accountId)
      }
      if (bytes(next) > MAX_BYTES) throw new Error('OUTBOX_GAP_CAPACITY')
      await this.save(next)
      return 'stored'
    })
  }

  /** 返回稳定事件副本，重复读取或重建不产生新 ID、不推进代次。 */
  gapOccurrences(accountId: string): Promise<OutboxOccurrence[]> {
    return this.run(async () => {
      if (!id(accountId)) throw new Error('OUTBOX_INPUT')
      return copy((await this.load()).occurrences?.filter(item => item.accountId === accountId) ?? [])
    })
  }

  /** 只有无稳定身份的旧缺口才需要发送兼容帧；新事件不得制造第二份旧标记。 */
  legacyGapRequired(accountId: string): Promise<boolean> {
    return this.run(async () => {
      if (!id(accountId)) throw new Error('OUTBOX_INPUT')
      return (await this.load()).legacyGaps?.includes(accountId) ?? false
    })
  }

  /** 先持久化再返回；容量不足时保存缺口标记，不驱逐未确认消息。 */
  enqueue(entry: OutboxEntry): Promise<'stored' | 'duplicate' | 'gap'> {
    return this.run(async () => {
      if (!validEntry(entry)) throw new Error('OUTBOX_INPUT')
      const state = await this.load()
      const lost = state.losses?.find(item => item.accountId === entry.accountId && item.sourceId === entry.sourceId)
      if (lost) {
        if (lost.fingerprint !== await lossFingerprint(entry.payload as ChatMessage)) throw new Error('OUTBOX_CONFLICT')
        return 'gap'
      }
      const previous = state.entries.find(item => item.accountId === entry.accountId && item.sourceId === entry.sourceId)
      if (previous) {
        if (fingerprint(previous.payload as ChatMessage) !== fingerprint(entry.payload as ChatMessage)) throw new Error('OUTBOX_CONFLICT')
        return 'duplicate'
      }
      const next = copy(state)
      next.entries.push(copy(entry))
      if (next.entries.length > MAX_ENTRIES || bytes(next) > MAX_BYTES - GAP_RESERVE) {
        const gap = copy(state)
        gap.occurrences ??= []
        gap.losses ??= []
        if (gap.occurrences.length >= MAX_OCCURRENCES || gap.losses.length >= MAX_OCCURRENCES) throw new Error('OUTBOX_GAP_CAPACITY')
        const generation = gap.occurrences.filter(item => item.accountId === entry.accountId && item.reason === 'OUTBOX_CAPACITY')
          .reduce((maximum, item) => Math.max(maximum, item.generation), 0) + 1
        if (!Number.isSafeInteger(generation)) throw new Error('OUTBOX_GAP_CAPACITY')
        // 丢失身份与缺口原子保存；重投和进程重建都不能把同一丢失解释为新代次。
        const occurrenceId = crypto.randomUUID()
        gap.occurrences.push({ accountId: entry.accountId, reason: 'OUTBOX_CAPACITY', occurrenceId, generation,
          scope: { scope: 'session', sessionId: (entry.payload as ChatMessage).sessionId } })
        gap.losses.push({ accountId: entry.accountId, sourceId: entry.sourceId, fingerprint: await lossFingerprint(entry.payload as ChatMessage), occurrenceId })
        if (!gap.gaps.includes(entry.accountId)) gap.gaps.push(entry.accountId)
        if (bytes(gap) > MAX_BYTES) throw new Error('OUTBOX_GAP_CAPACITY')
        await this.save(gap)
        return 'gap'
      }
      await this.save(next)
      return 'stored'
    })
  }

  /** ACK 必须携带原账号；旧连接不能按来源 ID 删除其他账号的消息。 */
  acknowledge(accountId: string, sourceId: string): Promise<void> {
    return this.run(async () => {
      if (!id(accountId) || !id(sourceId)) throw new Error('OUTBOX_INPUT')
      const state = await this.load()
      const next = copy(state)
      next.entries = next.entries.filter(entry => entry.accountId !== accountId || entry.sourceId !== sourceId)
      if (next.entries.length !== state.entries.length) await this.save(next)
    })
  }

  /** 持久记录页面观察缺口；兼容旧 gaps 格式，不删除任何未确认消息或已有缺口。 */
  markGap(accountId: string): Promise<void> {
    return this.run(async () => {
      if (!id(accountId)) throw new Error('OUTBOX_INPUT')
      const next = copy(await this.load())
      if (!next.gaps.includes(accountId)) next.gaps.push(accountId)
      next.legacyGaps ??= []
      if (!next.legacyGaps.includes(accountId)) next.legacyGaps.push(accountId)
      next.pageGaps ??= []
      if (!next.pageGaps.includes(accountId)) next.pageGaps.push(accountId)
      if (bytes(next) > MAX_BYTES) throw new Error('OUTBOX_GAP_CAPACITY')
      await this.save(next)
    })
  }

  /** 返回账号隔离的投递快照；调用者不得将其重新归属到当前账号。 */
  snapshot(accountId: string): Promise<{ entries: OutboxEntry[]; syncRequired: boolean; gapReason?: 'PAGE_GAP' | 'OUTBOX_CAPACITY' }> {
    return this.run(async () => {
      if (!id(accountId)) throw new Error('OUTBOX_INPUT')
      const state = await this.load()
      const syncRequired = state.gaps.includes(accountId)
      return copy({ entries: state.entries.filter(entry => entry.accountId === accountId), syncRequired,
        ...(syncRequired ? { gapReason: state.pageGaps?.includes(accountId) ? 'PAGE_GAP' as const : 'OUTBOX_CAPACITY' as const } : {}) })
    })
  }
}
