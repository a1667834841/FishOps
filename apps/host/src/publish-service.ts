import { createHash, randomUUID } from 'node:crypto'
import { keys, object } from '../../../packages/protocol/src/index.ts'
import {
  isPublishMyItemsResult, isPublishPrepareResult, isPublishSubmitResult,
  normalizePublishMyItemsParams, normalizePublishPrepareParams, normalizePublishSubmitParams, publishFingerprint,
  type PublishDraft, type PublishDraftSummary, type PublishMyItem, type PublishMyItemsResult,
  type PublishPrepareCandidates, type PublishPrepareParams, type PublishPrepareResult,
  type PublishSubmitParams, type PublishSubmitResult,
} from '../../../packages/protocol/src/publish.ts'
import type { HostDatabase } from './database.ts'
import type { RunInput } from './scheduler.ts'

/**
 * M5 发布编排（Host 侧，离线）。
 *
 * 边界：
 * - 只编排不触网：固定页面执行由调用方通过 `executePage` 注入，本模块不访问平台、不读写 cookie。
 * - 幂等权威是 v4 `operations`：prepare/submit 都先 `claimOperation` 再派发，`attempting`/`unknown`
 *   在进程重启后依然阻断自动重放。
 * - 成功只承认“平台明确成功 + 官方在售列表新增唯一 itemId”；拿不到完整基线或无法确认一律记为
 *   `unknown` 并锁定，绝不先发后猜。
 * - 设计依据见 docs/m5-publish-plan.md。
 */

/** 发布内部单步方法；扩展侧发布页面执行器补齐前，host 只做固定账户与页面上下文透传。 */
export type PublishStepMethod = 'publish.prepare' | 'publish.submit' | 'publish.myItems'
/** 固定执行上下文；步骤失败后不得换账号或换文档重放。 */
export type PublishPageContext = { accountId: string; tabId: number; documentId: string }
/** 单步请求；`params` 由 service 组装，只含已归一化业务字段。 */
export type PublishStepRequest = { method: PublishStepMethod; params: unknown; context: PublishPageContext }

/** 发布编排依赖；`executePage` 必须等待真实步骤终结，不能用 HTTP 等待超时替代。 */
export type PublishServiceDeps = {
  db: HostDatabase
  accountId(): string | null
  now(): number
  schedule<T>(input: RunInput, execute: () => Promise<T>, signal?: AbortSignal): Promise<T>
  resolvePage(accountId: string): Promise<{ tabId: number; documentId: string }>
  executePage(step: PublishStepRequest): Promise<unknown>
}

type Phase = 'queue' | 'read' | 'write'

/** prepare 引用有效期；过期后必须重新 prepare，不复用旧 token。 */
const PREPARE_TTL_MS = 30 * 60 * 1000
/** 单次完整在售列表的安全页数上限；超过上限不当作完整基线。 */
const MY_ITEMS_PAGES_MAX = 20
/** 内部基线读取页大小；协议 myItems 单页上限为 200。 */
const MY_ITEMS_LIMIT = 200
/** 公共 myItems 结果上限；超出即无法给出合法完整列表，只能报告未知。 */
const MY_ITEMS_MAX = 200
const DEFAULT_WAIT_MS = 120000
const ID_MAX = 128
const TITLE_MAX = 2000
const MESSAGES: Record<string, string> = {
  BAD_REQUEST: '发布参数或 prepare 引用无效',
  LOGIN_REQUIRED: '当前账号未登录，不能执行发布操作',
  ACCOUNT_CHANGED: '操作期间账号已变化',
  PAGE_NOT_READY: '发布页面尚未就绪',
  IDEMPOTENCY_CONFLICT: '幂等键已绑定其他发布参数',
  RESULT_UNKNOWN: '发布结果未知，禁止自动重放',
  TIMEOUT: '发布步骤等待超时，结果未知',
  CANCELLED: '调用方已取消发布等待',
  PLATFORM_REJECTED: '平台明确拒绝本次发布',
  INTERNAL: '平台返回的发布数据无效',
}
/** 统一构造发布错误；一律 `retryable=false`，禁止调用方把未知结果当成可自动重试。 */
const fail = (code: string, phase: Phase) => Object.assign(new Error(MESSAGES[code] ?? '发布操作未完成'), { code, phase, retryable: false })
/**
 * 可判定“没有发生平台提交/平台明确拒绝”的失败码。
 * 只有“未派发 + 这些码”才记 `failed`；其余错误（含超时、换号、页面未就绪、扩展离线）一律锁定为
 * `unknown`，因为无法证明平台副作用没有发生。
 */
