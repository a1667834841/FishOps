<script setup lang="ts">
import { computed } from 'vue'
import Callout from '../components/Callout.vue'
import EmptyState from '../components/EmptyState.vue'
import PanelCard from '../components/PanelCard.vue'
import ProgressBar from '../components/ProgressBar.vue'
import StatusTag from '../components/StatusTag.vue'
import { usePublish } from '../composables/usePublish'
import type { PageId } from '../data/navigation'
import {
  formatConfirmationStatus,
  formatPublishTaskStatus,
  formatRMB,
  getPublishTaskSummary,
  validateProductForPublish,
} from '../features/publish/publish-format'
import { formatFullTime } from '../features/chat/chat-format'
import type { PublishTask } from '../features/contracts'

const emit = defineEmits<{ navigate: [page: PageId] }>()

const { state, controller, inExtension } = usePublish()

const productsState = computed(() => state.value.products)
const products = computed(() => state.value.products.items)
const selectedProduct = computed(() => state.value.selectedProduct)
const taskListState = computed(() => state.value.taskList)
const taskList = computed(() => state.value.taskList.items)
const currentTask = computed(() => state.value.currentTask)
const customRule = computed(() => state.value.customRule)
const action = computed(() => state.value.action)
const isActionRunning = computed(() => action.value.phase === 'running')

// 提交中状态判断（防双击与状态锁定）
const isSubmitting = computed(() => {
  return (
    state.value.submittingTaskId === currentTask.value?.id ||
    (isActionRunning.value && state.value.submittingTaskId !== null)
  )
})

// 提交结果反馈
const submitOutcome = computed(() => {
  if (!currentTask.value) return null
  if (state.value.submitOutcome?.taskId === currentTask.value.id) {
    return state.value.submitOutcome
  }
  if (currentTask.value.result?.submit) {
    return {
      taskId: currentTask.value.id,
      outcome:
        currentTask.value.result.submit.state === 'unknown'
          ? ('unknown' as const)
          : ('submitted' as const),
      message: currentTask.value.result.submit.message,
    }
  }
  return null
})

// 是否已成功提交
const isSubmitted = computed(() => {
  return (
    currentTask.value?.status === 'completed' ||
    currentTask.value?.result?.submit?.state === 'submitted' ||
    submitOutcome.value?.outcome === 'submitted'
  )
})

// 是否结果未知
const isUnknown = computed(() => {
  return (
    currentTask.value?.result?.submit?.state === 'unknown' ||
    submitOutcome.value?.outcome === 'unknown'
  )
})

// 是否锁定提交动作（已提交、结果未知、或已派发过提交、或缺少令牌）
const isSubmitLocked = computed(() => {
  const task = currentTask.value
  if (!task) return true
  if (isSubmitted.value || isUnknown.value) return true
  if (task.meta?.submitAttempted === true) return true
  if (!task.result?.submitToken) return true
  return false
})

// 按钮是否禁用（包括防双击与锁定）
const isSubmitDisabled = computed(() => {
  return isSubmitting.value || isSubmitLocked.value || isActionRunning.value
})

// 流程步骤视图（真实状态驱动）
const stages = computed(() => {
  const hasProduct = Boolean(selectedProduct.value)
  const task = currentTask.value
  const isFilled = task?.status === 'waiting_confirmation'
  const isCompleted = isSubmitted.value
  const isFailed = task?.status === 'failed' || (action.value.phase === 'failed' && !task)

  return [
    {
      title: '选择商品',
      text: '从真实商品库中显式选择或明确随机挑选 1 件待发布商品（禁止自动偷选）。',
      status: hasProduct ? '已选择' : '待选择',
      tone: hasProduct ? ('ok' as const) : ('neutral' as const),
    },
    {
      title: '规则计算',
      text: '计算售价系数、浮动加价、5倍划线原价与文案修饰。',
      status: hasProduct ? '已配置' : '等待中',
      tone: hasProduct ? ('ok' as const) : ('neutral' as const),
    },
    {
      title: '表单填充',
      text: '后台静默打开官方发布页，自动填充图片、描述与价格，生成一次性提交令牌。',
      status: isActionRunning.value && !isSubmitting.value
        ? '填表中'
        : isFailed
          ? '填表失败'
          : isFilled || isCompleted
            ? '已就绪'
            : '待执行',
      tone: isActionRunning.value && !isSubmitting.value
        ? ('accent' as const)
        : isFailed
          ? ('error' as const)
          : isFilled || isCompleted
            ? ('ok' as const)
            : ('neutral' as const),
    },
    {
      title: '发布提交',
      text: '明确由用户点击发布按钮提交；采用一次性令牌防重放，结果未知绝不自动重试。',
      status: isCompleted
        ? '已提交'
        : isUnknown.value
          ? '结果未知'
          : task?.status === 'cancelled' || task?.result?.confirmationStatus === 'rejected'
            ? '已放弃'
            : isSubmitting.value
              ? '提交中'
              : isFilled
                ? '待发布'
                : '未开始',
      tone: isCompleted
        ? ('ok' as const)
        : isUnknown.value
          ? ('warn' as const)
          : isSubmitting.value || isFilled
            ? ('accent' as const)
            : ('neutral' as const),
    },
  ]
})

