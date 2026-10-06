const localSteps = ['test', 'typecheck', 'build', 'test:security', 'test:smoke', 'test:capture:smoke', 'test:sw-startup']
const artifactSteps = new Set(['test:security', 'test:smoke', 'test:capture:smoke', 'test:sw-startup'])

/** 返回指定回归层级的执行顺序；真实 E2E 内部负责部署。 */
export function regressionPlan(mode) {
  if (mode === 'local') return [...localSteps]
  if (mode === 'e2e') return ['e2e']
  if (mode === 'full') return [...localSteps, 'e2e']
  throw new Error('用法：npm run regression -- local|e2e|full')
}

/** 收集独立失败；构建失败禁止产物检查，任一本地失败禁止 E2E 部署。 */
export async function runSteps(plan, execute) {
  const results = []
  for (const name of plan) {
    const buildFailed = results.some(r => r.name === 'build' && r.status !== 'passed')
    if ((artifactSteps.has(name) && buildFailed) || (name === 'e2e' && results.some(r => r.status !== 'passed'))) {
      results.push({ name, status: 'blocked', durationMs: 0 })
      continue
    }
    const started = Date.now()
    let result
    try { result = await execute(name) } catch { result = { ok: false, reason: '执行异常，见对应日志' } }
    results.push({ ...result, name, status: result.ok ? 'passed' : 'failed', durationMs: Date.now() - started })
  }
  return results
}

/** 浏览器日志仅解析明确的脱敏结果；退出失败和停止信号优先。 */
export function readBrowserResult(stdout = '', stderr = '', status = 0) {
  const combined = `${stdout}\n${stderr}`
  if (/user has taken control|executionStopped|space is inactive|space is unassigned/i.test(combined)) {
    return { ok: false, stopped: true, reason: '浏览器已停止或由用户接管' }
  }
  if (status !== 0) return { ok: false, reason: '浏览器进程未成功退出' }
  try {
    const line = combined.split('\n').findLast(s => s.startsWith('REGRESSION_RESULT:'))
    const result = JSON.parse(line?.slice('REGRESSION_RESULT:'.length))
    if (typeof result?.ok !== 'boolean') throw new Error()
    return result
  } catch { return { ok: false, reason: '浏览器未返回有效回归结果' } }
}

/** npm 的配置包装器已去掉 FISHOPS 前缀，按行识别公开完成标记。 */
export function readSetupResult(stdout = '', stderr = '', status = 0) {
  const combined = `${stdout}\n${stderr}`
  const stopped = /user has taken control|executionStopped|space is inactive|space is unassigned/i.test(combined)
  return { ok: status === 0 && !stopped && combined.split('\n').some(line => /^\s*(?:FISHOPS:\s*)?SETUP_COMPLETED：/.test(line)), stopped }
}
