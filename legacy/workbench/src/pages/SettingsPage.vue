<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  PhPalette,
  PhCpu,
  PhTable,
  PhChats,
  PhHeartbeat,
  PhUserCircle,
  PhEye,
  PhEyeSlash,
  PhStethoscope,
} from '@phosphor-icons/vue'
import Callout from '../components/Callout.vue'
import PanelCard from '../components/PanelCard.vue'
import BackupPanel from '../components/BackupPanel.vue'
import StatusTag from '../components/StatusTag.vue'
import { useBridgeController } from '../composables/useBridgeController'
import { useBridgeStatus, type BridgeState } from '../composables/useBridgeStatus'
import { themeOptions, useTheme } from '../composables/useTheme'
import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_AI_MODEL,
  DEFAULT_AI_TIMEOUT_MS,
} from '../features/contracts'
import {
  resolveTargetAiOrigin,
} from '../features/settings/ai-origin-helper'
import type { CapabilityPhase } from '../features/settings/capability-controller'
import {
  inferAiProvider,
  SETTINGS_EVENTS,
  SettingsController,
  type AiConfigInput,
  type FeishuConfigInput,
  type ReplyStrategyDraft,
  type SettingsState,
} from '../features/settings/settings-controller'
import { REPLY_EVENTS, ReplyController, type ReplyState } from '../features/reply/reply-controller'
import { broadcastFeishuTargetChanged } from '../features/products/feishu-schema-controller'

const emit = defineEmits<{ diagnostics: [] }>()

/**
 * 规则 CRUD 面板按需加载：仅在设置页打开「回复策略」分区时渲染，
 * 避免其余分区的组件加载与渲染开销。
 */
const ReplyRulesPanel = defineAsyncComponent(() => import('../components/chat/ReplyRulesPanel.vue'))

const theme = useTheme()
const settingsSections = [
  { id: 'backup', label: '数据文件', icon: PhTable },
  { id: 'appearance', label: '外观', icon: PhPalette },
  { id: 'ai', label: 'AI 配置', icon: PhCpu },
  { id: 'feishu', label: '飞书配置', icon: PhTable },
  { id: 'reply', label: '回复策略', icon: PhChats },
  { id: 'runtime', label: '运行环境', icon: PhHeartbeat },
  { id: 'account', label: '账号与授权', icon: PhUserCircle },
] as const

const activeSection = ref<string>('appearance')

function onNavKeydown(event: KeyboardEvent, sectionId: string): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    activeSection.value = sectionId
  }
}

const { status, inExtension } = useBridgeStatus()

const { state, controller } = useBridgeController<SettingsState, SettingsController>({
  events: SETTINGS_EVENTS,
  timeoutMs: 25000,
  create: (api) => new SettingsController({ api }),
})

const bridgeLabels: Record<BridgeState, string> = {
  unavailable: '不可用（非扩展环境）',
  idle: '尚未检测',
  checking: '检测中',
  online: '已连接',
  error: '异常',
  unauthorized: '闲鱼未登录',
  captcha: '需要验证码',
}

const capabilityTones: Record<CapabilityPhase, 'neutral' | 'info' | 'ok' | 'warn' | 'error'> = {
  idle: 'neutral',
  checking: 'info',
  ok: 'ok',
  warn: 'warn',
  error: 'error',
}

const capabilityLabels: Record<CapabilityPhase, string> = {
  idle: '未检测',
  checking: '检测中',
  ok: '正常',
  warn: '注意',
  error: '异常',
}

// ==================== 1. AI 配置表单与安全 Origin 解析 ====================
// 默认留空，表示保留后台已保存的 endpoint，不以前端写死默认值覆盖用户已有配置
const aiForm = ref<AiConfigInput>({
  baseUrl: '',
  apiKey: '',
  model: '',
  timeoutMs: undefined,
})
const showAiKey = ref(false)
const aiUserTouched = ref({
  model: false,
  timeoutMs: false,
})

/** 计算是否已有配置但无法解析出安全 Origin（如旧版保存的端点无效，未填写新 URL）。 */
const isExistingEndpointInsecure = computed(() => {
  return state.value.ai.configured && !state.value.ai.permissionOrigin && !aiForm.value.baseUrl?.trim()
})

/** 依据输入 / 已存配置解析出的当前目标端点（同步纯计算，保留 http/https scheme）。 */
const currentAiTarget = computed(() =>
  resolveTargetAiOrigin({
    configured: state.value.ai.configured,
    inputUrl: aiForm.value.baseUrl,
    permissionOrigin: state.value.ai.permissionOrigin,
    defaultUrl: DEFAULT_AI_BASE_URL,
  }),
)

/** 当前目标是否为 HTTP（保留 scheme，用于显示明文传输警告）。 */
const currentAiTargetIsHttp = computed(
  () => currentAiTarget.value.ok && (currentAiTarget.value.origin ?? '').startsWith('http://'),
)

/** 当前计算得出的安全目标 Origin（仅 scheme+host）。 */
const currentAiTargetOrigin = computed(() => {
  const target = currentAiTarget.value
  if (target.ok && target.origin) return target.origin
  if (isExistingEndpointInsecure.value) {
    return '（现有端点无效）'
  }
  return '（无有效 HTTP/HTTPS Origin）'
})

// 当后台返回已有模型或超时配置时，仅在用户未触碰编辑且表单为空时进行初始填充，绝不覆盖用户编辑
watch(
  () => [state.value.ai.model, state.value.ai.timeoutMs] as const,
  ([serverModel, serverTimeout]) => {
    if (serverModel && !aiUserTouched.value.model && !aiForm.value.model) {
      aiForm.value.model = serverModel
    }
    if (serverTimeout && !aiUserTouched.value.timeoutMs && aiForm.value.timeoutMs === undefined) {
      aiForm.value.timeoutMs = serverTimeout
    }
  },
  { immediate: true },
)

