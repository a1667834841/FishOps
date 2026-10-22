/**
 * 发布诊断时间线的展示映射与安全过滤（纯逻辑，Node / 浏览器均可运行）。
 *
 * 设计边界（与 shared 类型 `PublishDiagnostics` 严格对齐，只读、绝不写回）：
 * 1. **只读消费**：本模块只把后台持久化的 `task.meta.diagnostics` 转换为展示视图，
 *    绝不发任何命令，绝不触发 fill / submit / 重试等隐式副作用；
 * 2. **安全过滤**：即便收到被污染的数据，也只保留白名单字段（阶段 / 状态 / 时间戳 /
 *    耗时 / 结构化 code / 数值计数 / 布尔标记），URL / token / 商品正文等原文一律被丢弃；
 * 3. **缺值不造 fake**：非法或缺字段的记录被丢弃，无记录时明确返回空时间线，
 *    由 UI 提示“无记录”，绝不本地补位推测。
 */

import {
  PUBLISH_DIAG_TIMELINE_LIMIT,
  type PublishDiagEntry,
  type PublishDiagStage,
  type PublishDiagStatus,
  type PublishDiagnostics,
} from '../contracts'
import type { StatusTone } from '../capture/capture-format'

/** 当前支持的诊断结构版本（与后台记录器一致）。 */
export const PUBLISH_DIAG_SCHEMA = 1

/** 阶段 → 中文标签。 */
const STAGE_LABELS: Record<PublishDiagStage, string> = {
  fresh_tab: '新建专属发布页',
  load: '等待页面加载',
  page_check: '页面状态检查',
  fields: '字段填充与回读',
  images: '图片下载与上传',
  form_validation: '表单整体校验',
  baseline: '提交前在售基线',
  submit_dispatch: '派发发布点击',
  official_verify: '官方在售核验',
  result: '本次最终结论',
}

/** 状态 → 中文标签与色调。 */
const STATUS_VIEW: Record<PublishDiagStatus, { label: string; tone: StatusTone }> = {
  started: { label: '进行中', tone: 'accent' },
  ok: { label: '成功', tone: 'ok' },
  failed: { label: '失败', tone: 'error' },
  unknown: { label: '未知', tone: 'warn' },
}

const STAGE_SET: ReadonlySet<string> = new Set(Object.keys(STAGE_LABELS))
const STATUS_SET: ReadonlySet<string> = new Set(Object.keys(STATUS_VIEW))

/** 安全 code：仅接受结构化枚举形态（`^[A-Z][A-Z0-9_]*$`），过滤 URL / 中文原文。 */
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/
/** 安全键名：仅接受英文标识符，过滤被塞入的 URL / 长文 / 中文。 */
const SAFE_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/

/** 计数字段 → 中文标签（未命中的已知安全键回退显示原键）。 */
const COUNTER_LABELS: Record<string, string> = {
  createCalls: '新建标签次数',
  images: '图片数',
  imageCount: '图片数',
  uploadedImages: '已上传图片数',
  fields: '字段数',
  fieldCount: '字段数',
  items: '在售商品数',
  onSaleCount: '在售商品数',
  beforeCount: '提交前在售数',
  afterCount: '提交后在售数',
  polls: '轮询次数',
  pollCount: '轮询次数',
  attempts: '尝试次数',
}

/** 布尔标记 → 中文标签（未命中的已知安全键回退显示原键）。 */
const FLAG_LABELS: Record<string, string> = {
  loggedIn: '已登录',
  captcha: '遇验证码',
  strictPlusOne: '严格 +1',
  reusedTab: '复用已有标签',
  freshTab: '专属新标签',
  formReady: '表单就绪',
  submitted: '已提交',
}

/** 阶段中文标签（未知阶段显示兜底文案，绝不回显原始字符串）。 */
export function formatDiagStage(stage: PublishDiagStage | string): string {
  return STAGE_LABELS[stage as PublishDiagStage] ?? '未知阶段'
}

/** 状态中文标签与色调（未知状态显示中性兜底）。 */
export function formatDiagStatus(status: PublishDiagStatus | string): { label: string; tone: StatusTone } {
  return STATUS_VIEW[status as PublishDiagStatus] ?? { label: '未知', tone: 'neutral' }
}

/** 计数 / 标记的中文标签（未命中回退原键，键本身已是安全英文标识符）。 */
export function formatDiagCounterLabel(key: string): string {
  return COUNTER_LABELS[key] ?? key
}

export function formatDiagFlagLabel(key: string): string {
  return FLAG_LABELS[key] ?? key
}

/** 过滤数值映射：仅保留安全键名 + 有限数值，其余（含 URL / 字符串）一律丢弃。 */
function sanitizeNumberMap(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SAFE_KEY_RE.test(key)) continue
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 过滤布尔映射：仅保留安全键名 + 布尔值。 */
function sanitizeBooleanMap(raw: unknown): Record<string, boolean> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!SAFE_KEY_RE.test(key)) continue
    if (typeof value === 'boolean') {
      out[key] = value
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * 过滤单条诊断记录：严格白名单重建，非法 stage / status / startedAt 直接丢弃。
 * 任何未在白名单内的字段（如被塞入的 rawUrl / token / 标题原文）都不会进入返回值。
 */
export function sanitizePublishDiagEntry(raw: unknown): PublishDiagEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  if (typeof r.stage !== 'string' || !STAGE_SET.has(r.stage)) return null
  if (typeof r.status !== 'string' || !STATUS_SET.has(r.status)) return null
  if (typeof r.startedAt !== 'number' || !Number.isFinite(r.startedAt)) return null

  const entry: PublishDiagEntry = {
    stage: r.stage as PublishDiagStage,
    status: r.status as PublishDiagStatus,
    startedAt: r.startedAt,
  }
  if (typeof r.endedAt === 'number' && Number.isFinite(r.endedAt)) {
    entry.endedAt = r.endedAt
  }
  if (typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs) && r.latencyMs >= 0) {
    entry.latencyMs = r.latencyMs
  }
  if (typeof r.code === 'string' && SAFE_CODE_RE.test(r.code)) {
    entry.code = r.code
  }
  const counters = sanitizeNumberMap(r.counters)
  if (counters) entry.counters = counters
  const flags = sanitizeBooleanMap(r.flags)
  if (flags) entry.flags = flags
  return entry
}

