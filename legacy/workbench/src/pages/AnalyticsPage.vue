<script setup lang="ts">
import { computed, ref } from 'vue'
import { PhArrowClockwise, PhPlus, PhPencilSimple, PhTrash, PhPlay, PhEye } from '@phosphor-icons/vue'
import AppModal from '../components/AppModal.vue'
import Callout from '../components/Callout.vue'
import EmptyState from '../components/EmptyState.vue'
import PanelCard from '../components/PanelCard.vue'
import ProgressBar from '../components/ProgressBar.vue'
import StatusTag from '../components/StatusTag.vue'
import { useBridgeController } from '../composables/useBridgeController'
import type { PageId } from '../data/navigation'
import { formatFullTime } from '../features/chat/chat-format'
import {
  ANALYSIS_EVENTS,
  AnalysisController,
  isActiveAnalysis,
  type AnalysisState,
} from '../features/analysis/analysis-controller'
import {
  buildDatasetFilter,
  buildPromptRule,
  cellLink,
  defaultFilterDraft,
  describeAnalysisFailure,
  draftFromPromptRule,
  emptyPromptRuleDraft,
  formatCell,
  parseSampleLimit,
  type FilterDraftErrors,
  type PromptRuleDraft,
} from '../features/analysis/analysis-format'
import { taskStatusView } from '../features/capture/capture-format'
import { ALLOWED_TEMPLATE_VARIABLES, DATASET_MAX_LIMIT, type PromptRule } from '../features/contracts'

const emit = defineEmits<{ navigate: [page: PageId] }>()

const { state, controller } = useBridgeController<AnalysisState, AnalysisController>({
  events: ANALYSIS_EVENTS,
  timeoutMs: 20000,
  create: (api) => new AnalysisController({ api }),
})

const available = computed(() => state.value.availability === 'ready')

// ---------------- 数据源 ----------------
const sources = computed(() => state.value.sources)
const hasFeishu = computed(() => sources.value.items.some((source) => source.type === 'feishu'))
const schema = computed(() => (state.value.schema.sourceType === state.value.sourceType ? state.value.schema : null))

// ---------------- 过滤器与预览 ----------------
const filterDraft = ref(defaultFilterDraft())
const filterErrors = ref<FilterDraftErrors>({})
const preview = computed(() => (state.value.preview.sourceType === state.value.sourceType ? state.value.preview : null))
const PREVIEW_ROWS = 10
const previewFields = computed(() => (preview.value?.dataset?.schema.fields ?? schema.value?.schema?.fields ?? []).slice(0, 8))

function runPreview(): void {
  if (!hasFeishu.value || state.value.sourceType !== 'feishu') return
  const built = buildDatasetFilter(filterDraft.value)
  if (!built.ok) {
    filterErrors.value = built.errors
    return
  }
  filterErrors.value = {}
  void controller.queryPreview(built.filter)
}

// ---------------- 提示词规则 ----------------
const rules = computed(() => state.value.rules)
const selectedRule = computed(() => rules.value.items.find((rule) => rule.id === state.value.selectedRuleId) ?? null)
const ruleEditor = ref<PromptRuleDraft | null>(null)
const ruleErrors = ref<string[]>([])
const confirmDeleteId = ref<string | null>(null)
const ruleBusy = computed(() => state.value.ruleOp.phase === 'running')
const variableList = [...ALLOWED_TEMPLATE_VARIABLES].map((name) => `{{${name}}}`).join('  ')

function newRule(): void {
  ruleEditor.value = emptyPromptRuleDraft()
  ruleErrors.value = []
  controller.clearRuleOp()
}

function editRule(rule: PromptRule): void {
  ruleEditor.value = draftFromPromptRule(rule)
  ruleErrors.value = []
  controller.clearRuleOp()
}

function closeRuleEditor(): void {
  ruleEditor.value = null
  ruleErrors.value = []
}

async function saveRule(): Promise<void> {
  const draft = ruleEditor.value
  if (!draft || ruleBusy.value) return
  const existing = rules.value.items.find((rule) => rule.id === draft.id) ?? null
  const built = buildPromptRule(draft, { existing })
  if (!built.ok) {
    ruleErrors.value = built.errors
    return
  }
  ruleErrors.value = []
  if (await controller.upsertRule(built.rule)) closeRuleEditor()
}

async function removeRule(ruleId: string): Promise<void> {
  confirmDeleteId.value = null
  if (ruleEditor.value?.id === ruleId) closeRuleEditor()
  await controller.deleteRule(ruleId)
}

