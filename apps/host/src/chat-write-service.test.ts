import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HostDatabase } from './database.ts'
import { createChatWriteService } from './chat-write-service.ts'
const input={sessionId:'s',receiverId:'r',text:'询价',idempotencyKey:'k'}
function fixture(){const db=new HostDatabase(':memory:');let calls=0;const deps:any={db,accountId:()=> 'a',schedule:async(_i:any,fn:any)=>fn(),executeSend:async()=>{calls++;return{messageId:'m',sentAt:1}}};return{db,service:createChatWriteService(deps),calls:()=>calls,deps}}
test('成功发送只执行一次，重复幂等返回已有结果',async()=>{const f=fixture();try{assert.deepEqual(await f.service.send(input),{messageId:'m',sentAt:1});assert.deepEqual(await f.service.send(input),{messageId:'m',sentAt:1});assert.equal(f.calls(),1)}finally{f.db.close()}})
test('同key异参冲突，未知结果不自动重发',async()=>{const f=fixture();try{f.deps.executeSend=async()=>{f.deps._calls=(f.deps._calls??0)+1;throw Object.assign(new Error(),{code:'TIMEOUT'})};await assert.rejects(f.service.send(input),{code:'RESULT_UNKNOWN'});await assert.rejects(f.service.send(input),{code:'RESULT_UNKNOWN'});assert.equal(f.deps._calls,1);assert.throws(()=>f.db.reserveOperation('a','chat.send','k','other'),{code:'IDEMPOTENCY_CONFLICT'})}finally{f.db.close()}})
test('排队取消不执行且终结claim，同key可再次派发',async()=>{const f=fixture();try{const c=new AbortController();c.abort();await assert.rejects(f.service.send(input,c.signal),{code:'CANCELLED'});assert.equal(f.calls(),0);const op=f.db.getOperation('a','chat.send','k');assert.equal(op?.status,'failed');assert.equal(op?.errorCode,'CANCELLED');assert.deepEqual(await f.service.send(input),{messageId:'m',sentAt:1});assert.equal(f.calls(),1)}finally{f.db.close()}})

test('并发同key只允许一个service实例派发', async () => {
  const db = new HostDatabase(':memory:')
  try {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const deps: any = { db, accountId: () => 'a', schedule: async (_: any, fn: any) => fn(), executeSend: async () => { calls++; await gate; return { messageId: 'm', sentAt: 1 } } }
    const first = createChatWriteService(deps)
    const second = createChatWriteService(deps)
    const a = first.send(input)
    await new Promise(resolve => setImmediate(resolve))
    const b = second.send(input)
    await assert.rejects(b, { code: 'RESULT_UNKNOWN' })
    release()
    assert.deepEqual(await a, { messageId: 'm', sentAt: 1 })
    assert.equal(calls, 1)
    assert.equal(db.getOperation('a', 'chat.send', 'k')?.status, 'succeeded')
  } finally { db.close() }
})
test('native 桥 apiError 码被记录，在途超时仍按未知处理', async () => {
  const f = fixture()
  try {
    f.deps.executeSend = async () => { throw Object.assign(new Error('x'), { apiError: { code: 'PAGE_NOT_READY', phase: 'read' } }) }
    await assert.rejects(f.service.send(input), { code: 'PLATFORM_REJECTED' })
    assert.equal(f.db.getOperation('a', 'chat.send', 'k')?.errorCode, 'PAGE_NOT_READY')
    f.deps.executeSend = async () => { throw Object.assign(new Error('x'), { apiError: { code: 'TIMEOUT' } }) }
    await assert.rejects(f.service.send({ ...input, idempotencyKey: 'k2' }), { code: 'RESULT_UNKNOWN' })
  } finally { f.db.close() }
})
test('风控和登录失效原样透传，不塌缩为 PLATFORM_REJECTED', async () => {
  const f = fixture()
  try {
    for (const [i, c] of ['RISK_BLOCKED', 'LOGIN_REQUIRED'].entries()) {
      f.deps.executeSend = async () => { throw Object.assign(new Error('x'), { apiError: { code: c } }) }
      await assert.rejects(f.service.send({ ...input, idempotencyKey: `r${i}` }), { code: c })
    }
  } finally { f.db.close() }
})
test('无码或 INTERNAL 等不明错误记为 unknown，同 key 不重发', async () => {
  const f = fixture()
  try {
    let calls = 0
    f.deps.executeSend = async () => { calls++; throw new Error('boom') }
    await assert.rejects(f.service.send(input), { code: 'RESULT_UNKNOWN' })
    assert.equal(f.db.getOperation('a', 'chat.send', 'k')?.status, 'unknown')
    await assert.rejects(f.service.send(input), { code: 'RESULT_UNKNOWN' })
    assert.equal(calls, 1)
    f.deps.executeSend = async () => { throw Object.assign(new Error('x'), { apiError: { code: 'RISK_BLOCKED', phase: 'write' } }) }
    await assert.rejects(f.service.send({ ...input, idempotencyKey: 'w' }), { code: 'RISK_BLOCKED' })
    assert.equal(f.db.getOperation('a', 'chat.send', 'w')?.status, 'unknown')
  } finally { f.db.close() }
})

test('派发后取消或页面失联保持 unknown，同键不再发送', async () => {
  for (const code of ['CANCELLED', 'PAGE_NOT_READY']) {
    const f = fixture()
    try {
      let calls = 0
      f.deps.executeSend = async () => { calls++; throw Object.assign(new Error('x'), { code, phase: 'write' }) }
      await assert.rejects(f.service.send(input), { code: 'RESULT_UNKNOWN' })
      assert.equal(f.db.getOperation('a', 'chat.send', 'k')?.status, 'unknown')
      await assert.rejects(f.service.send(input), { code: 'RESULT_UNKNOWN' })
      assert.equal(calls, 1)
    } finally { f.db.close() }
  }
})