// 计算预览价格
const calculatedPrice = computed(() => {
  if (!selectedProduct.value) return 0
  const base = selectedProduct.value.priceNumber || 0
  const mult = customRule.value.priceMultiplier || 1.0
  const markup = customRule.value.priceMarkup || 0
  const finalPrice = Math.max(0.01, base * mult + markup)
  return Number(finalPrice.toFixed(2))
})

const calculatedOriginalPrice = computed(() => {
  return Number((calculatedPrice.value * 5).toFixed(2))
})

const previewTitle = computed(() => {
  if (!selectedProduct.value) return ''
  const prefix = customRule.value.titlePrefix || ''
  const suffix = customRule.value.titleSuffix || ''
  return `${prefix}${selectedProduct.value.title}${suffix}`.slice(0, 60)
})

const previewDesc = computed(() => {
  if (!selectedProduct.value) return ''
  const prefix = customRule.value.descPrefix || ''
  const suffix = customRule.value.descSuffix || ''
  const raw = selectedProduct.value.desc || selectedProduct.value.title
  return `${prefix}${raw}${suffix}`.slice(0, 1000)
})

const productValidation = computed(() => validateProductForPublish(selectedProduct.value))


function onSelectProductChange(event: Event): void {
  const target = event.target as HTMLSelectElement
  controller.selectProduct(target.value)
}

async function onRandomPick(): Promise<void> {
  await controller.selectRandomProduct()
}

async function onStartFillForm(): Promise<void> {
  if (!selectedProduct.value) return
  await controller.createAndFillTask()
}

async function onCancelTask(taskId: string): Promise<void> {
  await controller.cancelTask(taskId, '操作员在工作台取消')
}

