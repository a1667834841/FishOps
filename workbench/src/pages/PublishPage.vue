<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import Callout from '../components/Callout.vue'
import PanelCard from '../components/PanelCard.vue'
import {
  PhArrowsClockwise,
  PhCheckCircle,
  PhSpinnerGap,
  PhWarningCircle,
  PhXCircle,
} from '@phosphor-icons/vue'
import ProgressBar from '../components/ProgressBar.vue'
import StatusTag from '../components/StatusTag.vue'
import { usePublish } from '../composables/usePublish'
import type { PageId } from '../data/navigation'
import { formatFullTime } from '../features/chat/chat-format'
import type { PublishTask } from '../features/contracts'
import {
  formatConfirmationStatus,
  formatPublishTaskStatus,
  formatRMB,
  getPublishTaskSummary,
} from '../features/publish/publish-format'
import type { PublishDraft } from '../features/publish/publish-draft-store'
import { publishDraftStore } from '../features/publish/publish-draft-store'
import PublishDiagnosticsPanel from '../features/publish/PublishDiagnosticsPanel.vue'
import DirectPublishModal from '../features/publish/DirectPublishModal.vue'
import { useDirectPublish } from '../features/publish/useDirectPublish'
import type { DirectPublishSourceProduct } from '../features/publish/direct-publish-controller'

const props = defineProps<{
  draft?: PublishDraft | null
}>()

const emit = defineEmits<{
  navigate: [page: PageId]
  clearDraft: []
}>()

// 旧控制器（保持原 DOM 任务历史与自营商品加载能力，不再由主发布按钮调用）
const { state, controller } = usePublish()

// 新两阶段直接发布控制器
const {
  controller: directController,
  phase: directPhase,
  publishedItemId: directItemId,
  submitResult: directSubmitResult,
  errorMessage: directErrorMessage,
  isDraftLocked: isDirectDraftLocked,
} = useDirectPublish()


const productsState = computed(() => state.value.products)
const products = computed(() => state.value.products.items)
const selectedProduct = computed(() => state.value.selectedProduct)
const editingDraft = computed(() => state.value.editingDraft)
const taskListState = computed(() => state.value.taskList)
const taskList = computed(() => state.value.taskList.items)
const currentTask = computed(() => state.value.currentTask)
const diagnostics = computed(() => state.value.diagnostics)
const action = computed(() => state.value.action)

// 载入 props 传入的 draft 或 typed store 中的 draft。
// 以草稿 identity（source + recordId/itemId）去重：props.draft 初始加载与 store 订阅的 immediate 回调
// 可能同时命中同一草稿，避免重复调用 loadDraft（会重复触发后台 FEISHU_PRODUCT_GET 等请求）。
let lastLoadedDraftKey = ''
function draftIdentityKey(d: PublishDraft | null): string {
  if (!d) return ''
  return `${d.source}|${d.recordId ?? ''}|${d.itemId ?? ''}`
}
function ensureLoadDraft(d: PublishDraft | null): void {
  if (!d) {
    // 草稿被清空（例如发布成功或用户清空）后，允许同款草稿之后再次载入
    lastLoadedDraftKey = ''
    return
  }
  const key = draftIdentityKey(d)
  if (key === lastLoadedDraftKey) return
  lastLoadedDraftKey = key
  void controller.loadDraft(d)
}

// 先订阅再初始加载：subscribe 会立即以 store 当前值回调一次，同一草稿不会重复 loadDraft。
// 保存取消函数，页面卸载时注销，避免切页累积旧回调并放大重复加载问题。
const unsubscribeDraftStore = publishDraftStore.subscribe((d) => {
  ensureLoadDraft(d)
})
ensureLoadDraft(props.draft ?? publishDraftStore.getDraft())

// 当前是否有待发布的商品或素材
const hasDraftOrProduct = computed(() => Boolean(editingDraft.value || selectedProduct.value))

// 构建传递给直接发布两阶段接口的商品源
const directPublishSource = computed<DirectPublishSourceProduct | null>(() => {
  if (!hasDraftOrProduct.value) return null
  const draft = editingDraft.value
  const product = selectedProduct.value
  const description = draft?.desc || product?.desc || product?.title || ''
  const price = draft?.price ?? product?.priceNumber ?? 0
  const images = draft?.imageUrls || product?.images || []
  return {
    description,
    price,
    images,
    specifications: [],
    itemId: draft?.itemId || product?.itemId,
    ...(draft?.title || product?.title ? { title: draft?.title || product?.title } : {}),
  }
})

