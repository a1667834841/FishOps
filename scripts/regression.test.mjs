import test from 'node:test'
import assert from 'node:assert/strict'
import { regressionPlan, runSteps, readBrowserResult, readSetupResult } from './regression-core.mjs'

test('完整回归覆盖本地检查，并在 E2E 前部署当前代码', () => {
  assert.deepEqual(regressionPlan('local'), ['test', 'typecheck', 'build', 'test:security', 'test:smoke', 'test:capture:smoke', 'test:sw-startup'])
  assert.deepEqual(regressionPlan('e2e'), ['e2e'])
  assert.equal(regressionPlan('full').at(-1), 'e2e')
  assert.throws(() => regressionPlan('unknown'))
})

test('本地失败继续收集独立检查，但禁止真实部署；异常不丢失前面的结果', async () => {
  const called = []
  const results = await runSteps(['test', 'typecheck', 'build', 'test:smoke', 'e2e'], async name => {
    called.push(name)
    if (name === 'test') return { ok: false }
    if (name === 'build') throw new Error('构建失败')
    return { ok: true }
  })
  assert.deepEqual(called, ['test', 'typecheck', 'build'])
  assert.deepEqual(results.map(r => r.status), ['failed', 'passed', 'failed', 'blocked', 'blocked'])
})

test('浏览器退出失败、用户接管和缺少结果均不能被旧成功标记覆盖', () => {
  const marker = 'REGRESSION_RESULT:' + JSON.stringify({ ok: true, cases: [] })
  assert.equal(readBrowserResult(marker, '', 0).ok, true)
  assert.equal(readBrowserResult(marker, '', 1).ok, false)
  assert.equal(readBrowserResult(marker, 'user has taken control', 0).ok, false)
  assert.equal(readBrowserResult('', '', 0).ok, false)
  assert.equal(readBrowserResult('REGRESSION_RESULT:invalid', '', 0).ok, false)
})

test('npm 部署输出已去掉内部前缀，仍识别完成标记；失败与接管优先', () => {
  const output = ' 配置状态：AI=true，飞书=true\n SETUP_COMPLETED：插件已重载，配置与权限状态已验证。\n'
  assert.equal(readSetupResult(output, '', 0).ok, true)
  assert.equal(readSetupResult(output, '', 1).ok, false)
  assert.equal(readSetupResult(output, 'user has taken control', 0).ok, false)
  assert.equal(readSetupResult('输出包含 SETUP_COMPLETED，但并未完成', '', 0).ok, false)
})
