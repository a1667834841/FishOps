/**
 * P6 `chrome.storage.local` 配置适配器（隔离层）。
 *
 * 把 `ReplyConfigStore` 落到 chrome.storage.local：
 * - 全局设置与规则使用**不同键**，规则写入前经字段白名单净化（绝不落 API key）；
 * - AI 凭据单独一个键，只在本适配器读取，**不进入规则 / 日志 / 事件**；
 * - 载入时做运行时校验，非法数据回退默认值（不抛错，避免脏数据拖垮 background）。
 *
 * 通过 {@link StorageLocalLike} 抽象 `chrome.storage.local`，可在 Node 中用 mock 测试。
 */
import {
  DEFAULT_AI_PROVIDER_CONFIG,
  DEFAULT_REPLY_GLOBAL_CONFIG,
  type AiProviderConfig,
  type ReplyGlobalConfig,
  type ReplyRule,
} from '../../../shared/types/reply'
import {
  isAiProviderConfig,
  isReplyGlobalConfig,
  isReplyRuleList,
  sanitizeReplyRules,
} from '../../../shared/reply/index'
import {
  REPLY_AI_PROVIDER_KEY,
  REPLY_GLOBAL_CONFIG_KEY,
  REPLY_RULES_KEY,
  type ReplyConfigStore,
} from './reply-config'

/** `chrome.storage.local` 的最小子集。 */
export interface StorageLocalLike {
  get(keys: string | string[] | Record<string, unknown>): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

/** 适配器选项。 */
export interface ChromeReplyConfigStoreOptions {
  /** 非致命告警回调（用于记录「配置非法，已回退默认」；不传任何凭据）。 */
  onWarn?: (message: string) => void
}

/** 基于 chrome.storage.local 的回复配置存储。 */
export class ChromeReplyConfigStore implements ReplyConfigStore {
  private readonly storage: StorageLocalLike
  private readonly warn: (message: string) => void

  constructor(storage: StorageLocalLike, options: ChromeReplyConfigStoreOptions = {}) {
    this.storage = storage
    this.warn = options.onWarn ?? (() => {})
  }

  async loadGlobalConfig(): Promise<ReplyGlobalConfig> {
    const stored = await this.storage.get(REPLY_GLOBAL_CONFIG_KEY)
    const value = stored[REPLY_GLOBAL_CONFIG_KEY]
    if (value === undefined) return { ...DEFAULT_REPLY_GLOBAL_CONFIG }
    if (!isReplyGlobalConfig(value)) {
      this.warn('回复全局配置非法，已回退默认值')
      return { ...DEFAULT_REPLY_GLOBAL_CONFIG }
    }
    // 与默认值合并，兼容未来新增字段缺省。
    return { ...DEFAULT_REPLY_GLOBAL_CONFIG, ...value }
  }

  async saveGlobalConfig(config: ReplyGlobalConfig): Promise<void> {
    await this.storage.set({ [REPLY_GLOBAL_CONFIG_KEY]: config })
  }

  async loadRules(): Promise<ReplyRule[]> {
    const stored = await this.storage.get(REPLY_RULES_KEY)
    const value = stored[REPLY_RULES_KEY]
    if (value === undefined) return []
    if (!isReplyRuleList(value)) {
      this.warn('回复规则非法，已忽略并回退为空列表')
      return []
    }
    // 二次净化：即便历史数据混入额外字段，也不会带进运行时。
    return sanitizeReplyRules(value)
  }

  async saveRules(rules: ReplyRule[]): Promise<void> {
    await this.storage.set({ [REPLY_RULES_KEY]: sanitizeReplyRules(rules) })
  }

  async loadAiProvider(): Promise<AiProviderConfig> {
    const stored = await this.storage.get(REPLY_AI_PROVIDER_KEY)
    const value = stored[REPLY_AI_PROVIDER_KEY]
    if (value === undefined) return { ...DEFAULT_AI_PROVIDER_CONFIG }
    if (!isAiProviderConfig(value)) {
      this.warn('AI 供应方配置非法，已回退默认值（未配置）')
      return { ...DEFAULT_AI_PROVIDER_CONFIG }
    }
    return { ...DEFAULT_AI_PROVIDER_CONFIG, ...value }
  }

  async saveAiProvider(config: AiProviderConfig): Promise<void> {
    await this.storage.set({ [REPLY_AI_PROVIDER_KEY]: config })
  }
}
