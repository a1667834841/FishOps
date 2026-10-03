/**
 * 数据集聚合、抽样与脱敏处理器（P7）。
 *
 * 核心安全与控制原则：
 * 1. 字段白名单：仅允许必要业务属性（itemId、title、priceNumber、wantCnt、sellerCity、freeShip、tags、publishTime）送入 LLM；
 * 2. 文本脱敏：自动检测并掩码手机号、微信号、QQ 等联系方式；
 * 3. 字段截断：标题最多 80 字符，标签最多 50 字符，整体采样条数受限；
 * 4. 统计聚合：预先计算均价、中位数、想要人数分布与 Top 城市，避免长文本送模与超 Token。
 */
import type { Dataset, DatasetRow } from '../types/dataset'

/** 送入 LLM 分析的商品字段白名单。 */
export const LLM_PRODUCT_FIELD_WHITELIST: ReadonlySet<string> = new Set([
  'itemId',
  'title',
  'priceNumber',
  'originalPriceNumber',
  'wantCnt',
  'sellerCity',
  'freeShip',
  'tags',
  'publishTime',
])

/** 聚合分析指标概览。 */
export interface DatasetSummary {
  /** 统计的总商品数。 */
  totalCount: number
  /** 价格指标。 */
  price: {
    min: number
    max: number
    avg: number
    median: number
  }
  /** 想要人数指标。 */
  want: {
    min: number
    max: number
    avg: number
    total: number
  }
  /** 包邮商品数及比例。 */
  freeShipCount: number
  freeShipRatio: number
  /** 主要卖家城市 Top 5。 */
  topCities: Array<{ city: string; count: number }>
  /** 高频标签 Top 5。 */
  topTags: Array<{ tag: string; count: number }>
}

/** 手机号识别正则（支持带中国区号）。 */
const PHONE_REGEX = /(?:(?:\+|00)86)?1[3-9]\d{9}/g
/** 社交账号/微信号特征正则。 */
const SOCIAL_REGEX = /(?:vx|weixin|wx|微信|扣扣|qq|企鹅)\s*[:：=]?\s*([a-zA-Z0-9_-]{5,20})/gi
/** 身份证号正则。 */
const ID_CARD_REGEX = /\d{17}[\dXx]/g

/**
 * 文本脱敏：对手机号、微信、身份证做星号遮盖，并剔除危险字符。
 */
export function sanitizeText(text: string): string {
  if (!text) return ''
  let sanitized = text
    .replace(PHONE_REGEX, (match) => {
      const pure = match.slice(-11)
      return `${pure.slice(0, 3)}****${pure.slice(7)}`
    })
    .replace(SOCIAL_REGEX, (match) => {
      return match.replace(/[a-zA-Z0-9_-]{4,}$/, '****')
    })
    .replace(ID_CARD_REGEX, (match) => {
      return `${match.slice(0, 6)}********${match.slice(14)}`
    })
  return sanitized
}

/**
 * 单条商品记录脱敏与白名单过滤。
 */
export function sanitizeProductForLLM(row: DatasetRow): DatasetRow {
  const result: DatasetRow = {}

  for (const key of LLM_PRODUCT_FIELD_WHITELIST) {
    const value = row[key]
    if (value === undefined || value === null) continue

    if (key === 'title') {
      const text = typeof value === 'string' ? value : String(value)
      // 脱敏并截断到 80 字符
      result[key] = sanitizeText(text).slice(0, 80)
    } else if (key === 'tags') {
      const text = typeof value === 'string' ? value : String(value)
      result[key] = sanitizeText(text).slice(0, 50)
    } else if (key === 'sellerCity') {
      result[key] = typeof value === 'string' ? value.slice(0, 20) : String(value)
    } else if (typeof value === 'string') {
      result[key] = sanitizeText(value).slice(0, 100)
    } else {
      result[key] = value
    }
  }

  return result
}

/**
 * 对数据集进行抽样。
 *
 * 优先按想要人数降序排列，并进行头部、中部、尾部分层采样，最多抽取 limit 条（默认 20，最大 50）。
 */
export function sampleDataset(dataset: Dataset, limit = 20): DatasetRow[] {
  const safeLimit = Math.min(Math.max(limit, 1), 50)
  const rows = dataset.rows

  if (rows.length <= safeLimit) {
    return rows.map(sanitizeProductForLLM)
  }

  // 按想要人数降序排序后抽样
  const sorted = [...rows].sort((a, b) => {
    const wantA = Number(a['wantCnt']) || 0
    const wantB = Number(b['wantCnt']) || 0
    return wantB - wantA
  })

  const sampled: DatasetRow[] = []
  // 头部取 50%
  const topCount = Math.ceil(safeLimit * 0.5)
  for (let i = 0; i < topCount && i < sorted.length; i++) {
    sampled.push(sorted[i]!)
  }

  // 中部均匀采样剩余部分
  const remaining = safeLimit - sampled.length
  if (remaining > 0 && sorted.length > topCount) {
    const step = (sorted.length - topCount) / remaining
    for (let i = 0; i < remaining; i++) {
      const idx = Math.min(Math.floor(topCount + i * step), sorted.length - 1)
      sampled.push(sorted[idx]!)
    }
  }

  return sampled.map(sanitizeProductForLLM)
}

