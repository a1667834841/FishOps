<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import Callout from '../components/Callout.vue'
import EmptyState from '../components/EmptyState.vue'
import PanelCard from '../components/PanelCard.vue'
import ProgressBar from '../components/ProgressBar.vue'
import StatusTag from '../components/StatusTag.vue'
import AppModal from '../components/AppModal.vue'
import { PhPlus, PhArrowsClockwise, PhX, PhCaretLeft, PhCaretRight, PhInfo } from '@phosphor-icons/vue'
import { useBridgeController } from '../composables/useBridgeController'
import type { PageId } from '../data/navigation'
import { formatFullTime, isoTime } from '../features/chat/chat-format'
import {
  buildBatchCapturePayloads,
  CAPTURE_LIMITS,
  defaultCaptureForm,
  formatTaskDuration,
  formatTaskValidCount,
  paginateTasks,
  parseKeywordTags,
  toCaptureTaskView,
  type CaptureFormErrors,
  type CaptureFormField,
} from '../features/capture/capture-format'
import { CAPTURE_EVENTS, CaptureController, type CaptureState } from '../features/capture/capture-controller'
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

const form = reactive(defaultCaptureForm())
const keywordInput = ref('')
const inputFocused = ref(false)
const createOpen = ref(false)
const detailOpen = ref(false)
const errors = ref<CaptureFormErrors>({})
const confirmCancelId = ref<string | null>(null)

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
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
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
  return '开始采集'
})

// 流量词建议（suggest）相关状态
const showSuggestDropdown = ref(false)

// 任务历史分页状态
const historyPage = ref(1)
const historyPageSize = ref(20)

const pagination = computed(() => paginateTasks(views.value, historyPage.value, historyPageSize.value))
const pagedViews = computed(() => pagination.value.pagedItems)
const paging = computed(() => pagination.value.paging)
watch(() => [views.value.length, historyPageSize.value], () => {
  historyPage.value = Math.min(historyPage.value, Math.max(1, Math.ceil(views.value.length / historyPageSize.value)))
})

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
    document.getElementById('capture-keyword-input')?.focus()
  } else {
    document.getElementById(`capture-${field}`)?.focus()
  }
}

/** 将当前输入框中的内容解析并追加到关键词标签中 */
function addCurrentInputTag(explicitText?: string): void {
  const inputEl = document.getElementById('capture-keyword-input') as HTMLInputElement | null
  const raw = (explicitText !== undefined ? explicitText : (keywordInput.value || inputEl?.value || '')).trim()
  if (!raw) return
  const parsed = parseKeywordTags(raw, form.keywords ?? [])
  form.keywords = parsed.tags
  if (parsed.error) {
    errors.value.keyword = parsed.error
    // 存在错误时保留当前输入供用户修改，不予清空
  } else {
    keywordInput.value = ''
    if (inputEl) inputEl.value = ''
    errors.value.keyword = undefined
  }
  closeSuggest()
}

/** 删除指定索引的标签 */
function removeTag(index: number): void {
  if (!form.keywords) return
  form.keywords.splice(index, 1)
  if (form.keywords.length === 0 && !keywordInput.value.trim()) {
    errors.value.keyword = '请输入搜索关键词'
  } else {
    // 重新对剩余标签校验
    const parsed = parseKeywordTags([], form.keywords)
    errors.value.keyword = parsed.error
  }
}

/** 输入框键盘事件：退格删除末尾标签，逗号/顿号快捷加入；中文输入中（isComposing）不确认 */
function onInputKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  if (e.key === 'Backspace' && !keywordInput.value && form.keywords && form.keywords.length > 0) {
    form.keywords.pop()
    return
  }
  if (e.key === ',' || e.key === '，' || e.key === '、') {
    e.preventDefault()
    addCurrentInputTag()
  }
}

function onEnterKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return
  addCurrentInputTag()
}

/** 粘贴处理：保留当前已有输入，支持换行分隔 */
function onInputPaste(e: ClipboardEvent): void {
  const text = e.clipboardData?.getData('text') ?? ''
  if (/[,，、\r\n]/.test(text)) {
    e.preventDefault()
    const inputEl = document.getElementById('capture-keyword-input') as HTMLInputElement | null
    const currentVal = keywordInput.value || inputEl?.value || ''
    const combined = currentVal ? `${currentVal},${text}` : text
    const parsed = parseKeywordTags(combined, form.keywords ?? [])
    form.keywords = parsed.tags
    if (parsed.error) {
      errors.value.keyword = parsed.error
    } else {
      keywordInput.value = ''
      if (inputEl) inputEl.value = ''
      errors.value.keyword = undefined
    }
    closeSuggest()
  }
}

