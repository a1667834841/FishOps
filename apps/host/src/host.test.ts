import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FrameDecoder, encodeFrame } from './framing.ts'
import { HostDatabase } from './database.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { NativeBridge } from './bridge.ts'
import { createReadService } from './read-service.ts'
import { createChatWriteService } from './chat-write-service.ts'

type ReadCall = { method: string; params: unknown }

test('native 构建标识来自本次握手，断开后不再返回旧标识', () => {
  const input = new PassThrough(), output = new PassThrough()
  const bridge = new NativeBridge(input, output, () => {})
  try {
    assert.equal(bridge.extensionBuildId, null)
    const extensionBuildId = 'a119991e-f9ad-4f83-bd16-997e732fc142'
    input.write(encodeFrame({ kind: 'hello', protocolVersion: 1, extensionVersion: '0.2.0', account: null, extensionBuildId } as any))
    assert.equal(bridge.ready, true)
    assert.equal(bridge.extensionBuildId, extensionBuildId)
    bridge.close()
    assert.equal(bridge.extensionBuildId, null)
  } finally { bridge.close(); input.destroy(); output.destroy() }
})

/** 测试用公共只读执行器；只验证路由是否到 read service，不接触真实页面。 */
function readFixture(overrides: {
  accountId?: () => string | null
  schedule?: <T>(input: any, execute: () => Promise<T>) => Promise<T>
  execute?: (method: any, params: any, accountId: string) => Promise<unknown>
} = {}) {
  const calls: ReadCall[] = []
  const db = new HostDatabase(':memory:')
  const service = createReadService({
    db,
    accountId: overrides.accountId ?? (() => 'account-a'),
    now: () => 1000,
    schedule: overrides.schedule ?? (async (_input, execute) => execute()),
    execute: overrides.execute ?? (async (method, params) => {
      calls.push({ method, params })
      if (method === 'search.suggest') return ['手机']
      if (method === 'item.detail') return {
        itemId: '1', title: '测试商品', description: null, price: null, status: 'unknown',
        image: null, sellerId: null, sellerNick: null, city: null, wantCnt: null,
        publishedAt: null, url: null, images: null, browseCnt: null, collectCnt: null,
      }
      return { items: [], hasMore: null }
    }),
  })
  return { db, service, calls }
}

async function startServer(t: any, readService?: ReturnType<typeof createReadService>, chatWriteService?: ReturnType<typeof createChatWriteService>) {
  const { HostServer } = await import('./server.ts')
  const db = new HostDatabase(':memory:')
  const input = new PassThrough()
  const output = new PassThrough()
  const sent: unknown[] = []
  output.on('data', chunk => {
    const n = chunk.readUInt32LE()
    sent.push(JSON.parse(chunk.subarray(4, 4 + n).toString('utf8')))
  })
  const bridge = new NativeBridge(input, output, () => {}, 1000)
  const server = new HostServer(0, 'z'.repeat(32), bridge, db, readService, undefined, undefined, chatWriteService)
  t.after(async () => { await server.close(); bridge.close(); input.destroy(); output.destroy(); db.close() })
  const port = await server.listen()
  const call = async (method: string, params: unknown = {}, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/v1/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${'z'.repeat(32)}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(params),
    })
    return { status: response.status, body: await response.json() as any }
  }
  return { server, bridge, input, output, sent, call, db }
}

test('native frame 支持拆分与粘连，并拒绝半帧和无效 UTF-8',{timeout:2000},()=>{
  const a=encodeFrame({kind:'hello',protocolVersion:1,extensionVersion:'1',account:null})
  const d=new FrameDecoder();assert.deepEqual(d.push(a.subarray(0,3)),[]);assert.equal(d.push(Buffer.concat([a.subarray(3),a])).length,2)
  const truncated=new FrameDecoder();truncated.push(a.subarray(0,5));assert.throws(()=>truncated.end(),/TRUNCATED_FRAME/)
  const invalid=Buffer.from([1,0,0,0,0xff]);assert.throws(()=>new FrameDecoder().push(invalid))
})

