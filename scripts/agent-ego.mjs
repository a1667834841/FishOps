// 本文件由 ego-browser nodejs 执行，使用其 TaskSpace API。
const fs = await import('node:fs/promises')
const target = agentInput.target
const config = agentInput.operation === 'uninstall' ? {} : JSON.parse(await fs.readFile(agentInput.configPath, 'utf8'))
let previous
try { previous = JSON.parse(await fs.readFile(agentInput.statePath, 'utf8')) } catch (error) {
  if (error.code !== 'ENOENT') throw new Error('测试空间记录无法读取，请检查本地状态文件')
}
// 配置未完成时续用同一个测试空间，避免重试时新建重复任务。
const task = previous
  ? previous.finished ? await claimTaskSpace(previous.spaceId) : await taskSpace(previous.spaceId)
  : await taskSpace(`FishOps Agent 配置初始化 ${Date.now()}`)
console.log(`FISHOPS: 测试空间：${task.spaceId}`)
const managedPages = await task.pages()
const tabs = managedPages.length ? [] : await task.tabs()
const activeTab = tabs.find(tab => tab.active) || tabs[0]
const page = managedPages.length ? managedPages[0] : activeTab ? await task.adopt(activeTab.page) : task.page('p1')
await fs.writeFile(agentInput.statePath, JSON.stringify({ spaceId: task.spaceId, finished: false }))
await page.goto('chrome://extensions')
const extensions = await page.evaluate(async () => {
  const items = await new Promise(resolve => chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true }, resolve))
  return items.filter(item => item.name.startsWith('FishOps Workbench')).map(item => ({ id: item.id, path: item.path, state: item.state }))
})
const installed = extensions.find(item => item.path === target)
async function removeAndVerify(id) {
  const item = extensions.find(item => item.id === id)
  if (item.state !== 'ENABLED') await page.evaluate(id => chrome.management.setEnabled(id, true), id)
  // 管理页保留用于验收；目标自身页面随自卸载关闭，不能等待其回调作为完成证据。
  const selfPage = await task.newPage()
  await selfPage.goto(`chrome-extension://${id}/workbench.html`)
  await selfPage.evaluate(uninstallExtension, id)
  await page.waitForFunction(async id => {
    const items = await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true })
    return !items.some(item => item.id === id)
  }, id, { timeout: 15000 })
}
if (agentInput.operation === 'uninstall') {
  const localInstances = extensions.filter(item => item.path)
  for (const item of localInstances) await removeAndVerify(item.id)
  console.log(localInstances.length ? `FISHOPS: 已卸载 ${localInstances.length} 个本地 FishOps 实例。` : 'FISHOPS: 本地 FishOps 未安装，卸载步骤正常完成。')
  await task.finish({ keep: [page.label] })
  await fs.writeFile(agentInput.statePath, JSON.stringify({ spaceId: task.spaceId, finished: true }))
  console.log('FISHOPS: SETUP_COMPLETED：卸载状态已验证，本地配置文件和构建目录已保留。')
} else {
if (!installed) {
  await fs.writeFile(agentInput.statePath, JSON.stringify({ spaceId: task.spaceId, finished: false }))
  console.log(`FISHOPS: INSTALL_REQUIRED：首次使用请在 ego lite 的扩展管理页手动加载固定目录：${target}`)
  throw new Error('首次使用尚未加载固定目录插件；手动加载后重新运行 npm run agent:configure')
}
if (installed.state !== 'ENABLED') {
  await page.evaluate(id => chrome.management.setEnabled(id, true), installed.id)
}
await page.evaluate(reloadUnpacked, installed.id)
if (config.ai) {
  const endpoint = new URL(config.ai.baseUrl || 'https://api.openai.com/v1')
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('AI 接口 URL 不合法')
  }
  // manifest 已静态声明全域名 host_permissions，此步确保开发版显式记录指定域名（若有需要）。
  await page.evaluate(({ id, pattern }) => chrome.developerPrivate.addHostPermission(id, pattern), {
    id: installed.id, pattern: `${endpoint.origin}/*`,
  })
}
await page.goto(`chrome-extension://${installed.id}/workbench.html`)
const status = await page.evaluate(async config => {
  async function call(type, payload) {
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('配置命令超时')), 15000)
      chrome.runtime.sendMessage({ kind: 'command', protocol: 1, requestId: `agent_${crypto.randomUUID()}`, type, payload, sentAt: Date.now() }, result => {
        clearTimeout(timer)
        if (chrome.runtime.lastError) reject(new Error('配置通信失败'))
        else resolve(result)
      })
    })
    if (!response?.ok) throw new Error(`配置命令失败：${type}`)
    return response.result
  }
  // 仅读取存在性状态；不返回凭据，不自动调用远端接口。
  if (config.ai) await call('AI_CONFIG_SET', config.ai)
  if (config.feishu) await call('FEISHU_CONFIG_SET', config.feishu)
  if (config.reply) await call('CHAT_RULES_SET', { global: config.reply })
  const ai = await call('AI_CONFIG_STATUS', {})
  const feishu = await call('FEISHU_CONFIG_STATUS', {})
  const permission = ai.permissionOrigin ? await chrome.permissions.contains({ origins: [`${ai.permissionOrigin}/*`] }) : false
  return { aiConfigured: ai.configured, feishuConfigured: feishu.configured, aiPermissionGranted: permission }
}, config)
console.log(`FISHOPS: 配置状态：AI=${status.aiConfigured}，飞书=${status.feishuConfigured}，AI 域名权限=${status.aiPermissionGranted}`)
if (config.ai && !status.aiPermissionGranted) throw new Error('AI 接口域名权限验证失败')
console.log('FISHOPS: 请确认闲鱼网页版已登录，并刷新现有闲鱼页面使新插件生效；本命令不自动发送消息或执行远端写入。')
await task.finish({ keep: [page.label] })
await fs.writeFile(agentInput.statePath, JSON.stringify({ spaceId: task.spaceId, finished: true }))
console.log('FISHOPS: SETUP_COMPLETED：插件已重载，配置与权限状态已验证。')
}