/** 关键词输入触发 300ms debounce 查询当前输入词的流量词 */
function onKeywordInput(e?: Event): void {
  if ((e as unknown as { isComposing?: boolean })?.isComposing) return
  const target = e?.target as HTMLInputElement | null
  const currentVal = target ? target.value : keywordInput.value
  if (/[,，、\r\n]/.test(currentVal)) {
    addCurrentInputTag(currentVal)
    return
  }
  const trimmed = currentVal.trim()
  if (!trimmed) {
    controller.clearSuggest()
    showSuggestDropdown.value = false
    return
  }
  showSuggestDropdown.value = true
  void controller.fetchSuggest(trimmed, { immediate: false })
}

/** 显式点击“获取流量词”按钮，立即查询当前输入词 */
function onRequestSuggest(): void {
  const trimmed = keywordInput.value.trim()
  if (!trimmed || !available.value) return
  showSuggestDropdown.value = true
  void controller.fetchSuggest(trimmed, { immediate: true })
}

/** 选中建议词：作为新标签追加，超长或超额显示错误，绝不自动创建任务 */
function onSelectSuggest(word: string): void {
  const selectedWord = controller.selectSuggestWord(word)
  const parsed = parseKeywordTags([selectedWord], form.keywords ?? [])
  form.keywords = parsed.tags
  if (parsed.error) {
    errors.value.keyword = parsed.error
  } else {
    keywordInput.value = ''
    errors.value.keyword = undefined
  }
  showSuggestDropdown.value = false
}

function closeSuggest(): void {
  showSuggestDropdown.value = false
}

function onInputBlur(): void {
  inputFocused.value = false
  setTimeout(() => {
    closeSuggest()
  }, 200)
}

function prevHistoryPage(): void {
  if (paging.value.hasPrev) historyPage.value--
}

function nextHistoryPage(): void {
  if (paging.value.hasNext) historyPage.value++
}

function resetFailedState(): void {
  failedKeywords.value = []
  failedPayloadSnapshots.value = []
  failureMessage.value = ''
  form.keywords = []
  errors.value.keyword = undefined
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
      resetFailedState()
      createOpen.value = false
      detailOpen.value = false
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
    // 全部成功：清空表单关键词，关闭弹窗，不自动打开详情
    form.keywords = []
    form.keyword = ''
    failedKeywords.value = []
    failedPayloadSnapshots.value = []
    historyPage.value = 1
    createOpen.value = false
    detailOpen.value = false
  } else {
    // 部分或全部失败：保存失败 payload 快照与失败词，表单仅保留失败词供重试
    failedKeywords.value = batchResult.failures.map((f) => f.keyword)
    failedPayloadSnapshots.value = result.payloads.filter((p) =>
      failedKeywords.value.includes(p.keyword),
    )
    form.keywords = [...failedKeywords.value]
    failureMessage.value = `以下 ${failedKeywords.value.length} 个关键词创建失败：${failedKeywords.value.join('、')}。已保留成功任务，点击重试将仅提交失败项。`
    detailOpen.value = false
  }
}

function formatTime(timestamp: number | null): string {
  return timestamp ? formatFullTime(timestamp) : '—'
}

async function runAction(kind: 'pause' | 'resume' | 'cancel', taskId: string): Promise<void> {
  if (kind === 'cancel') confirmCancelId.value = null
  await controller.act(kind, taskId)
}

const statItems = [
  { key: 'fetched', label: '已获取' },
  { key: 'valid', label: '有效' },
  { key: 'filtered', label: '被过滤' },
  { key: 'duplicates', label: '重复' },
  { key: 'failed', label: '失败' },
] as const
</script>

