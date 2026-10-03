<script setup lang="ts">
import PanelCard from '../components/PanelCard.vue'
import StatusTag from '../components/StatusTag.vue'
import type { PageId } from '../data/navigation'
import {
  demoActivities,
  demoMetrics,
  demoTasks,
  flowStages,
  quickActions,
  taskStatusMeta,
} from '../data/overview'

const emit = defineEmits<{ navigate: [page: PageId] }>()

/** 本次会话的真实启动时间，是活动列表里唯一的非演示条目。 */
const sessionStartedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div class="page overview">
    <section class="hero" aria-labelledby="hero-title">
      <div class="hero__main">
        <p class="hero__eyebrow">今日运营</p>
        <h2 id="hero-title" class="hero__title">把采集、对话和发布放在一个工作台里</h2>
        <p class="hero__text">
          从闲鱼采集商品数据，在聊天中心集中跟进买家，经发布中心整理上架，再用分析复盘价格与咨询。各模块正在按阶段接入，未接入的部分会明确标注。
        </p>
        <div class="row hero__actions">
          <button type="button" class="btn btn--primary" @click="emit('navigate', 'collect')">开始采集</button>
          <button type="button" class="btn" @click="emit('navigate', 'chat')">打开聊天</button>
        </div>
      </div>

      <div class="hero__flow">
        <h3 class="hero__flow-title">模块接入进度</h3>
        <ol class="flow">
          <li v-for="(stage, index) in flowStages" :key="stage.id" class="flow__item">
            <span class="flow__index" aria-hidden="true">{{ index + 1 }}</span>
            <span class="flow__text">
              <span class="flow__label">{{ stage.label }}</span>
              <span class="flow__note">{{ stage.note }}</span>
            </span>
            <StatusTag :tone="stage.tone">{{ stage.status }}</StatusTag>
          </li>
        </ol>
      </div>
    </section>

    <section aria-labelledby="metrics-title">
      <div class="section-head">
        <h2 id="metrics-title" class="section-head__title">今日摘要</h2>
        <StatusTag tone="warn">演示数据</StatusTag>
        <p class="section-head__note">数值仅用于预览布局，不代表真实线上数据。</p>
      </div>
      <ul class="metrics">
        <li v-for="metric in demoMetrics" :key="metric.id">
          <button type="button" class="metric" @click="emit('navigate', metric.target)">
            <span class="metric__label">{{ metric.label }}</span>
            <span class="metric__value">
              {{ metric.value }}<span class="metric__unit">{{ metric.unit }}</span>
            </span>
            <span class="metric__hint">{{ metric.hint }}</span>
            <span class="metric__demo">示例</span>
          </button>
        </li>
      </ul>
    </section>

    <div class="split">
      <PanelCard title="任务状态" description="各模块当前的后台任务">
        <template #actions>
          <StatusTag tone="warn">演示数据</StatusTag>
        </template>
        <ul class="tasks">
          <li v-for="task in demoTasks" :key="task.id" class="task">
            <div class="task__top">
              <div class="task__name">
                <span class="task__title">{{ task.name }}</span>
                <span class="task__detail">{{ task.detail }}</span>
              </div>
              <StatusTag
                :tone="taskStatusMeta[task.status].tone"
                :dot="task.status === 'running'"
                :pulse="task.status === 'running'"
              >
                {{ taskStatusMeta[task.status].label }}
              </StatusTag>
            </div>
            <div class="task__bar">
              <div
                class="progress"
                role="progressbar"
                :aria-label="`${task.name}进度（示例）`"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-valuenow="task.progress"
              >
                <span
                  class="progress__fill"
                  :class="`progress__fill--${taskStatusMeta[task.status].tone}`"
                  :style="{ width: `${task.progress}%` }"
                ></span>
              </div>
              <span class="task__pct">{{ task.progress }}%</span>
            </div>
          </li>
        </ul>
      </PanelCard>

      <PanelCard title="快捷操作" description="常用入口，直接跳转到对应模块">
        <ul class="actions">
          <li v-for="action in quickActions" :key="action.id">
            <button
              type="button"
              class="action"
              :class="{ 'action--primary': action.primary }"
              @click="emit('navigate', action.target)"
            >
              <span class="action__label">{{ action.label }}</span>
              <span class="action__desc">{{ action.description }}</span>
              <span class="action__arrow" aria-hidden="true">›</span>
            </button>
          </li>
        </ul>
      </PanelCard>
    </div>

    <PanelCard title="最近活动" description="按时间倒序">
      <template #actions>
        <StatusTag tone="warn">示例</StatusTag>
      </template>
      <ul class="activity">
        <li class="activity__item">
          <span class="activity__time">{{ sessionStartedAt }}</span>
          <StatusTag tone="ok">本次会话</StatusTag>
          <span class="activity__text">工作台已加载，可在顶部栏查看扩展连接状态</span>
        </li>
        <li v-for="item in demoActivities" :key="item.id" class="activity__item">
          <span class="activity__time">{{ item.time }}</span>
          <StatusTag>{{ item.module }}</StatusTag>
          <span class="activity__text">{{ item.text }}</span>
        </li>
      </ul>
    </PanelCard>
  </div>
