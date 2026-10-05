<script setup lang="ts">
import { PhTray } from '@phosphor-icons/vue'

defineProps<{
  title: string
  description: string
  /** 标题上方的标记文字，纯装饰 */
  mark?: string
}>()
</script>

<template>
  <div class="empty">
    <div v-if="mark" class="empty__mark">{{ mark }}</div>
    <PhTray v-else :size="32" class="empty__icon" aria-hidden="true" />
    <h3 class="empty__title">{{ title }}</h3>
    <p class="empty__desc">{{ description }}</p>
    <div v-if="$slots.default" class="empty__actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 36px 20px;
}

.empty__icon {
  margin-bottom: 4px;
  color: var(--text-faint);
}

.empty__mark {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  margin-bottom: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--brand-yellow-text);
  background: var(--brand-yellow-bg);
  border: 1px dashed var(--brand-yellow-border);
  border-radius: 9999px;
}

.empty__title {
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--text-main);
}

.empty__desc {
  max-width: 44ch;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

.empty__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 10px;
}
</style>
