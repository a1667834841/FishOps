/**
 * P6 消息发送器（高层）。
 *
 * 职责：校验发送输入 → 构造发送 LWP 信封 → 经注入的 {@link ChatSendTransport} 发送 →
 * 按 `mid` 关联响应并归一为结构化 {@link SendMessageResult}。
 *
 * 安全：
 * - 发送前校验 sessionId / receiverId / myId / content（非空、长度、ID 不含后缀、双方不同）；
 * - 只发送本模块构造的信封，绝不透传任意 payload；
 * - 本模块**不打印消息正文**；错误信息不含正文。
 */
import { isLwpSuccess } from '../../../shared/chat/index'
import { MAX_SEND_CONTENT_LENGTH } from '../../../shared/types/reply'
import type { SendMessageErrorCode, SendMessageResult } from '../../../shared/types/reply'
import {
  buildSendMessageLwpRequest,
  generateSendMid,
  generateSendUuid,
  isAllowedSendRoute,
  validateSendInput,
  validateSendLwpRequest,
} from './send-protocol'
import { ChatSendTransportError, type ChatSendTransport } from './send-transport'

/** 发送一条文本消息的输入。 */
export interface SendTextInput {
  sessionId: string
  receiverId: string
  myId: string
  content: string
  /** 可选：关联商品 ID（仅诊断）。 */
  itemId?: string
  /** 覆盖默认超时（毫秒）。 */
  timeoutMs?: number
}

/** 发送器依赖。 */
export interface ChatMessageSenderDeps {
  transport: ChatSendTransport
  /** 时间源，便于测试。 */
  now?: () => number
  /** mid 生成器，便于测试；默认使用 `generateSendMid`。 */
  midFactory?: () => string
  /** uuid 生成器，便于测试；默认使用 `generateSendUuid`。 */
  uuidFactory?: () => string
  /** 内容长度上限，缺省 {@link MAX_SEND_CONTENT_LENGTH}。 */
  maxContentLength?: number
}

/** 把 transport 错误码归一为发送错误码。 */
function normalizeTransportCode(code: string): SendMessageErrorCode {
  switch (code) {
    case 'ROUTE_NOT_ALLOWED':
      return 'ROUTE_NOT_ALLOWED'
    case 'INVALID_INPUT':
      return 'INVALID_INPUT'
    case 'DUPLICATE_MID':
      return 'DUPLICATE_MID'
    case 'NO_SOCKET':
      return 'NO_SOCKET'
    case 'TIMEOUT':
      return 'TIMEOUT'
    case 'SEND_FAILED':
    default:
      return 'SEND_FAILED'
  }
}

/** 消息发送器。 */
export class ChatMessageSender {
  private readonly transport: ChatSendTransport
  private readonly now: () => number
  private readonly midFactory: () => string
  private readonly uuidFactory: () => string
  private readonly maxContentLength: number

  constructor(deps: ChatMessageSenderDeps) {
    this.transport = deps.transport
    this.now = deps.now ?? (() => Date.now())
    this.midFactory = deps.midFactory ?? (() => generateSendMid())
    this.uuidFactory = deps.uuidFactory ?? (() => generateSendUuid())
    this.maxContentLength = deps.maxContentLength ?? MAX_SEND_CONTENT_LENGTH
  }

  /**
   * 发送一条文本消息。任何失败都返回结构化结果，绝不抛错。
   */
  async sendText(input: SendTextInput): Promise<SendMessageResult> {
    const invalid = validateSendInput(input)
    if (invalid) return { ok: false, error: invalid }
    if (input.content.length > this.maxContentLength) {
      return {
        ok: false,
        error: { code: 'INVALID_INPUT', message: `消息内容超过上限 ${this.maxContentLength}` },
      }
    }

    const uuid = this.uuidFactory()
    const request = buildSendMessageLwpRequest({
      sessionId: input.sessionId,
      receiverId: input.receiverId,
      myId: input.myId,
      content: input.content,
      mid: this.midFactory(),
      uuid,
    })

    // 双保险：构造后再自校验一次，确保只发出合规信封。
    const builtInvalid = validateSendLwpRequest(request)
    if (builtInvalid) return { ok: false, error: builtInvalid }
    if (!isAllowedSendRoute(request.lwp)) {
      return { ok: false, error: { code: 'ROUTE_NOT_ALLOWED', message: '非发送路由' } }
    }

    let response
    try {
      response = await this.transport.send(
        request,
        input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs },
      )
    } catch (error) {
      if (error instanceof ChatSendTransportError) {
        return { ok: false, error: { code: normalizeTransportCode(error.code), message: error.message } }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: { code: 'SEND_FAILED', message: `发送失败: ${message}` } }
    }

    if (!isLwpSuccess(response.code)) {
      // 只回服务端 code/message（可能为空），不回响应 body，避免任何回显风险。
      const detail = typeof response.message === 'string' && response.message.length > 0 ? response.message : String(response.code)
      return { ok: false, error: { code: 'LWP_ERROR', message: `服务端返回错误: ${detail}` } }
    }

    return {
      ok: true,
      messageId: uuid,
      sessionId: input.sessionId,
      receiverId: input.receiverId,
      sentAt: this.now(),
    }
  }
}
