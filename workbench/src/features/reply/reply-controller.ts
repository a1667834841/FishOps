/**
 * 聊天回复控制器（P6）：回复规则 / 全局配置、AI 建议、显式发送。纯 TypeScript，可在 Node 下测试。
 *
 * 使用的命令：
 * - 配置：`CHAT_RULES_GET`、`CHAT_RULES_SET`、`CHAT_AUTO_REPLY_STATUS`（只读状态，不用来发送）；
 * - 建议：`CHAT_GET_REPLY_SUGGESTION`（只生成，不发送）；
 * - 发送：`CHAT_APPLY_REPLY`（采用建议）、`CHAT_SEND_MESSAGE`（手动输入）。
 * 订阅事件：`CHAT_RULES_UPDATED`、`CHAT_AI_PAUSE_CHANGED`、`WORKER_STARTED`（只当「有变化」信号，不读取正文）。
 *
 * 安全约束（均有单测）：
 * - 加载页面、选择会话、生成建议都不会发送任何消息；发送只发生在用户显式调用 `applySuggestion` /
 *   `sendMessage` 时，且必须先 `setSendEnabled(true)`；切换会话会重新关闭发送；
 * - 发送进行中重复调用会被忽略（防重复点击 / 重复发送）；
 * - 把配置切到「自动回复」或在自动模式下打开引擎，必须携带 `confirmedAuto: true`，否则不发出命令；
 * - 建议 / 发送结果带会话 ID，切换会话后旧响应一律丢弃，不会显示在新会话下；
 * - 规则整表替换在同一时刻只允许一个写入进行；
 * - 不输出任何日志，不保存聊天正文以外的内容，也不读取 / 展示任何凭据。
 */
import { CommandTypes, EventTypes } from '@fishops/shared'
import {
  MAX_SEND_CONTENT_LENGTH,
  isReplyRule,
  type AutoReplyStatus,
  type ReplyGlobalConfig,
  type ReplyRule,
  type ReplySuggestionResult,
  type SendMessageErrorCode,
} from '../contracts'
import type { BridgeApi } from '../shared/bridge-api'
import { toErrorView, type ErrorView } from '../shared/error-format'
import { StateStore, type ActionPhase, type LoadPhase } from '../shared/state-store'
import { describeSendFailure, patchNeedsAutoConfirm } from './reply-form'

export const REPLY_EVENTS = [
  EventTypes.CHAT_RULES_UPDATED,
  EventTypes.CHAT_AI_PAUSE_CHANGED,
  EventTypes.WORKER_STARTED,
] as const

export interface ConfigState {
  phase: LoadPhase
  global: ReplyGlobalConfig | null
  rules: ReplyRule[]
  error: ErrorView | null
  refreshing: boolean
}

export interface StatusState {
  phase: LoadPhase
  data: AutoReplyStatus | null
  error: ErrorView | null
}

export interface SaveState {
  phase: ActionPhase
  scope: 'global' | 'rules' | null
  error: ErrorView | null
  /** 需要用户确认自动回复时置位；确认前不会发出命令。 */
  needsAutoConfirm: boolean
  savedAt: number | null
}

export interface SuggestionState {
  phase: ActionPhase
  sessionId: string | null
  result: ReplySuggestionResult | null
  error: ErrorView | null
}

export interface SendState {
  phase: ActionPhase
  kind: 'apply' | 'manual' | null
  sessionId: string | null
  /** 面向用户的失败说明（含发送结果 ok:false 与异常）。 */
  error: string | null
  /** 超时 / 响应无法识别：消息可能已经发出，界面需要提示先确认。 */
  uncertain: boolean
  sentAt: number | null
}

export interface ReplyState {
  availability: 'unavailable' | 'ready'
  config: ConfigState
  status: StatusState
  save: SaveState
  /** 当前选中的会话（建议 / 发送都绑定到它）。 */
  sessionId: string | null
  /** 发送开关：每次切换会话都会重置为 false，需用户手动启用。 */
  sendEnabled: boolean
  suggestion: SuggestionState
  send: SendState
  realtimeError: string | null
}

export interface ReplyControllerOptions {
  api: BridgeApi | null
  now?: () => number
}

