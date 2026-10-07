<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhArrowsClockwise, PhArrowSquareOut, PhStorefront, PhWrench } from '@phosphor-icons/vue'
import ReplyComposer from '../components/chat/ReplyComposer.vue'
import EmptyState from '../components/EmptyState.vue'
import PanelCard from '../components/PanelCard.vue'
import StatusTag from '../components/StatusTag.vue'
import { getAppBootstrapController } from '../composables/useAppBootstrap'
import { useBridgeController } from '../composables/useBridgeController'
import { useChatCenter } from '../composables/useChatCenter'
import type { PageId } from '../data/navigation'
import type { ChatMessage, Conversation } from '../features/chat/types'
import type { SyncState } from '../features/chat/chat-center-controller'
import {
  deriveItemContext,
  derivePeer,
  formatFullTime,
  formatShortTime,
  isoTime,
  messageAvatarUrl,
  messageDisplayText,
  messageKindLabel,
  peerAvatarUrl,
  safeHttpsUrl,
  socketStatusView,
} from '../features/chat/chat-format'
import { REPLY_EVENTS, ReplyController, type ReplyState } from '../features/reply/reply-controller'

const props = defineProps<{ initialSessionId?: string | null }>()

const emit = defineEmits<{ navigate: [page: PageId]; diagnostics: [] }>()

const { state, controller } = useChatCenter()
// 导航明确指定会话时复用正常选择流程；读取成功后才请求平台已读确认。
watch(() => props.initialSessionId, id => { if (id) controller.selectSession(id) }, { immediate: true })
const appBootstrap = getAppBootstrapController()
const bootstrapState = ref(appBootstrap.getState())
let unsubscribeBootstrapState = (): void => {}
let unsubscribeSync = (): void => {}

const available = computed(() => state.value.availability === 'ready')
const markReadError = computed(() => state.value.markReadError)

const conversations = computed(() => state.value.conversations)
const selectedId = computed(() => state.value.selectedId)
const selectedConversation = computed(
  () => conversations.value.items.find((item) => item.sessionId === selectedId.value) ?? null,
)

// Socket 状态展示：标题旁紧凑小点，不单占一行，不使用脉冲动画。
const socketView = computed(() => socketStatusView(state.value.socketStatus))

// 准备阶段可能先于聊天 socket 建立而失败；收到后续 open 事件时自动补一次准备与会话同步。
watch(
  () => state.value.socketStatus,
  (status, previous) => {
    const phase = bootstrapState.value.phase
    if (status === 'open' && previous !== 'open' && phase !== 'ready' && phase !== 'preparing' && phase !== 'syncing') {
      void appBootstrap.bootstrap(true)
    }
  },
)

/** 只展示属于当前选中会话的消息，防止切换瞬间出现上一个会话的内容。 */
const threadMessages = computed(() => {
  const messages = state.value.messages
  return messages.sessionId === selectedId.value ? messages.items : []
})

const itemContext = computed(() => deriveItemContext(selectedConversation.value, threadMessages.value))
const peer = computed(() => {
  const context = derivePeer(selectedConversation.value, threadMessages.value)
  const conversation = selectedConversation.value
  return conversation ? { ...context, name: displayName(conversation.sessionId, conversation.peerUserName) } : context
})
/** 消息窗口尾部 id：变化表示追加了新消息（实时消息 / 发送回显 / 刷新替换）。 */
const tailId = computed(() => {
  const items = threadMessages.value
  const last = items.length > 0 ? items[items.length - 1] : undefined
  return last ? last.id : ''
})
/** 消息窗口头部 id：变化表示前插了更早消息。 */
const headId = computed(() => {
  const items = threadMessages.value
  const first = items.length > 0 ? items[0] : undefined
  return first ? first.id : ''
})
/** 买家栏与列表使用同一会话身份；尚无会话实体时才回退消息头像。 */
const peerAvatar = computed(() => selectedConversation.value
  ? safeHttpsUrl(selectedConversation.value.peerAvatarUrl)
  : peerAvatarUrl(null, threadMessages.value))

/**
 * P6 回复层（规则 / 建议 / 发送）使用独立控制器与独立 Bridge。
 * 发送最长可能等待 10 秒（LWP）再加扩展处理，因此单次命令等待放宽到 30 秒。
 */
const { state: replyState, controller: replyController } = useBridgeController<ReplyState, ReplyController>({
  events: REPLY_EVENTS,
  timeoutMs: 30000,
  create: (api) => new ReplyController({ api }),
})

/**
 * 记录加载失败的头像 URL（以 URL 为键，避免一个会话/消息失败波及其他头像）。
 * 远程图片可能 404 或被拦截，失败后回退到字母头像，避免展示破损图标。
 */
