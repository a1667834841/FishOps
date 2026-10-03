/**
 * P6 回复配置存储抽象（规则与全局设置分开 + 凭据隔离）。
 *
 * 存储键刻意分成三个：
 * - `fishops.reply.globalConfig`：全局设置（非敏感）；
 * - `fishops.reply.rules`：规则列表（**绝不**含 API key）；
 * - `fishops.reply.aiProvider`：AI 凭据（只允许本适配器读取，不进规则 / 日志 / 事件）。
 *
 * 提供内存实现（测试 / 无持久化环境）与可选 mock 种子。
 */
import {
  DEFAULT_AI_PROVIDER_CONFIG,
  DEFAULT_REPLY_GLOBAL_CONFIG,
  type AiProviderConfig,
  type ReplyGlobalConfig,
  type ReplyRule,
} from '../../../shared/types/reply'
import { sanitizeReplyRules } from '../../../shared/reply/index'

/** 存储键常量。 */
export const REPLY_GLOBAL_CONFIG_KEY = 'fishops.reply.globalConfig'
export const REPLY_RULES_KEY = 'fishops.reply.rules'
export const REPLY_AI_PROVIDER_KEY = 'fishops.reply.aiProvider'

/** 回复配置存储接口。 */
export interface ReplyConfigStore {
  loadGlobalConfig(): Promise<ReplyGlobalConfig>
  saveGlobalConfig(config: ReplyGlobalConfig): Promise<void>
  loadRules(): Promise<ReplyRule[]>
  saveRules(rules: ReplyRule[]): Promise<void>
  /** 读取 AI 凭据（仅配置适配器调用）。 */
  loadAiProvider(): Promise<AiProviderConfig>
  /** 写入 AI 凭据（仅配置适配器调用）。 */
  saveAiProvider(config: AiProviderConfig): Promise<void>
}

/** 合并全局配置增量（保持现有值，未提供的字段不变）。 */
export function mergeReplyGlobalConfig(
  current: ReplyGlobalConfig,
  patch: Partial<ReplyGlobalConfig> | undefined,
): ReplyGlobalConfig {
  if (!patch) return { ...current }
  return {
    ...current,
    ...patch,
    blacklist: patch.blacklist ? [...patch.blacklist] : [...current.blacklist],
    handoffKeywords: patch.handoffKeywords ? [...patch.handoffKeywords] : [...current.handoffKeywords],
  }
}

/** 规整规则列表：去重 ID + 字段白名单净化，避免脏数据 / 敏感字段落库。 */
export function normalizeReplyRules(rules: readonly ReplyRule[]): ReplyRule[] {
  const seen = new Set<string>()
  const result: ReplyRule[] = []
  for (const rule of rules) {
    if (seen.has(rule.id)) continue
    seen.add(rule.id)
    result.push(...sanitizeReplyRules([rule]))
  }
  return result
}

/** 内存配置存储（默认值与全局默认一致）。 */
export class MemoryReplyConfigStore implements ReplyConfigStore {
  private globalConfig: ReplyGlobalConfig
  private rules: ReplyRule[]
  private aiProvider: AiProviderConfig

  constructor(seed: { global?: ReplyGlobalConfig; rules?: ReplyRule[]; aiProvider?: AiProviderConfig } = {}) {
    this.globalConfig = { ...(seed.global ?? DEFAULT_REPLY_GLOBAL_CONFIG) }
    this.rules = normalizeReplyRules(seed.rules ?? [])
    this.aiProvider = { ...(seed.aiProvider ?? DEFAULT_AI_PROVIDER_CONFIG) }
  }

  async loadGlobalConfig(): Promise<ReplyGlobalConfig> {
    return { ...this.globalConfig, blacklist: [...this.globalConfig.blacklist], handoffKeywords: [...this.globalConfig.handoffKeywords] }
  }

  async saveGlobalConfig(config: ReplyGlobalConfig): Promise<void> {
    this.globalConfig = { ...config }
  }

  async loadRules(): Promise<ReplyRule[]> {
    return normalizeReplyRules(this.rules)
  }

  async saveRules(rules: ReplyRule[]): Promise<void> {
    this.rules = normalizeReplyRules(rules)
  }

  async loadAiProvider(): Promise<AiProviderConfig> {
    return { ...this.aiProvider }
  }

  async saveAiProvider(config: AiProviderConfig): Promise<void> {
    this.aiProvider = { ...config }
  }
}

/** 可选 mock 种子。 */
export interface MockReplyConfigSeed {
  global?: Partial<ReplyGlobalConfig>
  rules?: ReplyRule[]
  aiProvider?: Partial<AiProviderConfig>
}

/**
 * Mock 配置存储：在内存实现上叠加默认值，便于测试与本地演示。
 * 注意：mock 的 API key 只存在于该实例内，不会写日志 / 事件。
 */
export class MockReplyConfigStore extends MemoryReplyConfigStore {
  constructor(seed: MockReplyConfigSeed = {}) {
    super({
      global: { ...DEFAULT_REPLY_GLOBAL_CONFIG, ...seed.global },
      rules: seed.rules ?? [],
      aiProvider: { ...DEFAULT_AI_PROVIDER_CONFIG, ...seed.aiProvider },
    })
  }
}

/** 便捷工厂。 */
export function createMockReplyConfigStore(seed: MockReplyConfigSeed = {}): ReplyConfigStore {
  return new MockReplyConfigStore(seed)
}
