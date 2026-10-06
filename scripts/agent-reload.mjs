/** 等待未打包插件真正完成重载；普通 reload 回调仅代表已发起操作。 */
export function reloadUnpacked(id, api = chrome.developerPrivate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('插件重载超时')), 15000)
    api.reload(id, { failQuietly: true, populateErrorForUnpacked: true }, error => {
      clearTimeout(timer)
      if (error || (typeof chrome !== 'undefined' && chrome.runtime.lastError)) {
        reject(new Error('插件重载失败'))
      } else resolve(true)
    })
  })
}

/** 在目标扩展自身页面发起自卸载；完成状态由保留的扩展管理页面验证。 */
export function uninstallExtension(id, runtime = chrome.runtime, api = chrome.management) {
  if (runtime.id !== id) throw new Error('卸载页面与目标插件不一致')
  // Chrome 强制确认跨扩展卸载；自卸载允许关闭确认，卸载时当前页面会随之关闭。
  api.uninstallSelf({ showConfirmDialog: false })
  return true
}
