/**
 * 发布规则引擎实现（P8）。
 *
 * 负责：
 * 1. 价格规则：系数倍率（multiplier）、固定售价（fixedPrice）、浮动加价（markup）与划线原价计算（如 5 倍原价）；
 * 2. 文案规则：前缀 / 后缀拼接、敏感词替换、字数硬限制截断；
 * 3. 图片规则：只允许 HTTPS 协议（自动升级 http 为 https 或阻断非法协议）、数量（1~9张）与大小限制；
 * 4. 组装标准 PublishItem 实体，供后续表单填充使用。
 */

import type { Product } from '../types/product'
import {
  PublishError,
  type PublishContentRule,
  type PublishImageRule,
  type PublishItem,
  type PublishItemOverride,
  type PublishPriceRule,
  type PublishRule,
} from '../types/publish'

/**
 * 默认发布规则
 */
export const DEFAULT_PUBLISH_RULE: Readonly<PublishRule> = Object.freeze({
  price: {
    mode: 'multiplier' as const,
    multiplier: 1.0,
    markup: 0,
    originalPriceRule: {
      mode: 'multiplier' as const,
      multiplier: 5,
    },
  },
  content: {
    maxTitleLength: 60,
    maxDescLength: 1000,
  },
  image: {
    minImages: 1,
    maxImages: 9,
    maxSizeBytes: 10 * 1024 * 1024, // 10MB
    requireHttps: true,
    allowedExtensions: ['jpg', 'jpeg', 'png', 'webp'],
  },
})

/**
 * 价格计算结果
 */
export interface CalculatedPrice {
  price: number
  priceInCent: number
  originalPrice: number
  originalPriceInCent: number
}

/**
 * 应用价格规则计算最终售价与划线原价
 *
 * @param product 来源商品
 * @param rule 价格规则
 * @returns 售价与原价（元与分）
 */
export function applyPriceRule(
  product: Product,
  rule?: PublishPriceRule,
): CalculatedPrice {
  const mergedRule: PublishPriceRule = {
    ...DEFAULT_PUBLISH_RULE.price,
    ...rule,
  }

  // 1. 提取基础售价
  let basePrice = product.priceNumber
  if (!basePrice || basePrice <= 0) {
    const parsed = Number.parseFloat((product.price || '').replace(/[^\d.]/g, ''))
    basePrice = !Number.isNaN(parsed) && parsed > 0 ? parsed : 0.01
  }

  // 2. 计算最终售价
  let finalPrice = basePrice
  if (mergedRule.mode === 'fixed') {
    if (typeof mergedRule.fixedPrice === 'number' && mergedRule.fixedPrice > 0) {
      finalPrice = mergedRule.fixedPrice
    }
  } else {
    const multiplier = typeof mergedRule.multiplier === 'number' ? mergedRule.multiplier : 1.0
    const markup = typeof mergedRule.markup === 'number' ? mergedRule.markup : 0
    finalPrice = basePrice * multiplier + markup
  }

  // 确保价格为正数并保留 2 位小数
  finalPrice = Math.max(0.01, Number(finalPrice.toFixed(2)))

  // 3. 计算划线原价
  const origRule = mergedRule.originalPriceRule ?? DEFAULT_PUBLISH_RULE.price?.originalPriceRule
  let finalOriginalPrice = finalPrice * 5 // 默认 5 倍原价

  if (origRule?.mode === 'fixed' && typeof origRule.fixedPrice === 'number' && origRule.fixedPrice > 0) {
    finalOriginalPrice = origRule.fixedPrice
  } else if (origRule?.mode === 'keep') {
    finalOriginalPrice =
      product.originalPriceNumber && product.originalPriceNumber > finalPrice
        ? product.originalPriceNumber
        : finalPrice * 5
  } else {
    const mult = typeof origRule?.multiplier === 'number' && origRule.multiplier > 0 ? origRule.multiplier : 5
    finalOriginalPrice = finalPrice * mult
  }

  finalOriginalPrice = Math.max(finalPrice, Number(finalOriginalPrice.toFixed(2)))

  return {
    price: finalPrice,
    priceInCent: Math.round(finalPrice * 100),
    originalPrice: finalOriginalPrice,
    originalPriceInCent: Math.round(finalOriginalPrice * 100),
  }
}

