/**
 * PublishController - 商品发布业务控制器（P8）。
 *
 * 职责：
 * 1. 严格从 ProductRepository 读取指定 itemId 的真实商品，严禁偷偷随机选择；
 *    并强制商品来源为当前账号已确认发布商品（my_published），竞品 / 存量未确认一律结构化拒绝；
 * 2. 应用价格规则（系数倍率、固定价、加价、划线原价）与文案规则；
 * 3. 严格校验图片只允许 HTTPS 协议、数量限制、大小限制；
 * 4. 提供可注入 mock 的 ImageDownloader 接口，准备 File / Blob / 二进制数据；
 * 5. 安全铁律：严禁执行真实发布提交，任何形式的 submit 均显式拒绝。
 */

import {
  buildPublishItem,
  DEFAULT_PUBLISH_RULE,
  PublishError,
  type PublishItem,
  type PublishItemOverride,
  type PublishRule,
} from '@fishops/shared'
import type { ProductRepository } from '../../../shared/capture/product-repository'

/**
 * 已下载并准备就绪的图片数据
 */
export interface PreparedImageFile {
  filename: string
  mimeType: string
  size: number
  /** 二进制 Blob（浏览器环境下可用） */
  blob?: Blob
  /** File 对象（浏览器环境下可用） */
  file?: File
  /** 纯数据 Buffer / ArrayBuffer（用于跨环境测试） */
  data?: ArrayBuffer
}

/**
 * 图片下载器抽象接口（全部可注入 mock，测试时完全不发起网络请求）
 */
export interface ImageDownloader {
  download(url: string, filename: string): Promise<PreparedImageFile>
}

/**
 * 默认图片下载器实现（基于 fetch 与 HTTPS 校验）
 */
export class DefaultImageDownloader implements ImageDownloader {
  async download(url: string, filename: string): Promise<PreparedImageFile> {
    let httpsUrl = url.trim()
    if (httpsUrl.startsWith('http://')) {
      httpsUrl = httpsUrl.replace('http://', 'https://')
    }

    try {
      const parsed = new URL(httpsUrl)
      if (parsed.protocol !== 'https:') {
        throw new PublishError(
          'IMAGE_DOWNLOAD_FAILED',
          `图片仅支持 HTTPS 协议: \"${url}\"`,
          { retryable: false },
        )
      }
    } catch (err) {
      if (err instanceof PublishError) throw err
      throw new PublishError(
        'IMAGE_DOWNLOAD_FAILED',
        `图片 URL 非法: \"${url}\"`,
        { retryable: false, details: err },
      )
    }

    try {
      const response = await fetch(httpsUrl)
      if (!response.ok) {
        throw new Error(`HTTP 状态异常: ${response.status} ${response.statusText}`)
      }
      const blob = await response.blob()
      const mimeType = blob.type || 'image/jpeg'
      const file = typeof File !== 'undefined'
        ? new File([blob], filename, { type: mimeType })
        : undefined

      return {
        filename,
        mimeType,
        size: blob.size,
        blob,
        file,
      }
    } catch (error) {
      if (error instanceof PublishError) throw error
      const msg = error instanceof Error ? error.message : String(error)
      throw new PublishError(
        'IMAGE_DOWNLOAD_FAILED',
        `下载图片失败 (${httpsUrl}): ${msg}`,
        { retryable: false, details: error },
      )
    }
  }
}

/**
 * PublishController 依赖注入配置
 */
export interface PublishControllerDeps {
  /** 商品仓储（P4 ProductRepository） */
  repository: ProductRepository
  /** 图片下载器抽象实现（默认 DefaultImageDownloader） */
  imageDownloader?: ImageDownloader
  /** 默认全局发布规则（缺省使用 DEFAULT_PUBLISH_RULE） */
  defaultRule?: PublishRule
  /** 时间戳发生器 */
  now?: () => number
}

/**
 * 商品发布业务控制器
 */
export class PublishController {
  private readonly repository: ProductRepository
  private readonly imageDownloader: ImageDownloader
  private readonly defaultRule: PublishRule

  constructor(deps: PublishControllerDeps) {
    this.repository = deps.repository
    this.imageDownloader = deps.imageDownloader ?? new DefaultImageDownloader()
    this.defaultRule = deps.defaultRule ?? DEFAULT_PUBLISH_RULE
  }

