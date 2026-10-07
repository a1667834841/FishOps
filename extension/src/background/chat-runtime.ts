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
import { PeerProfileResolver, type PeerProfileRequester } from '../chat/peer-profiles'
import { fetchPeerProfileInPage, isPeerProfilePageResult } from '../chat/peer-profiles-main'
import { ChatStore, type ChatPersistence } from '../chat/store'
import { ChatSync, type SyncResult } from '../chat/sync'
import type { ChatReadTransport } from '../chat/read-transport'

/** 需要 background `ChatRuntime` 处理的 Workbench 命令。 */
const CHAT_COMMANDS: ReadonlySet<string> = new Set<string>([
  ChatBridgeCommands.CHAT_STATUS,
  ChatBridgeCommands.CHAT_LIST_CONVERSATIONS,
  ChatBridgeCommands.CHAT_GET_MESSAGES,
  ChatBridgeCommands.CHAT_SYNC_HISTORY,
  ChatBridgeCommands.CHAT_SYNC_CONVERSATIONS,
  ChatBridgeCommands.CHAT_MARK_READ,
])

/** 是否为走 ChatRuntime 的聊天命令（不含 CHAT_SOCKET_EVENT，后者由 background 单独按来源校验）。 */
export function isChatCommand(type: string): boolean {
  return CHAT_COMMANDS.has(type)
}

export interface ChatRuntimeDeps {
  /** 只读 LWP transport；缺省时历史同步返回失败。 */
  transport?: ChatTransport
  /** 已读接口的独立写 transport；缺省时 CHAT_MARK_READ 返回 READ_UNAVAILABLE。 */
  readTransport?: ChatReadTransport
  /** 持久化实现；缺省用内存。 */
  persistence?: ChatPersistence
  /** 当前用户 ID，用于历史消息方向判断。 */
  myUserId?: string
  /** 对方头像补齐器；显式注入优先（测试用）。缺省时按环境自组。 */
  peerProfiles?: PeerProfileResolver
  /** 对方头像只读 requester；显式注入优先（测试用），用于自组补齐器。 */
  peerProfileRequester?: PeerProfileRequester

  /** 解析 goofish tab id；缺省时自解析 `chrome.tabs` 中的 goofish 页面。 */
  resolvePeerProfileTabId?: () => Promise<number | null>
}

export interface ChatRuntime {
  /** 从持久化载入已有数据。 */
  init(): Promise<void>
  /** 处理一条 Workbench 聊天命令。 */
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
  /** 摄入一条 MAIN world 上报的 socket 事件（不抛错）。 */
  ingestSocketEvent(payload: ChatSocketEventPayload): SyncResult | undefined
  /** 取出并清空待广播事件。 */
  drainEvents(): BridgeEventEnvelopeLike[]
  /**
   * 动态更新当前登录用户 ID，并同步到已有 history / sync / adapter。
   *
   * 用于 runtime 首次组装时登录态尚未就绪（myUserId 缺失）、后续准备流程才解析出真实 ID
   * 的场景：更新后已缓存消息方向会被重新归一（仅 `in → out` 纠正），**绝不丢本地发送回显
   * `pendingEcho` 与头像**。空串视为未就绪，不做纠正（不猜测方向）。
   */
  setMyUserId(userId: string): void
  /**
   * 暴露内部 store，供 P6（发送 / 回复）写入「已确认发出」的消息。
   *
   * 目的：保证 P6 写入与 P5 只读（CHAT_GET_MESSAGES / 实时 ingest）**读写同一份内存缓存**，
   * 使发送成功后 UI 无需同步历史即可读到；同时复用 P5 的去重键口径。
   */
  getStore(): ChatStore
}

