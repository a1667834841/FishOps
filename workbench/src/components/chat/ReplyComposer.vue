<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { MAX_SEND_CONTENT_LENGTH } from '../../features/contracts'
import { describeSuggestionFailure } from '../../features/reply/reply-form'
import type { ReplyController, ReplyState } from '../../features/reply/reply-controller'
import Callout from '../Callout.vue'
import StatusTag from '../StatusTag.vue'

/**
 * 回复区：AI 建议 + 手动发送。
 *
 * 安全设计：
 * - 页面加载 / 选择会话 / 生成建议都不会发送；
 * - 发送开关默认关闭，用户点击「启用发送」后才允许发送，切换会话会重新锁定；
 * - 「采用并发送」与「发送」都只在用户点击时调用对应命令，且发送进行中按钮禁用。
 */
const props = defineProps<{
  reply: ReplyState
  controller: ReplyController
  sessionId: string | null
  /** 买家用户 ID；缺失时无法手动发送。 */
  receiverId: string | null
  itemId: string | null
}>()

const suggestionText = ref('')
const manualText = ref('')

const sending = computed(() => props.reply.send.phase === 'running')
const suggesting = computed(() => props.reply.suggestion.phase === 'running')
const sendEnabled = computed(() => props.reply.sendEnabled)
const maxLength = computed(() =>
  Math.min(props.reply.config.global?.maxContentLength ?? MAX_SEND_CONTENT_LENGTH, MAX_SEND_CONTENT_LENGTH),
)
const suggestionResult = computed(() => {
  const s = props.reply.suggestion
  return s.sessionId === props.sessionId ? s : null
})
const okSuggestion = computed(() => {
  const result = suggestionResult.value?.result
  return result && result.ok ? result.suggestion : null
})
const failedSuggestionText = computed(() => {
  const result = suggestionResult.value?.result
  return result && !result.ok ? describeSuggestionFailure(result) : null
})
/** 发送结果只在其所属会话下展示。 */
const sendState = computed(() => (props.reply.send.sessionId === props.sessionId ? props.reply.send : null))

const canApply = computed(
  () => sendEnabled.value && !sending.value && suggestionText.value.trim().length > 0 && suggestionText.value.length <= maxLength.value,
)
const canSendManual = computed(
  () =>
    sendEnabled.value &&
    !sending.value &&
    Boolean(props.receiverId) &&
    manualText.value.trim().length > 0 &&
    manualText.value.length <= maxLength.value,
)

// 新建议到达时，把正文放入可编辑文本框。
watch(
  okSuggestion,
  (suggestion) => {
    suggestionText.value = suggestion ? suggestion.content : ''
  },
  { immediate: true },
)

// 切换会话：清空手动输入，避免把上一个会话的草稿发给新的买家。
watch(
  () => props.sessionId,
  () => {
    manualText.value = ''
  },
)

// 发送成功后清理对应输入；失败则保留，便于用户修改后重试。
watch(
  () => props.reply.send.sentAt,
  (sentAt) => {
    if (sentAt === null) return
    if (props.reply.send.kind === 'manual') manualText.value = ''
    else props.controller.clearSuggestion()
  },
)

function toggleSend(): void {
  props.controller.setSendEnabled(!sendEnabled.value)
}

async function apply(): Promise<void> {
  if (!canApply.value) return
  await props.controller.applySuggestion(suggestionText.value)
}

async function sendManual(): Promise<void> {
  if (!canSendManual.value || !props.receiverId) return
  await props.controller.sendMessage(manualText.value, props.receiverId, props.itemId ?? undefined)
}
</script>

