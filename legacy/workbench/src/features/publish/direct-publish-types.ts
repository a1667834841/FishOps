/**
 * 直接发布（两阶段）工作台前端类型定义。
 *
 * 引用 shared/types/direct-publish.ts 共享契约与后台类型，
 * 定义前端特有的卡片展示、草稿编辑模型与控制器状态。
 */

import type {
  DirectPublishPrepareRequest,
  DirectPublishPreparedResult,
  DirectPublishReviewDraft as SharedDirectPublishReviewDraft,
  DirectPublishSubmitRequest,
} from '../../../../shared/types/direct-publish'
import { DIRECT_PUBLISH_TITLE_MAX } from '../../../../shared/types/direct-publish'

export type DirectPublishReviewDraft = Omit<SharedDirectPublishReviewDraft, 'title'> & {
  title?: string
}

export type {
  DirectPublishPrepareRequest,
  DirectPublishPreparedResult,
  DirectPublishSubmitRequest,
}

export { DIRECT_PUBLISH_TITLE_MAX }

/** 提交阶段最终发布结果（与后台 direct-publish-api.ts 一致）。 */
export interface DirectPublishSubmitResult {
  status: 'published' | 'action_required' | 'rejected' | 'unknown'
  idempotencyKey: string
  itemId?: string
  actionRequired?: 'login' | 'captcha' | 'verification'
  code?: string
  message?: string
  reused?: boolean
  fingerprint?: string
  retryable?: boolean
  prepareTokenValid?: boolean
  warnings?: string[]
}

/** 归一化后的候选属性值。 */
export interface NormalizedCardValue {
  valueId: string
  valueName: string
  isCategory: boolean
  catId?: string
  channelCatId?: string
  catName?: string
  leafId?: string
  tbCatId?: string
  transportData: Record<string, unknown>
}

/** 归一化后的类目/属性候选卡片（供前端选择）。 */
export interface NormalizedPropertyCard {
  cardType: string
  propertyId: string
  propertyName: string
  isCategory: boolean
  isBook: boolean
  supportWebPublish: boolean
  tips: string
  values: NormalizedCardValue[]
}

/** 两阶段发布控制器阶段状态。 */
export type DirectPublishPhase =
  | 'idle'
  | 'preparing'
  | 'reviewed'
  | 'submitting'
  | 'published'
  | 'action_required'
  | 'prepare_failed'
  | 'submit_rejected'
  | 'unknown'

/** 前端发货地址表单。 */
export interface DirectPublishSellerForm {
  prov: string
  city: string
  area: string
  divisionId: string
  poiName: string
  poiId: string
  gps: string
  latitude?: number | ''
  longitude?: number | ''
}