// ---------------- 分析任务 ----------------
const sampleLimitText = ref('20')
const sampleError = ref('')
const customInstructions = ref('')
const task = computed(() => state.value.task)
const current = computed(() => task.value.current)
const active = computed(() => isActiveAnalysis(current.value))
const creating = computed(() => task.value.create.phase === 'running')
const canStart = computed(
  () =>
    available.value &&
    hasFeishu.value &&
    state.value.sourceType === 'feishu' &&
    Boolean(selectedRule.value) &&
    !creating.value &&
    !active.value,
)
const currentStatus = computed(() => (current.value ? taskStatusView(current.value.status) : null))
const failure = computed(() => (current.value?.status === 'failed' ? describeAnalysisFailure(current.value.error ?? '') : null))
const cancelledNote = computed(() => (current.value?.status === 'cancelled' ? '分析已取消，没有生成结果。' : ''))

function startAnalysis(): void {
  if (!canStart.value || !selectedRule.value || !hasFeishu.value) return
  const sample = parseSampleLimit(sampleLimitText.value)
  const built = buildDatasetFilter(filterDraft.value)
  sampleError.value = sample.error ?? ''
  filterErrors.value = built.ok ? {} : built.errors
  if (sample.value === undefined || !built.ok) return
  void controller.startAnalysis({
    ruleId: selectedRule.value.id,
    filter: built.filter,
    sampleLimit: sample.value,
    customInstructions: customInstructions.value,
  })
}

const result = computed(() => state.value.result)
const output = computed(() => result.value.data?.output ?? null)

function formatPrice(val: number | string | undefined | null): string {
  if (val === undefined || val === null || val === '') return '—'
  if (typeof val === 'number') {
    return '¥' + val.toLocaleString('zh-CN')
  }
  return String(val).startsWith('¥') ? String(val) : `¥${val}`
}
</script>

