import { randomUUID, createHash } from 'node:crypto'
import { normalizeChatSyncInput } from '../../../packages/protocol/src/chat-sync-input.ts'
import { validateResult, type ChatSyncPageParams } from '../../../packages/protocol/src/chat-sync.ts'
import type { HostDatabase } from './database.ts'
import type { RunInput } from './scheduler.ts'
import type { SyncCursor } from './sync-cursor.ts'
import { ChatGapLedger, type GapLedgerSnapshot } from './chat-gap-ledger.ts'

/** 单页执行上下文；账号由 service 绑定，不接受页面重新指定。 */
export type ChatSyncContext = { accountId: string; tabId: number; documentId: string }
/** 公共单页提交结果；complete 不代表全局消息缺口已恢复。 */
export type ChatSyncServiceResult = {
  runId: string; mode: 'conversations' | 'messages'; sessionId: string | null; committedPages: number
  receivedCount: number; insertedCount: number; updatedCount: number; hasMore: boolean; nextCursor: string | null
  completion: 'more' | 'complete'; partial: boolean; gapCleared: false
}
/** 同步依赖；executePage 必须等待真实步骤终结，不能自行超时释放平台槽位。 */
export type ChatSyncServiceDeps = {
  db: HostDatabase
  accountId(): string | null
  now(): number
  resolvePage(account: string): Promise<{ tabId: number; documentId: string }>
  executePage(params: ChatSyncPageParams, context: ChatSyncContext): Promise<unknown>
  schedule<T>(input: RunInput, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>
  codec: { encode(value: SyncCursor): string; decode(token: string, expected: Pick<SyncCursor, 'accountId' | 'mode' | 'sessionId' | 'limit'>): SyncCursor }
}
/** 覆盖事实由 Host 提交路径生成，不接受调用方上传；末页本身不等于可靠全覆盖。 */
export type ChatSyncCoverage = { startGaps: GapLedgerSnapshot; unsupportedCount: number; terminal: boolean; documentId?: string; tabId?: number }
export type ChatSyncPersistedState = { accountId?: string | null; runId?: string; status: 'reserved' | 'queued' | 'attempting' | 'unknown' | 'committed'; tag: string | null; partial: boolean; committedPages?: number; result?: ChatSyncServiceResult; coverage?: ChatSyncCoverage }
type State = ChatSyncPersistedState
const fail = (code: string, phase: 'queue' | 'read' = 'read') => Object.assign(new Error('聊天同步未完成'), { code, phase, retryable: false })
/** 可原样回传的错误码；其余本地异常统一 INTERNAL，避免把内部故障伪装成平台结论。 */
const PASSTHROUGH_CODES = new Set(['BAD_REQUEST', 'LOGIN_REQUIRED', 'ACCOUNT_CHANGED', 'PAGE_NOT_READY', 'RISK_BLOCKED', 'PLATFORM_REJECTED', 'TIMEOUT', 'CANCELLED', 'RESULT_UNKNOWN', 'EXTENSION_OFFLINE'])
/** 能证明平台请求尚未派出的码；只有这些码允许保留同一预留，让 host 用同一 cursor 重试这一页。 */
const NOT_DISPATCHED_CODES = new Set(['PAGE_NOT_READY', 'BAD_REQUEST'])
/**
 * 取出失败原因码。
 *
 * native 桥把扩展侧协议错误放在 `apiError` 上（错误对象本身只有文案），
 * 只读 `code` 会把风控、登录失效、页面未就绪一律塌缩成 INTERNAL。
 */
function failureCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const direct = (error as { code?: unknown }).code
  if (typeof direct === 'string') return direct
  const wire = (error as { apiError?: unknown }).apiError
  const nested = wire && typeof wire === 'object' ? (wire as { code?: unknown }).code : undefined
  return typeof nested === 'string' ? nested : undefined
}

/**
 * 每次调用最多调度一个平台页；持久预留阻止同凭证并发及重启后自动重放。
 *
 * 失败分类按“能否证明未派发”分流：未派发失败保留预留（同一 cursor 可重试），
 * 已派发失败一律记为 unknown，绝不因错误码好看就允许重放。
 */
