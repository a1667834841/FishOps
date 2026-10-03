/**
 * 命令路由：把 Workbench 发来的 Command 分派到对应处理函数。
 * 通过 RouterDeps 注入副作用，便于后续单元测试与替换实现。
 */
import {
  CommandTypes,
  createErrorResponse,
  createResponse,
  EventTypes,
  isPingPayload,
  isPlatformCallPayload,
  isPlatformPingPayload,
  isPublishPayload,
  isSubscribePayload,
  type CommandEnvelope,
  type EventType,
  type PingResult,
  type ProtocolError,
  type ResponseEnvelope,
} from '@fishops/shared'
import { PlatformError, toPlatformError } from '../platform/errors'
import { isPlatformMethod } from '../platform/protocol'

/**
 * 平台调用器（P3）。
 *
 * 由 background 组装并屏蔽 host-client / tab-manager 细节，只暴露 call / ping，
 * 便于在 Node 中对路由逻辑做无 chrome 单测。
 */
export interface PlatformRouterDeps {
  /** 按平台方法名调用 MAIN world host；失败抛 PlatformError。 */
  call(method: string, params: unknown): Promise<unknown>
  /** 探测 MAIN world host 是否就绪；失败抛 PlatformError。 */
  ping(): Promise<unknown>
}

/**
 * 聊天只读层（P5）路由器。
 *
 * background 侧用 `ChatRuntime` 实现；`CHAT_SOCKET_EVENT` 不走这里（它只允许来自 page
 * content script，由 background 在 onMessage 层先按来源校验）。
 */
export interface ChatRouterDeps {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/**
 * 采集 / 任务中心（P4）路由器。
 * background 侧用 `CaptureRuntime` 实现。
 */
export interface CaptureRouterDeps {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/**
 * 聊天发送与 AI（P6）路由器。
 * background 侧用 `ReplyRuntime` 实现。
 */
export interface ReplyRouterDeps {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/**
 * 运行时自动准备（P8）路由器。
 * background 侧同时提供只读状态与「准备后台 tab + host + 用户 ID」。
 */
export interface RuntimeRouterDeps {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/**
 * 旧扩展配置迁移路由器（安全，显式触发）。
 * background 侧用 `MigrationRuntime` 实现。
 */
export interface MigrationRouterDeps {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/** 需要交由 RuntimeRouterDeps 处理的运行时命令（P8）。 */
const RUNTIME_ROUTED_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.RUNTIME_STATUS,
  CommandTypes.CHAT_RUNTIME_PREPARE,
])

/**
 * 手动配置（AI / 飞书）路由器。
 * background 侧用 `ConfigRuntime` 实现；专用写入通道，密钥不回显。
 */
export interface ConfigRouterDeps {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/** 需要交由 MigrationRouterDeps 处理的迁移命令。 */
const MIGRATION_ROUTED_COMMANDS: ReadonlySet<string> = new Set<string>([CommandTypes.MIGRATE_LEGACY_CONFIG])

/** 需要交由 ConfigRouterDeps 处理的手动配置命令。 */
const CONFIG_ROUTED_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.AI_CONFIG_SET,
  CommandTypes.AI_CONFIG_STATUS,
  CommandTypes.AI_CONFIG_TEST,
  CommandTypes.FEISHU_CONFIG_SET,
  CommandTypes.FEISHU_CONFIG_STATUS,
])

/**
 * 飞书商品写入路由器（P7 后台）。
 * 预览只读、执行需显式 confirm；只写已配置商品表。
 */
export interface FeishuWriteRouterDeps {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/**
 * 飞书表字段同步路由器（P7 后台）。
 * 预览只读、执行需显式 confirm；并集目标、类型冲突需显式确认、不删字段。
 */
export interface FeishuSchemaRouterDeps {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/**
 * 发布中心路由器（P8）。
 * background 侧用 `PublishRuntime` 实现。
 */
export interface PublishRouterDeps {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/** 需要交由 PublishRouterDeps 处理的 P8 发布命令。 */
const PUBLISH_ROUTED_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.PUBLISH_CREATE,
  CommandTypes.PUBLISH_LIST,
  CommandTypes.PUBLISH_GET,
  CommandTypes.PUBLISH_FILL_FORM,
  CommandTypes.PUBLISH_CANCEL,
  CommandTypes.PUBLISH_PAUSE,
  CommandTypes.PUBLISH_RESUME,
  CommandTypes.PUBLISH_CONFIRM_STATUS,
  CommandTypes.PUBLISH_SUBMIT,
])

/** 需要交由 ReplyRouterDeps 处理的 P6 命令。 */
const REPLY_ROUTED_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.CHAT_SEND_MESSAGE,
  CommandTypes.CHAT_GET_REPLY_SUGGESTION,
  CommandTypes.CHAT_APPLY_REPLY,
  CommandTypes.CHAT_AUTO_REPLY_STATUS,
  CommandTypes.CHAT_RULES_GET,
  CommandTypes.CHAT_RULES_SET,
  CommandTypes.CHAT_AI_PAUSE_SET,
])

/**
 * 数据分析 / 数据源（P7）路由器。
 * background 侧用 `AnalysisRuntime` 实现。
 */
export interface AnalysisRouterDeps {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/** 需要交由 CaptureRouterDeps 处理的 Workbench 采集 / 任务命令。 */
const CAPTURE_ROUTED_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.CAPTURE_CREATE,
  CommandTypes.CAPTURE_PAUSE,
  CommandTypes.CAPTURE_RESUME,
  CommandTypes.CAPTURE_CANCEL,
  CommandTypes.CAPTURE_GET,
  CommandTypes.CAPTURE_SUGGEST_WORDS,
  CommandTypes.TASK_LIST,
  CommandTypes.PRODUCT_LIST,
])

