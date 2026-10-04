<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  PhArrowSquareOut,
  PhArrowsClockwise,
  PhCaretLeft,
  PhCaretRight,
  PhDownloadSimple,
  PhImage,
  PhMagnifyingGlass,
  PhPackage,
  PhPaperPlaneTilt,
  PhTable,
  PhUploadSimple,
  PhX,
} from '@phosphor-icons/vue'
import AppModal from '../components/AppModal.vue'
import Callout from '../components/Callout.vue'
import EmptyState from '../components/EmptyState.vue'
import PanelCard from '../components/PanelCard.vue'
import StatusTag from '../components/StatusTag.vue'
import { useBridgeController } from '../composables/useBridgeController'
import type { PageId } from '../data/navigation'
import { formatShortTime } from '../features/chat/chat-format'
import type { PublishDraft } from '../features/publish/publish-draft-store'
import { publishDraftStore } from '../features/publish/publish-draft-store'
import {
  FeishuWriteController,
  isFeishuPreviewExpired,
  type FeishuWriteState,
} from '../features/products/feishu-write-controller'
import { formatFeishuTypeName } from '../features/products/feishu-schema-controller'
import { PRODUCTS_EVENTS, ProductsController, type ProductsState } from '../features/products/products-controller'
import {
  PRODUCT_ORDER_OPTIONS,
  PRODUCT_PAGE_SIZES,
  buildProductsCsv,
  csvFileName,
  displayCaptureTime,
  displayPrice,
  pageInfo,
  productLink,
  type ProductTab,
  type ProductTableItem,
} from '../features/products/products-format'
import type { ProductOrder } from '../features/contracts'

const emit = defineEmits<{
  navigate: [page: PageId]
  publishItem: [draft: PublishDraft]
}>()

/** 缺值只说明本次数据未提供，不能据此断言该字段永远无法采集。 */
function missingFieldHint(product: ProductTableItem, field: string): string {
  return product.source === 'feishu_material'
    ? `飞书记录未提供${field}，请检查表格对应字段。`
    : `本次闲鱼数据未提供${field}，请查看详情补齐提示，或刷新重试。`
}

const { state, controller } = useBridgeController<ProductsState, ProductsController>({
  events: PRODUCTS_EVENTS,
  create: (api) => new ProductsController({ api }),
})

const { state: feishuState, controller: feishuController } = useBridgeController<
  FeishuWriteState,
  FeishuWriteController
>({
  events: [],
  timeoutMs: 30000,
  create: (api) => new FeishuWriteController({ api }),
})

const available = computed(() => state.value.availability === 'ready')
const currentTab = computed(() => state.value.tab)
const isFeishuTab = computed(() => state.value.tab === 'feishu')
const result = computed(() => state.value.result)
const query = computed(() => state.value.query)
const keywordInput = ref('')
const exportNote = ref('')
const showWritePanel = ref(false)
const failedCovers = ref(new Set<string>())

const tabFeishuRef = ref<HTMLButtonElement | null>(null)
const tabMyPublishedRef = ref<HTMLButtonElement | null>(null)

/** 组合 source + recordId/itemId + coverUrl 作为坏图 key，避免无 ID 或缺 ID 条目互相污染 */
function getCoverKey(product: ProductTableItem): string {
  const id = product.recordId || product.itemId || ''
  const src = product.source || currentTab.value
  return `${src}:${id}:${product.coverUrl || ''}`
}

function hideFailedCover(product: ProductTableItem): void {
  const key = getCoverKey(product)
  failedCovers.value = new Set([...failedCovers.value, key])
}

const paging = computed(() => pageInfo(result.value.total ?? 0, query.value.pageSize, query.value.page))
const busy = computed(() => result.value.phase === 'loading' || result.value.refreshing)
/** 当前列表是否与输入框 / 控件对应的查询不一致（上一次查询失败时会出现）。 */
const showingPrevious = computed(() => {
  const queried = result.value.queriedWith
  if (!queried || result.value.phase !== 'ready' || !result.value.error) return false
  return (
    queried.tab !== currentTab.value ||
    queried.query.keyword !== query.value.keyword ||
    queried.query.order !== query.value.order ||
    queried.query.pageSize !== query.value.pageSize ||
    queried.query.page !== query.value.page
  )
})

// ---------------- 飞书写入勾选与交互状态 ----------------
const selectedSet = computed(() => new Set(feishuState.value.selectedItemIds))
const selectedCount = computed(() => feishuState.value.selectedItemIds.length)

const currentPageItemIds = computed(() => result.value.items.map((p) => p.itemId))

const isPageAllSelected = computed(() => {
  const ids = currentPageItemIds.value
  return ids.length > 0 && ids.every((id) => selectedSet.value.has(id))
})

const isPagePartialSelected = computed(() => {
  const ids = currentPageItemIds.value
  const count = ids.filter((id) => selectedSet.value.has(id)).length
  return count > 0 && count < ids.length
})

/** 用户显式确认复选框。一旦选品发生变化或非 ready 状态，立即重置为 false。 */
const userConfirmed = ref(false)
/** 是否展开待写入清单的全部条目。 */
const showAllPreviewItems = ref(false)

// 当选品发生变动时，重置用户显式确认勾选框
watch(
  () => feishuState.value.selectedItemIds,
  () => {
    userConfirmed.value = false
    showAllPreviewItems.value = false
  },
)

// 当 preview 状态离开 ready 时重置确认
watch(
  () => feishuState.value.preview.phase,
  (phase) => {
    if (phase !== 'ready') {
      userConfirmed.value = false
    }
  },
)

const previewBusy = computed(() => feishuState.value.preview.phase === 'loading')
const executeBusy = computed(() => feishuState.value.execute.phase === 'loading')
const previewResult = computed(() => feishuState.value.preview.result)
const executeResult = computed(() => feishuState.value.execute.result)

/** 响应式时间刻度，用于驱动 isPreviewExpired 在到期时自动响应式触发更新。 */
const nowTick = ref(Date.now())
let nowTickTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  nowTickTimer = setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (nowTickTimer) {
    clearInterval(nowTickTimer)
    nowTickTimer = null
  }
})

