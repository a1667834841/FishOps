/**
 * 旧扩展配置迁移（Legacy Config Migration）领域类型（共享，纯类型）。
 *
 * 背景与约束（硬性）：
 * - `chrome.storage.local` **按 extension ID 隔离**，新扩展无法直接读取旧扩展的存储。
 *   因此迁移不读任何 storage，而是接收由**受信上下文**（旧扩展页面 / DevTools 隔离执行环境）
 *   采集的、严格白名单的「迁移载荷」，仅在内存中转移到新扩展的专用键。
 * - 迁移**只在用户显式调用 `MIGRATE_LEGACY_CONFIG` 命令时**执行，background 启动绝不自动读取；
 * - 预览（dry-run）只返回「某项是否存在 / 条数 / 布尔」，**绝不返回值本身**；
 * - AI 的 apiKey、飞书 appSecret、租户 token 等只写入 `chrome.storage.local` 专用键，
 *   返回值、事件、日志一律不出现任何明文值（只出现 `configured: boolean` 与派生的 `provider`）。
 *
 * 旧扩展真实配置键（只读 `git show` 确认，仅用于说明载荷采集范围，不在此读取）：
 * - `chat` 分支：`autoReplyGlobalConfig`（含 `aiApiKey/aiBaseUrl/aiModel/aiTimeout` 与 `xgj*`）、
 *   `autoReplyRules`（规则对象可能内嵌 `aiApiKey`）、`aiPauseConfig`；
 * - `main` 分支飞书：`chrome.storage.local` 扁平键 `appId/appSecret/spreadsheetToken/productTableId/sellerTableId/enabled`。
 */

/** 迁移目标。 */
export type LegacyMigrationTarget = 'aiProvider' | 'feishuConfig' | 'rules' | 'globalConfig'

/** 跳过原因。 */
export type LegacyMigrationSkipReason = 'existing-config' | 'missing-source' | 'invalid-source'

/** 受信载荷中允许的顶层分区。 */
export const LEGACY_TRANSFER_SECTIONS: readonly string[] = ['ai', 'rules', 'global', 'feishu'] as const

/** 受信载荷上限（防止超大数据 / 滥用）。 */
export const LEGACY_TRANSFER_LIMITS = {
  /** 规则条数上限。 */
  maxRules: 200,
  /** 单个字符串字段长度上限（含 apiKey / appSecret 等）。 */
  maxStringLength: 8192,
  /** 黑名单条数上限。 */
  maxBlacklist: 1000,
} as const

/**
 * 受信迁移载荷 · AI 分区（字段白名单，对应旧 `autoReplyGlobalConfig` 的 `ai*` 字段）。
 * 仅在内存中流转，绝不回显 / 落日志。
 */
export interface LegacyConfigTransferAi {
  /** 旧 `aiApiKey`。 */
  apiKey?: string
  /** 旧 `aiBaseUrl`。 */
  baseUrl?: string
  /** 旧 `aiModel`。 */
  model?: string
  /** 旧 `aiTimeout`。 */
  timeoutMs?: number
}

/**
 * 受信迁移载荷 · 全局分区（字段白名单，对应旧 `autoReplyGlobalConfig` 的非敏感字段）。
 * 迁移时强制 `enabled=false`、`mode='suggest'`，不会启用自动回复。
 */
export interface LegacyConfigTransferGlobal {
  enabled?: boolean
  defaultCooldown?: number
  defaultDelay?: number
  blacklist?: string[]
}

/**
 * 受信迁移载荷 · 飞书分区（字段白名单，对应 `main` 分支扁平键）。
 * 含 appSecret，仅在内存中流转。
 */
export interface LegacyConfigTransferFeishu {
  appId?: string
  appSecret?: string
  spreadsheetToken?: string
  productTableId?: string
  sellerTableId?: string
}

/**
 * 受信迁移载荷。
 *
 * 由受信上下文（旧扩展页面 / DevTools 隔离执行环境）**只读取白名单键**后构造，
 * 通过 `MIGRATE_LEGACY_CONFIG` 命令传入。`rules` 为旧规则原始数组，迁移时逐条净化
 * （剥离 `aiApiKey` 等敏感字段）并强制 `enabled=false`。
 */
export interface LegacyConfigTransfer {
  ai?: LegacyConfigTransferAi
  rules?: unknown[]
  global?: LegacyConfigTransferGlobal
  feishu?: LegacyConfigTransferFeishu
}

