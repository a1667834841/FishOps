/**
 * 提示词规则存储与持久化适配器（PromptRuleStore）（P7）。
 *
 * 隔离持久化接口与具体介质（内存 MemoryPromptRuleStore、Chrome 存储 StoragePromptRuleStore），
 * 并提供开箱即用的预设内置分析规则。
 */
import type { PromptRule } from '../types/analysis'
import { validatePromptRule } from './prompt-rule-validator'

/** 提示词规则持久化仓储接口。 */
export interface PromptRuleStore {
  /** 获取所有规则。 */
  list(): Promise<PromptRule[]>
  /** 按 ID 获取单个规则。 */
  get(id: string): Promise<PromptRule | null>
  /** 创建或更新规则（自动执行合规性与敏感信息校验）。 */
  upsert(rule: PromptRule): Promise<PromptRule>
  /** 按 ID 删除规则。 */
  delete(id: string): Promise<boolean>
}

/** 内置默认分析规则。 */
export const DEFAULT_PROMPT_RULES: PromptRule[] = [
  {
    id: 'rule_high_demand_low_competition',
    name: '高需求低竞争机会挖掘',
    description: '分析当前商品数据中想要人数高、价格合理但竞争相对较小的蓝海品类或属性',
    systemPrompt: `你是一名资深的闲鱼电商数据分析专家。请根据提供的数据集统计与抽样样本，分析高需求低竞争的品类与机会。
必须以纯 JSON 格式输出，不要包含 Markdown 标记或其他文字。输出结构必须符合：
{
  "summary": "整体市场概览",
  "keyFindings": ["发现1", "发现2"],
  "priceAnalysis": {
    "avgPrice": 0,
    "medianPrice": 0,
    "priceRange": "主要价格分布区间",
    "recommendation": "建议切入定价"
  },
  "opportunities": ["机会点1", "机会点2"],
  "risks": ["潜在风险1", "风险2"]
}`,
    userPromptTemplate: `请分析以下闲鱼商品数据：
【整体概况】
{{summary}}

【抽样数据（共 {{rowCount}} 条）】
{{dataset}}

{{customInstructions}}`,
    variables: ['summary', 'rowCount', 'dataset', 'customInstructions'],
    createdAt: 1727827200000,
    updatedAt: 1727827200000,
  },
  {
    id: 'rule_price_strategy',
    name: '定价策略与竞争区间分析',
    description: '通过对市场价格分布、想要人数与卖家地域的分析，给出最具竞争力的定价策略',
    systemPrompt: `你是一名闲鱼商品定价与竞争策略专家。
请根据传入的商品市场统计数据与样本，分析价格梯度与买家接受度。
必须以纯 JSON 格式输出：
{
  "summary": "定价环境分析",
  "keyFindings": ["价格梯度规律1", "特征2"],
  "priceAnalysis": {
    "avgPrice": 0,
    "medianPrice": 0,
    "priceRange": "主流出单价格带",
    "recommendation": "新上架推荐定价与打法"
  },
  "opportunities": ["定价空间与利润点"],
  "risks": ["低价内卷或滞销风险"]
}`,
    userPromptTemplate: `请为以下商品市场制定定价策略：
【数据总览】
{{summary}}

【样本明细】
{{dataset}}

{{customInstructions}}`,
    variables: ['summary', 'dataset', 'customInstructions'],
    createdAt: 1727827200000,
    updatedAt: 1727827200000,
  },
]

/** 内存版规则存储（用于 Node 测试与默认回退）。 */
export class MemoryPromptRuleStore implements PromptRuleStore {
  private readonly rules = new Map<string, PromptRule>()

  constructor(initialRules: PromptRule[] = DEFAULT_PROMPT_RULES) {
    for (const rule of initialRules) {
      this.rules.set(rule.id, { ...rule })
    }
  }

  async list(): Promise<PromptRule[]> {
    return Array.from(this.rules.values()).map((r) => ({ ...r }))
  }

  async get(id: string): Promise<PromptRule | null> {
    const found = this.rules.get(id)
    return found ? { ...found } : null
  }

  async upsert(rule: PromptRule): Promise<PromptRule> {
    const validation = validatePromptRule(rule)
    if (!validation.valid) {
      throw new Error(`提示词规则校验未通过: ${validation.errors.join('; ')}`)
    }
    const now = Date.now()
    const stored: PromptRule = {
      ...rule,
      updatedAt: now,
      createdAt: rule.createdAt || now,
    }
    this.rules.set(stored.id, stored)
    return { ...stored }
  }

  async delete(id: string): Promise<boolean> {
    return this.rules.delete(id)
  }
}

/** 简单的外部持久化存储适配器抽象（适配 chrome.storage.local）。 */
export interface KeyValueStorage {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

const STORAGE_RULE_KEY = 'fishops.prompt_rules'

/** 基于 KeyValueStorage (如 chrome.storage.local) 的规则存储。 */
export class StoragePromptRuleStore implements PromptRuleStore {
  private readonly storage: KeyValueStorage
  private memoryCache: Map<string, PromptRule> | null = null

  constructor(storage: KeyValueStorage) {
    this.storage = storage
  }

  private async ensureLoaded(): Promise<Map<string, PromptRule>> {
    if (this.memoryCache) return this.memoryCache
    const data = await this.storage.get([STORAGE_RULE_KEY])
    const rawList = data[STORAGE_RULE_KEY]
    const map = new Map<string, PromptRule>()

    if (Array.isArray(rawList) && rawList.length > 0) {
      for (const item of rawList) {
        if (item && typeof item.id === 'string') {
          map.set(item.id, item as PromptRule)
        }
      }
    } else {
      // 首次加载无数据时初始化内置规则
      for (const def of DEFAULT_PROMPT_RULES) {
        map.set(def.id, { ...def })
      }
      await this.storage.set({ [STORAGE_RULE_KEY]: Array.from(map.values()) })
    }

    this.memoryCache = map
    return map
  }

  async list(): Promise<PromptRule[]> {
    const map = await this.ensureLoaded()
    return Array.from(map.values()).map((r) => ({ ...r }))
  }

  async get(id: string): Promise<PromptRule | null> {
    const map = await this.ensureLoaded()
    const found = map.get(id)
    return found ? { ...found } : null
  }

  async upsert(rule: PromptRule): Promise<PromptRule> {
    const validation = validatePromptRule(rule)
    if (!validation.valid) {
      throw new Error(`提示词规则校验未通过: ${validation.errors.join('; ')}`)
    }
    const map = await this.ensureLoaded()
    const now = Date.now()
    const stored: PromptRule = {
      ...rule,
      updatedAt: now,
      createdAt: rule.createdAt || now,
    }
    map.set(stored.id, stored)
    await this.storage.set({ [STORAGE_RULE_KEY]: Array.from(map.values()) })
    return { ...stored }
  }

  async delete(id: string): Promise<boolean> {
    const map = await this.ensureLoaded()
    const existed = map.delete(id)
    if (existed) {
      await this.storage.set({ [STORAGE_RULE_KEY]: Array.from(map.values()) })
    }
    return existed
  }
}
