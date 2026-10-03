/**
 * 旧扩展配置安全迁移（LegacyConfigMigration）。
 *
 * 设计原则（硬性）：
 * - **显式触发**：仅在用户调用 `MIGRATE_LEGACY_CONFIG` 命令时执行，background 启动绝不自动读取；
 * - **不读 storage**：跨 extension ID 无法直接读取旧扩展 `chrome.storage.local`，
 *   来源是由受信上下文采集、协议层白名单校验过的受信载荷（{@link LegacyConfigSource}）；
 * - **dry-run 优先**：`preview()` 只返回存在性 / 条数 / 派生 provider，绝不返回值本身；
 * - **不覆盖已有新配置**：目标已有配置时默认跳过，仅 `overwrite=true`（二次确认）才覆盖；
 * - **不启用自动回复**：迁移后规则一律 `enabled=false`，全局配置强制 `enabled=false`、`mode='suggest'`；
 * - **凭据隔离**：AI key 只进 `fishops.reply.aiProvider`，飞书 appSecret/token 只进
 *   `fishops.analysis.feishuConfig`，返回值只出现 `configured/provider/count/fields`；
 * - **结构化失败**：读取 / 保存失败归类为 `LegacyMigrationError`，不抛全局错误。
 */
import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_TIMEOUT_MS,
  DEFAULT_REPLY_GLOBAL_CONFIG,
  type AiProviderConfig,
  type ReplyGlobalConfig,
} from '../../../shared/types/reply'
import type {
  LegacyAiProviderPreview,
  LegacyConfigMigrationResult,
  LegacyConfigPreview,
  LegacyFeishuPreview,
  LegacyMigrationApplied,
  LegacyMigrationError,
  LegacyMigrationSkip,
} from '../../../shared/types/legacy-migration'
import type { FeishuConfig } from '../../../shared/data-source/feishu-types'
import { sanitizeReplyRules } from '../../../shared/reply/index'
import type { ReplyConfigStore } from '../chat/reply-config'
import type { FeishuConfigStore } from './feishu-config-store'
import type { LegacyConfigSource } from './legacy-config-source'

/** 迁移依赖（不再依赖任何 storage 读取）。 */
export interface LegacyConfigMigrationDeps {
  /** 新 AI / 规则 / 全局配置存储（P6）。 */
  replyConfigStore: ReplyConfigStore
  /** 新飞书配置存储（P7）。 */
  feishuConfigStore: FeishuConfigStore
  now?: () => number
}

/** 迁移执行选项。 */
export interface LegacyConfigMigrateOptions {
  /** 允许覆盖已有新配置（调用方需已完成二次确认）。 */
  overwrite?: boolean
}