/** 创建聊天运行时。 */
export function createChatRuntime(deps: ChatRuntimeDeps = {}): ChatRuntime {
  const store = new ChatStore(deps.persistence ?? undefined)
  const history = deps.transport
    ? new ChatHistoryClient({ transport: deps.transport, ...(deps.myUserId === undefined ? {} : { myUserId: deps.myUserId }) })
    : undefined
  // 对方头像补齐：显式注入优先；否则在支持 chrome.scripting 的环境自组（MAIN world 只读读取）。
  const peerProfiles = resolvePeerProfiles(deps)
  const sync = new ChatSync(
    {
      store,
      ...(history === undefined ? {} : { history }),
      ...(peerProfiles === undefined ? {} : { peerProfiles }),
    },
    deps.myUserId === undefined ? {} : { myUserId: deps.myUserId },
  )
  const adapter = new ChatBridgeAdapter({
    sync,
    store,
    ...(deps.readTransport === undefined ? {} : { readTransport: deps.readTransport }),
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

    getStore(): ChatStore {
      return store
    },

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

    ingestSocketEvent(payload: ChatSocketEventPayload): SyncResult | undefined {
      switch (payload.event) {
        case 'message':
          if (typeof payload.raw === 'string') return adapter.ingestRealtime(payload.raw)
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

    setMyUserId(userId: string): void {
      // sync 会把新 ID 同时传播给 history（解析用）与 peerProfiles（头像归属同步）；
      // adapter 仅用于读取时的即时方向校正。
      sync.setMyUserId(userId)
      adapter.setMyUserId(userId)
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

// ---- 对方头像补齐（peer profiles）组装 ----

/** `chrome.scripting.executeScript` 的最小子集（与 `platform/host-client.ts` 同形）。 */
interface PeerProfileScriptingApi {
  executeScript(injection: {
    target: { tabId: number }
    world: 'MAIN'
    args: unknown[]
    func: (...args: never[]) => unknown
  }): Promise<Array<{ result?: unknown }>>
}

/** `chrome.tabs.query` 的最小子集。 */
interface PeerProfileTabsApi {
  query(queryInfo: { url?: string }): Promise<Array<{ id?: number; url?: string }>>
}

interface PeerProfileChromeLike {
  scripting?: PeerProfileScriptingApi
  tabs?: PeerProfileTabsApi
}

/**
 * 解析并组装对方头像补齐器。
 *
 * - 显式传入 `peerProfiles` 时直接使用；
 * - 否则用显式 `peerProfileRequester`，或在支持 `chrome.scripting` 的环境自组
 *   MAIN world requester（`chrome.scripting.executeScript({ world:'MAIN' })`）；
 * - 环境不支持（如 Node 测试 / 缺 scripting）时返回 undefined，会话同步照常工作，仅不补头像。
 *
 * `myUserId` 沿用调用方（`index.ts` 经现有 myUserId resolver 解析后传入）的值；
 * 缺失时 `session.sync` 归属判断安全跳过，由 `user.query`（按 peerUserId）兜底。
 */
function resolvePeerProfiles(deps: ChatRuntimeDeps): PeerProfileResolver | undefined {
  if (deps.peerProfiles) return deps.peerProfiles
  const requester = deps.peerProfileRequester ?? createMainWorldPeerProfileRequester(deps.resolvePeerProfileTabId)
  if (!requester) return undefined
  return new PeerProfileResolver({
    requester,
    ...(deps.myUserId === undefined ? {} : { myUserId: deps.myUserId }),
  })
}

/** 组装走页面 MAIN world 官方 mtop SDK 的只读 requester；缺 chrome.scripting 时返回 undefined。 */
function createMainWorldPeerProfileRequester(
  resolveTabId?: () => Promise<number | null>,
): PeerProfileRequester | undefined {
  const chromeLike = (globalThis as { chrome?: PeerProfileChromeLike }).chrome
  const scripting = chromeLike?.scripting
  if (!scripting || typeof scripting.executeScript !== 'function') return undefined

  return {
    async request({ api, data }) {
      const tabId = resolveTabId ? await resolveTabId() : await resolveGoofishTabId(chromeLike?.tabs)
      if (tabId === null || tabId === undefined) throw new Error('NO_GOOFISH_TAB')
      const results = await scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [{ api, data }],
        func: fetchPeerProfileInPage,
      })
      const result = results[0]?.result
      if (isPeerProfilePageResult(result)) {
        if (result.ok) return result.payload
        throw new Error(result.code)
      }
      throw new Error('PEER_PROFILE_FAILED')
    },
  }
}

/** 自解析 goofish tab：优先 `/im` 页面，其次任意 goofish 页面；找不到返回 null。 */
async function resolveGoofishTabId(tabs?: PeerProfileTabsApi): Promise<number | null> {
  if (!tabs || typeof tabs.query !== 'function') return null
  try {
    const found = await tabs.query({ url: 'https://www.goofish.com/*' })
    const imTab = found.find((tab) => typeof tab.url === 'string' && /\/im(?:[/?#]|$)/.test(tab.url))
    const chosen = imTab ?? found[0]
    return typeof chosen?.id === 'number' ? chosen.id : null
  } catch {
    return null
  }
}
