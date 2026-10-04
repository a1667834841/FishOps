import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  commandTrace, createCommand, createErrorResponse, createResponse, createTrace,
  startCommandTrace, traceCommandCall, type TraceRecord, type CommandEnvelope,
  type ResponseEnvelope,
} from '@fishops/shared'
import { RuntimeClient } from '../../../bridge/runtime-client'
import type { Transport } from '../../../bridge/transport'
import { createBridgeApi } from '../../../../workbench/src/features/shared/bridge-api'

function transport(call: (command: CommandEnvelope) => Promise<ResponseEnvelope>): Transport {
  return { name: 'test', call, onEvent: () => () => {}, setSubscription: () => {}, dispose: () => {} }
}

test('trace 默认关闭，关闭后保留缓冲，clear 清空', () => {
  let outputs = 0
  const trace = createTrace({ sink: () => { outputs += 1 } })
  const command = createCommand('PING', { nonce: 'x', clientTime: 0 })
  startCommandTrace('client', command, trace)('success')
  assert.equal(outputs, 0)
  trace.enable()
  startCommandTrace('client', command, trace)('success')
  assert.equal(trace.read().length, 2)
  trace.disable()
  startCommandTrace('client', command, trace)('error')
  assert.equal(trace.read().length, 2)
  trace.clear()
  assert.equal(trace.exportJson(), '[]')
})

test('缓冲有界，快照隔离，sink 不得修改记录或影响业务', () => {
  const trace = createTrace({ enabled: true, maxRecords: 3, sink: (record) => {
    ;(record as TraceRecord).command = 'secret'
  } })
  const command = createCommand('PING', { nonce: 'x', clientTime: 0 })
  for (let i = 0; i < 4; i += 1) startCommandTrace('client', command, trace)('success')
  assert.equal(trace.read().length, 3)
  const snapshot = trace.read()
  snapshot[0]!.command = 'changed'
  assert.ok(trace.read().every((record) => record.command === 'PING'))
  assert.equal(createTrace({ enabled: true, maxRecords: NaN, sink: () => {} }).read().length, 0)
})

test('只保留允许字段及错误码，不保存正文、URL 或自由文本', () => {
  const trace = createTrace({ enabled: true, sink: () => {} })
  trace.record({
    time: 0, scope: 'client', stage: 'error', traceId: 'secret-token', command: 'secret', code: 'secret',
    payload: { apiKey: 'secret' }, message: 'https://secret', result: 'secret',
  } as TraceRecord)
  assert.deepEqual(trace.read(), [{ time: 0, scope: 'client', stage: 'error', traceId: 'untracked', command: 'UNKNOWN_COMMAND' }])
  assert.doesNotMatch(trace.exportJson(), /secret|payload|result|message/)
})

test('span 只结束一次，三个上下文共享 requestId，并发不串链', async () => {
  const trace = createTrace({ enabled: true, sink: () => {} })
  const commands = [createCommand('PING', { nonce: 'a', clientTime: 0 }), createCommand('PING', { nonce: 'b', clientTime: 0 })]
  await Promise.all(commands.map((command) => traceCommandCall('client', command, async () => {
    const content = startCommandTrace('content', command, trace)
    const background = startCommandTrace('background', command, trace)
    await new Promise((resolve) => setTimeout(resolve, 1))
    background('success')
    background('error')
    content('success')
    return createResponse(command.requestId, command.type, {})
  }, trace)))
  for (const command of commands) {
    const records = trace.read().filter((record) => record.traceId === command.requestId)
    assert.equal(records.length, 6)
    for (const scope of ['client', 'content', 'background']) {
      assert.deepEqual(records.filter((record) => record.scope === scope).map((record) => record.stage), ['start', 'success'])
    }
  }
})

test('请求包装保留原响应/异常，安全记录协议失败、传输异常和超时', async () => {
  const trace = createTrace({ enabled: true, sink: () => { throw Error('sink') } })
  const command = createCommand('PING', { nonce: 'a', clientTime: 0 })
  const response = createErrorResponse(command.requestId, command.type, { code: 'PLATFORM_ERROR', message: 'secret' })
  assert.equal(await traceCommandCall('client', command, async () => response, trace), response)
  for (const code of ['INTERNAL', 'TIMEOUT']) {
    const error = Object.assign(Error('secret'), { code })
    await assert.rejects(traceCommandCall('client', command, async () => { throw error }, trace), (actual) => actual === error)
  }
  assert.deepEqual(trace.read().filter((record) => record.stage !== 'start').map((record) => record.stage), ['error', 'error', 'timeout'])
  assert.doesNotMatch(trace.exportJson(), /secret|sink/)
})

test('RuntimeClient 和真实 BridgeApi 入口都记录成功/失败/等待超时，保留平台错误类别', async () => {
  commandTrace.clear()
  commandTrace.enable()
  try {
    const client = new RuntimeClient({ transport: transport(async (command) => createResponse(command.requestId, command.type, { nonce: 'ok' })) })
    await client.ping('secret')
    const api = createBridgeApi(client, { events: [], timeoutMs: 20 })
    await api.call('PING', { nonce: 'secret', clientTime: 0 })
    const failClient = new RuntimeClient({ transport: transport(async (command) => createErrorResponse(command.requestId, command.type, { code: 'PLATFORM_ERROR', category: 'captcha', message: 'secret' })) })
    const failApi = createBridgeApi(failClient, { events: [], timeoutMs: 20 })
    await assert.rejects(failApi.call('PING', { nonce: 'secret', clientTime: 0 }), (error: any) => error.category === 'captcha')
    const timeoutClient = new RuntimeClient({ transport: transport(() => new Promise(() => {})), timeoutMs: 5 })
    await assert.rejects(timeoutClient.ping())
    const timeoutApi = createBridgeApi(timeoutClient, { events: [], timeoutMs: 5 })
    await assert.rejects(timeoutApi.call('PING', { nonce: 'x', clientTime: 0 }))
    assert.deepEqual(commandTrace.read().map((record) => record.stage), ['start', 'success', 'start', 'success', 'start', 'error', 'start', 'timeout', 'start', 'timeout'])
    assert.doesNotMatch(commandTrace.exportJson(), /secret/)
  } finally {
    commandTrace.disable()
    commandTrace.clear()
  }
})
