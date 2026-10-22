import { isChatMessage, type ChatMessage } from '../../../packages/protocol/src/chat.ts'
import { isChatSyncPageParams, validateResult, type ChatSyncPageParams, type ChatSyncPageResult, type ChatSyncConversation } from '../../../packages/protocol/src/chat-sync.ts'
import { ApiError } from './errors.ts'

const fail = (): never => { throw new ApiError('PAGE_NOT_READY', '聊天同步页结构或分页证据无效', { phase: 'read', retryable: false }) }
function obj(v: unknown): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail()
  return v as Record<string, any>
}
function id(v: unknown): string {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) v = String(v)
  if (typeof v !== 'string' || !v.trim() || v.length > 128) fail()
  return v as string
}
function entity(v: unknown): string {
  const raw = id(v)
  if (raw.includes('@') && !/^[^@]+@goofish$/.test(raw)) fail()
  return id(raw.replace(/@goofish$/, ''))
}
function num(v: unknown): number {
  if (!Number.isSafeInteger(v) || Number(v) < 0) fail()
  return v as number
}
function anchor(v: unknown): string {
  if (typeof v === 'number') return String(num(v))
  if (typeof v !== 'string' || !/^(0|[1-9]\d*)$/.test(v) || v.length > 16 || BigInt(v) > BigInt(Number.MAX_SAFE_INTEGER)) fail()
  return v as string
}
function pageBoolean(v: unknown): boolean | undefined {
  if (v === undefined) return undefined
  if (v === 0 || v === false) return false
  if (v === 1 || v === true) return true
  return fail()
}
function links(extension: Record<string, any>, account: string): { itemId: string | null; peerUserId: string | null } {
  if (extension.reminderUrl === undefined) return { itemId: null, peerUserId: null }
  if (typeof extension.reminderUrl !== 'string' || extension.reminderUrl.length > 8192) fail()
  let url: URL
  try { url = new URL(extension.reminderUrl) } catch { return fail() }
  const item = url.searchParams.get('itemId'), peer = url.searchParams.get('peerUserId')
  const peerId = peer === null ? null : entity(peer)
  return { itemId: item === null ? null : id(item), peerUserId: peerId === account ? null : peerId }
}
function customText(custom: Record<string, any>): string | null {
  let kind = custom.contentType ?? custom.type
  if (kind !== undefined) num(kind)
  let decoded: any
  if (custom.data !== undefined) {
    if (typeof custom.data !== 'string' || custom.data.length > 131072) fail()
    try {
      const binary = atob(custom.data)
      decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, c => c.charCodeAt(0))))
    } catch { return fail() }
    if (typeof decoded !== 'string') {
      const value = obj(decoded)
      const decodedKind = value.contentType ?? value.type
      if (decodedKind !== undefined) {
        num(decodedKind)
        if (kind !== undefined && kind !== decodedKind) fail()
        kind = decodedKind
      }
    }
  }
  if (kind !== undefined && kind !== 1 && kind !== 101) return null
  let text: unknown = custom.summary
  if (decoded !== undefined) text = typeof decoded === 'string' ? decoded : obj(decoded).text?.text ?? text
  if (typeof text !== 'string' || text.length > 20000) fail()
  return text as string
}

/**
 * 归一化一个已匹配响应的 body，不访问平台、不翻页、不生成来源 ID 或时间。
 * 输入最大 512KiB、最多请求 limit 条；分页必须明确，输出不携带原始或敏感字段。
 */
