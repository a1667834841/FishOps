<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { PhX } from '@phosphor-icons/vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const panelRef = ref<HTMLElement | null>(null)
const closeRef = ref<HTMLButtonElement | null>(null)
let returnFocusTo: HTMLElement | null = null

// 打开时把焦点移入抽屉，关闭后还给触发按钮。
watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
      await nextTick()
      closeRef.value?.focus()
    } else {
      returnFocusTo?.focus()
      returnFocusTo = null
    }
  },
)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
    return
  }
  if (event.key !== 'Tab' || !panelRef.value) return

  // 简单焦点陷阱：Tab 在抽屉内首尾循环。
  const focusables = Array.from(
    panelRef.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  )
  if (focusables.length === 0) return
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
</script>

<template>
  <!--
    用 v-show 而非 v-if：BridgeDemo 的订阅、日志和 PING 状态在抽屉关闭后仍需保留，
    顶部栏的环境状态也依赖它持续运行。
  -->
  <Transition name="drawer">
    <div v-show="open" class="drawer" @keydown="onKeydown">
      <div class="drawer__scrim" @click="emit('close')"></div>
      <aside
        ref="panelRef"
        class="drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diagnostics-title"
      >
        <header class="drawer__head">
          <div>
            <h2 id="diagnostics-title" class="drawer__title">系统状态与开发诊断</h2>
            <p class="drawer__desc">验证 Workbench 与扩展 background 之间的 Bridge 链路。</p>
          </div>
          <button ref="closeRef" type="button" class="btn btn--ghost btn--icon" aria-label="关闭诊断" title="关闭" @click="emit('close')"><PhX :size="20" /></button>
        </header>
        <div class="drawer__body">
          <slot />
        </div>
      </aside>
    </div>
  </Transition>
</template>

<style scoped>
.drawer {
  position: fixed;
  inset: 0;
  z-index: 50;
}

.drawer__scrim {
  position: absolute;
  inset: 0;
  background: var(--scrim);
}

.drawer__panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  width: min(580px, 100%);
  background: var(--bg);
  border-left: 1px solid var(--border);
  box-shadow: var(--shadow-drawer);
}

.drawer__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.drawer__title {
  font-size: 16px;
  font-weight: 650;
}

.drawer__desc {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--text-muted);
}

.drawer__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 20px 28px;
}

.drawer-enter-active,
.drawer-leave-active {
  transition: opacity 0.2s ease;
}

.drawer-enter-active .drawer__panel,
.drawer-leave-active .drawer__panel {
  transition: transform 0.22s cubic-bezier(0.2, 0.7, 0.2, 1);
}

.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}

.drawer-enter-from .drawer__panel,
.drawer-leave-to .drawer__panel {
  transform: translateX(32px);
}
</style>
