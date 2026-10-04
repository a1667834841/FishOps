/**
 * 聊天消息解析器（P5 只读）。
 *
 * 迁移自 `chat` 分支 `inject/chat-parser.js`，职责：
 * 1. MessagePack / base64 / JSON 兼容解码；
 * 2. 实时 WebSocket 消息解析（chat / order / typing / system / sync）；
 * 3. 历史 LWP 消息（userMessageModel）解析；
 * 4. 统一产出标准 `ChatMessage`。
 *
 * 边界：
 * - 只解析、不改写、不发送、不调用 AI；
 * - 所有对外函数对异常输入返回结构化 `ParseResult`/`null`，绝不把错误抛到全局，
 *   也绝不把解析失败「静默」成一条正常消息。
 */
import {
  buildMessageKey,
  extractUrlParam,
  isRecord,
  safeBase64ToUtf8,
  safeJsonParse,
  splitCid,
} from '../../../shared/chat/index'
import type {
  ChatDirection,
  ChatEventKind,
  ChatMessage,
  ChatMessageKind,
  ParseError,
  ParseErrorCode,
  ParseResult,
  ParsedChatEvent,
} from '../../../shared/types/chat'

/** 解析上下文。 */
export interface ParseContext {
  /** 当前登录账号的用户 ID，用于判断消息方向（in/out）。缺失时实时消息默认 in。 */
  myUserId?: string
}

/**
 * 归一用户 ID：去掉 `@goofish` 等会话后缀，仅保留 ID 本体（与 `splitCid` 同口径）。
 *
 * 平台在 `senderUserId` / `sender.uid` 等字段有时携带 `@goofish` 后缀，而当前用户 ID
 * （`platform.currentUserId`）是纯 ID。两者直接比较会失配，导致本人消息被误判为 `in`
 * （左侧）。本函数统一两侧形态，保证方向判定可靠。
 *
 * 非字符串 / 空串 / 仅后缀时返回空串；**不猜测、不编造**。
 */
export function normalizeUserId(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  const at = trimmed.indexOf('@')
  const body = at >= 0 ? trimmed.slice(0, at) : trimmed
  return body.trim()
}

// ==================== MessagePack 解码 ====================

/**
 * 最小 MessagePack 解码器。
 * 移植自旧实现，覆盖闲鱼实际出现的类型；遇到未知字节 / 越界 / 未完整消费时抛错，
 * 由调用方（decodeMessagePackBase64）捕获并归一为结构化失败（返回 null）。
 */
