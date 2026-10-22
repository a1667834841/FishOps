/**
 * 会话列表与消息历史（P5 只读）。
 *
 * 迁移自 `chat` 分支 `inject/api/chat-history.js`，保留真实协议：
 * - 会话列表：`/r/Conversation/listNewestPagination`，body `[maxSortIndex, pageSize]`
 * - 消息历史：`/r/MessageManager/listUserMessages`，body `[cid, false, anchor, count, false]`
 * - 首次游标：`Number.MAX_SAFE_INTEGER`（9007199254740991）
 * - 请求/响应均为 LWP JSON envelope
 *
 * 边界：
 * - 通过可注入的 `ChatTransport` 收发，不直接依赖 `window` / `WebSocket`，因此可在 Node 中测试；
 * - 本模块只做「请求 / 读取」，不实现 sender（P6），不调用 AI；
 * - transport 由宿主提供：生产环境应转发到 MAIN world 里已建立的闲鱼 WebSocket，
 *   且必须只发送本文件构造的读取类 LWP 请求。
 */
import {
  createLwpRequest,
  DEFAULT_CONVERSATION_PAGE_SIZE,
  DEFAULT_MESSAGE_PAGE_SIZE,
  extractUrlParam,
  generateMid,
  INITIAL_CURSOR,
  isLwpSuccess,
  isRecord,
  LWP_REQUEST_TIMEOUT_MS,
  LWP_ROUTES,
  MIN_FETCH_INTERVAL_MS,
  splitCid,
  toFullCid,
  type LwpRequest,
  type LwpResponse,
} from '../../../shared/chat/index'
import type { Conversation, ConversationPage, MessagePage } from '../../../shared/types/chat'
import { extractAvatarUrl, normalizeUserId, parseHistoryMessageModel, type ParseContext } from './parser'

/** 传输层：由宿主注入，负责把 LWP 请求送到闲鱼 WebSocket 并取回响应。 */
export interface ChatTransport {
  send(request: LwpRequest, options?: { timeoutMs?: number }): Promise<LwpResponse>
}

/** 历史接口错误码。 */
export type ChatHistoryErrorCode = 'INVALID_SESSION' | 'LWP_ERROR' | 'INVALID_RESPONSE'

/** 历史接口结构化错误（由调用方 catch，不逃逸到全局）。 */
export class ChatHistoryError extends Error {
  readonly code: ChatHistoryErrorCode
  readonly raw?: unknown

  constructor(code: ChatHistoryErrorCode, message: string, raw?: unknown) {
    super(message)
    this.name = 'ChatHistoryError'
    this.code = code
    this.raw = raw
  }
}

/** 客户端选项。 */
export interface ChatHistoryClientOptions {
  transport: ChatTransport
  /** mid 生成器，可注入以便测试确定性；默认使用 `generateMid`。 */
  midFactory?: () => string
  /** 会话列表默认页大小。 */
  conversationPageSize?: number
  /** 消息历史默认页大小。 */
  messagePageSize?: number
  /** 分页之间的等待函数，可注入以便测试。 */
  sleep?: (ms: number) => Promise<void>
  /** 当前用户 ID，用于历史消息方向判断。 */
  myUserId?: string
}

/** 分页参数。 */
export interface ListConversationsParams {
  cursor?: number
  pageSize?: number
}

/** 消息历史参数。 */
export interface ListMessagesParams {
  cursor?: number
  count?: number
}

/** 取第一个有限数值（用于服务端排序字段的优先级回退）。 */
function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * 解析会话列表项为标准 Conversation。
 * 返回 null 表示该项缺 cid，调用方应跳过。
 *
 * cid 优先取 `singleChatUserConversation.cid`（会话实体自身），仅当缺失时才回退到
 * `lastMessage.message.cid`；排序索引优先取服务端 `sortIndex`，再回退 modifyTime / joinTime。
 */
