import {
  HOST_NAME,
  PROTOCOL_VERSION,
  isExtensionBuildId,
  isWire,
  type Account,
  type Wire,
} from '../../../packages/protocol/src/index.ts'
import type { AccountTracker } from './account.ts'
import { isGapOccurrence, type GapOccurrence } from '../../../packages/protocol/src/chat-gap.ts'
import type { MethodDispatcher } from './dispatch.ts'
import type { ExtensionEnv, NativePortLike } from './env.ts'
import { ApiError } from './errors.ts'
import { isPageWire, isResolvedPage, isStepWire, type PageWire, type ResolvedPage, type StepWire } from '../../../packages/protocol/src/step.ts'
import { isChatMessage } from '../../../packages/protocol/src/chat.ts'
import { isChatWire } from '../../../packages/protocol/src/chat-wire.ts'
import type { ChatOutbox } from './chat-outbox.ts'

type StepRequest = Extract<StepWire, { kind: 'request-step' }>
type StepResult = Extract<StepWire, { kind: 'step-result' }>
type StepHandler = (request: StepRequest) => Promise<StepResult>
type PageResolver = (accountId: string) => Promise<ResolvedPage>

const DEFAULT_MIN_BACKOFF_MS = 1000
const DEFAULT_MAX_BACKOFF_MS = 30000

export interface NativeBridgeOptions {
  env: ExtensionEnv
  account: AccountTracker
  dispatch: MethodDispatcher
  /** 持久消息队列由调用方注入；未配置时拒绝接收聊天消息。 */
  outbox?: ChatOutbox
  /** 每个 native 连接创建独立去重执行器，旧连接结果不得回发到新连接。 */
  createStepHandler?: () => StepHandler
  /** 每个连接创建独立页面定位器；只返回固定执行页，不发平台请求。 */
  createPageResolver?: () => PageResolver
  /** native host 名，默认取公共协议的 HOST_NAME。 */
  hostName?: string
  minBackoffMs?: number
  maxBackoffMs?: number
}

type ActiveConnection = {
  /** 连接代次：旧连接的回调在代次不匹配时全部丢弃。 */
  epoch: number
  port: NativePortLike
  cleanup: () => void
  stepHandler?: StepHandler
  pageResolver?: PageResolver
}

/**
 * native 连接管理器。
 *
 * 生命周期：
 * 1. 建立 Port 后先读 cookie，再发送 hello；读取失败断开并按退避重连，不把异常伪装成退出登录。
 * 2. 每次连接使用独立代次，旧连接的消息与断开回调一律丢弃，不产生重复 Port。
 * 3. 断开退避 1s → 2s → 4s → 8s → 16s → 30s（上限 30s）；hello 成功后重置。
 * 4. 账号变化只在“当前连接已 hello”时推送 `account.changed`。
 */
export class NativeBridge {
  #env: ExtensionEnv
  #account: AccountTracker
  #dispatch: MethodDispatcher
  #outbox?: ChatOutbox
  #chatQueue: Promise<void> = Promise.resolve()
  #createStepHandler?: () => StepHandler
  #createPageResolver?: () => PageResolver
  #hostName: string
  #minBackoffMs: number
  #maxBackoffMs: number
  #epoch = 0
  #active: ActiveConnection | null = null
  #ready = false
  #attempt = 0
  #timer: number | null = null
  #stopped = false
  #unsubscribeAccount: (() => void) | null = null

