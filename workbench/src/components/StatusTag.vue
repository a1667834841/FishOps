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
  <span class="pill tag" :class="[`tag--${tone}`, { 'tag--mono': mono }]">
    <span v-if="dot" class="tag__dot" :class="{ 'tag__dot--pulse': pulse }" aria-hidden="true"></span>
    <slot />
  </span>
</template>

<style scoped>
.tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 20px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 400;
  line-height: 1.2;
  white-space: nowrap;
  border-radius: 9999px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-line);
  color: var(--text-secondary);
}

.tag--mono {
  font-family: var(--mono);
}

.tag--accent,
.tag--warn {
  background: var(--brand-yellow-bg);
  border-color: var(--brand-yellow-border);
  color: var(--brand-yellow-text);
  font-weight: 500;
}

.tag--ok {
  background: var(--status-success-bg);
  border-color: var(--status-success-border);
  color: var(--status-success);
}

.tag--error {
  background: var(--status-danger-bg);
  border-color: var(--status-danger-border);
  color: var(--status-danger);
}

.tag--info {
  background: var(--bg-subtle);
  border-color: var(--border-line);
  color: var(--text-secondary);
}

.tag__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.tag__dot--pulse {
  animation: tag-pulse 1.4s ease-in-out infinite;
}

@keyframes tag-pulse {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.35;
    transform: scale(0.85);
  }
}
</style>
