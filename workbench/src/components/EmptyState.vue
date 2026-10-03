<script setup lang="ts">
import { PhTray } from '@phosphor-icons/vue'
defineProps<{
  title: string
  description: string
  /** 标题上方的单字标记，纯装饰 */
  mark?: string
}>()
</script>

<template>
  <div class="empty">
    <PhTray :size="32" class="empty__icon" aria-hidden="true" />
    <h3 class="empty__title">{{ title }}</h3>
    <p class="empty__desc">{{ description }}</p>
    <div v-if="$slots.default" class="empty__actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty__icon { margin-bottom: 8px; color: var(--text-muted); }
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 32px 20px;
}

.empty__mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  margin-bottom: 6px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-muted);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-control);
}

.empty__title {
  font-size: 14px;
  font-weight: 650;
}

.empty__desc {
  max-width: 44ch;
  font-size: 13px;
  color: var(--text-muted);
}

.empty__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 10px;
}
</style>
