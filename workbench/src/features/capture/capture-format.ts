/**
 * 采集页的表单校验与任务展示推导（纯函数，可在 Node 下测试）。
 *
 * 约束：所有进度、页数、统计都只来自后台返回的任务快照；
 * 缺少的数据返回 null，由界面如实显示「暂无」，绝不推算或补一个看起来合理的数字。
 */
import type { CapturePayload, CaptureStats, Task, TaskStatus } from '../contracts'
import { describeTaskProblem, type ErrorView } from '../shared/error-format'

/** 表单原始值：数字输入统一保存为字符串，避免 `''` 与 `0` 混淆。 */
export interface CaptureFormValues {
  keyword?: string
  keywords?: string[]
  keywordInput?: string
  startPage: string
  pages: string
  rowsPerPage: string
  minWantCnt: string
  minPrice: string
  maxPrice: string
  baseIntervalSec?: string
  randomIntervalSec?: string
  baseIntervalMs?: string
  randomIntervalMs?: string
  onlyFreeShip: boolean
  fetchDetail: boolean
}

/** 表单上限（防止误填超大值触发过量请求；后台只要求 >= 1）。 */
export const CAPTURE_LIMITS = {
  keywordMaxLength: 60,
  maxKeywords: 20,
  maxPages: 50,
  maxRowsPerPage: 100,
  defaultIntervalSec: 0.5,
  defaultIntervalMs: 500,
} as const

export function defaultCaptureForm(): CaptureFormValues {
  return {
    keyword: '',
    keywords: [],
    keywordInput: '',
    startPage: '1',
    pages: '1',
    rowsPerPage: '30',
    minWantCnt: '',
    minPrice: '',
    maxPrice: '',
    baseIntervalSec: '0.5',
    randomIntervalSec: '0.5',
    onlyFreeShip: false,
    // 详情请求耗时且会增加平台调用量，用户需要主动勾选。
    fetchDetail: false,
  }
}

/**
 * 解析并规范化关键词标签：
 * - 支持回车、中英文逗号（, ，）、顿号（、）、换行分隔
 * - 保留词内空格，去除首尾空白
 * - 对 existingTags 与新增输入统一校验
 * - 去空去重，duplicate 先判重再判数量
 * - 单词最多 60 字，最多 20 个词
 */
export function parseKeywordTags(
  rawInput: string | readonly string[],
  existingTags: readonly string[] = [],
): { tags: string[]; error?: string } {
  const inputs: string[] = []
  if (Array.isArray(rawInput)) {
    inputs.push(...rawInput)
  } else if (typeof rawInput === 'string') {
    const parts = rawInput.split(/[,，、\r\n]+/)
    inputs.push(...parts)
  }

  const allItems: string[] = [...existingTags, ...inputs]
  const tagSet = new Set<string>()
  let error: string | undefined

  for (const item of allItems) {
    const trimmed = item.trim()
    if (!trimmed) continue
    if (trimmed.length > CAPTURE_LIMITS.keywordMaxLength) {
      error = `关键词“${trimmed.slice(0, 10)}…”超过 ${CAPTURE_LIMITS.keywordMaxLength} 个字符`
      continue
    }
    // 先判重，避免重复词误占配额
    if (tagSet.has(trimmed)) {
      continue
    }
    // 再判数量上限
    if (tagSet.size >= CAPTURE_LIMITS.maxKeywords) {
      error = `关键词最多支持 ${CAPTURE_LIMITS.maxKeywords} 个`
      break
    }
    tagSet.add(trimmed)
  }

  return {
    tags: Array.from(tagSet),
    ...(error ? { error } : {}),
  }
}

export type CaptureFormField = keyof CaptureFormValues
export type CaptureFormErrors = Partial<Record<CaptureFormField, string>>

export type CaptureBuildResult =
  | { ok: true; payload: CapturePayload }
  | { ok: false; errors: CaptureFormErrors }

function parseInteger(raw: string, min: number, max: number, label: string): { value?: number; error?: string } {
  const text = raw.trim()
  if (!/^\d+$/.test(text)) return { error: `${label}需要是 ${min} 到 ${max} 之间的整数` }
  const value = Number(text)
  if (value < min || value > max) return { error: `${label}需要在 ${min} 到 ${max} 之间` }
  return { value }
}

