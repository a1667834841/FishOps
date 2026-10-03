/**
 * 事件定义：Extension → Workbench 的单向推送。
 */
import type { Task, TaskStatus } from '../types/task'
import type {
  AiPauseStatus,
  ReplyContextSummary,
  ReplyMode,
  ReplyRuleType,
  SendMessageErrorCode,
} from '../types/reply'
import type { PublishTask, PublishTaskStatus } from '../types/publish'

/** 事件类型常量。 */
export const EventTypes = {
  /** background service worker 启动（或被回收后重启）时广播。 */
  WORKER_STARTED: 'WORKER_STARTED',
  /** background 收到 PING 时广播，可用于观察链路活动。 */
  PING_RECEIVED: 'PING_RECEIVED',
  /** PUBLISH 命令触发的示例事件。 */
  DEMO_TICK: 'DEMO_TICK',
  /** 实时消息已写入 ChatStore（P5）；负载仅含元数据，不含聊天正文。 */
  CHAT_MESSAGE_INGESTED: 'CHAT_MESSAGE_INGESTED',
  /** 会话信息更新（P5）；负载不含正文。 */
  CHAT_CONVERSATION_UPDATED: 'CHAT_CONVERSATION_UPDATED',
  /** 历史/会话同步完成（P5）。 */
  CHAT_SYNC_COMPLETED: 'CHAT_SYNC_COMPLETED',
  /** 聊天 WebSocket 连接状态变化（P5）。 */
  CHAT_SOCKET_STATUS: 'CHAT_SOCKET_STATUS',
  /** 任务状态 / 进度变化（P4 任务中心）；随任务快照推送，可同时驱动进度条。 */
  TASK_CHANGED: 'TASK_CHANGED',
  // ---------------- 聊天发送与 AI（P6） ----------------
  /** 一条消息发送完成（P6）；负载仅含元数据，不含正文。 */
  CHAT_MESSAGE_SENT: 'CHAT_MESSAGE_SENT',
  /** 自动回复已触发（P6）；负载仅含规则/会话元数据，不含正文。 */
  CHAT_AUTO_REPLY_TRIGGERED: 'CHAT_AUTO_REPLY_TRIGGERED',
  /** AI 暂停状态变化（P6）。 */
  CHAT_AI_PAUSE_CHANGED: 'CHAT_AI_PAUSE_CHANGED',
  /** 回复规则 / 全局配置已更新（P6）。 */
  CHAT_RULES_UPDATED: 'CHAT_RULES_UPDATED',
  /**
   * 已生成一条回复建议（P6）。**负载不含建议正文 / 图片 URL / 凭据**，
   * 只含规则与会话元数据 + 非敏感上下文摘要，供 Workbench 提示刷新。
   */
  CHAT_REPLY_SUGGESTION_GENERATED: 'CHAT_REPLY_SUGGESTION_GENERATED',
  // ---------------- 运行时自动准备（P8） ----------------
  /** 闲鱼运行时就绪状态变化（P8）；负载只含布尔与状态，不含用户 ID 值与聊天内容。 */
  RUNTIME_STATUS_CHANGED: 'RUNTIME_STATUS_CHANGED',
  // ---------------- 发布中心（P8） ----------------
  /** 发布任务状态 / 进度变化（P8 发布中心）。 */
  PUBLISH_TASK_CHANGED: 'PUBLISH_TASK_CHANGED',
} as const

export type EventType = (typeof EventTypes)[keyof typeof EventTypes]

/** WORKER_STARTED 事件负载。 */
export interface WorkerStartedPayload {
  /** service worker 本次实例启动时间。 */
  workerStartedAt: number
  /** 是否为本次浏览器会话内首次启动（用于区分首启与被回收后重启）。 */
  firstStart: boolean
}

/** PING_RECEIVED 事件负载。 */
export interface PingReceivedPayload {
  nonce: string
  pingCount: number
  receivedAt: number
}

/** DEMO_TICK 事件负载。 */
export interface DemoTickPayload {
  /** 发布方自定义的消息内容。 */
  message: string
  /** 发布方时间戳。 */
  tick: number
}

// ---------------- 聊天只读层（P5） ----------------

/** CHAT_MESSAGE_INGESTED 事件负载（不含正文）。 */
export interface ChatMessageIngestedPayload {
  /** 解析出的聊天事件类型（message/sync/... ）。 */
  kind?: string
  /** 新增条数。 */
  added: number
  /** 去重覆盖条数。 */
  updated: number
}

/** CHAT_CONVERSATION_UPDATED 事件负载（不含正文）。 */
export interface ChatConversationUpdatedPayload {
  /** 本次新增/更新的会话数量。 */
  added: number
  /** 去重覆盖的会话数量。 */
  updated: number
}

/** CHAT_SYNC_COMPLETED 事件负载。 */
export interface ChatSyncCompletedPayload {
  /** 同步范围：历史消息或会话列表。 */
  scope: 'history' | 'conversations'
  ok: boolean
  added: number
  updated: number
  error?: { code: string; message: string }
}