const failedAvatars = ref<Record<string, boolean>>({})
function markAvatarFailed(url: string | null): void {
  if (!url) return
  failedAvatars.value = { ...failedAvatars.value, [url]: true }
}

/** 会话头像：真实 URL 且该 URL 未加载失败时返回 URL，否则返回 null 走字母 fallback。 */
function conversationAvatar(item: Conversation): string | null {
  const url = safeHttpsUrl(item.peerAvatarUrl)
  if (!url || failedAvatars.value[url]) return null
  return url
}

/** 封面独立记录失败状态，不能回退成买家头像或聊天图片。 */
const failedCovers = ref<Record<string, boolean>>({})
function conversationCover(item: Conversation): string | null {
  const url = item.itemId ? safeHttpsUrl(item.itemCoverUrl) : null
  return url && !failedCovers.value[url] ? url : null
}
function markCoverFailed(url: string | null): void {
  if (url) failedCovers.value = { ...failedCovers.value, [url]: true }
}

/**
 * 消息头像：仅对方消息展示。优先消息自身 senderAvatarUrl，
 * 缺失时回退当前会话可信头像（会话字段优先），避免消息无头像时不显示。
 */
function bubbleAvatar(message: ChatMessage): string | null {
  const url = messageAvatarUrl(message) ?? peerAvatar.value
  if (!url || failedAvatars.value[url]) return null
  return url
}

/** 买家栏头像：当前会话头像且未加载失败时展示，否则走字母 fallback。 */
const contextbarAvatar = computed(() => {
  const url = peerAvatar.value
  if (!url || failedAvatars.value[url]) return null
  return url
})

// 选择会话时把回复层绑定到该会话：旧会话的建议与发送结果作废。
watch(selectedId, (id) => replyController.setSession(id), { immediate: true })

// 发送成功后只刷新本地缓存，不向平台发起额外请求。
watch(
  () => replyState.value.send.sentAt,
  (sentAt) => {
    if (sentAt !== null) void controller.refresh()
  },
)

// 自动同步完成后会话页读取最新本地缓存；若应用启动时同步失败，打开会话页时重试。
onMounted(() => {
  unsubscribeBootstrapState = appBootstrap.subscribe(() => {
    bootstrapState.value = appBootstrap.getState()
  })
  unsubscribeSync = appBootstrap.onSyncCompleted(() => {
    void controller.refresh()
  })
  if (appBootstrap.getState().phase !== 'ready') void appBootstrap.bootstrap(true)
})

onBeforeUnmount(() => {
  unsubscribeSync()
  unsubscribeBootstrapState()
})

/** 历史同步结果只在其所属会话下展示，切换会话后不串号。 */
const historySync = computed<SyncState | null>(() => {
  const sync = state.value.historySync
  return sync.phase !== 'idle' && sync.sessionId === selectedId.value ? sync : null
})
const historyBusyElsewhere = computed(
  () => state.value.historySync.phase === 'running' && state.value.historySync.sessionId !== selectedId.value,
)

function syncSummary(sync: SyncState, label: string): string {
  if (sync.phase === 'running') return `正在同步${label}…`
  if (sync.phase === 'failed') return `${label}同步失败：${sync.error ?? '未知错误'}`
  const time = sync.finishedAt ? `（${formatShortTime(sync.finishedAt)}）` : ''
  if (sync.added === 0 && sync.updated === 0) return `${label}同步完成，没有新增或更新${time}`
  return `${label}同步完成：新增 ${sync.added}，更新 ${sync.updated}${time}`
}

function displayName(sessionId: string, name: string): string {
  return name.trim() || `会话 ${sessionId}`
}

function unreadLabel(count: number): string {
  return count > 99 ? '99+' : String(count)
}

// 切换会话滚到底部；同会话内新消息到达时，仅当用户本来就在底部附近才跟随，避免打断翻阅历史。
// 距离顶部多少像素内视为「接近顶部」，会触发自动加载更早的一页。
const TOP_THRESHOLD = 48

const threadRef = ref<HTMLElement | null>(null)
let stickToBottom = true

// 滚动锚点：记录当前第一条可见消息及其视口位置。前插（或历史中段补洞）后用它将同一
// 条消息钉回原位置，避免可见内容跳动；用户滚到底部时则不做补偿，直接跟随最新消息。
interface ScrollAnchor {
  id: string
  viewportTop: number
}

let lastAnchor: ScrollAnchor | null = null

// 用户滚动意图：只有 wheel / touch / 键盘 / 指针（含滚动条拖动）手势引起的滚动才允许自动翻页。
// 程序化 scrollTop（吸底 / 锚点补偿）不置位，避免「加载 → 渲染滚动 → 再次加载」的循环。
// 一次手势序列最多消费一次：惯性滚动会连续产生 wheel / scroll 事件，若不限制，
// 同一次手势会在前插内容与锚点补偿之间反复抵达顶部，把历史连续拉完。
const SCROLL_INTENT_TTL = 1200
const SCROLL_GESTURE_GAP = 200
let scrollIntentPending = false
let scrollIntentUntil = 0
let scrollIntentConsumed = false
let lastGestureAt = 0
let touchStartY: number | null = null