/**
 * 文案处理结果
 */
export interface CalculatedContent {
  title: string
  desc: string
}

/**
 * 应用文案规则生成最终标题与商品描述
 *
 * @param product 来源商品
 * @param rule 文案规则
 * @returns 最终标题与描述
 */
export function applyContentRule(
  product: Product,
  rule?: PublishContentRule,
): CalculatedContent {
  const mergedRule: PublishContentRule = {
    ...DEFAULT_PUBLISH_RULE.content,
    ...rule,
  }

  // 1. 处理标题
  let rawTitle = (product.title || '').trim()
  if (mergedRule.textReplacements && mergedRule.textReplacements.length > 0) {
    for (const { pattern, replacement } of mergedRule.textReplacements) {
      if (pattern) {
        rawTitle = rawTitle.replaceAll(pattern, replacement)
      }
    }
  }

  const prefix = mergedRule.titlePrefix ?? ''
  const suffix = mergedRule.titleSuffix ?? ''
  let fullTitle = `${prefix}${rawTitle}${suffix}`.trim()
  const maxTitleLen = mergedRule.maxTitleLength ?? 60
  if (fullTitle.length > maxTitleLen) {
    fullTitle = fullTitle.slice(0, maxTitleLen)
  }

  // 2. 处理描述
  let rawDesc = (product.desc || product.title || '').trim()
  if (mergedRule.textReplacements && mergedRule.textReplacements.length > 0) {
    for (const { pattern, replacement } of mergedRule.textReplacements) {
      if (pattern) {
        rawDesc = rawDesc.replaceAll(pattern, replacement)
      }
    }
  }

  const descPrefix = mergedRule.descPrefix ?? ''
  const descSuffix = mergedRule.descSuffix ?? ''
  let fullDesc = `${descPrefix}${rawDesc}${descSuffix}`.trim()
  const maxDescLen = mergedRule.maxDescLength ?? 1000
  if (fullDesc.length > maxDescLen) {
    fullDesc = fullDesc.slice(0, maxDescLen)
  }

  return {
    title: fullTitle,
    desc: fullDesc,
  }
}

/**
 * 图片校验与归一化结果
 */
export interface ValidatedImages {
  mainImage: string
  detailImages: string[]
  allImages: string[]
}

/**
 * 校验、过滤与升级图片 URL，确保只允许合法 HTTPS 资源
 *
 * @param product 来源商品
 * @param rule 图片规则
 * @returns 主图与详情图列表
 */