/** 需要交由 AnalysisRouterDeps 处理的 Workbench 数据源 / 分析命令（P7）。 */
const ANALYSIS_ROUTED_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.DATA_SOURCE_LIST,
  CommandTypes.DATA_SOURCE_SCHEMA,
  CommandTypes.DATA_SOURCE_QUERY,
  CommandTypes.PROMPT_RULE_LIST,
  CommandTypes.PROMPT_RULE_UPSERT,
  CommandTypes.PROMPT_RULE_DELETE,
  CommandTypes.ANALYSIS_CREATE,
  CommandTypes.ANALYSIS_GET,
  CommandTypes.ANALYSIS_CANCEL,
  CommandTypes.ANALYSIS_RESULT_GET,
])

/** 需要交由 FeishuWriteRouterDeps 处理的飞书商品写入命令（P7 后台）。 */
const FEISHU_WRITE_ROUTED_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.FEISHU_PRODUCT_WRITE_PREVIEW,
  CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE,
])

/** 需要交由 FeishuSchemaRouterDeps 处理的飞书表字段同步命令（P7 后台）。 */
const FEISHU_SCHEMA_ROUTED_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW,
  CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE,
])

/** 需要交由 ChatRouterDeps 处理的 Workbench 聊天命令。 */
const CHAT_ROUTED_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.CHAT_STATUS,
  CommandTypes.CHAT_LIST_CONVERSATIONS,
  CommandTypes.CHAT_GET_MESSAGES,
  CommandTypes.CHAT_SYNC_HISTORY,
  CommandTypes.CHAT_SYNC_CONVERSATIONS,
])

/** 路由依赖。 */
export interface RouterDeps {
  /** 当前时间戳。 */
  now(): number
  /** service worker 本次实例的启动时间。 */
  workerStartedAt: number
  /** PING 计数 +1，返回新的累计值（持久化在 chrome.storage.session）。 */
  incrementPingCount(): Promise<number>
  /** 广播事件，返回投递数量。 */
  broadcast(type: EventType, payload: unknown): number
  /** 记录订阅（P1 仅回显确认，真正投递由长连接 Port 负责）。 */
  subscribe(events: string[]): string[]
  /** 取消订阅。 */
  unsubscribe(events: string[]): string[]
  /**
   * 取当前可用的平台调用器（P3）；返回 null 表示当前环境未接线
   * （如非扩展环境缺少 chrome.scripting / tabs）。
   */
  platform?: () => PlatformRouterDeps | null
  /** 聊天只读层路由器（P5）；缺省表示聊天层未接线。 */
  chat?: ChatRouterDeps
  /** 采集 / 任务中心路由器（P4）；缺省表示采集层未接线。 */
  capture?: CaptureRouterDeps
  /** 数据分析 / 数据源路由器（P7）；缺省表示分析层未接线。 */
  analysis?: AnalysisRouterDeps
  /** 飞书商品写入路由器（P7 后台）；缺省表示未接线。 */
  feishuWrite?: FeishuWriteRouterDeps
  /** 飞书表字段同步路由器（P7 后台）；缺省表示未接线。 */
  feishuSchema?: FeishuSchemaRouterDeps
  /** 聊天发送与 AI 路由器（P6）；缺省表示 P6 未接线。 */
  reply?: ReplyRouterDeps
  /** 运行时自动准备路由器（P8）；缺省表示运行时未接线。 */
  runtime?: RuntimeRouterDeps
  /** 发布中心路由器（P8）；缺省表示发布中心未接线。 */
  publish?: PublishRouterDeps
  /** 旧扩展配置迁移路由器；缺省表示迁移未接线。 */
  migration?: MigrationRouterDeps
  /** 手动配置（AI / 飞书）路由器；缺省表示配置写入未接线。 */
  config?: ConfigRouterDeps
}