const currentProvider = computed(() => {
  if (aiForm.value.baseUrl && aiForm.value.baseUrl.trim().length > 0) {
    return inferAiProvider(aiForm.value.baseUrl)
  }
  if (state.value.ai.provider) return state.value.ai.provider
  return 'OpenAI 兼容'
})

async function onSaveAi(): Promise<void> {
  controller.clearAlerts()
  await controller.saveAiConfig({ ...aiForm.value })
  // 保存成功后清空一次性输入的 key 缓存与新输入的 baseUrl，并重置 touched 标记
  if (state.value.ai.savePhase === 'ok') {
    aiForm.value.apiKey = ''
    aiForm.value.baseUrl = ''
    aiUserTouched.value.model = false
    aiUserTouched.value.timeoutMs = false
  }
}

async function onTestAi(): Promise<void> {
  controller.clearAlerts()

  // 1. 判断表单是否有未保存的改动
  const isDirty =
    (aiForm.value.apiKey ?? '').trim().length > 0 ||
    (aiForm.value.baseUrl ?? '').trim().length > 0 ||
    (aiUserTouched.value.model && (aiForm.value.model ?? '').trim() !== (state.value.ai.model ?? '')) ||
    (aiUserTouched.value.timeoutMs && aiForm.value.timeoutMs !== state.value.ai.timeoutMs)

  // 2. HTTP 判定与目标 Origin 信息
  const isHttp = currentAiTargetIsHttp.value
  const origin = currentAiTargetOrigin.value

  await controller.testAiConnection({
    isDirty,
    isHttp,
    origin,
  })
}

// ==================== 2. 飞书配置表单 ====================
const feishuForm = ref<FeishuConfigInput>({
  appId: '',
  appSecret: '',
  spreadsheetToken: '',
  productTableId: '',
  sellerTableId: '',
})
const showAppSecret = ref(false)
const showSpreadsheetToken = ref(false)

async function onSaveFeishu(): Promise<void> {
  controller.clearAlerts()
  await controller.saveFeishuConfig({
    appId: feishuForm.value.appId,
    appSecret: feishuForm.value.appSecret,
    spreadsheetToken: feishuForm.value.spreadsheetToken,
    productTableId: feishuForm.value.productTableId,
    // 只有用户主动输入非空内容时才传，未编辑时绝不传空串覆盖已保存的 sellerTableId
    sellerTableId: feishuForm.value.sellerTableId?.trim() || undefined,
  })
  // 保存成功后清空密钥输入框并广播配置变更
  if (state.value.feishu.savePhase === 'ok') {
    broadcastFeishuTargetChanged({
      appId: feishuForm.value.appId,
      spreadsheetToken: feishuForm.value.spreadsheetToken,
      productTableId: feishuForm.value.productTableId,
    })
    feishuForm.value.appSecret = ''
    feishuForm.value.spreadsheetToken = ''
  }
}

async function onTestFeishu(): Promise<void> {
  controller.clearAlerts()
  await controller.testFeishuConnection()
}

// ==================== 3. 回复策略表单与 AI 暂停 ====================

// 规则 CRUD 复用聊天中心的回复规则控制器：与全局策略共享同一后台来源
//（CHAT_RULES_GET / CHAT_RULES_SET）。规则保存只提交 rules 字段，不会覆盖上方全局策略；
// 事件订阅、前台恢复与卸载清理都由 useBridgeController 统一处理。
const { state: replyRulesState, controller: replyRulesController } = useBridgeController<ReplyState, ReplyController>({
  events: REPLY_EVENTS,
  timeoutMs: 30000,
  create: (api) => new ReplyController({ api }),
})

const replyDraft = ref<ReplyStrategyDraft>({
  enabled: false,
  mode: 'suggest',
  defaultCooldownSec: 60,
  defaultDelaySec: 1,
  maxAutoRepliesPerSession: 5,
  autoReplyWindowMin: 10,
  aiPauseMin: 10,
  blacklistText: '',
  handoffKeywordsText: '转人工, 客服',
})

const pendingAutoConfirm = ref(false)

// 当后台全局回复配置加载后，同步至本地草稿
watch(
  () => state.value.reply.global,
  (global) => {
    if (!global) return
    replyDraft.value = {
      enabled: global.enabled,
      mode: global.mode,
      defaultCooldownSec: Math.round(global.defaultCooldown / 1000),
      defaultDelaySec: Math.round(global.defaultDelay / 1000),
      maxAutoRepliesPerSession: global.maxAutoRepliesPerSession,
      autoReplyWindowMin: Math.round(global.autoReplyWindowMs / 60000),
      aiPauseMin: Math.round(global.aiPauseDurationMs / 60000),
      blacklistText: global.blacklist.join(', '),
      handoffKeywordsText: global.handoffKeywords.join(', '),
    }
  },
  { immediate: true },
)

