/**
 * 飞书商品写入后台运行时（P7）。
 *
 * 职责：把本地商品库中**显式指定**的 itemIds 写入已配置的飞书商品表。严格分离两阶段：
 * - `FEISHU_PRODUCT_WRITE_PREVIEW`：**只读**（读字段与已有记录）返回结构化预览 + 短期 `previewId`，
 *   缓存目标配置与选品，绝不写入；
 * - `FEISHU_PRODUCT_WRITE_EXECUTE`：必须携带 `previewId` 且 `confirm: true`，复验目标配置 /
 *   选品 / 去重未变后才真正调用 batch_create。
 *
 * 安全与边界（硬性）：
 * - 只写已配置的 `productTableId`：命令不接受 tableId 等任意目标；
 * - 网络出入只有 {@link FeishuDataSource}（固定飞书开放平台域名），不引入任意网络；
 * - **绝不自动创建 / 修改飞书字段**：字段缺失或类型冲突时失败，并回可行动的非敏感信息；
 * - 去重（商品组合键，读写共用归一函数）失败即失败，不静默放行；
 * - 去重、限量、串行并发保护；结果 / 错误结构化且不含 appSecret / token。
 */
import {
  CommandTypes,
  createErrorResponse,
  createResponse,
  genRequestId,
  isFeishuProductWriteExecutePayload,
  isFeishuProductWritePreviewPayload,
  type CommandEnvelope,
  type ProtocolErrorCode,
  type ResponseEnvelope,
} from '@fishops/shared'
import { FeishuDataSource } from '../../../shared/data-source/feishu-data-source'
import {
  FEISHU_PRODUCT_FIELD_CONFIGS,
  FeishuError,
  buildFeishuProductDedupeKey,
  type FeishuConfig,
  type FeishuTableField,
  type HttpTransport,
} from '../../../shared/data-source/feishu-types'
import { FEISHU_WRITE_MAX_ITEMS, FEISHU_WRITE_PREVIEW_TTL_MS } from '../../../shared/types/feishu-write'
import type {
  FeishuProductWriteExecuteResult,
  FeishuProductWriteFieldTypeConflict,
  FeishuProductWritePreviewResult,
} from '../../../shared/types/feishu-write'
import type { Product } from '../../../shared/types/product'
import type { ProductRepository } from '../../../shared/capture/product-repository'
import type { FeishuConfigStore } from '../data-source/feishu-config-store'

/** 写入运行时依赖。 */
export interface FeishuWriteRuntimeDeps {
  /** 飞书配置存储（只读取已配置商品表，密钥仅用于请求层）。 */
  feishuConfigStore: FeishuConfigStore
  /** 本地商品库（按 itemId 取待写入商品）。 */
  repository: ProductRepository
  /** 可注入的 HTTP 传输器（单测 / 离线环境 Mock）；缺省走原生 fetch。 */
  transport?: HttpTransport
  /** 可注入的时间源（令牌缓存过期判断与预览 TTL）。 */
  now?: () => number
  /** 单次写入商品数上限（缺省 {@link FEISHU_WRITE_MAX_ITEMS}）。 */
  maxItems?: number
  /** 预览有效期（毫秒，缺省 {@link FEISHU_WRITE_PREVIEW_TTL_MS}）。 */
  previewTtlMs?: number
}

/** 飞书商品写入运行时。 */
export interface FeishuWriteRuntime {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/** 需要交由飞书写入运行时处理的命令。 */
export const FEISHU_WRITE_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.FEISHU_PRODUCT_WRITE_PREVIEW,
  CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE,
])

/** 内部结构化错误：包一层便于统一映射为 ProtocolError。 */
class FeishuWriteError extends Error {
  readonly code: ProtocolErrorCode

  constructor(code: ProtocolErrorCode, message: string) {
    super(message)
    this.name = 'FeishuWriteError'
    this.code = code
  }
}

/** 字段兼容性检查结果。 */
interface FieldCheck {
  missingFields: string[]
  typeConflicts: FeishuProductWriteFieldTypeConflict[]
  compatible: boolean
}

/** 预览缓存项（绑定目标配置与选品，供执行复验）。 */
interface CachedPreview {
  previewId: string
  /** 目标指纹：appId + spreadsheetToken + productTableId（非敏感，仅内存复验）。 */
  targetKey: string
  /** 选品内容指纹（itemId + 规范化后的完整写入记录），仅存内存供复验。 */
  selectionKey: string
  /** 预览选定的唯一 itemId 列表（去重后）。 */
  itemIds: string[]
  /** 原始请求条数（去重前），供执行结果回显。 */
  requestedCount: number
  /** 预览时的重复 itemId，供执行结果回显。 */
  duplicateItemIds: string[]
  expiresAt: number
}

