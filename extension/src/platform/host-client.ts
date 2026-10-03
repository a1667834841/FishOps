/**
 * background 侧的平台调用适配器。
 *
 * 背景：MTOP 请求必须在 goofish.com 页面的 MAIN world 执行（才能带上页面 cookie 与签名所需环境）。
 * background 通过 `chrome.scripting.executeScript({ world: 'MAIN' })` 调用页面上已挂载的
 * `window.__FISHOPS_PLATFORM_HOST__`（见 {@link ./host-entry}）。
 *
 * 本模块把 `chrome.scripting` 抽象为 {@link PlatformScriptExecutor}，便于 mock 测试；
 * 同时提供基于 tab-manager 的目标 tab 解析 helper。
 *
 * 集成：manifest 已声明 `scripting` / `tabs` 权限与 goofish host_permissions，background 通过
 * message-router 的 PLATFORM_CALL / PLATFORM_PING 命令经本模块调用 MAIN world host。
 */
import { PlatformError, defaultMessageFor } from './errors'
import {
  isPlatformCallResponse,
  isPlatformMethod,
  PlatformMethods,
  type CurrentUserIdResult,
  type PlatformMethod,
  type PlatformParamsMap,
  type PlatformResultMap,
  type PingResult,
} from './protocol'

/**
 * 在目标 tab 的 MAIN world 执行一次平台调用，返回 host 的原始返回
 * （约定为 PlatformCallResponse，或是 host.handle 的直接结果）。
 *
 * 注意：该函数会被序列化后注入页面，**不得引用模块外的任何变量**。
 */
export function invokeRuntimeHostInPage(
  method: string,
  callId: string,
  params: unknown,
): Promise<unknown> {
  const globalObject = globalThis as {
    __FISHOPS_PLATFORM_HOST__?: {
      handleCall?: (request: unknown) => Promise<unknown>
      handle?: (method: string, params: unknown) => Promise<unknown>
    }
  }
  const host = globalObject.__FISHOPS_PLATFORM_HOST__
  if (!host) {
    return Promise.reject(new Error('页面未安装 FishOps 平台 host（MAIN world 未就绪）'))
  }
  if (typeof host.handleCall === 'function') {
    return host.handleCall({
      channel: 'fishops-platform',
      kind: 'platform-call',
      method,
      params,
      callId,
    })
  }
  if (typeof host.handle === 'function') {
    return host.handle(method, params)
  }
  return Promise.reject(new Error('页面平台 host 缺少 handle/handleCall 方法'))
}

/**
 * `chrome.scripting.executeScript` 的最小子集。
 *
 * `args` 放宽为 `unknown[]`、`func` 放宽为可变参，以同时支持：
 * - host 调用（3 个参数：method / callId / params）；
 * - 自包含的 cookie 读取注入（0 参数）。
 */
export interface ScriptingInjection {
  target: { tabId: number }
  world: 'MAIN'
  args: unknown[]
  func: (...args: never[]) => unknown
}

export interface ScriptingApi {
  executeScript(injection: ScriptingInjection): Promise<Array<{ result?: unknown }>>
}

export interface PlatformScriptExecutor {
  execute(tabId: number, method: string, params: unknown): Promise<unknown>
  /**
   * 可选：在页面 MAIN world **直接读取受信 cookie** 得到当前用户 ID。
   *
   * 注入函数自包含、可序列化（见 {@link readTrustedUserIdInPage}），因此**不依赖页面 host 版本**：
   * 扩展更新后若 /im 页面未重载，旧 host 仍在也可能读不到新逻辑下的用户 ID。
   * 返回 null 表示页面无可用受信 cookie，调用方应回退页面 host。
   */
  readUserId?(tabId: number): Promise<string | null>
}

/**
 * 在页面 MAIN world 直接读取受信 cookie 得到当前用户 ID。
 *
 * 该函数会被 `chrome.scripting.executeScript` **序列化后注入**，因此**禁止引用模块外的任何变量**
 * （只允许使用自身参数、局部变量与页面全局如 `document` / `atob` / `JSON`）。
 * 与 `platform/xianyu/auth.ts` 的 `extractUserIdFromCookie` 保持同一解析规则（有 parity 单测防止漂移）：
 * `unb` → `havana_lgc2_*`。**只返回 userId 或 null，绝不返回 cookie 原文、绝不打印。**
 *
 * @param cookieString 仅用于测试；缺省读取页面 `document.cookie`。
 */
export function readTrustedUserIdInPage(cookieString?: string): CurrentUserIdResult {
  try {
    const cookie =
      typeof cookieString === 'string'
        ? cookieString
        : typeof document === 'undefined'
          ? ''
          : document.cookie

    const valid = (value: unknown): value is string => {
      if (typeof value !== 'string') return false
      const trimmed = value.trim()
      if (trimmed.length === 0 || trimmed.length > 64) return false
      if (trimmed.includes('@')) return false
      return /^[0-9A-Za-z_-]+$/.test(trimmed)
    }

    const readCookie = (name: string): string | null => {
      const match = cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'))
      return match ? (match[1] ?? '').trim() : null
    }

    const unb = readCookie('unb')
    if (valid(unb)) return { userId: unb.trim() }

    const havana = cookie.match(/(?:^|;\s*)(havana_lgc2_\d+)=([^;]*)/)
    if (havana) {
      const normalized = (havana[2] ?? '').trim().replace(/-/g, '+').replace(/_/g, '/')
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
      const parsed: unknown = JSON.parse(atob(padded))
      const hid = parsed && typeof parsed === 'object' ? (parsed as { hid?: unknown }).hid : undefined
      if (typeof hid === 'number' && valid(String(hid))) return { userId: String(hid) }
      if (valid(hid)) return { userId: hid.trim() }
    }

    return { userId: null }
  } catch {
    return { userId: null }
  }
}

