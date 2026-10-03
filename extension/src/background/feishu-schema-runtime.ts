/**
 * 飞书表字段同步后台运行时（P7 schema reconciliation）。
 *
 * 职责：把「本地商品库字段」与「已配置飞书商品表字段」做可审计的一致性对齐。严格分离两阶段：
 * - `FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW`：**只读**（读飞书真实字段），返回结构化 diff +
 *   短期 `previewId`，缓存目标配置与字段目标指纹，绝不创建 / 修改 / 删除字段；
 * - `FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE`：必须携带 `previewId` + `confirm: true`，
 *   复验目标配置 / 字段目标未变后才创建缺失字段（幂等）。
 *
 * 安全与边界（硬性）：
 * - 只操作已配置的 `productTableId`：命令不接受 tableId 等任意目标（目标表绑定）；
 * - 目标为**并集**（本地字段 ∪ 飞书字段），不是破坏性覆盖；「哪边字段更多」不改变策略，只影响 union 规模；
 * - **同名类型冲突绝不静默覆盖**：存在冲突时缺省整体拒绝执行，需显式 `acceptTypeConflicts: true`；
 *   且即使确认也不自动改类型（飞书字段类型变更不安全），改为返回人工操作建议；
 * - **缺失字段仅由本命令显式创建**：普通写入不调用创建接口，不会隐式建字段；
 * - **删除字段绝不自动执行**：仅飞书存在的字段只做报告；
 * - 一次性 previewId + 限量 + 串行并发保护；结果 / 错误结构化且不含 appSecret / token。
 */
import {
  CommandTypes,
  createErrorResponse,
  createResponse,
  genRequestId,
  isFeishuProductSchemaReconcileExecutePayload,
  isFeishuProductSchemaReconcilePreviewPayload,
  type CommandEnvelope,
  type ProtocolErrorCode,
  type ResponseEnvelope,
} from '@fishops/shared'
import { FeishuDataSource } from '../../../shared/data-source/feishu-data-source'
import { FeishuError, type FeishuConfig, type HttpTransport } from '../../../shared/data-source/feishu-types'
import {
  FEISHU_SCHEMA_RECONCILE_CAPABILITY,
  FEISHU_SCHEMA_RECONCILE_STRATEGY,
  LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION,
  diffFeishuSchema,
  type FeishuSchemaDiff,
} from '../../../shared/data-source/feishu-schema-reconcile'
import { FEISHU_SCHEMA_RECONCILE_PREVIEW_TTL_MS } from '../../../shared/types/feishu-schema-reconcile'
import type {
  FeishuProductSchemaReconcileExecuteResult,
  FeishuProductSchemaReconcilePreviewResult,
} from '../../../shared/types/feishu-schema-reconcile'
import type { FeishuConfigStore } from '../data-source/feishu-config-store'

/** 字段同步运行时依赖。 */
export interface FeishuSchemaRuntimeDeps {
  /** 飞书配置存储（只读取已配置商品表，密钥仅用于请求层）。 */
  feishuConfigStore: FeishuConfigStore
  /** 可注入的 HTTP 传输器（单测 / 离线环境 Mock）；缺省走原生 fetch。 */
  transport?: HttpTransport
  /** 可注入的时间源（令牌缓存过期判断与预览 TTL）。 */
  now?: () => number
  /** 预览有效期（毫秒，缺省 {@link FEISHU_SCHEMA_RECONCILE_PREVIEW_TTL_MS}）。 */
  previewTtlMs?: number
}

/** 飞书表字段同步运行时。 */
export interface FeishuSchemaRuntime {
  handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope>
}

/** 需要交由飞书字段同步运行时处理的命令。 */
export const FEISHU_SCHEMA_COMMANDS: ReadonlySet<string> = new Set<string>([
  CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW,
  CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE,
])

/** 内部结构化错误：包一层便于统一映射为 ProtocolError。 */
class FeishuSchemaError extends Error {
  readonly code: ProtocolErrorCode

  constructor(code: ProtocolErrorCode, message: string) {
    super(message)
    this.name = 'FeishuSchemaError'
    this.code = code
  }
}

/** 预览缓存项（绑定目标配置与字段目标指纹，供执行复验）。 */
interface CachedSchemaPreview {
  previewId: string
  /** 目标指纹：appId + spreadsheetToken + productTableId（非敏感，仅内存复验）。 */
  targetKey: string
  /** 字段目标指纹（本地投影的 name:type 顺序拼接）。 */
  desiredKey: string
  expiresAt: number
}

