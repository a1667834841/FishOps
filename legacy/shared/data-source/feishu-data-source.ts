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
import type { FeishuProductsOrder } from '../types/feishu-products'
import { buildCaptureDedupeKey, FEISHU_CAPTURE_FIELD_CONFIGS } from './feishu-daily-tables'
import { extractFeishuText, extractFeishuTimeMs } from './feishu-product-mapping'
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
    if (!options.config.spreadsheetToken) {
      throw new FeishuError('飞书配置缺少 spreadsheetToken', 'INVALID_PARAM')
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
    if (!this.config.productTableId) {
      // 新配置只需多维表格 Token；连接测试校验查表权限，不为测试创建数据表。
      await this.listTables()
      return { name: 'feishu_daily_capture', label: '飞书每日采集表', fields: FEISHU_CAPTURE_FIELD_CONFIGS.map((field) => ({ name: field.name, label: field.name, type: mapFeishuTypeToDatasetType(field.type) })) }
    }
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
        // 固定文案：只暴露目标表 ID，绝不回显 spreadsheetToken / appId 等凭据。
        description: `多维表格 table=${this.config.productTableId}`,
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
    if (!this.config.productTableId) throw new FeishuError('旧商品表未配置，批量分析需填写旧商品表 ID', 'INVALID_PARAM')
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
   * 单次分页查询飞书商品记录（search API）。
   *
   * 关键约束：
   * - **每次调用只发一次真实请求**，由飞书分页（page_token / has_more）驱动，绝不循环拉全表；
   * - **官方签名**：`page_size` / `page_token` 是**查询参数（query）**，而 `filter` / `sort`
   *   经 **body** 以 JSON 发送（已按官方 SDK `RecordsNamespace.search` 生成代码校验）；
   *   若误把 page_size 放 body，飞书会忽略并一次返回全表（分页失效）；
   * - `keyword` 通过 search API 的 `filter`（标题 / 商品ID 包含匹配，OR 组合）在服务端过滤，
   *   绝不在本地全量拉取后过滤；`order` 映射为 API `sort`，同样在服务端排序；
   * - `total` 仅在飞书**真实返回**时透传，绝不本地估算；
   * - 若返回条数超过请求 pageSize（page_size 未生效），抛 INVALID_RESPONSE，绝不把全表当一页假成功。
   *
   * @param tableId 目标表 ID（运行时固定传已配置商品表，绝不接受任意表）。
   */
  async searchRecordsOnce(
    tableId: string,
    params: {
      pageSize: number
      pageToken?: string
      keyword?: string
      order?: FeishuProductsOrder
      /** 每日表包含采集关键字，旧表查询保持原字段兼容。 */
      includeCaptureKeyword?: boolean
    },
  ): Promise<FeishuSearchRecordsResult> {
    if (!tableId || tableId.trim().length === 0) {
      throw new FeishuError('查询飞书商品分页缺少目标表 ID', 'INVALID_PARAM')
    }
    const token = await this.getTenantAccessToken()

    // 官方签名：page_size / page_token 必须作为 **query 参数**（放 body 会被忽略→一次返回全表）。
    const url = new URL(
      `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${this.config.spreadsheetToken}/tables/${tableId}/records/search`,
    )
    url.searchParams.append('page_size', String(params.pageSize))
    if (params.pageToken) url.searchParams.append('page_token', params.pageToken)

    // body 仅承载检索条件（filter / sort）。
    const body: Record<string, unknown> = {}
    const keyword = params.keyword?.trim()
    if (keyword) {
      // 关键词过滤走飞书 search API，服务端执行，绝不本地全表过滤。
      body['filter'] = {
        conjunction: 'or',
        conditions: [
          { field_name: '商品标题', operator: 'contains', value: [keyword] },
          { field_name: '商品ID', operator: 'contains', value: [keyword] },
          ...(params.includeCaptureKeyword ? [{ field_name: '采集关键字', operator: 'contains', value: [keyword] }] : []),
        ],
      }
    }

    const sort = buildSearchSort(params.order)
    if (sort) body['sort'] = [sort, ...(params.includeCaptureKeyword && sort.field_name !== '采集时间' ? [{ field_name: '采集时间', desc: true }] : [])]

    try {
      const response = await this.transport.fetch(url.toString(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        throw new FeishuError(`分页查询飞书商品 HTTP 失败: ${response.status}`, 'API_ERROR')
      }

      const data = await response.json()
      if (data.code !== 0) {
        throw new FeishuError(data.msg || '分页查询飞书商品失败', 'API_ERROR', data.code)
      }

      const items = (data.data?.items ?? []) as Array<{
        record_id: string
        fields: Record<string, unknown>
      }>
      if (!Array.isArray(data.data?.items) || items.some((item) => typeof item.record_id !== 'string' || !item.fields || typeof item.fields !== 'object')) {
        throw new FeishuError('飞书商品分页格式异常', 'INVALID_RESPONSE')
      }

      // 护栏：返回条数绝不得超过请求 pageSize（否则说明 page_size 未生效，绝不能当一页假成功）。
      if (items.length > params.pageSize) {
        throw new FeishuError(
          `飞书分页返回条数超出请求上限（page_size 未生效）: ${items.length} > ${params.pageSize}`,
          'INVALID_RESPONSE',
        )
      }

      const result: FeishuSearchRecordsResult = {
        items,
        hasMore: data.data?.has_more === true,
      }
      if (result.hasMore && (typeof data.data?.page_token !== 'string' || !data.data.page_token)) {
        throw new FeishuError('飞书分页缺少后续游标', 'INVALID_RESPONSE')
      }
      if (typeof data.data?.page_token === 'string' && data.data.page_token.length > 0) {
        result.pageToken = data.data.page_token
      }
      if (typeof data.data?.total === 'number') {
        result.total = data.data.total
      }
      return result
    } catch (error) {
      if (error instanceof FeishuError) throw error
      throw new FeishuError(
        `分页查询飞书商品异常: ${error instanceof Error ? error.message : String(error)}`,
        'NETWORK_ERROR',
      )
    }
  }

  /**
   * 读取单条真实飞书记录（GET），供发布素材加载 / 安全复验。
   *
   * 记录不存在时返回 `null`（由调用方映射为 PRODUCT_NOT_FOUND），其余错误抛 {@link FeishuError}。
   */
  async getRecordOnce(
    tableId: string,
    recordId: string,
  ): Promise<{ record_id: string; fields: Record<string, unknown> } | null> {
    if (!tableId || tableId.trim().length === 0) {
      throw new FeishuError('读取飞书记录缺少目标表 ID', 'INVALID_PARAM')
    }
    if (!recordId || recordId.trim().length === 0) {
      throw new FeishuError('读取飞书记录缺少 recordId', 'INVALID_PARAM')
    }
    const token = await this.getTenantAccessToken()
    const url = `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${this.config.spreadsheetToken}/tables/${tableId}/records/${encodeURIComponent(recordId)}`

    try {
      const response = await this.transport.fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      })

      if (response.status === 404) return null
      if (!response.ok) {
        throw new FeishuError(`读取飞书记录 HTTP 失败: ${response.status}`, 'API_ERROR')
      }

      const data = await response.json()
      // 记录不存在时飞书返回 NOT_FOUND 业务码，映射为 null 交由上层判定。
      if (data.code !== 0) {
        if (data.code === 1254003 || data.code === 1254005) return null
        throw new FeishuError(data.msg || '读取飞书记录失败', 'API_ERROR', data.code)
      }

      const record = data.data?.record as
        | { record_id?: string; fields?: Record<string, unknown> }
        | undefined
      if (!record || typeof record.record_id !== 'string') return null
      return { record_id: record.record_id, fields: record.fields ?? {} }
    } catch (error) {
      if (error instanceof FeishuError) throw error
      throw new FeishuError(
        `读取飞书记录异常: ${error instanceof Error ? error.message : String(error)}`,
        'NETWORK_ERROR',
      )
    }
  }

  /** 分页列出当前配置多维表格中的数据表，失败时禁止假定目标表不存在。 */
  async listTables(): Promise<FeishuTable[]> {
    const tables: FeishuTable[] = []
    const visited = new Set<string>()
    let pageToken: string | undefined
    for (;;) {
      const query = new URLSearchParams({ page_size: '100', ...(pageToken ? { page_token: pageToken } : {}) })
      const data = await this.tableRequest(`?${query}`, 'GET')
      if (!Array.isArray(data.items)) throw new FeishuError('飞书数据表列表格式异常', 'INVALID_RESPONSE')
      for (const item of data.items) {
        if (typeof item.table_id !== 'string' || typeof item.name !== 'string') throw new FeishuError('飞书数据表信息异常', 'INVALID_RESPONSE')
        tables.push({ tableId: item.table_id, name: item.name })
      }
      if (data.has_more !== true) return tables
      if (typeof data.page_token !== 'string' || !data.page_token || visited.has(data.page_token)) {
        throw new FeishuError('飞书数据表分页游标异常', 'INVALID_RESPONSE')
      }
      pageToken = data.page_token
      visited.add(pageToken)
    }
  }

  /** 创建每日数据表时一并提供完整初始字段，避免空表状态造成同步失败。 */
  async createTable(name: string, fields: readonly FeishuFieldConfig[]): Promise<FeishuTable> {
    const data = await this.tableRequest('', 'POST', {
      table: { name, default_view_name: '采集记录', fields: fields.map((field) => ({ field_name: field.name, type: field.type })) },
    })
    if (typeof data.table_id !== 'string' || !data.table_id) throw new FeishuError('飞书创建数据表未返回 ID', 'INVALID_RESPONSE')
    return { tableId: data.table_id, name }
  }

  /** 数据表 API 使用固定飞书域名；对外错误不包含请求 URL 或凭据。 */
  private async tableRequest(suffix: string, method: string, body?: unknown): Promise<FeishuTablesApiData> {
    const token = await this.getTenantAccessToken()
    try {
      const response = await this.transport.fetch(
        `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${this.config.spreadsheetToken}/tables${suffix}`,
        { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) },
      )
      if (!response.ok) throw new FeishuError('飞书数据表请求失败，请检查应用权限与多维表格编辑权限', 'API_ERROR')
      const data = await response.json()
      if (data.code !== 0) throw new FeishuError('飞书数据表操作失败，请检查建表权限或表数量上限后恢复重试', 'API_ERROR', data.code)
      if (!data.data || typeof data.data !== 'object') throw new FeishuError('飞书数据表返回格式异常', 'INVALID_RESPONSE')
      return data.data
    } catch (error) {
      if (error instanceof FeishuError) throw error
      throw new FeishuError('飞书数据表网络请求失败，请稍后恢复重试', 'NETWORK_ERROR')
    }
  }

  /**
   * 获取目标数据表的**真实**字段列表（含类型，支持分页）。
   *
   * 与 {@link getSchema} 不同，本方法不回退静态 Schema：网络 / 鉴权 / 结构失败时抛
   * {@link FeishuError}，供写入前的字段兼容性校验（名称 + 类型）依赖真实结果。
   */
  async getTableFields(tableId: string): Promise<FeishuTableField[]> {
    if (!tableId) throw new FeishuError('目标商品表未配置', 'INVALID_PARAM')
    const token = await this.getTenantAccessToken()
    try {
      const fields: FeishuTableField[] = []
      let hasMore = true
      let pageToken: string | undefined = undefined
      const visited = new Set<string>()

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

        if (!Array.isArray(data.data?.items)) throw new FeishuError('飞书字段列表格式异常', 'INVALID_RESPONSE')
        const items = data.data.items as Array<{ field_name?: unknown; type?: unknown }>
        for (const item of items) {
          if (typeof item.field_name === 'string') {
            fields.push({ name: item.field_name, type: Number(item.type) || 0 })
          }
        }

        hasMore = data.data?.has_more === true
        pageToken = data.data?.page_token
        if (hasMore && (!pageToken || visited.has(pageToken))) throw new FeishuError('飞书字段分页游标异常', 'INVALID_RESPONSE')
        if (pageToken) visited.add(pageToken)
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

  /** 每日采集严格去重；读取失败必须停止，不能把空集合当作无重复。 */
  async getExistingCaptureKeysStrict(tableId: string): Promise<Set<string>> {
    return this.fetchExistingItemKeys(tableId, true)
  }

  /** 拉取已有商品组合键（失败抛 {@link FeishuError}）。 */
  private async fetchExistingItemKeys(tableId: string, capture = false): Promise<Set<string>> {
    const token = await this.getTenantAccessToken()
    const existingKeys = new Set<string>()

    try {
      let hasMore = true
      let pageToken: string | undefined = undefined
      const visited = new Set<string>()

      while (hasMore) {
        const url = new URL(
          `${FEISHU_API_BASE}/open-apis/bitable/v1/apps/${this.config.spreadsheetToken}/tables/${tableId}/records`,
        )
        url.searchParams.append('page_size', '500')
        url.searchParams.append('field_names', JSON.stringify(capture ? ['商品ID', '采集时间', '采集关键字'] : ['商品ID', '想要人数', '价格']))
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

        // records 接口通常返回 items；部分兼容网关会返回 records。两者语义相同，统一解析。
        const rawItems = Array.isArray(data.data?.items)
          ? data.data.items
          : Array.isArray(data.data?.records)
            ? data.data.records
            : Array.isArray(data.items)
              ? data.items
              : Array.isArray(data.records)
                ? data.records
                : Array.isArray(data.data)
                  ? data.data
                  : data.data && typeof data.data === 'object' && (data.data.items === null || data.data.records === null) && data.data.total === 0
                    ? []
                    : undefined
        if (capture && !rawItems) {
          const topKeys = data && typeof data === 'object' ? Object.keys(data).sort().join(',') : ''
          const dataKeys = data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? Object.keys(data.data).sort().join(',') : ''
          throw new FeishuError(`飞书已有采集记录格式异常（响应字段：${topKeys || '无'}；data字段：${dataKeys || '无'}）`, 'INVALID_RESPONSE')
        }
        const items = (rawItems ?? []) as Array<{ fields?: Record<string, unknown> }>
        for (const item of items) {
          const itemId = item.fields?.['商品ID']
          const wantCnt = item.fields?.['想要人数'] ?? 0
          const price = item.fields?.['价格'] ?? 0
          if (capture) {
            const id = extractFeishuText(itemId)
            const time = extractFeishuTimeMs(item.fields?.['采集时间'])
            const keyword = extractFeishuText(item.fields?.['采集关键字'])
            if (id && time > 0) existingKeys.add(buildCaptureDedupeKey(id, time, keyword))
          } else if (itemId) {
            // 与写入侧共用归一函数，避免读写两侧组合键漂移。
            existingKeys.add(buildFeishuProductDedupeKey(itemId, wantCnt, price))
          }
        }

        hasMore = data.data?.has_more === true
        pageToken = data.data?.page_token
        if (hasMore && (!pageToken || visited.has(pageToken))) throw new FeishuError('飞书记录分页游标异常', 'INVALID_RESPONSE')
        if (pageToken) visited.add(pageToken)
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
    if (!tableId) throw new FeishuError('目标商品表未配置', 'INVALID_PARAM')
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

      // 官方响应为 data.records；兼容部分代理返回 data.items / record_ids，避免已落库却被误判失败。
      const rawCreated = Array.isArray(data.data?.records)
        ? data.data.records
        : Array.isArray(data.data?.items)
          ? data.data.items
          : Array.isArray(data.data?.record_ids)
            ? data.data.record_ids.map((id: unknown) => ({ record_id: id }))
            : []
      const created = rawCreated
        .map((record: unknown) => {
          if (typeof record === 'string') return { record_id: record }
          if (!record || typeof record !== 'object') return { record_id: '' }
          const value = record as { record_id?: unknown; id?: unknown }
          return { record_id: typeof value.record_id === 'string' ? value.record_id : typeof value.id === 'string' ? value.id : '' }
        })
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
      '商品描述': String(product.desc || ''),
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

  /** 每日采集表在标准商品字段上增加当次关键字；旧表导出仍使用原映射。 */
  static convertCapturedProductToFeishuRecord(product: Product): { fields: Record<string, unknown> } {
    return { fields: { ...FeishuDataSource.convertProductToFeishuRecord(product).fields, '采集关键字': product.captureKeyword ?? '' } }
  }
}

/** 当前多维表格内的数据表，不包含凭据。 */
export interface FeishuTable {
  tableId: string
  name: string
}

interface FeishuTablesApiData {
  items?: Array<{ table_id: string; name: string }>
  has_more?: boolean
  page_token?: string
  table_id?: string
}

/** 单次分页查询结果（仅含分页与业务字段，绝不含任何凭据）。 */
export interface FeishuSearchRecordsResult {
  items: Array<{ record_id: string; fields: Record<string, unknown> }>
  hasMore: boolean
  pageToken?: string
  /** 仅当飞书 API 真实返回 total 时存在。 */
  total?: number
}

/** 把排序枚举映射为飞书 search API 的 sort（不指定则不传，交由飞书默认顺序）。 */
function buildSearchSort(
  order?: FeishuProductsOrder,
): { field_name: string; desc: boolean } | undefined {
  switch (order) {
    case 'titleAsc':
      return { field_name: '商品标题', desc: false }
    case 'titleDesc':
      return { field_name: '商品标题', desc: true }
    case 'priceAsc':
      return { field_name: '价格', desc: false }
    case 'priceDesc':
      return { field_name: '价格', desc: true }
    case 'wantCntDesc':
      return { field_name: '想要人数', desc: true }
    case 'captureTimeDesc':
      return { field_name: '采集时间', desc: true }
    case 'captureTimeAsc':
      return { field_name: '采集时间', desc: false }
    default:
      return undefined
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
