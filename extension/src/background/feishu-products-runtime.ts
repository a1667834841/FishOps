/**
 * 飞书商品库分页浏览 / 单条读取运行时（P7 商品库）。
 *
 * 职责：为商品库 UI 提供**真实分页**的飞书商品浏览与单条素材读取。
 *
 * 安全与边界（硬性）：
 * - 旧分页仍固定读取 productTableId；商品库读取今天和昨天的每日采集表；
 * - 每张表使用真实分页与服务端检索，在最多两张表的分页缓冲间合并，不拉取全表；
 * - 单条读取只允许当前多维表格的每日表或旧配置表；
 * - 结果**绝不包含** appSecret / tenantAccessToken / spreadsheetToken 等任何密钥；
 * - `total` 仅在飞书真实返回时透传；
 * - 单条读取缺字段时明确回退并报告，绝不伪造 ID。
 *
 * 本运行时**不影响** DATA_SOURCE_QUERY 的批量分析语义（两者独立）。
 */
import {
  CommandTypes,
  createErrorResponse,
  createResponse,
  FEISHU_PRODUCTS_DEFAULT_PAGE_SIZE,
  isFeishuProductGetPayload,
  isFeishuProductsPagePayload,
  type CommandEnvelope,
  type ProtocolErrorCode,
  type ResponseEnvelope,
} from '@fishops/shared'
import { FeishuDataSource } from '../../../shared/data-source/feishu-data-source'
import { isAllowedProductTable } from '../../../shared/data-source/feishu-daily-tables'
import { createDailyProductsPager } from './feishu-daily-products'
import {
  flattenFeishuRecord,
  mapFeishuFieldsToMaterial,
} from '../../../shared/data-source/feishu-product-mapping'
import type {
  FeishuProductGetPayload,
  FeishuProductGetResult,
  FeishuProductsPagePayload,
  FeishuProductsPageResult,
} from '../../../shared/types/feishu-products'
import {
  FeishuError,
  type FeishuConfig,
  type HttpTransport,
} from '../../../shared/data-source/feishu-types'
import type { FeishuConfigStore } from '../data-source/feishu-config-store'

/** 运行时依赖。 */
export interface FeishuProductsRuntimeDeps {
  /** 飞书配置存储（只读取已配置商品表；密钥仅用于请求层）。 */
  feishuConfigStore: FeishuConfigStore
  /** 可注入的 HTTP 传输器（单测 / 离线环境 Mock）；缺省走原生 fetch。 */
  transport?: HttpTransport
  /** 可注入的时间源。 */
  now?: () => number
}

/** 飞书商品库运行时。 */
export interface FeishuProductsRuntime {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
  /**
   * 直接分页读取（供商品目录复用同一专用分页读取）：目标表固定为已配置商品表，
   * 关键词 / 排序交给飞书 search API 服务端，绝不本地全量拉取。
   */
  page(payload: FeishuProductsPagePayload): Promise<FeishuProductsPageResult>
  /** 商品库读取今天与昨天的每日采集表；行内保留真实来源表。 */
  dailyPage(payload: FeishuProductsPagePayload): Promise<FeishuProductsPageResult>
}

/** 需要交由飞书商品库运行时处理的命令。 */
export const FEISHU_PRODUCTS_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.FEISHU_PRODUCTS_PAGE,
  CommandTypes.FEISHU_PRODUCT_GET,
])

/** 内部结构化错误：统一映射为 ProtocolError（可携带业务码，非敏感）。 */
class FeishuProductsError extends Error {
  readonly code: ProtocolErrorCode
  readonly businessCode?: string

  constructor(code: ProtocolErrorCode, message: string, businessCode?: string) {
    super(message)
    this.name = 'FeishuProductsError'
    this.code = code
    this.businessCode = businessCode
  }
}