const isPreviewExpired = computed(() => {
  const pr = previewResult.value
  if (!pr) return false
  return isFeishuPreviewExpired(pr.expiresAt, nowTick.value)
})

const hasFieldIncompatibility = computed(() => {
  const pr = previewResult.value
  if (!pr) return false
  return !pr.fieldCompatible || (pr.missingFields?.length ?? 0) > 0 || (pr.typeConflicts?.length ?? 0) > 0
})

const canExecute = computed(() => {
  const pr = previewResult.value
  return (
    feishuState.value.preview.phase === 'ready' &&
    pr !== null &&
    !hasFieldIncompatibility.value &&
    pr.toCreate.length > 0 &&
    !isPreviewExpired.value &&
    userConfirmed.value &&
    !executeBusy.value
  )
})

function toggleItemSelect(itemId: string): void {
  feishuController.toggle(itemId)
}

function toggleSelectPage(): void {
  if (isPageAllSelected.value) {
    feishuController.deselectMultiple(currentPageItemIds.value)
  } else {
    feishuController.selectMultiple(currentPageItemIds.value)
  }
}

function clearSelection(): void {
  feishuController.clearSelection()
}

/** 写入后台真实执行中（禁止切 tab，避免假取消真实 write）。 */
const isExecuting = computed(() => executeBusy.value)

/** 切换商品库菜单 Tab。 */
function onTabChange(tab: ProductTab): void {
  if (isExecuting.value) return
  if (tab === state.value.tab) return
  // 切 Tab 必须清空已选商品、清空写入预览与执行、作废 controller 预览、关闭弹窗、重置确认标记，杜绝竞态与自动写入
  clearSelection()
  feishuController.invalidatePreview()
  feishuController.resetExecute()
  showWritePanel.value = false
  userConfirmed.value = false
  exportNote.value = ''
  keywordInput.value = '' // 切Tab同步清空输入框，保持与 controller.query 同步
  void controller.setTab(tab)
}

/** WAI-ARIA Accessible Tabs 键盘漫游导航（ArrowLeft / ArrowRight / Home / End）。 */
function onTabKeydown(event: KeyboardEvent, current: ProductTab): void {
  if (isExecuting.value) return
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault()
    const targetTab: ProductTab = current === 'feishu' ? 'my_published' : 'feishu'
    onTabChange(targetTab)
    if (targetTab === 'feishu') {
      tabFeishuRef.value?.focus()
    } else {
      tabMyPublishedRef.value?.focus()
    }
  } else if (event.key === 'Home') {
    event.preventDefault()
    onTabChange('feishu')
    tabFeishuRef.value?.focus()
  } else if (event.key === 'End') {
    event.preventDefault()
    onTabChange('my_published')
    tabMyPublishedRef.value?.focus()
  }
}

function submitSearch(): void {
  exportNote.value = ''
  void controller.search(keywordInput.value)
}

function clearSearch(): void {
  keywordInput.value = ''
  submitSearch()
}

/**
 * 点击商品行“发布”按钮：
 * 仅导航至发布中心并传递选中的记录（精确携带 recordId/targetTableId 或真实 itemId），
 * 绝不自动调用 PUBLISH_CREATE、PUBLISH_FILL_FORM 或 PUBLISH_SUBMIT！
 */
function onPublishRow(product: ProductTableItem): void {
  const isFeishu = currentTab.value === 'feishu' || product.source === 'feishu_material'
  const draft: PublishDraft = {
    source: isFeishu ? 'feishu' : 'my_published',
    recordId: (product as any).recordId || undefined,
    targetTableId: product.targetTableId || result.value.targetTableId || undefined,
    itemId: product.itemId || undefined,
    title: product.title || '',
    desc: (product as any).desc || (product as any).description || '',
    price: product.priceNumber || 0,
    originalPrice: product.originalPriceNumber || 0,
    coverUrl: product.coverUrl || '',
    imageUrls: product.coverUrl ? [product.coverUrl] : [],
  }
  publishDraftStore.setDraft(draft)
  emit('publishItem', draft)
  emit('navigate', 'publish')
}

function onRefreshProducts(): void {
  void controller.refresh()
}

function onOrder(event: Event): void {
  void controller.setOrder((event.target as HTMLSelectElement).value as ProductOrder)
}

function onPageSize(event: Event): void {
  void controller.setPageSize(Number((event.target as HTMLSelectElement).value))
}