export function parseConversationItem(item: unknown, myUserId?: string): Conversation | null {
  if (!isRecord(item)) return null
  const userConv = isRecord(item['singleChatUserConversation'])
    ? (item['singleChatUserConversation'] as Record<string, unknown>)
    : {}
  const lastMessage = isRecord(userConv['lastMessage'])
    ? (userConv['lastMessage'] as Record<string, unknown>)
    : {}
  const msg = isRecord(lastMessage['message']) ? (lastMessage['message'] as Record<string, unknown>) : {}

  const userConvCid = typeof userConv['cid'] === 'string' ? (userConv['cid'] as string) : ''
  const messageCid = typeof msg['cid'] === 'string' ? (msg['cid'] as string) : ''
  const { cid, sessionId } = splitCid(userConvCid || messageCid)
  if (!sessionId) return null

  const content = isRecord(msg['content']) ? (msg['content'] as Record<string, unknown>) : {}
  const custom = isRecord(content['custom']) ? (content['custom'] as Record<string, unknown>) : {}
  const extension = isRecord(msg['extension']) ? (msg['extension'] as Record<string, unknown>) : {}
  const sender = isRecord(msg['sender']) ? (msg['sender'] as Record<string, unknown>) : {}
  const reminderUrl = extension['reminderUrl']

  const modifyTime = typeof userConv['modifyTime'] === 'number' ? userConv['modifyTime'] : 0
  const joinTime = typeof userConv['joinTime'] === 'number' ? userConv['joinTime'] : 0
  // 优先服务端 sortIndex（可能在 userConv 或 item 上），再回退 modifyTime / joinTime。
  const serverSortIndex = firstFiniteNumber(userConv['sortIndex'], item['sortIndex'])
  const itemId = extractUrlParam(reminderUrl, 'itemId')
  const peerUserId = extractUrlParam(reminderUrl, 'peerUserId')

  // peer 识别优先使用明确 ID：当 `peerUserId` 明确指向当前用户本人时，绝不把它当作对方
  // （避免会话列表 peer 显示自己）。无法判定时保持原口径，不猜测、不编造。
  const selfId = normalizeUserId(myUserId)
  const explicitPeer = normalizeUserId(peerUserId)
  const peerIsSelf = selfId.length > 0 && explicitPeer.length > 0 && explicitPeer === selfId

  // 昵称来源：`reminderTitle` 是**最后一条消息发送者**的昵称，不能无条件当作对方昵称。
  // 最近消息发送者是 self 时，其昵称是本人，若直接当 peerUserName 会把自己显示成对方
  // （即便 `peerUserId` 指向对方）。因此仅当能**正向确认发送者就是对方**时才采用该昵称；
  // 发送者是本人、或归属未知（发送者字段缺失 / 无法判定）时一律不填，绝不猜测。
  const lastSenderId = normalizeUserId(extension['senderUserId']) || normalizeUserId(sender['uid'])
  const senderIsPeer = explicitPeer.length > 0 && lastSenderId.length > 0 && lastSenderId === explicitPeer
  const reminderTitle = typeof extension['reminderTitle'] === 'string' ? extension['reminderTitle'] : ''
  const peerUserName = peerIsSelf || !senderIsPeer ? '' : reminderTitle

  return {
    sessionId,
    cid,
    peerUserId: peerIsSelf ? undefined : peerUserId ?? undefined,
    peerUserName,
    // 消息扩展中的头像归属发送者；用户资料也必须按 ID 排除自己，不能按 owner 角色猜。
    peerAvatarUrl: peerIsSelf ? undefined : extractAvatarUrl([
      senderIsPeer ? extension : undefined,
      ...[userConv['userInfo'], userConv['ownerInfo']].filter(info => {
        if (!isRecord(info)) return false
        const id = normalizeUserId(info['userId'])
        return !!id && (explicitPeer ? id === explicitPeer : !!selfId && id !== selfId)
      }),
    ]),
    lastMessage: typeof custom['summary'] === 'string' ? custom['summary'] : '',
    lastMessageTime: typeof msg['createAt'] === 'number' ? msg['createAt'] : modifyTime,
    unreadCount: typeof userConv['redPoint'] === 'number' ? userConv['redPoint'] : 0,
    sortIndex: serverSortIndex ?? (modifyTime || joinTime),
    itemId: itemId ?? undefined,
    visible: userConv['visible'] !== false,
  }
}

/** 历史与会话客户端。 */
export class ChatHistoryClient {
  private readonly transport: ChatTransport
  private readonly midFactory: () => string
  private readonly conversationPageSize: number
  private readonly messagePageSize: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly parseCtx: ParseContext

  constructor(options: ChatHistoryClientOptions) {
    this.transport = options.transport
    this.midFactory = options.midFactory ?? (() => generateMid())
    this.conversationPageSize = options.conversationPageSize ?? DEFAULT_CONVERSATION_PAGE_SIZE
    this.messagePageSize = options.messagePageSize ?? DEFAULT_MESSAGE_PAGE_SIZE
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.parseCtx = { myUserId: options.myUserId }
  }

  /** 构造会话列表请求参数：`[maxSortIndex, pageSize]`。 */
  buildConversationListBody(cursor?: number, pageSize?: number): unknown[] {
    return [cursor ?? INITIAL_CURSOR, pageSize ?? this.conversationPageSize]
  }

  /** 构造消息历史请求参数：`[cid, false, anchor, count, false]`。 */
  buildMessageHistoryBody(sessionId: string, cursor?: number, count?: number): unknown[] {
    return [toFullCid(sessionId), false, cursor ?? INITIAL_CURSOR, count ?? this.messagePageSize, false]
  }

  /**
   * 动态更新当前登录用户 ID（用于 runtime 后置解析出登录态的场景）。
   *
   * 更新后同一客户端后续解析立即按新 ID 判定方向；已写入 store 的历史数据由 `ChatSync`
   * 负责重新归一（避免自己消息长期停留在 `in` / 左侧）。
   */
  setMyUserId(myUserId?: string): void {
    this.parseCtx.myUserId = myUserId
  }