<template>
  <div class="page analytics-page">
    <!-- 顶部状态通知区 -->
    <div class="notices-wrap">
      <Callout v-if="available" tone="info">
        分析会将抽样商品数据发送给已配置的 AI 模型，请确认数据可以发送。
        <template #actions>
          <button type="button" class="btn btn--sm" @click="emit('navigate', 'settings')">
            <PhEye :size="16" aria-hidden="true" />查看配置
          </button>
        </template>
      </Callout>

      <Callout v-if="state.targetTable.changed" tone="warn" title="飞书目标表格已变更">
        <template #default>
          {{ state.targetTable.changeMessage }}
        </template>
        <template #actions>
          <button type="button" class="btn btn--sm" @click="controller.dismissTableChangeNotice()">我知道了</button>
        </template>
      </Callout>

      <Callout v-if="available && !hasFeishu" tone="warn" title="未配置飞书数据源">
        <template #default>
          请先在设置中连接飞书商品表，再预览数据或开始分析。
        </template>
        <template #actions>
          <button type="button" class="btn btn--sm btn--primary" @click="emit('navigate', 'settings')">配置飞书</button>
        </template>
      </Callout>

      <Callout v-if="state.realtimeError" tone="warn">{{ state.realtimeError }}（可点击任务面板的「刷新状态」）</Callout>
    </div>

    <!-- 页面标题与轻质副标题 -->
    <header class="view-header">
      <div class="view-title-group">
        <h1 class="view-title">数据分析</h1>
        <span class="view-sub">结构化数据分析与价格洞察：价格分析、商机与风险</span>
      </div>
    </header>

    <div class="analysis-layout">
      <!-- 左侧：分析配置栏 -->
      <aside class="analysis-config" aria-label="分析配置">
        <!-- 1. 数据源卡片 -->
        <PanelCard class="source-panel" title="数据源" description="飞书多维表格与字段定义">
          <template #actions>
            <button
              type="button"
              class="btn btn--sm icon-btn"
              :disabled="!available || sources.phase === 'loading'"
              title="刷新数据源"
              aria-label="刷新数据源"
              @click="controller.loadSources()"
            >
              <PhArrowClockwise :size="16" />
            </button>
          </template>

          <p v-if="!available" class="muted">未连接扩展。</p>
          <p v-else-if="sources.phase === 'idle' || sources.phase === 'loading'" class="muted" role="status">正在读取数据源…</p>
          <Callout v-else-if="sources.phase === 'error'" tone="error" :view="sources.error" />
          <template v-else>
            <fieldset class="sources">
              <legend class="sr-only">数据源选择</legend>
              <label class="source-item" :class="{ 'source-item--active': state.sourceType === 'feishu', 'source-item--off': !hasFeishu }">
                <input
                  type="radio"
                  name="data-source"
                  value="feishu"
                  :checked="state.sourceType === 'feishu'"
                  :disabled="!hasFeishu"
                  @change="controller.selectSource('feishu')"
                />
                <span class="source-item__text">
                  <span class="source-item__title">飞书多维表格</span>
                  <span class="source-item__desc">
                    {{
                      hasFeishu
                        ? (state.targetTable.currentTableId
                            ? `已连接飞书商品表：${state.targetTable.currentTableId}`
                            : '后台已连接飞书多维表格')
                        : '请先在设置中连接飞书商品表'
                    }}
                  </span>
                </span>
              </label>
            </fieldset>

            <details v-if="state.sourceType" class="schema-details">
              <summary class="schema-summary">查看字段定义</summary>
              <p v-if="state.schema.phase === 'loading'" class="muted" role="status">正在读取 Schema…</p>
              <Callout v-else-if="state.schema.phase === 'error'" tone="error" :view="state.schema.error">
                <template #actions>
                  <button type="button" class="btn btn--sm" @click="controller.reloadSchema()">重试</button>
                </template>
              </Callout>
              <template v-else-if="schema?.schema">
                <p class="muted schema-caption">{{ schema.schema.label }}（共 {{ schema.schema.fields.length }} 个字段）</p>
                <ul class="fields-list" aria-label="数据源字段">
                  <li v-for="field in schema.schema.fields" :key="field.name" class="fields-list__item" :title="field.description">
                    <span class="fields-list__label">{{ field.label }}</span>
                    <code class="fields-list__code">{{ field.name }}</code>
                    <StatusTag class="fields-list__tag">{{ field.type }}</StatusTag>
                    <StatusTag v-if="field.required" tone="accent" class="fields-list__tag">必填</StatusTag>
                  </li>
                </ul>
              </template>
            </details>
          </template>
        </PanelCard>

        <!-- 2. 筛选范围卡片 -->
        <PanelCard class="filter-panel" title="筛选范围" description="按关键词与数值范围提取待分析样本">
          <form class="form" novalidate @submit.prevent="runPreview">
            <div class="field">
              <label class="field__label" for="f-keyword">关键词（标题 / 商品 ID）</label>
              <input id="f-keyword" v-model="filterDraft.keyword" class="input" autocomplete="off" :disabled="!available" />
              <span v-if="filterErrors.keyword" class="field__error" role="alert">{{ filterErrors.keyword }}</span>
            </div>

            <details class="advanced-filter" :open="Object.keys(filterErrors).length > 0">
              <summary class="filter-summary">更多筛选选项</summary>
              <div class="form-grid">
                <div class="field">
                  <label class="field__label" for="f-minprice">最低价格</label>
                  <input id="f-minprice" v-model="filterDraft.minPrice" class="input" inputmode="decimal" :disabled="!available" />
                  <span v-if="filterErrors.minPrice" class="field__error" role="alert">{{ filterErrors.minPrice }}</span>
                </div>
                <div class="field">
                  <label class="field__label" for="f-maxprice">最高价格</label>
                  <input id="f-maxprice" v-model="filterDraft.maxPrice" class="input" inputmode="decimal" :disabled="!available" />
                  <span v-if="filterErrors.maxPrice" class="field__error" role="alert">{{ filterErrors.maxPrice }}</span>
                </div>
                <div class="field">
                  <label class="field__label" for="f-minwant">最小想要人数</label>
                  <input id="f-minwant" v-model="filterDraft.minWantCnt" class="input" inputmode="numeric" :disabled="!available" />
                  <span v-if="filterErrors.minWantCnt" class="field__error" role="alert">{{ filterErrors.minWantCnt }}</span>
                </div>
                <div class="field">
                  <label class="field__label" for="f-maxwant">最大想要人数</label>
                  <input id="f-maxwant" v-model="filterDraft.maxWantCnt" class="input" inputmode="numeric" :disabled="!available" />
                  <span v-if="filterErrors.maxWantCnt" class="field__error" role="alert">{{ filterErrors.maxWantCnt }}</span>
                </div>
                <div class="field field--full">
                  <label class="field__label" for="f-limit">数据范围上限（条）</label>
                  <input id="f-limit" v-model="filterDraft.limit" class="input" inputmode="numeric" :disabled="!available" />
                  <span v-if="filterErrors.limit" class="field__error" role="alert">{{ filterErrors.limit }}</span>
                  <span v-else class="field__hint">1 到 {{ DATASET_MAX_LIMIT }}</span>
                </div>
              </div>

              <label class="check-row">
                <input v-model="filterDraft.onlyFreeShip" type="checkbox" :disabled="!available" />
                <span>仅包邮商品</span>
              </label>
            </details>

            <div class="form-actions">
              <button
                type="submit"
                class="btn"
                :disabled="!available || !state.sourceType || preview?.phase === 'running'"
              >
                <PhEye :size="16" aria-hidden="true" />
                {{ preview?.phase === 'running' ? '查询中…' : '预览数据' }}
              </button>
            </div>
          </form>
        </PanelCard>

        <!-- 3. 分析规则卡片 -->
        <PanelCard class="rules-panel" title="分析规则" description="选择或自定义模型分析提示词策略">
          <template #actions>
            <button type="button" class="btn btn--sm" :disabled="!available || ruleBusy" @click="newRule">
              <PhPlus :size="16" aria-hidden="true" />新建规则
            </button>
          </template>

          <p v-if="!available" class="muted">未连接扩展。</p>
          <p v-else-if="rules.phase === 'idle' || rules.phase === 'loading'" class="muted" role="status">正在读取提示词规则…</p>
          <Callout v-else-if="rules.phase === 'error'" tone="error" :view="rules.error">
            <template #actions>
              <button type="button" class="btn btn--sm" @click="controller.loadRules()">重试</button>
            </template>
          </Callout>
          <template v-else>
            <Callout v-if="state.ruleOp.phase === 'failed' && state.ruleOp.error" tone="error">{{ state.ruleOp.error }}</Callout>
            <Callout v-else-if="state.ruleOp.phase === 'ok'" tone="ok">
              {{ state.ruleOp.kind === 'delete' ? '规则已删除。' : '规则已保存。' }}
            </Callout>

            <EmptyState
              v-if="rules.items.length === 0 && !ruleEditor"
              title="还没有提示词规则"
              description="分析需要选择一条规则。点击「新建规则」创建。"
            />

            <fieldset v-if="rules.items.length > 0" class="rules-list">
              <legend class="sr-only">选择分析使用的提示词规则</legend>
              <div
                v-for="rule in rules.items"
                :key="rule.id"
                class="rule-item"
                :class="{ 'rule-item--active': rule.id === state.selectedRuleId }"
              >
                <label class="rule-item__pick">
                  <input
                    type="radio"
                    name="prompt-rule"
                    :value="rule.id"
                    :checked="rule.id === state.selectedRuleId"
                    @change="controller.selectRule(rule.id)"
                  />
                  <span class="rule-item__text">
                    <span class="rule-item__name">{{ rule.name }}</span>
                    <span v-if="rule.description" class="rule-item__desc">{{ rule.description }}</span>
                  </span>
                </label>

                <div class="rule-item__actions">
                  <button
                    type="button"
                    class="btn btn--sm"
                    :disabled="ruleBusy"
                    :aria-label="`编辑规则 ${rule.name}`"
                    :title="`编辑 ${rule.name}`"
                    @click="editRule(rule)"
                  >
                    <PhPencilSimple :size="16" />
                  </button>
                  <template v-if="confirmDeleteId === rule.id">
                    <button type="button" class="btn btn--sm btn--danger" :disabled="ruleBusy" @click="removeRule(rule.id)">确认删除</button>
                    <button type="button" class="btn btn--sm btn--ghost" @click="confirmDeleteId = null">返回</button>
                  </template>
                  <button
                    v-else
                    type="button"
                    class="btn btn--sm"
                    :disabled="ruleBusy"
                    :aria-label="`删除规则 ${rule.name}`"
                    :title="`删除 ${rule.name}`"
                    @click="confirmDeleteId = rule.id"
                  >
                    <PhTrash :size="16" />
                  </button>
                </div>
              </div>
            </fieldset>
          </template>
        </PanelCard>

        <!-- 4. 运行分析卡片 -->
        <PanelCard class="run-panel" title="运行分析" description="设置抽样条数并向模型发起分析任务">
          <div class="run-form">
            <div class="form-grid">
              <div class="field field--full">
                <label class="field__label" for="a-sample">送入模型的抽样条数</label>
                <input id="a-sample" v-model="sampleLimitText" class="input" inputmode="numeric" :disabled="!available || active || creating" />
                <span v-if="sampleError" class="field__error" role="alert">{{ sampleError }}</span>
                <span v-else class="field__hint">1 到 50，默认 20</span>
              </div>
              <div class="field field--full">
                <label class="field__label" for="a-custom">补充要求（可选）</label>
                <textarea
                  id="a-custom"
                  v-model="customInstructions"
                  class="input"
                  rows="2"
                  maxlength="500"
                  :disabled="!available || active || creating"
                  placeholder="例如：重点关注 100 元以下的商品"
                ></textarea>
              </div>
            </div>

            <p class="muted run-status-summary">
              数据源：<strong>{{ state.sourceType === 'feishu' ? '飞书多维表格' : state.sourceType === 'local' ? '本地商品库' : '未选择' }}</strong>
              · 规则：<strong>{{ selectedRule?.name ?? '未选择' }}</strong>
            </p>

            <Callout v-if="task.create.phase === 'failed' && task.create.error" tone="error" :view="task.create.error" />

            <div class="run-actions">
              <button type="button" class="btn btn--primary" :disabled="!canStart" @click="startAnalysis">
                <PhPlay :size="16" aria-hidden="true" />
                {{ creating ? '正在创建…' : active ? '分析进行中' : '开始分析' }}
              </button>
              <button
                v-if="active"
                type="button"
                class="btn"
                :disabled="task.cancel.phase === 'running'"
                @click="controller.cancelAnalysis()"
              >
                {{ task.cancel.phase === 'running' ? '取消中…' : '取消分析' }}
              </button>
              <button
                v-if="current"
                type="button"
                class="btn btn--ghost"
                :disabled="task.refresh.phase === 'running'"
                @click="controller.refreshTask()"
              >
                {{ task.refresh.phase === 'running' ? '刷新中…' : '刷新状态' }}
              </button>
            </div>

            <Callout v-if="task.cancel.phase === 'failed' && task.cancel.error" tone="error" :view="task.cancel.error" />
            <Callout v-if="task.refresh.phase === 'failed' && task.refresh.error" tone="warn" :view="task.refresh.error" />
            <Callout v-if="task.restore.phase === 'error' && task.restore.error" tone="warn" :view="task.restore.error" />
          </div>
        </PanelCard>
      </aside>

      <!-- 右侧：数据预览与分析结果栏 -->
      <section class="analysis-output" aria-label="数据预览和分析结果">
        <!-- 数据预览卡片 -->
        <PanelCard class="preview-panel" title="数据预览" description="抽样数据结构及字段内容预览">
          <div class="preview-container" aria-live="polite">
            <Callout v-if="preview?.phase === 'failed'" tone="error" :view="preview.error" />
            <p v-else-if="preview?.phase === 'running'" class="muted" role="status">正在查询数据源…</p>
            <template v-else-if="preview?.phase === 'ok' && preview.dataset">
              <template v-if="preview.dataset.rows.length === 0">
                <EmptyState
                  title="数据源没有符合条件的数据"
                  description="分析需要至少一条数据。请先去数据采集页采集商品，或放宽上面的过滤条件。"
                >
                  <button type="button" class="btn btn--sm" @click="emit('navigate', 'collect')">去采集</button>
                </EmptyState>
              </template>
              <template v-else>
                <p class="muted preview-count-note">
                  匹配 {{ preview.dataset.total }} 条，本次返回 {{ preview.dataset.rows.length }} 条<template v-if="preview.dataset.truncated">（已按安全上限截断）</template>，下表显示前 {{ Math.min(PREVIEW_ROWS, preview.dataset.rows.length) }} 条。
                </p>
                <div class="table-wrap" tabindex="0" role="region" aria-label="数据预览，可横向滚动">
                  <table class="table">
                    <caption class="sr-only">数据预览</caption>
                    <thead>
                      <tr>
                        <th v-for="field in previewFields" :key="field.name" scope="col">{{ field.label }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(row, index) in preview.dataset.rows.slice(0, PREVIEW_ROWS)" :key="index">
                        <td v-for="field in previewFields" :key="field.name">
                          <a
                            v-if="cellLink(field, row[field.name])"
                            :href="cellLink(field, row[field.name]) ?? undefined"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            打开
                          </a>
                          <span v-else>{{ formatCell(field, row[field.name]) }}</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </template>
            </template>
          </div>
          <EmptyState v-if="!preview || preview.phase === 'idle'" title="预览待分析的数据" description="设置筛选范围后，点击「预览数据」。" />
        </PanelCard>

        <!-- 分析结果卡片 -->
        <PanelCard class="result-panel" title="分析结果" description="AI 模型生成的结构化分析与定价洞察">
          <!-- 任务执行实时状态 -->
          <div v-if="current && currentStatus" class="job-status-card" aria-live="polite">
            <div class="job-status-card__head">
              <StatusTag :tone="currentStatus.tone" :dot="active" :pulse="current.status === 'running'">
                {{ currentStatus.label }}
              </StatusTag>
              <span class="muted">任务创建于 {{ formatFullTime(current.createdAt) }}</span>
            </div>
            <ProgressBar
              :value="current.progress"
              :label="`分析进度 ${current.progress}%`"
              :tone="current.status === 'failed' ? 'error' : current.status === 'completed' ? 'ok' : 'accent'"
            />
            <p class="muted job-progress-text"><span class="mono">{{ current.progress }}%</span></p>
            <Callout v-if="failure" tone="error" :view="failure" />
            <p v-if="cancelledNote" class="muted">{{ cancelledNote }}</p>
          </div>

          <!-- 分析结果内容 -->
          <div v-if="current?.status === 'completed'" class="result-container">
            <p v-if="result.phase === 'loading'" class="muted" role="status">正在读取分析结果…</p>
            <Callout v-else-if="result.phase === 'error'" tone="error" title="分析结果不可用">
              {{ result.error }}
              <template #actions>
                <button type="button" class="btn btn--sm" @click="controller.retryResult()">重新读取</button>
              </template>
            </Callout>

            <template v-else-if="result.phase === 'ready' && result.data && output">
              <!-- 结果元信息栏 -->
              <div class="result-meta-bar">
                <span class="meta-chip">规则「{{ result.data.ruleName }}」</span>
                <span class="meta-chip">样本 {{ result.data.sampleCount }} / 匹配 {{ result.data.totalCount }} 条</span>
                <span class="meta-chip">模型 {{ result.data.modelUsed }}</span>
                <span class="meta-chip">{{ formatFullTime(result.data.analyzedAt) }}</span>
                <span v-if="result.data.usage?.totalTokens" class="meta-chip meta-chip--token">{{ result.data.usage.totalTokens }} tokens</span>
              </div>

              <!-- 1. 数据摘要卡片 (Seline 风格白卡，左侧闲鱼黄微边饰条，渲染真实 output.summary) -->
              <div class="seline-summary-card">
                <div class="summary-card__header">
                  <span class="summary-tag">数据摘要 · Summary</span>
                </div>
                <p class="summary-prose">{{ output.summary }}</p>
              </div>

              <!-- 2. 价格分析卡片 (使用真实 output.priceAnalysis 输出) -->
              <div v-if="output.priceAnalysis" class="seline-subcard price-analysis-card">
                <div class="subcard-header">
                  <div class="subcard-title-wrap">
                    <span class="subcard-title">价格分析</span>
                    <span class="subcard-caption">priceRange / competition / recommendation</span>
                  </div>
                </div>
                <div class="subcard-body">
                  <div class="key-value-grid">
                    <div class="kv-item">
                      <span class="kv-label">价格区间</span>
                      <span class="kv-val">{{ output.priceAnalysis.priceRange || '未提供' }}</span>
                    </div>
                    <div class="kv-item">
                      <span class="kv-label">均价</span>
                      <span class="kv-val mono">{{ formatPrice(output.priceAnalysis.avgPrice) }}</span>
                    </div>
                    <div class="kv-item">
                      <span class="kv-label">中位价</span>
                      <span class="kv-val mono">{{ formatPrice(output.priceAnalysis.medianPrice) }}</span>
                    </div>
                    <div v-if="output.priceAnalysis.recommendation" class="kv-item kv-item--full">
                      <span class="kv-label">定价建议</span>
                      <span class="kv-val">{{ output.priceAnalysis.recommendation }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 3. 潜在商机与风险提示并列网格 (真实 output.opportunities 与 output.risks 输出) -->
              <div class="insights-grid">
                <!-- 潜在商机卡片 -->
                <div class="seline-subcard insight-card">
                  <div class="subcard-header">
                    <div class="subcard-title-wrap">
                      <span class="subcard-title">潜在商机</span>
                      <span class="subcard-caption">opportunities</span>
                    </div>
                  </div>
                  <div class="subcard-body">
                    <div v-if="output.opportunities.length > 0" class="insight-list">
                      <div v-for="(item, index) in output.opportunities" :key="index" class="insight-row">
                        <span class="insight-dot green" aria-hidden="true"></span>
                        <div class="insight-content">
                          <span class="insight-text">{{ item }}</span>
                        </div>
                      </div>
                    </div>
                    <p v-else class="muted insight-empty">模型没有给出机会点。</p>
                  </div>
                </div>

                <!-- 风险提示卡片 -->
                <div class="seline-subcard insight-card">
                  <div class="subcard-header">
                    <div class="subcard-title-wrap">
                      <span class="subcard-title">风险提示</span>
                      <span class="subcard-caption">risks</span>
                    </div>
                  </div>
                  <div class="subcard-body">
                    <div v-if="output.risks.length > 0" class="insight-list">
                      <div v-for="(item, index) in output.risks" :key="index" class="insight-row">
                        <span class="insight-dot red" aria-hidden="true"></span>
                        <div class="insight-content">
                          <span class="insight-text">{{ item }}</span>
                        </div>
                      </div>
                    </div>
                    <p v-else class="muted insight-empty">模型没有给出风险提示。</p>
                  </div>
                </div>
              </div>
            </template>
          </div>

          <EmptyState v-if="!current && !creating" title="尚无分析结果" description="选择规则并开始分析，结果将显示在这里。" />
        </PanelCard>
      </section>
    </div>

    <!-- 规则编辑弹窗 -->
    <AppModal :open="Boolean(ruleEditor)" :title="ruleEditor?.id ? '编辑规则' : '新建规则'" :busy="ruleBusy" @close="closeRuleEditor">
      <form v-if="ruleEditor" class="form editor" novalidate @submit.prevent="saveRule">
        <p class="muted modal-desc">规则决定模型如何分析商品数据，请勿填写密钥。</p>
        <Callout v-if="state.ruleOp.phase === 'failed' && state.ruleOp.error" tone="error">{{ state.ruleOp.error }}</Callout>
        <div class="field">
          <label class="field__label" for="pr-name">规则名称</label>
          <input id="pr-name" v-model="ruleEditor.name" class="input" :disabled="ruleBusy" />
        </div>
        <div class="field">
          <label class="field__label" for="pr-desc">说明（可选）</label>
          <input id="pr-desc" v-model="ruleEditor.description" class="input" :disabled="ruleBusy" />
        </div>
        <div class="field">
          <label class="field__label" for="pr-system">系统提示词</label>
          <textarea id="pr-system" v-model="ruleEditor.systemPrompt" class="input" rows="5" :disabled="ruleBusy"></textarea>
          <span class="field__hint">需要要求模型只输出 JSON，包含 summary、keyFindings、priceAnalysis、opportunities、risks。</span>
        </div>
        <div class="field">
          <label class="field__label" for="pr-user">用户提示词模板</label>
          <textarea id="pr-user" v-model="ruleEditor.userPromptTemplate" class="input" rows="5" :disabled="ruleBusy"></textarea>
          <span class="field__hint">可用变量：<code>{{ variableList }}</code></span>
        </div>
        <Callout v-if="ruleErrors.length > 0" tone="error">
          <ul class="errors">
            <li v-for="message in ruleErrors" :key="message">{{ message }}</li>
          </ul>
        </Callout>
        <div class="modal-actions">
          <button type="submit" class="btn btn--primary" :disabled="ruleBusy">{{ ruleBusy ? '保存中…' : '保存规则' }}</button>
          <button type="button" class="btn" :disabled="ruleBusy" @click="closeRuleEditor">取消</button>
        </div>
      </form>
    </AppModal>
  </div>
</template>

<style scoped>
/* ================= 页面整体布局 ================= */
.analytics-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.notices-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Seline 风格轻标题头部 */
.view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 0 2px;
}

.view-title-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.view-title {
  margin: 0;
  font-size: 18px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--text);
  line-height: 1.35;
}

