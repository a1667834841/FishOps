/**
 * 飞书配置存储适配器（P7 / 迁移目标）。
 *
 * 与 P6 AI 配置一样，飞书凭据（`appSecret`、`spreadsheetToken` 等）**只写入
 * `chrome.storage.local` 的专用键**，并在对外返回时只暴露 `configured: boolean`；
 * 绝不进入规则、日志、事件或 Workbench 的持久化数据。
 *
 * 通过 {@link FeishuStorageLike} 抽象存储介质，可在 Node 中用 mock 测试。
 */
import type { FeishuConfig } from '../../../shared/data-source/feishu-types'

/** 飞书配置专用存储键。 */
export const FEISHU_CONFIG_KEY = 'fishops.analysis.feishuConfig'

/** `chrome.storage.local` 的最小子集。 */
export interface FeishuStorageLike {
  get(keys: string | string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

/** 飞书配置存储接口。 */
export interface FeishuConfigStore {
  /** 读取飞书配置；未配置返回 null。 */
  load(): Promise<FeishuConfig | null>
  /** 写入飞书配置（仅本适配器持有明文）。 */
  save(config: FeishuConfig): Promise<void>
  /** 是否已配置（只回布尔）。 */
  hasConfig(): Promise<boolean>
}

/** 判断对象是否为合法的飞书配置（字段白名单 + 类型校验）。 */
export function isFeishuConfig(value: unknown): value is FeishuConfig {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record['appId'] === 'string' &&
    typeof record['appSecret'] === 'string' &&
    typeof record['spreadsheetToken'] === 'string' &&
    typeof record['productTableId'] === 'string' &&
    (record['sellerTableId'] === undefined || typeof record['sellerTableId'] === 'string')
  )
}

/** 规整飞书配置：只保留已知字段，避免额外键（含未知敏感键）落库。 */
export function sanitizeFeishuConfig(config: FeishuConfig): FeishuConfig {
  return {
    appId: config.appId,
    appSecret: config.appSecret,
    spreadsheetToken: config.spreadsheetToken,
    productTableId: config.productTableId,
    ...(config.sellerTableId === undefined ? {} : { sellerTableId: config.sellerTableId }),
  }
}

/** 内存实现（测试 / 无持久化环境）。 */
export class MemoryFeishuConfigStore implements FeishuConfigStore {
  private config: FeishuConfig | null

  constructor(seed: FeishuConfig | null = null) {
    this.config = seed ? sanitizeFeishuConfig(seed) : null
  }

  async load(): Promise<FeishuConfig | null> {
    return this.config ? { ...this.config } : null
  }

  async save(config: FeishuConfig): Promise<void> {
    this.config = sanitizeFeishuConfig(config)
  }

  async hasConfig(): Promise<boolean> {
    return this.config !== null
  }
}

/** 基于 `chrome.storage.local` 的飞书配置存储。 */
export class ChromeFeishuConfigStore implements FeishuConfigStore {
  private readonly storage: FeishuStorageLike

  constructor(storage: FeishuStorageLike) {
    this.storage = storage
  }

  async load(): Promise<FeishuConfig | null> {
    const stored = await this.storage.get(FEISHU_CONFIG_KEY)
    const value = stored[FEISHU_CONFIG_KEY]
    return isFeishuConfig(value) ? sanitizeFeishuConfig(value) : null
  }

  async save(config: FeishuConfig): Promise<void> {
    await this.storage.set({ [FEISHU_CONFIG_KEY]: sanitizeFeishuConfig(config) })
  }

  async hasConfig(): Promise<boolean> {
    return (await this.load()) !== null
  }
}
