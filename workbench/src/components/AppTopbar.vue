<script setup lang="ts">
import { computed } from 'vue'
import type { NavItem } from '../data/navigation'
import { useBridgeStatus, type BridgeState } from '../composables/useBridgeStatus'
import { useTheme } from '../composables/useTheme'
import StatusTag, { type TagTone } from './StatusTag.vue'

defineProps<{ page: NavItem }>()

const emit = defineEmits<{
  diagnostics: []
  settings: []
}>()

const { status } = useBridgeStatus()
const theme = useTheme()

const envMeta = computed<{ label: string; tone: TagTone; pulse: boolean }>(() => {
  const labels: Record<BridgeState, { label: string; tone: TagTone; pulse: boolean }> = {
    unavailable: { label: '非扩展环境', tone: 'warn', pulse: false },
    idle: { label: '扩展内页', tone: 'neutral', pulse: false },
    checking: { label: '连接检测中', tone: 'accent', pulse: true },
    online: {
      label: status.value.rtt !== null ? `扩展已连接 · ${status.value.rtt} ms` : '扩展已连接',
      tone: 'ok',
      pulse: false,
    },
    error: { label: 'Bridge 异常', tone: 'error', pulse: false },
  }
  return labels[status.value.state]
})
</script>

<template>
  <header class="topbar">
    <div class="topbar__title">
      <h1 class="topbar__h1">{{ page.title }}</h1>
      <p class="topbar__desc">{{ page.description }}</p>
    </div>

    <div class="topbar__actions">
      <button
        type="button"
        class="env"
        :title="status.message ?? '打开系统状态与开发诊断'"
        @click="emit('diagnostics')"
      >
        <StatusTag :tone="envMeta.tone" dot :pulse="envMeta.pulse">{{ envMeta.label }}</StatusTag>
        <span class="env__action">诊断</span>
      </button>

      <button type="button" class="btn btn--ghost btn--sm" :title="`外观：${theme.label.value}，点击切换`" @click="theme.cycle()">
        <span class="topbar__theme-key">外观</span>
        {{ theme.label.value }}
      </button>

      <button type="button" class="account" @click="emit('settings')">
        <span class="account__avatar" aria-hidden="true">我</span>
        <span class="account__text">本地工作区</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding-bottom: 16px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--border);
}

.topbar__title {
  min-width: 0;
}

.topbar__h1 {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.3;
  letter-spacing: 0;
}

.topbar__desc {
  margin-top: 2px;
  font-size: 13px;
  color: var(--text-muted);
}

.topbar__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.topbar__theme-key {
  color: var(--text-muted);
  opacity: 0.8;
}

.env {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 4px 0 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface);
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.env:hover {
  border-color: var(--border-strong);
  background: var(--surface-sunken);
}

.env:active {
  transform: translateY(1px);
}

.env__action {
  padding: 0 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.account {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 0 12px 0 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface);
  cursor: pointer;
  font-size: 13px;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.account:hover {
  border-color: var(--border-strong);
  background: var(--surface-sunken);
}

.account:active {
  transform: translateY(1px);
}

.account__avatar {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  font-size: 12px;
  font-weight: 600;
  border-radius: var(--radius-tag);
  background: var(--sidebar-bg);
  color: #fff;
}

@media (max-width: 599px) {
  .topbar__theme-key {
    display: none;
  }

  .topbar__h1 {
    font-size: 20px;
  }
}
</style>
