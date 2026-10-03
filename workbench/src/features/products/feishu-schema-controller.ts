/**
 * 飞书商品字段同步控制器（workbench 侧 schema reconciliation）。纯 TypeScript，可在 Node 下单测。
 *
 * 职责与安全规范（硬性）：
 * 1. 显式两阶段：必须先只读预览（FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW），后显式确认执行（FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE）；
 * 2. 默认并集策略（UNION）：本地商品库字段 ∪ 飞书表实际字段，只补充创建缺失字段，绝不以字段多的一方破坏性覆盖；
 * 3. 绝不删除字段：仅在飞书存在的字段仅展示报告供审计，绝不发起任何删除调用；
 * 4. 类型冲突默认阻止：若存在同名类型冲突（typeConflicts），默认阻止执行；只有用户显式确认（acceptTypeConflicts: true）才允许执行，且即使确认也不会覆盖飞书类型；
 * 5. 目标表变更 / 过期后强制重新预览：
 *    - 预览具有 TTL（FEISHU_SCHEMA_RECONCILE_PREVIEW_TTL_MS，5 分钟）；
 *    - 到期或目标表变更后，严禁继续执行，必须作废并要求重新生成预览；
 * 6. 执行按钮不自动触发、不自动重试：
 *    - 生命周期 start() 绝不调用任何后台命令；
 *    - 执行失败时直接给出结构化错误并作废 preview，绝不静默自动重试；
 * 7. 一次性 previewId 防重放：执行后无论成功或失败，绑定的 preview 均立即失效；
 * 8. 未配置飞书状态识别：当后台返回配置缺失时，设置 isConfigMissing: true，以便 UI 提供直达设置页的入口；
 * 9. 脱敏安全：所有错误和状态不暴露任何密钥、token 等凭据。
 */

import { CommandTypes } from '@fishops/shared'
import {
  FEISHU_SCHEMA_RECONCILE_STRATEGY,
  type FeishuConfigStatus,
  type FeishuProductSchemaReconcileExecutePayload,
  type FeishuProductSchemaReconcileExecuteResult,
  type FeishuProductSchemaReconcilePreviewResult,
  type FeishuProductWriteFieldTypeConflict,
  type FeishuSchemaReconcileStrategy,
} from '../contracts'
import type { BridgeApi } from '../shared/bridge-api'
import { toErrorView, type ErrorView } from '../shared/error-format'
import { StateStore, type LoadPhase } from '../shared/state-store'

/**
 * 飞书目标表绑定信息（非敏感载体）。
 * 严禁包含 appSecret 或明文 token。
 *
 * UI 预览失效口径统一为 productTableId：appId / spreadsheetToken 仅由调用方携带，
 * 不参与 UI 侧比较。原因：FEISHU_CONFIG_STATUS 只返回 has 布尔、不回 token 明文，
 * 若在 UI 侧用 status / description 拼装含 token 的指纹，会造成「目标未变却被判为变更」的误作废。
 * appId / spreadsheetToken 的真实变更由后端完整 targetKey（appId|spreadsheetToken|productTableId）
 * 在 execute 阶段兜底拒绝。
 */
export interface FeishuTargetBindingInfo {
  appId?: string | null
  spreadsheetToken?: string | null
  productTableId?: string | null
}

/**
 * 解析目标绑定中的 productTableId（UI 预览失效的唯一比较口径）。
 *
 * 传入字符串按 tableId 处理；无法解析出非空 tableId 时返回 null（此时不作废预览，避免误伤）。
 */
export function resolveFeishuTargetTableId(
  target: FeishuTargetBindingInfo | string | null | undefined,
): string | null {
  if (!target) return null
  if (typeof target === 'string') return target.trim() || null
  const tableId = (target.productTableId ?? '').trim()
  return tableId || null
}

/** 飞书目标表配置变动的自定义事件名称（workbench 内部广播）。 */
export const FEISHU_TARGET_CONFIG_CHANGED_EVENT = 'fishops:feishu-target-changed'