test('SQLite 序号游标为字符串，分页稳定且重启保留',{timeout:2000},()=>{
  const dir=mkdtempSync(join(tmpdir(),'fishops-'));const path=join(dir,'fishops.db')
  try{
    let db=new HostDatabase(path);db.setAccount({userId:'u1',nick:'甲'});db.event('risk.signal',{level:'caution'},'u1','tag');db.event('risk.signal',{level:'ok'},'u1','tag')
    const first=db.events({afterSeq:'0',limit:1},'u1');assert.equal(typeof first.nextAfterSeq,'string');assert.equal(first.hasMore,true)
    const second=db.events({afterSeq:first.nextAfterSeq,limit:1},'u1');assert.equal(second.items.length,1)
    db.request('a','system.status');db.finish('a','succeeded');db.request('b','system.status');db.finish('b','succeeded');assert.equal(db.requests({afterId:'0',limit:1},'u1').hasMore,true);db.close()
    db=new HostDatabase(path);assert.equal(db.events({afterSeq:'0'},'u1').items.length,3);db.close()
  }finally{rmSync(dir,{recursive:true,force:true})}
})

test('SQLite 大序号读写不经过 Number',{timeout:2000},()=>{
  const dir=mkdtempSync(join(tmpdir(),'fishops-bigint-')),path=join(dir,'db')
  try{const db=new HostDatabase(path);db.db.exec("INSERT INTO events(seq,type,ts,account_id,tag,data) VALUES(9007199254740993,'risk.signal',1,NULL,NULL,'{}')");assert.equal(db.highWater(),'9007199254740993');assert.equal(db.events({afterSeq:'9007199254740992'}).items[0].seq,'9007199254740993');db.close()}finally{rmSync(dir,{recursive:true,force:true})}
})

test('bridge 按 ID 匹配并清理迟到响应、pending 与监听器',{timeout:2000},async t=>{
  const input=new PassThrough(),output=new PassThrough(),sent:Buffer[]=[]
  output.on('data',b=>sent.push(Buffer.from(b)))
  const bridge=new NativeBridge(input,output,()=>{},1000)
  t.after(()=>{bridge.close();input.destroy();output.destroy()})
  const send=(wire:unknown)=>input.write(encodeFrame(wire as any))
  send({kind:'hello',protocolVersion:1,extensionVersion:'x',account:null})
  const one=bridge.call('one',{}),two=bridge.call('two',{})
  await new Promise(r=>setImmediate(r))
  const reqs=sent.map(b=>{const n=b.readUInt32LE();return JSON.parse(b.subarray(4,4+n).toString('utf8'))})
  send({kind:'res',id:reqs[1].id,ok:true,data:{extensionVersion:'x',account:null,page:{present:true},chatReady:null}});send({kind:'res',id:reqs[0].id,ok:true,data:{extensionVersion:'x',account:null,page:{present:false},chatReady:null}})
  const [first,second]=await Promise.all([one,two]) as any[];assert.equal(first.page.present,false);assert.equal(second.page.present,true)
  const pending=bridge.call('late',{});await new Promise(r=>setImmediate(r));const last=sent.at(-1)!;const lateId=JSON.parse(last.subarray(4).toString('utf8')).id
  bridge.close();await assert.rejects(pending)
  send({kind:'res',id:lateId,ok:true,data:{}})
  assert.equal(input.listenerCount('data'),0)
  input.destroy();output.destroy()
})

