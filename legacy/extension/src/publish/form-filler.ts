/**
 * PublishFormFiller - 闲鱼发布页面表单填充适配器（P8）。
 *
 * 职责：
 * 1. 适配闲鱼发布页（https://www.goofish.com/publish*）的 DOM 结构与字段输入；
 * 2. 检查页面异常状态：未登录（NOT_LOGGED_IN）、验证码/滑块风控（VERIFICATION_REQUIRED）；
 * 3. 对 `chrome.scripting.executeScript` 的异常返回做结构化处理（空数组 / undefined / host 异常）；
 * 4. 填充描述（真实发布页无独立标题字段时，标题与描述融合为统一描述写入描述控件）、
 *    售价、划线原价、图片，以及配送（邮费）与所在地确认，并在填充后回读校验，全部通过才返回 ok；
 *    所在地优先保留发布页当前账号已有合法地址，不做任何伪造；为空时标记需用户选择；
 *    配送缺费用时结构化拒绝（绝不伪造收费）；
 * 5. 安全铁律（分层）：`fill()` 执行到表单填充完成并返回 fillSummary 即止，绝不提交；
 *    唯一允许触发真实提交的是 `submit()`，它只由用户显式触发的 PUBLISH_SUBMIT 命令调用，
 *    且只点击真实发布按钮，找不到时返回结构化失败，绝不猜测点击其它元素。
 */

import {
  PublishError,
  type PublishFillSummary,
  type PublishItem,
} from '@fishops/shared'
import type { PreparedImageFile } from './controller'
import {
  injectCheckPageStatus,
  injectClickPublishSubmit,
  injectFillPublishForm,
  type PageStatusCheckResult,
  type PublishFillFailedImage,
} from './injected-scripts'

export type { PageStatusCheckResult } from './injected-scripts'

/**
 * 表单填充各阶段的安全计时（毫秒，仅数字）。
 *
 * 来源于注入侧自包含脚本的计时（pageCheck / fields / images / validation 由
 * DOMPublishFormFiller 结合两次注入调用汇总）；绝不包含任何页面原文。
 */
export interface FormFillTimings {
  /** 页面状态检查（登录态 / 验证码）耗时 */
  pageCheckMs?: number
  /** 字段填充与回读耗时 */
  fieldsMs?: number
  /** 图片下载与上传回读耗时 */
  imagesMs?: number
  /** 字段最终回读与官方阻断探测耗时 */
  validationMs?: number
  /** 整体耗时（页面检查 + 注入填充） */
  totalMs?: number
}

/**
 * 表单填充执行结果
 */
export interface FormFillResult {
  /**
   * 是否所有字段（标题/描述/售价/原价/图片）全部填充且回读校验通过。
   *
   * 说明：真实发布页无独立商品标题输入框，标题会融合进描述控件，此时
   * `fillSummary.titleFilled` 表示“标题已融合进统一描述且回读校验通过”。
   */
  ok: boolean
  fillSummary: PublishFillSummary
  /** 安全阶段计时（毫秒），供 host 侧写入诊断时间线 */
  timings?: FormFillTimings
  /** 结构化错误信息（含图片序号） */
  errors?: string[]
  /** 图片失败明细（带序号） */
  imagesFailed?: PublishFillFailedImage[]
}

/**
 * 最终提交执行结果
 *
 * - `clicked:true`：已成功派发一次真实发布按钮点击，**是否真正发布成功由 host 侧依据官方
 *   「我的商品库」在售商品数严格 +1（after === before + 1）判定**，绝不依赖标签页跳转；
 * - `clicked:false`：提交前校验未通过（页面失效 / 未找到按钮 / 按钮禁用），**未派发任何点击**。
 */
export interface FormSubmitResult {
  /** 是否已派发一次发布按钮点击 */
  clicked: boolean
  /** 未点击时的结构化原因码（与 PublishErrorCode 对齐） */
  code?: string
  /** 未点击时的原因说明 */
  reason?: string
  /** 命中到的发布按钮 class（仅用于审计） */
  buttonClass?: string
  /** 派发点击的时间戳（毫秒） */
  clickedAt?: number
  /** 提交注入的安全计时（毫秒，仅数字） */
  timings?: { totalMs?: number }
}

/**
 * 注入脚本执行器接口（便于跨环境单测与 mock）
 */
