<script setup lang="ts">
import { ref } from 'vue'
import PanelCard from './PanelCard.vue'
import Callout from './Callout.vue'
import { useBridgeController } from '../composables/useBridgeController'
import { BackupController, type BackupState } from '../features/backup/backup-controller'
import { backupHandleStore, type BackupFileHandle } from '../../../shared/persistence/file-handle'

const { state, controller } = useBridgeController<BackupState, BackupController>({ events: [], timeoutMs: 60000, create: api => new BackupController(api) })
const localError = ref<string | null>(null)
const message = ref<string | null>(null)
const selecting = ref(false)
const input = ref<HTMLInputElement | null>(null)
async function selectFile(): Promise<void> {
  localError.value = null; message.value = null; selecting.value = true
  try {
    const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<BackupFileHandle> }).showSaveFilePicker
    if (!picker) throw new Error('当前浏览器不支持选择备份文件，请使用支持 File System Access 的 Chromium 浏览器')
    const handle = await picker({ suggestedName: 'fishops-data.json', types: [{ description: 'FishOps 数据文件', accept: { 'application/json': ['.json'] } }] })
    if ((await handle.getFile()).size > 0) throw new Error('此文件已有内容。请先用恢复入口读取，保存时选择新文件，避免覆盖原备份')
    await (await backupHandleStore()).set(handle)
    await controller.save()
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) localError.value = error instanceof Error ? error.message : '选择文件失败'
  } finally { selecting.value = false }
}
async function authorize(): Promise<void> {
  localError.value = null
  try {
    const handle = await (await backupHandleStore()).get()
    if (!handle || await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('尚未获得文件写入权限')
    await controller.save()
  } catch (error) { localError.value = error instanceof Error ? error.message : '重新授权失败' }
}
async function restore(event: Event): Promise<void> {
  localError.value = null; message.value = null
  const element = event.target as HTMLInputElement
  const file = element.files?.[0]
  if (!file) return
  try {
    if (file.size > 50 * 1024 * 1024) throw new Error('备份文件超过 50 MB')
    if (await controller.restore(await file.text())) message.value = '文件已合并恢复。任务不会自动执行；请选择新的保存文件以继续自动备份。'
  } catch (error) { localError.value = error instanceof Error ? error.message : '文件读取失败' }
  finally { element.value = '' }
}
</script>

<template>
  <PanelCard title="数据文件" description="首次选择独立文件后，商品与任务变化会在后台自动保存。卸载插件不会删除此文件。">
    <p>保存位置：{{ state.status?.fileName || '尚未选择文件' }}</p>
    <p class="muted">文件位于您在选择窗口指定的目录。浏览器不提供绝对路径；请记录该目录。</p>
    <p role="status">{{ state.status?.phase === 'saved' ? `已保存 · ${new Date(state.status.savedAt!).toLocaleString('zh-CN')}` : state.status?.phase === 'saving' ? '正在保存…' : state.status?.phase === 'error' ? '保存失败' : '尚未保存到独立文件' }}</p>
    <Callout v-if="localError || state.error || state.status?.error" tone="error">{{ localError || state.status?.error || state.error }}</Callout>
    <Callout v-if="message" tone="ok">{{ message }}</Callout>
    <div class="backup-actions">
      <button class="btn" :disabled="state.busy || selecting" @click="selectFile">选择保存文件</button>
      <button class="btn" :disabled="state.busy || !state.status?.fileName" @click="controller.save()">立即保存</button>
      <button class="btn" :disabled="state.busy || !state.status?.fileName" @click="authorize">重新授权文件</button>
      <button class="btn" :disabled="state.busy" @click="input?.click()">从文件恢复</button>
      <input ref="input" type="file" accept=".json,application/json" aria-label="选择恢复文件" class="backup-input" @change="restore" />
    </div>
    <p class="muted">包含本地商品、采集快照及采集、分析、发布任务历史。聊天与配置不包含在此文件中。飞书和官方在售商品仍由原服务读取；恢复不会写入这些服务。</p>
    <p class="muted">浏览器重启后可能需重新授权。恢复会保留较新的记录，采集暂停等待手动恢复，分析与发布只保留历史。文件含商品与任务信息，请保存到私人目录。</p>
  </PanelCard>
</template>
<style scoped>
.backup-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: 16px 0; }
.backup-input { display: none; }
p { margin-bottom: 12px; line-height: 1.6; }
</style>