test('SSE 回放使用多页推进，覆盖超过 100 条的历史事件',{timeout:5000},async t=>{
  const {HostServer}=await import('./server.ts')
  const dir=mkdtempSync(join(tmpdir(),'fishops-sse-pages-')),db=new HostDatabase(join(dir,'db'))
  try{
    db.setAccount(null);for(let i=0;i<205;i++)db.event('risk.signal',{i},null)
    const input=new PassThrough(),output=new PassThrough(),bridge=new NativeBridge(input,output,()=>{}),server=new HostServer(0,'x'.repeat(32),bridge,db)
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
    t.after(async()=>{await reader?.cancel().catch(()=>{});await server.close();bridge.close();input.destroy();output.destroy()})
    // 直接通过公开 HTTP 路由连接，验证真实 SSE 分页而非私有方法实现细节。
    const port=await server.listen(),response=await fetch(`http://127.0.0.1:${port}/v1/events`,{headers:{authorization:`Bearer ${'x'.repeat(32)}`}})
    reader=response.body!.getReader();let body='';while((body.match(/event: risk.signal/g)||[]).length<205){const {value,done}=await reader.read();if(done)break;body+=new TextDecoder().decode(value)}
    assert.equal((body.match(/event: risk.signal/g)||[]).length,205);await reader.cancel();await server.close();bridge.close();input.destroy();output.destroy()
  }finally{db.close();rmSync(dir,{recursive:true,force:true})}
})