/**
 * 过滤整条诊断时间线：校验 `schema` / `timeline` 形态，逐条安全重建，
 * 并按 {@link PUBLISH_DIAG_TIMELINE_LIMIT} 截断（超出部分累加进 `dropped`）。
 * 非法输入返回 `null`（表示“无记录”，绝不造 fake）。
 */
export function sanitizePublishDiagnostics(raw: unknown): PublishDiagnostics | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.schema !== PUBLISH_DIAG_SCHEMA || !Array.isArray(r.timeline)) return null

  const timeline: PublishDiagEntry[] = []
  for (const item of r.timeline) {
    const entry = sanitizePublishDiagEntry(item)
    if (entry) timeline.push(entry)
  }

  let dropped =
    typeof r.dropped === 'number' && Number.isFinite(r.dropped) && r.dropped > 0
      ? Math.floor(r.dropped)
      : 0
  if (timeline.length > PUBLISH_DIAG_TIMELINE_LIMIT) {
    dropped += timeline.length - PUBLISH_DIAG_TIMELINE_LIMIT
    timeline.splice(0, timeline.length - PUBLISH_DIAG_TIMELINE_LIMIT)
  }

  const updatedAt =
    typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : 0

  return { schema: PUBLISH_DIAG_SCHEMA, timeline, dropped, updatedAt }
}

/** 单条计数的展示视图。 */
export interface PublishDiagCounterView {
  key: string
  label: string
  value: number
}

/** 单条布尔标记的展示视图。 */
export interface PublishDiagFlagView {
  key: string
  label: string
  value: boolean
}

/** 单条诊断记录的中文展示视图（所有文本均由安全字段派生）。 */
export interface PublishDiagEntryView {
  stage: PublishDiagStage
  stageLabel: string
  status: PublishDiagStatus
  statusLabel: string
  statusTone: StatusTone
  startedAt: number
  startedAtText: string
  endedAtText: string
  latencyMs: number | null
  latencyText: string
  code: string
  counters: PublishDiagCounterView[]
  flags: PublishDiagFlagView[]
}

/** 整条时间线的展示视图。 */
export interface PublishDiagnosticsView {
  schema: number
  /** 是否存在可展示的记录（空时间线 / 无诊断时为 false，UI 据此提示“无记录”）。 */
  hasRecords: boolean
  timeline: PublishDiagEntryView[]
  dropped: number
  updatedAtText: string
}

export interface PublishDiagViewOptions {
  /** 时间戳格式化函数（页面注入 formatFullTime；缺省用本地时间字符串）。 */
  formatTime?: (ms: number) => string
}

function defaultFormatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`
}

/** 把单条已通过校验的记录转换为中文展示视图。 */
function toEntryView(
  entry: PublishDiagEntry,
  formatTime: (ms: number) => string,
): PublishDiagEntryView {
  const statusView = formatDiagStatus(entry.status)
  const latencyMs =
    typeof entry.latencyMs === 'number' && Number.isFinite(entry.latencyMs) ? entry.latencyMs : null
  const counters: PublishDiagCounterView[] = entry.counters
    ? Object.entries(entry.counters).map(([key, value]) => ({
        key,
        label: formatDiagCounterLabel(key),
        value,
      }))
    : []
  const flags: PublishDiagFlagView[] = entry.flags
    ? Object.entries(entry.flags).map(([key, value]) => ({
        key,
        label: formatDiagFlagLabel(key),
        value,
      }))
    : []

  return {
    stage: entry.stage,
    stageLabel: formatDiagStage(entry.stage),
    status: entry.status,
    statusLabel: statusView.label,
    statusTone: statusView.tone,
    startedAt: entry.startedAt,
    startedAtText: formatTime(entry.startedAt),
    endedAtText:
      typeof entry.endedAt === 'number' && Number.isFinite(entry.endedAt)
        ? formatTime(entry.endedAt)
        : '',
    latencyMs,
    latencyText: latencyMs === null ? '—' : `${latencyMs} ms`,
    code: entry.code ?? '',
    counters,
    flags,
  }
}

/**
 * 构建诊断时间线展示视图。
 *
 * @param raw 已过滤或原始的诊断结构（内部再次过滤，抵御被污染数据）。
 * @param options 时间格式化注入，便于页面复用 `formatFullTime`。
 */
export function buildPublishDiagnosticsView(
  raw: PublishDiagnostics | null | undefined,
  options: PublishDiagViewOptions = {},
): PublishDiagnosticsView {
  const formatTime = options.formatTime ?? defaultFormatTime
  const diag = sanitizePublishDiagnostics(raw)
  if (!diag) {
    return { schema: PUBLISH_DIAG_SCHEMA, hasRecords: false, timeline: [], dropped: 0, updatedAtText: '' }
  }
  const timeline = diag.timeline.map((entry) => toEntryView(entry, formatTime))
  return {
    schema: diag.schema,
    hasRecords: timeline.length > 0,
    timeline,
    dropped: diag.dropped,
    updatedAtText: diag.updatedAt > 0 ? formatTime(diag.updatedAt) : '',
  }
}
