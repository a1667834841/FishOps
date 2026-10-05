<script setup lang="ts">
import { allNav, type NavItem, type PageId } from '../data/navigation'

defineProps<{ current: PageId }>()

const emit = defineEmits<{ navigate: [page: PageId] }>()

function go(item: NavItem): void {
  emit('navigate', item.id)
}
</script>

<template>
  <aside class="sidebar-compat" aria-label="侧边辅助导航">
    <div class="sidebar-inner">
      <button
        v-for="item in allNav"
        :key="item.id"
        type="button"
        class="tab-item"
        :class="{ active: item.id === current }"
        @click="go(item)"
      >
        <span class="tab-dot" aria-hidden="true"></span>
        <span>{{ item.label }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sidebar-compat {
  padding: 8px 12px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-line);
}

.sidebar-inner {
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}

.sidebar-inner::-webkit-scrollbar {
  display: none;
}

.tab-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 9999px;
  font-size: 12px;
  color: var(--text-secondary);
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
}

.tab-item:hover {
  background: var(--bg-hover);
  color: var(--text-main);
}

.tab-item.active {
  background: var(--brand-yellow-bg);
  color: var(--brand-yellow-text);
  border-color: var(--brand-yellow-border);
  font-weight: 500;
}

.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand-yellow);
}
</style>
