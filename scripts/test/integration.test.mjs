import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const root = resolve(import.meta.dirname, '../..')
const token = 'integration-only-secret-never-log'
const frame = value => { const data=Buffer.from(JSON.stringify(value)); const head=Buffer.alloc(4); head.writeUInt32LE(data.length); return Buffer.concat([head,data]) }
async function launch(home, reply=true, hello=null) {
  const child=spawn(process.execPath,[join(root,'apps/host/src/main.ts')],{env:{...process.env,FISHOPS_HOME:home,FISHOPS_BRIDGE_TIMEOUT_MS:'80'},stdio:['pipe','pipe','pipe']})
  let stdout=Buffer.alloc(0),stderr='',port
  const messages=[]
  child.stdout.on('data',chunk=>{stdout=Buffer.concat([stdout,chunk]);while(stdout.length>=4){const n=stdout.readUInt32LE();assert.ok(n>0&&n<=1048576);if(stdout.length<4+n)break;const m=JSON.parse(stdout.subarray(4,4+n));stdout=stdout.subarray(4+n);messages.push(m);if(reply&&m.kind==='req')child.stdin.write(frame({kind:'res',id:m.id,ok:true,data:{extensionVersion:'0.2.0',account:null,page:{present:false},chatReady:null}}))}})
  child.stderr.on('data',chunk=>{stderr+=chunk;if(process.env.FISHOPS_TEST_DEBUG)process.stderr.write(`[child ${child.pid}] ${chunk}`);for(const line of stderr.split('\n')){try{const v=JSON.parse(line);if(v.event==='listening')port=v.port}catch{}}})
  if(hello)child.stdin.write(frame(hello))
  const deadline=Date.now()+5000
  while(!port&&child.exitCode===null&&Date.now()<deadline)await new Promise(r=>setTimeout(r,15))
  if(!port){child.kill();throw new Error('host未就绪：'+stderr.replaceAll(token,'[redacted]'))}
  const call=async(method,params={},headers={})=>{const res=await fetch(`http://127.0.0.1:${port}/v1/${method}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...headers},body:JSON.stringify(params)});return {status:res.status,body:await res.json()}}
  const stop=async()=>{if(child.exitCode!==null)return;const closed=once(child,'exit');child.stdin.end();const timer=setTimeout(()=>child.kill('SIGKILL'),4500);try{const [code]=await closed;assert.equal(code,0);assert.equal(stdout.length,0);assert.ok(!stderr.includes(token))}finally{clearTimeout(timer)}}
  return {child,call,stop,messages,port}
}
test('真实host：握手、认证、HTTP转发、SSE重放、EOF和重启历史', {timeout:15000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'fishops-host-integration-'))
  t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  let host=await launch(home);t.after(()=>host.stop())
  assert.equal((await host.call('system.status')).body.error.code,'EXTENSION_OFFLINE')
  assert.equal((await host.call('system.status',{}, {authorization:'Bearer wrong'})).status,401)
  assert.equal((await host.call('system.status',{}, {origin:''})).status,403)
  host.child.stdin.write(frame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:null}))
  let status
  for(let n=0;n<50;n++){status=await host.call('system.status');if(status.body.ok)break;await new Promise(r=>setTimeout(r,10))}
  assert.equal(status.body.ok,true);assert.equal(status.body.meta.risk.level,'unobserved');assert.equal(status.body.data.chatReady,null)
  assert.equal((await host.call('missing')).body.error.code,'NOT_FOUND')
  const events=await host.call('events.list');assert.equal(events.body.ok,true);assert.ok(events.body.data.items.length>=1)
  const abort=new AbortController()
  const stream=await fetch(`http://127.0.0.1:${host.port}/v1/events`,{headers:{authorization:`Bearer ${token}`,'Last-Event-ID':'0'},signal:abort.signal})
  assert.equal(stream.status,200);assert.match(stream.headers.get('content-type'),/text\/event-stream/)
  const reader=stream.body.getReader();let text=''
  while(!text.includes('account.changed')){const {value,done}=await reader.read();assert.equal(done,false);text+=new TextDecoder().decode(value)}
  abort.abort();await reader.cancel().catch(()=>{})
  const records=(await host.call('requests.list')).body.data.items
  assert.ok(records.every(record=>record.status!=='running'),'已完成只读记录不能永久running')
  const before=records.length
  assert.equal((await host.call('requests.list')).body.data.items.length,before)
  await host.stop();host=await launch(home,false)
  assert.ok((await host.call('events.list')).body.data.items.length>=1)
  host.child.stdin.write(frame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:null}))
  await new Promise(r=>setTimeout(r,30))
  const timeout=await host.call('system.status');assert.equal(timeout.body.error.code,'TIMEOUT')
  await host.stop()
})
test('真实host：占用端口明确退出，畸形帧不挂起', {timeout:12000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'fishops-invalid-frame-'));t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  const host=await launch(home);t.after(()=>host.stop())
  await writeFile(join(home,'config.json'),JSON.stringify({port:host.port,token}),{mode:0o600})
  const second=spawn(process.execPath,[join(root,'apps/host/src/main.ts')],{env:{...process.env,FISHOPS_HOME:home,FISHOPS_HANDOFF_NATIVE_READY_MS:'80'},stdio:['pipe','pipe','pipe']})
  t.after(()=>{if(second.exitCode===null)second.kill()})
  const deadline=setTimeout(()=>second.kill('SIGKILL'),3000)
  const [code,signal]=await once(second,'exit');clearTimeout(deadline);assert.notEqual(code,null);assert.equal(signal,null);assert.notEqual(code,0)
  assert.equal((await host.call('requests.list')).body.ok,true)
  const closed=once(host.child,'exit');host.child.stdin.write(Buffer.alloc(4));const timer=setTimeout(()=>host.child.kill('SIGKILL'),3000)
  const [invalidCode,invalidSignal]=await closed;clearTimeout(timer);assert.notEqual(invalidCode,null);assert.equal(invalidSignal,null)
})
test('真实host：旧实例仍持native时拒绝接管，EOF释放端口后新实例接管', {timeout:15000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'fishops-host-handoff-'));t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  const old=await launch(home,true,{kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:null});t.after(()=>old.stop())
  await writeFile(join(home,'config.json'),JSON.stringify({port:old.port,token}),{mode:0o600})

  const rejected=spawn(process.execPath,[join(root,'apps/host/src/main.ts')],{env:{...process.env,FISHOPS_HOME:home,FISHOPS_HANDOFF_NATIVE_READY_MS:'80'},stdio:['pipe','pipe','pipe']})
  let rejectedErr='';rejected.stderr.on('data',chunk=>{rejectedErr+=chunk})
  const rejectTimer=setTimeout(()=>rejected.kill('SIGKILL'),6000)
  const [rejectCode,rejectSignal]=await once(rejected,'exit');clearTimeout(rejectTimer)
  assert.equal(rejectCode,1);assert.equal(rejectSignal,null);assert.match(rejectedErr,/没有新的 native 连接/)
  assert.equal((await old.call('requests.list')).body.ok,true)
  const online=await old.call('host.handoff',{}, {'x-fishops-handoff':`${process.pid}:12345678-1234-1234-1234-123456789abc`})
  assert.equal(online.status,409,'在线旧实例必须拒绝接管')
  await assert.rejects(launch(home,true,{kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:null}),/端口被其他服务占用/)
  assert.equal(old.child.exitCode,null,'新 hello 不得踢掉在线旧实例')

  // 旧 stdin 断开后先让新实例等待端口自然释放；不能把仍在服务的旧实例踢掉。
  const oldClosed=once(old.child,'exit')
  old.child.stdin.end()
  const next=await launch(home,true,{kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:null});t.after(()=>next.stop())
  const [oldCode]=await oldClosed
  assert.equal(oldCode,0,'旧实例必须优雅退出')
  assert.equal(next.child.exitCode,null,'新实例应完成接管')
  let status
  for(let attempt=0;attempt<50;attempt++){
    status=await next.call('system.status')
    if(status.body.error?.code!=='EXTENSION_OFFLINE')break
    await new Promise(resolve=>setTimeout(resolve,20))
  }
  assert.equal(status.status,200)
  assert.equal(status.body.data.nativeConnected,true)
})
test('真实host：非法请求、SSE游标边界与账号事件隔离', {timeout:15000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'fishops-http-security-'));t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  const host=await launch(home);t.after(()=>host.stop())
  const url=`http://127.0.0.1:${host.port}`
  for(const body of ['null','[]','{','{"unknown":"secret"}']){
    const r=await fetch(url+'/v1/system.status',{method:'POST',headers:{authorization:`Bearer ${token}`},body});assert.equal(r.status,400)
  }
  const tooLarge=await fetch(url+'/v1/system.status',{method:'POST',headers:{authorization:`Bearer ${token}`},body:' '.repeat(65537)});assert.equal(tooLarge.status,413)
  for(const query of ['afterSeq=9223372036854775808','tag=','unknown=1','after=0&afterSeq=0']){
    const r=await fetch(url+'/v1/events?'+query,{headers:{authorization:`Bearer ${token}`}});assert.equal(r.status,400,query)
  }
  const invalidHeader=await fetch(url+'/v1/events?after=0',{headers:{authorization:`Bearer ${token}`,'Last-Event-ID':'bad'}});assert.equal(invalidHeader.status,400)
  host.child.stdin.write(frame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'}}))
  await new Promise(r=>setTimeout(r,30))
  host.child.stdin.write(frame({kind:'event',type:'account.changed',data:{account:{userId:'account-b',nick:'乙'}}}))
  await new Promise(r=>setTimeout(r,30))
  const events=await host.call('events.list')
  assert.equal(events.body.ok,true)
  assert.ok(!JSON.stringify(events.body.data.items).includes('account-a'),'B账号查询不得泄露A账号快照')
})
test('真实host：筛选SSE也必须在账号切换时通知并关闭', {timeout:10000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'fishops-sse-account-'));t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  const host=await launch(home);t.after(()=>host.stop())
  host.child.stdin.write(frame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'a',nick:'甲'}}))
  await new Promise(r=>setTimeout(r,30))
  const abort=new AbortController();t.after(()=>abort.abort())
  const res=await fetch(`http://127.0.0.1:${host.port}/v1/events?types=chat.message&tag=job`,{headers:{authorization:`Bearer ${token}`},signal:abort.signal})
  host.child.stdin.write(frame({kind:'event',type:'account.changed',data:{account:{userId:'b',nick:'乙'}}}))
  let text='';const reader=res.body.getReader()
  for(;;){const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value)}
  assert.match(text,/account.changed/)
})
test('真实host：SIGTERM与非法配置均限时退出且不泄露输入', {timeout:8000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'fishops-host-exit-'));t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  const host=await launch(home);t.after(()=>host.stop())
  const closed=once(host.child,'exit');host.child.kill('SIGTERM');const [code,signal]=await closed;assert.equal(code,0);assert.equal(signal,null)
  await writeFile(join(home,'config.json'),'null',{mode:0o600})
  const bad=spawn(process.execPath,[join(root,'apps/host/src/main.ts')],{env:{...process.env,FISHOPS_HOME:home},stdio:['pipe','pipe','pipe']})
  let stderr='';bad.stderr.on('data',v=>stderr+=v);const timer=setTimeout(()=>bad.kill('SIGKILL'),2000)
  const [badCode,badSignal]=await once(bad,'exit');clearTimeout(timer);assert.equal(badCode,1);assert.equal(badSignal,null);assert.ok(!stderr.includes('TypeError'));assert.ok(!stderr.includes(token))
})
test('真实host：SSE Last-Event-ID 优先且补发后再次连接不重放已读项', {timeout:8000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'fishops-sse-resume-'));t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  const host=await launch(home);t.after(()=>host.stop())
  host.child.stdin.write(frame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:null}))
  await new Promise(r=>setTimeout(r,30))
  const events=(await host.call('events.list')).body.data.items
  assert.equal(events.length,1)
  const seq=events[0].seq,abort=new AbortController();t.after(()=>abort.abort())
  const res=await fetch(`http://127.0.0.1:${host.port}/v1/events?after=999`,{headers:{authorization:`Bearer ${token}`,'Last-Event-ID':'0'},signal:abort.signal})
  const reader=res.body.getReader();let text=''
  while(!text.includes('\n\n')){const next=await reader.read();assert.equal(next.done,false);text+=new TextDecoder().decode(next.value)}
  assert.equal(/^id: (\d+)$/m.exec(text)?.[1],seq)
  abort.abort();await reader.cancel().catch(()=>{})
  const after=(await host.call('events.list',{afterSeq:seq})).body.data
  assert.deepEqual(after.items,[]);assert.equal(after.nextAfterSeq,seq)
})
test('真实host：未完成请求重启标记interrupted且查询自身不污染历史', {timeout:8000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'fishops-interrupted-'));t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  let host=await launch(home,false);t.after(()=>host.stop())
  host.child.stdin.write(frame({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:null}))
  await new Promise(r=>setTimeout(r,20))
  const request=host.call('system.status').catch(()=>null)
  const deadline=Date.now()+1000
  while(!host.messages.some(m=>m.kind==='req')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5))
  assert.ok(host.messages.some(m=>m.kind==='req'))
  const closed=once(host.child,'exit');host.child.kill('SIGKILL');await closed;await request
  host=await launch(home)
  const first=await host.call('requests.list');assert.equal(first.body.ok,true)
  assert.ok(first.body.data.items.some(v=>v.method==='system.status'&&v.status==='interrupted'))
  const second=await host.call('requests.list');assert.deepEqual(second.body.data,first.body.data)
})