/** 将 FeishuError 映射为固定、非敏感的写入错误（绝不透传底层 message / URL / 凭据）。 */
function mapFeishuError(error: FeishuError): FeishuWriteError {
  switch (error.category) {
    case 'AUTH_FAILED':
      return new FeishuWriteError('INVALID_PAYLOAD', '飞书鉴权失败：请检查 appId / appSecret 配置是否正确')
    case 'NOT_FOUND':
      return new FeishuWriteError('INVALID_PAYLOAD', '飞书目标表不存在：请检查商品表配置是否正确')
    case 'RATE_LIMITED':
      return new FeishuWriteError('INTERNAL', '飞书接口频率超限：请稍后重试')
    case 'NETWORK_ERROR':
      return new FeishuWriteError('INTERNAL', '飞书网络请求失败：请检查网络后重试')
    case 'BATCH_TOO_LARGE':
      return new FeishuWriteError('INTERNAL', '飞书写入单批超出上限：请减少本次写入数量后重试')
    case 'INVALID_PARAM':
      return new FeishuWriteError('INVALID_PAYLOAD', '飞书请求参数不合法：请检查飞书配置是否正确')
    case 'API_ERROR':
    default:
      return new FeishuWriteError('INTERNAL', '飞书写入失败：请检查飞书配置与目标表后重试')
  }
}

/** 比对目标表真实字段与期望字段配置（名称 + 类型），绝不创建 / 修改字段。 */
function checkFieldCompatibility(tableFields: FeishuTableField[]): FieldCheck {
  const typeByName = new Map(tableFields.map((field) => [field.name, field.type]))
  const missingFields: string[] = []
  const typeConflicts: FeishuProductWriteFieldTypeConflict[] = []
  for (const expected of FEISHU_PRODUCT_FIELD_CONFIGS) {
    const actualType = typeByName.get(expected.name)
    if (actualType === undefined) {
      missingFields.push(expected.name)
      continue
    }
    if (actualType !== expected.type) {
      typeConflicts.push({ name: expected.name, expectedType: expected.type, actualType })
    }
  }
  return { missingFields, typeConflicts, compatible: missingFields.length === 0 && typeConflicts.length === 0 }
}

/** 组装可行动、非敏感的字段问题描述。 */
function describeFieldProblems(check: FieldCheck): string {
  const parts: string[] = []
  if (check.missingFields.length > 0) {
    parts.push(`缺少字段「${check.missingFields.join('、')}」`)
  }
  if (check.typeConflicts.length > 0) {
    parts.push(
      `字段类型不匹配「${check.typeConflicts
        .map((conflict) => `${conflict.name}（期望 ${conflict.expectedType}，实际 ${conflict.actualType}）`)
        .join('、')}」`,
    )
  }
  return parts.join('；')
}

/** 目标表指纹（非敏感）：应用 + 多维表格 + 商品表。 */
function buildTargetKey(config: FeishuConfig): string {
  return `${config.appId}|${config.spreadsheetToken}|${config.productTableId}`
}

/** 选品内容指纹：按选择顺序序列化完整写入记录，缺失商品用 null 标记。 */
function buildSelectionKey(itemIds: string[], productMap: Map<string, Product>): string {
  // 与实际写入共用固定字段顺序和归一规则，避免去重键漏掉标题等内容，
  // 也避免原始展示文案、对象属性顺序或非写入字段变化误使预览失效。
  return JSON.stringify(itemIds.map((id) => {
    const product = productMap.get(id)
    return [id, product ? FeishuDataSource.convertProductToFeishuRecord(product) : null]
  }))
}

