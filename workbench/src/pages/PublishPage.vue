<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { enterDraftFlow } from '../features/publish/direct-publish-flow'
import { DirectPublishClient } from '../features/publish/direct-publish-client'
import Callout from '../components/Callout.vue'
import PanelCard from '../components/PanelCard.vue'
import {
  PhArrowsClockwise,
  PhCheckCircle,
  PhInfo,
  PhSpinnerGap,
  PhWarningCircle,
  PhXCircle,
  PhX,
} from '@phosphor-icons/vue'
import ProgressBar from '../components/ProgressBar.vue'
import StatusTag from '../components/StatusTag.vue'
import { usePublish } from '../composables/usePublish'
import type { PageId } from '../data/navigation'

import type { PublishTask } from '../features/contracts'
import {
  formatConfirmationStatus,
  formatPublishTaskStatus,
  formatRMB,
} from '../features/publish/publish-format'
import { filterPublishHistory, mergePublishHistory } from '../features/publish/publish-history'
import type { PublishDraft } from '../features/publish/publish-draft-store'
import { publishDraftStore } from '../features/publish/publish-draft-store'

import PublishDiagnosticsPanel from '../features/publish/PublishDiagnosticsPanel.vue'
import DirectPublishModal from '../features/publish/DirectPublishModal.vue'
import { useDirectPublish } from '../features/publish/useDirectPublish'
import { startPublishReturnCountdown } from '../features/publish/direct-publish-countdown'
import type { DirectPublishSourceProduct } from '../features/publish/direct-publish-controller'

const props = defineProps<{
  draft?: PublishDraft | null
}>()

const emit = defineEmits<{
  navigate: [page: PageId]
  clearDraft: []
}>()

// 旧控制器（保持原 DOM 任务历史与自营商品加载能力，不删历史 controller）
const { state, controller } = usePublish()

// 两阶段直接发布控制器
const {
  controller: directController,
  phase: directPhase,
  publishedItemId: directItemId,
  submitResult: directSubmitResult,
  errorMessage: directErrorMessage,
  isDraftLocked: isDirectDraftLocked,
} = useDirectPublish()

// 状态映射
const productsState = computed(() => state.value.products)
const products = computed(() => state.value.products.items)
const selectedProduct = computed(() => state.value.selectedProduct)
const editingDraft = computed(() => state.value.editingDraft)
const taskListState = computed(() => state.value.taskList)
const taskList = computed(() => state.value.taskList.items)
const currentTask = computed(() => state.value.currentTask)
const diagnostics = computed(() => state.value.diagnostics)
const action = computed(() => state.value.action)


const isPublishModalOpen = ref(false)
const directFlow = { draftKey: '', modalOpen: false, preparingKey: '' }