const detailFixture={itemId:'2002',title:'测试详情',description:null,price:'99',status:'unknown',image:null,sellerId:null,sellerNick:null,city:null,wantCnt:null,publishedAt:null,url:null,images:null,browseCnt:null,collectCnt:null}

/** 从已读帧队列取指定类型，并核对 host 没有发出非协议 stdout。 */
async function nextMessage(host,kind,timeoutMs=4000){
  const deadline=Date.now()+timeoutMs
  for(;;){
    const index=host.messages.findIndex(message=>message.kind===kind)
    if(index>=0)return host.messages.splice(index,1)[0]
    assert.ok(Date.now()<deadline,`等待 ${kind} 超时`)
    await new Promise(resolve=>setTimeout(resolve,5))
  }
}

test('真实host：三个M2只读方法经定位页、单步帧与归一化结果完整返回', {timeout:15000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'fishops-read-e2e-'));t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  const host=await launch(home,true,{kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'}})
  t.after(()=>host.stop())

  const suggest=host.call('search.suggest',{keyword:'手机'})
  const page=await nextMessage(host,'resolve-page')
  assert.equal(page.accountId,'account-a')
  host.child.stdin.write(frame({kind:'page-context',id:page.id,context:{tabId:7,documentId:'doc-a'}}))
  const suggestStep=await nextMessage(host,'request-step')
  assert.equal(suggestStep.method,'search.suggest')
  assert.deepEqual(suggestStep.params,{keyword:'手机'})
  assert.deepEqual(suggestStep.context,{accountId:'account-a',tabId:7,documentId:'doc-a'})
  host.child.stdin.write(frame({kind:'step-result',id:suggestStep.id,terminal:true,ok:true,data:['手机壳','手机膜']}))
  const suggestResult=await suggest
  assert.equal(suggestResult.status,200)
  assert.deepEqual(suggestResult.body.data,['手机壳','手机膜'])

  const search=host.call('search.items',{keyword:'手机',filter:{publishDays:7},maxAgeSec:0})
  const searchPage=await nextMessage(host,'resolve-page')
  host.child.stdin.write(frame({kind:'page-context',id:searchPage.id,context:{tabId:7,documentId:'doc-a'}}))
  const searchStep=await nextMessage(host,'request-step')
  assert.equal(searchStep.method,'search.items')
  assert.deepEqual(searchStep.params,{keyword:'手机',filter:{publishDays:7}})
  host.child.stdin.write(frame({kind:'step-result',id:searchStep.id,terminal:true,ok:true,data:{items:[],hasMore:null}}))
  const searchResult=await search
  assert.equal(searchResult.status,200)
  assert.deepEqual(searchResult.body.data,{items:[],hasMore:null})

  const detail=host.call('item.detail',{itemId:'2002',maxAgeSec:0})
  const detailPage=await nextMessage(host,'resolve-page')
  host.child.stdin.write(frame({kind:'page-context',id:detailPage.id,context:{tabId:7,documentId:'doc-a'}}))
  const detailStep=await nextMessage(host,'request-step')
  assert.equal(detailStep.method,'item.detail')
  assert.deepEqual(detailStep.params,{itemId:'2002'})
  host.child.stdin.write(frame({kind:'step-result',id:detailStep.id,terminal:true,ok:true,data:detailFixture}))
  const detailResult=await detail
  assert.equal(detailResult.status,200)
  assert.equal(detailResult.body.data.itemId,'2002')

  assert.deepEqual(host.messages.filter(message=>['resolve-page','request-step'].includes(message.kind)),[])
  const records=(await host.call('requests.list')).body.data.items
  for(const method of ['search.suggest','search.items','item.detail'])assert.ok(records.some(record=>record.method===method&&record.status==='succeeded'))
})

