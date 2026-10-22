<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'

import Callout from '../../components/Callout.vue'
import {
  PhArrowDown,
  PhArrowUp,
  PhArrowsClockwise,
  PhCheckCircle,
  PhPaperPlaneTilt,
  PhPlus,
  PhSpinnerGap,
  PhTrash,
  PhWarningCircle,
} from '@phosphor-icons/vue'
import type {
  DirectPublishController,
  DirectPublishSourceProduct,
} from './direct-publish-controller'
import { getSelectedValueId } from './direct-publish-cards'
import { formatPublishServiceName } from './direct-publish-labels'

const props = defineProps<{
  sourceProduct: DirectPublishSourceProduct | null
  sourceLabel?: string
  controller: DirectPublishController
}>()
const sourceLabel = computed(() => props.sourceLabel?.trim() || '当前商品')

// 响应式镜像状态
const phase = ref(props.controller.getPhase())
const sellerForm = ref(props.controller.getSellerForm())
const reviewedDraft = ref(props.controller.getReviewedDraft())
const propertyCards = ref(props.controller.getPropertyCards())
const warnings = ref(props.controller.getWarnings())
const failureStage = ref(props.controller.getFailureStage())
const missingFields = ref(props.controller.getMissingFields())
const publishedItemId = ref(props.controller.getPublishedItemId())
const errorCode = ref(props.controller.getErrorCode())
const errorMessage = ref(props.controller.getErrorMessage())
const actionRequired = ref(props.controller.getActionRequired())
const isDraftLocked = ref(props.controller.isDraftLocked())
const canStartPrepare = ref(props.controller.canStartPrepare())
const canSubmit = ref(props.controller.canSubmit())

// 状态同步
function syncState() {
  phase.value = props.controller.getPhase()
  sellerForm.value = props.controller.getSellerForm()
  reviewedDraft.value = props.controller.getReviewedDraft()
  propertyCards.value = props.controller.getPropertyCards()
  warnings.value = props.controller.getWarnings()
  failureStage.value = props.controller.getFailureStage()
  missingFields.value = props.controller.getMissingFields()
  publishedItemId.value = props.controller.getPublishedItemId()
  errorCode.value = props.controller.getErrorCode()
  errorMessage.value = props.controller.getErrorMessage()
  actionRequired.value = props.controller.getActionRequired()
  isDraftLocked.value = props.controller.isDraftLocked()
  canStartPrepare.value = props.controller.canStartPrepare()
  canSubmit.value = props.controller.canSubmit()
}

const unsubscribe = props.controller.subscribe(syncState)
onUnmounted(() => {
  unsubscribe()
})

const FAILURE_STAGE_MAP: Record<string, string> = {
  source: '商品源校验阶段',
  login: '账号登录检测阶段',
  network: '接口网络通信阶段',
  parse: '数据结构解析阶段',
  address: '发货地点匹配阶段',
  category: '类目属性推荐阶段',
  images: '图片上传处理阶段',
  badwords: '敏感词扫描阶段',
  services: '保障服务卡片阶段',
}

// 自动 prepare 控制：进入发布页或商品源变更时只准备一次；已有 reviewed 草稿时保留编辑不重复上传。
async function handleOpenOrSourceChange() {
  if (!props.sourceProduct) return

  // 同商品已有 reviewed 草稿时，保留编辑，不重复上传/不重复 prepare
  if (props.controller.hasReviewedDraftFor(props.sourceProduct)) {
    syncState()
    return
  }

  // 如果当前正在 preparing
  if (props.controller.getPhase() === 'preparing') {
    // 同源在途，防止重复并发
    if (props.controller.isSameSource(props.sourceProduct)) {
      return
    }
    // 跨源漂移：取消旧源准备，废弃在途请求并递增 seq
    props.controller.cancel()
  }

  // 同源在途已在上方拦截；取消后的新请求由控制器序列号隔离，不等待旧请求返回。
  try {
    syncState()
    await props.controller.initAndPrepareSource(props.sourceProduct)
  } finally {
    syncState()
  }
}

watch(
  () => props.sourceProduct,
  (src, prevSrc) => {
    if (src && src !== prevSrc) void handleOpenOrSourceChange()
  },
  { immediate: true },
)

const isBusy = computed(() => phase.value === 'preparing' || phase.value === 'submitting')
const uploadingImage = ref(false)
const imageUploadError = ref('')

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = ''
  if (files.length === 0) return
  uploadingImage.value = true
  imageUploadError.value = ''
  try {
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        imageUploadError.value = `不支持的文件格式：${file.name}`
        continue
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('读取图片失败')))
        reader.onerror = () => reject(new Error('读取图片失败'))
        reader.readAsDataURL(file)
      })
      const result = await props.controller.uploadImageDataUrl(dataUrl)
      if (!result.ok) imageUploadError.value = result.message
    }
  } catch (error) {
    imageUploadError.value = error instanceof Error ? error.message : '本地图片上传失败'
  } finally {
    uploadingImage.value = false
  }
}

