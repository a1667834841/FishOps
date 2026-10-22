/** 对真实 API 执行有界只读行为验收；不发送消息、不发布、不自动重试。 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { smokeDeploymentPaths, verifyExtensionBuild } from './deployment-paths.mjs'

if (process.env.FISHOPS_LIVE_SMOKE !== '1' || process.env.FISHOPS_CHAT_SYNC_BEHAVIOR !== '1') {
  console.error('需要显式开启真实验收与聊天同步行为开关；未读取配置或请求平台。')
  process.exit(2)
}
const root = resolve(import.meta.dirname, '../..')
const dir = join(root, '.test-results', `chat-sync-behavior-${Date.now()}-${process.pid}`)
await mkdir(dir, { recursive: true, mode: 0o700 })
const checks = []
let phase = 'config', requests = 0, status = 'failed'
let extensionBuildId = null
try {
  const { home, dist } = smokeDeploymentPaths()
  const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.token !== 'string' || !config.token) throw new Error()
  phase = 'deployment-identity'
  const identityResponse = await fetch(`http://127.0.0.1:${config.port}/v1/system.status`, {
    method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(10000),
  })
  const identity = await identityResponse.json()
  if (identityResponse.status !== 200 || identity.ok !== true || identity.data?.nativeConnected !== true || identity.data?.page?.present !== true) throw new Error()
  extensionBuildId = await verifyExtensionBuild(dist, identity.data.extensionBuildId)
  checks.push({ name: phase, status: 'passed' })
  const tag = `behavior-sync-${Date.now()}-${process.pid}`
  const call = async params => {
    if (++requests > 5) throw new Error()
    const response = await fetch(`http://127.0.0.1:${config.port}/v1/chat.sync`, {
      method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tag, ...params, maxWaitMs: 5000 }), signal: AbortSignal.timeout(10000),
    })
    const body = await response.json()
    if (body.ok === false && body.error?.code !== 'BAD_REQUEST') throw new Error()
    return { status: response.status, body }
  }
  const requireSuccess = result => {
    if (result.status !== 200 || result.body.ok !== true || !result.body.data || typeof result.body.data !== 'object') throw new Error()
    return result.body.data
  }
  const requireRejected = result => {
    if (result.status !== 400 || result.body.ok !== false || result.body.error?.code !== 'BAD_REQUEST') throw new Error()
  }
  phase = 'first-page'
  const first = requireSuccess(await call({ limit: 2 }))
  if (typeof first.hasMore !== 'boolean' || first.mode !== 'conversations' || first.sessionId !== null || first.committedPages !== 1 || first.completion !== (first.hasMore ? 'more' : 'complete') || first.gapCleared !== false) throw new Error()
  checks.push({ name: phase, status: 'passed' })
  if (!first.hasMore) {
    checks.push({ name: 'continuation', status: 'not-covered', reason: '首屏没有后续页' })
    status = 'partial'
  } else {
    if (typeof first.nextCursor !== 'string' || !first.nextCursor) throw new Error()
    const cursor = first.nextCursor
    phase = 'scope-rejection'
    requireRejected(await call({ limit: 3, cursor }))
    checks.push({ name: phase, status: 'passed' })
    phase = 'continuation'
    const next = requireSuccess(await call({ limit: 2, cursor }))
    if (next.mode !== 'conversations' || next.sessionId !== null || next.committedPages !== 2 || next.gapCleared !== false) throw new Error()
    checks.push({ name: phase, status: 'passed' })
    phase = 'committed-replay'
    const replay = requireSuccess(await call({ limit: 2, cursor }))
    if (!isDeepStrictEqual(next, replay)) throw new Error()
    checks.push({ name: phase, status: 'passed' })
    phase = 'tamper-rejection'
    const index = Math.floor(cursor.length / 2)
    const tampered = cursor.slice(0, index) + (cursor[index] === 'A' ? 'B' : 'A') + cursor.slice(index + 1)
    requireRejected(await call({ limit: 2, cursor: tampered }))
    checks.push({ name: phase, status: 'passed' })
    phase = 'conversation-tag-association'
    const localQuery = async value => {
      const response = await fetch(`http://127.0.0.1:${config.port}/v1/chat.conversations`, {
        method: 'POST', headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tag: value, limit: 100 }), signal: AbortSignal.timeout(10000),
      })
      return requireSuccess({ status: response.status, body: await response.json() })
    }
    const tagged = await localQuery(tag)
    const unrelated = await localQuery(`${tag}-absent`)
    if (!Array.isArray(tagged.items) || !Array.isArray(unrelated.items) || unrelated.items.length !== 0) throw new Error()
    // 已识别的会话数由提交计数给出，不把未支持群聊当成必有本地记录。
    const recognized = first.insertedCount + first.updatedCount + next.insertedCount + next.updatedCount
    if (!Number.isSafeInteger(recognized) || recognized < 0) throw new Error()
    if (recognized > 0 && tagged.items.length === 0) throw new Error()
    checks.push({ name: phase, status: recognized > 0 ? 'passed' : 'not-covered', count: tagged.items.length })
    if (recognized === 0) {
      status = 'partial'
    } else {
      status = 'passed'
    }
  }
} catch {
  checks.push({ name: phase, status: 'failed', reason: '请求或断言失败；已停止且未重试' })
}
const report = { status, requests, extensionBuildId, at: new Date().toISOString(), checks, scope: '真实API续页范围、提交重放与防篡改；不覆盖外部写操作', identityScope: 'SW构建与磁盘产物一致，不单独证明Host源码身份' }
await writeFile(join(dir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
console.log(JSON.stringify({ ...report, reportPath: join(dir, 'report.json') }))
process.exitCode = status === 'passed' ? 0 : status === 'partial' ? 2 : 1
