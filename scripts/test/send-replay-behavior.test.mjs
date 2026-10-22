import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

test('发送重放入口：未知键只查状态，不调用发送 API', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fishops-replay-guard-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const db = new DatabaseSync(join(home, 'fishops.db'))
  db.exec('CREATE TABLE operations(account_id TEXT,method TEXT,idempotency_key TEXT,status TEXT)')
  db.close()
  const methods = []
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk }
    methods.push(req.url)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, data: { account: { userId: 'test-account' } } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolveClose => server.close(resolveClose)))
  await writeFile(join(home, 'config.json'), JSON.stringify({ port: server.address().port, token: 'test-only-token' }))
  const entry = resolve(import.meta.dirname, 'send-replay-behavior.mjs')
  const child = spawn(process.execPath, [entry], {
    env: { ...process.env, FISHOPS_LIVE_SMOKE: '1', FISHOPS_HOME: home, FISHOPS_REPLAY_KEY: 'missing-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const timer = setTimeout(() => child.kill(), 5000)
  const [code] = await once(child, 'close')
  clearTimeout(timer)
  assert.equal(code, 1)
  assert.equal(stderr, '')
  assert.deepEqual(methods, ['/v1/system.status'])
  const report = JSON.parse(stdout)
  t.after(() => rm(dirname(report.reportPath), { recursive: true, force: true }))
  assert.equal(report.status, 'failed')
  assert.deepEqual(report.checks, [])
  assert.ok(!stdout.includes('test-only-token'))
})
