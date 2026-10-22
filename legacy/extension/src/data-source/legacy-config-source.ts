/**
 * 旧扩展配置来源适配器（受信载荷 → 内存来源；只读、显式、可注入、可审计）。
 *
 * 关键事实：`chrome.storage.local` **按 extension ID 隔离**，新扩展无法 `get` 旧扩展的存储。
 * 因此本模块**不读任何 storage**：来源是受信上下文（旧扩展页面 / DevTools 隔离执行环境）
 * 采集的白名单「迁移载荷」，只在内存中转移。
 *
 * 安全约束（硬性）：
 * - 载荷字段严格白名单（已由 `isLegacyConfigTransfer` 在协议层校验），未知键一律拒绝；
 * - 规则逐条净化（剥离 `aiApiKey` 等敏感字段）后再校验，绝不把敏感字段带入运行时；
 * - 本模块不写任何存储、不打印凭据；仅在显式迁移流程中被调用。
 */
import { isReplyRule, sanitizeReplyRules } from '../../../shared/reply/index'
import type { LegacyConfigTransfer } from '../../../shared/types/legacy-migration'
import type { ReplyRule } from '../../../shared/types/reply'

/** 旧扩展 AI 配置（含凭据，只在迁移内部流转，绝不外泄）。 */
export interface LegacyAiProviderSource {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs?: number
}

/** 旧扩展规则来源（已脱敏）。 */
export interface LegacyRulesSource {
  rules: ReplyRule[]
}

/** 旧扩展全局配置（非敏感字段）。 */
export interface LegacyGlobalConfigSource {
  enabled?: boolean
  defaultCooldown?: number
  defaultDelay?: number
  blacklist?: string[]
}

/** 旧扩展飞书配置（含 appSecret，只在迁移内部流转，绝不外泄）。 */
export interface LegacyFeishuSource {
  appId: string
  appSecret: string
  spreadsheetToken: string
  productTableId: string
  sellerTableId?: string
}

/** 旧扩展配置来源（异步以兼容未来受信桥接实现）。 */
export interface LegacyConfigSource {
  readAiProvider(): Promise<LegacyAiProviderSource | null>
  readRules(): Promise<LegacyRulesSource | null>
  readGlobalConfig(): Promise<LegacyGlobalConfigSource | null>
  readFeishuConfig(): Promise<LegacyFeishuSource | null>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 受信载荷来源：把已通过协议层白名单校验的 {@link LegacyConfigTransfer} 规整为内部来源。
 *
 * 这是**默认且唯一**的真实来源实现；不触碰任何 storage。
 */
export class PayloadLegacyConfigSource implements LegacyConfigSource {
  private readonly transfer: LegacyConfigTransfer

  constructor(transfer: LegacyConfigTransfer) {
    this.transfer = transfer
  }

  async readAiProvider(): Promise<LegacyAiProviderSource | null> {
    const ai = this.transfer.ai
    if (!ai) return null
    const apiKey = asString(ai.apiKey)
    const baseUrl = asString(ai.baseUrl)
    const model = asString(ai.model)
    if (apiKey.length === 0 && baseUrl.length === 0 && model.length === 0) return null
    return {
      apiKey,
      baseUrl,
      model,
      ...(typeof ai.timeoutMs === 'number' && Number.isFinite(ai.timeoutMs) && ai.timeoutMs > 0
        ? { timeoutMs: ai.timeoutMs }
        : {}),
    }
  }

  async readRules(): Promise<LegacyRulesSource | null> {
    const raw = this.transfer.rules
    if (!Array.isArray(raw)) return null
    // 先净化（剥离 aiApiKey 等敏感字段）再校验，避免脏字段导致规则整体被丢弃。
    const rules: ReplyRule[] = []
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      if (record['type'] !== 'keyword' && record['type'] !== 'ai') continue
      const sanitized = sanitizeReplyRules([record as unknown as ReplyRule])[0]
      if (sanitized && isReplyRule(sanitized)) rules.push(sanitized)
    }
    return { rules }
  }

  async readGlobalConfig(): Promise<LegacyGlobalConfigSource | null> {
    const global = this.transfer.global
    if (!global) return null
    const result: LegacyGlobalConfigSource = {}
    if (typeof global.enabled === 'boolean') result.enabled = global.enabled
    if (typeof global.defaultCooldown === 'number' && Number.isFinite(global.defaultCooldown)) {
      result.defaultCooldown = global.defaultCooldown
    }
    if (typeof global.defaultDelay === 'number' && Number.isFinite(global.defaultDelay)) {
      result.defaultDelay = global.defaultDelay
    }
    if (Array.isArray(global.blacklist) && global.blacklist.every((item) => typeof item === 'string')) {
      result.blacklist = [...global.blacklist]
    }
    return Object.keys(result).length > 0 ? result : null
  }

  async readFeishuConfig(): Promise<LegacyFeishuSource | null> {
    const feishu = this.transfer.feishu
    if (!feishu) return null
    const appId = asString(feishu.appId)
    const appSecret = asString(feishu.appSecret)
    const spreadsheetToken = asString(feishu.spreadsheetToken)
    const productTableId = asString(feishu.productTableId)
    const sellerTableId = asString(feishu.sellerTableId)
    if (!appId && !appSecret && !spreadsheetToken && !productTableId && !sellerTableId) return null
    return {
      appId,
      appSecret,
      spreadsheetToken,
      productTableId,
      ...(sellerTableId ? { sellerTableId } : {}),
    }
  }
}

/** 旧扩展配置来源（异步以兼容未来受信桥接实现）。 */
export interface LegacyConfigSource {
  readAiProvider(): Promise<LegacyAiProviderSource | null>
  readRules(): Promise<LegacyRulesSource | null>
  readGlobalConfig(): Promise<LegacyGlobalConfigSource | null>
  readFeishuConfig(): Promise<LegacyFeishuSource | null>
}