/** 记录用户手势意图；同一手势序列内已消费过则不再置位。 */
function markScrollIntent(): void {
  const now = Date.now()
  if (now - lastGestureAt > SCROLL_GESTURE_GAP) scrollIntentConsumed = false
  lastGestureAt = now
  if (scrollIntentConsumed) return
  scrollIntentPending = true
  scrollIntentUntil = now + SCROLL_INTENT_TTL
}

function hasScrollIntent(): boolean {
  return scrollIntentPending && Date.now() < scrollIntentUntil
}

/** 消费一次意图；返回 false 表示当前没有可用的用户意图，不得自动翻页。 */
function consumeScrollIntent(): boolean {
  if (!hasScrollIntent()) {
    clearScrollIntent()
    return false
  }
  scrollIntentPending = false
  scrollIntentUntil = 0
  scrollIntentConsumed = true
  return true
}

// 只清待消费意图，保留手势序列记忆（consumed / lastGestureAt），
// 否则紧随程序化滚动的惯性事件会被误判为新手势。
function clearScrollIntent(): void {
  scrollIntentPending = false
  scrollIntentUntil = 0
}

/** 记录第一条至少部分可见的消息，作为后续渲染后的位置基准。 */
function captureAnchor(el: HTMLElement): void {
  const containerTop = el.getBoundingClientRect().top
  for (const child of Array.from(el.children) as HTMLElement[]) {
    const id = child.dataset['mid']
    if (!id) continue
    if (child.getBoundingClientRect().bottom > containerTop + 1) {
      lastAnchor = { id, viewportTop: child.getBoundingClientRect().top }
      return
    }
  }
  lastAnchor = null
}

function onThreadScroll(): void {
  const el = threadRef.value
  if (!el) return
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  captureAnchor(el)
  // 只有用户手势引起的滚动才在抵达顶部时自动翻页：程序化 layout 滚动（吸底 / 锚点补偿）
  // 不带意图标记，因此首屏渲染不会把历史自动拉到底，也不会造成加载循环。
  // 覆盖滚动条拖动与「一次大幅 wheel 跨过阈值后停在顶部」两种无 wheel/touch 事件的场景。
  if (hasScrollIntent() && el.scrollTop <= TOP_THRESHOLD && consumeScrollIntent()) {
    requestOlder()
  }
}

/** 真实滚轮向上：记录意图；已在顶部时直接请求，保证一次大幅滚动跨过阈值仍能触发。 */
function onWheelScroll(event: WheelEvent): void {
  const el = threadRef.value
  if (!el || !(event.deltaY < 0)) return
  markScrollIntent()
  // 内容不满一屏时没有可滚动距离、不产生 scroll 事件，这里在顶部直接触发。
  if (el.scrollTop <= TOP_THRESHOLD && consumeScrollIntent()) requestOlder()
}

/** 真实键盘向上（ArrowUp / PageUp）：同样只由用户手势触发分页。 */
function onThreadKeydown(event: KeyboardEvent): void {
  if (event.key !== 'ArrowUp' && event.key !== 'PageUp') return
  const el = threadRef.value
  if (!el) return
  markScrollIntent()
  if (el.scrollTop <= TOP_THRESHOLD && consumeScrollIntent()) requestOlder()
}

/** 触摸开始：记录起点，用于确认后续确实发生了垂直拖动。 */
function onThreadTouchStart(event: TouchEvent): void {
  const touch = event.touches[0]
  touchStartY = touch ? touch.clientY : null
  markScrollIntent()
}

/** 触摸滚动：发生垂直拖动时记录意图；已在顶部时直接触发，保证短首屏仍能翻页。 */
function onThreadTouchMove(event: TouchEvent): void {
  const el = threadRef.value
  const touch = event.touches[0]
  if (!el || !touch || touchStartY === null || touch.clientY === touchStartY) return
  markScrollIntent()
  if (el.scrollTop <= TOP_THRESHOLD && consumeScrollIntent()) requestOlder()
}

/** 指针按下（包含滚动条拖动）：记录意图，交给随后的 scroll 事件在顶部消费。 */
function onThreadPointerDown(): void {
  markScrollIntent()
}

/**
 * 请求加载更早的一页；加载中或已耗尽时短路。
 *
 * 失败后不允许由滚动事件自动重试：分页 banner 的“加载中”与“失败”两态高度不同，
 * 切换时会反复改变滚动容器高度并触发 scroll 事件，自动重试会造成无限请求。
 * 因此失败后只能点击 banner 上的「重试」手动恢复。
 */