.view-sub {
  font-size: 12.5px;
  color: var(--text-muted);
  line-height: 1.45;
}

/* 双栏自适应网格 */
.analysis-layout {
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.analysis-config,
.analysis-output {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

/* 统一覆盖 PanelCard 的 Seline 暖纸白卡外观 */
.analysis-layout :deep(.panel) {
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.02);
  transition: border-color 0.15s ease;
}

.analysis-layout :deep(.panel__head) {
  padding: 14px 16px 0;
}

.analysis-layout :deep(.panel__title) {
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--text);
}

.analysis-layout :deep(.panel__desc) {
  font-size: 11.5px;
  color: var(--text-muted);
}

.analysis-layout :deep(.panel__body) {
  padding: 14px 16px 16px;
}

/* ================= 基础控件与文字 ================= */
.form {
  display: grid;
  gap: 12px;
}

.muted {
  font-size: 12px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.mono {
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}

.icon-btn {
  padding: 0 8px;
}

/* ================= 数据源 ================= */
.sources {
  display: grid;
  gap: 8px;
  min-width: 0;
  margin: 0 0 12px;
  padding: 0;
  border: 0;
}

.source-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface);
  cursor: pointer;
  transition: all 0.15s ease;
}

.source-item:hover:not(.source-item--off) {
  border-color: var(--border-strong);
}