function invalid(requestId: string, type: string, message: string): ResponseEnvelope {
  const error: ProtocolError = { code: 'INVALID_PAYLOAD', message }
  return createErrorResponse(requestId, type, error)
}

/** 错误 message 的安全上限：只回传截断后的单行文本，不携带凭据 / 正文。 */
const ROUTER_ERROR_MESSAGE_MAX = 300

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const single = raw.replace(/\s+/g, ' ').trim()
  return single.length > ROUTER_ERROR_MESSAGE_MAX ? `${single.slice(0, ROUTER_ERROR_MESSAGE_MAX)}…` : single
}

/**
 * 委派一个命令给聊天路由器。
 *
 * 聊天层内部已尽量把业务失败归一为 `result.ok=false`；此处再兼底捕获任何意外异常，
 * 保证聊天命令**永远返回合法 ResponseEnvelope**，不会 reject 到 onMessage 层（导致空响应）。
 */
async function delegateChat(command: CommandEnvelope, chat: ChatRouterDeps): Promise<ResponseEnvelope> {
  try {
    return await chat.handleCommand(command)
  } catch (error) {
    return createErrorResponse(command.requestId, command.type, {
      code: 'INTERNAL',
      message: `聊天命令处理失败: ${safeErrorMessage(error)}`,
    })
  }
}

/** 处理单条命令，返回响应信封；未知命令返回 UNKNOWN_COMMAND。 */
export async function handleCommand(
  command: CommandEnvelope,
  deps: RouterDeps,
): Promise<ResponseEnvelope> {
  switch (command.type) {
    case CommandTypes.PING:
      return handlePing(command, deps)
    case CommandTypes.SUBSCRIBE:
      if (!isSubscribePayload(command.payload)) {
        return invalid(command.requestId, command.type, '非法的 SUBSCRIBE 负载')
      }
      return createResponse(command.requestId, command.type, {
        subscribed: deps.subscribe(command.payload.events),
      })
    case CommandTypes.UNSUBSCRIBE:
      if (!isSubscribePayload(command.payload)) {
        return invalid(command.requestId, command.type, '非法的 UNSUBSCRIBE 负载')
      }
      return createResponse(command.requestId, command.type, {
        subscribed: deps.unsubscribe(command.payload.events),
      })
    case CommandTypes.PUBLISH:
      if (!isPublishPayload(command.payload)) {
        return invalid(command.requestId, command.type, '非法的 PUBLISH 负载')
      }
      return createResponse(command.requestId, command.type, {
        delivered: deps.broadcast(command.payload.event as EventType, command.payload.payload),
      })
    case CommandTypes.PLATFORM_CALL: {
      if (!isPlatformCallPayload(command.payload)) {
        return invalid(command.requestId, command.type, '非法的 PLATFORM_CALL 负载')
      }
      const { method, params } = command.payload
      // 平台方法白名单：只允许 protocol 中登记的方法，防止任意方法透传到页面。
      if (!isPlatformMethod(method)) {
        return invalid(command.requestId, command.type, `未知平台方法: ${method}`)
      }
      return runPlatform(command, deps, (platform) => platform.call(method, params))
    }
    case CommandTypes.PLATFORM_PING:
      if (!isPlatformPingPayload(command.payload)) {
        return invalid(command.requestId, command.type, '非法的 PLATFORM_PING 负载')
      }
      return runPlatform(command, deps, (platform) => platform.ping())
    default:
      if (CHAT_ROUTED_COMMANDS.has(command.type)) {
        if (!deps.chat) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INTERNAL',
            message: '聊天只读层未接线',
          })
        }
        return delegateChat(command, deps.chat)
      }
      if (CAPTURE_ROUTED_COMMANDS.has(command.type)) {
        if (!deps.capture) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INTERNAL',
            message: '采集层未接线',
          })
        }
        return deps.capture.handleCommand(command)
      }
      if (ANALYSIS_ROUTED_COMMANDS.has(command.type)) {
        if (!deps.analysis) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INTERNAL',
            message: '分析层未接线',
          })
        }
        return deps.analysis.handleCommand(command)
      }
      if (REPLY_ROUTED_COMMANDS.has(command.type)) {
        if (!deps.reply) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INTERNAL',
            message: '聊天发送 / AI 层未接线',
          })
        }
        return deps.reply.handleCommand(command)
      }
      if (RUNTIME_ROUTED_COMMANDS.has(command.type)) {
        if (!deps.runtime) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INTERNAL',
            message: '运行时层未接线',
          })
        }
        return deps.runtime.handleCommand(command)
      }
      if (MIGRATION_ROUTED_COMMANDS.has(command.type)) {
        if (!deps.migration) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INTERNAL',
            message: '配置迁移层未接线',
          })
        }
        return deps.migration.handleCommand(command)
      }
      if (CONFIG_ROUTED_COMMANDS.has(command.type)) {
        if (!deps.config) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INTERNAL',
            message: '配置写入层未接线',
          })
        }
        return deps.config.handleCommand(command)
      }
      if (PUBLISH_ROUTED_COMMANDS.has(command.type)) {
        if (!deps.publish) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INTERNAL',
            message: '发布中心未接线',
          })
        }
        return deps.publish.handleCommand(command)
      }
      if (FEISHU_WRITE_ROUTED_COMMANDS.has(command.type)) {
        if (!deps.feishuWrite) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INTERNAL',
            message: '飞书商品写入层未接线',
          })
        }
        return deps.feishuWrite.handleCommand(command)
      }
      if (FEISHU_SCHEMA_ROUTED_COMMANDS.has(command.type)) {
        if (!deps.feishuSchema) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INTERNAL',
            message: '飞书字段同步层未接线',
          })
        }
        return deps.feishuSchema.handleCommand(command)
      }
      return createErrorResponse(command.requestId, command.type, {
        code: 'UNKNOWN_COMMAND',
        message: `未知命令: ${command.type}`,
      })
  }
}