/** 把 FeishuError 映射为固定、非敏感的协议错误（绝不透传底层 message / URL / 凭据）。 */
function mapFeishuError(error: FeishuError): FeishuProductsError {
  switch (error.category) {
    case 'AUTH_FAILED':
      return new FeishuProductsError('INVALID_PAYLOAD', '飞书鉴权失败：请检查 appId / appSecret 配置是否正确')
    case 'NOT_FOUND':
      return new FeishuProductsError('INVALID_PAYLOAD', '飞书目标表不存在：请检查商品表配置是否正确')
    case 'RATE_LIMITED':
      return new FeishuProductsError('INTERNAL', '飞书接口频率超限：请稍后重试')
    case 'NETWORK_ERROR':
      return new FeishuProductsError('INTERNAL', '飞书网络请求失败：请检查网络后重试')
    case 'INVALID_PARAM':
      return new FeishuProductsError('INVALID_PAYLOAD', '飞书请求参数不合法：请检查飞书配置是否正确')
    case 'INVALID_RESPONSE':
      return new FeishuProductsError(
        'INTERNAL',
        '飞书分页返回条数异常：已拒绝本次结果以防假分页，请稍后重试',
        'INVALID_RESPONSE',
      )
    case 'API_ERROR':
    default:
      return new FeishuProductsError('INTERNAL', '飞书商品查询失败：请检查飞书配置与目标表后重试')
  }
}

