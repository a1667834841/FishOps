<script setup lang="ts">
import { computed } from 'vue'

/**
 * 真实进度条：value 必须来自后台上报，组件本身不做任何插值或动画推算。
 */
const props = defineProps<{
  value: number
  label: string
  tone?: 'accent' | 'ok' | 'warn' | 'error' | 'neutral'
}>()

const clamped = computed(() => Math.max(0, Math.min(100, Math.round(props.value))))
</script>

<template>
  <div
    class="bar"
    role="progressbar"
    :aria-label="label"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="clamped"
  >
    <span class="bar__fill" :class="`bar__fill--${tone ?? 'accent'}`" :style="{ width: `${clamped}%` }"></span>
  </div>
</template>

<style scoped>
.bar {
  height: 8px;
  overflow: hidden;
  border-radius: 4px;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
}

.bar__fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--accent);
  transition: width 0.25s ease;
}

.bar__fill--ok {
  background: var(--ok);
}

.bar__fill--warn {
  background: var(--warn);
}

.bar__fill--error {
  background: var(--error);
}

.bar__fill--neutral {
  background: var(--border-strong);
}
</style>
