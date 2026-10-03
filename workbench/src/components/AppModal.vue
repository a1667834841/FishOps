<script setup lang="ts">
import { nextTick, ref, watch, useId } from 'vue'
import { PhX } from '@phosphor-icons/vue'
const props = defineProps<{ open: boolean; title: string; wide?: boolean; busy?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const titleId = useId()
let trigger: HTMLElement | null = null
watch(() => props.open, async (open) => {
  await nextTick()
  if (open && !dialog.value?.open) {
    trigger = document.activeElement as HTMLElement | null
    dialog.value?.showModal()
    dialog.value?.querySelector<HTMLElement>('input:not([disabled]), textarea:not([disabled]), select:not([disabled])')?.focus()
  } else if (!open && dialog.value?.open) {
    dialog.value.close()
    trigger?.focus()
  }
}, { immediate: true })
function close(): void { if (!props.busy) emit('close') }
</script>

<template>
  <dialog ref="dialog" class="modal" :class="{ 'modal--wide': wide }" :aria-labelledby="titleId" @cancel.prevent="close" @click="event => { if (event.target === dialog) close() }">
    <header class="modal__header">
      <h2 :id="titleId">{{ title }}</h2>
      <button type="button" class="btn btn--ghost btn--icon" aria-label="关闭弹窗" title="关闭" :disabled="busy" @click="close"><PhX :size="20" /></button>
    </header>
    <div class="modal__body"><slot /></div>
  </dialog>
</template>

<style scoped>
.modal { width: min(640px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); margin: auto; padding: 0; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--text); box-shadow: 0 24px 80px #0003; }
.modal--wide { width: min(960px, calc(100vw - 32px)); }
.modal::backdrop { background: var(--scrim); }
.modal__header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--border); }
.modal__header h2 { font-size: 16px; font-weight: 600; }
.modal__body { padding: 20px; }
.modal__body :deep(.panel) { border: 0; border-radius: 0; }
.modal__body :deep(.panel__head) { padding: 0 0 12px; }
.modal__body :deep(.panel__body) { padding: 0; }
</style>
