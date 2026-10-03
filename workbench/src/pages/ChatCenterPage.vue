<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import ReplyComposer from '../components/chat/ReplyComposer.vue'
import ReplyRulesPanel from '../components/chat/ReplyRulesPanel.vue'
import EmptyState from '../components/EmptyState.vue'
import PanelCard from '../components/PanelCard.vue'
import StatusTag from '../components/StatusTag.vue'
import { useBridgeController } from '../composables/useBridgeController'
import { useChatCenter } from '../composables/useChatCenter'
import type { PageId } from '../data/navigation'
import type { SyncState } from '../features/chat/chat-center-controller'
import {
  deriveItemContext,
  derivePeer,
  formatFullTime,
  formatShortTime,
  isoTime,
  messageDisplayText,
  messageKindLabel,
  safeHttpsUrl,
  socketStatusView,
} from '../features/chat/chat-format'
import { REPLY_EVENTS, ReplyController, type ReplyState } from '../features/reply/reply-controller'

const emit = defineEmits<{ navigate: [page: PageId]; diagnostics: [] }>()

const { state, controller } = useChatCenter()

const available = computed(() => state.value.availability === 'ready')
const socketView = computed(() => socketStatusView(state.value.socketStatus))

const conversations = computed(() => state.value.conversations)
const selectedId = computed(() => state.value.selectedId)
const selectedConversation = computed(
  () => conversations.value.items.find((item) => item.sessionId === selectedId.value) ?? null,
)

/** 只展示属于当前选中会话的消息，防止切换瞬间出现上一个会话的内容。 */
const threadMessages = computed(() => {
  const messages = state.value.messages
  return messages.sessionId === selectedId.value ? messages.items : []
})

const itemContext = computed(() => deriveItemContext(selectedConversation.value, threadMessages.value))
const peer = computed(() => derivePeer(selectedConversation.value, threadMessages.value))

/**
 * P6 回复层（规则 / 建议 / 发送）使用独立控制器与独立 Bridge。
 * 发送最长可能等待 10 秒（LWP）再加扩展处理，因此单次命令等待放宽到 30 秒。
 */
const { state: replyState, controller: replyController } = useBridgeController<ReplyState, ReplyController>({
  events: REPLY_EVENTS,
  timeoutMs: 30000,
  create: (api) => new ReplyController({ api }),
})

/** 会话 / 回复规则两个视图；用 v-show 保留规则草稿，切换标签不会丢失未保存的修改。 */
const view = ref<'chat' | 'rules'>('chat')

// 选择会话时把回复层绑定到该会话：旧会话的建议与发送结果作废，发送重新锁定。
watch(selectedId, (id) => replyController.setSession(id), { immediate: true })

// 发送成功后只刷新本地缓存，不向平台发起额外请求。
watch(
  () => replyState.value.send.sentAt,
  (sentAt) => {
    if (sentAt !== null) void controller.refresh()
  },
)

const conversationSync = computed(() => state.value.conversationSync)
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
const threadRef = ref<HTMLElement | null>(null)
let stickToBottom = true

function onThreadScroll(): void {
  const el = threadRef.value
  if (!el) return
  stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
}

watch(
  () => [state.value.messages.sessionId, threadMessages.value.length] as const,
  async ([sessionId], [previousSessionId]) => {
    if (sessionId !== previousSessionId) stickToBottom = true
    await nextTick()
    const el = threadRef.value
    if (el && stickToBottom) el.scrollTop = el.scrollHeight
  },
)
</script>