export function validateAndFilterImages(
  product: Product,
  rule?: PublishImageRule,
): ValidatedImages {
  const mergedRule: PublishImageRule = {
    ...DEFAULT_PUBLISH_RULE.image,
    ...rule,
  }

  // 1. 收集来源图片并去重
  const candidateUrls: string[] = []
  const seen = new Set<string>()

  const addUrl = (url?: string) => {
    if (!url || typeof url !== 'string') return
    const trimmed = url.trim()
    if (!trimmed || seen.has(trimmed)) return
    seen.add(trimmed)
    candidateUrls.push(trimmed)
  }

  addUrl(product.coverUrl)
  if (Array.isArray(product.images)) {
    for (const img of product.images) {
      addUrl(img)
    }
  }

  if (candidateUrls.length === 0) {
    throw new PublishError(
      'IMAGE_DOWNLOAD_FAILED',
      `商品 \"${product.itemId}\" 缺少任何可用的商品图片`,
      { retryable: false },
    )
  }

  // 2. URL 协议过滤与升级（只允许 HTTPS）
  const validHttpsUrls: string[] = []
  for (const rawUrl of candidateUrls) {
    let normalizedUrl = rawUrl
    // 自动将 http:// 升级为 https://
    if (normalizedUrl.startsWith('http://')) {
      normalizedUrl = normalizedUrl.replace('http://', 'https://')
    }

    try {
      const parsed = new URL(normalizedUrl)
      if (parsed.protocol !== 'https:') {
        // 非 https 协议拒绝
        continue
      }
      validHttpsUrls.push(normalizedUrl)
    } catch {
      // 非法 URL 格式忽略
      continue
    }
  }

  const minImages = mergedRule.minImages ?? 1
  if (validHttpsUrls.length < minImages) {
    throw new PublishError(
      'IMAGE_DOWNLOAD_FAILED',
      `商品 \"${product.itemId}\" 合法 HTTPS 图片数量不足（至少需 ${minImages} 张，当前有效: ${validHttpsUrls.length}）`,
      { retryable: false },
    )
  }

  // 3. 截断最大数量
  const maxImages = mergedRule.maxImages ?? 9
  const limitedImages = validHttpsUrls.slice(0, maxImages)

  const mainImage = limitedImages[0]!
  const detailImages = limitedImages.slice(1)

  return {
    mainImage,
    detailImages,
    allImages: limitedImages,
  }
}

/**
 * 组装标准待发布商品数据（PublishItem）
 *
 * @param product 来源商品实体
 * @param rule 发布规则
 * @param override 手工覆盖项（可选）
 */
export function buildPublishItem(
  product: Product,
  rule?: PublishRule,
  override?: PublishItemOverride,
): PublishItem {
  const priceResult = applyPriceRule(product, rule?.price)
  const contentResult = applyContentRule(product, rule?.content)
  const imageResult = validateAndFilterImages(product, rule?.image)

  // 处理覆盖项
  const finalTitle = override?.title?.trim() || contentResult.title
  const finalDesc = override?.desc?.trim() || contentResult.desc

  let finalPrice = priceResult.price
  let finalPriceInCent = priceResult.priceInCent
  if (typeof override?.price === 'number' && override.price > 0) {
    finalPrice = Number(override.price.toFixed(2))
    finalPriceInCent = Math.round(finalPrice * 100)
  }

  let finalOriginalPrice = priceResult.originalPrice
  let finalOriginalPriceInCent = priceResult.originalPriceInCent
  if (typeof override?.originalPrice === 'number' && override.originalPrice > 0) {
    finalOriginalPrice = Number(override.originalPrice.toFixed(2))
    finalOriginalPriceInCent = Math.round(finalOriginalPrice * 100)
  }

  let finalAllImages = imageResult.allImages
  let finalMainImage = imageResult.mainImage
  let finalDetailImages = imageResult.detailImages

  if (Array.isArray(override?.images) && override.images.length > 0) {
    const validOverrideImages = override.images
      .map((u) => (u.startsWith('http://') ? u.replace('http://', 'https://') : u))
      .filter((u) => {
        try {
          return new URL(u).protocol === 'https:'
        } catch {
          return false
        }
      })
    if (validOverrideImages.length > 0) {
      finalAllImages = validOverrideImages.slice(0, rule?.image?.maxImages ?? 9)
      finalMainImage = finalAllImages[0]!
      finalDetailImages = finalAllImages.slice(1)
    }
  }

  return {
    itemId: product.itemId,
    sourceTitle: product.title,
    sourcePrice: product.priceNumber,
    sourceOriginalPrice: product.originalPriceNumber,
    sourceDesc: product.desc,
    sourceImages: product.images || [product.coverUrl].filter(Boolean),

    title: finalTitle,
    desc: finalDesc,
    price: finalPrice,
    priceInCent: finalPriceInCent,
    originalPrice: finalOriginalPrice,
    originalPriceInCent: finalOriginalPriceInCent,
    mainImage: finalMainImage,
    detailImages: finalDetailImages,
    allImages: finalAllImages,

    confirmationStatus: 'unconfirmed',
  }
}
