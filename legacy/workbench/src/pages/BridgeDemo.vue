<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { EventTypes, type EventEnvelope, type PingResult } from '@fishops/shared'
import { BridgeError, createRuntimeClient } from '@fishops/bridge'
import StatusTag from '../components/StatusTag.vue'
import { isExtensionContext, setBridgeStatus } from '../composables/useBridgeStatus'

interface LogEntry {
  id: number
  at: string
  level: 'info' | 'success' | 'warn' | 'error'
  text: string
}

/** Bridge 客户端：非扩展环境会自动退化为 postMessage 传输层。 */
const client = createRuntimeClient()

const inExtension = computed(() => isExtensionContext())

const demoEvents = [EventTypes.WORKER_STARTED, EventTypes.PING_RECEIVED, EventTypes.DEMO_TICK]

const pingLoading = ref(false)
const pingResult = ref<PingResult | null>(null)
const pingRtt = ref<number | null>(null)
const lastError = ref<string | null>(null)
const publishText = ref('来自 Workbench 的问候')
const logs = ref<LogEntry[]>([])

let logSeq = 0
let stopAny: (() => void) | null = null

function log(level: LogEntry['level'], text: string): void {
  const at = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  logs.value.unshift({ id: ++logSeq, at, level, text })
  if (logs.value.length > 100) logs.value.length = 100
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

async function doPing(): Promise<void> {
  if (pingLoading.value) return
  pingLoading.value = true
  lastError.value = null
  setBridgeStatus({ state: 'checking' })
  const startedAt = performance.now()
  try {
    const result = await client.ping()
    pingRtt.value = Math.round(performance.now() - startedAt)
    pingResult.value = result
    setBridgeStatus({ state: 'online', rtt: pingRtt.value, message: null })
    log('success', `PONG · nonce=${result.nonce} · pingCount=${result.pingCount} · ${pingRtt.value}ms`)
  } catch (error) {
    const message = error instanceof BridgeError ? `${error.code}: ${error.message}` : String(error)
    lastError.value = message
    setBridgeStatus({ state: 'error', message })
    log('error', `PING 失败 · ${message}`)
  } finally {
    pingLoading.value = false
  }
}

async function doPublish(): Promise<void> {
  if (!inExtension.value) return
  try {
    const result = await client.publish(EventTypes.DEMO_TICK, {
      message: publishText.value,
      tick: Date.now(),
    })
    log('info', `PUBLISH DEMO_TICK · delivered=${result.delivered}`)
  } catch (error) {
    log('error', `PUBLISH 失败 · ${error instanceof Error ? error.message : String(error)}`)
  }
}

function clearLogs(): void {
  logs.value = []
}

onMounted(() => {
  log('info', `transport=${client.transportName} · inExtension=${inExtension.value}`)
  stopAny = client.onAny((event: EventEnvelope) => {
    log('info', `EVENT ${event.type} · ${JSON.stringify(event.payload)}`)
  })
  client.subscribe(demoEvents)
  if (inExtension.value) void doPing()
  else log('warn', '当前不是扩展内页，请通过 chrome-extension://<id>/workbench.html 打开')
})

onBeforeUnmount(() => {
  stopAny?.()
  client.dispose()
})
</script>

<template>
  <div class="diag">
    <div class="row">
      <StatusTag :tone="inExtension ? 'ok' : 'warn'" mono>
        {{ inExtension ? '扩展内页' : '非扩展环境' }}
      </StatusTag>
      <StatusTag mono>transport: {{ client.transportName }}</StatusTag>
    </div>

    <p v-if="!inExtension" class="notice" role="alert">
      当前不是扩展内页，PING 会走 <code>postMessage</code> 通道（需要 content bridge）。
      请通过 <code>chrome-extension://&lt;id&gt;/workbench.html</code> 打开以获得完整功能。
    </p>

    <article class="card">
      <h3 class="card__title">Bridge 连通性</h3>
      <p class="card__hint">向 background service worker 发送 PING，验证「请求 / 响应」链路。</p>
      <div class="row">
        <button type="button" class="btn btn--primary" :disabled="pingLoading" @click="doPing">
          {{ pingLoading ? 'PING 中…' : '发送 PING' }}
        </button>
        <span v-if="pingRtt !== null" class="rtt">往返 {{ pingRtt }} ms</span>
      </div>

      <dl v-if="pingResult" class="kv">
        <div><dt>nonce</dt><dd>{{ pingResult.nonce }}</dd></div>
        <div><dt>PING 累计次数</dt><dd>{{ pingResult.pingCount }}</dd></div>
        <div><dt>worker 启动于</dt><dd>{{ formatTime(pingResult.workerStartedAt) }}</dd></div>
        <div><dt>server time</dt><dd>{{ formatTime(pingResult.serverTime) }}</dd></div>
      </dl>
      <p class="hint-small">
        刷新页面后 <code>pingCount</code> 仍会累加，说明计数持久化在 <code>chrome.storage.session</code>。
      </p>
      <p v-if="lastError" class="error" role="alert">{{ lastError }}</p>
    </article>

    <article class="card">
      <h3 class="card__title">事件订阅 / 发布</h3>
      <p class="card__hint">
        已订阅：<code>{{ demoEvents.join(', ') }}</code>
      </p>
      <div class="row">
        <label class="sr-only" for="publish-text">要发布的消息内容</label>
        <input id="publish-text" v-model="publishText" class="input publish-input" placeholder="要发布的消息内容" />
        <button type="button" class="btn" :disabled="!inExtension" @click="doPublish">发布 DEMO_TICK</button>
      </div>
      <p class="hint-small">发布后 background 会把事件广播给订阅者，可在下方日志看到。</p>
    </article>

    <article class="card card--log">
      <div class="log__head">
        <h3 class="card__title">事件日志</h3>
        <button type="button" class="btn btn--ghost btn--sm" @click="clearLogs">清空</button>
      </div>
      <ul class="log" aria-live="polite">
        <li v-for="entry in logs" :key="entry.id" class="log__item" :class="`log__item--${entry.level}`">
          <span class="log__time">{{ entry.at }}</span>
          <span class="log__text">{{ entry.text }}</span>
        </li>
        <li v-if="logs.length === 0" class="log__empty">暂无事件。</li>
      </ul>
    </article>
  </div>
</template>

<style scoped>
.diag {
  display: grid;
  gap: 14px;
}

.notice {
  padding: 12px 14px;
  background: var(--warn-soft);
  border-radius: var(--radius-control);
  font-size: 13px;
  color: var(--warn);
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-panel);
  padding: 16px 18px;
}

