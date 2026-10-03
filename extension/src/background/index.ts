/**
 * MV3 background service worker 入口。
 *
 * 职责（P1）：
 * 1. 处理 Workbench 发来的 Command（PING / SUBSCRIBE / UNSUBSCRIBE / PUBLISH）；
 * 2. 通过长连接 Port 向 Workbench 推送 Event，并按订阅精确投递；
 * 3. 关键状态写入 chrome.storage.session，保证 service worker 被回收后仍可用。
 */
import {
  createCommand,
  createErrorResponse,
  createEvent,
  createResponse,
  CommandTypes,
  EVENT_PORT_NAME,
  EventTypes,
  isChatRuntimePreparePayload,
  isChatSocketEventPayload,
  isCommandEnvelope,
  isEmptyPayload,
  isSubscribeMessage,
  type ChatRuntimePrepareResult,
  type ChatSocketEventPayload,
  type CommandEnvelope,
  type EventType,
  type ResponseEnvelope,
  type RuntimeSocketStatus,
  type RuntimeStatusChangeReason,
  type RuntimeStatusResult,
} from '@fishops/shared'
import { handleCommand, type PlatformRouterDeps } from './message-router'
import { createChatRuntime, type ChatRuntime } from './chat-runtime'
import { isTrustedChatContentSource } from './chat-source'
import { isExtensionPageSender } from './sender-policy'
import { incrementCounter, readState, writeState } from './session-store'
import type { TabsApi } from './tab-manager'
import {
  createRuntimeSession,
  type RuntimeSession,
  type RuntimeTabsApi,
} from './runtime-session'
import { createMyUserIdResolver, type MyUserIdResolver } from './my-user-id'
import { SessionChatPersistence } from '../chat/session-persistence'
import { createBackgroundChatTransport, createChromeChatExecutor, type ChatScriptingApi } from '../chat/background-transport'
import {
  createChromeScriptExecutor,
  createPlatformHostClient,
  type ScriptingApi,
} from '../platform/host-client'
import { PlatformMethods } from '../platform/protocol'
import { PlatformError } from '../platform/errors'
import { createCaptureRuntime, type CaptureRuntime } from './capture-runtime'
import { createProductRepository } from '../capture/repository'
import type { CapturePlatform } from '../capture/controller'
import { createAnalysisRuntime, type AnalysisRuntime } from './analysis-runtime'
import { createFeishuWriteRuntime, type FeishuWriteRuntime } from './feishu-write-runtime'
import { createFeishuSchemaRuntime, type FeishuSchemaRuntime } from './feishu-schema-runtime'
import { createReplyRuntime, type ReplyRuntime } from './reply-runtime'
import { createPublishRuntime, type PublishRuntime } from './publish-runtime'
import { ChatMessageSender } from '../chat/send-client'
import { createBackgroundSendTransport, createChromeSendExecutor, type SendScriptingApi } from '../chat/send-background'
import { AiChatService } from '../chat/ai-service'
import { ChromeReplyConfigStore, type StorageLocalLike } from '../chat/reply-config-chrome'
import { MemoryReplyConfigStore, type ReplyConfigStore } from '../chat/reply-config'
import { createMigrationRuntime, type MigrationRuntime } from './migration-runtime'
import { createConfigRuntime, type ConfigRuntime } from './config-runtime'
import { LegacyConfigMigration } from '../data-source/legacy-config-migration'
import {
  ChromeFeishuConfigStore,
  MemoryFeishuConfigStore,
  type FeishuConfigStore,
  type FeishuStorageLike,
} from '../data-source/feishu-config-store'
import type { ChatMessage } from '../../../shared/types/chat'
import type { MigrateLegacyConfigResult } from '../../../shared/types/legacy-migration'
import { createPersistentTaskStore, TaskManager } from '../../../shared/task/index'

/** 本实例（service worker 生命周期内）的启动时间。 */
const workerStartedAt = Date.now()

const PING_COUNT_KEY = 'fishops.pingCount'
const EVER_STARTED_KEY = 'fishops.everStarted'

/** 事件订阅者：key 为事件长连接 Port，value 为该 Port 订阅的事件类型集合。 */
const subscribers = new Map<chrome.runtime.Port, Set<string>>()

/** 本次浏览器会话内是否为首次启动 service worker。 */
let firstStartOfSession = false

// ---- 平台层（P3）：懒组装，避免在 Node smoke 等无 chrome.scripting 的环境顶层报错 ----

/** 本次 service worker 实例内缓存的平台调用器。 */
let platformRouterDeps: PlatformRouterDeps | null = null

/**
 * 组装平台调用器（tab-manager + host-client）。
 *
 * 仅在首次需要时创建：Node smoke 测试的 chrome mock 没有 `scripting`，
 * 顶层就访问会让 background 无法 import。环境不具备时返回 null，
 * 由 message-router 统一回 PLATFORM_ERROR（host-unavailable）。
 */
function getPlatformRouterDeps(): PlatformRouterDeps | null {
  if (platformRouterDeps) return platformRouterDeps

  const scripting = chrome.scripting as unknown as ScriptingApi | undefined
  const tabs = chrome.tabs as unknown as TabsApi | undefined
  if (!scripting || !tabs) return null

  /** 最近一次平台调用实际使用的 tab id（用于把 ping 结果回写到 hostReady）。 */
  let lastResolvedTabId: number | null = null

  const client = createPlatformHostClient({
    executor: createChromeScriptExecutor(scripting),
    // 平台调用统一走运行时会话：优先复用已登录的 /im tab，缺失时后台创建（active:false）。
    resolveTabId: async () => {
      const session = getRuntimeSession()
      if (!session) return null
      const result = await session.ensureTab({ purpose: 'platform' })
      // 记录本次实际使用的 tab，供 ping 成功后回写 hostReady。
      lastResolvedTabId = result.ok ? result.tabId : null
      return lastResolvedTabId
    },
  })

  platformRouterDeps = {
    call: (method, params) => client.callRaw(method, params),
    // ping 是对页面 host 的**真实探测**：成功/失败都要回写会话的 hostReady，
    // 保证 RUNTIME_STATUS.hostReady 与 PLATFORM_PING 结果一致。
    ping: async () => {
      lastResolvedTabId = null
      const session = getRuntimeSession()
      try {
        const result = await client.ping()
        if (session && lastResolvedTabId !== null) {
          session.noteHostProbe(lastResolvedTabId, true)
          broadcastRuntimeStatus('host-probe')
        }
        return result
      } catch (error) {
        if (session && lastResolvedTabId !== null) {
          session.noteHostProbe(lastResolvedTabId, false)
          broadcastRuntimeStatus('host-probe')
        }
        throw error
      }
    },
  }
  console.info('[FishOps:Background] 平台层已接线（runtime-session + host-client）')
  return platformRouterDeps
}

