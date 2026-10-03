/**
 * 飞书多维表格数据源实现（FeishuDataSource）。
 *
 * 迁移旧版 `main:background.js` 飞书同步与查询逻辑：
 * 1. 租户访问令牌缓存与提前 5 分钟过期自动刷新；
 * 2. 字段映射（文本=1, 数值=2, 日期=5, 链接=15）；
 * 3. 分页查询 records 与获取已有商品组合键去重；
 * 4. 批量写入自动切片（限制单批 <= 500 条）；
 * 5. 全面分类错误（FeishuError），注入 HttpTransport 保证在 Node 单测时不发真实请求；
 * 6. 严禁在日志中输出 appSecret 和 token。
 */
import type { DataSource } from './data-source'
import type { Dataset, DatasetFieldType, DatasetRow, DatasetSchema } from '../types/dataset'
import { DATASET_DEFAULT_LIMIT, DATASET_MAX_LIMIT, DATASET_MAX_TEXT_LENGTH } from '../types/dataset'
import type { Product } from '../types/product'
import type {
  FeishuConfig,
  FeishuFieldConfig,
  FeishuTableField,
  HttpTransport,
} from './feishu-types'
import {
  FEISHU_MAX_BATCH_SIZE,
  FEISHU_PRODUCT_FIELD_CONFIGS,
  FeishuError,
  buildFeishuProductDedupeKey,
} from './feishu-types'

const FEISHU_API_BASE = 'https://open.feishu.cn'

/** 默认的 Node / 浏览器原生 fetch 传输器。 */
const defaultTransport: HttpTransport = {
  fetch: (url, init) => fetch(url, init),
}

export interface FeishuDataSourceOptions {
  config: FeishuConfig
  transport?: HttpTransport
  now?: () => number
}

export class FeishuDataSource implements DataSource {
  readonly type = 'feishu'
  readonly name = '飞书多维表格'

  private readonly config: FeishuConfig
  private readonly transport: HttpTransport
  private readonly now: () => number

  private tenantAccessToken: string | null = null
  private tokenExpireTime = 0

  constructor(options: FeishuDataSourceOptions) {
    if (!options.config.appId || !options.config.appSecret) {
      throw new FeishuError('飞书配置缺少 appId 或 appSecret', 'INVALID_PARAM')
    }
    if (!options.config.spreadsheetToken || !options.config.productTableId) {
      throw new FeishuError('飞书配置缺少 spreadsheetToken 或 productTableId', 'INVALID_PARAM')
    }
    this.config = options.config
    this.transport = options.transport ?? defaultTransport
    this.now = options.now ?? (() => Date.now())
  }