const BAD_SHAPE = '扩展返回的数据格式不正确'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isGlobalConfig(value: unknown): value is ReplyGlobalConfig {
  return (
    isRecord(value) &&
    typeof value['enabled'] === 'boolean' &&
    (value['mode'] === 'manual' || value['mode'] === 'suggest' || value['mode'] === 'auto') &&
    typeof value['defaultCooldown'] === 'number' &&
    typeof value['defaultDelay'] === 'number' &&
    Array.isArray(value['blacklist']) &&
    Array.isArray(value['handoffKeywords']) &&
    typeof value['maxAutoRepliesPerSession'] === 'number' &&
    typeof value['autoReplyWindowMs'] === 'number' &&
    typeof value['aiPauseDurationMs'] === 'number' &&
    typeof value['maxContentLength'] === 'number'
  )
}

function parseRulesResult(value: unknown): { global: ReplyGlobalConfig; rules: ReplyRule[] } | null {
  if (!isRecord(value) || !isGlobalConfig(value['global']) || !Array.isArray(value['rules'])) return null
  const rules: unknown[] = value['rules']
  if (!rules.every((rule) => isRecord(rule) && typeof rule['id'] === 'string' && typeof rule['type'] === 'string')) return null
  return { global: value['global'], rules: rules as ReplyRule[] }
}

function parseStatus(value: unknown): AutoReplyStatus | null {
  if (!isRecord(value)) return null
  if (typeof value['enabled'] !== 'boolean' || typeof value['aiConfigured'] !== 'boolean' || typeof value['rulesCount'] !== 'number') {
    return null
  }
  return value as unknown as AutoReplyStatus
}

function parseSuggestion(value: unknown): ReplySuggestionResult | null {
  if (!isRecord(value) || typeof value['ok'] !== 'boolean') return null
  if (value['ok'] === true) {
    const suggestion = value['suggestion']
    if (!isRecord(suggestion) || typeof suggestion['content'] !== 'string' || typeof suggestion['sessionId'] !== 'string') return null
    return value as unknown as ReplySuggestionResult
  }
  if (typeof value['code'] !== 'string') return null
  return value as unknown as ReplySuggestionResult
}

export function createInitialReplyState(availability: ReplyState['availability']): ReplyState {
  return {
    availability,
    config: { phase: 'idle', global: null, rules: [], error: null, refreshing: false },
    status: { phase: 'idle', data: null, error: null },
    save: { phase: 'idle', scope: null, error: null, needsAutoConfirm: false, savedAt: null },
    sessionId: null,
    sendEnabled: false,
    suggestion: { phase: 'idle', sessionId: null, result: null, error: null },
    send: { phase: 'idle', kind: null, sessionId: null, error: null, uncertain: false, sentAt: null },
    realtimeError: null,
  }
}

export interface SaveOutcome {
  ok: boolean
  /** 因缺少自动回复确认而被拒绝。 */
  needsAutoConfirm?: boolean
}

export class ReplyController extends StateStore<ReplyState> {
  private readonly api: BridgeApi | null
  private readonly now: () => number
  private started = false
  private configSeq = 0
  private statusSeq = 0
  /** 建议 / 发送共用的会话令牌：切换会话即递增，让旧响应作废。 */
  private sessionEpoch = 0
  private suggestionSeq = 0

  constructor(options: ReplyControllerOptions) {
    super(createInitialReplyState(options.api ? 'ready' : 'unavailable'))
    this.api = options.api
    this.now = options.now ?? (() => Date.now())
  }

  /** 启动：登记事件，读取规则 / 全局配置与自动回复状态（均为本地只读）。幂等。 */
  start(): void {
    if (this.disposed || this.started) return
    this.started = true
    const api = this.api
    if (!api) return
    try {
      this.track(api.on(EventTypes.CHAT_RULES_UPDATED, () => this.reloadQuietly()))
      this.track(api.on(EventTypes.CHAT_AI_PAUSE_CHANGED, () => void this.loadStatus()))
      this.track(api.on(EventTypes.WORKER_STARTED, () => this.reloadQuietly()))
    } catch (error) {
      this.patch({ realtimeError: `实时更新不可用：${toErrorView(error).title}` })
    }
    void this.loadConfig(false)
    void this.loadStatus()
  }