export class MessagePackDecoder {
  private readonly view: DataView
  private offset = 0

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer)
  }

  /** 解码并返回根值；必须完整消费 buffer，否则抛错（避免把截断数据当成合法结果）。 */
  decode(): unknown {
    const value = this.parse()
    if (this.offset !== this.view.byteLength) {
      throw new Error(`MessagePack 未完整消费 buffer：已读 ${this.offset}/${this.view.byteLength}`)
    }
    return value
  }

  private parse(): unknown {
    const byte = this.view.getUint8(this.offset++)

    if (byte <= 0x7f) return byte
    if (byte >= 0x80 && byte <= 0x8f) return this.parseMap(byte - 0x80)
    if (byte >= 0x90 && byte <= 0x9f) return this.parseArray(byte - 0x90)
    if (byte >= 0xa0 && byte <= 0xbf) return this.parseString(byte - 0xa0)
    if (byte === 0xc0) return null
    if (byte === 0xc2) return false
    if (byte === 0xc3) return true

    if (byte === 0xc4) return this.parseBytes(this.view.getUint8(this.offset++))
    if (byte === 0xc5) {
      const len = this.view.getUint16(this.offset)
      this.offset += 2
      return this.parseBytes(len)
    }
    if (byte === 0xc6) {
      const len = this.view.getUint32(this.offset)
      this.offset += 4
      return this.parseBytes(len)
    }
    if (byte === 0xca) {
      const val = this.view.getFloat32(this.offset)
      this.offset += 4
      return val
    }
    if (byte === 0xcb) {
      const val = this.view.getFloat64(this.offset)
      this.offset += 8
      return val
    }
    if (byte === 0xcc) return this.view.getUint8(this.offset++)
    if (byte === 0xcd) {
      const val = this.view.getUint16(this.offset)
      this.offset += 2
      return val
    }
    if (byte === 0xce) {
      const val = this.view.getUint32(this.offset)
      this.offset += 4
      return val
    }
    if (byte === 0xcf) {
      const val = this.view.getBigUint64(this.offset)
      this.offset += 8
      // 超出安全整数范围时保留字符串，避免静默损失精度（如大 ID）。
      return bigIntToSafeValue(val)
    }
    if (byte === 0xd0) return this.view.getInt8(this.offset++)
    if (byte === 0xd1) {
      const val = this.view.getInt16(this.offset)
      this.offset += 2
      return val
    }
    if (byte === 0xd2) {
      const val = this.view.getInt32(this.offset)
      this.offset += 4
      return val
    }
    if (byte === 0xd3) {
      const val = this.view.getBigInt64(this.offset)
      this.offset += 8
      return bigIntToSafeValue(val)
    }
    if (byte === 0xd9) return this.parseString(this.view.getUint8(this.offset++))
    if (byte === 0xda) {
      const len = this.view.getUint16(this.offset)
      this.offset += 2
      return this.parseString(len)
    }
    if (byte === 0xdb) {
      const len = this.view.getUint32(this.offset)
      this.offset += 4
      return this.parseString(len)
    }
    if (byte === 0xdc) {
      const len = this.view.getUint16(this.offset)
      this.offset += 2
      return this.parseArray(len)
    }
    if (byte === 0xdd) {
      const len = this.view.getUint32(this.offset)
      this.offset += 4
      return this.parseArray(len)
    }
    if (byte === 0xde) {
      const len = this.view.getUint16(this.offset)
      this.offset += 2
      return this.parseMap(len)
    }
    if (byte === 0xdf) {
      const len = this.view.getUint32(this.offset)
      this.offset += 4
      return this.parseMap(len)
    }
    if (byte >= 0xe0) return byte - 256

    throw new Error(`MessagePack 未知字节 0x${byte.toString(16)} @ ${this.offset - 1}`)
  }

  private parseString(length: number): string {
    const bytes = new Uint8Array(this.view.buffer, this.offset, length)
    this.offset += length
    return new TextDecoder('utf-8').decode(bytes)
  }

  private parseBytes(length: number): Uint8Array {
    const bytes = new Uint8Array(this.view.buffer, this.offset, length)
    this.offset += length
    return bytes
  }

  private parseArray(length: number): unknown[] {
    const arr: unknown[] = []
    for (let i = 0; i < length; i++) arr.push(this.parse())
    return arr
  }

  private parseMap(length: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    for (let i = 0; i < length; i++) {
      const key = this.parse()
      const value = this.parse()
      // 用 defineProperty 写自有属性：key 为 `__proto__` 时不会触发原型 setter，避免原型污染。
      Object.defineProperty(obj, String(key), { value, writable: true, enumerable: true, configurable: true })
    }
    return obj
  }
}

/**
 * 64 位整数 → JS 值：安全整数范围内返回 number，超出时返回十进制字符串保留精度。
 */
function bigIntToSafeValue(value: bigint): number | string {
  if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value)
  }
  return value.toString()
}

/** base64 → MessagePack 解码；失败返回 null，不抛错。 */
export function decodeMessagePackBase64(base64: string): unknown | null {
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new MessagePackDecoder(bytes.buffer).decode()
  } catch {
    return null
  }
}

/**
 * 兼容解码：优先 MessagePack，失败再尝试 base64 → JSON 文本。
 * 只有当 MessagePack 解出「结构化值（对象/数组）」时才直接采用，避免把 JSON 文本
 * 誤读为单个 MessagePack 整数（JSON 首字节 `{` = 0x7b 会被当成 positive fixint）。
 * 返回 null 表示两种方式都无法解析。
 */