function parseCsvList(text: string): string[] {
  return text
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function executeSaveReply(confirmedAuto = false): Promise<void> {
  controller.clearAlerts()
  const draft = replyDraft.value
  const patch = {
    enabled: draft.enabled,
    mode: draft.mode,
    defaultCooldown: Math.max(1, draft.defaultCooldownSec) * 1000,
    defaultDelay: Math.max(0, draft.defaultDelaySec) * 1000,
    maxAutoRepliesPerSession: Math.max(1, draft.maxAutoRepliesPerSession),
    autoReplyWindowMs: Math.max(1, draft.autoReplyWindowMin) * 60000,
    aiPauseDurationMs: Math.max(1, draft.aiPauseMin) * 60000,
    blacklist: parseCsvList(draft.blacklistText),
    handoffKeywords: parseCsvList(draft.handoffKeywordsText),
  }

  const result = await controller.saveReplyStrategy(patch, confirmedAuto)
  if (result.needsAutoConfirm) {
    pendingAutoConfirm.value = true
  } else {
    pendingAutoConfirm.value = false
  }
}

function onConfirmAutoSave(): void {
  void executeSaveReply(true)
}

function onCancelAutoSave(): void {
  pendingAutoConfirm.value = false
}

// 倒计时刷新
const nowTick = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  timer = setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const pauseCountdown = computed(() => {
  const st = state.value.reply.status
  if (!st || !st.aiPaused || !st.aiPausedUntil) return null
  const remaining = st.aiPausedUntil - nowTick.value
  if (remaining <= 0) return '即将恢复'
  const mins = Math.floor(remaining / 60000)
  const secs = Math.floor((remaining % 60000) / 1000)
  return `${mins} 分 ${secs} 秒`
})

async function onTogglePause(): Promise<void> {
  const isPaused = state.value.reply.status?.aiPaused ?? false
  if (isPaused) {
    await controller.setAiPause(false)
  } else {
    const duration = Math.max(1, replyDraft.value.aiPauseMin) * 60000
    await controller.setAiPause(true, duration)
  }
}
</script>

<template>
  <div class="page settings">
    <!-- Seline 风格页面轻标题 -->
    <div class="view-header">
      <div class="view-title-group">
        <h1 class="view-title">设置</h1>
        <span class="view-sub">外观、AI、飞书、回复策略、运行环境与授权</span>
      </div>
    </div>

    <!-- 全局实时通信警告提示 -->
    <Callout v-if="state.realtimeError" tone="warn" style="margin-bottom: 16px;">
      {{ state.realtimeError }}
    </Callout>

    <div class="settings-layout">
      <!-- 左侧白卡导航 -->
      <div class="card settings-nav-card">
        <nav class="settings-nav" aria-label="设置分区">
          <button
            v-for="section in settingsSections"
            :key="section.id"
            type="button"
            class="nav-item"
            :class="{ 'is-active': activeSection === section.id }"
            :aria-current="activeSection === section.id ? 'page' : undefined"
            @click="activeSection = section.id"
            @keydown="onNavKeydown($event, section.id)"
          >
            <span class="nav-item__inner">
              <component :is="section.icon" :size="17" aria-hidden="true" />
              <span>{{ section.label }}</span>
            </span>
            <span v-if="activeSection === section.id" class="nav-active-pill" aria-hidden="true"></span>
          </button>
        </nav>
      </div>

      <!-- 右侧白卡设置内容区 -->
      <div class="settings-content">
        <BackupPanel v-if="activeSection === 'backup'" />
        <!-- 1. 外观 -->
        <PanelCard v-show="activeSection === 'appearance'" title="外观" description="选择界面主题，自动保存本地偏好。">
          <div class="appearance-card-body">
            <span class="form-label">主题</span>
            <div class="theme-tabs" role="radiogroup" aria-label="主题选择">
              <button
                v-for="option in themeOptions"
                :key="option.value"
                type="button"
                class="tab-btn"
                :class="{ active: theme.mode.value === option.value }"
                :aria-checked="theme.mode.value === option.value"
                role="radio"
                @click="theme.setMode(option.value)"
              >
                {{ option.label }}
              </button>
            </div>
            <p class="muted-note">与顶部主题切换按钮联动，选择保存在本地。</p>
          </div>
        </PanelCard>

        <!-- 2. AI 配置 -->
        <PanelCard
          v-show="activeSection === 'ai'"
          title="AI 配置"
          description="模型服务与接口凭证。凭据保存在扩展专用存储中，已保存的密钥不回显。"
        >
          <template #actions>
            <span class="pill" :class="state.ai.configured ? 'pill--accent' : 'pill--neutral'">
              {{ state.ai.configured ? `已配置 · ${currentProvider}` : '未配置凭证' }}
            </span>
          </template>

          <form class="form-grid" @submit.prevent="onSaveAi">
            <div class="field">
              <label class="field__label" for="ai-base-url">API Base URL (可选)</label>
              <input
                id="ai-base-url"
                v-model="aiForm.baseUrl"
                class="input"
                type="url"
                placeholder="留空保留后台当前端点；支持 HTTP/HTTPS，如 https://api.deepseek.com/v1 或 http://127.0.0.1:8080/v1"
                :disabled="state.ai.savePhase === 'running'"
              />
              <span class="field__hint">
                留空表示保持扩展已保存的端点；首次未填将由后台采用默认端点。支持 HTTP/HTTPS 与 DeepSeek、通义千问等兼容协议；HTTP 为明文传输，请仅在可信环境使用
              </span>
            </div>

            <!-- AI 接口域名说明区 -->
            <div class="ai-origin-card">
              <div class="ai-origin-card__head">
                <div class="ai-origin-card__meta">
                  <span class="ai-origin-card__title">当前 AI 接口域名</span>
                  <span class="ai-origin-card__origin mono">{{ currentAiTargetOrigin }}</span>
                </div>
              </div>

              <div v-if="isExistingEndpointInsecure" class="form-feedback">
                <Callout tone="error">
                  现有已配置端点无法解析出有效 Origin，请在上方填写合规的 HTTP/HTTPS 地址并保存。
                </Callout>
              </div>

              <!-- HTTP 明文传输风险提示 -->
              <template v-if="currentAiTargetIsHttp">
                <Callout tone="error" title="HTTP 会明文传输 API Key">
                  当前目标为 HTTP 端点，API Key 与请求内容将以明文在网络中传输，可能被中间人窃取。请仅在可信内网 / 本地环境使用，并确认网络链路安全。
                </Callout>
              </template>
            </div>

            <div class="field">
              <label class="field__label" for="ai-api-key">API Key（密钥输入不回显）</label>
              <div class="input-secret-wrap">
                <input
                  id="ai-api-key"
                  v-model="aiForm.apiKey"
                  class="input mono"
                  :type="showAiKey ? 'text' : 'password'"
                  :required="!state.ai.configured"
                  :placeholder="state.ai.configured ? '••••••••（已在后台配置，留空保持原密钥）' : 'sk-...'"
                  :disabled="state.ai.savePhase === 'running'"
                  autocomplete="new-password"
                />
                <button
                  type="button"
                  class="btn btn--ghost btn--sm secret-toggle-btn"
                  :aria-label="showAiKey ? '隐藏密钥' : '显示密钥'"
                  @click="showAiKey = !showAiKey"
                >
                  <component :is="showAiKey ? PhEyeSlash : PhEye" :size="18" aria-hidden="true" />
                </button>
              </div>
              <span class="field__hint">凭据保存在扩展专用存储中；绝不进入日志、诊断或页面明文；已配置状态下留空表示保持原 Key</span>
            </div>

            <div class="form-row">
              <div class="field form-col">
                <label class="field__label" for="ai-model">模型名称 (Model)</label>
                <input
                  id="ai-model"
                  v-model="aiForm.model"
                  class="input"
                  type="text"
                  :placeholder="DEFAULT_AI_MODEL"
                  :disabled="state.ai.savePhase === 'running'"
                  @input="aiUserTouched.model = true"
                />
              </div>

              <div class="field form-col">
                <label class="field__label" for="ai-timeout">超时上限 (毫秒)</label>
                <input
                  id="ai-timeout"
                  v-model.number="aiForm.timeoutMs"
                  class="input"
                  type="number"
                  min="1000"
                  max="300000"
                  step="1000"
                  :placeholder="String(DEFAULT_AI_TIMEOUT_MS)"
                  :disabled="state.ai.savePhase === 'running'"
                  @input="aiUserTouched.timeoutMs = true"
                />
              </div>
            </div>

            <div v-if="state.ai.saveError" class="form-feedback">
              <Callout tone="error">{{ state.ai.saveError }}</Callout>
            </div>
            <div v-if="state.ai.saveSuccess" class="form-feedback">
              <Callout tone="ok">{{ state.ai.saveSuccess }}</Callout>
            </div>
            <div v-if="state.ai.testError" class="form-feedback">
              <Callout tone="error" :view="state.ai.testErrorView">
                {{ state.ai.testError }}
              </Callout>
            </div>
            <div v-if="state.ai.testSuccess" class="form-feedback">
              <Callout tone="ok">{{ state.ai.testSuccess }}</Callout>
            </div>

            <div class="form-actions form-actions--split">
              <button
                type="submit"
                class="btn btn--primary btn--sm"
                :disabled="
                  state.availability !== 'ready' ||
                  state.ai.savePhase === 'running' ||
                  state.ai.testPhase === 'running'
                "
              >
                {{ state.ai.savePhase === 'running' ? '保存中…' : '保存 AI 配置' }}
              </button>

              <button
                type="button"
                class="btn btn--sm"
                :disabled="
                  state.availability !== 'ready' ||
                  state.ai.testPhase === 'running' ||
                  (!state.ai.configured && !aiForm.apiKey)
                "
                @click="onTestAi"
              >
                {{ state.ai.testPhase === 'running' ? '测试连接中…' : '测试 AI 接口' }}
              </button>
            </div>
          </form>
        </PanelCard>

        <!-- 3. 飞书配置 -->
        <PanelCard
          v-show="activeSection === 'feishu'"
          title="飞书配置"
          description="多维表格与机器人权限。连接商品库与分析数据源，已保存的凭据留空即可保留。"
        >
          <template #actions>
            <span class="pill" :class="state.feishu.configured ? 'pill--accent' : 'pill--neutral'">
              {{ state.feishu.configured ? '数据源已配置' : '未配置数据源' }}
            </span>
          </template>

          <form class="form-grid" @submit.prevent="onSaveFeishu">
            <div class="form-row">
              <div class="field form-col">
                <label class="field__label" for="feishu-app-id">App ID</label>
                <input
                  id="feishu-app-id"
                  v-model="feishuForm.appId"
                  class="input mono"
                  type="text"
                  :required="!state.feishu.hasAppId"
                  :placeholder="state.feishu.hasAppId ? '••••••••（已在后台配置）' : 'cli_xxxxxxxxxxxxxx'"
                  :disabled="state.feishu.savePhase === 'running'"
                />
              </div>

              <div class="field form-col">
                <label class="field__label" for="feishu-app-secret">App Secret（密钥输入不回显）</label>
                <div class="input-secret-wrap">
                  <input
                    id="feishu-app-secret"
                    v-model="feishuForm.appSecret"
                    class="input mono"
                    :type="showAppSecret ? 'text' : 'password'"
                    :required="!state.feishu.hasAppSecret"
                    :placeholder="state.feishu.hasAppSecret ? '••••••••（已在后台配置，留空保持）' : '应用密钥'"
                    :disabled="state.feishu.savePhase === 'running'"
                    autocomplete="new-password"
                  />
                  <button
                    type="button"
                    class="btn btn--ghost btn--sm secret-toggle-btn"
                    :aria-label="showAppSecret ? '隐藏 Secret' : '显示 Secret'"
                    @click="showAppSecret = !showAppSecret"
                  >
                    <component :is="showAppSecret ? PhEyeSlash : PhEye" :size="18" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>

            <div class="field">
              <label class="field__label" for="feishu-sheet-token">Spreadsheet Token（电子表格 Token）</label>
              <div class="input-secret-wrap">
                <input
                  id="feishu-sheet-token"
                  v-model="feishuForm.spreadsheetToken"
                  class="input mono"
                  :type="showSpreadsheetToken ? 'text' : 'password'"
                  :required="!state.feishu.hasSpreadsheetToken"
                  :placeholder="state.feishu.hasSpreadsheetToken ? '••••••••（已在后台配置，留空保持）' : '多维表格链接中 /base/ 后面的一长串字符'"
                  :disabled="state.feishu.savePhase === 'running'"
                  autocomplete="new-password"
                />
                <button
                  type="button"
                  class="btn btn--ghost btn--sm secret-toggle-btn"
                  :aria-label="showSpreadsheetToken ? '隐藏 Token' : '显示 Token'"
                  @click="showSpreadsheetToken = !showSpreadsheetToken"
                >
                  <component :is="showSpreadsheetToken ? PhEyeSlash : PhEye" :size="18" aria-hidden="true" />
                </button>
              </div>
              <span class="field__hint">表格 URL 格式：https://bytedance.feishu.cn/base/&lt;SpreadsheetToken&gt;?table=...</span>
            </div>

            <div class="form-row">
              <div class="field form-col">
                <label class="field__label" for="feishu-prod-table">旧商品表 Table ID（可选）</label>
                <input
                  id="feishu-prod-table"
                  v-model="feishuForm.productTableId"
                  class="input mono"
                  type="text"
                  :placeholder="state.feishu.hasProductTableId ? '••••••••（已在后台配置）' : 'tblxxxxxxxxxxxxxx'"
                  :disabled="state.feishu.savePhase === 'running'"
                />
                <span class="field__hint">采集同步会自动创建每日表；此项仅用于旧表分析和手动导出。</span>
              </div>

              <div class="field form-col">
                <label class="field__label" for="feishu-seller-table">卖家表 Table ID (可选)</label>
                <input
                  id="feishu-seller-table"
                  v-model="feishuForm.sellerTableId"
                  class="input mono"
                  type="text"
                  :placeholder="state.feishu.hasSellerTableId ? '••••••••（已在后台配置，留空保持）' : 'tblxxxxxxxxxxxxxx (留空不修改)'"
                  :disabled="state.feishu.savePhase === 'running'"
                />
                <span class="field__hint">未输入时不会修改后台已保存的卖家表 ID</span>
              </div>
            </div>

            <div v-if="state.feishu.saveError" class="form-feedback">
              <Callout tone="error">{{ state.feishu.saveError }}</Callout>
            </div>
            <div v-if="state.feishu.saveSuccess" class="form-feedback">
              <Callout tone="ok">{{ state.feishu.saveSuccess }}</Callout>
            </div>
            <div v-if="state.feishu.testError" class="form-feedback">
              <Callout tone="error">{{ state.feishu.testError }}</Callout>
            </div>
            <div v-if="state.feishu.testSuccess" class="form-feedback">
              <Callout tone="ok">{{ state.feishu.testSuccess }}</Callout>
            </div>

            <div class="form-actions form-actions--split">
              <button
                type="submit"
                class="btn btn--primary btn--sm"
                :disabled="state.availability !== 'ready' || state.feishu.savePhase === 'running'"
              >
                {{ state.feishu.savePhase === 'running' ? '保存中…' : '保存飞书配置' }}
              </button>

              <button
                type="button"
                class="btn btn--sm"
                :disabled="
                  state.availability !== 'ready' ||
                  state.feishu.testPhase === 'running' ||
                  (!state.feishu.configured && !feishuForm.spreadsheetToken)
                "
                @click="onTestFeishu"
              >
                {{ state.feishu.testPhase === 'running' ? '测试连接中…' : '测试飞书连接 (Schema)' }}
              </button>
            </div>
          </form>
        </PanelCard>

        <!-- 4. 回复策略与安全控制 -->
        <PanelCard
          v-show="activeSection === 'reply'"
          title="回复策略与安全控制"
          description="自动回复与兜底规则。默认生成建议，由人工确认发送。"
        >
          <template #actions>
            <div class="pills-group">
              <span class="pill" :class="state.reply.status?.enabled ? 'pill--accent' : 'pill--neutral'">
                {{ state.reply.status?.enabled ? '引擎运行中' : '自动回复已停用' }}
              </span>
              <span class="pill" :class="state.reply.status?.aiPaused ? 'pill--warn' : 'pill--ok'">
                {{ state.reply.status?.aiPaused ? 'AI 暂停中' : 'AI 正常' }}
              </span>
            </div>
          </template>

          <!-- 加载配置异常反馈 -->
          <div v-if="state.reply.loadError" class="form-feedback" style="margin-bottom: 12px;">
            <Callout tone="error">{{ state.reply.loadError }}</Callout>
          </div>

          <!-- AI 暂停状态栏与手动干预控制 -->
          <div class="pause-banner">
            <div class="pause-banner__meta">
              <span class="pause-banner__title">AI 介入状态：</span>
              <span v-if="state.reply.status?.aiPaused" class="pause-banner__desc pause-banner__desc--warn">
                AI 已暂停响应（{{ state.reply.status.aiPauseReason === 'manual' ? '人工手动暂停' : '检测到人工介入' }}，剩余倒计时：<strong>{{ pauseCountdown || '计算中…' }}</strong>）
              </span>
              <span v-else class="pause-banner__desc">
                AI 处于就绪状态，收到买家咨询时按所选模式生成回复建议。
              </span>
            </div>
            <button
              type="button"
              class="btn btn--sm"
              :class="{ 'btn--primary': state.reply.status?.aiPaused }"
              :disabled="state.availability !== 'ready' || state.reply.pausePhase === 'running'"
              @click="onTogglePause"
            >
              {{
                state.reply.pausePhase === 'running'
                  ? '处理中…'
                  : state.reply.status?.aiPaused
                  ? '立即恢复 AI'
                  : `手动暂停 AI (${replyDraft.aiPauseMin}分钟)`
              }}
            </button>
          </div>

          <!-- 暂停控制错误提示 -->
          <div v-if="state.reply.pauseError" class="form-feedback" style="margin-bottom: 12px;">
            <Callout tone="error">{{ state.reply.pauseError }}</Callout>
          </div>

          <form class="form-grid" @submit.prevent="executeSaveReply(false)">
            <!-- 开关与回复模式 -->
            <div class="field">
              <label class="field__label">回复模式 (Reply Mode)</label>
              <div class="mode-cards" role="radiogroup" aria-label="回复模式选择">
                <label
                  class="mode-card"
                  :class="{ 'mode-card--active': replyDraft.mode === 'suggest' }"
                >
                  <input
                    v-model="replyDraft.mode"
                    type="radio"
                    name="reply-mode"
                    value="suggest"
                    class="sr-only"
                  />
                  <div class="mode-card__head">
                    <span class="mode-card__title">AI 建议模式（默认推荐）</span>
                    <span class="pill pill--ok">安全</span>
                  </div>
                  <p class="mode-card__desc">
                    收到买家消息仅在工作台生成回复草稿，必须由人工确认点击发送，绝不自动对外发消息。
                  </p>
                </label>

                <label
                  class="mode-card"
                  :class="{ 'mode-card--active': replyDraft.mode === 'auto' }"
                >
                  <input
                    v-model="replyDraft.mode"
                    type="radio"
                    name="reply-mode"
                    value="auto"
                    class="sr-only"
                  />
                  <div class="mode-card__head">
                    <span class="mode-card__title">AI 自动回复模式</span>
                    <span class="pill pill--warn">自动外发</span>
                  </div>
                  <p class="mode-card__desc">
                    命中规则且通过防频繁与转人工安全闸后自动向买家发送消息。开启需二次确认。
                  </p>
                </label>

                <label
                  class="mode-card"
                  :class="{ 'mode-card--active': replyDraft.mode === 'manual' }"
                >
                  <input
                    v-model="replyDraft.mode"
                    type="radio"
                    name="reply-mode"
                    value="manual"
                    class="sr-only"
                  />
                  <div class="mode-card__head">
                    <span class="mode-card__title">纯人工模式</span>
                    <span class="pill pill--neutral">静默</span>
                  </div>
                  <p class="mode-card__desc">
                    完全关闭自动回复与 AI 建议生成，全部沟通由人工在聊天中心完成。
                  </p>
                </label>
              </div>
            </div>

            <div class="field">
              <label class="switch-row">
                <input
                  v-model="replyDraft.enabled"
                  type="checkbox"
                  class="switch-checkbox"
                />
                <span class="switch-label">
                  <strong>启用回复引擎</strong>
                  <small class="switch-hint">总开关。开启后才会根据上述模式运行；关闭后任何模式均不触发。</small>
                </span>
              </label>
            </div>

            <!-- 保护参数与安全防线 -->
            <div class="form-row">
              <div class="field form-col">
                <label class="field__label" for="reply-cooldown">单会话冷却时间 (秒)</label>
                <input
                  id="reply-cooldown"
                  v-model.number="replyDraft.defaultCooldownSec"
                  class="input"
                  type="number"
                  min="5"
                  max="3600"
                  required
                />
                <span class="field__hint">同一会话在该时间内不重复触发建议或回复</span>
              </div>

              <div class="field form-col">
                <label class="field__label" for="reply-delay">发送前等待延迟 (秒)</label>
                <input
                  id="reply-delay"
                  v-model.number="replyDraft.defaultDelaySec"
                  class="input"
                  type="number"
                  min="0"
                  max="120"
                  required
                />
                <span class="field__hint">模拟真人思考间隔，避免瞬间秒回触发平台风控</span>
              </div>
            </div>

            <div class="form-row">
              <div class="field form-col">
                <label class="field__label" for="reply-max-replies">会话自动回复上限 (次)</label>
                <input
                  id="reply-max-replies"
                  v-model.number="replyDraft.maxAutoRepliesPerSession"
                  class="input"
                  type="number"
                  min="1"
                  max="50"
                  required
                />
                <span class="field__hint">窗口期内单一会话达到此次数后强制停用，防死循环</span>
              </div>

              <div class="field form-col">
                <label class="field__label" for="reply-pause-duration">人工介入暂停时长 (分钟)</label>
                <input
                  id="reply-pause-duration"
                  v-model.number="replyDraft.aiPauseMin"
                  class="input"
                  type="number"
                  min="1"
                  max="180"
                  required
                />
                <span class="field__hint">在手机等外部端手动回复买家后，自动暂停 AI 的时间</span>
              </div>
            </div>

            <div class="field">
              <label class="field__label" for="reply-handoff">转人工关键词（命中立即停用自动回复并提醒人工）</label>
              <input
                id="reply-handoff"
                v-model="replyDraft.handoffKeywordsText"
                class="input"
                type="text"
                placeholder="人工, 客服, 投诉, 电话, 退款"
              />
              <span class="field__hint">用逗号分隔。当买家消息包含这些词语时，安全闸阻止自动发送</span>
            </div>

            <div class="field">
              <label class="field__label" for="reply-blacklist">买家黑名单（用户 ID 列表）</label>
              <input
                id="reply-blacklist"
                v-model="replyDraft.blacklistText"
                class="input"
                type="text"
                placeholder="填入不予自动回复的买家 ID，用逗号分隔"
              />
            </div>

            <!-- 开启自动回复二次确认区 -->
            <div v-if="pendingAutoConfirm" class="confirm-callout">
              <Callout tone="warn">
                <p><strong>安全确认：您正在开启【AI 自动回复】模式</strong></p>
                <p style="margin-top: 4px;">
                  在自动回复模式下，AI 将直接向闲鱼买家发送消息，可能会影响买家体验或触碰平台规则。建议优先使用
                  <strong>建议模式 (suggest)</strong>
                  在聊天中心由人工确认后发送。
                </p>
                <div class="confirm-callout__actions">
                  <button
                    type="button"
                    class="btn btn--primary btn--sm"
                    @click="onConfirmAutoSave"
                  >
                    我已充分了解风险，确认开启并保存
                  </button>
                  <button
                    type="button"
                    class="btn btn--sm"
                    @click="onCancelAutoSave"
                  >
                    取消
                  </button>
                </div>
              </Callout>
            </div>

            <div v-if="state.reply.saveError" class="form-feedback">
              <Callout tone="error">{{ state.reply.saveError }}</Callout>
            </div>
            <div v-if="state.reply.saveSuccess" class="form-feedback">
              <Callout tone="ok">{{ state.reply.saveSuccess }}</Callout>
            </div>

            <div class="form-actions">
              <button
                type="submit"
                class="btn btn--primary btn--sm"
                :disabled="state.availability !== 'ready' || state.reply.savePhase === 'running'"
              >
                {{ state.reply.savePhase === 'running' ? '保存中…' : '保存回复策略' }}
              </button>
            </div>
          </form>
        </PanelCard>

        <!-- 回复规则 CRUD：复用聊天中心面板的 rulesOnly 模式。全局策略仍由上方表单管理，这里不重复渲染全局配置。 -->
        <ReplyRulesPanel
          v-if="activeSection === 'reply'"
          rules-only
          :reply="replyRulesState"
          :controller="replyRulesController"
        />

        <!-- 5. 运行环境 -->
        <PanelCard
          v-show="activeSection === 'runtime'"
          title="运行环境"
          description="页面与扩展连接状态与底层 Bridge 健康指标"
        >
          <template #actions>
            <span
              class="pill"
              :class="status.state === 'online' ? 'pill--ok' : status.state === 'error' ? 'pill--error' : 'pill--neutral'"
            >
              {{ bridgeLabels[status.state] }}
            </span>
          </template>

          <div class="key-value-list">
            <div class="kv-item">
              <span class="kv-key">扩展环境</span>
              <span class="kv-val">
                <StatusTag :tone="inExtension ? 'ok' : 'warn'">
                  {{ inExtension ? '扩展内页 (Chrome Extension)' : '非扩展环境' }}
                </StatusTag>
              </span>
            </div>
            <div class="kv-item">
              <span class="kv-key">Bridge 状态</span>
              <span class="kv-val">
                <StatusTag
                  :tone="status.state === 'online' ? 'ok' : status.state === 'error' ? 'error' : 'neutral'"
                  :dot="status.state === 'checking'"
                  :pulse="status.state === 'checking'"
                >
                  {{ bridgeLabels[status.state] }}
                </StatusTag>
              </span>
            </div>
            <div class="kv-item">
              <span class="kv-key">RTT（单次 PING 往返耗时）</span>
              <span class="kv-val mono">{{ status.rtt !== null ? `${status.rtt} ms` : '暂无' }}</span>
            </div>
            <div class="kv-item">
              <span class="kv-key">错误信息</span>
              <span class="kv-val" :class="{ 'kv__error mono': status.message }">{{ status.message || '无' }}</span>
            </div>
          </div>

          <div class="runtime-actions">
            <button type="button" class="btn btn--sm" @click="emit('diagnostics')">
              <PhStethoscope :size="16" aria-hidden="true" />
              <span>查看连接诊断</span>
            </button>
          </div>
        </PanelCard>

        <!-- 后台模块健康检查 -->
        <PanelCard
          v-show="activeSection === 'runtime'"
          title="后台模块健康检查"
          description="检查扩展后台核心服务与数据源能力可用性。"
        >
          <template #actions>
            <button
              type="button"
              class="btn btn--sm btn--primary"
              :disabled="state.availability !== 'ready' || state.capability.running"
              @click="controller.runCapabilityChecks()"
            >
              {{ state.capability.running ? '检查中…' : '重新检查能力' }}
            </button>
          </template>

          <p v-if="state.availability !== 'ready'" class="placeholder__text">
            当前不是扩展内页，无法检查后台模块能力。
          </p>
          <div v-else class="cap-section">
            <ul class="caps" aria-label="后台模块状态列表">
              <li v-for="item in state.capability.items" :key="item.id" class="cap">
                <div class="cap__main">
                  <span class="cap__label">{{ item.label }}</span>
                  <span class="cap__source mono">{{ item.source }}</span>
                </div>
                <div class="cap__side">
                  <StatusTag
                    :tone="capabilityTones[item.phase]"
                    :dot="item.phase === 'checking'"
                    :pulse="item.phase === 'checking'"
                  >
                    {{ capabilityLabels[item.phase] }}
                  </StatusTag>
                  <span class="cap__summary">{{ item.summary }}</span>
                  <span v-if="item.detail" class="cap__detail">{{ item.detail }}</span>
                </div>
              </li>
            </ul>
          </div>
        </PanelCard>

        <!-- 6. 账号与授权（未实现保留明确空态，绝无示例secret/假成功/新增用量） -->
        <PanelCard
          v-show="activeSection === 'account'"
          title="账号与授权"
          description="管理闲鱼账号的授权方式与运行凭证"
        >
          <div class="placeholder-wrap">
            <span class="placeholder-badge">暂未实现</span>
            <h2 class="placeholder-title">账号与授权功能暂未实现</h2>
            <p class="placeholder-desc">
              当前版本不包含账号体系、登录、会员、套餐与余额。此处不展示任何虚构的账号或授权信息。
            </p>
            <p class="placeholder-note">
              采集、聊天与回复依赖扩展在您已登录的闲鱼网页内运行。无需在工作台输入任何闲鱼账号密码。
            </p>
          </div>
        </PanelCard>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  max-width: 1200px;
}