/** 从 baseUrl 提取主机名（用于推断供应方，非敏感）。 */
function hostOf(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`)
    return parsed.hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** 由 baseUrl 推断供应方标识（派生、非敏感）。 */
export function describeProvider(baseUrl: string): string {
  const host = hostOf(baseUrl)
  if (!host) return 'custom'
  if (host.includes('dashscope')) return 'dashscope'
  if (host.includes('deepseek')) return 'deepseek'
  if (host.includes('openai.com')) return 'openai'
  if (host.includes('anthropic')) return 'anthropic'
  if (host.includes('moonshot')) return 'moonshot'
  if (host.includes('bigmodel') || host.includes('zhipu')) return 'zhipu'
  return host
}

/** 判断新全局配置是否仍为默认值（用于判定「已有新配置」）。 */
function isPristineGlobalConfig(config: ReplyGlobalConfig): boolean {
  const defaults = DEFAULT_REPLY_GLOBAL_CONFIG
  return (
    config.enabled === defaults.enabled &&
    config.mode === defaults.mode &&
    config.defaultCooldown === defaults.defaultCooldown &&
    config.defaultDelay === defaults.defaultDelay &&
    config.blacklist.length === 0 &&
    config.handoffKeywords.length === 0 &&
    config.maxAutoRepliesPerSession === defaults.maxAutoRepliesPerSession &&
    config.autoReplyWindowMs === defaults.autoReplyWindowMs &&
    config.aiPauseDurationMs === defaults.aiPauseDurationMs &&
    config.maxContentLength === defaults.maxContentLength
  )
}

/** 旧扩展配置安全迁移服务。 */
export class LegacyConfigMigration {
  private readonly deps: LegacyConfigMigrationDeps

  constructor(deps: LegacyConfigMigrationDeps) {
    this.deps = deps
  }

  /** dry-run 预览：只说明存在性，不返回值。 */
  async preview(source: LegacyConfigSource): Promise<LegacyConfigPreview> {
    const [ai, rules, global, feishu] = await Promise.all([
      source.readAiProvider(),
      source.readRules(),
      source.readGlobalConfig(),
      source.readFeishuConfig(),
    ])
    const [existingAi, existingRules, existingGlobal, existingFeishu] = await Promise.all([
      this.deps.replyConfigStore.loadAiProvider(),
      this.deps.replyConfigStore.loadRules(),
      this.deps.replyConfigStore.loadGlobalConfig(),
      this.deps.feishuConfigStore.hasConfig(),
    ])

    const aiPreview: LegacyAiProviderPreview = {
      exists: ai !== null,
      hasApiKey: !!ai?.apiKey,
      hasBaseUrl: !!ai?.baseUrl,
      hasModel: !!ai?.model,
    }
    if (ai?.baseUrl) aiPreview.provider = describeProvider(ai.baseUrl)

    const feishuPreview: LegacyFeishuPreview = {
      exists: feishu !== null,
      hasAppId: !!feishu?.appId,
      hasAppSecret: !!feishu?.appSecret,
      hasSpreadsheetToken: !!feishu?.spreadsheetToken,
      hasProductTableId: !!feishu?.productTableId,
      hasSellerTableId: !!feishu?.sellerTableId,
    }

    return {
      aiProvider: aiPreview,
      feishuConfig: feishuPreview,
      rules: { exists: rules !== null, count: rules?.rules.length ?? 0 },
      globalConfig: { exists: global !== null, fields: global ? Object.keys(global) : [] },
      existing: {
        aiProvider: existingAi.apiKey.length > 0,
        feishuConfig: existingFeishu,
        rules: existingRules.length > 0,
        globalConfig: !isPristineGlobalConfig(existingGlobal),
      },
    }
  }

  /** 执行迁移。 */
  async migrate(source: LegacyConfigSource, options: LegacyConfigMigrateOptions = {}): Promise<LegacyConfigMigrationResult> {
    const overwrite = options.overwrite === true
    const applied: LegacyMigrationApplied[] = []
    const skipped: LegacyMigrationSkip[] = []
    const errors: LegacyMigrationError[] = []

    await this.migrateAiProvider(source, overwrite, applied, skipped, errors)
    await this.migrateRules(source, overwrite, applied, skipped, errors)
    await this.migrateGlobalConfig(source, overwrite, applied, skipped, errors)
    await this.migrateFeishuConfig(source, overwrite, applied, skipped, errors)

    return { ok: errors.length === 0, applied, skipped, errors }
  }

  private async migrateAiProvider(
    source: LegacyConfigSource,
    overwrite: boolean,
    applied: LegacyMigrationApplied[],
    skipped: LegacyMigrationSkip[],
    errors: LegacyMigrationError[],
  ): Promise<void> {
    const target = 'aiProvider' as const
    let legacy: Awaited<ReturnType<LegacyConfigSource['readAiProvider']>>
    try {
      legacy = await source.readAiProvider()
    } catch (error) {
      errors.push({ target, code: 'SOURCE_READ_FAILED', message: this.messageOf(error) })
      return
    }
    if (!legacy) {
      skipped.push({ target, reason: 'missing-source' })
      return
    }

    let existing: AiProviderConfig
    try {
      existing = await this.deps.replyConfigStore.loadAiProvider()
    } catch (error) {
      errors.push({ target, code: 'SOURCE_READ_FAILED', message: this.messageOf(error) })
      return
    }
    if (existing.apiKey.length > 0 && !overwrite) {
      skipped.push({ target, reason: 'existing-config' })
      return
    }

    const provider: AiProviderConfig = {
      apiKey: legacy.apiKey,
      baseUrl: legacy.baseUrl || DEFAULT_AI_BASE_URL,
      model: legacy.model || DEFAULT_AI_MODEL,
      timeoutMs: legacy.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
    }
    try {
      await this.deps.replyConfigStore.saveAiProvider(provider)
    } catch (error) {
      errors.push({ target, code: 'SAVE_FAILED', message: this.messageOf(error) })
      return
    }
    applied.push({
      target,
      configured: provider.apiKey.length > 0,
      provider: describeProvider(provider.baseUrl),
    })
  }

  private async migrateRules(
    source: LegacyConfigSource,
    overwrite: boolean,
    applied: LegacyMigrationApplied[],
    skipped: LegacyMigrationSkip[],
    errors: LegacyMigrationError[],
  ): Promise<void> {
    const target = 'rules' as const
    let legacy: Awaited<ReturnType<LegacyConfigSource['readRules']>>
    try {
      legacy = await source.readRules()
    } catch (error) {
      errors.push({ target, code: 'SOURCE_READ_FAILED', message: this.messageOf(error) })
      return
    }
    if (!legacy) {
      skipped.push({ target, reason: 'missing-source' })
      return
    }

    let existingCount: number
    try {
      existingCount = (await this.deps.replyConfigStore.loadRules()).length
    } catch (error) {
      errors.push({ target, code: 'SOURCE_READ_FAILED', message: this.messageOf(error) })
      return
    }
    if (existingCount > 0 && !overwrite) {
      skipped.push({ target, reason: 'existing-config' })
      return
    }

    // 安全默认：迁移的规则一律禁用，绝不因迁移而启用自动回复。
    const rules = sanitizeReplyRules(legacy.rules).map((rule) => ({ ...rule, enabled: false }))
    try {
      await this.deps.replyConfigStore.saveRules(rules)
    } catch (error) {
      errors.push({ target, code: 'SAVE_FAILED', message: this.messageOf(error) })
      return
    }
    applied.push({ target, count: rules.length })
  }

  private async migrateGlobalConfig(
    source: LegacyConfigSource,
    overwrite: boolean,
    applied: LegacyMigrationApplied[],
    skipped: LegacyMigrationSkip[],
    errors: LegacyMigrationError[],
  ): Promise<void> {
    const target = 'globalConfig' as const
    let legacy: Awaited<ReturnType<LegacyConfigSource['readGlobalConfig']>>
    try {
      legacy = await source.readGlobalConfig()
    } catch (error) {
      errors.push({ target, code: 'SOURCE_READ_FAILED', message: this.messageOf(error) })
      return
    }
    if (!legacy) {
      skipped.push({ target, reason: 'missing-source' })
      return
    }

    let current: ReplyGlobalConfig
    try {
      current = await this.deps.replyConfigStore.loadGlobalConfig()
    } catch (error) {
      errors.push({ target, code: 'SOURCE_READ_FAILED', message: this.messageOf(error) })
      return
    }
    if (!isPristineGlobalConfig(current) && !overwrite) {
      skipped.push({ target, reason: 'existing-config' })
      return
    }

    // 安全默认：强制关闭自动回复并使用建议模式，仅迁移非敏感调优字段。
    const merged: ReplyGlobalConfig = {
      ...current,
      ...(legacy.defaultCooldown === undefined ? {} : { defaultCooldown: legacy.defaultCooldown }),
      ...(legacy.defaultDelay === undefined ? {} : { defaultDelay: legacy.defaultDelay }),
      ...(legacy.blacklist === undefined ? {} : { blacklist: [...legacy.blacklist] }),
      enabled: false,
      mode: 'suggest',
    }
    try {
      await this.deps.replyConfigStore.saveGlobalConfig(merged)
    } catch (error) {
      errors.push({ target, code: 'SAVE_FAILED', message: this.messageOf(error) })
      return
    }
    // 只报告实际应用的非敏感字段（enabled/mode 被强制为安全默认，不计入迁移来源）。
    const appliedFields = (['defaultCooldown', 'defaultDelay', 'blacklist'] as const).filter(
      (key) => (legacy as Record<string, unknown>)[key] !== undefined,
    )
    applied.push({ target, fields: appliedFields })
  }

  private async migrateFeishuConfig(
    source: LegacyConfigSource,
    overwrite: boolean,
    applied: LegacyMigrationApplied[],
    skipped: LegacyMigrationSkip[],
    errors: LegacyMigrationError[],
  ): Promise<void> {
    const target = 'feishuConfig' as const
    let legacy: Awaited<ReturnType<LegacyConfigSource['readFeishuConfig']>>
    try {
      legacy = await source.readFeishuConfig()
    } catch (error) {
      errors.push({ target, code: 'SOURCE_READ_FAILED', message: this.messageOf(error) })
      return
    }
    if (!legacy) {
      skipped.push({ target, reason: 'missing-source' })
      return
    }
    if (!legacy.appId || !legacy.appSecret || !legacy.spreadsheetToken || !legacy.productTableId) {
      skipped.push({ target, reason: 'invalid-source' })
      return
    }

    let existing: boolean
    try {
      existing = await this.deps.feishuConfigStore.hasConfig()
    } catch (error) {
      errors.push({ target, code: 'SOURCE_READ_FAILED', message: this.messageOf(error) })
      return
    }
    if (existing && !overwrite) {
      skipped.push({ target, reason: 'existing-config' })
      return
    }

    const config: FeishuConfig = {
      appId: legacy.appId,
      appSecret: legacy.appSecret,
      spreadsheetToken: legacy.spreadsheetToken,
      productTableId: legacy.productTableId,
      ...(legacy.sellerTableId === undefined ? {} : { sellerTableId: legacy.sellerTableId }),
    }
    try {
      await this.deps.feishuConfigStore.save(config)
    } catch (error) {
      errors.push({ target, code: 'SAVE_FAILED', message: this.messageOf(error) })
      return
    }
    applied.push({ target, configured: true })
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }
}
