<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import Callout from '../components/Callout.vue'
import EmptyState from '../components/EmptyState.vue'
import AppModal from '../components/AppModal.vue'
import {
  PhArrowsClockwise,
  PhCaretLeft,
  PhCaretRight,
  PhInfo,
  PhPlus,
  PhX,
} from '@phosphor-icons/vue'
import { useBridgeController } from '../composables/useBridgeController'
import type { PageId } from '../data/navigation'
import {
  appendKeywordTag,
  buildBatchCapturePayloads,
  CAPTURE_LIMITS,
  defaultCaptureForm,
  formatTaskDuration,
  formatTaskValidCount,
  isKeywordSelected,
  paginateTasks,
  parseKeywordTags,
  toCaptureTaskView,
  type CaptureFormErrors,
  type CaptureFormField,
  type CaptureTaskView,
} from '../features/capture/capture-format'
import {
  CAPTURE_EVENTS,
  CaptureController,
  type CaptureState,
} from '../features/capture/capture-controller'
import type { CapturePayload } from '../features/contracts'

const emit = defineEmits<{ navigate: [page: PageId]; diagnostics: [] }>()

const { state, controller } = useBridgeController<CaptureState, CaptureController>({
  events: CAPTURE_EVENTS,
  create: (api) => new CaptureController({ api }),
})

const available = computed(() => state.value.availability === 'ready')
const views = computed(() => state.value.tasks.items.map(toCaptureTaskView))
const selected = computed(() => views.value.find((view) => view.id === state.value.selectedId) ?? null)
const selectedAction = computed(() => (selected.value ? (state.value.actions[selected.value.id] ?? null) : null))
const creating = computed(() => state.value.create.phase === 'running')
const hasActive = computed(() => views.value.some((view) => view.status === 'running' || view.status === 'pending'))

// 表单展开/收起状态（默认展开）
const formCollapsed = ref(false)

const form = reactive(defaultCaptureForm())
const keywordInput = ref('')
const inputFocused = ref(false)
const detailOpen = ref(false)
const errors = ref<CaptureFormErrors>({})
const confirmCancelId = ref<string | null>(null)
const taskKeywordInputRef = ref<HTMLInputElement | null>(null)
const keywordFieldWrapRef = ref<HTMLElement | null>(null)

// 批量提交与失败重试管理
const isSubmitting = ref(false)
const failedKeywords = ref<string[]>([])
const failedPayloadSnapshots = ref<CapturePayload[]>([])
const failureMessage = ref('')

// 运行中任务耗时每秒刷新
const nowTick = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)
  document.addEventListener('click', handleOutsideClick)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
  document.removeEventListener('click', handleOutsideClick)
})

// 用户编辑标签或输入时，如果不再与失败词集合匹配，重置重试状态，避免新建误标为重试
watch(
  () => [form.keywords?.join(','), keywordInput.value],
  () => {
    if (failedPayloadSnapshots.value.length > 0) {
      const currentTags = (form.keywords ?? []).slice().sort().join(',')
      const failedTags = failedKeywords.value.slice().sort().join(',')
      if (currentTags !== failedTags || keywordInput.value.trim() !== '') {
        failedPayloadSnapshots.value = []
        failureMessage.value = ''
      }
    }
  },
)

const isRetryMode = computed(() => {
  return failedPayloadSnapshots.value.length > 0 && failedKeywords.value.length > 0
})

/** 提交按钮防重复提交 */
const submitDisabled = computed(() => !available.value || isSubmitting.value || creating.value)
const submitLabel = computed(() => {
  if (isSubmitting.value) return '正在创建任务…'
  if (isRetryMode.value) {
    return `重试失败项 (${failedPayloadSnapshots.value.length})`
  }
  return '创建任务'
})

// 流量词建议（suggest）相关状态与热门词备选
const showSuggestDropdown = ref(false)

const POPULAR_KEYWORDS: readonly { word: string; hot: string }[] = [
  { word: 'Sony A7M4', hot: '4.8w' },
  { word: '富士 X-T5', hot: '4.2w' },
  { word: '佳能 EOS R6', hot: '3.9w' },
  { word: '索尼 A7C II', hot: '3.7w' },
  { word: '尼康 Z6 III', hot: '3.5w' },
  { word: '大疆 Pocket 3', hot: '4.5w' },
  { word: '理光 GR3', hot: '3.6w' },
  { word: '佳能 G7X3', hot: '3.8w' },
  { word: '富士 X100V', hot: '4.1w' },
  { word: '适马 24-70', hot: '2.9w' },
  { word: '索尼 24-70 GM2', hot: '3.2w' },
  { word: '腾龙 28-200', hot: '2.7w' },
]

/**
 * 下拉展示项：优先展示后台实时返回词（通过 CAPTURE_SUGGEST_WORDS 查询），
 * 与热门流量词合并并根据当前输入进行过滤。
 */
const displayedSuggestItems = computed(() => {
  const query = keywordInput.value.trim().toLowerCase()
  const remoteWords = state.value.suggest.words || []

  const itemMap = new Map<string, { word: string; hot?: string }>()

  // 1. 优先放入后台真实返回词
  for (const rw of remoteWords) {
    const trimmed = rw.trim()
    if (trimmed && !itemMap.has(trimmed)) {
      itemMap.set(trimmed, { word: trimmed, hot: '实时' })
    }
  }

  // 2. 补充 Seline 内置热门流量词
  for (const pop of POPULAR_KEYWORDS) {
    if (!itemMap.has(pop.word)) {
      itemMap.set(pop.word, pop)
    }
  }

  const allItems = Array.from(itemMap.values())
  if (!query) {
    return allItems
  }
  return allItems.filter((item) => item.word.toLowerCase().includes(query))
})

/** 判断某个关键词是否已被选（用于打标记和去重，委托给生产 helper） */
function checkKeywordSelected(word: string): boolean {
  return isKeywordSelected(word, form.keywords ?? [])
}

/** 任务状态 Tab 过滤 */
type TaskStatusFilter = 'all' | 'waiting' | 'running' | 'paused' | 'done' | 'failed' | 'canceled'
const statusFilter = ref<TaskStatusFilter>('all')

const statusTabItems: readonly { status: TaskStatusFilter; label: string }[] = [
  { status: 'all', label: '全部' },
  { status: 'waiting', label: '等待开始' },
  { status: 'running', label: '采集中' },
  { status: 'paused', label: '已暂停' },
  { status: 'done', label: '已完成' },
  { status: 'failed', label: '失败' },
  { status: 'canceled', label: '已取消' },
]

