<script setup lang="ts">
import { computed, ref } from 'vue'
import BackupNotice from '../components/BackupNotice.vue'
import {
  PhArrowClockwise as ArrowClockwise,
  PhArrowRight as ArrowRight,
  PhPackage as Package,
  PhChatCircle as ChatCircle,
  PhDownloadSimple as DownloadSimple,
  PhUploadSimple as UploadSimple,
  PhChartBar as ChartBar,
  PhGear as Gear,
  PhWarningCircle as WarningCircle,
} from '@phosphor-icons/vue'
import { useBridgeController } from '../composables/useBridgeController'
import type { PageId } from '../data/navigation'
import {
  OVERVIEW_EVENTS,
  OverviewController,
  overviewTasks,
  taskCounts,
  type OverviewSource,
  type OverviewState,
  type OverviewTask,
} from '../features/overview/overview-controller'

const emit = defineEmits<{ navigate: [page: PageId] }>()

const { state, controller } = useBridgeController<OverviewState, OverviewController>({
  events: OVERVIEW_EVENTS,
  create: (api) => new OverviewController(api),
})

const counts = computed(() => taskCounts(state.value))
const showAllTasks = ref(false)
const recent = computed(() => showAllTasks.value ? overviewTasks(state.value) : overviewTasks(state.value).slice(0, 8))
const refreshing = computed(() =>
  [state.value.products, state.value.conversations, state.value.tasks, state.value.publish].some(
    (source) => source.loading,
  ),
)

function taskSource(): OverviewSource<unknown> {
  const { tasks, publish } = state.value
  return {
    value: counts.value,
    loading: tasks.loading || publish.loading,
    error: tasks.error ?? publish.error,
    updatedAt:
      tasks.updatedAt && publish.updatedAt ? Math.min(tasks.updatedAt, publish.updatedAt) : null,
  }
}

function updated(source: OverviewSource<unknown>): string {
  if (source.loading) return source.value === null ? '正在读取' : '正在更新'
  if (!source.updatedAt) return source.error ? '读取失败，可刷新重试' : '连接扩展后显示'
  return `${source.error ? '刷新失败 · ' : ''}${new Date(source.updatedAt).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  })} 更新`
}

const metrics = computed(() => [
  {
    id: 'products',
    label: '商品总数',
    value: state.value.products.value,
    source: state.value.products,
    target: 'products' as PageId,
    badge: state.value.products.error ? { text: '需重试', tone: 'red' } : null,
    meta: updated(state.value.products),
  },
  {
    id: 'conversations',
    label: '未读会话',
    value: state.value.conversations.value,
    source: state.value.conversations,
    target: 'chat' as PageId,
    badge:
      state.value.conversations.value !== null && state.value.conversations.value > 0
        ? { text: '需关注', tone: 'red' }
        : state.value.conversations.error
          ? { text: '异常', tone: 'red' }
          : null,
    meta: updated(state.value.conversations),
  },
  {
    id: 'running',
    label: '运行中任务',
    value: counts.value?.running ?? null,
    source: taskSource(),
    target: 'collect' as PageId,
    badge:
      counts.value?.running !== null && counts.value && counts.value.running > 0
        ? { text: '执行中', tone: 'yellow' }
        : null,
    meta: updated(taskSource()),
  },
  {
    id: 'failed',
    label: '失败任务',
    value: counts.value?.failed ?? null,
    source: taskSource(),
    target: 'collect' as PageId,
    badge:
      counts.value?.failed !== null && counts.value && counts.value.failed > 0
        ? { text: '待排查', tone: 'red' }
        : taskSource().error
          ? { text: '异常', tone: 'red' }
          : null,
    meta: updated(taskSource()),
  },
])

const actions = [
  { label: '数据采集', target: 'collect' as PageId, icon: DownloadSimple },
  { label: '聊天中心', target: 'chat' as PageId, icon: ChatCircle },
  { label: '商品库', target: 'products' as PageId, icon: Package },
  { label: '发布中心', target: 'publish' as PageId, icon: UploadSimple },
  { label: '数据分析', target: 'analytics' as PageId, icon: ChartBar },
  { label: '系统设置', target: 'settings' as PageId, icon: Gear },
]

const statusLabels: Record<string, string> = {
  pending: '等待执行',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  waiting_confirmation: '待确认',
}