  constructor(options: NativeBridgeOptions) {
    this.#env = options.env
    this.#account = options.account
    this.#dispatch = options.dispatch
    this.#outbox = options.outbox
    this.#createStepHandler = options.createStepHandler
    this.#createPageResolver = options.createPageResolver
    this.#hostName = options.hostName ?? options.env.hostName ?? HOST_NAME
    this.#minBackoffMs = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS
    this.#maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  }

  /** native 通道是否已完成 hello。 */
  get connected(): boolean {
    return this.#ready
  }

  /** 当前活跃连接的代次，仅用于诊断与测试断言。 */
  get epoch(): number {
    return this.#epoch
  }

  /** 校验消息及当前账号后持久入队；成功不代表 host 已落库，须等待 ACK。 */
  ingestChatMessage(accountId: string, message: unknown): Promise<void> {
    if (!isChatMessage(message)) return Promise.reject(new ApiError('BAD_REQUEST', '聊天消息无效'))
    // 调用者随后修改对象不能改变已验证的待持久化内容。
    const payload = structuredClone(message)
    return this.#serializeChat(async () => {
      if (!this.#outbox) throw new ApiError('INTERNAL', '聊天持久队列不可用')
      if (!accountId || (await this.#account.read())?.userId !== accountId) throw new ApiError('ACCOUNT_CHANGED', '聊天账号不匹配')
      const result = await this.#outbox.enqueue({ accountId, sourceId: payload.sourceId, payload })
      const active = this.#active
      if (active) await this.#flushChat(active.epoch, active.port, accountId)
      if (result === 'gap') throw new ApiError('INTERNAL', '聊天队列容量不足，消息未持久保存')
    }, 'ingest')
  }

  /** 校验当前账号并先持久记录页面缺口，随后通知当前连接；重连仍会重投。 */
  reportChatGap(accountId: string, reason: 'PAGE_GAP' = 'PAGE_GAP', occurrence?: GapOccurrence): Promise<void> {
    return this.#serializeChat(async () => {
      if (reason !== 'PAGE_GAP') throw new ApiError('BAD_REQUEST', '聊天缺口类型无效')
      if (!this.#outbox) throw new ApiError('INTERNAL', '聊天持久队列不可用')
      if (!accountId || (await this.#account.read())?.userId !== accountId) throw new ApiError('ACCOUNT_CHANGED', '聊天账号不匹配')
      if (occurrence !== undefined) {
        if (!isGapOccurrence(occurrence) || occurrence.accountId !== accountId || occurrence.reason !== reason) throw new ApiError('BAD_REQUEST', '聊天缺口身份无效')
        await this.#outbox.recordGap(occurrence)
      } else await this.#outbox.markGap(accountId)
      const active = this.#active
      if (active) await this.#flushChat(active.epoch, active.port, accountId)
    }, 'gap')
  }

  #serializeChat(action: () => Promise<void>, category: 'ingest' | 'flush' | 'ack' | 'gap'): Promise<void> {
    const result = this.#chatQueue.then(action).catch(error => {
      this.#env.log('warn', '聊天交付处理失败', { category })
      throw error instanceof ApiError ? error : new ApiError('INTERNAL', '聊天持久队列处理失败')
    })
    this.#chatQueue = result.catch(() => {})
    return result
  }

