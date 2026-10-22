/** 只重放已成功的发送操作；未知键或非成功状态在调用 API 前停止，禁止补发。 */
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { resolve, join } from 'node:path'

if (process.env.FISHOPS_LIVE_SMOKE !== '1' || !process.env.FISHOPS_HOME || !process.env.FISHOPS_REPLAY_KEY) {
  console.error('需要真实验收开关、隔离目录及已成功的发送幂等键')
  process.exit(2)
}
const home = resolve(process.env.FISHOPS_HOME)
const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port <= 65535)
const db = new DatabaseSync(join(home, 'fishops.db'), { readOnly: true })
const call = async (method, params) => {
  const response = await fetch(`http://127.0.0.1:${config.port}/v1/${method}`, {
    method: 'POST', redirect: 'error',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(params), signal: AbortSignal.timeout(15000),
  })
  return { status: response.status, body: await response.json() }
}
const checks = []
let status = 'failed'
try {
  const current = await call('system.status', {})
  assert.equal(current.body.ok, true)
  const account = current.body.data.account?.userId
  assert.ok(account)
  const row = db.prepare("SELECT * FROM operations WHERE account_id=? AND method='chat.send' AND idempotency_key=?").get(account, process.env.FISHOPS_REPLAY_KEY)
  assert.equal(row?.status, 'succeeded', '只允许重放当前账号已成功操作')
  const fingerprint = JSON.parse(row.fingerprint)
  assert.equal(fingerprint[0], account)
  assert.equal(fingerprint[1], 'chat.send')
  assert.equal(fingerprint[2], row.idempotency_key)
  const params = { ...fingerprint[3], idempotencyKey: row.idempotency_key, maxWaitMs: 10000 }
  const replay = await call('chat.send', params)
  assert.equal(replay.body.ok, true)
  assert.deepEqual(replay.body.data, JSON.parse(row.result_json))
  checks.push({ name: 'persisted-success-replay', status: 'passed' })
  const conflict = await call('chat.send', { ...params, text: params.text === '冲突校验' ? '不同正文' : '冲突校验' })
  assert.equal(conflict.body.error?.code, 'IDEMPOTENCY_CONFLICT')
  checks.push({ name: 'same-key-conflict', status: 'passed' })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM operations WHERE account_id=? AND method='chat.send' AND idempotency_key=?").get(account, row.idempotency_key).n, 1)
  checks.push({ name: 'single-operation-record', status: 'passed' })
  status = 'passed'
} catch {
  // 不输出异常原文，避免账号、正文、参数和凭据落入报告；失败后不重试。
} finally {
  db.close()
}
const dir = resolve(import.meta.dirname, '../../.test-results', `send-replay-${Date.now()}-${process.pid}`)
await mkdir(dir, { recursive: true, mode: 0o700 })
const report = { status, checks, at: new Date().toISOString(), scope: '仅重放当前账号已成功发送操作和冲突拒绝；不证明平台一次送达' }
await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ ...report, reportPath: join(dir, 'report.json') }))
process.exitCode = status === 'passed' ? 0 : 1