// 发布执行状态
const isPublishing = computed(() => {
  return directPhase.value === 'preparing' || directPhase.value === 'submitting'
})

// 发布成功后“返回发布中心任务列表”倒计时的初始秒数
const RETURN_COUNTDOWN_SECONDS = 5
// 剩余秒数；为 0 时不再展示倒计时提示
const countdownSeconds = ref(0)
// 是否展开“发布任务历史”：发布中心默认即展示任务列表，故初始为 true
const taskHistoryOpen = ref(true)
// 是否处于“仅任务列表”视图（发布成功倒计时结束时置 true）。
// 该视图隐藏“选择发布素材”、成功结果区与 DirectPublishModal，只保留任务历史；
// 默认 false，保证新挂载或以商品库进入时仍走正常选品/发布流程，不被上一次成功状态永久隐藏。
const showTaskListOnly = ref(false)
// setInterval 句柄；页面卸载或重复进入成功态时清理，避免残留或重复创建计时器
let countdownTimer: ReturnType<typeof setInterval> | null = null

/** 清理倒计时计时器（幂等，可安全重复调用） */
function clearCountdownTimer(): void {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer)
    countdownTimer = null
  }
}

// 启动 5 秒倒计时并逐秒递减；归零后自动展开“发布任务历史”。
// 纯前端展示切换，绝不触发 prepare 或再次发布；重复调用会先清理旧计时器，避免重复 interval。
function startReturnCountdown(): void {
  clearCountdownTimer()
  countdownSeconds.value = RETURN_COUNTDOWN_SECONDS
  countdownTimer = setInterval(() => {
    if (countdownSeconds.value > 1) {
      countdownSeconds.value -= 1
      return
    }
    countdownSeconds.value = 0
    taskHistoryOpen.value = true
    // 切换到“仅任务列表”视图；纯前端展示切换，不调用发布控制器接口、不导航，避免重复副作用
    showTaskListOnly.value = true
    clearCountdownTimer()
  }, 1000)
}

// 发布成功后清理跨页面待发布草稿（App 的 pendingDraft 与 typed store），
// 使切菜单再回发布中心时不会恢复已发布商品并再次触发 prepare。
// 成功反馈由 directPhase/publishedItemId 承载，保持在当前页面可见，故不在成功前清理。
watch(directPhase, (phase, previousPhase) => {
  if (phase === 'published') {
    emit('clearDraft')
    if (previousPhase !== 'published') startReturnCountdown()
  } else {
    clearCountdownTimer()
    countdownSeconds.value = 0
  }
})

onUnmounted(() => {
  // 注销跨页面草稿订阅，避免切页累积旧回调
  unsubscribeDraftStore()
  // 清理返回倒计时计时器，避免用户离开页面后残留 interval
  clearCountdownTimer()
  // 离开发布页时取消在途 prepare（cancel 内部递增序列号使在途请求作废）；
  // submitting 中 cancel 会被忽略，不会中断正在进行的提交。
  directController.cancel()
})

// ---------------- 商品选择事件 ----------------
function onSelectProductChange(event: Event): void {
  const target = event.target as HTMLSelectElement
  controller.selectProduct(target.value)
}

async function onRandomPick(): Promise<void> {
  await controller.selectRandomProduct()
}

function onClearDraft(): void {
  // 用户主动重新选品时退出“仅任务列表”视图，恢复选品/发布入口，避免成功状态永久隐藏流程
  showTaskListOnly.value = false
  emit('clearDraft')
  publishDraftStore.clearDraft()
  controller.selectProduct('')
}

async function onCancelTask(taskId: string): Promise<void> {
  await controller.cancelTask(taskId, '操作员在工作台取消')
}

function onFocusTask(task: PublishTask): void {
  controller.setCurrentTask(task)
  if (task.id) {
    void controller.getTask(task.id)
  }
}

</script>