  resubscribe(): void {
    if (this.disposed || !this.api) return
    try {
      this.api.resubscribe()
      if (this.state.realtimeError) this.patch({ realtimeError: null })
    } catch (error) {
      this.patch({ realtimeError: `实时更新不可用：${toErrorView(error).title}` })
    }
  }

  /** 手动刷新规则、全局配置与状态。 */
  async refresh(): Promise<void> {
    await Promise.all([this.loadConfig(false), this.loadStatus()])
  }

  // ---------------- 会话绑定 ----------------

  /**
   * 切换当前会话：丢弃旧会话的建议与发送结果，并重新关闭发送开关。
   * 发送进行中切换会话时不取消已发出的命令，但其结果不会显示在新会话下。
   */
  setSession(sessionId: string | null): void {
    if (this.disposed || sessionId === this.state.sessionId) return
    this.sessionEpoch++
    this.suggestionSeq++
    this.patch({
      sessionId,
      sendEnabled: false,
      suggestion: { phase: 'idle', sessionId: null, result: null, error: null },
      send: { phase: 'idle', kind: null, sessionId: null, error: null, uncertain: false, sentAt: null },
    })
  }

  /** 用户手动启用 / 关闭发送。 */
  setSendEnabled(enabled: boolean): void {
    if (this.disposed) return
    if (enabled && (!this.api || !this.state.sessionId)) return
    this.patch({ sendEnabled: enabled })
  }

  // ---------------- 建议（不发送） ----------------

  async requestSuggestion(): Promise<void> {
    const api = this.api
    const sessionId = this.state.sessionId
    if (this.disposed || !api || !sessionId || this.state.suggestion.phase === 'running') return
    const epoch = this.sessionEpoch
    const token = ++this.suggestionSeq
    this.patch({ suggestion: { phase: 'running', sessionId, result: null, error: null } })
    try {
      const raw = await api.call(CommandTypes.CHAT_GET_REPLY_SUGGESTION, { sessionId, respectPause: false })
      if (this.isStale(epoch) || token !== this.suggestionSeq) return
      const result = parseSuggestion(raw)
      if (!result) throw new Error(BAD_SHAPE)
      // ok:false 是命令成功但没有生成建议，同样要如实展示为失败结果。
      this.patch({ suggestion: { phase: result.ok ? 'ok' : 'failed', sessionId, result, error: null } })
    } catch (error) {
      if (this.isStale(epoch) || token !== this.suggestionSeq) return
      this.patch({ suggestion: { phase: 'failed', sessionId, result: null, error: toErrorView(error) } })
    }
  }

  clearSuggestion(): void {
    if (this.disposed) return
    this.suggestionSeq++
    this.patch({ suggestion: { phase: 'idle', sessionId: null, result: null, error: null } })
  }

  // ---------------- 发送（仅用户显式触发） ----------------

  /** 采用建议并发送（`CHAT_APPLY_REPLY`）。content 为用户最终确认的文本。 */
  async applySuggestion(content: string): Promise<boolean> {
    const current = this.state.suggestion
    if (!current.result || !current.result.ok) return false
    const suggestion = current.result.suggestion
    return this.dispatchSend('apply', content, async (api, sessionId, text) => {
      return api.call(CommandTypes.CHAT_APPLY_REPLY, {
        sessionId,
        content: text,
        messageId: suggestion.messageId,
        ruleId: suggestion.ruleId,
      })
    })
  }

  /** 手动发送一条消息（`CHAT_SEND_MESSAGE`）。receiverId 必须来自已知的买家 ID。 */
  async sendMessage(content: string, receiverId: string, itemId?: string): Promise<boolean> {
    if (!receiverId.trim()) return false
    return this.dispatchSend('manual', content, async (api, sessionId, text) => {
      return api.call(CommandTypes.CHAT_SEND_MESSAGE, {
        sessionId,
        receiverId,
        content: text,
        ...(itemId ? { itemId } : {}),
      })
    })
  }

