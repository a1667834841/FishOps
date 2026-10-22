import { isChatSyncPageParams, type ChatSyncPageParams } from '../../../packages/protocol/src/chat-sync.ts'
import type { ErrorCode } from '../../../packages/protocol/src/index.ts'
import { ApiError } from './errors.ts'

/** 页面已有连接的最小接口；不覆盖页面事件处理器，不拥有连接生命周期。 */
export interface ChatReadSocket {
  readonly readyState: number
  send(data: string): void
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}
/** 注入连接、账号与时钟；不允许通过此接口创建连接或调整固定超时。 */
export interface ChatReadTransportDeps {
  getSocket(): ChatReadSocket | null
  readAccountId(): string | null
  now?: () => number
  setTimer?: (callback: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  /** 生成平台线上 mid 的随机源；测试可注入以固定输出。 */
  random?: () => number
}

const routes = {
  conversations: '/r/Conversation/listNewestPagination',
  messages: '/r/MessageManager/listUserMessages',
} as const
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function failure(code: ErrorCode): ApiError {
  return new ApiError(code, '聊天只读请求未能安全完成', { phase: 'read', retryable: false })
}

/**
 * 单页只读 transport。返回值仅为未归一化正文，必须再交给专门 normalizer。
 *
 * 失败关闭（poison）只用于“请求已派发但无法确认终结”：此时实例永久停用，调用方必须继续占用文档锁。
 * 未派发的失败必须保持未派发语义（PAGE_NOT_READY/BAD_REQUEST），绝不能沿用“终止未知”的错误码，
 * 否则调用方会把仍可能被平台处理的请求当成可安全释放、可重放。
 */
export function createChatReadTransport(deps: ChatReadTransportDeps) {
  const used = new Set<string>()
  const random = deps.random ?? Math.random
  let sequence = 0
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>))
  let poisoned: ErrorCode | undefined
  let bound: ChatReadSocket | undefined
  let boundAccount: string | undefined
  let pending: {
    mid: string; wireMid: string; route: string; started: number
    resolve(value: unknown): void; reject(error: ApiError): void
    timer?: unknown
  } | undefined

  function cleanupPending() {
    const entry = pending
    pending = undefined
    if (entry?.timer !== undefined) clearTimer(entry.timer)
    return entry
  }
  function unlisten() {
    if (!bound) return
    bound.removeEventListener('message', message)
    bound.removeEventListener('close', disconnected)
    bound.removeEventListener('error', disconnected)
  }
  /**
   * 释放已完成请求的旧连接绑定。仅在不存在在途请求时调用：
   * 页面 socket 空闲重连不构成“结果未知”，下一次请求可以安全绑定当前唯一 OPEN 连接。
   */
  function releaseBinding() {
    if (pending) throw new Error('在途请求不能释放连接绑定')
    unlisten()
    bound = undefined
    boundAccount = undefined
  }
  /** 失败关闭：仅用于已派发但终结未知的场景；调用方必须继续占用文档锁。 */
  function poison(code: ErrorCode) {
    if (poisoned) return
    poisoned = code
    cleanupPending()?.reject(failure(code))
    unlisten()
  }
  /**
   * 在途请求期间发现绑定失效：无法证明平台请求终结，必须失败关闭。
   * 账号变化保留自身分类；连接不可确认只能按未知超时处理，不能冒充未派发的 PAGE_NOT_READY。
   */
  function poisonInFlight(code: ErrorCode | null) {
    poison(code === 'ACCOUNT_CHANGED' ? 'ACCOUNT_CHANGED' : 'TIMEOUT')
  }
  /** 核验绑定是否仍指向同账号的同一个 OPEN 连接；只返回分类，不产生副作用。 */
  function verify(): ErrorCode | null {
    try {
      if (deps.readAccountId() !== boundAccount) return 'ACCOUNT_CHANGED'
      if (deps.getSocket() !== bound || bound?.readyState !== 1) return 'PAGE_NOT_READY'
      return null
    } catch { return 'PAGE_NOT_READY' }
  }
  function disconnected() {
    // 只有已派出请求断线才是结果未知；空闲时重连必须允许后续请求绑定新连接。
    if (pending) poisonInFlight(null)
    else releaseBinding()
  }
  function message(event: Event) {
    const entry = pending
    if (!entry || poisoned) return
    const mismatch = verify()
    if (mismatch !== null) { poisonInFlight(mismatch); return }
    if (now() - entry.started >= 15000) { poison('TIMEOUT'); return }
    const raw: unknown = (event as MessageEvent).data
    // 主动分页正文可达 512KiB；不能沿用被动推送帧的 256KiB 上限。
    // 信封另留 16KiB，正文仍由 normalizer 严格限制，不扩大推送解析边界。
    const maxReadEnvelopeBytes = 528 * 1024
    if (typeof raw !== 'string' || raw.length > maxReadEnvelopeBytes || new TextEncoder().encode(raw).byteLength > maxReadEnvelopeBytes) return
    let response: unknown
    try { response = JSON.parse(raw) } catch { return }
    // 只按本实例生成的线上 mid 精确匹配，页面自身请求的响应不会被误认。
    if (!record(response) || !record(response.headers) ||
      (response.headers.mid !== entry.wireMid)) return
    if ('lwp' in response && response.lwp !== entry.route) return
    if ('route' in response && response.route !== entry.route) return
    if (response.code !== 200 && response.code !== 0) {
      // 只使用有限错误特征做分类，绝不将平台原文带出页面。
      const text = [response.code, response.message].filter(v => typeof v === 'string').join(' ')
      const code = /captcha|RGV587|FAIL_SYS_USER_VALIDATE|x5sec|punish|_tmd_|验证码|安全验证|滑块/i.test(text)
        ? 'RISK_BLOCKED' : /TOKEN_EXPIRED|TOKEN_EMPTY|TOKEN_INVALID|NOT_LOGIN|SESSION_EXPIRED|未登录|登录失效/i.test(text)
          ? 'LOGIN_REQUIRED' : 'PLATFORM_REJECTED'
      // 平台已明确返回错误，请求在本连接上已经终结；交给调用方停止并允许事后恢复，
      // 不能把“明确拒绝”误判成结果未知而永久锁死页面。
      cleanupPending()?.reject(failure(code))
      releaseBinding()
      return
    }
    if (!Object.hasOwn(response, 'body') || !record(response.body) && !Array.isArray(response.body)) {
      cleanupPending()?.reject(failure('PLATFORM_REJECTED'))
      releaseBinding()
      return
    }
    cleanupPending()?.resolve(response.body)
  }

  return {
    /** 严格构造两种读取信封；同一实例仅允许一个挂起请求且 mid 永不复用。 */
    async query(params: ChatSyncPageParams, accountId: string, mid: string): Promise<unknown> {
      if (poisoned) throw failure(poisoned)
      if (!isChatSyncPageParams(params) || typeof accountId !== 'string' || !accountId.trim() ||
        typeof mid !== 'string' || !mid.trim() || mid.length > 128 || used.has(mid)) throw failure('BAD_REQUEST')
      if (params.mode === 'messages' && !/^[^@\s]+(?:@goofish)?$/.test(params.sessionId)) throw failure('BAD_REQUEST')
      if (pending) throw failure('PAGE_NOT_READY')
      // 没有在途请求时，旧连接失效只说明当前页面的观察代次已变化；
      // 释放旧绑定后可以绑定当前唯一 OPEN 连接，不能永久污染整个页面实例。
      if (bound) {
        const stale = verify()
        if (stale === 'ACCOUNT_CHANGED') throw failure('ACCOUNT_CHANGED')
        if (stale !== null) releaseBinding()
      }
      let socket: ChatReadSocket | null
      try {
        // 账号不一致时本次请求直接拒绝；不得复用旧账号数据，但也不需要永久停用页面实例。
        if (deps.readAccountId() !== accountId) throw failure('ACCOUNT_CHANGED')
        socket = deps.getSocket()
      } catch (error) {
        if (error instanceof ApiError) throw error
        throw failure('PAGE_NOT_READY')
      }
      if (!socket || socket.readyState !== 1) throw failure('PAGE_NOT_READY')
      if (bound && boundAccount !== accountId) releaseBinding()
      if (!bound) {
        bound = socket; boundAccount = accountId
        try {
          socket.addEventListener('message', message)
          socket.addEventListener('close', disconnected)
          socket.addEventListener('error', disconnected)
        } catch {
          // 注册可能只完成一部分：先摘掉已注册的监听再回到未绑定，
          // 否则残留 handler 会被旧连接触发，把无关消息当成当前在途响应。
          try { unlisten() } catch {}
          bound = undefined; boundAccount = undefined
          throw failure('PAGE_NOT_READY')
        }
      }
      const route = routes[params.mode]
      const body = params.mode === 'conversations' ? [Number(params.anchor), params.limit]
        : [params.sessionId.endsWith('@goofish') ? params.sessionId : `${params.sessionId}@goofish`, false, Number(params.anchor), params.limit, false]
      used.add(mid)
      return new Promise((resolve, reject) => {
        // 先登记再发送，页面或测试 socket 可以在 send 内同步投递响应。
        // 真实平台只响应 `<数字> <序号>` 格式的 mid，其它格式（如调用方 UUID）会被静默丢弃。
        // 调用方 mid 仅用于本实例防重放；线上 mid 由此处按页面同款格式生成。
        const wireMid = `${Math.floor(random() * 1000)}${now()} ${sequence++}`
        const entry = { mid, wireMid, route, started: now(), resolve, reject, timer: undefined as unknown }
        pending = entry
        try {
          entry.timer = setTimer(() => {
            const mismatch = verify()
            if (mismatch !== null) return poisonInFlight(mismatch)
            poison('TIMEOUT')
          }, 15000)
          // 发送前最后一次核验：此处失败说明请求还没派出，可以安全拒绝而不失败关闭。
          const mismatch = verify()
          if (mismatch !== null) {
            cleanupPending()
            releaseBinding()
            reject(failure(mismatch))
            return
          }
          socket.send(JSON.stringify({ lwp: route, headers: { mid: wireMid }, body }))
        } catch { poisonInFlight(null) }
      })
    },
    /**
     * 幂等移除监听和定时器；绝不关闭页面拥有的连接。
     * 已派发请求的销毁不能证明平台终结，必须保留未知语义；仅空闲销毁使用未就绪分类。
     */
    dispose(): void { poison(pending ? 'RESULT_UNKNOWN' : 'PAGE_NOT_READY') },
  }
}
