/**
 * 聊天只读层（P5）的领域类型定义。
 *
 * 设计原则：
 * - 只描述「接收/读取」相关数据，不含发送、自动回复、AI 字段；
 * - 实时（WebSocket）与历史（LWP RPC）统一为同一套标准模型，靠 `source` 区分来源；
 * - 保留原始 ID（messageId / cid / senderId），但不含任何 Cookie、token、签名等敏感字段。
 */

/** 消息方向：`in` 表示对方发来，`out` 表示本账号发出。 */
export type ChatDirection = 'in' | 'out'

/** 消息内容类型（归一后的语义分类）。 */
export type ChatMessageKind =
  | 'text'
  | 'image'
  | 'voice'
  | 'item'
  | 'order'
  | 'system'
  | 'unknown'

/** 消息来源：实时推送或历史拉取。 */
export type ChatMessageSource = 'realtime' | 'history'

/**
 * 标准聊天消息。
 *
 * 由实时解析（parser.ts）与历史解析（history.ts）共同产出，写入 ChatStore 前结构一致。
 */
export interface ChatMessage {
  /** 去重键：优先使用 messageId，缺失时由 sessionId + 发送者 + 时间 + 内容合成。 */
  id: string
  /** 服务端原始消息 ID，可能为空字符串。 */
  messageId: string
  /** 会话 ID，已去掉 `@goofish` 等后缀。 */
  sessionId: string
  /** 原始会话 cid（形如 `123@goofish`），保留用于回写请求。 */
  cid: string
  /** 发送者用户 ID。 */
  senderId: string
  /** 发送者昵称。 */
  senderName: string
  /** 接收者用户 ID。 */
  receiverId: string
  /** 消息方向。 */
  direction: ChatDirection
  /** 归一后的内容类型。 */
  kind: ChatMessageKind
  /** 原始 contentType 数值（1/2/101 等），保留用于诊断。 */
  contentType: number
  /** 文本内容；图片消息为 `[图片]`。 */
  content: string
  /** 图片消息 URL（kind === 'image' 时可能存在）。 */
  imageUrl?: string
  /** 关联商品 ID。 */
  itemId?: string
  /** 关联商品标题（历史同步时可能补全）。 */
  itemTitle?: string
  /** 创建时间（毫秒时间戳）。 */
  createAt: number
  /** 已读状态（历史接口返回）。 */
  readStatus?: number
  /** 数据来源。 */
  source: ChatMessageSource
}

/** 标准会话（会话列表项）。 */
export interface Conversation {
  /** 会话 ID，已去掉 `@goofish` 后缀。 */
  sessionId: string
  /** 原始 cid。 */
  cid: string
  /** 对方用户 ID（若可从扩展信息中提取）。 */
  peerUserId?: string
  /** 对方用户名。 */
  peerUserName: string
  /** 最后一条消息摘要。 */
  lastMessage: string
  /** 最后一条消息时间（毫秒时间戳）。 */
  lastMessageTime: number
  /** 未读数量。 */
  unreadCount: number
  /** 排序索引（服务端 modifyTime / joinTime）。 */
  sortIndex: number
  /** 关联商品 ID。 */
  itemId?: string
  /** 是否可见。 */
  visible: boolean
}

// ---------------- 解析结果（结构化错误，绝不抛全局） ----------------

/** 解析错误码。 */
export type ParseErrorCode =
  | 'NOT_STRING'
  | 'EMPTY_INPUT'
  | 'NOT_JSON'
  | 'UNSUPPORTED_BODY'
  | 'DECODE_FAILED'

/** 结构化解析错误。 */
export interface ParseError {
  code: ParseErrorCode
  message: string
}

/**
 * 历史 / 会话同步的结构化错误。
 *
 * 与 {@link ParseError} 不同，`code` 不限于解析码：历史同步还可能因
 * LWP 业务错误、transport（无 tab / 超时 / 未登录）、持久化失败等返回结构化错误，
 * 这些码由各层归一后填充，供 Workbench 直接展示（message 已做脱敏 / 截断）。
 */
export interface SyncError {
  code: string
  message: string
}

/** 单次解析得到的聊天事件类型。 */
export type ChatEventKind = 'message' | 'sync' | 'order' | 'typing' | 'system' | 'unknown'

/** 解析成功时的事件负载。 */
export interface ParsedChatEvent {
  kind: ChatEventKind
  /** 归一后的聊天消息；非聊天事件（order/typing/system/unknown）为空数组。 */
  messages: ChatMessage[]
  /**
   * 原始解码对象，仅供内存内诊断使用。
   * 注意：可能含 base64 原文，禁止写入持久化存储或打印完整日志。
   */
  raw?: unknown
  /** 解析过程中的非致命提示（如缺字段、无法识别的分支）。 */
  notes?: string[]
}

/** 解析成功。 */
export interface ParseSuccess {
  ok: true
  event: ParsedChatEvent
}

/** 解析失败：调用方必须据此走错误分支，不得当作正常消息处理。 */
export interface ParseFailure {
  ok: false
  error: ParseError
  /** 已尽力解出的原始对象（可能为 undefined）。 */
  raw?: unknown
}

/** 解析结果。 */
export type ParseResult = ParseSuccess | ParseFailure

// ---------------- 分页结果 ----------------

/** 会话列表分页结果。 */
export interface ConversationPage {
  conversations: Conversation[]
  hasMore: boolean
  /** 下一页游标（maxSortIndex）；无更多时为 undefined。 */
  nextCursor?: number
}

/** 消息历史分页结果。 */
export interface MessagePage {
  messages: ChatMessage[]
  hasMore: boolean
  /** 下一页锚点（nextCursor）；无更多时为 0。 */
  nextCursor: number
}