/* Seline 轻标题 */
.view-header {
  margin-bottom: 20px;
}

.view-title-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.view-title {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.01em;
  color: var(--text);
  line-height: 1.3;
}

.view-sub {
  font-size: 13px;
  color: var(--text-muted);
}

/* Seline 暖纸白卡网格布局 */
.settings-layout {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}

/* 导航卡片 */
.settings-nav-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  padding: 6px;
  position: sticky;
  top: 16px;
}

.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.nav-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  color: var(--text-muted);
  border-radius: var(--radius-control);
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
  user-select: none;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.nav-item__inner {
  display: flex;
  align-items: center;
  gap: 9px;
}

.nav-item:hover {
  background: var(--surface-sunken);
  color: var(--text);
}

.nav-item.is-active {
  background: var(--accent-soft);
  color: var(--accent-text);
  font-weight: 600;
}

.nav-item:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}

.nav-active-pill {
  width: 6px;
  height: 6px;
  border-radius: 9999px;
  background: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
}

.settings-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

@media (max-width: 900px) {
  .settings-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 16px;
  }
  .settings-nav-card {
    position: static;
  }
  .settings-nav {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .nav-item {
    width: auto;
  }
}

/* Seline 黄色 pill 控件与标签徽章 */
.pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  font-size: 11.5px;
  font-weight: 550;
  border-radius: 9999px;
  white-space: nowrap;
  background: var(--surface-sunken);
  color: var(--text-muted);
  border: 1px solid var(--border);
  line-height: 1.4;
}