/** 执行一次自包含 cookie 读取注入；注入失败（无 tab / 无 scripting）返回 null，由上层回退 host。 */
async function readUserIdViaCookie(scripting: ScriptingApi, tabId: number): Promise<string | null> {
  try {
    const results = await scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [],
      func: readTrustedUserIdInPage,
    })
    const result = results[0]?.result
    if (result && typeof result === 'object' && typeof (result as { userId?: unknown }).userId === 'string') {
      return (result as { userId: string }).userId
    }
    return null
  } catch {
    return null
  }
}

/** 基于 `chrome.scripting.executeScript` 的执行器。 */
export function createChromeScriptExecutor(scripting: ScriptingApi): PlatformScriptExecutor {
  let counter = 0
  return {
    async execute(tabId: number, method: string, params: unknown): Promise<unknown> {
      const callId = `host_${Date.now().toString(36)}_${(counter++).toString(36)}`
      const results = await scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [method, callId, params],
        func: invokeRuntimeHostInPage,
      })
      return results[0]?.result
    },
    readUserId(tabId: number): Promise<string | null> {
      return readUserIdViaCookie(scripting, tabId)
    },
  }
}

/** 只依赖 ensureGoofishTab 的 tab 解析器形状（兼容 TabManager）。 */
export interface TabResolver {
  ensureGoofishTab(): Promise<{ tab: { id?: number } }>
}

/** 把 TabManager 适配为 `resolveTabId`。 */
export function tabResolverFromManager(manager: TabResolver): () => Promise<number | null> {
  return async () => {
    const { tab } = await manager.ensureGoofishTab()
    return tab.id ?? null
  }
}

export interface PlatformHostClientDeps {
  executor: PlatformScriptExecutor
  /** 解析目标 goofish tab id；返回 null 表示无可用 tab。 */
  resolveTabId: () => Promise<number | null>
}

export interface PlatformHostClient {
  call<M extends PlatformMethod>(method: M, params: PlatformParamsMap[M]): Promise<PlatformResultMap[M]>
  /**
   * 以字符串 method 发起调用（供 background 消息路由使用）。
   * 内部会先做平台方法白名单校验，非法 method 抛 `unknown` 类别错误。
   */
  callRaw(method: string, params: unknown): Promise<unknown>
  ping(): Promise<PingResult>
}

function unwrapResponse<M extends PlatformMethod>(value: unknown): PlatformResultMap[M] {
  if (isPlatformCallResponse(value)) {
    if (!value.ok) {
      throw new PlatformError(value.error.category, value.error.message, {
        retCode: value.error.retCode,
      })
    }
    return value.result as PlatformResultMap[M]
  }
  // executor 直接返回了 host.handle 的结果
  return value as PlatformResultMap[M]
}

/** 创建 background 侧的平台客户端。 */
export function createPlatformHostClient(deps: PlatformHostClientDeps): PlatformHostClient {
  /** 解析目标 tab 并执行一次 MAIN world 调用；失败统一归一为 PlatformError。 */
  async function execute(method: string, params: unknown): Promise<unknown> {
    const tabId = await deps.resolveTabId()
    if (tabId === null) {
      throw new PlatformError('host-unavailable', '未找到闲鱼标签页，请先打开 goofish.com 页面')
    }
    try {
      // 当前用户 ID：优先由自包含注入直接读受信 cookie（不依赖页面 host 版本）。
      // 命中即返回；未命中（无受信 cookie）再回退 page host（MTOP），并保留其错误类别。
      if (method === PlatformMethods.CURRENT_USER_ID && deps.executor.readUserId) {
        const userId = await deps.executor.readUserId(tabId)
        if (typeof userId === 'string' && userId.length > 0) {
          return { userId } satisfies CurrentUserIdResult
        }
      }
      const raw = await deps.executor.execute(tabId, method, params)
      return unwrapResponse(raw) as unknown
    } catch (error) {
      if (error instanceof PlatformError) throw error
      // 注入失败（页面未安装 host / tab 被关闭 / chrome.scripting 报错）
      const message = error instanceof Error ? error.message : defaultMessageFor('unknown')
      throw new PlatformError('host-unavailable', message, { cause: error })
    }
  }

  return {
    async call<M extends PlatformMethod>(
      method: M,
      params: PlatformParamsMap[M],
    ): Promise<PlatformResultMap[M]> {
      return (await execute(method, params)) as PlatformResultMap[M]
    },
    callRaw(method: string, params: unknown): Promise<unknown> {
      if (!isPlatformMethod(method)) {
        throw new PlatformError('unknown', `未知平台方法: ${method}`)
      }
      return execute(method, params)
    },
    ping(): Promise<PingResult> {
      return execute(PlatformMethods.PING, {}) as Promise<PingResult>
    },
  }
}