.source-item--active {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.source-item:has(input:focus-visible) {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.source-item--off {
  cursor: not-allowed;
  opacity: 0.65;
}

.source-item__text {
  display: grid;
  gap: 2px;
}

.source-item__title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.source-item__desc {
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.4;
}

.schema-details {
  display: grid;
  gap: 8px;
  margin-top: 4px;
}

.schema-summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  user-select: none;
}

.schema-summary:hover {
  color: var(--text);
}

.schema-summary:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.schema-caption {
  margin: 2px 0 4px;
}

.fields-list {
  display: grid;
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
}

.fields-list__item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  padding: 6px 10px;
  font-size: 12px;
  background: var(--surface);
}

.fields-list__item + .fields-list__item {
  border-top: 1px solid var(--border);
}

.fields-list__label {
  font-weight: 500;
  color: var(--text);
}

.fields-list__code {
  font-family: var(--mono);
  font-size: 11px;
}

.fields-list__tag {
  font-size: 11px;
}

/* ================= 筛选范围 ================= */
.advanced-filter {
  margin-top: 4px;
}

.filter-summary {
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  margin-bottom: 10px;
  user-select: none;
}

.filter-summary:hover {
  color: var(--text);
}

.filter-summary:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 12px;
}

.field--full {
  grid-column: 1 / -1;
}

