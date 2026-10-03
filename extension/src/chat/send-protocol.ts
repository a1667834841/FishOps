/**
 * P6 发送协议（纯逻辑，MAIN world 与 background 共用）。
 *
 * 严格对照旧 `chat` 分支 `inject/api/chat-sender.js` 与 `docs/api/websocket-api.md`：
 * - 路由：`/r/MessageSend/sendByReceiverScope`
 * - mid：`{0-999 随机}{时间戳} 0`；uuid：`-{时间戳}{0-9999 随机}`
 * - 外层 `content.contentType = 101`，`custom.type = 1`，`custom.data` 为 base64
 * - 内层 base64 文本：`{ contentType: 1, text: { text } }`（JSON → UTF-8 → base64）
 * - 第二个 body 元素 `{ actualReceivers: [对方@goofish, 自己@goofish] }`，**必须包含双方**
 *
 * 本文件**不发送任何数据**、不访问 `window`/`WebSocket`；socket 由 transport 注入，可在 Node 中单测。
 */
import { isRecord, toFullCid, type LwpRequest } from '../../../shared/chat/index'
import {
  GOOFISH_SUFFIX,
  OUTER_CONTENT_TYPE,
  SEND_LWP_ROUTE,
  TEXT_CONTENT_TYPE,
} from '../../../shared/types/reply'

export { GOOFISH_SUFFIX, OUTER_CONTENT_TYPE, SEND_LWP_ROUTE, TEXT_CONTENT_TYPE }

/** 发送输入（高层的 session/receiver/myId/content）。 */
export interface SendInput {
  sessionId: string
  receiverId: string
  myId: string
  content: string
}

/** 构造发送请求所需参数。 */
export interface BuildSendMessageParams extends SendInput {
  mid: string
  uuid: string
}

/** 发送校验错误码（发送白名单校验只会产生这两类）。 */
export type SendValidationCode = 'INVALID_INPUT' | 'ROUTE_NOT_ALLOWED'

/** 校验结果：通过返回 null，否则返回结构化错误。 */
export interface SendValidationError {
  code: SendValidationCode
  message: string
}

/**
 * 生成发送用的 mid。
 * 格式对照旧实现：`{0-999 随机数}{时间戳} 0`。
 */
export function generateSendMid(now: number = Date.now(), random: number = Math.random()): string {
  return `${Math.floor(random * 1000)}${now} 0`
}

/**
 * 生成发送用的 uuid。
 * 格式对照旧实现：`-{时间戳}{0-9999 随机数}`。
 */
export function generateSendUuid(now: number = Date.now(), random: number = Math.random()): string {
  return `-${now}${Math.floor(random * 10000)}`
}

/** 把任意 UTF-8 文本编码为 base64（等价旧实现 `btoa(unescape(encodeURIComponent(x)))`，但不依赖废弃 API）。 */
export function encodeBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/** 内层文本 payload 的 base64（`{ contentType: 1, text: { text } }`）。 */
export function encodeTextContent(content: string): string {
  return encodeBase64Utf8(JSON.stringify({ contentType: TEXT_CONTENT_TYPE, text: { text: content } }))
}

/**
 * 校验发送输入。
 * 要求：sessionId / receiverId / myId / content 均为非空，且不得已带 `@goofish` 后缀。
 */
export function validateSendInput(input: Partial<SendInput>): SendValidationError | null {
  const sessionId = input.sessionId
  const receiverId = input.receiverId
  const myId = input.myId
  const content = input.content

  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    return { code: 'INVALID_INPUT', message: 'sessionId 不能为空' }
  }
  if (typeof receiverId !== 'string' || receiverId.length === 0) {
    return { code: 'INVALID_INPUT', message: 'receiverId 不能为空' }
  }
  if (typeof myId !== 'string' || myId.length === 0) {
    return { code: 'INVALID_INPUT', message: 'myId 不能为空' }
  }
  if (typeof content !== 'string' || content.trim().length === 0) {
    return { code: 'INVALID_INPUT', message: '消息内容不能为空' }
  }
  if (sessionId.includes('@') || receiverId.includes('@') || myId.includes('@')) {
    return { code: 'INVALID_INPUT', message: 'ID 不应包含 @ 后缀' }
  }
  if (receiverId === myId) {
    return { code: 'INVALID_INPUT', message: 'receiverId 不能等于 myId' }
  }
  return null
}

/**
 * 构造发送 LWP 请求信封。
 * 调用方必须先通过 {@link validateSendInput}；本函数不做业务校验，只忠实构造协议结构。
 */