export function decodeChatData(base64Data: unknown): unknown | null {
  if (typeof base64Data !== 'string' || base64Data.length === 0) return null
  const cleaned = base64Data.trim()

  const msgPack = decodeMessagePackBase64(cleaned)
  if (msgPack !== null && typeof msgPack === 'object') return msgPack

  const text = safeBase64ToUtf8(cleaned)
  const json = text === null ? null : safeJsonParse(text)
  if (json !== null && json !== undefined) return json

  return msgPack
}

// ==================== 类型判断 ====================

/** 判断是否是订单消息（旧结构：`data['3'].redReminder`）。 */
export function isOrderPayload(data: unknown): boolean {
  if (!isRecord(data)) return false
  const three = data['3']
  return isRecord(three) && Boolean(three['redReminder'])
}

/** 判断是否是系统通知（旧结构：`data['3'].systemNotice`）。 */
export function isSystemPayload(data: unknown): boolean {
  if (!isRecord(data)) return false
  const three = data['3']
  return isRecord(three) && Boolean(three['systemNotice'])
}

/** 判断是否是「正在输入」状态。 */
export function isTypingPayload(data: unknown): boolean {
  if (!isRecord(data)) return false
  const one = data['1']
  if (!Array.isArray(one) || one.length === 0) return false
  const first = one[0]
  if (!isRecord(first)) return false
  const inner = first['1']
  return typeof inner === 'string' && inner.includes('@goofish')
}

/** 判断是否是聊天消息（旧结构：`data['1']['10'].reminderContent`）。 */
export function isChatPayload(data: unknown): boolean {
  if (!isRecord(data)) return false
  const one = data['1']
  if (!isRecord(one)) return false
  const ten = one['10']
  return isRecord(ten) && Boolean(ten['reminderContent'])
}

/** 判断解码后数据的消息类型。 */
export function classifyPayload(data: unknown): ChatEventKind {
  if (!isRecord(data)) return 'unknown'
  if (isOrderPayload(data)) return 'order'
  if (isTypingPayload(data)) return 'typing'
  if (isSystemPayload(data)) return 'system'
  if (isChatPayload(data)) return 'message'
  return 'unknown'
}

// ==================== 标准消息构建 ====================

/** 内容类型 → 语义类型。 */
function kindFromContentType(contentType: number, hasImage: boolean, hasContent: boolean): ChatMessageKind {
  if (hasImage || contentType === 2) return 'image'
  if (contentType === 1 || contentType === 101) return 'text'
  if (contentType === 3) return 'voice'
  if (contentType === 4) return 'item'
  if (contentType === 5) return 'order'
  return hasContent ? 'text' : 'unknown'
}

/** 根据发送者与当前用户判断方向（两侧均归一后比较，容忍 @goofish 后缀）。 */
export function directionFor(senderId: string, myUserId?: string): ChatDirection {
  const sender = normalizeUserId(senderId)
  const me = normalizeUserId(myUserId)
  if (me && sender && sender === me) return 'out'
  return 'in'
}

/**
 * 按当前用户 ID 纠正单条消息方向（仅 `in → out`，绝不降级）。
 *
 * - 仅当发送者明确匹配当前用户时升级为 `out`（不猜测）；
 * - 已确认的 `out` 一律保留，避免破坏本地发送回显 / 平台回声；
 * - history 来源的 `out` 消息回填 `receiverId` 为会话对方；实时来源保留原有接收者。
 *
 * 返回 `null` 表示无需变更（调用方可据此避免无效写入）。
 */
export function correctMessageDirection(message: ChatMessage, myUserId?: string): ChatMessage | null {
  if (!myUserId) return null
  if (message.direction === 'out') return null
  if (directionFor(message.senderId, myUserId) !== 'out') return null
  return {
    ...message,
    direction: 'out',
    receiverId: message.source === 'history' ? message.sessionId : message.receiverId,
  }
}

