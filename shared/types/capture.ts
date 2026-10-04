/**
 * 采集（Capture）领域类型（P4）。
 *
 * 描述采集任务的入参、过滤条件、进度断点与结果统计。
 * 与旧 `FishOps`（main 分支）`background.js` 的 `filterConfig` / `statistics` 语义对齐。
 */

/**
 * 采集搜索请求默认基础间隔（毫秒）。
 * 搜索不再强制固定 1500ms，而是「基础间隔 + 随机增量」，见 {@link CapturePayload.minIntervalMs}。
 */
export const DEFAULT_CAPTURE_INTERVAL_MS = 500

/** 采集搜索请求默认随机增量上限（毫秒），见 {@link CapturePayload.intervalJitterMs}。 */
export const DEFAULT_CAPTURE_JITTER_MS = 500

/** 采集过滤条件（与旧 `filterConfig` 一致，值为 0 / false 表示不限制）。 */
export interface CaptureFilter {
  /** 最小想要人数。 */
  minWantCnt?: number
  /** 最低价格。 */
  minPrice?: number
  /** 最高价格。 */
  maxPrice?: number
  /** 只看包邮。 */
  onlyFreeShip?: boolean
}

/** CAPTURE_CREATE 入参。 */
export interface CapturePayload {
  /** 搜索关键词。 */
  keyword: string
  /** 起始页，默认 1。 */
  startPage?: number
  /** 采集总页数（从 startPage 起算），默认 1。 */
  pages?: number
  /** 每页数量，默认由平台层决定（30）。 */
  rowsPerPage?: number
  /**
   * 搜索请求基础间隔（毫秒）。实际等待 = 基础间隔 + `intervalJitterMs` 内的均匀随机增量；
   * 首页立即不等待。缺省 {@link DEFAULT_CAPTURE_INTERVAL_MS}（500ms）。须为非负有限数。
   */
  minIntervalMs?: number
  /**
   * 搜索请求随机增量上限（毫秒）：每次等待额外叠加 `[0, intervalJitterMs]` 的均匀随机量，
   * 避免固定节奏被风控识别。缺省 {@link DEFAULT_CAPTURE_JITTER_MS}（500ms）。须为非负有限数。
   */
  intervalJitterMs?: number
  /** 过滤条件。 */
  filter?: CaptureFilter
  /** 是否顺带采集详情（浏览量 / 想要数 / 卖家），默认 false。 */
  fetchDetail?: boolean
}

/** 采集统计。 */
export interface CaptureStats {
  /** 已获取（原始条目，含被过滤项）。 */
  fetched: number
  /** 有效（通过过滤且本次运行内未重复）。 */
  valid: number
  /** 被过滤条数。 */
  filtered: number
  /** 本次运行内 itemId 重复条数。 */
  duplicates: number
  /** 失败次数（页面请求失败 + 详情请求失败）。 */
  failed: number
  /** 页面请求失败次数（`failed` 子集，跨轮次累加）。 */
  pageFailed?: number
  /** 详情请求失败次数（`failed` 的子集，单独计数便于排查详情问题；跨轮次累加）。 */
  detailFailed?: number
  /** 成功入库（有效去重）的商品数量。 */
  stored?: number
  /**
   * 归属未确认条数。
   *
   * 当无法确认当前登录账号 ID（获取失败 / 为空）或无法确认卖家身份（缺 sellerId）时，
   * 商品不会被归入当前账号发布目录。此处显式计数，避免把「归属未知」静默伪装成「确认非本人」。
   * 为兼容旧持久化数据与既有调用方，本字段可选。
   */
  ownershipUnconfirmed?: number
}

/**
 * 采集断点：写入 `task.meta.capture`，Service Worker 重启后可据此续跑。
 * `nextPage` 为「下一个待采集页」，暂停 / 取消后不会推进。
 */
export interface CaptureCheckpoint {
  keyword: string
  /** 起始页。 */
  startPage: number
  /** 总页数。 */
  totalPages: number
  /** 下一个待采集页（断点）。 */
  nextPage: number
  /** 已成功完成的页数。 */
  pagesCompleted: number
  /** 累计统计。 */
  stats: CaptureStats
  /**
   * 已成功入库的商品 itemId 列表（跨轮次持久化）。
   * 恢复续采时据此重建去重集合，避免已入库条目被重复计入 `stored`。
   * 旧存量断点可能缺失，按空集合兼容。
   */
  storedIds?: string[]
  /** 当次采集快照引用；完整商品内容存于 IndexedDB，避免任务事件与 session 存储膨胀。 */
  capturedRecords?: Array<{ itemId: string; snapshotId: string }>
}