/** 只导出当前页已经查询到的商品；不会再向后台请求、也不会补全其它页。 */
function exportCsv(): void {
  const items = result.value.items
  if (result.value.phase !== 'ready' || items.length === 0) return
  const blob = new Blob([buildProductsCsv(items)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = csvFileName(Date.now())
  document.body.appendChild(link)
  link.click()
  link.remove()
  // 延后释放，保证浏览器已经开始下载。
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  if (isFeishuTab.value) {
    exportNote.value = `已导出当前页 ${items.length} 条飞书采集商品${typeof result.value.total === 'number' ? `（已加载共 ${result.value.total} 件）` : ''}。`
  } else {
    exportNote.value = `已导出当前页 ${items.length} 条发布商品（商品库共 ${result.value.total ?? items.length} 件，未导出的部分需翻页后分别导出）。`
  }
}

function handlePreview(): void {
  showWritePanel.value = true
  userConfirmed.value = false
  void feishuController.preview()
}

async function handleExecute(): Promise<void> {
  if (!canExecute.value) return
  await feishuController.execute({ confirm: true })
}

function navigateToSettings(): void {
  showWritePanel.value = false
  emit('navigate', 'settings')
}

/** 格式化商品标题：最多 40 字 */
function formatProductTitle(title?: string): string {
  if (!title) return '（无标题）'
  return title.length > 40 ? `${title.slice(0, 40)}…` : title
}

/** 获取商品描述原文 */
function getProductDesc(product: ProductTableItem): string {
  return (product as any).desc || (product as any).description || ''
}

/** 格式化商品描述：最多 80 字，缺失时必须显示「暂无描述」 */
function formatProductDesc(desc: string): string {
  const trimmed = desc?.trim()
  if (!trimmed) return '暂无描述'
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed
}
</script>

<template>
  <div class="page">
    <Callout v-if="state.hasNewCapture" tone="info">
      <template #default>后台任务有新的进展，当前账号商品目录可能已更新。</template>
      <template #actions>
        <button type="button" class="btn btn--sm btn--primary" :disabled="busy" @click="controller.refresh()">刷新商品目录</button>
      </template>
    </Callout>

    <PanelCard flush>
      <!-- 恰好两个菜单 Tab：默认「飞书采集的商品库」，第二「自己发布的商品库」 -->
      <nav class="tabs-nav" role="tablist" aria-label="商品库来源分类">
        <button
          id="tab-feishu"
          ref="tabFeishuRef"
          type="button"
          role="tab"
          class="tab-btn"
          :class="{ 'tab-btn--active': currentTab === 'feishu' }"
          :aria-selected="currentTab === 'feishu'"
          aria-controls="panel-products"
          :tabindex="currentTab === 'feishu' ? 0 : -1"
          :disabled="isExecuting"
          @click="onTabChange('feishu')"
          @keydown="onTabKeydown($event, 'feishu')"
        >
          <PhTable :size="18" class="tab-btn__icon" />
          <span class="tab-btn__text">飞书采集的商品库</span>
          <span
            v-if="currentTab === 'feishu' && result.phase === 'ready' && typeof result.total === 'number'"
            class="tab-btn__badge"
          >
            {{ result.total }}
          </span>
        </button>
        <button
          id="tab-my_published"
          ref="tabMyPublishedRef"
          type="button"
          role="tab"
          class="tab-btn"
          :class="{ 'tab-btn--active': currentTab === 'my_published' }"
          :aria-selected="currentTab === 'my_published'"
          aria-controls="panel-products"
          :tabindex="currentTab === 'my_published' ? 0 : -1"
          :disabled="isExecuting"
          @click="onTabChange('my_published')"
          @keydown="onTabKeydown($event, 'my_published')"
        >
          <PhPackage :size="18" class="tab-btn__icon" />
          <span class="tab-btn__text">自己发布的商品库</span>
          <span
            v-if="currentTab === 'my_published' && result.phase === 'ready' && typeof result.total === 'number'"
            class="tab-btn__badge"
          >
            {{ result.total }}
          </span>
        </button>
      </nav>

      <div
        id="panel-products"
        role="tabpanel"
        :aria-labelledby="currentTab === 'feishu' ? 'tab-feishu' : 'tab-my_published'"
        class="tab-panel"
        tabindex="0"
      >
        <p v-if="isFeishuTab" class="muted">北京时间今天和昨天的全部采集记录，同一商品可显示多条。</p>
        <form class="toolbar" role="search" @submit.prevent="submitSearch">
          <div class="toolbar__search">
            <label class="sr-only" for="products-keyword">{{ isFeishuTab ? '按采集关键字、标题或商品 ID 搜索' : '按标题或商品 ID 搜索' }}</label>
            <input
              id="products-keyword"
              v-model="keywordInput"
              class="input"
              type="search"
              autocomplete="off"
              :placeholder="isFeishuTab ? '搜索采集关键字、商品标题或 ID，回车确认' : '搜索已发布标题或 ID，回车确认'"
              :disabled="!available"
            />
          </div>
          <button type="submit" class="btn btn--sm btn--icon" aria-label="搜索商品" title="搜索" :disabled="!available || busy"><PhMagnifyingGlass :size="18" /></button>
          <button v-if="query.keyword" type="button" class="btn btn--sm btn--ghost btn--icon" aria-label="清除搜索" title="清除搜索" :disabled="busy" @click="clearSearch"><PhX :size="18" /></button>

          <label class="toolbar__select">
            <span class="sr-only">排序方式</span>
            <select class="input" :value="query.order" :disabled="!available" @change="onOrder">
              <option v-for="option in PRODUCT_ORDER_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <span class="toolbar__spacer"></span>
          <button type="button" class="btn btn--sm btn--icon" aria-label="刷新商品列表" :title="result.refreshing ? '刷新中…' : '刷新'" :disabled="!available || busy" @click="onRefreshProducts">
            <PhArrowsClockwise :size="18" />
          </button>
          <button
            type="button"
            class="btn btn--sm"
            :disabled="result.phase !== 'ready' || result.items.length === 0"
            title="仅导出当前页已查询到的商品"
            @click="exportCsv"
          >
            <PhDownloadSimple :size="18" /> 导出本页
          </button>
        </form>

        <!-- 飞书写入选品操作条（只在自己发布的商品库勾选时展示，飞书商品已在表中严禁重复写入） -->
        <section v-if="!isFeishuTab && selectedCount > 0" class="feishu-bar" aria-label="飞书写入选品操作">
          <div class="feishu-bar__info">
            <span class="feishu-bar__badge">
              已勾选 <strong>{{ selectedCount }}</strong> / 200 件商品
            </span>
            <span v-if="feishuState.warningMessage" class="feishu-bar__warn" role="alert">
              {{ feishuState.warningMessage }}
            </span>
          </div>
          <div class="feishu-bar__actions">
            <button
              type="button"
              class="btn btn--sm btn--ghost"
              :disabled="!available || previewBusy || executeBusy"
              @click="toggleSelectPage"
            >
              {{ isPageAllSelected ? '取消全选本页' : '全选本页' }}
            </button>
            <button
              type="button"
              class="btn btn--sm btn--ghost"
              :disabled="!available || previewBusy || executeBusy"
              @click="clearSelection"
            >
              清空选择
            </button>
            <button
              type="button"
              class="btn btn--sm btn--primary"
              :disabled="!available || selectedCount === 0 || previewBusy || executeBusy"
              @click="handlePreview"
            >
              <PhUploadSimple :size="18" /> {{ previewBusy ? '正在生成预览…' : '写入飞书' }}
            </button>
            <button v-if="feishuState.preview.phase !== 'idle' || feishuState.execute.phase !== 'idle'" type="button" class="btn btn--sm" @click="showWritePanel = true">查看写入结果</button>
          </div>
        </section>

        <!-- 飞书写入预览与确认区域 -->
        <AppModal :open="showWritePanel" title="写入飞书商品表" wide :busy="previewBusy || executeBusy" @close="showWritePanel = false">
          <section class="feishu-panel" aria-live="polite">
            <!-- 预览加载中 -->
            <div v-if="feishuState.preview.phase === 'loading'" class="feishu-loading">
              <div class="skeleton__row" style="width: 60%"></div>
              <p class="muted">正在读取飞书商品表配置、字段结构与已有记录，进行只读比对（绝不写入）…</p>
            </div>

            <!-- 预览报错 -->
            <div v-else-if="feishuState.preview.phase === 'error'" class="feishu-error">
              <Callout tone="error" :view="feishuState.preview.error">
                <template #actions>
                  <button
                    v-if="feishuState.isConfigMissing"
                    type="button"
                    class="btn btn--sm btn--primary"
                    @click="navigateToSettings"
                  >
                    前往设置页配置飞书
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm"
                    :disabled="previewBusy"
                    @click="handlePreview"
                  >
                    重试预览
                  </button>
                </template>
              </Callout>
            </div>

            <!-- 预览成功：展示核对面板与显式确认区 -->
            <div v-else-if="feishuState.preview.phase === 'ready' && previewResult" class="feishu-preview">
              <div class="feishu-preview__header">
                <div>
                  <h3 class="feishu-preview__title">核对待写入商品</h3>
                  <p class="feishu-preview__desc">
                    目标商品表：<code>{{ previewResult.targetTableId }}</code>
                    <span v-if="previewResult.previewId">
                      · 预览 ID：<code>{{ previewResult.previewId }}</code>
                    </span>
                    <span v-if="feishuState.preview.previewedAt">
                      · 预览于 {{ formatShortTime(feishuState.preview.previewedAt) }}
                    </span>
                  </p>
                </div>
                <div class="feishu-header-actions">
                  <StatusTag v-if="!hasFieldIncompatibility && !isPreviewExpired" tone="ok">字段完全兼容</StatusTag>
                  <StatusTag v-else-if="isPreviewExpired" tone="warn">预览已过期</StatusTag>
                  <StatusTag v-else tone="error">字段不兼容</StatusTag>
                  <button type="button" class="btn btn--sm" :disabled="previewBusy || executeBusy" @click="handlePreview"><PhArrowsClockwise :size="18" /> 重新生成预览</button>
                </div>
              </div>

              <!-- 预览已过期提示 -->
              <div v-if="isPreviewExpired" class="feishu-preview__field-alert">
                <Callout tone="warn" title="写入预览已过期">
                  <template #default>
                    本次预览已超过有效期限（5 分钟）。为了保证飞书目标表与去重数据绝对准确，<strong>已作废旧预览并禁止继续执行</strong>。请重新点击「重新生成预览」核对。
                  </template>
                  <template #actions>
                    <button type="button" class="btn btn--sm btn--primary" :disabled="previewBusy" @click="handlePreview">
                      重新生成预览
                    </button>
                  </template>
                </Callout>
              </div>

              <!-- 字段不兼容警告：缺失字段 或 字段类型冲突（禁止自动创建修改字段） -->
              <div v-if="hasFieldIncompatibility" class="feishu-preview__field-alert">
                <Callout tone="error" title="飞书目标表字段不兼容（已禁止写入）">
                  <template #default>
                    <div class="field-issues">
                      <div v-if="previewResult.missingFields.length > 0" class="field-issue">
                        <strong>缺失必需字段：</strong>{{ previewResult.missingFields.join('、') }}
                      </div>
                      <div v-if="previewResult.typeConflicts.length > 0" class="field-issue">
                        <strong>字段类型冲突：</strong>
                        <ul class="conflict-list">
                          <li v-for="conflict in previewResult.typeConflicts" :key="conflict.name">
                            「{{ conflict.name }}」：期望类型为 <strong>{{ formatFeishuTypeName(conflict.expectedType) }}</strong>，飞书表中实际为 <strong>{{ formatFeishuTypeName(conflict.actualType) }}</strong>
                          </li>
                        </ul>
                      </div>
                      <p class="field-issue__notice">
                        根据安全规范，<strong>系统严禁自动创建或修改飞书表格字段</strong>。请前往飞书多维表格手动调整或添加对应字段后重新生成预览。
                      </p>
                    </div>
                  </template>
                </Callout>
              </div>

              <!-- 数据比对栅格看板 -->
              <div class="metric-grid">
                <div class="metric-item">
                  <span class="metric-label">勾选请求</span>
                  <strong class="metric-value">{{ previewResult.requestedCount }}</strong>
                </div>
                <div class="metric-item">
                  <span class="metric-label">唯一有效</span>
                  <strong class="metric-value">{{ previewResult.uniqueCount }}</strong>
                  <small v-if="previewResult.duplicateItemIds.length > 0" class="metric-sub">
                    去重 {{ previewResult.duplicateItemIds.length }}
                  </small>
                </div>
                <div class="metric-item">
                  <span class="metric-label">飞书已有(跳过)</span>
                  <strong class="metric-value">{{ previewResult.alreadyExistsItemIds.length }}</strong>
                </div>
                <div class="metric-item">
                  <span class="metric-label">本地缺失</span>
                  <strong class="metric-value">{{ previewResult.missingItemIds.length }}</strong>
                </div>
                <div class="metric-item metric-item--accent">
                  <span class="metric-label">待写入记录</span>
                  <strong class="metric-value">{{ previewResult.toCreate.length }}</strong>
                </div>
              </div>

              <!-- 待写入清单预览 -->
              <div v-if="previewResult.toCreate.length > 0" class="preview-list-wrap">
                <div class="preview-list-header">
                  <span>待写入商品清单预览（共 {{ previewResult.toCreate.length }} 件）</span>
                  <button
                    v-if="previewResult.toCreate.length > 5"
                    type="button"
                    class="btn btn--sm btn--ghost"
                    @click="showAllPreviewItems = !showAllPreviewItems"
                  >
                    {{ showAllPreviewItems ? '收起部分' : `展开全部 (${previewResult.toCreate.length})` }}
                  </button>
                </div>
                <ul class="preview-list">
                  <li
                    v-for="item in showAllPreviewItems ? previewResult.toCreate : previewResult.toCreate.slice(0, 5)"
                    :key="item.itemId"
                    class="preview-list-item"
                  >
                    <div class="preview-list-item__main">
                      <span class="preview-list-item__title">{{ item.title || '（无标题）' }}</span>
                      <span class="preview-list-item__id">{{ item.itemId }}</span>
                    </div>
                    <div class="preview-list-item__meta">
                      <span class="num">¥{{ item.price }}</span>
                      <span class="muted">{{ item.wantCnt }} 想要</span>
                    </div>
                  </li>
                </ul>
              </div>

              <!-- 待写入条数为 0 时的说明 -->
              <div v-else class="feishu-empty-notice">
                <Callout tone="info">
                  选中的商品在飞书表中均已存在（按商品 ID、想要数、价格组合键比对），无需重复写入。
                </Callout>
              </div>

              <!-- 显式确认与执行操作区 -->
              <div class="feishu-confirm-box">
                <div class="feishu-confirm-box__left">
                  <label v-if="!hasFieldIncompatibility && !isPreviewExpired && previewResult.toCreate.length > 0" class="confirm-check">
                    <input
                      v-model="userConfirmed"
                      type="checkbox"
                      :disabled="executeBusy"
                    />
                    <span>我已核对上述待写入列表，确认向飞书商品表创建 <strong>{{ previewResult.toCreate.length }}</strong> 条记录</span>
                  </label>
                  <span v-else-if="isPreviewExpired" class="text-error">
                    预览已过期，请重新点击上方「重新生成预览」。
                  </span>
                  <span v-else-if="hasFieldIncompatibility" class="text-error">
                    字段不兼容或类型冲突，必须先在飞书表格中调整字段，无法执行写入。
                  </span>
                  <span v-else class="text-muted">
                    当前无可写入记录。
                  </span>
                </div>
                <div class="feishu-confirm-box__right">
                  <button
                    type="button"
                    class="btn btn--primary"
                    :disabled="!canExecute"
                    @click="handleExecute"
                  >
                    <PhUploadSimple :size="18" />
                    {{ executeBusy ? '正在写入飞书…' : `确认执行写入飞书 (${previewResult.toCreate.length})` }}
                  </button>
                </div>
              </div>
            </div>

            <!-- 执行成功报告 -->
            <div v-if="feishuState.execute.phase === 'ready' && executeResult" class="feishu-result">
              <Callout tone="ok" title="飞书写入成功（已禁止重放）">
                <template #default>
                  已在目标表（<code>{{ executeResult.targetTableId }}</code>）创建 <strong>{{ executeResult.createdCount }}</strong> 条商品记录。
                  <span v-if="executeResult.alreadyExistsItemIds.length > 0">
                    （跳过表中已有 {{ executeResult.alreadyExistsItemIds.length }} 条）
                  </span>
                </template>
                <template #actions>
                  <button type="button" class="btn btn--sm" @click="clearSelection">清空已选商品</button>
                  <button type="button" class="btn btn--sm btn--ghost" @click="feishuController.resetExecute()">关闭提示</button>
                </template>
              </Callout>
            </div>

            <!-- 执行失败报告：突出实际风险、作废原预览与严禁自动重试 -->
            <div v-if="feishuState.execute.phase === 'error'" class="feishu-result">
              <Callout tone="error" :view="feishuState.execute.error">
                <template #actions>
                  <button
                    v-if="feishuState.isConfigMissing"
                    type="button"
                    class="btn btn--sm btn--primary"
                    @click="navigateToSettings"
                  >
                    前往设置页配置飞书
                  </button>
                  <button type="button" class="btn btn--sm btn--ghost" @click="feishuController.resetExecute()">
                    关闭错误提示
                  </button>
                </template>
              </Callout>
              <div v-if="feishuState.execute.riskNotice" class="feishu-risk">
                <Callout tone="warn" title="实际风险提示（严禁自动重试 · 本次预览已作废）">
                  <template #default>
                    {{ feishuState.execute.riskNotice }}
                  </template>
                </Callout>
              </div>
            </div>
          </section>
        </AppModal>

        <!-- 导出说明提示 -->
        <div v-if="exportNote" class="note"><Callout tone="ok">{{ exportNote }}</Callout></div>

        <!-- 非致命详情补充告警/提示（warnings） -->
        <div v-if="result.warnings && result.warnings.length > 0" class="note">
          <Callout tone="warn" title="商品详情提示">
            <template #default>
              <ul class="warning-list">
                <li v-for="(warn, idx) in result.warnings" :key="idx">{{ warn }}</li>
              </ul>
            </template>
          </Callout>
        </div>

        <!-- 异常/加载/空状态呈现 -->
        <div v-if="!available" class="blank">
          <EmptyState mark="品" title="未连接扩展" description="商品数据由扩展运行时负责同步与管理，需要在扩展内页打开工作台才能读取。" />
        </div>

        <!-- 未配置飞书引导（只在飞书 Tab 且明确检测到配置缺失时呈现） -->
        <div v-else-if="isFeishuTab && state.isConfigMissing" class="blank">
          <Callout tone="error" title="飞书商品表尚未配置完整">
            <template #default>
              飞书多维表格数据源尚未配置完整（缺少 App ID、Secret、Spreadsheet Token 或商品表 Table ID），无法直接读取飞书采集的商品库。
            </template>
            <template #actions>
              <button type="button" class="btn btn--primary" @click="navigateToSettings">前往设置页配置飞书</button>
            </template>
          </Callout>
        </div>

        <!-- 加载中状态骨架屏 -->
        <div v-else-if="result.phase === 'idle' || result.phase === 'loading'" class="blank" role="status">
          <div class="skeleton" aria-hidden="true">
            <span v-for="n in 5" :key="n" class="skeleton__row"></span>
          </div>
          <p class="muted">{{ isFeishuTab ? '正在读取飞书多维表格商品数据…' : '正在读取当前账号已发布商品…' }}</p>
        </div>

        <!-- 首次/全量查询失败（Phase 为 error，决不伪装成暂无商品） -->
        <div v-else-if="result.phase === 'error'" class="blank">
          <Callout tone="error" :view="result.error">
            <template #actions>
              <button type="button" class="btn btn--sm btn--primary" :disabled="busy" @click="controller.refresh()">重试</button>
              <button v-if="state.isConfigMissing" type="button" class="btn btn--sm" @click="navigateToSettings">前往设置页配置飞书</button>
            </template>
          </Callout>
        </div>

        <!-- 查询发生错误且暂无可用数据（决不能落入 EmptyState 伪装成暂无商品） -->
        <div v-else-if="result.error && result.items.length === 0" class="blank">
          <Callout tone="error" :view="result.error">
            <template #actions>
              <button type="button" class="btn btn--sm btn--primary" :disabled="busy" @click="controller.refresh()">重试</button>
              <button v-if="state.isConfigMissing" type="button" class="btn btn--sm" @click="navigateToSettings">前往设置页配置飞书</button>
            </template>
          </Callout>
        </div>

        <!-- 真正的空状态（仅在查询成功无错但结果确实为空时展示） -->
        <div v-else-if="result.items.length === 0" class="blank">
          <!-- 搜索无结果 -->
          <EmptyState
            v-if="result.queriedWith?.query.keyword"
            mark="品"
            :title="isFeishuTab ? '飞书商品表中没有符合条件的记录' : '没有符合条件的已发布商品'"
            :description="isFeishuTab
              ? `近两天没有采集关键字、标题或 ID 包含「${result.queriedWith.query.keyword}」的记录。`
              : `当前账号已发布商品中没有标题或 ID 包含「${result.queriedWith.query.keyword}」的商品。`"
          >
            <button type="button" class="btn" @click="clearSearch">清除搜索</button>
          </EmptyState>

          <!-- 飞书 Tab 空态 -->
          <EmptyState
            v-else-if="isFeishuTab"
            mark="飞"
            title="飞书商品表暂无记录"
            description="今天和昨天的每日表中暂无采集记录。您可在采集中心发起搜索采集，同步时会自动创建每日表。"
          >
            <button type="button" class="btn btn--primary" @click="emit('navigate', 'collect')">前往采集中心</button>
            <button type="button" class="btn" @click="navigateToSettings">检查飞书配置</button>
          </EmptyState>

          <!-- 自己发布 Tab 空态 -->
          <EmptyState
            v-else
            mark="品"
            title="当前账号暂无发布商品"
            description="本地商品目录仅收录当前登录账号已发布的商品。市场搜索采集的竞品不会冒充为已发布商品；您可在发布中心发布商品。"
          >
            <button type="button" class="btn btn--primary" @click="emit('navigate', 'publish')">去发布商品</button>
          </EmptyState>
        </div>

        <!-- 正常商品列表展示 -->
        <template v-else>
          <!-- 已有数据时若刷新发生错误，以警告条清晰提示，保留旧数据不白屏，同时决不伪装成暂无商品 -->
          <div v-if="result.error && result.phase === 'ready'" class="note">
            <Callout tone="warn" :view="result.error">
              <template #actions>
                <button type="button" class="btn btn--sm btn--primary" :disabled="busy" @click="controller.refresh()">重试</button>
                <button v-if="state.isConfigMissing" type="button" class="btn btn--sm" @click="navigateToSettings">前往设置</button>
              </template>
            </Callout>
            <p v-if="showingPrevious" class="note__text">下方仍是上一次成功查询的结果，与当前筛选条件不一定一致。</p>
          </div>

          <div class="table-wrap" tabindex="0" role="region" aria-label="商品列表，可横向滚动">
            <table class="table">
              <caption class="sr-only">
                商品列表，当前显示第 {{ paging.from }} 到 {{ paging.to }} 条
                <template v-if="typeof result.total === 'number'">，共 {{ result.total }} 件</template>
              </caption>
              <thead>
                <tr>
                  <!-- 飞书数据已在飞书多维表中，严禁提供重复写入操作；仅自己发布库展示勾选列 -->
                  <th v-if="!isFeishuTab" scope="col" class="cell-check">
                    <span class="sr-only">全选当前页</span>
                    <input
                      type="checkbox"
                      :checked="isPageAllSelected"
                      :indeterminate="isPagePartialSelected"
                      :disabled="!available || result.items.length === 0"
                      aria-label="全选当前页商品"
                      @change="toggleSelectPage"
                    />
                  </th>
                  <th scope="col" class="cell-title-head">商品</th>
                  <th scope="col" class="cell-id-head">商品 ID</th>
                  <th v-if="isFeishuTab" scope="col">关键字</th>
                  <th scope="col" class="num">价格</th>
                  <th scope="col" class="num">想要</th>
                  <th scope="col" class="cell-seller-head">卖家</th>
                  <th scope="col" class="cell-city-head">地区</th>
                  <th scope="col">包邮</th>
                  <th scope="col">采集时间</th>
                  <th scope="col">链接</th>
                  <th scope="col" class="cell-action">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="product in result.items"
                  :key="product.recordId ? `${product.targetTableId || ''}:${product.recordId}` : product.itemId"
                  :class="{ 'tr--selected': selectedSet.has(product.itemId) }"
                >
                  <td v-if="!isFeishuTab" class="cell-check">
                    <input
                      type="checkbox"
                      :checked="selectedSet.has(product.itemId)"
                      :disabled="!available"
                      :aria-label="`勾选商品 ${product.title || product.itemId}`"
                      @change="toggleItemSelect(product.itemId)"
                    />
                  </td>
                  <td class="cell-title">
                    <div class="product-summary">
                      <img
                        v-if="product.coverUrl && !failedCovers.has(getCoverKey(product))"
                        class="product-cover"
                        :src="product.coverUrl"
                        :alt="product.title || '商品图片'"
                        loading="lazy"
                        referrerpolicy="no-referrer"
                        @error="hideFailedCover(product)"
                      />
                      <span v-else class="product-cover product-cover--empty" aria-hidden="true">
                        <PhImage :size="28" />
                      </span>
                      <div class="product-copy">
                        <div class="product-title" :title="product.title || '（无标题）'">
                          {{ formatProductTitle(product.title) }}
                        </div>
                        <div
                          class="product-desc"
                          :class="{ 'product-desc--empty': !getProductDesc(product)?.trim() }"
                          :title="getProductDesc(product)?.trim() || '暂无描述'"
                        >
                          {{ formatProductDesc(getProductDesc(product)) }}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td class="cell-id" :title="product.itemId || product.recordId || ''">
                    <span class="id-text">
                      <template v-if="product.itemId">{{ product.itemId }}</template>
                      <template v-else-if="product.recordId">Record: {{ product.recordId }}</template>
                      <template v-else>—</template>
                    </span>
                  </td>
                  <td v-if="isFeishuTab" class="cell-ellipsis nowrap" :title="product.captureKeyword || ''">{{ product.captureKeyword || '未提供' }}</td>
                  <td class="num">{{ displayPrice(product) }}</td>
                  <td class="num">{{ product.wantCnt }}</td>
                  <td class="cell-ellipsis cell-seller" :title="product.sellerNick || missingFieldHint(product, '卖家昵称')">
                    {{ product.sellerNick || '未提供' }}
                  </td>
                  <td class="cell-ellipsis cell-city" :title="product.sellerCity || missingFieldHint(product, '地区')">
                    {{ product.sellerCity || '未提供' }}
                  </td>
                  <td>
                    <StatusTag v-if="product.freeShip === '是'" tone="ok">包邮</StatusTag>
                    <span v-else-if="product.freeShip === '否'" class="muted">否</span>
                    <span v-else class="muted nowrap" :title="missingFieldHint(product, '包邮信息')">未提供</span>
                  </td>
                  <td class="nowrap" :title="displayCaptureTime(product) || missingFieldHint(product, '采集时间')">{{ displayCaptureTime(product) || '未提供' }}</td>
                  <td>
                    <a
                      v-if="productLink(product)"
                      class="open"
                      :aria-label="`打开商品 ${product.title || product.itemId}`"
                      title="在新标签页打开商品"
                      :href="productLink(product) ?? undefined"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <PhArrowSquareOut :size="18" />
                    </a>
                    <span v-else class="muted">无可用链接</span>
                  </td>
                  <td class="cell-action">
                    <button
                      type="button"
                      class="btn btn--sm btn--primary publish-action-btn"
                      title="前往发布中心并载入该商品进行编辑与发布"
                      :aria-label="`发布商品 ${product.title || product.itemId}`"
                      @click="onPublishRow(product)"
                    >
                      <PhPaperPlaneTilt :size="14" aria-hidden="true" />
                      <span>发布</span>
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <nav class="pager" aria-label="商品库分页">
            <span class="pager__total">
              <template v-if="typeof result.total === 'number'">
                共 {{ result.total }} 件商品
              </template>
              <template v-else>
                第 {{ query.page + 1 }} 页
              </template>
            </span>
            <label class="toolbar__size">
              <span class="sr-only">每页数量</span>
              <select class="input" :value="query.pageSize" :disabled="!available || busy" @change="onPageSize">
                <option v-for="size in PRODUCT_PAGE_SIZES" :key="size" :value="size">每页 {{ size }} 条</option>
              </select>
            </label>
            <button
              type="button"
              class="btn btn--sm btn--icon"
              aria-label="上一页"
              title="上一页"
              :disabled="busy || !state.canPrev"
              @click="controller.prevPage()"
            >
              <PhCaretLeft :size="18" />
            </button>
            <span class="pager__info">
              第 {{ query.page + 1 }} 页
              <template v-if="typeof result.total === 'number' && Number.isFinite(result.total)">
                / {{ Math.max(1, Math.ceil(result.total / query.pageSize)) }} 页
              </template>
            </span>
            <button
              type="button"
              class="btn btn--sm btn--icon"
              aria-label="下一页"
              title="下一页"
              :disabled="busy || !state.canNext"
              @click="controller.nextPage()"
            >
              <PhCaretRight :size="18" />
            </button>
          </nav>
        </template>
      </div><!-- end of #panel-products -->
    </PanelCard>
  </div>
</template>

<style scoped>
/* 双菜单 Tab 导航栏（无缝融入闲鱼黄设计系统） */
.tabs-nav {
  display: flex;
  align-items: stretch;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0 10px;
  gap: 4px;
}

.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px;
  font-size: 13.5px;
  font-weight: 550;
  color: var(--text-muted);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  position: relative;
  transition: color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
  user-select: none;
}

.tab-btn:hover:not(:disabled) {
  color: var(--text);
  background: var(--surface-sunken);
}

.tab-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.tab-btn--active {
  color: var(--text);
  font-weight: 650;
  border-bottom-color: var(--accent);
  background: var(--accent-soft, rgba(255, 218, 0, 0.08));
}

.tab-btn__icon {
  flex-shrink: 0;
}

.tab-btn__text {
  letter-spacing: -0.01em;
}

.tab-btn__badge {
  display: inline-block;
  padding: 1px 7px;
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  border-radius: 10px;
  background: var(--border);
  color: var(--text-muted);
  transition: background 0.15s ease, color 0.15s ease;
}

.tab-btn--active .tab-btn__badge {
  background: var(--accent);
  color: #000000;
}

.tab-panel {
  display: flex;
  flex-direction: column;
}

.tab-panel:focus-visible {
  outline: none;
}

.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}