.pill--accent {
  background: var(--accent-soft);
  color: var(--accent-text);
  border-color: #ffe58f;
}

.pill--ok {
  background: var(--ok-soft);
  color: var(--ok);
  border-color: transparent;
}

.pill--warn {
  background: var(--warn-soft);
  color: var(--warn);
  border-color: transparent;
}

.pill--error {
  background: var(--error-soft);
  color: var(--error);
  border-color: transparent;
}

.pill--neutral {
  background: var(--surface-sunken);
  color: var(--text-muted);
}

.pills-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* 外观主题 Tab 控件 */
.appearance-card-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.form-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 2px;
}

.theme-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
  align-self: flex-start;
}

.tab-btn {
  padding: 6px 16px;
  font-size: 13px;
  border-radius: var(--radius-control);
  border: 0;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.tab-btn:hover {
  color: var(--text);
}

.tab-btn.active {
  background: var(--surface);
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}

.tab-btn:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}

.muted-note {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* 键值列表 (运行环境) */
.key-value-list {
  display: flex;
  flex-direction: column;
}

.kv-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  font-size: 13px;
}

.kv-item:first-child {
  padding-top: 0;
}

.kv-item + .kv-item {
  border-top: 1px solid var(--border);
}

.kv-key {
  color: var(--text-muted);
}

