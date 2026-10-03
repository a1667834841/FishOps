<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhArrowSquareOut, PhArrowsClockwise, PhCaretLeft, PhCaretRight, PhCheck, PhDownloadSimple, PhImage, PhMagnifyingGlass, PhTable, PhUploadSimple, PhX } from '@phosphor-icons/vue'
import AppModal from '../components/AppModal.vue'
import Callout from '../components/Callout.vue'
import EmptyState from '../components/EmptyState.vue'
import PanelCard from '../components/PanelCard.vue'
import StatusTag from '../components/StatusTag.vue'
import { useBridgeController } from '../composables/useBridgeController'
import type { PageId } from '../data/navigation'
import { formatShortTime } from '../features/chat/chat-format'
import {
  FeishuWriteController,
  isFeishuPreviewExpired,
  type FeishuWriteState,
} from '../features/products/feishu-write-controller'
import {
  FeishuSchemaReconcileController,
  extractLegacyTextFieldConflicts,
  formatFeishuTypeName,
  buildLegacyMigrationGuide,
  isFeishuPreviewExpired as isFeishuSchemaExpired,
  type FeishuSchemaReconcileState,
} from '../features/products/feishu-schema-controller'
import { PRODUCTS_EVENTS, ProductsController, type ProductsState } from '../features/products/products-controller'
import {
  PRODUCT_ORDER_OPTIONS,
  PRODUCT_PAGE_SIZES,
  PRODUCT_SOURCE_OPTIONS,
  buildProductsCsv,
  csvFileName,
  displayCaptureTime,
  displayPrice,
  displayProductSourceTag,
  pageInfo,
  productLink,
  type ProductSourceFilter,
} from '../features/products/products-format'
import type { ProductOrder } from '../features/contracts'

const emit = defineEmits<{ navigate: [page: PageId] }>()

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

const { state: schemaState, controller: schemaController } = useBridgeController<
  FeishuSchemaReconcileState,
  FeishuSchemaReconcileController
>({
  events: [],
  timeoutMs: 30000,
  create: (api) => new FeishuSchemaReconcileController({ api }),
})

const available = computed(() => state.value.availability === 'ready')
const result = computed(() => state.value.result)
const query = computed(() => state.value.query)
const keywordInput = ref('')
const exportNote = ref('')
const showWritePanel = ref(false)
const failedCovers = ref(new Set<string>())

function hideFailedCover(itemId: string): void {
  failedCovers.value = new Set([...failedCovers.value, itemId])
}

