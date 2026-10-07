<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
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

/** 页面导航使用本地状态：不写入 URL 或存储，刷新后回到概览。 */
const page = ref<PageId>(DEFAULT_PAGE)
const diagnosticsOpen = ref(false)
/** 概览未读入口的目标会话，仅在本次聊天页导航中使用。 */
const pendingChatSessionId = ref<string | null>(null)
const mainRef = ref<HTMLElement | null>(null)
/** 跨页面传递的待发布草稿（从 ProductsPage 传递到 PublishPage） */
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
      text: '未连接扩展，请从 Chrome/Edge 扩展中打开工作台。',
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

async function go(next: PageId, sessionId?: string): Promise<void> {
  pendingChatSessionId.value = next === 'chat' ? sessionId ?? null : null
  if (next === page.value) return
  page.value = next
  window.scrollTo({ top: 0 })
  // 将焦点切换到主内容区，保障键盘与读屏辅助感知
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

    <!-- 顶部轻量导航：1200 内容宽居中，收拢全部页面胶囊 Tab 与全局操作 -->
    <AppTopbar
      :current="page"
      :page="currentItem"
      @navigate="go"
      @diagnostics="diagnosticsOpen = true"
      @settings="go('settings')"
    />

    <!-- 工作区主体：统一最大内容宽度 1200px 暖纸画布 -->
    <div class="workspace-wrap">
      <main
        id="main"
        ref="mainRef"
        class="content"
        :class="{ 'content--wide': page === 'chat' || page === 'products' }"
        tabindex="-1"
      >
        <div v-if="envNotice" class="notice" :class="`notice--${envNotice.tone}`" role="status">
          <p class="notice__text">{{ envNotice.text }}</p>
          <button type="button" class="btn btn--sm" @click="diagnosticsOpen = true">查看诊断</button>
        </div>

        <Transition name="page" mode="out-in">
          <OverviewPage v-if="page === 'overview'" @navigate="go" />
          <CollectPage v-else-if="page === 'collect'" @navigate="go" @diagnostics="diagnosticsOpen = true" />
          <ChatCenterPage v-else-if="page === 'chat'" :initial-session-id="pendingChatSessionId" @navigate="go" @diagnostics="diagnosticsOpen = true" />
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

    <!-- 系统状态与开发诊断抽屉 -->
    <DiagnosticsDrawer :open="diagnosticsOpen" @close="diagnosticsOpen = false">
      <BridgeDemo />
    </DiagnosticsDrawer>
  </div>
</template>

<style scoped>
.shell {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-canvas);
}

.skip {
  position: absolute;
  left: 16px;
  top: -48px;
  z-index: 100;
  padding: 6px 14px;
  border-radius: 9999px;
  background: var(--brand-yellow);
  color: #1c1917;
  font-weight: 600;
  text-decoration: none;
  font-size: 12px;
  box-shadow: var(--shadow-card);
}

.skip:focus {
  top: 12px;
}

.workspace-wrap {
  width: 100%;
  max-width: 1200px;
  margin: 0 auto;
  padding: 20px 20px 48px;
  flex: 1;
}

.content {
  display: grid;
  gap: 16px;
  align-content: start;
}

.content:focus {
  outline: none;
}

.content--wide {
  max-width: none;
}

.notice {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 14px;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 12.5px;
  line-height: 1.5;
  background: var(--bg-card);
  border: 1px solid var(--border-line);
}

.notice--warn {
  border-color: var(--brand-yellow-border);
  background: var(--brand-yellow-bg);
  color: var(--brand-yellow-text);
  border-style: dashed;
}

.notice--error {
  border-color: var(--status-danger-border);
  background: var(--status-danger-bg);
  color: var(--status-danger);
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
  .workspace-wrap {
    padding: 14px 12px 36px;
  }
}
</style>
