<script setup lang="ts">
import { computed } from 'vue'
import { allNav, type NavItem, type PageId } from '../data/navigation'
import { useBridgeStatus, type BridgeState } from '../composables/useBridgeStatus'
import { useTheme } from '../composables/useTheme'

const props = defineProps<{
  /** 当前选中的页面 ID */
  current: PageId
  /** 向后兼容传入的页面信息 */
  page?: NavItem
}>()

const emit = defineEmits<{
  navigate: [page: PageId]
  diagnostics: []
  settings: []
}>()

const { status, inExtension } = useBridgeStatus()
const { mode, cycle: cycleTheme } = useTheme()

/** 主题图标展示 */
const themeIcon = computed(() => (mode.value === 'dark' ? '☼' : '◐'))

/** 真实扩展 Bridge 连接状态元信息 */
const envMeta = computed<{ label: string; dotClass: string; title: string }>(() => {
  if (!inExtension) {
    return {
      label: '未连接扩展',
      dotClass: 'status-dot--warn',
      title: '请从 Chrome/Edge 扩展中打开工作台',
    }
  }

  const map: Record<BridgeState, { label: string; dotClass: string; title: string }> = {
    unavailable: { label: '未连接', dotClass: 'status-dot--warn', title: status.value.message ?? '未连接扩展' },
    idle: { label: '已就绪', dotClass: 'status-dot--idle', title: '扩展运行时就绪' },
    checking: { label: '连接中…', dotClass: 'status-dot--pulse', title: '正在探测与扩展 background 的连接' },
    online: {
      label: status.value.rtt !== null ? `已连接 · ${status.value.rtt}ms` : '已连接',
      dotClass: 'status-dot--online',
      title: status.value.message ?? 'Bridge 链路通畅',
    },
    error: { label: '连接异常', dotClass: 'status-dot--error', title: status.value.message ?? '连接失败' },
    unauthorized: { label: '未登录', dotClass: 'status-dot--error', title: status.value.message ?? '闲鱼账号未登录' },
    captcha: { label: '需验证', dotClass: 'status-dot--warn', title: status.value.message ?? '需要安全验证码' },
  }

  return map[status.value.state] ?? { label: '未知状态', dotClass: 'status-dot--idle', title: '' }
})

function onNavClick(targetId: PageId): void {
  if (targetId === 'settings') {
    emit('settings')
  }
  emit('navigate', targetId)
}
</script>

<template>
  <nav class="top-nav" aria-label="顶部轻导航">
    <div class="nav-container">
      <!-- 左侧：品牌 Logo 与产品名 -->
      <div class="brand-section">
        <div class="brand-logo-mark" aria-hidden="true">F</div>
        <div class="brand-name-wrap">
          <span class="brand-title">FishOps Workbench</span>
          <span class="brand-version-pill">v0.9.1</span>
        </div>
      </div>

      <!-- 中间：核心页面胶囊 Tab（原侧边栏收拢于此） -->
      <div class="tab-bar" role="tablist" aria-label="页面切换">
        <button
          v-for="item in allNav"
          :key="item.id"
          type="button"
          class="tab-item"
          :class="{ active: current === item.id }"
          role="tab"
          :aria-selected="current === item.id"
          @click="onNavClick(item.id)"
        >
          <span class="tab-dot" aria-hidden="true"></span>
          <span class="tab-text">{{ item.shortLabel ?? item.label }}</span>
        </button>
      </div>

      <!-- 右侧：真实状态药丸、深浅主题切换、诊断入口 -->
      <div class="nav-actions">
        <div
          class="status-pill"
          :title="envMeta.title"
          role="status"
          aria-live="polite"
        >
          <span class="status-live-dot" :class="envMeta.dotClass" aria-hidden="true"></span>
          <span class="status-text">{{ envMeta.label }}</span>
        </div>

        <button
          type="button"
          class="btn btn-icon-only"
          title="切换深色/浅色主题"
          aria-label="切换深色/浅色主题"
          @click="cycleTheme"
        >
          <span class="theme-icon-glyph" aria-hidden="true">{{ themeIcon }}</span>
        </button>

        <button
          type="button"
          class="btn"
          title="打开系统状态与开发诊断"
          @click="emit('diagnostics')"
        >
          诊断
        </button>
      </div>
    </div>
  </nav>
</template>

<style scoped>
.top-nav {
  position: sticky;
  top: 0;
  z-index: 50;
  background: var(--bg-canvas);
  border-bottom: 1px solid var(--border-line);
  backdrop-filter: blur(8px);
}

.nav-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 20px;
  height: 54px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.brand-section {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.brand-logo-mark {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--brand-yellow);
  color: #1c1917;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: -0.5px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.brand-name-wrap {
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.brand-title {
  font-size: 14px;
  font-weight: 600;
  letter-spacing: -0.2px;
  color: var(--text-main);
}

.brand-version-pill {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 9999px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-line);
  color: var(--text-muted);
}

/* 页面切换胶囊 Tab */
.tab-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  background: var(--bg-subtle);
  padding: 3px 4px;
  border-radius: 9999px;
  border: 1px solid var(--border-line);
  overflow-x: auto;
  scrollbar-width: none;
}

.tab-bar::-webkit-scrollbar {
  display: none;
}

.tab-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 11px;
  border-radius: 9999px;
  font-size: 12.5px;
  font-weight: 400;
  color: var(--text-secondary);
  cursor: pointer;
  border: 1px solid transparent;
  background: transparent;
  outline: none;
  transition: all 0.15s ease;
  white-space: nowrap;
  font-family: inherit;
}

.tab-item:hover {
  color: var(--text-main);
  background: rgba(0, 0, 0, 0.03);
}

:root[data-theme="dark"] .tab-item:hover {
  background: rgba(255, 255, 255, 0.05);
}

.tab-item.active {
  background: var(--bg-card);
  color: var(--text-main);
  font-weight: 500;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
  border-color: var(--border-line);
}

.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
  display: inline-block;
  transition: background 0.15s ease;
}

.tab-item.active .tab-dot {
  background: var(--brand-yellow);
}

.nav-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 9999px;
  font-size: 11.5px;
  background: var(--brand-yellow-bg);
  border: 1px solid var(--brand-yellow-border);
  color: var(--brand-yellow-text);
  font-weight: 500;
  cursor: default;
}

.status-live-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--brand-yellow);
  flex-shrink: 0;
}

.status-dot--online {
  background: var(--status-success);
}

.status-dot--warn {
  background: var(--status-warn);
}

.status-dot--error {
  background: var(--status-danger);
}

.status-dot--idle {
  background: var(--brand-yellow);
}

.status-dot--pulse {
  background: var(--brand-yellow);
  animation: pulse-dot 1.4s infinite ease-in-out;
}

@keyframes pulse-dot {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.85); }
}

.theme-icon-glyph {
  font-size: 14px;
  line-height: 1;
}

@media (max-width: 899px) {
  .nav-container {
    padding: 0 12px;
  }
  .brand-title {
    display: none;
  }
  .tab-item {
    padding: 4px 8px;
    font-size: 12px;
  }
}
</style>
