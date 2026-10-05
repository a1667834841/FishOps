<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { REPLY_LIMITS, type ReplyGlobalConfig, type ReplyRule } from '../../features/contracts'
import type { ReplyController, ReplyState } from '../../features/reply/reply-controller'
import {
  MODE_OPTIONS,
  buildGlobalPatch,
  buildRuleFromDraft,
  draftFromGlobal,
  draftFromRule,
  emptyRuleDraft,
  type GlobalDraft,
  type GlobalDraftErrors,
  type RuleDraft,
  type RuleDraftErrors,
} from '../../features/reply/reply-form'
import Callout from '../Callout.vue'
import EmptyState from '../EmptyState.vue'
import PanelCard from '../PanelCard.vue'
import StatusTag from '../StatusTag.vue'
import AppModal from '../AppModal.vue'

/**
 * 回复规则与全局配置面板。
 *
 * 默认（rulesOnly 未开启）同时渲染全局配置与规则列表，保持聊天中心旧入口的完整能力。
 * 传入 rulesOnly 时只渲染规则列表（创建/编辑/启停/删除/模态框），隐藏全局配置卡
 * 与「安全默认」等面向整个引擎的说明文案，供设置页「回复策略」分区复用；规则保存
 * 始终走同一后台命令且只提交 rules 字段，不会覆盖全局策略。
 *
 * 安全设计：
 * - 全局默认 suggest + 引擎关闭，页面只展示后台返回的真实配置，读取失败时不显示任何「默认值」；
 * - 切到自动回复，或在自动模式下打开引擎，必须在醒目的确认面板里勾选并点击确认，否则不会发出命令；
 * - 这里没有任何 API Key / Secret 输入框，AI 凭据只能在扩展侧安全配置。
 */
const props = defineProps<{ reply: ReplyState; controller: ReplyController; rulesOnly?: boolean }>()

const config = computed(() => props.reply.config)
const saving = computed(() => props.reply.save.phase === 'running')
const status = computed(() => props.reply.status.data)

// ---------------- 全局配置 ----------------
const globalDraft = ref<GlobalDraft | null>(null)
const globalErrors = ref<GlobalDraftErrors>({})
const baseline = ref('')
const staleGlobal = ref(false)
const pendingPatch = ref<Partial<ReplyGlobalConfig> | null>(null)
const autoAck = ref(false)

function syncGlobal(global: ReplyGlobalConfig | null): void {
  if (!global) {
    globalDraft.value = null
    baseline.value = ''
    return
  }
  const next = draftFromGlobal(global)
  const nextJson = JSON.stringify(next)
  const draftJson = globalDraft.value === null ? '' : JSON.stringify(globalDraft.value)
  const clean = globalDraft.value === null || draftJson === baseline.value
  if (clean || draftJson === nextJson) {
    // 草稿无改动，或后台值恰好等于草稿（例如刚保存成功）：以后台为准同步基线。
    globalDraft.value = next
    baseline.value = nextJson
    staleGlobal.value = false
  } else if (nextJson !== baseline.value) {
    // 用户有未保存的修改时不覆盖，只提示后台配置已变化。
    staleGlobal.value = true
  }
}

watch(() => config.value.global, (global) => syncGlobal(global), { immediate: true })

function reloadGlobalDraft(): void {
  globalDraft.value = null
  syncGlobal(config.value.global)
  globalErrors.value = {}
  pendingPatch.value = null
  autoAck.value = false
}

const globalDirty = computed(() => globalDraft.value !== null && JSON.stringify(globalDraft.value) !== baseline.value)
const autoDraft = computed(() => globalDraft.value?.mode === 'auto')

async function saveGlobal(): Promise<void> {
  const current = config.value.global
  const draft = globalDraft.value
  if (!current || !draft || saving.value) return
  const built = buildGlobalPatch(draft, current)
  if (!built.ok) {
    globalErrors.value = built.errors
    return
  }
  globalErrors.value = {}
  if (Object.keys(built.patch).length === 0) {
    props.controller.clearSaveStatus()
    return
  }
  const outcome = await props.controller.saveGlobal(built.patch)
  if (outcome.needsAutoConfirm) {
    // 控制器拒绝直接保存：展示二次确认面板，确认前不会发出命令。
    pendingPatch.value = built.patch
    autoAck.value = false
  } else {
    pendingPatch.value = null
  }
}

