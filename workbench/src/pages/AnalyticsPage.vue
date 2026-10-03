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
</script>

<template>
  <div class="page">
    <Callout v-if="available" tone="info">
      分析会将抽样商品数据发送给已配置的 AI 模型，请确认数据可以发送。
      <template #actions>
        <button type="button" class="btn btn--sm" @click="emit('navigate', 'settings')"><PhEye :size="16" aria-hidden="true" />查看配置</button>
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

    <div class="analysis-layout">
      <aside class="analysis-config" aria-label="分析配置">
      <PanelCard class="source-panel" title="数据源">
        <template #actions>
          <button type="button" class="btn btn--sm" :disabled="!available || sources.phase === 'loading'" title="刷新数据源" aria-label="刷新数据源" @click="controller.loadSources()"><PhArrowClockwise :size="16" /></button>
        </template>

        <p v-if="!available" class="muted">未连接扩展。</p>
        <p v-else-if="sources.phase === 'idle' || sources.phase === 'loading'" class="muted" role="status">正在读取数据源…</p>
        <Callout v-else-if="sources.phase === 'error'" tone="error" :view="sources.error" />
        <template v-else>
          <fieldset class="sources">
            <legend class="sr-only">数据源</legend>
            <label class="source" :class="{ 'source--off': !hasFeishu }">
              <input
                type="radio"
                name="data-source"
                value="feishu"
                :checked="state.sourceType === 'feishu'"
                :disabled="!hasFeishu"
                @change="controller.selectSource('feishu')"
              />
              <span class="source__text">
                <span class="source__name">飞书多维表格</span>
                <span class="source__desc">
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

          <details v-if="state.sourceType" class="schema">
            <summary>查看字段</summary>
            <p v-if="state.schema.phase === 'loading'" class="muted" role="status">正在读取 Schema…</p>
            <Callout v-else-if="state.schema.phase === 'error'" tone="error" :view="state.schema.error">
              <template #actions>
                <button type="button" class="btn btn--sm" @click="controller.reloadSchema()">重试</button>
              </template>
            </Callout>
            <template v-else-if="schema?.schema">
              <p class="muted">{{ schema.schema.label }}（{{ schema.schema.fields.length }} 个字段）</p>
              <ul class="fields" aria-label="数据源字段">
                <li v-for="field in schema.schema.fields" :key="field.name" class="fields__item" :title="field.description">
                  <span class="fields__label">{{ field.label }}</span>
                  <code>{{ field.name }}</code>
                  <StatusTag>{{ field.type }}</StatusTag>
                  <StatusTag v-if="field.required" tone="accent">必填</StatusTag>
                </li>
              </ul>
            </template>
          </details>
        </template>
      </PanelCard>
      <PanelCard class="filter-panel" title="筛选范围">
        <form class="form" novalidate @submit.prevent="runPreview">
          <div class="field">
            <label class="field__label" for="f-keyword">关键词（标题 / 商品 ID）</label>
            <input id="f-keyword" v-model="filterDraft.keyword" class="input" autocomplete="off" :disabled="!available" />
            <span v-if="filterErrors.keyword" class="field__error" role="alert">{{ filterErrors.keyword }}</span>
          </div>
          <details class="advanced-filter" :open="Object.keys(filterErrors).length > 0">
            <summary>更多筛选</summary>
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
            <div class="field">
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
          <div class="row">
            <button type="submit" class="btn" :disabled="!available || !state.sourceType || preview?.phase === 'running'">
              <PhEye :size="16" aria-hidden="true" />{{ preview?.phase === 'running' ? '查询中…' : '预览数据' }}
            </button>
          </div>
        </form>


      </PanelCard>
    <PanelCard class="rules-panel" title="分析规则">
      <template #actions>
        <button type="button" class="btn btn--sm" :disabled="!available || ruleBusy" @click="newRule"><PhPlus :size="16" aria-hidden="true" />新建规则</button>
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
        <Callout v-else-if="state.ruleOp.phase === 'ok'" tone="ok">{{ state.ruleOp.kind === 'delete' ? '规则已删除。' : '规则已保存。' }}</Callout>

        <EmptyState
          v-if="rules.items.length === 0 && !ruleEditor"
          title="还没有提示词规则"
          description="分析需要选择一条规则。点击「新建规则」创建。"
        />
        <fieldset v-if="rules.items.length > 0" class="rules">
          <legend class="sr-only">选择分析使用的提示词规则</legend>
          <div v-for="rule in rules.items" :key="rule.id" class="rule" :class="{ 'rule--active': rule.id === state.selectedRuleId }">
            <label class="rule__pick">
              <input type="radio" name="prompt-rule" :value="rule.id" :checked="rule.id === state.selectedRuleId" @change="controller.selectRule(rule.id)" />
              <span class="rule__text">
                <span class="rule__name">{{ rule.name }}</span>
                <span v-if="rule.description" class="rule__desc">{{ rule.description }}</span>
              </span>
            </label>
            <div class="rule__actions">
              <button type="button" class="btn btn--sm" :disabled="ruleBusy" :aria-label="`编辑规则 ${rule.name}`" :title="`编辑 ${rule.name}`" @click="editRule(rule)"><PhPencilSimple :size="16" /></button>
              <template v-if="confirmDeleteId === rule.id">
                <button type="button" class="btn btn--sm btn--danger" :disabled="ruleBusy" @click="removeRule(rule.id)">确认删除</button>
                <button type="button" class="btn btn--sm btn--ghost" @click="confirmDeleteId = null">返回</button>
              </template>
              <button v-else type="button" class="btn btn--sm" :disabled="ruleBusy" :aria-label="`删除规则 ${rule.name}`" :title="`删除 ${rule.name}`" @click="confirmDeleteId = rule.id">
                <PhTrash :size="16" />
              </button>
            </div>
          </div>
        </fieldset>


      </template>
    </PanelCard>
    <PanelCard class="run-panel" title="运行分析">
      <div class="run">
        <div class="form-grid">
          <div class="field">
            <label class="field__label" for="a-sample">送入模型的抽样条数</label>
            <input id="a-sample" v-model="sampleLimitText" class="input" inputmode="numeric" :disabled="!available || active || creating" />
            <span v-if="sampleError" class="field__error" role="alert">{{ sampleError }}</span>
            <span v-else class="field__hint">1 到 50，默认 20</span>
          </div>
          <div class="field field--wide">
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

        <p class="muted">
          数据源：<strong>{{ state.sourceType === 'feishu' ? '飞书多维表格' : state.sourceType === 'local' ? '本地商品库' : '未选择' }}</strong>
          · 规则：<strong>{{ selectedRule?.name ?? '未选择' }}</strong>
        </p>

        <Callout v-if="task.create.phase === 'failed' && task.create.error" tone="error" :view="task.create.error" />

        <div class="row">
          <button type="button" class="btn btn--primary" :disabled="!canStart" @click="startAnalysis">
            <PhPlay :size="16" aria-hidden="true" />{{ creating ? '正在创建…' : active ? '分析进行中' : '开始分析' }}
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
          <button v-if="current" type="button" class="btn btn--ghost" :disabled="task.refresh.phase === 'running'" @click="controller.refreshTask()">
            {{ task.refresh.phase === 'running' ? '刷新中…' : '刷新状态' }}
          </button>
        </div>
        <Callout v-if="task.cancel.phase === 'failed' && task.cancel.error" tone="error" :view="task.cancel.error" />
        <Callout v-if="task.refresh.phase === 'failed' && task.refresh.error" tone="warn" :view="task.refresh.error" />
        <Callout v-if="task.restore.phase === 'error' && task.restore.error" tone="warn" :view="task.restore.error" />


      </div>
    </PanelCard>
      </aside>
      <section class="analysis-output" aria-label="数据预览和分析结果">
      <PanelCard class="preview-panel" title="数据预览">
        <div class="preview" aria-live="polite">
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
              <p class="muted">
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
    <PanelCard class="result-panel" title="分析结果">
        <!-- 任务状态 -->
        <div v-if="current && currentStatus" class="job" aria-live="polite">
          <div class="job__head">
            <StatusTag :tone="currentStatus.tone" :dot="active" :pulse="current.status === 'running'">{{ currentStatus.label }}</StatusTag>
            <span class="muted">任务创建于 {{ formatFullTime(current.createdAt) }}</span>
          </div>
          <ProgressBar
            :value="current.progress"
            :label="`分析进度 ${current.progress}%`"
            :tone="current.status === 'failed' ? 'error' : current.status === 'completed' ? 'ok' : 'accent'"
          />
          <p class="muted"><span class="mono">{{ current.progress }}%</span></p>
          <Callout v-if="failure" tone="error" :view="failure" />
          <p v-if="cancelledNote" class="muted">{{ cancelledNote }}</p>
        </div>


        <!-- 结果 -->
        <div v-if="current?.status === 'completed'" class="result">
          <p v-if="result.phase === 'loading'" class="muted" role="status">正在读取分析结果…</p>
          <Callout v-else-if="result.phase === 'error'" tone="error" title="分析结果不可用">
            {{ result.error }}
            <template #actions>
              <button type="button" class="btn btn--sm" @click="controller.retryResult()">重新读取</button>
            </template>
          </Callout>
          <template v-else-if="result.phase === 'ready' && result.data && output">
            <h3 class="h3">分析结论</h3>
            <p class="result__meta muted">
              规则「{{ result.data.ruleName }}」· 样本 {{ result.data.sampleCount }} / 匹配 {{ result.data.totalCount }} 条 · 模型 {{ result.data.modelUsed }} ·
              {{ formatFullTime(result.data.analyzedAt) }}
              <template v-if="result.data.usage?.totalTokens"> · {{ result.data.usage.totalTokens }} tokens</template>
            </p>

            <section class="block" aria-labelledby="res-summary">
              <h4 id="res-summary" class="block__title">概览</h4>
              <p class="prose">{{ output.summary }}</p>
            </section>
            <section class="block" aria-labelledby="res-findings">
              <h4 id="res-findings" class="block__title">关键发现</h4>
              <ul v-if="output.keyFindings.length > 0" class="bullets">
                <li v-for="(item, index) in output.keyFindings" :key="index">{{ item }}</li>
              </ul>
              <p v-else class="muted">模型没有给出关键发现。</p>
            </section>
            <section v-if="output.priceAnalysis" class="block" aria-labelledby="res-price">
              <h4 id="res-price" class="block__title">价格分析</h4>
              <dl class="kv">
                <div><dt>均价</dt><dd class="mono">{{ output.priceAnalysis.avgPrice }}</dd></div>
                <div><dt>中位价</dt><dd class="mono">{{ output.priceAnalysis.medianPrice }}</dd></div>
                <div><dt>主要价格带</dt><dd>{{ output.priceAnalysis.priceRange || '未提供' }}</dd></div>
                <div v-if="output.priceAnalysis.recommendation"><dt>定价建议</dt><dd>{{ output.priceAnalysis.recommendation }}</dd></div>
              </dl>
            </section>
            <section class="block" aria-labelledby="res-opps">
              <h4 id="res-opps" class="block__title">机会点</h4>
              <ul v-if="output.opportunities.length > 0" class="bullets">
                <li v-for="(item, index) in output.opportunities" :key="index">{{ item }}</li>
              </ul>
              <p v-else class="muted">模型没有给出机会点。</p>
            </section>
            <section class="block" aria-labelledby="res-risks">
              <h4 id="res-risks" class="block__title">风险</h4>
              <ul v-if="output.risks.length > 0" class="bullets">
                <li v-for="(item, index) in output.risks" :key="index">{{ item }}</li>
              </ul>
              <p v-else class="muted">模型没有给出风险提示。</p>
            </section>
          </template>
        </div>
      <EmptyState v-if="!current && !creating" title="尚无分析结果" description="选择规则并开始分析，结果将显示在这里。" />
    </PanelCard>
      </section>
    </div>
    <AppModal :open="Boolean(ruleEditor)" :title="ruleEditor?.id ? '编辑规则' : '新建规则'" :busy="ruleBusy" @close="closeRuleEditor">
        <form v-if="ruleEditor" class="form editor" novalidate @submit.prevent="saveRule">
          <p class="muted">规则决定模型如何分析商品数据，请勿填写密钥。</p>
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
          <div class="row">
            <button type="submit" class="btn btn--primary" :disabled="ruleBusy">{{ ruleBusy ? '保存中…' : '保存规则' }}</button>
            <button type="button" class="btn" :disabled="ruleBusy" @click="closeRuleEditor">取消</button>
          </div>
        </form>
    </AppModal>
  </div>