.mono {
  font-family: var(--mono);
}

.kv__error {
  color: var(--error);
  text-align: right;
  overflow-wrap: anywhere;
}

.runtime-actions {
  margin-top: 16px;
}

/* 表单布局 */
.form-grid {
  display: grid;
  gap: 16px;
}

.form-row {
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}

.form-col {
  flex: 1 1 240px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field__label {
  font-size: 13px;
  font-weight: 550;
  color: var(--text);
}

.field__hint {
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.45;
}

.input {
  width: 100%;
  height: 36px;
  padding: 0 12px;
  font-size: 13.5px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  background: var(--surface);
  color: var(--text);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.input:focus {
  outline: none;
  border-color: var(--focus);
  box-shadow: 0 0 0 2px var(--focus);
}

.input:disabled {
  opacity: 0.6;
  background: var(--surface-sunken);
  cursor: not-allowed;
}

.input-secret-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.input-secret-wrap .input {
  padding-right: 58px;
}

.secret-toggle-btn {
  position: absolute;
  right: 4px;
  height: 28px;
  padding: 0 8px;
  font-size: 12px;
  background: transparent;
  border: 0;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 4px;
}

.secret-toggle-btn:hover {
  background: var(--surface-sunken);
  color: var(--text);
}

.form-feedback {
  margin-top: 4px;
}

.form-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}

.form-actions--split {
  justify-content: space-between;
}

/* 回复模式卡片 */
.mode-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}