const paging = computed(() => pageInfo(result.value.total, query.value.pageSize, query.value.page))
const busy = computed(() => result.value.phase === 'loading' || result.value.refreshing)
/** 当前列表是否与输入框 / 控件对应的查询不一致（上一次查询失败时会出现）。 */
const showingPrevious = computed(() => {
  const queried = result.value.queriedWith
  if (!queried || result.value.phase !== 'ready' || !result.value.error) return false
  return (
    queried.keyword !== query.value.keyword ||
    queried.order !== query.value.order ||
    queried.pageSize !== query.value.pageSize ||
    queried.page !== query.value.page
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
  // 进入商品页时主动调用飞书目标配置安全状态检查，不依赖后端执行才失败
  void schemaController.checkSafetyStatus()
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

function submitSearch(): void {
  exportNote.value = ''
  void controller.search(keywordInput.value)
}

function clearSearch(): void {
  keywordInput.value = ''
  submitSearch()
}

function onRefreshProducts(): void {
  void controller.refresh()
  void schemaController.checkSafetyStatus()
}

function onOrder(event: Event): void {
  void controller.setOrder((event.target as HTMLSelectElement).value as ProductOrder)
}

function onSource(event: Event): void {
  void controller.setSource((event.target as HTMLSelectElement).value as ProductSourceFilter)
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
  exportNote.value = `已导出当前页 ${items.length} 条商品（商品库共 ${result.value.total} 件，未导出的部分需翻页后分别导出）。`
}

function handlePreview(): void {
  showSchemaPanel.value = false
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
  showSchemaPanel.value = false
  emit('navigate', 'settings')
}

// ---------------- 飞书商品字段同步（Schema Reconciliation） ----------------
const showSchemaPanel = ref(false)
const userAcceptedTypeConflicts = ref(false)

const schemaPreviewBusy = computed(() => schemaState.value.preview.phase === 'loading')
const schemaExecuteBusy = computed(() => schemaState.value.execute.phase === 'loading')
const schemaBusy = computed(() => schemaPreviewBusy.value || schemaExecuteBusy.value)
const schemaPreviewResult = computed(() => schemaState.value.preview.result)
const schemaExecuteResult = computed(() => schemaState.value.execute.result)

const isSchemaExpired = computed(() => {
  const pr = schemaPreviewResult.value
  if (!pr) return false
  return isFeishuSchemaExpired(pr.expiresAt, nowTick.value)
})

const hasTypeConflicts = computed(() => {
  const pr = schemaPreviewResult.value
  if (!pr) return false
  return (pr.typeConflicts?.length ?? 0) > 0 || (pr.requiresConfirmation ?? false)
})

/** 旧历史口径关键字段类型冲突（价格/原价/发布时间/采集时间为文本）。 */
const legacyTypeConflicts = computed(() => {
  const pr = schemaPreviewResult.value
  return extractLegacyTextFieldConflicts(pr?.typeConflicts)
})

/** 是否存在旧历史口径类型冲突（若存在，绝对禁止通过 acceptTypeConflicts 强行放行）。 */
const hasLegacyTypeConflicts = computed(() => legacyTypeConflicts.value.length > 0)

/** 旧历史口径字段人工迁移指引（清晰、可操作但不自动改表） */
const legacyMigrationGuide = computed(() => {
  return buildLegacyMigrationGuide(schemaPreviewResult.value?.typeConflicts)
})

watch(
  () => schemaState.value.preview.phase,
  (phase) => {
    if (phase !== 'ready') {
      userAcceptedTypeConflicts.value = false
    }
  },
)

const canExecuteSchema = computed(() => {
  const pr = schemaPreviewResult.value
  return (
    schemaState.value.preview.phase === 'ready' &&
    pr !== null &&
    pr.toCreate.length > 0 &&
    !isSchemaExpired.value &&
    !schemaExecuteBusy.value &&
    !hasLegacyTypeConflicts.value && // 存在旧历史口径冲突时严格禁止执行！
    (!hasTypeConflicts.value || userAcceptedTypeConflicts.value)
  )
})

function toggleSchemaPanel(): void {
  showWritePanel.value = false
  showSchemaPanel.value = !showSchemaPanel.value
  if (showSchemaPanel.value) {
    void schemaController.checkSafetyStatus()
  }
}

function openSchemaPanel(): void {
  showWritePanel.value = false
  showSchemaPanel.value = true
  void schemaController.checkSafetyStatus()
}

function handleSchemaPreview(): void {
  userAcceptedTypeConflicts.value = false
  void schemaController.preview()
}

async function handleSchemaExecute(): Promise<void> {
  if (!canExecuteSchema.value) return
  await schemaController.execute({
    confirm: true,
    acceptTypeConflicts: userAcceptedTypeConflicts.value,
  })
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
      <form class="toolbar" role="search" @submit.prevent="submitSearch">
        <div class="toolbar__search">
          <label class="sr-only" for="products-keyword">按标题或商品 ID 搜索</label>
          <input
            id="products-keyword"
            v-model="keywordInput"
            class="input"
            type="search"
            autocomplete="off"
            placeholder="搜索标题或商品 ID，回车确认"
            :disabled="!available"
          />
        </div>
        <button type="submit" class="btn btn--sm btn--icon" aria-label="搜索商品" title="搜索" :disabled="!available || busy"><PhMagnifyingGlass :size="18" /></button>
        <button v-if="query.keyword" type="button" class="btn btn--sm btn--ghost btn--icon" aria-label="清除搜索" title="清除搜索" :disabled="busy" @click="clearSearch"><PhX :size="18" /></button>

        <label class="toolbar__select">
          <span class="sr-only">商品来源筛选</span>
          <select class="input" :value="query.source" :disabled="!available" title="筛选商品归属来源" @change="onSource">
            <option v-for="option in PRODUCT_SOURCE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
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
          :title="'仅导出当前页已查询到的商品'"
          @click="exportCsv"
        >
          <PhDownloadSimple :size="18" /> 导出本页
        </button>
        <button
          type="button"
          class="btn btn--sm"
          :class="{ 'btn--primary': showSchemaPanel }"
          :disabled="!available || schemaBusy"
          title="将本地商品库字段与飞书表结构做并集同步，补充缺失字段"
          @click="toggleSchemaPanel"
        >
          <PhTable :size="18" /> 同步字段
        </button>
      </form>

      <!-- 飞书商品字段同步面板（Schema Reconciliation） -->
      <AppModal :open="showSchemaPanel" title="同步商品字段" wide :busy="schemaBusy" @close="showSchemaPanel = false">
      <section
        class="feishu-panel schema-panel"
        aria-label="飞书商品字段同步"
      >
        <div class="feishu-preview__header">
          <div>
            <h3 class="feishu-preview__title">核对飞书表结构</h3>
            <p class="feishu-preview__desc">
              比对本地与飞书商品字段，确认后补充缺失字段。现有字段不会被删除或修改。
              <template v-if="schemaPreviewResult">
                · 目标商品表：<code>{{ schemaPreviewResult.targetTableId }}</code>
                · 预览 ID：<code>{{ schemaPreviewResult.previewId }}</code>
                <template v-if="schemaState.preview.previewedAt">
                  · 预览于 {{ formatShortTime(schemaState.preview.previewedAt) }}
                </template>
              </template>
            </p>
          </div>
          <div class="schema-header-actions">
            <StatusTag v-if="isSchemaExpired" tone="warn">预览已过期</StatusTag>
            <StatusTag v-else-if="hasLegacyTypeConflicts" tone="error">历史口径冲突 (禁止写入)</StatusTag>
            <StatusTag v-else-if="hasTypeConflicts" tone="error">存在类型冲突</StatusTag>
            <StatusTag v-else-if="schemaPreviewResult && schemaPreviewResult.toCreate.length === 0" tone="ok">字段已对齐</StatusTag>
            <button
              type="button"
              class="btn btn--sm btn--primary"
              :disabled="!available || schemaBusy"
              @click="handleSchemaPreview"
            >
              <PhMagnifyingGlass :size="18" />
              {{ schemaPreviewBusy ? '正在生成预览…' : schemaState.preview.phase === 'ready' ? '重新生成预览' : '生成字段同步预览' }}
            </button>
          </div>
        </div>

        <!-- 未配置飞书或配置缺失提示：显示去设置 -->
        <div v-if="schemaState.isConfigMissing" class="feishu-error">
          <Callout tone="error" title="未配置飞书数据源">
            <template #default>
              飞书商品表数据源尚未配置完整（缺少 App ID、Secret、Spreadsheet Token 或商品表 Table ID），无法进行字段比对与同步。
            </template>
            <template #actions>
              <button type="button" class="btn btn--sm btn--primary" @click="navigateToSettings">
                前往设置页配置飞书
              </button>
            </template>
          </Callout>
        </div>

        <!-- 预览加载中 -->
        <div v-else-if="schemaPreviewBusy" class="feishu-loading">
          <div class="skeleton__row" style="width: 50%"></div>
          <p class="muted">正在读取飞书多维表格真实字段并与本地商品库字段进行只读比对（绝不写入或删除字段）…</p>
        </div>

        <!-- 预览报错（非未配置飞书） -->
        <div v-else-if="schemaState.preview.phase === 'error'" class="feishu-error">
          <Callout tone="error" :view="schemaState.preview.error">
            <template #actions>
              <button
                type="button"
                class="btn btn--sm"
                :disabled="schemaPreviewBusy"
                @click="handleSchemaPreview"
              >
                重试预览
              </button>
            </template>
          </Callout>
        </div>

        <!-- 尚未生成预览时的初次提示 -->
        <div v-else-if="schemaState.preview.phase === 'idle' && schemaState.execute.phase === 'idle'" class="schema-initial">
          <Callout tone="info">
            点击右上角「生成字段同步预览」，系统将只读检测当前飞书商品表（<code>productTableId</code>）的字段结构，展示待创建字段、已一致字段与冲突情况。
          </Callout>
        </div>

        <!-- 预览成功结果展示 -->
        <div v-else-if="schemaState.preview.phase === 'ready' && schemaPreviewResult" class="schema-body">
          <!-- 预览过期提醒 -->
          <div v-if="isSchemaExpired" class="feishu-preview__field-alert">
            <Callout tone="warn" title="字段同步预览已过期">
              <template #default>
                本次预览已超过有效期限（5 分钟）。为了保证飞书表结构与字段定义绝对准确，<strong>原预览已失效并禁止继续执行</strong>。请重新点击「重新生成预览」。
              </template>
              <template #actions>
                <button type="button" class="btn btn--sm btn--primary" :disabled="schemaPreviewBusy" @click="handleSchemaPreview">
                  重新生成预览
                </button>
              </template>
            </Callout>
          </div>

          <!-- 字段数量看板 -->
          <div class="metric-grid">
            <div class="metric-item">
              <span class="metric-label">本地商品库字段</span>
              <strong class="metric-value">{{ schemaPreviewResult.localFieldCount }}</strong>
            </div>
            <div class="metric-item">
              <span class="metric-label">飞书现有字段</span>
              <strong class="metric-value">{{ schemaPreviewResult.feishuFieldCount }}</strong>
            </div>
            <div class="metric-item">
              <span class="metric-label">目标并集总数</span>
              <strong class="metric-value">{{ schemaPreviewResult.targetFieldCount }}</strong>
            </div>
            <div class="metric-item">
              <span class="metric-label">已一致字段</span>
              <strong class="metric-value">{{ schemaPreviewResult.inSync.length }}</strong>
            </div>
            <div class="metric-item metric-item--accent">
              <span class="metric-label">待创建缺失字段</span>
              <strong class="metric-value">{{ schemaPreviewResult.toCreate.length }}</strong>
            </div>
            <div class="metric-item" :class="{ 'metric-item--warn': hasTypeConflicts }">
              <span class="metric-label">同名类型冲突</span>
              <strong class="metric-value" :class="{ 'text-warn': hasTypeConflicts }">{{ schemaPreviewResult.typeConflicts.length }}</strong>
            </div>
            <div class="metric-item">
              <span class="metric-label">仅飞书存在(绝不删除)</span>
              <strong class="metric-value">{{ schemaPreviewResult.feishuOnly.length }}</strong>
            </div>
          </div>

          <!-- 类型冲突警告与确认（默认阻止执行） -->
          <div v-if="hasTypeConflicts" class="feishu-preview__field-alert">
            <!-- 旧历史口径关键字段类型冲突拦截提示与人工迁移指引（已阻断执行，不自动改表） -->
            <Callout
              v-if="hasLegacyTypeConflicts"
              tone="error"
              title="已阻断执行：检测到历史旧表文本类型冲突（需人工改表，系统不提供自动改表）"
            >
              <template #default>
                <div class="legacy-guide">
                  <p class="legacy-guide__lead">
                    飞书目标表中的<strong>价格、原价、发布时间、采集时间</strong>关键字段被误设为了文本类型。系统字段同步采用安全并集策略，<strong>绝不自动修改或覆盖已有字段类型，目前已全面阻断执行</strong>。请按以下指引在飞书后台人工完成迁移：
                  </p>

                  <!-- 1. 逐字段列当前类型 / 目标类型 -->
                  <div class="legacy-guide__table-wrap">
                    <div class="legacy-guide__table-title">
                      <strong>冲突字段类型对照表（共 {{ legacyMigrationGuide?.fields.length ?? 0 }} 项）</strong>
                    </div>
                    <table class="legacy-guide__table">
                      <thead>
                        <tr>
                          <th>冲突字段</th>
                          <th>飞书当前类型</th>
                          <th>系统规范目标类型</th>
                          <th>人工操作要求</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="item in legacyMigrationGuide?.fields" :key="item.name">
                          <td>
                            <strong class="legacy-field-name"><code>{{ item.name }}</code></strong>
                          </td>
                          <td>
                            <span class="legacy-type-tag legacy-type-tag--actual"><PhX :size="14" /> {{ item.actualTypeName }} (类型 {{ item.actualType }})</span>
                          </td>
                          <td>
                            <span class="legacy-type-tag legacy-type-tag--target"><PhCheck :size="14" /> {{ item.expectedTypeName }} (类型 {{ item.expectedType }})</span>
                          </td>
                          <td class="legacy-field-hint">
                            {{ item.adjustmentHint }}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <!-- 2. 清晰、可操作的人工迁移操作指引 -->
                  <div class="legacy-guide__steps">
                    <div class="legacy-step">
                      <div class="legacy-step__num">1</div>
                      <div class="legacy-step__content">
                        <strong>先备份现有数据（至关重要）：</strong>
                        <span>在进入飞书多维表格后台调整前，务必先将当前多维表格导出为 Excel/CSV 或创建表格副本备份，以防误操作导致存量历史数据丢失。</span>
                      </div>
                    </div>

                    <div class="legacy-step">
                      <div class="legacy-step__num">2</div>
                      <div class="legacy-step__content">
                        <strong>新建正确类型字段或在飞书后台人工调整（二选一）：</strong>
                        <div class="legacy-step__sub">
                          <p>
                            <strong>• 方案 A（推荐，平滑新建）：</strong>在飞书多维表格中新建对应目标类型的字段（价格/原价设为「数字」，发布时间/采集时间设为「日期时间」），清洗存量文本数据后填入新列。
                          </p>
                          <p>
                            <strong>• 方案 B（直接变更）：</strong>在飞书多维表格字段设置中，直接将该列字段类型由「文本」人工调整为「数字」或「日期时间」，注意检查转换后的数值精度与时间格式。
                          </p>
                        </div>
                      </div>
                    </div>

                    <div class="legacy-step legacy-step--warn">
                      <div class="legacy-step__num legacy-step__num--warn">!</div>
                      <div class="legacy-step__content">
                        <strong class="text-warn">旧列不要自动删除（安全原则）：</strong>
                        <span>存量文本列不要随意删除！保留旧列作为存量历史数据的对照与回退备份，避免不可逆丢失数据或破坏既有视图和公式引用。</span>
                      </div>
                    </div>

                    <div class="legacy-step">
                      <div class="legacy-step__num">3</div>
                      <div class="legacy-step__content">
                        <strong>调整后重新预览：</strong>
                        <span>在飞书后台完成字段类型调整后，点击下方「调整后重新生成预览」按钮。系统将只读重新读取真实表结构比对，所有冲突解除后将自动恢复正常同步与商品写入通道。</span>
                      </div>
                    </div>

                    <div class="legacy-step legacy-step--neutral">
                      <div class="legacy-step__num legacy-step__num--neutral"><PhTable :size="16" /></div>
                      <div class="legacy-step__content">
                        <strong>安全守卫说明（无任何自动执行）：</strong>
                        <span>为确保用户数据绝对安全，系统在此处<strong>不提供任何自动执行按钮、不自动改表、不自动重试</strong>，所有类型调整均须由管理员在飞书管理后台安全完成。</span>
                      </div>
                    </div>
                  </div>
                </div>
              </template>
              <template #actions>
                <button
                  type="button"
                  class="btn btn--sm btn--primary"
                  :disabled="schemaPreviewBusy"
                  @click="handleSchemaPreview"
                >
                  {{ schemaPreviewBusy ? '正在重新比对…' : '调整后重新生成预览' }}
                </button>
              </template>
            </Callout>

            <!-- 非历史口径的普通同名类型冲突提示 -->
            <Callout
              v-else
              tone="error"
              title="检测到同名类型冲突（系统默认阻止执行）"
            >
              <template #default>
                <div class="field-issues">
                  <p class="field-issue__notice">
                    飞书目标表中已存在与本地商品库同名但类型不一致的字段。根据飞书 API 能力与数据安全规范，<strong>系统绝不自动覆盖飞书字段类型</strong>，默认阻止执行：
                  </p>
                  <ul class="conflict-list">
                    <li v-for="conflict in schemaPreviewResult.typeConflicts" :key="conflict.name">
                      「{{ conflict.name }}」：期望类型为 <strong>{{ formatFeishuTypeName(conflict.expectedType) }}</strong>，飞书表中实际为 <strong>{{ formatFeishuTypeName(conflict.actualType) }}</strong>
                    </li>
                  </ul>
                  <p class="field-issue__notice" style="margin-top: 6px;">
                    建议先前往飞书多维表格手动调整上述字段类型。若您已知悉并同意忽略类型冲突、仅创建其余缺失字段，请在下方勾选确认。
                  </p>
                </div>
              </template>
            </Callout>
          </div>

          <!-- 待创建字段清单 -->
          <div v-if="schemaPreviewResult.toCreate.length > 0" class="preview-list-wrap">
            <div class="preview-list-header">
              <span>待创建字段清单（共 {{ schemaPreviewResult.toCreate.length }} 个字段将被新增至飞书商品表）</span>
            </div>
            <ul class="preview-list">
              <li v-for="field in schemaPreviewResult.toCreate" :key="field.name" class="preview-list-item">
                <div class="preview-list-item__main">
                  <span class="preview-list-item__title"><code>{{ field.name }}</code></span>
                  <span class="preview-list-item__id">并集补充 · 来源本地商品库定义</span>
                </div>
                <div class="preview-list-item__meta">
                  <StatusTag tone="info">{{ formatFeishuTypeName(field.type) }}</StatusTag>
                </div>
              </li>
            </ul>
          </div>
          <div v-else class="feishu-empty-notice">
            <Callout tone="ok">
              本地商品库定义的全部字段在飞书商品表中均已存在，无需创建缺失字段。
            </Callout>
          </div>

          <!-- 仅飞书存在字段说明（审计与禁止删除提示） -->
          <div v-if="schemaPreviewResult.feishuOnly.length > 0" class="schema-feishu-only">
            <Callout tone="info" title="仅飞书存在的字段（安全保护：绝不删除）">
              <template #default>
                以下字段仅在飞书多维表中存在，本地未定义：
                <strong>{{ schemaPreviewResult.feishuOnly.join('、') }}</strong>。
                系统严格遵循并集策略与安全规范，<strong>绝不发起删除操作</strong>，飞书上的业务数据与自定义字段完整保留。
              </template>
            </Callout>
          </div>

          <!-- 显式确认与执行操作区 -->
          <div class="feishu-confirm-box">
            <div class="feishu-confirm-box__left">
              <!-- 若存在旧历史口径类型冲突，明确提示禁止写入与人工迁移要求，绝对不渲染勾选框 -->
              <span v-if="hasLegacyTypeConflicts" class="text-error">
                存在关键字段历史口径冲突：已阻断执行。系统绝不自动改表，请根据上方指引在飞书后台人工调整，旧列请勿删除，调整后重新预览。
              </span>
              <!-- 普通类型冲突，提供显式知悉确认勾选框 -->
              <label v-else-if="hasTypeConflicts && !isSchemaExpired && schemaPreviewResult.toCreate.length > 0" class="confirm-check">
                <input
                  v-model="userAcceptedTypeConflicts"
                  type="checkbox"
                  :disabled="schemaExecuteBusy"
                />
                <span>
                  已知悉上述同名类型冲突，同意仅创建其余 <strong>{{ schemaPreviewResult.toCreate.length }}</strong> 个缺失字段（类型冲突字段需在飞书人工调整，系统不覆盖类型）。
                </span>
              </label>
              <span v-else-if="isSchemaExpired" class="text-error">
                预览已过期，请点击上方「重新生成预览」。
              </span>
              <span v-else-if="schemaPreviewResult.toCreate.length === 0" class="text-muted">
                当前字段已全部一致，无需执行同步。
              </span>
              <span v-else class="text-muted">
                点击右侧按钮显式执行字段创建。<strong>执行不会自动触发，失败绝不自动重试。</strong>
              </span>
            </div>
            <div class="feishu-confirm-box__right">
              <!-- 存在历史口径冲突时：已阻断执行，坚决不提供任何自动执行按钮，仅允许在改表后重新生成预览 -->
              <button
                v-if="hasLegacyTypeConflicts"
                type="button"
                class="btn btn--primary"
                :disabled="schemaPreviewBusy"
                @click="handleSchemaPreview"
              >
                {{ schemaPreviewBusy ? '正在重新比对…' : '调整后重新生成预览' }}
              </button>
              <button
                v-else
                type="button"
                class="btn btn--primary"
                :disabled="!canExecuteSchema"
                @click="handleSchemaExecute"
              >
                <PhTable :size="18" />
                {{ schemaExecuteBusy ? '正在创建字段…' : `确认同步商品字段 (${schemaPreviewResult.toCreate.length})` }}
              </button>
            </div>
          </div>
        </div>

        <!-- 执行成功报告 -->
        <div v-if="schemaState.execute.phase === 'ready' && schemaExecuteResult" class="feishu-result">
          <Callout tone="ok" title="商品字段同步成功（已禁止重放）">
            <template #default>
              已成功在目标表（<code>{{ schemaExecuteResult.targetTableId }}</code>）创建 <strong>{{ schemaExecuteResult.createdFields.length }}</strong> 个缺失字段：
              <code>{{ schemaExecuteResult.createdFields.join('、') || '（无）' }}</code>。
              <span v-if="schemaExecuteResult.skippedExistingFields.length > 0">
                （已幂等跳过已有字段 {{ schemaExecuteResult.skippedExistingFields.length }} 个）
              </span>
              <div v-if="schemaExecuteResult.typeConflicts.length > 0" style="margin-top: 6px;">
                <strong>注意：</strong>仍保留 {{ schemaExecuteResult.typeConflicts.length }} 个同名类型冲突字段未作修改，请在飞书多维表格中手动调整其类型。
              </div>
            </template>
            <template #actions>
              <button type="button" class="btn btn--sm" @click="handleSchemaPreview">再次比对字段</button>
              <button type="button" class="btn btn--sm btn--ghost" @click="schemaController.resetExecute()">关闭提示</button>
            </template>
          </Callout>
        </div>

        <!-- 执行失败报告：严禁自动重试并作废原预览 -->
        <div v-if="schemaState.execute.phase === 'error'" class="feishu-result">
          <Callout tone="error" :view="schemaState.execute.error">
            <template #actions>
              <button
                v-if="schemaState.isConfigMissing"
                type="button"
                class="btn btn--sm btn--primary"
                @click="navigateToSettings"
              >
                前往设置页配置飞书
              </button>
              <button type="button" class="btn btn--sm btn--ghost" @click="schemaController.resetExecute()">
                关闭错误提示
              </button>
            </template>
          </Callout>
        </div>
      </section>
      </AppModal>

      <!-- 飞书写入选品操作条 -->
      <section v-if="selectedCount > 0" class="feishu-bar" aria-label="飞书写入选品操作">
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
      <section
        class="feishu-panel"
        aria-live="polite"
      >
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
            <div class="schema-header-actions">
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
                本次预览已超过有效期限（5 分钟）。为了保证飞书目标表与去重数据绝对准确，<strong>已作废旧预览并禁止继续执行</strong>。请重新点击「生成飞书写入预览」核对。
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
                    根据安全规范，<strong>系统严禁自动创建或修改飞书表格字段</strong>。您可点击下方按钮显式比对并同步缺失字段，或前往飞书多维表格手动调整字段后重新生成预览。
                  </p>
                  <div class="field-issue__actions">
                    <button type="button" class="btn btn--sm btn--primary" @click="openSchemaPanel">
                      前往同步商品字段
                    </button>
                  </div>
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

      <div class="status" aria-live="polite">
        <template v-if="result.phase === 'ready'">
          <span>共 <strong>{{ result.total }}</strong> 件<template v-if="result.queriedWith?.keyword">（关键词「{{ result.queriedWith.keyword }}」）</template></span>
          <span v-if="result.total > 0">第 {{ paging.from }} 到 {{ paging.to }} 条</span>
          <span v-if="result.queriedAt">查询于 {{ formatShortTime(result.queriedAt) }}</span>
        </template>
        <span v-else-if="result.phase === 'loading'">正在读取当前账号已发布商品…</span>
        <span v-else>&nbsp;</span>
      </div>

      <div v-if="exportNote" class="note"><Callout tone="ok">{{ exportNote }}</Callout></div>
      <div v-if="result.error && result.phase === 'ready'" class="note">
        <Callout tone="warn" :view="result.error">
          <template #actions>
            <button type="button" class="btn btn--sm" :disabled="busy" @click="controller.refresh()">重试</button>
          </template>
        </Callout>
        <p v-if="showingPrevious" class="note__text">下方仍是上一次成功查询的结果，与当前筛选条件不一定一致。</p>
      </div>

      <div v-if="!available" class="blank">
        <EmptyState mark="品" title="未连接扩展" description="当前账号发布的商品数据保存在扩展的本地库中，需要在扩展内页打开工作台才能读取。" />
      </div>

      <div v-else-if="result.phase === 'idle' || result.phase === 'loading'" class="blank" role="status">
        <div class="skeleton" aria-hidden="true">
          <span v-for="n in 5" :key="n" class="skeleton__row"></span>
        </div>
        <p class="muted">正在读取当前账号已发布商品…</p>
      </div>

      <div v-else-if="result.phase === 'error'" class="blank">
        <Callout tone="error" :view="result.error">
          <template #actions>
            <button type="button" class="btn btn--sm" @click="controller.refresh()">重试</button>
          </template>
        </Callout>
      </div>

      <div v-else-if="result.items.length === 0" class="blank">
        <EmptyState
          v-if="result.queriedWith?.keyword"
          mark="品"
          title="没有符合条件的已发布商品"
          :description="`当前账号已发布商品中没有标题或商品 ID 包含「${result.queriedWith.keyword}」的商品。`"
        >
          <button type="button" class="btn" @click="clearSearch">清除搜索</button>
        </EmptyState>
        <EmptyState
          v-else-if="query.source === 'my_published'"
          mark="品"
          title="当前账号暂无发布商品"
          description="本地商品目录仅收录当前登录账号已发布的商品。市场搜索采集的竞品不会冒充为已发布商品；您可在发布中心发布商品，或将来源筛选切换为全部查看历史存量记录。"
        >
          <button type="button" class="btn btn--primary" @click="emit('navigate', 'publish')">去发布商品</button>
        </EmptyState>
        <EmptyState
          v-else
          mark="品"
          title="暂无对应来源的商品记录"
          description="当前筛选条件下没有匹配的商品记录。"
        >
          <button type="button" class="btn" @click="controller.setSource('my_published')">切换回当前账号发布商品</button>
        </EmptyState>
      </div>

      <template v-else>
        <div class="table-wrap" tabindex="0" role="region" aria-label="商品列表，可横向滚动">
          <table class="table">
            <caption class="sr-only">
              商品列表，当前显示第 {{ paging.from }} 到 {{ paging.to }} 条，共 {{ result.total }} 件
            </caption>
            <thead>
              <tr>
                <th scope="col" class="cell-check">
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
                <th scope="col">商品</th>
                <th scope="col">来源</th>
                <th scope="col" class="num">价格</th>
                <th scope="col" class="num">想要</th>
                <th scope="col">卖家</th>
                <th scope="col">地区</th>
                <th scope="col">包邮</th>
                <th scope="col">采集时间</th>
                <th scope="col">链接</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="product in result.items"
                :key="product.itemId"
                :class="{ 'tr--selected': selectedSet.has(product.itemId) }"
              >
                <td class="cell-check">
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
                    <img v-if="product.coverUrl && !failedCovers.has(product.itemId)" class="product-cover" :src="product.coverUrl" :alt="product.title || '商品图片'" loading="lazy" referrerpolicy="no-referrer" @error="hideFailedCover(product.itemId)" />
                    <span v-else class="product-cover product-cover--empty" aria-hidden="true"><PhImage :size="22" /></span>
                    <div class="product-copy">
                      <span class="title">{{ product.title || '（无标题）' }}</span>
                      <span class="id">{{ product.itemId }}</span>
                    </div>
                  </div>
                </td>
                <td>
                  <StatusTag :tone="displayProductSourceTag(product.source).tone">
                    {{ displayProductSourceTag(product.source).text }}
                  </StatusTag>
                </td>
                <td class="num">{{ displayPrice(product) }}</td>
                <td class="num">{{ product.wantCnt }}</td>
                <td>{{ product.sellerNick || '未知' }}</td>
                <td>{{ product.sellerCity || '未知' }}</td>
                <td>
                  <StatusTag v-if="product.freeShip === '是'" tone="ok">包邮</StatusTag>
                  <span v-else-if="product.freeShip === '否'" class="muted">否</span>
                  <span v-else class="muted">未知</span>
                </td>
                <td class="nowrap">{{ displayCaptureTime(product) || '未知' }}</td>
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
              </tr>
            </tbody>
          </table>
        </div>

        <nav class="pager" aria-label="商品库分页">
          <span class="pager__total">共 {{ result.total }} 件商品</span>
          <label class="toolbar__size">
            <span class="sr-only">每页数量</span>
            <select class="input" :value="query.pageSize" :disabled="!available || busy" @change="onPageSize">
              <option v-for="size in PRODUCT_PAGE_SIZES" :key="size" :value="size">每页 {{ size }} 条</option>
            </select>
          </label>
          <button type="button" class="btn btn--sm btn--icon" aria-label="上一页" title="上一页" :disabled="busy || paging.page <= 0" @click="controller.goToPage(paging.page - 1)"><PhCaretLeft :size="18" /></button>
          <span class="pager__info">第 {{ paging.page + 1 }} / {{ paging.totalPages }} 页</span>
          <button
            type="button"
            class="btn btn--sm"
            aria-label="下一页"
            title="下一页"
            :disabled="busy || paging.page >= paging.totalPages - 1"
            @click="controller.goToPage(paging.page + 1)"
          >
            <PhCaretRight :size="18" />
          </button>
        </nav>
      </template>
    </PanelCard>
  </div>
</template>

<style scoped>
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

/* 商品字段同步专属样式 */
.schema-panel {
  background: var(--surface);
}

.schema-header-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.schema-body {
  display: grid;
  gap: 12px;
}

.schema-initial {
  margin: 4px 0;
}

.schema-feishu-only {
  margin: 2px 0;
}

.field-issue__actions {
  margin-top: 8px;
}

.metric-item--warn {
  border-color: var(--warn);
}

.text-warn {
  color: var(--warn);
}

.status {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  min-height: 34px;
  padding: 8px 18px;
  font-size: 12.5px;
  color: var(--text-muted);
}

.note {
  display: grid;
  gap: 6px;
  padding: 0 18px 10px;
}

.note__text {
  font-size: 12px;
  color: var(--text-muted);
}

.blank {
  padding: 8px 18px 20px;
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
  min-width: 900px;
  border-collapse: collapse;
}

.cell-check {
  width: 44px;
  text-align: center;
  vertical-align: middle !important;
  padding: 8px !important;
}

.cell-check input[type="checkbox"] {
  cursor: pointer;
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
}

.tr--selected td {
  background: var(--accent-soft);
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

.table td {
  padding: 10px 14px;
  vertical-align: top;
  font-size: 13px;
  border-bottom: 1px solid var(--border);
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.cell-title {
  min-width: 260px;
  max-width: 320px;
}

.product-summary {
  display: flex;
  align-items: center;
  gap: 12px;
}

.product-cover {
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  object-fit: cover;
  border-radius: 6px;
  background: var(--surface-sunken);
}

.product-cover--empty {
  display: grid;
  place-items: center;
  color: var(--text-muted);
}

.product-copy {
  min-width: 0;
}

.title {
  display: block;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.id {
  display: block;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
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

.open:hover { background: var(--surface-sunken); color: var(--text); }

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

.pager__total { margin-right: auto; font-size: 12.5px; color: var(--text-muted); }

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

/* 旧历史口径字段人工迁移指引卡片 */
.legacy-guide {
  display: grid;
  gap: 12px;
  margin-top: 4px;
}

.legacy-guide__lead {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  margin: 0;
}

.legacy-guide__table-wrap {
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
  overflow-x: auto;
}

.legacy-guide__table-title {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.legacy-guide__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.legacy-guide__table th {
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  color: var(--text-muted);
  background: var(--surface-sunken);
  border-bottom: 1px solid var(--border);
}

.legacy-guide__table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.legacy-guide__table tr:last-child td {
  border-bottom: none;
}

.legacy-field-name code {
  font-family: var(--mono);
  font-weight: 600;
}

.legacy-type-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 11.5px;
  font-weight: 500;
}

.legacy-type-tag--actual {
  background: rgba(239, 68, 68, 0.12);
  color: var(--error);
  border: 1px solid rgba(239, 68, 68, 0.25);
}

.legacy-type-tag--target {
  background: rgba(34, 197, 94, 0.12);
  color: var(--ok, #16a34a);
  border: 1px solid rgba(34, 197, 94, 0.25);
}

.legacy-field-hint {
  font-size: 12px;
  color: var(--text-muted);
}

.legacy-guide__steps {
  display: grid;
  gap: 8px;
}

.legacy-step {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 12px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  font-size: 12.5px;
  line-height: 1.5;
}

.legacy-step--warn {
  border-color: var(--warn);
  background: rgba(245, 158, 11, 0.06);
}

.legacy-step--neutral {
  border-color: var(--border-strong);
  background: var(--surface);
}

.legacy-step__num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
  margin-top: 1px;
}

.legacy-step__num--warn {
  background: var(--warn);
}

.legacy-step__num--neutral {
  background: transparent;
  width: auto;
  height: auto;
  font-size: 13px;
}

.legacy-step__content {
  flex: 1 1 auto;
}

.legacy-step__sub {
  margin-top: 4px;
  padding-left: 2px;
  display: grid;
  gap: 4px;
  color: var(--text-muted);
}

.legacy-step__sub p {
  margin: 0;
}
</style>