// ---- 当前用户 ID（用于聊天方向判断与发送）：platform.currentUserId，带 TTL / 退避 ----

/** 获取当前用户 ID 的超时上限，避免平台调用异常时无限期阻塞。 */
const MY_USER_ID_TIMEOUT_MS = 4000

/** 当前用户 ID 解析器（惰性创建，惰性以避免在无 chrome 环境顶层报错）。 */
let myUserIdResolver: MyUserIdResolver | null = null

function getMyUserIdResolver(): MyUserIdResolver {
  if (myUserIdResolver) return myUserIdResolver
  myUserIdResolver = createMyUserIdResolver({ fetch: fetchMyUserId, now: () => Date.now() })
  return myUserIdResolver
}

/** 解析当前登录用户 ID；失败/环境不可用时返回 undefined（不抛错）。 */
async function resolveMyUserId(): Promise<string | undefined> {
  const outcome = await getMyUserIdResolver().get()
  return outcome.ok ? outcome.userId : undefined
}

/**
 * 真正拉取当前用户 ID；失败抛 {@link PlatformError}（由 resolver 归类为 host-unavailable /
 * unauthorized / captcha 等）。**不记录用户 ID 值**。
 */
async function fetchMyUserId(): Promise<string> {
  const platform = getPlatformRouterDeps()
  if (!platform) {
    throw new PlatformError('host-unavailable', '平台层未接线：当前环境缺少 chrome.scripting / tabs（或未在扩展中运行）')
  }
  const result = await withTimeout(platform.call(PlatformMethods.CURRENT_USER_ID, {}), MY_USER_ID_TIMEOUT_MS)
  const userId = extractCurrentUserId(result)
  if (!userId) throw new PlatformError('unknown', '登录用户接口未返回用户 ID')
  console.info('[FishOps:Background] 已获取当前用户 ID（值不记录，仅用于方向判断与发送）')
  return userId
}