/**
 * 广播飞书目标配置发生变动的非敏感通知。
 * 只广播 productTableId（UI 比较口径），不含任何 secret / token / 指纹。
 */
export function broadcastFeishuTargetChanged(binding: FeishuTargetBindingInfo): void {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  try {
    const productTableId = binding.productTableId?.trim() || undefined
    const event = new CustomEvent(FEISHU_TARGET_CONFIG_CHANGED_EVENT, {
      detail: { productTableId },
    })
    window.dispatchEvent(event)
  } catch {
    // 环境容错
  }
}

/**
 * 旧历史口径的关键字段名：
 * 历史存量表中常被误设为文本（type 1）的字段：
 * - 价格（期望类型 2 数字，旧存量表误设为 1 文本）
 * - 原价（期望类型 2 数字，旧存量表误设为 1 文本）
 * - 发布时间（期望类型 5 日期时间，旧存量表误设为 1 文本）
 * - 采集时间（期望类型 5 日期时间，旧存量表误设为 1 文本）
 */
export const LEGACY_TEXT_FIELD_CONFLICT_NAMES = ['价格', '原价', '发布时间', '采集时间'] as const

/**
 * 格式化飞书多维表格字段类型编码为易读中文名称。
 */
export function formatFeishuTypeName(code: number): string {
  switch (code) {
    case 1:
      return '文本'
    case 2:
      return '数字'
    case 3:
      return '单选'
    case 4:
      return '多选'
    case 5:
      return '日期时间'
    case 7:
      return '复选框'
    case 11:
      return '人员'
    case 13:
      return '电话号码'
    case 15:
      return '超链接'
    case 17:
      return '附件'
    case 18:
      return '单向关联'
    case 21:
      return '双向关联'
    case 1001:
      return '创建时间'
    case 1002:
      return '修改时间'
    default:
      return `类型(${code})`
  }
}

/**
 * 判定单条类型冲突是否属于旧历史口径（文本型关键字段）。
 */
export function isLegacyTextFieldConflict(conflict: FeishuProductWriteFieldTypeConflict): boolean {
  if (!conflict || typeof conflict.name !== 'string') return false
  const name = conflict.name.trim()
  if (!LEGACY_TEXT_FIELD_CONFLICT_NAMES.includes(name as any)) return false
  // 期望为数字(2)或日期时间(5)，但实际在飞书表中为文本(1)
  return conflict.actualType === 1 && (conflict.expectedType === 2 || conflict.expectedType === 5)
}

/**
 * 从类型冲突列表中筛选出旧历史口径的冲突项。
 */
export function extractLegacyTextFieldConflicts(
  conflicts: FeishuProductWriteFieldTypeConflict[] | null | undefined,
): FeishuProductWriteFieldTypeConflict[] {
  if (!Array.isArray(conflicts)) return []
  return conflicts.filter(isLegacyTextFieldConflict)
}

/**
 * 旧历史口径字段人工迁移指引单项。
 */
export interface LegacyFieldMigrationGuideItem {
  /** 字段名（例如：价格、原价、发布时间、采集时间） */
  name: string
  /** 当前飞书多维表格中的实际类型编码（如 1） */
  actualType: number
  /** 当前飞书多维表格中的实际类型名称（如 文本） */
  actualTypeName: string
  /** 系统要求的规范目标类型编码（如 2 或 5） */
  expectedType: number
  /** 系统要求的规范目标类型名称（如 数字、日期时间） */
  expectedTypeName: string
  /** 针对该字段的具体人工操作说明 */
  adjustmentHint: string
}

/**
 * 旧历史口径关键字段人工迁移指引结构体。
 * 清晰、可操作但不自动改表，指导用户在飞书后台安全调整。
 */
export interface LegacyFieldMigrationGuide {
  /** 是否存在冲突已阻断执行 */
  isBlocked: boolean
  /** 冲突字段清单与类型对照 */
  fields: LegacyFieldMigrationGuideItem[]
  /** 步骤 1：先备份说明 */
  backupNotice: string
  /** 步骤 2：新建正确类型字段或人工调整说明 */
  migrationAdvice: string
  /** 步骤 3：旧列保留说明（旧列不要自动删除） */
  retentionNotice: string
  /** 步骤 4：调整后重新预览说明 */
  recheckNotice: string
  /** 严格安全守卫：没有任何自动执行按钮说明 */
  noAutoExecutionNotice: string
}