async function confirmAuto(): Promise<void> {
  const patch = pendingPatch.value
  if (!patch || !autoAck.value || saving.value) return
  const outcome = await props.controller.saveGlobal(patch, { confirmedAuto: true })
  if (outcome.ok) {
    pendingPatch.value = null
    autoAck.value = false
  }
}

function cancelAuto(): void {
  pendingPatch.value = null
  autoAck.value = false
  props.controller.clearSaveStatus()
  // 取消确认时把草稿恢复到后台当前值，避免遗留一个未确认的 auto 草稿。
  reloadGlobalDraft()
}

// ---------------- 规则列表与编辑 ----------------
const editor = ref<RuleDraft | null>(null)
const editorErrors = ref<RuleDraftErrors>({})
const confirmDeleteId = ref<string | null>(null)

function startCreate(type: 'keyword' | 'ai'): void {
  editor.value = emptyRuleDraft(type)
  editorErrors.value = {}
}

function startEdit(rule: ReplyRule): void {
  editor.value = draftFromRule(rule)
  editorErrors.value = {}
}

function closeEditor(): void {
  editor.value = null
  editorErrors.value = {}
}

async function saveRule(): Promise<void> {
  const draft = editor.value
  if (!draft || saving.value) return
  const built = buildRuleFromDraft(draft)
  if (!built.ok) {
    editorErrors.value = built.errors
    return
  }
  editorErrors.value = {}
  const outcome = await props.controller.upsertRule(built.rule)
  if (outcome.ok) closeEditor()
}

async function removeRule(ruleId: string): Promise<void> {
  confirmDeleteId.value = null
  if (editor.value?.id === ruleId) closeEditor()
  await props.controller.deleteRule(ruleId)
}

function ruleSummary(rule: ReplyRule): string {
  return rule.type === 'keyword' ? `匹配 /${rule.pattern}/i` : rule.prompt ? '使用自定义提示词' : '使用内置提示词'
}

const sortedRules = computed(() => [...config.value.rules].sort((a, b) => b.priority - a.priority))
</script>