/** AI 供应方预览（只回布尔与派生的 provider，绝不含 apiKey / baseUrl 明文）。 */
export interface LegacyAiProviderPreview {
  /** 是否存在任一旧 AI 配置字段。 */
  exists: boolean
  hasApiKey: boolean
  hasBaseUrl: boolean
  hasModel: boolean
  /** 由 baseUrl 推断的供应方标识（派生、非敏感）。 */
  provider?: string
}

/** 飞书配置预览（只说明各成员是否存在，绝不含 appSecret 明文）。 */
export interface LegacyFeishuPreview {
  exists: boolean
  hasAppId: boolean
  hasAppSecret: boolean
  hasSpreadsheetToken: boolean
  hasProductTableId: boolean
  hasSellerTableId: boolean
}

/** 规则预览。 */
export interface LegacyRulesPreview {
  exists: boolean
  /** 有效（净化后）规则条数。 */
  count: number
}

/** 全局配置预览（只列出非敏感字段名）。 */
export interface LegacyGlobalConfigPreview {
  exists: boolean
  /** 存在的非敏感字段名（如 enabled/defaultCooldown/defaultDelay/blacklist）。 */
  fields: string[]
}

/** 新配置当前是否已存在（用于判断是否会覆盖）。 */
export interface LegacyMigrationExistingState {
  aiProvider: boolean
  feishuConfig: boolean
  rules: boolean
  globalConfig: boolean
}

/** 迁移预览（dry-run）：只说明存在性，不返回值。 */
export interface LegacyConfigPreview {
  aiProvider: LegacyAiProviderPreview
  feishuConfig: LegacyFeishuPreview
  rules: LegacyRulesPreview
  globalConfig: LegacyGlobalConfigPreview
  /** 目标侧已有新配置的判定（true 表示需 overwrite=true 才会覆盖）。 */
  existing: LegacyMigrationExistingState
}

/** 单目标成功应用的结果（不含任何凭据 / URL 明文）。 */
export interface LegacyMigrationApplied {
  target: LegacyMigrationTarget
  /** AI / 飞书目标：写入后是否处于已配置状态。 */
  configured?: boolean
  /** AI 目标：供应方标识（派生、非敏感）。 */
  provider?: string
  /** 规则目标：迁移条数。 */
  count?: number
  /** 全局配置目标：应用的非敏感字段名。 */
  fields?: string[]
}

/** 跳过的目标。 */
export interface LegacyMigrationSkip {
  target: LegacyMigrationTarget
  reason: LegacyMigrationSkipReason
}

/** 迁移错误码。 */
export type LegacyMigrationErrorCode =
  | 'CONFIRM_REQUIRED'
  | 'SOURCE_READ_FAILED'
  | 'SAVE_FAILED'
  | 'INVALID_SOURCE'
  | 'NO_PENDING_SOURCE'

/** 单个目标的迁移失败（结构化）。 */
export interface LegacyMigrationError {
  target: LegacyMigrationTarget
  code: LegacyMigrationErrorCode
  message: string
}

/** 迁移执行结果（不含旧原始对象 / 完整 storage dump / 旧 token）。 */
export interface LegacyConfigMigrationResult {
  ok: boolean
  applied: LegacyMigrationApplied[]
  skipped: LegacyMigrationSkip[]
  errors: LegacyMigrationError[]
}

/** 迁移命令结果：预览或已应用。 */
export interface MigrateLegacyConfigResult {
  mode: 'preview' | 'applied'
  preview?: LegacyConfigPreview
  result?: LegacyConfigMigrationResult
}

/**
 * 迁移命令负载。
 *
 * 契约：
 * - `legacy`：受信上下文采集的白名单载荷；预览阶段必须提供，确认阶段可省略（复用内存中已校验的来源）；
 * - 缺省 / `dryRun:true` / 未 `confirm` → 仅预览（返回存在性，不写入、不返回值）；
 * - `confirm:true` → 执行写入；已有新配置的目标默认跳过；
 * - `confirm:true && overwrite:true` → 覆盖已有新配置（二次确认）。
 */
export interface MigrateLegacyConfigPayload {
  legacy?: LegacyConfigTransfer
  dryRun?: boolean
  confirm?: boolean
  overwrite?: boolean
}