  /** 构造完整的会话列表 LWP 请求信封（便于测试与诊断）。 */
  buildConversationListRequest(cursor?: number, pageSize?: number): LwpRequest {
    return createLwpRequest(LWP_ROUTES.listConversations, this.buildConversationListBody(cursor, pageSize), this.midFactory())
  }

  /** 构造完整的消息历史 LWP 请求信封。 */
  buildMessageHistoryRequest(sessionId: string, cursor?: number, count?: number): LwpRequest {
    if (!sessionId) throw new ChatHistoryError('INVALID_SESSION', 'sessionId 不能为空')
    return createLwpRequest(LWP_ROUTES.listMessages, this.buildMessageHistoryBody(sessionId, cursor, count), this.midFactory())
  }

  /** 获取一页会话列表。 */
  async listConversations(params: ListConversationsParams = {}): Promise<ConversationPage> {
    const request = this.buildConversationListRequest(params.cursor, params.pageSize)
    const body = await this.call(request)
    if (!isRecord(body)) throw new ChatHistoryError('INVALID_RESPONSE', '会话列表响应 body 非法', body)

    const rawItems = Array.isArray(body['userConvs']) ? (body['userConvs'] as unknown[]) : Array.isArray(body) ? (body as unknown[]) : []
    const conversations: Conversation[] = []
    for (const item of rawItems) {
      const conv = parseConversationItem(item, this.parseCtx.myUserId)
      if (conv) conversations.push(conv)
    }

    const pageSize = params.pageSize ?? this.conversationPageSize
    const hasMore =
      typeof body['hasMore'] === 'boolean'
        ? (body['hasMore'] as boolean)
        : typeof body['hasNextPage'] === 'boolean'
          ? (body['hasNextPage'] as boolean)
          : conversations.length >= pageSize

    const nextCursor = conversations.length > 0 ? conversations[conversations.length - 1].sortIndex : undefined
    return { conversations, hasMore, nextCursor }
  }

  /** 获取一页消息历史。 */
  async listMessageHistory(sessionId: string, params: ListMessagesParams = {}): Promise<MessagePage> {
    const count = params.count ?? this.messagePageSize
    const request = this.buildMessageHistoryRequest(sessionId, params.cursor, count)
    const body = await this.call(request)
    if (!isRecord(body)) throw new ChatHistoryError('INVALID_RESPONSE', '消息历史响应 body 非法', body)

    const rawModels = Array.isArray(body['userMessageModels']) ? (body['userMessageModels'] as unknown[]) : []
    const messages = rawModels
      .map((model) => parseHistoryMessageModel(model, this.parseCtx))
      .filter((m): m is NonNullable<typeof m> => m !== null)

    const nextCursor = typeof body['nextCursor'] === 'number' ? body['nextCursor'] : 0
    // 用原始模型数量判断是否还有更多，避免因部分模型无内容被跳过而提前停止。
    const hasMore = rawModels.length >= count && nextCursor > 0
    return { messages, hasMore, nextCursor }
  }

  /** 自动分页拉取会话列表（带请求间隔，避免限流）。 */
  async listAllConversations(maxPages = 10): Promise<Conversation[]> {
    const all: Conversation[] = []
    const seen = new Set<string>()
    let cursor: number | undefined
    for (let page = 0; page < maxPages; page++) {
      const result = await this.listConversations({ cursor })
      for (const conv of result.conversations) {
        if (seen.has(conv.sessionId)) continue
        seen.add(conv.sessionId)
        all.push(conv)
      }
      if (!result.hasMore || result.nextCursor === undefined) break
      cursor = result.nextCursor
      await this.sleep(MIN_FETCH_INTERVAL_MS)
    }
    return all
  }

  /** 自动分页拉取某会话的历史消息（带请求间隔，避免限流）。 */
  async listAllMessages(sessionId: string, maxPages = 10): Promise<MessagePage['messages']> {
    const all: MessagePage['messages'] = []
    const seen = new Set<string>()
    let cursor: number | undefined
    for (let page = 0; page < maxPages; page++) {
      const result = await this.listMessageHistory(sessionId, { cursor })
      for (const msg of result.messages) {
        if (seen.has(msg.id)) continue
        seen.add(msg.id)
        all.push(msg)
      }
      if (!result.hasMore || result.nextCursor <= 0) break
      cursor = result.nextCursor
      await this.sleep(MIN_FETCH_INTERVAL_MS)
    }
    return all
  }

  private async call(request: LwpRequest): Promise<unknown> {
    const response = await this.transport.send(request, { timeoutMs: LWP_REQUEST_TIMEOUT_MS })
    if (!isLwpSuccess(response.code)) {
      throw new ChatHistoryError(
        'LWP_ERROR',
        `LWP 请求失败: ${request.lwp} code=${String(response.code)} ${response.message ?? ''}`,
        response,
      )
    }
    return response.body ?? response
  }
}
