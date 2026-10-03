<script setup lang="ts">
export type TagTone = 'neutral' | 'accent' | 'ok' | 'info' | 'warn' | 'error'

withDefaults(
  defineProps<{
    tone?: TagTone
    /** 是否在文字前显示状态圆点 */
    dot?: boolean
    /** 圆点是否呼吸闪烁（用于进行中状态） */
    pulse?: boolean
    mono?: boolean
  }>(),
  { tone: 'neutral', dot: false, pulse: false, mono: false },
)
</script>

<template>
  <span class="tag" :class="[`tag--${tone}`, { 'tag--mono': mono }]">
    <span v-if="dot" class="tag__dot" :class="{ 'tag__dot--pulse': pulse }" aria-hidden="true"></span>
    <slot />
  </span>
</template>

<style scoped>
.tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 22px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  border-radius: var(--radius-tag);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  color: var(--text-muted);
}

.tag--mono {
  font-family: var(--mono);
}

.tag--accent {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent-text);
}

.tag--ok {
  background: var(--ok-soft);
  border-color: transparent;
  color: var(--ok);
}

.tag--info {
  background: var(--info-soft);
  border-color: transparent;
  color: var(--info);
}

.tag--warn {
  background: var(--warn-soft);
  border-color: transparent;
  color: var(--warn);
}

.tag--error {
  background: var(--error-soft);
  border-color: transparent;
  color: var(--error);
}

.tag__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.tag__dot--pulse {
  animation: tag-pulse 1.4s ease-in-out infinite;
}

@keyframes tag-pulse {
  50% {
    opacity: 0.3;
  }
}
</style>