<template>
  <div class="page">
    <Callout v-if="state.realtimeError" tone="warn">{{ state.realtimeError }}（可手动点击「刷新任务」）</Callout>

    <div class="layout">
      <div class="capture-toolbar">
        <p class="muted">采集任务 <span class="mono">{{ views.length }}</span></p>
        <div class="row">
          <button type="button" class="btn btn--icon" title="刷新任务" aria-label="刷新任务" :disabled="!available || state.tasks.refreshing" @click="controller.refresh()"><PhArrowsClockwise :size="18" /></button>
          <button type="button" class="btn btn--primary" :disabled="!available" @click="createOpen = true"><PhPlus :size="18" />新建采集</button>
        </div>
      </div>

      <!-- 新建采集弹窗 -->
      <AppModal :open="createOpen" title="新建采集" :busy="creating || isSubmitting" @close="createOpen = false">
        <p class="capture-note">请保持已登录的闲鱼页面打开。遇到验证码或登录失效时，任务会暂停并保留进度。</p>
        <PanelCard>
          <form class="form" novalidate @submit.prevent="submit">
            <!-- 桌面第 1 行：关键词标签输入与流量词建议 -->
            <div class="field suggest-field">
              <div class="field__head">
                <label class="field__label" for="capture-keyword-input">
                  搜索关键词（最多 {{ CAPTURE_LIMITS.maxKeywords }} 个）
                </label>
                <span class="field__hint">回车、逗号、顿号、换行分隔，支持批量添加</span>
              </div>
              <div class="tags-input-container" :class="{ 'tags-input-container--focused': inputFocused, 'tags-input-container--error': !!errors.keyword }">
                <div v-if="form.keywords && form.keywords.length > 0" class="tags-list">
                  <span v-for="(tag, idx) in form.keywords" :key="tag" class="tag-pill">
                    <span class="tag-text">{{ tag }}</span>
                    <button
                      type="button"
                      class="tag-remove"
                      :aria-label="`删除关键词 ${tag}`"
                      :disabled="!available || isSubmitting"
                      @click.stop="removeTag(idx)"
                    >
                      <PhX :size="12" />
                    </button>
                  </span>
                </div>
                <div class="input-with-button">
                  <input
                    id="capture-keyword-input"
                    v-model="keywordInput"
                    class="input tag-input-element"
                    type="text"
                    autocomplete="off"
                    role="combobox"
                    aria-autocomplete="list"
                    :aria-expanded="showSuggestDropdown"
                    aria-controls="capture-suggest-list"
                    :aria-invalid="errors.keyword ? 'true' : undefined"
                    :aria-describedby="errors.keyword ? 'capture-keyword-error' : undefined"
                    :disabled="!available || isSubmitting || (Boolean(form.keywords && form.keywords.length >= CAPTURE_LIMITS.maxKeywords))"
                    :placeholder="form.keywords && form.keywords.length > 0 ? (form.keywords.length >= CAPTURE_LIMITS.maxKeywords ? '已达20个词上限' : '继续添加关键词…') : '例如：机械键盘、iPhone 15（按回车或逗号分隔）'"
                    @focus="inputFocused = true"
                    @blur="onInputBlur"
                    @input="onKeywordInput"
                    @keydown.enter.prevent="onEnterKeydown"
                    @keydown="onInputKeydown"
                    @paste="onInputPaste"
                  />
                  <button
                    type="button"
                    class="btn btn--sm btn-suggest"
                    :disabled="!available || !keywordInput.trim() || state.suggest.phase === 'loading' || isSubmitting"
                    title="查询当前输入词的流量词建议"
                    @click="onRequestSuggest"
                  >
                    {{ state.suggest.phase === 'loading' ? '查询中…' : '获取流量词' }}
                  </button>
                </div>
              </div>
              <span v-if="errors.keyword" id="capture-keyword-error" class="field__error" role="alert">{{ errors.keyword }}</span>

              <!-- 流量词建议下拉面板：仅查询当前输入词 -->
              <div
                v-if="showSuggestDropdown && keywordInput.trim() !== ''"
                class="suggest-dropdown"
                role="region"
                aria-label="流量词建议"
              >
                <div class="suggest-dropdown__header">
                  <span class="suggest-dropdown__title">“{{ keywordInput }}”的闲鱼流量词建议</span>
                  <button type="button" class="suggest-dropdown__close" aria-label="关闭建议" title="关闭建议" @click="closeSuggest"><PhX :size="16" /></button>
                </div>

                <div v-if="state.suggest.phase === 'loading'" class="suggest-status" role="status">
                  <span class="suggest-spinner" aria-hidden="true"></span>
                  <span>正在获取“{{ keywordInput }}”相关的流量词…</span>
                </div>

                <div v-else-if="state.suggest.phase === 'error'" class="suggest-error" role="alert">
                  <span>{{ state.suggest.error?.title || '流量词获取失败' }}</span>
                  <button type="button" class="btn btn--xs" @click="onRequestSuggest">重试</button>
                </div>

                <div v-else-if="state.suggest.phase === 'ok' && state.suggest.words.length === 0" class="suggest-empty">
                  未找到与“{{ keywordInput }}”相关的流量词
                </div>

                <ul
                  v-else-if="state.suggest.phase === 'ok' && state.suggest.words.length > 0"
                  id="capture-suggest-list"
                  class="suggest-list"
                  role="listbox"
                >
                  <li
                    v-for="word in state.suggest.words"
                    :key="word"
                    class="suggest-item"
                    role="option"
                    tabindex="0"
                    @click="onSelectSuggest(word)"
                    @keydown.enter.prevent="onSelectSuggest(word)"
                  >
                    <span class="suggest-word">{{ word }}</span>
                    <span class="suggest-tag">+ 追加标签</span>
                  </li>
                </ul>

                <div class="suggest-footer">
                  <span class="suggest-footer__tip">点击建议词将作为新标签追加，不会自动创建任务</span>
                </div>
              </div>
            </div>

            <!-- 桌面第 2 行：分页参数（3个数字字段） -->
            <div class="form-row form-row--3">
              <div class="field">
                <label class="field__label" for="capture-startPage">起始页</label>
                <input
                  id="capture-startPage"
                  v-model="form.startPage"
                  class="input"
                  inputmode="numeric"
                  :disabled="!available || isSubmitting"
                  :aria-invalid="errors.startPage ? 'true' : undefined"
                  :aria-describedby="errors.startPage ? 'capture-startPage-error' : undefined"
                />
                <span v-if="errors.startPage" id="capture-startPage-error" class="field__error" role="alert">{{ errors.startPage }}</span>
              </div>
              <div class="field">
                <label class="field__label" for="capture-pages">采集页数</label>
                <input
                  id="capture-pages"
                  v-model="form.pages"
                  class="input"
                  inputmode="numeric"
                  :disabled="!available || isSubmitting"
                  :aria-invalid="errors.pages ? 'true' : undefined"
                  :aria-describedby="errors.pages ? 'capture-pages-error' : 'capture-pages-hint'"
                />
                <span v-if="errors.pages" id="capture-pages-error" class="field__error" role="alert">{{ errors.pages }}</span>
                <span v-else id="capture-pages-hint" class="field__hint">最多 {{ CAPTURE_LIMITS.maxPages }} 页</span>
              </div>
              <div class="field">
                <label class="field__label" for="capture-rowsPerPage">每页数量</label>
                <input
                  id="capture-rowsPerPage"
                  v-model="form.rowsPerPage"
                  class="input"
                  inputmode="numeric"
                  :disabled="!available || isSubmitting"
                  :aria-invalid="errors.rowsPerPage ? 'true' : undefined"
                  :aria-describedby="errors.rowsPerPage ? 'capture-rowsPerPage-error' : undefined"
                />
                <span v-if="errors.rowsPerPage" id="capture-rowsPerPage-error" class="field__error" role="alert">{{ errors.rowsPerPage }}</span>
              </div>
            </div>

            <!-- 桌面第 3 行：过滤行顺序调整为 最小想要人数、最低价格、最高价格（3个数字字段常显） -->
            <div class="form-row form-row--3">
              <div class="field">
                <label class="field__label" for="capture-minWantCnt">最小想要人数</label>
                <input
                  id="capture-minWantCnt"
                  v-model="form.minWantCnt"
                  class="input"
                  inputmode="numeric"
                  placeholder="不限"
                  :disabled="!available || isSubmitting"
                  :aria-invalid="errors.minWantCnt ? 'true' : undefined"
                  :aria-describedby="errors.minWantCnt ? 'capture-minWantCnt-error' : undefined"
                />
                <span v-if="errors.minWantCnt" id="capture-minWantCnt-error" class="field__error" role="alert">{{ errors.minWantCnt }}</span>
              </div>
              <div class="field">
                <label class="field__label" for="capture-minPrice">最低价格（元）</label>
                <input
                  id="capture-minPrice"
                  v-model="form.minPrice"
                  class="input"
                  inputmode="decimal"
                  placeholder="不限"
                  :disabled="!available || isSubmitting"
                  :aria-invalid="errors.minPrice ? 'true' : undefined"
                  :aria-describedby="errors.minPrice ? 'capture-minPrice-error' : undefined"
                />
                <span v-if="errors.minPrice" id="capture-minPrice-error" class="field__error" role="alert">{{ errors.minPrice }}</span>
              </div>
              <div class="field">
                <label class="field__label" for="capture-maxPrice">最高价格（元）</label>
                <input
                  id="capture-maxPrice"
                  v-model="form.maxPrice"
                  class="input"
                  inputmode="decimal"
                  placeholder="不限"
                  :disabled="!available || isSubmitting"
                  :aria-invalid="errors.maxPrice ? 'true' : undefined"
                  :aria-describedby="errors.maxPrice ? 'capture-maxPrice-error' : undefined"
                />
                <span v-if="errors.maxPrice" id="capture-maxPrice-error" class="field__error" role="alert">{{ errors.maxPrice }}</span>
              </div>
            </div>

            <!-- 桌面第 4 行：基础间隔与随机增量（非负秒数，默认0.5/0.5，2个数字字段） -->
            <div class="form-row form-row--2">
              <div class="field">
                <label class="field__label" for="capture-baseIntervalSec">基础间隔（秒）</label>
                <input
                  id="capture-baseIntervalSec"
                  v-model="form.baseIntervalSec"
                  class="input"
                  inputmode="decimal"
                  placeholder="默认 0.5"
                  :disabled="!available || isSubmitting"
                  :aria-invalid="errors.baseIntervalSec ? 'true' : undefined"
                  :aria-describedby="errors.baseIntervalSec ? 'capture-baseIntervalSec-error' : 'capture-baseIntervalSec-hint'"
                />
                <span v-if="errors.baseIntervalSec" id="capture-baseIntervalSec-error" class="field__error" role="alert">{{ errors.baseIntervalSec }}</span>
                <span v-else id="capture-baseIntervalSec-hint" class="field__hint">单次请求基础间隔，默认 0.5 秒</span>
              </div>
              <div class="field">
                <label class="field__label" for="capture-randomIntervalSec">随机增量（秒）</label>
                <input
                  id="capture-randomIntervalSec"
                  v-model="form.randomIntervalSec"
                  class="input"
                  inputmode="decimal"
                  placeholder="默认 0.5"
                  :disabled="!available || isSubmitting"
                  :aria-invalid="errors.randomIntervalSec ? 'true' : undefined"
                  :aria-describedby="errors.randomIntervalSec ? 'capture-randomIntervalSec-error' : 'capture-randomIntervalSec-hint'"
                />
                <span v-if="errors.randomIntervalSec" id="capture-randomIntervalSec-error" class="field__error" role="alert">{{ errors.randomIntervalSec }}</span>
                <span v-else id="capture-randomIntervalSec-hint" class="field__hint">单次请求随机浮动上限，默认 0.5 秒</span>
              </div>
            </div>

            <!-- 桌面第 5 行：只看包邮、采集详情开关与提交按钮同一行 -->
            <div class="form-row form-row--bottom">
              <div class="switches-group">
                <label class="check-row">
                  <input v-model="form.onlyFreeShip" type="checkbox" :disabled="!available || isSubmitting" />
                  <span>仅包邮商品</span>
                </label>

                <div class="switch-with-info">
                  <label class="check-row">
                    <input v-model="form.fetchDetail" type="checkbox" :disabled="!available || isSubmitting" />
                    <span>同时采集商品详情</span>
                  </label>
                  <div
                    class="info-tooltip-wrapper"
                    tabindex="0"
                    role="note"
                    aria-label="同时采集商品详情说明"
                  >
                    <PhInfo :size="16" class="info-icon" />
                    <div class="tooltip-bubble" role="tooltip">
                      关闭只获取商品封面图；开启会额外发起一次详情请求，耗时较长，可获取浏览量、想要数、卖家信息及全量商品图片URL。默认关闭。
                    </div>
                  </div>
                </div>
              </div>

              <div class="submit-actions-group">
                <button type="submit" class="btn btn--primary" :disabled="submitDisabled">{{ submitLabel }}</button>
                <button
                  v-if="failedKeywords.length > 0"
                  type="button"
                  class="btn btn--ghost"
                  :disabled="submitDisabled"
                  @click="resetFailedState"
                >
                  清空失败项
                </button>
              </div>
            </div>

            <!-- 异常与重试提示 -->
            <Callout v-if="failureMessage" tone="error">
              {{ failureMessage }}
            </Callout>
            <Callout v-else-if="state.create.phase === 'failed' && state.create.error" tone="error" :view="state.create.error" />
            <Callout v-else-if="state.create.phase === 'ok' && !createOpen" tone="ok">采集任务已创建并加入队列，历史记录已保留。</Callout>
            <div v-if="hasActive && available" class="subtle-tip">
              提示：当前有正在进行中的采集任务，后台具备限速队列保护，新任务创建后将有序执行。
            </div>
          </form>
        </PanelCard>
      </AppModal>

      <!-- 任务列表区域 -->
      <div class="history-column">
        <PanelCard title="任务列表" flush>
          <template #actions>
            <StatusTag v-if="state.tasks.phase === 'ready'" mono>共 {{ views.length }} 条</StatusTag>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="!available || state.tasks.refreshing"
              @click="controller.refresh()"
            >
              {{ state.tasks.refreshing ? '正在刷新…' : '刷新列表' }}
            </button>
          </template>

          <div v-if="!available" class="blank">
            <EmptyState title="未连接扩展" description="从扩展内页打开工作台后可查看采集任务。" />
          </div>

          <div v-else-if="state.tasks.phase === 'idle' || state.tasks.phase === 'loading'" class="blank" role="status">
            <p class="muted">正在加载任务历史…</p>
          </div>

          <div v-else-if="state.tasks.phase === 'error'" class="blank">
            <Callout tone="error" :view="state.tasks.error">
              <template #actions>
                <button type="button" class="btn btn--sm" @click="controller.refresh()">重试</button>
              </template>
            </Callout>
          </div>

          <div v-else-if="views.length === 0" class="blank">
            <EmptyState
              title="暂无采集任务"
              description="点击右上角「新建采集」发起第一次采集。"
            />
          </div>

          <div v-else class="history-content">
            <!-- 任务列表表格：明确显示关键词、成功入库商品数量、耗时、状态，未启动/旧字段显示—，运行任务耗时每秒更新，行点击可打开详情，键盘可达 -->
            <div class="tasks-table-wrapper">
              <table class="tasks-table" aria-label="采集任务列表">
                <thead>
                  <tr>
                    <th scope="col" class="th-keyword">关键词</th>
                    <th scope="col" class="th-status">状态</th>
                    <th scope="col" class="th-progress">进度</th>
                    <th scope="col" class="th-valid">成功入库</th>
                    <th scope="col" class="th-duration">耗时</th>
                    <th scope="col" class="th-time">创建时间</th>
                    <th scope="col" class="th-actions">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="view in pagedViews"
                    :key="view.id"
                    class="task-row"
                    :class="{ 'task-row--active': view.id === state.selectedId }"
                    tabindex="0"
                    role="button"
                    :aria-label="`查看任务详情：${view.keyword || '无关键词'}`"
                    @click="openTaskDetail(view.id)"
                    @keydown.enter.prevent="openTaskDetail(view.id)"
                    @keydown.space.prevent="openTaskDetail(view.id)"
                  >
                    <td class="td-keyword">
                      <div class="keyword-cell">
                        <span class="keyword-text" :title="view.keyword">{{ view.keyword || '—' }}</span>
                        <span v-if="view.fetchDetail" class="detail-badge" title="同时采集详情">含详情</span>
                      </div>
                    </td>
                    <td class="td-status">
                      <StatusTag :tone="view.tone" :dot="view.status === 'running'" :pulse="view.status === 'running'">
                        {{ view.statusLabel }}
                      </StatusTag>
                    </td>
                    <td class="td-progress">
                      <div class="progress-cell">
                        <span class="mono">{{ view.progress }}%</span>
                        <span v-if="view.pagesCompleted !== null && view.totalPages !== null" class="progress-sub muted">
                          ({{ view.pagesCompleted }}/{{ view.totalPages }}页)
                        </span>
                      </div>
                    </td>
                    <td class="td-valid mono">
                      {{ formatTaskValidCount(view) }}
                    </td>
                    <td class="td-duration mono">
                      {{ formatTaskDuration(view, nowTick) }}
                    </td>
                    <td class="td-time muted">
                      {{ formatTime(view.createdAt) }}
                    </td>
                    <td class="td-actions">
                      <button
                        type="button"
                        class="btn btn--xs"
                        title="查看任务详情"
                        @click.stop="openTaskDetail(view.id)"
                      >
                        查看详情
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <!-- 分页与加载更多栏 -->
            <div class="pagination-bar">
              <div class="pagination-info">
                第 <span class="mono">{{ paging.page }}</span> / <span class="mono">{{ paging.totalPages }}</span> 页（已加载 {{ paging.total }} 条）
              </div>
              <div class="pagination-actions">
                <select v-model="historyPageSize" class="input" aria-label="每页任务数量" @change="historyPage = 1">
                  <option :value="10">每页 10 条</option>
                  <option :value="20">每页 20 条</option>
                  <option :value="50">每页 50 条</option>
                </select>
                <button
                  type="button"
                  class="btn btn--xs"
                  :disabled="!paging.hasPrev"
                  @click="prevHistoryPage"
                >
                  <PhCaretLeft :size="14" aria-hidden="true" /> 上一页
                </button>
                <button
                  type="button"
                  class="btn btn--xs"
                  :disabled="!paging.hasNext"
                  @click="nextHistoryPage"
                >
                  下一页 <PhCaretRight :size="14" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="btn btn--xs btn--ghost"
                  title="向后台拉取更多历史任务"
                  @click="controller.loadMoreHistory()"
                >
                  加载更多
                </button>
              </div>
            </div>
          </div>
        </PanelCard>

        <!-- 选中任务详情弹窗：保留查看详情与控制操作 -->
        <AppModal :open="detailOpen" title="采集详情" @close="detailOpen = false">
          <PanelCard>
            <div v-if="!available" class="blank">
              <p class="muted">未连接扩展，详情不可用。</p>
            </div>
            <div v-else-if="!selected" class="blank">
              <EmptyState
                title="未选择任务"
                description="在左侧历史列表中点击任一条目以查看断点和统计。"
              />
            </div>
            <div v-else class="task">
              <Callout v-if="state.tasks.error" tone="warn" :view="state.tasks.error" />
              <div class="task__head">
                <div class="task__title">
                  <h3 class="task__keyword">{{ selected.keyword || '（无关键词）' }}</h3>
                  <StatusTag :tone="selected.tone" :dot="selected.status === 'running'" :pulse="selected.status === 'running'">
                    {{ selected.statusLabel }}
                  </StatusTag>
                  <StatusTag v-if="selected.fetchDetail" tone="info">含详情</StatusTag>
                </div>
                <p class="muted">
                  任务 ID <code class="mono">{{ selected.id }}</code> · 创建于
                  <time :datetime="isoTime(selected.createdAt)">{{ formatTime(selected.createdAt) }}</time>
                  <template v-if="selected.endedAt">
                    · 结束于 <time :datetime="isoTime(selected.endedAt)">{{ formatTime(selected.endedAt) }}</time>
                  </template>
                </p>
              </div>

              <!-- 进度与断点页数 -->
              <div class="task__progress">
                <ProgressBar
                  :value="selected.progress"
                  label="采集任务进度"
                  :tone="selected.tone === 'ok' ? 'ok' : selected.tone === 'error' ? 'error' : selected.tone === 'warn' ? 'warn' : 'accent'"
                />
                <p class="task__meta">
                  进度 <span class="mono">{{ selected.progress }}%</span>
                  <span v-if="selected.pagesCompleted !== null && selected.totalPages !== null">
                    · 已完成 <span class="mono">{{ selected.pagesCompleted }} / {{ selected.totalPages }}</span> 页
                  </span>
                  <span v-else>· 尚未获取页数</span>
                  <span v-if="selected.nextPage !== null && selected.status !== 'completed'">
                    · 断点页 <span class="mono">{{ selected.nextPage }}</span>
                  </span>
                </p>
              </div>

              <!-- 统计网格 -->
              <dl v-if="selected.stats" class="stats">
                <div v-for="item in statItems" :key="item.key" class="stats__item">
                  <dt>{{ item.label }}</dt>
                  <dd class="mono">{{ selected.stats[item.key] }}</dd>
                </div>
              </dl>
              <p v-else class="muted">暂无结果统计</p>

              <!-- 问题说明（失败或暂停原因） -->
              <Callout v-if="selected.problem" :tone="selected.status === 'failed' ? 'error' : 'warn'" :view="selected.problem" />
              <p v-if="selected.note" class="muted">{{ selected.note }}</p>
              <p v-if="selected.status === 'paused' && !selected.problem" class="muted">
                任务已暂停，断点已保存。在闲鱼页面完成操作后点击「恢复」即可续跑。
              </p>
              <p v-if="selected.status === 'completed'" class="muted">
                本轮采集已完成。可在
                <button type="button" class="link" @click="emit('navigate', 'products')">商品库</button>
                中查看。
              </p>

              <!-- 任务操作失败提示 -->
              <Callout v-if="selectedAction?.phase === 'failed' && selectedAction.error" tone="error" :view="selectedAction.error" />

              <!-- 操作按钮 -->
              <div v-if="selected.canPause || selected.canResume || selected.canCancel" class="row">
                <button
                  v-if="selected.canPause"
                  type="button"
                  class="btn"
                  :disabled="selectedAction?.phase === 'running'"
                  @click="runAction('pause', selected.id)"
                >
                  {{ selectedAction?.phase === 'running' ? '正在暂停…' : '暂停采集' }}
                </button>
                <button
                  v-if="selected.canResume"
                  type="button"
                  class="btn btn--primary"
                  :disabled="selectedAction?.phase === 'running'"
                  @click="runAction('resume', selected.id)"
                >
                  {{ selectedAction?.phase === 'running' ? '正在恢复…' : '恢复采集' }}
                </button>
                <template v-if="selected.canCancel">
                  <button
                    v-if="confirmCancelId !== selected.id"
                    type="button"
                    class="btn btn--ghost"
                    :disabled="selectedAction?.phase === 'running'"
                    @click="confirmCancelId = selected.id"
                  >
                    取消任务
                  </button>
                  <template v-else>
                    <span class="muted">确定取消该任务？</span>
                    <button
                      type="button"
                      class="btn btn--danger"
                      :disabled="selectedAction?.phase === 'running'"
                      @click="runAction('cancel', selected.id)"
                    >
                      确认取消
                    </button>
                    <button type="button" class="btn btn--ghost" @click="confirmCancelId = null">返回</button>
                  </template>
                </template>
              </div>
            </div>
          </PanelCard>
        </AppModal>
      </div>
    </div>
  </div>
