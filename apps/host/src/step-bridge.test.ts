import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { NativeBridge } from './bridge.ts'
import { encodeFrame, FrameDecoder } from './framing.ts'

const request = (accountId = 'acct') => ({ requestId: 'call-1', method: 'search.suggest' as const, params: { keyword: 'lamp' }, context: { accountId, tabId: 7, documentId: 'doc-1' } })
const hello = (input: PassThrough, account: unknown = { userId: 'acct', nick: 'A' }) => input.write(encodeFrame({ kind: 'hello', protocolVersion: 1, extensionVersion: 'x', account } as any))
const wires = (buffers: Buffer[]) => { const d = new FrameDecoder(); return buffers.flatMap(b => d.push(b)) }

test('step 帧真实编解码与未知 data 透传；只匹配终结 id', async t => {
  const input = new PassThrough(), output = new PassThrough(), sent: Buffer[] = []
  output.on('data', b => sent.push(Buffer.from(b)))
  const bridge = new NativeBridge(input, output, () => {})
  t.after(() => { bridge.close(); input.destroy(); output.destroy() }); hello(input)
  const result = bridge.callStep(request())
  const frame = wires(sent)[0] as any
  assert.equal(frame.kind, 'request-step'); assert.equal(frame.context.accountId, 'acct')
  input.write(encodeFrame({ kind: 'step-result', id: 'stale', terminal: true, ok: true, data: {} } as any))
  input.write(encodeFrame({ kind: 'step-result', id: frame.id, terminal: true, ok: true, data: { arbitrary: true } } as any))
  assert.deepEqual(await result, { arbitrary: true })
})

test('step 在途唯一，真实错误终结后释放 host 内槽位', async t => {
  const input = new PassThrough(), output = new PassThrough(), sent: Buffer[] = []; output.on('data', b => sent.push(Buffer.from(b)))
  const bridge = new NativeBridge(input, output, () => {}); t.after(() => { bridge.close(); input.destroy(); output.destroy() }); hello(input)
  const first = bridge.callStep(request()); await assert.rejects(bridge.callStep(request()), { code: 'BAD_REQUEST' })
  const frame = wires(sent)[0] as any
  input.write(encodeFrame({ kind: 'step-result', id: frame.id, terminal: true, ok: false, error: { code: 'INTERNAL', message: 'failed' } } as any))
  await assert.rejects(first, (e: any) => e.apiError.code === 'INTERNAL')
  const second = bridge.callStep(request()); const next = wires(sent).at(-1) as any
  input.write(encodeFrame({ kind: 'step-result', id: next.id, terminal: true, ok: true, data: null } as any)); assert.equal(await second, null)
})

test('账号切换等待真实终结后报 ACCOUNT_CHANGED', async t => {
  const input = new PassThrough(), output = new PassThrough(), sent: Buffer[] = []; output.on('data', b => sent.push(Buffer.from(b)))
  const bridge = new NativeBridge(input, output, () => {}); t.after(() => { bridge.close(); input.destroy(); output.destroy() }); hello(input)
  const pending = bridge.callStep(request()); const frame = wires(sent)[0] as any
  input.write(encodeFrame({ kind: 'event', type: 'account.changed', data: { account: { userId: 'other', nick: 'B' } } } as any))
  input.write(encodeFrame({ kind: 'step-result', id: frame.id, terminal: true, ok: true, data: 'old' } as any))
  await assert.rejects(pending, { code: 'ACCOUNT_CHANGED' })
})

test('native 断线拒绝 host 等待并清理监听器（不代表页面 fetch 已终结）', async t => {
  const input = new PassThrough(), output = new PassThrough(), bridge = new NativeBridge(input, output, () => {})
  hello(input); const pending = bridge.callStep(request()); input.destroy()
  await assert.rejects(pending, { code: 'EXTENSION_OFFLINE' })
  assert.equal(input.listenerCount('data'), 0); assert.equal(input.listenerCount('end'), 0); assert.equal(input.listenerCount('close'), 0); assert.equal(input.listenerCount('error'), 0)
  t.after(() => { bridge.close(); output.destroy() })
})

test('无效请求不占用单步槽位，未知 id 不推进等待', async t => {
  const input = new PassThrough(), output = new PassThrough(), sent: Buffer[] = []; output.on('data', b => sent.push(Buffer.from(b)))
  const bridge = new NativeBridge(input, output, () => {}); t.after(() => { bridge.close(); input.destroy(); output.destroy() }); hello(input)
  await assert.rejects(bridge.callStep({ ...request(), params: { keyword: '' } } as any), { code: 'BAD_REQUEST' })
  const pending = bridge.callStep(request()), frame = wires(sent)[0] as any
  input.write(encodeFrame({ kind: 'step-result', id: 'unknown', terminal: true, ok: true, data: 2 } as any))
  assert.equal(bridge.ready, true)
  input.write(encodeFrame({ kind: 'step-result', id: frame.id, terminal: true, ok: true, data: 3 } as any))
  assert.equal(await pending, 3)
})

