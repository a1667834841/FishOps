<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { PhSparkle } from '@phosphor-icons/vue'
import { MAX_SEND_CONTENT_LENGTH } from '../../features/contracts'
import { describeSuggestionFailure } from '../../features/reply/reply-form'
import type { ReplyController, ReplyState } from '../../features/reply/reply-controller'
import Callout from '../Callout.vue'

/**
 * 回复区：以手动发送为唯一入口，「回复建议」只生成并回填输入框。
 *
 * 安全设计：
 * - 点击「回复建议」只生成建议并填入输入框，绝不发送；
 * - 发送仅由用户点击「发送」触发，且发送进行中按钮禁用；
 * - 页面加载 / 切换会话都不会发送。
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
/** 最近一次建议成功后回填的原文；与输入框一致时展示“已填入建议”提示，用户编辑后自动消失。 */
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
/** 建议已回填且用户尚未改动时，展示简短提示。 */
const showSuggestionFilled = computed(
  () => filledSuggestionContent.value !== null && manualText.value === filledSuggestionContent.value,
)

// 建议生成成功：把正文放进手动发送输入框，等待用户编辑 / 点击发送。
watch(okSuggestion, (suggestion) => {
  if (!suggestion) return
  manualText.value = suggestion.content
  filledSuggestionContent.value = suggestion.content
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
  <section class="reply" aria-label="回复">
    <!-- 手动发送：始终可见的主入口；建议只回填到此输入框 -->
    <div class="compose">
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
        <button type="button" class="btn btn--primary" :disabled="!canSendManual" @click="sendManual">
          {{ sending && reply.send.kind === 'manual' ? '发送中…' : '发送' }}
        </button>
        <button type="button" class="btn btn--sm suggest-btn" :disabled="!canSuggest" @click="generateSuggestion">
          <PhSparkle :size="15" aria-hidden="true" />
          {{ suggesting ? '生成中…' : '回复建议' }}
        </button>
        <span class="counter">{{ manualText.length }} / {{ maxLength }}</span>
      </div>
      <span v-if="sessionId && !receiverId" class="muted">缺少买家用户 ID，请先同步历史后再手动发送。</span>
      <p v-if="suggesting" class="muted" role="status">正在生成回复建议（不会发送）…</p>
      <Callout v-else-if="suggestionResult?.phase === 'failed' && suggestionResult.error" tone="error" :view="suggestionResult.error" />
      <Callout v-else-if="failedSuggestionText" tone="warn">{{ failedSuggestionText }}</Callout>
      <p v-else-if="showSuggestionFilled" class="muted" role="status">已填入建议，可编辑后发送。</p>
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

.compose {
  display: grid;
  gap: 8px;
}

.suggest-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
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