/** 将 FeishuError 映射为固定、非敏感的字段同步错误（绝不透传底层 message / URL / 凭据）。 */
function mapFeishuError(error: FeishuError): FeishuSchemaError {
  switch (error.category) {
    case 'AUTH_FAILED':
      return new FeishuSchemaError('INVALID_PAYLOAD', '飞书鉴权失败：请检查 appId / appSecret 配置是否正确')
    case 'NOT_FOUND':
      return new FeishuSchemaError('INVALID_PAYLOAD', '飞书目标表不存在：请检查商品表配置是否正确')
    case 'RATE_LIMITED':
      return new FeishuSchemaError('INTERNAL', '飞书接口频率超限：请稍后重试')
    case 'NETWORK_ERROR':
      return new FeishuSchemaError('INTERNAL', '飞书网络请求失败：请检查网络后重试')
    case 'BATCH_TOO_LARGE':
      return new FeishuSchemaError('INTERNAL', '飞书请求超出上限：请减少单次字段变更数量后重试')
    case 'INVALID_PARAM':
      return new FeishuSchemaError('INVALID_PAYLOAD', '飞书请求参数不合法：请检查飞书配置是否正确')
    case 'API_ERROR':
    default:
      return new FeishuSchemaError('INTERNAL', '飞书字段同步失败：请检查飞书配置与目标表后重试')
  }
}

/** 目标表指纹（非敏感）：应用 + 多维表格 + 商品表。 */
function buildTargetKey(config: FeishuConfig): string {
  return `${config.appId}|${config.spreadsheetToken}|${config.productTableId}`
}

/** 字段目标指纹：本地投影的 `name:type` 顺序拼接，用于复验字段目标未变。 */
function buildDesiredKey(): string {
  return LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION.map((field) => `${field.name}:${field.type}`).join('|')
}

/** 组装可行动、非敏感的人工操作建议。 */
function buildManualActions(diff: FeishuSchemaDiff): string[] {
  const actions: string[] = []
  if (diff.typeConflicts.length > 0) {
    const detail = diff.typeConflicts
      .map((conflict) => `${conflict.name}（期望类型 ${conflict.expectedType}，飞书实际 ${conflict.actualType}）`)
      .join('、')
    actions.push(
      `同名字段类型冲突：${detail}。本功能不会自动覆盖字段类型（飞书类型变更不安全），` +
        '请在飞书多维表格中手动调整字段类型或改用同义字段后重新预览。',
    )
  }
  if (diff.feishuOnly.length > 0) {
    actions.push(
      `仅飞书存在、本地商品库未声明的字段：${diff.feishuOnly.join('、')}。本功能绝不删除字段；` +
        '如需在本地保留请在本地字段定义中补充，否则请人工确认去留。',
    )
  }
  return actions
}

/** 组装可行动、非敏感的缺失 / 冲突描述，用于拒绝执行的错误信息。 */
function describeSchemaProblems(diff: FeishuSchemaDiff): string {
  const parts: string[] = []
  if (diff.typeConflicts.length > 0) {
    parts.push(
      `类型冲突「${diff.typeConflicts
        .map((conflict) => `${conflict.name}（期望 ${conflict.expectedType}，实际 ${conflict.actualType}）`)
        .join('、')}」`,
    )
  }
  return parts.join('；')
}

