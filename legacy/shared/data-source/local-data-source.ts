/**
 * 本地商品库数据源实现（LocalDataSource）。
 *
 * 包装 P4 的 ProductRepository，提供统一的 Schema 与增强过滤功能（关键词、价格、想要数、时间、包邮等），
 * 并实施安全截断（条数上限 500，单字段最长 1000 字符），防止内存超载。
 */
import type { DataSource } from './data-source'
import type {
  Dataset,
  DatasetFilter,
  DatasetRow,
  DatasetSchema,
} from '../types/dataset'
import {
  DATASET_DEFAULT_LIMIT,
  DATASET_MAX_LIMIT,
  DATASET_MAX_TEXT_LENGTH,
} from '../types/dataset'
import type { Product } from '../types/product'
import type { ProductRepository } from '../capture/product-repository'

/** 本地商品库的数据集 Schema 定义。 */
export const LOCAL_PRODUCT_DATASET_SCHEMA: DatasetSchema = {
  name: 'local_products',
  label: '本地采集商品库',
  description: '由扩展本地采集并持久化在 IndexedDB / 内存中的闲鱼商品数据集',
  fields: [
    { name: 'itemId', label: '商品ID', type: 'string', required: true, description: '闲鱼商品全局唯一ID' },
    { name: 'title', label: '商品标题', type: 'string', required: true, description: '商品名称与标题' },
    { name: 'desc', label: '商品描述', type: 'string', description: '从商品详情页采集的真实描述；未采集时为空' },
    { name: 'price', label: '价格原文', type: 'string', required: true, description: '带货币符号的价格字符串' },
    { name: 'priceNumber', label: '价格数值', type: 'number', required: true, description: '解析后的数值价格（单位：元）' },
    { name: 'originalPrice', label: '原价原文', type: 'string', description: '划线原价或购买原价字符串' },
    { name: 'originalPriceNumber', label: '原价数值', type: 'number', description: '划线原价数值（元）' },
    { name: 'wantCnt', label: '想要人数', type: 'number', required: true, description: '点击「想要」的买家数量' },
    { name: 'publishTime', label: '发布时间', type: 'string', description: '相对发布时间或日期' },
    { name: 'publishTimeMs', label: '发布时间戳', type: 'datetime', description: '发布毫秒时间戳' },
    { name: 'captureTime', label: '采集时间', type: 'string', description: '采集时的日期时间' },
    { name: 'captureTimeMs', label: '采集时间戳', type: 'datetime', description: '采集毫秒时间戳' },
    { name: 'sellerNick', label: '卖家昵称', type: 'string', description: '卖家展示昵称' },
    { name: 'sellerCity', label: '卖家地区', type: 'string', description: '商品所在省市地理位置' },
    { name: 'freeShip', label: '是否包邮', type: 'string', description: '是/否' },
    { name: 'tags', label: '商品标签', type: 'string', description: '商品包含的标签列表（顿号分隔）' },
    { name: 'coverUrl', label: '封面URL', type: 'url', description: '商品封面主图网络地址' },
    { name: 'detailUrl', label: '详情页URL', type: 'url', description: '闲鱼商品网页端详情链接' },
    { name: 'browseCnt', label: '浏览量', type: 'number', description: '商品页面累计浏览次数（详情补充）' },
    { name: 'collectCnt', label: '收藏数', type: 'number', description: '收藏买家数（详情补充）' },
  ],
}

/** 本地数据源选项。 */
export interface LocalDataSourceOptions {
  /** 注入的 ProductRepository。 */
  repository: ProductRepository
  /** 时间提供者，便于测试时固定时间。 */
  now?: () => number
}

/** 本地数据源实现类。 */
export class LocalDataSource implements DataSource {
  readonly type = 'local'
  readonly name = '本地商品库'

  private readonly repository: ProductRepository
  private readonly now: () => number

  constructor(options: LocalDataSourceOptions) {
    this.repository = options.repository
    this.now = options.now ?? (() => Date.now())
  }

