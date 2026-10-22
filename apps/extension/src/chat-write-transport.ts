import type { ErrorCode } from '../../../packages/protocol/src/index.ts'
import { ApiError } from './errors.ts'

const ROUTE = '/r/MessageSend/sendByReceiverScope'
const TIMEOUT_MS = 10_000
const MAX_TEXT = 20_000

/** 页面已经建立的聊天连接最小接口；本模块不创建、关闭或重连连接。 */
export interface ChatWriteSocket {
  readonly readyState: number
  send(data: string): void
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}
export interface ChatWriteParams { sessionId: string; receiverId: string; myId: string; text: string }
export interface ChatWriteTransportDeps {
  now?: () => number
  random?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  readAccountId?: () => string | null
}
export type ChatWriteResult = { messageId: string; sentAt: number }

function fail(code: ErrorCode): ApiError {
  const messages: Partial<Record<ErrorCode, string>> = {
    BAD_REQUEST: '聊天发送参数无效', PAGE_NOT_READY: '聊天页面或连接不可用',
    ACCOUNT_CHANGED: '发送账号已变化', TIMEOUT: '发送结果未知，未自动重试',
    RESULT_UNKNOWN: '发送结果未知，未自动重试', RISK_BLOCKED: '发送被平台风控拦截',
    LOGIN_REQUIRED: '登录状态不可用', PLATFORM_REJECTED: '平台拒绝发送',
  }
  return new ApiError(code, messages[code] ?? '聊天发送未能安全完成', { phase: 'write', retryable: false })
}
function fullId(value: string): string { return value.endsWith('@goofish') ? value : `${value}@goofish` }
function b64(text: string): string {
  const bytes = new TextEncoder().encode(text); let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('@') && !/\s/.test(value) }
