/**
 * P6 回复规则引擎（纯逻辑，不发送、不调用 AI）。
 *
 * 迁移自 `chat` 分支 `inject/handlers/auto-reply-processor.js` 的纯逻辑部分：
 * 优先级排序、正则（i）匹配、商品绑定、cooldown、delay、blacklist、
 * processedMessageIds 防重、recentReplySessions 会话级冷却、自己消息过滤、AI 暂停。
 *
 * 关键设计：
 * - {@link ReplyEngine.decide} 是**只读**判定，不消费冷却 / 防重（便于反复生成建议）；
 * - {@link ReplyEngine.commit} 才记账（消息防重、规则冷却、会话冷却、安全闸计数），在真正发送前调用；
 * - 默认模式为 `suggest`（建议 / 人工安全模式），`auto` 模式下还会经过 {@link AutoReplySafetyGate} 复核，
 *   被拦截时自动降级为建议，绝不隐式发送。
 * - 本模块不持有 socket / 不调用 AI / 不打日志中的正文。
 */
import { DEFAULT_AI_MAX_HISTORY, DEFAULT_REPLY_GLOBAL_CONFIG } from '../../../shared/types/reply'
import type {
  AiPauseStatus,
  ReplyDecision,
  ReplyGlobalConfig,
  ReplyIncomingMessage,
  ReplyMode,
  ReplyRule,
  ReplySkipReason,
} from '../../../shared/types/reply'
import { AutoReplySafetyGate } from './reply-safety'

/** 已处理消息 ID 的保留上限（与旧实现一致）。 */
const PROCESSED_LIMIT = 200

/**
 * 无规则命中时「默认 AI 建议」使用的哨兵规则 ID。
 * 仅用于标识建议来源（`ReplySuggestion.ruleId`），不是用户 ID，也不参与任何比对。
 */
export const DEFAULT_AI_RULE_ID = 'default-ai'

/** 引擎依赖。 */
export interface ReplyEngineOptions {
  /** 时间源，便于测试。 */
  now?: () => number
  /** 全局配置；缺省 {@link DEFAULT_REPLY_GLOBAL_CONFIG}。 */
  config?: ReplyGlobalConfig
  /** 规则列表。 */
  rules?: ReplyRule[]
  /** 当前账号用户 ID，用于自己消息过滤。 */
  myId?: string
  /** 自动回复安全闸；缺省内部创建一个。 */
  safety?: AutoReplySafetyGate
}

/** decide 的可选行为。 */
export interface ReplyDecideOptions {
  /**
   * 是否遵循 AI 暂停。用户显式请求建议（CHAT_GET_REPLY_SUGGESTION）可传 false；
   * 自动触发必须保持 true。
   */
  respectPause?: boolean
  /** 覆盖模式（建议请求固定用 `suggest`）。缺省使用全局配置的 mode。 */
  mode?: ReplyMode
  /**
   * 是否忽略全局自动回复总开关（`enabled`）。
   *
   * 仅用于**用户显式请求建议**（`CHAT_GET_REPLY_SUGGESTION`）：总开关只管自动发送，
   * 不应阻断人工主动要建议。自动回复路径（`handleIncomingMessage`）必须保持 false。
   */
  ignoreGlobalEnabled?: boolean
  /**
   * 无规则命中时是否回退到「默认 AI 建议」。
   *
   * 仅用于用户显式请求建议且 AI 已配置时；回退决策固定为 `suggest`，**绝不自动发送**。
   */
  fallbackToAi?: boolean
}

/** 回复规则引擎。 */
export class ReplyEngine {
  private readonly now: () => number
  private readonly safety: AutoReplySafetyGate
  private rules: ReplyRule[]
  private config: ReplyGlobalConfig
  private myId: string
  /** 正则缓存：pattern → RegExp（编译失败为 null）。 */
  private readonly regexCache = new Map<string, RegExp | null>()
  private readonly processedMessageIds = new Set<string>()
  /** `${senderId}_${ruleId}` → 上次回复时间。 */
  private readonly lastReplyTime = new Map<string, number>()
  /** sessionId → 上次回复时间（防 AI 循环）。 */
  private readonly recentReplySessions = new Map<string, number>()
  private pausedUntil = 0
  private pauseReason: string | null = null

  constructor(options: ReplyEngineOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.rules = options.rules ? [...options.rules] : []
    this.config = options.config ?? { ...DEFAULT_REPLY_GLOBAL_CONFIG }
    this.myId = options.myId ?? ''
    this.safety = options.safety ?? new AutoReplySafetyGate({}, this.now)
    this.syncSafetyPolicy()
  }

  // ---------------- 配置 ----------------

  /** 设置规则列表。 */
  setRules(rules: readonly ReplyRule[]): void {
    this.rules = [...rules]
  }

