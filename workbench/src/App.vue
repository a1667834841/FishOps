<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import AppSidebar from './components/AppSidebar.vue'
import AppTopbar from './components/AppTopbar.vue'
import DiagnosticsDrawer from './components/DiagnosticsDrawer.vue'
import { useAppBootstrap } from './composables/useAppBootstrap'
import { useBridgeStatus } from './composables/useBridgeStatus'
import { DEFAULT_PAGE, findNavItem, type PageId } from './data/navigation'
import type { PublishDraft } from './features/publish/publish-draft-store'
import { publishDraftStore } from './features/publish/publish-draft-store'
import BridgeDemo from './pages/BridgeDemo.vue'
import OverviewPage from './pages/OverviewPage.vue'
const AnalyticsPage = defineAsyncComponent(() => import('./pages/AnalyticsPage.vue'))
const ChatCenterPage = defineAsyncComponent(() => import('./pages/ChatCenterPage.vue'))
const CollectPage = defineAsyncComponent(() => import('./pages/CollectPage.vue'))
const ProductsPage = defineAsyncComponent(() => import('./pages/ProductsPage.vue'))
const PublishPage = defineAsyncComponent(() => import('./pages/PublishPage.vue'))
const SettingsPage = defineAsyncComponent(() => import('./pages/SettingsPage.vue'))

/** 页面导航只用本地状态：不写入 URL 或存储，刷新后回到概览。 */
const page = ref<PageId>(DEFAULT_PAGE)
const diagnosticsOpen = ref(false)
const mainRef = ref<HTMLElement | null>(null)
/** 跨页面传递的待发布草稿（从 ProductsPage 飞书 Tab 或自营 Tab 传递到 PublishPage） */
const pendingDraft = ref<PublishDraft | null>(null)

const currentItem = computed(() => findNavItem(page.value))
const { status, inExtension } = useBridgeStatus()
// 应用级启动时自动准备聊天运行时并同步会话
useAppBootstrap()

/** 非扩展环境或 Bridge 异常时，在内容区顶部给出明确提示。 */
const envNotice = computed<{ tone: 'warn' | 'error'; text: string } | null>(() => {
  if (!inExtension) {
    return {
      tone: 'warn',
      text: '未连接扩展，请从浏览器扩展打开工作台。',
    }
  }
  if (status.value.state === 'error') {
    return { tone: 'error', text: `连接失败：${status.value.message ?? '与扩展或闲鱼运行时连接异常'}` }
  }
  if (status.value.state === 'unauthorized') {
    return { tone: 'warn', text: status.value.message ?? '闲鱼账号未登录，请先在闲鱼网页版登录后重试。' }
  }
  if (status.value.state === 'captcha') {
    return { tone: 'warn', text: status.value.message ?? '闲鱼安全验证拦截，请在闲鱼网页版完成滑块/验证码验证。' }
  }
  return null
})

watch(
  currentItem,
  (item) => {
    document.title = `${item.title} · FishOps Workbench`
  },
  { immediate: true },
)

async function go(next: PageId): Promise<void> {
  if (next === page.value) return
  page.value = next
  window.scrollTo({ top: 0 })
  // 把键盘焦点移到内容区，便于读屏与键盘用户感知页面已切换。
  await nextTick()
  mainRef.value?.focus({ preventScroll: true })
}

/** 接收选品并导航到发布中心（绝不自动调用任务创建/填表/发布提交） */
function handlePublishItem(draft: PublishDraft): void {
  pendingDraft.value = draft
  publishDraftStore.setDraft(draft)
  void go('publish')
}

function handleClearDraft(): void {
  pendingDraft.value = null
  publishDraftStore.clearDraft()
}
</script>

<template>
  <div class="shell">
    <a class="skip" href="#main" @click.prevent="mainRef?.focus()">跳到主内容</a>
    <AppSidebar :current="page" @navigate="go" />

    <div class="workspace">
      <AppTopbar :page="currentItem" @diagnostics="diagnosticsOpen = true" @settings="go('settings')" />

      <main id="main" ref="mainRef" class="content" :class="{ 'content--wide': page === 'chat' || page === 'products' }" tabindex="-1">
        <div v-if="envNotice" class="notice" :class="`notice--${envNotice.tone}`" role="status">
          <p class="notice__text">{{ envNotice.text }}</p>
          <button type="button" class="btn btn--sm" @click="diagnosticsOpen = true">查看诊断</button>
        </div>

        <Transition name="page" mode="out-in">
          <OverviewPage v-if="page === 'overview'" @navigate="go" />
          <CollectPage v-else-if="page === 'collect'" @navigate="go" @diagnostics="diagnosticsOpen = true" />
          <ChatCenterPage v-else-if="page === 'chat'" @navigate="go" @diagnostics="diagnosticsOpen = true" />
          <ProductsPage v-else-if="page === 'products'" @navigate="go" @publish-item="handlePublishItem" />
          <PublishPage
            v-else-if="page === 'publish'"
            :draft="pendingDraft"
            @navigate="go"
            @clear-draft="handleClearDraft"
          />
          <AnalyticsPage v-else-if="page === 'analytics'" @navigate="go" />
          <SettingsPage v-else @diagnostics="diagnosticsOpen = true" />
        </Transition>
      </main>
    </div>

    <DiagnosticsDrawer :open="diagnosticsOpen" @close="diagnosticsOpen = false">
      <BridgeDemo />
    </DiagnosticsDrawer>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  align-items: start;
  min-height: 100dvh;
}

.skip {
  position: absolute;
  left: 16px;
  top: -48px;
  z-index: 100;
  padding: 8px 14px;
  border-radius: var(--radius-control);
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
  text-decoration: none;
}

.skip:focus {
  top: 12px;
}

.workspace {
  min-width: 0;
  padding: 20px 24px 32px;
}

.content {
  max-width: 1440px;
  margin-inline: auto;
  display: grid;
  gap: 16px;
  align-content: start;
}

.content:focus {
  outline: none;
}
.content--wide { max-width: none; }

.notice {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 14px;
  padding: 10px 14px;
  border-radius: var(--radius-control);
  font-size: 13px;
}

.notice--warn {
  background: var(--warn-soft);
  color: var(--warn);
}

.notice--error {
  background: var(--error-soft);
  color: var(--error);
}

.notice__text {
  flex: 1 1 320px;
  overflow-wrap: anywhere;
}

.page-enter-active,
.page-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.page-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.page-leave-to {
  opacity: 0;
}

@media (max-width: 899px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
  }

  .workspace {
    padding: 16px 12px 40px;
  }
}
</style>