/** 平台回传 messageId 的严格校验：非空、长度受限、不含空白；畸形值一律视为结果未知。 */
function validMessageId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/\s/.test(value) }
function validParams(params: unknown, account: string): params is ChatWriteParams {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false
  const value = params as Record<string, unknown>
  return Object.keys(value).length === 4 && validId(value.sessionId) && validId(value.receiverId) &&
    validId(value.myId) && value.myId === account && value.receiverId !== value.myId &&
    typeof value.text === 'string' && value.text.trim().length > 0 && value.text.length <= MAX_TEXT
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
/**
 * 成功响应正文判定，返回经校验的平台 messageId。
 * 真实平台会回传 extension、receiverCount、createAt、content 等多个字段，字段集合会随版本变化；
 * 只校验能证明“本次发送已被受理”的关键字段：messageId 必须存在，uuid 若存在必须与本次一致。
 * uuid 仅用于相关性校验，不作为结果返回；只有平台 messageId 才能与历史消息 sourceId 关联。
 * 其它字段忽略且绝不带出页面。
 */
function responseBody(value: unknown, uuid: string): string | undefined {
  if (!record(value)) return undefined
  if (!validMessageId(value.messageId)) return undefined
  if (value.uuid !== undefined && value.uuid !== uuid) return undefined
  if (value.success !== undefined && value.success !== true) return undefined
  return value.messageId
}

/**
 * 单次文本写入 transport。匹配 pending 后返回经校验的平台 messageId 与本地发送时间；
 * 本地 uuid 只用于响应相关性校验，不再对外返回。
 * 服务端响应仅证明协议响应通过，不证明跨设备最终持久化。
 */
export function createChatWriteTransport(deps: ChatWriteTransportDeps = {}) {
  const now = deps.now ?? Date.now
  const random = deps.random ?? Math.random
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const used = new Set<string>()
  let poisoned: ErrorCode | undefined
  let disposed = false
  let pending: { socket: ChatWriteSocket; mid: string; uuid: string; sentAt: number; timer: unknown; resolve: (v: ChatWriteResult) => void; reject: (e: ApiError) => void } | undefined
  let sequence = 0

  function detach(entry: typeof pending) {
    if (!entry) return
    entry.socket.removeEventListener('message', onMessage)
    entry.socket.removeEventListener('close', onConnectionLost)
    entry.socket.removeEventListener('error', onConnectionLost)
    clearTimer(entry.timer)
  }
  function poison(code: ErrorCode) {
    if (poisoned) return
    poisoned = code
    const entry = pending; pending = undefined
    detach(entry); entry?.reject(fail(code))
  }
  function onConnectionLost() { poison('RESULT_UNKNOWN') }
  function onMessage(event: Event) {
    const entry = pending
    if (!entry || poisoned || disposed) return
    const raw = (event as MessageEvent).data
    if (typeof raw !== 'string' || raw.length > 256 * 1024) return
    let value: unknown
    try { value = JSON.parse(raw) } catch { poison('RESULT_UNKNOWN'); return }
    if (!record(value) || !record(value.headers) || value.headers.mid !== entry.mid) return
    if (value.lwp !== undefined && value.lwp !== ROUTE) { poison('RESULT_UNKNOWN'); return }
    if (value.route !== undefined && value.route !== ROUTE) { poison('RESULT_UNKNOWN'); return }
    if (value.code !== 200 && value.code !== 0) {
      const text = typeof value.message === 'string' ? value.message : ''
      poison(/captcha|RGV587|x5sec|punish|验证码|安全验证/i.test(text) ? 'RISK_BLOCKED' : /token|login|未登录|登录/i.test(text) ? 'LOGIN_REQUIRED' : 'PLATFORM_REJECTED')
      return
    }
    const platformMessageId = Object.prototype.hasOwnProperty.call(value, 'body') ? responseBody(value.body, entry.uuid) : undefined
    if (platformMessageId === undefined) { poison('RESULT_UNKNOWN'); return }
    const done = pending; pending = undefined; detach(done)
    done?.resolve({ messageId: platformMessageId, sentAt: entry.sentAt })
  }

  return {
    async send(params: ChatWriteParams, accountId: string, socket: ChatWriteSocket): Promise<ChatWriteResult> {
      if (disposed || poisoned) throw fail(poisoned ?? 'PAGE_NOT_READY')
      if (typeof accountId !== 'string' || !accountId.trim() || !validParams(params, accountId)) throw fail('BAD_REQUEST')
      if (!socket || socket.readyState !== 1 || typeof socket.send !== 'function') throw fail('PAGE_NOT_READY')
      if (pending) throw fail('PAGE_NOT_READY')
      if (deps.readAccountId && deps.readAccountId() !== accountId) { poison('ACCOUNT_CHANGED'); throw fail('ACCOUNT_CHANGED') }
      const sentAt = now()
      const mid = `${Math.floor(random() * 1000)}${sentAt} ${sequence++}`
      const uuid = `-${sentAt}${Math.floor(random() * 10000)}`
      if (used.has(mid) || used.has(uuid)) throw fail('BAD_REQUEST')
      used.add(mid); used.add(uuid)
      const envelope = {
        lwp: ROUTE, headers: { mid }, body: [{ uuid, cid: fullId(params.sessionId), conversationType: 1,
          content: { contentType: 101, custom: { type: 1, data: b64(JSON.stringify({ contentType: 1, text: { text: params.text } })) } },
          redPointPolicy: 0, extension: { extJson: '{}' }, ctx: { appVersion: '1.0', platform: 'web' }, mtags: {}, msgReadStatusSetting: 1 },
          { actualReceivers: [fullId(params.receiverId), fullId(params.myId)] }],
      }
      return new Promise((resolve, reject) => {
        const timer = setTimer(() => poison('TIMEOUT'), TIMEOUT_MS)
        pending = { socket, mid, uuid, sentAt, timer, resolve, reject }
        socket.addEventListener('message', onMessage); socket.addEventListener('close', onConnectionLost); socket.addEventListener('error', onConnectionLost)
        try { socket.send(JSON.stringify(envelope)) } catch { poison('RESULT_UNKNOWN') }
      })
    },
    dispose() { if (disposed) return; disposed = true; poison('PAGE_NOT_READY') },
  }
}