const FAILED_CODES = new Set(['BAD_REQUEST', 'CANCELLED', 'LOGIN_REQUIRED', 'PLATFORM_REJECTED'])
const statusOf = (code: string, dispatched: boolean): 'failed' | 'unknown' => !dispatched && FAILED_CODES.has(code) ? 'failed' : 'unknown'
/**
 * operations 表只接受 ≤256 字符的定长指纹，而协议指纹是规范化 JSON，发布草稿很容易超限；
 * 这里先对协议指纹做摘要：同关联参数仍得到同一指纹，且不截断参数。
 */
const operationFingerprint = (canonical: string): string => createHash('sha256').update(canonical).digest('hex')

/** prepare 成功后持久化的权威引用；不含 cookie、签名、token 原文或原始响应。 */
type PreparedRecord = {
  accountId: string
  token: string
  /** 页面权威 prepare 的受控内部引用；只用于 submit 单步，不进入公共结果。 */
  prepareRef: string
  itemId: string
  draftFingerprint: string
  expiresAt: number
  draft: PublishDraft
  summary: PublishDraftSummary
  candidates: PublishPrepareCandidates
  status: 'prepared' | 'consuming' | 'consumed'
  consumedBy?: string
  createdAt: number
  context?: PublishPageContext
}

type PreparePageData = {
  summary: PublishDraftSummary
  candidates: PublishPrepareCandidates
  prepareRef: string
}

/** 页面 prepare 步骤只接受脱敏摘要、候选集合与受控内部引用。 */
function preparePageData(value: unknown, probe: { token: string; fingerprint: string; expiresAt: number }): PreparePageData {
  if (!object(value) || !keys(value, ['draft', 'candidates', 'prepareRef'])) throw fail('INTERNAL', 'read')
  const prepareRef = value.prepareRef
  if (typeof prepareRef !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(prepareRef)) throw fail('INTERNAL', 'read')
  const candidates = value.candidates
  if (!object(candidates) || !keys(candidates, ['categoryRefs', 'attributeRefs', 'serviceRefs'])) throw fail('INTERNAL', 'read')
  // 复用协议校验：组装成完整 prepare 结果，只有形状完全合法才接受页面数据。
  const result = { prepareToken: probe.token, draftFingerprint: probe.fingerprint, expiresAt: probe.expiresAt, draft: value.draft, candidates }
  if (!isPublishPrepareResult(result)) throw fail('INTERNAL', 'read')
  return {
    summary: value.draft as PublishDraftSummary,
    candidates: candidates as unknown as PublishPrepareCandidates,
    prepareRef,
  }
}

/** 单条在售商品摘要；标题只作辅助，缺失不阻断已明确 itemId 的条目。 */
function myItemsEntry(value: unknown): PublishMyItem {
  if (!object(value) || !keys(value, ['itemId', 'title'])) throw fail('INTERNAL', 'read')
  const itemId = value.itemId
  if (typeof itemId !== 'string' || !itemId.trim() || itemId.length > ID_MAX) throw fail('INTERNAL', 'read')
  const title = value.title
  if (title === undefined) return { itemId }
  if (typeof title !== 'string' || !title.trim() || title.length > TITLE_MAX) throw fail('INTERNAL', 'read')
  return { itemId, title }
}