const filteredViews = computed(() => {
  return views.value.filter((view) => {
    if (statusFilter.value === 'all') return true
    if (statusFilter.value === 'waiting') return view.status === 'pending'
    if (statusFilter.value === 'running') return view.status === 'running'
    if (statusFilter.value === 'paused') return view.status === 'paused'
    if (statusFilter.value === 'done') return view.status === 'completed'
    if (statusFilter.value === 'failed') return view.status === 'failed'
    if (statusFilter.value === 'canceled') return view.status === 'cancelled'
    return true
  })
})

// 任务历史分页状态
const historyPage = ref(1)
const historyPageSize = ref(20)

const pagination = computed(() => paginateTasks(filteredViews.value, historyPage.value, historyPageSize.value))
const pagedViews = computed(() => pagination.value.pagedItems)
const paging = computed(() => pagination.value.paging)

watch(
  () => [filteredViews.value.length, historyPageSize.value, statusFilter.value],
  () => {
    historyPage.value = Math.min(
      historyPage.value,
      Math.max(1, Math.ceil(filteredViews.value.length / historyPageSize.value)),
    )
  },
)

const FIELD_ORDER: readonly CaptureFormField[] = [
  'keyword',
  'startPage',
  'pages',
  'rowsPerPage',
  'minWantCnt',
  'minPrice',
  'maxPrice',
  'baseIntervalSec',
  'randomIntervalSec',
]

function focusField(field: CaptureFormField): void {
  if (field === 'keyword') {
    taskKeywordInputRef.value?.focus()
  } else {
    document.getElementById(`capture-${field}`)?.focus()
  }
}

/** 将当前输入框中的内容解析并追加到关键词标签中（使用生产 helper） */
function addCurrentInputTag(explicitText?: string): void {
  const raw = (explicitText !== undefined ? explicitText : (keywordInput.value || '')).trim()
  if (!raw) return
  const result = appendKeywordTag(raw, form.keywords ?? [])
  form.keywords = result.tags
  if (result.error) {
    errors.value.keyword = result.error
  } else {
    keywordInput.value = ''
    errors.value.keyword = undefined
  }
}

/** 删除指定索引的标签 */
function removeTag(index: number): void {
  if (!form.keywords) return
  form.keywords.splice(index, 1)
  if (form.keywords.length === 0 && !keywordInput.value.trim()) {
    errors.value.keyword = '请输入搜索关键词'
  } else {
    const parsed = parseKeywordTags([], form.keywords)
    errors.value.keyword = parsed.error
  }
}

/** 输入框键盘事件：退格删除末尾标签，逗号/顿号快捷加入；中文输入中（isComposing）不确认 */
function onInputKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  if (e.key === 'Backspace' && !keywordInput.value && form.keywords && form.keywords.length > 0) {
    removeTag(form.keywords.length - 1)
    return
  }
  if (e.key === ',' || e.key === '，' || e.key === '、') {
    e.preventDefault()
    addCurrentInputTag()
  } else if (e.key === 'Escape') {
    closeSuggest()
  }
}

function onEnterKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  addCurrentInputTag()
}

/** 粘贴处理：保留当前已有输入，支持换行与逗号分隔 */
function onInputPaste(e: ClipboardEvent): void {
  const text = e.clipboardData?.getData('text') ?? ''
  if (/[,，、\r\n]/.test(text)) {
    e.preventDefault()
    const currentVal = keywordInput.value || ''
    const combined = currentVal ? `${currentVal},${text}` : text
    const parsed = parseKeywordTags(combined, form.keywords ?? [])
    form.keywords = parsed.tags
    if (parsed.error) {
      errors.value.keyword = parsed.error
    } else {
      keywordInput.value = ''
      errors.value.keyword = undefined
    }
  }
}

/** 关键词输入触发 300ms debounce 查询当前输入词的真实流量词（CAPTURE_SUGGEST_WORDS） */
function onKeywordInput(e?: Event): void {
  if ((e as unknown as { isComposing?: boolean })?.isComposing) return
  const currentVal = keywordInput.value
  if (/[,，、\r\n]/.test(currentVal)) {
    addCurrentInputTag(currentVal)
    return
  }
  const trimmed = currentVal.trim()
  showSuggestDropdown.value = true
  if (!trimmed) {
    controller.clearSuggest()
    return
  }
  void controller.fetchSuggest(trimmed, { immediate: false })
}

/** 输入框聚焦时展示建议下拉 */
function onInputFocus(): void {
  inputFocused.value = true
  showSuggestDropdown.value = true
  const trimmed = keywordInput.value.trim()
  if (trimmed && available.value) {
    void controller.fetchSuggest(trimmed, { immediate: true })
  }
}

/** 点击容器聚焦输入框 */
function focusKeywordInput(): void {
  taskKeywordInputRef.value?.focus()
}

/** 切换建议下拉展开/收起 */
function toggleSuggest(): void {
  showSuggestDropdown.value = !showSuggestDropdown.value
  if (showSuggestDropdown.value) {
    nextTick(() => {
      taskKeywordInputRef.value?.focus()
    })
    const trimmed = keywordInput.value.trim()
    if (trimmed && available.value) {
      void controller.fetchSuggest(trimmed, { immediate: true })
    }
  }
}

/**
 * 点选建议词：
 * - 委托生产 helper appendKeywordTag 处理去重与上限校验；
 * - 逐个添加后保持下拉展开，绝不关闭！
 * - 严格去重，已选标记打勾；
 * - 焦点支持：选词后重新聚焦输入框；
 * - 建议只走 CAPTURE_SUGGEST_WORDS，绝不触发任务创建！
 */
function onSelectSuggestItem(word: string): void {
  const result = appendKeywordTag(word, form.keywords ?? [])
  form.keywords = result.tags
  errors.value.keyword = result.error

  // 关键：下拉逐个添加后保持展开
  showSuggestDropdown.value = true

  // 聚焦支持
  nextTick(() => {
    taskKeywordInputRef.value?.focus()
  })
}

function closeSuggest(): void {
  showSuggestDropdown.value = false
}

/** 点击外部关闭建议下拉 */
function handleOutsideClick(e: MouseEvent): void {
  if (keywordFieldWrapRef.value && !keywordFieldWrapRef.value.contains(e.target as Node)) {
    closeSuggest()
  }
}

function prevHistoryPage(): void {
  if (paging.value.hasPrev) historyPage.value--
}

function nextHistoryPage(): void {
  if (paging.value.hasNext) historyPage.value++
}

