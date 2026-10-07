/** 独立文件最近一次写入状态；文件名由浏览器提供，不伪造绝对路径。 */
export interface BackupStatus {
  fileName: string | null
  phase: 'unconfigured' | 'saving' | 'saved' | 'error'
  savedAt: number | null
  error: string | null
}
