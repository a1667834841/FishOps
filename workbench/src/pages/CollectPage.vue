<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue'
import Callout from '../components/Callout.vue'
import EmptyState from '../components/EmptyState.vue'
import PanelCard from '../components/PanelCard.vue'
import ProgressBar from '../components/ProgressBar.vue'
import StatusTag from '../components/StatusTag.vue'
import { useBridgeController } from '../composables/useBridgeController'
import type { PageId } from '../data/navigation'
import { formatFullTime, isoTime } from '../features/chat/chat-format'
import {
  buildCapturePayload,
  CAPTURE_LIMITS,
  defaultCaptureForm,
  paginateTasks,
  toCaptureTaskView,
  type CaptureFormErrors,
  type CaptureFormField,
} from '../features/capture/capture-format'
import { CAPTURE_EVENTS, CaptureController, type CaptureState } from '../features/capture/capture-controller'

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

/** 提交按钮仅防重复提交，不因已有 active 任务禁用新建 */
const submitDisabled = computed(() => !available.value || creating.value)
const submitLabel = computed(() => (creating.value ? '正在创建…' : '开始采集'))

const form = reactive(defaultCaptureForm())
const errors = ref<CaptureFormErrors>({})
const confirmCancelId = ref<string | null>(null)

// 流量词建议（suggest）相关状态
const showSuggestDropdown = ref(false)

// 任务历史分页状态
const historyPage = ref(1)
const historyPageSize = ref(6)

const pagination = computed(() => paginateTasks(views.value, historyPage.value, historyPageSize.value))
const pagedViews = computed(() => pagination.value.pagedItems)
const paging = computed(() => pagination.value.paging)

const FIELD_ORDER: readonly CaptureFormField[] = [
  'keyword',
  'startPage',
  'pages',
  'rowsPerPage',
  'minWantCnt',
  'minPrice',
  'maxPrice',
]

/** 关键词输入触发 300ms debounce 查询流量词 */
function onKeywordInput(): void {
  if (form.keyword.trim() === '') {
    controller.clearSuggest()
    showSuggestDropdown.value = false
    return
  }
  showSuggestDropdown.value = true
  void controller.fetchSuggest(form.keyword, { immediate: false })
}

/** 显式点击“获取流量词”按钮，立即调用 */
function onRequestSuggest(): void {
  if (!form.keyword.trim() || !available.value) return
  showSuggestDropdown.value = true
  void controller.fetchSuggest(form.keyword, { immediate: true })
}

/** 点击建议词填入关键词，绝不自动创建任务 */
function onSelectSuggest(word: string): void {
  form.keyword = controller.selectSuggestWord(word)
  showSuggestDropdown.value = false
  errors.value.keyword = undefined
}

function closeSuggest(): void {
  showSuggestDropdown.value = false
}

function prevHistoryPage(): void {
  if (paging.value.hasPrev) historyPage.value--
}

function nextHistoryPage(): void {
  if (paging.value.hasNext) historyPage.value++
}

async function submit(): Promise<void> {
  if (submitDisabled.value) return
  const result = buildCapturePayload(form)
  if (!result.ok) {
    errors.value = result.errors
    await nextTick()
    const first = FIELD_ORDER.find((field) => result.errors[field])
    if (first) document.getElementById(`capture-${first}`)?.focus()
    return
  }
  errors.value = {}
  closeSuggest()
  const ok = await controller.createTask(result.payload)
  if (ok) {
    // 成功创建后跳到第一页并保持选中新任务
    historyPage.value = 1
  }
}