test('真实host：定位失败不发单步，排队断开不派发业务请求', {timeout:12000},async t=>{
  const home=await mkdtemp(join(tmpdir(),'fishops-read-reject-'));t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  const host=await launch(home,false,{kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'account-a',nick:'甲'}})
  t.after(()=>host.stop())

  const rejectedPromise=host.call('search.items',{keyword:'手机',maxAgeSec:0})
  const rejectedPage=await nextMessage(host,'resolve-page')
  host.child.stdin.write(frame({kind:'page-context',id:rejectedPage.id,context:null,reason:'PAGE_NOT_READY'}))
  const rejected=await rejectedPromise
  assert.equal(rejected.status,503)
  assert.equal(rejected.body.error.code,'PAGE_NOT_READY')
  assert.equal(host.messages.some(message=>message.kind==='request-step'),false)

  // 第一个调用占用单槽；第二个请求在排队时断开，必须返回 CANCELLED 且不发送新步骤。
  const first=host.call('item.detail',{itemId:'1',maxAgeSec:0})
  const firstPage=await nextMessage(host,'resolve-page')
  host.child.stdin.write(frame({kind:'page-context',id:firstPage.id,context:{tabId:7,documentId:'doc-a'}}))
  const firstStep=await nextMessage(host,'request-step')
  assert.equal(firstStep.method,'item.detail')

  const controller=new AbortController()
  const queued=fetch(`http://127.0.0.1:${host.port}/v1/search.suggest`,{
    method:'POST',
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:JSON.stringify({keyword:'手机'}),
    signal:controller.signal,
  })
  await new Promise(resolve=>setTimeout(resolve,50))
  controller.abort()
  await assert.rejects(queued)

  await new Promise(resolve=>setTimeout(resolve,50))
  assert.equal(host.messages.filter(message=>message.kind==='request-step').length,0)
  host.child.stdin.write(frame({kind:'step-result',id:firstStep.id,terminal:true,ok:true,data:detailFixture}))
  assert.equal((await first).status,200)
})

