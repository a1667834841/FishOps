/** 验证 chat.sync.status 的真实 API 行为；只读，不发送消息、不发布商品。 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
if (process.env.FISHOPS_LIVE_SMOKE !== '1' || !process.env.FISHOPS_HOME) { console.error('需要显式开启真实验收与 FISHOPS_HOME'); process.exit(2) }
const root = resolve(import.meta.dirname, '../..')
const dir = join(root, '.test-results', `chat-sync-status-${Date.now()}-${process.pid}`)
await mkdir(dir, { recursive: true, mode: 0o700 })
const config = JSON.parse(await readFile(join(process.env.FISHOPS_HOME, 'config.json'), 'utf8'))
const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' }
const call = async (method, body) => { const response = await fetch(`http://127.0.0.1:${config.port}/v1/${method}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) }); return { status: response.status, body: await response.json() } }
const checks = []
try {
  const invalid = await call('chat.sync.status', { runId: 'bad' })
  if (invalid.status !== 400 || invalid.body.error?.code !== 'BAD_REQUEST') throw new Error('非法 runId 未拒绝')
  checks.push({ name: 'invalid-run-id', status: 'passed' })
  const unknown = await call('chat.sync.status', { runId: '00000000-0000-0000-0000-000000000000' })
  if (unknown.status !== 404 || unknown.body.error?.code !== 'NOT_FOUND') throw new Error('未知 runId 未返回 NOT_FOUND')
  checks.push({ name: 'unknown-run', status: 'passed' })
  const tag = `status-behavior-${Date.now()}`
  const sync = await call('chat.sync', { limit: 1, tag, maxWaitMs: 5000 })
  if (sync.status !== 200 || sync.body.ok !== true || typeof sync.body.data?.runId !== 'string') throw new Error('真实 chat.sync 未成功')
  const runId = sync.body.data.runId
  checks.push({ name: 'sync-run', status: 'passed', completion: sync.body.data.completion })
  const status = await call('chat.sync.status', { runId })
  if (status.status !== 200 || status.body.ok !== true || status.body.data?.runId !== runId || !status.body.data?.result) throw new Error('已提交 run 状态不可查询')
  if (status.body.data.result.committedPages !== sync.body.data.committedPages) throw new Error('进度不一致')
  checks.push({ name: 'committed-run-status', status: 'passed', committedPages: status.body.data.result.committedPages })
  // 缺口可见性：只断言结构与“永不宣称已清除”，只记录计数，不记录 occurrence 内容。
  const gaps = status.body.data.gaps
  if (!gaps || typeof gaps.open !== 'boolean' || gaps.cleared !== false || !Array.isArray(gaps.legacyReasons) || !Array.isArray(gaps.ledger) ||
    gaps.open !== (gaps.legacyReasons.length > 0 || gaps.ledger.length > 0)) throw new Error('缺口快照结构不符合契约')
  checks.push({ name: 'gap-visibility', status: 'passed', open: gaps.open, legacyCount: gaps.legacyReasons.length, ledgerLines: gaps.ledger.length })
  if (sync.body.data.hasMore) {
    const next = await call('chat.sync', { limit: 1, tag, cursor: sync.body.data.nextCursor, maxWaitMs: 5000 })
    if (next.status !== 200 || next.body.ok !== true) throw new Error('续页未成功')
    const latest = await call('chat.sync.status', { runId })
    if (latest.status !== 200 || latest.body.ok !== true || latest.body.data?.result?.committedPages !== next.body.data.committedPages ||
      JSON.stringify(latest.body.data.result) !== JSON.stringify(next.body.data)) throw new Error('状态未推进到最新页')
    checks.push({ name: 'latest-page-status', status: 'passed', committedPages: next.body.data.committedPages })
  } else checks.push({ name: 'latest-page-status', status: 'not-covered', reason: '首屏已到末页' })
  const report = { status: 'passed', checks, runId, at: new Date().toISOString(), scope: '真实同步状态查询；不覆盖外部写操作' }
  const reportPath = join(dir, 'report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify({ ...report, reportPath }))
} catch (error) {
  const report = { status: 'failed', checks, at: new Date().toISOString(), reason: '请求或断言失败；已停止且未重试' }
  const reportPath = join(dir, 'report.json'); await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 }); console.log(JSON.stringify({ ...report, reportPath })); process.exitCode = 1
}
