<script setup lang="ts">
import { computed } from 'vue'
import { PhArrowClockwise as ArrowClockwise, PhArrowRight as ArrowRight, PhPackage as Package, PhChatCircle as ChatCircle, PhDownloadSimple as DownloadSimple, PhUploadSimple as UploadSimple, PhChartBar as ChartBar, PhGear as Gear, PhSpinnerGap as SpinnerGap, PhWarningCircle as WarningCircle } from '@phosphor-icons/vue'
import PanelCard from '../components/PanelCard.vue'
import StatusTag from '../components/StatusTag.vue'
import { useBridgeController } from '../composables/useBridgeController'
import type { PageId } from '../data/navigation'
import { OVERVIEW_EVENTS, OverviewController, overviewTasks, taskCounts, type OverviewSource, type OverviewState, type OverviewTask } from '../features/overview/overview-controller'

const emit = defineEmits<{ navigate: [page: PageId] }>()
const { state, controller } = useBridgeController<OverviewState, OverviewController>({
  events: OVERVIEW_EVENTS, create: (api) => new OverviewController(api),
})
const counts = computed(() => taskCounts(state.value))
const recent = computed(() => overviewTasks(state.value).slice(0, 8))
const refreshing = computed(() => [state.value.products, state.value.conversations, state.value.tasks, state.value.publish].some((source) => source.loading))
const metrics = computed(() => [
  { label: '商品总数', value: state.value.products.value, source: state.value.products, icon: Package, target: 'products' as PageId },
  { label: '未读会话', value: state.value.conversations.value, source: state.value.conversations, icon: ChatCircle, target: 'chat' as PageId },
  { label: '运行中任务', value: counts.value?.running ?? null, source: taskSource(), icon: SpinnerGap, target: 'collect' as PageId },
  { label: '失败任务', value: counts.value?.failed ?? null, source: taskSource(), icon: WarningCircle, target: 'collect' as PageId },
])
function taskSource(): OverviewSource<unknown> {
  const { tasks, publish } = state.value
  return { value: counts.value, loading: tasks.loading || publish.loading, error: tasks.error ?? publish.error,
    updatedAt: tasks.updatedAt && publish.updatedAt ? Math.min(tasks.updatedAt, publish.updatedAt) : null }
}
function updated(source: OverviewSource<unknown>): string {
  if (source.loading) return source.value === null ? '正在读取' : '正在更新'
  if (!source.updatedAt) return source.error ? '读取失败，可刷新重试' : '连接扩展后显示'
  return `${source.error ? '刷新失败 · ' : ''}${new Date(source.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新`
}
const actions = [
  { label: '数据采集', target: 'collect' as PageId, icon: DownloadSimple },
  { label: '聊天中心', target: 'chat' as PageId, icon: ChatCircle },
  { label: '商品库', target: 'products' as PageId, icon: Package },
  { label: '发布中心', target: 'publish' as PageId, icon: UploadSimple },
  { label: '数据分析', target: 'analytics' as PageId, icon: ChartBar },
  { label: '设置', target: 'settings' as PageId, icon: Gear },
]
const statusLabels: Record<string, string> = { pending: '等待执行', running: '运行中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消', waiting_confirmation: '待确认' }
function taskName(task: OverviewTask): string {
  const keyword = (task.payload as Record<string, unknown>)?.keyword
  const title = (task.result as { item?: { title?: string } } | undefined)?.item?.title
  return title || (typeof keyword === 'string' && keyword) || `${task.type === 'capture' ? '采集' : task.type === 'publish' ? '发布' : '分析'}任务`
}
function taskTarget(task: OverviewTask): PageId { return task.type === 'capture' ? 'collect' : task.type === 'publish' ? 'publish' : 'analytics' }
function taskTime(time: number): string { return new Date(time).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) }
</script>