/**
 * 构建旧历史口径关键字段（价格/原价/发布时间/采集时间文本冲突）人工迁移指引。
 * 纯函数，不修改外部状态，便于严格测试与 UI 渲染。
 */
export function buildLegacyMigrationGuide(
  conflicts: FeishuProductWriteFieldTypeConflict[] | null | undefined,
): LegacyFieldMigrationGuide | null {
  const legacyConflicts = extractLegacyTextFieldConflicts(conflicts)
  if (legacyConflicts.length === 0) {
    return null
  }

  const fields: LegacyFieldMigrationGuideItem[] = legacyConflicts.map((c) => {
    const actualTypeName = formatFeishuTypeName(c.actualType)
    const expectedTypeName = formatFeishuTypeName(c.expectedType)
    let adjustmentHint = ''
    if (c.name === '价格' || c.name === '原价') {
      adjustmentHint = `飞书后台类型须由「${actualTypeName}」调整为「${expectedTypeName}」（数字类型，支持浮点/定点金额存储）`
    } else if (c.name === '发布时间' || c.name === '采集时间') {
      adjustmentHint = `飞书后台类型须由「${actualTypeName}」调整为「${expectedTypeName}」（日期时间类型，精确到秒）`
    } else {
      adjustmentHint = `飞书后台类型须由「${actualTypeName}」调整为「${expectedTypeName}」`
    }

    return {
      name: c.name,
      actualType: c.actualType,
      actualTypeName,
      expectedType: c.expectedType,
      expectedTypeName,
      adjustmentHint,
    }
  })

  return {
    isBlocked: true,
    fields,
    backupNotice: '【数据备份】在进入飞书多维表格后台操作前，务必先将当前数据导出为 Excel/CSV 或创建表格副本备份，以防误操作导致存量历史数据丢失。',
    migrationAdvice: '【人工调整方案（二选一）】\n· 方案 A（推荐，平滑新建）：在飞书后台新建对应目标类型（数字或日期时间）的标准字段，将历史文本数据清洗转换后填入新字段；\n· 方案 B（直接变更）：在飞书多维表格字段设置中，直接将该列字段类型编辑修改为目标类型（文本改为数字/日期时间），注意检查飞书系统自动类型转换后的数值与时间格式。',
    retentionNotice: '【旧列严禁自动删除】切勿删除旧的文本列！保留存量旧字段作为历史数据对照与回退备份，避免不可逆丢失数据或破坏既有公式与引用。',
    recheckNotice: '【调整后重新预览】完成飞书后台字段调整后，返回本页面点击「重新生成预览」。系统将重新读取真实表结构比对；当所有冲突解除后，执行通道将自动恢复。',
    noAutoExecutionNotice: '【严格守卫】系统已完全阻断自动写入与自动改表。此处不提供任何自动执行、自动迁移或自动修改表结构的按钮，所有类型调整均须由管理员在飞书管理后台安全完成。',
  }
}

export interface FeishuSchemaReconcileState {
  availability: 'unavailable' | 'ready'
  /** 预览状态。过期或目标表变更时作废。 */
  preview: {
    phase: LoadPhase
    result: FeishuProductSchemaReconcilePreviewResult | null
    error: ErrorView | null
    previewedAt: number | null
  }
  /** 执行字段同步状态。仅在合法未过期的预览后由用户显式触发。 */
  execute: {
    phase: LoadPhase
    result: FeishuProductSchemaReconcileExecuteResult | null
    error: ErrorView | null
    executedAt: number | null
  }
  /** 字段同步采用的策略：固定为并集（UNION）。 */
  strategy: FeishuSchemaReconcileStrategy
  /** 当前预览绑定的目标商品表 ID（UI 预览失效的唯一比较口径）。若外部配置变动与此不符，强制重新预览。 */
  boundTargetTableId: string | null
  /** 是否因飞书未配置导致失败（用于 UI 显示前往设置页的导航入口）。 */
  isConfigMissing: boolean
}

