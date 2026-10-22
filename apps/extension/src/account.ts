import type { Account } from '../../../packages/protocol/src/index.ts'
import type { CookieResult, ExtensionEnv } from './env.ts'

/** 闲鱼首页：cookies.get 需要在 host_permissions 覆盖的 url 上读取域 cookie。 */
const XIANYU_HOME_URL = 'https://www.goofish.com/'
/** 闲鱼用户 ID cookie。 */
const USER_ID_COOKIE = 'unb'
/** 闲鱼昵称 cookie（百分号编码）。 */
const NICK_COOKIE = 'tracknick'
/** cookie 变化合并窗口：闲鱼登录/退出会连续写多个 cookie，合并后只读一次。 */
const DEFAULT_DEBOUNCE_MS = 300
/** 单次读取的最大尝试次数：读取期间账号切换时重读，超过次数判定为读取失败。 */
const MAX_READ_ATTEMPTS = 3
/** 单次 cookie API 调用的截止时间；浏览器 API 不返回时不能卡住 native 握手。 */
const DEFAULT_COOKIE_TIMEOUT_MS = 2000

export class AccountReadError extends Error {
  constructor(message = '账号 cookie 读取失败') {
    super(message)
    this.name = 'AccountReadError'
  }
}

export interface AccountTrackerOptions {
  /** cookie 变化合并窗口，默认 300ms。 */
  debounceMs?: number
  /** 单次 cookie 读取截止时间，默认 2000ms。 */
  cookieTimeoutMs?: number
}

/**
 * 账号观测器：只读 `unb` / `tracknick` cookie，不发任何网络请求。
 *
 * 关键约束：
 * - 读取串行化，旧快照不会覆盖新账号；
 * - 读取异常只记录并保留上一次观测值，绝不把异常伪装成退出登录（account = null）；
 * - 一次读取内重读 `unb` 确认快照，避免组合出“旧 ID + 新昵称”的混合账号；
 * - 任何成功观测到的账号变化都会通知订阅者（不只在 debounce 路径），
 *   否则 `system.status` 抢先读到新账号会让 host 账本停在旧账号；
 * - 首次握手由 hello 承载，用 markReported 登记基线，不重复推送事件。
 */
export class AccountTracker {
  #env: ExtensionEnv
  #debounceMs: number
  #cookieTimeoutMs: number
  #current: Account = null
  /** 已经通过 hello 或 account.changed 上报给 host 的账号基线；undefined 表示尚未上报。 */
  #reported: Account | undefined = undefined
  #observed = false
  #unsubscribe: (() => void) | null = null
  #timer: number | null = null
  #listeners = new Set<(account: Account) => void>()
  /** 读取队列：保证任意时刻只有一个 cookie 读取在途，新读取排在上一次之后。 */
  #queue: Promise<unknown> = Promise.resolve()
  /** 停止代次：stop 后，所有旧读取必须在下一个等待点立即结束。 */
  #generation = 0
  /** 当前在途 cookie 读取的取消入口；stop 时主动结束等待并清理计时器。 */
  #cookieWaits = new Set<(error: AccountReadError) => void>()

  constructor(env: ExtensionEnv, options: AccountTrackerOptions = {}) {
    this.#env = env
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    this.#cookieTimeoutMs = options.cookieTimeoutMs ?? DEFAULT_COOKIE_TIMEOUT_MS
  }

  /** 上一次成功观测到的账号；读取失败时不改变。 */
  get current(): Account {
    return this.#current
  }

  /** 已经上报给 host 的账号基线；undefined 表示本次连接尚未完成 hello。 */
  get reported(): Account | undefined {
    return this.#reported
  }