async function onSubmitPublish(taskId: string): Promise<void> {
  if (!taskId || isSubmitDisabled.value) return
  await controller.submitPublish(taskId)
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
    <!-- 环境未就绪提醒 -->
    <Callout v-if="!inExtension" tone="warn" title="当前处于开发或脱机环境">
      未检测到扩展运行时环境（需在 Chrome 扩展内页中运行）。界面已接入 Mock 数据流，可正常测试商品选择与状态流转。
    </Callout>

    <!-- 1. 发布流程引导 -->
    <section aria-labelledby="stages-title">
      <div class="section-header">
        <h2 id="stages-title" class="section-title">发布流程与安全防线</h2>
        <span class="safe-badge">🛡️ 仅在用户点击“发布”后提交一次</span>
      </div>
      <ol class="stages">
        <li v-for="(stage, index) in stages" :key="stage.title" class="stage">
          <div class="stage__top">
            <span class="stage__index" aria-hidden="true">{{ index + 1 }}</span>
            <StatusTag :tone="stage.tone">{{ stage.status }}</StatusTag>
          </div>
          <h3 class="stage__title">{{ stage.title }}</h3>
          <p class="stage__text">{{ stage.text }}</p>
        </li>
      </ol>
    </section>

    <!-- 2. 商品选择与来源区 -->
    <PanelCard
      title="1. 选择待发布商品"
      description="从本地商品库读取真实商品，支持显式下拉选择或明确随机挑选 1 条（禁止自动偷选）。"
    >
      <template #actions>
        <button
          type="button"
          class="btn btn--sm btn--ghost"
          :disabled="isActionRunning || productsState.phase === 'loading'"
          title="重新读取商品库"
          @click="controller.loadProducts()"
        >
          🔄 刷新商品库
        </button>
      </template>

      <!-- 商品库加载中 -->
      <div v-if="productsState.phase === 'loading'" class="loading-state">
        <span class="loading-spinner" aria-hidden="true">⏳</span>
        <span>正在读取商品库候选数据...</span>
      </div>

      <!-- 商品库加载失败 -->
      <div v-else-if="productsState.phase === 'error' && productsState.error" class="error-state">
        <Callout tone="error" :view="productsState.error">
          <template #actions>
            <button type="button" class="btn btn--sm" @click="controller.loadProducts()">
              重试加载商品库
            </button>
          </template>
        </Callout>
      </div>

      <!-- 商品库为空 -->
      <div v-else-if="products.length === 0" class="empty-product-box">
        <EmptyState
          mark="库"
          title="商品库暂无可发布商品"
          description="发布功能依赖真实商品库数据。请先在采集中心采集或在商品库导入商品。"
        >
          <button type="button" class="btn btn--primary" @click="emit('navigate', 'collect')">
            去采集中心抓取
          </button>
          <button type="button" class="btn" @click="emit('navigate', 'products')">
            查看商品库
          </button>
        </EmptyState>
      </div>

      <!-- 正常选择控件 -->
      <div v-else class="select-form-container">
        <div class="select-form-row">
          <div class="form-group flex-1">
            <label for="product-select" class="form-label">
              显式选择商品：<span class="count-tip">(共 {{ products.length }} 件候选)</span>
            </label>
            <select
              id="product-select"
              class="input-select"
              :value="selectedProduct?.itemId || ''"
              :disabled="isActionRunning"
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
              :disabled="isActionRunning"
              @click="onRandomPick"
            >
              🎲 随机选择 1 条商品
            </button>
          </div>
        </div>

        <div v-if="!selectedProduct" class="select-guide-tip">
          <span>💡 提示：系统不会自动暗中选择商品，请从上方下拉列表挑选，或点击“🎲 随机选择 1 条商品”。</span>
        </div>
      </div>
    </PanelCard>

    <!-- 3. 商品预览与规则设置 -->
    <div v-if="selectedProduct" class="publish-grid">
      <PanelCard title="2. 商品与规则预览" description="核对来源字段与规则生成后的最终发布参数。">
        <div class="preview-card">
          <div class="preview-card__header">
            <img
              v-if="selectedProduct.coverUrl"
              :src="selectedProduct.coverUrl"
              alt="封面"
              class="preview-thumb"
            />
            <div class="preview-info">
              <span class="item-tag">来源 ID: {{ selectedProduct.itemId }}</span>
              <h4 class="preview-title">{{ previewTitle }}</h4>
              <div class="price-row">
                <span class="price-calc">
                  最终售价: <strong>{{ formatRMB(calculatedPrice) }}</strong>
                </span>
                <span class="price-orig">
                  划线原价: <del>{{ formatRMB(calculatedOriginalPrice) }}</del>
                </span>
                <span class="price-source">来源原价: {{ formatRMB(selectedProduct.price) }}</span>
              </div>
            </div>
          </div>

          <div class="preview-desc-box">
            <span class="desc-label">最终描述预览：</span>
            <p class="preview-desc-text">{{ previewDesc }}</p>
          </div>
        </div>

        <!-- 规则参数微调 -->
        <div class="rules-edit-grid">
          <div class="rule-field">
            <label class="rule-label">售价倍数系数：</label>
            <input
              type="number"
              step="0.05"
              min="0.1"
              max="10"
              class="input-text"
              :value="customRule.priceMultiplier"
              :disabled="isActionRunning"
              @input="controller.updateCustomRule({ priceMultiplier: Number(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="rule-field">
            <label class="rule-label">浮动加减价 (元)：</label>
            <input
              type="number"
              step="1"
              class="input-text"
              :value="customRule.priceMarkup"
              :disabled="isActionRunning"
              @input="controller.updateCustomRule({ priceMarkup: Number(($event.target as HTMLInputElement).value) })"
            />
          </div>

          <div class="rule-field">
            <label class="rule-label">标题前缀：</label>
            <input
              type="text"
              placeholder="如：【包邮】"
              class="input-text"
              :value="customRule.titlePrefix"
              :disabled="isActionRunning"
              @input="controller.updateCustomRule({ titlePrefix: ($event.target as HTMLInputElement).value })"
            />
          </div>

          <div class="rule-field">
            <label class="rule-label">标题后缀：</label>
            <input
              type="text"
              placeholder="如：[个人一手]"
              class="input-text"
              :value="customRule.titleSuffix"
              :disabled="isActionRunning"
              @input="controller.updateCustomRule({ titleSuffix: ($event.target as HTMLInputElement).value })"
            />
          </div>
        </div>

        <!-- 开始填表按钮（按钮宽度自适应内容，不撑满整行） -->
        <div class="submit-action-bar">
          <div class="submit-action-row">
            <button
              type="button"
              class="btn btn--primary btn--large"
              :disabled="isActionRunning || !productValidation.valid"
              @click="onStartFillForm"
            >
              <span v-if="isActionRunning" class="btn-spinner" aria-hidden="true">⏳</span>
              <span v-else aria-hidden="true">🚀</span>
              {{ isActionRunning ? '正在自动填充发布表单...' : '开始自动填充发布表单' }}
            </button>
            <span class="safe-note">提示：表单填充将在后台静默标签页中执行，完成后可点击“发布”提交。</span>
          </div>
        </div>

        <!-- 操作状态提示 -->
        <Callout
          v-if="action.error"
          tone="error"
          :view="action.error"
        />
        <Callout v-if="action.successMessage" tone="ok" :title="action.successMessage" />
      </PanelCard>

      <!-- 4. 当前执行与发布提交流程台 -->
      <PanelCard
        v-if="currentTask"
        title="3. 闲鱼发布提交"
        description="表单已填充就绪并生成一次性提交令牌，请点击“发布”按钮提交。"
      >
        <div class="confirmation-panel">
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

          <!-- 等待提交发布阶段（waiting_confirmation） -->
          <div v-if="currentTask.status === 'waiting_confirmation'" class="publish-submit-panel">
            <!-- 场景 A：已成功提交 -->
            <div v-if="isSubmitted" class="submitted-box" role="status" aria-live="polite">
              <span class="done-icon" aria-hidden="true">✅</span>
              <span class="done-text">商品发布已成功提交！</span>
            </div>

            <!-- 场景 B：提交结果未知（超时或未收到信号，严禁自动重试） -->
            <div v-else-if="isUnknown" class="unknown-box" role="alert" aria-live="assertive">
              <div class="unknown-header">
                <span class="warn-icon" aria-hidden="true">⚠️</span>
                <strong class="warn-title">发布结果未知，严禁自动重试</strong>
              </div>
              <p class="warn-desc">
                已向闲鱼发布页派发发布点击，但超时未收到明确的跳转信号。为防止在平台重复发布同一商品，<strong>系统已锁定且绝不自动重试</strong>。请稍后直接在闲鱼 APP 或网页端查看“我的发布”核实。
              </p>
              <div class="action-buttons">
                <button
                  type="button"
                  class="btn btn--danger"
                  aria-label="放弃本次发布任务"
                  @click="onCancelTask(currentTask.id)"
                >
                  放弃本次发布
                </button>
              </div>
            </div>

            <!-- 场景 C：等待用户明确点击“发布” -->
            <div v-else class="human-confirm-box">
              <div class="notice-callout">
                <p>
                  <strong>表单已成功自动填充！</strong>
                  已生成一次性提交令牌。请点击下方“发布”按钮完成提交。系统内置防重复提交保护，点击后立即锁定。
                </p>
              </div>

              <!-- 确定性错误反馈（若未锁定时提示修正后可重新点击） -->
              <div
                v-if="action.phase === 'failed' && action.error"
                class="submit-error-callout"
                role="alert"
                aria-live="polite"
              >
                <Callout tone="error" :view="action.error" />
              </div>

              <!-- 操作按钮组（按钮仅包裹可见文案，点击区域清晰不覆盖整行） -->
              <div class="action-buttons">
                <button
                  type="button"
                  class="btn btn--primary btn--large"
                  :disabled="isSubmitDisabled"
                  :aria-busy="isSubmitting"
                  aria-label="确认发布当前商品"
                  @click="onSubmitPublish(currentTask.id)"
                >
                  <span v-if="isSubmitting" class="btn-spinner" aria-hidden="true" />
                  <span v-else aria-hidden="true">🚀</span>
                  <span>{{ isSubmitting ? '正在提交发布...' : '发布' }}</span>
                </button>

                <button
                  type="button"
                  class="btn btn--danger"
                  :disabled="isSubmitting"
                  aria-label="放弃本次发布"
                  @click="onCancelTask(currentTask.id)"
                >
                  放弃本次发布
                </button>
              </div>

              <p v-if="!currentTask.result?.submitToken" class="token-missing-tip" role="status">
                ⚠️ 当前任务缺少有效提交令牌，请先重新填充表单。
              </p>
            </div>
          </div>

          <!-- 已完成 -->
          <div v-else-if="currentTask.status === 'completed'" class="done-box" role="status" aria-live="polite">
            <span class="done-icon" aria-hidden="true">🎉</span>
            <span class="done-text">该商品已发布完成！</span>
          </div>

          <!-- 任务已取消 -->
          <div v-else-if="currentTask.status === 'cancelled'" class="cancelled-box" role="status">
            <span class="cancelled-icon" aria-hidden="true">⏹</span>
            <span class="cancelled-text">本次发布任务已取消/放弃。</span>
          </div>

          <!-- 填表失败状态展示 -->
          <div v-else-if="currentTask.status === 'failed'" class="failed-box" role="alert">
            <span class="failed-icon" aria-hidden="true">❌</span>
            <span class="failed-text">
              发布异常：{{ currentTask.error || action.error?.title || '执行未完成' }}
            </span>
          </div>
        </div>
      </PanelCard>
    </div>

    <!-- 5. 发布任务历史列表 -->
    <PanelCard
      title="发布任务历史"
      description="最近生成的发布任务与提交结果（数据由 PUBLISH_LIST 实时提供）。"
    >
      <template #actions>
        <button
          type="button"
          class="btn btn--sm btn--ghost"
          :disabled="taskListState.phase === 'loading'"
          title="刷新发布任务列表"
          @click="controller.loadTasks()"
        >
          🔄 刷新列表
        </button>
      </template>

      <!-- 任务列表加载中 -->
      <div v-if="taskListState.phase === 'loading'" class="loading-state">
        <span class="loading-spinner" aria-hidden="true">⏳</span>
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
  </div>
</template>

<style scoped>
.publish-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  /* 关键：作为 .content 网格项，需显式允许收缩到内容宽度以下，
     否则下方发布任务表格的 min-content 会把整个发布页撑宽（真实环境曾出现按钮/整行超出视口、点击被拦截）。 */
  min-width: 0;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.section-title {
  font-size: 15px;
  font-weight: 650;
}

.safe-badge {
  font-size: 12px;
  font-weight: 600;
  color: var(--warn);
  background: var(--warn-soft);
  padding: 4px 8px;
  border-radius: var(--radius-tag);
}

.stages {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.stage {
  padding: 14px 16px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
}

.stage__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.stage__index {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  font-size: 12px;
  font-weight: 600;
  border-radius: var(--radius-tag);
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
}

.stage__title {
  font-size: 14px;
  font-weight: 650;
}

.stage__text {
  margin-top: 4px;
  font-size: 12.5px;
  color: var(--text-muted);
  line-height: 1.4;
}

/* 按钮点击区域与对齐修复：仅包裹文字与内边距，严禁 stretch 横跨整行 */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: fit-content;
  max-width: 100%;
  box-sizing: border-box;
}

.loading-state,
.error-state {
  padding: 16px 0;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-muted);
  font-size: 13px;
}

