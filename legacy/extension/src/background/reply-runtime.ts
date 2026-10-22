/**
 * P6 回复 / 发送 / AI 运行时（background 接线）。
 *
 * 组装 `ReplyConfigStore`（规则 + 全局 + 凭据隔离）+ `ReplyEngine`（纯规则逻辑）+
 * `AutoReplySafetyGate`（安全闸）+ `AiChatService`（AI）+ `ChatMessageSender`（发送），
 * 把 P6 能力暴露为 P1 命令 / 事件：
 * - `CHAT_RULES_GET/SET`、`CHAT_AUTO_REPLY_STATUS`、`CHAT_AI_PAUSE_SET`：配置与状态；
 * - `CHAT_GET_REPLY_SUGGESTION`：生成建议（**不发送**）；
 * - `CHAT_SEND_MESSAGE` / `CHAT_APPLY_REPLY`：**显式**发送入口。
 *
 * 建议与自动回复的关系：
 * - `CHAT_GET_REPLY_SUGGESTION` 是**用户显式**动作，独立于自动回复总开关（`enabled=false` 也可用），
 *   不发送、不消费自动回复配额；无规则命中且 AI 已配置时回退为「默认 AI 建议」，携带上下文与图片。
 *
 * 安全：
 * - 默认 `suggest` 模式，绝不自动发送；`auto` 模式下同时受规则与安全闸约束；
 * - API key 只在配置适配器读取，不进日志 / 事件 / 返回值（状态里只回 `aiConfigured` 布尔）；
 * - 事件负载不含聊天正文。
 */
import {
  CommandTypes,
  createErrorResponse,
  createResponse,
  EventTypes,
  isEmptyPayload,
  isChatAiPauseSetPayload,
  isChatApplyReplyPayload,
  isChatGetReplySuggestionPayload,
  isChatRulesSetPayload,
  isChatSendMessagePayload,
  type CommandEnvelope,
  type PlatformErrorCategory,
  type ResponseEnvelope,
} from '@fishops/shared'
import { toFullCid } from '../../../shared/chat/index'
import { normalizeUserId } from '../chat/parser'
import type { ChatMessage, Conversation } from '../../../shared/types/chat'
import {
  DEFAULT_AI_MAX_HISTORY,
  TEXT_CONTENT_TYPE,
  type AutoReplyStatus,
  type ReplyContextSummary,
  type ReplyDecision,
  type ReplyGlobalConfig,
  type ReplyIncomingMessage,
  type ReplyRule,
  type ReplySuggestion,
  type ReplySuggestionResult,
} from '../../../shared/types/reply'
import { buildReplyMessages, type AiItemDetail } from '../chat/ai-prompt'
import type { AiChatService } from '../chat/ai-service'
import type { BridgeEventEnvelopeLike } from '../chat/bridge-adapter'
import { ReplyEngine } from '../chat/reply-engine'
import { mergeReplyGlobalConfig, type ReplyConfigStore } from '../chat/reply-config'
import { matchesHandoff } from '../chat/reply-safety'
import type { ChatMessageSender } from '../chat/send-client'
import type { UpsertResult } from '../chat/store'
import type { MyUserIdOutcome } from './my-user-id'

/** 走 ReplyRuntime 的 P6 命令集合。 */
export const REPLY_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.CHAT_SEND_MESSAGE,
  CommandTypes.CHAT_GET_REPLY_SUGGESTION,
  CommandTypes.CHAT_APPLY_REPLY,
  CommandTypes.CHAT_AUTO_REPLY_STATUS,
  CommandTypes.CHAT_RULES_GET,
  CommandTypes.CHAT_RULES_SET,
  CommandTypes.CHAT_AI_PAUSE_SET,
])

/** 是否为 P6 命令。 */
export function isReplyCommand(type: string): boolean {
  return REPLY_COMMANDS.has(type)
}

/** 发送前准备结果（由 background 的运行时会话提供）。 */
export interface ReplyReadiness {
  ok: boolean
  /** 失败时的结构化类别，直接透传给 UI（host-unavailable / unauthorized / captcha 等）。 */
  category?: PlatformErrorCategory
  message?: string
  /** 失败时的 MTOP ret 码（若有，仅诊断，不含凭据）。 */
  retCode?: string
}

