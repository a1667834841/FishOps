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
  task?: PublishTask
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
    itemId: task.result?.item?.itemId || task.payload?.itemId,
    task,
  }))

  const taskKeys = new Set(rows.map((row) => row.idempotencyKey).filter((key): key is string => Boolean(key)))
  for (const job of byKey.values()) {
    if (taskKeys.has(job.idempotencyKey)) continue
    const status = job.status === 'published' ? 'completed' : job.status === 'attempting' ? 'running' : job.status === 'unknown' || job.status === 'action_required' ? 'unknown' : 'failed'
    rows.push({
      id: `direct:${job.idempotencyKey}`,
      source: 'direct-audit',
      createdAt: Date.parse(job.at) || 0,
      summary: job.itemId ? `直接发布商品 ID ${job.itemId}` : '直接发布记录',
      status,
      confirmationStatus: job.status === 'published' ? 'confirmed' : undefined,
      statusLabel: job.status === 'published' ? '已发布' : job.status === 'attempting' ? '进行中' : job.status === 'unknown' ? '结果未知' : job.status === 'action_required' ? '需处理' : '失败',
      statusTone: job.status === 'published' ? 'ok' : job.status === 'attempting' ? 'accent' : job.status === 'unknown' || job.status === 'action_required' ? 'warn' : 'error',
      idempotencyKey: job.idempotencyKey,
      itemId: job.itemId,
    })
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