  /** 读取规则列表（副本）。 */
  getRules(): ReplyRule[] {
    return this.rules.map((rule) => ({ ...rule }))
  }

  /** 设置全局配置。 */
  setGlobalConfig(config: ReplyGlobalConfig): void {
    this.config = { ...config }
    this.syncSafetyPolicy()
  }

  /** 读取全局配置（副本）。 */
  getGlobalConfig(): ReplyGlobalConfig {
    return { ...this.config, blacklist: [...this.config.blacklist], handoffKeywords: [...this.config.handoffKeywords] }
  }

  /** 设置当前用户 ID。 */
  setMyId(myId: string): void {
    this.myId = myId
  }

  /** 已处理消息数（诊断）。 */
  get processedCount(): number {
    return this.processedMessageIds.size
  }

  // ---------------- AI 暂停 ----------------

  /** 当前 AI 暂停状态（过期自动恢复）。 */
  getAiPauseStatus(): AiPauseStatus {
    if (this.pausedUntil > 0 && this.now() >= this.pausedUntil) {
      this.pausedUntil = 0
      this.pauseReason = null
    }
    return { paused: this.pausedUntil > 0, pausedUntil: this.pausedUntil, reason: this.pausedUntil > 0 ? this.pauseReason : null }
  }

  /** 暂停 AI 自动回复；durationMs 缺省使用全局 `aiPauseDurationMs`。 */
  pauseAi(durationMs?: number, reason = 'manual'): AiPauseStatus {
    const duration = durationMs ?? this.config.aiPauseDurationMs
    this.pausedUntil = this.now() + duration
    this.pauseReason = reason
    return this.getAiPauseStatus()
  }

  /** 恢复 AI 自动回复。 */
  resumeAi(): AiPauseStatus {
    this.pausedUntil = 0
    this.pauseReason = null
    return this.getAiPauseStatus()
  }

  /**
   * 处理一条消息以判断是否需要触发 AI 暂停。
   * 触发条件（与旧实现一致）：`platform !== 'web'` 且 `direction === 'out'`，
   * 即「当前账号在非 Web 端（手机 APP 等）发送了消息」，避免与人工回复冲突。
   * 返回新的暂停状态（触发时），否则返回 null。
   */
  reportNonWebOutMessage(message: Pick<ReplyIncomingMessage, 'platform' | 'direction'>): AiPauseStatus | null {
    if (!message.platform || message.platform === 'web') return null
    if (message.direction !== 'out') return null
    return this.pauseAi(this.config.aiPauseDurationMs, 'non-web-out')
  }

  private isAiPaused(): boolean {
    return this.getAiPauseStatus().paused
  }

  // ---------------- 判定 ----------------

  /**
   * 判定一条消息。只读，不消费冷却 / 防重。
   * 返回 `kind: 'skip'` 表示不处理，`'suggest'` 表示给出建议（不发送），
   * `'auto'` 表示允许自动发送（由调用方执行发送，引擎本身不发送）。
   */
  decide(message: ReplyIncomingMessage, options: ReplyDecideOptions = {}): ReplyDecision {
    const mode = options.mode ?? this.config.mode
    const respectPause = options.respectPause ?? true
    const now = this.now()

    // 检查链（顺序与旧实现一致）。
    // 全局总开关只约束自动发送；用户显式请求建议可经 ignoreGlobalEnabled 绕过。
    if (!this.config.enabled && !options.ignoreGlobalEnabled) return this.skip(mode, 'disabled')
    if (respectPause && this.isAiPaused()) return this.skip(mode, 'ai-paused')

    // 1) 自己消息过滤：senderId === myId，或方向为 out（双重保险）。
    if (this.myId && message.senderId === this.myId) return this.skip(mode, 'self')
    if (message.direction === 'out') return this.skip(mode, 'outgoing')

    // 2) 黑名单。
    if (this.config.blacklist.includes(message.senderId)) return this.skip(mode, 'blacklisted')

    // 3) 消息级防重。
    if (message.messageId && this.processedMessageIds.has(message.messageId)) return this.skip(mode, 'duplicate')

    // 4) 会话级冷却（防 AI 回复循环）。
    const sessionTs = this.recentReplySessions.get(message.sessionId)
    if (sessionTs !== undefined) {
      const cooldown = this.config.defaultCooldown
      if (now - sessionTs < cooldown) return this.skip(mode, 'session-cooldown')
      this.recentReplySessions.delete(message.sessionId)
    }

    const rule = this.findMatchingRule(message, now)
    if (!rule) {
      // 无规则命中：用户显式请求建议且 AI 已配置时，回退到「默认 AI 建议」（整合上下文/图片）。
      if (options.fallbackToAi) return this.defaultAiDecision()
      return this.skip(mode, 'no-match')
    }

    const delayMs = rule.delay ?? this.config.defaultDelay
    const base: ReplyDecision =
      rule.type === 'keyword'
        ? {
            kind: mode === 'auto' ? 'auto' : 'suggest',
            mode,
            ruleId: rule.id,
            ruleType: 'keyword',
            content: rule.reply,
            delayMs,
          }
        : {
            kind: mode === 'auto' ? 'auto' : 'suggest',
            mode,
            ruleId: rule.id,
            ruleType: 'ai',
            needsAi: true,
            ...(rule.prompt === undefined ? {} : { prompt: rule.prompt }),
            ...(rule.userPromptTemplate === undefined ? {} : { userPromptTemplate: rule.userPromptTemplate }),
            maxHistoryMessages: rule.maxHistoryMessages ?? DEFAULT_AI_MAX_HISTORY,
            ...(rule.model === undefined ? {} : { model: rule.model }),
            ...(rule.timeoutMs === undefined ? {} : { timeoutMs: rule.timeoutMs }),
            delayMs,
          }

    // 自动模式再过安全闸；被拦截时降级为建议，绝不自动发送。
    if (base.kind === 'auto') {
      const verdict = this.safety.check({ sessionId: message.sessionId, content: message.content })
      if (!verdict.allowed) {
        return { ...base, kind: 'suggest', reason: verdict.reason }
      }
    }
    return base
  }

