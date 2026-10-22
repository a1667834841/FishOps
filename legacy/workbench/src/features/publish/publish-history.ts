import type { PublishTask, PublishTaskStatus, PublishManualConfirmationStatus } from '../contracts'
import { formatPublishTaskStatus, getPublishTaskSummary } from './publish-format'
import type { DirectPublishJob } from './direct-publish-client'

export type PublishHistoryRow = {
  id: string
  source: 'task' | 'direct-audit'
  createdAt: number
  summary: string
  status: PublishTaskStatus | 'unknown'
  statusLabel?: string
  statusTone?: 'neutral' | 'accent' | 'ok' | 'info' | 'warn' | 'error'
  confirmationStatus?: PublishManualConfirmationStatus
  idempotencyKey?: string
  itemId?: string
  itemUrl?: string
  task?: PublishTask
}

/** 仅从真实平台商品 ID 生成详情地址；不能接受记录 ID、发布页或任意 URL。 */
export function publishItemUrl(itemId: string | undefined): string | undefined {
  return itemId && /^\d+$/.test(itemId) ? `https://www.goofish.com/item?id=${itemId}` : undefined
}

/** 为缺少快照的旧审计只读获取名称；查询失败保留明确的缺失状态，不猜测商品身份。 */
export async function resolvePublishHistoryNames(jobs: DirectPublishJob[], client: Pick<import('./direct-publish-client').DirectPublishClient, 'getProduct'>): Promise<DirectPublishJob[]> {
  const names = new Map<string, string>()
  for (const job of jobs) {
    if (job.productName?.trim() || job.status !== 'published' || !publishItemUrl(job.itemId)) continue
    const id = job.itemId!
    if (names.has(id)) continue
    try {
      const result = await client.getProduct(id)
      if (result.status === 'ok' && result.itemId === id && result.product?.description.trim()) {
        names.set(id, result.product.description.trim().split(/\r?\n/)[0]!.slice(0, 120))
      }
    } catch { /* 旧商品已下架或查询失败时，不影响其他历史展示。 */ }
  }
  return jobs.map((job) => ({ ...job, productName: job.productName?.trim() || names.get(job.itemId || '') }))
}

/** 合并旧任务与直接发布审计；相同幂等键的最新审计优先且只显示一行。 */
export function mergePublishHistory(tasks: PublishTask[], jobs: DirectPublishJob[]): PublishHistoryRow[] {
  const byKey = new Map<string, DirectPublishJob>()
  for (const job of jobs) {
    const previous = byKey.get(job.idempotencyKey)
    if (!previous || Date.parse(job.at) >= Date.parse(previous.at)) byKey.set(job.idempotencyKey, job)
  }

  const rows: PublishHistoryRow[] = tasks.map((task) => ({
    statusLabel: formatPublishTaskStatus(task.status).label,
    statusTone: formatPublishTaskStatus(task.status).tone,
    id: `task:${task.id}`,
    source: 'task',
    createdAt: task.createdAt,
    summary: getPublishTaskSummary(task),
    status: task.status,
    confirmationStatus: task.result?.confirmationStatus,
    idempotencyKey: typeof task.meta?.['idempotencyKey'] === 'string' ? task.meta['idempotencyKey'] : undefined,
    // 已提交或结果未知时绝不回退来源 ID；未提交任务可查看原素材商品。
    itemId: task.status === 'completed' || task.result?.submit
      ? task.result?.submit?.publishedItemId
      : task.payload?.itemId || task.result?.item?.itemId,
    itemUrl: publishItemUrl(task.status === 'completed' || task.result?.submit
      ? task.result?.submit?.publishedItemId
      : task.payload?.itemId || task.result?.item?.itemId),
    task,
  }))

  const taskRows = new Map(rows.filter((row) => row.idempotencyKey).map((row) => [row.idempotencyKey!, row]))
  for (const job of byKey.values()) {
    const taskRow = taskRows.get(job.idempotencyKey)
    const status = job.status === 'published' ? 'completed' : job.status === 'attempting' ? 'running' : job.status === 'unknown' || job.status === 'action_required' ? 'unknown' : 'failed'
    const auditRow: PublishHistoryRow = {
      id: taskRow?.id || `direct:${job.idempotencyKey}`,
      source: 'direct-audit',
      createdAt: Date.parse(job.at) || 0,
      summary: job.productName?.trim() || taskRow?.summary || '商品名称暂不可用',
      status,
      confirmationStatus: job.status === 'published' ? 'confirmed' : undefined,
      statusLabel: job.status === 'published' ? '已发布' : job.status === 'attempting' ? '进行中' : job.status === 'unknown' ? '结果未知' : job.status === 'action_required' ? '需处理' : '失败',
      statusTone: job.status === 'published' ? 'ok' : job.status === 'attempting' ? 'accent' : job.status === 'unknown' || job.status === 'action_required' ? 'warn' : 'error',
      idempotencyKey: job.idempotencyKey,
      itemId: job.itemId,
      itemUrl: job.status === 'published' ? publishItemUrl(job.itemId) : undefined,
    }
    if (taskRow) Object.assign(taskRow, auditRow)
    else rows.push(auditRow)
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}

export function filterPublishHistory(rows: PublishHistoryRow[], keyword: string, filter: string): PublishHistoryRow[] {
  const query = keyword.trim().toLocaleLowerCase()
  return rows.filter((row) => {
    if (query && !`${row.summary} ${row.id} ${row.itemId || ''}`.toLocaleLowerCase().includes(query)) return false
    if (filter === 'all') return true
    if (filter === 'running') return row.status === 'running' || row.status === 'pending'
    if (filter === 'review') return row.status === 'waiting_confirmation'
    if (filter === 'published') return row.status === 'completed'
    if (filter === 'failed') return row.status === 'failed' || row.status === 'cancelled'
    if (filter === 'unknown') return row.status === 'unknown'
    return false
  })
}