export interface FeishuSchemaReconcileControllerOptions {
  api: BridgeApi | null
  now?: () => number
}

export function isFeishuPreviewExpired(
  expiresAt: number | null | undefined,
  now: number,
): boolean {
  if (typeof expiresAt !== 'number') return false
  return now >= expiresAt
}

export function checkIsConfigMissing(view: ErrorView): boolean {
  const combined = `${view.title} ${view.hint} ${view.detail} ${view.code}`.toLowerCase()
  return (
    combined.includes('飞书未配置') ||
    combined.includes('未配置飞书') ||
    combined.includes('config_missing') ||
    combined.includes('请先在配置页填写飞书') ||
    combined.includes('目标表不存在')
  )
}

export function createInitialFeishuSchemaState(
  availability: FeishuSchemaReconcileState['availability'],
): FeishuSchemaReconcileState {
  return {
    availability,
    preview: {
      phase: 'idle',
      result: null,
      error: null,
      previewedAt: null,
    },
    execute: {
      phase: 'idle',
      result: null,
      error: null,
      executedAt: null,
    },
    strategy: FEISHU_SCHEMA_RECONCILE_STRATEGY,
    boundTargetTableId: null,
    isConfigMissing: false,
  }
}

export class FeishuSchemaReconcileController extends StateStore<FeishuSchemaReconcileState> {
  private readonly api: BridgeApi | null
  private readonly now: () => number
  private previewSeq = 0
  private targetChangeListener: ((event: Event) => void) | null = null

  constructor(options: FeishuSchemaReconcileControllerOptions) {
    super(createInitialFeishuSchemaState(options.api ? 'ready' : 'unavailable'))
    this.api = options.api
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 控制器生命周期挂载。
   * 安全保证：绝不挂载自动发起预览或自动执行！
   * 仅监听飞书目标配置变动通知事件，以便在外部配置修改时主动感知并作废预览。
   */
  start(): void {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && !this.targetChangeListener) {
      this.targetChangeListener = (e: Event) => {
        const customEvent = e as CustomEvent<FeishuTargetBindingInfo>
        if (customEvent.detail) {
          this.notifyTargetTableChanged(customEvent.detail)
        } else {
          this.notifyTargetTableChanged()
        }
      }
      window.addEventListener(FEISHU_TARGET_CONFIG_CHANGED_EVENT, this.targetChangeListener)
    }
  }

  override dispose(): void {
    if (this.targetChangeListener && typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener(FEISHU_TARGET_CONFIG_CHANGED_EVENT, this.targetChangeListener)
      this.targetChangeListener = null
    }
    super.dispose()
  }

  resubscribe(): void {
    if (this.disposed || !this.api) return
    try {
      this.api.resubscribe()
    } catch {
      // 容错忽略
    }
  }

  /**
   * 检查当前预览是否仍然合法可用（未过期且处于 ready 状态）。
   */
  isCurrentPreviewValid(): boolean {
    const preview = this.state.preview
    if (preview.phase !== 'ready' || !preview.result) return false
    return !isFeishuPreviewExpired(preview.result.expiresAt, this.now())
  }

  /**
   * 作废并清空当前预览与执行状态（强制重新预览）。
   */
  invalidatePreview(): void {
    if (this.disposed) return
    this.patch({
      preview: {
        phase: 'idle',
        result: null,
        error: null,
        previewedAt: null,
      },
      execute: {
        phase: 'idle',
        result: null,
        error: null,
        executedAt: null,
      },
      boundTargetTableId: null,
    })
  }