interface BuildMessageInput {
  messageId?: string
  cid: string
  /** 显式 sessionId（优先于从 cid 拆分），用于 cid 与 provider 会话 ID 不一致的场景。 */
  sessionId?: string
  senderId?: string
  senderName?: string
  senderAvatarUrl?: string
  receiverId?: string
  direction?: ChatDirection
  contentType?: number
  content?: string
  imageUrl?: string
  itemId?: string
  itemTitle?: string
  createAt?: number
  readStatus?: number
  source: ChatMessage['source']
  myUserId?: string
}

/** 由归一字段构建标准 ChatMessage（不导出，内部使用）。 */
function makeMessage(input: BuildMessageInput): ChatMessage {
  const split = splitCid(input.cid)
  const cid = split.cid
  const sessionId = input.sessionId ?? split.sessionId
  const content = input.content ?? ''
  const imageUrl = input.imageUrl && input.imageUrl.length > 0 ? input.imageUrl : undefined
  const contentType = typeof input.contentType === 'number' ? input.contentType : 0
  const senderId = normalizeUserId(input.senderId)
  const messageId = input.messageId ?? ''
  return {
    id: buildMessageKey({ messageId, sessionId, senderId, createAt: input.createAt, content }),
    messageId,
    sessionId,
    cid,
    senderId,
    senderName: input.senderName ?? '',
    senderAvatarUrl: input.senderAvatarUrl && input.senderAvatarUrl.length > 0 ? input.senderAvatarUrl : undefined,
    receiverId: normalizeUserId(input.receiverId),
    direction: input.direction ?? directionFor(senderId, input.myUserId),
    kind: kindFromContentType(contentType, Boolean(imageUrl), content.length > 0),
    contentType,
    content,
    imageUrl,
    itemId: input.itemId && input.itemId.length > 0 ? input.itemId : undefined,
    itemTitle: input.itemTitle && input.itemTitle.length > 0 ? input.itemTitle : undefined,
    createAt: input.createAt ?? 0,
    readStatus: input.readStatus,
    source: input.source,
  }
}

/**
 * 头像字段候选键名。
 *
 * 真实平台头像字段是 `logo`：出现在 mtop `taobao.idlemessage.pc.user.query` 的
 * `data.userInfo.logo`，以及 `taobao.idlemessage.pc.session.sync` 的
 * `ownerInfo.logo` / `userInfo.logo`。调用方需把承载它的 `userInfo` / `ownerInfo`
 * 对象作为来源传入。
 *
 * 故意**不包含** `picUrl`：它是商品封面（`picInfo.picUrl`，旧采集 / 发布链路使用），
 * 混入候选会把商品图渲染成用户头像。
 */
const AVATAR_URL_KEYS = ['avatarUrl', 'avatar', 'logo', 'headUrl', 'headImg', 'portrait', 'iconUrl'] as const

/** 校验并规范化 https 图片 URL；带账号密码、非 https 或非法地址一律返回 undefined。 */
export function toSafeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return undefined
  return url.href
}

/**
 * 从若干原始对象中尽力提取头像 URL。
 *
 * 仅返回通过 https 白名单校验的地址，绝不用昵称等其它字段拼造；
 * 所有候选来源都拿不到时返回 undefined，由界面回退字母头像。
 */
export function extractAvatarUrl(sources: readonly unknown[]): string | undefined {
  for (const source of sources) {
    if (!isRecord(source)) continue
    for (const key of AVATAR_URL_KEYS) {
      const url = toSafeHttpsUrl(source[key])
      if (url) return url
    }
  }
  return undefined
}