async function handlePing(command: CommandEnvelope, deps: RouterDeps): Promise<ResponseEnvelope> {
  if (!isPingPayload(command.payload)) {
    return invalid(command.requestId, command.type, '非法的 PING 负载')
  }
  const pingCount = await deps.incrementPingCount()
  const receivedAt = deps.now()
  // 顺带广播 PING_RECEIVED，便于 Workbench 观察链路活动。
  deps.broadcast(EventTypes.PING_RECEIVED, {
    nonce: command.payload.nonce,
    pingCount,
    receivedAt,
  })
  const result: PingResult = {
    pong: true,
    nonce: command.payload.nonce,
    pingCount,
    workerStartedAt: deps.workerStartedAt,
    serverTime: deps.now(),
  }
  return createResponse(command.requestId, command.type, result)
}

/**
 * 执行一次平台调用并封装响应。
 *
 * 成功：`createResponse` 原样返回平台结果；
 * 失败（未接线 / tab 不可用 / 未登录 / 风控等）：统一转成 `PLATFORM_ERROR`，
 * 并在 `error.category` 中带上结构化类别（不含 token / cookie / 原始响应）。
 */
async function runPlatform(
  command: CommandEnvelope,
  deps: RouterDeps,
  invoke: (platform: PlatformRouterDeps) => Promise<unknown>,
): Promise<ResponseEnvelope> {
  const platform = deps.platform?.() ?? null
  if (!platform) {
    return platformErrorResponse(
      command.requestId,
      command.type,
      new PlatformError(
        'host-unavailable',
        '平台层未接线：当前环境缺少 chrome.scripting / tabs（或未在扩展中运行）',
      ),
    )
  }
  try {
    return createResponse(command.requestId, command.type, await invoke(platform))
  } catch (error) {
    return platformErrorResponse(command.requestId, command.type, error)
  }
}

/** 把平台错误归一为带类别的 PLATFORM_ERROR 响应。 */
function platformErrorResponse(requestId: string, type: string, error: unknown): ResponseEnvelope {
  const payload = toPlatformError(error).toPayload()
  return createErrorResponse(requestId, type, {
    code: 'PLATFORM_ERROR',
    message: payload.message,
    category: payload.category,
    ...(payload.retCode === undefined ? {} : { retCode: payload.retCode }),
  })
}