  /** 获取租户访问令牌（带提前 5 分钟过期缓存）。 */
  async getTenantAccessToken(): Promise<string> {
    const currentTime = this.now()
    if (this.tenantAccessToken && currentTime < this.tokenExpireTime) {
      return this.tenantAccessToken
    }

    try {
      const response = await this.transport.fetch(
        `${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_id: this.config.appId,
            app_secret: this.config.appSecret,
          }),
        },
      )

      if (!response.ok) {
        throw new FeishuError(
          `获取飞书访问令牌 HTTP 失败: ${response.status}`,
          'AUTH_FAILED',
        )
      }

      const data = await response.json()
      if (data.code !== 0) {
        throw new FeishuError(
          data.msg || '获取飞书租户访问令牌失败',
          'AUTH_FAILED',
          data.code,
        )
      }

      this.tenantAccessToken = data.tenant_access_token
      // 提前 5 分钟 (300 秒) 过期
      const expireSeconds = Math.max(data.expire ?? 7200, 600)
      this.tokenExpireTime = currentTime + (expireSeconds - 300) * 1000

      return this.tenantAccessToken!
    } catch (error) {
      if (error instanceof FeishuError) throw error
      throw new FeishuError(
        `获取飞书令牌网络异常: ${error instanceof Error ? error.message : String(error)}`,
        'NETWORK_ERROR',
      )
    }
  }

  /** 获取数据表字段 Schema。 */
  async getSchema(): Promise<DatasetSchema> {
    const token = await this.getTenantAccessToken()
    try {
      const url = `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${this.config.spreadsheetToken}/tables/${this.config.productTableId}/fields`
      const response = await this.transport.fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        throw new FeishuError(`获取飞书表字段 HTTP 失败: ${response.status}`, 'API_ERROR')
      }

      const data = await response.json()
      if (data.code !== 0) {
        throw new FeishuError(data.msg || '获取飞书表格字段失败', 'API_ERROR', data.code)
      }

      const rawFields = (data.data?.items ?? []) as Array<{ field_name: string; type: number }>
      const fields = rawFields.map((f) => ({
        name: f.field_name,
        label: f.field_name,
        type: mapFeishuTypeToDatasetType(f.type),
      }))

      return {
        name: 'feishu_bitable',
        label: '飞书多维表格',
        description: `多维表格 app=${this.config.spreadsheetToken}, table=${this.config.productTableId}`,
        fields,
      }
    } catch (error) {
      // 网络或结构失败时回退静态 Schema 映射
      if (error instanceof FeishuError) throw error
      return {
        name: 'feishu_bitable',
        label: '飞书多维表格',
        fields: FEISHU_PRODUCT_FIELD_CONFIGS.map((c) => ({
          name: c.name,
          label: c.name,
          type: mapFeishuTypeToDatasetType(c.type),
        })),
      }
    }
  }

  /** 查询飞书表格数据。 */
  async query(params?: {
    pageSize?: number
    pageToken?: string
    maxRecords?: number
  }): Promise<Dataset> {
    const token = await this.getTenantAccessToken()
    const limit = Math.min(params?.maxRecords ?? DATASET_DEFAULT_LIMIT, DATASET_MAX_LIMIT)
    const pageSize = Math.min(params?.pageSize ?? 100, FEISHU_MAX_BATCH_SIZE)

    let pageToken = params?.pageToken
    const allRows: DatasetRow[] = []
    let hasMore = true

    try {
      while (hasMore && allRows.length < limit) {
        const url = new URL(
          `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${this.config.spreadsheetToken}/tables/${this.config.productTableId}/records`,
        )
        url.searchParams.append('page_size', String(pageSize))
        if (pageToken) url.searchParams.append('page_token', pageToken)

        const response = await this.transport.fetch(url.toString(), {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          throw new FeishuError(`查询飞书记录 HTTP 失败: ${response.status}`, 'API_ERROR')
        }

        const data = await response.json()
        if (data.code !== 0) {
          throw new FeishuError(data.msg || '查询飞书记录失败', 'API_ERROR', data.code)
        }

        const items = (data.data?.items ?? []) as Array<{ record_id: string; fields: Record<string, unknown> }>
        for (const item of items) {
          if (allRows.length >= limit) break
          const sanitizedRow: DatasetRow = { recordId: item.record_id }
          for (const [k, v] of Object.entries(item.fields)) {
            if (typeof v === 'string' && v.length > DATASET_MAX_TEXT_LENGTH) {
              sanitizedRow[k] = v.slice(0, DATASET_MAX_TEXT_LENGTH)
            } else {
              sanitizedRow[k] = v
            }
          }
          allRows.push(sanitizedRow)
        }

        hasMore = data.data?.has_more === true
        pageToken = data.data?.page_token
      }

      const schema = await this.getSchema()
      return {
        schema,
        rows: allRows,
        total: allRows.length,
        source: 'feishu',
        queriedAt: this.now(),
        truncated: hasMore || allRows.length >= limit,
      }
    } catch (error) {
      if (error instanceof FeishuError) throw error
      throw new FeishuError(
        `查询飞书表格异常: ${error instanceof Error ? error.message : String(error)}`,
        'NETWORK_ERROR',
      )
    }
  }

  /**
   * 获取目标数据表的**真实**字段列表（含类型，支持分页）。
   *
   * 与 {@link getSchema} 不同，本方法不回退静态 Schema：网络 / 鉴权 / 结构失败时抛
   * {@link FeishuError}，供写入前的字段兼容性校验（名称 + 类型）依赖真实结果。
   */
  async getTableFields(tableId: string): Promise<FeishuTableField[]> {
    const token = await this.getTenantAccessToken()
    try {
      const fields: FeishuTableField[] = []
      let hasMore = true
      let pageToken: string | undefined = undefined

      while (hasMore) {
        const url = new URL(
          `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${this.config.spreadsheetToken}/tables/${tableId}/fields`,
        )
        url.searchParams.append('page_size', '100')
        if (pageToken) url.searchParams.append('page_token', pageToken)

        const response = await this.transport.fetch(url.toString(), {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          throw new FeishuError(`获取飞书表字段 HTTP 失败: ${response.status}`, 'API_ERROR')
        }

        const data = await response.json()
        if (data.code !== 0) {
          throw new FeishuError(data.msg || '获取飞书表格字段失败', 'API_ERROR', data.code)
        }

        const items = (data.data?.items ?? []) as Array<{ field_name?: unknown; type?: unknown }>
        for (const item of items) {
          if (typeof item.field_name === 'string') {
            fields.push({ name: item.field_name, type: Number(item.type) || 0 })
          }
        }

        hasMore = data.data?.has_more === true
        pageToken = data.data?.page_token
      }

      return fields
    } catch (error) {
      if (error instanceof FeishuError) throw error
      throw new FeishuError(
        `获取飞书表字段异常: ${error instanceof Error ? error.message : String(error)}`,
        'NETWORK_ERROR',
      )
    }
  }

  /**
   * 获取表格中已存在的商品组合键（用于写入前去重）。
   * 组合键格式：`${itemId}_${wantCnt}_${price}`
   *
   * 容错语义：获取失败时返回空集合，不中断主流程（仅适用于可容忍漏去重的场景）。
   * 写入前的严格去重请用 {@link getExistingItemKeysStrict}。
   */
  async getExistingItemKeys(tableId: string): Promise<Set<string>> {
    try {
      return await this.fetchExistingItemKeys(tableId)
    } catch {
      // 容错：去重获取失败时返回空集合，不中断主写入流程
      return new Set<string>()
    }
  }

  /**
   * 严格获取已有商品组合键：失败时抛 {@link FeishuError}。
   *
   * 写入前必须用本方法：去重失败若静默放行会导致重复写入。
   */
  async getExistingItemKeysStrict(tableId: string): Promise<Set<string>> {
    return this.fetchExistingItemKeys(tableId)
  }

  /** 拉取已有商品组合键（失败抛 {@link FeishuError}）。 */
  private async fetchExistingItemKeys(tableId: string): Promise<Set<string>> {
    const token = await this.getTenantAccessToken()
    const existingKeys = new Set<string>()

    try {
      let hasMore = true
      let pageToken: string | undefined = undefined

      while (hasMore) {
        const url = new URL(
          `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${this.config.spreadsheetToken}/tables/${tableId}/records`,
        )
        url.searchParams.append('page_size', '500')
        url.searchParams.append('field_names', '["商品ID", "想要人数", "价格"]')
        if (pageToken) url.searchParams.append('page_token', pageToken)

        const response = await this.transport.fetch(url.toString(), {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          throw new FeishuError(`获取已有商品记录 HTTP 失败: ${response.status}`, 'API_ERROR')
        }

        const data = await response.json()
        if (data.code !== 0) {
          throw new FeishuError(data.msg || '获取已有商品记录失败', 'API_ERROR', data.code)
        }

        const items = (data.data?.items ?? []) as Array<{ fields?: Record<string, unknown> }>
        for (const item of items) {
          const itemId = item.fields?.['商品ID']
          const wantCnt = item.fields?.['想要人数'] ?? 0
          const price = item.fields?.['价格'] ?? 0
          if (itemId) {
            // 与写入侧共用归一函数，避免读写两侧组合键漂移。
            existingKeys.add(buildFeishuProductDedupeKey(itemId, wantCnt, price))
          }
        }

        hasMore = data.data?.has_more === true
        pageToken = data.data?.page_token
      }

      return existingKeys
    } catch (error) {
      if (error instanceof FeishuError) throw error
      throw new FeishuError(
        `获取已有商品记录异常: ${error instanceof Error ? error.message : String(error)}`,
        'NETWORK_ERROR',
      )
    }
  }

  /**
   * 显式创建缺失字段（幂等：已存在的字段直接跳过，不修改、不删除）。
   *
   * 仅由字段同步命令的执行阶段调用；**普通商品写入不会调用本方法**，因此不会隐式创建字段。
   * 返回实际创建的字段名与因已存在而跳过的字段名，便于审计与幂等验证。
   */
  async createTableFields(
    tableId: string,
    fieldConfigs: FeishuFieldConfig[],
  ): Promise<{ created: string[]; skipped: string[] }> {
    const token = await this.getTenantAccessToken()
    const url = `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${this.config.spreadsheetToken}/tables/${tableId}/fields`

    const existingFieldNames = new Set((await this.getTableFields(tableId)).map((field) => field.name))

    const created: string[] = []
    const skipped: string[] = []

    for (const config of fieldConfigs) {
      if (existingFieldNames.has(config.name)) {
        skipped.push(config.name)
        continue
      }

      const response = await this.transport.fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          field_name: config.name,
          type: config.type,
        }),
      })

      if (!response.ok) {
        throw new FeishuError(`创建飞书字段 HTTP 失败: ${response.status}`, 'API_ERROR')
      }

      const data = await response.json()
      if (data.code !== 0) {
        throw new FeishuError(data.msg || `创建飞书字段失败: ${config.name}`, 'API_ERROR', data.code)
      }

      // 记住已创建，避免同批重复创建。
      existingFieldNames.add(config.name)
      created.push(config.name)
    }

    return { created, skipped }
  }

  /**
   * 检查并创建表格所需字段（对齐旧版 ensureTableFields）。
   *
   * 保留旧签名：内部委托 {@link createTableFields}，同样只创建缺失字段，不修改 / 删除已有字段。
   */
  async ensureTableFields(tableId: string, fieldConfigs: FeishuFieldConfig[]): Promise<void> {
    await this.createTableFields(tableId, fieldConfigs)
  }

  /**
   * 批量创建记录（自动切片，每批 <= 500 条）。
   */
  async batchCreateRecords(
    tableId: string,
    records: Array<{ fields: Record<string, unknown> }>,
  ): Promise<Array<{ record_id: string }>> {
    const token = await this.getTenantAccessToken()
    const results: Array<{ record_id: string }> = []

    for (let i = 0; i < records.length; i += FEISHU_MAX_BATCH_SIZE) {
      const batch = records.slice(i, i + FEISHU_MAX_BATCH_SIZE)
      const url = `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${this.config.spreadsheetToken}/tables/${tableId}/records/batch_create`

      const response = await this.transport.fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ records: batch }),
      })

      if (!response.ok) {
        throw new FeishuError(`批量创建记录 HTTP 失败: ${response.status}`, 'API_ERROR')
      }

      const data = await response.json()
      if (data.code !== 0) {
        throw new FeishuError(data.msg || '批量创建记录失败', 'API_ERROR', data.code)
      }

      const created = (data.data?.records ?? []) as Array<{ record_id: string }>
      results.push(...created)
    }

    return results
  }

  /**
   * 将标准 Product 转换为飞书多维表格字段格式。
   */
  static convertProductToFeishuRecord(product: Product): { fields: Record<string, unknown> } {
    const fields: Record<string, unknown> = {
      '商品ID': String(product.itemId || ''),
      '商品标题': String(product.title || ''),
      '价格': Number(product.priceNumber) || 0,
      '原价': Number(product.originalPriceNumber) || 0,
      '想要人数': Number(product.wantCnt) || 0,
      '发布时间': product.publishTimeMs || null,
      '采集时间': product.captureTimeMs || null,
      '卖家昵称': String(product.sellerNick || ''),
      '地区': String(product.sellerCity || ''),
      '包邮': String(product.freeShip || ''),
      '商品标签': String(product.tags || ''),
      '封面URL': product.coverUrl ? { link: product.coverUrl } : null,
      '商品详情URL': product.detailUrl ? { link: product.detailUrl } : null,
    }
    return { fields }
  }
}

function mapFeishuTypeToDatasetType(type: number): DatasetFieldType {
  switch (type) {
    case 2:
      return 'number'
    case 5:
      return 'datetime'
    case 15:
      return 'url'
    default:
      return 'string'
  }
}