function formatTime(timestamp: number | null): string {
  return timestamp ? formatFullTime(timestamp) : ''
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
    <Callout v-if="!available" tone="warn">
      <template #default>
        当前不是扩展内页，采集任务无法创建。请通过 chrome-extension://&lt;扩展 ID&gt;/workbench.html 打开工作台。
      </template>
      <template #actions>
        <button type="button" class="btn btn--sm" @click="emit('diagnostics')">查看系统状态</button>
      </template>
    </Callout>
    <Callout v-else tone="info">
      采集由扩展在你已登录的闲鱼页面内发起请求，开始前请先打开并登录 goofish.com，并保持该页面打开。系统强制请求间隔不低于 1.5 秒，遇到验证码或登录失效会自动暂停并保留断点。
    </Callout>
    <Callout v-if="state.realtimeError" tone="warn">{{ state.realtimeError }}（可手动点击「刷新任务」）</Callout>

    <div class="layout">
      <!-- 左栏：新建采集任务 -->
      <PanelCard title="新建采集任务" description="按关键词搜索并写入本地商品库，支持并发入队">
        <form class="form" novalidate @submit.prevent="submit">
          <!-- 关键词与流量词建议 -->
          <div class="field suggest-field">
            <div class="field__head">
              <label class="field__label" for="capture-keyword">搜索关键词</label>
              <span class="field__hint">输入后约 300ms 自动联想流量词</span>
            </div>
            <div class="input-with-button">
              <input
                id="capture-keyword"
                v-model="form.keyword"
                class="input"
                type="text"
                autocomplete="off"
                role="combobox"
                aria-autocomplete="list"
                :aria-expanded="showSuggestDropdown"
                aria-controls="capture-suggest-list"
                :maxlength="CAPTURE_LIMITS.keywordMaxLength"
                :disabled="!available"
                :aria-invalid="errors.keyword ? 'true' : undefined"
                :aria-describedby="errors.keyword ? 'capture-keyword-error' : undefined"
                placeholder="例如：机械键盘、iPhone 15"
                @input="onKeywordInput"
                @keydown.esc="closeSuggest"
              />
              <button
                type="button"
                class="btn btn--sm btn-suggest"
                :disabled="!available || !form.keyword.trim() || state.suggest.phase === 'loading'"
                title="立即查询与当前关键词相关的流量词"
                @click="onRequestSuggest"
              >
                {{ state.suggest.phase === 'loading' ? '查询中…' : '获取流量词' }}
              </button>
            </div>
            <span v-if="errors.keyword" id="capture-keyword-error" class="field__error" role="alert">{{ errors.keyword }}</span>

            <!-- 流量词建议下拉面板 -->
            <div
              v-if="showSuggestDropdown && form.keyword.trim() !== ''"
              class="suggest-dropdown"
              role="region"
              aria-label="流量词建议"
            >
              <div class="suggest-dropdown__header">
                <span class="suggest-dropdown__title">闲鱼流量词建议</span>
                <button type="button" class="suggest-dropdown__close" aria-label="关闭建议" @click="closeSuggest">✕</button>
              </div>

              <!-- loading -->
              <div v-if="state.suggest.phase === 'loading'" class="suggest-status" role="status">
                <span class="suggest-spinner" aria-hidden="true"></span>
                <span>正在获取“{{ form.keyword }}”相关的流量词…</span>
              </div>

              <!-- error -->
              <div v-else-if="state.suggest.phase === 'error'" class="suggest-error" role="alert">
                <span>{{ state.suggest.error?.title || '流量词获取失败' }}</span>
                <button type="button" class="btn btn--xs" @click="onRequestSuggest">重试</button>
              </div>

              <!-- empty -->
              <div v-else-if="state.suggest.phase === 'ok' && state.suggest.words.length === 0" class="suggest-empty">
                未找到与“{{ form.keyword }}”相关的流量词
              </div>

              <!-- ok 且有建议词 -->
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
                  <span class="suggest-tag">填入</span>
                </li>
              </ul>

              <div class="suggest-footer">
                <span class="suggest-footer__tip">点击建议词仅填入输入框，不会自动创建任务</span>
              </div>
            </div>
          </div>

          <div class="form-grid">
            <div class="field">
              <label class="field__label" for="capture-startPage">起始页</label>
              <input
                id="capture-startPage"
                v-model="form.startPage"
                class="input"
                inputmode="numeric"
                :disabled="!available"
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
                :disabled="!available"
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
                :disabled="!available"
                :aria-invalid="errors.rowsPerPage ? 'true' : undefined"
                :aria-describedby="errors.rowsPerPage ? 'capture-rowsPerPage-error' : undefined"
              />
              <span v-if="errors.rowsPerPage" id="capture-rowsPerPage-error" class="field__error" role="alert">{{ errors.rowsPerPage }}</span>
            </div>
          </div>

          <fieldset class="filters">
            <legend class="filters__legend">过滤条件（留空表示不限制）</legend>
            <div class="form-grid">
              <div class="field">
                <label class="field__label" for="capture-minWantCnt">最小想要人数</label>
                <input
                  id="capture-minWantCnt"
                  v-model="form.minWantCnt"
                  class="input"
                  inputmode="numeric"
                  :disabled="!available"
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
                  :disabled="!available"
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
                  :disabled="!available"
                  :aria-invalid="errors.maxPrice ? 'true' : undefined"
                  :aria-describedby="errors.maxPrice ? 'capture-maxPrice-error' : undefined"
                />
                <span v-if="errors.maxPrice" id="capture-maxPrice-error" class="field__error" role="alert">{{ errors.maxPrice }}</span>
              </div>
            </div>
            <label class="check-row">
              <input v-model="form.onlyFreeShip" type="checkbox" :disabled="!available" />
              <span>仅包邮商品</span>
            </label>
          </fieldset>

          <div class="field">
            <label class="check-row">
              <input v-model="form.fetchDetail" type="checkbox" :disabled="!available" aria-describedby="capture-detail-hint" />
              <span>同时采集商品详情（浏览量、卖家等）</span>
            </label>
            <span id="capture-detail-hint" class="field__hint">每个商品会额外发起一次详情请求，耗时相对更长。默认关闭。</span>
          </div>

          <Callout v-if="state.create.phase === 'failed' && state.create.error" tone="error" :view="state.create.error" />
          <Callout v-else-if="state.create.phase === 'ok'" tone="ok">采集任务已创建并加入队列，历史记录已保留。</Callout>
          <div v-if="hasActive && available" class="subtle-tip">
            提示：当前有正在进行中的采集任务，后台具备限速队列保护，新任务创建后将有序执行。
          </div>

          <div class="row">
            <button type="submit" class="btn btn--primary" :disabled="submitDisabled">{{ submitLabel }}</button>
          </div>
        </form>
      </PanelCard>

      <!-- 右栏：任务历史列表 + 任务详情 -->
      <div class="history-column">
        <!-- 任务历史列表卡片 -->
        <PanelCard title="任务历史列表" description="所有已创建的采集任务均保留在历史中，支持点击切换详情" flush>
          <template #actions>
            <StatusTag v-if="state.tasks.phase === 'ready'" mono>共 {{ views.length }} 条</StatusTag>
            <button
              type="button"
              class="btn btn--sm"
              :disabled="!available || state.tasks.phase === 'loading' || state.tasks.refreshing"
              @click="controller.refresh()"
            >
              {{ state.tasks.refreshing ? '刷新中…' : '刷新列表' }}
            </button>
          </template>

          <div v-if="!available" class="blank">
            <EmptyState title="未连接扩展" description="在扩展内页打开工作台后，这里会显示真实的采集任务历史。绝不伪造任何演示数据。" />
          </div>
          <div v-else-if="state.tasks.phase === 'idle' || state.tasks.phase === 'loading'" class="blank" role="status">
            <p class="muted">正在读取任务历史…</p>
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
              title="暂无采集历史"
              description="在左侧填写关键词并开始采集后，每次创建的任务都会持久化保留在历史列表中。"
            />
          </div>

          <div v-else class="history-content">
            <ul class="list" aria-label="采集任务历史列表">
              <li v-for="view in pagedViews" :key="view.id">
                <button
                  type="button"
                  class="list__row"
                  :class="{ 'list__row--active': view.id === state.selectedId }"
                  :aria-current="view.id === state.selectedId ? 'true' : undefined"
                  @click="controller.select(view.id)"
                >
                  <span class="list__main">
                    <span class="list__keyword">{{ view.keyword || '（无关键词）' }}</span>
                    <span class="list__time">{{ formatTime(view.createdAt) }}</span>
                  </span>
                  <span class="list__side">
                    <span class="mono">{{ view.progress }}%</span>
                    <StatusTag :tone="view.tone" :dot="view.status === 'running'" :pulse="view.status === 'running'">
                      {{ view.statusLabel }}
                    </StatusTag>
                  </span>
                </button>
              </li>
            </ul>

            <!-- 分页与加载更多栏 -->
            <div class="pagination-bar">
              <div class="pagination-info">
                第 <span class="mono">{{ paging.page }}</span> / <span class="mono">{{ paging.totalPages }}</span> 页（共 {{ paging.total }} 条）
              </div>
              <div class="pagination-actions">
                <button
                  type="button"
                  class="btn btn--xs"
                  :disabled="!paging.hasPrev"
                  @click="prevHistoryPage"
                >
                  上一页
                </button>
                <button
                  type="button"
                  class="btn btn--xs"
                  :disabled="!paging.hasNext"
                  @click="nextHistoryPage"
                >
                  下一页
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

        <!-- 选中任务详情卡片 -->
        <PanelCard title="任务详情" description="状态、进度与统计均来自后台任务快照，绝无虚构数据">
          <div v-if="!available" class="blank">
            <p class="muted">未连接扩展，详情不可用。</p>
          </div>
          <div v-else-if="!selected" class="blank">
            <EmptyState
              title="未选择任务"
              description="请在上方历史列表中点击选择任意一条任务查看其实时进度与详细统计。"
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
                <StatusTag v-if="selected.fetchDetail">含详情</StatusTag>
              </div>
              <p class="muted">
                任务 ID: <code class="mono">{{ selected.id }}</code> ·
                创建于 <time :datetime="isoTime(selected.createdAt)">{{ formatTime(selected.createdAt) }}</time>
                <template v-if="selected.endedAt"> · 结束于 <time :datetime="isoTime(selected.endedAt)">{{ formatTime(selected.endedAt) }}</time></template>
              </p>
            </div>

            <!-- 进度条与断点 -->
            <div class="task__progress">
              <ProgressBar
                :value="selected.progress"
                :label="`采集进度 ${selected.progress}%`"
                :tone="selected.status === 'failed' ? 'error' : selected.status === 'completed' ? 'ok' : selected.status === 'paused' ? 'warn' : 'accent'"
              />
              <p class="task__meta">
                <span class="mono">{{ selected.progress }}%</span>
                <span v-if="selected.pagesCompleted !== null && selected.totalPages !== null">
                  已完成 {{ selected.pagesCompleted }} / {{ selected.totalPages }} 页
                </span>
                <span v-else>页数进度：后台尚未上报</span>
                <span v-if="selected.nextPage !== null && selected.status !== 'completed'">
                  下一待采集页：第 {{ selected.nextPage }} 页
                </span>
              </p>
            </div>

            <!-- 统计网格（如实展示） -->
            <dl v-if="selected.stats" class="stats">
              <div v-for="item in statItems" :key="item.key" class="stats__item">
                <dt>{{ item.label }}</dt>
                <dd class="mono">{{ selected.stats[item.key] }}</dd>
              </div>
            </dl>
            <p v-else class="muted">统计：后台尚未上报（首页采集完成后呈现）。</p>

            <!-- 异常与提示说明 -->
            <Callout v-if="selected.problem" :tone="selected.status === 'failed' ? 'error' : 'warn'" :view="selected.problem" />
            <p v-if="selected.note" class="muted">{{ selected.note }}</p>
            <p v-if="selected.status === 'paused' && !selected.problem" class="muted">
              任务已暂停，断点已保留；点击「恢复采集」会从下一页继续执行。
            </p>
            <p v-if="selected.status === 'completed'" class="muted">
              采集完成，商品已入库。
              <button type="button" class="link" @click="emit('navigate', 'products')">前往商品库查看</button>
            </p>

            <Callout v-if="selectedAction?.phase === 'failed' && selectedAction.error" tone="error" :view="selectedAction.error" />

            <!-- 操作按钮栏 -->
            <div v-if="selected.canPause || selected.canResume || selected.canCancel" class="row">
              <button
                v-if="selected.canPause"
                type="button"
                class="btn"
                :disabled="selectedAction?.phase === 'running'"
                @click="runAction('pause', selected.id)"
              >
                {{ selectedAction?.phase === 'running' && selectedAction.kind === 'pause' ? '暂停中…' : '暂停' }}
              </button>
              <button
                v-if="selected.canResume"
                type="button"
                class="btn btn--primary"
                :disabled="selectedAction?.phase === 'running'"
                @click="runAction('resume', selected.id)"
              >
                {{ selectedAction?.phase === 'running' && selectedAction.kind === 'resume' ? '恢复中…' : '恢复采集' }}
              </button>
              <template v-if="selected.canCancel">
                <button
                  v-if="confirmCancelId !== selected.id"
                  type="button"
                  class="btn"
                  :disabled="selectedAction?.phase === 'running'"
                  @click="confirmCancelId = selected.id"
                >
                  取消任务
                </button>
                <template v-else>
                  <span class="muted">取消后不可恢复，确认取消？</span>
                  <button
                    type="button"
                    class="btn btn--danger"
                    :disabled="selectedAction?.phase === 'running'"
                    @click="runAction('cancel', selected.id)"
                  >
                    {{ selectedAction?.phase === 'running' && selectedAction.kind === 'cancel' ? '取消中…' : '确认取消' }}
                  </button>
                  <button type="button" class="btn btn--ghost" @click="confirmCancelId = null">返回</button>
                </template>
              </template>
            </div>
          </div>
        </PanelCard>
      </div>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(360px, 440px) minmax(460px, 1fr);
  gap: 16px;
  align-items: start;
}

