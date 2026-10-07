import type { ProductRepository } from '../../../shared/capture/product-repository'
import type { Product, ProductSnapshot } from '../../../shared/types/product'
import type { Task } from '../../../shared/types/task'
import { withTaskUpdateLock, type TaskStore } from '../../../shared/task/task-store'
import type { BackupFileHandle } from '../../../shared/persistence/file-handle'

interface BackupData {
  format: 'fishops-data'
  version: 1
  savedAt: number
  products: Product[]
  snapshots: ProductSnapshot[]
  tasks: Task[]
  publish: Task[]
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const number = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const text = (v: unknown): v is string => typeof v === 'string'
function product(v: unknown): v is Product {
  if (!record(v) || !text(v.itemId) || !v.itemId) return false
  return ['title', 'price', 'originalPrice', 'publishTime', 'captureTime', 'sellerNick', 'sellerCity', 'freeShip', 'tags', 'coverUrl', 'detailUrl'].every(key => text(v[key])) &&
    ['priceNumber', 'originalPriceNumber', 'wantCnt', 'publishTimeMs', 'captureTimeMs'].every(key => number(v[key])) &&
    (v.images === undefined || (Array.isArray(v.images) && v.images.every(text))) &&
    (v.source === undefined || ['my_published', 'captured_search', 'legacy_unconfirmed'].includes(v.source as string))
}
function task(v: unknown, publish: boolean): v is Task {
  return record(v) && text(v.id) && !!v.id &&
    (publish ? v.type === 'publish' : ['capture', 'analysis'].includes(v.type as string)) &&
    ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled', ...(publish ? ['waiting_confirmation'] : [])].includes(v.status as string) &&
    number(v.createdAt) && number(v.updatedAt) && number(v.progress) && v.progress <= 100 && record(v.payload) &&
    (v.meta === undefined || record(v.meta)) && (v.result === undefined || record(v.result))
}
/** 完整校验后才允许恢复或覆盖文件，拒绝损坏、重复 ID 和未知版本。 */
export function parseBackup(content: string): BackupData {
  const v: unknown = JSON.parse(content)
  if (!record(v) || v.format !== 'fishops-data' || v.version !== 1 || !number(v.savedAt) ||
    !Array.isArray(v.products) || !v.products.every(product) ||
    !Array.isArray(v.snapshots) || !v.snapshots.every(s => record(s) && text(s.id) && !!s.id && text(s.itemId) && number(s.capturedAt) && number(s.wantCnt) && number(s.priceNumber) && text(s.price) && (s.product === undefined || product(s.product))) ||
    !Array.isArray(v.tasks) || !v.tasks.every(t => task(t, false)) ||
    !Array.isArray(v.publish) || !v.publish.every(t => task(t, true))) throw new Error('备份文件损坏或版本不支持，未恢复数据')
  for (const [items, key] of [[v.products, 'itemId'], [v.snapshots, 'id'], [v.tasks, 'id'], [v.publish, 'id']] as const) {
    const ids = items.map(item => (item as Record<string, unknown>)[key])
    if (new Set(ids).size !== ids.length) throw new Error('备份包含重复记录，未恢复数据')
  }
  return v as unknown as BackupData
}

import type { BackupStatus } from '../../../shared/persistence/backup-status'
/** 串行文件写入与恢复；原子关闭文件，失败时保留上次有效版本。 */
export class FileBackup {
  private queue: Promise<unknown> = Promise.resolve()
  private status: BackupStatus = { fileName: null, phase: 'unconfigured', savedAt: null, error: null }
  private readonly deps: { products: ProductRepository; tasks: TaskStore; publish: TaskStore; getHandle(): Promise<BackupFileHandle | null>; onTaskRestored?(task: Task): void; readStatus?(): Promise<BackupStatus | null>; writeStatus?(status: BackupStatus): Promise<void> }
  constructor(deps: FileBackup['deps']) { this.deps = deps }
  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }
  async getStatus(): Promise<BackupStatus> {
    const handle = await this.deps.getHandle()
    if (!handle) return { fileName: null, phase: 'unconfigured', savedAt: null, error: null }
    const stored = await this.deps.readStatus?.()
    if (stored && this.status.phase === 'unconfigured') this.status = stored
    if (handle && await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      return { ...this.status, fileName: handle.name, phase: 'error', error: '文件权限失效，请重新授权' }
    }
    return { ...this.status, fileName: handle?.name ?? null }
  }
  save(): Promise<BackupStatus> {
    return this.run(async () => {
      const handle = await this.deps.getHandle()
      if (!handle) return this.status = { ...this.status, phase: 'unconfigured', fileName: null }
      this.status = { ...this.status, fileName: handle.name, phase: 'saving', error: null }
      let writer: Awaited<ReturnType<BackupFileHandle['createWritable']>> | null = null
      try {
        if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('文件权限失效，请在设置页重新授权')
        const previous = await handle.getFile()
        if (previous.size) parseBackup(await previous.text())
        if (!this.deps.products.exportData) throw new Error('当前商品存储不支持文件备份')
        const data = await this.deps.products.exportData()
        const tasks = (await this.deps.tasks.list()).filter(t => t.type !== 'publish')
        const publish = await this.deps.publish.list()
        const savedAt = Date.now()
        const content = JSON.stringify({ format: 'fishops-data', version: 1, savedAt, ...data, tasks, publish })
        if (new TextEncoder().encode(content).byteLength > 50 * 1024 * 1024) throw new Error('备份超过 50 MB，未覆盖原文件')
        parseBackup(content)
        writer = await handle.createWritable()
        await writer.write(content)
        await writer.close()
        this.status = { fileName: handle.name, phase: 'saved', savedAt, error: null }
        await this.deps.writeStatus?.(this.status)
        return this.status
      } catch (error) {
        if (writer) await writer.abort().catch(() => {})
        this.status = { ...this.status, phase: 'error', error: error instanceof Error ? error.message : '文件保存失败' }
        await this.deps.writeStatus?.(this.status).catch(() => {})
        throw error
      }
    })
  }
  restore(content: string): Promise<{ products: number; tasks: number }> {
    return this.run(async () => {
      const data = parseBackup(content)
      if (!this.deps.products.importData) throw new Error('当前商品存储不支持文件恢复')
      await this.deps.products.importData(data)
      for (const [store, tasks] of [[this.deps.tasks, data.tasks], [this.deps.publish, data.publish]] as const) {
        for (const incoming of tasks) await withTaskUpdateLock(store, incoming.id, async () => {
          const existing = await store.get(incoming.id)
          // 只合并缺失或旧终态记录，不覆盖当前活动任务；重复恢复也不生成新 ID。
          if (existing && (existing.updatedAt >= incoming.updatedAt || ['pending', 'running', 'paused', 'waiting_confirmation'].includes(existing.status))) return
          const restored = structuredClone(incoming)
          if (['pending', 'running', 'paused', 'waiting_confirmation'].includes(restored.status)) {
            restored.status = restored.type === 'capture' ? 'paused' : restored.type === 'analysis' ? 'failed' : 'cancelled'
            restored.meta = { ...restored.meta, recoveryNote: restored.type === 'capture' ? '从文件恢复，等待手动恢复采集' : '从文件恢复，仅保留历史，禁止自动执行' }
          }
          await store.save(restored)
          this.deps.onTaskRestored?.(structuredClone(restored))
        })
      }
      return { products: data.products.length, tasks: data.tasks.length + data.publish.length }
    })
  }
}
