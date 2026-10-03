/**
 * 发布中心格式化与展示辅助函数（P8）。
 *
 * 纯逻辑函数，在 Node 与浏览器均可测试运行。
 */

import type {
  Product,
  PublishManualConfirmationStatus,
  PublishTask,
  PublishTaskStatus,
} from '../contracts'
import type { StatusTone } from '../capture/capture-format'

/** 任务状态标签视图 */
export interface TaskStatusView {
  label: string
  tone: StatusTone
  description: string
}

/** 提交与确认状态标签视图 */
export interface ManualConfirmationView {
  label: string
  tone: StatusTone
  description: string
}

const PUBLISH_STATUS_MAP: Record<PublishTaskStatus, TaskStatusView> = {
  pending: {
    label: '待准备',
    tone: 'neutral',
    description: '任务已创建，等待开始下载图片并填充表单',
  },
  running: {
    label: '填表中',
    tone: 'accent',
    description: '正在后台标签页中校验图片并填充表单字段',
  },
  paused: {
    label: '已挂起',
    tone: 'warn',
    description: '任务已挂起，等待人工核实续跑',
  },
  waiting_confirmation: {
    label: '待发布',
    tone: 'warn',
    description: '表单已成功自动填充，请点击“发布”按钮提交',
  },
  completed: {
    label: '已发布',
    tone: 'ok',
    description: '商品已成功提交并发布完成',
  },
  failed: {
    label: '填表失败',
    tone: 'error',
    description: '表单填充或图片准备遇到异常，请检查原因',
  },
  cancelled: {
    label: '已放弃',
    tone: 'neutral',
    description: '操作员已放弃本次发布任务',
  },
}

const CONFIRMATION_STATUS_MAP: Record<PublishManualConfirmationStatus, ManualConfirmationView> = {
  unconfirmed: {
    label: '未提交',
    tone: 'neutral',
    description: '表单尚未填充完成',
  },
  waiting_review: {
    label: '待提交/准备发布',
    tone: 'warn',
    description: '表单已就绪，准备发布',
  },
  confirmed: {
    label: '已提交',
    tone: 'ok',
    description: '商品发布已成功提交',
  },
  rejected: {
    label: '已放弃',
    tone: 'neutral',
    description: '已放弃本次发布',
  },
}

/**
 * 获取任务流转状态展示视图
 */
export function formatPublishTaskStatus(status: PublishTaskStatus): TaskStatusView {
  return (
    PUBLISH_STATUS_MAP[status] ?? {
      label: String(status),
      tone: 'neutral',
      description: '未知任务状态',
    }
  )
}

/**
 * 获取提交与确认状态展示视图
 */
export function formatConfirmationStatus(
  status: PublishManualConfirmationStatus | undefined,
): ManualConfirmationView {
  if (!status) {
    return CONFIRMATION_STATUS_MAP.unconfirmed
  }
  return (
    CONFIRMATION_STATUS_MAP[status] ?? {
      label: String(status),
      tone: 'neutral',
      description: '未知确认状态',
    }
  )
}

/**
 * 格式化价格数字为规范人民币格式（如 ¥199.00）
 */
export function formatRMB(price: number | string | undefined): string {
  if (price === undefined || price === null || price === '') return '¥0.00'
  const num = typeof price === 'number' ? price : Number.parseFloat(String(price).replace(/[^\d.]/g, ''))
  if (Number.isNaN(num)) return '¥0.00'
  return `¥${num.toFixed(2)}`
}

/**
 * 校验来源商品是否具备最基本的发布要素（至少有 itemId 与标题）
 */
export function validateProductForPublish(product: Product | null | undefined): {
  valid: boolean
  error?: string
} {
  if (!product) {
    return { valid: false, error: '请先选择需要发布的商品' }
  }
  if (!product.itemId || product.itemId.trim().length === 0) {
    return { valid: false, error: '商品缺少有效 ID (itemId)' }
  }
  if (!product.title || product.title.trim().length === 0) {
    return { valid: false, error: '商品缺少标题' }
  }
  return { valid: true }
}

/**
 * 提取发布任务的关键摘要文本
 */
export function getPublishTaskSummary(task: PublishTask): string {
  const item = task.result?.item
  if (item) {
    return `${item.title} (${formatRMB(item.price)})`
  }
  const snap = task.meta?.sourceProductSnapshot
  if (snap) {
    return `${snap.title} (${formatRMB(snap.price)})`
  }
  return `商品 ID: ${task.payload?.itemId || task.id}`
}