/**
 * 「已发送消息」落库所需的最小 store 能力。
 * P5 `ChatStore` 天然满足；测试可注入内存实现。
 */
export interface SentMessageStore {
  /** 批量 upsert 消息（按 {@link ChatStore.keyOf} 去重），返回新增/覆盖统计。 */
  upsertMessages(messages: readonly ChatMessage[]): UpsertResult
  /** 批量 upsert 会话，返回新增/覆盖统计。 */
  upsertConversations(conversations: readonly Conversation[]): UpsertResult
  /** 读取已有会话（用于保留头像 / 昵称等既有字段）。 */
  getConversation(sessionId: string): Conversation | undefined
}

/** P6 运行时依赖。 */
export interface ReplyRuntimeDeps {
  configStore: ReplyConfigStore
  sender: ChatMessageSender
  ai: AiChatService
  /** 读取某会话本地消息（由 P5 store 提供）。 */
  getMessages: (sessionId: string, options?: { order?: 'asc' | 'desc'; limit?: number }) => Promise<ChatMessage[]>
  /**
   * 已发送消息落库入口（P5 `store` 提供）。
   * 仅在服务端确认发送成功（`result.ok`）后写入「已确认发出」的消息并更新会话摘要；
   * 缺省时退化为旧行为（只发 `CHAT_MESSAGE_SENT`，不写 store）。
   */
  sentMessageStore?: SentMessageStore
  /** 当前登录用户 ID（发送必需，初值；运行时可用 `resolveMyUserId` 重新解析）。 */
  myUserId?: string
  /**
   * 显式发送前的运行时就绪准备（tab + host + socket + 用户 ID）。
   * **仅在 `CHAT_SEND_MESSAGE` / `CHAT_APPLY_REPLY` 调用**，自动模式 / 实时消息不触发。
   */
  ensureReady?: (options?: { purpose?: 'chat' | 'platform' }) => Promise<ReplyReadiness>
  /** 发送时动态解析用户 ID（命中成功缓存则不重复请求）。 */
  resolveMyUserId?: () => Promise<MyUserIdOutcome>
  now?: () => number
  /** 延迟函数（自动回复 delay）；便于测试。 */
  sleep?: (ms: number) => Promise<void>
  /** eventId 生成器，便于测试。 */
  genEventId?: () => string
}

/** P6 运行时。 */
export interface ReplyRuntime {
  init(): Promise<void>
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
  /** 处理一条已入库消息（自动回复 / AI 暂停入口）。返回引擎判定。 */
  handleIncomingMessage(message: ChatMessage & { platform?: string }): Promise<ReplyDecision>
  /** 取出并清空待广播事件。 */
  drainEvents(): BridgeEventEnvelopeLike[]
  /** 当前状态。 */
  getStatus(): AutoReplyStatus
  /** 重新从配置存储加载全局/规则/凭据（迁移后刷新内存缓存，避免用户重载）。 */
  reloadConfig(): Promise<void>
}

/** 消息 + 可选平台来源。 */
export type ReplyIncomingSource = ChatMessage & { platform?: string }

function toIncoming(message: ReplyIncomingSource): ReplyIncomingMessage {
  return {
    messageId: message.messageId || message.id,
    sessionId: message.sessionId,
    senderId: message.senderId,
    receiverId: message.receiverId,
    direction: message.direction,
    content: message.content,
    ...(message.itemId === undefined ? {} : { itemId: message.itemId }),
    createAt: message.createAt,
    ...(message.platform === undefined ? {} : { platform: message.platform }),
    ...(message.senderName === undefined ? {} : { senderName: message.senderName }),
    ...(message.itemTitle === undefined ? {} : { itemTitle: message.itemTitle }),
    ...(message.kind === undefined ? {} : { kind: message.kind }),
    ...(message.contentType === undefined ? {} : { contentType: message.contentType }),
    ...(message.imageUrl === undefined ? {} : { imageUrl: message.imageUrl }),
  }
}

function isInbound(message: ChatMessage): boolean {
  return message.direction === 'in' && message.content.trim().length > 0
}

