<script setup lang="ts">
defineProps<{
  title?: string
  description?: string
  /** 去掉内容区内边距，用于表格、列表等需要贴边的内容 */
  flush?: boolean
}>()
</script>

<template>
  <section class="panel">
    <header v-if="title || $slots.actions" class="panel__head">
      <div class="panel__heading">
        <h2 v-if="title" class="panel__title">{{ title }}</h2>
        <p v-if="description" class="panel__desc">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="panel__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="panel__body" :class="{ 'panel__body--flush': flush }">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.panel {
  min-width: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  overflow: hidden;
}

.panel__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 18px 0;
}

.panel__title {
  font-size: 15px;
  font-weight: 650;
  line-height: 1.35;
}

.panel__desc {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--text-muted);
}

.panel__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.panel__body {
  padding: 14px 18px 18px;
}

.panel__body--flush {
  padding: 0;
}

.panel__head + .panel__body--flush {
  margin-top: 14px;
}
</style>