<template>
  <div class="rules">
    <!-- 面向整个引擎的安全说明仅在完整面板展示；独立规则页隐藏，避免与设置页全局策略文案重复。 -->
    <Callout v-if="!rulesOnly" tone="info">
      安全默认：回复引擎关闭、模式为「建议」，不会自动发送。AI 凭据（API Key）只能在扩展侧安全配置，工作台不提供输入入口，也不会读取或显示。
    </Callout>

    <div v-if="config.phase === 'idle' || config.phase === 'loading'" class="blank" role="status">正在读取回复配置…</div>

    <Callout v-else-if="config.phase === 'error'" tone="error" :view="config.error">
      <template #actions>
        <button type="button" class="btn btn--sm" @click="controller.refresh()">重试</button>
      </template>
    </Callout>

    <!--
      移除旧的 `globalDraft && config.global` gate：该 gate 会让只关心规则的
      rulesOnly 模式在全局草稿尚未同步时整块不渲染。此处在读取成功后直接渲染，
      全局卡再按 rulesOnly 独立控制。
    -->
    <template v-else>
      <Callout v-if="config.error" tone="warn" :view="config.error" />

      <PanelCard v-if="globalDraft && !rulesOnly" title="全局配置" description="以下均为后台当前真实配置">
        <template #actions>
          <StatusTag v-if="status" :tone="status.aiConfigured ? 'ok' : 'warn'">
            {{ status.aiConfigured ? 'AI 凭据已配置' : 'AI 凭据未配置' }}
          </StatusTag>
          <button type="button" class="btn btn--sm" :disabled="saving || config.refreshing" @click="controller.refresh()">
            {{ config.refreshing ? '刷新中…' : '刷新' }}
          </button>
        </template>

        <form class="form" novalidate @submit.prevent="saveGlobal">
          <Callout v-if="staleGlobal" tone="warn">
            后台配置已变化，但你有未保存的修改。
            <template #actions>
              <button type="button" class="btn btn--sm" @click="reloadGlobalDraft">放弃修改并载入最新</button>
            </template>
          </Callout>

          <div class="field">
            <label class="check-row">
              <input v-model="globalDraft.enabled" type="checkbox" :disabled="saving" aria-describedby="g-enabled-hint" />
              <span>启用回复引擎</span>
            </label>
            <span id="g-enabled-hint" class="field__hint">
              默认关闭。启用后允许后台自动匹配规则；关闭时仍可手动在聊天区生成建议（无规则匹配时将使用 AI 兜底生成）。建议保持关闭，避免自动发送风险。
            </span>
          </div>

          <fieldset class="modes">
            <legend class="field__label">回复模式</legend>
            <label v-for="option in MODE_OPTIONS" :key="option.value" class="mode" :class="{ 'mode--auto': option.value === 'auto' }">
              <input v-model="globalDraft.mode" type="radio" name="reply-mode" :value="option.value" :disabled="saving" />
              <span class="mode__text">
                <span class="mode__label">{{ option.label }}</span>
                <span class="mode__desc">{{ option.description }}</span>
              </span>
            </label>
          </fieldset>

          <Callout v-if="autoDraft" tone="error" title="自动回复存在风险">
            选择「自动回复」并保存后，命中规则的买家消息会不经你确认直接发出，可能误回复、重复回复，也可能触发平台风控。保存时需要再次确认。
          </Callout>

          <div class="form-grid">
            <div class="field">
              <label class="field__label" for="g-cooldown">默认冷却（秒）</label>
              <input id="g-cooldown" v-model="globalDraft.defaultCooldownSec" class="input" inputmode="decimal" :disabled="saving" />
              <span v-if="globalErrors.defaultCooldownSec" class="field__error" role="alert">{{ globalErrors.defaultCooldownSec }}</span>
            </div>
            <div class="field">
              <label class="field__label" for="g-delay">默认发送延迟（秒）</label>
              <input id="g-delay" v-model="globalDraft.defaultDelaySec" class="input" inputmode="decimal" :disabled="saving" />
              <span v-if="globalErrors.defaultDelaySec" class="field__error" role="alert">{{ globalErrors.defaultDelaySec }}</span>
            </div>
            <div class="field">
              <label class="field__label" for="g-max-auto">窗口内每会话自动回复上限</label>
              <input id="g-max-auto" v-model="globalDraft.maxAutoRepliesPerSession" class="input" inputmode="numeric" :disabled="saving" />
              <span v-if="globalErrors.maxAutoRepliesPerSession" class="field__error" role="alert">{{ globalErrors.maxAutoRepliesPerSession }}</span>
            </div>
            <div class="field">
              <label class="field__label" for="g-window">频率保护窗口（分钟）</label>
              <input id="g-window" v-model="globalDraft.autoReplyWindowMin" class="input" inputmode="decimal" :disabled="saving" />
              <span v-if="globalErrors.autoReplyWindowMin" class="field__error" role="alert">{{ globalErrors.autoReplyWindowMin }}</span>
            </div>
            <div class="field">
              <label class="field__label" for="g-pause">人工回复后 AI 暂停（分钟）</label>
              <input id="g-pause" v-model="globalDraft.aiPauseMin" class="input" inputmode="decimal" :disabled="saving" />
              <span v-if="globalErrors.aiPauseMin" class="field__error" role="alert">{{ globalErrors.aiPauseMin }}</span>
            </div>
            <div class="field">
              <label class="field__label" for="g-maxlen">单条消息长度上限</label>
              <input id="g-maxlen" v-model="globalDraft.maxContentLength" class="input" inputmode="numeric" :disabled="saving" />
              <span v-if="globalErrors.maxContentLength" class="field__error" role="alert">{{ globalErrors.maxContentLength }}</span>
            </div>
          </div>

          <div class="form-grid form-grid--wide">
            <div class="field">
              <label class="field__label" for="g-handoff">转人工关键词（每行一个）</label>
              <textarea id="g-handoff" v-model="globalDraft.handoffKeywords" class="input" rows="3" :disabled="saving"></textarea>
              <span v-if="globalErrors.handoffKeywords" class="field__error" role="alert">{{ globalErrors.handoffKeywords }}</span>
              <span v-else class="field__hint">命中后只给出建议并提示人工处理，不会自动发送。</span>
            </div>
            <div class="field">
              <label class="field__label" for="g-blacklist">黑名单用户 ID（每行一个）</label>
              <textarea id="g-blacklist" v-model="globalDraft.blacklist" class="input" rows="3" :disabled="saving"></textarea>
              <span v-if="globalErrors.blacklist" class="field__error" role="alert">{{ globalErrors.blacklist }}</span>
            </div>
          </div>

          <!-- 自动回复二次确认 -->
          <div v-if="pendingPatch" class="danger" role="alertdialog" aria-labelledby="auto-confirm-title" aria-describedby="auto-confirm-desc">
            <h4 id="auto-confirm-title" class="danger__title">确认开启自动回复</h4>
            <p id="auto-confirm-desc" class="danger__text">
              开启后，满足规则的买家消息会由你的账号自动回复，没有人工确认环节。请确认规则已经过充分检查，并了解误发与平台风控风险。随时可以回到这里切回「建议」模式。
            </p>
            <label class="check-row">
              <input v-model="autoAck" type="checkbox" :disabled="saving" />
              <span>我已理解风险，确认开启自动回复</span>
            </label>
            <div class="row">
              <button type="button" class="btn btn--danger" :disabled="!autoAck || saving" @click="confirmAuto">
                {{ saving ? '保存中…' : '确认并保存' }}
              </button>
              <button type="button" class="btn" :disabled="saving" @click="cancelAuto">取消，保持当前设置</button>
            </div>
          </div>

          <Callout v-if="reply.save.scope === 'global' && reply.save.phase === 'failed' && reply.save.error" tone="error" :view="reply.save.error" />
          <Callout v-else-if="reply.save.scope === 'global' && reply.save.phase === 'ok'" tone="ok">全局配置已保存。</Callout>

          <div class="row">
            <button type="submit" class="btn btn--primary" :disabled="saving || !globalDirty || Boolean(pendingPatch)">
              {{ saving && !pendingPatch ? '保存中…' : '保存全局配置' }}
            </button>
            <button type="button" class="btn btn--ghost" :disabled="saving || !globalDirty" @click="reloadGlobalDraft">还原</button>
          </div>
        </form>
      </PanelCard>

      <PanelCard title="回复规则" :description="`共 ${config.rules.length} 条，数值越大越先匹配（上限 ${REPLY_LIMITS.maxRules} 条）`">
        <template #actions>
          <button type="button" class="btn btn--sm" :disabled="saving" @click="startCreate('keyword')">新建关键词规则</button>
          <button type="button" class="btn btn--sm" :disabled="saving" @click="startCreate('ai')">新建 AI 规则</button>
        </template>

        <Callout v-if="reply.save.scope === 'rules' && reply.save.phase === 'failed' && reply.save.error" tone="error" :view="reply.save.error" />
        <Callout v-else-if="reply.save.scope === 'rules' && reply.save.phase === 'ok'" tone="ok">规则已保存。</Callout>

        <EmptyState
          v-if="sortedRules.length === 0 && !editor"
          title="还没有回复规则"
          description="没有规则时不会生成任何回复建议。新建的规则默认处于停用状态，确认无误后再启用。"
        />

        <ul v-if="sortedRules.length > 0" class="rule-list" aria-label="回复规则列表">
          <li v-for="rule in sortedRules" :key="rule.id" class="rule">
            <div class="rule__main">
              <div class="rule__top">
                <span class="rule__name">{{ rule.name }}</span>
                <StatusTag :tone="rule.type === 'ai' ? 'info' : 'accent'">{{ rule.type === 'ai' ? 'AI' : '关键词' }}</StatusTag>
                <StatusTag :tone="rule.enabled ? 'ok' : 'neutral'">{{ rule.enabled ? '已启用' : '已停用' }}</StatusTag>
                <span class="rule__prio">优先级 {{ rule.priority }}</span>
              </div>
              <p class="rule__desc">{{ ruleSummary(rule) }}</p>
              <p v-if="rule.itemIds && rule.itemIds.length > 0" class="rule__desc">仅限商品：{{ rule.itemIds.join('、') }}</p>
            </div>
            <div class="rule__actions">
              <button
                type="button"
                class="btn btn--sm"
                :disabled="saving"
                :aria-label="`${rule.enabled ? '停用' : '启用'}规则 ${rule.name}`"
                @click="controller.setRuleEnabled(rule.id, !rule.enabled)"
              >
                {{ rule.enabled ? '停用' : '启用' }}
              </button>
              <button type="button" class="btn btn--sm" :disabled="saving" :aria-label="`编辑规则 ${rule.name}`" @click="startEdit(rule)">编辑</button>
              <template v-if="confirmDeleteId === rule.id">
                <button type="button" class="btn btn--sm btn--danger" :disabled="saving" @click="removeRule(rule.id)">确认删除</button>
                <button type="button" class="btn btn--sm btn--ghost" @click="confirmDeleteId = null">返回</button>
              </template>
              <button
                v-else
                type="button"
                class="btn btn--sm"
                :disabled="saving"
                :aria-label="`删除规则 ${rule.name}`"
                @click="confirmDeleteId = rule.id"
              >
                删除
              </button>
            </div>
          </li>
        </ul>

        <AppModal :open="Boolean(editor)" :title="editor?.id ? '编辑回复规则' : '新建回复规则'" :busy="saving" @close="closeEditor">
        <Callout v-if="reply.save.phase === 'failed' && reply.save.error" tone="error" :view="reply.save.error" />
        <form v-if="editor" class="editor form" novalidate @submit.prevent="saveRule">
          <h4 class="editor__title">{{ editor.id ? '编辑' : '新建' }}{{ editor.type === 'ai' ? ' AI 规则' : '关键词规则' }}</h4>

          <div class="form-grid">
            <div class="field">
              <label class="field__label" for="r-name">规则名称</label>
              <input id="r-name" v-model="editor.name" class="input" :maxlength="REPLY_LIMITS.maxNameLength" :disabled="saving" />
              <span v-if="editorErrors.name" class="field__error" role="alert">{{ editorErrors.name }}</span>
            </div>
            <div class="field">
              <label class="field__label" for="r-priority">优先级</label>
              <input id="r-priority" v-model="editor.priority" class="input" inputmode="numeric" :disabled="saving" />
              <span v-if="editorErrors.priority" class="field__error" role="alert">{{ editorErrors.priority }}</span>
            </div>
            <div class="field">
              <label class="field__label" for="r-cooldown">规则冷却（秒，留空用全局）</label>
              <input id="r-cooldown" v-model="editor.cooldownSec" class="input" inputmode="decimal" :disabled="saving" />
              <span v-if="editorErrors.cooldownSec" class="field__error" role="alert">{{ editorErrors.cooldownSec }}</span>
            </div>
            <div class="field">
              <label class="field__label" for="r-delay">发送延迟（秒，留空用全局）</label>
              <input id="r-delay" v-model="editor.delaySec" class="input" inputmode="decimal" :disabled="saving" />
              <span v-if="editorErrors.delaySec" class="field__error" role="alert">{{ editorErrors.delaySec }}</span>
            </div>
          </div>

          <div class="field">
            <label class="field__label" for="r-items">限定商品 ID（可选，逗号或空格分隔）</label>
            <input id="r-items" v-model="editor.itemIds" class="input" :disabled="saving" />
            <span v-if="editorErrors.itemIds" class="field__error" role="alert">{{ editorErrors.itemIds }}</span>
          </div>

          <template v-if="editor.type === 'keyword'">
            <div class="field">
              <label class="field__label" for="r-pattern">匹配正则（不区分大小写）</label>
              <input id="r-pattern" v-model="editor.pattern" class="input mono" :maxlength="REPLY_LIMITS.maxPatternLength" :disabled="saving" placeholder="例如：还在吗|在不在" />
              <span v-if="editorErrors.pattern" class="field__error" role="alert">{{ editorErrors.pattern }}</span>
            </div>
            <div class="field">
              <label class="field__label" for="r-reply">命中后回复的文本</label>
              <textarea id="r-reply" v-model="editor.reply" class="input" rows="3" :maxlength="REPLY_LIMITS.maxReplyLength" :disabled="saving"></textarea>
              <span v-if="editorErrors.reply" class="field__error" role="alert">{{ editorErrors.reply }}</span>
            </div>
          </template>

          <template v-else>
            <div class="field">
              <label class="field__label" for="r-prompt">系统提示词（可选，留空用内置）</label>
              <textarea id="r-prompt" v-model="editor.prompt" class="input" rows="4" :disabled="saving"></textarea>
              <span v-if="editorErrors.prompt" class="field__error" role="alert">{{ editorErrors.prompt }}</span>
              <span v-else class="field__hint">不要在这里写入 API Key；含疑似密钥的内容会被拒绝。</span>
            </div>
            <div class="form-grid">
              <div class="field">
                <label class="field__label" for="r-history">携带历史消息条数（留空默认 10）</label>
                <input id="r-history" v-model="editor.maxHistoryMessages" class="input" inputmode="numeric" :disabled="saving" />
                <span v-if="editorErrors.maxHistoryMessages" class="field__error" role="alert">{{ editorErrors.maxHistoryMessages }}</span>
              </div>
              <div class="field">
                <label class="field__label" for="r-model">模型名（可选）</label>
                <input id="r-model" v-model="editor.model" class="input mono" :disabled="saving" />
                <span v-if="editorErrors.model" class="field__error" role="alert">{{ editorErrors.model }}</span>
              </div>
              <div class="field">
                <label class="field__label" for="r-timeout">超时（秒，可选）</label>
                <input id="r-timeout" v-model="editor.timeoutSec" class="input" inputmode="decimal" :disabled="saving" />
                <span v-if="editorErrors.timeoutSec" class="field__error" role="alert">{{ editorErrors.timeoutSec }}</span>
              </div>
            </div>
          </template>

          <label class="check-row">
            <input v-model="editor.enabled" type="checkbox" :disabled="saving" />
            <span>保存后立即启用此规则（新建默认停用）</span>
          </label>

          <div class="row">
            <button type="submit" class="btn btn--primary" :disabled="saving">{{ saving ? '保存中…' : '保存规则' }}</button>
            <button type="button" class="btn" :disabled="saving" @click="closeEditor">取消</button>
          </div>
        </form>
        </AppModal>
      </PanelCard>
    </template>
  </div>
