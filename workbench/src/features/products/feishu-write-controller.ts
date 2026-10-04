/**
 * 飞书商品写入控制器（workbench 侧）。纯 TypeScript，可在 Node 下单测。
 *
 * 职责：
 * 1. 管理商品显式勾选（单选、当前页全选、清空），上限 200 件（FEISHU_WRITE_MAX_ITEMS）；
 * 2. 变更选中商品时，当前预览必须立即失效并清空，防止以旧预览执行；
 * 3. 调用后台 `FEISHU_PRODUCT_WRITE_PREVIEW` 进行只读预览（返回 previewId, expiresAt, typeConflicts 等）；
 * 4. 预览成功后，展示已配置商品表、字段兼容性（含字段缺失与类型冲突）、已有记录与待写入列表；
 * 5. 用户显式确认（confirm: true）后调用 `FEISHU_PRODUCT_WRITE_EXECUTE`（仅携带 { previewId, confirm: true }，无 itemIds）；
 * 6. 严禁挂载自动写入、严禁自动创建字段、严禁自动重试失败写入；
 * 7. 写入失败时提示实际风险（可能部分已落表），且失败后作废当前 previewId 需重新生成预览；
 * 8. 成功后禁止重放（即刻作废 preview 状态）；
 * 9. 错误与结果严格脱敏，不泄漏任何配置密钥；未配置飞书时提供导航标记。
 */

import { CommandTypes } from '@fishops/shared'
import {
  FEISHU_WRITE_MAX_ITEMS,
  type FeishuProductWriteExecuteResult,
  type FeishuProductWritePreviewResult,
} from '../contracts'
import type { BridgeApi } from '../shared/bridge-api'
import { toErrorView, type ErrorView } from '../shared/error-format'
import { StateStore, type LoadPhase } from '../shared/state-store'

export interface FeishuWriteState {
  availability: 'unavailable' | 'ready'
  /** 显式选中的商品 itemId 列表（去重、保序，上限 FEISHU_WRITE_MAX_ITEMS）。 */
  selectedItemIds: string[]
  /** 预览状态。当 selectedItemIds 变动时必须立即失效。 */
  preview: {
    phase: LoadPhase
    result: FeishuProductWritePreviewResult | null
    error: ErrorView | null
    /** 产生此预览结果对应的 itemIds（快照），用于校验执行前是否一致。 */
    targetItemIds: string[]
    previewedAt: number | null
  }
  /** 执行写入状态。必须经过成功且未过期的 preview，且用户显式确认才可触发。 */
  execute: {
    phase: LoadPhase
    result: FeishuProductWriteExecuteResult | null
    error: ErrorView | null
    /** 写入失败时的实际风险提示（绝不自动重试）。 */
    riskNotice: string | null
    executedAt: number | null
  }
  /** 是否因飞书未配置导致失败（用于 UI 显示设置页导航入口）。 */
  isConfigMissing: boolean
  /** 勾选超限等操作提示。 */
  warningMessage: string | null
}

export interface FeishuWriteControllerOptions {
  api: BridgeApi | null
  now?: () => number
}

function areArraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((id) => setA.has(id))
}

function checkIsConfigMissing(view: ErrorView): boolean {
  const combined = `${view.title} ${view.hint} ${view.detail} ${view.code}`.toLowerCase()
  return (
    combined.includes('飞书未配置') ||
    combined.includes('未配置飞书') ||
    combined.includes('config_missing') ||
    combined.includes('请先在配置页填写飞书') ||
    combined.includes('目标表不存在')
  )
}

export function isFeishuPreviewExpired(
  expiresAt: number | null | undefined,
  now: number,
): boolean {
  if (typeof expiresAt !== 'number') return false
  return now >= expiresAt
}

export function createInitialFeishuWriteState(
  availability: FeishuWriteState['availability'],
): FeishuWriteState {
  return {
    availability,
    selectedItemIds: [],
    preview: {
      phase: 'idle',
      result: null,
      error: null,
      targetItemIds: [],
      previewedAt: null,
    },
    execute: {
      phase: 'idle',
      result: null,
      error: null,
      riskNotice: null,
      executedAt: null,
    },
    isConfigMissing: false,
    warningMessage: null,
  }
}

export class FeishuWriteController extends StateStore<FeishuWriteState> {
  private readonly api: BridgeApi | null
  private readonly now: () => number
  private previewSeq = 0