.loading-spinner {
  display: inline-block;
  animation: spin 1.2s infinite linear;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.empty-product-box {
  padding: 8px 0;
}

.select-form-container {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.select-form-row {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.flex-1 {
  flex: 1 1 320px;
}

.form-label {
  font-size: 13px;
  font-weight: 600;
}

.count-tip {
  font-size: 12px;
  font-weight: normal;
  color: var(--text-muted);
}

.input-select,
.input-text {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 12px;
  font-size: 13.5px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--text);
  outline: none;
}

.input-select:focus,
.input-text:focus {
  border-color: var(--focus);
}

.action-btn-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.select-guide-tip {
  font-size: 12.5px;
  color: var(--text-muted);
  background: var(--surface-sunken);
  padding: 8px 12px;
  border-radius: var(--radius-control);
  border: 1px dashed var(--border);
}

.publish-grid {
  display: flex;
  flex-direction: column;
  gap: 16px;
  /* 同理：允许内部长内容（表格/预览）收缩，超出部分交给各自容器滚动。 */
  min-width: 0;
}

.preview-card {
  padding: 14px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  margin-bottom: 16px;
}

.preview-card__header {
  display: flex;
  gap: 14px;
}

.preview-thumb {
  width: 80px;
  height: 80px;
  object-fit: cover;
  border-radius: var(--radius-control);
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.preview-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.item-tag {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--mono);
}

.preview-title {
  font-size: 14px;
  font-weight: 650;
  word-break: break-all;
}

.price-row {
  display: flex;
  gap: 12px;
  font-size: 13px;
  margin-top: 4px;
  flex-wrap: wrap;
}

.price-calc {
  color: var(--error);
}

.price-orig {
  color: var(--text-muted);
}

.price-source {
  color: var(--text-muted);
  font-size: 12px;
}

.preview-desc-box {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}

.desc-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.preview-desc-text {
  margin-top: 4px;
  font-size: 12.5px;
  color: var(--text);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.rules-edit-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.rule-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.rule-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

/* 填表按钮栏修复：使用 flex-start，主操作按钮只包裹文案，绝对不横向撑满整行 */
.submit-action-bar {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin-top: 8px;
  margin-bottom: 12px;
}

.submit-action-row {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}

.btn--large {
  min-height: 38px;
  padding: 0 18px;
  font-size: 14px;
  font-weight: 600;
}

.safe-note {
  font-size: 12px;
  color: var(--text-muted);
}

.confirmation-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
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
  flex-wrap: wrap;
}

.task-id {
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--mono);
}

.task-progress-box {
  min-width: 140px;
}

/* 发布提交确认盒：颜色遵循主题变量，深浅模式通用 */
.human-confirm-box {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  background: var(--warn-soft);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-panel);
}