.mode-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}

.mode-card:hover {
  border-color: var(--border-strong);
}

.mode-card--active {
  border-color: #ffd000;
  background: var(--surface);
  box-shadow: 0 0 0 1px #ffd000;
}

.mode-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mode-card__title {
  font-size: 13px;
  font-weight: 650;
  color: var(--text);
}

.mode-card__desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.45;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

/* 开关行 */
.switch-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: var(--surface-sunken);
  border-radius: var(--radius-control);
  border: 1px solid var(--border);
  cursor: pointer;
}

.switch-checkbox {
  margin-top: 3px;
  accent-color: var(--accent);
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.switch-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.switch-label strong {
  font-size: 13px;
}

.switch-hint {
  font-size: 12px;
  color: var(--text-muted);
}

/* 暂停控制横幅 */
.pause-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 11px 14px;
  margin-bottom: 16px;
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  font-size: 13px;
}

.pause-banner__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.pause-banner__title {
  font-weight: 600;
}

.pause-banner__desc {
  color: var(--text-muted);
}

.pause-banner__desc--warn {
  color: var(--warn);
}

/* 二次确认区 */
.confirm-callout {
  margin: 6px 0;
}

.confirm-callout__actions {
  display: flex;
  gap: 10px;
  margin-top: 10px;
}

