<script setup lang="ts">
import { computed } from 'vue'
import type { ErrorView } from '../features/shared/error-format'

/**
 * 提示块：成功 / 提示 / 警告 / 错误。
 * 错误与警告使用 role="alert"，其余使用 role="status"，读屏会按重要程度播报。
 * 传入 `view` 时按 ErrorView 渲染标题、建议与脱敏后的原始说明。
 */
const props = withDefaults(
  defineProps<{
    tone?: 'info' | 'ok' | 'warn' | 'error'
    title?: string
    view?: ErrorView | null
  }>(),
  { tone: 'info', title: undefined, view: null },
)

const role = computed(() => (props.tone === 'error' || props.tone === 'warn' ? 'alert' : 'status'))
</script>

<template>
  <div class="callout" :class="`callout--${tone}`" :role="role">
    <div class="callout__body">
      <template v-if="view">
        <p class="callout__title">{{ view.title }}</p>
        <p v-if="view.hint" class="callout__text">{{ view.hint }}</p>
        <p v-if="view.detail && view.detail !== view.title" class="callout__detail">
          {{ view.detail }}<span v-if="view.code"> · {{ view.code }}</span>
        </p>
      </template>
      <template v-else>
        <p v-if="title" class="callout__title">{{ title }}</p>
        <div class="callout__text"><slot /></div>
      </template>
    </div>
    <div v-if="$slots.actions" class="callout__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
.callout {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 14px;
  padding: 10px 14px;
  border-radius: var(--radius-control);
  border: 1px solid transparent;
  font-size: 13px;
  min-width: 0;
}

.callout--info {
  background: var(--info-soft);
  color: var(--text);
}

.callout--ok {
  background: var(--ok-soft);
  color: var(--ok);
}

.callout--warn {
  background: var(--warn-soft);
  color: var(--warn);
}

.callout--error {
  background: var(--error-soft);
  color: var(--error);
}

.callout__body {
  flex: 1 1 260px;
  display: grid;
  gap: 2px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.callout__title {
  font-weight: 650;
}

.callout__text {
  white-space: pre-wrap;
}

.callout__detail {
  font-size: 12px;
  opacity: 0.85;
  font-family: var(--mono);
}

.callout__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