function parseOptionalNumber(raw: string, label: string, integer: boolean): { value?: number; error?: string } {
  const text = raw.trim()
  if (text === '') return {}
  const pattern = integer ? /^\d+$/ : /^\d+(\.\d{1,2})?$/
  if (!pattern.test(text)) return { error: `${label}需要是不小于 0 的${integer ? '整数' : '数字（最多两位小数）'}` }
  const value = Number(text)
  if (!Number.isFinite(value) || value > 99999999) return { error: `${label}数值过大` }
  return { value }
}

function parseIntervalSeconds(
  rawSec: string | undefined,
  rawMs: string | undefined,
  label: string,
  defaultSec: number,
): { valueMs?: number; error?: string } {
  // 如果显式传了 ms，优先按毫秒解析（便于底层与单测直接指定毫秒）
  if (rawMs !== undefined && rawMs.trim() !== '') {
    const text = rawMs.trim()
    if (!/^\d+(\.\d+)?$/.test(text)) {
      return { error: `${label}需要是不小于 0 的数字` }
    }
    const val = Number(text)
    if (!Number.isFinite(val) || val < 0) {
      return { error: `${label}需要是非负有限数字` }
    }
    if (val > 99999999) {
      return { error: `${label}数值过大` }
    }
    return { valueMs: Math.round(val) }
  }

  // 其次按秒解析（UI 表单主要口径）
  if (rawSec !== undefined && rawSec.trim() !== '') {
    const text = rawSec.trim()
    if (!/^\d+(\.\d+)?$/.test(text)) {
      return { error: `${label}需要是不小于 0 的秒数` }
    }
    const val = Number(text)
    if (!Number.isFinite(val) || val < 0) {
      return { error: `${label}需要是非负有限数字` }
    }
    if (val > 99999) {
      return { error: `${label}数值过大` }
    }
    return { valueMs: Math.round(val * 1000) }
  }

  return { valueMs: Math.round(defaultSec * 1000) }
}

export type BatchCaptureBuildResult =
  | { ok: true; payloads: CapturePayload[]; keywords: string[] }
  | { ok: false; errors: CaptureFormErrors }