.field {
  display: grid;
  gap: 4px;
}

.field__label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
}

.field__error {
  font-size: 11.5px;
  color: var(--error);
}

.field__hint {
  font-size: 11.5px;
  color: var(--text-muted);
}

.check-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 12.5px;
  cursor: pointer;
  user-select: none;
}

.check-row input {
  cursor: pointer;
}

.form-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}

/* ================= 提示词规则 ================= */
.rules-list {
  display: grid;
  min-width: 0;
  margin: 0 0 12px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  overflow: hidden;
}

.rule-item {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 9px 12px;
  background: var(--surface);
  transition: background-color 0.15s ease;
}

.rule-item + .rule-item {
  border-top: 1px solid var(--border);
}

.rule-item--active {
  background: var(--accent-soft);
}

.rule-item__pick {
  display: flex;
  flex: 1 1 240px;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  cursor: pointer;
}

.rule-item__text {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.rule-item__name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text);
  overflow-wrap: anywhere;
}

.rule-item__desc {
  font-size: 11.5px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
  line-height: 1.4;
}

.rule-item__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

/* ================= 运行分析 ================= */
.run-form {
  display: grid;
  gap: 12px;
}

.run-status-summary {
  font-size: 12px;
  padding: 6px 10px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
}

.run-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

/* ================= 数据预览 ================= */
.preview-container {
  display: grid;
  gap: 10px;
}