test('真实host：聊天投递提交后ACK，重投不重复事件且SSE可恢复', {timeout:8000}, async t => {
  const home=await mkdtemp(join(tmpdir(),'fishops-chat-delivery-'));t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  const host=await launch(home,false,{kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'test-account',nick:'测试'}})
  t.after(()=>host.stop())
  const delivery={kind:'chat-delivery',accountId:'test-account',message:{sourceId:'source-1',sessionId:'session-1',senderId:'peer',text:'测试消息',sentAt:100}}
  host.child.stdin.write(frame(delivery))
  const ack=await nextMessage(host,'chat-ack')
  assert.equal(ack.sourceId,'source-1')
  const abort=new AbortController();t.after(()=>abort.abort())
  const response=await fetch(`http://127.0.0.1:${host.port}/v1/events?types=chat.message`,{headers:{authorization:`Bearer ${token}`,'Last-Event-ID':'0'},signal:abort.signal})
  const reader=response.body.getReader()
  let text=''
  while(!text.includes('source-1')){const chunk=await reader.read();assert.equal(chunk.done,false);text+=new TextDecoder().decode(chunk.value)}
  assert.ok(text.includes(`id: ${ack.eventSeq}`))
  abort.abort();await reader.cancel().catch(()=>{})
  host.child.stdin.write(frame(delivery))
  assert.deepEqual(await nextMessage(host,'chat-ack'),ack)
  const events=(await host.call('events.list',{types:['chat.message']})).body.data.items
  assert.equal(events.length,1)
  assert.equal(events[0].seq,ack.eventSeq)
})