<template>
  <div class="page overview">
    <div class="overview-toolbar">
      <span class="muted">当前存储数据</span>
      <button class="btn" type="button" title="刷新概览" aria-label="刷新概览" :disabled="refreshing || state.availability === 'unavailable'" @click="controller.refresh()"><ArrowClockwise :size="18" /></button>
    </div>
    <div class="metrics">
      <button v-for="metric in metrics" :key="metric.label" type="button" class="metric" @click="emit('navigate', metric.target)">
        <span class="metric__label"><component :is="metric.icon" :size="18" />{{ metric.label }}</span>
        <span class="metric__value" :class="{ 'metric__value--empty': metric.value === null }">{{ metric.value === null ? (metric.source.loading ? '—' : '暂不可用') : metric.value.toLocaleString('zh-CN') }}</span>
        <span class="metric__hint" :title="metric.source.error?.title">{{ updated(metric.source) }}</span>
      </button>
    </div>
    <p v-if="state.realtimeError" class="muted" role="status">{{ state.realtimeError }}</p>
    <PanelCard title="近期任务">
      <div class="table-wrap" v-if="recent.length">
        <table class="overview-table">
          <thead><tr><th>任务</th><th>类型</th><th>状态</th><th>更新于</th><th><span class="sr-only">操作</span></th></tr></thead>
          <tbody><tr v-for="task in recent" :key="`${task.type}:${task.id}`">
            <td class="task-title">{{ taskName(task) }}</td><td>{{ task.type === 'capture' ? '采集' : task.type === 'publish' ? '发布' : '分析' }}</td>
            <td><StatusTag :tone="task.status === 'failed' ? 'error' : task.status === 'completed' ? 'ok' : task.status === 'running' ? 'accent' : 'neutral'">{{ statusLabels[task.status] ?? task.status }}</StatusTag></td>
            <td class="muted">{{ taskTime(task.updatedAt) }}</td><td><button class="btn btn--sm" type="button" :aria-label="`查看${taskName(task)}`" title="查看任务" @click="emit('navigate', taskTarget(task))"><ArrowRight :size="16" /></button></td>
          </tr></tbody>
        </table>
      </div>
      <div v-else class="overview-empty">{{ state.tasks.loading || state.publish.loading ? '正在读取任务…' : state.availability === 'unavailable' ? '连接扩展后查看近期任务' : state.tasks.error || state.publish.error ? '任务暂不可用，请刷新重试' : '暂无任务' }}</div>
      <p v-if="recent.length && (state.tasks.error || state.publish.error)" class="muted task-warning">部分任务读取失败，已保留可用记录。</p>
    </PanelCard>
    <PanelCard title="常用入口">
      <div class="quick-actions"><button v-for="action in actions" :key="action.target" class="quick-action" type="button" @click="emit('navigate', action.target)"><component :is="action.icon" :size="20" /><span>{{ action.label }}</span><ArrowRight :size="16" class="quick-action__arrow" /></button></div>
    </PanelCard>
  </div>
</template>

<style scoped>
.overview-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.metric { display: grid; gap: 8px; text-align: left; padding: 18px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-panel); cursor: pointer; }
.metric:hover { border-color: var(--accent); }
.metric__label { display: flex; align-items: center; gap: 8px; color: var(--text-muted); }
.metric__value { font-size: 30px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.25; }
.metric__value--empty { font-size: 20px; color: var(--text-muted); }
.metric__hint { font-size: 12px; color: var(--text-muted); }
.table-wrap { overflow-x: auto; }
.overview-table { width: 100%; border-collapse: collapse; text-align: left; white-space: nowrap; }
.overview-table th { font-size: 12px; font-weight: 500; color: var(--text-muted); padding: 8px 12px; border-bottom: 1px solid var(--border); }
.overview-table td { padding: 12px; border-bottom: 1px solid var(--border); }
.overview-table tbody tr:last-child td { border-bottom: 0; }
.task-title { max-width: 360px; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.overview-empty { padding: 44px 16px; text-align: center; color: var(--text-muted); }
.task-warning { margin-top: 12px; font-size: 12px; }
.quick-actions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.quick-action { display: flex; align-items: center; gap: 10px; padding: 14px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-control); cursor: pointer; text-align: left; }
.quick-action:hover { background: var(--surface-sunken); }
.quick-action__arrow { margin-left: auto; color: var(--text-muted); }
@media (max-width: 1100px) { .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { .quick-actions { grid-template-columns: repeat(2, minmax(0, 1fr)); } .metric { padding: 14px; } .metric__value { font-size: 26px; } .metric__value--empty { font-size: 18px; } }
</style>
