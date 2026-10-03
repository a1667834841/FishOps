/**
 * FishOps Workbench 通信协议——基础信封与常量。
 *
 * Workbench（Vue 页面）与 Extension（background / content）之间只通过这些信封通信，
 * 双方共享同一份类型与运行时校验，避免消息结构漂移。
 */

/** 协议版本号。双方不一致时可在日志中快速定位（P1 仅记录，不做强制协商）。 */
export const PROTOCOL_VERSION = 1

/** 事件订阅长连接的端口名，background 与 Workbench 客户端必须一致。 */
export const EVENT_PORT_NAME = 'fishops-workbench-events'

/** 命令/响应的关联 id，由调用方生成，用于把响应匹配回对应请求。 */
export type RequestId = string

/** 事件 id，用于去重与日志关联。 */
export type EventId = string

/** 协议错误码。 */
export type ProtocolErrorCode =
  | 'INVALID_MESSAGE'
  | 'UNKNOWN_COMMAND'
  | 'INVALID_PAYLOAD'
  | 'INTERNAL'
  | 'TIMEOUT'
  | 'NO_TRANSPORT'
  /** 平台层（P3）调用失败；具体原因见 `category`。 */
  | 'PLATFORM_ERROR'

/**
 * 平台层错误类别。
 *
 * 与 `extension/src/platform/errors.ts` 的 `PlatformErrorCategory` 保持同构；
 * 跨包不直接共享类型，此处镜像定义，便于 Workbench 在不依赖 extension 包的情况下
 * 按类别决定行为（例如风控验证码要暂停自动化、未登录要引导重新登录）。
 */
export type PlatformErrorCategory =
  /** 页面尚未安装平台 host，或目标 tab 不存在 / 已关闭。 */
  | 'host-unavailable'
  /** 未登录 / 会话失效。 */
  | 'unauthorized'
  /** MTOP token 过期或为空，需刷新页面 / 重新登录。 */
  | 'token-expired'
  /** 验证码 / 风控拦截，需要人工处理。 */
  | 'captcha'
  /** 网络 / 传输层错误。 */
  | 'network'
  /** MTOP 业务错误。 */
  | 'api'
  /** 其他无法归类的错误。 */
  | 'unknown'

/** 结构化协议错误。 */
export interface ProtocolError {
  code: ProtocolErrorCode
  message: string
  /** 仅当 `code` 为 `PLATFORM_ERROR` 时存在：平台层错误类别。 */
  category?: PlatformErrorCategory
  /** 仅当 `code` 为 `PLATFORM_ERROR` 时可能存在：MTOP ret 码（不含任何凭据）。 */
  retCode?: string
  /**
   * 业务层结构化码（可选）：如发布中心的 SUBMIT_DUPLICATE / SUBMIT_BUTTON_NOT_FOUND，
   * 用于调用方在不依赖 message 文本的情况下精准分支。仅含枚举码，不含任何凭据。
   */
  businessCode?: string
}

/** Workbench → Extension：请求。 */
export interface CommandEnvelope<TType extends string = string, TPayload = unknown> {
  kind: 'command'
  protocol: typeof PROTOCOL_VERSION
  requestId: RequestId
  type: TType
  payload: TPayload
  /** 发送时间（毫秒时间戳）。 */
  sentAt: number
}

/** Extension → Workbench：响应。 */
export interface ResponseEnvelope<TType extends string = string, TResult = unknown> {
  kind: 'response'
  protocol: typeof PROTOCOL_VERSION
  requestId: RequestId
  /** 对应命令类型，便于调用方校验响应归属。 */
  type: TType
  ok: boolean
  result?: TResult
  error?: ProtocolError
  /** 响应时间（毫秒时间戳）。 */
  respondedAt: number
}

/** Extension → Workbench：单向事件。 */
export interface EventEnvelope<TType extends string = string, TPayload = unknown> {
  kind: 'event'
  protocol: typeof PROTOCOL_VERSION
  type: TType
  eventId: EventId
  payload: TPayload
  /** 事件产生时间（毫秒时间戳）。 */
  emittedAt: number
}

/** 任一协议消息。 */
export type BridgeMessage = CommandEnvelope | ResponseEnvelope | EventEnvelope

/** Workbench 客户端通过事件长连接发送的订阅声明。 */
export interface SubscribeMessage {
  kind: 'subscribe'
  events: string[]
}