<template>
  <div class="page publish-page">
    <!-- 商品选择与来源区（发布成功后“仅任务列表”视图隐藏，可由任务列表上的“重新选择素材”恢复） -->
    <PanelCard
      v-if="!showTaskListOnly"
      title="选择发布素材"
      description="从飞书采集商品库或自营商品中挑选待发布内容；支持直接从商品库行点击“发布”快速载入。"
    >
      <template #actions>
        <button
          v-if="editingDraft"
          type="button"
          class="btn btn--sm btn--ghost"
          :disabled="isPublishing"
          @click="onClearDraft"
        >
          重新选择素材
        </button>
        <button
          type="button"
          class="btn btn--sm btn--ghost"
          :disabled="isPublishing || productsState.phase === 'loading'"
          title="重新读取自营商品库"
          @click="controller.loadProducts()"
        >
          <PhArrowsClockwise :size="16" aria-hidden="true" /> 刷新自营商品
        </button>
      </template>

      <!-- 商品库选择与飞书素材继续保留；发布流程统一在下方页面内容内完成。 -->
      <div v-if="!editingDraft" class="select-form-container">
        <!-- 自营商品库加载中 -->
        <div v-if="productsState.phase === 'loading'" class="loading-state">
          <PhSpinnerGap class="loading-spinner" aria-hidden="true" :size="18" />
          <span>正在读取自营商品库候选数据...</span>
        </div>

        <!-- 自营商品库加载失败 -->
        <div v-else-if="productsState.phase === 'error' && productsState.error" class="error-state">
          <Callout tone="error" :view="productsState.error">
            <template #actions>
              <button type="button" class="btn btn--sm" @click="controller.loadProducts()">
                重试加载自营商品
              </button>
            </template>
          </Callout>
        </div>

        <div v-else class="select-form-row">
          <div class="form-group flex-1">
            <label for="product-select" class="form-label">
              显式选择自营商品：<span class="count-tip">(共 {{ products.length }} 件候选)</span>
            </label>
            <select
              id="product-select"
              class="input-select"
              :value="selectedProduct?.itemId || ''"
              :disabled="isPublishing"
              @change="onSelectProductChange"
            >
              <option value="">-- 请选择待发布商品 --</option>
              <option v-for="p in products" :key="p.itemId" :value="p.itemId">
                {{ p.title }} ({{ formatRMB(p.price) }}) - [{{ p.itemId }}]
              </option>
            </select>
          </div>

          <div class="action-btn-group">
            <button
              type="button"
              class="btn"
              :disabled="isPublishing"
              @click="onRandomPick"
            >
              🎲 随机选择 1 条商品
            </button>
            <button
              type="button"
              class="btn btn--primary"
              @click="emit('navigate', 'products')"
            >
              前往商品库选品
            </button>
          </div>
        </div>

        <div v-if="!selectedProduct" class="select-guide-tip">
          <span>💡 提示：系统不会自动暗中选择商品，请从上方下拉列表挑选，或前往「商品库」直接点击商品行的「发布」按钮快速载入。</span>
        </div>
      </div>
    </PanelCard>


    <!-- 发布状态与结果（优先展示直接发布的真实结果，杜绝假成功）；
         发布成功后“仅任务列表”视图隐藏本区域（含成功链接与倒计时） -->
    <PanelCard
      v-if="!showTaskListOnly && (directSubmitResult || directPhase === 'published' || directPhase === 'unknown' || currentTask || action.error)"
      title="发布状态与结果"
      description="实时反馈当前商品的发布提交执行结果（以闲鱼官方接口返回的真实 itemId 为准）。"
    >
      <div class="confirmation-panel">
        <!-- 场景 A：直接发布成功（必须有真实 itemId） -->
        <div v-if="directPhase === 'published' && directItemId" class="submitted-box" role="status" aria-live="polite">
          <PhCheckCircle class="done-icon" aria-hidden="true" :size="20" />
          <span class="done-text">商品已成功通过两阶段接口发布到当前闲鱼账号！</span>
          <span class="submitted-evidence">
            新增商品 ID：<code>{{ directItemId }}</code>
            <a
              :href="`https://www.goofish.com/item?id=${encodeURIComponent(directItemId)}`"
              target="_blank"
              rel="noopener noreferrer"
              class="item-link"
            >
              https://www.goofish.com/item?id={{ directItemId }}
            </a>
          </span>
        </div>

        <!-- 场景 B：直接发布结果未知（永久锁定） -->
        <div v-else-if="directPhase === 'unknown' || isDirectDraftLocked" class="unknown-box" role="alert" aria-live="assertive">
          <div class="unknown-header">
            <PhWarningCircle class="warn-icon" aria-hidden="true" :size="20" />
            <strong class="warn-title">发布结果未知，已锁定禁止重试</strong>
          </div>
          <p class="warn-desc">
            已向闲鱼发布接口派发最终发布请求，但通信过程中未收到明确的最终响应。为防止在平台重复发布同一商品，<strong>系统已锁定且绝不自动重试</strong>。请稍后直接在闲鱼 APP 或网页端查看“我的发布”核实。
          </p>
          <div class="action-buttons">
            <button
              type="button"
              class="btn btn--sm btn--ghost"
              @click="directController.manualUnlockDraft()"
            >
              已人工核实未上架（解除锁定）
            </button>
          </div>
        </div>

        <!-- 场景 C：直接发布被拒绝或失败 -->
        <div v-else-if="directPhase === 'submit_rejected' && directErrorMessage" class="failed-box" role="alert">
          <PhXCircle class="failed-icon" aria-hidden="true" :size="18" />
          <span class="failed-text">
            发布失败：{{ directErrorMessage }}
          </span>
        </div>

        <!-- 场景 D：历史 DOM 任务展示（保持向下兼容） -->
        <template v-else-if="currentTask">
          <div class="task-summary-row">
            <div class="task-meta">
              <span class="task-id">任务 ID: {{ currentTask.id }}</span>
              <StatusTag :tone="formatPublishTaskStatus(currentTask.status).tone">
                {{ formatPublishTaskStatus(currentTask.status).label }}
              </StatusTag>
              <StatusTag :tone="formatConfirmationStatus(currentTask.result?.confirmationStatus).tone">
                {{ formatConfirmationStatus(currentTask.result?.confirmationStatus).label }}
              </StatusTag>
            </div>
            <div class="task-progress-box">
              <ProgressBar :value="currentTask.progress" :label="`${currentTask.progress}%`" />
            </div>
          </div>
        </template>

        <!-- 场景 E：发布成功后的返回倒计时（纯前端展示，不触发 prepare / 发布） -->
        <p
          v-if="directPhase === 'published' && directItemId && countdownSeconds > 0"
          class="return-countdown"
          role="status"
          aria-live="polite"
        >
          {{ countdownSeconds }} 秒后返回发布中心任务列表
        </p>
      </div>

      <!-- 结果 / 历史详情：发布诊断时间线 -->
      <PublishDiagnosticsPanel
        v-if="currentTask"
        :diagnostics="diagnostics"
        class="result-diag"
      />
    </PanelCard>

    <!-- 直接发布弹窗；“仅任务列表”视图下不渲染，避免恢复流程触发无谓副作用 -->
    <DirectPublishModal
      v-if="hasDraftOrProduct && !showTaskListOnly"
      :source-product="directPublishSource"
      :controller="directController"
    />

    <!-- 发布任务历史列表（保持原 DOM 任务历史旧能力） -->
    <details class="task-history" :open="taskHistoryOpen">
      <summary>发布任务历史</summary>
      <PanelCard
        title="发布任务历史"
        description="最近生成的发布任务与提交结果（数据由 PUBLISH_LIST 实时提供）。"
      >
        <template #actions>
          <!-- 恢复入口：仅在“仅任务列表”视图显示，避免成功状态永久隐藏选品/发布流程 -->
          <button
            v-if="showTaskListOnly"
            type="button"
            class="btn btn--sm btn--ghost"
            @click="onClearDraft"
          >
            重新选择素材
          </button>
          <button
            type="button"
            class="btn btn--sm btn--ghost"
            :disabled="taskListState.phase === 'loading'"
            title="刷新发布任务列表"
            @click="controller.loadTasks()"
          >
            <PhArrowsClockwise :size="16" aria-hidden="true" /> 刷新列表
          </button>
        </template>

        <!-- 任务列表加载中 -->
        <div v-if="taskListState.phase === 'loading'" class="loading-state">
          <PhSpinnerGap class="loading-spinner" aria-hidden="true" :size="18" />
          <span>正在读取发布任务列表...</span>
        </div>

        <!-- 任务列表加载失败 -->
        <div v-else-if="taskListState.phase === 'error' && taskListState.error" class="error-state">
          <Callout tone="error" :view="taskListState.error">
            <template #actions>
              <button type="button" class="btn btn--sm" @click="controller.loadTasks()">
                重试加载
              </button>
            </template>
          </Callout>
        </div>

        <!-- 任务列表为空 -->
        <div v-else-if="taskList.length === 0" class="empty-task-history">
          <p class="empty-tip">暂无发布任务历史，请选择商品后点击开始填表。</p>
        </div>

        <!-- 任务表格 -->
        <div v-else class="task-table-wrapper">
          <table class="data-table">
            <thead>
              <tr>
                <th>任务创建时间</th>
                <th>商品名称 / 售价</th>
                <th>填表状态</th>
                <th>提交结果</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in taskList" :key="t.id">
                <td class="col-time">{{ formatFullTime(t.createdAt) }}</td>
                <td class="col-summary">{{ getPublishTaskSummary(t) }}</td>
                <td>
                  <StatusTag :tone="formatPublishTaskStatus(t.status).tone">
                    {{ formatPublishTaskStatus(t.status).label }}
                  </StatusTag>
                </td>
                <td>
                  <StatusTag :tone="formatConfirmationStatus(t.result?.confirmationStatus).tone">
                    {{ formatConfirmationStatus(t.result?.confirmationStatus).label }}
                  </StatusTag>
                </td>
                <td class="col-actions">
                  <button
                    type="button"
                    class="btn btn--sm"
                    title="查看任务详情"
                    @click="onFocusTask(t)"
                  >
                    查看
                  </button>
                  <button
                    v-if="t.status === 'running' || t.status === 'pending' || t.status === 'waiting_confirmation'"
                    type="button"
                    class="btn btn--sm btn--danger"
                    @click="onCancelTask(t.id)"
                  >
                    取消
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </PanelCard>
    </details>
  </div>
