/**
 * background 聊天只读运行时（P5 接线）。
 *
 * 组装 `ChatStore`（session 持久化）+ `ChatHistoryClient`（只读 LWP transport）+
 * `ChatSync` + `ChatBridgeAdapter`，把 P5 模块暴露为 P1 命令/事件：
 * - 处理 Workbench 的 `CHAT_*` 命令（STATUS / LIST / GET / SYNC_*）；
 * - 摄入 goofish MAIN world 上报的 `CHAT_SOCKET_EVENT`；
 * - 产出待广播事件（背景仅含元数据，不含聊天正文）。
 *
 * 边界：只读、不发送、不自动回复、不调用 AI。
 */
import {
  createErrorResponse,
  createResponse,
  type ChatSocketEventPayload,
  type CommandEnvelope,
  type ProtocolError,
  type ResponseEnvelope,
} from '@fishops/shared'
import { ChatBridgeAdapter, ChatBridgeCommands, type BridgeEventEnvelopeLike } from '../chat/bridge-adapter'
import { ChatHistoryClient, type ChatTransport } from '../chat/history'
import { ChatStore, type ChatPersistence } from '../chat/store'
import { ChatSync } from '../chat/sync'

/** 需要 background `ChatRuntime` 处理的 Workbench 命令。 */
const CHAT_COMMANDS: ReadonlySet<string> = new Set<string>([
  ChatBridgeCommands.CHAT_STATUS,
  ChatBridgeCommands.CHAT_LIST_CONVERSATIONS,
  ChatBridgeCommands.CHAT_GET_MESSAGES,
  ChatBridgeCommands.CHAT_SYNC_HISTORY,
  ChatBridgeCommands.CHAT_SYNC_CONVERSATIONS,
])

/** 是否为走 ChatRuntime 的聊天命令（不含 CHAT_SOCKET_EVENT，后者由 background 单独按来源校验）。 */
export function isChatCommand(type: string): boolean {
  return CHAT_COMMANDS.has(type)
}

export interface ChatRuntimeDeps {
  /** 只读 LWP transport；缺省时历史同步返回失败。 */
  transport?: ChatTransport
  /** 持久化实现；缺省用内存。 */
  persistence?: ChatPersistence
  /** 当前用户 ID，用于历史消息方向判断。 */
  myUserId?: string
}

export interface ChatRuntime {
  /** 从持久化载入已有数据。 */
  init(): Promise<void>
  /** 处理一条 Workbench 聊天命令。 */
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
  /** 摄入一条 MAIN world 上报的 socket 事件（不抛错）。 */
  ingestSocketEvent(payload: ChatSocketEventPayload): void
  /** 取出并清空待广播事件。 */
  drainEvents(): BridgeEventEnvelopeLike[]
}

/** 创建聊天运行时。 */
export function createChatRuntime(deps: ChatRuntimeDeps = {}): ChatRuntime {
  const store = new ChatStore(deps.persistence ?? undefined)
  const history = deps.transport
    ? new ChatHistoryClient({ transport: deps.transport, ...(deps.myUserId === undefined ? {} : { myUserId: deps.myUserId }) })
    : undefined
  const sync = new ChatSync(
    history ? { store, history } : { store },
    deps.myUserId === undefined ? {} : { myUserId: deps.myUserId },
  )
  const adapter = new ChatBridgeAdapter({
    sync,
    store,
    ...(deps.myUserId === undefined ? {} : { myUserId: deps.myUserId }),
  })

  // init 幂等：首次调用（或首个命令）时从持久化载入，避免读到空 store。
  let initPromise: Promise<void> | null = null
  const ensureInit = (): Promise<void> => {
    if (!initPromise) initPromise = store.init()
    return initPromise
  }

  return {
    init: ensureInit,

    async handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope> {
      if (!isChatCommand(command.type)) {
        return createErrorResponse(command.requestId, command.type, {
          code: 'UNKNOWN_COMMAND',
          message: `非聊天命令: ${command.type}`,
        })
      }
      try {
        await ensureInit()
        const response = await adapter.handleCommand({
          kind: 'command',
          requestId: command.requestId,
          type: command.type,
          payload: command.payload,
        })
        if (response.ok) {
          return createResponse(command.requestId, command.type, response.result)
        }
        const error: ProtocolError = {
          code: normalizeErrorCode(response.error?.code),
          message: response.error?.message ?? '聊天命令处理失败',
        }
        return createErrorResponse(command.requestId, command.type, error)
      } catch (error) {
        // init（持久化载入）或 adapter 意外异常：归一为结构化 INTERNAL，绝不 reject，
        // 避免异常逃出 listener 导致端口关闭 / 客户端收到空响应。
        return createErrorResponse(command.requestId, command.type, {
          code: 'INTERNAL',
          message: `聊天层初始化 / 执行失败: ${safeErrorMessage(error)}`,
        })
      }
    },

    ingestSocketEvent(payload: ChatSocketEventPayload): void {
      switch (payload.event) {
        case 'message':
          if (typeof payload.raw === 'string') adapter.ingestRealtime(payload.raw)
          break
        case 'open':
          adapter.reportSocketStatus('open')
          break
        case 'close':
          adapter.reportSocketStatus('closed')
          break
        case 'error':
          adapter.reportSocketStatus('error')
          break
        default:
          break
      }
    },

    drainEvents(): BridgeEventEnvelopeLike[] {
      return adapter.drainEvents()
    },
  }
}

/** 把 adapter 的错误码归一到协议错误码（未知码统一为 INTERNAL）。 */
function normalizeErrorCode(code: string | undefined): ProtocolError['code'] {
  switch (code) {
    case 'INVALID_PAYLOAD':
    case 'UNKNOWN_COMMAND':
    case 'INTERNAL':
    case 'TIMEOUT':
      return code
    default:
      return 'INTERNAL'
  }
}

/** 错误 message 的安全上限：只回传截断后的单行文本，不携带任何凭据 / 正文。 */
const RUNTIME_ERROR_MESSAGE_MAX = 300

function safeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const single = raw.replace(/\s+/g, ' ').trim()
  return single.length > RUNTIME_ERROR_MESSAGE_MAX ? `${single.slice(0, RUNTIME_ERROR_MESSAGE_MAX)}…` : single
}
