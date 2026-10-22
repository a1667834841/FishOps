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

  // 焦点陷阱：Tab 在抽屉内首尾循环。
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
          <div class="drawer__title-wrap">
            <h2 id="diagnostics-title" class="drawer__title">系统状态与开发诊断</h2>
            <p class="drawer__desc">验证 Workbench 与扩展 background 之间的 Bridge 链路</p>
          </div>
          <button
            ref="closeRef"
            type="button"
            class="btn btn-icon-only btn--ghost"
            aria-label="关闭诊断"
            title="关闭"
            @click="emit('close')"
          >
            <PhX :size="18" aria-hidden="true" />
          </button>
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
  z-index: 60;
}

.drawer__scrim {
  position: absolute;
  inset: 0;
  background: var(--scrim);
  backdrop-filter: blur(2px);
}

.drawer__panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  width: min(580px, 100%);
  background: var(--bg-canvas);
  border-left: 1px solid var(--border-line);
  box-shadow: var(--shadow-drawer);
}

.drawer__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-line);
  background: var(--bg-card);
}

.drawer__title-wrap {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.drawer__title {
  font-size: 14.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--text-main);
}

.drawer__desc {
  font-size: 11.5px;
  color: var(--text-muted);
}

.drawer__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 18px 28px;
}

.drawer-enter-active,
.drawer-leave-active {
  transition: opacity 0.2s ease;
}

.drawer-enter-active .drawer__panel,
.drawer-leave-active .drawer__panel {
  transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}

.drawer-enter-from .drawer__panel,
.drawer-leave-to .drawer__panel {
  transform: translateX(36px);
}
</style>
