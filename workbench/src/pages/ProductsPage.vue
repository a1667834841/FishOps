<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  PhArrowSquareOut,
  PhArrowsClockwise,
  PhCaretLeft,
  PhCaretRight,
  PhDownloadSimple,
  PhImage,
  PhMagnifyingGlass,
  PhPackage,

  PhTable,
  PhX,
} from '@phosphor-icons/vue'
import Callout from '../components/Callout.vue'
import EmptyState from '../components/EmptyState.vue'
import PanelCard from '../components/PanelCard.vue'
import ProductImagePreview from '../components/ProductImagePreview.vue'
import { useBridgeController } from '../composables/useBridgeController'
import type { PageId } from '../data/navigation'
import type { PublishDraft } from '../features/publish/publish-draft-store'
import { publishDraftStore } from '../features/publish/publish-draft-store'
import { publishProductDraft } from '../features/publish/products-publish-entry'
import { PRODUCTS_EVENTS, ProductsController, type ProductsState } from '../features/products/products-controller'
import {
  PRODUCT_ORDER_OPTIONS,
  PRODUCT_PAGE_SIZES,
  buildProductsCsv,
  csvFileName,
  displayCaptureTime,
  displayPublishTime,
  displayPrice,
  pageInfo,
  productLink,
  type ProductTab,
  type ProductTableItem,
} from '../features/products/products-format'
import {
  buildPublishDraft,
  filterPageProducts,
  getItemKey,
  type PageShipFilter,
} from '../features/products/products-publish-draft'
import type { ProductOrder } from '../features/contracts'

const emit = defineEmits<{
  navigate: [page: PageId]
  publishItem: [draft: PublishDraft]
}>()

/** 缺值提示辅助说明 */
function missingFieldHint(product: ProductTableItem, field: string): string {
  return product.source === 'feishu_material'
    ? `飞书记录未提供${field}，请检查表格对应字段。`
    : `本次闲鱼数据未提供${field}，请查看详情补齐提示，或刷新重试。`
}

const { state, controller } = useBridgeController<ProductsState, ProductsController>({
  events: PRODUCTS_EVENTS,
  create: (api) => new ProductsController({ api }),
})

const available = computed(() => state.value.availability === 'ready')
const currentTab = computed(() => state.value.tab)
const isFeishuTab = computed(() => state.value.tab === 'feishu')
const timeLabel = computed(() => isFeishuTab.value ? '采集时间' : '发布时间')
const orderOptions = computed(() => PRODUCT_ORDER_OPTIONS.map(option => ({
  ...option, label: isFeishuTab.value ? option.label : option.label.replace('采集时间', '发布时间'),
})))
function displayTime(product: ProductTableItem): string {
  return isFeishuTab.value ? displayCaptureTime(product) : displayPublishTime(product)
}
const result = computed(() => state.value.result)
const query = computed(() => state.value.query)
const keywordInput = ref('')
const exportNote = ref('')
const failedCovers = ref(new Set<string>())

const tabFeishuRef = ref<HTMLButtonElement | null>(null)
const tabMyPublishedRef = ref<HTMLButtonElement | null>(null)

/** 行距密度切换：默认 'normal'（行高约 64-72px）或紧凑 'compact'（行高约 52-58px） */
const density = ref<'normal' | 'compact'>('normal')

/** 本页包邮筛选（仅作用于当前页商品，不修改扩展全库分页协议） */
const shipFilter = ref<PageShipFilter>('all')