/** 校验表单并生成 `CAPTURE_CREATE` 的负载；不合法时返回逐字段错误。 */
export function buildCapturePayload(values: CaptureFormValues): CaptureBuildResult {
  const errors: CaptureFormErrors = {}

  let keyword = values.keyword?.trim() || ''
  if (!keyword && values.keywords && values.keywords.length > 0) {
    keyword = values.keywords[0].trim()
  } else if (!keyword && values.keywordInput) {
    keyword = values.keywordInput.trim()
  }

  if (!keyword) errors.keyword = '请输入搜索关键词'
  else if (keyword.length > CAPTURE_LIMITS.keywordMaxLength) {
    errors.keyword = `关键词不能超过 ${CAPTURE_LIMITS.keywordMaxLength} 个字符`
  }

  const startPage = parseInteger(values.startPage, 1, 9999, '起始页')
  if (startPage.error) errors.startPage = startPage.error
  const pages = parseInteger(values.pages, 1, CAPTURE_LIMITS.maxPages, '采集页数')
  if (pages.error) errors.pages = pages.error
  const rows = parseInteger(values.rowsPerPage, 1, CAPTURE_LIMITS.maxRowsPerPage, '每页数量')
  if (rows.error) errors.rowsPerPage = rows.error

  const minWant = parseOptionalNumber(values.minWantCnt, '最小想要人数', true)
  if (minWant.error) errors.minWantCnt = minWant.error
  const minPrice = parseOptionalNumber(values.minPrice, '最低价格', false)
  if (minPrice.error) errors.minPrice = minPrice.error
  const maxPrice = parseOptionalNumber(values.maxPrice, '最高价格', false)
  if (maxPrice.error) errors.maxPrice = maxPrice.error
  if (minPrice.value !== undefined && maxPrice.value !== undefined && minPrice.value > maxPrice.value) {
    errors.maxPrice = '最高价格不能低于最低价格'
  }

  const baseInterval = parseIntervalSeconds(
    values.baseIntervalSec,
    values.baseIntervalMs,
    '基础间隔',
    CAPTURE_LIMITS.defaultIntervalSec,
  )
  if (baseInterval.error) {
    if (values.baseIntervalMs !== undefined) errors.baseIntervalMs = baseInterval.error
    else errors.baseIntervalSec = baseInterval.error
  }

  const randomInterval = parseIntervalSeconds(
    values.randomIntervalSec,
    values.randomIntervalMs,
    '随机增量',
    CAPTURE_LIMITS.defaultIntervalSec,
  )
  if (randomInterval.error) {
    if (values.randomIntervalMs !== undefined) errors.randomIntervalMs = randomInterval.error
    else errors.randomIntervalSec = randomInterval.error
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const filter: NonNullable<CapturePayload['filter']> = {}
  if (minWant.value !== undefined && minWant.value > 0) filter.minWantCnt = minWant.value
  if (minPrice.value !== undefined && minPrice.value > 0) filter.minPrice = minPrice.value
  if (maxPrice.value !== undefined && maxPrice.value > 0) filter.maxPrice = maxPrice.value
  if (values.onlyFreeShip) filter.onlyFreeShip = true

  const baseMs = baseInterval.valueMs ?? CAPTURE_LIMITS.defaultIntervalMs
  const randMs = randomInterval.valueMs ?? CAPTURE_LIMITS.defaultIntervalMs

  const payload: CapturePayload = {
    keyword,
    startPage: startPage.value as number,
    pages: pages.value as number,
    rowsPerPage: rows.value as number,
    fetchDetail: values.fetchDetail,
    minIntervalMs: baseMs,
    intervalJitterMs: randMs,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
  }
  return { ok: true, payload }
}

/** 校验批量采集表单并为所有关键词生成 `CAPTURE_CREATE` 负载。 */
export function buildBatchCapturePayloads(values: CaptureFormValues): BatchCaptureBuildResult {
  const errors: CaptureFormErrors = {}

  // 合并已确认标签与当前未回车的输入
  const pendingInput = values.keywordInput ? [values.keywordInput] : []
  const parsed = parseKeywordTags(pendingInput, values.keywords ?? (values.keyword ? [values.keyword] : []))

  if (parsed.error) {
    errors.keyword = parsed.error
  } else if (parsed.tags.length === 0) {
    errors.keyword = '请输入搜索关键词'
  } else if (parsed.tags.length > CAPTURE_LIMITS.maxKeywords) {
    errors.keyword = `关键词最多支持 ${CAPTURE_LIMITS.maxKeywords} 个`
  }

  const startPage = parseInteger(values.startPage, 1, 9999, '起始页')
  if (startPage.error) errors.startPage = startPage.error
  const pages = parseInteger(values.pages, 1, CAPTURE_LIMITS.maxPages, '采集页数')
  if (pages.error) errors.pages = pages.error
  const rows = parseInteger(values.rowsPerPage, 1, CAPTURE_LIMITS.maxRowsPerPage, '每页数量')
  if (rows.error) errors.rowsPerPage = rows.error

  const minWant = parseOptionalNumber(values.minWantCnt, '最小想要人数', true)
  if (minWant.error) errors.minWantCnt = minWant.error
  const minPrice = parseOptionalNumber(values.minPrice, '最低价格', false)
  if (minPrice.error) errors.minPrice = minPrice.error
  const maxPrice = parseOptionalNumber(values.maxPrice, '最高价格', false)
  if (maxPrice.error) errors.maxPrice = maxPrice.error
  if (minPrice.value !== undefined && maxPrice.value !== undefined && minPrice.value > maxPrice.value) {
    errors.maxPrice = '最高价格不能低于最低价格'
  }

  const baseInterval = parseIntervalSeconds(
    values.baseIntervalSec,
    values.baseIntervalMs,
    '基础间隔',
    CAPTURE_LIMITS.defaultIntervalSec,
  )
  if (baseInterval.error) {
    if (values.baseIntervalMs !== undefined) errors.baseIntervalMs = baseInterval.error
    else errors.baseIntervalSec = baseInterval.error
  }

  const randomInterval = parseIntervalSeconds(
    values.randomIntervalSec,
    values.randomIntervalMs,
    '随机增量',
    CAPTURE_LIMITS.defaultIntervalSec,
  )
  if (randomInterval.error) {
    if (values.randomIntervalMs !== undefined) errors.randomIntervalMs = randomInterval.error
    else errors.randomIntervalSec = randomInterval.error
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }

  const filter: NonNullable<CapturePayload['filter']> = {}
  if (minWant.value !== undefined && minWant.value > 0) filter.minWantCnt = minWant.value
  if (minPrice.value !== undefined && minPrice.value > 0) filter.minPrice = minPrice.value
  if (maxPrice.value !== undefined && maxPrice.value > 0) filter.maxPrice = maxPrice.value
  if (values.onlyFreeShip) filter.onlyFreeShip = true

  const baseMs = baseInterval.valueMs ?? CAPTURE_LIMITS.defaultIntervalMs
  const randMs = randomInterval.valueMs ?? CAPTURE_LIMITS.defaultIntervalMs

  const payloads: CapturePayload[] = parsed.tags.map((kw) => ({
    keyword: kw,
    startPage: startPage.value as number,
    pages: pages.value as number,
    rowsPerPage: rows.value as number,
    fetchDetail: values.fetchDetail,
    minIntervalMs: baseMs,
    intervalJitterMs: randMs,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
  }))

  return { ok: true, payloads, keywords: parsed.tags }
}

// ---------------- 任务展示 ----------------

export type StatusTone = 'neutral' | 'accent' | 'ok' | 'info' | 'warn' | 'error'

const STATUS_VIEW: Record<TaskStatus, { label: string; tone: StatusTone }> = {
  pending: { label: '等待开始', tone: 'neutral' },
  running: { label: '采集中', tone: 'accent' },
  paused: { label: '已暂停', tone: 'warn' },
  completed: { label: '已完成', tone: 'ok' },
  failed: { label: '失败', tone: 'error' },
  cancelled: { label: '已取消', tone: 'neutral' },
}

export function taskStatusView(status: TaskStatus): { label: string; tone: StatusTone } {
  return STATUS_VIEW[status] ?? { label: String(status), tone: 'neutral' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readStats(value: unknown): CaptureStats | null {
  if (!isRecord(value)) return null
  const fetched = num(value['fetched'])
  const valid = num(value['valid'])
  const filtered = num(value['filtered'])
  const duplicates = num(value['duplicates'])
  const failed = num(value['failed'])
  const stored = num(value['stored'])
  if (fetched === null || valid === null || filtered === null || duplicates === null || failed === null) return null
  return { fetched, valid, filtered, duplicates, failed, ...(stored === null ? {} : { stored }) }
}

/** 任务的页面展示模型。 */
export interface CaptureTaskView {
  id: string
  keyword: string
  status: TaskStatus
  statusLabel: string
  tone: StatusTone
  /** 后台上报的进度（0-100）；pending 时为 0。 */
  progress: number
  /** 已完成页数 / 总页数；后台尚未上报断点时为 null。 */
  pagesCompleted: number | null
  totalPages: number | null
  /** 下一待采集页（断点）。 */
  nextPage: number | null
  stats: CaptureStats | null
  /** 失败 / 暂停时的问题说明。 */
  problem: ErrorView | null
  /** 重启恢复等补充说明。 */
  note: string | null
  canPause: boolean
  canResume: boolean
  canCancel: boolean
  fetchDetail: boolean
  createdAt: number
  startedAt: number | null
  endedAt: number | null
}

/** 把后台任务快照转换为展示模型。 */
export function toCaptureTaskView(task: Task): CaptureTaskView {
  const payload = isRecord(task.payload) ? task.payload : {}
  const meta = isRecord(task.meta) ? task.meta : {}
  const checkpoint = isRecord(meta['capture']) ? meta['capture'] : null
  const result = isRecord(task.result) ? task.result : null

  const keyword = str(checkpoint?.['keyword']) || str(payload['keyword'])

  const payloadPages = num(payload['pages'])
  const totalPages = num(checkpoint?.['totalPages']) ?? payloadPages
  const pagesCompleted = num(checkpoint?.['pagesCompleted']) ?? num(result?.['pagesCompleted'])
  const nextPage = num(checkpoint?.['nextPage']) ?? num(result?.['nextPage'])

  const stats = readStats(checkpoint?.['stats']) ?? readStats(result)

  let problem: ErrorView | null = null
  let note: string | null = null
  if (task.status === 'failed') {
    problem = describeTaskProblem(task.error ?? '')
  } else if (task.status === 'paused') {
    // meta 会跨状态合并保留，因此 pauseReason 只在当前确为 paused 时才有意义。
    const pauseReason = str(meta['pauseReason'])
    const recovery = str(meta['recoveryNote'])
    if (pauseReason) problem = describeTaskProblem(pauseReason)
    if (recovery && recovery !== pauseReason) note = recovery
  }

  if (task.status === 'completed' && isRecord(result?.['feishuSync'])) {
    const sync = result['feishuSync']
    note = `已同步到飞书：新增 ${num(sync['createdCount']) ?? 0} 条，已存在跳过 ${num(sync['skippedCount']) ?? 0} 条`
  }
  const status = task.status
  return {
    id: task.id,
    keyword,
    status,
    statusLabel: taskStatusView(status).label,
    tone: taskStatusView(status).tone,
    progress: Number.isFinite(task.progress) ? Math.max(0, Math.min(100, task.progress)) : 0,
    pagesCompleted,
    totalPages,
    nextPage,
    stats,
    problem,
    note,
    canPause: status === 'running',
    canResume: status === 'paused',
    canCancel: status === 'pending' || status === 'running' || status === 'paused',
    fetchDetail: payload['fetchDetail'] === true,
    createdAt: task.createdAt,
    startedAt: typeof task.startedAt === 'number' ? task.startedAt : null,
    endedAt: typeof task.endedAt === 'number' ? task.endedAt : null,
  }
}

/**
 * 格式化任务耗时：
 * - 只有 startedAt 缺失才表示未启动，显示「—」（包括刚创建的 pending 任务或从未启动就被取消的任务）
 * - 恢复排队中（pending 且已有 startedAt）或运行中（running / paused）基于当前时间戳持续更新计时
 * - 已结束（completed / failed / cancelled 且已启动过）展示实际运行耗时
 */
export function formatTaskDuration(view: CaptureTaskView, now: number = Date.now()): string {
  const startTime = view.startedAt
  if (startTime === null || !Number.isFinite(startTime)) {
    return '—'
  }
  const isFinished = view.status === 'completed' || view.status === 'failed' || view.status === 'cancelled'
  if (isFinished && (view.endedAt === null || !Number.isFinite(view.endedAt))) {
    return '—'
  }
  const endTime = isFinished ? view.endedAt! : now
  if (!Number.isFinite(endTime) || endTime < startTime) {
    return '0s'
  }
  const elapsedMs = Math.max(0, endTime - startTime)
  const seconds = Math.floor(elapsedMs / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainingSecs = seconds % 60
  if (minutes < 60) {
    return `${minutes}m ${remainingSecs}s`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMins = minutes % 60
  return `${hours}h ${remainingMins}m`
}

/**
 * 格式化入库有效商品数量：
 * - 只有未启动（startedAt 缺失）或无统计/缺失 stored 字段时显示「—」
 * - 若任务已启动过且处于 pending 恢复排队状态，已有 stored 统计则如实展示
 */
export function formatTaskValidCount(view: CaptureTaskView): string {
  if (view.startedAt === null || !Number.isFinite(view.startedAt) || !view.stats || typeof view.stats.stored !== 'number') {
    return '—'
  }
  return String(view.stats.stored)
}

/** 默认选中的任务：优先进行中 / 已暂停的最新任务，其次是最新任务。 */
export function pickDefaultTask(tasks: readonly Task[]): string | null {
  if (tasks.length === 0) return null
  const active = tasks.find((task) => task.status === 'running' || task.status === 'paused' || task.status === 'pending')
  return (active ?? tasks[0]).id
}

/** 任务历史分页信息。 */
export interface TaskPagingInfo {
  total: number
  page: number
  pageSize: number
  totalPages: number
  hasPrev: boolean
  hasNext: boolean
  startIndex: number
  endIndex: number
}

/**
 * 任务列表分页切片纯函数。
 * 针对历史列表进行安全翻页，避免越界。
 */
export function paginateTasks<T>(
  items: readonly T[],
  page: number,
  pageSize: number,
): {
  pagedItems: T[]
  paging: TaskPagingInfo
} {
  const total = items.length
  const validPageSize = Math.max(1, pageSize)
  const totalPages = Math.max(1, Math.ceil(total / validPageSize))
  const validPage = Math.min(Math.max(1, page), totalPages)
  const startIndex = (validPage - 1) * validPageSize
  const endIndex = Math.min(startIndex + validPageSize, total)
  const pagedItems = items.slice(startIndex, endIndex)
  return {
    pagedItems,
    paging: {
      total,
      page: validPage,
      pageSize: validPageSize,
      totalPages,
      hasPrev: validPage > 1,
      hasNext: validPage < totalPages,
      startIndex,
      endIndex,
    },
  }
}