function requestOlder(options: { manual?: boolean } = {}): void {
  const el = threadRef.value
  const messages = state.value.messages
  if (!el || messages.olderPhase === 'loading' || !messages.hasMore) return
  if (messages.olderPhase === 'error' && !options.manual) return
  captureAnchor(el)
  void controller.loadOlder()
}

watch(
  () => [state.value.messages.sessionId, tailId.value, headId.value] as const,
  async (
    [sessionId, nextTailId, nextHeadId],
    [previousSessionId, previousTailId, previousHeadId],
  ) => {
    const switched = sessionId !== previousSessionId
    if (switched) {
      stickToBottom = true
      lastAnchor = null
      // 切换会话时重置手势意图状态，避免把上一个会话的滚动当成当前会话的翻页信号。
      touchStartY = null
      scrollIntentConsumed = false
      lastGestureAt = 0
      clearScrollIntent()
    }
    // 尾部变化 = 追加新消息（实时消息 / 自身发送回显）。并发追加时始终优先滚底，
    // 避免两个事件在同一 tick 合并后 lose 掉跟随最新消息的机会。
    const appended = !switched && nextTailId !== previousTailId
    // 头部变化 = 前插更早消息：只有用户不在底部时才按锚点补偿，保持可见内容不动。
    const prepended = !switched && !appended && nextHeadId !== previousHeadId
    await nextTick()
    const el = threadRef.value
    if (!el) return
    if (appended || stickToBottom) {
      // 程序化吸底前清除意图，避免随后触发的 scroll 事件误当成用户手势。
      clearScrollIntent()
      el.scrollTop = el.scrollHeight
      return
    }
    // 用户不在底部时，用锚点补偿前插造成的位移，保持可见内容不动。
    if (prepended && lastAnchor) {
      const target = (Array.from(el.children) as HTMLElement[]).find(
        (child) => child.dataset['mid'] === lastAnchor?.id,
      )
      if (target) {
        clearScrollIntent()
        el.scrollTop += target.getBoundingClientRect().top - lastAnchor.viewportTop
        return
      }
      lastAnchor = null
    }
  },
)
</script>