test('扩展方向收到 request-step 时失败关闭通道', async t => {
  const input = new PassThrough(), output = new PassThrough(), bridge = new NativeBridge(input, output, () => {})
  t.after(() => { bridge.close(); input.destroy(); output.destroy() }); hello(input)
  input.write(encodeFrame({ kind: 'request-step', id: 'wrong-direction', ...request() } as any))
  assert.equal(bridge.ready, false)
  assert.equal(input.listenerCount('data'), 0)
})

test('页面定位按 id 匹配，成功只返回 tab/document 且不占用单步槽位', async t => {
  const input = new PassThrough(), output = new PassThrough(), sent: Buffer[] = []
  output.on('data', b => sent.push(Buffer.from(b)))
  const bridge = new NativeBridge(input, output, () => {})
  t.after(() => { bridge.close(); input.destroy(); output.destroy() }); hello(input)
  const pending = bridge.callResolvePage('acct')
  const frame = wires(sent)[0] as any
  assert.deepEqual(frame, { kind: 'resolve-page', id: frame.id, accountId: 'acct' })
  input.write(encodeFrame({ kind: 'page-context', id: 'stale', context: { tabId: 8, documentId: 'other' } } as any))
  input.write(encodeFrame({ kind: 'page-context', id: frame.id, context: { tabId: 7, documentId: 'doc-1' } } as any))
  assert.deepEqual(await pending, { tabId: 7, documentId: 'doc-1' })
  const step = bridge.callStep(request())
  const stepFrame = wires(sent)[1] as any
  input.write(encodeFrame({ kind: 'step-result', id: stepFrame.id, terminal: true, ok: true, data: 1 } as any))
  assert.equal(await step, 1)
})

test('页面定位在途唯一，失败原因原样映射', async t => {
  const input = new PassThrough(), output = new PassThrough(), sent: Buffer[] = []
  output.on('data', b => sent.push(Buffer.from(b)))
  const bridge = new NativeBridge(input, output, () => {})
  t.after(() => { bridge.close(); input.destroy(); output.destroy() }); hello(input)
  const first = bridge.callResolvePage('acct')
  await assert.rejects(bridge.callResolvePage('acct'), { code: 'BAD_REQUEST' })
  const frame = wires(sent)[0] as any
  input.write(encodeFrame({ kind: 'page-context', id: frame.id, context: null, reason: 'LOGIN_REQUIRED' } as any))
  await assert.rejects(first, { code: 'LOGIN_REQUIRED' })
})

test('页面定位超时、断线与账号变化都不伪造上下文', async t => {
  const input = new PassThrough(), output = new PassThrough()
  const bridge = new NativeBridge(input, output, () => {}, 20)
  t.after(() => { bridge.close(); input.destroy(); output.destroy() }); hello(input)
  await assert.rejects(bridge.callResolvePage('acct'), { code: 'TIMEOUT' })

  const input2 = new PassThrough(), output2 = new PassThrough()
  const bridge2 = new NativeBridge(input2, output2, () => {})
  hello(input2)
  const dropped = bridge2.callResolvePage('acct')
  input2.destroy()
  await assert.rejects(dropped, { code: 'EXTENSION_OFFLINE' })
  t.after(() => { bridge2.close(); output2.destroy() })

  const input3 = new PassThrough(), output3 = new PassThrough(), sent: Buffer[] = []
  output3.on('data', b => sent.push(Buffer.from(b)))
  const bridge3 = new NativeBridge(input3, output3, () => {})
  t.after(() => { bridge3.close(); input3.destroy(); output3.destroy() }); hello(input3)
  const changed = bridge3.callResolvePage('acct')
  const frame = wires(sent)[0] as any
  input3.write(encodeFrame({ kind: 'event', type: 'account.changed', data: { account: { userId: 'other', nick: 'B' } } } as any))
  input3.write(encodeFrame({ kind: 'page-context', id: frame.id, context: { tabId: 7, documentId: 'doc-1' } } as any))
  await assert.rejects(changed, { code: 'ACCOUNT_CHANGED' })
})

