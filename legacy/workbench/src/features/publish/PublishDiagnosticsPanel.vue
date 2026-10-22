<script setup lang="ts">
/**
 * 发布诊断折叠面板（纯只读）。
 *
 * 展示当前聚焦任务的安全诊断时间线：中文阶段 / 状态（成功 / 失败 / 未知 / 进行中）/
 * 开始时间与耗时 / 结构化原因码 / 安全数值计数与布尔标记。
 * 数据经 `buildPublishDiagnosticsView` 再次安全过滤，绝不渲染 URL / token / 商品正文。
 *
 * 组件**只做展示**：不发出任何命令，不触发 fill / submit / 重试，也不监听事件。
 */
import { computed, onMounted, ref } from 'vue'
import StatusTag from '../../components/StatusTag.vue'
import type { PublishDiagnostics } from '../contracts'
import { formatFullTime } from '../chat/chat-format'
import { buildPublishDiagnosticsView } from './publish-diagnostics'

const props = withDefaults(
  defineProps<{
    diagnostics?: PublishDiagnostics | null
    /** 折叠标题 */
    title?: string
    /** 无记录时的提示文案（明确不造 fake） */
    emptyText?: string
    /** 初始是否展开（仅初始化一次，之后由用户控制原生折叠） */
    defaultOpen?: boolean
  }>(),
  {
    diagnostics: null,
    title: '发布诊断',
    emptyText: '暂无诊断记录（该任务可能由旧版本创建），此处不展示任何推测内容。',
    defaultOpen: false,
  },
)

const detailsRef = ref<HTMLDetailsElement | null>(null)
const view = computed(() =>
  buildPublishDiagnosticsView(props.diagnostics, { formatTime: formatFullTime }),
)

// 仅设置一次初始展开态，之后保留原生 <details> 交互，避免受控绑定阻止用户折叠。
onMounted(() => {
  if (detailsRef.value) detailsRef.value.open = props.defaultOpen
})
</script>

<template>
  <details ref="detailsRef" class="pub-diag">
    <summary class="pub-diag__summary">
      <span class="pub-diag__title">{{ title }}</span>
      <StatusTag v-if="view.hasRecords" tone="neutral">{{ view.timeline.length }} 条记录</StatusTag>
      <StatusTag v-else tone="neutral">无记录</StatusTag>
      <span v-if="view.dropped > 0" class="pub-diag__dropped">已丢弃 {{ view.dropped }} 条旧记录</span>
    </summary>

    <div class="pub-diag__body">
      <p v-if="!view.hasRecords" class="pub-diag__empty">{{ emptyText }}</p>
      <ol v-else class="pub-diag__timeline">
        <li
          v-for="(entry, idx) in view.timeline"
          :key="`${entry.stage}-${idx}`"
          class="pub-diag__item"
        >
          <div class="pub-diag__item-head">
            <span class="pub-diag__stage">{{ entry.stageLabel }}</span>
            <StatusTag :tone="entry.statusTone">{{ entry.statusLabel }}</StatusTag>
          </div>
          <div class="pub-diag__item-meta">
            <span>开始：{{ entry.startedAtText || '—' }}</span>
            <span>耗时：{{ entry.latencyText }}</span>
            <span v-if="entry.code">原因码：<code>{{ entry.code }}</code></span>
          </div>
          <div v-if="entry.counters.length > 0 || entry.flags.length > 0" class="pub-diag__item-data">
            <span v-for="c in entry.counters" :key="`c-${c.key}`" class="pub-diag__chip">
              {{ c.label }}：{{ c.value }}
            </span>
            <span v-for="f in entry.flags" :key="`f-${f.key}`" class="pub-diag__chip">
              {{ f.label }}：{{ f.value ? '是' : '否' }}
            </span>
          </div>
        </li>
      </ol>
      <p v-if="view.updatedAtText" class="pub-diag__updated">最后更新：{{ view.updatedAtText }}</p>
    </div>
  </details>
</template>

<style scoped>
.pub-diag {
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  background: var(--surface);
  padding: 0;
}

.pub-diag__summary {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
  list-style: none;
}

.pub-diag__summary::-webkit-details-marker {
  display: none;
}

.pub-diag__summary::before {
  content: '▸';
  color: var(--text-muted);
  font-size: 12px;
  transition: transform 0.15s ease;
}

.pub-diag[open] > .pub-diag__summary::before {
  transform: rotate(90deg);
}

.pub-diag__title {
  font-weight: 650;
}

.pub-diag__dropped {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
}

.pub-diag__body {
  padding: 0 14px 14px;
  border-top: 1px solid var(--border);
}

.pub-diag__empty {
  margin-top: 12px;
  font-size: 12.5px;
  color: var(--text-muted);
}

.pub-diag__timeline {
  margin: 12px 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 10px;
}

.pub-diag__item {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
}

.pub-diag__item-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pub-diag__stage {
  font-size: 13px;
  font-weight: 600;
}

.pub-diag__item-meta {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.pub-diag__item-data {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 8px;
}

.pub-diag__chip {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  font-size: 12px;
  border-radius: var(--radius-tag);
  background: var(--accent-soft);
  color: var(--accent-text);
}

.pub-diag__updated {
  margin-top: 10px;
  font-size: 12px;
  color: var(--text-muted);
}
</style>
