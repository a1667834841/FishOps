<script setup lang="ts">
import Callout from './Callout.vue'
import { useBridgeController } from '../composables/useBridgeController'
import { BackupController, type BackupState } from '../features/backup/backup-controller'
const emit = defineEmits<{ settings: [] }>()
const { state } = useBridgeController<BackupState, BackupController>({ events: [], create: api => new BackupController(api) })
</script>
<template>
  <Callout v-if="state.status?.phase === 'error'" tone="error">
    数据文件保存异常：{{ state.status.error }}
    <button class="btn btn--sm" @click="emit('settings')">查看数据文件设置</button>
  </Callout>
</template>