test('真实host：聊天本地查询分页、账号隔离和参数拒绝不触发平台步骤', {timeout:8000}, async t => {
  const home=await mkdtemp(join(tmpdir(),'fishops-chat-query-'));t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  const host=await launch(home,false,{kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'a',nick:'测试'}})
  t.after(()=>host.stop())
  for(let n=1;n<=3;n++){
    host.child.stdin.write(frame({kind:'chat-delivery',accountId:'a',message:{sourceId:`m${n}`,sessionId:'s',senderId:'p',text:'测试',sentAt:n}}))
    await nextMessage(host,'chat-ack')
  }
  const first=await host.call('chat.messages',{sessionId:'s',limit:2})
  assert.equal(first.status,200);assert.equal(first.body.data.items.length,2);assert.equal(first.body.data.hasMore,true)
  const last=await host.call('chat.messages',{sessionId:'s',afterSeq:first.body.data.nextAfterSeq,limit:2})
  assert.equal(last.body.data.items.length,1);assert.equal(last.body.data.hasMore,false)
  assert.equal((await host.call('chat.conversations')).body.data.items.length,1)
  for(const params of [{},{sessionId:'s',limit:0},{sessionId:'s',afterSeq:'01'},{sessionId:'s',unknown:true}])assert.equal((await host.call('chat.messages',params)).status,400)
  host.child.stdin.write(frame({kind:'event',type:'account.changed',data:{account:{userId:'b',nick:'测试'}}}))
  await new Promise(resolve=>setTimeout(resolve,20))
  assert.equal((await host.call('chat.messages',{sessionId:'s'})).body.data.items.length,0)
  assert.equal((await host.call('chat.conversations')).body.data.items.length,0)
  host.child.stdin.write(frame({kind:'event',type:'account.changed',data:{account:null}}))
  await new Promise(resolve=>setTimeout(resolve,20))
  assert.equal((await host.call('chat.conversations')).body.error.code,'LOGIN_REQUIRED')
  assert.equal(host.messages.some(message=>['resolve-page','request-step','req'].includes(message.kind)),false)
})

