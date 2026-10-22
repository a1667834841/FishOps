/**
 * 发布 prepared 的会话存储适配。
 *
 * 仅使用 `chrome.storage.session`（浏览器会话内存，不落盘）。存储值包含
 * 类目 transportData、地址和已上传图片等权威字段，因此：
 * - 键按账号分区，读取时仍由执行器复核账号；
 * - 只保存受控结构，损坏或额外字段一律失败关闭；
 * - TTL 与容量有界，避免占满 session 配额；
 * - 不把原始上下文写入日志或公共协议。
 */

import type {
  PublishPreparedContext,
  PublishPreparedCore,
  PublishPreparedStore,
} from './publish-page-executor.ts'

/** chrome.storage.session 的最小依赖面；测试可注入内存实现。 */
export type PublishSessionStorageArea = {
  get(key: string): Promise<Record<string, unknown>>
  set(value: Record<string, unknown>): Promise<void>
  remove(key: string): Promise<void>
}

export type PublishPreparedStorageDeps = {
  storage: PublishSessionStorageArea
  /** 账号命名空间；缺失时拒绝读写，不能退化成跨账号共享。 */
  accountId: () => string | null | Promise<string | null>
  now: () => number
  maxEntries?: number
}

const PREFIX = 'fishops.publish.prepared.v1'
const MAX_ENTRIES = 20
const MAX_SERIALIZED_BYTES = 7 * 1024 * 1024

type StoredEntry = PublishPreparedContext & { storedAt: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function accountNamespace(accountId: string): string {
  return `${PREFIX}:${accountId}`
}

function keyOf(namespace: string, token: string): string {
  return `${namespace}:${token}`
}

function parseCore(value: unknown): PublishPreparedCore {
  if (!isRecord(value)) throw new Error('prepared core 无效')
  const required = ['description', 'priceYuan', 'itemCatDTO', 'itemAddrDTO', 'imageInfoDOList', 'services']
  if (required.some(key => !(key in value))) throw new Error('prepared core 字段不完整')
  if (!Array.isArray(value['specifications']) || !Array.isArray(value['itemLabelExtList'])) {
    throw new Error('prepared core 集合无效')
  }
  return value as unknown as PublishPreparedCore
}

function parseEntry(value: unknown, accountId: string): StoredEntry {
  if (!isRecord(value)) throw new Error('prepared 条目无效')
  const allowed = ['accountId', 'sourceItemId', 'expiresAt', 'prepareRef', 'core', 'rawCards', 'draftFingerprint', 'storedAt']
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('prepared 条目含未知字段')
  if (value['accountId'] !== accountId || typeof value['sourceItemId'] !== 'string' ||
    !Number.isSafeInteger(value['expiresAt']) || typeof value['prepareRef'] !== 'string' ||
    typeof value['draftFingerprint'] !== 'string' || !Number.isSafeInteger(value['storedAt']) ||
    !Array.isArray(value['rawCards'])) {
    throw new Error('prepared 条目结构无效')
  }
  return {
    accountId,
    sourceItemId: value['sourceItemId'],
    expiresAt: value['expiresAt'] as number,
    prepareRef: value['prepareRef'],
    core: parseCore(value['core']),
    rawCards: value['rawCards'],
    draftFingerprint: value['draftFingerprint'],
    storedAt: value['storedAt'] as number,
  }
}

function toStored(context: PublishPreparedContext, now: number): StoredEntry {
  return {
    accountId: context.accountId,
    sourceItemId: context.sourceItemId,
    expiresAt: context.expiresAt,
    prepareRef: context.prepareRef,
    core: context.core,
    rawCards: context.rawCards,
    draftFingerprint: context.draftFingerprint,
    storedAt: now,
  }
}

function withoutStoredAt(entry: StoredEntry): PublishPreparedContext {
  const { storedAt: _storedAt, ...context } = entry
  return context
}

/**
 * 创建按账号分区的 session 存储。
 *
 * 同一扩展实例内串行化读改写，避免并发 prepare 覆盖。
 */
export function createPublishPreparedStore(deps: PublishPreparedStorageDeps): PublishPreparedStore {
  const maxEntries = deps.maxEntries ?? MAX_ENTRIES
  let queue: Promise<void> = Promise.resolve()

  async function namespace(): Promise<string> {
    const accountId = await deps.accountId()
    if (typeof accountId !== 'string' || !accountId.length) throw new Error('prepared 账号上下文不可用')
    return accountNamespace(accountId)
  }

  function serialize(action: () => Promise<void>): Promise<void> {
    const run = queue.then(action, action)
    queue = run.catch(() => {})
    return run
  }

  async function readAll(ns: string): Promise<Map<string, StoredEntry>> {
    const raw = await deps.storage.get(ns)
    const value = raw[ns]
    if (value === undefined) return new Map()
    if (!isRecord(value)) throw new Error('prepared 会话存储损坏')
    const entries = new Map<string, StoredEntry>()
    const accountId = ns.slice(PREFIX.length + 1)
    for (const [token, item] of Object.entries(value)) {
      if (!token || token.length > 256) throw new Error('prepared 存储键无效')
      entries.set(token, parseEntry(item, accountId))
    }
    return entries
  }

  async function writeAll(ns: string, entries: Map<string, StoredEntry>): Promise<void> {
    const plain: Record<string, StoredEntry> = {}
    for (const [token, entry] of entries) plain[token] = entry
    const serialized = JSON.stringify(plain)
    if (new TextEncoder().encode(serialized).byteLength > MAX_SERIALIZED_BYTES) {
      throw new Error('prepared 会话存储超过容量上限')
    }
    await deps.storage.set({ [ns]: plain })
  }

  function prune(entries: Map<string, StoredEntry>): void {
    const now = deps.now()
    for (const [token, entry] of entries) if (entry.expiresAt <= now) entries.delete(token)
    if (entries.size <= maxEntries) return
    const ordered = [...entries.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt)
    for (const [token] of ordered.slice(0, entries.size - maxEntries)) entries.delete(token)
  }

  return {
    async get(token) {
      if (!token || token.length > 256) return null
      const ns = await namespace()
      const entries = await readAll(ns)
      const entry = entries.get(token)
      if (!entry) return null
      if (entry.expiresAt <= deps.now()) {
        await serialize(async () => {
          const current = await readAll(ns)
          current.delete(token)
          await writeAll(ns, current)
        })
        return null
      }
      return withoutStoredAt(entry)
    },
    async set(token, value) {
      if (!token || token.length > 256) throw new Error('prepared 存储键无效')
      const ns = await namespace()
      if (value.accountId !== ns.slice(PREFIX.length + 1)) throw new Error('prepared 账号不匹配')
      await serialize(async () => {
        const entries = await readAll(ns)
        entries.set(token, toStored(value, deps.now()))
        prune(entries)
        await writeAll(ns, entries)
      })
    },
    async delete(token) {
      if (!token || token.length > 256) return
      const ns = await namespace()
      await serialize(async () => {
        const entries = await readAll(ns)
        if (!entries.delete(token)) return
        await writeAll(ns, entries)
      })
    },
  }
}
