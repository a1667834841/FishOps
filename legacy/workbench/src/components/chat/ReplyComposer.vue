<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { PhSparkle } from '@phosphor-icons/vue'
import { MAX_SEND_CONTENT_LENGTH } from '../../features/contracts'
import { describeSuggestionFailure } from '../../features/reply/reply-form'
import type { ReplyController, ReplyState } from '../../features/reply/reply-controller'
import Callout from '../Callout.vue'

/**
 * 回复区（ReplyComposer）：忠实 Seline 暖纸白卡细线黄色风格。
 *
 * 核心安全机制：
 * 1. 唯一发送入口为用户点击「发送」，点击「回复建议」仅生成建议并回填输入框，绝不自动发送；
 * 2. 切换会话时严格清空草稿与建议提示，避免串会话发送；
 * 3. 发送进行中禁用按钮防重复，发送成功后清空草稿，失败时保留以供修改。
 */
const props = defineProps<{
  reply: ReplyState
  controller: ReplyController
  sessionId: string | null
  /** 买家用户 ID；缺失时无法手动发送。 */
  receiverId: string | null
  itemId: string | null
}>()

const manualText = ref('')
const textareaRef = ref<HTMLTextAreaElement | null>(null)
/** 最近一次建议成功后回填的原文；与输入框一致时展示“已填入智能建议”，用户修改后自动消失。 */
const filledSuggestionContent = ref<string | null>(null)

const sending = computed(() => props.reply.send.phase === 'running')
const suggesting = computed(() => props.reply.suggestion.phase === 'running')
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

const canSuggest = computed(() => Boolean(props.sessionId) && !suggesting.value)
const canSendManual = computed(
  () =>
    Boolean(props.sessionId) &&
    !sending.value &&
    Boolean(props.receiverId) &&
    manualText.value.trim().length > 0 &&
    manualText.value.length <= maxLength.value,
)
/** 建议已回填且用户尚未改动时，展示提示。 */
const showSuggestionFilled = computed(
  () => filledSuggestionContent.value !== null && manualText.value === filledSuggestionContent.value,
)

// 建议生成成功：把正文放进手动发送输入框，等待用户编辑 / 点击发送，并自动聚焦。
watch(okSuggestion, async (suggestion) => {
  if (!suggestion) return
  manualText.value = suggestion.content
  filledSuggestionContent.value = suggestion.content
  await nextTick()
  textareaRef.value?.focus()
})

// 切换会话：清空手动输入与回填提示，避免把上一个会话的草稿 / 建议发给新的买家。
watch(
  () => props.sessionId,
  () => {
    manualText.value = ''
    filledSuggestionContent.value = null
  },
)

// 发送成功后清理输入；失败则保留，便于用户修改后重试。
watch(
  () => props.reply.send.sentAt,
  (sentAt) => {
    if (sentAt === null) return
    manualText.value = ''
    filledSuggestionContent.value = null
  },
)

async function generateSuggestion(): Promise<void> {
  if (!canSuggest.value) return
  // 重新生成时先撤下旧回填提示，避免与“生成中 / 失败”状态并存。
  filledSuggestionContent.value = null
  await props.controller.requestSuggestion()
}

async function sendManual(): Promise<void> {
  if (!canSendManual.value || !props.receiverId) return
  await props.controller.sendMessage(manualText.value, props.receiverId, props.itemId ?? undefined)
}
</script>