.history-column {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.filters {
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-control);
  padding: 10px 14px 12px;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.filters__legend {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  padding: 0 4px;
}

/* 关键词与流量词输入群组 */
.suggest-field {
  position: relative;
}

.field__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 4px;
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
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-sunken);
}

.suggest-dropdown__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.suggest-dropdown__close {
  background: transparent;
  border: none;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-muted);
  padding: 2px 4px;
  border-radius: 4px;
}

.suggest-dropdown__close:hover {
  background: var(--border);
  color: var(--text);
}

.suggest-status,
.suggest-empty,
.suggest-error {
  padding: 12px 14px;
  font-size: 12.5px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 8px;
}

.suggest-error {
  color: var(--error);
  justify-content: space-between;
}

.suggest-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.suggest-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  max-height: 180px;
}

.suggest-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 12px;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.suggest-item:hover,
.suggest-item:focus-visible {
  background: var(--surface-sunken);
  outline: none;
}

.suggest-word {
  color: var(--text);
  font-weight: 500;
}

.suggest-tag {
  font-size: 11px;
  color: var(--accent-text);
  background: var(--accent-soft);
  padding: 2px 6px;
  border-radius: 4px;
}

.suggest-footer {
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  background: var(--surface-sunken);
}

.suggest-footer__tip {
  font-size: 11px;
  color: var(--text-muted);
}

