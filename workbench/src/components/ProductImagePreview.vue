<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { imagePreviewPosition } from '../features/products/image-preview-position'

/** 商品缩略图的悬浮预览；不接管缩略图布局或加载失败占位。 */
const props = defineProps<{ src?: string; alt: string }>()
const position = ref<ReturnType<typeof imagePreviewPosition> | null>(null)
const loaded = ref(false)
const failed = ref(false)

function close(): void {
  position.value = null
  loaded.value = false
  window.removeEventListener('scroll', close, true)
  window.removeEventListener('resize', close)
}

function open(): void {
  if (!props.src || failed.value) return
  position.value = imagePreviewPosition({ width: window.innerWidth, height: window.innerHeight })
  // 滚动或调整窗口后关闭，避免预览残留在已离开视口的旧商品位置。
  window.addEventListener('scroll', close, true)
  window.addEventListener('resize', close)
}

function onError(): void {
  failed.value = true
  close()
}

watch(() => props.src, () => {
  close()
  failed.value = false
})
onBeforeUnmount(close)
</script>

<template>
  <div class="product-image-trigger" @mouseenter="open" @mouseleave="close">
    <slot />
  </div>
  <!-- 脱离表格滚动容器，既不撑高行，也不被 overflow 裁切。 -->
  <Teleport to="body">
    <div
      v-if="position && src"
      class="product-image-preview"
      :style="{
        left: `${position.left}px`, top: `${position.top}px`,
        width: `${position.width}px`, height: `${position.height}px`,
        visibility: loaded ? 'visible' : 'hidden',
      }"
      role="img"
      :aria-label="`${alt}，放大预览`"
    >
      <img :key="src" :src="src" :alt="alt" @load="loaded = true" @error="onError" />
    </div>
  </Teleport>
</template>

<style scoped>
.product-image-trigger { display: flex; width: fit-content; }
.product-image-preview {
  position: fixed;
  z-index: 1000;
  pointer-events: none;
  padding: 6px;
  box-sizing: border-box;
  border: 1px solid var(--border-line, #ede8df);
  border-radius: 8px;
  background: var(--bg-subtle, #faf8f5);
  box-shadow: 0 8px 24px rgb(0 0 0 / 16%);
}
.product-image-preview img { width: 100%; height: 100%; object-fit: contain; display: block; }
</style>