  async getSchema(): Promise<DatasetSchema> {
    return LOCAL_PRODUCT_DATASET_SCHEMA
  }

  async query(filter?: DatasetFilter): Promise<Dataset> {
    // 从底层仓储获取基础数据（传一个较大上限获取候选集以执行全字段联合过滤）。
    // 本地商品库分析语境下按全量商品取数（含竞品 / 存量记录），故显式传 source: 'all'，
    // 不因仓储缺省安全默认（my_published）而遗漏商品。
    const candidateLimit = Math.max(DATASET_MAX_LIMIT * 2, 1000)
    const page = await this.repository.list({
      keyword: filter?.keyword?.trim() || undefined,
      limit: candidateLimit,
      source: 'all',
    })

    let filtered = page.products

    // 1. 价格区间过滤
    if (filter?.minPrice !== undefined) {
      const min = filter.minPrice
      filtered = filtered.filter((p) => p.priceNumber >= min)
    }
    if (filter?.maxPrice !== undefined) {
      const max = filter.maxPrice
      filtered = filtered.filter((p) => p.priceNumber <= max)
    }

    // 2. 想要人数过滤
    if (filter?.minWantCnt !== undefined) {
      const minWant = filter.minWantCnt
      filtered = filtered.filter((p) => p.wantCnt >= minWant)
    }
    if (filter?.maxWantCnt !== undefined) {
      const maxWant = filter.maxWantCnt
      filtered = filtered.filter((p) => p.wantCnt <= maxWant)
    }

    // 3. 包邮过滤
    if (filter?.onlyFreeShip === true) {
      filtered = filtered.filter((p) => p.freeShip === '是')
    }

    // 4. 时间范围过滤（按 publishTimeMs 或 captureTimeMs）
    if (filter?.startTime !== undefined || filter?.endTime !== undefined) {
      const timeFieldKey = filter.timeField === 'publishTimeMs' ? 'publishTimeMs' : 'captureTimeMs'
      const start = filter.startTime ?? -Infinity
      const end = filter.endTime ?? Infinity
      filtered = filtered.filter((p) => {
        const timeVal = p[timeFieldKey]
        return typeof timeVal === 'number' && timeVal >= start && timeVal <= end
      })
    }

    const total = filtered.length

    // 5. 分页处理并实施硬性上限约束（最大 500 条）
    const offset = Math.max(filter?.offset ?? 0, 0)
    const rawLimit = filter?.limit ?? DATASET_DEFAULT_LIMIT
    const safeLimit = Math.min(Math.max(rawLimit, 1), DATASET_MAX_LIMIT)

    const sliced = filtered.slice(offset, offset + safeLimit)
    const truncated = total > safeLimit

    // 6. 转换为 DatasetRow 并执行单字段字符长度安全截断
    const rows: DatasetRow[] = sliced.map((product) => this.sanitizeProductRow(product))

    return {
      schema: LOCAL_PRODUCT_DATASET_SCHEMA,
      rows,
      total,
      source: 'local',
      queriedAt: this.now(),
      truncated,
    }
  }

  /**
   * 将商品转为数据行，并限制单文本字段长度不超过上限，避免超长字符串
   */
  private sanitizeProductRow(product: Product): DatasetRow {
    const row: DatasetRow = {}
    for (const [key, value] of Object.entries(product)) {
      if (typeof value === 'string') {
        row[key] = value.length > DATASET_MAX_TEXT_LENGTH
          ? value.slice(0, DATASET_MAX_TEXT_LENGTH)
          : value
      } else if (Array.isArray(value)) {
        // 图片数组等可能包含大量 URL，最多保留 5 个并做单项截断
        row[key] = value.slice(0, 5).map((item) =>
          typeof item === 'string' && item.length > DATASET_MAX_TEXT_LENGTH
            ? item.slice(0, DATASET_MAX_TEXT_LENGTH)
            : item,
        )
      } else {
        row[key] = value
      }
    }
    return row
  }
}
