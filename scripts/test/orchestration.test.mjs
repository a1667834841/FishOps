import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runVerification } from '../../scripts/verify.mjs'

const root = resolve(import.meta.dirname, '../..')

function envWithoutLiveSmoke() {
  // integration 测试不得读取本机已安装部署或凭据。
  const env = { ...process.env, FISHOPS_LIVE_SMOKE: '0' }
  // 测试进程可能由真实门禁启动；默认用例必须显式隔离触发器。
  delete env.FISHOPS_LIFECYCLE_TRIGGER
  return env
}

async function createResultRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fishops-verify-orchestration-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function createRunner(calls, codes = {}) {
  return async (name, context) => {
    calls.push({ name, env: context.env })
    return { code: codes[name] ?? 0, output: `${name}\n` }
  }
}

test('真实浏览器入口未配置时必须失败关闭，不能返回通过', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/test/browser-smoke.mjs')], {
    encoding: 'utf8',
    env: { ...envWithoutLiveSmoke(), FISHOPS_HOME: '/isolated/home', FISHOPS_EXTENSION_DIST: '/isolated/dist' },
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /未执行真实 E2E/)
})

test('e2e 在本地检查通过后执行只读冒烟，并把生命周期标为 blocked', async (t) => {
  const calls = []
  const resultRoot = await createResultRoot(t)
  const { report } = await runVerification({
    mode: 'e2e',
    env: { ...envWithoutLiveSmoke(), FISHOPS_HOME: '/isolated/home', FISHOPS_EXTENSION_DIST: '/isolated/dist' },
    resultRoot,
    runCommand: createRunner(calls, { 'test:browser-smoke': 2 }),
    log: () => {},
  })

  assert.deepEqual(
    calls.map((item) => item.name),
    ['typecheck', 'test:unit', 'test:integration', 'build', 'host:install', 'test:browser-smoke'],
  )
  assert.ok(
    calls
      .filter((item) => !['test:browser-smoke', 'build', 'host:install'].includes(item.name))
      .every((item) => item.env.FISHOPS_LIVE_SMOKE === '0'),
    '本地检查不得读取真实部署',
  )
  assert.equal(
    calls.find((item) => item.name === 'test:browser-smoke')?.env.FISHOPS_LIVE_SMOKE,
    '1',
    '真实模式必须显式向冒烟入口传递开关',
  )
  const smoke = report.results.find((item) => item.name === 'chrome-live-smoke')
  assert.equal(smoke.status, 'blocked')
  assert.equal(smoke.command, 'test:browser-smoke')
  const lifecycle = report.results.find((item) => item.name === 'chrome-lifecycle')
  assert.equal(lifecycle.status, 'blocked')
  assert.equal(report.exitCode, 2)
})

test('只读冒烟成功也不能把未隔离的浏览器生命周期标为通过', async (t) => {
  for (const mode of ['e2e', 'full']) {
    const calls = []
    const resultRoot = await createResultRoot(t)
    const { report } = await runVerification({
      mode,
      env: { ...envWithoutLiveSmoke(), FISHOPS_HOME: '/isolated/home', FISHOPS_EXTENSION_DIST: '/isolated/dist' },
      resultRoot,
      runCommand: createRunner(calls),
      log: () => {},
    })

    assert.ok(calls.some((item) => item.name === 'test:browser-smoke'))
    assert.equal(
      calls.find((item) => item.name === 'test:browser-smoke')?.env.FISHOPS_LIVE_SMOKE,
      '1',
      '真实模式必须显式向冒烟入口传递开关',
    )
    assert.equal(report.results.find((item) => item.name === 'chrome-live-smoke').status, 'passed')
    assert.equal(report.results.find((item) => item.name === 'chrome-lifecycle').status, 'blocked')
    assert.equal(report.exitCode, 2)
  }
})

test('显式生命周期触发器存在时执行观察，不用旧报告冒充通过', async (t) => {
  const calls = [], resultRoot = await createResultRoot(t)
  const { report } = await runVerification({
    mode: 'full',
    env: { ...envWithoutLiveSmoke(), FISHOPS_HOME: '/isolated/home', FISHOPS_EXTENSION_DIST: '/isolated/dist', FISHOPS_LIFECYCLE_TRIGGER: 'true' },
    resultRoot,
    runCommand: createRunner(calls),
    log: () => {},
  })
  assert.ok(calls.some((item) => item.name === 'test:lifecycle-observe'))
  assert.equal(calls.find((item) => item.name === 'test:lifecycle-observe')?.env.FISHOPS_LIVE_SMOKE, '1')
  assert.equal(report.results.find((item) => item.name === 'chrome-lifecycle').status, 'passed')
  assert.equal(report.exitCode, 0)
})

test('前序本地失败时不执行真实冒烟，避免复用旧产物假通过', async (t) => {
  const calls = []
  const resultRoot = await createResultRoot(t)
  const { report } = await runVerification({
    mode: 'e2e',
    env: envWithoutLiveSmoke(),
    resultRoot,
    runCommand: createRunner(calls, { typecheck: 1 }),
    log: () => {},
  })

  assert.ok(!calls.some((item) => item.name === 'test:browser-smoke'))
  const smoke = report.results.find((item) => item.name === 'chrome-live-smoke')
  assert.equal(smoke.status, 'blocked')
  assert.match(smoke.reason, /旧产物/)
  assert.equal(report.exitCode, 1)
})

test('根测试入口包含编排测试且只扫描新架构', async () => {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['test:browser-smoke'], 'node scripts/test/browser-smoke.mjs')
  assert.match(pkg.scripts['test:integration'], /scripts\/test\/orchestration\.test\.mjs/)
  assert.match(pkg.scripts['test:integration'], /scripts\/test\/report\.test\.mjs/)
  assert.deepEqual(pkg.workspaces, ['packages/*', 'apps/*'])
  for (const value of Object.values(pkg.scripts)) assert.ok(!value.includes('legacy/'))
})

test('未指定隔离部署目录时不运行真实冒烟且不读取默认安装', async t => {
  const calls = [], resultRoot = await createResultRoot(t)
  const { report } = await runVerification({ mode: 'e2e', env: envWithoutLiveSmoke(), resultRoot, runCommand: createRunner(calls), log: () => {} })
  assert.ok(!calls.some(item => item.name === 'test:browser-smoke'))
  const smoke = report.results.find(item => item.name === 'chrome-live-smoke')
  assert.equal(smoke.status, 'blocked')
  assert.match(smoke.reason, /FISHOPS_HOME.*FISHOPS_EXTENSION_DIST/)
  assert.equal(report.exitCode, 2)
})