/** 创建飞书商品写入运行时。 */
export function createFeishuWriteRuntime(deps: FeishuWriteRuntimeDeps): FeishuWriteRuntime {
  const maxItems = deps.maxItems ?? FEISHU_WRITE_MAX_ITEMS
  const previewTtlMs = deps.previewTtlMs ?? FEISHU_WRITE_PREVIEW_TTL_MS
  const now = deps.now ?? (() => Date.now())

  /** 当前是否已有写入在执行（串行并发保护）。 */
  let executing = false

  /** 预览缓存（previewId → 绑定信息）；一次性、带 TTL。 */
  const previews = new Map<string, CachedPreview>()

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

  /** 清理过期预览缓存，避免 Map 无界增长。 */
  function prunePreviews(): void {
    const current = now()
    for (const [id, cached] of previews) {
      if (current > cached.expiresAt) previews.delete(id)
    }
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
      ...(deps.now === undefined ? {} : { now: deps.now }),
    })
    cachedConfig = config
    return { source: cachedSource, config }
  }

  /** 去重入参 itemId（保留首次出现顺序），返回唯一列表与重复项。 */
  function dedupeItemIds(itemIds: string[]): { unique: string[]; duplicates: string[] } {
    const seen = new Set<string>()
    const unique: string[] = []
    const dupSet = new Set<string>()
    const duplicates: string[] = []
    for (const raw of itemIds) {
      const id = raw.trim()
      if (id.length === 0) continue
      if (seen.has(id)) {
        if (!dupSet.has(id)) {
          dupSet.add(id)
          duplicates.push(id)
        }
        continue
      }
      seen.add(id)
      unique.push(id)
    }
    return { unique, duplicates }
  }

  /** 只读预览：字段兼容性 + 去重分类 + 生成短期 previewId（绝不写入）。 */
  async function preview(rawItemIds: string[]): Promise<FeishuProductWritePreviewResult> {
    prunePreviews()

    const requestedCount = rawItemIds.length
    const { unique, duplicates } = dedupeItemIds(rawItemIds)
    if (unique.length === 0) {
      throw new FeishuWriteError('INVALID_PAYLOAD', '没有可写入的有效 itemId')
    }
    if (unique.length > maxItems) {
      throw new FeishuWriteError('INVALID_PAYLOAD', `本次写入商品数超出上限（最多 ${maxItems} 条）`)
    }

    const resolved = await getDataSource()
    if (!resolved) {
      throw new FeishuWriteError('INVALID_PAYLOAD', '飞书未配置：请先在配置页填写飞书应用与商品表信息')
    }
    const { source, config } = resolved
    const tableId = config.productTableId

    // 真实字段（含类型，分页）：用于判定字段是否兼容，绝不自动创建 / 修改字段。
    const fieldCheck = checkFieldCompatibility(await source.getTableFields(tableId))

    // 读取本地商品库并按 itemId 建索引（数量受 itemIds 上限约束，规模可控）。
    // 飞书字段同步需要覆盖全量本地商品（含竞品记录），故显式传 source: 'all'。
    const page = await deps.repository.list({ source: 'all' })
    const productMap = new Map(page.products.map((product) => [product.itemId, product]))
    const missingItemIds = unique.filter((id) => !productMap.has(id))

    // 严格去重：拉取已有组合键失败时直接失败，避免静默重复写入。
    const existingKeys = await source.getExistingItemKeysStrict(tableId)
    const alreadyExistsItemIds: string[] = []
    const toCreate: Array<{ product: Product; record: { fields: Record<string, unknown> } }> = []
    for (const id of unique) {
      const product = productMap.get(id)
      if (!product) continue
      const key = buildFeishuProductDedupeKey(product.itemId, product.wantCnt, product.priceNumber)
      if (existingKeys.has(key)) {
        alreadyExistsItemIds.push(id)
        continue
      }
      toCreate.push({ product, record: FeishuDataSource.convertProductToFeishuRecord(product) })
    }

    // 生成短期预览 ID，缓存目标配置与选品绑定，供执行阶段复验。
    const previewId = genRequestId()
    const expiresAt = now() + previewTtlMs
    previews.set(previewId, {
      previewId,
      targetKey: buildTargetKey(config),
      selectionKey: buildSelectionKey(unique, productMap),
      itemIds: unique,
      requestedCount,
      duplicateItemIds: duplicates,
      expiresAt,
    })

    return {
      previewId,
      expiresAt,
      targetTableId: tableId,
      requestedCount,
      uniqueCount: unique.length,
      duplicateItemIds: duplicates,
      missingItemIds,
      alreadyExistsItemIds,
      toCreate: toCreate.map(({ product }) => ({
        itemId: product.itemId,
        title: product.title,
        price: Number(product.priceNumber) || 0,
        wantCnt: Number(product.wantCnt) || 0,
      })),
      fieldCompatible: fieldCheck.compatible,
      missingFields: fieldCheck.missingFields,
      typeConflicts: fieldCheck.typeConflicts,
    }
  }

  /**
   * 执行写入：复验 previewId 有效性、目标配置、选品指纹与字段兼容性，
   * 并重新检查去重；任一不符即失败（可行动、非敏感），绝不创建 / 修改字段。
   */
  async function execute(previewId: string): Promise<FeishuProductWriteExecuteResult> {
    const cached = previews.get(previewId)
    // 一次性：无论成败都消费掉该 previewId，防止重放。
    if (cached) previews.delete(previewId)
    if (!cached) {
      throw new FeishuWriteError('INVALID_PAYLOAD', '预览不存在或已失效，请重新预览后再执行')
    }
    if (now() > cached.expiresAt) {
      throw new FeishuWriteError('INVALID_PAYLOAD', '预览已过期，请重新预览后再执行')
    }

    const resolved = await getDataSource()
    if (!resolved) {
      throw new FeishuWriteError('INVALID_PAYLOAD', '飞书未配置：请先在配置页填写飞书应用与商品表信息')
    }
    const { source, config } = resolved
    const tableId = config.productTableId
    if (buildTargetKey(config) !== cached.targetKey) {
      throw new FeishuWriteError('INVALID_PAYLOAD', '飞书目标表已变更，请重新预览后再执行')
    }

    const fieldCheck = checkFieldCompatibility(await source.getTableFields(tableId))
    if (!fieldCheck.compatible) {
      throw new FeishuWriteError(
        'INVALID_PAYLOAD',
        `目标商品表字段不兼容：${describeFieldProblems(fieldCheck)}。请在飞书多维表格中手动调整后重试（本功能不会自动创建或修改字段）`,
      )
    }

    // 执行阶段需按 itemIds 重新取全量本地商品（含竞品记录）校验选择集，故显式传 source: 'all'。
    const page = await deps.repository.list({ source: 'all' })
    const productMap = new Map(page.products.map((product) => [product.itemId, product]))
    if (buildSelectionKey(cached.itemIds, productMap) !== cached.selectionKey) {
      throw new FeishuWriteError('INVALID_PAYLOAD', '选品已变化（本地商品数据已更新），请重新预览后再执行')
    }

    // 重新检查去重：飞书端可能已新增相同组合键记录。
    const existingKeys = await source.getExistingItemKeysStrict(tableId)
    const missingItemIds: string[] = []
    const alreadyExistsItemIds: string[] = []
    const records: Array<{ fields: Record<string, unknown> }> = []
    for (const id of cached.itemIds) {
      const product = productMap.get(id)
      if (!product) {
        missingItemIds.push(id)
        continue
      }
      const key = buildFeishuProductDedupeKey(product.itemId, product.wantCnt, product.priceNumber)
      if (existingKeys.has(key)) {
        alreadyExistsItemIds.push(id)
        continue
      }
      records.push(FeishuDataSource.convertProductToFeishuRecord(product))
    }

    let createdRecordIds: string[] = []
    if (records.length > 0) {
      const created = await source.batchCreateRecords(tableId, records)
      createdRecordIds = created.map((record) => record.record_id)
    }

    return {
      previewId,
      targetTableId: tableId,
      requestedCount: cached.requestedCount,
      uniqueCount: cached.itemIds.length,
      duplicateItemIds: cached.duplicateItemIds,
      missingItemIds,
      alreadyExistsItemIds,
      createdCount: createdRecordIds.length,
      createdRecordIds,
      fieldCompatible: true,
      missingFields: [],
      typeConflicts: [],
    }
  }

  /** 统一把内部错误映射为合法响应（固定文案，不回显底层异常 / 凭据）。 */
  function toErrorResponse(command: CommandEnvelope, error: unknown): ResponseEnvelope {
    if (error instanceof FeishuWriteError) {
      return createErrorResponse(command.requestId, command.type, { code: error.code, message: error.message })
    }
    if (error instanceof FeishuError) {
      const mapped = mapFeishuError(error)
      return createErrorResponse(command.requestId, command.type, { code: mapped.code, message: mapped.message })
    }
    return createErrorResponse(command.requestId, command.type, {
      code: 'INTERNAL',
      message: '飞书商品写入失败：请检查飞书配置与网络后重试',
    })
  }

  async function handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope> {
    switch (command.type) {
      case CommandTypes.FEISHU_PRODUCT_WRITE_PREVIEW: {
        if (!isFeishuProductWritePreviewPayload(command.payload)) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INVALID_PAYLOAD',
            message: '非法的 FEISHU_PRODUCT_WRITE_PREVIEW 负载：需要非空 itemIds 数组',
          })
        }
        try {
          return createResponse(command.requestId, command.type, await preview(command.payload.itemIds))
        } catch (error) {
          return toErrorResponse(command, error)
        }
      }
      case CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE: {
        if (!isFeishuProductWriteExecutePayload(command.payload)) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INVALID_PAYLOAD',
            message: '非法的 FEISHU_PRODUCT_WRITE_EXECUTE 负载：需要 previewId 与 confirm:true',
          })
        }
        if (executing) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INTERNAL',
            message: '已有飞书商品写入正在进行，请稍后重试',
          })
        }
        executing = true
        try {
          return createResponse(command.requestId, command.type, await execute(command.payload.previewId))
        } catch (error) {
          return toErrorResponse(command, error)
        } finally {
          executing = false
        }
      }
      default:
        return createErrorResponse(command.requestId, command.type, {
          code: 'UNKNOWN_COMMAND',
          message: `非飞书商品写入命令: ${command.type}`,
        })
    }
  }

  return { handleCommand }
}