</template>

<style scoped>
.analysis-layout { display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 16px; align-items: start; }
.analysis-config, .analysis-output { display: grid; gap: 16px; min-width: 0; }
.advanced-filter summary { cursor: pointer; font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
.advanced-filter .check-row { margin-top: 12px; }
.schema summary { cursor: pointer; font-size: 12px; color: var(--text-muted); margin-bottom: 8px; }
.analysis-layout :deep(.panel) { min-width: 0; }
.analysis-layout .form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }


.form {
  display: grid;
  gap: 12px;
}

.muted {
  font-size: 12.5px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}

.mono {
  font-family: var(--mono);
}

.sources {
  display: grid;
  gap: 8px;
  min-width: 0;
  margin: 0 0 12px;
  padding: 0;
  border: 0;
}

.source {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  cursor: pointer;
}

.source:has(input:checked) {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.source:has(input:focus-visible) {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.source--off {
  cursor: not-allowed;
  opacity: 0.65;
}

.source__text {
  display: grid;
  gap: 2px;
}

.source__name {
  font-weight: 600;
}

.source__desc {
  font-size: 12.5px;
  color: var(--text-muted);
}

.schema {
  display: grid;
  gap: 8px;
}

.fields {
  display: grid;
  max-height: 260px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
}

.fields__item {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  padding: 7px 10px;
  font-size: 12.5px;
}

.fields__item + .fields__item {
  border-top: 1px solid var(--border);
}

.fields__label {
  font-weight: 600;
}

.preview {
  display: grid;
  gap: 10px;
  margin-top: 14px;
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
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
  padding: 8px 10px;
  font-size: 12px;
  font-weight: 600;
  text-align: left;
  white-space: nowrap;
  color: var(--text-muted);
  background: var(--surface-sunken);
}

.table td {
  max-width: 240px;
  padding: 7px 10px;
  font-size: 12.5px;
  border-top: 1px solid var(--border);
  overflow-wrap: anywhere;
}

.rules {
  display: grid;
  min-width: 0;
  margin: 0 0 12px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
}

.rule {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 12px;
  padding: 10px 12px;
}

.rule + .rule {
  border-top: 1px solid var(--border);
}

.rule--active {
  background: var(--accent-soft);
}

.rule__pick {
  display: flex;
  flex: 1 1 260px;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  cursor: pointer;
}

.rule__text {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.rule__name {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.rule__desc {
  font-size: 12.5px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.rule__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.editor {
  padding: 0;
}

.errors {
  margin: 0;
  padding-left: 18px;
  list-style: disc;
}

.run {
  display: grid;
  gap: 12px;
}

.field--wide {
  grid-column: 1 / -1;
}

.job {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
}

.job__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
}

.result {
  display: grid;
  gap: 12px;
}

.result__meta {
  margin-top: -6px;
}

.block {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
}

.block__title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text-muted);
}

.prose {
  line-height: 1.7;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.bullets {
  display: grid;
  gap: 6px;
  margin: 0;
  padding-left: 18px;
  list-style: disc;
  overflow-wrap: anywhere;
}

.kv {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
  margin: 0;
}

.kv > div {
  display: grid;
  gap: 2px;
}

.kv dt {
  font-size: 11.5px;
  color: var(--text-muted);
}

.kv dd {
  margin: 0;
  overflow-wrap: anywhere;
}

@media (max-width: 900px) {
  .analysis-layout { grid-template-columns: minmax(0, 1fr); }
}
</style>
