/** 只读本地 HTTP 契约验收，不发起平台同步或外部写操作。 */
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { smokeDeploymentPaths } from './deployment-paths.mjs'

if (process.env.FISHOPS_LIVE_SMOKE !== '1') {
  console.error('需要 FISHOPS_LIVE_SMOKE=1；未读取部署或执行验收。')
  process.exit(2)
}
const root = resolve(import.meta.dirname, '../..')
const dir = join(root, '.test-results', `local-chat-contract-${Date.now()}-${process.pid}`)
await mkdir(dir, { recursive: true, mode: 0o700 })
const checks = []
let phase = 'config'
try {
  const { home } = smokeDeploymentPaths()
  const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
  assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port <= 65535)
  assert.ok(typeof config.token === 'string' && config.token.length > 0)
  const call = async (method, params) => {
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/${method}`, {
      method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(params), signal: AbortSignal.timeout(10000),
    })
    return { status: response.status, body: await response.json() }
  }
  phase = 'conversation-pagination'
  const first = await call('chat.conversations', { limit: 2 })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.ok(Array.isArray(first.body.data.items))
  assert.equal(typeof first.body.data.hasMore, 'boolean')
  assert.ok(first.body.data.items.length <= 2)
  if (first.body.data.hasMore) {
    assert.ok(first.body.data.items.length > 0)
    assert.ok(first.body.data.nextAfterId != null)
    const next = await call('chat.conversations', { limit: 2, afterId: first.body.data.nextAfterId })
    assert.equal(next.status, 200)
    assert.equal(next.body.ok, true)
    assert.ok(Array.isArray(next.body.data.items) && next.body.data.items.length > 0 && next.body.data.items.length <= 2)
    assert.equal(typeof next.body.data.hasMore, 'boolean')
    const ids = new Set(first.body.data.items.map(item => item.id))
    assert.equal(ids.size, first.body.data.items.length)
    assert.ok(first.body.data.items.every(item => item.id != null))
    assert.ok(next.body.data.items.every(item => item.id != null))
    assert.equal(new Set(next.body.data.items.map(item => item.id)).size, next.body.data.items.length)
    assert.ok(next.body.data.items.every(item => !ids.has(item.id)))
    checks.push({ name: phase, status: 'passed', counts: [first.body.data.items.length, next.body.data.items.length] })
  } else {
    checks.push({ name: phase, status: 'not-covered', reason: '本地会话不足两页' })
  }
  phase = 'invalid-parameters'
  for (const [method, params] of [
    ['chat.messages', { limit: 2 }], ['chat.conversations', { limit: 0 }],
    ['chat.conversations', { afterId: -1 }], ['chat.sync', { limit: 101 }],
  ]) {
    const result = await call(method, params)
    assert.equal(result.status, 400)
    assert.equal(result.body.ok, false)
    assert.equal(result.body.error.code, 'BAD_REQUEST')
  }
  checks.push({ name: phase, status: 'passed', count: 4 })
  const report = { status: checks.some(check => check.status === 'not-covered') ? 'partial' : 'passed',
    scope: '本地会话分页与非法参数，不包含平台同步、发送或发布', checks }
  await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ ...report, reportPath: join(dir, 'report.json') }))
  if (report.status === 'partial') process.exitCode = 2
} catch {
  await writeFile(join(dir, 'report.json'), JSON.stringify({ status: 'failed', phase, checks }), { mode: 0o600 })
  console.error(`本地聊天契约验收失败，阶段：${phase}；未输出凭据或业务正文。`)
  process.exitCode = 1
}