.toolbar__search {
  flex: 1 1 220px;
  max-width: 360px;
}

.toolbar__select {
  flex: 0 0 170px;
}

.toolbar__size {
  flex: 0 0 120px;
}

.toolbar__spacer {
  flex: 1 1 0;
}

/* 飞书写入操作条 */
.feishu-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 16px;
  padding: 10px 18px;
  background: var(--surface-sunken);
  border-bottom: 1px solid var(--border);
}

.feishu-bar__info {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.feishu-bar__badge {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.feishu-bar__warn {
  font-size: 12px;
  color: var(--warn);
  font-weight: 600;
}

.feishu-bar__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

/* 飞书写入预览面板 */
.feishu-panel {
  padding: 0;
  background: var(--surface);
  display: grid;
  gap: 12px;
}

.feishu-loading {
  padding: 10px 0;
}

.feishu-error {
  margin: 4px 0;
}

.feishu-preview {
  display: grid;
  gap: 12px;
}

.feishu-preview__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.feishu-header-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.feishu-preview__title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
  color: var(--text);
}

.feishu-preview__desc {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.feishu-preview__field-alert {
  margin: 2px 0;
}

.field-issues {
  display: grid;
  gap: 6px;
  font-size: 13px;
}

.field-issue {
  overflow-wrap: anywhere;
}

.conflict-list {
  margin: 4px 0 0 16px;
  padding: 0;
  display: grid;
  gap: 2px;
}

.field-issue__notice {
  margin: 4px 0 0;
  font-size: 12px;
}

/* 栅格看板 */
.metric-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
}

.metric-item {
  display: flex;
  flex-direction: column;
  padding: 8px 12px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
}

.metric-item--accent {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.metric-label {
  font-size: 11.5px;
  color: var(--text-muted);
}

.metric-value {
  font-size: 17px;
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  color: var(--text);
  margin-top: 2px;
}

.metric-sub {
  font-size: 10.5px;
  color: var(--warn);
  margin-top: 2px;
}

/* 清单预览 */
.preview-list-wrap {
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
  overflow: hidden;
}

.preview-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
}

.preview-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 200px;
  overflow-y: auto;
}