/** 组合 source + tableId + recordId/itemId + coverUrl 作为坏图 key，避免无 ID 或缺 ID 条目互相污染 */
function getCoverKey(product: ProductTableItem): string {
  const rowKey = getItemKey(product, result.value.targetTableId)
  const src = product.source || currentTab.value
  return `${src}:${rowKey}:${product.coverUrl || ''}`
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

// ---------------- 选品与多选状态 ----------------
const selectedKeys = ref<Set<string>>(new Set())

function getRowKey(product: ProductTableItem): string {
  return getItemKey(product, result.value.targetTableId)
}



/** 过滤后的本页展示商品列表（结合本页包邮状态筛选） */
const displayItems = computed(() => {
  return filterPageProducts(result.value.items, shipFilter.value)
})

const currentPageKeys = computed(() => displayItems.value.map(getRowKey).filter(Boolean))

const isPageAllSelected = computed(() => {
  const keys = currentPageKeys.value
  return keys.length > 0 && keys.every((key) => selectedKeys.value.has(key))
})

const isPagePartialSelected = computed(() => {
  const keys = currentPageKeys.value
  const count = keys.filter((key) => selectedKeys.value.has(key)).length
  return count > 0 && count < keys.length
})

function toggleItemSelect(product: ProductTableItem): void {
  const key = getRowKey(product)
  if (!key) return
  const next = new Set(selectedKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selectedKeys.value = next
}

function toggleSelectPage(): void {
  const next = new Set(selectedKeys.value)
  if (isPageAllSelected.value) {
    for (const key of currentPageKeys.value) {
      next.delete(key)
    }
  } else {
    for (const key of currentPageKeys.value) {
      next.add(key)
    }
  }
  selectedKeys.value = next
}



/** 切换商品库菜单 Tab */
function onTabChange(tab: ProductTab): void {
  if (tab === state.value.tab) return
  selectedKeys.value = new Set()
  exportNote.value = ''
  keywordInput.value = ''
  shipFilter.value = 'all'
  void controller.setTab(tab)
}

/** WAI-ARIA Accessible Tabs 键盘漫游导航 */
function onTabKeydown(event: KeyboardEvent, current: ProductTab): void {
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

function resetFilters(): void {
  keywordInput.value = ''
  shipFilter.value = 'all'
  submitSearch()
}


/**
 * 点击单行“发布”按钮：
 * 保持原有旧单品去发布安全流程（保留真实草稿，导航至发布中心，绝不自动提交）。
 */
function onPublishRow(product: ProductTableItem): void {
  const draft = buildPublishDraft(product, currentTab.value, result.value.targetTableId)
  publishProductDraft(draft, publishDraftStore, () => {
    emit('publishItem', draft)
    emit('navigate', 'publish')
  })
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

/** 表头点击快速排序（仅支持后端真实支持的 wantCntDesc 与 captureTime） */
function toggleSort(type: 'time' | 'wants'): void {
  if (type === 'wants') {
    void controller.setOrder('wantCntDesc')
  } else if (type === 'time') {
    const nextOrder = query.value.order === 'captureTimeDesc' ? 'captureTimeAsc' : 'captureTimeDesc'
    void controller.setOrder(nextOrder)
  }
}

/**
 * CSV 导出：导出 displayItems（严格符合当前用户看到的本页筛选条目）。
 */
function exportCsv(): void {
  const items = displayItems.value
  if (result.value.phase !== 'ready' || items.length === 0) return
  const blob = new Blob([buildProductsCsv(items)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = csvFileName(Date.now())
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)

  const filterText = shipFilter.value === 'all' ? '' : `（${shipFilter.value === 'free' ? '仅包邮' : '仅不包邮'}）`
  exportNote.value = `已导出当前页筛选的 ${items.length} 条商品${filterText}。`
}

function navigateToSettings(): void {
  emit('navigate', 'settings')
}

/** 格式化商品标题：最多 36 字单行截断，避免撑大行高 */
function formatProductTitle(title?: string): string {
  if (!title) return '（无标题）'
  return title.length > 36 ? `${title.slice(0, 36)}…` : title
}
</script>

<template>
  <div class="page products-view">
    <!-- 顶部状态提示 -->
    <Callout v-if="state.hasNewCapture" tone="info" class="status-banner">
      <template #default>后台采集任务有新进展，当前账号商品目录可能已更新。</template>
      <template #actions>
        <button type="button" class="btn btn--sm btn--primary" :disabled="busy" @click="controller.refresh()">
          刷新商品目录
        </button>
      </template>
    </Callout>


    <!-- Seline 暖纸白卡容器 -->
    <PanelCard flush class="feature-card">
      <!-- 页面轻标题与 Tab 导航 -->
      <div class="card-header-row">
        <div class="view-title-group">
          <h1 class="view-title">
            <span class="title-dot" aria-hidden="true"></span>
            商品库
          </h1>
          <span class="view-sub">采集结果检索、筛选、排序与发布流转</span>
        </div>

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
            @click="onTabChange('feishu')"
            @keydown="onTabKeydown($event, 'feishu')"
          >
            <PhTable :size="16" class="tab-btn__icon" />
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
            @click="onTabChange('my_published')"
            @keydown="onTabKeydown($event, 'my_published')"
          >
            <PhPackage :size="16" class="tab-btn__icon" />
            <span class="tab-btn__text">自己发布的商品库</span>
            <span
              v-if="currentTab === 'my_published' && result.phase === 'ready' && typeof result.total === 'number'"
              class="tab-btn__badge"
            >
              {{ result.total }}
            </span>
          </button>
        </nav>
      </div>

      <div
        id="panel-products"
        role="tabpanel"
        :aria-labelledby="currentTab === 'feishu' ? 'tab-feishu' : 'tab-my_published'"
        class="tab-panel"
        tabindex="0"
      >
        <!-- 紧凑工具栏 -->
        <div class="toolbar-row">
          <div class="toolbar-left">
            <div class="search-input-wrap">
              <PhMagnifyingGlass :size="14" class="search-lens" aria-hidden="true" />
              <input
                id="product-search"
                v-model="keywordInput"
                type="text"
                class="input-text"
                :placeholder="isFeishuTab ? '搜索标题、卖家、地区...' : '搜索商品名称、商品 ID...'"
                aria-label="搜索商品"
                :disabled="!available || busy"
                @keydown.enter.prevent="submitSearch"
              />
              <button
                v-if="keywordInput"
                type="button"
                class="clear-btn"
                aria-label="清除搜索"
                title="清除"
                @click="clearSearch"
              >
                <PhX :size="13" />
              </button>
            </div>

            <!-- 明确为本页包邮筛选，不修改全库协议 -->
            <select v-model="shipFilter" class="select-dropdown" aria-label="本页包邮筛选">
              <option value="all">本页包邮筛选：全部</option>
              <option value="free">本页仅包邮</option>
              <option value="paid">本页仅不包邮</option>
            </select>

            <select
              class="select-dropdown"
              :value="query.order"
              :disabled="!available || busy"
              aria-label="排序方式"
              @change="onOrder"
            >
              <option v-for="option in orderOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>

            <button
              type="button"
              class="btn btn--sm"
              :disabled="!available || busy"
              @click="resetFilters"
            >
              重置筛选
            </button>
          </div>

          <div class="toolbar-right">
            <span class="density-label">行距密度：</span>
            <div class="density-switch" role="group" aria-label="表格行距密度">
              <button
                type="button"
                class="density-btn"
                :class="{ active: density === 'normal' }"
                @click="density = 'normal'"
              >
                默认
              </button>
              <button
                type="button"
                class="density-btn"
                :class="{ active: density === 'compact' }"
                @click="density = 'compact'"
              >
                紧凑
              </button>
            </div>

            <button
              type="button"
              class="btn btn--sm btn--icon"
              aria-label="刷新商品列表"
              :title="result.refreshing ? '刷新中…' : '刷新'"
              :disabled="!available || busy"
              @click="onRefreshProducts"
            >
              <PhArrowsClockwise :size="15" :class="{ 'spin-icon': result.refreshing }" />
            </button>

            <button
              type="button"
              class="btn btn--sm"
              :disabled="result.phase !== 'ready' || displayItems.length === 0"
              title="仅导出当前页已筛选到的商品"
              @click="exportCsv"
            >
              <PhDownloadSimple :size="15" />
              <span>导出本页</span>
            </button>


          </div>
        </div>

        <!-- 选品与辅助状态提示 -->


        <div v-if="exportNote" class="notice-bar">
          <Callout tone="ok">{{ exportNote }}</Callout>
        </div>

        <div v-if="isFeishuTab && result.warnings && result.warnings.length > 0" class="notice-bar">
          <Callout tone="warn" title="商品详情提示">
            <template #default>
              <ul class="warning-list">
                <li v-for="(warn, idx) in result.warnings" :key="idx">{{ warn }}</li>
              </ul>
            </template>
          </Callout>
        </div>

        <!-- 空态 / 错误 / 加载中完整状态分支 -->
        <div v-if="!available" class="blank-container">
          <EmptyState mark="品" title="未连接扩展" description="商品数据由扩展运行时负责同步与管理，需要在扩展内页打开工作台才能读取。" />
        </div>

        <div v-else-if="isFeishuTab && state.isConfigMissing" class="blank-container">
          <Callout tone="error" title="飞书商品表尚未配置完整">
            <template #default>缺少飞书多维表格对应配置或授权凭据，无法查询采集数据。</template>
            <template #actions>
              <button type="button" class="btn btn--primary" @click="navigateToSettings">前往设置</button>
            </template>
          </Callout>
        </div>

        <div v-else-if="result.phase === 'idle' || result.phase === 'loading'" class="blank-container" role="status">
          <div class="skeleton" aria-hidden="true">
            <span v-for="n in 6" :key="n" class="skeleton__row"></span>
          </div>
          <p class="muted">正在读取商品库数据…</p>
        </div>

        <div v-else-if="result.phase === 'error'" class="blank-container">
          <Callout tone="error" :view="result.error">
            <template #actions>
              <button type="button" class="btn btn--sm btn--primary" :disabled="busy" @click="controller.refresh()">重试</button>
              <button v-if="state.isConfigMissing" type="button" class="btn btn--sm" @click="navigateToSettings">前往设置</button>
            </template>
          </Callout>
        </div>

        <div v-else-if="displayItems.length === 0" class="blank-container">
          <EmptyState
            v-if="query.keyword || shipFilter !== 'all'"
            mark="搜"
            title="未找到匹配的商品"
            :description="`当前筛选条件下未检索到任何商品，请尝试更换关键词或重置本页筛选。`"
          >
            <button type="button" class="btn" @click="resetFilters">重置筛选</button>
          </EmptyState>
          <EmptyState
            v-else-if="isFeishuTab"
            mark="采"
            title="暂无采集商品记录"
            description="飞书表格中暂无昨天和今天的采集结果。可先到采集中心创建采集任务或前往设置检查表格配置。"
          >
            <button type="button" class="btn btn--primary" @click="emit('navigate', 'collect')">去采集商品</button>
            <button type="button" class="btn" @click="navigateToSettings">检查配置</button>
          </EmptyState>
          <EmptyState
            v-else
            mark="发"
            title="暂无已发布商品"
            description="当前闲鱼账号尚未同步到在售商品，可以从飞书采集表挑选商品并直接进入人工核对。"
          >
            <button type="button" class="btn btn--primary" @click="emit('navigate', 'publish')">去发布中心</button>
          </EmptyState>
        </div>

        <!-- 真实数据紧凑表格 -->
        <template v-else>
          <div v-if="result.error && result.phase === 'ready'" class="notice-bar">
            <Callout tone="warn" :view="result.error">
              <template #actions>
                <button type="button" class="btn btn--sm btn--primary" :disabled="busy" @click="controller.refresh()">重试</button>
                <button v-if="state.isConfigMissing" type="button" class="btn btn--sm" @click="navigateToSettings">设置</button>
              </template>
            </Callout>
            <p v-if="showingPrevious" class="note__text">由于网络或查询异常，当前显示上一次加载成功的商品缓存。</p>
          </div>

          <div class="table-responsive" tabindex="0" role="region" aria-label="商品列表，可横向滚动">
            <table class="seline-table" :class="{ 'density-compact': density === 'compact' }" id="product-table">
              <caption class="sr-only">
                <template v-if="typeof result.total === 'number'">商品列表，共 {{ result.total }} 件</template>
                <template v-else>商品列表</template>
              </caption>
              <thead>
                <tr>
                  <th style="width: 40px; text-align: center;">
                    <input
                      type="checkbox"
                      class="row-check"
                      id="check-all"
                      aria-label="全选本页商品"
                      :checked="isPageAllSelected"
                      :indeterminate="isPagePartialSelected"
                      @change="toggleSelectPage"
                    />
                  </th>
                  <th style="width: 66px;">图片</th>
                  <th>{{ isFeishuTab ? '商品（itemId）' : '商品名称' }}</th>
                  <!-- 后端无价格排序，严格展示为普通表头 -->
                  <th>价格</th>
                  <th class="sortable" title="点击按想要数排序" @click="toggleSort('wants')">
                    想要数 <span class="sort-icon">↕</span>
                  </th>
                  <th v-if="isFeishuTab">卖家</th>
                  <th>地区</th>
                  <th>包邮</th>
                  <th class="sortable" :title="`点击按${timeLabel}排序`" @click="toggleSort('time')">
                    {{ timeLabel }} <span class="sort-icon">↕</span>
                  </th>
                  <th style="width: 140px; text-align: right;">操作</th>
                </tr>
              </thead>
              <tbody id="product-tbody">
                <tr
                  v-for="product in displayItems"
                  :key="getRowKey(product)"
                  :class="{ 'tr--selected': selectedKeys.has(getRowKey(product)) }"
                >
                  <td style="text-align: center;">
                    <input
                      type="checkbox"
                      class="row-check"
                      aria-label="选择此行"
                      :checked="selectedKeys.has(getRowKey(product))"
                      @change="toggleItemSelect(product)"
                    />
                  </td>
                  <td>
                    <ProductImagePreview
                      :src="failedCovers.has(getCoverKey(product)) ? undefined : product.coverUrl"
                      :alt="product.title || '商品图片'"
                    >
                      <div class="product-thumb">
                        <img
                          v-if="product.coverUrl && !failedCovers.has(getCoverKey(product))"
                          :src="product.coverUrl"
                          :alt="product.title || '商品图片'"
                          loading="lazy"
                          @error="hideFailedCover(product)"
                        />
                        <span v-else class="product-thumb-empty" aria-hidden="true">
                          <PhImage :size="22" />
                        </span>
                      </div>
                    </ProductImagePreview>
                  </td>
                  <td>
                    <div class="product-info-wrap">
                      <span class="product-name" :title="product.title || '（无标题）'">
                        {{ formatProductTitle(product.title) }}
                      </span>
                      <span v-if="isFeishuTab" class="product-sku" :title="product.itemId || product.recordId || ''">
                        <template v-if="product.itemId">itemId: {{ product.itemId }}</template>
                        <template v-else-if="product.recordId">recordId: {{ product.recordId }}</template>
                        <template v-else>无商品 ID</template>
                      </span>
                    </div>
                  </td>
                  <td>
                    <span class="product-price">{{ displayPrice(product) }}</span>
                  </td>
                  <td>
                    <span v-if="typeof product.wantCnt === 'number' && Number.isFinite(product.wantCnt)">
                      <strong>{{ product.wantCnt }}</strong>
                    </span>
                    <span v-else class="text-muted">—</span>
                  </td>
                  <td v-if="isFeishuTab" class="cell-ellipsis" :title="product.sellerNick || missingFieldHint(product, '卖家昵称')">
                    {{ product.sellerNick || '—' }}
                  </td>
                  <td class="cell-ellipsis" :title="product.sellerCity || missingFieldHint(product, '地区')">
                    {{ product.sellerCity || '—' }}
                  </td>
                  <td>
                    <span v-if="product.freeShip === '是'" class="pill pill-yellow">包邮</span>
                    <span v-else-if="product.freeShip === '否'" class="pill">不包邮</span>
                    <span v-else class="text-muted" :title="missingFieldHint(product, '包邮信息')">—</span>
                  </td>
                  <td class="nowrap" :title="displayTime(product) || missingFieldHint(product, timeLabel)">
                    {{ displayTime(product) }}
                  </td>
                  <td style="text-align: right;">
                    <div class="cell-actions-wrap">
                      <a
                        v-if="productLink(product)"
                        :href="productLink(product)!"
                        target="_blank"
                        rel="noreferrer noopener"
                        class="action-btn"
                        title="在新标签页查看闲鱼商品详情"
                      >
                        <PhArrowSquareOut :size="13" />
                        <span>详情</span>
                      </a>

                      <button
                        type="button"
                        v-if="isFeishuTab"
                        class="action-btn action-btn--brand"
                        title="去发布中心编辑发布"
                        @click="onPublishRow(product)"
                      >
                        发布
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 分页器（明确全库 total 与本页筛选命中数量，不冒充过滤总数） -->
          <div class="table-footer">
            <div id="pagination-summary" class="pagination-summary">
              <template v-if="typeof result.total === 'number'">
                全库共 {{ result.total }} 件商品 · 当前第 {{ paging.page + 1 }} / {{ paging.totalPages }} 页
                <span v-if="shipFilter !== 'all'" class="filter-count-badge">
                  （本页筛选命中 {{ displayItems.length }} / {{ result.items.length }} 条）
                </span>
                <span v-else class="filter-count-badge">（本页共 {{ result.items.length }} 条）</span>
              </template>
              <template v-else>
                本页已加载 {{ result.items.length }} 条 · 第 {{ paging.page + 1 }} 页
                <span v-if="shipFilter !== 'all'" class="filter-count-badge">
                  （本页筛选命中 {{ displayItems.length }} 条）
                </span>
              </template>
            </div>

            <div class="page-controls" id="pagination-pages">
              <label class="page-size-wrap">
                <span class="sr-only">每页条数</span>
                <select
                  class="select-dropdown-sm"
                  :value="query.pageSize"
                  :disabled="!available || busy"
                  @change="onPageSize"
                >
                  <option v-for="size in PRODUCT_PAGE_SIZES" :key="size" :value="size">{{ size }} 条/页</option>
                </select>
              </label>

              <button
                type="button"
                class="page-nav-btn"
                aria-label="上一页"
                title="上一页"
                :disabled="!available || busy || !state.canPrev"
                @click="controller.prevPage()"
              >
                <PhCaretLeft :size="14" />
              </button>
              <span class="page-current">{{ paging.page + 1 }}</span>
              <button
                type="button"
                class="page-nav-btn"
                aria-label="下一页"
                title="下一页"
                :disabled="!available || busy || !state.canNext"
                @click="controller.nextPage()"
              >
                <PhCaretRight :size="14" />
              </button>
            </div>
          </div>
        </template>
      </div>
    </PanelCard>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.status-banner,
.feedback-banner,
.notice-bar {
  margin-bottom: 2px;
}

.feature-card {
  background: var(--bg-card, #ffffff);
  border: 1px solid var(--border-line, #ede8df);
  border-radius: 8px;
  overflow: hidden;
}

/* ============ 轻标题与 Tab 栏 ============ */
.card-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-line, #ede8df);
  background: var(--bg-card, #ffffff);
  flex-wrap: wrap;
}

.view-title-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.view-title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-main, #1c1a17);
  letter-spacing: -0.01em;
}

.title-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--brand-yellow, #f5c400);
  display: inline-block;
}

.view-sub {
  font-size: 12px;
  color: var(--text-muted, #948e85);
}

.tabs-nav {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-subtle, #faf8f5);
  padding: 3px;
  border-radius: 6px;
  border: 1px solid var(--border-line, #ede8df);
}

.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: none;
  background: transparent;
  color: var(--text-secondary, #706b65);
  font-size: 12.5px;
  font-weight: 500;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
  font-family: inherit;
}

.tab-btn:hover:not(:disabled) {
  color: var(--text-main, #1c1a17);
  background: rgba(0, 0, 0, 0.03);
}

.tab-btn--active {
  background: #ffffff !important;
  color: var(--text-main, #1c1a17) !important;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.tab-btn__badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--bg-subtle, #faf8f5);
  border: 1px solid var(--border-line, #ede8df);
  color: var(--text-muted, #948e85);
  font-family: ui-monospace, SFMono-Regular, monospace;
}

.tab-btn--active .tab-btn__badge {
  background: var(--brand-yellow-bg, #fff9e6);
  border-color: rgba(245, 196, 0, 0.3);
  color: var(--text-main, #1c1a17);
}

.tab-panel {
  outline: none;
}

/* ============ 工具栏 ============ */
.toolbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-line, #ede8df);
  background: var(--bg-card, #ffffff);
  flex-wrap: wrap;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.search-input-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.search-lens {
  position: absolute;
  left: 8px;
  color: var(--text-muted, #948e85);
  pointer-events: none;
}

.input-text {
  height: 30px;
  padding: 0 26px 0 26px;
  border-radius: 6px;
  border: 1px solid var(--border-line, #ede8df);
  background: var(--bg-card, #ffffff);
  color: var(--text-main, #1c1a17);
  font-size: 12.5px;
  outline: none;
  transition: border-color 0.15s ease;
  width: 210px;
  font-family: inherit;
}

.input-text:focus {
  border-color: var(--brand-yellow, #f5c400);
  box-shadow: 0 0 0 2px var(--brand-yellow-bg, #fff9e6);
}

.clear-btn {
  position: absolute;
  right: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted, #948e85);
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
}

.clear-btn:hover {
  color: var(--text-main, #1c1a17);
}

.select-dropdown {
  height: 30px;
  padding: 0 24px 0 10px;
  border-radius: 6px;
  border: 1px solid var(--border-line, #ede8df);
  background-color: var(--bg-card, #ffffff);
  color: var(--text-main, #1c1a17);
  font-size: 12px;
  outline: none;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--text-muted, #948e85) 50%),
    linear-gradient(135deg, var(--text-muted, #948e85) 50%, transparent 50%);
  background-position: calc(100% - 13px) center, calc(100% - 8px) center;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  transition: border-color 0.15s ease;
  font-family: inherit;
}

.select-dropdown:focus {
  border-color: var(--brand-yellow, #f5c400);
  box-shadow: 0 0 0 2px var(--brand-yellow-bg, #fff9e6);
}

.select-dropdown-sm {
  height: 24px;
  padding: 0 18px 0 6px;
  border-radius: 4px;
  border: 1px solid var(--border-line, #ede8df);
  background: var(--bg-card, #ffffff);
  color: var(--text-main, #1c1a17);
  font-size: 11.5px;
  outline: none;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
  background-image:
    linear-gradient(45deg, transparent 50%, var(--text-muted, #948e85) 50%),
    linear-gradient(135deg, var(--text-muted, #948e85) 50%, transparent 50%);
  background-position: calc(100% - 10px) center, calc(100% - 6px) center;
  background-size: 4px 4px, 4px 4px;
  background-repeat: no-repeat;
}

.density-label {
  font-size: 12px;
  color: var(--text-muted, #948e85);
}

.density-switch {
  display: inline-flex;
  align-items: center;
  background: var(--bg-subtle, #faf8f5);
  border: 1px solid var(--border-line, #ede8df);
  border-radius: 6px;
  padding: 2px;
}

.density-btn {
  border: none;
  background: transparent;
  padding: 3px 8px;
  font-size: 11.5px;
  color: var(--text-secondary, #706b65);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.density-btn.active {
  background: #ffffff;
  color: var(--text-main, #1c1a17);
  font-weight: 500;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.btn-brand {
  background: var(--brand-yellow, #f5c400) !important;
  color: #1c1a17 !important;
  border: 1px solid rgba(0, 0, 0, 0.1) !important;
  font-weight: 600 !important;
  cursor: pointer;
}

.btn-brand:hover:not(:disabled) {
  filter: brightness(0.96);
}

.btn-brand:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ============ 选品提示条 ============ */
.selection-status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 16px;
  background: var(--brand-yellow-bg, #fff9e6);
  border-bottom: 1px solid rgba(245, 196, 0, 0.25);
  font-size: 12px;
}

.brand-text {
  color: var(--text-main, #1c1a17);
  font-weight: 600;
}

.selection-quick-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-link {
  border: none;
  background: transparent;
  color: var(--text-main, #1c1a17);
  font-size: 12px;
  text-decoration: underline;
  cursor: pointer;
  padding: 0;
}

.action-link:hover {
  color: #000000;
}

.sep-dot {
  color: var(--text-muted, #948e85);
}

/* ============ 表格与行高规范 ============ */
.table-responsive {
  width: 100%;
  overflow-x: auto;
}

.seline-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
  text-align: left;
}

/* 紧凑表格头约 34px */
.seline-table th {
  background: var(--bg-subtle, #faf8f5);
  color: var(--text-secondary, #706b65);
  font-weight: 500;
  padding: 6px 12px;
  height: 34px;
  box-sizing: border-box;
  border-bottom: 1px solid var(--border-line, #ede8df);
  white-space: nowrap;
  user-select: none;
  font-size: 12px;
}

.seline-table th.sortable {
  cursor: pointer;
}

.seline-table th.sortable:hover {
  color: var(--text-main, #1c1a17);
  background: var(--bg-hover, #f2efe9);
}

.sort-icon {
  font-size: 10px;
  opacity: 0.7;
}

/* 默认模式：行高 64-72px */
.seline-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-line, #ede8df);
  color: var(--text-main, #1c1a17);
  vertical-align: middle;
  transition: background 0.1s ease;
  box-sizing: border-box;
}

.seline-table tr:hover td {
  background: var(--bg-subtle, #faf8f5);
}

.tr--selected td {
  background: rgba(245, 196, 0, 0.06) !important;
}

/* 紧凑模式：行高 52-58px */
.seline-table.density-compact th {
  height: 28px;
  padding: 4px 10px;
  font-size: 11.5px;
}

.seline-table.density-compact td {
  padding: 4px 10px;
  font-size: 11.5px;
}

.seline-table.density-compact .product-thumb {
  width: 44px;
  height: 44px;
  min-width: 44px;
}

.row-check {
  cursor: pointer;
  accent-color: var(--brand-yellow, #f5c400);
}

/* ============ 商品图片 48px ============ */
.product-thumb {
  width: 48px;
  height: 48px;
  min-width: 48px;
  border-radius: 6px;
  border: 1px solid var(--border-line, #ede8df);
  background: var(--bg-subtle, #faf8f5);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.product-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.product-thumb-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted, #948e85);
}

/* ============ 商品信息与防撑高 ============ */
.product-info-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-width: 320px;
}

.product-name {
  font-size: 13px;
  color: var(--text-main, #1c1a17);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.3;
}

.product-sku {
  font-size: 11px;
  color: var(--text-muted, #948e85);
  font-family: ui-monospace, SFMono-Regular, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.2;
}

.product-price {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main, #1c1a17);
  white-space: nowrap;
}

.cell-ellipsis {
  max-width: 140px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.nowrap {
  white-space: nowrap;
}

/* ============ 药丸标签 ============ */
.pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
  background: var(--bg-subtle, #faf8f5);
  border: 1px solid var(--border-line, #ede8df);
  color: var(--text-secondary, #706b65);
  white-space: nowrap;
}

.pill-yellow {
  background: var(--brand-yellow-bg, #fff9e6);
  border-color: rgba(245, 196, 0, 0.4);
  color: #8c6d00;
}

/* ============ 行内操作按钮 ============ */
.cell-actions-wrap {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  justify-content: flex-end;
}

.action-btn {
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid var(--border-line, #ede8df);
  background: var(--bg-card, #ffffff);
  color: var(--text-secondary, #706b65);
  font-size: 11.5px;
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  transition: all 0.12s ease;
  font-family: inherit;
}

.action-btn:hover {
  color: var(--text-main, #1c1a17);
  background: var(--bg-hover, #f2efe9);
  border-color: rgba(0, 0, 0, 0.15);
}

.action-btn--brand {
  background: var(--brand-yellow-bg, #fff9e6);
  border-color: rgba(245, 196, 0, 0.4);
  color: #735900;
  font-weight: 500;
}

.action-btn--brand:hover {
  background: var(--brand-yellow, #f5c400);
  color: #1c1a17;
}

/* ============ 分页底栏 ============ */
.table-footer {
  padding: 10px 16px;
  border-top: 1px solid var(--border-line, #ede8df);
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--bg-card, #ffffff);
  font-size: 12px;
  color: var(--text-muted, #948e85);
  flex-wrap: wrap;
  gap: 12px;
}

.pagination-summary {
  font-size: 12px;
}

.filter-count-badge {
  color: var(--text-secondary, #706b65);
  font-size: 11.5px;
}

.page-controls {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.page-size-wrap {
  display: inline-flex;
  align-items: center;
}

.page-nav-btn {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: 1px solid var(--border-line, #ede8df);
  background: var(--bg-card, #ffffff);
  color: var(--text-main, #1c1a17);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.12s ease;
}

.page-nav-btn:hover:not(:disabled) {
  background: var(--bg-subtle, #faf8f5);
  border-color: rgba(0, 0, 0, 0.15);
}

.page-nav-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.page-current {
  min-width: 20px;
  text-align: center;
  font-weight: 600;
  color: var(--text-main, #1c1a17);
  font-family: ui-monospace, SFMono-Regular, monospace;
}

/* ============ 空白态与骨架屏 ============ */
.blank-container {
  padding: 48px 16px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.skeleton {
  width: 100%;
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}

.skeleton__row {
  height: 16px;
  border-radius: 4px;
  background: linear-gradient(90deg, #ede8df 25%, #f7f5f0 37%, #ede8df 63%);
  background-size: 400% 100%;
  animation: skeleton-glow 1.4s ease infinite;
}

@keyframes skeleton-glow {
  0% {
    background-position: 100% 50%;
  }
  100% {
    background-position: 0 50%;
  }
}

.spin-icon {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.text-muted {
  color: var(--text-muted, #948e85);
}

.warning-list {
  margin: 0;
  padding-left: 18px;
}

.note__text {
  font-size: 12px;
  color: var(--text-muted, #948e85);
  margin: 4px 0 0;
}
</style>