<template>
  <section class="reply" aria-labelledby="reply-title">
    <div class="reply__head">
      <h3 id="reply-title" class="reply__title">回复</h3>
      <StatusTag :tone="sendEnabled ? 'warn' : 'neutral'" :dot="sendEnabled">{{ sendEnabled ? '发送已启用' : '发送已锁定' }}</StatusTag>
      <span class="reply__spacer"></span>
      <button
        type="button"
        class="btn btn--sm"
        :class="{ 'btn--primary': !sendEnabled }"
        :aria-pressed="sendEnabled"
        :disabled="!sessionId || sending"
        @click="toggleSend"
      >
        {{ sendEnabled ? '重新锁定发送' : '启用发送' }}
      </button>
    </div>
    <p class="reply__note">
      <template v-if="!sessionId">选择会话后才能生成建议或发送。</template>
      <template v-else-if="!sendEnabled">
        默认锁定：点击「启用发送」后才能发送消息；生成建议不会发送。切换会话会重新锁定。
      </template>
      <template v-else>发送已启用：下方按钮点击后会立即以你的账号向买家发送消息，请先确认内容。</template>
    </p>

    <!-- AI / 规则建议 -->
    <div class="block">
      <div class="block__head">
        <h4 class="block__title">回复建议</h4>
        <button type="button" class="btn btn--sm" :disabled="!sessionId || suggesting" @click="controller.requestSuggestion()">
          {{ suggesting ? '生成中…' : '生成建议' }}
        </button>
      </div>

      <p v-if="suggesting" class="muted" role="status">正在根据规则生成建议（不会发送）…</p>
      <Callout v-else-if="suggestionResult?.phase === 'failed' && suggestionResult.error" tone="error" :view="suggestionResult.error" />
      <Callout v-else-if="failedSuggestionText" tone="warn">{{ failedSuggestionText }}</Callout>
      <p v-else-if="!okSuggestion" class="muted">
        点击「生成建议」将匹配回复规则生成建议；若无规则匹配，将由 AI 智能生成兜底建议（手动生成独立可用，不会自动发送，需人工确认后采用）。
      </p>

      <div v-if="okSuggestion" class="suggest">
        <p class="suggest__meta">
          <StatusTag :tone="okSuggestion.ruleType === 'ai' ? 'info' : 'accent'">{{ okSuggestion.ruleType === 'ai' ? 'AI 规则' : '关键词规则' }}</StatusTag>
          <span class="muted">规则 {{ okSuggestion.ruleId }}</span>
        </p>
        <Callout v-if="okSuggestion.requiresHuman" tone="warn">买家消息命中了转人工关键词，建议由你亲自确认并修改后再发送。</Callout>
        <label class="sr-only" for="reply-suggestion-text">建议回复正文，可修改</label>
        <textarea
          id="reply-suggestion-text"
          v-model="suggestionText"
          class="input"
          rows="3"
          :maxlength="maxLength"
          :disabled="sending"
        ></textarea>
        <div class="row">
          <button type="button" class="btn btn--primary" :disabled="!canApply" :title="sendEnabled ? undefined : '请先点击「启用发送」'" @click="apply">
            {{ sending && reply.send.kind === 'apply' ? '发送中…' : '采用并发送' }}
          </button>
          <button type="button" class="btn btn--ghost" :disabled="sending" @click="controller.clearSuggestion()">丢弃建议</button>
          <span class="counter">{{ suggestionText.length }} / {{ maxLength }}</span>
        </div>
      </div>
    </div>

    <!-- 手动发送 -->
    <div class="block">
      <h4 class="block__title">手动发送</h4>
      <label class="sr-only" for="reply-manual-text">要发送的消息</label>
      <textarea
        id="reply-manual-text"
        v-model="manualText"
        class="input"
        rows="2"
        :maxlength="maxLength"
        :disabled="!sessionId || sending"
        placeholder="输入要发送的消息"
      ></textarea>
      <div class="row">
        <button type="button" class="btn" :disabled="!canSendManual" :title="sendEnabled ? undefined : '请先点击「启用发送」'" @click="sendManual">
          {{ sending && reply.send.kind === 'manual' ? '发送中…' : '发送' }}
        </button>
        <span class="counter">{{ manualText.length }} / {{ maxLength }}</span>
        <span v-if="sessionId && !receiverId" class="muted">缺少买家用户 ID，请先同步历史后再手动发送。</span>
      </div>
    </div>

    <div v-if="sendState && sendState.phase !== 'idle'" class="result">
      <p v-if="sendState.phase === 'running'" class="muted" role="status">正在发送，请稍候，不要重复点击…</p>
      <Callout v-else-if="sendState.phase === 'ok'" tone="ok">消息已发送。本地缓存刷新后会出现在消息记录中。</Callout>
      <Callout v-else-if="sendState.phase === 'failed'" :tone="sendState.uncertain ? 'warn' : 'error'">
        {{ sendState.error }}
      </Callout>
    </div>
  </section>
</template>

<style scoped>
.reply {
  display: grid;
  gap: 12px;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--border);
}

.reply__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 10px;
}

.reply__title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}

.reply__spacer {
  flex: 1 1 0;
}

.reply__note {
  font-size: 12.5px;
  color: var(--text-muted);
}

.block {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
}

.block__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.block__title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 650;
  color: var(--text-muted);
}

.suggest {
  display: grid;
  gap: 8px;
}

.suggest__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.muted {
  font-size: 12.5px;
  color: var(--text-muted);
}

.counter {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.result {
  display: grid;
  gap: 6px;
}
</style>