  /**
   * 记账：消息防重、规则冷却、会话冷却、安全闸计数。
   * 必须在真正发送前调用（`suggest` 在用户采用后调用，`auto` 在发送前调用）。
   */
  commit(message: ReplyIncomingMessage, decision: ReplyDecision): void {
    const now = this.now()
    if (message.messageId) {
      this.processedMessageIds.add(message.messageId)
      this.pruneProcessed()
    }
    if (decision.ruleId) {
      this.lastReplyTime.set(`${message.senderId}_${decision.ruleId}`, now)
    }
    if (message.sessionId) this.recentReplySessions.set(message.sessionId, now)
    if (decision.kind === 'auto' && message.sessionId) this.safety.record(message.sessionId)
  }

  // ---------------- 内部 ----------------

  private skip(mode: ReplyMode, reason: ReplySkipReason): ReplyDecision {
    return { kind: 'skip', mode, delayMs: 0, reason }
  }

  /**
   * 无规则命中时的「默认 AI 建议」决策。
   *
   * 固定 `kind: 'suggest'`（用户显式请求，绝不自动发送），使用内置默认系统提示词与默认历史条数；
   * 具体上下文 / 图片组装由调用方（reply-runtime）在带 `includeImages` 的 AI 请求中完成。
   */
  private defaultAiDecision(): ReplyDecision {
    return {
      kind: 'suggest',
      mode: 'suggest',
      ruleId: DEFAULT_AI_RULE_ID,
      ruleType: 'ai',
      needsAi: true,
      maxHistoryMessages: DEFAULT_AI_MAX_HISTORY,
      delayMs: 0,
    }
  }

  private findMatchingRule(message: ReplyIncomingMessage, now: number): ReplyRule | null {
    const sorted = [...this.rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    for (const rule of sorted) {
      if (!rule.enabled) continue
      // 商品绑定。
      if (rule.itemIds && rule.itemIds.length > 0) {
        if (!message.itemId || !rule.itemIds.includes(message.itemId)) continue
      }
      // 规则级冷却（无记录视为不受冷却约束）。
      const cooldown = rule.cooldown ?? this.config.defaultCooldown
      const lastTime = this.lastReplyTime.get(`${message.senderId}_${rule.id}`)
      if (lastTime !== undefined && now - lastTime < cooldown) continue

      if (rule.type === 'keyword') {
        if (this.testPattern(message.content, rule.pattern)) return rule
      } else {
        // AI 规则无关键词条件，命中即触发（与旧实现一致）。
        return rule
      }
    }
    return null
  }

  private testPattern(content: string, pattern: string): boolean {
    let regex = this.regexCache.get(pattern)
    if (regex === undefined) {
      try {
        regex = new RegExp(pattern, 'i')
      } catch {
        regex = null
      }
      this.regexCache.set(pattern, regex)
    }
    if (!regex) return false
    try {
      return regex.test(content)
    } catch {
      return false
    }
  }

  private pruneProcessed(): void {
    while (this.processedMessageIds.size > PROCESSED_LIMIT) {
      const oldest = this.processedMessageIds.values().next().value
      if (oldest === undefined) break
      this.processedMessageIds.delete(oldest)
    }
  }

  private syncSafetyPolicy(): void {
    this.safety.setPolicy({
      enabled: this.config.enabled,
      windowMs: this.config.autoReplyWindowMs,
      maxAutoRepliesPerSession: this.config.maxAutoRepliesPerSession,
      handoffKeywords: this.config.handoffKeywords,
    })
  }
}