/** 采集商品同步到飞书的结果；已存在的组合键跳过写入。 */
export interface CaptureFeishuSyncResult {
  createdCount: number
  skippedCount: number
}

/** 采集任务完成的输出。 */
export interface CaptureResult extends CaptureStats {
  /** 同步成功后才上报，旧任务可能没有此字段。 */
  feishuSync?: CaptureFeishuSyncResult
  keyword: string
  /** 已完成页数。 */
  pagesCompleted: number
  /** 下一个待采集页（正常完成时为 endPage + 1）。 */
  nextPage: number
  /** 本轮实际开始时间戳（毫秒，即任务首次进入 running 的时间）。 */
  startedAt?: number
  /** 本轮结束时间戳（毫秒），供前端展示耗时。 */
  endedAt?: number
}

/** 空统计。 */
export function emptyCaptureStats(): CaptureStats {
  return {
    fetched: 0,
    valid: 0,
    filtered: 0,
    duplicates: 0,
    failed: 0,
    pageFailed: 0,
    detailFailed: 0,
    stored: 0,
    ownershipUnconfirmed: 0,
  }
}

// ---------------- 任务中心历史列表（TASK_LIST） ----------------

/** 任务历史列表排序字段。 */
export type TaskListSortBy = 'createdAt' | 'updatedAt'

/** 任务历史列表排序方向。 */
export type TaskListSortOrder = 'asc' | 'desc'

// ---------------- 流量词（suggest） ----------------

/**
 * CAPTURE_SUGGEST_WORDS 请求负载。
 *
 * 仅查询建议词，**不会创建采集任务、不搜索商品**。关键词由调用方（UI）在输入确定后
 * 通过显式命令下发；后台不因逐键输入自动请求。
 */
export interface CaptureSuggestWordsPayload {
  /** 已确定的关键词。 */
  keyword: string
  /**
   * 调用方生成的查询标识；后台原样回传，便于 UI 把响应匹配回对应查询。
   * 超出 {@link CAPTURE_LIMITS.suggestQueryIdMaxLength} 时截断。
   */
  queryId?: string
  /** 期望返回条数上限；实际受 {@link CAPTURE_LIMITS.suggestMaxWords} 约束。 */
  limit?: number
}

/**
 * CAPTURE_SUGGEST_WORDS 结果。
 *
 * `sequence` 为后台单调递增序号（按请求到达顺序分配，而非完成顺序）：
 * UI 只需比较序号，忽略小于当前已渲染结果序号（或 queryId 不匹配最新查询）的旧响应，
 * 即可避免并发请求乱序导致“旧结果覆盖新结果”。
 */
export interface CaptureSuggestWordsResult {
  /** 实际查询的关键词（已 trim 并按限制截断）。 */
  keyword: string
  /** 去重、截断后的建议词列表（可能为空）。 */
  words: string[]
  /** 回显的查询标识（若请求携带）。 */
  queryId?: string
  /** 后台单调递增序号（>= 1）。 */
  sequence: number
}

/**
 * CAPTURE_SUGGEST_WORDS 默认限制。
 *
 * 任务载荷 / 结果 / 错误会写入 `chrome.storage.session`，存在容量上限，
 * 因此在协议层统一约束各字段最大长度 / 条数，避免单个超长字段挤占存储；
 * 这些限制**只裁剪可选文本，绝不动核心统计**（{@link CaptureStats}）。
 */
export const CAPTURE_LIMITS = {
  /** 采集关键词最大长度（CAPTURE_CREATE）。 */
  captureKeywordMaxLength: 120,
  /** 任务 error 文本最大长度（超出截断并追加省略号）。 */
  taskErrorMaxLength: 500,
  /** 流量词查询输入关键词最大长度。 */
  suggestInputMaxLength: 60,
  /** 单次流量词查询最多返回条数。 */
  suggestMaxWords: 20,
  /** 单个流量词最大长度。 */
  suggestWordMaxLength: 80,
  /** queryId 最大长度（回传给 UI，用于丢弃旧结果）。 */
  suggestQueryIdMaxLength: 128,
} as const

/** 依据 {@link CAPTURE_LIMITS} 截断文本；超出时追加省略号，保证长度精确受限。 */
export function limitText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return value.slice(0, Math.max(0, maxLength - 1)) + '…'
}
