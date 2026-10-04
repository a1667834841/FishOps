/**
 * 发布诊断时间线记录器（安全、有界、可持久化）。
 *
 * 设计目标：让「一次真实发布卡点」的监控结果**可复用、可读**，且绝不把敏感原文写入任务详情。
 *
 * 安全铁律：
 * 1. 时间线只保存阶段名 / 状态 / 时间戳 / 耗时 / 结构化 `code` / 数值 `counters` / 布尔 `flags`；
 * 2. `code` 仅接受 `^[A-Z][A-Z0-9_]*$`（发布错误码 / 固定枚举），任何 URL / query / token /
 *    cookie / 商品正文 / 地址 / 图片原始链接等原文一律被过滤丢弃；
 * 3. `counters` 只保留有限数值，`flags` 只保留布尔值，并限制键数量，避免被注入任意长文；
 * 4. 时间线长度有界（{@link PUBLISH_DIAG_TIMELINE_LIMIT}），超出丢弃最旧记录并累加 `dropped`，
 *    保证反复重填 / 轮询也不会无限增长。
 *
 * 该模块**不依赖任何 DOM / Chrome API**，可在 Node 单测中直接验证。
 */

import {
  PUBLISH_DIAG_TIMELINE_LIMIT,
  type PublishDiagEntry,
  type PublishDiagStage,
  type PublishDiagStatus,
  type PublishDiagnostics,
} from '@fishops/shared'

/** 结构化 code 白名单形态：大写字母开头，仅含大写字母 / 数字 / 下划线。 */
const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/

/** counters / flags 最多保留的键数量，防止被塞入超长对象。 */
const MAX_DIAG_KEYS = 16

/** 可写入阶段的安全数据。 */
export interface PublishDiagData {
  /** 结构化原因码（会被白名单过滤，非安全形态直接丢弃） */
  code?: string
  /** 数值计数（仅保留有限数值） */
  counters?: Record<string, number>
  /** 布尔标记（仅保留布尔值） */
  flags?: Record<string, boolean>
}

/** 追加一条已完成阶段时额外允许的计时字段。 */
export interface PublishDiagAppendData extends PublishDiagData {
  startedAt?: number
  latencyMs?: number
}

/** 过滤结构化 code：非白名单形态一律丢弃，杜绝原文/URL/token 混入。 */
export function sanitizeDiagCode(code: string | undefined): string | undefined {
  if (typeof code !== 'string') return undefined
  return SAFE_CODE_RE.test(code) ? code : undefined
}

/** 过滤数值计数：仅保留有限数值，并限制键数量。 */
function sanitizeCounters(counters: Record<string, number> | undefined): Record<string, number> | undefined {
  if (!counters) return undefined
  const out: Record<string, number> = {}
  let keys = 0
  for (const [key, value] of Object.entries(counters)) {
    if (keys >= MAX_DIAG_KEYS) break
    if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) continue
    out[key] = value
    keys++
  }
  return keys > 0 ? out : undefined
}

/** 过滤布尔标记：仅保留布尔值，并限制键数量。 */
function sanitizeFlags(flags: Record<string, boolean> | undefined): Record<string, boolean> | undefined {
  if (!flags) return undefined
  const out: Record<string, boolean> = {}
  let keys = 0
  for (const [key, value] of Object.entries(flags)) {
    if (keys >= MAX_DIAG_KEYS) break
    if (typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key)) continue
    if (typeof value !== 'boolean') continue
    out[key] = value
    keys++
  }
  return keys > 0 ? out : undefined
}

/** 把安全数据合并进一条记录（就地修改）。 */
function mergeData(entry: PublishDiagEntry, data?: PublishDiagData): void {
  if (!data) return
  const code = sanitizeDiagCode(data.code)
  if (code !== undefined) entry.code = code
  const counters = sanitizeCounters(data.counters)
  if (counters) entry.counters = { ...(entry.counters ?? {}), ...counters }
  const flags = sanitizeFlags(data.flags)
  if (flags) entry.flags = { ...(entry.flags ?? {}), ...flags }
}

/** 深拷贝一条诊断记录（保证快照与内存对象解耦）。 */
function cloneEntry(entry: PublishDiagEntry): PublishDiagEntry {
  return {
    stage: entry.stage,
    status: entry.status,
    startedAt: entry.startedAt,
    ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
    ...(entry.latencyMs === undefined ? {} : { latencyMs: entry.latencyMs }),
    ...(entry.code === undefined ? {} : { code: entry.code }),
    ...(entry.counters === undefined ? {} : { counters: { ...entry.counters } }),
    ...(entry.flags === undefined ? {} : { flags: { ...entry.flags } }),
  }
}