.preview-count-note {
  font-size: 12px;
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface);
}

.table-wrap:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.table {
  width: 100%;
  min-width: 560px;
  border-collapse: collapse;
}

.table th {
  padding: 8px 12px;
  font-size: 11.5px;
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
  color: var(--text-muted);
  background: var(--surface-sunken);
  border-bottom: 1px solid var(--border);
}

.table td {
  max-width: 240px;
  padding: 8px 12px;
  font-size: 12.5px;
  border-top: 1px solid var(--border);
  overflow-wrap: anywhere;
}

.table tbody tr:hover td {
  background: var(--surface-sunken);
}

/* ================= 分析结果与任务状态 ================= */
.job-status-card {
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
  margin-bottom: 14px;
}

.job-status-card__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.job-progress-text {
  font-size: 11.5px;
  margin-top: -2px;
}

.result-container {
  display: grid;
  gap: 14px;
}

/* 结果元信息胶囊栏 */
.result-meta-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  padding-bottom: 2px;
}

.meta-chip {
  display: inline-flex;
  align-items: center;
  font-size: 11.5px;
  padding: 2px 9px;
  border-radius: 9999px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  color: var(--text-muted);
}

.meta-chip--token {
  font-family: var(--mono);
  color: var(--text);
  border-color: var(--border-strong);
}