export function buildSendMessageLwpRequest(params: BuildSendMessageParams): LwpRequest {
  const payload = {
    uuid: params.uuid,
    cid: toFullCid(params.sessionId),
    conversationType: 1,
    content: {
      contentType: OUTER_CONTENT_TYPE,
      custom: { type: 1, data: encodeTextContent(params.content) },
    },
    redPointPolicy: 0,
    extension: { extJson: '{}' },
    ctx: { appVersion: '1.0', platform: 'web' },
    mtags: {},
    msgReadStatusSetting: 1,
  }
  return {
    lwp: SEND_LWP_ROUTE,
    headers: { mid: params.mid },
    body: [
      payload,
      // 关键：actualReceivers 必须包含双方（对方 + 自己），否则不同步到双方设备。
      { actualReceivers: [toFullCid(params.receiverId), toFullCid(params.myId)] },
    ],
  }
}

/** 是否为本模块允许的发送路由。 */
export function isAllowedSendRoute(lwp: unknown): boolean {
  return lwp === SEND_LWP_ROUTE
}

/** 校验 base64 文本内容是否是我们构造的内层结构（用于测试 / 诊断，不用于生产信任）。 */
export function decodeTextContent(base64: string): string | null {
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const json = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as unknown
    if (!isRecord(json) || json['contentType'] !== TEXT_CONTENT_TYPE) return null
    const text = json['text']
    if (!isRecord(text) || typeof text['text'] !== 'string') return null
    return text['text']
  } catch {
    return null
  }
}

/**
 * 严格校验发送 LWP 请求信封。
 * 通过返回 null；否则返回结构化错误。
 *
 * 这是发送侧独立的白名单校验，**不复用也不放宽** P5 只读 transport 的白名单。
 */
export function validateSendLwpRequest(request: unknown): SendValidationError | null {
  if (!isRecord(request)) return { code: 'INVALID_INPUT', message: '请求不是对象' }

  const keys = Object.keys(request)
  if (keys.length !== 3 || !keys.every((key) => key === 'lwp' || key === 'headers' || key === 'body')) {
    return { code: 'INVALID_INPUT', message: 'LWP 请求只允许 lwp / headers / body 三个字段' }
  }
  if (!isAllowedSendRoute(request['lwp'])) {
    return { code: 'ROUTE_NOT_ALLOWED', message: `非发送路由: ${String(request['lwp'])}` }
  }
  const headers = request['headers']
  if (!isRecord(headers) || Object.keys(headers).length !== 1 || typeof headers['mid'] !== 'string' || headers['mid'].length === 0) {
    return { code: 'INVALID_INPUT', message: 'headers 必须且只能包含非空字符串 mid' }
  }
  const body = request['body']
  if (!Array.isArray(body) || body.length !== 2) {
    return { code: 'INVALID_INPUT', message: 'body 必须是长度为 2 的数组' }
  }

  const message = body[0]
  if (!isRecord(message)) return { code: 'INVALID_INPUT', message: 'body[0] 必须是消息对象' }
  if (typeof message['uuid'] !== 'string' || message['uuid'].length === 0) {
    return { code: 'INVALID_INPUT', message: 'uuid 非法' }
  }
  if (typeof message['cid'] !== 'string' || !message['cid'].endsWith(GOOFISH_SUFFIX)) {
    return { code: 'INVALID_INPUT', message: 'cid 非法' }
  }
  if (message['conversationType'] !== 1) return { code: 'INVALID_INPUT', message: 'conversationType 必须为 1' }
  if (!isRecord(message['content']) || message['content']['contentType'] !== OUTER_CONTENT_TYPE) {
    return { code: 'INVALID_INPUT', message: '外层 contentType 必须为 101' }
  }
  const custom = message['content']['custom']
  if (!isRecord(custom) || custom['type'] !== 1 || typeof custom['data'] !== 'string' || custom['data'].length === 0) {
    return { code: 'INVALID_INPUT', message: 'custom 结构非法' }
  }
  const ctx = message['ctx']
  if (!isRecord(ctx) || ctx['platform'] !== 'web') {
    return { code: 'INVALID_INPUT', message: 'ctx.platform 必须为 web' }
  }
  if (!isRecord(message['extension']) || typeof message['extension']['extJson'] !== 'string') {
    return { code: 'INVALID_INPUT', message: 'extension.extJson 非法' }
  }

  const receivers = body[1]
  if (!isRecord(receivers) || !Array.isArray(receivers['actualReceivers']) || receivers['actualReceivers'].length !== 2) {
    return { code: 'INVALID_INPUT', message: 'actualReceivers 必须是长度为 2 的数组' }
  }
  const list = receivers['actualReceivers'] as unknown[]
  if (!list.every((id) => typeof id === 'string' && id.endsWith(GOOFISH_SUFFIX))) {
    return { code: 'INVALID_INPUT', message: 'actualReceivers 元素必须带 @goofish 后缀' }
  }
  if (list[0] === list[1]) return { code: 'INVALID_INPUT', message: 'actualReceivers 双方 ID 不能相同' }

  return null
}