<template>
  <div class="page">
    <div class="banner">
      <div class="banner__head">
        <template v-if="available">
          <StatusTag :tone="socketView.tone" dot>{{ socketView.label }}</StatusTag>
          <StatusTag v-if="state.status.data" mono>
            本地缓存 {{ state.status.data.sessionCount }} 个会话 · {{ state.status.data.messageCount }} 条消息
          </StatusTag>
          <StatusTag v-else-if="state.status.phase === 'loading'" mono>正在读取状态…</StatusTag>
          <StatusTag v-else-if="state.status.phase === 'error'" tone="error">状态读取失败</StatusTag>
        </template>
        <StatusTag v-else tone="warn">未连接扩展</StatusTag>
        <span class="banner__spacer"></span>
        <div class="row">
          <button
            v-if="available"
            type="button"
            class="btn btn--sm"
            :disabled="conversations.phase === 'loading' || conversations.refreshing"
            @click="controller.refresh()"
          >
            刷新本地缓存
          </button>
          <button
            v-if="available"
            type="button"
            class="btn btn--sm btn--primary"
            :disabled="conversationSync.phase === 'running'"
            @click="controller.syncConversations()"
          >
            {{ conversationSync.phase === 'running' ? '同步会话中…' : '同步会话' }}
          </button>
          <button type="button" class="btn btn--sm" @click="emit('diagnostics')">查看系统状态</button>
        </div>
      </div>
      <p class="banner__text">
        读取是只读的：「刷新本地缓存」只读取扩展内已有数据，「同步会话」「同步历史」才会通过已打开的闲鱼页面向平台拉取。回复区默认锁定，页面加载不会发送任何消息；只有你点击「启用发送」并点击发送按钮后才会发送，AI 建议也只在你点击「生成建议」时调用。
      </p>
      <p
        v-if="conversationSync.phase !== 'idle'"
        class="sync"
        :class="{ 'sync--failed': conversationSync.phase === 'failed', 'sync--ok': conversationSync.phase === 'ok' }"
        :role="conversationSync.phase === 'failed' ? 'alert' : 'status'"
      >
        {{ syncSummary(conversationSync, '会话') }}
      </p>
      <p v-if="state.status.phase === 'error' && state.status.error" class="sync sync--failed" role="alert">
        读取聊天状态失败：{{ state.status.error }}
      </p>
      <p v-if="state.realtimeError" class="sync sync--warn" role="status">
        {{ state.realtimeError }}（可手动点击「刷新本地缓存」）
      </p>
    </div>

    <div v-if="available" class="views" role="group" aria-label="聊天中心视图">
      <button type="button" class="btn btn--sm" :class="{ 'btn--primary': view === 'chat' }" :aria-pressed="view === 'chat'" @click="view = 'chat'">
        会话与回复
      </button>
      <button type="button" class="btn btn--sm" :class="{ 'btn--primary': view === 'rules' }" :aria-pressed="view === 'rules'" @click="view = 'rules'">
        回复规则
      </button>
    </div>

    <ReplyRulesPanel v-if="available" v-show="view === 'rules'" :reply="replyState" :controller="replyController" />

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

    <div v-else v-show="view === 'chat'" class="chat">
      <!-- 会话列表 -->
      <PanelCard title="会话" flush class="chat__col">
        <template #actions>
          <StatusTag v-if="conversations.phase === 'ready'" mono>{{ conversations.items.length }}</StatusTag>
        </template>

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
            description="扩展本地缓存里暂无会话。请先在浏览器打开并登录闲鱼，再点击上方「同步会话」；收到新消息时这里也会自动出现。"
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
                <span class="conv__avatar" aria-hidden="true">{{ displayName(item.sessionId, item.peerUserName).slice(0, 1) }}</span>
                <span class="conv__body">
                  <span class="conv__top">
                    <span class="conv__name">{{ displayName(item.sessionId, item.peerUserName) }}</span>
                    <time v-if="item.lastMessageTime > 0" class="conv__time" :datetime="isoTime(item.lastMessageTime)">
                      {{ formatShortTime(item.lastMessageTime) }}
                    </time>
                  </span>
                  <span class="conv__bottom">
                    <span class="conv__last">{{ item.lastMessage || '（暂无消息摘要）' }}</span>
                    <span v-if="item.unreadCount > 0" class="conv__unread">
                      <span aria-hidden="true">{{ unreadLabel(item.unreadCount) }}</span>
                      <span class="sr-only">{{ item.unreadCount }} 条未读</span>
                    </span>
                  </span>
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
            <ol ref="threadRef" class="msgs" aria-label="消息记录" tabindex="0" @scroll.passive="onThreadScroll">
              <li
                v-for="message in threadMessages"
                :key="message.id"
                class="msg"
                :class="message.direction === 'out' ? 'msg--out' : 'msg--in'"
              >
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
                  在新标签页查看图片
                </a>
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

      <!-- 买家与商品 -->
      <PanelCard title="买家与商品" flush class="chat__col">
        <div v-if="!selectedId" class="state">
          <p class="col-note">选择会话后，这里显示该买家的已知信息和关联商品。</p>
        </div>
        <div v-else class="context">
          <section aria-labelledby="ctx-peer">
            <h3 id="ctx-peer" class="context__h">买家</h3>
            <dl class="kv">
              <div>
                <dt>昵称</dt>
                <dd>{{ peer.name ?? '未知' }}</dd>
              </div>
              <div>
                <dt>用户 ID</dt>
                <dd class="mono">{{ peer.userId ?? '未知' }}</dd>
              </div>
              <div>
                <dt>会话 ID</dt>
                <dd class="mono">{{ selectedId }}</dd>
              </div>
              <div v-if="selectedConversation">
                <dt>未读</dt>
                <dd>{{ selectedConversation.unreadCount }}</dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="ctx-item">
            <h3 id="ctx-item" class="context__h">关联商品</h3>
            <template v-if="itemContext">
              <dl class="kv">
                <div v-if="itemContext.itemTitle">
                  <dt>标题</dt>
                  <dd>{{ itemContext.itemTitle }}</dd>
                </div>
                <div>
                  <dt>商品 ID</dt>
                  <dd class="mono">{{ itemContext.itemId }}</dd>
                </div>
              </dl>
              <a
                v-if="itemContext.url"
                class="btn btn--sm context__link"
                :href="itemContext.url"
                target="_blank"
                rel="noopener noreferrer"
              >
                在闲鱼打开商品
              </a>
              <p v-else class="col-note col-note--flat">商品 ID 格式无法识别，未生成链接。</p>
              <p class="col-note col-note--flat">扩展目前只提供商品 ID，价格、图片等详情暂不可用。</p>
            </template>
            <p v-else class="col-note col-note--flat">这个会话没有关联商品信息。</p>
          </section>
        </div>
      </PanelCard>
    </div>
  </div>