  /**
   * hello 发送成功后由连接层登记基线与这次上报值一致才接受，
   * 避免把已经推送过的新账号回退成旧基线。
   */
  markReported(account: Account): void {
    if (this.#reported !== undefined && !sameAccount(this.#reported, account)) return
    this.#reported = account
  }

  /** 订阅 cookie 变化；重复调用安全。 */
  observe(): void {
    if (this.#observed) return
    this.#observed = true
    this.#unsubscribe = this.#env.cookies.onChanged(() => this.#scheduleRefresh())
  }

  /** 取消订阅、终止在途读取并清理计时器。 */
  stop(): void {
    this.#generation += 1
    if (this.#timer !== null) {
      this.#env.timers.clearTimeout(this.#timer)
      this.#timer = null
    }
    if (this.#unsubscribe) {
      this.#unsubscribe()
      this.#unsubscribe = null
    }
    const error = new AccountReadError('账号读取已停止')
    for (const cancel of [...this.#cookieWaits]) cancel(error)
    this.#cookieWaits.clear()
    this.#observed = false
  }

  /** 账号变化通知；返回取消订阅函数。 */
  onChange(listener: (account: Account) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * 读取当前账号。读取失败抛出 AccountReadError，由调用方决定重试策略。
   * 未登录返回 null（这是有效观测，不是失败）。
   */
  read(): Promise<Account> {
    const generation = this.#generation
    const run = this.#queue.then(() => {
      this.#assertActive(generation)
      return this.#readOnce(generation)
    })
    // 队列只用于排序，不能因一次失败中断后续读取。
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run.then((account) => {
      this.#assertActive(generation)
      this.#current = account
      this.#maybeEmit()
      return account
    })
  }

  /** debounce 到期后的刷新：读取失败只记录，不改变观测值，也不通知。 */
  async refresh(): Promise<void> {
    try {
      // read() 内部完成“观测值变化 → 通知”，这里不重复比较。
      await this.read()
    } catch (error) {
      this.#env.log('warn', '账号读取失败，保留上次观测值', {
        reason: error instanceof Error ? error.message : 'unknown',
      })
    }
  }

  #scheduleRefresh(): void {
    if (this.#timer !== null) this.#env.timers.clearTimeout(this.#timer)
    this.#timer = this.#env.timers.setTimeout(() => {
      this.#timer = null
      void this.refresh()
    }, this.#debounceMs)
  }

  #emit(account: Account): void {
    for (const listener of [...this.#listeners]) listener(account)
  }

  /** 观测值与已上报基线不同才通知；尚未上报（hello 前）交给 hello 承载。 */
  #maybeEmit(): void {
    if (this.#reported === undefined) return
    if (sameAccount(this.#reported, this.#current)) return
    this.#reported = this.#current
    this.#emit(this.#current)
  }

  async #readOnce(generation: number): Promise<Account> {
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      // unb → nick → unb：首尾 unb 一致才认为整个快照属于同一账号。
      // 连续两次读 unb 再加 nick 会漏掉“读 nick 期间切换账号”的情况。
      const userId = normalizeCookieValue(await this.#getCookie(USER_ID_COOKIE, generation))
      const nick = decodeNick(await this.#getCookie(NICK_COOKIE, generation))
      const confirmed = normalizeCookieValue(await this.#getCookie(USER_ID_COOKIE, generation))
      this.#assertActive(generation)
      if (userId !== confirmed) continue
      if (!confirmed) return null
      return { userId: confirmed, nick: nick ?? confirmed }
    }
    throw new AccountReadError('账号 cookie 在校验期间持续变化')
  }

  async #getCookie(name: string, generation: number): Promise<CookieResult> {
    this.#assertActive(generation)
    let timer: number | null = null
    let settled = false
    let cancelWait: (error: AccountReadError) => void = () => undefined
    /** 诊断只记录读取结果类别，不记录 cookie 值或浏览器内部异常正文。 */
    let outcome = 'error'
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = this.#env.timers.setTimeout(
          () => {
            if (settled) return
            settled = true
            outcome = 'timeout'
            reject(new AccountReadError(`读取 cookie ${name} 超时`))
          },
          this.#cookieTimeoutMs,
        )
      })
      const cancelled = new Promise<never>((_, reject) => {
        cancelWait = (error) => {
          if (settled) return
          settled = true
          outcome = 'cancelled'
          if (timer !== null) {
            this.#env.timers.clearTimeout(timer)
            timer = null
          }
          reject(error)
        }
        this.#cookieWaits.add(cancelWait)
      })
      const value = await Promise.race([
        this.#env.cookies.get({ url: XIANYU_HOME_URL, name }),
        timeout,
        cancelled,
      ])
      settled = true
      outcome = value?.value ? 'ok' : 'empty'
      return value
    } catch {
      // 不附带原始异常细节，避免 cookie 值或浏览器内部信息进入日志。
      throw new AccountReadError(`读取 cookie ${name} 失败`)
    } finally {
      settled = true
      this.#cookieWaits.delete(cancelWait)
      if (timer !== null) this.#env.timers.clearTimeout(timer)
      this.#env.log('info', '账号 cookie 读取结果', { cookie: name, outcome })
    }
  }

  #assertActive(generation: number): void {
    if (generation !== this.#generation) throw new AccountReadError('账号读取已取消')
  }
}

function normalizeCookieValue(cookie: CookieResult): string | null {
  const value = cookie?.value?.trim()
  return value ? value : null
}

/** tracknick 是百分号编码的昵称；解码失败时退回原始值，不因此判定为退出登录。 */
function decodeNick(cookie: CookieResult): string | null {
  const raw = normalizeCookieValue(cookie)
  if (!raw) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

function sameAccount(a: Account, b: Account): boolean {
  if (a === null || b === null) return a === b
  return a.userId === b.userId && a.nick === b.nick
}
