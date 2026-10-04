/**
 * 闲聊 LWP 协议常量与纯函数工具（P5 只读）。
 *
 * 严格对照 `chat` 分支真实协议：
 * - WebSocket URL：`wss://wss-goofish.dingtalk.com/`
 * - 会话路由：`/r/Conversation/listNewestPagination`
 * - 历史路由：`/r/MessageManager/listUserMessages`
 * - 分页初始游标：JavaScript 安全最大整数 `9007199254740991`
 * - 请求/响应使用 LWP JSON envelope：`{ lwp, headers: { mid }, body: [...] }`
 *
 * 本文件只做「请求构造 / 响应判定 / 解码」，不发送任何 WebSocket 数据、不访问网络。
 */

/** 闲鱼聊天 WebSocket 地址。 */
export const CHAT_WEBSOCKET_URL = 'wss://wss-goofish.dingtalk.com/'

/** 闲鱼聊天 WebSocket 主机名，用于拦截匹配。 */
export const CHAT_WEBSOCKET_HOST = 'wss-goofish.dingtalk.com'

/** LWP 路由常量。 */
export const LWP_ROUTES = {
  /** 会话列表（分页）。 */
  listConversations: '/r/Conversation/listNewestPagination',
  /** 指定会话的消息历史（分页）。 */
  listMessages: '/r/MessageManager/listUserMessages',
  /** 清除单个会话截至指定服务端消息的未读红点。 */
  clearRedPoint: '/r/Conversation/clearRedPoint',
} as const

/** 首次请求使用的分页游标：JavaScript 安全最大整数。 */
export const INITIAL_CURSOR = 9007199254740991

/** 会话列表默认每页条数。 */
export const DEFAULT_CONVERSATION_PAGE_SIZE = 20

/** 消息历史默认每页条数。 */
export const DEFAULT_MESSAGE_PAGE_SIZE = 20

/** 分页请求建议间隔（毫秒），避免触发限流。 */
export const MIN_FETCH_INTERVAL_MS = 300

/** LWP 请求默认超时（毫秒）。 */
export const LWP_REQUEST_TIMEOUT_MS = 15000

/** LWP 请求信封。 */
export interface LwpRequest {
  lwp: string
  headers: { mid: string }
  body: unknown[]
}

/** LWP 响应信封（字段宽松，允许透传未知字段）。 */
export interface LwpResponse {
  code?: number
  message?: string
  headers?: { mid?: string }
  body?: unknown
  [key: string]: unknown
}

/** 判断值是否为普通对象。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 判断 WebSocket URL 是否为闲鱼聊天连接。
 * 使用精确 hostname 比较（而非 `includes` 子串），避免误匹配相似域名。
 */
export function isTargetChatWebSocket(url: unknown): boolean {
  if (typeof url !== 'string' || url.length === 0) return false
  try {
    return new URL(url).hostname === CHAT_WEBSOCKET_HOST
  } catch {
    return false
  }
}

/**
 * 生成 LWP 请求的 mid。
 * 格式对照旧实现：`{0-999 随机数}{时间戳} 0`。
 */
export function generateMid(now: number = Date.now(), random: number = Math.random()): string {
  const randomPart = Math.floor(random * 1000)
  return `${randomPart}${now} 0`
}

/** 构造 LWP 请求信封。 */
export function createLwpRequest(lwp: string, body: unknown[], mid: string): LwpRequest {
  return { lwp, headers: { mid }, body }
}

/** LWP 成功码：200 或 0。 */
export function isLwpSuccess(code: unknown): boolean {
  return code === 200 || code === 0
}

/** 从 URL 中提取查询参数（如 peerUserId / sid / itemId）。 */
export function extractUrlParam(url: unknown, key: string): string | null {
  if (typeof url !== 'string' || url.length === 0) return null
  const match = url.match(new RegExp(`[?&]${key}=([^&]+)`))
  return match ? match[1] : null
}

/** 拆分 cid：`123@goofish` → { cid, sessionId: '123' }。 */
export function splitCid(cid: string): { cid: string; sessionId: string } {
  if (!cid) return { cid: '', sessionId: '' }
  const sessionId = cid.includes('@') ? cid.split('@')[0] : cid
  return { cid, sessionId }
}

/**
 * 把 cid 归一为带 `@goofish` 后缀的完整形式。
 * 旧实现写死了 `@goofish`，此处保持一致。
 */
export function toFullCid(sessionId: string): string {
  if (!sessionId) return ''
  return sessionId.includes('@') ? sessionId : `${sessionId}@goofish`
}

/**
 * base64 解码为 UTF-8 字符串。
 * 等价于旧实现的 `decodeURIComponent(escape(atob(x)))`，但使用 TextDecoder，避免依赖废弃的 `escape`。
 */
export function base64ToUtf8(base64: string): string {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

/** 安全版 base64 → UTF-8；失败返回 null，不抛错。 */
export function safeBase64ToUtf8(base64: unknown): string | null {
  if (typeof base64 !== 'string' || base64.length === 0) return null
  try {
    return base64ToUtf8(base64)
  } catch {
    return null
  }
}

/** 安全 JSON 解析；失败返回 null，不抛错。 */
export function safeJsonParse(text: unknown): unknown {
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/**
 * 计算消息去重键。
 * 优先使用服务端 messageId；缺失时用「会话 + 发送者 + 时间 + 内容」合成稳定指纹。
 * parser 与 store 共用同一函数，避免去重口径不一致。
 */
export function buildMessageKey(input: {
  messageId?: string
  sessionId?: string
  senderId?: string
  createAt?: number
  content?: string
}): string {
  if (input.messageId) return `mid:${input.messageId}`
  return `fp:${input.sessionId ?? ''}|${input.senderId ?? ''}|${input.createAt ?? 0}|${input.content ?? ''}`
}
