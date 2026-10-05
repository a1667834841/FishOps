<script setup lang="ts">
defineProps<{
  title?: string
  description?: string
  /** 去掉内容区内边距，用于表格、列表等贴边布局 */
  flush?: boolean
}>()
</script>

<template>
  <section class="card panel">
    <header v-if="title || $slots.actions" class="card-header panel__head">
      <div class="card-title-wrap panel__heading">
        <h2 v-if="title" class="card-title panel__title">{{ title }}</h2>
        <p v-if="description" class="card-caption panel__desc">{{ description }}</p>
      </div>
      <div v-if="$slots.actions" class="card-actions panel__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="card-body panel__body" :class="{ 'panel__body--flush': flush }">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.panel {
  min-width: 0;
  background: var(--bg-card);
  border: 1px solid var(--border-line);
  border-radius: 10px;
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-line);
  background: var(--bg-card);
  flex-wrap: wrap;
}

.panel__heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.panel__title {
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--text-main);
  line-height: 1.35;
}

.panel__desc {
  font-size: 11.5px;
  color: var(--text-muted);
}

.panel__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}

.panel__body {
  padding: 16px;
}

.panel__body--flush {
  padding: 0;
}
</style>