<template>
  <div class="page">
    <PanelCard v-if="!available" flush>
      <EmptyState
        mark="!"
        title="需要在扩展中打开工作台"
        description="聊天数据来自浏览器扩展的本地缓存，当前页面不是扩展内页，无法读取。请通过 chrome-extension://<扩展 ID>/workbench.html 打开；这里不会展示任何演示数据。"
      >
        <button type="button" class="btn btn--sm" @click="emit('diagnostics')">查看系统状态</button>
        <button type="button" class="btn btn--sm" @click="emit('navigate', 'overview')">回到概览</button>
      </EmptyState>
    </PanelCard>

    <div v-else class="chat">
      <!-- 会话列表 -->
      <PanelCard title="会话" flush class="chat__col">
        <template #actions>
          <span
            id="socket-status-dot"
            class="status-dot-compact"
            :class="`status-dot-compact--${socketView.tone}`"
            :title="`Socket ${socketView.label}`"
            :aria-label="`Socket ${socketView.label}`"
            role="status"
          ></span>
          <StatusTag v-if="conversations.phase === 'ready'" mono>{{ conversations.items.length }}</StatusTag>
          <button
            id="chat-refresh-conv-btn"
            type="button"
            class="btn btn--icon"
            title="同步最近平台记录"
            aria-label="同步最近平台记录"
            :disabled="state.recentSyncing || conversations.phase === 'loading' || conversations.refreshing"
            @click="controller.syncRecent()"
          >
            <PhArrowsClockwise :size="16" />
          </button>
          <button type="button" class="btn btn--icon" title="系统状态" aria-label="查看系统状态" @click="emit('diagnostics')">
            <PhWrench :size="16" />
          </button>
        </template>

        <p v-if="markReadError" class="col-note col-note--error" role="alert">
          标记会话已读失败：{{ markReadError }}（未清除未读数）
        </p>
        <p v-if="state.recentSyncError" class="col-note col-note--error" role="alert">
          最近平台记录同步失败：{{ state.recentSyncError }}（已保留旧数据）
        </p>
        <p v-if="bootstrapState.phase === 'error'" class="col-note col-note--error" role="alert">
          会话同步失败：{{ bootstrapState.error ?? '未知错误' }}
          <button
            type="button"
            class="btn btn--sm"
            @click="appBootstrap.bootstrap(true)"
          >
            重试同步
          </button>
        </p>

        <div v-if="conversations.phase === 'idle' || conversations.phase === 'loading'" class="state" role="status">
          <div class="list" aria-hidden="true">
            <div v-for="n in 4" :key="n" class="list__row">
              <span class="skel skel--avatar"></span>
              <span class="list__lines">
                <span class="skel skel--line"></span>
                <span class="skel skel--line skel--short"></span>
              </span>
            </div>
          </div>
          <p class="col-note">正在读取本地会话缓存…</p>
        </div>

        <div v-else-if="conversations.phase === 'error'" class="state">
          <p class="col-note col-note--error" role="alert">读取会话列表失败：{{ conversations.error }}</p>
          <div class="col-actions">
            <button type="button" class="btn btn--sm" @click="controller.refresh()">重试</button>
            <button type="button" class="btn btn--sm" @click="emit('diagnostics')">查看系统状态</button>
          </div>
        </div>

        <div v-else-if="conversations.items.length === 0" class="state">
          <EmptyState
            title="本地还没有会话"
            :description="bootstrapState.phase === 'error' ? '平台会话同步未完成。检查闲鱼聊天页面连接后，可重试同步。' : '扩展本地缓存里暂无会话。启动时会自动同步；收到新消息时这里也会自动出现。'"
          />
        </div>

        <template v-else>
          <p v-if="conversations.error" class="col-note col-note--error" role="alert">
            最近一次刷新失败（已保留旧数据）：{{ conversations.error }}
          </p>
          <ul class="convs" aria-label="会话列表">
            <li v-for="item in conversations.items" :key="item.sessionId">
              <button
                type="button"
                class="conv"
                :class="{ 'conv--active': item.sessionId === selectedId }"
                :aria-current="item.sessionId === selectedId ? 'true' : undefined"
                @click="controller.selectSession(item.sessionId)"
              >
                <span class="conv__identity">
                  <span class="conv__avatar" aria-hidden="true">
                    <img
                      v-if="conversationAvatar(item)"
                      :src="conversationAvatar(item) ?? undefined"
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerpolicy="no-referrer"
                      @error="markAvatarFailed(conversationAvatar(item))"
                    />
                    <template v-else>{{ displayName(item.sessionId, item.peerUserName).slice(0, 1) }}</template>
                  </span>
                  <span v-if="item.unreadCount > 0" class="conv__unread">
                    <span aria-hidden="true">{{ unreadLabel(item.unreadCount) }}</span>
                    <span class="sr-only">{{ item.unreadCount }} 条未读</span>
                  </span>
                </span>
                <span class="conv__body">
                  <span class="conv__top">
                    <span class="conv__name">{{ displayName(item.sessionId, item.peerUserName) }}</span>
                  </span>
                  <span class="conv__bottom">
                    <span class="conv__last">{{ item.lastMessage || '（暂无消息摘要）' }}</span>
                  </span>
                  <time v-if="item.lastMessageTime > 0" class="conv__time" :datetime="isoTime(item.lastMessageTime)">
                    {{ formatShortTime(item.lastMessageTime) }}
                  </time>
                </span>
                <span v-if="item.itemId" class="conv__cover">
                  <img v-if="conversationCover(item)" :src="conversationCover(item) ?? undefined"
                    alt="关联商品封面" loading="lazy" decoding="async" referrerpolicy="no-referrer"
                    @error="markCoverFailed(conversationCover(item))" />
                  <span v-else class="conv__cover-placeholder">暂无封面</span>
                </span>
              </button>
            </li>
          </ul>
        </template>
      </PanelCard>

      <!-- 消息记录 -->
      <PanelCard title="消息" flush class="chat__col chat__col--main">
        <template v-if="selectedId" #actions>
          <button
            id="chat-sync-history-btn"
            type="button"
            class="btn btn--sm"
            :disabled="state.historySync.phase === 'running'"
            :title="historyBusyElsewhere ? '正在同步其他会话的历史，请稍候' : undefined"
            @click="controller.syncHistory()"
          >
            {{ historySync?.phase === 'running' ? '同步历史中…' : '同步历史' }}
          </button>
        </template>

        <div class="thread">
          <!-- 买家 / 商品紧凑摘要：对齐 Seline contextbar -->
          <div v-if="selectedId" id="chat-contextbar" class="contextbar" role="group" aria-label="买家与商品信息">
            <div class="contextbar__peer">
              <span id="contextbar-avatar" class="contextbar__avatar" aria-hidden="true">
                <img
                  v-if="contextbarAvatar"
                  :src="contextbarAvatar ?? undefined"
                  alt=""
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  @error="markAvatarFailed(contextbarAvatar)"
                />
                <template v-else>{{ (peer.name || '对').slice(0, 1) }}</template>
              </span>
              <div class="contextbar__peer-text">
                <span id="chat-peer-name" class="contextbar__name">{{ peer.name ?? '未知买家' }}</span>
                <span id="chat-peer-meta" class="contextbar__sub">
                  <span v-if="peer.userId" class="mono">ID {{ peer.userId }}</span>
                  <span v-if="selectedConversation" class="mono">未读 {{ selectedConversation.unreadCount }}</span>
                </span>
              </div>
            </div>
            <div id="contextbar-item" class="contextbar__item">
              <span class="contextbar__item-tag"><PhStorefront :size="13" aria-hidden="true" />关联商品</span>
              <template v-if="itemContext">
                <span id="contextbar-item-title" class="contextbar__item-title" :title="itemContext.itemTitle ?? itemContext.itemId">
                  {{ itemContext.itemTitle || itemContext.itemId }}
                </span>
                <a
                  v-if="itemContext.url"
                  id="contextbar-item-link"
                  class="contextbar__link"
                  :href="itemContext.url"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <PhArrowSquareOut :size="13" aria-hidden="true" />在闲鱼打开 ↗
                </a>
                <span v-else class="contextbar__muted">商品 ID 格式无法识别</span>
              </template>
              <span v-else class="contextbar__muted">暂无关联商品</span>
            </div>
          </div>

          <p
            v-if="historySync"
            class="sync sync--inline"
            :class="{ 'sync--failed': historySync.phase === 'failed', 'sync--ok': historySync.phase === 'ok' }"
            :role="historySync.phase === 'failed' ? 'alert' : 'status'"
          >
            {{ syncSummary(historySync, '历史') }}
          </p>
          <p v-else-if="historyBusyElsewhere" class="sync sync--inline" role="status">正在同步其他会话的历史…</p>

          <div v-if="!selectedId" class="thread__empty">
            <p class="thread__title">未选择会话</p>
            <p class="thread__text">在左侧选择一个会话后，扩展本地缓存的消息会显示在这里。</p>
          </div>

          <div v-else-if="state.messages.phase === 'loading' || state.messages.phase === 'idle'" class="thread__empty" role="status">
            <p class="thread__title">正在读取消息…</p>
          </div>

          <div v-else-if="state.messages.phase === 'error'" class="thread__empty">
            <p class="thread__title">读取消息失败</p>
            <p class="thread__text thread__text--error" role="alert">{{ state.messages.error }}</p>
            <button type="button" class="btn btn--sm" @click="controller.retryMessages()">重试</button>
          </div>

          <div v-else-if="threadMessages.length === 0" class="thread__empty">
            <p class="thread__title">本地没有这个会话的消息</p>
            <p class="thread__text">可点击右上角「同步历史」从平台只读拉取，新消息到达时也会自动出现。</p>
          </div>

          <template v-else>
            <p v-if="state.messages.error" class="col-note col-note--error" role="alert">
              最近一次刷新失败（已保留旧数据）：{{ state.messages.error }}
            </p>
            <div class="thread__banner">
              <p v-if="state.messages.olderPhase === 'loading'" class="thread__banner-text" role="status">
                正在加载更早的消息…
              </p>
              <p
                v-else-if="state.messages.olderPhase === 'error'"
                class="thread__banner-text thread__banner-text--error"
                role="alert"
              >
                加载更早的消息失败：{{ state.messages.olderError }}
                <button type="button" class="btn btn--sm" @click="requestOlder({ manual: true })">重试</button>
              </p>
              <p v-else-if="!state.messages.hasMore" class="thread__banner-text" role="status">
                没有更多了
              </p>
            </div>
            <ol
              id="message-stream"
              ref="threadRef"
              class="msgs"
              aria-label="消息记录"
              tabindex="0"
              @scroll.passive="onThreadScroll"
              @wheel.passive="onWheelScroll"
              @keydown="onThreadKeydown"
              @touchstart.passive="onThreadTouchStart"
              @touchmove.passive="onThreadTouchMove"
              @pointerdown="onThreadPointerDown"
            >
              <li
                v-for="message in threadMessages"
                :key="message.id"
                :data-mid="message.id"
                class="msg"
                :class="message.direction === 'out' ? 'msg--out' : 'msg--in'"
              >
                <span v-if="message.direction !== 'out'" class="msg__avatar" aria-hidden="true">
                  <img
                    v-if="bubbleAvatar(message)"
                    :src="bubbleAvatar(message) ?? undefined"
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerpolicy="no-referrer"
                    @error="markAvatarFailed(bubbleAvatar(message))"
                  />
                  <template v-else>{{ (message.senderName || '对').slice(0, 1) }}</template>
                </span>
                <div class="msg__content">
                  <div class="msg__meta">
                    <span class="msg__who">{{ message.direction === 'out' ? '我' : message.senderName || '对方' }}</span>
                    <time v-if="message.createAt > 0" :datetime="isoTime(message.createAt)" :title="formatFullTime(message.createAt)">
                      {{ formatShortTime(message.createAt) }}
                    </time>
                    <StatusTag v-if="message.kind !== 'text'">{{ messageKindLabel(message.kind) }}</StatusTag>
                  </div>
                  <p class="msg__bubble">{{ messageDisplayText(message) }}</p>
                  <a
                    v-if="message.kind === 'image' && safeHttpsUrl(message.imageUrl)"
                    class="msg__link"
                    :href="safeHttpsUrl(message.imageUrl) ?? undefined"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    在新标签页查看图片 ↗
                  </a>
                </div>
              </li>
            </ol>
          </template>

          <ReplyComposer
            :reply="replyState"
            :controller="replyController"
            :session-id="selectedId"
            :receiver-id="peer.userId"
            :item-id="itemContext?.itemId ?? null"
          />
        </div>
      </PanelCard>
    </div>
  </div>