</template>

<style scoped>
.rules {
  display: grid;
  gap: 14px;
}

.blank {
  padding: 18px;
  font-size: 13px;
  color: var(--text-muted);
}

.form {
  display: grid;
  gap: 14px;
}

.modes {
  display: grid;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.mode {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  cursor: pointer;
}

.mode:has(input:checked) {
  border-color: var(--brand-yellow, #FACC15);
  background: var(--brand-yellow-bg, #FEF9C3);
}

.mode--auto:has(input:checked) {
  border-color: var(--error);
  background: var(--error-soft);
}

.mode:has(input:focus-visible) {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}

.mode__text {
  display: grid;
  gap: 2px;
}

.mode__label {
  font-weight: 600;
}

.mode__desc {
  font-size: 12.5px;
  color: var(--text-muted);
}

.danger {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 2px solid var(--error);
  border-radius: var(--radius-control);
  background: var(--error-soft);
}

.danger__title {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--error);
}

.danger__text {
  font-size: 13px;
}

.rule-list {
  display: grid;
  list-style: none;
  margin: 0 0 14px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
}

.rule {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 14px;
  padding: 10px 12px;
}

.rule + .rule {
  border-top: 1px solid var(--border);
}

.rule__main {
  flex: 1 1 260px;
  display: grid;
  gap: 4px;
  min-width: 0;
}

.rule__top {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 8px;
}

.rule__name {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.rule__prio,
.rule__desc {
  font-size: 12.5px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.rule__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.editor {
  padding: 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
}

.editor__title {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}

.mono {
  font-family: var(--mono);
}
</style>