.notice-callout {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
}

.notice-callout strong {
  color: var(--warn);
}

/* 操作按钮组修复：水平排列，各个按钮只包裹文本，避免异常拉伸 */
.action-buttons {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.btn--ok {
  background: var(--ok);
  color: #ffffff;
  border-color: var(--ok);
}

.btn--ok:hover:not(:disabled) {
  opacity: 0.9;
}

.btn--danger {
  background: var(--error);
  color: #ffffff;
  border-color: var(--error);
}

.btn--danger:hover:not(:disabled) {
  opacity: 0.9;
}

.note-input-row {
  display: flex;
}

.note-input {
  max-width: 440px;
}

.done-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: var(--ok-soft);
  border: 1px solid var(--ok);
  border-radius: var(--radius-control);
  font-size: 13px;
  color: var(--ok);
  font-weight: 600;
}

.publish-submit-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.submitted-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: var(--ok-soft);
  border: 1px solid var(--ok);
  border-radius: var(--radius-control);
  font-size: 13px;
  color: var(--ok);
  font-weight: 600;
}

.unknown-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  background: var(--warn-soft);
  border: 1px solid var(--warn);
  border-radius: var(--radius-panel);
}

.unknown-header {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--warn);
}

.warn-icon {
  font-size: 16px;
}