export function normalizeChatSyncPage(params: ChatSyncPageParams, rawBody: unknown, accountId: string): ChatSyncPageResult {
  try {
    if (!isChatSyncPageParams(params)) fail()
    const account = entity(accountId)
    // 先限制字符串输入，再解析；对象输入按实际 JSON 字节限制。
    if (typeof rawBody === 'string') {
      if (new TextEncoder().encode(rawBody).length > 512 * 1024) fail()
      rawBody = JSON.parse(rawBody)
    }
    if (new TextEncoder().encode(JSON.stringify(rawBody)).length > 512 * 1024) fail()
    const body = obj(rawBody)
    const rows = body[params.mode === 'conversations' ? 'userConvs' : 'userMessageModels']
    // 平台超额返回时整页拒绝，不能截断再沿用整页游标，否则会永久跳过剩余记录。
    // 消息游标的排序域尚无证据证明可由 createAt/messageId 推导，禁止猜测续页锚点。
    if (!Array.isArray(rows) || rows.length > params.limit || rows.length > 100) fail()
    const selectedRows = rows
    const conversations: ChatSyncConversation[] = [], messages: ChatMessage[] = []
    const seen = new Set<string>()
    let unsupportedCount = 0
    for (const row of selectedRows) {
      if (params.mode === 'conversations') {
        const item = obj(row)
        // 官方分页会混入群聊；当前单聊协议不消费群聊，但必须保留覆盖缺口，不能整页丢弃。
        if (item.type === 2 && item.singleChatUserConversation === undefined) {
          obj(item.groupChatUserConversation)
          unsupportedCount++
          continue
        }
        const conv = obj(item.singleChatUserConversation)
        const conversation = conv.singleChatConversation === undefined ? {} : obj(conv.singleChatConversation)
        const msg = conv.lastMessage === undefined ? undefined : obj(obj(conv.lastMessage).message)
        // 真实响应把会话实体（含 cid）放在嵌套 singleChatConversation；首屏记录可没有 lastMessage。
        const sessionId = entity(conv.cid ?? conversation.cid ?? msg?.cid)
        if (msg?.cid !== undefined && entity(msg.cid) !== sessionId) fail()
        // 真实会话响应通常不带 sortIndex；服务端 nextCursor 是分页排序域，不能假设与 modifyTime 同域。
        const sortIndex = anchor(conv.sortIndex ?? item.sortIndex ?? conv.modifyTime ?? conversation.createAt ?? msg?.createAt)
        const updatedAt = num(conv.modifyTime ?? conversation.createAt ?? msg?.createAt)
        const extra = links(msg?.extension === undefined ? {} : obj(msg.extension), account)
        if (seen.has(sessionId)) fail()
        seen.add(sessionId)
        conversations.push({ sessionId, ...extra, updatedAt, sortIndex })
      } else {
        const msg = obj(obj(row).message), sourceId = id(msg.messageId), sessionId = entity(msg.cid)
        if (sessionId !== params.sessionId || seen.has(sourceId)) fail()
        seen.add(sourceId)
        const ext = msg.extension === undefined ? {} : obj(msg.extension)
        const senderId = entity(ext.senderUserId ?? obj(msg.sender).uid), sentAt = num(msg.createAt)
        const custom = obj(obj(msg.content).custom)
        const text = customText(custom)
        const extra = links(ext, account)
        if (text === null) { unsupportedCount++; continue }
        const message = { sourceId, sessionId, senderId, text, sentAt,
          ...(extra.itemId === null ? {} : { itemId: extra.itemId }), ...(extra.peerUserId === null ? {} : { peerUserId: extra.peerUserId }) }
        if (!isChatMessage(message)) fail()
        messages.push(message)
      }
    }
    // 闲鱼 LWP 当前返回 0/1；公共协议只接受 boolean，因此只在页面边界做严格转换。
    const hasMore = pageBoolean(body.hasMore), hasNextPage = pageBoolean(body.hasNextPage)
    // 别名分别校验后再比较，兼容 0/1 与 boolean，不能让备用字段中的非法值被遮蔽。
    if (hasMore !== undefined && hasNextPage !== undefined && hasMore !== hasNextPage) fail()
    let more = hasMore ?? hasNextPage
    let next: string | null = body.nextCursor === undefined ? null : anchor(body.nextCursor)
    if (more === undefined) {
      if (next === null) fail()
      more = next !== '0'
    }
    if (more) {
      // 平台明确返回的 nextCursor 是唯一可信分页域；缺失时只能会话模式回退最后 sortIndex。
      if (next === null && params.mode !== 'conversations') fail()
      if (next === null && conversations.length && unsupportedCount === 0) next = conversations.at(-1)!.sortIndex
      if (next === null || next === '0' || BigInt(next) >= BigInt(params.anchor)) fail()
    } else {
      // 真实平台在 hasMore=0 时仍会把最后一条记录时间放进 nextCursor；
      // 只要平台明确声明没有更多，就丢弃该游标，不再把它当作分页冲突。
      if (next !== null && next !== '0' && body.hasMore === undefined && body.hasNextPage === undefined) fail()
      next = null
    }
    const result: ChatSyncPageResult = params.mode === 'conversations'
      ? { mode: 'conversations', conversations, hasMore: more, nextAnchor: next, unsupportedCount }
      : { mode: 'messages', messages, hasMore: more, nextAnchor: next, unsupportedCount }
    if (!validateResult(params, result)) fail()
    return result
  } catch { return fail() }
}