function resetForm(): void {
  failedKeywords.value = []
  failedPayloadSnapshots.value = []
  failureMessage.value = ''
  form.keywords = []
  form.keyword = ''
  keywordInput.value = ''
  form.startPage = '1'
  form.pages = '5'
  form.rowsPerPage = '30'
  form.minWantCnt = '0'
  form.minPrice = ''
  form.maxPrice = ''
  form.baseIntervalSec = '3'
  form.randomIntervalSec = '2'
  form.onlyFreeShip = false
  form.fetchDetail = false
  errors.value = {}
  closeSuggest()
}

function openTaskDetail(id: string): void {
  controller.select(id)
  detailOpen.value = true
}

async function submit(): Promise<void> {
  if (submitDisabled.value) return

  // 重试模式：只使用原失败 payload 快照进行重试，不重复发成功项，也不受表单中途修改影响
  if (isRetryMode.value) {
    isSubmitting.value = true
    failureMessage.value = ''
    const retryPayloads = [...failedPayloadSnapshots.value]
    const batchResult = await controller.createBatchTasks(retryPayloads)
    isSubmitting.value = false

    if (batchResult.failures.length === 0) {
      resetForm()
      historyPage.value = 1
    } else {
      failedKeywords.value = batchResult.failures.map((f) => f.keyword)
      failedPayloadSnapshots.value = retryPayloads.filter((p) =>
        failedKeywords.value.includes(p.keyword),
      )
      failureMessage.value = `重试仍有 ${failedKeywords.value.length} 个任务失败：${failedKeywords.value.join('、')}。已保留成功项。`
    }
    return
  }

  // 新建模式：合并当前已输入词并校验
  form.keywordInput = keywordInput.value
  const result = buildBatchCapturePayloads(form)
  if (!result.ok) {
    errors.value = result.errors
    await nextTick()
    const first = FIELD_ORDER.find((field) => result.errors[field])
    if (first) focusField(first)
    return
  }

  errors.value = {}
  closeSuggest()
  keywordInput.value = ''
  isSubmitting.value = true
  failureMessage.value = ''

  // 批量依次按词调用 CAPTURE_CREATE 命令
  const batchResult = await controller.createBatchTasks(result.payloads)
  isSubmitting.value = false

  if (batchResult.failures.length === 0) {
    // 全部成功：清空表单关键词，不自动打开详情
    form.keywords = []
    form.keyword = ''
    failedKeywords.value = []
    failedPayloadSnapshots.value = []
    historyPage.value = 1
  } else {
    // 部分或全部失败：保存失败 payload 快照与失败词，表单仅保留失败词供重试
    failedKeywords.value = batchResult.failures.map((f) => f.keyword)
    failedPayloadSnapshots.value = result.payloads.filter((p) =>
      failedKeywords.value.includes(p.keyword),
    )
    form.keywords = [...failedKeywords.value]
    failureMessage.value = `以下 ${failedKeywords.value.length} 个关键词创建失败：${failedKeywords.value.join('、')}。已保留成功任务，点击重试将仅提交失败项。`
  }
}