.preview-list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 12px;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}

.preview-list-item:last-child {
  border-bottom: none;
}

.preview-list-item__main {
  flex: 1 1 auto;
  min-width: 0;
}

.preview-list-item__title {
  display: block;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.preview-list-item__id {
  display: block;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
}

.preview-list-item__meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 0 0 auto;
  text-align: right;
}

.feishu-empty-notice {
  margin: 4px 0;
}

/* 确认执行区 */
.feishu-confirm-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px 16px;
  padding: 10px 14px;
  background: var(--surface-sunken);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
}

.confirm-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}

.confirm-check input[type="checkbox"] {
  cursor: pointer;
  accent-color: var(--accent);
}

.feishu-result {
  margin: 6px 0;
}

.feishu-risk {
  margin-top: 8px;
}

.note {
  display: grid;
  gap: 6px;
  padding: 10px 18px 0;
}

.note__text {
  font-size: 12px;
  color: var(--text-muted);
}

.warning-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12.5px;
}

.blank {
  padding: 16px 18px 24px;
}

.muted {
  font-size: 12.5px;
  color: var(--text-muted);
}

.text-muted {
  font-size: 12.5px;
  color: var(--text-muted);
}

.text-error {
  font-size: 12.5px;
  color: var(--error);
  font-weight: 600;
}

