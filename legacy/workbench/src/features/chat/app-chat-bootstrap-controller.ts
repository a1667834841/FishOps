/**
 * 应用级聊天运行时准备与会话同步控制器。
 *
 * 业务目标：
 * 1. 工作台应用级启动时一次性调用 CHAT_RUNTIME_PREPARE；
 * 2. 准备成功后调用 CHAT_SYNC_CONVERSATIONS；
 * 3. 使用并发锁避免重复挂载/热更新导致的重复创建与重复同步；
 * 4. 状态接入统一状态展示（连接中、已连接、连接失败、闲鱼未登录、需要验证码）；
 * 5. 自动同步完成后通知会话页读取最新本地缓存。
 */

import {
  CommandTypes,
  type CommandPayloadMap,
  type CommandResultMap,
} from '@fishops/shared'
import { setBridgeStatus } from '../../composables/useBridgeStatus'
import { inferCategoryFromText } from '../shared/error-format'
import { StateStore } from '../shared/state-store'

export type BootstrapCommandType =
  | typeof CommandTypes.CHAT_RUNTIME_PREPARE
  | typeof CommandTypes.CHAT_SYNC_CONVERSATIONS

/** 最小调用接口（与 RuntimeClient / BridgeApi 解耦，便于 Node 单元测试）。 */
export interface ChatBootstrapApi {
  call<T extends BootstrapCommandType>(type: T, payload: CommandPayloadMap[T]): Promise<CommandResultMap[T]>
}

/** 启动阶段。 */
export type BootstrapPhase =
  | 'idle'
  | 'preparing'
  | 'syncing'
  | 'ready'
  | 'error'
  | 'unauthorized'
  | 'captcha'

export interface AppChatBootstrapState {
  phase: BootstrapPhase
  error: string | null
  prepareResult: unknown | null
  syncResult: unknown | null
  updatedAt: number | null
}

export interface AppChatBootstrapOptions {
  api?: ChatBootstrapApi | null
  inExtension?: boolean
  now?: () => number
}

function initialBootstrapState(): AppChatBootstrapState {
  return {
    phase: 'idle',
    error: null,
    prepareResult: null,
    syncResult: null,
    updatedAt: null,
  }
}

export class AppChatBootstrapController extends StateStore<AppChatBootstrapState> {
  private readonly api: ChatBootstrapApi | null
  private readonly inExtension: boolean
  private readonly now: () => number
  private inFlightPromise: Promise<void> | null = null
  private executed = false
  private readonly syncCompletedListeners = new Set<() => void>()