test('生产执行组合先定位返回上下文，再只调用一次单步', async t => {
  const input = new PassThrough(), output = new PassThrough(), sent: Buffer[] = []
  output.on('data', b => sent.push(Buffer.from(b)))
  const bridge = new NativeBridge(input, output, () => {})
  t.after(() => { bridge.close(); input.destroy(); output.destroy() }); hello(input)
  const pending = bridge.callPageStep({
    requestId: 'call-9', method: 'item.detail', params: { itemId: '9' }, accountId: 'acct',
  })
  const pageFrame = wires(sent)[0] as any
  input.write(encodeFrame({ kind: 'page-context', id: pageFrame.id, context: { tabId: 7, documentId: 'doc-1' } } as any))
  await new Promise<void>(resolve => setImmediate(resolve))
  const frames = wires(sent)
  assert.equal(frames.length, 2)
  assert.equal(frames.filter(frame => frame.kind === 'request-step').length, 1)
  const stepFrame = frames[1] as any
  assert.deepEqual(stepFrame.context, { accountId: 'acct', tabId: 7, documentId: 'doc-1' })
  input.write(encodeFrame({ kind: 'step-result', id: stepFrame.id, terminal: true, ok: true, data: { itemId: '9' } } as any))
  assert.deepEqual(await pending, { itemId: '9' })
})

test('页面定位失败时不发送单步', async t => {
  const input = new PassThrough(), output = new PassThrough(), sent: Buffer[] = []
  output.on('data', b => sent.push(Buffer.from(b)))
  const bridge = new NativeBridge(input, output, () => {})
  t.after(() => { bridge.close(); input.destroy(); output.destroy() }); hello(input)
  const pending = bridge.callPageStep({
    requestId: 'call-10', method: 'search.items', params: { keyword: '手机' }, accountId: 'acct',
  })
  const pageFrame = wires(sent)[0] as any
  input.write(encodeFrame({ kind: 'page-context', id: pageFrame.id, context: null, reason: 'PAGE_NOT_READY' } as any))
  await assert.rejects(pending, { code: 'PAGE_NOT_READY' })
  assert.equal(wires(sent).filter(frame => frame.kind === 'request-step').length, 0)
})

test('聊天单页先定位固定上下文并传递终结data，坏参数不发步骤', async t => {
  const input = new PassThrough(), output = new PassThrough(), sent: Buffer[] = []
  output.on('data', b => sent.push(Buffer.from(b)))
  const bridge = new NativeBridge(input, output, () => {})
  t.after(() => { bridge.close(); input.destroy(); output.destroy() }); hello(input)
  const params = { mode: 'messages' as const, sessionId: 's', anchor: '100', limit: 2 }
  await assert.rejects(bridge.callStep({ ...request(), method: 'chat.sync.page', params: { ...params, limit: 101 } }), { code: 'BAD_REQUEST' })
  await assert.rejects(bridge.callStep({ ...request(), method: 'chat.send' } as any), { code: 'BAD_REQUEST' })
  assert.equal(sent.length, 0)
  const pending = bridge.callPageStep({ requestId: 'chat-call', method: 'chat.sync.page', params, accountId: 'acct' })
  const resolve = wires(sent)[0] as any
  input.write(encodeFrame({ kind: 'page-context', id: resolve.id, context: { tabId: 9, documentId: 'chat-doc' } }))
  await new Promise<void>(done => setImmediate(done))
  const frame = wires(sent)[1] as any
  assert.equal(frame.method, 'chat.sync.page')
  assert.deepEqual(frame.params, params)
  assert.deepEqual(frame.context, { accountId: 'acct', tabId: 9, documentId: 'chat-doc' })
  const data = { mode: 'messages', messages: [], hasMore: false, nextAnchor: null, unsupportedCount: 0 }
  input.write(encodeFrame({ kind: 'step-result', id: frame.id, terminal: true, ok: true, data }))
  assert.deepEqual(await pending, data)
  assert.equal(wires(sent).filter(frame => frame.kind === 'request-step').length, 1)
})

test('step 失败码挂在顶层 code，经调度器 toError 后仍是 RISK_BLOCKED 而非 INTERNAL', async t => {
  const input = new PassThrough(), output = new PassThrough(), sent: Buffer[] = []; output.on('data', b => sent.push(Buffer.from(b)))
  const bridge = new NativeBridge(input, output, () => {}); t.after(() => { bridge.close(); input.destroy(); output.destroy() }); hello(input)
  const pending = bridge.callStep(request()); const frame = wires(sent)[0] as any
  input.write(encodeFrame({ kind: 'step-result', id: frame.id, terminal: true, ok: false, error: { code: 'RISK_BLOCKED', message: 'captcha', phase: 'read' } } as any))
  await assert.rejects(pending, (e: any) => e.code === 'RISK_BLOCKED' && e.phase === 'read' && e.apiError.code === 'RISK_BLOCKED')
})