/** 从自定义内容 JSON 中提取图片 URL（兼容多种旧格式）。 */
function extractImageUrlFromJson(parsed: unknown): string {
  if (!isRecord(parsed)) return ''
  const image = parsed['image']
  if (isRecord(image)) {
    const pics = image['pics']
    if (Array.isArray(pics) && pics.length > 0 && isRecord(pics[0])) {
      const url = pics[0]['url']
      if (typeof url === 'string') return url
    }
  }
  for (const key of ['url', 'imgUrl', 'imageUrl']) {
    const value = parsed[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/** 从解析后的内容 JSON 中提取文本。 */
function extractTextFromJson(parsed: unknown): string {
  if (!isRecord(parsed)) return ''
  const text = parsed['text']
  if (isRecord(text) && typeof text['text'] === 'string') return text['text']
  if (typeof parsed === 'string') return parsed
  return ''
}

/** 解析 custom.data 得到文本/图片/内容类型。 */
interface DecodedCustom {
  content: string
  contentType: number
  imageUrl: string
}

function parseCustomData(custom: Record<string, unknown>): DecodedCustom {
  const rawType = typeof custom['contentType'] === 'number' ? custom['contentType'] : custom['type']
  const typeAsNumber = typeof rawType === 'number' ? rawType : 0
  let contentType = typeAsNumber
  let content = typeof custom['summary'] === 'string' ? custom['summary'] : ''
  let imageUrl = ''

  const rawData = typeof custom['data'] === 'string' ? custom['data'] : undefined
  if (rawData) {
    const decodedText = safeBase64ToUtf8(rawData)
    const parsed = decodedText === null ? null : safeJsonParse(decodedText)
    if (parsed !== null) {
      const parsedType =
        isRecord(parsed) && typeof parsed['contentType'] === 'number'
          ? (parsed['contentType'] as number)
          : isRecord(parsed) && typeof parsed['type'] === 'number'
            ? (parsed['type'] as number)
            : 0
      const isImage = contentType === 2 || parsedType === 2
      if (isImage) {
        contentType = 2
        imageUrl = extractImageUrlFromJson(parsed)
        if (!content) content = '[图片]'
      } else {
        if (!contentType && parsedType) contentType = parsedType
        const text = extractTextFromJson(parsed)
        if (text) content = text
        else if (typeof parsed === 'string' && !content) content = parsed
      }
    }
  }

  return { content, contentType, imageUrl }
}

// ==================== 实时消息解析 ====================

/** 解析单个「对象型」sync 项（已解码对象）。 */
function handleObjectData(data: Record<string, unknown>, ctx: ParseContext): { message?: ChatMessage; note?: string } {
  if (isOrderPayload(data)) return { note: '订单消息（P5 不存储）' }
  if (isTypingPayload(data)) return { note: '正在输入状态（P5 不存储）' }
  if (isSystemPayload(data)) return { note: '系统通知（P5 不存储）' }
  if (!isChatPayload(data)) return { note: '未识别的对象型消息' }

  const one = data['1'] as Record<string, unknown>
  const chatInfo = one['10'] as Record<string, unknown>
  const reminderUrl = chatInfo['reminderUrl']
  const receiverRaw = typeof one['2'] === 'string' ? one['2'] : ''
  const receiverSession = splitCid(receiverRaw).sessionId

  const message = makeMessage({
    messageId: typeof one['3'] === 'string' ? one['3'] : '',
    cid: receiverRaw || String(chatInfo['reminderUrl'] ?? ''),
    // 会话 ID 优先取自 reminderUrl.sid（与页面会话列表一致），回退到接收人
    sessionId: extractUrlParam(reminderUrl, 'sid') ?? receiverSession,
    senderId: normalizeUserId(chatInfo['senderUserId']),
    senderName: typeof chatInfo['reminderTitle'] === 'string' ? chatInfo['reminderTitle'] : '',
    senderAvatarUrl: extractAvatarUrl([chatInfo]),
    receiverId: receiverSession,
    contentType: 101,
    content: typeof chatInfo['reminderContent'] === 'string' ? chatInfo['reminderContent'] : '',
    itemId: extractUrlParam(reminderUrl, 'itemId') ?? '',
    createAt: typeof one['5'] === 'number' ? one['5'] : 0,
    source: 'realtime',
    myUserId: ctx.myUserId,
  })
  return { message }
}

/** 解析单个「base64 字符串型」sync 项。 */
function handleStringData(base64Data: string, ctx: ParseContext): { message?: ChatMessage; note?: string } {
  const decoded = decodeChatData(base64Data)
  if (decoded === null) return { note: 'DECODE_FAILED：无法解码的 sync 数据' }
  if (!isChatPayload(decoded)) return { note: '非聊天类型的 sync 数据' }

  const chatData = (decoded as Record<string, unknown>)['1'] as Record<string, unknown>
  const contentData = chatData['10'] as Record<string, unknown>
  const messageData = isRecord(chatData['6']) ? (chatData['6'] as Record<string, unknown>) : {}

  // chatData['6']['3']['5'] 内是 JSON 字符串（文本/图片内容）
  let content = ''
  let contentType = 101
  let imageUrl = ''
  const innerThree = isRecord(messageData['3']) ? (messageData['3'] as Record<string, unknown>) : {}
  const rawContent = typeof innerThree['5'] === 'string' ? innerThree['5'] : ''
  if (rawContent) {
    const parsed = safeJsonParse(rawContent)
    if (parsed !== null) {
      const isImage = isRecord(parsed) && (parsed['contentType'] === 2 || parsed['type'] === 2)
      if (isImage) {
        contentType = 2
        content = '[图片]'
        imageUrl = extractImageUrlFromJson(parsed)
      } else {
        contentType = isRecord(parsed) && typeof parsed['contentType'] === 'number' ? parsed['contentType'] : 101
        content = extractTextFromJson(parsed)
      }
    } else {
      content = rawContent
    }
  } else {
    content = typeof contentData['reminderContent'] === 'string' ? contentData['reminderContent'] : ''
  }

  // 图片消息兜底：从 custom.data 再取一次 URL
  if (contentType === 2 && !imageUrl) {
    const custom = isRecord(contentData['custom']) ? (contentData['custom'] as Record<string, unknown>) : {}
    const rawData = typeof custom['data'] === 'string' ? custom['data'] : ''
    if (rawData) {
      if (rawData.startsWith('http') || rawData.startsWith('data:image')) {
        imageUrl = rawData
      } else {
        const decodedData = safeBase64ToUtf8(rawData)
        const parsedData = decodedData === null ? null : safeJsonParse(decodedData)
        imageUrl = extractImageUrlFromJson(parsedData)
      }
    }
  }

  const reminderUrl = contentData['reminderUrl']
  const peerUserId = extractUrlParam(reminderUrl, 'peerUserId') ?? ''
  const senderFromChat = normalizeUserId(chatData['1'])
  const senderId =
    normalizeUserId(contentData['senderUserId']) || senderFromChat || normalizeUserId(peerUserId)
  const receiverRaw = typeof chatData['2'] === 'string' ? (chatData['2'] as string) : ''

  const message = makeMessage({
    messageId: typeof chatData['3'] === 'string' ? chatData['3'] : '',
    cid: receiverRaw || senderFromChat,
    // 会话 ID 优先取自 reminderUrl.sid，回退到发送者/接收人
    sessionId: extractUrlParam(reminderUrl, 'sid') ?? splitCid(receiverRaw).sessionId,
    senderId,
    senderName: typeof contentData['reminderTitle'] === 'string' ? contentData['reminderTitle'] : '',
    senderAvatarUrl: extractAvatarUrl([contentData]),
    receiverId: splitCid(receiverRaw).sessionId,
    contentType,
    content,
    imageUrl,
    itemId: extractUrlParam(reminderUrl, 'itemId') ?? '',
    createAt: typeof chatData['5'] === 'number' ? chatData['5'] : 0,
    source: 'realtime',
    myUserId: ctx.myUserId,
  })
  return { message }
}

/** 解析同步推送包（syncPushPackage.data）。 */
function parseSyncData(items: unknown[], raw: unknown, ctx: ParseContext): ParseResult {
  const messages: ChatMessage[] = []
  const notes: string[] = []
  items.forEach((item, index) => {
    if (!isRecord(item)) {
      notes.push(`sync[${index}] 不是对象`)
      return
    }
    const data = item['data']
    const outcome =
      isRecord(data) ? handleObjectData(data, ctx) : typeof data === 'string' ? handleStringData(data, ctx) : null
    if (!outcome) {
      notes.push(`sync[${index}] 缺少可解析的 data`)
      return
    }
    if (outcome.message) messages.push(outcome.message)
    if (outcome.note) notes.push(outcome.note)
  })

  const event: ParsedChatEvent = {
    kind: 'sync',
    messages,
    raw,
    notes: notes.length > 0 ? notes : undefined,
  }
  return { ok: true, event }
}

/** 解析实时普通消息体（body.content / body.extension）。 */
function parseRealtimeBody(body: Record<string, unknown>, ctx: ParseContext): ParseResult {
  const extension = isRecord(body['extension']) ? (body['extension'] as Record<string, unknown>) : {}
  const content = isRecord(body['content']) ? (body['content'] as Record<string, unknown>) : {}
  const custom = isRecord(content['custom']) ? (content['custom'] as Record<string, unknown>) : {}
  const decoded = parseCustomData(custom)
  const reminderUrl = extension['reminderUrl']

  const content_ = decoded.content || (typeof custom['summary'] === 'string' ? custom['summary'] : '')
  const message = makeMessage({
    messageId: typeof body['messageId'] === 'string' ? body['messageId'] : '',
    cid: (extractUrlParam(reminderUrl, 'sid') ?? '') || (typeof extension['sessionId'] === 'string' ? extension['sessionId'] : ''),
    sessionId: extractUrlParam(reminderUrl, 'sid') ?? undefined,
    senderId: normalizeUserId(extension['senderUserId']),
    senderName: typeof extension['reminderTitle'] === 'string' ? extension['reminderTitle'] : '',
    senderAvatarUrl: extractAvatarUrl([extension]),
    receiverId: normalizeUserId(extractUrlParam(reminderUrl, 'peerUserId') ?? ctx.myUserId),
    contentType: decoded.contentType,
    content: content_,
    imageUrl: decoded.imageUrl,
    itemId: extractUrlParam(reminderUrl, 'itemId') ?? '',
    createAt: typeof body['createAt'] === 'number' ? body['createAt'] : 0,
    source: 'realtime',
    myUserId: ctx.myUserId,
  })

  if (!message.content && !message.imageUrl) {
    return {
      ok: true,
      event: { kind: 'unknown', messages: [], raw: body, notes: ['body 无法解析出有效内容'] },
    }
  }
  return { ok: true, event: { kind: 'message', messages: [message], raw: body } }
}

/**
 * 解析一条实时 WebSocket 文本消息。
 * 心跳/确认帧与不可识别结构以 `kind: 'unknown'` + notes 返回；真正的解码失败返回 `ok: false`。
 */
export function parseWebSocketMessage(raw: unknown, ctx: ParseContext = {}): ParseResult {
  if (typeof raw !== 'string') return fail('NOT_STRING', 'WebSocket 消息不是字符串')
  if (raw.trim().length === 0) return fail('EMPTY_INPUT', 'WebSocket 消息为空')

  const parsed = safeJsonParse(raw)
  if (parsed === null || !isRecord(parsed)) {
    return fail('NOT_JSON', 'WebSocket 消息不是合法 JSON 对象')
  }

  const body = parsed['body']
  if (!isRecord(body)) {
    // 心跳/确认帧：code 200 且无 body。显式标记 unknown，不当作正常消息。
    return {
      ok: true,
      event: { kind: 'unknown', messages: [], raw: parsed, notes: ['响应无 body（可能是心跳或确认帧）'] },
    }
  }

  const syncPush = body['syncPushPackage']
  if (isRecord(syncPush) && Array.isArray(syncPush['data'])) {
    return parseSyncData(syncPush['data'] as unknown[], parsed, ctx)
  }

  if (isRecord(body['content']) || isRecord(body['extension'])) {
    return parseRealtimeBody(body, ctx)
  }

  return {
    ok: true,
    event: { kind: 'unknown', messages: [], raw: parsed, notes: ['未识别的 body 结构'] },
  }
}

// ==================== 历史消息解析 ====================

/** 从 reminderUrl / extension.itemId / dxCard 中提取商品信息。 */
function extractHistoryItem(
  extension: Record<string, unknown>,
  rawData: string | undefined,
): { itemId: string; itemTitle: string } {
  let itemId = ''
  let itemTitle = ''

  const url = extension['reminderUrl']
  itemId = extractUrlParam(url, 'itemId') ?? ''
  if (!itemId && typeof extension['itemId'] === 'string') itemId = extension['itemId']

  if (rawData) {
    const decoded = safeBase64ToUtf8(rawData)
    const card = decoded === null ? null : safeJsonParse(decoded)
    if (isRecord(card)) {
      const dxCard = card['dxCard']
      if (isRecord(dxCard) && isRecord(dxCard['item']) && isRecord((dxCard['item'] as Record<string, unknown>)['main'])) {
        const main = (dxCard['item'] as Record<string, unknown>)['main'] as Record<string, unknown>
        if (!itemId && typeof main['targetUrl'] === 'string') {
          const match = (main['targetUrl'] as string).match(/item\.htm\?id=(\d+)/)
          if (match) itemId = match[1]
        }
        if (typeof main['title'] === 'string') itemTitle = main['title']
      }
    }
  }

  return { itemId, itemTitle }
}

/**
 * 解析历史 LWP 消息模型（`userMessageModel`）。
 * 返回 null 表示该条无有效内容，调用方应跳过（不视为致命错误）。
 */
export function parseHistoryMessageModel(model: unknown, ctx: ParseContext = {}): ChatMessage | null {
  if (!isRecord(model)) return null
  const msg = model['message']
  if (!isRecord(msg)) return null

  const cidRaw = typeof msg['cid'] === 'string' ? (msg['cid'] as string) : ''
  const { sessionId } = splitCid(cidRaw)
  const extension = isRecord(msg['extension']) ? (msg['extension'] as Record<string, unknown>) : {}

  // 发送者：`senderUserId` / `sender.uid` 可能带 `@goofish` 后缀，统一归一为本体。
  const sender = isRecord(msg['sender']) ? (msg['sender'] as Record<string, unknown>) : {}
  let senderId = normalizeUserId(extension['senderUserId'])
  if (!senderId) senderId = normalizeUserId(sender['uid'])
  const senderName = typeof extension['reminderTitle'] === 'string' ? extension['reminderTitle'] : '未知用户'

  // 内容
  const contentObj = isRecord(msg['content']) ? (msg['content'] as Record<string, unknown>) : {}
  const custom = isRecord(contentObj['custom']) ? (contentObj['custom'] as Record<string, unknown>) : {}
  const decoded = parseCustomData(custom)
  let content = decoded.content
  let contentType = decoded.contentType
  let imageUrl = decoded.imageUrl

  // 补充：直接解析 rawData 里的 text
  if (!content && typeof custom['data'] === 'string') {
    const text = safeBase64ToUtf8(custom['data'])
    const parsed = text === null ? null : safeJsonParse(text)
    const extracted = extractTextFromJson(parsed)
    if (extracted) content = extracted
  }
  if (!contentType && typeof custom['type'] === 'number') contentType = custom['type']

  const { itemId, itemTitle } = extractHistoryItem(
    extension,
    typeof custom['data'] === 'string' ? custom['data'] : undefined,
  )

  if (!content && !imageUrl) return null

  const direction = directionFor(senderId, ctx.myUserId)
  const receiverId = direction === 'out' ? sessionId : normalizeUserId(ctx.myUserId)

  return makeMessage({
    messageId: typeof msg['messageId'] === 'string' ? msg['messageId'] : '',
    cid: cidRaw,
    senderId,
    senderName,
    senderAvatarUrl: extractAvatarUrl([extension, sender]),
    receiverId,
    direction,
    contentType,
    content,
    imageUrl,
    itemId,
    itemTitle,
    createAt: typeof msg['createAt'] === 'number' ? msg['createAt'] : 0,
    readStatus: typeof model['readStatus'] === 'number' ? model['readStatus'] : undefined,
    source: 'history',
    myUserId: ctx.myUserId,
  })
}

// ==================== 内部工具 ====================

function fail(code: ParseErrorCode, message: string): ParseResult {
  const error: ParseError = { code, message }
  return { ok: false, error }
}