/** 页面 myItems 单页结果；只接受最小摘要、显式 hasMore 与主机分页令牌，重复 itemId 交给收集器去重。 */
function myItemsPage(value: unknown): { items: PublishMyItem[]; hasMore: boolean; nextPage?: string } {
  if (!object(value) || !keys(value, ['items', 'hasMore', 'nextPage']) || !Array.isArray(value.items)) throw fail('INTERNAL', 'read')
  if (value.items.length > MY_ITEMS_MAX || typeof value.hasMore !== 'boolean') throw fail('INTERNAL', 'read')
  const items = value.items.map(myItemsEntry)
  const nextPage = value.nextPage
  if (nextPage !== undefined && (typeof nextPage !== 'string' || !nextPage.length || nextPage.length > 256)) throw fail('INTERNAL', 'read')
  if (value.hasMore && nextPage === undefined) throw fail('INTERNAL', 'read')
  return nextPage === undefined ? { items, hasMore: value.hasMore } : { items, hasMore: value.hasMore, nextPage }
}

/** 页面 submit 步骤的内部终态；其他形状一律不判成功。 */
type SubmitOutcome = { outcome: 'accepted' | 'rejected'; itemId?: string }
function submitOutcome(value: unknown): SubmitOutcome {
  if (!object(value) || !keys(value, ['outcome', 'itemId'])) throw fail('RESULT_UNKNOWN', 'write')
  if (value.outcome === 'rejected') {
    if (value.itemId !== undefined) throw fail('RESULT_UNKNOWN', 'write')
    return { outcome: 'rejected' }
  }
  if (value.outcome !== 'accepted') throw fail('RESULT_UNKNOWN', 'write')
  const itemId = value.itemId
  if (itemId === undefined) return { outcome: 'accepted' }
  if (typeof itemId !== 'string' || !itemId.length || itemId.length > ID_MAX || itemId.trim() !== itemId || /[\u0000-\u0020\u007f]/.test(itemId)) {
    throw fail('RESULT_UNKNOWN', 'write')
  }
  return { outcome: 'accepted', itemId }
}

/** prepare 步骤只传归一化业务字段；幂等键、调度参数与账号范围不进入单步。 */
function prepareStepParams(params: PublishPrepareParams): Record<string, unknown> {
  return {
    source: params.source,
    seller: params.seller,
    confirm: params.confirm,
    ...(params.draft === undefined ? {} : { draft: params.draft }),
  }
}

/** submit 步骤只接受 host 已验证引用：页面不得自造 payload、图片或服务项。 */
function submitStepParams(prepared: PreparedRecord, params: PublishSubmitParams): Record<string, unknown> {
  return {
    prepareToken: prepared.token,
    prepareRef: prepared.prepareRef,
    draftFingerprint: prepared.draftFingerprint,
    confirm: params.confirm,
  }
}