</template>

<style scoped>
.task-history summary { cursor: pointer; padding: 12px 0; font-weight: 600; }

.publish-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  min-width: 0;
}

.btn {
  width: fit-content;
  max-width: 100%;
}

/* 草稿横幅 */
.draft-loaded-banner {
  padding: 12px 14px;
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
}

.draft-badge-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 6px;
}

.table-id-badge,
.item-id-badge {
  font-size: 12px;
  color: var(--text-muted);
}

.table-id-badge code,
.item-id-badge code {
  font-size: 11.5px;
  background: var(--surface);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--border);
}

.draft-source-hint {
  font-size: 12.5px;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.4;
}

/* 表单与选择区 */
.select-form-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.select-form-row {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.flex-1 { flex: 1 1 280px; }
.col-full { grid-column: 1 / -1; }

.form-label {
  font-size: 12.5px;
  font-weight: 600;
}

.count-tip {
  font-weight: normal;
  color: var(--text-muted);
  font-size: 11.5px;
}

.unsupported-hint {
  font-weight: normal;
  color: var(--warn, #e6a23c);
  font-size: 11.5px;
}

.input-select,
.input-text,
.input-textarea {
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-control);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  box-sizing: border-box;
}

.input-textarea {
  resize: vertical;
  line-height: 1.5;
}

.input-select:focus,
.input-text:focus,
.input-textarea:focus {
  outline: 2px solid var(--accent);
  border-color: transparent;
}

.action-btn-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.select-guide-tip {
  font-size: 12px;
  color: var(--text-muted);
}

/* 结果面板 */
.confirmation-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.submitted-box,
.done-box {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--surface-sunken);
  border: 1px solid var(--ok, #67c23a);
  border-radius: var(--radius-control);
}

.done-icon {
  color: var(--ok, #67c23a);
}

.done-text {
  font-weight: 600;
}

.submitted-evidence {
  font-size: 12px;
  color: var(--text-muted);
  margin-left: auto;
}

.submitted-evidence code {
  font-weight: 600;
  color: var(--accent);
}

.return-countdown {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}

.unknown-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  background: var(--surface-sunken);
  border: 1px solid var(--warn, #e6a23c);
  border-radius: var(--radius-control);
}

.unknown-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.warn-icon {
  color: var(--warn, #e6a23c);
}

.warn-title {
  font-size: 14px;
}

.warn-desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--text-muted);
}

.failed-box {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--surface-sunken);
  border: 1px solid var(--error, #f56c6c);
  border-radius: var(--radius-control);
  color: var(--error, #f56c6c);
}

.failed-icon {
  flex-shrink: 0;
}

.failed-text {
  font-size: 13px;
}

.task-summary-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.task-meta {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-id {
  font-size: 12px;
  color: var(--text-muted);
}

.task-progress-box {
  width: 140px;
}

.result-diag {
  margin-top: 12px;
}

/* 历史表格 */
.task-table-wrapper {
  overflow-x: auto;
  max-width: 100%;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.data-table th,
.data-table td {
  padding: 8px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.data-table th {
  font-weight: 600;
  color: var(--text-muted);
}

.col-actions {
  display: flex;
  gap: 6px;
}

.empty-task-history {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}

.loading-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
  font-size: 13px;
  color: var(--text-muted);
}
</style>