/** 从平台返回值中提取 userId（结构不符时返回 undefined）。 */
function extractCurrentUserId(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const value = (result as { userId?: unknown }).userId
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 给 promise 加超时，超时后 reject；用于约束平台调用不无限期挂起。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('平台调用超时')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** 提取错误信息文本（保留真实错误，不吞）。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---- 聊天只读层（P5）：惰性组装，不依赖 chrome.scripting 是否可用 ----

/** 单例聊天运行时（init 成功后才赋值）。 */
let chatRuntime: ChatRuntime | null = null
/** 进行中的组装 promise（并发去重）；init 失败时置空以便下次重建重试。 */
let chatRuntimePromise: Promise<ChatRuntime> | null = null

// ---- 闲鱼运行时（P8）：按需复用 / 后台创建 goofish tab ----

/** 单例运行时会话（惰性创建，避免在无 chrome 环境顶层报错）。 */
let runtimeSession: RuntimeSession | null = null

/** socket 事件 → 状态（不改变状态的 message 事件返回 null）。 */
function noteSocketStatusFromEvent(payload: ChatSocketEventPayload): void {
  const session = getRuntimeSession()
  if (!session) return
  const status: RuntimeSocketStatus | null =
    payload.event === 'open'
      ? 'open'
      : payload.event === 'close'
        ? 'closed'
        : payload.event === 'error'
          ? 'error'
          : null
  if (!status) return
  session.noteSocketStatus(status)
  broadcastRuntimeStatus('socket-status')
}

/**
 * 组装运行时会话；环境缺少必要 chrome.tabs 子集（query/create/get/onUpdated）时返回 null。
 *
 * `probeHost` 通过 chrome.scripting 在目标 tab 的 MAIN world 执行 platform.ping，
 * 用于判断页面 host 是否就绪；`fetchUserId` 复用 myUserId 解析器（带 TTL / 退避）。
 */
function getRuntimeSession(): RuntimeSession | null {
  if (runtimeSession) return runtimeSession
  const tabs = chrome.tabs as unknown as RuntimeTabsApi | undefined
  if (
    !tabs ||
    typeof tabs.query !== 'function' ||
    typeof tabs.create !== 'function' ||
    typeof tabs.get !== 'function' ||
    !tabs.onUpdated ||
    typeof tabs.onUpdated.addListener !== 'function'
  ) {
    return null
  }
  const session = createRuntimeSession({
    tabs,
    probeHost: async (tabId) => {
      const scripting = chrome.scripting as unknown as ScriptingApi | undefined
      if (!scripting) throw new Error('当前环境缺少 chrome.scripting')
      const raw = await createChromeScriptExecutor(scripting).execute(tabId, PlatformMethods.PING, {})
      if (raw === undefined || raw === null) throw new Error('页面平台 host 未就绪')
    },
    fetchUserId: (force) => getMyUserIdResolver().get({ force }),
  })
  tabs.onRemoved?.addListener((tabId) => session.handleTabRemoved(tabId))
  runtimeSession = session
  console.info('[FishOps:Background] 运行时会话已接线（tab 复用 / 后台创建 + host 探测）')
  return session
}

/**
 * 解析目标 goofish tab id：优先复用现有 tab，缺失时后台创建（active:false）并等待加载；
 * 环境不可用（无 chrome.tabs 子集）时返回 null（不抛错）。
 */
function resolveChatTabId(): Promise<number | null> {
  const session = getRuntimeSession()
  if (!session) return Promise.resolve(null)
  return session.ensureTab({ purpose: 'chat' }).then((result) => (result.ok ? result.tabId : null))
}

/**
 * 取聊天运行时单例（异步）。
 *
 * 顺序保证：
 * 1. 先解析 myUserId（`platform.currentUserId`，带超时与缓存）供方向判断；
 * 2. 再创建 runtime 并 await `init()` —— **init 完成前不返回实例**，
 *    调用方因此不会在缓存载入前 ingest 实时数据（避免旧缓存覆盖新帧）；
 * 3. init 失败时丢弃实例、清空 promise，并把错误抛出（不吞），下次调用可重建重试。
 *
 * 不在此处校验 chrome.scripting：`CHAT_STATUS/LIST/GET` 只读本地 store，无需 MAIN world；
 * 仅 `CHAT_SYNC_*` 会触发 transport，缺失 scripting 时由 transport 返回结构化错误。
 */
function getChatRuntime(): Promise<ChatRuntime> {
  if (chatRuntime) return Promise.resolve(chatRuntime)
  if (!chatRuntimePromise) chatRuntimePromise = createChatRuntimeInstance()
  return chatRuntimePromise
}

async function createChatRuntimeInstance(): Promise<ChatRuntime> {
  const myUserId = await resolveMyUserId()
  const transport = createBackgroundChatTransport({
    executor: {
      execute: (tabId, request, timeoutMs) => {
        const scripting = chrome.scripting as unknown as ChatScriptingApi | undefined
        if (!scripting) return Promise.reject(new Error('当前环境缺少 chrome.scripting'))
        return createChromeChatExecutor(scripting).execute(tabId, request, timeoutMs)
      },
    },
    resolveTabId: resolveChatTabId,
  })
  const runtime = createChatRuntime({
    transport,
    persistence: new SessionChatPersistence(chrome.storage.session),
    ...(myUserId === undefined ? {} : { myUserId }),
  })
  try {
    await runtime.init()
  } catch (error) {
    // 不缓存失败实例：下次调用会重新创建并重试；错误向上抛出，交给调用方处理（不静默吞掉）。
    chatRuntimePromise = null
    console.error('[FishOps:Background] 聊天缓存载入失败，将在下次调用时重试', error)
    throw error
  }
  chatRuntime = runtime
  console.info('[FishOps:Background] 聊天只读层已接线（store + sync + adapter）')
  return runtime
}

/** 取出并广播聊天事件（无待广播事件时为空操作）。 */
function flushChatEvents(): void {
  if (!chatRuntime) return
  for (const event of chatRuntime.drainEvents()) {
    broadcast(event.type as EventType, event.payload)
  }
}

// ---- 实时帧串行队列：保证「先 init，再按到达顺序 ingest」 ----

/** 实时帧处理链；每帧在上帧完成后才执行，避免乱序或旧缓存覆盖新帧。 */
let chatIngestChain: Promise<void> = Promise.resolve()

function enqueueChatIngest(payload: ChatSocketEventPayload): Promise<void> {
  const run = chatIngestChain.then(async () => {
    const runtime = await getChatRuntime()
    runtime.ingestSocketEvent(payload)
    flushChatEvents()
  })
  // 单帧失败不阻塞后续帧（链继续）；错误仍返回给调用方，不在此吞掉。
  chatIngestChain = run.catch(() => {})
  return run
}

/**
 * 处理来自 goofish content script 的原始 socket 事件。
 *
 * 严格校验来源（必须是本扩展、且来自 goofish 页面的 content script）与负载：
 * 非法来源/负载返回 false；通过后进入串行队列，等 init 完成后按序 ingest。
 */
async function handleChatSocketEvent(
  message: { requestId: string; type: string; payload: unknown },
  sender: chrome.runtime.MessageSender,
): Promise<boolean> {
  if (!isTrustedChatContentSource(sender, chrome.runtime.id)) return false
  if (!isChatSocketEventPayload(message.payload)) return false
  // socket 状态同步记录（不依赖 init），供 `CHAT_RUNTIME_PREPARE` 等待 WebSocket open。
  noteSocketStatusFromEvent(message.payload)
  await enqueueChatIngest(message.payload)
  return true
}

// ---- 采集层（P4）：惰性组装；复用 P3 的 platform.search / platform.detail ----

/**
 * 采集平台端口。
 *
 * `isAvailable()` 实时反映平台层是否接线（缺少 chrome.scripting / tabs 时为 false），
 * 供采集层在开始前给出「初始化错误」而非产生假成功的空结果。
 */
const capturePlatform: CapturePlatform = {
  isAvailable: () => getPlatformRouterDeps() !== null,
  search: async (params) => {
    const platform = requirePlatform()
    return platform.call(PlatformMethods.SEARCH, {
      keyword: params.keyword,
      pageNumber: params.pageNumber,
      rowsPerPage: params.rowsPerPage,
      ...(params.searchFilter === undefined ? {} : { searchFilter: params.searchFilter }),
    })
  },
  detail: async (itemId) => {
    const platform = requirePlatform()
    return platform.call(PlatformMethods.DETAIL, { itemId })
  },
  suggest: async (keyword) => {
    const platform = requirePlatform()
    const words = await platform.call(PlatformMethods.SUGGEST, { inputWords: keyword })
    // 平台层已保证结果为 string[]；防御非数组 / 非字符串，避免脏数据进入上层。
    return Array.isArray(words)
      ? words.filter((word): word is string => typeof word === 'string')
      : []
  },
}

/** 取平台调用器；未接线时抛 host-unavailable。 */
function requirePlatform(): PlatformRouterDeps {
  const platform = getPlatformRouterDeps()
  if (!platform) {
    throw new PlatformError(
      'host-unavailable',
      '平台层未接线：当前环境缺少 chrome.scripting / tabs（或未在扩展中运行）',
    )
  }
  return platform
}

/** 单例采集运行时（init 成功后才赋值）。 */
let captureRuntime: CaptureRuntime | null = null
/** 进行中的组装 promise（并发去重）；init 失败时置空以便下次重建重试。 */
let captureRuntimePromise: Promise<CaptureRuntime> | null = null

/** 取采集运行时单例（异步）。 */
function getCaptureRuntime(): Promise<CaptureRuntime> {
  if (captureRuntime) return Promise.resolve(captureRuntime)
  if (!captureRuntimePromise) captureRuntimePromise = createCaptureRuntimeInstance()
  return captureRuntimePromise
}

async function createCaptureRuntimeInstance(): Promise<CaptureRuntime> {
  const runtime = createCaptureRuntime({
    platform: capturePlatform,
    repository: createProductRepository(),
    getCurrentUserId: resolveMyUserId,
    onEvent: (event) => {
      broadcast(event.type as EventType, event.payload)
    },
  })
  try {
    await runtime.init()
  } catch (error) {
    // 不缓存失败实例：下次调用重新创建并重试；错误向上抛出，不静默吞掉。
    captureRuntimePromise = null
    console.error('[FishOps:Background] 采集层初始化失败，将在下次调用时重试', error)
    throw error
  }
  captureRuntime = runtime
  console.info('[FishOps:Background] 采集层已接线（TaskManager + CaptureController + ProductRepository）')
  return runtime
}

// ---- 数据分析层（P7）：惰性组装 ----

/** 单例分析运行时。 */
let analysisRuntime: AnalysisRuntime | null = null
let analysisRuntimePromise: Promise<AnalysisRuntime> | null = null

function getAnalysisRuntime(): Promise<AnalysisRuntime> {
  if (analysisRuntime) return Promise.resolve(analysisRuntime)
  if (!analysisRuntimePromise) analysisRuntimePromise = createAnalysisRuntimeInstance()
  return analysisRuntimePromise
}

async function createAnalysisRuntimeInstance(): Promise<AnalysisRuntime> {
  // 飞书配置来自专用存储键（可能由迁移写入）；未配置时为 undefined，不注册飞书数据源。
  const feishuConfig = await getFeishuConfigStore().load()
  const runtime = createAnalysisRuntime({
    repository: createProductRepository(),
    ...(feishuConfig === null ? {} : { feishuConfig }),
    onEvent: (event) => {
      broadcast(event.type as EventType, event.payload)
    },
    // 注入全局 AI 供应方配置：使自定义 baseUrl / model / timeoutMs 与密钥对分析任务生效。
    // 凭据仅在请求层使用，绝不进入任务 / 结果 / 事件 / 日志。
    getAiProvider: () => getReplyConfigStore().loadAiProvider(),
  })
  try {
    await runtime.init()
  } catch (error) {
    analysisRuntimePromise = null
    console.error('[FishOps:Background] 分析层初始化失败，将在下次调用时重试', error)
    throw error
  }
  analysisRuntime = runtime
  console.info('[FishOps:Background] 数据分析层已接线（TaskManager + AnalysisService + PromptRuleStore）')
  return runtime
}

// ---- 飞书商品写入（P7 后台）：惰性组装 ----

/** 单例飞书商品写入运行时。 */
let feishuWriteRuntime: FeishuWriteRuntime | null = null
let feishuWriteRuntimePromise: Promise<FeishuWriteRuntime> | null = null

function getFeishuWriteRuntime(): Promise<FeishuWriteRuntime> {
  if (feishuWriteRuntime) return Promise.resolve(feishuWriteRuntime)
  if (!feishuWriteRuntimePromise) {
    // 组装本身为同步操作，这里统一包装为 Promise，失败时允许下次重试。
    try {
      feishuWriteRuntime = createFeishuWriteRuntime({
        feishuConfigStore: getFeishuConfigStore(),
        repository: createProductRepository(),
      })
      feishuWriteRuntimePromise = Promise.resolve(feishuWriteRuntime)
      console.info('[FishOps:Background] 飞书商品写入层已接线（预览只读 / 执行需 confirm / 只写已配置商品表）')
    } catch (error) {
      feishuWriteRuntimePromise = null
      return Promise.reject(error)
    }
  }
  return feishuWriteRuntimePromise
}

// ---- 飞书表字段同步（P7 后台）：惰性组装 ----

/** 单例飞书表字段同步运行时。 */
let feishuSchemaRuntime: FeishuSchemaRuntime | null = null
let feishuSchemaRuntimePromise: Promise<FeishuSchemaRuntime> | null = null

function getFeishuSchemaRuntime(): Promise<FeishuSchemaRuntime> {
  if (feishuSchemaRuntime) return Promise.resolve(feishuSchemaRuntime)
  if (!feishuSchemaRuntimePromise) {
    try {
      feishuSchemaRuntime = createFeishuSchemaRuntime({ feishuConfigStore: getFeishuConfigStore() })
      feishuSchemaRuntimePromise = Promise.resolve(feishuSchemaRuntime)
      console.info('[FishOps:Background] 飞书字段同步层已接线（并集目标 / 预览只读 / 执行需 confirm / 不删字段）')
    } catch (error) {
      feishuSchemaRuntimePromise = null
      return Promise.reject(error)
    }
  }
  return feishuSchemaRuntimePromise
}

// ---- 发布中心（P8）：惰性组装 ----

/** 单例 P8 运行时。 */
let publishRuntime: PublishRuntime | null = null
let publishRuntimePromise: Promise<PublishRuntime> | null = null

function getPublishRuntime(): Promise<PublishRuntime> {
  if (publishRuntime) return Promise.resolve(publishRuntime)
  if (!publishRuntimePromise) {
    publishRuntimePromise = createPublishRuntimeInstance().catch((err) => {
      publishRuntimePromise = null
      throw err
    })
  }
  return publishRuntimePromise
}

async function createPublishRuntimeInstance(): Promise<PublishRuntime> {
  const tabs = typeof chrome !== 'undefined' && chrome.tabs ? chrome.tabs : undefined
  const scripting = typeof chrome !== 'undefined' && chrome.scripting ? chrome.scripting : undefined

  // 发布任务历史必须跨扩展 reload 保留：waiting_confirmation 断点若落在 chrome.storage.session，
  // 会在扩展 reload / 更新时被官方语义清空，导致 PUBLISH_LIST total=0。
  // 因此发布中心单独使用 chrome.storage.local 持久化，并用独立前缀与 capture/analysis 任务存储隔离。
  const tasks = new TaskManager({ store: createPersistentTaskStore('fishops.publish') })

  const runtime = createPublishRuntime({
    repository: createProductRepository(),
    tasks,
    tabs: tabs as any,
    scripting: scripting as any,
    onEvent: (event) => {
      broadcast(event.type as EventType, event.payload)
    },
  })
  try {
    await runtime.init()
  } catch (error) {
    publishRuntimePromise = null
    console.error('[FishOps:Background] 发布中心初始化失败，将在下次调用时重试', error)
    throw error
  }
  publishRuntime = runtime
  console.info('[FishOps:Background] 发布中心已接线（TaskManager + PublishController + DOMPublishFormFiller）')
  return runtime
}

// ---- 聊天发送与 AI（P6）：惰性组装 ----

/** 单例 P6 运行时。 */
let replyRuntime: ReplyRuntime | null = null
let replyRuntimePromise: Promise<ReplyRuntime> | null = null

function getReplyRuntime(): Promise<ReplyRuntime> {
  if (replyRuntime) return Promise.resolve(replyRuntime)
  if (!replyRuntimePromise) replyRuntimePromise = createReplyRuntimeInstance()
  return replyRuntimePromise
}

/** 读取某会话本地消息（复用 P5 ChatRuntime 的只读命令，不直接触碰 store）。 */
async function readChatMessages(
  sessionId: string,
  options?: { order?: 'asc' | 'desc'; limit?: number },
): Promise<ChatMessage[]> {
  const runtime = await getChatRuntime()
  const response = await runtime.handleCommand(
    createCommand(CommandTypes.CHAT_GET_MESSAGES, {
      sessionId,
      ...(options?.order === undefined ? {} : { order: options.order }),
      ...(options?.limit === undefined ? {} : { limit: options.limit }),
    }),
  )
  if (!response.ok) throw new Error(response.error?.message ?? '读取会话消息失败')
  const result = response.result as { messages?: ChatMessage[] } | undefined
  return Array.isArray(result?.messages) ? result.messages : []
}

/** 组装配置存储：优先 chrome.storage.local（隔离层），否则退化为内存（不持久化）。 */
/**
 * 组装配置存储单例：优先 chrome.storage.local（隔离层），否则退化为内存（不持久化）。
 * 单例确保迁移写入与 P6 运行时读取的是同一份存储（内存回退时也一致）。
 */
let replyConfigStoreInstance: ReplyConfigStore | null = null
function getReplyConfigStore(): ReplyConfigStore {
  if (replyConfigStoreInstance) return replyConfigStoreInstance
  const storage = (chrome.storage as unknown as { local?: StorageLocalLike } | undefined)?.local
  if (storage && typeof storage.get === 'function' && typeof storage.set === 'function') {
    replyConfigStoreInstance = new ChromeReplyConfigStore(storage)
  } else {
    console.warn('[FishOps:Background] chrome.storage.local 不可用，P6 配置改用内存存储（不持久化）')
    replyConfigStoreInstance = new MemoryReplyConfigStore()
  }
  return replyConfigStoreInstance
}

async function createReplyRuntimeInstance(): Promise<ReplyRuntime> {
  const myUserId = await resolveMyUserId()
  const configStore = getReplyConfigStore()
  const sender = new ChatMessageSender({
    transport: createBackgroundSendTransport({
      executor: {
        execute: (tabId, request, timeoutMs) => {
          const scripting = chrome.scripting as unknown as SendScriptingApi | undefined
          if (!scripting) return Promise.reject(new Error('当前环境缺少 chrome.scripting'))
          return createChromeSendExecutor(scripting).execute(tabId, request, timeoutMs)
        },
      },
      resolveTabId: resolveChatTabId,
    }),
  })
  const ai = new AiChatService({ loadProvider: () => configStore.loadAiProvider() })
  const runtime = createReplyRuntime({
    configStore,
    sender,
    ai,
    getMessages: readChatMessages,
    ...(myUserId === undefined ? {} : { myUserId }),
    // 显式发送前准备后台运行时（tab + host + socket + 用户 ID）；自动模式 / 实时消息不经过此处。
    ensureReady: () => ensureChatRuntimePrepared({ force: true }),
    // 发送时重新解析用户 ID：命中成功缓存（5 分钟 TTL）则不重复请求。
    resolveMyUserId: () => getMyUserIdResolver().get(),
  })
  try {
    await runtime.init()
  } catch (error) {
    replyRuntimePromise = null
    console.error('[FishOps:Background] 聊天发送 / AI 层初始化失败，将在下次调用时重试', error)
    throw error
  }
  replyRuntime = runtime
  console.info('[FishOps:Background] 聊天发送与 AI 层已接线（sender + reply-engine + ai-service）')
  return runtime
}

/** 取出并广播 P6 事件（无待广播事件时为空操作）。 */
function flushReplyEvents(): void {
  if (!replyRuntime) return
  for (const event of replyRuntime.drainEvents()) {
    broadcast(event.type as EventType, event.payload)
  }
}

// ---- 旧扩展配置迁移（安全，显式触发）：惰性组装 ----

/**
 * 迁移运行时单例。**只在收到 MIGRATE_LEGACY_CONFIG 命令时创建**，
 * 启动阶段不读取、不复制任何 secret。
 */
let migrationRuntime: MigrationRuntime | null = null
let migrationRuntimePromise: Promise<MigrationRuntime> | null = null
let feishuConfigStore: FeishuConfigStore | null = null

/** 飞书配置存储单例：优先 chrome.storage.local，否则退化为内存（不持久化）。 */
function getFeishuConfigStore(): FeishuConfigStore {
  if (feishuConfigStore) return feishuConfigStore
  const storage = (chrome.storage as unknown as { local?: FeishuStorageLike } | undefined)?.local
  if (storage && typeof storage.get === 'function' && typeof storage.set === 'function') {
    feishuConfigStore = new ChromeFeishuConfigStore(storage)
  } else {
    console.warn('[FishOps:Background] chrome.storage.local 不可用，飞书配置改用内存存储（不持久化）')
    feishuConfigStore = new MemoryFeishuConfigStore()
  }
  return feishuConfigStore
}

function getMigrationRuntime(): Promise<MigrationRuntime> {
  if (migrationRuntime) return Promise.resolve(migrationRuntime)
  if (!migrationRuntimePromise) migrationRuntimePromise = createMigrationRuntimeInstance()
  return migrationRuntimePromise
}

async function createMigrationRuntimeInstance(): Promise<MigrationRuntime> {
  // 不读任何 storage：来源是命令携带的受信载荷，仅在内存中转移。
  const migration = new LegacyConfigMigration({
    replyConfigStore: getReplyConfigStore(),
    feishuConfigStore: getFeishuConfigStore(),
  })
  migrationRuntime = createMigrationRuntime({ migration })
  console.info('[FishOps:Background] 旧扩展配置迁移层已接线（受信载荷，仅显式命令触发，不读 storage / 不回显 secret）')
  return migrationRuntime
}

/**
 * 迁移应用后的运行时就绪刷新（避免用户重载）：
 * - AI provider / 规则 / 全局配置变更 → 刷新已存在的 P6 运行时内存缓存；
 * - 飞书配置变更 → 更新已存在的 P7 分析运行时飞书数据源。
 * 未创建的运行时会按需从专用键加载，无需处理。
 */
async function refreshAfterMigration(result: MigrateLegacyConfigResult | undefined): Promise<void> {
  if (!result || result.mode !== 'applied' || !result.result) return
  const applied = new Set(result.result.applied.map((item) => item.target))
  if (applied.has('aiProvider') || applied.has('rules') || applied.has('globalConfig')) {
    if (replyRuntime) {
      try {
        await replyRuntime.reloadConfig()
      } catch (error) {
        console.warn('[FishOps:Background] 迁移后刷新 P6 配置失败', error)
      }
    }
  }
  if (applied.has('feishuConfig') && analysisRuntime) {
    try {
      const feishuConfig = await getFeishuConfigStore().load()
      if (feishuConfig) analysisRuntime.updateFeishuConfig(feishuConfig)
    } catch (error) {
      console.warn('[FishOps:Background] 迁移后刷新飞书数据源失败', error)
    }
  }
}

// ---- 手动配置（AI / 飞书，专用写入通道）：惰性组装 ----

/** 配置写入运行时单例。首次收到配置命令时惰性创建。 */
let configRuntime: ConfigRuntime | null = null
let configRuntimePromise: Promise<ConfigRuntime> | null = null

function getConfigRuntime(): Promise<ConfigRuntime> {
  if (configRuntime) return Promise.resolve(configRuntime)
  if (!configRuntimePromise) configRuntimePromise = createConfigRuntimeInstance()
  return configRuntimePromise
}

async function createConfigRuntimeInstance(): Promise<ConfigRuntime> {
  // 复用迁移 / P6 / P7 同一存储单例，确保读写命中同一专用键。
  configRuntime = createConfigRuntime({
    replyConfigStore: getReplyConfigStore(),
    feishuConfigStore: getFeishuConfigStore(),
    // AI 探测与 P6 共用同一凭据读取路径；凭据只在请求层使用，绝不进入响应 / 日志。
    ai: new AiChatService({ loadProvider: () => getReplyConfigStore().loadAiProvider() }),
  })
  console.info('[FishOps:Background] 手动配置写入层已接线（AI / 飞书；密钥只落专用键，不回显）')
  return configRuntime
}

/**
 * 手动配置保存后的运行时就绪刷新（避免用户重载）：
 * - AI 配置保存成功 → 刷新已存在的 P6 运行时内存缓存（重载 aiConfigured）；
 * - 飞书配置保存成功 → 更新已存在的 P7 分析运行时飞书数据源。
 * 未创建的运行时会按需从专用键加载，无需处理。
 */
async function refreshAfterConfigSave(commandType: string, response: ResponseEnvelope): Promise<void> {
  if (!response.ok) return
  if (commandType === CommandTypes.AI_CONFIG_SET) {
    if (replyRuntime) {
      try {
        await replyRuntime.reloadConfig()
      } catch {
        // 固定文案：不附带原始异常，避免异常文本间接泄露凭据。
        console.warn('[FishOps:Background] 保存 AI 配置后刷新 P6 运行时失败')
      }
    }
    return
  }
  if (commandType === CommandTypes.FEISHU_CONFIG_SET && analysisRuntime) {
    try {
      const feishuConfig = await getFeishuConfigStore().load()
      if (feishuConfig) analysisRuntime.updateFeishuConfig(feishuConfig)
    } catch {
      // 固定文案：不附带原始异常，避免异常文本间接泄露凭据。
      console.warn('[FishOps:Background] 保存飞书配置后刷新 P7 飞书数据源失败')
    }
  }
}

// ---- 运行时命令与发送前准备（P8） ----

/** 广播运行时状态变化（不含用户 ID 值）。 */
function broadcastRuntimeStatus(reason: RuntimeStatusChangeReason): void {
  const status = runtimeStatusSnapshot()
  broadcast(EventTypes.RUNTIME_STATUS_CHANGED, {
    reason,
    tabReady: status.tabReady,
    hostReady: status.hostReady,
    socketStatus: status.socketStatus,
    userIdReady: status.userIdReady,
  })
}

/** 组装只读运行时状态快照（环境不可用时退化为全 false）。 */
function runtimeStatusSnapshot(): RuntimeStatusResult {
  const session = getRuntimeSession()
  const base = session?.getStatus()
  return {
    tabOpen: base?.tabOpen ?? false,
    tabReady: base?.tabReady ?? false,
    hostReady: base?.hostReady ?? false,
    socketStatus: base?.socketStatus ?? 'connecting',
    userIdReady: getMyUserIdResolver().peek().hasUserId,
    ...(base?.lastError === undefined ? {} : { lastError: base.lastError }),
  }
}

/**
 * 准备聊天运行时（tab + host + socket + 用户 ID），供发送前与显式准备命令复用。
 * 环境不可用时返回结构化 host-unavailable（不抛错）。
 */
async function ensureChatRuntimePrepared(options: {
  purpose?: 'chat' | 'platform'
  force?: boolean
} = {}): Promise<ChatRuntimePrepareResult> {
  const session = getRuntimeSession()
  if (!session) {
    return {
      ok: false,
      tabId: null,
      tabCreated: false,
      platformReady: false,
      socketReady: false,
      socketStatus: 'connecting',
      userIdReady: false,
      error: {
        category: 'host-unavailable',
        message: '运行时不可用：当前环境缺少 chrome.tabs 子集（query/create/get/onUpdated）',
      },
    }
  }

  const result = await session.ensureChatRuntimeReady(options)
  if (result.ok) {
    broadcastRuntimeStatus(result.tabCreated ? 'tab-created' : 'prepare-ok')
    return {
      ok: true,
      tabId: result.tabId,
      tabCreated: result.tabCreated,
      platformReady: result.platformReady,
      socketReady: result.socketReady,
      socketStatus: result.socketStatus,
      userIdReady: true,
    }
  }

  broadcastRuntimeStatus('prepare-failed')
  return {
    ok: false,
    tabId: result.tabId,
    tabCreated: false,
    platformReady: result.platformReady,
    socketReady: result.socketReady,
    socketStatus: result.socketStatus,
    userIdReady: result.userIdReady,
    error: { category: result.category, message: result.message },
  }
}

/** 处理运行时只读 / 准备命令（RUNTIME_STATUS / CHAT_RUNTIME_PREPARE）。 */
async function handleRuntimeCommand(command: CommandEnvelope): Promise<ResponseEnvelope> {
  switch (command.type) {
    case CommandTypes.RUNTIME_STATUS: {
      if (!isEmptyPayload(command.payload)) {
        return createErrorResponse(command.requestId, command.type, {
          code: 'INVALID_PAYLOAD',
          message: '非法的 RUNTIME_STATUS 负载',
        })
      }
      return createResponse(command.requestId, command.type, runtimeStatusSnapshot())
    }
    case CommandTypes.CHAT_RUNTIME_PREPARE: {
      if (!isChatRuntimePreparePayload(command.payload)) {
        return createErrorResponse(command.requestId, command.type, {
          code: 'INVALID_PAYLOAD',
          message: '非法的 CHAT_RUNTIME_PREPARE 负载',
        })
      }
      const result = await ensureChatRuntimePrepared({
        ...(command.payload.purpose === undefined ? {} : { purpose: command.payload.purpose }),
        // 显式准备默认允许重试失败的用户 ID（force 可通过 payload 关闭）。
        force: command.payload.force ?? true,
      })
      return createResponse(command.requestId, command.type, result)
    }
    default:
      return createErrorResponse(command.requestId, command.type, {
        code: 'UNKNOWN_COMMAND',
        message: `非运行时命令: ${command.type}`,
      })
  }
}

async function bootstrap(): Promise<void> {
  const everStarted = await readState<boolean>(EVER_STARTED_KEY, false)
  firstStartOfSession = !everStarted
  if (!everStarted) await writeState(EVER_STARTED_KEY, true)
  console.info(
    `[FishOps:Background] service worker 启动 @${new Date(workerStartedAt).toISOString()} firstStart=${firstStartOfSession}`,
  )
  broadcast(EventTypes.WORKER_STARTED, { workerStartedAt, firstStart: firstStartOfSession })

  // 启动恢复：把遗留 running 的采集任务恢复为 paused（绝不自动续跑）。
  void getCaptureRuntime().catch((error: unknown) => {
    console.warn('[FishOps:Background] 采集层启动恢复失败', error)
  })

  // 启动恢复：把遗留 running 的分析任务恢复为 failed。
  void getAnalysisRuntime().catch((error: unknown) => {
    console.warn('[FishOps:Background] 分析层启动恢复失败', error)
  })

  // 启动恢复：发布任务只挂起遗留 running、保留 waiting_confirmation，绝不自动重跑或自动提交。
  // 发布任务历史持久化在 chrome.storage.local，扩展 reload 后仍可恢复。
  void getPublishRuntime().catch((error: unknown) => {
    console.warn('[FishOps:Background] 发布中心启动恢复失败', error)
  })
}

/** 向订阅了该事件的 Port 广播事件，返回投递数量。 */
function broadcast(type: EventType, payload: unknown): number {
  const event = createEvent(type, payload)
  let delivered = 0
  for (const [port, events] of subscribers) {
    if (!events.has(type)) continue
    try {
      port.postMessage(event)
      delivered += 1
    } catch {
      // Port 已失效（页面关闭或 service worker 被回收），忽略即可。
    }
  }
  return delivered
}

// ---- 事件长连接：Workbench 通过 chrome.runtime.connect 建立 ----
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== EVENT_PORT_NAME) return

  // 只接受本扩展内页建立订阅长连接；content script / 外部页面一律断开，防止事件泄露。
  if (!isExtensionPageSender(port.sender, chrome.runtime.id)) {
    try {
      port.disconnect()
    } catch {
      // 连接可能已断开，忽略即可。
    }
    return
  }

  subscribers.set(port, new Set())

  port.onMessage.addListener((message: unknown) => {
    if (!isSubscribeMessage(message)) return
    const events = subscribers.get(port)
    if (!events) return
    events.clear()
    for (const event of message.events) events.add(event)
  })

  port.onDisconnect.addListener(() => {
    subscribers.delete(port)
  })

  // 新连接建立时补发一次启动事件，避免 Workbench 打开晚于 worker 启动而错过。
  try {
    port.postMessage(
      createEvent(EventTypes.WORKER_STARTED, { workerStartedAt, firstStart: firstStartOfSession }),
    )
  } catch {
    // 忽略：连接可能已关闭。
  }
})

