<script setup lang="ts">
import { computed } from 'vue'
import type { ErrorView } from '../features/shared/error-format'

/**
 * 提示块：成功 / 提示 / 警告 / 错误。
 * 错误与警告使用 role="alert"，其余使用 role="status"。
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
  border-radius: 8px;
  border: 1px solid var(--border-line);
  font-size: 12.5px;
  min-width: 0;
}

.callout--info {
  background: var(--bg-subtle);
  border-color: var(--border-line);
  color: var(--text-main);
}

.callout--ok {
  background: var(--status-success-bg);
  border-color: var(--status-success-border);
  color: var(--status-success);
}

.callout--warn {
  background: var(--brand-yellow-bg);
  border-color: var(--brand-yellow-border);
  border-style: dashed;
  color: var(--brand-yellow-text);
}

.callout--error {
  background: var(--status-danger-bg);
  border-color: var(--status-danger-border);
  color: var(--status-danger);
}

.callout__body {
  flex: 1 1 260px;
  display: grid;
  gap: 3px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.callout__title {
  font-weight: 500;
  color: inherit;
}

.callout__text {
  white-space: pre-wrap;
  color: var(--text-secondary);
}

.callout--ok .callout__text {
  color: var(--status-success);
}

.callout--warn .callout__text {
  color: var(--brand-yellow-text);
}

.callout--error .callout__text {
  color: var(--status-danger);
}

.callout__detail {
  font-size: 11px;
  opacity: 0.85;
  font-family: var(--mono);
}

.callout__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