function formatTime(timestamp: number | null): string {
  if (!timestamp) return '—'
  const d = new Date(timestamp)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${m}-${day} ${h}:${min}`
}

function formatBreakpoint(view: CaptureTaskView | null): string {
  if (!view) return '暂无'
  if (view.nextPage !== null) return `第 ${view.nextPage} 页`
  if (view.status === 'completed') return '已完成'
  if (view.status === 'pending') return '未开始'
  return '暂无'
}

function isActionBusy(taskId: string): boolean {
  return state.value.actions[taskId]?.phase === 'running'
}

async function runAction(kind: 'pause' | 'resume' | 'cancel', taskId: string): Promise<void> {
  if (kind === 'cancel') confirmCancelId.value = null
  await controller.act(kind, taskId)
}

/** 单条任务重试失败项 */
async function retrySingleTask(view: CaptureTaskView): Promise<void> {
  if (!available.value || isActionBusy(view.id)) return
  const payload: CapturePayload = {
    keyword: view.keyword,
    fetchDetail: view.fetchDetail,
    startPage: 1,
    pages: view.totalPages ?? 5,
  }
  await controller.createTask(payload)
}

function openCreateForm(): void {
  formCollapsed.value = false
  nextTick(() => {
    taskKeywordInputRef.value?.focus()
  })
}
</script>

<template>
  <div class="page seline-collect-page">
    <Callout v-if="state.realtimeError" tone="warn">{{ state.realtimeError }}</Callout>

    <!-- 顶部标题组与工具栏 -->
    <div class="view-header">
      <div class="view-title-group">
        <h1 class="view-title">采集任务</h1>
        <span class="view-sub">创建关键词采集任务、跟踪进度与查看任务详情</span>
      </div>
      <div class="header-actions">
        <button
          type="button"
          class="btn btn--icon"
          title="刷新任务列表"
          aria-label="刷新任务列表"
          :disabled="!available || state.tasks.refreshing"
          @click="controller.refresh()"
        >
          <PhArrowsClockwise :size="16" :class="{ 'spin-icon': state.tasks.refreshing }" />
        </button>
        <button
          type="button"
          class="btn btn--primary"
          :disabled="!available"
          @click="openCreateForm"
        >
          <PhPlus :size="15" />
          <span>新建任务</span>
        </button>
      </div>
    </div>

    <!-- 1. 创建任务卡片（Seline 纸白卡细线可折叠） -->
    <div class="card feature-card">
      <div class="card-header">
        <div class="card-title-wrap">
          <span class="card-title">创建采集任务</span>
          <span class="card-caption">采集参数与流量词选择</span>
        </div>
        <button
          type="button"
          class="btn btn--sm"
          id="toggle-task-form"
          @click="formCollapsed = !formCollapsed"
        >
          {{ formCollapsed ? '展开表单' : '收起表单' }}
        </button>
      </div>

      <div v-show="!formCollapsed" class="collapse-panel" id="task-form-panel">
        <div class="card-body">
          <form class="form" novalidate @submit.prevent="submit">
            <div class="form-grid">
              <!-- 关键词/流量词标签与下拉 -->
              <div ref="keywordFieldWrapRef" class="form-field span-full keyword-field-wrap">
                <div class="field-label-row">
                  <label class="form-label" for="task-keyword-input">
                    关键词 / 流量词（多选，上限 {{ CAPTURE_LIMITS.maxKeywords }} 词）
                  </label>
                  <button
                    type="button"
                    class="btn-text-action"
                    id="toggle-suggest-btn"
                    @click.stop="toggleSuggest"
                  >
                    常用流量词建议 ▾
                  </button>
                </div>

                <div
                  class="tag-input-container"
                  id="keyword-tag-container"
                  :class="{ 'is-focused': inputFocused, 'has-error': !!errors.keyword }"
                  tabindex="0"
                  @click="focusKeywordInput"
                >
                  <div class="tag-list" id="keyword-tag-list">
                    <span
                      v-for="(tag, idx) in form.keywords"
                      :key="tag"
                      class="tag-chip"
                    >
                      <span>{{ tag }}</span>
                      <button
                        type="button"
                        class="tag-remove"
                        :aria-label="`移除 ${tag}`"
                        @click.stop="removeTag(idx)"
                      >
                        ×
                      </button>
                    </span>
                  </div>

                  <input
                    ref="taskKeywordInputRef"
                    id="task-keyword-input"
                    type="text"
                    class="tag-input-field"
                    v-model="keywordInput"
                    placeholder="输入关键词按 Enter 添加，或点选建议词..."
                    autocomplete="off"
                    @focus="onInputFocus"
                    @blur="inputFocused = false"
                    @input="onKeywordInput"
                    @keydown="onInputKeydown"
                    @keydown.enter.prevent="onEnterKeydown"
                    @paste="onInputPaste"
                  />
                </div>

                <span
                  v-if="errors.keyword"
                  id="capture-keyword-error"
                  class="field__error"
                  role="alert"
                >
                  {{ errors.keyword }}
                </span>

                <!-- 热门流量词建议下拉浮层 -->
                <div
                  v-show="showSuggestDropdown"
                  class="suggest-dropdown"
                  id="keyword-suggest-dropdown"
                  role="listbox"
                  @click.stop
                >
                  <div class="suggest-header">
                    <span>热门流量词建议（点击可连续添加）</span>
                    <div class="suggest-header-right">
                      <span class="suggest-hint">Esc 或点击外部关闭</span>
                      <button
                        type="button"
                        class="suggest-close-btn"
                        aria-label="关闭建议"
                        @click.stop="closeSuggest"
                      >
                        <PhX :size="13" />
                      </button>
                    </div>
                  </div>

                  <div class="suggest-items-grid" id="suggest-items-container">
                    <div
                      v-for="item in displayedSuggestItems"
                      :key="item.word"
                      class="suggest-item"
                      :class="{ 'is-selected': checkKeywordSelected(item.word) }"
                      role="option"
                      tabindex="0"
                      :aria-selected="checkKeywordSelected(item.word)"
                      @click.stop="onSelectSuggestItem(item.word)"
                      @keydown.enter.prevent.stop="onSelectSuggestItem(item.word)"
                      @keydown.space.prevent.stop="onSelectSuggestItem(item.word)"
                    >
                      <span class="suggest-word-text">{{ item.word }}</span>
                      <span v-if="checkKeywordSelected(item.word)" class="suggest-check-mark">✓</span>
                      <span v-else-if="item.hot" class="suggest-hot-tag">{{ item.hot }}</span>
                    </div>

                    <div v-if="displayedSuggestItems.length === 0" class="suggest-empty-tip">
                      按 Enter 可添加「{{ keywordInput.trim() }}」作为自定义关键词
                    </div>
                  </div>
                </div>
              </div>

              <!-- 参数字段 -->
              <div class="form-field">
                <label class="form-label" for="task-start-page">起始页</label>
                <input
                  id="task-start-page"
                  v-model="form.startPage"
                  class="form-input"
                  type="number"
                  min="1"
                  placeholder="1"
                />
                <span v-if="errors.startPage" class="field__error">{{ errors.startPage }}</span>
              </div>

              <div class="form-field">
                <label class="form-label" for="task-pages">采集页数</label>
                <input
                  id="task-pages"
                  v-model="form.pages"
                  class="form-input"
                  type="number"
                  min="1"
                  max="100"
                  placeholder="5"
                />
                <span v-if="errors.pages" class="field__error">{{ errors.pages }}</span>
              </div>

              <div class="form-field">
                <label class="form-label" for="task-page-size">每页条数</label>
                <input
                  id="task-page-size"
                  v-model="form.rowsPerPage"
                  class="form-input"
                  type="number"
                  min="1"
                  max="30"
                  placeholder="30"
                />
                <span v-if="errors.rowsPerPage" class="field__error">{{ errors.rowsPerPage }}</span>
              </div>

              <div class="form-field">
                <label class="form-label" for="task-min-wants">最低想要数</label>
                <input
                  id="task-min-wants"
                  v-model="form.minWantCnt"
                  class="form-input"
                  type="number"
                  min="0"
                  placeholder="0"
                />
                <span v-if="errors.minWantCnt" class="field__error">{{ errors.minWantCnt }}</span>
              </div>

              <div class="form-field">
                <label class="form-label" for="task-price-min">最低价格</label>
                <input
                  id="task-price-min"
                  v-model="form.minPrice"
                  class="form-input"
                  type="number"
                  min="0"
                  placeholder="¥"
                />
                <span v-if="errors.minPrice" class="field__error">{{ errors.minPrice }}</span>
              </div>

              <div class="form-field">
                <label class="form-label" for="task-price-max">最高价格</label>
                <input
                  id="task-price-max"
                  v-model="form.maxPrice"
                  class="form-input"
                  type="number"
                  min="0"
                  placeholder="¥"
                />
                <span v-if="errors.maxPrice" class="field__error">{{ errors.maxPrice }}</span>
              </div>

              <div class="form-field">
                <label class="form-label" for="task-base-interval">基础间隔（秒）</label>
                <input
                  id="task-base-interval"
                  v-model="form.baseIntervalSec"
                  class="form-input"
                  type="number"
                  min="0"
                  step="0.5"
                  placeholder="3"
                />
                <span v-if="errors.baseIntervalSec" class="field__error">{{ errors.baseIntervalSec }}</span>
              </div>

              <div class="form-field">
                <label class="form-label" for="task-random-interval">随机间隔（秒）</label>
                <input
                  id="task-random-interval"
                  v-model="form.randomIntervalSec"
                  class="form-input"
                  type="number"
                  min="0"
                  step="0.5"
                  placeholder="2"
                />
                <span v-if="errors.randomIntervalSec" class="field__error">{{ errors.randomIntervalSec }}</span>
              </div>

              <div class="form-field form-field--check">
                <span class="form-label">仅包邮</span>
                <label class="form-check">
                  <input id="task-free-shipping" v-model="form.onlyFreeShip" type="checkbox" />
                  <span>仅采集包邮商品</span>
                </label>
              </div>

              <div class="form-field form-field--check">
                <span class="form-label">采集详情</span>
                <div class="check-with-tooltip">
                  <label class="form-check">
                    <input id="task-fetch-detail" v-model="form.fetchDetail" type="checkbox" />
                    <span>采集商品详情页</span>
                  </label>
                  <span class="info-tip-wrap" tabindex="0" title="开启后会按顺序额外进入商品详情页，采集完整描述与图片">
                    <PhInfo :size="14" class="info-icon" />
                  </span>
                </div>
              </div>
            </div>

            <!-- 批量错误与重试提示 -->
            <Callout v-if="failureMessage" tone="error" class="form-callout">
              {{ failureMessage }}
            </Callout>
            <Callout
              v-else-if="state.create.phase === 'failed' && state.create.error"
              tone="error"
              :view="state.create.error"
              class="form-callout"
            />

            <!-- 底部提交与重置按钮 -->
            <div class="form-actions">
              <button
                id="create-task-btn"
                type="submit"
                class="btn btn--primary"
                :disabled="submitDisabled"
              >
                {{ submitLabel }}
              </button>
              <button
                id="reset-task-form-btn"
                type="button"
                class="btn"
                :disabled="isSubmitting"
                @click="resetForm"
              >
                重置
              </button>
              <span v-if="hasActive && available" class="subtle-tip">
                已有任务进行中，新任务将按队列依次执行。
              </span>
            </div>
          </form>
        </div>
      </div>
    </div>

    <!-- 2. 采集任务列表卡片（Seline 纸白卡细线黄色轻标题紧凑表） -->
    <div class="card">
      <div class="card-header">
        <div class="card-title-wrap">
          <span class="card-title">采集任务列表</span>
          <span class="card-caption">任务执行流水</span>
        </div>

        <!-- 任务状态筛选 Tabs -->
        <div class="tabs" id="task-status-tabs" role="tablist" aria-label="任务状态筛选">
          <button
            v-for="item in statusTabItems"
            :key="item.status"
            type="button"
            class="tab-btn"
            :class="{ active: statusFilter === item.status }"
            role="tab"
            :aria-selected="statusFilter === item.status"
            @click="statusFilter = item.status"
          >
            {{ item.label }}
          </button>
        </div>
      </div>

      <!-- 表格内容 -->
      <div v-if="!available" class="blank-container">
        <EmptyState title="未连接扩展" description="从扩展内页打开工作台后可查看采集任务。" />
      </div>

      <div
        v-else-if="state.tasks.phase === 'idle' || state.tasks.phase === 'loading'"
        class="blank-container"
        role="status"
      >
        <p class="muted">正在读取任务列表…</p>
      </div>

      <div v-else-if="state.tasks.phase === 'error'" class="blank-container">
        <Callout tone="error" :view="state.tasks.error">
          <template #actions>
            <button type="button" class="btn btn--sm" @click="controller.refresh()">重试</button>
          </template>
        </Callout>
      </div>

      <div v-else-if="views.length === 0" class="blank-container">
        <EmptyState
          title="暂无采集任务"
          description="在上方输入关键词创建新任务，采集进度与入库数据将实时展示在此。"
        />
      </div>

      <div v-else-if="filteredViews.length === 0" class="blank-container">
        <EmptyState title="无匹配状态的任务" description="当前状态分类下暂无任务，可切换其他状态分类查看。" />
      </div>

      <div v-else class="table-responsive">
        <table class="seline-table density-compact" aria-label="采集任务列表">
          <thead>
            <tr>
              <th scope="col">关键词</th>
              <th scope="col" style="width: 96px;">状态</th>
              <th scope="col" style="width: 160px;">进度</th>
              <th scope="col" style="width: 80px;">页码</th>
              <th scope="col" style="width: 74px;">已入库</th>
              <th scope="col" style="width: 70px;">失败数</th>
              <th scope="col" style="width: 120px;">更新时间</th>
              <th scope="col" style="width: 210px; text-align: right;">操作</th>
            </tr>
          </thead>
          <tbody id="task-tbody">
            <tr
              v-for="view in pagedViews"
              :key="view.id"
              :class="{ 'is-selected-row': view.id === selected?.id }"
            >
              <!-- 关键词 -->
              <td>
                <div class="keyword-cell">
                  <strong class="keyword-text" :title="view.keyword">{{ view.keyword || '（未命名）' }}</strong>
                  <span v-if="view.fetchDetail" class="detail-badge" title="同时采集商品详情">详情</span>
                </div>
              </td>

              <!-- 状态 pill -->
              <td>
                <span
                  class="pill"
                  :class="{
                    'pill-yellow': view.status === 'running' || view.status === 'paused',
                    'pill-green': view.status === 'completed',
                    'pill-red': view.status === 'failed',
                  }"
                >
                  {{ view.statusLabel }}
                </span>
              </td>

              <!-- 内联进度条 -->
              <td>
                <div class="progress-inline">
                  <div class="progress-bar-wrap">
                    <div
                      class="progress-bar-fill"
                      :class="{
                        success: view.status === 'completed',
                        danger: view.status === 'failed',
                      }"
                      :style="{ width: `${view.progress}%` }"
                    ></div>
                  </div>
                  <span class="progress-label mono">{{ view.progress }}%</span>
                </div>
              </td>

              <!-- 页码 -->
              <td class="mono">
                {{ view.pagesCompleted !== null && view.totalPages !== null ? `${view.pagesCompleted} / ${view.totalPages}` : '暂无' }}
              </td>

              <!-- 已入库 -->
              <td class="mono">
                {{ formatTaskValidCount(view) }}
              </td>

              <!-- 失败数 -->
              <td class="mono" :class="{ 'has-fail-count': (view.stats?.failed ?? 0) > 0 }">
                {{ view.stats?.failed ?? 0 }}
              </td>

              <!-- 更新时间 -->
              <td class="time-col">
                {{ formatTime(view.endedAt || view.startedAt || view.createdAt) }}
              </td>

              <!-- 操作按钮组 -->
              <td style="text-align: right;">
                <!-- 采集中：暂停、取消、查看详情 -->
                <template v-if="view.status === 'running'">
                  <button
                    type="button"
                    class="action-btn"
                    :disabled="isActionBusy(view.id)"
                    @click="runAction('pause', view.id)"
                  >
                    暂停
                  </button>
                  <button
                    type="button"
                    class="action-btn"
                    :disabled="isActionBusy(view.id)"
                    @click="runAction('cancel', view.id)"
                  >
                    取消
                  </button>
                </template>

                <!-- 已暂停：恢复、取消、查看详情 -->
                <template v-else-if="view.status === 'paused'">
                  <button
                    type="button"
                    class="action-btn"
                    :disabled="isActionBusy(view.id)"
                    @click="runAction('resume', view.id)"
                  >
                    恢复
                  </button>
                  <button
                    type="button"
                    class="action-btn"
                    :disabled="isActionBusy(view.id)"
                    @click="runAction('cancel', view.id)"
                  >
                    取消
                  </button>
                </template>

                <!-- 等待开始：取消、查看详情 -->
                <template v-else-if="view.status === 'pending'">
                  <button
                    type="button"
                    class="action-btn"
                    :disabled="isActionBusy(view.id)"
                    @click="runAction('cancel', view.id)"
                  >
                    取消
                  </button>
                </template>

                <!-- 已完成且有失败数：重试失败项、查看详情 -->
                <template v-else-if="view.status === 'completed' && (view.stats?.failed ?? 0) > 0">
                  <button
                    type="button"
                    class="action-btn"
                    :disabled="isActionBusy(view.id)"
                    @click="retrySingleTask(view)"
                  >
                    重试失败项
                  </button>
                </template>

                <!-- 失败：重试失败项、查看详情、取消 -->
                <template v-else-if="view.status === 'failed'">
                  <button
                    type="button"
                    class="action-btn"
                    :disabled="isActionBusy(view.id)"
                    @click="retrySingleTask(view)"
                  >
                    重试失败项
                  </button>
                  <button
                    v-if="view.canCancel"
                    type="button"
                    class="action-btn danger"
                    :disabled="isActionBusy(view.id)"
                    @click="runAction('cancel', view.id)"
                  >
                    取消
                  </button>
                </template>

                <!-- 查看详情按钮 -->
                <button
                  type="button"
                  class="action-btn"
                  @click="openTaskDetail(view.id)"
                >
                  查看详情
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- 底部分页栏 -->
        <div class="pagination-bar">
          <div class="pagination-info">
            共 <span class="mono">{{ paging.total }}</span> 条任务，第
            <span class="mono">{{ paging.page }}</span> /
            <span class="mono">{{ paging.totalPages }}</span> 页
          </div>
          <div class="pagination-actions">
            <select
              v-model="historyPageSize"
              class="form-select"
              aria-label="每页任务数量"
              @change="historyPage = 1"
            >
              <option :value="10">10 条/页</option>
              <option :value="20">20 条/页</option>
              <option :value="50">50 条/页</option>
            </select>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="!paging.hasPrev"
              aria-label="上一页"
              @click="prevHistoryPage"
            >
              <PhCaretLeft :size="14" />
            </button>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="!paging.hasNext"
              aria-label="下一页"
              @click="nextHistoryPage"
            >
              <PhCaretRight :size="14" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 3. 采集任务详情弹窗（严格对齐 Seline 详情弹窗，真实 state/stats，禁止虚构） -->
    <AppModal
      :open="detailOpen"
      :title="`采集任务详情 · ${selected?.keyword || '暂无'}`"
      @close="detailOpen = false"
    >
      <div v-if="!selected" class="detail-empty">
        <EmptyState title="未选择任务" description="请从列表选择一条任务查看详细数据。" />
      </div>

      <div v-else class="task-detail-content">
        <!-- 进度与时间信息 -->
        <div class="detail-header-card">
          <div class="dh-status-row">
            <span
              class="pill"
              :class="{
                'pill-yellow': selected.status === 'running' || selected.status === 'paused',
                'pill-green': selected.status === 'completed',
                'pill-red': selected.status === 'failed',
              }"
            >
              {{ selected.statusLabel }}
            </span>
            <span v-if="selected.fetchDetail" class="detail-badge">含商品详情</span>
            <span class="muted dh-time">创建于 {{ formatTime(selected.createdAt) }}</span>
          </div>

          <div class="dh-progress-row">
            <div class="progress-bar-wrap">
              <div
                class="progress-bar-fill"
                :class="{
                  success: selected.status === 'completed',
                  danger: selected.status === 'failed',
                }"
                :style="{ width: `${selected.progress}%` }"
              ></div>
            </div>
            <span class="progress-label mono">{{ selected.progress }}%</span>
          </div>
        </div>

        <!-- 真实 stats 键值对网格（Seline .key-value 布局，禁止虚构成功率与并发数） -->
        <div class="key-value">
          <div class="kv-key">已获取</div>
          <div class="kv-val mono">{{ selected.stats?.fetched ?? '暂无' }}</div>

          <div class="kv-key">有效</div>
          <div class="kv-val mono">{{ selected.stats?.valid ?? '暂无' }}</div>

          <div class="kv-key">被过滤</div>
          <div class="kv-val mono">{{ selected.stats?.filtered ?? '暂无' }}</div>

          <div class="kv-key">重复</div>
          <div class="kv-val mono">{{ selected.stats?.duplicates ?? '暂无' }}</div>

          <div class="kv-key">失败</div>
          <div class="kv-val mono">{{ selected.stats?.failed ?? '暂无' }}</div>

          <div class="kv-key">已入库</div>
          <div class="kv-val mono">{{ formatTaskValidCount(selected) }}</div>

          <div class="kv-key">页码进度</div>
          <div class="kv-val mono">
            {{ selected.pagesCompleted !== null && selected.totalPages !== null ? `${selected.pagesCompleted} / ${selected.totalPages}` : '暂无' }}
          </div>

          <div class="kv-key">下一页断点</div>
          <div class="kv-val">{{ formatBreakpoint(selected) }}</div>

          <div class="kv-key">问题说明</div>
          <div class="kv-val">
            {{ selected.problem ? (selected.problem.detail || selected.problem.title) : (selected.note || '无') }}
          </div>

          <div class="kv-key">运行耗时</div>
          <div class="kv-val mono">
            {{ formatTaskDuration(selected, nowTick) }}
          </div>
        </div>

        <!-- 异常提示 Callout -->
        <Callout
          v-if="selected.problem"
          :tone="selected.status === 'failed' ? 'error' : 'warn'"
          :view="selected.problem"
          class="detail-callout"
        />

        <Callout
          v-if="selectedAction?.phase === 'failed' && selectedAction.error"
          tone="error"
          :view="selectedAction.error"
          class="detail-callout"
        />

        <!-- 弹窗底部操作按钮 -->
        <div class="dialog-footer-actions">
          <button
            v-if="selected.canPause"
            type="button"
            class="btn"
            :disabled="isActionBusy(selected.id)"
            @click="runAction('pause', selected.id)"
          >
            暂停任务
          </button>
          <button
            v-if="selected.canResume"
            type="button"
            class="btn btn--primary"
            :disabled="isActionBusy(selected.id)"
            @click="runAction('resume', selected.id)"
          >
            恢复任务
          </button>
          <button
            v-if="selected.canCancel"
            type="button"
            class="btn btn--ghost"
            :disabled="isActionBusy(selected.id)"
            @click="runAction('cancel', selected.id)"
          >
            取消任务
          </button>
          <button
            type="button"
            class="btn"
            @click="detailOpen = false"
          >
            关闭
          </button>
        </div>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
/* ============ Seline 调色板映射与纸白卡细线黄色轻标题 ============ */
.seline-collect-page {
  --brand-yellow: #f6c000;
  --brand-yellow-bg: rgba(246, 192, 0, 0.12);
  --brand-yellow-border: rgba(246, 192, 0, 0.35);
  --brand-yellow-text: #996e00;
  --bg-card: var(--surface, #ffffff);
  --bg-subtle: var(--surface-sunken, #f8f8f8);
  --bg-hover: rgba(0, 0, 0, 0.03);
  --border-line: var(--border, #e8e8e8);
  --border-hover: var(--border-strong, #d0d0d0);
  --text-main: var(--text, #222222);
  --text-secondary: var(--text-muted, #666666);
  --text-muted: var(--text-muted, #888888);
  --text-faint: #aaaaaa;
  --status-success: #15803d;
  --status-success-bg: rgba(21, 128, 61, 0.1);
  --status-success-border: rgba(21, 128, 61, 0.25);
  --status-danger: #b42318;
  --status-danger-bg: rgba(180, 35, 24, 0.1);
  --status-danger-border: rgba(180, 35, 24, 0.25);
  --shadow-pop: 0 4px 16px rgba(0, 0, 0, 0.08);

  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
}

@media (prefers-color-scheme: dark) {
  .seline-collect-page {
    --brand-yellow: #ffe60f;
    --brand-yellow-bg: rgba(255, 230, 15, 0.14);
    --brand-yellow-border: rgba(255, 230, 15, 0.35);
    --brand-yellow-text: #ffd54f;
    --bg-card: var(--surface, #222222);
    --bg-subtle: var(--surface-sunken, #1c1c1c);
    --bg-hover: rgba(255, 255, 255, 0.04);
    --border-line: var(--border, #353535);
    --border-hover: var(--border-strong, #505050);
    --text-main: var(--text, #eeeeee);
    --text-secondary: var(--text-muted, #aaaaaa);
    --text-muted: var(--text-muted, #888888);
    --text-faint: #666666;
    --status-success: #4ade80;
    --status-success-bg: rgba(74, 222, 128, 0.14);
    --status-success-border: rgba(74, 222, 128, 0.3);
    --status-danger: #ff8a80;
    --status-danger-bg: rgba(255, 138, 128, 0.14);
    --status-danger-border: rgba(255, 138, 128, 0.3);
    --shadow-pop: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
}

/* ============ 顶部标题组 ============ */
.view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 2px;
}

.view-title-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.view-title {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--text-main);
  line-height: 1.25;
}

.view-sub {
  font-size: 12px;
  color: var(--text-secondary);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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

/* ============ 卡片通用 ============ */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border-line);
  border-radius: 8px;
  overflow: visible;
  transition: border-color 0.15s ease;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-line);
  background: var(--bg-card);
  border-top-left-radius: 8px;
  border-top-right-radius: 8px;
  flex-wrap: wrap;
}

.card-title-wrap {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.card-title {
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--text-main);
}

.card-caption {
  font-size: 11.5px;
  color: var(--text-muted);
}

.card-body {
  padding: 16px;
}

/* ============ 表单网格 ============ */
.form-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px 14px;
}

.span-full {
  grid-column: 1 / -1;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.form-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
}

.form-input {
  height: 34px;
  padding: 0 10px;
  font-size: 13px;
  color: var(--text-main);
  background: var(--bg-card);
  border: 1px solid var(--border-line);
  border-radius: 6px;
  outline: none;
  font-family: inherit;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.form-input:focus {
  border-color: var(--brand-yellow);
  box-shadow: 0 0 0 2px var(--brand-yellow-bg);
}

.form-field--check {
  justify-content: flex-end;
}

.form-check {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-main);
  cursor: pointer;
  user-select: none;
  min-height: 34px;
}

.check-with-tooltip {
  display: flex;
  align-items: center;
  gap: 6px;
}

.info-tip-wrap {
  display: inline-flex;
  align-items: center;
  color: var(--text-muted);
  cursor: help;
  outline: none;
}

.info-tip-wrap:hover {
  color: var(--text-main);
}

.field__error {
  font-size: 11.5px;
  color: var(--status-danger);
  line-height: 1.3;
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 18px;
  flex-wrap: wrap;
}

.subtle-tip {
  font-size: 12px;
  color: var(--text-muted);
  margin-left: 6px;
}

.form-callout {
  margin-top: 12px;
}

/* ============ 关键词/流量词标签与建议下拉 ============ */
.keyword-field-wrap {
  position: relative;
}

.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 2px;
}

.btn-text-action {
  background: none;
  border: none;
  color: var(--brand-yellow-text);
  font-size: 11.5px;
  cursor: pointer;
  padding: 0 4px;
  font-family: inherit;
  font-weight: 500;
  border-radius: 4px;
}

.btn-text-action:hover {
  text-decoration: underline;
}

.tag-input-container {
  min-height: 38px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border: 1px solid var(--border-line);
  border-radius: 6px;
  background: var(--bg-card);
  cursor: text;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.tag-input-container.is-focused {
  border-color: var(--brand-yellow);
  box-shadow: 0 0 0 2px var(--brand-yellow-bg);
}

.tag-input-container.has-error {
  border-color: var(--status-danger);
}

.tag-list {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--brand-yellow-bg);
  border: 1px solid var(--brand-yellow-border);
  color: var(--brand-yellow-text);
  font-size: 12px;
  padding: 2px 7px;
  border-radius: 4px;
  line-height: 1.4;
  user-select: none;
}

.tag-remove {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  color: var(--brand-yellow-text);
  opacity: 0.65;
  padding: 0 1px;
  font-family: inherit;
  transition: opacity 0.1s ease;
}

.tag-remove:hover {
  opacity: 1;
}

.tag-input-field {
  flex: 1;
  min-width: 180px;
  border: none;
  background: transparent;
  outline: none;
  font-size: 13px;
  color: var(--text-main);
  font-family: inherit;
  padding: 2px 0;
}

.tag-input-field::placeholder {
  color: var(--text-faint);
}

/* 建议下拉菜单 */
.suggest-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 60;
  margin-top: 4px;
  background: var(--bg-card);
  border: 1px solid var(--border-line);
  border-radius: 8px;
  box-shadow: var(--shadow-pop);
  padding: 10px 12px;
}

.suggest-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--text-secondary);
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-line);
  margin-bottom: 8px;
}

.suggest-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.suggest-close-btn {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  padding: 2px;
  display: inline-flex;
  align-items: center;
  border-radius: 4px;
}

.suggest-close-btn:hover {
  color: var(--text-main);
  background: var(--bg-subtle);
}

.suggest-hint {
  font-size: 11px;
  color: var(--text-faint);
}

.suggest-items-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
}

.suggest-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  border: 1px solid var(--border-line);
  background: var(--bg-subtle);
  font-size: 12px;
  color: var(--text-main);
  cursor: pointer;
  transition: all 0.12s ease;
  user-select: none;
  outline: none;
}

.suggest-item:hover,
.suggest-item:focus-visible {
  background: var(--bg-hover);
  border-color: var(--border-hover);
}

.suggest-item.is-selected {
  background: var(--brand-yellow-bg);
  border-color: var(--brand-yellow-border);
  color: var(--brand-yellow-text);
  font-weight: 500;
}

.suggest-word-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.suggest-check-mark {
  font-size: 11px;
  font-weight: bold;
}

.suggest-hot-tag {
  font-size: 10px;
  color: var(--text-muted);
}

.suggest-empty-tip {
  grid-column: 1 / -1;
  text-align: center;
  padding: 10px;
  color: var(--text-muted);
  font-size: 12px;
}

/* ============ 状态 Tabs ============ */
.tabs {
  display: inline-flex;
  align-items: center;
  background: var(--bg-subtle);
  border: 1px solid var(--border-line);
  border-radius: 6px;
  padding: 2px;
  gap: 2px;
  overflow-x: auto;
  max-width: 100%;
}

.tab-btn {
  background: transparent;
  border: none;
  color: var(--text-secondary);
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  white-space: nowrap;
  transition: all 0.12s ease;
}

.tab-btn:hover {
  color: var(--text-main);
}

.tab-btn.active {
  background: var(--bg-card);
  color: var(--text-main);
  font-weight: 500;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

/* ============ Seline 紧凑表 ============ */
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

.seline-table th {
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-weight: 500;
  padding: 6px 12px;
  height: 30px;
  border-bottom: 1px solid var(--border-line);
  white-space: nowrap;
  user-select: none;
}

.seline-table td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-line);
  color: var(--text-main);
  vertical-align: middle;
  transition: background 0.1s ease;
}

.seline-table tr:hover td {
  background: var(--bg-subtle);
}

.seline-table.density-compact td {
  padding: 6px 10px;
  font-size: 12px;
}

.seline-table.density-compact th {
  padding: 5px 10px;
  height: 28px;
  font-size: 12px;
}

.keyword-cell {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
}

.keyword-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.detail-badge {
  font-size: 10.5px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--brand-yellow-bg);
  border: 1px solid var(--brand-yellow-border);
  color: var(--brand-yellow-text);
  line-height: 1.2;
  white-space: nowrap;
}

.time-col {
  color: var(--text-muted);
  font-size: 11.5px;
  white-space: nowrap;
}

.has-fail-count {
  color: var(--status-danger);
  font-weight: 500;
}

/* ============ 药丸标签 ============ */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  font-weight: 400;
  border: 1px solid var(--border-line);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  white-space: nowrap;
  line-height: 1.35;
}

.pill.pill-yellow {
  background: var(--brand-yellow-bg);
  border-color: var(--brand-yellow-border);
  color: var(--brand-yellow-text);
  font-weight: 500;
}

.pill.pill-green {
  background: var(--status-success-bg);
  border-color: var(--status-success-border);
  color: var(--status-success);
}

.pill.pill-red {
  background: var(--status-danger-bg);
  border-color: var(--status-danger-border);
  color: var(--status-danger);
}

/* ============ 内联进度条 ============ */
.progress-inline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 130px;
}

.progress-bar-wrap {
  flex: 1;
  height: 5px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-line);
  border-radius: 9999px;
  overflow: hidden;
}

.progress-bar-fill {
  height: 100%;
  border-radius: 9999px;
  background: var(--brand-yellow);
  transition: width 0.3s ease;
}

.progress-bar-fill.success {
  background: var(--status-success);
}

.progress-bar-fill.danger {
  background: var(--status-danger);
}

.progress-label {
  font-size: 11px;
  color: var(--text-muted);
  min-width: 32px;
  text-align: right;
}

/* ============ 操作按钮 ============ */
.action-btn {
  color: var(--brand-yellow-text);
  text-decoration: none;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  margin-left: 8px;
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
  line-height: 1;
  transition: opacity 0.1s ease;
}

.action-btn:hover:not(:disabled) {
  text-decoration: underline;
}

.action-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.action-btn.danger {
  color: var(--status-danger);
}

/* ============ 分页栏 ============ */
.pagination-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-top: 1px solid var(--border-line);
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-card);
  border-bottom-left-radius: 8px;
  border-bottom-right-radius: 8px;
  flex-wrap: wrap;
  gap: 10px;
}

.pagination-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.form-select {
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--text-main);
  background: var(--bg-card);
  border: 1px solid var(--border-line);
  border-radius: 6px;
  outline: none;
  cursor: pointer;
  font-family: inherit;
}

/* ============ 空状态容器 ============ */
.blank-container {
  padding: 32px 16px;
  display: flex;
  justify-content: center;
}

/* ============ 详情弹窗 ============ */
.detail-empty {
  padding: 24px;
}

.task-detail-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 0;
}

.detail-header-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-line);
  border-radius: 8px;
}

.dh-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.dh-time {
  margin-left: auto;
  font-size: 11.5px;
}

.dh-progress-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* Seline .key-value 网格 */
.key-value {
  display: grid;
  grid-template-columns: 140px 1fr;
  gap: 10px 16px;
  font-size: 12.5px;
  padding: 4px 6px;
}

.key-value .kv-key {
  color: var(--text-muted);
}

.key-value .kv-val {
  color: var(--text-main);
  font-weight: 500;
  word-break: break-word;
}

.detail-callout {
  margin-top: 4px;
}

.dialog-footer-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 8px;
  padding-top: 14px;
  border-top: 1px solid var(--border-line);
}

/* ============ 响应式调整 ============ */
@media (max-width: 900px) {
  .form-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 600px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
  .key-value {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  .key-value .kv-key {
    margin-top: 6px;
    font-size: 11.5px;
  }
  .view-header {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