</template>

<style scoped>
.capture-note { margin-bottom: 16px; font-size: 13px; color: var(--text-muted); }

.layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.history-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.capture-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; }

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 桌面五行布局与栅格自适应 */
.form-row--3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}

.form-row--2 {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

.form-row--bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 6px;
  padding-top: 4px;
}

.switches-group {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}

.submit-actions-group {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 关键词与标签输入群组 */
.suggest-field {
  position: relative;
}

.field__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.tags-input-container {
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  padding: 8px 10px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.tags-input-container--focused {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.tags-input-container--error {
  border-color: var(--danger, #ef4444);
}

.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 8px;
  font-size: 13px;
  color: var(--text);
}

.tag-text {
  word-break: break-all;
}

.tag-remove {
  background: transparent;
  border: none;
  padding: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  border-radius: 2px;
}

.tag-remove:hover {
  color: var(--danger, #ef4444);
}

.tag-input-element {
  border: none !important;
  box-shadow: none !important;
  padding-left: 2px !important;
  background: transparent !important;
}

.tag-input-element:focus {
  outline: none !important;
}

.input-with-button {
  display: flex;
  gap: 6px;
  align-items: center;
}

.input-with-button .input {
  flex: 1;
}

.btn-suggest {
  flex-shrink: 0;
}

/* 详情开关与悬浮/键盘 Tooltip */
.switch-with-info {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.info-tooltip-wrapper {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: help;
  color: var(--text-muted);
  outline: none;
  border-radius: 50%;
  padding: 2px;
}

.info-tooltip-wrapper:hover,
.info-tooltip-wrapper:focus-visible {
  color: var(--accent-text);
}

.info-tooltip-wrapper .tooltip-bubble {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--surface-raised, #222);
  color: var(--text-inverse, #fff);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  padding: 6px 10px;
  font-size: 12px;
  line-height: 1.4;
  white-space: normal;
  width: 260px;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.15s ease, visibility 0.15s ease;
  z-index: 50;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
}

.info-tooltip-wrapper:hover .tooltip-bubble,
.info-tooltip-wrapper:focus .tooltip-bubble,
.info-tooltip-wrapper:focus-visible .tooltip-bubble {
  opacity: 1;
  visibility: visible;
}

/* 流量词下拉建议面板 */
.suggest-dropdown {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 40;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.14);
  overflow: hidden;
  max-height: 280px;
  display: flex;
  flex-direction: column;
}

.suggest-dropdown__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--surface-sunken);
  border-bottom: 1px solid var(--border);
}

.suggest-dropdown__title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.suggest-dropdown__close {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 13px;
  padding: 2px 6px;
  border-radius: 3px;
}

.suggest-dropdown__close:hover {
  background: var(--border);
  color: var(--text);
}

.suggest-status,
.suggest-empty,
.suggest-error {
  padding: 16px;
  font-size: 13px;
  color: var(--text-muted);
  text-align: center;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.suggest-error {
  color: var(--danger, #ef4444);
}

.suggest-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: suggest-spin 0.8s linear infinite;
}

@keyframes suggest-spin {
  to { transform: rotate(360deg); }
}

.suggest-list {
  list-style: none;
  padding: 4px 0;
  margin: 0;
  overflow-y: auto;
  max-height: 200px;
}

.suggest-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
  outline: none;
  transition: background-color 0.12s ease;
}

.suggest-item:hover,
.suggest-item:focus-visible {
  background: var(--accent-soft);
}

.suggest-word {
  color: var(--text);
  font-weight: 500;
}

.suggest-tag {
  font-size: 11px;
  color: var(--accent-text);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  padding: 1px 6px;
  border-radius: 3px;
}

.suggest-footer {
  padding: 6px 12px;
  background: var(--surface-sunken);
  border-top: 1px solid var(--border);
}

.suggest-footer__tip {
  font-size: 11px;
  color: var(--text-muted);
}

.subtle-tip {
  font-size: 12px;
  color: var(--text-muted);
  background: var(--surface-sunken);
  padding: 8px 12px;
  border-radius: var(--radius-control);
  border: 1px solid var(--border);
}

.blank {
  padding: 24px 16px;
  text-align: center;
}

.muted {
  color: var(--text-muted);
  font-size: 12px;
  margin: 0;
}

/* 详情弹窗 */
.task {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.task__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.task__title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.task__keyword {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.task__progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.task__meta {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
  gap: 8px;
  margin: 0;
}

.stats__item {
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stats__item dt {
  font-size: 11px;
  color: var(--text-muted);
}

.stats__item dd {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}

.mono {
  font-family: var(--mono);
}

.link {
  background: transparent;
  border: none;
  color: var(--accent-text);
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}

.history-content {
  display: flex;
  flex-direction: column;
}

/* 列表表格 */
.tasks-table-wrapper {
  width: 100%;
  overflow-x: auto;
}

.tasks-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 13px;
}

.tasks-table th {
  padding: 10px 14px;
  color: var(--text-muted);
  font-weight: 500;
  border-bottom: 1px solid var(--border-strong);
  background: var(--surface-sunken);
  white-space: nowrap;
}

.tasks-table td {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.task-row {
  transition: background-color 0.12s ease;
  cursor: pointer;
  outline: none;
}

.task-row:hover {
  background: var(--surface-sunken);
}

.task-row:focus-visible {
  outline: 2px solid var(--focus, #3b82f6);
  outline-offset: -2px;
}

.task-row--active {
  background: var(--accent-soft);
}

.keyword-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.keyword-text {
  font-weight: 600;
  color: var(--text);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.detail-badge {
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  color: var(--text-muted);
  white-space: nowrap;
}

.progress-cell {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.progress-sub {
  font-size: 11px;
}

.pagination-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 16px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-muted);
  flex-wrap: wrap;
  gap: 8px;
}

.pagination-info {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pagination-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.pagination-actions .input {
  font-size: 12px;
  padding: 2px 6px;
  height: 28px;
}

.btn--xs {
  font-size: 11px;
  padding: 3px 8px;
  height: 26px;
}

/* 窄屏自适应断点：数字字段换行 */
@media (max-width: 680px) {
  .form-row--3 {
    grid-template-columns: 1fr;
  }
  .form-row--2 {
    grid-template-columns: 1fr;
  }
  .form-row--bottom {
    flex-direction: column;
    align-items: stretch;
  }
  .submit-actions-group {
    justify-content: flex-end;
  }
  .pagination-bar {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