.card--log {
  padding-bottom: 8px;
}

.card__title {
  margin-bottom: 2px;
  font-size: 14px;
  font-weight: 650;
}

.card__hint {
  margin-bottom: 14px;
  font-size: 12.5px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.publish-input {
  flex: 1 1 160px;
  width: auto;
  min-width: 0;
}

.rtt {
  font-size: 13px;
  font-family: var(--mono);
  color: var(--ok);
}

.kv {
  margin-top: 16px;
  display: grid;
  gap: 8px;
}

.kv > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.kv dt {
  color: var(--text-muted);
}

.kv dd {
  font-family: var(--mono);
  overflow-wrap: anywhere;
  text-align: right;
}

.hint-small {
  margin-top: 14px;
  font-size: 12px;
  color: var(--text-muted);
}

.error {
  margin-top: 12px;
  padding: 8px 10px;
  font-size: 13px;
  border-radius: var(--radius-control);
  background: var(--error-soft);
  color: var(--error);
  overflow-wrap: anywhere;
}

.log__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.log {
  max-height: 320px;
  overflow-y: auto;
}

.log__item {
  display: flex;
  gap: 12px;
  padding: 7px 0;
  border-top: 1px solid var(--border);
  font-size: 12.5px;
  font-family: var(--mono);
}

.log__time {
  color: var(--text-muted);
  flex: none;
}

.log__text {
  overflow-wrap: anywhere;
}

.log__item--success .log__text {
  color: var(--ok);
}

.log__item--warn .log__text {
  color: var(--warn);
}

.log__item--error .log__text {
  color: var(--error);
}

.log__empty {
  padding: 14px 0;
  font-size: 13px;
  color: var(--text-muted);
}
</style>