</template>

<style scoped>
/* Seline 紧凑状态小点：语义化色调，无脉冲，标题旁水平对齐 */
.status-dot-compact {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
  background: var(--status-success, #10B981);
}

.status-dot-compact--ok {
  background: var(--status-success, #10B981);
}

.status-dot-compact--warn {
  background: var(--brand-yellow, #EAB308);
}

.status-dot-compact--error {
  background: var(--status-danger, #EF4444);
}

.status-dot-compact--neutral {
  background: var(--text-faint, #A8A29E);
}

.sync {
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.sync--ok {
  color: var(--ok, #15803D);
}

.sync--failed {
  color: var(--error, #DC2626);
}

.sync--inline {
  padding: 8px 14px;
  background: var(--bg-subtle, #F5F2EB);
  border-bottom: 1px solid var(--border-line, #EFECE6);
}

.chat {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px;
  align-items: stretch;
  min-height: 480px;
  /* 聊天中心移除标签栏后，减去该栏及其间距占位 180px，把完整高度给会话与消息流 */
  height: max(480px, calc(100dvh - 180px));
}

.chat__col {
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-card, #FFFFFF);
  border: 1px solid var(--border-line, #EFECE6);
}

.chat__col :deep(.panel__body) {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 0;
}

.state {
  min-width: 0;
}

.list {
  display: grid;
  padding: 0 14px;
}

.list__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
}

.list__row + .list__row {
  border-top: 1px solid var(--border-line, #EFECE6);
}

.list__lines {
  display: grid;
  flex: 1;
  gap: 6px;
}

.skel {
  display: block;
  background: var(--bg-subtle, #F5F2EB);
  border: 1px solid var(--border-line, #EFECE6);
}

.skel--avatar {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 50%;
}

.skel--line {
  height: 9px;
  border-radius: 3px;
}

.skel--short {
  width: 60%;
}

.col-note {
  padding: 12px 14px;
  font-size: 12px;
  color: var(--text-muted, #8C867E);
  overflow-wrap: anywhere;
}

.col-note--error {
  color: var(--error, #DC2626);
}

.col-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 14px 14px;
}

/* 会话列表：Seline 暖纸黄色微调 */
.convs {
  display: grid;
  /* 长摘要不能撑大网格列，否则右侧未读角标会被面板裁掉。 */
  grid-template-columns: minmax(0, 1fr);
  max-height: 100%;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
}

.convs > li + li {
  border-top: 1px solid var(--border-line, #EFECE6);
}

.conv {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 88px;
  padding: 12px 14px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s ease;
}

.conv:hover {
  background: var(--bg-subtle, #F5F2EB);
}

.conv--active,
.conv--active:hover {
  background: var(--brand-yellow-bg, #FEF9C3);
}

.conv:focus-visible {
  outline: 2px solid var(--brand-yellow, #FACC15);
  outline-offset: -2px;
}

.conv__identity {
  position: relative;
  flex: none;
}

.conv__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 40px;
  height: 40px;
  overflow: hidden;
  border-radius: 50%;
  background: var(--bg-subtle, #F5F2EB);
  border: 1px solid var(--border-line, #EFECE6);
  font-size: 13px;
  font-weight: 550;
  color: var(--text-main, #1C1917);
}

.conv--active .conv__avatar {
  background: var(--brand-yellow, #FACC15);
  border-color: var(--brand-yellow, #FACC15);
  color: #1C1917;
}

.conv__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.conv__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
}

.conv__top,
.conv__bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.conv__name {
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-main, #1C1917);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv__time {
  flex: none;
  font-size: 11px;
  color: var(--text-muted, #8C867E);
}

.conv__last {
  overflow: hidden;
  font-size: 11.5px;
  color: var(--text-secondary, #78716C);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv__unread {
  position: absolute;
  top: -6px;
  right: -7px;
  border: 2px solid var(--bg-card, #FFFFFF);
  flex: none;
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  border-radius: 9999px;
  background: var(--status-danger, #EF4444);
  color: #FFFFFF;
  font-size: 10.5px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.conv__cover {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 48px;
  height: 48px;
  overflow: hidden;
  border-radius: 8px;
  background: var(--bg-subtle, #F5F2EB);
}

.conv__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.conv__cover-placeholder {
  font-size: 10px;
  color: var(--text-secondary, #78716C);
}

/* 消息区 */
.thread {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.thread__empty {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 24px;
  text-align: center;
}

.thread__title {
  font-size: 13.5px;
  font-weight: 550;
  color: var(--text-main, #1C1917);
}

.thread__text {
  max-width: 44ch;
  font-size: 12.5px;
  color: var(--text-muted, #8C867E);
  overflow-wrap: anywhere;
}

.thread__text--error {
  color: var(--error, #DC2626);
}

.thread__banner:empty {
  display: none;
}

.thread__banner-text {
  margin: 0;
  padding: 6px 16px;
  font-size: 12px;
  color: var(--text-muted, #8C867E);
  border-bottom: 1px solid var(--border-subtle, #EDE9E1);
  background: var(--bg-surface, #FFFFFF);
}

.thread__banner-text--error {
  color: var(--error, #DC2626);
}

.msgs {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 16px;
  background: var(--bg-canvas, #FBF9F4);
}

.msgs:focus-visible {
  outline: 2px solid var(--brand-yellow, #FACC15);
  outline-offset: -2px;
}

.msg {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: min(76%, 560px);
}

.msg--in {
  align-self: flex-start;
}

.msg--out {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.msg__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  overflow: hidden;
  border-radius: 50%;
  background: var(--bg-subtle, #F5F2EB);
  border: 1px solid var(--border-line, #EFECE6);
  font-size: 12px;
  font-weight: 550;
  color: var(--text-muted, #8C867E);
}

.msg__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.msg__content {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.msg__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--text-muted, #8C867E);
}

.msg--out .msg__meta {
  justify-content: flex-end;
}

.msg__who {
  font-weight: 500;
}

.msg__bubble {
  padding: 8px 11px;
  border: 1px solid var(--border-line, #EFECE6);
  border-radius: 10px;
  background: var(--bg-card, #FFFFFF);
  font-size: 12.5px;
  color: var(--text-main, #1C1917);
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.03);
}

.msg--out .msg__bubble {
  background: var(--brand-yellow, #FACC15);
  border-color: var(--brand-yellow, #FACC15);
  color: #1C1917;
}

.msg__link {
  font-size: 11.5px;
  color: var(--brand-yellow-text, #854D0E);
  text-decoration: none;
}

.msg__link:hover {
  text-decoration: underline;
}

/* 买家 / 商品紧凑摘要条：对齐 Seline contextbar */
.contextbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: var(--bg-subtle, #F5F2EB);
  border-bottom: 1px solid var(--border-line, #EFECE6);
  gap: 12px;
  flex-shrink: 0;
}

.contextbar__peer {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.contextbar__avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  overflow: hidden;
  border-radius: 50%;
  background: var(--brand-yellow-bg, #FEF9C3);
  border: 1px solid var(--brand-yellow-border, #FDE047);
  color: var(--brand-yellow-text, #854D0E);
  font-size: 12px;
  font-weight: 600;
}

.contextbar__avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.contextbar__peer-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.contextbar__name {
  font-size: 12.5px;
  font-weight: 550;
  color: var(--text-main, #1C1917);
  line-height: 1.2;
}

.contextbar__sub {
  font-size: 11px;
  color: var(--text-muted, #8C867E);
  line-height: 1.2;
  display: flex;
  gap: 6px;
}

.contextbar__item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  min-width: 0;
  max-width: 58%;
}

.contextbar__item-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-card, #FFFFFF);
  border: 1px solid var(--border-line, #EFECE6);
  font-size: 11px;
  color: var(--text-muted, #8C867E);
  flex-shrink: 0;
}

.contextbar__item-title {
  overflow: hidden;
  font-size: 12px;
  color: var(--text-secondary, #78716C);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.contextbar__link {
  color: var(--brand-yellow-text, #854D0E);
  text-decoration: none;
  font-size: 11.5px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  font-weight: 500;
}

.contextbar__link:hover {
  text-decoration: underline;
}

.contextbar__muted {
  font-size: 11.5px;
  color: var(--text-muted, #8C867E);
}

.mono {
  font-family: var(--mono);
  font-size: 11px;
}

@media (max-width: 719px) {
  .chat {
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
    height: auto;
  }

  .convs {
    max-height: 320px;
  }

  .msgs {
    max-height: 60vh;
  }

  .msg {
    max-width: 92%;
  }
}
</style>