// 地址是否关键字段缺失
const isAddressIncomplete = computed(() => {
  if (!reviewedDraft.value?.address) return false
  const addr = reviewedDraft.value.address
  return !addr.prov?.trim() || !addr.city?.trim() || !addr.area?.trim()
})

// 类目候选卡片（propertyId === '-10000' 或 isCategory=true）
const categoryCard = computed(() => propertyCards.value.find((c) => c.isCategory))

// 属性候选卡片（排除类目）
const attributeCards = computed(() => propertyCards.value.filter((c) => !c.isCategory))

// 当前选中的类目 candidate valueId
const currentCategoryValueId = computed(() => {
  if (!reviewedDraft.value?.category) return ''
  const cat = reviewedDraft.value.category
  return cat.channelCatId || cat.catId || cat.valueId || ''
})

// 最终将提交的业务草稿 Payload（只读展示业务数据，不伪造复选框字段，绝不暴露 prepareToken 敏感凭据）
const finalPayloadPreview = computed(() => {
  if (!reviewedDraft.value) return null
  return {
    businessDraft: reviewedDraft.value,
    confirm: true,
  }
})

// ==================== 事件操作 ====================

async function onRetryPrepare() {
  if (isBusy.value) return
  await props.controller.executePrepare()
}

function onCategoryChange(e: Event) {
  const target = e.target as HTMLSelectElement
  const valId = target.value
  if (!categoryCard.value) return
  const candidate = categoryCard.value.values.find((v) => v.valueId === valId)
  if (candidate) {
    props.controller.selectCategory(candidate)
  }
}

function onAttributeChange(propertyId: string, e: Event) {
  const target = e.target as HTMLSelectElement
  props.controller.selectAttribute(propertyId, target.value)
}

function onUpdateSpec(index: number, key: 'name' | 'value', val: string) {
  if (!reviewedDraft.value?.specifications) return
  const list = reviewedDraft.value.specifications.map((s, idx) =>
    idx === index ? { ...s, [key]: val } : s,
  )
  props.controller.updateDraftSpecifications(list)
}

function onAddSpecification() {
  const list = reviewedDraft.value?.specifications ? [...reviewedDraft.value.specifications] : []
  list.push({ name: '', value: '' })
  props.controller.updateDraftSpecifications(list)
}

function onRemoveSpecification(index: number) {
  if (!reviewedDraft.value?.specifications) return
  const list = reviewedDraft.value.specifications.filter((_, idx) => idx !== index)
  props.controller.updateDraftSpecifications(list)
}

function onMoveImage(index: number, direction: 'up' | 'down') {
  const targetIndex = direction === 'up' ? index - 1 : index + 1
  props.controller.reorderImages(index, targetIndex)
}

function onRemoveImage(index: number) {
  props.controller.removeImage(index)
}

function onToggleService(serviceCode: string, e: Event) {
  const target = e.target as HTMLInputElement
  props.controller.toggleService(serviceCode, target.checked)
}

async function onExecuteSubmit() {
  await props.controller.executeSubmit()
}


function onBackToPrepare() {
  props.controller.backToPrepare()
}

function onManualUnlock() {
  props.controller.manualUnlockDraft()
}
</script>