<template>
  <section class="chat-reply-composer" aria-label="回复区">
    <!-- 提示与建议生成行 -->
    <div class="reply-prompt-row">
      <button
        id="chat-suggest-btn"
        type="button"
        class="reply-suggest-btn"
        :disabled="!canSuggest"
        @click="generateSuggestion"
      >
        <PhSparkle :size="13" aria-hidden="true" />
        <span>{{ suggesting ? '正在生成建议…' : '✨ 回复建议' }}</span>
      </button>
      <span v-if="showSuggestionFilled" id="suggestion-filled-tip" class="suggestion-filled-badge" role="status">
        已填入智能建议
      </span>
      <span v-else-if="suggesting" class="reply-hint" role="status">
        正在读取上下文生成建议（不会发送）…
      </span>
    </div>

    <!-- 真实错误与提示信息 -->
    <div v-if="sessionId && !receiverId" class="reply-alert">
      缺少买家用户 ID，请先同步历史后再手动发送。
    </div>
    <Callout
      v-if="suggestionResult?.phase === 'failed' && suggestionResult.error"
      tone="error"
      :view="suggestionResult.error"
    />
    <Callout v-else-if="failedSuggestionText" tone="warn">{{ failedSuggestionText }}</Callout>

    <!-- 输入框 -->
    <label class="sr-only" for="reply-input">输入回复内容</label>
    <textarea
      id="reply-input"
      ref="textareaRef"
      v-model="manualText"
      class="reply-textarea"
      rows="3"
      :maxlength="maxLength"
      :disabled="!sessionId || sending"
      placeholder="输入回复内容..."
    ></textarea>

    <!-- 工具栏：字数统计 + 发送按钮 -->
    <div class="reply-toolbar">
      <span class="reply-count">
        <span id="reply-count">{{ manualText.length }}</span> / {{ maxLength }} 字
      </span>
      <div class="reply-actions">
        <button
          id="send-reply-btn"
          type="button"
          class="btn-send"
          :disabled="!canSendManual"
          @click="sendManual"
        >
          {{ sending && reply.send.kind === 'manual' ? '发送中…' : '发送' }}
        </button>
      </div>
    </div>

    <!-- 发送结果反馈 -->
    <div v-if="sendState && sendState.phase !== 'idle'" class="send-status">
      <p v-if="sendState.phase === 'running'" class="reply-hint" role="status">正在发送，请稍候，不要重复点击…</p>
      <Callout v-else-if="sendState.phase === 'ok'" tone="ok">消息已发送。本地缓存刷新后会出现在消息记录中。</Callout>
      <Callout v-else-if="sendState.phase === 'failed'" :tone="sendState.uncertain ? 'warn' : 'error'">
        {{ sendState.error }}
      </Callout>
    </div>
  </section>
</template>

<style scoped>
.chat-reply-composer {
  border-top: 1px solid var(--border-line, #EFECE6);
  padding: 10px 14px;
  background: var(--bg-card, #FFFFFF);
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.reply-prompt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 24px;
}

.reply-suggest-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 9999px;
  font-size: 11.5px;
  background: var(--brand-yellow-bg, #FEF9C3);
  border: 1px solid var(--brand-yellow-border, #FDE047);
  color: var(--brand-yellow-text, #854D0E);
  cursor: pointer;
  font-family: inherit;
  font-weight: 500;
  transition: all 0.12s ease;
  line-height: 1.4;
}

.reply-suggest-btn:hover:not(:disabled) {
  background: var(--brand-yellow, #FACC15);
  color: #1C1917;
}

.reply-suggest-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.suggestion-filled-badge {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--status-success, #15803D);
}

.reply-hint {
  font-size: 11.5px;
  color: var(--text-muted, #8C867E);
}

.reply-alert {
  font-size: 11.5px;
  color: var(--warn, #D97706);
}

.reply-textarea {
  width: 100%;
  min-height: 58px;
  max-height: 120px;
  resize: vertical;
  padding: 8px 11px;
  border-radius: 6px;
  border: 1px solid var(--border-line, #EFECE6);
  background: var(--bg-card, #FFFFFF);
  color: var(--text-main, #1C1917);
  font-size: 12.5px;
  outline: none;
  font-family: inherit;
  line-height: 1.5;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
  box-sizing: border-box;
}

.reply-textarea:focus {
  border-color: var(--brand-yellow, #FACC15);
  box-shadow: 0 0 0 2px var(--brand-yellow-bg, #FEF9C3);
}

.reply-textarea:disabled {
  background: var(--bg-subtle, #F5F2EB);
  color: var(--text-muted, #8C867E);
  cursor: not-allowed;
}

.reply-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.reply-count {
  font-size: 11.5px;
  color: var(--text-muted, #8C867E);
  font-variant-numeric: tabular-nums;
}

.reply-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 14px;
  border-radius: 6px;
  font-size: 12.5px;
  font-weight: 500;
  border: 1px solid transparent;
  background: var(--brand-yellow, #FACC15);
  color: #1C1917;
  cursor: pointer;
  transition: all 0.12s ease;
}

.btn-send:hover:not(:disabled) {
  filter: brightness(0.96);
}

.btn-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  background: var(--bg-subtle, #EFECE6);
  color: var(--text-muted, #8C867E);
}

.send-status {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