.warn-title {
  font-size: 14px;
  font-weight: 600;
}

.warn-desc {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
  margin: 0;
}

.cancelled-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: var(--neutral-soft);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-control);
  font-size: 13px;
  color: var(--text-muted);
  font-weight: 500;
}

.token-missing-tip {
  font-size: 12px;
  color: var(--warn);
  margin: 0;
}

.submit-error-callout {
  margin-top: 4px;
}

.failed-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: var(--error-soft);
  border: 1px solid var(--error);
  border-radius: var(--radius-control);
  font-size: 13px;
  color: var(--error);
  font-weight: 600;
}

.task-table-wrapper {
  /* 页宽受限时让表格在此容器内横向滚动，避免用 min-content 撑宽整页。 */
  max-width: 100%;
  min-width: 0;
  overflow-x: auto;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.data-table th,
.data-table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}

.col-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.empty-tip {
  color: var(--text-muted);
  font-size: 13px;
  text-align: center;
  padding: 24px 0;
}

@media (max-width: 900px) {
  .stages {
    grid-template-columns: repeat(2, 1fr);
  }
  .rules-edit-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 560px) {
  .stages {
    grid-template-columns: 1fr;
  }
  .rules-edit-grid {
    grid-template-columns: 1fr;
  }
  .select-form-row {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
