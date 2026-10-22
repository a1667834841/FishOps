/** 测试替身：假 Chrome API、假计时器与远端请求探针。仅测试使用，不进入构建产物。 */
import type {
  CookieChangeEvent,
  CookieQuery,
  CookieResult,
  ExtensionEnv,
  NativePortLike,
  TabInfo,
  Timers,
} from '../env.ts'

/** 假计时器：让退避与 cookie debounce 可以在单测里精确推进。 */
export class FakeClock {
  #now = 0
  #nextId = 1
  #timers = new Map<number, { at: number; handler: () => void }>()

  readonly timers: Timers = {
    setTimeout: (handler, ms) => {
      const id = this.#nextId
      this.#nextId += 1
      this.#timers.set(id, { at: this.#now + Math.max(0, ms), handler })
      return id
    },
    clearTimeout: (handle) => {
      this.#timers.delete(handle)
    },
  }

  get now(): number {
    return this.#now
  }

  get pendingCount(): number {
    return this.#timers.size
  }

  /** 推进时间：按到期顺序执行，包含推进期间新增且已到期的定时器。 */
  advance(ms: number): void {
    const target = this.#now + ms
    for (;;) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      this.#timers.delete(due[0])
      this.#now = due[1].at
      due[1].handler()
    }
    this.#now = target
  }
}

/** 假 native Port：记录出站消息，并可手动触发消息、断开与重复回调。 */
export class FakeNativePort implements NativePortLike {
  readonly outbound: unknown[] = []
  disconnected = false
  #messages = new Set<(message: unknown) => void>()
  #disconnects = new Set<(info: { message?: string }) => void>()

  postMessage(message: unknown): void {
    if (this.disconnected) throw new Error('Port 已断开')
    this.outbound.push(message)
  }

  disconnect(): void {
    if (this.disconnected) return
    this.disconnected = true
    this.emitDisconnect()
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.#messages.add(listener)
    return () => {
      this.#messages.delete(listener)
    }
  }

  onDisconnect(listener: (info: { message?: string }) => void): () => void {
    this.#disconnects.add(listener)
    return () => {
      this.#disconnects.delete(listener)
    }
  }