/** 发布编排入口；所有平台动作都通过注入依赖发生。 */
export function createPublishService(deps: PublishServiceDeps) {
  /** prepare 引用按 token 全局索引；记录自带账号，跨账号使用按 ACCOUNT_CHANGED 拒绝。 */
  const recordKey = (token: string) => `publish.prepared:${token}`
  /** 持久状态损坏属于未知事实，必须失败关闭，不得当成“没有引用”。 */
  const parsePrepared = (value: unknown): PreparedRecord => {
    if (!object(value)) throw fail('INTERNAL', 'read')
    const record = value as Record<string, unknown>
    if (typeof record.accountId !== 'string' || typeof record.token !== 'string' || typeof record.prepareRef !== 'string' ||
      typeof record.itemId !== 'string' ||
      typeof record.draftFingerprint !== 'string' || !Number.isSafeInteger(record.expiresAt) || !object(record.draft) ||
      (record.status !== 'prepared' && record.status !== 'consuming' && record.status !== 'consumed')) throw fail('INTERNAL', 'read')
    return record as unknown as PreparedRecord
  }
  const readPrepared = (token: string): PreparedRecord | null => {
    const row = deps.db.db.prepare('SELECT value FROM state WHERE key=?').get(recordKey(token)) as { value: string } | undefined
    return row ? parsePrepared(JSON.parse(row.value)) : null
  }
  const putPrepared = (record: PreparedRecord): void => {
    deps.db.db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(recordKey(record.token), JSON.stringify(record))
  }
  /**
   * 原子消费 prepare 引用。
   *
   * 写平台前必须先 CAS 为 consuming；即使随后超时或结果未知，也不能恢复
   * prepared，避免调用方换幂等键后再次提交同一引用。
   */
  const consumePrepared = (prepared: PreparedRecord, idempotencyKey: string): PreparedRecord => {
    const claimed: PreparedRecord = { ...prepared, status: 'consuming' }
    deps.db.db.exec('BEGIN IMMEDIATE')
    try {
      const row = deps.db.db.prepare('SELECT value FROM state WHERE key=?').get(recordKey(prepared.token)) as { value: string } | undefined
      if (!row) throw fail('BAD_REQUEST', 'write')
      const current = parsePrepared(JSON.parse(row.value))
      if (current.status !== 'prepared' || current.draftFingerprint !== prepared.draftFingerprint ||
        current.prepareRef !== prepared.prepareRef || current.accountId !== prepared.accountId) {
        throw fail('BAD_REQUEST', 'write')
      }
      // 绑定消费它的 submit 幂等键，便于审计而不暴露到公共结果。
      putPrepared({ ...claimed, consumedBy: idempotencyKey } as PreparedRecord)
      deps.db.db.exec('COMMIT')
      return { ...claimed, consumedBy: idempotencyKey } as PreparedRecord
    } catch (error) {
      if (deps.db.db.isTransaction) deps.db.db.exec('ROLLBACK')
      throw error
    }
  }
  /**
   * 在调度槽内重新定位固定页；定位失败不发送任何步骤，也不自动换页重试。
   * `expect` 用于“发包前后 documentId 未变化”的核验：不一致说明页面已被替换，无法归因。
   */
  const pageContext = async (accountId: string, expect?: PublishPageContext): Promise<PublishPageContext> => {
    const page = await deps.resolvePage(accountId)
    if (!page || !Number.isSafeInteger(page.tabId) || page.tabId < 0 || typeof page.documentId !== 'string' || !page.documentId.length) throw fail('PAGE_NOT_READY', 'read')
    if (expect && (page.tabId !== expect.tabId || page.documentId !== expect.documentId)) throw fail('RESULT_UNKNOWN', 'write')
    return { accountId, tabId: page.tabId, documentId: page.documentId }
  }
  /** 读取完整在售列表；分页被截断、页面被替换或结果缺字段都不得当作完整基线。 */
  const collectMyItems = async (input: { accountId: string; limit: number; maxWaitMs: number; minIntervalMs?: number; expect?: PublishPageContext; signal?: AbortSignal }): Promise<{ items: PublishMyItem[]; total: number; hasMore: false; context: PublishPageContext }> => {
    const items = new Map<string, PublishMyItem>()
    let nextPage: string | undefined
    const seenCursors = new Set<string>()
    let context: PublishPageContext | undefined
    for (let page = 0; page < MY_ITEMS_PAGES_MAX; page += 1) {
      const cursor = nextPage
      if (cursor !== undefined) {
        if (seenCursors.has(cursor)) throw fail('RESULT_UNKNOWN', 'read')
        seenCursors.add(cursor)
      }
      const params = cursor === undefined ? { limit: input.limit } : { limit: input.limit, nextPage: cursor }
      const outcome = await deps.schedule({ accountId: input.accountId, category: 'light', maxWaitMs: input.maxWaitMs, minIntervalMs: input.minIntervalMs }, async () => {
        if (deps.accountId() !== input.accountId) throw fail('ACCOUNT_CHANGED', 'read')
        const resolved = await pageContext(input.accountId, input.expect)
        return { resolved, page: myItemsPage(await deps.executePage({ method: 'publish.myItems', params, context: resolved })) }
      }, input.signal)
      context = outcome.resolved
      const result = outcome.page
      for (const item of result.items) if (!items.has(item.itemId)) items.set(item.itemId, item)
      if (items.size > MY_ITEMS_MAX) throw fail('RESULT_UNKNOWN', 'read')
      if (!result.hasMore) return { items: [...items.values()], total: items.size, hasMore: false, context }
      if (result.nextPage === undefined) throw fail('RESULT_UNKNOWN', 'read')
      nextPage = result.nextPage
    }
    // 达到安全上限仍有下一页：宁可报告未知，也不伪造完整基线。
    throw fail('RESULT_UNKNOWN', 'read')
  }
  /** 组装 host 签发的 prepare 引用与公开结果；token 与指纹都不由页面决定。 */
  const buildPrepared = (accountId: string, params: PublishPrepareParams, value: unknown): { record: PreparedRecord; result: PublishPrepareResult } => {
    const token = randomUUID()
    const draft = params.draft ?? {}
    const expiresAt = deps.now() + PREPARE_TTL_MS
    const page = preparePageData(value, { token, fingerprint: 'pending', expiresAt })
    // 指纹同时绑定调用方已规范草稿与页面权威准备摘要/候选；页面 prepareRef
    // 另行绑定该指纹，任何一方被替换都会在 submit 前失败关闭。
    const draftFingerprint = createHash('sha256')
      .update(JSON.stringify([
        accountId,
        params.source.itemId,
        params.seller,
        draft,
        page.prepareRef,
        page.summary,
        page.candidates,
      ]))
      .digest('hex')
    const checked = preparePageData(value, { token, fingerprint: draftFingerprint, expiresAt })
    const record: PreparedRecord = {
      accountId, token, prepareRef: checked.prepareRef, itemId: params.source.itemId, draftFingerprint, expiresAt, draft,
      summary: checked.summary, candidates: checked.candidates, status: 'prepared', createdAt: deps.now(),
    }
    const result: PublishPrepareResult = { prepareToken: token, draftFingerprint, expiresAt, draft: checked.summary, candidates: checked.candidates }
    if (!isPublishPrepareResult(result)) throw fail('INTERNAL', 'read')
    return { record, result }
  }

  /** 统一终结写操作：只有“未派发 + 明确失败码”记 `failed`，其余一律锁定为 `unknown`。 */
  const settle = (accountId: string, method: PublishStepMethod, params: { idempotencyKey: string }, code: string, dispatched: boolean): void => {
    deps.db.finishOperation(accountId, method, params.idempotencyKey, statusOf(code, dispatched), undefined, code)
  }
  /** 诊断仅保留固定元数据，异常 message/name 可能含平台正文或凭据，禁止写日志。 */
  const diagnose = (method: string, code: string, dispatched: boolean): void => {
    if (!process.env.FISHOPS_DIAG) return
    process.stderr.write(JSON.stringify({ diag: method, code, dispatched, at: Date.now() }) + '\n')
  }
  // 同时兼容旧桥的 apiError 与顶层错误码。
  const codeOf = (error: unknown): string => (error as { code?: string })?.code ?? (error as { apiError?: { code?: string } })?.apiError?.code ?? 'INTERNAL'

  return {
    /** 只读确认；不接受调用方账号范围，也不写任何 operation。 */
    async myItems(raw: unknown, signal?: AbortSignal): Promise<PublishMyItemsResult> {
      const params = normalizePublishMyItemsParams(raw)
      if (signal?.aborted) throw fail('CANCELLED', 'queue')
      const accountId = deps.accountId()
      if (!accountId) throw fail('LOGIN_REQUIRED', 'queue')
      const collected = await collectMyItems({ accountId, limit: params.limit, maxWaitMs: params.maxWaitMs, minIntervalMs: params.minIntervalMs, signal })
      if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED', 'read')
      // 只返回最小摘要：执行上下文与主机分页令牌都不外泄。
      const result: PublishMyItemsResult = { items: collected.items, total: collected.total, hasMore: collected.hasMore }
      if (!isPublishMyItemsResult(result)) throw fail('INTERNAL', 'read')
      return result
    },

    /** 只做只读准备与草稿组装；不调用最终发布接口，也不把 prepare 成功当作发布成功。 */
    async prepare(raw: unknown, signal?: AbortSignal): Promise<PublishPrepareResult> {
      const params = normalizePublishPrepareParams(raw)
      const accountId = deps.accountId()
      if (!accountId) throw fail('LOGIN_REQUIRED', 'queue')
      const bound = publishFingerprint(accountId, 'publish.prepare', params)
      const claim = deps.db.claimOperation(accountId, 'publish.prepare', params.idempotencyKey, operationFingerprint(bound.fingerprint))
      // 同键同参复用既有结果；attempting/unknown 只报告锁定状态，绝不自动重放。
      if (claim.record.status === 'succeeded' && claim.record.resultJson) return claim.record.resultJson as PublishPrepareResult
      if (!claim.claimed) throw fail('RESULT_UNKNOWN', 'queue')
      if (signal?.aborted) {
        deps.db.finishOperation(accountId, 'publish.prepare', params.idempotencyKey, 'failed', undefined, 'CANCELLED')
        throw fail('CANCELLED', 'queue')
      }
      let dispatched = false
      try {
        const prepared = await deps.schedule({ accountId, category: 'detail', maxWaitMs: params.maxWaitMs ?? DEFAULT_WAIT_MS, minIntervalMs: params.minIntervalMs }, async () => {
          if (signal?.aborted) throw fail('CANCELLED', 'queue')
          if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED', 'read')
          const context = await pageContext(accountId)
          if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED', 'read')
          dispatched = true
          const built = buildPrepared(accountId, params, await deps.executePage({ method: 'publish.prepare', params: prepareStepParams(params), context }))
          built.record.context = context
          return built
        }, signal)
        if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED', 'read')
        // 引用和成功结果必须原子提交，避免崩溃留下孤立授权或不可恢复的成功记录。
        deps.db.db.exec('BEGIN IMMEDIATE')
        try {
          putPrepared(prepared.record)
          deps.db.finishOperation(accountId, 'publish.prepare', params.idempotencyKey, 'succeeded', prepared.result)
          deps.db.db.exec('COMMIT')
        } catch (error) {
          if (deps.db.db.isTransaction) deps.db.db.exec('ROLLBACK')
          throw error
        }
        return prepared.result
      } catch (error) {
        const code = codeOf(error)
        diagnose('publish.prepare', code, dispatched)
        settle(accountId, 'publish.prepare', params, code, dispatched)
        throw fail(code, dispatched ? 'read' : 'queue')
      }
    },

    /** 唯一允许写平台的入口；必须绑定 host 签发的 prepare 引用，并用官方在售列表确认新增 itemId。 */
    async submit(raw: unknown, signal?: AbortSignal): Promise<PublishSubmitResult> {
      const params = normalizePublishSubmitParams(raw)
      const accountId = deps.accountId()
      if (!accountId) throw fail('LOGIN_REQUIRED', 'queue')
      const bound = publishFingerprint(accountId, 'publish.submit', params)
      const claim = deps.db.claimOperation(accountId, 'publish.submit', params.idempotencyKey, operationFingerprint(bound.fingerprint))
      if (claim.record.status === 'succeeded' && claim.record.resultJson) return claim.record.resultJson as PublishSubmitResult
      if (!claim.claimed) throw fail('RESULT_UNKNOWN', 'queue')
      let dispatched = false
      try {
        let prepared = readPrepared(params.prepareToken)
        if (!prepared) throw fail('BAD_REQUEST', 'write')
        if (prepared.accountId !== accountId) throw fail('ACCOUNT_CHANGED', 'write')
        if (prepared.draftFingerprint !== params.draftFingerprint) throw fail('BAD_REQUEST', 'write')
        if (prepared.status !== 'prepared') throw fail('BAD_REQUEST', 'write')
        if (deps.now() >= prepared.expiresAt) throw fail('BAD_REQUEST', 'write')
        // 会话恢复不允许迁移发布授权到新文档；刷新后必须重新 prepare。
        if (!prepared.context) throw fail('PAGE_NOT_READY', 'write')
        await pageContext(accountId, prepared.context)
        if (signal?.aborted) throw fail('CANCELLED', 'queue')
        // 提交前先取完整在售基线：拿不到完整基线就不发包，绝不先发后猜。
        const before = await collectMyItems({ accountId, limit: MY_ITEMS_LIMIT, maxWaitMs: params.maxWaitMs ?? DEFAULT_WAIT_MS, minIntervalMs: params.minIntervalMs, expect: prepared.context, signal })
        if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED', 'write')
        // 基线与写操作之间不得被其他调用抢走同一引用；CAS 在任何写步骤前完成。
        prepared = consumePrepared(prepared, params.idempotencyKey)
        const outcome = await deps.schedule({ accountId, category: 'publish', maxWaitMs: params.maxWaitMs ?? DEFAULT_WAIT_MS, minIntervalMs: params.minIntervalMs }, async () => {
          if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED', 'write')
          // 写步骤必须落在与基线相同的固定文档上，否则不能把新增 itemId 归因到本次提交。
          const context = await pageContext(accountId, before.context)
          dispatched = true
          return submitOutcome(await deps.executePage({ method: 'publish.submit', params: submitStepParams(prepared, params), context }))
        }, signal)
        if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED', 'write')
        if (signal?.aborted) throw fail('RESULT_UNKNOWN', 'write')
        if (outcome.outcome === 'rejected') {
          settle(accountId, 'publish.submit', params, 'PLATFORM_REJECTED', false)
          throw fail('PLATFORM_REJECTED', 'write')
        }
        const confirmed = await collectMyItems({ accountId, limit: MY_ITEMS_LIMIT, maxWaitMs: params.maxWaitMs ?? DEFAULT_WAIT_MS, minIntervalMs: params.minIntervalMs, expect: before.context, signal })
        const known = new Set(before.items.map(item => item.itemId))
        const added = confirmed.items.filter(item => !known.has(item.itemId))
        // 数量 +1 只能辅助；页面 itemId 必须合法，且是基线之外唯一新增项。
        if (outcome.itemId === undefined || added.length !== 1 || added[0]!.itemId !== outcome.itemId) {
          throw fail('RESULT_UNKNOWN', 'write')
        }
        if (!confirmed.items.some(item => item.itemId === outcome.itemId)) throw fail('RESULT_UNKNOWN', 'write')
        const itemId = outcome.itemId
        const result: PublishSubmitResult = { state: 'published', itemId, confirmedAt: deps.now() }
        if (!isPublishSubmitResult(result)) throw fail('INTERNAL', 'write')
        if (deps.accountId() !== accountId) throw fail('ACCOUNT_CHANGED', 'write')
        // 引用一经成功提交即作废，防止换幂等键复用同一 prepare 重复发布。
        putPrepared({ ...prepared, status: 'consumed' })
        deps.db.finishOperation(accountId, 'publish.submit', params.idempotencyKey, 'succeeded', result)
        return result
      } catch (error) {
        const code = codeOf(error)
        settle(accountId, 'publish.submit', params, code, dispatched)
        throw fail(code, dispatched ? 'write' : 'queue')
      }
    },
  }
}
