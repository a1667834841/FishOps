/**
 * 发布中心格式化与展示辅助函数（P8）。
 *
 * 纯逻辑函数，在 Node 与浏览器均可测试运行。
 */

import type {
  Product,
  PublishManualConfirmationStatus,
  PublishSubmitResult,
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
 * 校验来源商品或发布草稿是否具备最基本的发布要素：
 * - 飞书素材：必须具备有效的 recordId 与标题，绝不因缺少 itemId 而拦截；
 * - 本地/自营商品：具备有效 itemId 与标题。
 */
export function validateProductForPublish(product: (Partial<Product> & { recordId?: string }) | null | undefined): {
  valid: boolean
  error?: string
} {
  if (!product) {
    return { valid: false, error: '请先选择需要发布的商品' }
  }
  const hasRecordId = typeof product.recordId === 'string' && product.recordId.trim().length > 0
  const hasItemId = typeof product.itemId === 'string' && product.itemId.trim().length > 0

  if (!hasItemId && !hasRecordId) {
    return { valid: false, error: '商品缺少有效 ID (itemId)' }
  }
  const hasDesc = Boolean(
    (typeof product.desc === 'string' && product.desc.trim().length > 0) ||
    (typeof product.title === 'string' && product.title.trim().length > 0)
  )
  if (!hasDesc) {
    return { valid: false, error: '商品缺少描述' }
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
  return '商品名称暂不可用'
}

/**
 * 确认发布后是否允许自动关闭确认弹窗。
 *
 * 唯一允许自动关闭的条件：后台返回 `outcome === 'submitted'`
 * （已由闲鱼官方「我的商品库」确认真实新增，或既有可复用等待任务的确定性成功）。
 *
 * 其余一切情况都必须保持弹窗打开，绝不自动关闭伪装成功：
 * - `failed` / 链路中断（executeConfirmedPublish 返回 null）：展示准确业务失败原因，供用户修正后重试；
 * - `unknown`：结果未知且已被后台锁定，展示锁定状态，允许用户自行关闭后前往官方核实；
 * - 异常（catch 后仍返回 null）：同样不得关闭，避免“弹窗消失 === 发布成功”的误判。
 */
export function shouldAutoCloseConfirmModal(
  res: Pick<PublishSubmitResult, 'outcome'> | null | undefined,
): boolean {
  return res?.outcome === 'submitted'
}

export interface PublishItemInput {
  title?: string
  desc?: string
  price?: number | string
  priceNumber?: number
  originalPrice?: number | string
  originalPriceNumber?: number
  coverUrl?: string
  imageUrls?: string[]
  images?: string[]
}

export interface PublishCustomRuleInput {
  priceMultiplier?: number
  priceMarkup?: number
  titlePrefix?: string
  titleSuffix?: string
  descPrefix?: string
  descSuffix?: string
}

export interface FinalPublishItem {
  title: string
  desc: string
  price: number
  originalPrice: number
  coverUrl: string
  images: string[]
}

/**
 * Unicode emoji / 表情符号匹配（安全 pure 工具内部使用）。
 *
 * 使用 Unicode 属性 `Extended_Pictographic`（图形类 emoji）叠加 emoji 修饰符、
 * 变体选择符（FE0E/FE0F）、零宽连接符（ZWJ）、组合键帽（20E3）与区域指示符
 * （1F1E6-1F1FF，国旗），既覆盖常见 emoji 与组合序列，又**不误伤**中文、数字与
 * 常规标点（如“【】！？、《》”，它们不具备图形类 emoji 属性）。
 */
const UNICODE_EMOJI_PATTERN =
  /\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\u{FE0E}\u{FE0F}\u{200D}\u{20E3}\u{1F1E6}-\u{1F1FF}]/u

/** 判断文本是否含 Unicode emoji / 表情符号（保留中文、数字与标点）。 */
export function containsUnicodeEmoji(text: string | null | undefined): boolean {
  if (!text) return false
  return UNICODE_EMOJI_PATTERN.test(String(text))
}

/**
 * 清理文本中的 Unicode emoji / 表情符号，保留中文、数字与标点。
 *
 * 纯函数、无副作用。用到发布标题 / 描述上，使字数截断前先去除 emoji，
 * 并保证“预览（preview）=== 实际发送（send）”一致。
 */
export function stripUnicodeEmoji(text: string | null | undefined): string {
  if (text === null || text === undefined || text === '') return ''
  return String(text).replace(
    new RegExp(UNICODE_EMOJI_PATTERN.source, 'gu'),
    '',
  )
}

/**
 * 统一纯函数：计算最终发布内容（供 PublishPage 预览与 PublishController 填表 override 严格共用）。
 *
 * 核心规则与业务收敛：
 * 1. 封面与多图同步：以 images[0] 为唯一封面，若修改封面同步替换 images[0]，去重去空且不重复保留旧封面；
 * 2. 标题与描述前后缀：统一按规则拼接并分别做 60 字与 1000 字截断；
 * 3. 价格计算：编辑价格明确作为基准乘 mult + markup，保留 2 位小数（最小 0.01）；
 * 4. 原价计算：以编辑值或最终售价 * 5 回退，且最终原价不得小于最终售价（Math.max(price, orig)）；
 * 5. 所见即所发：前端 preview 与实际填表 override 必须完全共用该函数计算值，后端直接接收最终计算值，绝无双重加价或前后缀吞并；
 * 6. emoji 安全清理：标题与描述统一清理 Unicode emoji / 表情符号（保留中文、数字与标点），
 *    避免官方校验“商品描述不能包含emoji”而导致真实发布失败；清理在拼接后、截断前进行。
 */
export function computeFinalPublishItem(
  input: PublishItemInput | null | undefined,
  rule?: PublishCustomRuleInput | null,
): FinalPublishItem {
  if (!input) {
    return {
      title: '',
      desc: '',
      price: 0,
      originalPrice: 0,
      coverUrl: '',
      images: [],
    }
  }

  // 1. 多图与封面同步（以首图为封面，支持 imageUrls 与 images，去空去重；删除首图后不复活旧封面）
  const rawList = Array.isArray(input.imageUrls)
    ? input.imageUrls
    : Array.isArray(input.images)
      ? input.images
      : []

  const validUrls: string[] = []
  for (const url of rawList) {
    const trimmed = typeof url === 'string' ? url.trim() : ''
    if (trimmed && !validUrls.includes(trimmed)) {
      validUrls.push(trimmed)
    }
  }

  const explicitCover = typeof input.coverUrl === 'string' ? input.coverUrl.trim() : ''
  let coverUrl = ''
  let images: string[] = []

  if (explicitCover && validUrls.includes(explicitCover)) {
    // 封面已在列表中，将其置为首位（不重复保留旧封面）
    images = [explicitCover, ...validUrls.filter((u) => u !== explicitCover)]
    coverUrl = explicitCover
  } else if (validUrls.length > 0) {
    // 列表非空，以列表首项为封面
    images = validUrls
    coverUrl = validUrls[0]
  } else if (explicitCover) {
    images = [explicitCover]
    coverUrl = explicitCover
  }

  // 2. 描述与标题处理（描述为主，拼接后统一清理 emoji，再截断）
  const rawDesc = (input.desc !== undefined && input.desc !== null ? String(input.desc) : input.title || '').trim()
  const descPrefix = rule?.descPrefix || ''
  const descSuffix = rule?.descSuffix || ''
  const desc = stripUnicodeEmoji(`${descPrefix}${rawDesc}${descSuffix}`).slice(0, 1000)

  const rawTitle = (input.title || '').trim()
  const titlePrefix = rule?.titlePrefix || ''
  const titleSuffix = rule?.titleSuffix || ''
  const title = rawTitle
    ? stripUnicodeEmoji(`${titlePrefix}${rawTitle}${titleSuffix}`).slice(0, 60)
    : desc

  // 4. 价格计算（编辑价格明确作为基准乘 mult + markup）
  const basePrice =
    typeof input.priceNumber === 'number' && Number.isFinite(input.priceNumber) && input.priceNumber > 0
      ? input.priceNumber
      : typeof input.price === 'number' && Number.isFinite(input.price)
        ? input.price
        : typeof input.price === 'string'
          ? parseFloat(input.price.replace(/[^\d.]/g, '')) || 0
          : 0
  const mult = typeof rule?.priceMultiplier === 'number' && Number.isFinite(rule.priceMultiplier) ? rule.priceMultiplier : 1.0
  const markup = typeof rule?.priceMarkup === 'number' && Number.isFinite(rule.priceMarkup) ? rule.priceMarkup : 0
  const rawCalculated = basePrice * mult + markup
  const price = rawCalculated > 0 ? Number(Math.max(0.01, rawCalculated).toFixed(2)) : 0

  // 5. 原价计算（以编辑值或最终售价 * 5 回退，且原价不得小于售价）
  const userOriginalPrice =
    typeof input.originalPriceNumber === 'number' && Number.isFinite(input.originalPriceNumber) && input.originalPriceNumber > 0
      ? input.originalPriceNumber
      : typeof input.originalPrice === 'number' && Number.isFinite(input.originalPrice) && input.originalPrice > 0
        ? input.originalPrice
        : typeof input.originalPrice === 'string'
          ? parseFloat(input.originalPrice.replace(/[^\d.]/g, '')) || 0
          : 0

  let candidateOrig = userOriginalPrice > 0 ? userOriginalPrice : Number((price * 5).toFixed(2))
  if (price > 0 && candidateOrig < price) {
    candidateOrig = price
  }
  const originalPrice = candidateOrig > 0 ? Number(candidateOrig.toFixed(2)) : 0

  return {
    title,
    desc,
    price,
    originalPrice,
    coverUrl,
    images,
  }
}