/* 1. Seline 风格数据摘要卡片（暖纸白卡，细边框，左侧闲鱼黄微边饰条） */
.seline-summary-card {
  position: relative;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px 14px 18px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.03);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.seline-summary-card::before {
  content: "";
  position: absolute;
  left: 0;
  top: 12px;
  bottom: 12px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
}

.summary-card__header {
  display: flex;
  align-items: center;
}

.summary-tag {
  font-size: 11px;
  font-weight: 500;
  color: var(--accent-text);
  letter-spacing: 0.02em;
}

.summary-prose {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

/* Seline 子卡片通用样式（细边框、轻标题） */
.seline-subcard {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.02);
}

.subcard-header {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.subcard-title-wrap {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.subcard-title {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--text);
}

.subcard-caption {
  font-size: 11px;
  color: var(--text-muted);
}

.subcard-body {
  padding: 14px;
}

/* 2. 价格分析键值对网格 (key-value grid) */
.key-value-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px 16px;
  font-size: 12.5px;
}

.kv-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.kv-item--full {
  grid-column: 1 / -1;
}

.kv-label {
  font-size: 11.5px;
  color: var(--text-muted);
}

.kv-val {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  overflow-wrap: anywhere;
}

/* 3. 潜在商机与风险提示并列网格 */
.insights-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.insight-list {
  display: flex;
  flex-direction: column;
}

.insight-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}

.insight-row:first-child {
  padding-top: 0;
}

.insight-row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.insight-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-top: 6px;
  flex-shrink: 0;
}

.insight-dot.green {
  background: var(--ok);
}

.insight-dot.red {
  background: var(--error);
}

.insight-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.insight-text {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text);
  overflow-wrap: anywhere;
}

.insight-empty {
  font-size: 12px;
  padding: 4px 0;
}

/* ================= 规则编辑弹窗 ================= */
.editor {
  padding: 0;
}

.modal-desc {
  margin-bottom: 4px;
}

.errors {
  margin: 0;
  padding-left: 18px;
  list-style: disc;
}

.modal-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
}

/* ================= 响应式媒体查询 ================= */
@media (max-width: 960px) {
  .analysis-layout {
    grid-template-columns: minmax(0, 1fr);
  }

  .insights-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .key-value-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .key-value-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