  constructor(options: AppChatBootstrapOptions = {}) {
    super(initialBootstrapState())
    this.api = options.api ?? null
    this.inExtension = options.inExtension ?? true
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 注册自动同步完成监听（供会话页读取最新本地缓存）。
   * 返回取消监听函数。
   */
  onSyncCompleted(listener: () => void): () => void {
    this.syncCompletedListeners.add(listener)
    // 聊天页是懒加载的，应用级启动同步可能早于页面挂载完成；新监听者仍需
    // 对账一次本地缓存，避免初次读取与同步写入交错后一直显示旧列表。
    if (this.state.syncResult !== null) {
      try {
        listener()
      } catch {
        // 单个监听器异常不影响其他监听者。
      }
    }
    return () => {
      this.syncCompletedListeners.delete(listener)
    }
  }

  /** 是否已完成过一次性启动准备与同步。 */
  isExecuted(): boolean {
    return this.executed
  }

  /** 是否正在执行启动准备或同步（并发锁激活中）。 */
  isInFlight(): boolean {
    return this.inFlightPromise !== null
  }

  /**
   * 应用级启动入口：
   * - 并发锁避免重复执行；
   * - 成功时热更新与多次挂载只执行一次；失败时后续入口可以重试；
   * - 非扩展环境下安全退出，不发起任何通信。
   */
  async bootstrap(force = false): Promise<void> {
    if (this.disposed) return
    if (!this.inExtension) {
      setBridgeStatus({ state: 'unavailable', message: '未连接扩展' })
      return
    }
    if (this.executed && !force) return
    if (this.inFlightPromise) {
      return this.inFlightPromise
    }

    this.inFlightPromise = this.runBootstrap(force)
    try {
      await this.inFlightPromise
    } finally {
      this.inFlightPromise = null
    }
  }

  /** 重置控制器状态（主要用于测试）。 */
  reset(): void {
    this.executed = false
    this.inFlightPromise = null
    this.patch(initialBootstrapState())
  }

  override dispose(): void {
    super.dispose()
    this.syncCompletedListeners.clear()
    this.inFlightPromise = null
  }

  private async runBootstrap(force: boolean): Promise<void> {
    if (!this.api) {
      this.patch({
        phase: 'error',
        error: '未初始化通信客户端',
        updatedAt: this.now(),
      })
      setBridgeStatus({ state: 'error', message: '未初始化通信客户端' })
      this.executed = false
      return
    }

    // 1. 进入连接检测中状态
    this.patch({
      phase: 'preparing',
      error: null,
      updatedAt: this.now(),
    })
    setBridgeStatus({ state: 'checking', message: '正在准备闲鱼聊天运行时…' })

    try {
      // 2. 一次性调用 CHAT_RUNTIME_PREPARE
      const prepareRaw = await this.api.call(CommandTypes.CHAT_RUNTIME_PREPARE, {
        purpose: 'chat',
        ...(force ? { force: true } : {}),
      })
      if (this.disposed) return

      const prepareResult = (prepareRaw && typeof prepareRaw === 'object' ? prepareRaw : {}) as Record<string, unknown>
      const isOk = Boolean(prepareResult['ok'])

      if (!isOk) {
        // 准备失败：根据错误分类接入统一状态展示，不调用后续会话同步
        const errObj = (prepareResult['error'] && typeof prepareResult['error'] === 'object' ? prepareResult['error'] : {}) as Record<string, unknown>
        const rawCategory = typeof errObj['category'] === 'string' ? errObj['category'] : null
        const rawMessage = typeof errObj['message'] === 'string' ? errObj['message'] : '闲鱼聊天运行时准备失败'
        const category = rawCategory || inferCategoryFromText(rawMessage)

        if (category === 'unauthorized') {
          this.patch({
            phase: 'unauthorized',
            error: rawMessage,
            prepareResult,
            updatedAt: this.now(),
          })
          setBridgeStatus({ state: 'unauthorized', message: rawMessage })
        } else if (category === 'captcha') {
          this.patch({
            phase: 'captcha',
            error: rawMessage,
            prepareResult,
            updatedAt: this.now(),
          })
          setBridgeStatus({ state: 'captcha', message: rawMessage })
        } else {
          this.patch({
            phase: 'error',
            error: rawMessage,
            prepareResult,
            updatedAt: this.now(),
          })
          setBridgeStatus({ state: 'error', message: rawMessage })
        }
        this.executed = false
        return
      }

      // 3. 准备成功：调用 CHAT_SYNC_CONVERSATIONS
      this.patch({
        phase: 'syncing',
        prepareResult,
        updatedAt: this.now(),
      })

      let syncResult: unknown = null
      try {
        syncResult = await this.api.call(CommandTypes.CHAT_SYNC_CONVERSATIONS, {})
      } catch (syncError) {
        // 保留失败原因，供页面显示并在后续准备入口重试。
        syncResult = { ok: false, error: syncError instanceof Error ? syncError.message : String(syncError) }
      }

      if (this.disposed) return

      // 4. 准备成功后，区分连接成功与会话同步成功，避免失败时静默显示空列表。
      const syncRecord = syncResult && typeof syncResult === 'object'
        ? syncResult as Record<string, unknown>
        : null
      const syncOk = syncRecord?.['ok'] === true
      const syncErrorValue = syncRecord?.['error']
      const syncError = typeof syncErrorValue === 'string'
        ? syncErrorValue
        : syncErrorValue && typeof syncErrorValue === 'object' && 'message' in syncErrorValue
          ? String((syncErrorValue as { message: unknown }).message)
          : syncOk ? null : '会话同步未返回成功结果，请重试'

      this.patch({
        phase: syncOk ? 'ready' : 'error',
        error: syncError,
        prepareResult,
        syncResult,
        updatedAt: this.now(),
      })
      setBridgeStatus(syncOk
        ? { state: 'online', message: null }
        : { state: 'error', message: syncError ?? '会话同步失败，请重试' })
      this.executed = syncOk

      // 广播同步完成通知
      this.notifySyncCompleted()
    } catch (error) {
      if (this.disposed) return
      const rawMessage = error instanceof Error ? error.message : String(error)
      const errCategory = (error && typeof error === 'object' && 'category' in error && typeof (error as { category: unknown }).category === 'string')
        ? (error as { category: string }).category
        : inferCategoryFromText(rawMessage)

      if (errCategory === 'unauthorized') {
        this.patch({
          phase: 'unauthorized',
          error: rawMessage,
          updatedAt: this.now(),
        })
        setBridgeStatus({ state: 'unauthorized', message: rawMessage })
      } else if (errCategory === 'captcha') {
        this.patch({
          phase: 'captcha',
          error: rawMessage,
          updatedAt: this.now(),
        })
        setBridgeStatus({ state: 'captcha', message: rawMessage })
      } else {
        this.patch({
          phase: 'error',
          error: rawMessage,
          updatedAt: this.now(),
        })
        setBridgeStatus({ state: 'error', message: rawMessage })
      }
      this.executed = false
    }
  }

  private notifySyncCompleted(): void {
    for (const listener of [...this.syncCompletedListeners]) {
      try {
        listener()
      } catch {
        // 单个监听器异常不中断其余通知
      }
    }
  }
}