  private async dispatchSend(
    kind: 'apply' | 'manual',
    content: string,
    run: (api: BridgeApi, sessionId: string, content: string) => Promise<unknown>,
  ): Promise<boolean> {
    const api = this.api
    const sessionId = this.state.sessionId
    // 没有用户启用发送开关、没有会话或正在发送时一律不发命令。
    if (this.disposed || !api || !sessionId || !this.state.sendEnabled || this.state.send.phase === 'running') return false

    const text = content.trim()
    const limit = Math.min(this.state.config.global?.maxContentLength ?? MAX_SEND_CONTENT_LENGTH, MAX_SEND_CONTENT_LENGTH)
    if (!text) {
      this.patch({ send: { phase: 'failed', kind, sessionId, error: '消息内容不能为空。', uncertain: false, sentAt: null } })
      return false
    }
    if (text.length > limit) {
      this.patch({ send: { phase: 'failed', kind, sessionId, error: `消息过长，最多 ${limit} 个字符。`, uncertain: false, sentAt: null } })
      return false
    }

    const epoch = this.sessionEpoch
    this.patch({ send: { phase: 'running', kind, sessionId, error: null, uncertain: false, sentAt: null } })
    try {
      const raw = await run(api, sessionId, text)
      if (this.isStale(epoch)) return false
      if (!isRecord(raw) || typeof raw['ok'] !== 'boolean') throw new Error(BAD_SHAPE)
      if (raw['ok'] === true) {
        this.patch({ send: { phase: 'ok', kind, sessionId, error: null, uncertain: false, sentAt: this.now() } })
        return true
      }
      const failure = raw['error']
      const code = isRecord(failure) && typeof failure['code'] === 'string' ? failure['code'] : 'SEND_FAILED'
      const message = isRecord(failure) && typeof failure['message'] === 'string' ? failure['message'] : ''
      this.patch({
        send: {
          phase: 'failed',
          kind,
          sessionId,
          error: describeSendFailure({ code: code as SendMessageErrorCode, message }),
          uncertain: code === 'TIMEOUT' || code === 'INVALID_RESPONSE',
          sentAt: null,
        },
      })
      return false
    } catch (error) {
      if (this.isStale(epoch)) return false
      const view = toErrorView(error)
      this.patch({
        send: {
          phase: 'failed',
          kind,
          sessionId,
          error: view.hint ? `${view.title}。${view.hint}` : view.detail ? `${view.title}（${view.detail}）` : view.title,
          // Bridge 超时只代表停止等待，扩展里的发送可能已经完成。
          uncertain: view.kind === 'timeout',
          sentAt: null,
        },
      })
      return false
    }
  }

  // ---------------- 规则与全局配置 ----------------

  /**
   * 保存全局配置补丁。
   * 若补丁会让自动发送生效而 `confirmedAuto` 不是 true，则不发命令，仅标记需要确认。
   */
  async saveGlobal(patch: Partial<ReplyGlobalConfig>, options: { confirmedAuto?: boolean } = {}): Promise<SaveOutcome> {
    const api = this.api
    const current = this.state.config.global
    if (this.disposed || !api || !current || this.state.save.phase === 'running') return { ok: false }
    if (Object.keys(patch).length === 0) return { ok: true }
    if (patchNeedsAutoConfirm(current, patch) && options.confirmedAuto !== true) {
      this.patch({ save: { phase: 'idle', scope: 'global', error: null, needsAutoConfirm: true, savedAt: null } })
      return { ok: false, needsAutoConfirm: true }
    }
    return this.writeConfig('global', { global: patch })
  }

  /** 整表替换规则。会先用后台同一份校验复核每条规则。 */
  async saveRules(rules: readonly ReplyRule[]): Promise<SaveOutcome> {
    const api = this.api
    if (this.disposed || !api || this.state.config.phase !== 'ready' || this.state.save.phase === 'running') return { ok: false }
    // 显式标注返回 boolean，避免 `!isReplyRule` 被推断成类型守卫后把结果收窄为 never。
    const invalid = rules.find((rule): boolean => !isReplyRule(rule))
    if (invalid) {
      this.patch({
        save: {
          phase: 'failed',
          scope: 'rules',
          error: toErrorView(new Error(`规则「${invalid.name || invalid.id}」未通过格式校验，未保存`)),
          needsAutoConfirm: false,
          savedAt: null,
        },
      })
      return { ok: false }
    }
    return this.writeConfig('rules', { rules: [...rules] })
  }

  /** 基于最新已加载的规则表新增或修改一条规则。 */
  upsertRule(rule: ReplyRule): Promise<SaveOutcome> {
    const rules = this.state.config.rules
    const exists = rules.some((item) => item.id === rule.id)
    return this.saveRules(exists ? rules.map((item) => (item.id === rule.id ? rule : item)) : [...rules, rule])
  }