/** 校验一个未知值是否是合法的诊断时间线。 */
function isDiagnostics(value: unknown): value is PublishDiagnostics {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<PublishDiagnostics>
  return candidate.schema === 1 && Array.isArray(candidate.timeline)
}

/**
 * 从任务 meta 中读取已有诊断时间线（用于跨重填 / 跨命令累计）。
 *
 * 非法或缺失时返回新建的空时间线，保证调用方无需判空。
 */
export function readDiagnosticsFromMeta(meta: unknown): PublishDiagnostics {
  if (meta && typeof meta === 'object') {
    const candidate = (meta as { diagnostics?: unknown }).diagnostics
    if (isDiagnostics(candidate)) {
      return createDiagnostics(candidate)
    }
  }
  return createDiagnostics()
}

/**
 * 创建（或从既有时间线续接）一个诊断记录器。
 *
 * 传入 `seed` 时会在其副本上继续追加，实现同一任务跨命令的可复用时间线。
 */
export function createDiagnostics(seed?: PublishDiagnostics | null): PublishDiagnostics {
  if (seed && isDiagnostics(seed)) {
    return {
      schema: 1,
      timeline: seed.timeline.map(cloneEntry),
      dropped: typeof seed.dropped === 'number' && seed.dropped > 0 ? Math.floor(seed.dropped) : 0,
      updatedAt: typeof seed.updatedAt === 'number' ? seed.updatedAt : 0,
    }
  }
  return { schema: 1, timeline: [], dropped: 0, updatedAt: 0 }
}

/** 有界追加：超出上限时丢弃最旧记录并累加 `dropped`。 */
function pushBounded(diag: PublishDiagnostics, entry: PublishDiagEntry): void {
  diag.timeline.push(entry)
  while (diag.timeline.length > PUBLISH_DIAG_TIMELINE_LIMIT) {
    diag.timeline.shift()
    diag.dropped++
  }
}

/** 开始一个阶段（状态 `started`），返回可后续 finish 的记录引用。 */
export function beginDiagStage(
  diag: PublishDiagnostics,
  stage: PublishDiagStage,
  at: number,
  data?: PublishDiagData,
): PublishDiagEntry {
  const entry: PublishDiagEntry = { stage, status: 'started', startedAt: at }
  mergeData(entry, data)
  pushBounded(diag, entry)
  diag.updatedAt = at
  return entry
}

/** 结束一个阶段，写入状态 / 结束时间 / 耗时与附加安全数据。 */
export function endDiagStage(
  entry: PublishDiagEntry,
  status: PublishDiagStatus,
  at: number,
  data?: PublishDiagData,
): void {
  entry.status = status
  entry.endedAt = at
  entry.latencyMs = Math.max(0, at - entry.startedAt)
  mergeData(entry, data)
}

/** 追加一条**已完成**的阶段记录（用于由注入侧安全计时还原的子阶段）。 */
export function appendDiagStage(
  diag: PublishDiagnostics,
  stage: PublishDiagStage,
  status: PublishDiagStatus,
  at: number,
  data?: PublishDiagAppendData,
): PublishDiagEntry {
  const startedAt = typeof data?.startedAt === 'number' ? data.startedAt : at
  const entry: PublishDiagEntry = { stage, status, startedAt }
  const latency = data?.latencyMs
  if (typeof latency === 'number' && Number.isFinite(latency) && latency >= 0) {
    entry.latencyMs = latency
    entry.endedAt = startedAt + latency
  } else {
    entry.endedAt = at
    entry.latencyMs = Math.max(0, at - startedAt)
  }
  mergeData(entry, data)
  pushBounded(diag, entry)
  diag.updatedAt = at
  return entry
}

/**
 * 写入 / 覆盖最终的 `result` 阶段（同一任务只保留最后一条结论，且位于时间线末尾）。
 *
 * 会先移除历史 `result` 记录再追加，避免多次填充 / 提交（或填充 + 提交跨命令）堆叠出多条结论。
 */
export function setResultStage(
  diag: PublishDiagnostics,
  status: Exclude<PublishDiagStatus, 'started'>,
  at: number,
  data?: PublishDiagAppendData,
): PublishDiagEntry {
  for (let i = diag.timeline.length - 1; i >= 0; i--) {
    if (diag.timeline[i]!.stage === 'result') {
      diag.timeline.splice(i, 1)
    }
  }
  return appendDiagStage(diag, 'result', status, at, data)
}

/** 生成一份可安全持久化 / 经协议传输的深拷贝快照。 */
export function snapshotDiagnostics(diag: PublishDiagnostics): PublishDiagnostics {
  return {
    schema: 1,
    timeline: diag.timeline.map(cloneEntry),
    dropped: diag.dropped,
    updatedAt: diag.updatedAt,
  }
}