// ---- 命令通道：Workbench 通过 chrome.runtime.sendMessage 发起 ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isCommandEnvelope(message)) return false

  // 聊天实时上报：只允许 goofish 页面的 content script，且需等 init 完成后按序 ingest，
  // 故保持端口打开（返回 true）并异步响应。
  if (message.type === CommandTypes.CHAT_SOCKET_EVENT) {
    // 非本扩展来源（其它扩展 / 外部页面）直接忽略，不响应，避免暴露扩展存在。
    if (sender.id !== chrome.runtime.id) return false
    handleChatSocketEvent(message, sender)
      .then((accepted) => {
        sendResponse(createResponse(message.requestId, message.type, { accepted }))
      })
      .catch((error: unknown) => {
        // init 失败或 ingest 出错：不吞错误，回 accepted=false 并记录。
        console.error('[FishOps:Background] 处理聊天实时事件失败', error)
        sendResponse(createResponse(message.requestId, message.type, { accepted: false }))
      })
    return true
  }

  // 普通 Workbench 命令：只接受本扩展内页来源（chrome-extension://<本扩展 ID>/...），
  // 拒绝 content script 与外部页面（它们的 sender.id 同样是本扩展，光靠 id 校验不够）。
  if (!isExtensionPageSender(sender, chrome.runtime.id)) return false

  handleCommand(message, {
    now: () => Date.now(),
    workerStartedAt,
    incrementPingCount: () => incrementCounter(PING_COUNT_KEY, 1),
    subscribe: (events) => events,
    unsubscribe: (events) => events,
    broadcast,
    platform: getPlatformRouterDeps,
    chat: {
      // init 失败或 runtime.handleCommand 意外异常都回结构化 INTERNAL 错误
      // （不挂起到客户端超时，也不静默；handleCommand 内部已尽量自己归一，这里是双保险）。
      handleCommand: (command) =>
        getChatRuntime()
          .then((runtime) => runtime.handleCommand(command))
          .catch((error: unknown) =>
            createErrorResponse(command.requestId, command.type, {
              code: 'INTERNAL',
              message: `聊天层初始化失败: ${messageOf(error)}`,
            }),
          ),
    },
    capture: {
      // init 失败时回结构化 INTERNAL 错误（不挂起到客户端超时，也不静默）。
      handleCommand: (command) =>
        getCaptureRuntime().then(
          (runtime) => runtime.handleCommand(command),
          (error: unknown) =>
            createErrorResponse(command.requestId, command.type, {
              code: 'INTERNAL',
              message: `采集层初始化失败: ${messageOf(error)}`,
            }),
        ),
    },
    analysis: {
      handleCommand: (command) =>
        getAnalysisRuntime().then(
          (runtime) => runtime.handleCommand(command),
          (error: unknown) =>
            createErrorResponse(command.requestId, command.type, {
              code: 'INTERNAL',
              message: `分析层初始化失败: ${messageOf(error)}`,
            }),
        ),
    },
    feishuWrite: {
      handleCommand: (command) =>
        getFeishuWriteRuntime().then(
          (runtime) => runtime.handleCommand(command),
          () =>
            createErrorResponse(command.requestId, command.type, {
              code: 'INTERNAL',
              // 固定文案：不回显原始异常，避免底层错误间接泄露凭据。
              message: '飞书商品写入层初始化失败',
            }),
        ),
    },
    feishuSchema: {
      handleCommand: (command) =>
        getFeishuSchemaRuntime().then(
          (runtime) => runtime.handleCommand(command),
          () =>
            createErrorResponse(command.requestId, command.type, {
              code: 'INTERNAL',
              message: '飞书字段同步层初始化失败',
            }),
        ),
    },
    reply: {
      // init 失败时回结构化 INTERNAL 错误（不挂起到客户端超时，也不静默）。
      handleCommand: (command) =>
        getReplyRuntime().then(
          (runtime) => runtime.handleCommand(command),
          (error: unknown) =>
            createErrorResponse(command.requestId, command.type, {
              code: 'INTERNAL',
              message: `聊天发送 / AI 层初始化失败: ${messageOf(error)}`,
            }),
        ),
    },
    runtime: {
      // 只读状态 / 运行时准备：不依赖 P5/P6 单例，环境不可用时回结构化错误。
      handleCommand: handleRuntimeCommand,
    },
    migration: {
      // 仅在收到 MIGRATE_LEGACY_CONFIG 时惰性组装；成功后刷新 P6/P7 运行时，避免用户重载。
      handleCommand: (command) =>
        getMigrationRuntime().then(
          (runtime) =>
            runtime.handleCommand(command).then(async (response) => {
              await refreshAfterMigration(response.result as MigrateLegacyConfigResult | undefined)
              return response
            }),
          (error: unknown) =>
            createErrorResponse(command.requestId, command.type, {
              code: 'INTERNAL',
              message: `配置迁移层初始化失败: ${messageOf(error)}`,
            }),
        ),
    },
    publish: {
      handleCommand: (command) =>
        getPublishRuntime().then(
          (runtime) => runtime.handleCommand(command),
          (error: unknown) =>
            createErrorResponse(command.requestId, command.type, {
              code: 'INTERNAL',
              message: `发布中心初始化失败: ${messageOf(error)}`,
            }),
        ),
    },
    config: {
      // 手动配置写入：仅在收到配置命令时惰性组装；成功后刷新 P6/P7 运行时，避免用户重载。
      handleCommand: (command) =>
        getConfigRuntime().then(
          (runtime) =>
            runtime.handleCommand(command).then(async (response) => {
              await refreshAfterConfigSave(command.type, response)
              return response
            }),
          () =>
            createErrorResponse(command.requestId, command.type, {
              code: 'INTERNAL',
              // 固定文案：不回显原始异常文本，避免配置错误泄露凭据。
              message: '配置写入层初始化失败',
            }),
        ),
    },
  })
    .then((response) => {
      flushChatEvents()
      flushReplyEvents()
      sendResponse(response)
    })
    .catch((error: unknown) => {
      console.error('[FishOps:Background] 处理命令失败', error)
      // 兜底：绝不 sendResponse(undefined)（客户端会判为 INVALID_MESSAGE）；
      // 统一回一个结构合法的 INTERNAL 响应，保证端口正常关闭。
      sendResponse(
        createErrorResponse(message.requestId, message.type, {
          code: 'INTERNAL',
          message: `命令处理失败: ${messageOf(error)}`,
        }),
      )
    })

  // 返回 true 以保持消息端口打开，等待异步 sendResponse。
  return true
})

// ---- 点击扩展图标打开 Workbench（扩展内页） ----
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('workbench.html') })
})

// 启动初始化失败不静默：记录错误以便在 chrome://extensions / SW 控制台诊断；
// 同时因为 onMessage / onConnect 监听在此之前已注册，PING 等基础命令仍可响应。
void bootstrap().catch((error: unknown) => {
  console.error('[FishOps:Background] service worker 启动初始化失败', error)
})