/** 创建飞书商品库运行时。 */
export function createFeishuProductsRuntime(deps: FeishuProductsRuntimeDeps): FeishuProductsRuntime {
  const now = deps.now ?? (() => Date.now())
  const dailyPager = createDailyProductsPager(now)

  /** 缓存数据源实例（复用令牌缓存），配置变化时重建。 */
  let cachedSource: FeishuDataSource | null = null
  let cachedConfig: FeishuConfig | null = null

  /** 完整（内存）比较飞书配置，检测（含同长度密钥轮换）变化。 */
  function sameConfig(a: FeishuConfig, b: FeishuConfig): boolean {
    return (
      a.appId === b.appId &&
      a.appSecret === b.appSecret &&
      a.spreadsheetToken === b.spreadsheetToken &&
      a.productTableId === b.productTableId &&
      (a.sellerTableId ?? '') === (b.sellerTableId ?? '')
    )
  }

  /** 读取飞书配置并构造（或复用）数据源；未配置返回 null。 */
  async function getDataSource(): Promise<{ source: FeishuDataSource; config: FeishuConfig } | null> {
    const config = await deps.feishuConfigStore.load()
    if (!config) {
      cachedSource = null
      cachedConfig = null
      return null
    }
    if (cachedSource && cachedConfig && sameConfig(cachedConfig, config)) {
      return { source: cachedSource, config }
    }
    cachedSource = new FeishuDataSource({
      config,
      ...(deps.transport === undefined ? {} : { transport: deps.transport }),
      now,
    })
    cachedConfig = config
    return { source: cachedSource, config }
  }

  /** 分页读取：真实单次请求，缺省每页 20 条。 */
  async function page(payload: FeishuProductsPagePayload): Promise<FeishuProductsPageResult> {
    const resolved = await getDataSource()
    if (!resolved) {
      throw new FeishuProductsError(
        'INVALID_PAYLOAD',
        '飞书未配置：请先在设置页填写飞书应用与商品表信息',
        'CONFIG_MISSING',
      )
    }
    const { source, config } = resolved
    const pageSize = payload.pageSize ?? FEISHU_PRODUCTS_DEFAULT_PAGE_SIZE

    // 目标表绑定复验：声明 targetTableId 时必须等于当前已配置商品表，否则以漂移拒绝。
    // codec 已保证携带 pageToken 时必有 targetTableId，因此不会出现无绑定的跨表游标。
    const boundTableId = payload.targetTableId?.trim()
    if (boundTableId && boundTableId !== config.productTableId) {
      throw new FeishuProductsError(
        'INVALID_PAYLOAD',
        `飞书分页目标表与当前已配置商品表不一致（绑定漂移）：${boundTableId} ≠ ${config.productTableId}`,
        'PUBLISH_TARGET_TABLE_MISMATCH',
      )
    }

    const search = await source.searchRecordsOnce(config.productTableId, {
      pageSize,
      ...(payload.pageToken ? { pageToken: payload.pageToken } : {}),
      ...(payload.keyword ? { keyword: payload.keyword } : {}),
      ...(payload.order ? { order: payload.order } : {}),
    })

    const rows = search.items.map((item) => flattenFeishuRecord(item.record_id, item.fields ?? {}))
    return {
      rows,
      hasMore: search.hasMore,
      ...(search.pageToken ? { nextPageToken: search.pageToken } : {}),
      ...(search.total === undefined ? {} : { total: search.total }),
      targetTableId: config.productTableId,
    }
  }


  /** 每日商品库读取；与旧配置表的专用分页接口隔离。 */
  async function dailyPage(payload: FeishuProductsPagePayload): Promise<FeishuProductsPageResult> {
    const resolved = await getDataSource()
    if (!resolved) throw new FeishuProductsError('INVALID_PAYLOAD', '飞书未配置，请先设置飞书多维表格', 'CONFIG_MISSING')
    try {
      return await dailyPager(resolved.source, JSON.stringify(resolved.config), payload)
    } catch (error) {
      if (error instanceof FeishuError) {
        const safeMessages = ['商品库日期范围或目标表已变化，请刷新后重试', '商品库分页已失效或查询条件变化，请刷新后重试']
        if (safeMessages.includes(error.message)) throw new FeishuProductsError('INVALID_PAYLOAD', error.message)
        throw mapFeishuError(error)
      }
      throw new FeishuProductsError('INTERNAL', '飞书商品查询失败，请刷新后重试')
    }
  }

  /** 单条读取：真实记录映射为可编辑素材，缺字段明确回退并报告。 */
  async function get(payload: FeishuProductGetPayload): Promise<FeishuProductGetResult> {
    const resolved = await getDataSource()
    if (!resolved) {
      throw new FeishuProductsError(
        'INVALID_PAYLOAD',
        '飞书未配置：请先在设置页填写飞书应用与商品表信息',
        'CONFIG_MISSING',
      )
    }
    const { source, config } = resolved
    const recordId = payload.recordId.trim()

    // 单条素材必须绑定真实来源表，并经当前多维表格的允许表集合复验。
    const boundTableId = payload.targetTableId?.trim()
    const targetTableId = boundTableId || config.productTableId
    if (!(await isAllowedProductTable(source, config, targetTableId))) {
      throw new FeishuProductsError(
        'INVALID_PAYLOAD',
        `飞书素材目标表与当前已配置商品表不一致（绑定漂移）：${boundTableId} ≠ ${config.productTableId}`,
        'PUBLISH_TARGET_TABLE_MISMATCH',
      )
    }

    const record = await source.getRecordOnce(targetTableId, recordId)
    if (!record) {
      throw new FeishuProductsError(
        'INVALID_PAYLOAD',
        `飞书商品表中未找到记录: "${recordId}"（可能已被删除或 recordId 失效）`,
        'FEISHU_RECORD_NOT_FOUND',
      )
    }

    const mapping = mapFeishuFieldsToMaterial(record.fields)

    return {
      recordId: record.record_id,
      targetTableId,
      // 平铺行（含 recordId），与 DatasetRow 同构，供编辑表单直接解析。
      row: flattenFeishuRecord(record.record_id, record.fields),
      material: mapping.material,
      missingFields: mapping.missingFields,
      warnings: mapping.warnings,
    }
  }

  async function handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope> {
    switch (command.type) {
      case CommandTypes.FEISHU_PRODUCTS_PAGE: {
        if (!isFeishuProductsPagePayload(command.payload)) {
          return invalid(command, 'FEISHU_PRODUCTS_PAGE 负载非法：仅支持 pageSize / pageToken / keyword / order')
        }
        try {
          const result = await page(command.payload)
          return createResponse(command.requestId, command.type, result)
        } catch (error) {
          return toErrorResponse(command, error)
        }
      }

      case CommandTypes.FEISHU_PRODUCT_GET: {
        if (!isFeishuProductGetPayload(command.payload)) {
          return invalid(command, 'FEISHU_PRODUCT_GET 负载非法：需要非空 recordId')
        }
        try {
          const result = await get(command.payload)
          return createResponse(command.requestId, command.type, result)
        } catch (error) {
          return toErrorResponse(command, error)
        }
      }

      default:
        return createErrorResponse(command.requestId, command.type, {
          code: 'UNKNOWN_COMMAND',
          message: `非飞书商品库命令: ${command.type}`,
        })
    }
  }

  function invalid(command: CommandEnvelope, message: string): ResponseEnvelope {
    return createErrorResponse(command.requestId, command.type, {
      code: 'INVALID_PAYLOAD',
      message,
    })
  }

  function toErrorResponse(command: CommandEnvelope, error: unknown): ResponseEnvelope {
    const mapped =
      error instanceof FeishuProductsError
        ? error
        : error instanceof FeishuError
          ? mapFeishuError(error)
          : new FeishuProductsError('INTERNAL', '飞书商品查询失败：请稍后重试')
    return createErrorResponse(command.requestId, command.type, {
      code: mapped.code,
      message: mapped.message,
      ...(mapped.businessCode === undefined ? {} : { businessCode: mapped.businessCode }),
    })
  }

  return { handleCommand, page, dailyPage }
}
