/**
 * P6 自动回复安全闸（纯逻辑）。
 *
 * 在「自动模式」真正发送前做最后一道限制：
 * - 全局开关关闭时不允许自动回复；
 * - 命中「转人工」关键词时不允许自动回复（降级为人工/建议）；
 * - 频率保护：窗口期内每会话自动回复数达到上限后不再自动发送。
 *
 * 本模块不做 IO、不发送消息；计数器只存内存（service worker 回收后归零，属可接受的保守行为）。
 */
import type { ReplySkipReason } from '../../../shared/types/reply'

/** 安全闸判定结果。 */
export interface AutoReplySafetyVerdict {
  allowed: boolean
  /** 不允许时的原因。 */
  reason?: Extract<ReplySkipReason, 'disabled' | 'handoff' | 'max-auto-replies'>
}

/** 安全闸策略。 */
export interface AutoReplySafetyPolicy {
  /** 是否启用自动回复（对应全局 enabled）。 */
  enabled: boolean
  /** 窗口期。 */
  windowMs: number
  /** 窗口期内每会话自动回复上限。 */
  maxAutoRepliesPerSession: number
  /** 命中即转人工的关键词（大小写不敏感的子串匹配）。 */
  handoffKeywords: readonly string[]
}

/** 判断内容是否命中转人工关键词。 */
export function matchesHandoff(content: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false
  const lower = content.toLowerCase()
  return keywords.some((keyword) => {
    const k = keyword.trim().toLowerCase()
    return k.length > 0 && lower.includes(k)
  })
}

/** 自动回复安全闸。 */
export class AutoReplySafetyGate {
  private readonly now: () => number
  private policy: AutoReplySafetyPolicy
  /** sessionId → 窗口内自动回复时间戳列表。 */
  private readonly records = new Map<string, number[]>()

  constructor(policy: Partial<AutoReplySafetyPolicy> = {}, now: () => number = () => Date.now()) {
    this.now = now
    this.policy = {
      enabled: policy.enabled ?? false,
      windowMs: policy.windowMs ?? 10 * 60 * 1000,
      maxAutoRepliesPerSession: policy.maxAutoRepliesPerSession ?? 5,
      handoffKeywords: policy.handoffKeywords ?? [],
    }
  }

  /** 更新策略（会即时生效；窗口/上限变化不清空已有计数）。 */
  setPolicy(policy: Partial<AutoReplySafetyPolicy>): void {
    this.policy = { ...this.policy, ...policy }
  }

  /** 判定当前是否允许自动回复。 */
  check(input: { sessionId: string; content: string }): AutoReplySafetyVerdict {
    if (!this.policy.enabled) return { allowed: false, reason: 'disabled' }
    if (matchesHandoff(input.content, this.policy.handoffKeywords)) {
      return { allowed: false, reason: 'handoff' }
    }
    if (this.countFor(input.sessionId) >= this.policy.maxAutoRepliesPerSession) {
      return { allowed: false, reason: 'max-auto-replies' }
    }
    return { allowed: true }
  }

  /** 记录一次自动回复（在真正发送前调用，避免并发绕过限制）。 */
  record(sessionId: string): void {
    const now = this.now()
    const list = this.records.get(sessionId) ?? []
    list.push(now)
    this.records.set(sessionId, list)
    this.prune(now)
  }

  /** 当前会话在窗口内的自动回复次数。 */
  countFor(sessionId: string): number {
    const now = this.now()
    const list = this.records.get(sessionId)
    if (!list) return 0
    const cutoff = now - this.policy.windowMs
    return list.filter((ts) => ts > cutoff).length
  }

  /** 清空计数（测试 / 手动恢复）。 */
  reset(): void {
    this.records.clear()
  }

  private prune(now: number): void {
    const cutoff = now - this.policy.windowMs
    for (const [sessionId, list] of this.records) {
      const kept = list.filter((ts) => ts > cutoff)
      if (kept.length === 0) this.records.delete(sessionId)
      else this.records.set(sessionId, kept)
    }
  }
}