  deleteRule(ruleId: string): Promise<SaveOutcome> {
    return this.saveRules(this.state.config.rules.filter((rule) => rule.id !== ruleId))
  }

  setRuleEnabled(ruleId: string, enabled: boolean): Promise<SaveOutcome> {
    return this.saveRules(this.state.config.rules.map((rule) => (rule.id === ruleId ? { ...rule, enabled } : rule)))
  }

  clearSaveStatus(): void {
    if (this.disposed || this.state.save.phase === 'running') return
    this.patch({ save: { phase: 'idle', scope: null, error: null, needsAutoConfirm: false, savedAt: null } })
  }

  private async writeConfig(
    scope: 'global' | 'rules',
    payload: { global?: Partial<ReplyGlobalConfig>; rules?: ReplyRule[] },
  ): Promise<SaveOutcome> {
    const api = this.api as BridgeApi
    this.patch({ save: { phase: 'running', scope, error: null, needsAutoConfirm: false, savedAt: null } })
    // 写入前使进行中的读取失效，避免旧读取结果在写入后覆盖新配置。
    this.configSeq++
    try {
      const raw = await api.call(CommandTypes.CHAT_RULES_SET, payload)
      if (this.disposed) return { ok: false }
      const parsed = parseRulesResult(raw)
      if (!parsed) throw new Error(BAD_SHAPE)
      this.patch({
        config: { phase: 'ready', global: parsed.global, rules: parsed.rules, error: null, refreshing: false },
        save: { phase: 'ok', scope, error: null, needsAutoConfirm: false, savedAt: this.now() },
      })
      void this.loadStatus()
      return { ok: true }
    } catch (error) {
      if (this.disposed) return { ok: false }
      this.patch({ save: { phase: 'failed', scope, error: toErrorView(error), needsAutoConfirm: false, savedAt: null } })
      return { ok: false }
    }
  }

  // ---------------- 读取 ----------------

  private isStale(epoch: number): boolean {
    return this.disposed || epoch !== this.sessionEpoch
  }

  private reloadQuietly(): void {
    // 保存进行中不重读，保存完成后响应本身就是最新配置。
    if (this.state.save.phase === 'running') return
    void this.loadConfig(true)
    void this.loadStatus()
  }

  private async loadConfig(silent: boolean): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    const token = ++this.configSeq
    const current = this.state.config
    const hadData = current.phase === 'ready'
    if (!hadData) this.patch({ config: { phase: 'loading', global: null, rules: [], error: null, refreshing: false } })
    else if (!silent) this.patch({ config: { ...current, refreshing: true } })
    try {
      const raw = await api.call(CommandTypes.CHAT_RULES_GET, {})
      if (this.disposed || token !== this.configSeq) return
      const parsed = parseRulesResult(raw)
      if (!parsed) throw new Error(BAD_SHAPE)
      this.patch({ config: { phase: 'ready', global: parsed.global, rules: parsed.rules, error: null, refreshing: false } })
    } catch (error) {
      if (this.disposed || token !== this.configSeq) return
      const latest = this.state.config
      this.patch({
        config: {
          phase: hadData ? 'ready' : 'error',
          global: hadData ? latest.global : null,
          rules: hadData ? latest.rules : [],
          error: toErrorView(error),
          refreshing: false,
        },
      })
    }
  }

  private async loadStatus(): Promise<void> {
    const api = this.api
    if (!api || this.disposed) return
    const token = ++this.statusSeq
    const hadData = this.state.status.data !== null
    if (!hadData) this.patch({ status: { phase: 'loading', data: null, error: null } })
    try {
      const raw = await api.call(CommandTypes.CHAT_AUTO_REPLY_STATUS, {})
      if (this.disposed || token !== this.statusSeq) return
      const data = parseStatus(raw)
      if (!data) throw new Error(BAD_SHAPE)
      this.patch({ status: { phase: 'ready', data, error: null } })
    } catch (error) {
      if (this.disposed || token !== this.statusSeq) return
      this.patch({
        status: { phase: hadData ? 'ready' : 'error', data: this.state.status.data, error: toErrorView(error) },
      })
    }
  }
}