/* 后台能力检查列表 */
.cap-section {
  display: flex;
  flex-direction: column;
}

.caps {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}

.cap {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
}

.cap:first-child {
  padding-top: 0;
}

.cap + .cap {
  border-top: 1px solid var(--border);
}

.cap__main {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.cap__label {
  font-size: 13px;
  font-weight: 600;
}

.cap__source {
  font-size: 11.5px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.cap__side {
  display: grid;
  justify-items: end;
  gap: 4px;
  text-align: right;
}

.cap__summary {
  font-size: 12.5px;
  overflow-wrap: anywhere;
}

.cap__detail {
  font-size: 11.5px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.placeholder__text {
  font-size: 13px;
  color: var(--text-muted);
}

/* AI 域名信息卡片 */
.ai-origin-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--radius-control);
  background: var(--surface-sunken);
  border: 1px solid var(--border);
}

.ai-origin-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.ai-origin-card__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ai-origin-card__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.ai-origin-card__origin {
  font-size: 12px;
  color: var(--text-muted);
  background: var(--surface);
  padding: 2px 7px;
  border-radius: 4px;
  border: 1px solid var(--border);
}

/* 账号与授权未实现明确空态 (Seline 白卡空态) */
.placeholder-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 44px 20px;
  gap: 10px;
}

.placeholder-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 550;
  border-radius: 9999px;
  background: var(--warn-soft);
  color: var(--warn);
  border: 1px solid rgba(242, 184, 75, 0.3);
}

.placeholder-title {
  font-size: 16px;
  font-weight: 650;
  color: var(--text);
  margin-top: 4px;
}

.placeholder-desc {
  max-width: 480px;
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.6;
}

.placeholder-note {
  max-width: 480px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
  margin-top: 2px;
}

@media (max-width: 599px) {
  .cap {
    flex-direction: column;
  }

  .cap__side {
    justify-items: start;
    text-align: left;
  }

  .pause-banner {
    flex-direction: column;
    align-items: flex-start;
  }

  .form-actions--split {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
