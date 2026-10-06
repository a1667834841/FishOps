/** 统一回归入口：本地检查、真实 E2E 和完整回归，生成可复核的本地报告。 */
import { mkdir, readFile, writeFile, open, rm } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentExtensionDir } from './agent-build.mjs'
import { resolveAgentConfigPath } from './agent-config-path.mjs'
import { regressionPlan, runSteps, readBrowserResult, readSetupResult } from './regression-core.mjs'
import { regressionCases } from './regression-cases.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const mode = process.argv[2] || 'local'

/** 执行单个检查，限制最长运行时间；默认仅将输出写入权限受限的本地日志。 */
async function execute(program, args, { input, logPath, timeout = 600000, capture = false } = {}) {
  const log = logPath ? await open(logPath, 'w', 0o600) : null
  return await new Promise(resolve => {
    let stdout = '', stderr = '', timedOut = false
    const child = spawn(program, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, timeout)
    child.stdout.on('data', chunk => { if (capture) stdout += chunk; if (log) log.write(chunk).catch(() => {}) })
    child.stderr.on('data', chunk => { if (capture) stderr += chunk; if (log) log.write(chunk).catch(() => {}) })
    child.on('error', () => {})
    child.on('close', async code => {
      clearTimeout(timer)
      if (log) await log.close()
      resolve({ ok: code === 0 && !timedOut, exitCode: code, timedOut, stdout, stderr })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

async function main() {
  if (process.argv.length > 3) throw new Error('只接受 local、e2e 或 full 参数')
  const plan = regressionPlan(mode)
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
  const reportDir = join(root, '.regression', new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid)
  await mkdir(reportDir, { recursive: true, mode: 0o700 })
  const browserScript = await readFile(join(root, 'scripts/regression-browser.mjs'), 'utf8')
  const browser = async (phase, spaceId) => {
    const input = `const regressionInput = ${JSON.stringify({ phase, spaceId, root, target: agentExtensionDir, commit, cases: regressionCases })};\n${browserScript}`
    const output = await execute('ego-browser', ['nodejs'], { input, timeout: 240000, capture: true })
    // 浏览器原始输出不写日志；只保存本脚本显式生成的脱敏结果。
    return readBrowserResult(output.stdout, output.stderr, output.exitCode)
  }
  const results = await runSteps(plan, async name => {
    console.log(`开始：${name}`)
    if (name !== 'e2e') {
      const logPath = join(reportDir, name.replaceAll(':', '-') + '.log')
      const result = await execute('npm', ['run', name], { logPath })
      console.log(`${result.ok ? '通过' : '失败'}：${name}`)
      return { ok: result.ok, exitCode: result.exitCode, timedOut: result.timedOut, logPath }
    }
    const lock = agentExtensionDir + '.regression.lock'
    await mkdir(dirname(lock), { recursive: true })
    try { await mkdir(lock) } catch { return { ok: false, reason: '另一组真实回归正在使用固定测试插件' } }
    try {
      const config = JSON.parse(await readFile(await resolveAgentConfigPath(root), 'utf8'))
      if (!config.ai?.apiKey || !config.feishu?.appId || !config.feishu?.appSecret || !config.feishu?.spreadsheetToken) {
        return { ok: false, reason: '完整 E2E 必须配置 AI 和飞书，缺失配置不能跳过' }
      }
      if (!config.reply || config.reply.enabled !== false || config.reply.mode !== 'suggest') {
        return { ok: false, reason: '真实回归必须显式配置 reply.enabled=false、reply.mode=suggest' }
      }
      const requestedSpace = process.env.FISHOPS_REGRESSION_SPACE_ID
      if (requestedSpace && !/^\d+$/.test(requestedSpace)) return { ok: false, reason: '测试空间 ID 非法' }
      const preflight = await browser('preflight', requestedSpace ? Number(requestedSpace) : undefined)
      if (!preflight.ok) return { ...preflight, phase: 'preflight' }
      console.log(`真实回归空间：${preflight.spaceId}；当前无运行中任务`)
      // agent:configure 自身已过滤 ego 原始输出；保留 npm 构建/部署日志供失败定位。
      const setup = await execute('npm', ['run', 'agent:setup'], { capture: true, logPath: join(reportDir, 'setup.log'), timeout: 600000 })
      const setupState = readSetupResult(setup.stdout, setup.stderr, setup.exitCode)
      if (!setupState.ok || !setup.ok) return { ok: false, stopped: setupState.stopped, phase: 'setup', spaceId: preflight.spaceId, reason: 'agent:setup 未完成；见 setup.log' }
      console.log('部署通过：SETUP_COMPLETED')
      const result = await browser('checks', preflight.spaceId)
      for (const c of result.cases ?? []) console.log(`${c.status === 'passed' ? '通过' : '失败'}：${c.id} (${c.durationMs}ms)`)
      return result
    } finally { await rm(lock, { recursive: true, force: true }) }
  })
  const report = { mode, root, commit, dirty, createdAt: new Date().toISOString(), ok: results.every(r => r.status === 'passed'), results }
  const reportPath = join(reportDir, 'report.json')
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(`回归${report.ok ? '通过' : '失败'}，报告：${reportPath}`)
  if (!report.ok) process.exitCode = 1
}

main().catch(() => {
  console.error('回归未完成；请检查命令参数、依赖、本地配置及文件权限。')
  process.exitCode = 1
})
