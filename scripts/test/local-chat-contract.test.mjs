import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const root = resolve(import.meta.dirname, '../..')
const entry = join(root, 'scripts/test/local-chat-contract.mjs')

for (const hasMore of [false, true]) {
  test(`本地契约脚本分页覆盖分支 hasMore=${hasMore}`, async t => {
    const home = await mkdtemp(join(tmpdir(), 'fishops-contract-http-'))
    t.after(() => rm(home, { recursive: true, force: true }))
    let pages = 0
    const server = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const params = JSON.parse(raw)
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/chat.conversations' && params.limit === 2) {
        pages++
        res.end(JSON.stringify({ ok: true, data: { items: [{ id: pages }], hasMore: pages === 1 && hasMore, nextAfterId: pages } }))
      } else {
        res.statusCode = 400
        res.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST' } }))
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(() => new Promise(resolve => server.close(resolve)))
    await writeFile(join(home, 'config.json'), JSON.stringify({ port: server.address().port, token: 'fake-contract-test-token' }))
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, FISHOPS_LIVE_SMOKE: '1', FISHOPS_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    const timer = setTimeout(() => child.kill(), 5000)
    const [exitCode] = await once(child, 'close')
    clearTimeout(timer)
    assert.equal(stderr, '')
    assert.equal(exitCode, hasMore ? 0 : 2)
    const report = JSON.parse(stdout)
    assert.ok(report.reportPath.startsWith(join(root, '.test-results', 'local-chat-contract-')))
    t.after(() => rm(dirname(report.reportPath), { recursive: true, force: true }))
    assert.equal(report.status, hasMore ? 'passed' : 'partial')
    assert.equal(pages, hasMore ? 2 : 1)
  })
}

test('本地契约脚本未显式授权时在读取配置前停止', () => {
  const result = spawnSync(process.execPath, [entry], {
    env: { ...process.env, FISHOPS_LIVE_SMOKE: '0', FISHOPS_HOME: '/nonexistent/fishops-contract-config' }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /未读取部署/)
})

test('本地契约脚本配置错误时输出固定错误且报告无凭据', async t => {
  const home = await mkdtemp(join(tmpdir(), 'fishops-contract-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const secret = 'contract-secret-never-print'
  await writeFile(join(home, 'config.json'), JSON.stringify({ port: -1, token: secret }))
  const resultRoot = join(root, '.test-results')
  await mkdir(resultRoot, { recursive: true })
  const before = new Set(await readdir(resultRoot))
  const result = spawnSync(process.execPath, [entry], {
    env: { ...process.env, FISHOPS_LIVE_SMOKE: '1', FISHOPS_HOME: home }, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 1)
  assert.ok(!`${result.stdout}${result.stderr}`.includes(secret))
  const added = (await readdir(resultRoot)).filter(name => !before.has(name) && name.startsWith('local-chat-contract-') && name.endsWith(`-${result.pid}`))
  assert.equal(added.length, 1)
  const dir = join(resultRoot, added[0])
  t.after(() => rm(dir, { recursive: true, force: true }))
  const text = await readFile(join(dir, 'report.json'), 'utf8')
  assert.ok(!text.includes(secret))
  assert.deepEqual(JSON.parse(text), { status: 'failed', phase: 'config', checks: [] })
})
