/**
 * 类目与属性候选卡片整理工具（纯函数）。
 *
 * 职责：
 * 1. 兼容读取后台返回的 propertyCards 格式（支持 direct-publish-page 归一化后的 values，
 *    以及原始 cardData.valuesList 结构），整理出前端友好的 NormalizedPropertyCard；
 * 2. 严格按后台 normalizeReviewedDraft 校验规则：
 *    - 属性项必须为 { propertyId: string, valueId: string } 结构，杜绝随意拼接；
 *    - 类目项由 category 统一处理（propertyId 为 '-10000' 或 isCategory=true 排除在 attributes 外）；
 * 3. 类目切换时，计算属性兼容性与重置。
 */

import type {
  NormalizedCardValue,
  NormalizedPropertyCard,
} from './direct-publish-types'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

/** 安全转换字符串。 */
function toText(v: unknown): string {
  if (typeof v === 'string') return v.trim()
  if (typeof v === 'number') return String(v)
  return ''
}

/** 整理单个候选值。 */
function normalizeCardValue(raw: unknown, isCategory: boolean): NormalizedCardValue | null {
  if (!isRecord(raw)) return null
  const isCat = isCategory || raw['isCategory'] === true
  // 类目对齐后台 direct-publish-page.ts:58：类目优先 channelCatId || catId || valueId
  const valueId = isCat
    ? toText(raw['channelCatId'] || raw['catId'] || raw['valueId'] || raw['id'])
    : toText(raw['valueId'] || raw['id'])
  const valueName = toText(raw['valueName'] || raw['catName'] || raw['name'] || raw['text'])
  if (!valueId && !valueName) return null

  const catId = toText(raw['catId']) || undefined
  const channelCatId = toText(raw['channelCatId']) || undefined
  const catName = toText(raw['catName']) || undefined
  const leafId = toText(raw['leafId']) || undefined
  const tbCatId = toText(raw['tbCatId']) || undefined

  const transportData = isRecord(raw['transportData'])
    ? (raw['transportData'] as Record<string, unknown>)
    : raw

  return {
    valueId: valueId || valueName,
    valueName: valueName || valueId,
    isCategory: isCat,
    catId,
    channelCatId,
    catName,
    leafId,
    tbCatId,
    transportData,
  }
}

/** 整理卡片列表。 */
export function normalizePropertyCards(rawCards: unknown[] | undefined | null): NormalizedPropertyCard[] {
  if (!Array.isArray(rawCards)) return []
  const result: NormalizedPropertyCard[] = []

  for (const raw of rawCards) {
    if (!isRecord(raw)) continue
    // 兼容 cardData 嵌套结构或平铺结构
    const cd = isRecord(raw['cardData']) ? (raw['cardData'] as Record<string, unknown>) : raw

    const cardType = toText(raw['cardType'] || cd['cardType'])
    const propertyId = toText(cd['propertyId'] || raw['propertyId'])
    const propertyName = toText(cd['propertyName'] || raw['propertyName'])
    const isCategory = propertyId === '-10000' || raw['isCategory'] === true || cd['isCategory'] === true
    const isBook = cd['isBook'] === true || raw['isBook'] === true
    const supportWebPublish = cd['supportWebPublish'] !== false && raw['supportWebPublish'] !== false
    const tips = toText(cd['tips'] || raw['tips'])

    // 读取候选值集合（兼容 values, valuesList, cardData.valuesList）
    const rawValues = Array.isArray(raw['values'])
      ? (raw['values'] as unknown[])
      : Array.isArray(cd['valuesList'])
        ? (cd['valuesList'] as unknown[])
        : Array.isArray(raw['valuesList'])
          ? (raw['valuesList'] as unknown[])
          : []

    const values: NormalizedCardValue[] = []
    for (const val of rawValues) {
      const normalizedVal = normalizeCardValue(val, isCategory)
      if (normalizedVal) values.push(normalizedVal)
    }

    result.push({
      cardType,
      propertyId,
      propertyName,
      isCategory,
      isBook,
      supportWebPublish,
      tips,
      values,
    })
  }

  return result
}

/**
 * 校验并构造符合后台要求的属性选择项。
 * 必须包含 propertyId 和 valueId。
 */
export function buildAttributeItem(propertyId: string, valueId: string): Record<string, unknown> {
  return {
    propertyId: String(propertyId).trim(),
    valueId: String(valueId).trim(),
  }
}

/** 从 draft.attributes 中提取某属性已选中的 valueId。 */
export function getSelectedValueId(attributes: Array<Record<string, unknown>> | undefined, propertyId: string): string {
  if (!Array.isArray(attributes)) return ''
  const item = attributes.find((a) => isRecord(a) && toText(a['propertyId']) === propertyId)
  return item ? toText(item['valueId']) : ''
}

/** 更新或添加 draft.attributes 中的某属性项。 */
export function setAttributeSelection(
  attributes: Array<Record<string, unknown>>,
  propertyId: string,
  valueId: string,
): Array<Record<string, unknown>> {
  const next = attributes.filter((a) => isRecord(a) && toText(a['propertyId']) !== propertyId)
  if (valueId.trim() !== '') {
    next.push(buildAttributeItem(propertyId, valueId))
  }
  return next
}

/** 构造类目对象（供 draft.category 使用）。 */
export function buildCategoryFromCandidate(candidate: NormalizedCardValue): Record<string, string> {
  return {
    catId: candidate.catId || candidate.valueId,
    catName: candidate.catName || candidate.valueName,
    channelCatId: candidate.channelCatId || candidate.valueId,
    leafId: candidate.leafId || '0',
    tbCatId: candidate.tbCatId || '',
    valueId: candidate.valueId,
  }
}