  constructor(options: FeishuWriteControllerOptions) {
    super(createInitialFeishuWriteState(options.api ? 'ready' : 'unavailable'))
    this.api = options.api
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 控制器生命周期启动。
   * 安全保证：绝不挂载自动写入或自动预览！
   */
  start(): void {
    // 显式空实现：严禁在挂载时自动发起任何写入或预览
  }

  resubscribe(): void {
    if (this.disposed || !this.api) return
    try {
      this.api.resubscribe()
    } catch {
      // 忽略
    }
  }

  /**
   * 选品变动时的核心失效逻辑：
   * 只要选中的 itemIds 改变，已有预览结果立即失效作废，执行结果也一并清理。
   */
  invalidatePreview(): void {
    this.previewSeq++
    this.patch({
      preview: {
        phase: 'idle',
        result: null,
        error: null,
        targetItemIds: [],
        previewedAt: null,
      },
      execute: {
        phase: 'idle',
        result: null,
        error: null,
        riskNotice: null,
        executedAt: null,
      },
      isConfigMissing: false,
    })
  }

  /** 勾选单个商品。 */
  select(itemId: string): void {
    const trimmed = itemId.trim()
    if (!trimmed || this.state.selectedItemIds.includes(trimmed)) return
    if (this.state.selectedItemIds.length >= FEISHU_WRITE_MAX_ITEMS) {
      this.patch({ warningMessage: `单次最多勾选 ${FEISHU_WRITE_MAX_ITEMS} 件商品` })
      return
    }
    const next = [...this.state.selectedItemIds, trimmed]
    this.patch({ selectedItemIds: next, warningMessage: null })
    this.invalidatePreview()
  }

  /** 取消勾选单个商品。 */
  deselect(itemId: string): void {
    const trimmed = itemId.trim()
    if (!this.state.selectedItemIds.includes(trimmed)) return
    const next = this.state.selectedItemIds.filter((id) => id !== trimmed)
    this.patch({ selectedItemIds: next, warningMessage: null })
    this.invalidatePreview()
  }

  /** 切换单个商品勾选状态。 */
  toggle(itemId: string): void {
    if (this.state.selectedItemIds.includes(itemId.trim())) {
      this.deselect(itemId)
    } else {
      this.select(itemId)
    }
  }

  /** 批量勾选商品（例如全选当前页）。 */
  selectMultiple(itemIds: string[]): void {
    const current = new Set(this.state.selectedItemIds)
    let added = 0
    let reachedLimit = false

    for (const raw of itemIds) {
      const id = raw.trim()
      if (!id || current.has(id)) continue
      if (current.size >= FEISHU_WRITE_MAX_ITEMS) {
        reachedLimit = true
        break
      }
      current.add(id)
      added++
    }

    if (added === 0 && !reachedLimit) return

    const next = Array.from(current)
    this.patch({
      selectedItemIds: next,
      warningMessage: reachedLimit ? `已达勾选上限（最多 ${FEISHU_WRITE_MAX_ITEMS} 件）` : null,
    })
    this.invalidatePreview()
  }

  /** 批量取消勾选商品（例如取消全选当前页）。 */
  deselectMultiple(itemIds: string[]): void {
    const removeSet = new Set(itemIds.map((id) => id.trim()))
    const next = this.state.selectedItemIds.filter((id) => !removeSet.has(id))
    if (next.length === this.state.selectedItemIds.length) return
    this.patch({ selectedItemIds: next, warningMessage: null })
    this.invalidatePreview()
  }

  /** 清空全部已选商品。 */
  clearSelection(): void {
    if (this.state.selectedItemIds.length === 0) return
    this.patch({ selectedItemIds: [], warningMessage: null })
    this.invalidatePreview()
  }

  /** 清除警告提示。 */
  clearWarning(): void {
    if (this.state.warningMessage) {
      this.patch({ warningMessage: null })
    }
  }

  /** 检查当前预览是否仍然有效（未过期且选品未变）。 */
  isCurrentPreviewValid(): boolean {
    const preview = this.state.preview
    if (preview.phase !== 'ready' || !preview.result) return false
    if (this.now() >= preview.result.expiresAt) return false
    if (!areArraysEqual(this.state.selectedItemIds, preview.targetItemIds)) return false
    return true
  }

  /**
   * 生成飞书写入只读预览（FEISHU_PRODUCT_WRITE_PREVIEW）。
   * 只读操作，绝不写入飞书表。返回包含 previewId 与 expiresAt 等短期凭证。
   */
  async preview(): Promise<FeishuProductWritePreviewResult | null> {
    const api = this.api
    if (!api || this.state.availability !== 'ready') {
      const errorView: ErrorView = {
        title: '未连接扩展',
        hint: '请在扩展内页中使用工作台',
        detail: '',
        kind: 'unavailable',
        code: 'UNAVAILABLE',
      }
      this.patch({ preview: { ...this.state.preview, phase: 'error', error: errorView } })
      return null
    }

    if (this.state.selectedItemIds.length === 0) {
      const errorView: ErrorView = {
        title: '未选择商品',
        hint: '请先勾选需要写入飞书的商品',
        detail: '',
        kind: 'validation',
        code: 'EMPTY_SELECTION',
      }
      this.patch({ preview: { ...this.state.preview, phase: 'error', error: errorView } })
      return null
    }

    if (this.state.selectedItemIds.length > FEISHU_WRITE_MAX_ITEMS) {
      const errorView: ErrorView = {
        title: '勾选超出上限',
        hint: `单次最多支持写入 ${FEISHU_WRITE_MAX_ITEMS} 件商品`,
        detail: '',
        kind: 'validation',
        code: 'EXCEEDED_LIMIT',
      }
      this.patch({ preview: { ...this.state.preview, phase: 'error', error: errorView } })
      return null
    }

    // 防止在执行中重复操作，或重复预览
    if (this.state.execute.phase === 'loading' || this.state.preview.phase === 'loading') {
      return null
    }

    const token = ++this.previewSeq
    const targetItemIds = [...this.state.selectedItemIds]

    this.patch({
      preview: {
        phase: 'loading',
        result: null,
        error: null,
        targetItemIds: [],
        previewedAt: null,
      },
      isConfigMissing: false,
    })

    try {
      const result = await api.call(CommandTypes.FEISHU_PRODUCT_WRITE_PREVIEW, {
        itemIds: targetItemIds,
      })

      if (this.disposed || token !== this.previewSeq) return null

      // 如果在预览请求返回前，选中的商品发生了变更，丢弃旧响应
      if (!areArraysEqual(this.state.selectedItemIds, targetItemIds)) {
        return null
      }

      const previewResult = result as FeishuProductWritePreviewResult
      this.patch({
        preview: {
          phase: 'ready',
          result: previewResult,
          error: null,
          targetItemIds,
          previewedAt: this.now(),
        },
        isConfigMissing: false,
      })
      return previewResult
    } catch (error) {
      if (this.disposed || token !== this.previewSeq) return null
      const errorView = toErrorView(error)
      const isConfigMissing = checkIsConfigMissing(errorView)

      this.patch({
        preview: {
          phase: 'error',
          result: null,
          error: errorView,
          targetItemIds: [],
          previewedAt: null,
        },
        isConfigMissing,
      })
      return null
    }
  }

  /**
   * 执行向飞书商品表写入（FEISHU_PRODUCT_WRITE_EXECUTE）。
   *
   * 严格前置约束与契约绑定：
   * 1. 必须处于成功预览状态（preview.phase === 'ready' 且有 previewId）；
   * 2. 预览必须未过期（当前时间 < expiresAt）；
   * 3. 当前选中商品必须与预览快照完全一致；
   * 4. 字段必须兼容（缺失字段为 0 且无类型冲突，严禁自动创建或修改字段）；
   * 5. 待写入条数必须大于 0；
   * 6. 必须显式传递 confirm: true；
   * 7. 执行进行中禁用重复；
   * 8. 成功后必须立即使 previewId 失效，防止二次重放；
   * 9. 失败时明确报告实际风险，严禁自动重试，且作废当前 previewId（失败需重新 preview）。
   */
  async execute(options: { confirm: boolean }): Promise<FeishuProductWriteExecuteResult | null> {
    const api = this.api
    if (!api || this.state.availability !== 'ready') {
      const errorView: ErrorView = {
        title: '未连接扩展',
        hint: '请在扩展内页中使用工作台',
        detail: '',
        kind: 'unavailable',
        code: 'UNAVAILABLE',
      }
      this.patch({ execute: { ...this.state.execute, phase: 'error', error: errorView } })
      return null
    }

    // 防重复执行
    if (this.state.execute.phase === 'loading') {
      return null
    }

    // 显式确认校验
    if (options?.confirm !== true) {
      const errorView: ErrorView = {
        title: '未显式确认',
        hint: '必须勾选确认后方可执行写入飞书',
        detail: '',
        kind: 'validation',
        code: 'CONFIRM_REQUIRED',
      }
      this.patch({ execute: { ...this.state.execute, phase: 'error', error: errorView } })
      return null
    }

    // 未经成功 preview 执行防护
    const preview = this.state.preview
    if (preview.phase !== 'ready' || !preview.result || !preview.result.previewId) {
      const errorView: ErrorView = {
        title: '未经预览不可执行',
        hint: '请先点击「生成写入预览」，核对待写入数据后再执行写入',
        detail: '',
        kind: 'validation',
        code: 'PREVIEW_REQUIRED',
      }
      this.patch({ execute: { ...this.state.execute, phase: 'error', error: errorView } })
      return null
    }

    // 预览过期校验：到期需重新预览
    if (this.now() >= preview.result.expiresAt) {
      const errorView: ErrorView = {
        title: '预览已过期',
        hint: '该写入预览已超时过期，请重新点击「生成飞书写入预览」核对后再执行',
        detail: '',
        kind: 'validation',
        code: 'PREVIEW_EXPIRED',
      }
      this.invalidatePreview()
      this.patch({ execute: { ...this.state.execute, phase: 'error', error: errorView } })
      return null
    }

    // 选品变更防护（比对选品快照）
    if (!areArraysEqual(this.state.selectedItemIds, preview.targetItemIds)) {
      const errorView: ErrorView = {
        title: '选中的商品已变更',
        hint: '选中的商品已发生改变，原预览已作废，请重新生成预览核对后再执行',
        detail: '',
        kind: 'validation',
        code: 'SELECTION_CHANGED',
      }
      this.invalidatePreview()
      this.patch({ execute: { ...this.state.execute, phase: 'error', error: errorView } })
      return null
    }

    // 字段兼容性与类型冲突防护：严禁在字段缺失或类型冲突时执行
    const missing = preview.result.missingFields ?? []
    const conflicts = preview.result.typeConflicts ?? []
    if (!preview.result.fieldCompatible || missing.length > 0 || conflicts.length > 0) {
      const issueParts: string[] = []
      if (missing.length > 0) {
        issueParts.push(`缺少必需字段（${missing.join('、')}）`)
      }
      if (conflicts.length > 0) {
        const conflictDesc = conflicts
          .map((c) => `${c.name}(期望类型:${c.expectedType},实际类型:${c.actualType})`)
          .join('、')
        issueParts.push(`字段类型冲突（${conflictDesc}）`)
      }
      const errorView: ErrorView = {
        title: '飞书目标表字段不兼容',
        hint: `${issueParts.join('；')}。请先前往飞书多维表格手动调整字段后重新预览（本系统严禁自动创建或修改飞书字段）`,
        detail: '',
        kind: 'validation',
        code: 'FIELDS_INCOMPATIBLE',
      }
      this.patch({ execute: { ...this.state.execute, phase: 'error', error: errorView } })
      return null
    }

    // 待写入条数校验
    if (preview.result.toCreate.length === 0) {
      const errorView: ErrorView = {
        title: '无待写入商品',
        hint: '所有选中的商品均已存在于飞书表中或本地不存在，无需重复写入',
        detail: '',
        kind: 'validation',
        code: 'NOTHING_TO_CREATE',
      }
      this.patch({ execute: { ...this.state.execute, phase: 'error', error: errorView } })
      return null
    }

    const boundPreviewId = preview.result.previewId

    this.patch({
      execute: {
        phase: 'loading',
        result: null,
        error: null,
        riskNotice: null,
        executedAt: null,
      },
    })

    try {
      // 按照升级后最新契约：仅传递 { previewId, confirm: true }，无 itemIds
      const res = await api.call(CommandTypes.FEISHU_PRODUCT_WRITE_EXECUTE, {
        previewId: boundPreviewId,
        confirm: true,
      })

      if (this.disposed) return null

      const executeResult = res as FeishuProductWriteExecuteResult

      // 成功写入后：立即使当前 preview 失效作废，杜绝二次重放（replay 防护）！
      this.patch({
        preview: {
          phase: 'idle',
          result: null,
          error: null,
          targetItemIds: [],
          previewedAt: null,
        },
        execute: {
          phase: 'ready',
          result: executeResult,
          error: null,
          riskNotice: null,
          executedAt: this.now(),
        },
      })
      return executeResult
    } catch (error) {
      if (this.disposed) return null
      const errorView = toErrorView(error)
      const isConfigMissing = checkIsConfigMissing(errorView)

      // 写入失败！明确提示实际风险，且绝对严禁自动重试！
      const riskNotice =
        '飞书商品写入失败或被中断。实际风险：部分商品记录可能已被写入飞书多维表格。严禁自动重试！本次写入预览已作废，请先前往飞书核实已写入的数据，确认无误后重新生成预览。'

      // 失败后作废当前 previewId，禁止用同一 previewId 再次重试
      this.patch({
        preview: {
          phase: 'idle',
          result: null,
          error: null,
          targetItemIds: [],
          previewedAt: null,
        },
        execute: {
          phase: 'error',
          result: null,
          error: errorView,
          riskNotice,
          executedAt: null,
        },
        isConfigMissing: this.state.isConfigMissing || isConfigMissing,
      })
      return null
    }
  }

  /** 重置执行状态。 */
  resetExecute(): void {
    this.patch({
      execute: {
        phase: 'idle',
        result: null,
        error: null,
        riskNotice: null,
        executedAt: null,
      },
    })
  }
}