  /**
   * 当检测到目标商品表配置发生变动时通知控制器。
   *
   * UI 预览失效口径统一为 productTableId：仅当当前已绑定目标、且新目标能解析出非空
   * tableId、且与当前绑定不同时才作废预览。appId / spreadsheetToken 变化不参与比较
   * （由后端完整 targetKey 兜底拒绝），避免刷新 / 打开面板等操作误作废。
   */
  notifyTargetTableChanged(newTarget?: string | FeishuTargetBindingInfo | null): void {
    if (this.disposed) return
    const boundTableId = this.state.boundTargetTableId
    // 若当前并未绑定任何目标，无需作废
    if (!boundTableId) return

    if (!newTarget) {
      // 目标被清空或重置，立即作废
      this.invalidatePreview()
      return
    }

    const newTableId = resolveFeishuTargetTableId(newTarget)
    // 无法解析出目标 tableId（如 status 只回 has 布尔）时不作废，避免误伤
    if (!newTableId) return
    if (newTableId !== boundTableId) {
      this.invalidatePreview()
    }
  }

  /**
   * 安全状态检查（至少在 ProductsPage 进入/刷新时调用，不要依赖后端执行才失败）。
   *
   * 规范与防护：
   * 1. 调用 FEISHU_CONFIG_STATUS 获取当前配置存在性（只读、无凭据明文）；
   * 2. 若配置缺失，标记 isConfigMissing: true，并立即作废既有预览；
   * 3. 若配置完整，尝试通过 DATA_SOURCE_SCHEMA({ type: 'feishu' }) 读取当前实际绑定的目标表信息，
   *    以 productTableId 作为唯一口径与当前预览绑定比较；若不一致立即作废既有预览
   *    （不解析 / 不伪造含 token 的指纹，避免目标未变却误作废）；
   * 4. 消除对后台 execute 才报错的被动依赖。
   */
  async checkSafetyStatus(): Promise<{
    ok: boolean
    isConfigMissing: boolean
    targetChanged: boolean
  }> {
    const api = this.api
    if (this.disposed || !api) {
      return { ok: false, isConfigMissing: false, targetChanged: false }
    }

    try {
      const status: FeishuConfigStatus = await api.call(CommandTypes.FEISHU_CONFIG_STATUS, {})
      if (this.disposed) return { ok: false, isConfigMissing: false, targetChanged: false }

      // 检查必需字段存在性
      const missing =
        !status ||
        !status.configured ||
        !status.hasAppId ||
        !status.hasAppSecret ||
        !status.hasSpreadsheetToken ||
        !status.hasProductTableId

      if (missing) {
        const wasBound = Boolean(this.state.boundTargetTableId)
        if (wasBound) {
          this.invalidatePreview()
        }
        this.patch({ isConfigMissing: true })
        return { ok: false, isConfigMissing: true, targetChanged: wasBound }
      }

      this.patch({ isConfigMissing: false })

      // 若当前已有预览绑定，通过 DATA_SOURCE_SCHEMA 校验当前目标表是否发生变动。
      // 统一口径为 productTableId：不解析 / 不伪造 token 指纹，避免目标未变却误作废。
      let targetChanged = false
      if (this.state.boundTargetTableId) {
        try {
          const dsResult: any = await api.call(CommandTypes.DATA_SOURCE_SCHEMA, { type: 'feishu' })
          if (this.disposed) return { ok: true, isConfigMissing: false, targetChanged: false }

          if (dsResult && dsResult.schema && typeof dsResult.schema.description === 'string') {
            const tableMatch = dsResult.schema.description.match(/table=([^\s,;]+)/)
            const currentTable = tableMatch ? tableMatch[1].trim() : null
            if (currentTable && this.state.boundTargetTableId && currentTable !== this.state.boundTargetTableId) {
              targetChanged = true
              this.notifyTargetTableChanged(currentTable)
            }
          }
        } catch {
          // 只读校验容错，不阻断正常流程
        }
      }

      return { ok: true, isConfigMissing: false, targetChanged }
    } catch {
      return { ok: false, isConfigMissing: false, targetChanged: false }
    }
  }

