import { persistChatGap } from './main.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { NativeBridge, type ChatGapHandler, type ChatDeliveryHandler } from './bridge.ts'
import { HostDatabase } from './database.ts'
import { encodeFrame, FrameDecoder } from './framing.ts'

const message={sourceId:'test-source',sessionId:'test-session',senderId:'test-sender',text:'测试消息',sentAt:123}
const delivery={kind:'chat-delivery' as const,accountId:'test-account',message}
function fixture(t:any,handler?:ChatDeliveryHandler,ready=true,gap?:ChatGapHandler){
  const input=new PassThrough(),output=new PassThrough(),sent:unknown[]=[]
  const decoder=new FrameDecoder()
  output.on('data',chunk=>sent.push(...decoder.push(chunk)))
  let fatal=0
  const bridge=new NativeBridge(input,output,()=>{},1000,()=>{fatal++},handler,gap)
  t.after(()=>{bridge.close();input.destroy();output.destroy()})
  if(ready)input.write(encodeFrame({kind:'hello',protocolVersion:1,extensionVersion:'test',account:{userId:'test-account',nick:'测试'}}))
  return{input,bridge,sent,fatal:()=>fatal}
}

test('提交后才ACK，重复投递相同ACK且只保存一条消息和事件',t=>{
  const db=new HostDatabase(':memory:');t.after(()=>db.close())
  let calls=0
  const f=fixture(t,(account,m)=>{
    assert.equal(f.sent.length,calls)
    calls++
    const result=db.ingestChatMessage(account,m)
    assert.equal(db.chatMessages(account,{sessionId:m.sessionId}).items[0].seq,result.eventSeq)
    return result
  })
  f.input.write(encodeFrame(delivery));f.input.write(encodeFrame(delivery))
  assert.equal(f.sent.length,2);assert.deepEqual(f.sent[0],f.sent[1])
  assert.deepEqual(f.sent[0],{kind:'chat-ack',accountId:'test-account',sourceId:message.sourceId,eventSeq:'1'})
  assert.equal(db.events({types:['chat.message']},'test-account').items.length,1)
  assert.equal(f.bridge.ready,true)
})

test('写入失败、未配置回调或非法提交结果无ACK且失败关闭',t=>{
  for(const handler of [undefined,()=>{throw new Error('模拟写失败')},()=>({eventSeq:'0',inserted:true}),()=>({eventSeq:'01',inserted:true})]){
    const f=fixture(t,handler)
    f.input.write(encodeFrame(delivery))
    assert.equal(f.sent.length,0);assert.equal(f.bridge.ready,false);assert.equal(f.fatal(),1)
  }
})

test('握手前、账号不符和反方向帧失败关闭且不落库',t=>{
  for(const mode of ['before','account','direction']){
    let calls=0
    const f=fixture(t,()=>{calls++;return{eventSeq:'1',inserted:true}},mode!=='before')
    f.input.write(encodeFrame(mode==='direction'?{kind:'chat-ack',accountId:'test-account',sourceId:'test-source',eventSeq:'1'}:
      mode==='account'?{...delivery,accountId:'other-test-account'}:delivery))
    assert.equal(calls,0);assert.equal(f.sent.length,0);assert.equal(f.bridge.ready,false);assert.equal(f.fatal(),1)
  }
})

test('坏消息和额外字段拒绝；粘连帧关闭后不继续处理有效交付',t=>{
  for(const bad of [{...delivery,message:{...message,tag:'forged'}},{...delivery,secret:'forbidden'},{...delivery,message:{...message,sentAt:-1}}]){
    let calls=0
    const f=fixture(t,()=>{calls++;return{eventSeq:'1',inserted:true}})
    f.input.write(encodeFrame(bad as any))
    assert.equal(calls,0);assert.equal(f.sent.length,0);assert.equal(f.bridge.ready,false)
  }
  let calls=0
  const f=fixture(t,()=>{calls++;return{eventSeq:'1',inserted:true}})
  f.input.write(Buffer.concat([encodeFrame({kind:'chat-ack',accountId:'test-account',sourceId:'s',eventSeq:'1'}),encodeFrame(delivery)]))
  assert.equal(calls,0);assert.equal(f.sent.length,0)
})


test('缺口持久提交并按账号原因去重，重放不创建重复事件',t=>{
  const db=new HostDatabase(':memory:');t.after(()=>db.close())
  let notified=0
  const f=fixture(t,undefined,true,(account,reason)=>{if(persistChatGap(db,account,reason))notified++})
  const gap={kind:'chat-gap' as const,accountId:'test-account',reason:'PAGE_GAP' as const}
  f.input.write(encodeFrame(gap));f.input.write(encodeFrame(gap))
  assert.equal(notified,1);assert.equal(f.bridge.ready,true);assert.equal(f.sent.length,0)
  const events=db.events({},'test-account').items
  assert.equal(events.length,1);assert.equal(events[0].type,'chat.gap');assert.deepEqual(events[0].data,{reason:'PAGE_GAP'})
  assert.equal(db.events({},'other-account').items.length,0)
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM state').get()?.n,1)
  f.input.write(encodeFrame({...gap,reason:'OUTBOX_CAPACITY'}))
  assert.equal(notified,2)
})

test('缺口错误账号、握手前和坏帧均不持久化',t=>{
  for(const mode of ['before','account','bad']){
    let calls=0
    const f=fixture(t,undefined,mode!=='before',()=>{calls++})
    f.input.write(encodeFrame({kind:'chat-gap',accountId:mode==='account'?'other-account':'test-account',reason:mode==='bad'?'INVALID':'PAGE_GAP'} as any))
    assert.equal(calls,0);assert.equal(f.bridge.ready,false);assert.equal(f.sent.length,0)
  }
})

test('缺口写入失败原子回滚并关闭通道，无ACK',t=>{
  const db=new HostDatabase(':memory:');t.after(()=>db.close())
  db.db.exec("CREATE TRIGGER fail_gap BEFORE INSERT ON events WHEN NEW.type='chat.gap' BEGIN SELECT RAISE(ABORT,'test'); END")
  const f=fixture(t,undefined,true,(account,reason)=>{persistChatGap(db,account,reason)})
  f.input.write(encodeFrame({kind:'chat-gap',accountId:'test-account',reason:'PAGE_GAP'}))
  assert.equal(f.bridge.ready,false);assert.equal(f.sent.length,0)
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM state').get()?.n,0)
  assert.equal(db.highWater(),'0')
})