  /**
   * 严格从 ProductRepository 查询真实商品，应用规则组装出 PublishItem
   *
   * @param itemId 目标商品 ID（必须显式传入，严禁私自随机选择）
   * @param ruleOverride 自定义发布规则覆盖
   * @param directOverride 直接覆盖字段
   * @returns 组装完毕的 PublishItem
   */
  async preparePublishItem(
    itemId: string,
    ruleOverride?: Partial<PublishRule>,
    directOverride?: PublishItemOverride,
  ): Promise<PublishItem> {
    if (!itemId || typeof itemId !== 'string' || itemId.trim().length === 0) {
      throw new PublishError(
        'INVALID_PAYLOAD',
        '必须显式提供商品 itemId，严禁偷偷随机选择商品',
        { retryable: false },
      )
    }

    const trimmedId = itemId.trim()
    // 查询必须显式带 source: 'all'：目的是先找到该 itemId 的真实商品，
    // 再严格校验来源，以便对竞品 / legacy / 未确认结构化拒绝，而非笼统的“找不到”。
    const page = await this.repository.list({ keyword: trimmedId, limit: 50, source: 'all' })
    const product = page.products.find((p) => p.itemId === trimmedId)
    if (!product) {
      throw new PublishError(
        'PRODUCT_NOT_FOUND',
        `商品库中未找到商品 ID: "${trimmedId}"，请先在商品库采集或导入该商品`,
        { retryable: false },
      )
    }

    // 安全铁律：只允许发布当前账号已验证归属的已发布商品（my_published）。
    // 竞品（captured_search）、存量未确认（legacy_unconfirmed）与任何归属未确认商品一律结构化拒绝，
    // 避免把他人商品 / 来源不明的商品误发布到当前账号。
    if (product.source !== 'my_published') {
      const source = product.source ?? 'legacy_unconfirmed'
      throw new PublishError(
        'PRODUCT_SOURCE_NOT_ALLOWED',
        `商品 "${trimmedId}" 来源为 "${source}"，仅允许发布当前账号已确认归属的已发布商品（my_published），已拒绝以规避误发风险`,
        { retryable: false, details: { itemId: trimmedId, source } },
      )
    }

    const mergedRule: PublishRule = {
      price: { ...this.defaultRule.price, ...ruleOverride?.price },
      content: { ...this.defaultRule.content, ...ruleOverride?.content },
      image: { ...this.defaultRule.image, ...ruleOverride?.image },
    }

    return buildPublishItem(product, mergedRule, directOverride)
  }

  /**
   * 批量下载并准备已过滤的图片文件
   *
   * @param images 图片 URL 列表（已确保为 HTTPS）
   * @returns 准备完毕的图片二进制/文件对象列表
   */
  async prepareImages(images: string[]): Promise<PreparedImageFile[]> {
    if (!images || images.length === 0) {
      throw new PublishError(
        'IMAGE_DOWNLOAD_FAILED',
        '待处理图片列表为空',
        { retryable: false },
      )
    }

    const preparedList: PreparedImageFile[] = []
    const maxSizeBytes = this.defaultRule.image?.maxSizeBytes ?? 10 * 1024 * 1024

    for (let index = 0; index < images.length; index++) {
      const url = images[index]!
      const imageSeq = index + 1
      const filename = index === 0 ? 'main-image.jpg' : `detail-image-${index}.jpg`
      try {
        const item = await this.imageDownloader.download(url, filename)
        if (item.size > maxSizeBytes) {
          throw new PublishError(
            'IMAGE_DOWNLOAD_FAILED',
            `第 ${imageSeq} 张图片大小超出限制 (${(item.size / 1024 / 1024).toFixed(2)}MB > ${(maxSizeBytes / 1024 / 1024).toFixed(2)}MB): ${url}`,
            { retryable: false },
          )
        }
        preparedList.push(item)
      } catch (error) {
        if (error instanceof PublishError) throw error
        const msg = error instanceof Error ? error.message : String(error)
        throw new PublishError(
          'IMAGE_DOWNLOAD_FAILED',
          `第 ${imageSeq} 张图片下载或准备失败 (${url}): ${msg}`,
          { retryable: false, details: error },
        )
      }
    }

    return preparedList
  }

  /**
   * 严格禁止业务控制器自动提交（硬性安全防线）。
   *
   * 最终提交已改为只能由用户在发布中心显式触发 PUBLISH_SUBMIT 命令、经 PublishRuntime
   * 携带一次性令牌执行；业务控制器不提供任何提交能力，调用此处一律显式拒绝，
   * 避免任务创建 / 填表路径误触真实发布。
   */
  submit(): never {
    throw new PublishError(
      'SUBMIT_DISABLED',
      '发布控制器不提供自动提交能力，最终提交必须由用户在发布中心显式触发 PUBLISH_SUBMIT',
      { retryable: false },
    )
  }
}