  /**
   * 发起只读字段同步预览（FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW）。
   * 严格空 payload，绝不接受任意 tableId，绝不写入任何字段。
   */
  async preview(): Promise<FeishuProductSchemaReconcilePreviewResult | null> {
    const api = this.api
    if (this.disposed || !api) {
      this.patch({
        preview: {
          phase: 'error',
          result: null,
          error: {
            title: '不可用',
            hint: '当前环境未连接扩展后台',
            detail: '无法调用飞书字段同步命令',
            kind: 'unavailable',
            code: 'BRIDGE_UNAVAILABLE',
          },
          previewedAt: null,
        },
      })
      return null
    }

    if (this.state.execute.phase === 'loading') {
      return null
    }

    const seq = ++this.previewSeq
    this.patch({
      preview: {
        phase: 'loading',
        result: null,
        error: null,
        previewedAt: null,
      },
      isConfigMissing: false,
    })

    try {
      const res = await api.call(CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_PREVIEW, {})
      if (this.disposed || seq !== this.previewSeq) return null

      if (!res || typeof res.previewId !== 'string') {
        throw new Error('飞书字段同步预览返回了非法的数据结构')
      }

      this.patch({
        preview: {
          phase: 'ready',
          result: res,
          error: null,
          previewedAt: this.now(),
        },
        boundTargetTableId: res.targetTableId ?? null,
        isConfigMissing: false,
        // 新生成预览时重置执行状态
        execute: {
          phase: 'idle',
          result: null,
          error: null,
          executedAt: null,
        },
      })
      return res
    } catch (error) {
      if (this.disposed || seq !== this.previewSeq) return null
      const errorView = toErrorView(error)
      const missing = checkIsConfigMissing(errorView)

      this.patch({
        preview: {
          phase: 'error',
          result: null,
          error: errorView,
          previewedAt: null,
        },
        boundTargetTableId: null,
        isConfigMissing: missing,
      })
      return null
    }
  }