  /** 模拟 host 发来的消息；断开后重复调用用于验证旧回调隔离。 */
  emitMessage(message: unknown): void {
    for (const listener of [...this.#messages]) listener(message)
  }

  emitDisconnect(info: { message?: string } = {}): void {
    for (const listener of [...this.#disconnects]) listener(info)
  }

  get listenerCount(): number {
    return this.#messages.size + this.#disconnects.size
  }

  hello(): Record<string, unknown> | undefined {
    return this.outbound.find(isKindOf('hello'))
  }

  responses(): Record<string, unknown>[] {
    return this.outbound.filter(isKindOf('res'))
  }

  events(): Record<string, unknown>[] {
    return this.outbound.filter(isKindOf('event'))
  }
}

function isKindOf(kind: string): (message: unknown) => message is Record<string, unknown> {
  return (message): message is Record<string, unknown> =>
    typeof message === 'object' && message !== null && (message as { kind?: string }).kind === kind
}

export interface PendingCookieRead {
  name: string
  resolve: (result: CookieResult) => void
  reject: (error: unknown) => void
}

export interface FakeEnvOptions {
  version?: string
  /** cookie 名 → 值；null 表示存在但为空。 */
  cookies?: Record<string, string | null>
  /** 这些 cookie 名读取时抛错。 */
  cookieErrors?: string[]
  /** 全部 cookie 读取抛错。 */
  failAllCookies?: boolean
  /** cookie 读取挂起，由测试手动 resolve / reject。 */
  deferredCookieReads?: boolean
  tabCount?: number
  tabsError?: boolean
  /** 标签页查询返回明确的 id；缺省按数量回退。 */
  tabIds?: number[]
}

export class FakeEnv implements ExtensionEnv {
  readonly version: string
  readonly clock = new FakeClock()
  readonly ports: FakeNativePort[] = []
  readonly hostNames: string[] = []
  readonly logs: string[] = []
  readonly cookieReads: string[] = []
  readonly pendingReads: PendingCookieRead[] = []
  #cookies = new Map<string, string | null>()
  #cookieErrors = new Set<string>()
  #failAll: boolean
  #deferred: boolean
  #tabCount: number
  #tabIds?: number[]
  #tabsError: boolean
  #changeListeners = new Set<(change: CookieChangeEvent) => void>()

  constructor(options: FakeEnvOptions = {}) {
    this.version = options.version ?? '0.2.0'
    this.#failAll = options.failAllCookies ?? false
    this.#deferred = options.deferredCookieReads ?? false
    this.#tabCount = options.tabCount ?? 0
    this.#tabIds = options.tabIds
    this.#tabsError = options.tabsError ?? false
    for (const [name, value] of Object.entries(options.cookies ?? {})) this.#cookies.set(name, value)
    for (const name of options.cookieErrors ?? []) this.#cookieErrors.add(name)
  }

  get timers(): Timers {
    return this.clock.timers
  }

  connectNative(hostName: string): NativePortLike {
    this.hostNames.push(hostName)
    const port = new FakeNativePort()
    this.ports.push(port)
    return port
  }

  readonly cookies = {
    get: (query: CookieQuery): Promise<CookieResult> => {
      this.cookieReads.push(query.name)
      if (this.#failAll || this.#cookieErrors.has(query.name)) {
        return Promise.reject(new Error('cookie 读取失败'))
      }
      if (this.#deferred) {
        return new Promise<CookieResult>((resolve, reject) => {
          this.pendingReads.push({ name: query.name, resolve, reject })
        })
      }
      return Promise.resolve(this.#read(query.name))
    },
    onChanged: (listener: (change: CookieChangeEvent) => void): (() => void) => {
      this.#changeListeners.add(listener)
      return () => {
        this.#changeListeners.delete(listener)
      }
    },
  }

  readonly tabs = {
    query: (pattern: string): Promise<TabInfo[]> => {
      if (this.#tabsError) return Promise.reject(new Error('tabs 查询失败'))
      if (this.#tabIds) return Promise.resolve(this.#tabIds.map(id => ({ id, url: pattern.replace('*', 'www') })))
      return Promise.resolve(
        Array.from({ length: this.#tabCount }, (_, index) => ({ id: index + 1, url: pattern.replace('*', 'www') })),
      )
    },
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.logs.push(`${level}:${message}`)
  }

  setCookie(name: string, value: string | null): void {
    this.#cookies.set(name, value)
  }

  /** 触发 cookie 变化订阅，用于验证 debounce 与变化通知。 */
  emitCookieChange(name: string): void {
    for (const listener of [...this.#changeListeners]) {
      listener({ cookie: { name, domain: '.goofish.com' }, cause: 'explicit', removed: false })
    }
  }

  get activeChangeListeners(): number {
    return this.#changeListeners.size
  }

  get lastPort(): FakeNativePort | undefined {
    return this.ports.at(-1)
  }

  #read(name: string): CookieResult {
    const value = this.#cookies.get(name)
    return value === null || value === undefined ? null : { value }
  }
}

/** 让异步队列推进到稳定：定时器回调里的 async 逻辑需要多个微任务轮次。 */
export async function settle(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

export interface NetworkProbe {
  calls: string[]
  restore: () => void
  assertNone: () => void
}

/**
 * 远端请求探针：替换 fetch / XMLHttpRequest / WebSocket / EventSource。
 * 被测代码一旦发起远端请求就会留下调用记录，测试立即失败。
 */
export function installNetworkProbes(): NetworkProbe {
  const scope = globalThis as Record<string, unknown>
  const calls: string[] = []
  const originals = new Map<string, unknown>()
  const guard = (name: string): never => {
    calls.push(name)
    throw new Error(`扩展不得发起远端请求：${name}`)
  }
  // 每一项都是“替换值工厂”：工厂返回待替换对象本身，不在安装阶段触发 guard。
  const definitions: Array<[string, () => unknown]> = [
    ['fetch', () => () => guard('fetch')],
    ['XMLHttpRequest', () => class { constructor() { guard('XMLHttpRequest') } }],
    ['WebSocket', () => class { constructor() { guard('WebSocket') } }],
    ['EventSource', () => class { constructor() { guard('EventSource') } }],
  ]
  for (const [name, factory] of definitions) {
    originals.set(name, scope[name])
    scope[name] = factory()
  }
  return {
    calls,
    restore: () => {
      for (const [name, value] of originals) scope[name] = value
    },
    assertNone: () => {
      if (calls.length > 0) throw new Error(`检测到远端请求调用：${calls.join(', ')}`)
    },
  }
}