</template>

<style scoped>
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(280px, 1fr);
  gap: 24px;
  padding: 22px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
}

.hero__eyebrow {
  font-size: 12px;
  font-weight: 600;
  color: var(--accent-text);
}

.hero__title {
  margin-top: 4px;
  font-size: 22px;
  font-weight: 700;
  line-height: 1.35;
}

.hero__text {
  max-width: 52ch;
  margin-top: 8px;
  color: var(--text-muted);
}

.hero__actions {
  margin-top: 16px;
}

.hero__flow {
  padding: 14px 16px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
}

.hero__flow-title {
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.flow {
  display: grid;
}

.flow__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}

.flow__item + .flow__item {
  border-top: 1px solid var(--border);
}

.flow__index {
  display: grid;
  place-items: center;
  flex: none;
  width: 22px;
  height: 22px;
  font-size: 12px;
  font-weight: 600;
  border-radius: var(--radius-tag);
  border: 1px solid var(--border-strong);
  color: var(--text-muted);
}

.flow__text {
  display: grid;
  flex: 1;
  min-width: 0;
}

.flow__label {
  font-weight: 600;
  line-height: 1.3;
}

.flow__note {
  font-size: 12px;
  color: var(--text-muted);
}

.section-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
  margin-bottom: 10px;
}

.section-head__title {
  font-size: 15px;
  font-weight: 650;
}

.section-head__note {
  font-size: 12.5px;
  color: var(--text-muted);
}

.metrics {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.metric {
  position: relative;
  display: grid;
  gap: 2px;
  width: 100%;
  height: 100%;
  padding: 14px 16px;
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.metric:hover {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent-soft) 45%, var(--surface));
}

.metric:active {
  transform: translateY(1px);
}

.metric__label {
  font-size: 12.5px;
  color: var(--text-muted);
}

.metric__value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.25;
  font-variant-numeric: tabular-nums;
}

.metric__unit {
  margin-left: 3px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
}

.metric__hint {
  font-size: 12px;
  color: var(--text-muted);
}

.metric__demo {
  position: absolute;
  top: 12px;
  right: 12px;
  padding: 1px 6px;
  font-size: 11px;
  border-radius: var(--radius-tag);
  background: var(--warn-soft);
  color: var(--warn);
}

.split {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}

.tasks {
  display: grid;
}

.task {
  display: grid;
  gap: 8px;
  padding: 12px 0;
}

.task:first-child {
  padding-top: 0;
}

.task:last-child {
  padding-bottom: 0;
}

.task + .task {
  border-top: 1px solid var(--border);
}

.task__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.task__name {
  display: grid;
  min-width: 0;
}

.task__title {
  font-weight: 600;
}

.task__detail {
  font-size: 12.5px;
  color: var(--text-muted);
}

.task__bar {
  display: flex;
  align-items: center;
  gap: 10px;
}

.progress {
  flex: 1;
  height: 6px;
  overflow: hidden;
  border-radius: 3px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
}

.progress__fill {
  display: block;
  height: 100%;
  background: var(--text-muted);
  transition: width 0.4s ease;
}

.progress__fill--accent {
  background: var(--accent);
}

.progress__fill--ok {
  background: var(--ok);
}

.progress__fill--info {
  background: var(--info);
}

.task__pct {
  width: 36px;
  font-size: 12px;
  text-align: right;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.actions {
  display: grid;
  gap: 8px;
}

.action {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas:
    "label arrow"
    "desc arrow";
  align-items: center;
  column-gap: 12px;
  width: 100%;
  padding: 10px 14px;
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}

.action:hover {
  background: var(--surface-sunken);
}

.action:active {
  transform: translateY(1px);
}

.action--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--on-accent);
}

.action--primary:hover {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}

.action--primary:active {
  background: var(--accent-active);
}

.action__label {
  grid-area: label;
  font-weight: 600;
}

.action__desc {
  grid-area: desc;
  font-size: 12.5px;
  opacity: 0.75;
}

.action__arrow {
  grid-area: arrow;
  font-size: 20px;
  line-height: 1;
  opacity: 0.6;
}

.activity__item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
}

.activity__item:first-child {
  padding-top: 0;
}

.activity__item:last-child {
  padding-bottom: 0;
}

.activity__item + .activity__item {
  border-top: 1px solid var(--border);
}

.activity__time {
  flex: none;
  width: 44px;
  font-size: 12.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.activity__text {
  min-width: 0;
}

@media (max-width: 1179px) {
  .metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 1099px) {
  .hero,
  .split {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 599px) {
  .hero {
    padding: 16px;
  }

  .metrics {
    grid-template-columns: minmax(0, 1fr);
  }

  .activity__item {
    flex-wrap: wrap;
    gap: 4px 10px;
  }

  .activity__text {
    flex-basis: 100%;
  }
}
</style>