  /**
   * 显式确认执行字段同步（FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE）。
   *
   * 安全与合规拦截：
   * 1. 必须在经过成功的 preview 之后触发；
   * 2. 预览到期后禁止执行，强制重新预览；
   * 3. 同名类型冲突默认阻止；只有显式 options.acceptTypeConflicts: true 才放行；
   * 4. 必须显式 confirm: true；
   * 5. 执行后立即作废 previewId，防止重放；
   * 6. 执行失败绝不自动重试。
   */
  async execute(options: {
    confirm: true
    acceptTypeConflicts?: boolean
  }): Promise<FeishuProductSchemaReconcileExecuteResult | null> {
    const api = this.api
    if (this.disposed || !api) {
      this.patch({
        execute: {
          phase: 'error',
          result: null,
          error: {
            title: '不可用',
            hint: '当前环境未连接扩展后台',
            detail: '无法调用飞书字段同步命令',
            kind: 'unavailable',
            code: 'BRIDGE_UNAVAILABLE',
          },
          executedAt: null,
        },
      })
      return null
    }

    if (this.state.execute.phase === 'loading') {
      return null
    }

    if (!options || options.confirm !== true) {
      this.patch({
        execute: {
          phase: 'error',
          result: null,
          error: {
            title: '操作未确认',
            hint: '必须显式确认同意执行真实字段变更',
            detail: '缺少 confirm: true 确认参数',
            kind: 'validation',
            code: 'UNCONFIRMED',
          },
          executedAt: null,
        },
      })
      return null
    }

    const preview = this.state.preview
    if (preview.phase !== 'ready' || !preview.result) {
      this.patch({
        execute: {
          phase: 'error',
          result: null,
          error: {
            title: '缺少有效预览',
            hint: '执行前必须先进行只读字段比对预览',
            detail: '当前尚未生成有效的飞书字段同步预览',
            kind: 'validation',
            code: 'PREVIEW_REQUIRED',
          },
          executedAt: null,
        },
      })
      return null
    }

    const previewResult = preview.result

    // 检查过期：到期后强制重新预览
    if (isFeishuPreviewExpired(previewResult.expiresAt, this.now())) {
      this.invalidatePreview()
      this.patch({
        execute: {
          phase: 'error',
          result: null,
          error: {
            title: '预览已过期',
            hint: '本次字段同步预览已超过有效期限（5 分钟）',
            detail: '为保证飞书多维表格结构准确，原预览已作废，请重新生成预览',
            kind: 'validation',
            code: 'PREVIEW_EXPIRED',
          },
          executedAt: null,
        },
      })
      return null
    }

    // 检查是否存在旧历史口径同名类型冲突（价格/原价/发布时间/采集时间为文本类型）
    // 存量表必须人工在飞书迁移或改类型，系统后台 accept 仅创建缺失字段，绝不改类型；
    // 严禁通过 acceptTypeConflicts 让执行成功！
    const legacyConflicts = extractLegacyTextFieldConflicts(previewResult.typeConflicts)
    if (legacyConflicts.length > 0) {
      const names = legacyConflicts.map((c) => `「${c.name}」`).join('、')
      this.patch({
        execute: {
          phase: 'error',
          result: null,
          error: {
            title: '检测到关键字段历史口径冲突',
            hint: '存量表需人工迁移/改类型，系统不会覆盖已有字段；暂不能执行商品写入。',
            detail: `飞书目标表中 ${names} 为文本类型，系统要求价格/原价为数字、发布/采集时间为日期时间。后台同步仅补充缺失字段，不会修改已有字段类型；即使确认也无法使商品写入成功，必须先在飞书人工调整字段类型。`,
            kind: 'validation',
            code: 'LEGACY_TYPE_CONFLICT_BLOCKED',
          },
          executedAt: null,
        },
      })
      return null
    }

    // 检查其他同名类型冲突：默认阻止，除非用户明确确认知悉
    const hasConflicts = (previewResult.typeConflicts?.length ?? 0) > 0 || previewResult.requiresConfirmation
    if (hasConflicts && options.acceptTypeConflicts !== true) {
      this.patch({
        execute: {
          phase: 'error',
          result: null,
          error: {
            title: '存在同名类型冲突',
            hint: '飞书目标表存在与本地商品库类型不一致的同名字段',
            detail: '系统默认阻止执行；飞书 API 无法安全变更字段类型。如需继续同步其他缺失字段，请先在飞书调整或显式确认已知悉冲突。',
            kind: 'validation',
            code: 'TYPE_CONFLICT_UNACCEPTED',
          },
          executedAt: null,
        },
      })
      return null
    }

    const boundPreviewId = previewResult.previewId

    this.patch({
      execute: {
        phase: 'loading',
        result: null,
        error: null,
        executedAt: null,
      },
    })

    const payload: FeishuProductSchemaReconcileExecutePayload = {
      previewId: boundPreviewId,
      confirm: true,
      ...(options.acceptTypeConflicts ? { acceptTypeConflicts: true } : {}),
    }

    try {
      const res = await api.call(CommandTypes.FEISHU_PRODUCT_SCHEMA_RECONCILE_EXECUTE, payload)
      if (this.disposed) return null

      // 执行后立即作废旧 preview（一次性 previewId，防止重放）
      this.patch({
        preview: {
          phase: 'idle',
          result: null,
          error: null,
          previewedAt: null,
        },
        execute: {
          phase: 'ready',
          result: res,
          error: null,
          executedAt: this.now(),
        },
        boundTargetTableId: null,
        isConfigMissing: false,
      })
      return res
    } catch (error) {
      if (this.disposed) return null
      const errorView = toErrorView(error)
      const missing = checkIsConfigMissing(errorView)

      // 无论失败原因是什么，旧 previewId 均已失效，必须作废并要求重新预览；绝不自动重试
      this.patch({
        preview: {
          phase: 'idle',
          result: null,
          error: null,
          previewedAt: null,
        },
        execute: {
          phase: 'error',
          result: null,
          error: errorView,
          executedAt: this.now(),
        },
        boundTargetTableId: null,
        isConfigMissing: missing,
      })
      return null
    }
  }

  /**
   * 重置执行结果状态。
   */
  resetExecute(): void {
    if (this.disposed) return
    this.patch({
      execute: {
        phase: 'idle',
        result: null,
        error: null,
        executedAt: null,
      },
    })
  }
}