export function createChatSyncService(deps: ChatSyncServiceDeps) {
  const gapLedger = new ChatGapLedger(deps.db)
  const read = (key: string): State | null => {
    const row = deps.db.db.prepare('SELECT value FROM state WHERE key=?').get(key) as { value: string } | undefined
    return row ? JSON.parse(row.value) : null
  }
  const put = (key: string, state: State) => deps.db.db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(state))
  return {
    /** 参数、账号及凭证验证先于平台调度；排队取消零派发，已派发取消保持未知且不提交。 */
    async call(raw: unknown, signal?: AbortSignal): Promise<ChatSyncServiceResult> {
      let key: string | undefined, state: State | undefined, started = false
      let accountId: string | null = null, runId = ''
      const queued = () => { if (signal?.aborted) throw fail('CANCELLED', 'queue') }
      try {
        const input = normalizeChatSyncInput(raw)
        queued()
        accountId = deps.accountId()
        if (!accountId) throw fail('LOGIN_REQUIRED')
        const expected = { accountId, mode: input.sessionId ? 'messages' as const : 'conversations' as const, sessionId: input.sessionId ?? null, limit: input.limit }
        let cursor: SyncCursor | undefined
        if (input.cursor) {
          try { cursor = deps.codec.decode(input.cursor, expected) } catch { throw fail('BAD_REQUEST') }
        }
        runId = cursor?.runId ?? randomUUID()
        const anchor = cursor?.anchor ?? String(Number.MAX_SAFE_INTEGER)
        key = `chat.sync.service:${createHash('sha256').update(JSON.stringify([accountId, runId, anchor])).digest('hex')}`
        const old = read(key)
        if (old) {
          if (old.tag !== (input.tag ?? null)) throw fail('BAD_REQUEST')
          if (old.status === 'committed' && old.result) return old.result
          if (old.status !== 'reserved' || !cursor) throw fail('RESULT_UNKNOWN')
          const claim = deps.db.db.prepare('UPDATE state SET value=? WHERE key=? AND value=?').run(JSON.stringify({ ...old, status: 'queued' }), key, JSON.stringify(old))
          if (claim.changes !== 1) throw fail('RESULT_UNKNOWN')
          state = { ...old, accountId, runId, status: 'queued' }
          return await run()
        }
        if (cursor) throw fail('BAD_REQUEST') // 续页只能消费已提交上一页所签发的持久预留。
        state = { accountId, runId, status: 'queued', tag: input.tag ?? null, partial: false,
          coverage: { startGaps: gapLedger.snapshot(accountId), unsupportedCount: 0, terminal: false } }
        deps.db.db.prepare('INSERT INTO state(key,value) VALUES(?,?)').run(key, JSON.stringify(state))
        return await run()

        async function run(): Promise<ChatSyncServiceResult> {
          return deps.schedule({ accountId: accountId!, category: 'chatRead', maxWaitMs: input.maxWaitMs, minIntervalMs: input.minIntervalMs }, async () => {
            queued()
            if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED')
            const page = await deps.resolvePage(accountId!)
            queued()
            if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED')
            if (!Number.isSafeInteger(page.tabId) || page.tabId < 0 || !page.documentId) throw fail('PAGE_NOT_READY')
            if (cursor && (page.tabId !== cursor.tabId || page.documentId !== cursor.documentId)) {
              if (process.env.FISHOPS_DIAG) process.stderr.write(JSON.stringify({ diag: 'chat-sync-page', tabChanged: page.tabId !== cursor.tabId, documentChanged: page.documentId !== cursor.documentId }) + '\n')
              throw fail('PAGE_NOT_READY')
            }
            state!.status = 'attempting'; put(key!, { ...state!, accountId, runId }); started = true
            const params: ChatSyncPageParams = expected.mode === 'messages' ? { mode: 'messages', sessionId: input.sessionId!, anchor, limit: input.limit } : { mode: 'conversations', anchor, limit: input.limit }
            const result = await deps.executePage(params, { ...page, accountId: accountId! })
            if (!validateResult(params, result)) throw fail('INTERNAL')
            if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED')
            if (signal?.aborted) throw fail('RESULT_UNKNOWN')
            // 数据、公共结果和下一页预留同一事务提交；事务内没有异步等待。
            deps.db.db.exec('BEGIN IMMEDIATE')
            try {
            const counts = deps.db.commitChatSyncPage(accountId!, runId, anchor, params, result, input.tag)
            let coverage: ChatSyncCoverage | undefined
            if (state!.coverage) {
              const unsupportedCount = state!.coverage.unsupportedCount + result.unsupportedCount
              if (!Number.isSafeInteger(unsupportedCount)) throw fail('INTERNAL')
              coverage = { ...state!.coverage, unsupportedCount, terminal: !result.hasMore, documentId: page.documentId, tabId: page.tabId }
            }
            const partial = state!.partial || result.hasMore || result.unsupportedCount > 0
            let nextCursor: string | null = null
            if (result.hasMore) {
              nextCursor = deps.codec.encode({ version: 1, ...expected, anchor: result.nextAnchor!, ...page, runId, expiresAt: deps.now() + 3600000 })
            }
            const committedPages = (state!.committedPages ?? 0) + 1
            const response: ChatSyncServiceResult = { runId, mode: result.mode, sessionId: result.mode === 'messages' ? (params as Extract<ChatSyncPageParams, { mode: 'messages' }>).sessionId : null, committedPages,
              receivedCount: (result.mode === 'messages' ? result.messages.length : result.conversations.length) + result.unsupportedCount,
              insertedCount: counts.insertedCount, updatedCount: counts.updatedCount, hasMore: result.hasMore, nextCursor,
              completion: result.hasMore ? 'more' : 'complete', partial, gapCleared: false }
              put(key!, { ...state!, accountId, runId, status: 'committed', committedPages, result: response, ...(coverage ? { coverage } : {}) })
              if (result.hasMore) {
                const nextKey = `chat.sync.service:${createHash('sha256').update(JSON.stringify([accountId, runId, result.nextAnchor])).digest('hex')}`
                // 只跨页保留不可恢复的覆盖缺口；hasMore 是本页进度，不能让正常末页永远处于 partial。
                put(nextKey, { accountId, runId, status: 'reserved', tag: input.tag ?? null, partial: state!.partial || result.unsupportedCount > 0, committedPages, ...(coverage ? { coverage } : {}) })
              }
              deps.db.db.exec('COMMIT')
            return response
            } catch (error) { deps.db.db.exec('ROLLBACK'); throw error }
          }, signal)
        }
      } catch (error) {
        const reported = failureCode(error)
        const code = reported && PASSTHROUGH_CODES.has(reported) ? reported : 'INTERNAL'
        if (key && state) {
          // 只有证明未派发才保留可重试预留；已派发（含平台明确停止）一律不可重放。
          if (started && !NOT_DISPATCHED_CODES.has(code)) { try { put(key, { ...state, accountId: accountId!, runId, status: 'unknown' }) } catch {} }
          else if (raw && typeof raw === 'object' && 'cursor' in raw) put(key, { ...state, accountId: accountId!, runId, status: 'reserved' })
          else deps.db.db.prepare('DELETE FROM state WHERE key=?').run(key)
        }
        throw fail(code, !started ? 'queue' : 'read')
      }
    },
  }
}