test('SSE 慢客户端累计缓冲达到 1 MiB 后关闭并可从游标恢复',{timeout:7000},async t=>{
  const {HostServer}=await import('./server.ts')
  const dir=mkdtempSync(join(tmpdir(),'fishops-sse-slow-')),db=new HostDatabase(join(dir,'db'))
  const input=new PassThrough(),output=new PassThrough(),bridge=new NativeBridge(input,output,()=>{}),server=new HostServer(0,'y'.repeat(32),bridge,db)
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
  t.after(async()=>{await reader?.cancel().catch(()=>{});await server.close();bridge.close();input.destroy();output.destroy();db.close();rmSync(dir,{recursive:true,force:true})})
  for(let i=0;i<200;i++)db.event('risk.signal',{payload:'x'.repeat(9000),i},null)
  const port=await server.listen(),res=await fetch(`http://127.0.0.1:${port}/v1/events`,{headers:{authorization:`Bearer ${'y'.repeat(32)}`}})
  reader=res.body!.getReader();let text='',closed=false
  while(!closed){let timer:ReturnType<typeof setTimeout>|undefined;const result=await Promise.race([reader.read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SSE 未按缓冲上限关闭')),3000)})]).finally(()=>clearTimeout(timer));if(result.done){closed=true;break}text+=new TextDecoder().decode(result.value)}
  assert.ok(Buffer.byteLength(text)<1024*1024+20_000)
  const cursor=/^id: (\d+)$/m.exec(text)?.[1];assert.ok(cursor)
  const resumed=db.events({afterSeq:cursor!,limit:500},null);assert.ok(resumed.items.length>0)
})

test('公共只读路由：认证、Origin、未知方法、参数错误与 capabilities',{timeout:5000},async t=>{
  const fixture=readFixture(),host=await startServer(t,fixture.service)
  try{
    assert.equal((await host.call('search.items',{keyword:'手机'},{authorization:'Bearer wrong'})).status,401)
    assert.equal((await host.call('search.items',{keyword:'手机'},{origin:''})).status,403)
    assert.equal((await host.call('missing.method')).body.error.code,'NOT_FOUND')
    const invalid=await host.call('search.items',{keyword:'',token:'secret'})
    assert.equal(invalid.status,400);assert.equal(invalid.body.error.code,'BAD_REQUEST')
    const invalidValue=await host.call('search.items',{keyword:'手机',page:0})
    assert.equal(invalidValue.status,400);assert.equal(invalidValue.body.error.code,'BAD_REQUEST')
    assert.equal(host.db.requests({afterId:'0'}).items.length,0)

    host.input.write(encodeFrame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',extensionBuildId:'a119991e-f9ad-4f83-bd16-997e732fc142',account:{userId:'account-a',nick:'甲'}}))
    await new Promise(resolve=>setImmediate(resolve))

    // system.status 必须真实经过 bridge；测试在收到 req 后回包，而不是走只读服务。
    const statusPromise=host.call('system.status')
    while(!host.sent.some(item=>(item as any).kind==='req'))await new Promise(resolve=>setImmediate(resolve))
    const request=(host.sent.find(item=>(item as any).kind==='req') as any)
    host.input.write(encodeFrame({kind:'res',id:request.id,ok:true,data:{extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'},page:{present:true},chatReady:null}}))
    const status=await statusPromise
    assert.equal(status.body.ok,true)
    assert.equal(status.body.data.extensionBuildId,'a119991e-f9ad-4f83-bd16-997e732fc142')
    for(const method of ['system.status','events.list','requests.list','search.items','search.suggest','item.detail','chat.sync.status'])assert.equal(status.body.data.capabilities.includes(method),true)
    assert.deepEqual(fixture.calls,[])
  }finally{await host.server.close()}
})

test('公共只读路由：三个方法走 read service，结果保持 ok/data 包装且不转给 bridge',{timeout:5000},async t=>{
  const fixture=readFixture(),host=await startServer(t,fixture.service)
  try{
    host.input.write(encodeFrame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'}}))
    await new Promise(resolve=>setImmediate(resolve))
    const search=await host.call('search.items',{keyword:'手机',page:2,rowsPerPage:10})
    const suggest=await host.call('search.suggest',{keyword:'手机'})
    const detail=await host.call('item.detail',{itemId:'1'})
    assert.equal(search.status,200);assert.deepEqual(search.body.data,{items:[],hasMore:null})
    assert.equal(suggest.status,200);assert.deepEqual(suggest.body.data,['手机'])
    assert.equal(detail.status,200);assert.equal(detail.body.data.itemId,'1')
    assert.deepEqual(fixture.calls,[
      {method:'search.items',params:{keyword:'手机',page:2,rowsPerPage:10}},
      {method:'search.suggest',params:{keyword:'手机'}},
      {method:'item.detail',params:{itemId:'1'}},
    ])
    assert.equal(host.sent.some(item=>(item as any).kind==='req'),false)
  }finally{await host.server.close()}
})

test('公共只读路由：LOGIN_REQUIRED、PAGE_NOT_READY、ACCOUNT_CHANGED 与 INTERNAL 映射',{timeout:5000},async t=>{
  const login=readFixture({accountId:()=>null}),loginHost=await startServer(t,login.service)
  try{
    const result=await loginHost.call('item.detail',{itemId:'1'})
    assert.equal(result.status,503);assert.equal(result.body.error.code,'LOGIN_REQUIRED')
  }finally{await loginHost.server.close()}

  const page=readFixture({execute:async()=>{throw Object.assign(new Error('页面不可用'),{code:'PAGE_NOT_READY'})}}),pageHost=await startServer(t,page.service)
  try{
    const result=await pageHost.call('search.suggest',{keyword:'手机'})
    assert.equal(result.status,503);assert.equal(result.body.error.code,'PAGE_NOT_READY')
  }finally{await pageHost.server.close()}

  let account='account-a'
  const changed=readFixture({accountId:()=>account,schedule:async(_input,execute)=>{account='account-b';return execute()}}),changedHost=await startServer(t,changed.service)
  try{
    const result=await changedHost.call('item.detail',{itemId:'1'})
    assert.equal(result.status,409);assert.equal(result.body.error.code,'ACCOUNT_CHANGED')
  }finally{await changedHost.server.close()}

  const internal=readFixture({execute:async()=>({unexpected:true})}),internalHost=await startServer(t,internal.service)
  try{
    const result=await internalHost.call('search.items',{keyword:'手机'})
    assert.equal(result.status,500);assert.equal(result.body.error.code,'INTERNAL')
  }finally{await internalHost.server.close()}
})

test('只读风控与登录失效发布 risk.signal，普通失败不伪造平台信号',{timeout:5000},async t=>{
  const cases:Array<{code:string;signal:string;level:string}>=[
    {code:'RISK_BLOCKED',signal:'CAPTCHA',level:'blocked'},
    {code:'LOGIN_REQUIRED',signal:'LOGIN_REQUIRED',level:'caution'},
  ]
  for(const item of cases){
    const fixture=readFixture({execute:async()=>{throw Object.assign(new Error('测试失败'),{code:item.code})}})
    const host=await startServer(t,fixture.service)
    try{
      host.input.write(encodeFrame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'}}))
      await new Promise(resolve=>setImmediate(resolve))
      const result=await host.call('search.items',{keyword:'手机'})
      assert.equal(result.body.error.code,item.code)
      const events=host.db.events({afterSeq:'0',types:['risk.signal']},'account-a')
      assert.equal(events.items.length,1)
      assert.deepEqual(events.items[0]?.data,{level:item.level,signal:item.signal})
    }finally{await host.server.close()}
  }

  const fixture=readFixture({execute:async()=>{throw Object.assign(new Error('页面不可用'),{code:'PAGE_NOT_READY'})}})
  const host=await startServer(t,fixture.service)
  try{
    host.input.write(encodeFrame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'}}))
    await new Promise(resolve=>setImmediate(resolve))
    await host.call('search.items',{keyword:'手机'})
    assert.equal(host.db.events({afterSeq:'0',types:['risk.signal']},'account-a').items.length,0)
  }finally{await host.server.close()}
})

test('公共 chat.send 路由保持幂等、单次派发并映射未知结果',{timeout:5000},async t=>{
  const db = new HostDatabase(':memory:')
  let account: string | null = 'account-a'
  let sends = 0
  const service = createChatWriteService({
    db, accountId: () => account,
    schedule: async (_input, execute) => execute(),
    executeSend: async () => { sends++; return { messageId: 'm1', sentAt: 1 } },
  })
  const host = await startServer(t, undefined, service)
  try {
    host.input.write(encodeFrame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'}}))
    await new Promise(resolve => setImmediate(resolve))
    const input = { sessionId: 's', receiverId: 'r', text: '询价', idempotencyKey: 'k' }
    const first = await host.call('chat.send', input)
    const second = await host.call('chat.send', input)
    assert.equal(first.status, 200); assert.deepEqual(second.body.data, first.body.data); assert.equal(sends, 1)
    assert.equal(db.getOperation('account-a', 'chat.send', 'k')?.status, 'succeeded')
  } finally { account = null; await host.server.close(); db.close() }
})

test('公共 chat.send 路由：未配置、未登录、账号变化与平台拒绝映射',{timeout:5000},async t=>{
  const bare = await startServer(t)
  try {
    bare.input.write(encodeFrame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'}}))
    await new Promise(resolve => setImmediate(resolve))
    const noService = await bare.call('chat.send', { sessionId:'s', receiverId:'r', text:'x', idempotencyKey:'k' })
    assert.equal(noService.status, 503); assert.equal(noService.body.error.code, 'PAGE_NOT_READY')
  } finally { await bare.server.close() }

  const loginDb = new HostDatabase(':memory:')
  const loginService = createChatWriteService({ db: loginDb, accountId: () => null, schedule: async (_i, fn) => fn(), executeSend: async () => ({ messageId:'m', sentAt:1 }) })
  const login = await startServer(t, undefined, loginService)
  try {
    login.input.write(encodeFrame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'}}))
    await new Promise(resolve => setImmediate(resolve))
    const result = await login.call('chat.send', { sessionId:'s', receiverId:'r', text:'x', idempotencyKey:'k' })
    assert.equal(result.status, 503); assert.equal(result.body.error.code, 'LOGIN_REQUIRED')
  } finally { await login.server.close(); loginDb.close() }

  const rejectDb = new HostDatabase(':memory:')
  const rejectService = createChatWriteService({ db: rejectDb, accountId: () => 'account-a', schedule: async (_i, fn) => fn(), executeSend: async () => { throw Object.assign(new Error('拒绝'), { code:'PLATFORM_REJECTED' }) } })
  const reject = await startServer(t, undefined, rejectService)
  try {
    reject.input.write(encodeFrame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'}}))
    await new Promise(resolve => setImmediate(resolve))
    const result = await reject.call('chat.send', { sessionId:'s', receiverId:'r', text:'x', idempotencyKey:'k' })
    assert.equal(result.status, 409); assert.equal(result.body.error.code, 'PLATFORM_REJECTED')
    assert.equal(rejectDb.getOperation('account-a','chat.send','k')?.status, 'failed')
  } finally { await reject.server.close(); rejectDb.close() }
})

test('风控熔断：RISK_BLOCKED 后冷却期内不再触达平台，clearRisk 后恢复',{timeout:5000},async t=>{
  let calls=0,code:string|null='RISK_BLOCKED'
  const fixture=readFixture({execute:async()=>{calls++;if(code)throw Object.assign(new Error('x'),{code});return {items:[],hasMore:false}}})
  const host=await startServer(t,fixture.service)
  try{
    host.input.write(encodeFrame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'}}))
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal((await host.call('search.items',{keyword:'手机'})).body.error.code,'RISK_BLOCKED')
    assert.equal(calls,1)
    const blocked=await host.call('search.items',{keyword:'耳机'})
    assert.equal(blocked.status,409);assert.equal(blocked.body.error.code,'RISK_BLOCKED');assert.equal(blocked.body.error.phase,'queue')
    assert.equal(calls,1)
    assert.equal((await host.call('risk.status',{})).body.data.blocked,true)
    assert.equal((await host.call('risk.clear',{})).status,400)
    code=null
    const cleared=await host.call('risk.clear',{manualVerified:true})
    assert.equal(cleared.body.data.blocked,false)
    await host.call('search.items',{keyword:'耳机'})
    assert.equal(calls,2)
  }finally{await host.server.close()}
})


test('非法冷却配置不能使风控熔断失效', async () => {
  const { riskCooldownFromEnv } = await import('./server.ts')
  for (const value of [undefined, '', 'NaN', 'Infinity', '0', '-1', '1.5', '99999999999999999999']) {
    assert.equal(riskCooldownFromEnv(value), 30 * 60_000)
  }
  assert.equal(riskCooldownFromEnv('60000'), 60000)
})

test('风控按请求开始账号记账：在途切换不误熔断新账号，信号只归原账号',{timeout:5000},async t=>{
  let host: Awaited<ReturnType<typeof startServer>>|undefined
  let calls=0
  const fixture=readFixture({execute:async()=>{
    calls++
    if(calls===1){
      // 平台请求在途时账号从 account-a 切到 account-b：迟到风控必须仍算在 a 身上。
      host!.input.write(encodeFrame({kind:'event',type:'account.changed',data:{account:{userId:'account-b',nick:'乙'}}}))
      await new Promise(resolve=>setImmediate(resolve))
      throw Object.assign(new Error('风控'),{code:'RISK_BLOCKED'})
    }
    return {items:[],hasMore:false}
  }})
  host=await startServer(t,fixture.service)
  try{
    host.input.write(encodeFrame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'}}))
    await new Promise(resolve=>setImmediate(resolve))
    const first=await host.call('search.items',{keyword:'手机'})
    assert.equal(first.status,409);assert.equal(first.body.error.code,'RISK_BLOCKED')
    // 事件与冷却都归属发起请求的 account-a，account-b 既看不到事件也不被熔断。
    const signalRow=host.db.db.prepare("SELECT account_id FROM events WHERE type='risk.signal'").get() as {account_id:string|null}
    assert.equal(signalRow.account_id,'account-a')
    assert.equal(host.db.events({afterSeq:'0',types:['risk.signal']},'account-a').items.length,1)
    assert.equal(host.db.events({afterSeq:'0',types:['risk.signal']},'account-b').items.length,0)
    assert.ok(host.db.riskCooldownUntil('account-a',Date.now())>Date.now())
    assert.equal(host.db.riskCooldownUntil('account-b',Date.now()),0)
    // 当前账号是 account-b，第二次请求不得被 account-a 的熔断拦截，仍会触达平台。
    const second=await host.call('search.items',{keyword:'耳机'})
    assert.equal(second.status,200);assert.equal(calls,2)
  }finally{await host.server.close()}
})

test('风控冷却持久化 SQLite 并清理过期条目',{timeout:5000},()=>{
  const dir=mkdtempSync(join(tmpdir(),'fishops-risk-state-')),path=join(dir,'db')
  try{
    const now=Date.now()
    let db=new HostDatabase(path)
    db.setRiskCooldown('u1',now+60_000)
    db.db.prepare("INSERT INTO state(key,value) VALUES('risk:until:stale','1')").run()
    db.close()

    // 重启后冷却仍生效，不受进程内存重置影响。
    db=new HostDatabase(path)
    assert.ok(db.riskCooldownUntil('u1',now+1000)>now+1000)
    // 写入新冷却时顺带清理已过期条目。
    db.setRiskCooldown('u2',now+120_000)
    assert.equal(db.db.prepare("SELECT 1 FROM state WHERE key='risk:until:stale'").get(),undefined)
    // 读取过期冷却时就地清除，不再返回旧到期时间。
    assert.equal(db.riskCooldownUntil('u1',now+999_999),0)
    assert.equal(db.db.prepare("SELECT 1 FROM state WHERE key='risk:until:u1'").get(),undefined)
    // 人工清除后立即不再阻断。
    db.clearRiskCooldown('u2')
    assert.equal(db.riskCooldownUntil('u2',Date.now()),0)
    db.close()
  }finally{rmSync(dir,{recursive:true,force:true})}
})

test('熔断拦截的请求写入 requests 审计且不触达平台',{timeout:5000},async t=>{
  let calls=0
  const fixture=readFixture({execute:async()=>{calls++;throw Object.assign(new Error('风控'),{code:'RISK_BLOCKED'})}})
  const host=await startServer(t,fixture.service)
  try{
    host.input.write(encodeFrame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'}}))
    await new Promise(resolve=>setImmediate(resolve))
    const first=await host.call('search.items',{keyword:'手机',tag:'risk-first'})
    assert.equal(first.body.error.code,'RISK_BLOCKED');assert.equal(calls,1)
    const second=await host.call('search.items',{keyword:'耳机',tag:'risk-blocked'})
    assert.equal(second.status,409);assert.equal(second.body.error.code,'RISK_BLOCKED');assert.equal(second.body.error.phase,'queue')
    assert.equal(calls,1)
    const rows=host.db.requests({afterId:'0',tag:'risk-blocked'},'account-a').items
    assert.equal(rows.length,1)
    assert.equal(rows[0]?.method,'search.items');assert.equal(rows[0]?.status,'failed');assert.equal(rows[0]?.errorCode,'RISK_BLOCKED')
    const stored=host.db.db.prepare("SELECT account_id,status,error_code FROM requests WHERE tag='risk-blocked'").get() as {account_id:string;status:string;error_code:string}
    assert.equal(stored.account_id,'account-a');assert.equal(stored.status,'failed');assert.equal(stored.error_code,'RISK_BLOCKED')
  }finally{await host.server.close()}
})

test('公共同步状态返回末页而非首屏，不用结果子串认领其他任务', async t => {
  const { HostServer } = await import('./server.ts')
  const db = new HostDatabase(':memory:')
  const input = new PassThrough(), output = new PassThrough()
  const bridge = new NativeBridge(input, output, () => {})
  input.write(encodeFrame({ kind: 'hello', protocolVersion: 1, extensionVersion: 'test', account: { userId: 'a', nick: '测试' } }))
  const runId = '00000000-0000-4000-8000-000000000001'
  const put = (key: string, value: unknown) => db.db.prepare('INSERT INTO state(key,value) VALUES(?,?)').run(`chat.sync.service:${key}`, JSON.stringify(value))
  put('first', { accountId: 'a', runId, status: 'committed', committedPages: 1, result: { committedPages: 1, completion: 'more' } })
  put('last', { accountId: 'a', runId, status: 'committed', committedPages: 2, result: { committedPages: 2, completion: 'complete' } })
  const server = new HostServer(0, 'test-token', bridge, db)
  const port = await server.listen()
  t.after(async () => { await server.close(); bridge.close(); input.destroy(); output.destroy(); db.close() })
  const call = async (id: string) => fetch(`http://127.0.0.1:${port}/v1/chat.sync.status`, { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ runId: id }) })
  const response = await call(runId)
  const body = await response.json() as any
  assert.equal(body.data.result.completion, 'complete')
  assert.equal(body.data.result.committedPages, 2)
  put('pending', { accountId: 'a', runId, status: 'unknown', committedPages: 2 })
  const pending = await (await call(runId)).json() as any
  assert.equal(pending.data.status, 'unknown')
  assert.equal(pending.data.result, null)
  const foreign = '00000000-0000-4000-8000-000000000002'
  put('unrelated', { accountId: 'a', runId, status: 'committed', result: { diagnostic: foreign } })
  assert.equal((await call(foreign)).status, 404)
})

test('同步状态只读暴露本账号缺口（新账本与旧标记双源），不泄漏他人且永不标记已清除', async t => {
  const { HostServer } = await import('./server.ts')
  const { ChatGapLedger } = await import('./chat-gap-ledger.ts')
  const { persistChatGap } = await import('./main.ts')
  const db = new HostDatabase(':memory:')
  const input = new PassThrough(), output = new PassThrough()
  const bridge = new NativeBridge(input, output, () => {})
  input.write(encodeFrame({ kind: 'hello', protocolVersion: 1, extensionVersion: 'test', account: { userId: 'a', nick: '测试' } }))
  const runId = '00000000-0000-4000-8000-000000000003'
  db.db.prepare('INSERT INTO state(key,value) VALUES(?,?)').run('chat.sync.service:x', JSON.stringify({ accountId: 'a', runId, status: 'committed', committedPages: 1, result: { committedPages: 1 } }))
  const server = new HostServer(0, 'test-token', bridge, db)
  const port = await server.listen()
  t.after(async () => { await server.close(); bridge.close(); input.destroy(); output.destroy(); db.close() })
  const call = async () => (await fetch(`http://127.0.0.1:${port}/v1/chat.sync.status`, { method: 'POST', headers: { authorization: 'Bearer test-token' }, body: JSON.stringify({ runId }) })).json() as Promise<any>
  assert.deepEqual((await call()).data.gaps, { open: false, legacyReasons: [], ledger: [], cleared: false })
  persistChatGap(db, 'b', 'PAGE_GAP')
  new ChatGapLedger(db).ingest({ accountId: 'b', reason: 'PAGE_GAP', occurrenceId: 'ob', generation: 1, scope: { scope: 'unknown' } })
  assert.equal((await call()).data.gaps.open, false)
  persistChatGap(db, 'a', 'OUTBOX_CAPACITY')
  new ChatGapLedger(db).ingest({ accountId: 'a', reason: 'PAGE_GAP', occurrenceId: 'oa', generation: 1, scope: { scope: 'account' } })
  const gaps = (await call()).data.gaps
  assert.equal(gaps.open, true)
  assert.equal(gaps.cleared, false)
  assert.deepEqual(gaps.legacyReasons, ['OUTBOX_CAPACITY'])
  assert.equal(gaps.ledger.length, 1)
  assert.equal(gaps.ledger[0].latestOccurrenceId, 'oa')
  db.db.prepare('UPDATE chat_gap_ledger SET source_generation=-1 WHERE account_id=?').run('a')
  const corrupted = await call()
  assert.equal(corrupted.ok, false)
  assert.equal(corrupted.error.code, 'INTERNAL')
  db.db.prepare('UPDATE chat_gap_ledger SET source_generation=1 WHERE account_id=?').run('a')
  assert.equal((await call()).ok, true)
})