/** 创建飞书表字段同步运行时。 */
export function createFeishuSchemaRuntime(deps: FeishuSchemaRuntimeDeps): FeishuSchemaRuntime {
  const previewTtlMs = deps.previewTtlMs ?? FEISHU_SCHEMA_RECONCILE_PREVIEW_TTL_MS
  const now = deps.now ?? (() => Date.now())

  /** 当前是否已有字段同步在执行（串行并发保护）。 */
  let reconciling = false

  /** 预览缓存（previewId → 绑定信息）；一次性、带 TTL。 */
  const previews = new Map<string, CachedSchemaPreview>()

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

  /** 只读预览：读取真实字段并与本地投影做并集 diff，生成短期 previewId（绝不写入）。 */
  async function preview(): Promise<FeishuProductSchemaReconcilePreviewResult> {
    prunePreviews()

    const resolved = await getDataSource()
    if (!resolved) {
      throw new FeishuSchemaError('INVALID_PAYLOAD', '飞书未配置：请先在配置页填写飞书应用与商品表信息')
    }
    const { source, config } = resolved
    const tableId = config.productTableId

    const diff = diffFeishuSchema(LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION, await source.getTableFields(tableId))

    const previewId = genRequestId()
    const expiresAt = now() + previewTtlMs
    previews.set(previewId, {
      previewId,
      targetKey: buildTargetKey(config),
      desiredKey: buildDesiredKey(),
      expiresAt,
    })

    return {
      previewId,
      expiresAt,
      targetTableId: tableId,
      strategy: FEISHU_SCHEMA_RECONCILE_STRATEGY,
      targetFieldCount: diff.targetFieldCount,
      localFieldCount: diff.localFieldCount,
      feishuFieldCount: diff.feishuFieldCount,
      toCreate: diff.toCreate.map((field) => ({ name: field.name, type: field.type })),
      inSync: diff.inSync,
      typeConflicts: diff.typeConflicts,
      feishuOnly: diff.feishuOnly,
      requiresConfirmation: diff.typeConflicts.length > 0,
      canAutoApply: diff.typeConflicts.length === 0,
      fieldApiCapability: FEISHU_SCHEMA_RECONCILE_CAPABILITY,
      manualActions: buildManualActions(diff),
    }
  }

  /**
   * 执行字段同步：复验 previewId、目标配置、字段目标指纹；存在类型冲突且未显式确认时拒绝执行；
   * 随后仅创建缺失字段（幂等），绝不修改类型、绝不删除字段。
   */
  async function execute(
    previewId: string,
    acceptTypeConflicts: boolean,
  ): Promise<FeishuProductSchemaReconcileExecuteResult> {
    const cached = previews.get(previewId)
    // 一次性：无论成败都消费掉该 previewId，防止重放。
    if (cached) previews.delete(previewId)
    if (!cached) {
      throw new FeishuSchemaError('INVALID_PAYLOAD', '预览不存在或已失效，请重新预览后再执行')
    }
    if (now() > cached.expiresAt) {
      throw new FeishuSchemaError('INVALID_PAYLOAD', '预览已过期，请重新预览后再执行')
    }

    const resolved = await getDataSource()
    if (!resolved) {
      throw new FeishuSchemaError('INVALID_PAYLOAD', '飞书未配置：请先在配置页填写飞书应用与商品表信息')
    }
    const { source, config } = resolved
    const tableId = config.productTableId
    if (buildTargetKey(config) !== cached.targetKey) {
      throw new FeishuSchemaError('INVALID_PAYLOAD', '飞书目标表已变更，请重新预览后再执行')
    }
    if (buildDesiredKey() !== cached.desiredKey) {
      throw new FeishuSchemaError('INVALID_PAYLOAD', '本地字段目标已变更，请重新预览后再执行')
    }

    // 执行阶段重新读取真实字段并复算 diff：飞书端可能已变化，需据实处理（保证幂等与安全）。
    const diff = diffFeishuSchema(LOCAL_PRODUCT_FEISHU_FIELD_PROJECTION, await source.getTableFields(tableId))
    if (diff.typeConflicts.length > 0 && !acceptTypeConflicts) {
      throw new FeishuSchemaError(
        'INVALID_PAYLOAD',
        `目标商品表存在字段类型冲突：${describeSchemaProblems(diff)}。` +
          '本功能不会静默覆盖字段类型；请显式确认（acceptTypeConflicts:true）继续，' +
          '或先在飞书多维表格中手动调整字段类型后重新预览',
      )
    }

    // 仅创建缺失字段（幂等：createTableFields 内部会再次跳过已存在字段）。绝不改类型 / 删字段。
    const { created, skipped } = await source.createTableFields(tableId, diff.toCreate)

    return {
      previewId,
      targetTableId: tableId,
      strategy: FEISHU_SCHEMA_RECONCILE_STRATEGY,
      targetFieldCount: diff.targetFieldCount,
      localFieldCount: diff.localFieldCount,
      feishuFieldCount: diff.feishuFieldCount,
      createdFields: created,
      skippedExistingFields: skipped,
      typeConflicts: diff.typeConflicts,
      feishuOnly: diff.feishuOnly,
      manualActions: buildManualActions(diff),
    }
  }

  /** 统一把内部错误映射为合法响应（固定文案，不回显底层异常 / 凭据）。 */
  function toErrorResponse(command: CommandEnvelope, error: unknown): ResponseEnvelope {
    if (error instanceof FeishuSchemaError) {
      return createErrorResponse(command.requestId, command.type, { code: error.code, message: error.message })
    }
    if (error instanceof FeishuError) {
      const mapped = mapFeishuError(error)
      return createErrorResponse(command.requestId, command.type, { code: mapped.code, message: mapped.message })
    }
    return createErrorResponse(command.requestId, command.type, {
      code: 'INTERNAL',
      message: '飞书字段同步失败：请检查飞书配置与网络后重试',
    })
  }

  async function handleCommand(command: CommandEnvelope): Promise<ResponseEnvelope> {
    switch (command.type) {
      case CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW: {
        if (!isFeishuProductSchemaReconcilePreviewPayload(command.payload)) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INVALID_PAYLOAD',
            message: '非法的 FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW 负载：不接受任何参数',
          })
        }
        try {
          return createResponse(command.requestId, command.type, await preview())
        } catch (error) {
          return toErrorResponse(command, error)
        }
      }
      case CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE: {
        if (!isFeishuProductSchemaReconcileExecutePayload(command.payload)) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INVALID_PAYLOAD',
            message: '非法的 FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE 负载：需要 previewId 与 confirm:true',
          })
        }
        if (reconciling) {
          return createErrorResponse(command.requestId, command.type, {
            code: 'INTERNAL',
            message: '已有飞书字段同步正在进行，请稍后重试',
          })
        }
        reconciling = true
        try {
          return createResponse(
            command.requestId,
            command.type,
            await execute(command.payload.previewId, command.payload.acceptTypeConflicts === true),
          )
        } catch (error) {
          return toErrorResponse(command, error)
        } finally {
          reconciling = false
        }
      }
      default:
        return createErrorResponse(command.requestId, command.type, {
          code: 'UNKNOWN_COMMAND',
          message: `非飞书字段同步命令: ${command.type}`,
        })
    }
  }

  return { handleCommand }
}