test('真实host：chat.send经固定页面单步发送，同key不重复发包', {timeout:10000}, async t => {
  const home=await mkdtemp(join(tmpdir(),'fishops-chat-send-'));t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  const host=await launch(home,false,{kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'a',nick:'测试'}})
  t.after(()=>host.stop())
  let steps=0
  const driver=(async()=>{
    for(;;){
      const page=await nextMessage(host,'resolve-page',8000)
      host.child.stdin.write(frame({kind:'page-context',id:page.id,context:{tabId:7,documentId:'doc-1'}}))
      const step=await nextMessage(host,'request-step',8000)
      assert.equal(step.method,'chat.send')
      assert.deepEqual(step.params,{sessionId:'s',receiverId:'r',text:'询价'})
      assert.equal(step.context.accountId,'a');assert.equal(step.context.tabId,7);assert.equal(step.context.documentId,'doc-1')
      steps+=1
      host.child.stdin.write(frame({kind:'step-result',id:step.id,terminal:true,ok:true,data:{messageId:'m1',sentAt:1}}))
    }
  })()
  const input={sessionId:'s',receiverId:'r',text:'询价',idempotencyKey:'k1'}
  const first=await host.call('chat.send',input)
  assert.equal(first.status,200);assert.deepEqual(first.body.data,{messageId:'m1',sentAt:1})
  const second=await host.call('chat.send',input)
  assert.equal(second.status,200);assert.deepEqual(second.body.data,{messageId:'m1',sentAt:1})
  await new Promise(resolve=>setTimeout(resolve,60))
  assert.equal(steps,1,'同幂等键不得第二次发送')
  const records=(await host.call('requests.list')).body.data.items
  assert.ok(records.some(record=>record.method==='chat.send'&&record.status==='succeeded'))
  const conflict=await host.call('chat.send',{...input,text:'改价'})
  assert.equal(conflict.status,409);assert.equal(conflict.body.error.code,'IDEMPOTENCY_CONFLICT')
  void driver.catch(()=>{})
})

test('真实host：chat.sync经固定页面单步拉取并持久化会话', {timeout:10000}, async t => {
  const home=await mkdtemp(join(tmpdir(),'fishops-chat-sync-'));t.after(()=>rm(home,{recursive:true,force:true}))
  await writeFile(join(home,'config.json'),JSON.stringify({port:0,token}),{mode:0o600})
  const host=await launch(home,false,{kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:{userId:'a',nick:'测试'}})
  t.after(()=>host.stop())
  const driver=(async()=>{
    for(;;){
      const page=await nextMessage(host,'resolve-page',8000)
      host.child.stdin.write(frame({kind:'page-context',id:page.id,context:{tabId:9,documentId:'doc-2'}}))
      const step=await nextMessage(host,'request-step',8000)
      assert.equal(step.method,'chat.sync.page')
      host.child.stdin.write(frame({kind:'step-result',id:step.id,terminal:true,ok:true,data:{mode:'conversations',conversations:[{sessionId:'c1',peerUserId:'p',itemId:null,updatedAt:5,sortIndex:'5'}],hasMore:false,nextAnchor:null,unsupportedCount:0}}))
    }
  })()
  const result=await host.call('chat.sync',{})
  assert.equal(result.status,200)
  assert.equal(result.body.data.completion,'complete')
  const conversations=(await host.call('chat.conversations')).body.data.items
  assert.equal(conversations.length,1);assert.equal(conversations[0].sessionId,'c1')
  void driver.catch(()=>{})
})