function taskName(task: OverviewTask): string {
  const keyword = (task.payload as Record<string, unknown>)?.keyword
  const title = (task.result as { item?: { title?: string } } | undefined)?.item?.title
  return title || (typeof keyword === 'string' && keyword) || `${task.type === 'capture' ? '采集' : task.type === 'publish' ? '发布' : '分析'}任务`
}

function taskTarget(task: OverviewTask): PageId {
  return task.type === 'capture' ? 'collect' : task.type === 'publish' ? 'publish' : 'analytics'
}

function taskTime(time: number): string {
  return new Date(time).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function taskTypeLabel(type: string): string {
  if (type === 'capture') return '采集'
  if (type === 'publish') return '发布'
  return '分析'
}

function taskTypeClass(type: string): string {
  if (type === 'capture') return 'pill pill-yellow'
  return 'pill'
}

function taskStatusClass(status: string): string {
  if (status === 'completed') return 'pill pill-green'
  if (status === 'running') return 'pill pill-yellow'
  if (status === 'failed') return 'pill pill-red'
  if (status === 'waiting_confirmation') return 'pill pill-yellow'
  return 'pill'
}
</script>

<template>
  <div class="page overview-view">
    <!-- 1. 顶部操作栏 -->
    <div class="view-header">
      <div class="view-title-group">
        <h1 class="view-title">运营总览</h1>
        <span class="view-sub">商品资产、未读会话、任务流水线与运行环境状态看板</span>
      </div>
      <div class="view-tools">
        <select class="input" aria-label="概览商品来源" :value="state.productSource"
          @change="controller.setProductSource(($event.target as HTMLSelectElement).value as 'feishu' | 'my_published')">
          <option value="feishu">飞书采集的商品库</option>
          <option value="my_published">自己发布的商品库</option>
        </select>
        <button
          type="button"
          class="btn"
          title="刷新概览数据"
          aria-label="刷新概览数据"
          :disabled="refreshing || state.availability === 'unavailable'"
          @click="controller.refresh()"
        >
          <ArrowClockwise :size="15" :class="{ 'icon-spin': refreshing }" />
          <span>{{ refreshing ? '刷新中…' : '刷新概览' }}</span>
        </button>
        <button
          type="button"
          class="btn btn-brand"
          @click="emit('navigate', 'products')"
        >
          浏览商品库
        </button>
      </div>
    </div>

    <BackupNotice @settings="emit('navigate', 'settings')" />
    <!-- 2. 四指标卡片网格 -->
    <div class="metrics-grid">
      <button
        v-for="metric in metrics"
        :key="metric.id"
        type="button"
        class="metric-card"
        @click="emit('navigate', metric.target)"
      >
        <div class="metric-header">
          <span class="metric-label">{{ metric.label }}</span>
          <span v-if="metric.badge" class="metric-badge" :class="metric.badge.tone">
            {{ metric.badge.text }}
          </span>
        </div>
        <div class="metric-value-row">
          <span class="metric-num" :class="{ 'metric-num--empty': metric.value === null }">
            {{
              metric.value === null
                ? (metric.source.loading ? '—' : '暂不可用')
                : metric.value.toLocaleString('zh-CN')
            }}
          </span>
        </div>
        <div class="metric-meta" :title="metric.source.error?.title">
          <span>{{ metric.meta }}</span>
        </div>
      </button>
    </div>

    <!-- 3. 下方分栏布局：左侧近期任务，右侧运行状态与快捷入口 -->
    <div class="dashboard-split">
      <!-- 近期任务卡片 -->
      <div class="card">
        <div class="card-header">
          <div class="card-title-wrap">
            <span class="card-title">近期任务</span>
            <span class="card-caption">采集 / 发布 / 分析</span>
          </div>
          <button
            type="button"
            class="btn btn-sm"
            @click="showAllTasks = !showAllTasks"
          >
            {{ showAllTasks ? '收起任务列表' : '查看全部任务' }}
          </button>
        </div>

        <div v-if="recent.length" class="table-responsive">
          <table class="seline-table">
            <thead>
              <tr>
                <th>任务</th>
                <th style="width: 80px;">类型</th>
                <th style="width: 96px;">状态</th>
                <th style="width: 130px;">更新时间</th>
                <th style="width: 80px; text-align: right;">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="task in recent" :key="`${task.type}:${task.id}`">
                <td class="task-title-cell" :title="taskName(task)">
                  <span class="task-title-text">{{ taskName(task) }}</span>
                </td>
                <td>
                  <span :class="taskTypeClass(task.type)">
                    {{ taskTypeLabel(task.type) }}
                  </span>
                </td>
                <td>
                  <span :class="taskStatusClass(task.status)">
                    {{ statusLabels[task.status] ?? task.status }}
                  </span>
                </td>
                <td class="task-time-cell">
                  {{ taskTime(task.updatedAt) }}
                </td>
                <td style="text-align: right;">
                  <button
                    type="button"
                    class="action-btn"
                    :aria-label="`查看${taskName(task)}`"
                    @click="emit('navigate', taskTarget(task))"
                  >
                    查看
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-else class="overview-empty" role="status">
          <p class="empty-title">
            {{
              state.tasks.loading || state.publish.loading
                ? '正在读取任务…'
                : state.availability === 'unavailable'
                  ? '连接扩展后查看近期任务'
                  : state.tasks.error || state.publish.error
                    ? '任务暂不可用，请刷新重试'
                    : '暂无任务'
            }}
          </p>
        </div>

        <div v-if="recent.length && (state.tasks.error || state.publish.error)" class="table-footer-warning">
          <WarningCircle :size="14" class="warning-icon" />
          <span>部分任务源读取失败，已保留可用记录。</span>
        </div>
      </div>

      <!-- 右侧辅助面板 -->
      <div class="split-side">
        <!-- 运行环境状态卡片 -->
        <div class="card">
          <div class="card-header">
            <div class="card-title-wrap">
              <span class="card-title">运行环境状态</span>
              <span class="card-caption">Bridge 实时与数据源</span>
            </div>
            <span
              class="pill"
              :class="state.availability === 'ready' ? (state.realtimeError ? 'pill-yellow' : 'pill-green') : 'pill-red'"
            >
              {{ state.availability === 'ready' ? (state.realtimeError ? '实时受限' : '已就绪') : '未连接' }}
            </span>
          </div>
          <div class="card-body">
            <div class="kv-list">
              <div class="kv-item">
                <span class="kv-k">Bridge 状态</span>
                <span
                  class="kv-v"
                  :class="{ 'text-ok': state.availability === 'ready', 'text-danger': state.availability !== 'ready' }"
                >
                  {{ state.availability === 'ready' ? '扩展连接就绪' : '未检测到扩展环境' }}
                </span>
              </div>
              <div class="kv-item">
                <span class="kv-k">实时事件通道</span>
                <span
                  class="kv-v"
                  :class="{ 'text-danger': Boolean(state.realtimeError), 'text-muted': !state.realtimeError }"
                >
                  {{ state.realtimeError ? '通道连接受限' : '事件监听正常' }}
                </span>
              </div>
              <div class="kv-item">
                <span class="kv-k">商品数据快照</span>
                <span class="kv-v text-muted">
                  {{ state.products.loading ? '正在同步…' : (state.products.error ? '同步异常' : (state.products.updatedAt ? '已同步' : '未加载')) }}
                </span>
              </div>
              <div class="kv-item">
                <span class="kv-k">会话数据快照</span>
                <span class="kv-v text-muted">
                  {{ state.conversations.loading ? '正在同步…' : (state.conversations.error ? '同步异常' : (state.conversations.updatedAt ? '已同步' : '未加载')) }}
                </span>
              </div>
            </div>
            <p class="muted-note">
              各数据源独立同步，事件合并后读取全量存储快照。所有指标均为真实统计，无任何虚构趋势。
            </p>
            <div v-if="state.realtimeError" class="side-actions">
              <button
                type="button"
                class="btn btn-sm btn-brand"
                @click="controller.resubscribe()"
              >
                重新订阅实时通道
              </button>
            </div>
          </div>
        </div>

        <!-- 常用入口卡片 -->
        <div class="card">
          <div class="card-header">
            <div class="card-title-wrap">
              <span class="card-title">快捷入口</span>
              <span class="card-caption">业务模块导航</span>
            </div>
          </div>
          <div class="card-body card-body-compact">
            <div class="quick-nav-grid">
              <button
                v-for="action in actions"
                :key="action.target"
                type="button"
                class="quick-nav-item"
                @click="emit('navigate', action.target)"
              >
                <div class="quick-nav-icon-wrap">
                  <component :is="action.icon" :size="16" />
                </div>
                <span class="quick-nav-label">{{ action.label }}</span>
                <ArrowRight :size="13" class="quick-nav-arrow" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Seline 暖纸白卡细线视觉系统局部定义与语义回退 */
.overview-view {
  --bg-card: var(--surface, #ffffff);
  --border-line: var(--border, #e8e5dc);
  --border-hover: var(--border-strong, #d6d2c4);
  --text-main: var(--text, #1c1917);
  --text-secondary: #57534e;
  --text-muted-color: var(--text-muted, #8c867e);
  --bg-subtle: var(--surface-sunken, #f4f2ec);
  --bg-hover: #ece9e1;
  --brand-yellow: var(--accent, #f5c400);
  --brand-yellow-hover: var(--accent-hover, #e5b700);
  --brand-yellow-active: var(--accent-active, #cca300);
  --brand-yellow-bg: #fef9e6;
  --brand-yellow-border: #f3dc7d;
  --brand-yellow-text: #826200;
  --status-success: var(--ok, #16a34a);
  --status-success-bg: #f0fdf4;
  --status-success-border: #bbf7d0;
  --status-danger: var(--error, #dc2626);
  --status-danger-bg: #fef2f2;
  --status-danger-border: #fecaca;
  --shadow-card: 0 1px 3px rgba(28, 25, 23, 0.04), 0 1px 2px rgba(28, 25, 23, 0.02);

  display: grid;
  gap: 16px;
}

:root[data-theme="dark"] .overview-view {
  --bg-card: var(--surface, #1a1916);
  --border-line: var(--border, #2e2b25);
  --border-hover: var(--border-strong, #423e34);
  --text-main: var(--text, #fbf9f5);
  --text-secondary: #aba59a;
  --text-muted-color: var(--text-muted, #7a746b);
  --bg-subtle: var(--surface-sunken, #24221e);
  --bg-hover: #2d2a24;
  --brand-yellow: #f5c400;
  --brand-yellow-hover: #ffd21a;
  --brand-yellow-active: #e5b700;
  --brand-yellow-bg: rgba(245, 196, 0, 0.12);
  --brand-yellow-border: rgba(245, 196, 0, 0.32);
  --brand-yellow-text: #fde68a;
  --status-success: #22c55e;
  --status-success-bg: rgba(34, 197, 94, 0.12);
  --status-success-border: rgba(34, 197, 94, 0.28);
  --status-danger: #ef4444;
  --status-danger-bg: rgba(239, 68, 68, 0.12);
  --status-danger-border: rgba(239, 68, 68, 0.28);
  --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.4);
}

/* ============ 顶部标题与工具栏 ============ */
.view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.view-title-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.view-title {
  font-size: 19px;
  font-weight: 400;
  letter-spacing: -0.02em;
  color: var(--text-main);
  line-height: 1.3;
}

.view-sub {
  font-size: 12.5px;
  color: var(--text-muted-color);
}

.view-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.btn-brand {
  background: var(--brand-yellow);
  border-color: var(--brand-yellow);
  color: #1c1917;
  font-weight: 500;
}

.btn-brand:hover:not(:disabled) {
  background: var(--brand-yellow-hover);
  border-color: var(--brand-yellow-hover);
}

.btn-brand:active:not(:disabled) {
  background: var(--brand-yellow-active);
  border-color: var(--brand-yellow-active);
}

.btn-sm {
  min-height: 28px;
  padding: 0 10px;
  font-size: 12px;
}

.icon-spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ============ 四指标卡片网格 ============ */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.metric-card {
  background: var(--bg-card);
  border: 1px solid var(--border-line);
  border-radius: 10px;
  padding: 14px 16px;
  box-shadow: var(--shadow-card);
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  font-family: inherit;
}

.metric-card:hover {
  border-color: var(--border-hover);
}

.metric-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.metric-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.metric-badge {
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 9999px;
  border: 1px solid var(--border-line);
  color: var(--text-muted-color);
  background: var(--bg-subtle);
  white-space: nowrap;
}

.metric-badge.yellow {
  background: var(--brand-yellow-bg);
  border-color: var(--brand-yellow-border);
  color: var(--brand-yellow-text);
  font-weight: 500;
}

.metric-badge.red {
  background: var(--status-danger-bg);
  border-color: var(--status-danger-border);
  color: var(--status-danger);
}

.metric-value-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 2px;
}

.metric-num {
  font-size: 24px;
  font-weight: 400;
  letter-spacing: -0.03em;
  color: var(--text-main);
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.metric-num--empty {
  font-size: 18px;
  color: var(--text-muted-color);
}

.metric-meta {
  font-size: 11px;
  color: var(--text-muted-color);
  padding-top: 6px;
  border-top: 1px solid var(--border-line);
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  gap: 8px;
}

/* ============ 分栏结构 ============ */
.dashboard-split {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 16px;
  align-items: start;
}

.split-side {
  display: grid;
  gap: 16px;
}

/* ============ 白卡容器与标题 ============ */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border-line);
  border-radius: 10px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.card-header {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-line);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  background: var(--bg-card);
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
  color: var(--text-muted-color);
}

.card-body {
  padding: 16px;
}

.card-body-compact {
  padding: 12px;
}

/* ============ Seline 细线紧凑表格 ============ */
.table-responsive {
  width: 100%;
  overflow-x: auto;
}

.seline-table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  white-space: nowrap;
}

.seline-table th {
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 11.5px;
  font-weight: 500;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border-line);
  height: 32px;
}

.seline-table td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--border-line);
  font-size: 12.5px;
  color: var(--text-main);
}

.seline-table tr:hover td {
  background: var(--bg-subtle);
}

.seline-table tbody tr:last-child td {
  border-bottom: 0;
}

.task-title-cell {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-title-text {
  font-weight: 500;
}

.task-time-cell {
  color: var(--text-muted-color);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
}

/* ============ 胶囊标签 (Pills) ============ */
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

/* ============ 操作按钮（行内轻操作） ============ */
.action-btn {
  color: var(--brand-yellow-text);
  text-decoration: none;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  background: transparent;
  border: none;
  padding: 2px 4px;
  font-family: inherit;
  border-radius: 4px;
  transition: opacity 0.15s ease;
}

.action-btn:hover {
  text-decoration: underline;
  opacity: 0.85;
}

/* ============ 空态与告警 ============ */
.overview-empty {
  padding: 48px 16px;
  text-align: center;
}

.empty-title {
  color: var(--text-muted-color);
  font-size: 13px;
}

.table-footer-warning {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  background: var(--brand-yellow-bg);
  border-top: 1px solid var(--brand-yellow-border);
  color: var(--brand-yellow-text);
  font-size: 12px;
}

.warning-icon {
  flex-shrink: 0;
}

/* ============ 运行状态键值列表 ============ */
.kv-list {
  display: grid;
  gap: 8px;
}

.kv-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border-line);
  font-size: 12px;
}

.kv-item:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.kv-k {
  color: var(--text-secondary);
}

.kv-v {
  font-weight: 500;
}

.text-ok {
  color: var(--status-success);
}

.text-danger {
  color: var(--status-danger);
}

.text-muted {
  color: var(--text-muted-color);
}

.muted-note {
  font-size: 11.5px;
  color: var(--text-muted-color);
  line-height: 1.5;
  margin-top: 10px;
}

.side-actions {
  margin-top: 12px;
}

/* ============ 快捷导航入口 ============ */
.quick-nav-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
}

.quick-nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-line);
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.quick-nav-item:hover {
  background: var(--bg-hover);
  border-color: var(--border-hover);
}

.quick-nav-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-secondary);
}

.quick-nav-label {
  font-size: 12.5px;
  color: var(--text-main);
  font-weight: 500;
  white-space: nowrap;
}

.quick-nav-arrow {
  margin-left: auto;
  color: var(--text-muted-color);
  opacity: 0.6;
}

.quick-nav-item:hover .quick-nav-arrow {
  opacity: 1;
  color: var(--brand-yellow-text);
}

/* ============ 响应式适配 ============ */
@media (max-width: 1080px) {
  .metrics-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .dashboard-split {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .metrics-grid {
    grid-template-columns: 1fr;
  }
  .quick-nav-grid {
    grid-template-columns: 1fr;
  }
  .metric-card {
    padding: 12px 14px;
  }
  .metric-num {
    font-size: 22px;
  }
}
</style>
