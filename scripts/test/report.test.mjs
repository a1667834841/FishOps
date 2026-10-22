import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runVerification } from '../../scripts/verify.mjs'

async function createResultRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fishops-verify-report-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('编排生成本次 blocked 报告、摘要和脱敏日志', { timeout: 5000 }, async (t) => {
  const resultRoot = await createResultRoot(t)
  const secret = 'report-test-secret-value'
  const env = { ...process.env, FISHOPS_LIVE_SMOKE: '0', FISHOPS_HOME: '/isolated/home', FISHOPS_EXTENSION_DIST: '/isolated/dist' }
  delete env.FISHOPS_LIFECYCLE_TRIGGER
  const { dir, report } = await runVerification({
    mode: 'e2e',
    env,
    resultRoot,
    runCommand: async (name) => ({
      code: name === 'test:browser-smoke' ? 2 : 0,
      output: name === 'typecheck' ? `Authorization: Bearer ${secret}\ntoken=${secret}\n` : `${name}\n`,
    }),
    log: () => {},
  })

  assert.equal(report.exitCode, 2)
  assert.equal(report.results[0].name, 'typecheck')
  assert.equal(report.results[0].status, 'passed')
  assert.equal(report.results.find((item) => item.name === 'chrome-live-smoke').status, 'blocked')
  assert.equal(report.results.find((item) => item.name === 'chrome-lifecycle').status, 'blocked')

  const diskReport = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'))
  assert.equal(diskReport.exitCode, 2)
  const files = await readdir(dir)
  assert.ok(files.includes('summary.md'))
  assert.ok(files.includes('test-browser-smoke.log'))

  const summary = await readFile(join(dir, 'summary.md'), 'utf8')
  assert.match(summary, /chrome-live-smoke: blocked/)
  assert.match(summary, /chrome-lifecycle: blocked/)

  const log = await readFile(join(dir, 'typecheck.log'), 'utf8')
  assert.ok(!log.includes(secret))
  assert.match(log, /Bearer \[已脱敏\]/)
  assert.match(log, /token=\[已脱敏\]/)
})

test('相同时间启动的验证也使用独立报告目录', { timeout: 5000 }, async (t) => {
  const resultRoot = await createResultRoot(t)
  const now = () => new Date('2026-10-17T00:00:00.000Z')
  const first = await runVerification({
    mode: 'e2e',
    env: { ...process.env, FISHOPS_LIVE_SMOKE: '0' },
    resultRoot,
    runCommand: async (name) => ({ code: name === 'test:browser-smoke' ? 2 : 0, output: '' }),
    log: () => {},
    now,
  })
  const second = await runVerification({
    mode: 'e2e',
    env: { ...process.env, FISHOPS_LIVE_SMOKE: '0' },
    resultRoot,
    runCommand: async (name) => ({ code: name === 'test:browser-smoke' ? 2 : 0, output: '' }),
    log: () => {},
    now,
  })

  assert.notEqual(first.dir, second.dir)
})