export interface ScriptingExecutor {
  executeScript<T>(injection: {
    target: { tabId: number }
    func: (...args: any[]) => T
    args?: any[]
  }): Promise<Array<{ result: T }>>
}

/**
 * 表单填充器核心接口
 */
export interface PublishFormFiller {
  /**
   * 检查发布页环境状态（登录态与验证码）
   */
  checkPageStatus(tabId: number): Promise<PageStatusCheckResult>

  /**
   * 执行表单字段填充（仅填充，不提交）
   */
  fill(
    tabId: number,
    item: PublishItem,
    preparedImages?: PreparedImageFile[],
  ): Promise<FormFillResult>

  /**
   * 最终发布提交：仅由用户显式触发的 PUBLISH_SUBMIT 命令调用，点击真实发布按钮一次。
   */
  submit?(tabId: number): Promise<FormSubmitResult>
}

/**
 * 基于 Chrome Scripting API 的真实 DOM 表单填充器实现
 */
export class DOMPublishFormFiller implements PublishFormFiller {
  private readonly executor?: ScriptingExecutor

  constructor(deps?: { executor?: ScriptingExecutor }) {
    this.executor = deps?.executor
  }

  /**
   * 统一封装 `executeScript` 调用，对以下异常情况做结构化错误处理：
   * - host 侧异常（无权限、tab 不存在、跨源限制等）导致 Promise reject；
   * - 返回结果不是数组或为空数组；
   * - 返回结果为 undefined / null。
   *
   * @param tabId 目标标签页 ID
   * @param func 完全自包含的注入函数
   * @param args 可序列化参数
   */
  private async runInjection<T>(
    tabId: number,
    func: (...args: any[]) => T,
    args?: any[],
  ): Promise<T> {
    if (!this.executor) {
      throw new PublishError(
        'SCRIPT_INJECTION_FAILED',
        '当前环境缺少脚本注入执行器（scripting executor），无法执行页面注入',
        { retryable: false },
      )
    }

    let results: Array<{ result: T }>
    try {
      results = await this.executor.executeScript<T>({
        target: { tabId },
        func,
        ...(args === undefined ? {} : { args }),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new PublishError(
        'SCRIPT_INJECTION_FAILED',
        `注入脚本在标签页 ${tabId} 执行失败（可能是页面未加载完成或无访问权限）: ${message}`,
        { retryable: false, details: err },
      )
    }

    if (!Array.isArray(results) || results.length === 0) {
      throw new PublishError(
        'SCRIPT_INJECTION_FAILED',
        `注入脚本未返回任何结果（标签页 ${tabId} 可能已重定向、崩溃或被关闭）`,
        { retryable: false },
      )
    }

    // executeScript 对 async 注入函数可能返回 Promise，这里统一 await 兜底。
    // 注意：若注入函数返回的直接是 rejected Promise，这里必须转换为结构化错误，
    // 不允许原始异常冒泡出 SCRIPT_INJECTION_FAILED 分类。
    let rawResult: T
    try {
      rawResult = await Promise.resolve(results[0]?.result as T)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new PublishError(
        'SCRIPT_INJECTION_FAILED',
        `注入脚本执行结果异常（标签页 ${tabId}）: ${message}`,
        { retryable: false, details: err },
      )
    }

    if (rawResult === undefined || rawResult === null) {
      throw new PublishError(
        'SCRIPT_INJECTION_FAILED',
        `注入脚本返回结果为空（标签页 ${tabId}），无法确认页面填充状态`,
        { retryable: false },
      )
    }

    return rawResult
  }

  /**
   * 检查页面状态（是否在发布页、是否未登录、是否弹出风控滑块/验证码）
   */
  async checkPageStatus(tabId: number): Promise<PageStatusCheckResult> {
    if (!this.executor) {
      // 缺省或轻量 mock 下默认就绪
      return { isPublishPage: true, isLoggedIn: true, hasCaptcha: false }
    }

    const status = await this.runInjection<PageStatusCheckResult>(tabId, injectCheckPageStatus)

    if (status.hasCaptcha) {
      throw new PublishError(
        'VERIFICATION_REQUIRED',
        '发布页面弹出安全验证码或滑块风控，请在浏览器中人工通过验证后重试',
        { retryable: false },
      )
    }

    if (!status.isLoggedIn) {
      throw new PublishError(
        'NOT_LOGGED_IN',
        '检测到闲鱼账号尚未登录，请先在浏览器中登录闲鱼账号',
        { retryable: false },
      )
    }

    return status
  }

  /**
   * 从 PublishItem 解析注入用的配送意图。
   *
   * 安全铁律：不包邮 / 明确要求收费但缺少有效邮费金额时，结构化拒绝
   * （FORM_VALIDATION_FAILED）并给出可行动提示，绝不伪造一个收费金额。
   * 旧任务（shippingStatus 缺省）不涉及配送，返回 undefined 以保持向后兼容。
   */
  private resolveShippingPayload(
    item: PublishItem,
  ): { mode: 'free' | 'paid'; postFee?: number } | undefined {
    if (item.shippingStatus === 'free') {
      return { mode: 'free' }
    }
    if (item.shippingStatus === 'paid') {
      const fee = item.postFee
      if (typeof fee !== 'number' || !Number.isFinite(fee) || fee <= 0) {
        throw new PublishError(
          'FORM_VALIDATION_FAILED',
          '配送需收费但缺少有效邮费金额：请提供 override.postFee（> 0）或改为包邮（override.freeShip=true / override.postFee=0），绝不伪造收费',
          { retryable: false },
        )
      }
      return { mode: 'paid', postFee: fee }
    }
    if (item.shippingStatus === 'unspecified') {
      throw new PublishError(
        'FORM_VALIDATION_FAILED',
        '来源商品明确不包邮但未提供邮费金额：请提供 override.postFee（> 0）或改为包邮（override.freeShip=true / override.postFee=0），绝不伪造收费',
        { retryable: false },
      )
    }
    // 旧任务：无配送信息，不参与配送校验
    return undefined
  }

  /**
   * 执行表单填充（仅填写，绝不提交）。
   *
   * 只有标题（无独立标题字段时指融合进描述的内容）、描述、售价、划线原价、图片、
   * 配送（邮费）与所在地全部满足且回读校验通过时，`ok` 才为 true；
   * 任何一项未通过都不会被标记为成功（避免假成功）。
   *
   * root guard：若注入侧探测到官方当前可见的阻断提示（分类不支持网页端发布 / 描述含 emoji），
   * 则**优先**抛出对应结构化错误（PUBLISH_CATEGORY_UNSUPPORTED / FORM_VALIDATION_FAILED），
   * 不再退化为图片回读失败，也不自动换分类 / 绕过 / 重试。
   */
  async fill(
    tabId: number,
    item: PublishItem,
    preparedImages: PreparedImageFile[] = [],
  ): Promise<FormFillResult> {
    // 1. 先探测页面安全状态（单独计时，供 host 侧记录 page_check 阶段）
    const pageCheckStart = Date.now()
    await this.checkPageStatus(tabId)
    const pageCheckMs = Math.max(0, Date.now() - pageCheckStart)

    // 1.5 解析配送（邮费）意图：缺费用时结构化拒绝（可行动），绝不伪造收费
    const shippingPayload = this.resolveShippingPayload(item)

    if (!this.executor) {
      // 在脱机单测无 executor 场景下返回模拟填充结果
      // 无独立标题字段时，标题会融合进描述，因此标题/描述均以文本存在为准
      return {
        ok: true,
        fillSummary: {
          titleFilled: Boolean(item.title || item.desc),
          mainImageUploaded: preparedImages.length > 0,
          detailImagesCount: Math.max(0, preparedImages.length - 1),
          descFilled: Boolean(item.desc || item.title),
          priceFilled: item.price > 0,
          origPriceFilled: item.originalPrice > 0,
          postFeeFilled: true,
          locationFilled: true,
        },
        timings: { pageCheckMs, fieldsMs: 0, imagesMs: 0, validationMs: 0, totalMs: pageCheckMs },
      }
    }

    // 2. 注入自包含脚本进行页面填充（仅传可序列化 args）
    const injectionArgs: Record<string, unknown> = {
      title: item.title,
      desc: item.desc,
      price: item.price,
      originalPrice: item.originalPrice,
      imageUrls: item.allImages,
    }
    if (shippingPayload) injectionArgs.shipping = shippingPayload

    const injectionResult = await this.runInjection(tabId, injectFillPublishForm, [injectionArgs])

    // 汇总注入侧安全计时（pageCheck 由本层测量，其余来自注入脚本）
    const injTimings = injectionResult.timings
    const timings: FormFillTimings = {
      pageCheckMs,
      fieldsMs: typeof injTimings?.fieldsMs === 'number' ? injTimings.fieldsMs : 0,
      imagesMs: typeof injTimings?.imagesMs === 'number' ? injTimings.imagesMs : 0,
      validationMs: typeof injTimings?.validationMs === 'number' ? injTimings.validationMs : 0,
      totalMs: pageCheckMs + (typeof injTimings?.totalMs === 'number' ? injTimings.totalMs : 0),
    }

    // root guard：官方当前**可见**的阻断提示（「当前分类不支持网页端发布」/「商品描述不能包含
    // emoji」等）优先于图片与字段回读失败。绝不把“官方明确阻断”误判为图片回读失败
    // （FORM_FIELD_CHANGED），也绝不自动换分类 / 绕过 / 自动重试（抛不可重试错误即中断）。
    const officialBlock = injectionResult.officialBlock
    if (officialBlock) {
      throw new PublishError(
        officialBlock.code,
        `官方发布页当前阻断（${officialBlock.source === 'toast' ? '页面提示' : '表单校验'}）：${officialBlock.message}`,
        { retryable: false, details: { source: officialBlock.source, officialBlock } },
      )
    }

    const errors = Array.isArray(injectionResult.errors) ? injectionResult.errors : []
    const imagesFailed = Array.isArray(injectionResult.imagesFailed)
      ? injectionResult.imagesFailed
      : []

    const titleFilled = injectionResult.titleFilled === true
    const descFilled = injectionResult.descFilled === true
    const priceFilled = injectionResult.priceFilled === true
    const origPriceFilled = injectionResult.origPriceFilled === true
    const mainImageUploaded = injectionResult.mainImageUploaded === true
    const detailImagesCount =
      typeof injectionResult.detailImagesCount === 'number' ? injectionResult.detailImagesCount : 0

    // 配送 / 所在地：缺省（旧任务）视为已满足；明确为 false 才判定失败
    const postFeeFilled = injectionResult.postFeeFilled !== false
    const locationFilled = injectionResult.locationFilled !== false

    // 3. 严格判定：所有字段、全部图片以及配送/所在地必须成功，否则不置 ok
    const ok =
      titleFilled &&
      descFilled &&
      priceFilled &&
      origPriceFilled &&
      mainImageUploaded &&
      postFeeFilled &&
      locationFilled &&
      imagesFailed.length === 0

    // 4. 严重控件缺失时抛出结构化 FORM_FIELD_CHANGED（保留既有错误分类语义）
    if (!descFilled && !priceFilled) {
      throw new PublishError(
        'FORM_FIELD_CHANGED',
        `表单字段严重不匹配或改版，关键输入控件缺失: ${errors.join('; ') || '未知原因'}`,
        { retryable: false, details: errors },
      )
    }

    return {
      ok,
      fillSummary: {
        titleFilled,
        mainImageUploaded,
        detailImagesCount,
        descFilled,
        priceFilled,
        origPriceFilled,
        postFeeFilled,
        locationFilled,
        locationValue: injectionResult.locationValue,
        locationStatus: injectionResult.locationStatus,
        shippingStatus: injectionResult.shippingStatus,
      },
      timings,
      errors,
      imagesFailed,
    }
  }

  /**
   * 最终提交：在用户显式触发下，重新校验页面状态并点击真实发布按钮一次。
   *
   * 注意：这里只负责“派发点击”与结构化返回，**不**判定发布成败；
   * 页面状态失效 / 未找到按钮 / 按钮禁用时返回 `clicked:false`，绝不猜测点击其它元素。
   */
  async submit(tabId: number): Promise<FormSubmitResult> {
    if (!this.executor) {
      throw new PublishError(
        'SCRIPT_INJECTION_FAILED',
        '当前环境缺少脚本注入执行器（scripting executor），无法执行发布提交',
        { retryable: false },
      )
    }

    const result = await this.runInjection(tabId, injectClickPublishSubmit)
    return {
      clicked: result.clicked === true,
      code: result.code,
      reason: result.reason,
      buttonClass: result.buttonClass,
      clickedAt: result.clickedAt,
      timings: result.timings,
    }
  }
}