<template>
  <section class="direct-publish-modal" aria-labelledby="direct-publish-title">
    <h2 id="direct-publish-title" class="sr-only">直接接口发布</h2>
      <div class="publish-flow-heading">
        <strong>发布准备与最终确认</strong>
        <span>页面已自动获取最新信息并准备发布数据，请核对后点击一次“发布”。</span>
      </div>

      <!-- Unknown 同源草稿锁定警示（去掉永久锁不实描述） -->
      <div v-if="isDraftLocked" class="modal-locked-banner" role="alert">
        <PhWarningCircle class="warn-icon" :size="24" aria-hidden="true" />
        <div class="locked-text">
          <h4>发布结果未知，已锁定该草稿！</h4>
          <p>
            由于此前的最终提交未收到平台明确成功/失败响应，为杜绝同一商品在闲鱼重复上架，
            <strong>系统已锁定该草稿，禁止自动重试与提交</strong>。
          </p>
          <p class="locked-sub">请在闲鱼 APP 或网页端进入「我的发布」人工核实。</p>
          <div class="locked-actions">
            <button type="button" class="btn btn--sm btn--ghost" @click="onManualUnlock">
              我已在闲鱼核实未上架，解除锁定
            </button>
          </div>
        </div>
      </div>

      <!-- 阶段 1：自动预检与准备状态（直接 loading / 失败指导，不展示空表单） -->
      <div v-if="!isDraftLocked && (phase === 'idle' || phase === 'preparing' || phase === 'prepare_failed')" class="prepare-phase-box">
        <!-- 准备执行中 Loading 视图 -->
        <div v-if="phase === 'preparing' || phase === 'idle'" class="preparing-loading-card">
          <PhSpinnerGap class="loading-spinner" :size="36" aria-hidden="true" />
          <div class="loading-text">
            <h4>正在自动预检与准备发布数据...</h4>
            <p>
              正在后台自动完成：商品预检、图片上传平台相册、敏感词扫描、匹配闲鱼推荐类目与属性、校准账号发货地点。
              <strong>准备阶段绝不执行最终发布</strong>，请稍候...
            </p>
          </div>

        </div>

        <!-- 准备失败视图（保留 returned draft / propertyCards，展示原因与指引） -->
        <div v-else-if="phase === 'prepare_failed'" class="prepare-failed-card">
          <Callout tone="error" :title="`准备发布未完成：${sourceLabel ? `${sourceLabel}：` : ''}${errorMessage}`">
            <div class="failure-details">
              <p v-if="failureStage" class="failure-stage-text">
                <strong>失败阶段：</strong>{{ failureStage === 'source' ? '商品详情读取阶段' : FAILURE_STAGE_MAP[failureStage] || failureStage }}
                <span v-if="errorCode" class="error-code-badge">（错误码: {{ errorCode }}）</span>
              </p>
              <p v-if="missingFields && missingFields.length > 0" class="missing-fields-text">
                <strong>缺失字段：</strong>{{ missingFields.join('、') }}
              </p>
              <p class="guide-text">
                💡 <strong>操作指导：</strong>请先按上方错误信息排查当前失败阶段；仅当明确返回登录或验证要求时，再前往闲鱼完成相应操作。
              </p>
            </div>
          </Callout>

          <!-- 若返回了部分已准备好的草稿或卡片，保留展示不清空 -->
          <div v-if="reviewedDraft || (propertyCards && propertyCards.length > 0)" class="partial-draft-preview">
            <h5 class="partial-preview-title">已准备部分数据预览（仅供核对参考）：</h5>
            <div v-if="reviewedDraft?.images && reviewedDraft.images.length > 0" class="partial-images-row">
              <img
                v-for="(img, idx) in reviewedDraft.images"
                :key="idx"
                :src="(img as any).url || (img as any).picUrl || (img as any).originUrl"
                class="mini-thumb"
                alt="已上传图片预览"
                referrerpolicy="no-referrer"
              />
            </div>
            <p v-if="reviewedDraft?.title" class="partial-info-line">商品标题：{{ reviewedDraft.title }}</p>
            <p v-if="reviewedDraft?.price" class="partial-info-line">售价：¥{{ reviewedDraft.price }}</p>
          </div>

          <div class="modal-footer-bar">
            <button type="button" class="btn btn--primary" @click="onRetryPrepare">
              <PhArrowsClockwise :size="16" aria-hidden="true" />
              <span>重新准备发布</span>
            </button>
          </div>
        </div>
      </div>

      <!-- 阶段 2：草稿核对与编辑 (Reviewed Draft) -->
      <div v-else-if="!isDraftLocked && (phase === 'reviewed' || phase === 'submitting' || phase === 'submit_rejected')" class="review-phase-box">
        <!-- 告警与平台提示 -->
        <div v-if="warnings.length > 0" class="warnings-box">
          <Callout tone="warn" title="平台返回提示事项">
            <ul>
              <li v-for="(w, idx) in warnings" :key="idx">{{ w }}</li>
            </ul>
          </Callout>
        </div>

        <!-- 提交失败提示 -->
        <div v-if="phase === 'submit_rejected' && errorMessage" class="phase-error-box">
          <Callout tone="error" :title="`提交失败：${errorMessage}`">
            <span v-if="errorCode">错误码: {{ errorCode }}</span>
          </Callout>
        </div>

        <!-- 草稿编辑网格（全字段可编辑） -->
        <div class="draft-edit-grid">
          <!-- 描述编辑 -->
          <div class="form-group col-full">
            <label class="form-label" for="draft-desc">商品描述正文（不含规格追加）：</label>
            <textarea
              id="draft-desc"
              rows="4"
              class="input-textarea"
              placeholder="请输入商品描述文本"
              :value="reviewedDraft?.description || ''"
              :disabled="isBusy"
              @input="controller.updateDraftDescription(($event.target as HTMLInputElement).value)"
            />
          </div>

          <!-- 售价编辑 -->
          <div class="form-group">
            <label class="form-label" for="draft-price">售价（元，最多两位小数）：</label>
            <input
              id="draft-price"
              type="text"
              class="input-text"
              placeholder="如：99.00"
              :value="reviewedDraft?.price || ''"
              :disabled="isBusy"
              @input="controller.updateDraftPrice(($event.target as HTMLInputElement).value)"
            />
          </div>

          <!-- 单 SKU 规格配置（支持动态增删改与预览，非空门禁） -->
          <div class="form-group col-full">
            <div class="label-row">
              <label class="form-label">
                单 SKU 规格属性（共 {{ reviewedDraft?.specifications?.length || 0 }} 项，最终组装时追加至描述末尾）：
              </label>
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                :disabled="isBusy"
                @click="onAddSpecification"
              >
                <PhPlus :size="14" aria-hidden="true" />
                添加规格
              </button>
            </div>

            <div v-if="reviewedDraft?.specifications && reviewedDraft.specifications.length > 0" class="specs-edit-list">
              <div v-for="(spec, idx) in reviewedDraft.specifications" :key="idx" class="spec-edit-row">
                <input
                  type="text"
                  class="input-text spec-name-input"
                  placeholder="规格名称 (如颜色)"
                  :value="spec.name"
                  :disabled="isBusy"
                  @input="onUpdateSpec(idx, 'name', ($event.target as HTMLInputElement).value)"
                />
                <input
                  type="text"
                  class="input-text spec-val-input"
                  placeholder="规格值 (如黑色)"
                  :value="spec.value"
                  :disabled="isBusy"
                  @input="onUpdateSpec(idx, 'value', ($event.target as HTMLInputElement).value)"
                />
                <button
                  type="button"
                  class="btn-icon btn-icon--danger"
                  title="删除此规格"
                  :disabled="isBusy"
                  @click="onRemoveSpecification(idx)"
                >
                  <PhTrash :size="16" aria-hidden="true" />
                </button>
              </div>

              <!-- 描述末尾规格追加预览 -->
              <details class="specs-preview-details">
                <summary>查看规格追加至描述的效果预览</summary>
                <div class="specs-preview-content">
                  <p class="specs-preview-header">【规格参数】</p>
                  <p v-for="(s, sIdx) in reviewedDraft.specifications" :key="sIdx" class="specs-preview-line">
                    {{ s.name }}：{{ s.value }}
                  </p>
                </div>
              </details>
            </div>
            <div v-else class="empty-hint">暂无规格配置，点击上方「添加规格」可新增单 SKU 规格参数。</div>
          </div>

          <!-- 类目下拉选择（必须命中候选卡片） -->
          <div v-if="categoryCard" class="form-group col-full">
            <label class="form-label" for="cat-select">
              闲鱼推荐类目（基于商品智能推荐，切换类目将重置属性）：
            </label>
            <select
              id="cat-select"
              class="input-select"
              :value="currentCategoryValueId"
              :disabled="isBusy"
              @change="onCategoryChange"
            >
              <option value="">-- 请选择类目 --</option>
              <option v-for="val in categoryCard.values" :key="val.valueId" :value="val.valueId">
                {{ val.valueName }} (catId: {{ val.catId || val.valueId }})
              </option>
            </select>
            <p class="field-hint">选中的类目将作为候选传给后台，后台按权威数据校验重建。</p>
          </div>

          <!-- 属性下拉选择（动态卡片列表） -->
          <div v-if="attributeCards.length > 0" class="form-group col-full">
            <label class="form-label">推荐属性卡片：</label>
            <div class="attribute-cards-grid">
              <div v-for="card in attributeCards" :key="card.propertyId" class="attribute-item">
                <label class="sub-label">{{ card.propertyName }}：</label>
                <select
                  class="input-select"
                  :value="getSelectedValueId(reviewedDraft?.attributes, card.propertyId)"
                  :disabled="isBusy"
                  @change="onAttributeChange(card.propertyId, $event)"
                >
                  <option value="">-- 未选择 --</option>
                  <option v-for="v in card.values" :key="v.valueId" :value="v.valueId">
                    {{ v.valueName }}
                  </option>
                </select>
              </div>
            </div>
          </div>

          <!-- 发货地址与定位（官方账号默认地址只读展示，官方页修改后重新获取） -->
          <div class="form-group col-full">
            <label class="form-label">
              发货地址与定位（由闲鱼官方账号自动解析匹配，只读展示）：
            </label>
            <div v-if="isAddressIncomplete" class="address-warn-tip" role="alert">
              <PhWarningCircle :size="16" aria-hidden="true" />
              <span>当前发货地址缺少省/市/区或经纬度关键信息，需补齐有效行政区后方可发布。</span>
            </div>
            <div class="address-input-grid">
              <div class="form-group">
                <label class="sub-label">省份：</label>
                <input
                  type="text"
                  class="input-text input-readonly"
                  placeholder="如：广东省"
                  :value="reviewedDraft?.address?.prov || ''"
                  readonly
                />
              </div>
              <div class="form-group">
                <label class="sub-label">城市：</label>
                <input
                  type="text"
                  class="input-text input-readonly"
                  placeholder="如：深圳市"
                  :value="reviewedDraft?.address?.city || ''"
                  readonly
                />
              </div>
              <div class="form-group">
                <label class="sub-label">区/县：</label>
                <input
                  type="text"
                  class="input-text input-readonly"
                  placeholder="如：南山区"
                  :value="reviewedDraft?.address?.area || ''"
                  readonly
                />
              </div>
              <div class="form-group">
                <label class="sub-label">商圈/地点名 (poiName)：</label>
                <input
                  type="text"
                  class="input-text input-readonly"
                  placeholder="如：科技园"
                  :value="reviewedDraft?.address?.poiName || ''"
                  readonly
                />
              </div>
              <div class="form-group">
                <label class="sub-label">经纬度坐标 (GPS)：</label>
                <input
                  type="text"
                  class="input-text input-readonly"
                  placeholder="如：113.934528,22.540503"
                  :value="reviewedDraft?.address?.gps || ''"
                  readonly
                />
              </div>
            </div>
            <p class="field-hint">
              💡 发货地址由闲鱼官方根据当前登录账号默认发货地址自动匹配与定位。为保证与平台 POI 商圈及行政区划代码严格一致，此处为只读展示。如需更换发货地址或坐标，请前往闲鱼官方发布页修改默认地址后点击下方「重新准备发布」即可。
            </p>
          </div>

          <!-- 图片管理：详情图片按原顺序保留，新图先真实上传成功后再追加。 -->
          <div class="form-group col-full">
            <div class="label-row">
              <label class="form-label">图片（共 {{ reviewedDraft?.images.length || 0 }} 张）：</label>
              <label class="btn btn--sm">
                <input type="file" accept="image/*" multiple hidden :disabled="isBusy || uploadingImage" @change="onFileSelected" />
                {{ uploadingImage ? '正在上传…' : '选择本地图片' }}
              </label>
            </div>
            <p v-if="imageUploadError" class="field-error-hint" role="alert">{{ imageUploadError }}</p>
            <div class="image-manage-grid">
              <div
                v-for="(img, idx) in reviewedDraft?.images || []"
                :key="idx"
                class="image-manage-card"
              >
                <img
                  :src="(img as any).url || (img as any).picUrl || (img as any).originUrl"
                  :alt="`图片 ${idx + 1}`"
                  class="manage-thumb-img"
                  referrerpolicy="no-referrer"
                />
                <span v-if="idx === 0" class="cover-tag">主图</span>
                <div class="image-actions">
                  <button
                    type="button"
                    class="btn-icon"
                    title="前移"
                    :disabled="idx === 0 || isBusy"
                    @click="onMoveImage(idx, 'up')"
                  >
                    <PhArrowUp :size="14" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="btn-icon"
                    title="后移"
                    :disabled="idx === (reviewedDraft?.images.length || 1) - 1 || isBusy"
                    @click="onMoveImage(idx, 'down')"
                  >
                    <PhArrowDown :size="14" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    class="btn-icon btn-icon--danger"
                    title="删除"
                    :disabled="(reviewedDraft?.images.length || 0) <= 1 || isBusy"
                    @click="onRemoveImage(idx)"
                  >
                    <PhTrash :size="14" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 配送方式固定展示 -->
          <div class="form-group col-full">
            <label class="form-label">配送方式（系统预置，只读注明）：</label>
            <div class="delivery-status-card">
              <span class="delivery-badge">包邮 / 快递发货</span>
              <span class="delivery-desc">
                支持运费模板与全国快递发货，非纯同城自提。当前接口发布版本为系统固定，只读注明当前不能调整。
              </span>
            </div>
          </div>

          <!-- 服务卡片配置 -->
          <div v-if="reviewedDraft?.services && reviewedDraft.services.length > 0" class="form-group col-full">
            <label class="form-label">平台服务卡片（支持启用已准备确认可用的服务；AI_SALE 强制关闭）：</label>
            <div class="services-row">
              <label v-for="srv in reviewedDraft.services" :key="srv.serviceCode" class="service-check-label">
                <input
                  type="checkbox"
                  :checked="srv.enable"
                  :disabled="srv.serviceCode === 'AI_SALE' || isBusy"
                  @change="onToggleService(srv.serviceCode, $event)"
                />
                <span :title="srv.serviceCode">{{ formatPublishServiceName(srv.serviceCode) }} {{ srv.serviceCode === 'AI_SALE' ? '（平台强制关闭）' : '' }}</span>
              </label>
            </div>
          </div>
        </div>

        <!-- 可折叠查看待提交业务草稿 (JSON) —— 仅展示业务 draft，绝不显示 prepareToken 敏感凭据 -->
        <details class="raw-payload-box">
          <summary>查看待提交业务草稿 (Review Draft JSON，非最终组装 Payload)</summary>
          <pre class="json-code">{{ JSON.stringify(finalPayloadPreview, null, 2) }}</pre>
        </details>

        <!-- 提交中状态 -->
        <div v-if="phase === 'submitting'" class="preparing-loading-box">
          <PhSpinnerGap class="loading-spinner" :size="24" aria-hidden="true" />
          <div class="loading-text">
            <strong>正在提交闲鱼发布...</strong>
            <p>已向平台发送最终提交请求，正在等待返回在售商品 itemId。提交中请勿离开发布页。</p>
          </div>
        </div>

        <!-- 阶段 2 操作栏（统一最后一次“确认并发布”，无逐项 checkbox） -->
        <div class="modal-footer-bar">
          <button
            type="button"
            class="btn btn--ghost"
            :disabled="isBusy"
            @click="onBackToPrepare"
          >
            重新准备发布
          </button>
          <button
            type="button"
            class="btn btn--primary"
            :disabled="!canSubmit || isBusy || uploadingImage"
            @click="onExecuteSubmit"
          >
            <PhSpinnerGap v-if="phase === 'submitting'" class="loading-spinner" :size="16" aria-hidden="true" />
            <PhPaperPlaneTilt v-else aria-hidden="true" :size="16" />
            <span>{{ phase === 'submitting' ? '正在提交发布...' : '确认并发布' }}</span>
          </button>
        </div>
      </div>

      <!-- 阶段 3：发布成功反馈 -->
      <div v-else-if="phase === 'published'" class="published-box">
        <PhCheckCircle class="success-icon" :size="48" aria-hidden="true" />
        <h3>发布成功！</h3>
        <p>商品已成功在闲鱼上架发布，成功标准已满足（官方返回有效 itemId）。</p>
        <div class="item-id-card">
          <span>新商品 Item ID：</span>
          <code>{{ publishedItemId }}</code>
          <a
            v-if="publishedItemId"
            :href="`https://www.goofish.com/item?id=${encodeURIComponent(publishedItemId)}`"
            target="_blank"
            rel="noopener noreferrer"
            class="item-link"
          >
            https://www.goofish.com/item?id={{ publishedItemId }}
          </a>
        </div>

      </div>

      <!-- 阶段 3：结果未知（同源草稿锁定，严禁自动重试） -->
      <div v-else-if="phase === 'unknown'" class="unknown-box">
        <PhWarningCircle class="warn-icon" :size="48" aria-hidden="true" />
        <h3>提交结果未知，已锁定该草稿</h3>
        <p class="unknown-desc">
          系统无法确认本次操作的最终结果，不能据此判断商品已经提交或上架。为避免重复发布，已锁定该草稿，不会自动重试。
        </p>
        <Callout v-if="errorCode || errorMessage" tone="error" title="本次操作的具体错误">
          <p v-if="errorCode">错误码：<code>{{ errorCode }}</code></p>
          <p v-if="errorMessage">原因：{{ errorMessage }}</p>
          <p>请保留这段错误信息，用于判断是通信异常、发布请求超时还是提交前检查失败。</p>
        </Callout>
        <p class="unknown-action">
          请前往闲鱼 APP 或网页端「我的发布」人工核实该商品是否已经上架。若已上架请勿重发；若确认未上架，可点击下方按钮解除锁定。
        </p>
        <div class="modal-footer-bar">
          <button type="button" class="btn btn--ghost" @click="onManualUnlock">
            已人工核实未上架（解除锁定）
          </button>

        </div>
      </div>

      <!-- 平台需要人工处理：登录或验证码 (action_required) -->
      <div v-else-if="phase === 'action_required'" class="action-required-box" role="alert">
        <PhWarningCircle class="warn-icon" :size="48" aria-hidden="true" />
        <h3>需要人工完成平台验证或登录</h3>
        <p class="action-desc">
          闲鱼平台返回了身份校验要求：{{ errorMessage || '需要完成安全验证或登录' }}
          <template v-if="actionRequired">（类型: {{ actionRequired }}）</template>。
        </p>
        <p class="action-hint">
          为确保您的账号安全，本插件绝不自动代填验证码或篡改登录凭据。请在闲鱼网页版完成相应验证或登录后，点击下方按钮重新发起准备。
        </p>
        <div class="modal-footer-bar">
          <button type="button" class="btn btn--primary" @click="onBackToPrepare">
            已在网页完成验证，返回重新准备
          </button>
        </div>
      </div>
  </section>