</template>

<style scoped>
.views {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.banner {
  display: grid;
  gap: 8px;
  padding: 12px 16px;
  background: var(--info-soft);
  border-radius: var(--radius-panel);
}

.banner__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
}

.banner__spacer {
  flex: 1 1 0;
}

.banner__text {
  font-size: 12.5px;
  color: var(--text-muted);
}

.sync {
  font-size: 13px;
  overflow-wrap: anywhere;
}

.sync--ok {
  color: var(--ok);
}

.sync--failed {
  color: var(--error);
}

.sync--warn {
  color: var(--warn);
}

.sync--inline {
  padding: 8px 14px;
  background: var(--surface-sunken);
  border-bottom: 1px solid var(--border);
}

.chat {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr) 280px;
  gap: 14px;
  align-items: stretch;
  min-height: 420px;
}

.chat__col {
  display: flex;
  flex-direction: column;
}

.chat__col :deep(.panel__body) {
  flex: 1;
  min-width: 0;
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
  border-top: 1px solid var(--border);
}

.list__lines {
  display: grid;
  flex: 1;
  gap: 6px;
}

.skel {
  display: block;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
}

.skel--avatar {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-control);
}

.skel--line {
  height: 9px;
  border-radius: 3px;
}

.skel--short {
  width: 60%;
}

.col-note {
  padding: 14px;
  font-size: 12.5px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.col-note--flat {
  padding: 8px 0 0;
}

.col-note--error {
  color: var(--error);
}

.col-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 14px 14px;
}

/* 会话列表 */
.convs {
  display: grid;
  max-height: 560px;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 0;
}

.convs > li + li {
  border-top: 1px solid var(--border);
}

.conv {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;
}

.conv:hover {
  background: var(--surface-sunken);
}

.conv--active,
.conv--active:hover {
  background: var(--accent-soft);
  box-shadow: inset 3px 0 0 var(--accent);
}

.conv:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}

.conv__avatar {
  display: grid;
  flex: none;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  font-weight: 600;
  color: var(--text-muted);
}

.conv__body {
  display: grid;
  flex: 1;
  gap: 3px;
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
  font-size: 13.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv__time {
  flex: none;
  font-size: 11.5px;
  color: var(--text-muted);
}

.conv__last {
  overflow: hidden;
  font-size: 12.5px;
  color: var(--text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.conv__unread {
  flex: none;
  min-width: 18px;
  padding: 2px 6px;
  border-radius: 9px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 11px;
  font-weight: 650;
  line-height: 1.2;
  text-align: center;
}

/* 消息区 */
.thread {
  display: flex;
  flex-direction: column;
  min-height: 330px;
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
  font-weight: 650;
}

.thread__text {
  max-width: 44ch;
  font-size: 13px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.thread__text--error {
  color: var(--error);
}

.msgs {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  max-height: 520px;
  overflow-y: auto;
  list-style: none;
  margin: 0;
  padding: 14px;
}

.msgs:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}

.msg {
  display: grid;
  gap: 4px;
  max-width: min(78%, 560px);
}

.msg--in {
  align-self: flex-start;
}

.msg--out {
  align-self: flex-end;
}

.msg__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
  font-size: 11.5px;
  color: var(--text-muted);
}

.msg--out .msg__meta {
  justify-content: flex-end;
}

.msg__who {
  font-weight: 600;
}

.msg__bubble {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
  font-size: 13.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.msg--out .msg__bubble {
  border-color: transparent;
  background: var(--accent-soft);
}

.msg__link {
  font-size: 12px;
  color: var(--info);
}

/* 买家与商品 */
.context {
  display: grid;
  gap: 18px;
  padding: 0 14px 14px;
}

.context__h {
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 650;
  color: var(--text-muted);
}

.kv {
  display: grid;
  gap: 8px;
  margin: 0;
}

.kv > div {
  display: grid;
  gap: 2px;
}

.kv dt {
  font-size: 11.5px;
  color: var(--text-muted);
}

.kv dd {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.mono {
  font-family: var(--mono);
  font-size: 12.5px;
}

.context__link {
  margin-top: 10px;
  text-decoration: none;
}

@media (max-width: 1179px) {
  .chat {
    grid-template-columns: 260px minmax(0, 1fr);
  }

  .chat > :last-child {
    grid-column: 1 / -1;
  }
}

@media (max-width: 719px) {
  .chat {
    grid-template-columns: minmax(0, 1fr);
    min-height: 0;
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
