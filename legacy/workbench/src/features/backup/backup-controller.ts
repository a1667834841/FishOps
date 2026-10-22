import { CommandTypes } from '@fishops/shared'
import type { BackupStatus } from '../../../../shared/persistence/backup-status'
import type { BridgeApi } from '../shared/bridge-api'
import { StateStore } from '../shared/state-store'

export interface BackupState { status: BackupStatus | null; error: string | null; busy: boolean }

/** 文件备份的读写状态；轮询仅用于提示，后台写入不依赖页面。 */
export class BackupController extends StateStore<BackupState> {
  private readonly api: BridgeApi | null
  private refreshSequence = 0
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(api: BridgeApi | null) { super({ status: null, error: null, busy: false }); this.api = api }
  start(): void {
    if (!this.api || this.timer !== null) return
    void this.refresh()
    this.timer = setInterval(() => { if (!this.state.busy) void this.refresh() }, 5000)
  }
  resubscribe(): void { void this.refresh() }
  async refresh(): Promise<void> {
    if (!this.api || this.disposed) return
    const sequence = ++this.refreshSequence
    try {
      const status = await this.api.call(CommandTypes.DATA_BACKUP_STATUS, {})
      if (!this.disposed && sequence === this.refreshSequence) this.patch({ status })
    } catch { if (!this.disposed && sequence === this.refreshSequence) this.patch({ error: '无法读取文件备份状态' }) }
  }
  async save(): Promise<void> {
    if (!this.api || this.disposed || this.state.busy) return
    // 保存或恢复前使旧轮询失效，避免旧文件状态覆盖刚完成的结果。
    this.refreshSequence++
    this.patch({ busy: true, error: null })
    try {
      const status = await this.api.call(CommandTypes.DATA_BACKUP_SAVE, {})
      if (!this.disposed) this.patch({ status })
    } catch (error) { if (!this.disposed) this.patch({ error: error instanceof Error ? error.message : '文件保存失败' }) }
    finally { if (!this.disposed) { this.patch({ busy: false }); await this.refresh() } }
  }
  async restore(content: string): Promise<boolean> {
    if (!this.api || this.disposed || this.state.busy) return false
    // 保存或恢复前使旧轮询失效，避免旧文件状态覆盖刚完成的结果。
    this.refreshSequence++
    this.patch({ busy: true, error: null })
    try {
      await this.api.call(CommandTypes.DATA_BACKUP_RESTORE, { content })
      return true
    } catch (error) {
      if (!this.disposed) this.patch({ error: error instanceof Error ? error.message : '文件恢复失败' })
      return false
    } finally { if (!this.disposed) this.patch({ busy: false }) }
  }
  override dispose(): void { if (this.timer !== null) clearInterval(this.timer); this.timer = null; super.dispose() }
}