/**
 * 聚合数据集统计指标。
 */
export function aggregateDataset(dataset: Dataset): DatasetSummary {
  const rows = dataset.rows
  const totalCount = dataset.total || rows.length

  if (rows.length === 0) {
    return {
      totalCount: 0,
      price: { min: 0, max: 0, avg: 0, median: 0 },
      want: { min: 0, max: 0, avg: 0, total: 0 },
      freeShipCount: 0,
      freeShipRatio: 0,
      topCities: [],
      topTags: [],
    }
  }

  const prices: number[] = []
  let wantTotal = 0
  let wantMin = Infinity
  let wantMax = -Infinity
  let freeShipCount = 0
  const cityCounts = new Map<string, number>()
  const tagCounts = new Map<string, number>()

  for (const row of rows) {
    const p = Number(row['priceNumber'] ?? row['price'])
    if (!Number.isNaN(p) && p >= 0) {
      prices.push(p)
    }

    const want = Number(row['wantCnt']) || 0
    wantTotal += want
    if (want < wantMin) wantMin = want
    if (want > wantMax) wantMax = want

    if (row['freeShip'] === '是') {
      freeShipCount += 1
    }

    const city = typeof row['sellerCity'] === 'string' ? row['sellerCity'].trim() : ''
    if (city) {
      cityCounts.set(city, (cityCounts.get(city) || 0) + 1)
    }

    const tagsStr = typeof row['tags'] === 'string' ? row['tags'] : ''
    if (tagsStr) {
      const tags = tagsStr.split(/[、,，\s]+/).filter(Boolean)
      for (const t of tags) {
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1)
      }
    }
  }

  prices.sort((a, b) => a - b)
  const priceMin = prices[0] ?? 0
  const priceMax = prices[prices.length - 1] ?? 0
  const priceSum = prices.reduce((acc, cur) => acc + cur, 0)
  const priceAvg = prices.length > 0 ? Number((priceSum / prices.length).toFixed(2)) : 0
  const medianIndex = Math.floor(prices.length / 2)
  const priceMedian = prices.length === 0
    ? 0
    : prices.length % 2 === 0
      ? Number(((prices[medianIndex - 1]! + prices[medianIndex]!) / 2).toFixed(2))
      : prices[medianIndex]!

  const wantAvg = rows.length > 0 ? Number((wantTotal / rows.length).toFixed(1)) : 0

  const topCities = Array.from(cityCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([city, count]) => ({ city, count }))

  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag, count]) => ({ tag, count }))

  return {
    totalCount,
    price: {
      min: priceMin,
      max: priceMax,
      avg: priceAvg,
      median: priceMedian,
    },
    want: {
      min: wantMin === Infinity ? 0 : wantMin,
      max: wantMax === -Infinity ? 0 : wantMax,
      avg: wantAvg,
      total: wantTotal,
    },
    freeShipCount,
    freeShipRatio: rows.length > 0 ? Number((freeShipCount / rows.length).toFixed(2)) : 0,
    topCities,
    topTags,
  }
}

/**
 * 将聚合统计对象格式化为清晰易读的纯文本概括。
 */
export function formatDatasetSummary(summary: DatasetSummary): string {
  const cityStr = summary.topCities.map((c) => `${c.city}(${c.count})`).join('、') || '暂无'
  const tagStr = summary.topTags.map((t) => `${t.tag}(${t.count})`).join('、') || '暂无'

  return `商品总数: ${summary.totalCount} 件
价格区间: ¥${summary.price.min} ~ ¥${summary.price.max}（均价: ¥${summary.price.avg}，中位数: ¥${summary.price.median}）
想要人数: 平均 ${summary.want.avg} 人（最高 ${summary.want.max} 人，总计 ${summary.want.total} 人）
包邮比例: ${(summary.freeShipRatio * 100).toFixed(0)}% (${summary.freeShipCount} 件)
主要地区: ${cityStr}
高频标签: ${tagStr}`
}

/**
 * 填充模板变量生成最终送模 Prompt。
 */
export function renderPromptTemplate(
  template: string,
  context: Record<string, string | number>,
): string {
  let rendered = template
  for (const [key, value] of Object.entries(context)) {
    const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g')
    rendered = rendered.replace(pattern, String(value))
  }
  // 清理未匹配到的空变量占位符
  rendered = rendered.replace(/\{\{\s*[a-zA-Z0-9_]+\s*\}\}/g, '')
  return rendered.trim()
}
