/**
 * 直接接口发布（两阶段）共享契约。
 *
 * 仅类型定义与少量**共享常量**，供扩展后台与前端以**相对路径** `import` 直接引用；
 * **不从 `shared/events/index.ts` 导出**，避免污染既有协议与工作台命令。
 *
 * 两阶段：
 * 1. prepare：后台跑完「最终 publish 之前」的全部接口（资格预检、preget、详情、
 *    违禁词、图片上传、推荐类目属性、POI、service cards），返回完整「已准备实际待发送数据」
 *    与人工资讯（候选类目属性卡片），**不提交**；
 * 2. submit：用户在扩展内页核对 / 编辑后回传 {@link DirectPublishSubmitRequest}，
 *    后台严格校验草稿后才会调用最终 publish。
 *
 * 权威约束：草稿里的 `category` / `attributes` / `images` 只是「候选选择」，
 * 后台会按 prepare 缓存的权威候选重新组装，拒绝任意拼接与未知字段注入。
 */

/** 人工审核草稿：prepare 返回的「实际待发送数据」，submit 回传确认。 */
export interface DirectPublishReviewDraft {
  /**
   * @deprecated 闲鱼商品**无独立标题**：最终以 description 统一提交（`titleDescSeparate=false`）。
   * 保留**可选**仅为旧草稿 / 旧调用兼容；submit 归一化会**忽略**该字段
   * （不校验、不拼接到文案、不参与指纹），避免「同描述不同隐形 title」冲突。
   */
  title?: string
  /** 商品描述（唯一文案；原始文本，**不含**规格追加，规格单独放在 specifications 并只追加一次）。 */
  description: string
  /** 售价（元字符串）。 */
  price: string
  /** 规格（singleSKU，最终组装时按行追加到描述，只追加一次）。 */
  specifications: Array<{ name: string; value: string }>
  /** 类目（须为 prepare 网页支持的候选之一，如 `{ catId, catName, channelCatId, leafId, tbCatId }`）。 */
  category: Record<string, string>
  /** 属性（须命中 propertyCards 候选值，后台按候选 transportData 重建，不信任前端字段）。 */
  attributes: Array<Record<string, unknown>>
  /** 发货地址（后台只保留 prov/city/area/divisionId/poiName/poiId/gps 白名单字段）。 */
  address: Record<string, string>
  /** 图片（只能从已上传图片中重排 / 删除，禁止伪造图片数据）。 */
  images: Array<Record<string, unknown>>
  /** 服务卡（只能启用 prepare 已确认可用的服务；AI_SALE 强制 false）。 */
  services: Array<{ serviceCode: string; enable: boolean }>
}

/** prepare 入参。 */
export interface DirectPublishPrepareRequest {
  source:
    | {
        product: {
          /**
           * @deprecated 闲鱼商品无独立标题：该字段被**忽略**，最终文案统一取 description。
           * 保留可选仅为旧调用兼容。
           */
          title?: string
          description: string
          price: string
          images: string[]
          specifications?: Array<{ name: string; value: string }>
        }
      }
    | { itemId: string; imageIndexes?: number[] }
  /** 幂等键；同 key 会绑定到 prepareToken，submit 时据此防重复。 */
  idempotencyKey: string
  /**
   * 卖家发货地址 / 坐标；**可选**。
   * 缺省时后台自动只读当前账号**官方已选默认发货地址**（`poi.get` 的 `selectedPoi`），
   * 不使用源卖家地址，也不把「常用 / 附近」地址当已选；显式传入时作为 override 继续兼容。
   */
  seller?: {
    address?: Record<string, string>
    coordinates?: { latitude: number; longitude: number }
  }
  /** @deprecated 保留仅为旧调用兼容；两阶段直接自动上传图片，不校验该字段，新前端不再发送。 */
  confirmedNoQrCodes?: boolean
  /** 已有类目（作为初始选择；推荐接口仍会执行，最终按候选校验，不覆盖用户选择）。 */
  category?: Record<string, string>
  /** 已有属性（作为初始选择；推荐接口仍会执行，最终按候选校验，不覆盖用户选择）。 */
  attributes?: Array<Record<string, unknown>>
}

/** prepare 结果。 */
export interface DirectPublishPreparedResult {
  status: 'prepared' | 'action_required' | 'rejected' | 'unknown'
  /** 成功时返回，用于后续 submit；不可伪造、不可跨账号复用。 */
  prepareToken?: string
  /**
   * 完整「实际待发送数据」；prepare 失败时若已准备好部分数据，
   * 会返回**部分 draft**（无 token），供 UI 展示已准备部分而非空白表单。
   */
  draft?: DirectPublishReviewDraft
  /** 类目 / 属性候选卡（含候选 value 的 transportData），供人工资讯与选择。 */
  propertyCards?: Array<Record<string, unknown>>
  warnings?: string[]
  code?: string
  message?: string
  actionRequired?: 'login' | 'captcha' | 'verification'
  /** 失败阶段细分（如 `source` / `login` / `network` / `parse` / `address` / `category` / `images` / `badwords` / `services`），供 UI 定位，不吞异常。 */
  failureStage?: string
  /** 解析 / 前置条件缺失的字段清单（如 `['address']` / `['category']`），供 UI 提示补全。 */
  missingFields?: string[]
}

/** submit 入参。 */
export interface DirectPublishSubmitRequest {
  prepareToken: string
  draft: DirectPublishReviewDraft
  /** 最终一次性确认（唯一必需门禁）。 */
  confirm: true
  /** @deprecated 两阶段不再要求；保留为可选仅为旧调用兼容。 */
  categoryConfirmed?: boolean
  /** @deprecated 两阶段不再要求；保留为可选仅为旧调用兼容。 */
  confirmedNoQrCodes?: boolean
}

// ==================== 共享常量 ====================

/**
 * 旧一步式**独立标题**长度上限（与服务端 `FAIL_BIZ_TITLE_LENGTH_TOO_LONG` 校验一致，单位：字符）。
 * @deprecated 保留 `export` 仅为旧调用 / 前端展示兼容；两阶段描述模式**无独立标题**，
 * 提交文案统一为 description（`titleDescSeparate=false`），**不再用该阈值**校验。
 * 两阶段 submit 预校验改按「描述 + 规格拼接后的最终描述长度」（见 `DRAFT_DESCRIPTION_MAX`）。
 */
export const DIRECT_PUBLISH_TITLE_MAX = 30