/** 选择用于生成建议的目标消息：指定 messageId 优先，否则取最后一条对方消息。 */
function pickTargetMessage(messages: readonly ChatMessage[], messageId?: string): ChatMessage | null {
  if (messageId) {
    const found = messages.find((m) => m.messageId === messageId || m.id === messageId)
    return found ?? null
  }
  const inbound = messages.filter(isInbound).sort((a, b) => (a.createAt ?? 0) - (b.createAt ?? 0))
  return inbound.length > 0 ? inbound[inbound.length - 1] : null
}

function defaultEventId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') return cryptoObj.randomUUID()
  return `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/** 创建 P6 运行时。 */
export function createReplyRuntime(deps: ReplyRuntimeDeps): ReplyRuntime {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const genEventId = deps.genEventId ?? defaultEventId

  const engine = new ReplyEngine({ now, myId: deps.myUserId ?? '' })
  const events: BridgeEventEnvelopeLike[] = []
  let configLoaded = false
  let aiConfigured = false
  let initPromise: Promise<void> | null = null

  const push = (type: string, payload: unknown): void => {
    events.push({ kind: 'event', type, eventId: genEventId(), payload, emittedAt: now() })
  }

  const ensureInit = (): Promise<void> => {
    if (!initPromise) initPromise = loadConfig()
    return initPromise
  }

  async function loadConfig(): Promise<void> {
    const [global, rules, provider] = await Promise.all([
      deps.configStore.loadGlobalConfig(),
      deps.configStore.loadRules(),
      deps.configStore.loadAiProvider(),
    ])
    engine.setGlobalConfig(global)
    engine.setRules(rules)
    aiConfigured = provider.apiKey.length > 0
    configLoaded = true
  }

  /** 卸载后重新加载配置，并广播 CHAT_RULES_UPDATED 供 Workbench 刷新。 */
  async function reloadConfig(): Promise<void> {
    await loadConfig()
    const config = engine.getGlobalConfig()
    push(EventTypes.CHAT_RULES_UPDATED, {
      enabled: config.enabled,
      mode: config.mode,
      rulesCount: engine.getRules().length,
    })
  }

  function getStatus(): AutoReplyStatus {
    const config = engine.getGlobalConfig()
    const pause = engine.getAiPauseStatus()
    return {
      configLoaded,
      enabled: config.enabled,
      mode: config.mode,
      rulesCount: engine.getRules().length,
      processedCount: engine.processedCount,
      aiPaused: pause.paused,
      aiPausedUntil: pause.pausedUntil,
      aiPauseReason: pause.reason,
      aiConfigured,
    }
  }

  /**
   * 解析 AI 回复内容（失败返回 null）。
   * 同时返回非敏感上下文摘要，供建议诊断元数据与事件使用。
   */
  async function resolveAiReply(
    incoming: ReplyIncomingMessage,
    decision: ReplyDecision,
    includeImages = true,
  ): Promise<{ content: string; summary: ReplyContextSummary } | null> {
    const maxHistory = decision.maxHistoryMessages ?? DEFAULT_AI_MAX_HISTORY
    const history = await deps.getMessages(incoming.sessionId, { order: 'desc', limit: maxHistory })
    const itemTitle = incoming.itemTitle ?? incoming.itemId
    const itemDetail: AiItemDetail | undefined =
      typeof itemTitle === 'string' && itemTitle.length > 0 ? { title: itemTitle } : undefined
    const built = buildReplyMessages({
      history,
      current: incoming,
      ...(decision.prompt === undefined ? {} : { basePrompt: decision.prompt }),
      ...(decision.userPromptTemplate === undefined ? {} : { userPromptTemplate: decision.userPromptTemplate }),
      ...(itemDetail === undefined ? {} : { itemDetail }),
      maxHistoryMessages: maxHistory,
      includeImages,
    })
    const options = {
      ...(decision.model === undefined ? {} : { model: decision.model }),
      ...(decision.timeoutMs === undefined ? {} : { timeoutMs: decision.timeoutMs }),
    }
    const result = await deps.ai.completeText(built.messages, options)
    return result.ok ? { content: result.content, summary: built.contextSummary } : null
  }

  /** 自动模式下真正发送（受延迟 / 安全闸 / 发送器约束；失败结构化记事件）。 */
  async function executeAuto(incoming: ReplyIncomingMessage, decision: ReplyDecision): Promise<void> {
    const ruleId = decision.ruleId ?? ''
    const ruleType = decision.ruleType ?? 'keyword'
    const myId = deps.myUserId ?? ''
    if (!myId) {
      push(EventTypes.CHAT_AUTO_REPLY_TRIGGERED, { sessionId: incoming.sessionId, ruleId, ruleType, mode: decision.mode, ok: false })
      return
    }

    let content: string | null = decision.content ?? null
    if (decision.needsAi) content = (await resolveAiReply(incoming, decision))?.content ?? null
    if (!content) {
      push(EventTypes.CHAT_AUTO_REPLY_TRIGGERED, { sessionId: incoming.sessionId, ruleId, ruleType, mode: decision.mode, ok: false })
      return
    }

    if (decision.delayMs > 0) await sleep(decision.delayMs)

    // 发送前记账：防止并发 / 重复触发。
    engine.commit(incoming, decision)

    const result = await deps.sender.sendText({
      sessionId: incoming.sessionId,
      receiverId: incoming.senderId,
      myId,
      content,
    })
    push(EventTypes.CHAT_MESSAGE_SENT, {
      ok: result.ok,
      sessionId: incoming.sessionId,
      ...(result.ok ? { messageId: result.messageId } : { errorCode: result.error.code }),
    })
    // 仅在服务端确认成功后才落库；失败 / 超时结果未知，绝不伪造。
    if (result.ok) {
      emitSentIngested(
        recordSentMessage({
          sessionId: incoming.sessionId,
          receiverId: incoming.senderId,
          myId,
          content,
          messageId: result.messageId,
          sentAt: result.sentAt,
          ...(incoming.itemId === undefined ? {} : { itemId: incoming.itemId }),
        }),
      )
    }
    push(EventTypes.CHAT_AUTO_REPLY_TRIGGERED, {
      sessionId: incoming.sessionId,
      ruleId,
      ruleType,
      mode: decision.mode,
      ok: result.ok,
    })
  }

  async function handleIncomingMessage(message: ReplyIncomingSource): Promise<ReplyDecision> {
    await ensureInit()
    const incoming = toIncoming(message)
    // 非 Web 端 out 消息：触发 AI 暂停（默认 10 分钟）。
    const pause = engine.reportNonWebOutMessage(incoming)
    if (pause) push(EventTypes.CHAT_AI_PAUSE_CHANGED, pause)

    const decision = engine.decide(incoming)
    if (decision.kind === 'auto') await executeAuto(incoming, decision)
    return decision
  }

  async function suggestion(payload: { sessionId: string; messageId?: string; respectPause?: boolean; includeImages?: boolean }): Promise<ReplySuggestionResult> {
    // 目标查找覆盖整个本地会话，避免历史指定 ID 或连续出站消息被上下文窗口截断。
    // AI 上下文仍由 resolveAiReply 单独按 maxHistory 限量，不增加联网历史请求。
    const messages = await deps.getMessages(payload.sessionId, { order: 'asc' })
    const target = pickTargetMessage(messages, payload.messageId)
    if (!target) return { ok: false, code: 'NO_MESSAGE', message: '该会话没有可用于生成建议的消息' }

    const incoming = toIncoming(target)
    // 手动建议：独立于自动回复总开关（ignoreGlobalEnabled），且不发送 / 不记账（不调用 commit）。
    // 无规则命中时若已配置 AI，则回退到默认 AI 建议（fallbackToAi），整合上下文与图片。
    const decision = engine.decide(incoming, {
      mode: 'suggest',
      respectPause: payload.respectPause ?? false,
      ignoreGlobalEnabled: true,
      fallbackToAi: aiConfigured,
    })
    if (decision.kind === 'skip' || !decision.ruleId || !decision.ruleType) {
      return {
        ok: false,
        code: decision.reason === 'no-match' ? 'NO_MATCH' : 'SKIPPED',
        message: `未生成建议: ${decision.reason ?? 'unknown'}`,
        ...(decision.reason === undefined ? {} : { reason: decision.reason }),
      }
    }

    let content: string | null = decision.content ?? null
    let contextSummary: ReplyContextSummary | null = null
    if (decision.needsAi) {
      const aiReply = await resolveAiReply(incoming, decision, payload.includeImages ?? true)
      content = aiReply?.content ?? null
      contextSummary = aiReply?.summary ?? null
    }
    if (!content) {
      if (decision.needsAi) {
        push(EventTypes.CHAT_REPLY_SUGGESTION_GENERATED, {
          sessionId: payload.sessionId,
          messageId: incoming.messageId,
          ruleId: decision.ruleId,
          ruleType: decision.ruleType,
          ok: false,
          contextSummary: contextSummary ?? { historyCount: 0, imageCount: 0, truncated: false, hasItem: false },
        })
      }
      return { ok: false, code: 'AI_ERROR', message: 'AI 生成建议失败' }
    }

    const config = engine.getGlobalConfig()
    const reply: ReplySuggestion = {
      sessionId: payload.sessionId,
      messageId: incoming.messageId,
      ruleId: decision.ruleId,
      ruleType: decision.ruleType,
      mode: 'suggest',
      content,
      requiresHuman: matchesHandoff(incoming.content, config.handoffKeywords),
      generatedAt: now(),
      ...(contextSummary === null ? {} : { diagnostics: { contextSummary } }),
    }
    push(EventTypes.CHAT_REPLY_SUGGESTION_GENERATED, {
      sessionId: payload.sessionId,
      messageId: incoming.messageId,
      ruleId: decision.ruleId,
      ruleType: decision.ruleType,
      ok: true,
      contextSummary: contextSummary ?? { historyCount: 0, imageCount: 0, truncated: false, hasItem: false },
    })
    return { ok: true, suggestion: reply }
  }

  /** 推断对方用户 ID：优先显式传入，其次来源消息的 senderId。 */
  async function resolveReceiverId(
    sessionId: string,
    explicit: string | undefined,
    messageId: string | undefined,
  ): Promise<string | null> {
    if (explicit) return explicit
    // 与建议目标保持同一查找范围；显式收件人仍在读取消息前直接返回。
    const messages = await deps.getMessages(sessionId, { order: 'asc' })
    const target = pickTargetMessage(messages, messageId)
    return target ? target.senderId : null
  }

  /** 会话摘要最大长度（避免把长正文整段塞进会话列表）。 */
  const CONVERSATION_SUMMARY_MAX = 100

  /** 已发送消息落库结果（消息 + 会话两组 upsert 统计）。 */
  interface SentIngestResult {
    message: UpsertResult
    conversation: UpsertResult
  }

  /**
   * 发送成功后把「已确认发出」的消息与其会话摘要写入本地 store。
   *
   * 仅在服务端确认 `ok` 后调用；未注入 `sentMessageStore` 时返回 null（退化为旧行为，不写 store）。
   *
   * 去重使用 P5 `ChatStore` 口径，以发送 uuid 作 `messageId`（`mid:uuid`）。
   * 证据核实（`.p0-runtime/chat/docs/api/websocket-api.md` 与旧 `chat-sender.js`）：
   * 平台发送响应**不返回**服务端 `messageId`，历史 / 实时回声的 `messageId` 形如 `msg_xxx`，
   * 与发送 uuid **不同源**，因此本键只能保证**本地幂等**（重试 / 重复发送不重复入库）；
   * 跨源（本地发送 vs 历史 / 回声）按 id 去重无可靠依据，不做时间窗等猜测性合并。
   *
   * 会话摘要更新遵循「保留既有字段」：已存在则只改 `lastMessage` / `lastMessageTime` / `sortIndex`，
   * 保留头像 / 昵称 / 未读等；不存在才新建（头像未知保持 undefined）。
   */
  function recordSentMessage(input: {
    sessionId: string
    receiverId: string
    myId: string
    content: string
    messageId: string
    sentAt: number
    itemId?: string
  }): SentIngestResult | null {
    const store = deps.sentMessageStore
    if (!store) return null

    const cid = toFullCid(input.sessionId)
    const summary =
      input.content.length > CONVERSATION_SUMMARY_MAX ? `${input.content.slice(0, CONVERSATION_SUMMARY_MAX)}…` : input.content

    const message: ChatMessage = {
      // id 由 store 按去重键覆盖，这里留空占位。
      id: '',
      messageId: input.messageId,
      sessionId: input.sessionId,
      cid,
      senderId: input.myId,
      senderName: '',
      receiverId: input.receiverId,
      direction: 'out',
      kind: 'text',
      contentType: TEXT_CONTENT_TYPE,
      content: input.content,
      ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
      createAt: input.sentAt,
      // 本地已确认发出（非平台实时回声 / 历史拉取）；复用 history 表示「非实时推送」
      source: 'history',
      // 本地确认回显：仅内存暂存，待权威历史 / 回声覆盖边界到达后由 store 自动替换移除。
      pendingEcho: true,
    }

    const candidate = store.getConversation(input.sessionId)
    const existing = candidate?.accountUserId && normalizeUserId(candidate.accountUserId) !== normalizeUserId(input.myId)
      ? undefined : candidate
    const conversation: Conversation = existing
      ? { ...existing, accountUserId: normalizeUserId(input.myId), lastMessage: summary, lastMessageTime: input.sentAt, sortIndex: input.sentAt }
      : {
          sessionId: input.sessionId,
          cid,
          accountUserId: normalizeUserId(input.myId),
          peerUserId: input.receiverId,
          peerUserName: '',
          lastMessage: summary,
          lastMessageTime: input.sentAt,
          unreadCount: 0,
          sortIndex: input.sentAt,
          ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
          visible: true,
        }

    return {
      message: store.upsertMessages([message]),
      conversation: store.upsertConversations([conversation]),
    }
  }

  /** 发送成功落库后 emit 入库 / 会话更新事件（负载仅元数据，不含正文）。 */
  function emitSentIngested(result: SentIngestResult | null): void {
    if (!result) return
    if (result.message.added + result.message.updated > 0) {
      push(EventTypes.CHAT_MESSAGE_INGESTED, {
        kind: 'message',
        added: result.message.added,
        updated: result.message.updated,
      })
    }
    if (result.conversation.added + result.conversation.updated > 0) {
      push(EventTypes.CHAT_CONVERSATION_UPDATED, {
        added: result.conversation.added,
        updated: result.conversation.updated,
      })
    }
  }

  /**
   * 显式发送前的统一准备：运行时就绪（ensureReady）+ 用户 ID 解析。
   * 失败返回结构化 `PLATFORM_ERROR`（带 category），由 UI 引导登录 / 处理验证码。
   * 仅在 `CHAT_SEND_MESSAGE` / `CHAT_APPLY_REPLY` 调用，自动模式与实时消息不经过此处。
   */
  async function ensureSendReady(
    command: CommandEnvelope,
  ): Promise<{ ok: true; myId: string } | { ok: false; response: ResponseEnvelope }> {
    if (deps.ensureReady) {
      const ready = await deps.ensureReady({ purpose: 'chat' })
      if (!ready.ok) {
        const category = ready.category ?? 'host-unavailable'
        // ensureReady 路径（runtime-session → index）不携带 retCode；尽量从用户 ID 解析结果补齐
        // （同一失败一般在退避窗口内，命中缓存，不额外请求），保证 retCode 不丢。
        let retCode = ready.retCode
        if (retCode === undefined && deps.resolveMyUserId) {
          const probe = await deps.resolveMyUserId()
          if (!probe.ok && probe.category === category && probe.retCode) retCode = probe.retCode
        }
        return {
          ok: false,
          response: createErrorResponse(command.requestId, command.type, {
            code: 'PLATFORM_ERROR',
            message: ready.message ?? '闲鱼运行时就绪失败，请确认已登录闲鱼并处理验证码',
            category,
            ...(retCode === undefined ? {} : { retCode }),
          }),
        }
      }
    }

    if (deps.resolveMyUserId) {
      const outcome = await deps.resolveMyUserId()
      if (!outcome.ok) {
        return {
          ok: false,
          response: createErrorResponse(command.requestId, command.type, {
            code: 'PLATFORM_ERROR',
            message: `${outcome.message}（请确认已登录闲鱼；如有验证码请在页面完成）`,
            category: outcome.category,
            ...(outcome.retCode === undefined ? {} : { retCode: outcome.retCode }),
          }),
        }
      }
      engine.setMyId(outcome.userId)
      return { ok: true, myId: outcome.userId }
    }

    const myId = deps.myUserId ?? ''
    if (!myId) {
      return {
        ok: false,
        response: createErrorResponse(command.requestId, command.type, {
          code: 'PLATFORM_ERROR',
          message: '当前用户 ID 未就绪，请确认已登录闲鱼；如有验证码请在页面完成',
          category: 'unauthorized',
        }),
      }
    }
    return { ok: true, myId }
  }

  async function sendMessage(
    command: CommandEnvelope,
    payload: { sessionId: string; receiverId: string; content: string; itemId?: string; timeoutMs?: number },
  ): Promise<ResponseEnvelope> {
    const ready = await ensureSendReady(command)
    if (!ready.ok) return ready.response
    const myId = ready.myId
    const result = await deps.sender.sendText({
      sessionId: payload.sessionId,
      receiverId: payload.receiverId,
      myId,
      content: payload.content,
      ...(payload.itemId === undefined ? {} : { itemId: payload.itemId }),
      ...(payload.timeoutMs === undefined ? {} : { timeoutMs: payload.timeoutMs }),
    })
    push(EventTypes.CHAT_MESSAGE_SENT, {
      ok: result.ok,
      sessionId: payload.sessionId,
      ...(result.ok ? { messageId: result.messageId } : { errorCode: result.error.code }),
    })
    // 仅在服务端确认成功后才落库；失败 / 超时结果未知，绝不伪造。
    if (result.ok) {
      emitSentIngested(
        recordSentMessage({
          sessionId: payload.sessionId,
          receiverId: payload.receiverId,
          myId,
          content: payload.content,
          messageId: result.messageId,
          sentAt: result.sentAt,
          ...(payload.itemId === undefined ? {} : { itemId: payload.itemId }),
        }),
      )
    }
    return createResponse(command.requestId, command.type, result)
  }

  async function applyReply(
    command: CommandEnvelope,
    payload: { sessionId: string; content: string; receiverId?: string; messageId?: string; ruleId?: string },
  ): Promise<ResponseEnvelope> {
    const ready = await ensureSendReady(command)
    if (!ready.ok) return ready.response
    const myId = ready.myId
    const receiverId = await resolveReceiverId(payload.sessionId, payload.receiverId, payload.messageId)
    if (!receiverId) {
      return createErrorResponse(command.requestId, command.type, {
        code: 'INVALID_PAYLOAD',
        message: '无法确定接收者，请先同步该会话消息或显式传入 receiverId',
      })
    }

    const result = await deps.sender.sendText({ sessionId: payload.sessionId, receiverId, myId, content: payload.content })
    if (result.ok) {
      // 采用建议属于人工动作：只记防重 / 冷却，不计入安全闸自动回复计数。
      engine.commit(
        {
          messageId: payload.messageId ?? '',
          sessionId: payload.sessionId,
          senderId: receiverId,
          receiverId: myId,
          direction: 'in',
          content: payload.content,
        },
        { kind: 'suggest', mode: 'suggest', delayMs: 0, ...(payload.ruleId === undefined ? {} : { ruleId: payload.ruleId }) },
      )
      // 服务端确认后入库，使 UI 无需同步历史即可看到采用后发出的消息。
      emitSentIngested(
        recordSentMessage({
          sessionId: payload.sessionId,
          receiverId,
          myId,
          content: payload.content,
          messageId: result.messageId,
          sentAt: result.sentAt,
        }),
      )
    }
    push(EventTypes.CHAT_MESSAGE_SENT, {
      ok: result.ok,
      sessionId: payload.sessionId,
      ...(result.ok ? { messageId: result.messageId } : { errorCode: result.error.code }),
    })
    return createResponse(command.requestId, command.type, result)
  }

  async function setRules(
    command: CommandEnvelope,
    payload: { global?: Partial<ReplyGlobalConfig>; rules?: ReplyRule[] },
  ): Promise<ResponseEnvelope> {
    if (payload.global) {
      const current = await deps.configStore.loadGlobalConfig()
      const merged = mergeReplyGlobalConfig(current, payload.global)
      await deps.configStore.saveGlobalConfig(merged)
      engine.setGlobalConfig(merged)
    }
    if (payload.rules) {
      await deps.configStore.saveRules(payload.rules)
      engine.setRules(await deps.configStore.loadRules())
    }
    const [global, rules] = await Promise.all([deps.configStore.loadGlobalConfig(), deps.configStore.loadRules()])
    push(EventTypes.CHAT_RULES_UPDATED, { enabled: global.enabled, mode: global.mode, rulesCount: rules.length })
    return createResponse(command.requestId, command.type, { global, rules })
  }

  async function handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope> {
    if (!isReplyCommand(command.type)) {
      return createErrorResponse(command.requestId, command.type, {
        code: 'UNKNOWN_COMMAND',
        message: `非 P6 命令: ${command.type}`,
      })
    }
    try {
      await ensureInit()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return createErrorResponse(command.requestId, command.type, { code: 'INTERNAL', message: `回复层初始化失败: ${message}` })
    }

    switch (command.type) {
      case CommandTypes.CHAT_SEND_MESSAGE: {
        if (!isChatSendMessagePayload(command.payload)) return invalid(command, '非法的 CHAT_SEND_MESSAGE 负载')
        return sendMessage(command, command.payload)
      }
      case CommandTypes.CHAT_GET_REPLY_SUGGESTION: {
        if (!isChatGetReplySuggestionPayload(command.payload)) return invalid(command, '非法的 CHAT_GET_REPLY_SUGGESTION 负载')
        return createResponse(command.requestId, command.type, await suggestion(command.payload))
      }
      case CommandTypes.CHAT_APPLY_REPLY: {
        if (!isChatApplyReplyPayload(command.payload)) return invalid(command, '非法的 CHAT_APPLY_REPLY 负载')
        return applyReply(command, command.payload)
      }
      case CommandTypes.CHAT_AUTO_REPLY_STATUS: {
        if (!isEmptyPayload(command.payload)) return invalid(command, '非法的 CHAT_AUTO_REPLY_STATUS 负载')
        return createResponse(command.requestId, command.type, getStatus())
      }
      case CommandTypes.CHAT_RULES_GET: {
        if (!isEmptyPayload(command.payload)) return invalid(command, '非法的 CHAT_RULES_GET 负载')
        const [global, rules] = await Promise.all([deps.configStore.loadGlobalConfig(), deps.configStore.loadRules()])
        return createResponse(command.requestId, command.type, { global, rules })
      }
      case CommandTypes.CHAT_RULES_SET: {
        if (!isChatRulesSetPayload(command.payload)) return invalid(command, '非法的 CHAT_RULES_SET 负载')
        return setRules(command, command.payload)
      }
      case CommandTypes.CHAT_AI_PAUSE_SET: {
        if (!isChatAiPauseSetPayload(command.payload)) return invalid(command, '非法的 CHAT_AI_PAUSE_SET 负载')
        const status = command.payload.paused
          ? engine.pauseAi(command.payload.durationMs, command.payload.reason ?? 'manual')
          : engine.resumeAi()
        push(EventTypes.CHAT_AI_PAUSE_CHANGED, status)
        return createResponse(command.requestId, command.type, status)
      }
      default:
        return createErrorResponse(command.requestId, command.type, {
          code: 'UNKNOWN_COMMAND',
          message: `未处理的 P6 命令: ${command.type}`,
        })
    }
  }

  return {
    init: ensureInit,
    handleCommand,
    handleIncomingMessage,
    drainEvents: () => events.splice(0, events.length),
    getStatus,
    reloadConfig,
  }

  // ---- 小助手 ----

  function invalid(command: CommandEnvelope, message: string): ResponseEnvelope {
    return createErrorResponse(command.requestId, command.type, { code: 'INVALID_PAYLOAD', message })
  }
}