/** CHAT_SOCKET_STATUS 事件负载。 */
export interface ChatSocketStatusPayload {
  status: 'connecting' | 'open' | 'closed' | 'error'
}

/** TASK_CHANGED 事件负载。 */
export interface TaskChangedPayload {
  /** 变更类型。 */
  eventType: 'created' | 'updated' | 'removed'
  /** 变更后的任务快照（`removed` 时为删除前数据）。 */
  task: Task
  /** 前一个状态（状态不变时可能缺省）。 */
  previousStatus?: TaskStatus
  /** 变更时间戳（毫秒）。 */
  timestamp: number
}

// ---------------- 聊天发送与 AI（P6） ----------------

/** CHAT_MESSAGE_SENT 事件负载（不含正文）。 */
export interface ChatMessageSentPayload {
  ok: boolean
  sessionId: string
  /** 发送成功时的消息标识（uuid）。 */
  messageId?: string
  /** 发送失败时的错误码。 */
  errorCode?: SendMessageErrorCode
}

/** CHAT_AUTO_REPLY_TRIGGERED 事件负载（不含正文）。 */
export interface ChatAutoReplyTriggeredPayload {
  sessionId: string
  ruleId: string
  ruleType: ReplyRuleType
  mode: ReplyMode
  ok: boolean
}

/** CHAT_AI_PAUSE_CHANGED 事件负载（与 AiPauseStatus 同构）。 */
export type ChatAiPauseChangedPayload = AiPauseStatus

/** CHAT_RULES_UPDATED 事件负载。 */
export interface ChatRulesUpdatedPayload {
  enabled: boolean
  mode: ReplyMode
  rulesCount: number
}

/** CHAT_REPLY_SUGGESTION_GENERATED 事件负载（不含建议正文 / 图片 URL / 凭据）。 */
export interface ChatReplySuggestionGeneratedPayload {
  sessionId: string
  /** 生成建议所用的消息 ID。 */
  messageId: string
  ruleId: string
  ruleType: ReplyRuleType
  /** 是否成功生成。 */
  ok: boolean
  /** 非敏感上下文摘要（条数 / 图片数 / 截断 / 是否有商品）。 */
  contextSummary: ReplyContextSummary
}

// ---------------- 运行时自动准备（P8） ----------------

/** 运行时状态变化原因。 */
export type RuntimeStatusChangeReason =
  | 'tab-created'
  | 'tab-ready'
  | 'tab-closed'
  | 'host-probe'
  | 'socket-status'
  | 'prepare-ok'
  | 'prepare-failed'

/** RUNTIME_STATUS_CHANGED 事件负载（不含用户 ID 值）。 */
export interface RuntimeStatusChangedPayload {
  reason: RuntimeStatusChangeReason
  tabReady: boolean
  /** 页面 MAIN world host 是否就绪（真实 probe/ping 成功）。 */
  hostReady: boolean
  socketStatus: 'connecting' | 'open' | 'closed' | 'error'
  userIdReady: boolean
}

/** PUBLISH_TASK_CHANGED 事件负载 */
export interface PublishTaskChangedPayload {
  /** 变更类型。 */
  eventType: 'created' | 'updated' | 'removed'
  /** 变更后的发布任务快照。 */
  task: PublishTask
  /** 前一个状态。 */
  previousStatus?: PublishTaskStatus
  /** 变更时间戳（毫秒）。 */
  timestamp: number
}

/** 事件 → 负载 映射。 */
export interface EventPayloadMap {
  [EventTypes.WORKER_STARTED]: WorkerStartedPayload
  [EventTypes.PING_RECEIVED]: PingReceivedPayload
  [EventTypes.DEMO_TICK]: DemoTickPayload
  [EventTypes.CHAT_MESSAGE_INGESTED]: ChatMessageIngestedPayload
  [EventTypes.CHAT_CONVERSATION_UPDATED]: ChatConversationUpdatedPayload
  [EventTypes.CHAT_SYNC_COMPLETED]: ChatSyncCompletedPayload
  [EventTypes.CHAT_SOCKET_STATUS]: ChatSocketStatusPayload
  [EventTypes.TASK_CHANGED]: TaskChangedPayload
  [EventTypes.CHAT_MESSAGE_SENT]: ChatMessageSentPayload
  [EventTypes.CHAT_AUTO_REPLY_TRIGGERED]: ChatAutoReplyTriggeredPayload
  [EventTypes.CHAT_AI_PAUSE_CHANGED]: ChatAiPauseChangedPayload
  [EventTypes.CHAT_RULES_UPDATED]: ChatRulesUpdatedPayload
  [EventTypes.CHAT_REPLY_SUGGESTION_GENERATED]: ChatReplySuggestionGeneratedPayload
  [EventTypes.RUNTIME_STATUS_CHANGED]: RuntimeStatusChangedPayload
  [EventTypes.PUBLISH_TASK_CHANGED]: PublishTaskChangedPayload
}