.skeleton {
  display: grid;
  gap: 8px;
  margin-bottom: 10px;
}

.skeleton__row {
  height: 34px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
}

.table-wrap {
  overflow-x: auto;
  border-top: 1px solid var(--border);
}

.table-wrap:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}

.table {
  width: 100%;
  min-width: 980px;
  border-collapse: collapse;
}

.table th {
  padding: 10px 14px;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
  color: var(--text-muted);
  background: var(--surface-sunken);
  border-bottom: 1px solid var(--border);
}

/* 统一行高 112px，列垂直居中；padding 上下为 0，防止 80px + 32px padding + 1px border 撑大至 113px */
.table tr {
  height: 112px;
}

.table td {
  padding: 0 14px;
  vertical-align: middle;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
  height: 112px;
  max-height: 112px;
  box-sizing: border-box;
}

.cell-check {
  width: 44px;
  text-align: center;
  vertical-align: middle !important;
  padding: 0 8px !important;
}

.cell-check input[type="checkbox"] {
  cursor: pointer;
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
}

.cell-action {
  width: 80px;
  text-align: center;
  vertical-align: middle !important;
  padding: 0 12px !important;
  white-space: nowrap;
}

.publish-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 600;
}

.tr--selected td {
  background: var(--accent-soft);
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* 商品摘要与主图（80x80，坏图/缺图等尺寸占位） */
.cell-title-head {
  min-width: 300px;
}

.cell-title {
  min-width: 300px;
  max-width: 420px;
}

.product-summary {
  display: flex;
  align-items: center;
  gap: 12px;
}

.product-cover {
  width: 80px;
  height: 80px;
  flex: 0 0 80px;
  min-width: 80px;
  object-fit: cover;
  border-radius: 6px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  box-sizing: border-box;
}

.product-cover--empty {
  display: grid;
  place-items: center;
  color: var(--text-muted);
  width: 80px;
  height: 80px;
  flex: 0 0 80px;
  min-width: 80px;
  border-radius: 6px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  box-sizing: border-box;
}

.product-copy {
  min-width: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

/* 标题最多 40 字两行，悬停完整内容 */
.product-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}

/* 描述最多 80 字两行，悬停完整内容 */
.product-desc {
  font-size: 12px;
  line-height: 1.35;
  color: var(--text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
  margin-top: 4px;
}

.product-desc--empty {
  color: var(--text-muted);
  opacity: 0.65;
}

/* 商品 ID 独立列 */
.cell-id-head {
  min-width: 140px;
  max-width: 180px;
}

.cell-id {
  min-width: 140px;
  max-width: 180px;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-muted);
}

.id-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 卖家昵称 / 地区单行省略 */
.cell-ellipsis {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cell-seller-head {
  max-width: 120px;
}

.cell-seller {
  max-width: 120px;
}

.cell-city-head {
  max-width: 100px;
}

.cell-city {
  max-width: 100px;
}

.nowrap {
  white-space: nowrap;
}

.open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  min-height: 32px;
  border-radius: 6px;
  color: var(--text-muted);
}

.open:hover {
  background: var(--surface-sunken);
  color: var(--text);
}

.open:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 14px;
  padding: 12px 18px;
}

.pager__total {
  margin-right: auto;
  font-size: 12.5px;
  color: var(--text-muted);
}

.pager__info {
  font-size: 12.5px;
  color: var(--text-muted);
}

@media (max-width: 599px) {
  .toolbar {
    padding: 12px;
  }

  .toolbar__search,
  .toolbar__select,
  .toolbar__size {
    flex: 1 1 100%;
    max-width: none;
  }

  .feishu-bar,
  .feishu-confirm-box {
    flex-direction: column;
    align-items: flex-start;
  }

  .feishu-bar__actions,
  .feishu-confirm-box__right {
    width: 100%;
    justify-content: flex-start;
  }
}
</style>