.subtle-tip {
  font-size: 12px;
  color: var(--text-muted);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  padding: 6px 10px;
}

.blank {
  padding: 18px 14px;
}

.muted {
  font-size: 12.5px;
  color: var(--text-muted);
}

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
  font-size: 15px;
  font-weight: 650;
}

.task__progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.task__meta {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--text-muted);
  flex-wrap: wrap;
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
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}

.history-content {
  display: flex;
  flex-direction: column;
}

.list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.list > li + li {
  border-top: 1px solid var(--border);
}

.list__row {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 18px;
  background: transparent;
  border: none;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.list__row:hover {
  background: var(--surface-sunken);
}

.list__row--active,
.list__row--active:hover {
  background: var(--accent-soft);
  position: relative;
}

.list__row--active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
  background: var(--accent);
}

.list__row:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}

.list__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.list__keyword {
  font-weight: 600;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.list__time {
  font-size: 11.5px;
  color: var(--text-muted);
}

.list__side {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}

.pagination-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 18px;
  border-top: 1px solid var(--border);
  background: var(--surface-sunken);
  font-size: 12px;
}

.pagination-info {
  color: var(--text-muted);
}

.pagination-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn--xs {
  min-height: 24px;
  padding: 0 8px;
  font-size: 11.5px;
}

@media (max-width: 1099px) {
  .layout {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 599px) {
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
  .list__row {
    padding: 10px 14px;
  }
  .pagination-bar {
    flex-direction: column;
    gap: 8px;
    align-items: flex-start;
  }
}
</style>