  async #flushChat(epoch: number, port: NativePortLike, accountId: string): Promise<void> {
    if (!this.#outbox || !this.#ready || !this.#isActive(epoch, port)) return
    const snapshot = await this.#outbox.snapshot(accountId)
    if (snapshot.syncRequired) {
      const account = await this.#account.read()
      if (!this.#ready || !this.#isActive(epoch, port) || account?.userId !== accountId) return
      // 缺口只通知，不清除持久标记；已保存消息继续正常交付。
      if (await this.#outbox.legacyGapRequired(accountId)) {
        if (!this.#ready || !this.#isActive(epoch, port) || (await this.#account.read())?.userId !== accountId) return
        port.postMessage({ kind: 'chat-gap', accountId, reason: snapshot.gapReason ?? 'OUTBOX_CAPACITY' })
      }
      for (const occurrence of await this.#outbox.gapOccurrences(accountId)) {
        if (!this.#ready || !this.#isActive(epoch, port) || (await this.#account.read())?.userId !== accountId) return
        port.postMessage({ kind: 'chat-gap', accountId, reason: occurrence.reason, occurrence })
      }
    }
    for (const entry of snapshot.entries) {
      const account = await this.#account.read()
      if (!this.#ready || !this.#isActive(epoch, port) || account?.userId !== accountId) return
      const delivery = { kind: 'chat-delivery', accountId, message: entry.payload }
      if (!isChatWire(delivery) || delivery.kind !== 'chat-delivery' || delivery.message.sourceId !== entry.sourceId) {
        throw new ApiError('INTERNAL', '聊天持久消息无效')
      }
      port.postMessage(delivery)
    }
  }

  /** SW 顶层调用：订阅 cookie 变化并建立首个连接。 */
  start(): void {
    if (this.#stopped) return
    this.#account.observe()
    if (!this.#unsubscribeAccount) {
      this.#unsubscribeAccount = this.#account.onChange((account) => this.#publishAccount(account))
    }
    this.#connect()
  }

  /**
   * 明确唤醒动作（安装、浏览器启动、点击图标）时调用。
   * 已有活跃连接时不重复建立 Port；只有确实断开才立即重连。
   */
  ensureConnected(): void {
    if (this.#stopped) return
    this.#account.observe()
    if (this.#active) return
    this.#clearTimer()
    this.#connect()
  }

  /** 停止重连并释放监听与计时器；重复调用安全。 */
  stop(): void {
    this.#stopped = true
    this.#clearTimer()
    if (this.#unsubscribeAccount) {
      this.#unsubscribeAccount()
      this.#unsubscribeAccount = null
    }
    this.#account.stop()
    this.#epoch += 1
    this.#dropActive({ reason: '停止', disconnect: true, reconnect: false })
  }

  #connect(): void {
    if (this.#stopped || this.#active) return
    const epoch = ++this.#epoch
    let port: NativePortLike
    try {
      port = this.#env.connectNative(this.#hostName)
    } catch (error) {
      this.#env.log('warn', 'native host 连接失败', { reason: describeError(error) })
      this.#scheduleReconnect()
      return
    }

    this.#ready = false
    const offMessage = port.onMessage((message) => {
      if (!this.#isActive(epoch, port)) return
      void this.#handleMessage(epoch, port, message)
    })
    const offDisconnect = port.onDisconnect((info) => {
      if (!this.#isActive(epoch, port)) return
      // 重连循环常见于 hello 发送后 host 立即退出；只记录脱敏原因，不包含账户或平台数据。
      this.#env.log('warn', 'native 连接断开', { epoch, reason: info.message ? 'host_message' : 'no_message' })
      this.#dropActive({ reason: info.message ?? 'native 连接断开', disconnect: false, reconnect: true })
    })
    this.#active = { epoch, port, stepHandler: this.#createStepHandler?.(), pageResolver: this.#createPageResolver?.(), cleanup: () => {
      offMessage()
      offDisconnect()
    } }
    void this.#handshake(epoch, port)
  }

  /** 建立连接后先读 cookie，再发 hello；读取失败不外发 hello。 */
  async #handshake(epoch: number, port: NativePortLike): Promise<void> {
    let account: Account
    try {
      account = await this.#account.read()
    } catch {
      this.#env.log('warn', 'hello 前账号读取失败，断开并退避重连')
      // 读取等待期间连接可能已被替换：旧握手的失败不得再影响新连接。
      if (!this.#isActive(epoch, port)) return
      this.#dropActive({ reason: '账号读取失败', disconnect: true, reconnect: true })
      return
    }
    if (!this.#isActive(epoch, port)) return

    // 生产环境上报真实构建身份；未构建的源码测试环境无法提供有效值时省略该字段。
    const buildId = this.#env.buildId
    try {
      port.postMessage({
        kind: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        extensionVersion: this.#env.version,
        ...(isExtensionBuildId(buildId) ? { extensionBuildId: buildId } : {}),
        account,
      })
    } catch (error) {
      this.#env.log('warn', 'hello 发送失败', { reason: describeError(error) })
      this.#dropActive({ reason: 'hello 发送失败', disconnect: true, reconnect: true })
      return
    }
    // 完成 hello 后重置退避；后续断开从 1s 重新开始。
    this.#attempt = 0
    this.#ready = true
    // 登记上报基线：同一账号的后续观测不再重复推送 account.changed。
    this.#account.markReported(account)
    if (account) {
      void this.#serializeChat(() => this.#flushChat(epoch, port, account.userId), 'flush').catch(() => {})
    }
  }

  async #handleMessage(epoch: number, port: NativePortLike, message: unknown): Promise<void> {
    if (isChatWire(message) && message.kind === 'chat-ack') {
      await this.#serializeChat(async () => {
        if (!this.#outbox || !this.#ready || !this.#isActive(epoch, port)) return
        const account = await this.#account.read()
        // 账号读取可能跨越断线重连；删除前必须再次核验原连接代次。
        if (!this.#ready || !this.#isActive(epoch, port) || account?.userId !== message.accountId) return
        await this.#outbox.acknowledge(message.accountId, message.sourceId)
      }, 'ack').catch(() => {})
      return
    }
    if (isPageWire(message) && message.kind === 'resolve-page') {
      if (!this.#ready) {
        this.#dropActive({ reason: '握手前页面定位', disconnect: true, reconnect: true })
        return
      }
      const resolver = this.#active?.pageResolver
      let response: PageWire
      try {
        if (!resolver) throw new ApiError('PAGE_NOT_READY', '页面定位器不可用')
        const context = await resolver(message.accountId)
        if (!isResolvedPage(context)) throw new ApiError('PAGE_NOT_READY', '页面定位结果无效')
        response = { kind: 'page-context', id: message.id, context }
      } catch (error) {
        const code = error instanceof ApiError && (
          error.code === 'PAGE_NOT_READY' || error.code === 'LOGIN_REQUIRED' || error.code === 'ACCOUNT_CHANGED'
        ) ? error.code : 'PAGE_NOT_READY'
        response = { kind: 'page-context', id: message.id, context: null, reason: code }
      }
      if (!this.#isActive(epoch, port)) return
      try { port.postMessage(response) } catch {
        this.#dropActive({ reason: '页面定位响应发送失败', disconnect: true, reconnect: true })
      }
      return
    }
    if (isStepWire(message) && message.kind === 'request-step') {
      if (!this.#ready) {
        this.#dropActive({ reason: '握手前业务步骤', disconnect: true, reconnect: true })
        return
      }
      const handler = this.#active?.stepHandler
      let result: StepResult
      try {
        result = handler ? await handler(message) : { kind: 'step-result', id: message.id, terminal: true, ok: false,
          error: new ApiError('NOT_FOUND', '尚未配置平台步骤执行器').toWire() }
      } catch {
        // 未知执行器异常不证明平台请求已结束，关闭通道而非伪造 terminal。
        if (this.#isActive(epoch, port)) this.#dropActive({ reason: '单步执行器异常', disconnect: true, reconnect: true })
        return
      }
      if (!this.#isActive(epoch, port)) return
      if (!isStepWire(result) || result.kind !== 'step-result' || result.id !== message.id) {
        this.#dropActive({ reason: '单步响应无效', disconnect: true, reconnect: true })
        return
      }
      try { port.postMessage(result) } catch {
        this.#dropActive({ reason: '单步响应发送失败', disconnect: true, reconnect: true })
      }
      return
    }
    if (!isWire(message) || message.kind !== 'req') {
      // 非法 Wire 视为通道损坏：记录脱敏原因并终止该连接，但不改变账号观测值。
      this.#env.log('warn', '收到非法 native 帧，终止通道')
      this.#dropActive({ reason: '非法帧', disconnect: true, reconnect: true })
      return
    }

    let response: Wire
    try {
      const data = await this.#dispatch(message.method, message.params)
      response = { kind: 'res', id: message.id, ok: true, data }
    } catch (error) {
      const apiError = ApiError.from(error, 'INTERNAL')
      response = { kind: 'res', id: message.id, ok: false, error: apiError.toWire() }
    }

    // 处理期间连接可能已被替换或关闭：旧响应不回发。
    if (!this.#isActive(epoch, port)) return
    try {
      port.postMessage(response)
    } catch (error) {
      this.#env.log('warn', '响应发送失败', { reason: describeError(error) })
    }
  }

  #publishAccount(account: Account): void {
    const active = this.#active
    if (!active || !this.#ready) return
    try {
      active.port.postMessage({ kind: 'event', type: 'account.changed', data: { account } })
      if (account) {
        void this.#serializeChat(() => this.#flushChat(active.epoch, active.port, account.userId), 'flush').catch(() => {})
      }
    } catch (error) {
      this.#env.log('warn', '账号事件发送失败', { reason: describeError(error) })
    }
  }

  #isActive(epoch: number, port: NativePortLike): boolean {
    return this.#active?.epoch === epoch && this.#active.port === port
  }

  #dropActive(options: { reason: string; disconnect: boolean; reconnect: boolean }): void {
    const active = this.#active
    if (!active) return
    this.#active = null
    this.#ready = false
    active.cleanup()
    if (options.disconnect) {
      try {
        active.port.disconnect()
      } catch {
        // 已经断开的 Port 再次 disconnect 会抛错，这里忽略。
      }
    }
    if (options.reconnect) this.#scheduleReconnect()
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#timer !== null || this.#active) return
    const delay = Math.min(this.#minBackoffMs * 2 ** this.#attempt, this.#maxBackoffMs)
    this.#attempt += 1
    this.#timer = this.#env.timers.setTimeout(() => {
      this.#timer = null
      this.#connect()
    }, delay)
  }

  #clearTimer(): void {
    if (this.#timer === null) return
    this.#env.timers.clearTimeout(this.#timer)
    this.#timer = null
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown'
}
