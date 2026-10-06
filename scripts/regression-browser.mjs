// 由 ego-browser nodejs 执行；输入只含路径、用例和测试空间 ID，不含凭据。
const fs = await import('node:fs/promises')
const task = regressionInput.spaceId
  ? await taskSpace(regressionInput.spaceId)
  : await taskSpace('FishOps 真实回归')
const page = task.page('p1')
const cases = []

async function command(type, payload) {
  return await page.evaluate(async ({ type, payload }) => await new Promise(resolve => {
    const timer = setTimeout(() => resolve({ ok: false, error: { code: 'TIMEOUT' } }), 30000)
    chrome.runtime.sendMessage({ kind: 'command', protocol: 1, requestId: `regression_${crypto.randomUUID()}`, type, payload, sentAt: Date.now() }, result => {
      clearTimeout(timer)
      resolve(chrome.runtime.lastError ? { ok: false, error: { code: 'COMMUNICATION_FAILED' } } : result)
    })
  }), { type, payload })
}

async function check(id, run) {
  const start = Date.now()
  // 普通用例失败可继续；ego 的接管/停止异常必须向外传播，不能绕过。
  try {
    const detail = await run()
    cases.push({ id, status: 'passed', durationMs: Date.now() - start, ...detail })
  } catch (error) {
    if (/user has taken control|executionStopped|space is inactive|space is unassigned/i.test(String(error))) throw error
    cases.push({ id, status: 'failed', durationMs: Date.now() - start })
  }
}

try {
  await page.goto('chrome://extensions')
  const installed = await page.evaluate(async target => {
    const list = await chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true, includeTerminated: true })
    const item = list.find(i => i.path === target && i.name.startsWith('FishOps Workbench'))
    return item ? { id: item.id, state: item.state } : null
  }, regressionInput.target)
  if (!installed || installed.state !== 'ENABLED') throw new Error('固定测试插件未加载或未启用')
  await page.goto(`chrome-extension://${installed.id}/workbench.html`)
  if (regressionInput.phase === 'preflight') {
    const tasks = await command('TASK_LIST', { status: 'running', limit: 1 })
    const publish = await command('PUBLISH_LIST', { status: 'running', limit: 1 })
    if (!tasks?.ok || !publish?.ok) throw new Error('无法确认运行中任务')
    // 发布 pending 是尚未启动的草稿，重载不会自动执行；只阻止正在运行的操作。
    if (tasks.result.tasks.length || publish.result.tasks.length) throw new Error('存在运行中任务，停止部署')
    console.log('REGRESSION_RESULT:' + JSON.stringify({ ok: true, spaceId: task.spaceId, cases: [] }))
  } else {
    const metadata = JSON.parse(await fs.readFile(regressionInput.target + '/.fishops-agent-build.json', 'utf8'))
    if (metadata.worktree !== regressionInput.root || metadata.commit !== regressionInput.commit) throw new Error('部署来源不是当前 worktree/提交')
    for (const c of regressionInput.cases.commands) await check(c.id, async () => {
      const response = await command(c.type, c.payload)
      if (!response?.ok || (c.id === 'bridge' ? response.result?.[c.resultKey] !== true : !Array.isArray(response.result?.[c.resultKey]))) throw new Error('命令回归失败')
      return {}
    })
    for (const c of regressionInput.cases.pages) await check('page-' + c.id, async () => {
      await page.click(`loc=role:tab[name="${c.tab}"]`)
      await page.waitForSelector('loc=css:main ' + c.selector)
      await page.waitForFunction(({ tab, title }) => {
        const selected = [...document.querySelectorAll('.top-nav [role=tab]')].find(e => e.textContent.trim() === tab)
        return selected?.getAttribute('aria-selected') === 'true' && document.title === title + ' · FishOps Workbench'
      }, c, { timeout: 15000 })
      return {}
    })
    // 通过设置页真实按钮探测，覆盖 UI → Bridge → background → 真实 API 全链路。
    await page.click('loc=role:tab[name="设置"]')
    await page.waitForSelector('loc=css:.settings')
    for (const c of regressionInput.cases.connections) await check('connection-' + c.id, async () => {
      await page.click(`loc=role:button[name="${c.section}"]`)
      await page.waitForFunction(c => {
        const form = document.querySelector(c.input)?.closest('form')
        return [...(form?.querySelectorAll('button') ?? [])].some(e => e.textContent.trim() === c.button && !e.disabled)
      }, c, { timeout: 15000 })
      await page.click(`loc=role:button[name="${c.button}"]`)
      await page.waitForFunction(c => {
        const form = document.querySelector(c.input)?.closest('form')
        return !!form?.querySelector('.form-feedback .callout--ok, .form-feedback .callout--error')
      }, c, { timeout: 60000 })
      const state = await page.evaluate(c => {
        const form = document.querySelector(c.input)?.closest('form')
        return { ok: [...(form?.querySelectorAll('.form-feedback .callout--ok') ?? [])].some(e => e.textContent.includes(c.success)), failed: !!form?.querySelector('.form-feedback .callout--error') }
      }, c)
      if (!state.ok || state.failed) throw new Error('连接测试失败')
      return {}
    })
    const ok = cases.every(c => c.status === 'passed')
    if (ok) await task.finish({ keep: [] })
    console.log('REGRESSION_RESULT:' + JSON.stringify({ ok, spaceId: task.spaceId, cases }))
  }
} catch (error) {
  // 不输出异常对象、DOM 或服务端响应，防止凭据和业务正文混入报告。
  const reasons = ['固定测试插件未加载或未启用', '无法确认运行中任务', '存在运行中任务，停止部署', '部署来源不是当前 worktree/提交']
  const stopped = /user has taken control|executionStopped|space is inactive|space is unassigned/i.test(String(error))
  console.log('REGRESSION_RESULT:' + JSON.stringify({ ok: false, stopped, spaceId: task.spaceId, cases, reason: reasons.includes(error.message) ? error.message : '浏览器回归未完成；检查插件、任务和部署来源' }))
}