</template>

<style scoped>
.direct-publish-modal {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 280px;
}

/* 步骤指示 */
.modal-steps-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--surface-sunken);
  border-radius: var(--radius-control);
  font-size: 12px;
  color: var(--text-muted);
}

.step-badge {
  padding: 4px 8px;
  border-radius: 4px;
}

.step-badge--active {
  background: var(--surface);
  color: var(--accent);
  font-weight: 600;
  border: 1px solid var(--accent);
}

.step-arrow {
  color: var(--text-muted);
}

/* 锁定横幅 */
.modal-locked-banner {
  display: flex;
  gap: 12px;
  padding: 14px;
  background: var(--surface-sunken);
  border: 1px solid var(--warn, #e6a23c);
  border-radius: var(--radius-control);
}

.warn-icon {
  color: var(--warn, #e6a23c);
  flex-shrink: 0;
}

.locked-text h4 {
  margin: 0 0 6px;
  font-size: 14px;
  color: var(--text);
}

.locked-text p {
  margin: 0 0 4px;
  font-size: 12.5px;
  line-height: 1.4;
}

.locked-sub {
  color: var(--text-muted);
}

.locked-actions {
  margin-top: 10px;
}

/* 准备前表单 */
.prepare-intro {
  padding: 12px 14px;
  background: var(--surface-sunken);
  border-radius: var(--radius-control);
}

.intro-title {
  font-weight: 600;
  font-size: 13.5px;
  margin: 0 0 4px;
}

.intro-desc {
  font-size: 12.5px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.4;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-title {
  font-size: 13px;
  font-weight: 600;
}

/* 经纬度推荐卡片 */
.coordinates-card {
  padding: 12px 14px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.coordinates-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.badge-tag {
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: 600;
}

.coordinates-input-row {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.address-details-box {
  border: 1px dashed var(--border);
  border-radius: var(--radius-control);
  padding: 10px 14px;
  background: var(--surface);
}

.details-summary {
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-muted);
}

.address-input-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
  margin-top: 10px;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.flex-1 {
  flex: 1 1 200px;
}

.form-label {
  font-size: 12px;
  font-weight: 600;
}

.sub-label {
  font-size: 11.5px;
  color: var(--text-muted);
  margin-bottom: 2px;
}

.label-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.char-count {
  font-size: 11px;
  color: var(--text-muted);
}

.char-count--overflow {
  color: var(--danger, #f56c6c);
  font-weight: 600;
}

.field-error-hint {
  font-size: 11.5px;
  color: var(--danger, #f56c6c);
  margin: 4px 0 0;
  line-height: 1.4;
  font-weight: 500;
}

.input-text--error {
  border-color: var(--danger, #f56c6c) !important;
}

.field-hint {
  font-size: 11.5px;
  color: var(--text-muted);
  margin: 2px 0 0;
  line-height: 1.4;
}

.input-text,
.input-textarea,
.input-select {
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-control);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  box-sizing: border-box;
}

.input-readonly {
  background: var(--surface-sunken);
  color: var(--text-muted);
  cursor: default;
}

.input-textarea {
  resize: vertical;
}

.qr-gate-box,
.submit-gates-card {
  padding: 12px 14px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.checkbox-label {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
  font-size: 12.5px;
  line-height: 1.4;
}

.checkbox-label input {
  margin-top: 3px;
}

/* 草稿审核编辑网格 */
.draft-edit-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

.col-full {
  grid-column: 1 / -1;
}

/* 规格项编辑 */
.specs-edit-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.spec-edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.spec-name-input {
  flex: 1 1 140px;
}

.spec-val-input {
  flex: 2 1 200px;
}

.empty-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.attribute-cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.attribute-item {
  display: flex;
  flex-direction: column;
}

/* 图片管理卡片 */
.image-manage-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 6px;
}

.image-manage-card {
  position: relative;
  width: 100px;
  height: 120px;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--surface);
}

.manage-thumb-img {
  width: 100px;
  height: 85px;
  object-fit: cover;
}

.cover-tag {
  position: absolute;
  top: 4px;
  left: 4px;
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
}

.image-actions {
  display: flex;
  justify-content: space-around;
  align-items: center;
  height: 35px;
  background: var(--surface-sunken);
  border-top: 1px solid var(--border);
}

.btn-icon {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  padding: 4px;
}

.btn-icon:hover:not(:disabled) {
  color: var(--text);
}

.btn-icon--danger:hover:not(:disabled) {
  color: var(--error, #f56c6c);
}

.btn-icon:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.services-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.service-check-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
}

/* 规格追加折叠与配送卡片 */
.specs-preview-details {
  margin-top: 6px;
  background: var(--surface-sunken);
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
}

.specs-preview-details summary {
  cursor: pointer;
  font-size: 11.5px;
  color: var(--text-muted);
}

.specs-preview-content {
  margin-top: 6px;
  padding: 6px 10px;
  background: var(--surface);
  border-radius: 4px;
  font-size: 12px;
  line-height: 1.5;
}

.specs-preview-header {
  margin: 0;
  font-weight: 600;
  color: var(--text-muted);
}

.specs-preview-line {
  margin: 0;
}

.delivery-status-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
}

.delivery-badge {
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  font-weight: 600;
  white-space: nowrap;
}

.delivery-desc {
  font-size: 12px;
  color: var(--text-muted);
}

.raw-payload-box summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
}

.json-code {
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  padding: 10px;
  border-radius: 6px;
  max-height: 200px;
  overflow: auto;
  font-size: 11px;
}

/* 加载动画 */
.preparing-loading-box {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  background: var(--surface-sunken);
  border-radius: var(--radius-control);
}

.loading-spinner {
  animation: spin 1s linear infinite;
  color: var(--accent);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.loading-text strong {
  display: block;
  font-size: 13px;
  margin-bottom: 2px;
}

.loading-text p {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

/* 成功与未知 */
.published-box,
.unknown-box,
.action-required-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 30px 20px;
  gap: 12px;
}

.action-desc {
  font-size: 13.5px;
  color: var(--text);
  max-width: 520px;
  margin: 0;
}

.action-hint {
  font-size: 12px;
  color: var(--text-muted);
  max-width: 520px;
  margin: 0;
  line-height: 1.5;
}

.success-icon {
  color: var(--ok, #67c23a);
}

.item-id-card {
  padding: 8px 16px;
  background: var(--surface-sunken);
  border-radius: var(--radius-control);
  border: 1px solid var(--border);
  font-size: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  word-break: break-all;
}

.item-id-card .item-link {
  color: var(--accent);
  text-decoration: underline;
  font-weight: 600;
}

.item-id-card code {
  font-weight: 700;
  color: var(--accent);
}

.unknown-desc {
  font-size: 13px;
  color: var(--text);
  max-width: 500px;
  margin: 0;
}

.unknown-action {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
}

/* 准备阶段专用卡片 */
.preparing-loading-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 40px 20px;
  gap: 16px;
  background: var(--surface-sunken);
  border-radius: var(--radius-control);
}

.preparing-loading-card .loading-text h4 {
  margin: 0 0 8px;
  font-size: 15px;
}

.preparing-loading-card .loading-text p {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted);
  max-width: 520px;
  line-height: 1.5;
}

.prepare-failed-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.failure-details {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
}

.failure-stage-text,
.missing-fields-text {
  margin: 0;
  color: var(--text);
}

.guide-text {
  margin: 4px 0 0;
  line-height: 1.5;
  color: var(--text-muted);
}

.partial-draft-preview {
  padding: 12px 14px;
  background: var(--surface-sunken);
  border-radius: var(--radius-control);
  border: 1px dashed var(--border);
}

.partial-preview-title {
  margin: 0 0 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-muted);
}

.partial-images-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  overflow-x: auto;
}

.mini-thumb {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid var(--border);
}

.partial-info-line {
  margin: 2px 0;
  font-size: 12px;
  color: var(--text);
}

.address-warn-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--surface-sunken);
  border: 1px solid var(--warn, #e6a23c);
  border-radius: 4px;
  color: var(--warn, #e6a23c);
  font-size: 12px;
  margin-bottom: 8px;
}

.address-tech-details {
  margin-top: 8px;
  background: var(--surface-sunken);
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
}

.tech-summary {
  cursor: pointer;
  font-size: 11.5px;
  color: var(--text-muted);
}

.tech-fields-row {
  display: flex;
  gap: 16px;
  margin-top: 8px;
  font-size: 12px;
}

.tech-item code {
  margin-left: 4px;
  padding: 2px 6px;
  background: var(--surface);
  border-radius: 4px;
  border: 1px solid var(--border);
  color: var(--text-muted);
}

/* 底部操作栏 */
.modal-footer-bar {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
</style>