// 载入 props 传入的 draft 或 typed store 中的 draft。
// 以草稿 identity（source + targetTableId + recordId / itemId）去重：
let lastLoadedDraftKey = ''
function draftIdentityKey(d: PublishDraft | null): string {
  if (!d) return ''
  return `${d.source}|${d.targetTableId ?? ''}|${d.recordId ?? ''}|${d.itemId ?? ''}`
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


// 剩余秒数；为 0 时不再展示倒计时提示
const countdownSeconds = ref(0)
// 是否展开“发布任务历史”：发布中心默认即展示任务列表，故初始为 true
const taskHistoryOpen = ref(true)
const directHistory = ref<Array<{ idempotencyKey: string; status: string; itemId?: string; at: string; code?: string; actionRequired?: string }>>([])
const directHistoryError = ref('')
const historyClient = new DirectPublishClient()
async function loadDirectHistory(): Promise<void> {
  const result = await historyClient.getJobs()
  if (result.ok) {
    directHistory.value = result.jobs
    directHistoryError.value = ''
  } else {
    directHistoryError.value = result.error?.message || '读取直接发布历史失败'
  }
}
void loadDirectHistory()
// 是否处于“仅任务列表”视图（发布成功倒计时结束时置 true）。
// 该视图隐藏“选择发布素材”、成功结果区与 DirectPublishModal，只保留任务历史；
// 默认 false，保证新挂载或以商品库进入时仍走正常选品/发布流程，不被上一次成功状态永久隐藏。
const showTaskListOnly = ref(false)
// 计时器清理函数属于当前页面实例，离开发布页时立即释放，避免下次进入残留。
let clearCountdownTimer = (): void => {}

// 启动 5 秒倒计时；完成时关闭整个核对 modal 并只展示历史列表。
function startReturnCountdown(): void {
  clearCountdownTimer()
  clearCountdownTimer = startPublishReturnCountdown(
    {
      get countdownSeconds() { return countdownSeconds.value },
      set countdownSeconds(value: number) { countdownSeconds.value = value },
      get isPublishModalOpen() { return isPublishModalOpen.value },
      set isPublishModalOpen(value: boolean) { isPublishModalOpen.value = value },
      get modalOpen() { return directFlow.modalOpen },
      set modalOpen(value: boolean) { directFlow.modalOpen = value },
      get showTaskListOnly() { return showTaskListOnly.value },
      set showTaskListOnly(value: boolean) { showTaskListOnly.value = value },
      get taskHistoryOpen() { return taskHistoryOpen.value },
      set taskHistoryOpen(value: boolean) { taskHistoryOpen.value = value },
    },
    { onComplete: () => { clearCountdownTimer = () => {} } },
  )
}

// ---------------- 上下文 Modal（安全核对与显式提交） ----------------
/** 打开两阶段发布核对 Modal（纯前端状态切换，不调用任何 controller 写命令） */
function onOpenPublishModal(): void {
  showTaskListOnly.value = false
  isPublishModalOpen.value = true
  directFlow.modalOpen = true
}

/** 取消并关闭两阶段发布核对 Modal（纯前端状态切换，不调用任何 controller 写命令） */
function onClosePublishModal(): void {
  isPublishModalOpen.value = false
  directFlow.modalOpen = false
}

// draft 到达时自动打开核对 modal；identity 去重会阻止切页回来重复 prepare。
function onDraftChanged(d: PublishDraft | null): void {
  ensureLoadDraft(d)
  if (d && enterDraftFlow(directFlow, d)) onOpenPublishModal()
}
const unsubscribeDraftStore = publishDraftStore.subscribe(onDraftChanged)
const initialDraft = props.draft ?? publishDraftStore.getDraft()
ensureLoadDraft(initialDraft)
if (initialDraft) {
  enterDraftFlow(directFlow, initialDraft)
  isPublishModalOpen.value = true
}

// 仅控制器明确报告 published 时刷新后端持久化审计，并清理草稿。
watch(directPhase, (phase, previousPhase) => {
  if (phase === 'published') {
    if (previousPhase !== 'published') {
      void loadDirectHistory()
      startReturnCountdown()
      emit('clearDraft')
      publishDraftStore.clearDraft()
    }
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

// ---------------- 任务历史轻筛选 ----------------
const searchKeyword = ref('')
const statusFilter = ref('all')
const mergedHistory = computed(() => mergePublishHistory(taskList.value, directHistory.value))
const filteredTaskList = computed(() => filterPublishHistory(mergedHistory.value, searchKeyword.value, statusFilter.value))

async function onRefreshTasks(): Promise<void> {
  await Promise.all([controller.loadTasks(), loadDirectHistory()])
}


// ---------------- 商品选择操作 ----------------
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

function onFocusTask(task: PublishTask): void {
  controller.setCurrentTask(task)
  if (task.id) {
    void controller.getTask(task.id)
  }
}
</script>

<template>
  <div class="page publish-page">
    <div class="publish-grid">
      <!-- 页面顶部视图标头 -->
      <div class="view-header">
        <div class="view-title-group">
          <h1 class="view-title">发布中心</h1>
          <span class="view-sub">发布任务历史流水、执行状态与人工确认</span>
        </div>
      </div>


      <!-- ============ 1. 首屏核心主体：发布任务历史流水 ============ -->
      <details class="task-history default-open" :open="taskHistoryOpen">
        <summary>发布任务历史流水</summary>
        <Callout v-if="directHistoryError" tone="error" :title="directHistoryError" />
        <div class="card history-main-card">
          <div class="card-header">
            <div class="card-title-wrap">
              <span class="card-title">发布任务历史</span>
              <span class="card-caption" id="publish-count-caption">
                共 {{ mergedHistory.length }} 条任务{{ filteredTaskList.length !== mergedHistory.length ? `（筛选显示 ${filteredTaskList.length} 条）` : '' }}
              </span>
            </div>
            <div class="toolbar-right">
              <button
                type="button"
                v-if="showTaskListOnly"
                class="btn btn--sm btn--ghost"
                @click="onClearDraft"
              >
                重新选择素材
              </button>
              <input
                id="publish-search-input"
                v-model="searchKeyword"
                type="text"
                class="input-text"
                placeholder="搜索商品名称..."
                aria-label="搜索发布任务"
                style="width: 170px;"
              />
              <select
                id="publish-status-filter"
                v-model="statusFilter"
                class="select-dropdown input-select"
                aria-label="发布状态筛选"
                style="width: 140px;"
              >
                <option value="all">任务状态：全部</option>

                <option value="running">进行中</option>
                <option value="review">待核对</option>
                <option value="published">已发布</option>
                <option value="failed">准备失败 / 拒绝</option>
                <option value="unknown">结果未知</option>
              </select>
              <button
                id="refresh-publish-list-btn"
                type="button"
                class="btn btn--sm"
                :disabled="taskListState.phase === 'loading'"
                title="刷新发布任务列表"
                @click="onRefreshTasks"
              >
                <PhArrowsClockwise :size="16" aria-hidden="true" />
                <span>刷新列表</span>
              </button>
            </div>
          </div>

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
          <div v-else-if="filteredTaskList.length === 0" class="empty-task-history">
            <p class="empty-tip">暂无匹配的发布任务记录</p>
          </div>

          <!-- 任务表格（首屏主力展示） -->
          <div v-else class="table-responsive task-table-wrapper">
            <table class="seline-table data-table">
              <thead>
                <tr>
                  <th style="width: 130px;">时间</th>
                  <th>摘要</th>
                  <th style="width: 116px;">任务状态</th>
                  <th style="width: 96px;">确认状态</th>
                  <th style="width: 110px; text-align: right;">操作</th>
                </tr>
              </thead>
              <tbody id="publish-task-tbody">
                <tr v-for="row in filteredTaskList" :key="row.id">
                  <td class="col-time">{{ row.createdAt ? new Date(row.createdAt).toLocaleString() : '时间未知' }}</td>
                  <td class="col-summary">
                    <strong>{{ row.summary }}</strong>
                    <small v-if="row.source === 'direct-audit'"> · 直接发布审计</small>
                    <small v-else> · 旧任务</small>
                  </td>
                  <td>
                    <StatusTag :tone="row.statusTone || 'neutral'">
                      {{ row.statusLabel || formatPublishTaskStatus(row.status as PublishTask['status']).label }}
                    </StatusTag>
                  </td>
                  <td>
                    <StatusTag :tone="formatConfirmationStatus(row.confirmationStatus).tone">
                      {{ formatConfirmationStatus(row.confirmationStatus).label }}
                    </StatusTag>
                  </td>
                  <td class="col-actions" style="text-align: right;">
                    <button
                      v-if="row.task"
                      type="button"
                      class="btn btn--sm action-btn"
                      title="查看任务详情"
                      @click="onFocusTask(row.task)"
                    >
                      查看
                    </button>
                    <code v-else-if="row.itemId">{{ row.itemId }}</code>
                    <span v-else>—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </details>

      <!-- ============ 2. 状态结果反馈面板（发布成功或异常时醒目呈现） ============ -->
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

      <!-- ============ 3. 自营素材挑选备用区（折叠辅助，不抢占首屏历史） ============ -->
      <PanelCard
        v-if="!showTaskListOnly"
        title="选择发布素材"
        description="从飞书采集商品库或自营商品中挑选待发布内容；支持直接从商品库行点击“发布”快速载入。"
      >
        <template #actions>
          <button
            type="button"
            v-if="editingDraft"
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
            <PhArrowsClockwise :size="16" aria-hidden="true" />
            <span>刷新自营商品</span>
          </button>
        </template>

        <div v-if="!editingDraft" class="select-form-container">
          <div v-if="productsState.phase === 'loading'" class="loading-state">
            <PhSpinnerGap class="loading-spinner" aria-hidden="true" :size="18" />
            <span>正在读取自营商品库候选数据...</span>
          </div>

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

        <!-- 显式核对入口栏 -->
        <div v-if="hasDraftOrProduct" class="submit-action-bar">
          <div class="submit-action-row">
            <button
              type="button"
              class="btn btn-brand"
              :disabled="isPublishing || isDirectDraftLocked"
              :aria-busy="isPublishing"
              @click="onOpenPublishModal"
            >
              安全核对并发布当前商品
            </button>
            <div class="emoji-tooltip-trigger" tabindex="0" aria-label="表情符号清理提示">
              <PhInfo :size="16" aria-hidden="true" />
              <span class="emoji-tooltip-text">描述中的表情符号（emoji）已在发布前自动清理</span>
            </div>
          </div>
        </div>
      </PanelCard>

      <!-- ============ 4. 上下文核对与显式提交 Modal ============ -->
      <div
        v-if="isPublishModalOpen"
        class="modal-backdrop"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-review-heading"
      >
        <div class="modal-dialog">
          <div class="modal-header">
            <div class="modal-title-wrap">
              <h3 id="modal-review-heading" class="modal-title">安全核对与显式提交</h3>
              <span class="modal-subtitle">请核对商品信息、类目属性与发货地点，人工确认后再执行最终提交</span>
            </div>
            <button
              type="button"
              class="modal-close-btn"
              aria-label="关闭核对弹窗"
              @click="onClosePublishModal"
            >
              <PhX :size="20" aria-hidden="true" />
            </button>
          </div>

          <div class="modal-body-scroll">
              <DirectPublishModal
              v-if="hasDraftOrProduct && !showTaskListOnly"
              :source-product="directPublishSource"
              :source-label="editingDraft?.title || selectedProduct?.title || ''"
              :controller="directController"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.publish-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  min-width: 0;
}

.publish-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  min-width: 0;
}

.task-history summary {
  cursor: pointer;
  padding: 8px 0;
  font-weight: 600;
  color: var(--text-heading, #111827);
  user-select: none;
}

.btn {
  width: fit-content;
  max-width: 100%;
}

/* Seline 黄色品牌按钮风格 */
.btn-brand {
  background-color: var(--brand, #F5C400);
  color: #111827;
  font-weight: 600;
  border: 1px solid rgba(0, 0, 0, 0.08);
}

.btn-brand:hover:not(:disabled) {
  background-color: #E5B700;
}

.action-btn {
  padding: 4px 10px;
  font-size: 12px;
}

.submit-action-bar {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px dashed var(--border, #E5E7EB);
}

.submit-action-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* Tooltip 小图标悬浮 */
.emoji-tooltip-trigger {
  position: relative;
  display: inline-flex;
  align-items: center;
  color: var(--text-muted, #9CA3AF);
  cursor: help;
}

.emoji-tooltip-trigger:hover,
.emoji-tooltip-trigger:focus {
  color: var(--text, #374151);
}

.emoji-tooltip-text {
  display: none;
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: #1F2937;
  color: #FFFFFF;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 11.5px;
  white-space: nowrap;
  z-index: 100;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
}

.emoji-tooltip-trigger:hover .emoji-tooltip-text,
.emoji-tooltip-trigger:focus .emoji-tooltip-text {
  display: block;
}

/* Seline 卡片与轻量队列横幅 */
.card {
  background: var(--surface, #FFFFFF);
  border: 1px solid var(--border, #E5E7EB);
  border-radius: var(--radius-card, 8px);
  padding: 16px 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}



/* 历史卡片 */
.history-main-card {
  border-radius: var(--radius-card, 8px);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.card-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-heading, #111827);
}

.card-caption {
  font-size: 12px;
  color: var(--text-muted, #6B7280);
}

.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

/* 表格与响应式 */
.table-responsive {
  overflow-x: auto;
  max-width: 100%;
}

.task-table-wrapper {
  overflow-x: auto;
  max-width: 100%;
}

.data-table,
.seline-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}

.data-table th,
.data-table td,
.seline-table th,
.seline-table td {
  padding: 10px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border, #E5E7EB);
}

.data-table th,
.seline-table th {
  font-weight: 600;
  color: var(--text-muted, #6B7280);
  background: var(--surface-sunken, #F9FAFB);
}

.col-summary {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.item-desc-snippet {
  font-size: 11.5px;
  color: var(--text-muted, #9CA3AF);
  font-weight: normal;
}

.col-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}

.price-val {
  font-weight: 600;
  color: #111827;
}

/* Pill 样式 */
.pill {
  display: inline-block;
  padding: 2px 8px;
  font-size: 11px;
  border-radius: 9999px;
  font-weight: 500;
}

.pill-yellow {
  background: #FEF3C7;
  color: #92400E;
}

.pill-blue {
  background: #EFF6FF;
  color: #1D4ED8;
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

.form-label {
  font-size: 12.5px;
  font-weight: 600;
}

.count-tip {
  font-weight: normal;
  color: var(--text-muted);
  font-size: 11.5px;
}

.input-select,
.input-text {
  padding: 8px 10px;
  border-radius: var(--radius-control, 6px);
  border: 1px solid var(--border, #E5E7EB);
  background: var(--surface, #FFFFFF);
  color: var(--text, #111827);
  font-size: 13px;
  box-sizing: border-box;
}

.input-select:focus,
.input-text:focus {
  outline: 2px solid var(--brand, #F5C400);
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

.submitted-box {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--surface-sunken, #F9FAFB);
  border: 1px solid var(--ok, #10B981);
  border-radius: var(--radius-control, 6px);
}

.done-icon {
  color: var(--ok, #10B981);
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
  color: var(--brand-dark, #B45309);
}

.return-countdown {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent, #F5C400);
}

.unknown-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  background: var(--surface-sunken, #F9FAFB);
  border: 1px solid var(--warn, #F59E0B);
  border-radius: var(--radius-control, 6px);
}

.unknown-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.warn-icon {
  color: var(--warn, #F59E0B);
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
  background: var(--surface-sunken, #F9FAFB);
  border: 1px solid var(--error, #EF4444);
  border-radius: var(--radius-control, 6px);
  color: var(--error, #EF4444);
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

/* ============ 上下文核对 Modal 遮罩与弹窗 ============ */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(17, 24, 39, 0.45);
  backdrop-filter: blur(2px);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  box-sizing: border-box;
}

.modal-dialog {
  background: #FFFFFF;
  border-radius: 10px;
  box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  width: 100%;
  max-width: 820px;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--border, #E5E7EB);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border, #E5E7EB);
  background: #FAFAF7;
}

.modal-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.modal-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #111827;
}

.modal-subtitle {
  font-size: 12px;
  color: #6B7280;
}

.modal-close-btn {
  background: transparent;
  border: none;
  cursor: pointer;
  color: #6B7280;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border-radius: 4px;
}

.modal-close-btn:hover {
  background: #F3F4F6;
  color: #111827;
}

.modal-body-scroll {
  padding: 20px;
  overflow-y: auto;
  max-height: calc(90vh - 70px);
}
</style>
