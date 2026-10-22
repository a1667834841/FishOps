import { pathToFileURL } from 'node:url'
import { chmod } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { loadConfig } from './config.ts'
import { HostDatabase } from './database.ts'
import { NativeBridge } from './bridge.ts'
import { HANDOFF_HEADER, HostServer } from './server.ts'
import { createReadService } from './read-service.ts'
import { createChatSyncService } from './chat-sync-service.ts'
import { createChatWriteService } from './chat-write-service.ts'
import { createPublishService } from './publish-service.ts'
import { createSyncCursorCodec } from './sync-cursor.ts'
import { Scheduler } from './scheduler.ts'
import { ChatGapLedger } from './chat-gap-ledger.ts'
import type { GapOccurrence } from '../../../packages/protocol/src/chat-gap.ts'

const HANDOFF_TIMEOUT_MS=5_000
/** 新 host 收到 hello 后先等旧实例自然释放端口，避免重载窗口内无意义接管。 */
const HANDOFF_PORT_WAIT_MS=3_000
const DEFAULT_NATIVE_READY_TIMEOUT_MS=10_000
/** Chrome 重载时新旧 host 交接窗口；只对已成功 hello 的实例生效。 */
const HANDOFF_EOF_GRACE_MS=750

/** 等待新 native 连接完成 hello；没有新扩展连接时不得接管旧实例。 */
async function waitForNativeReady(bridge:NativeBridge,timeoutMs:number,isClosing:()=>boolean):Promise<boolean>{
  const deadline=Date.now()+timeoutMs
  while(!isClosing()&&Date.now()<deadline){
    if(bridge.ready)return true
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  return bridge.ready
}

/** 请求同部署旧 host 优雅退出，并核对响应标记，避免误接管其他本地服务。 */
async function handoffFrom(port:number,token:string,requesterPid:number,requesterToken:string):Promise<void>{
  const response=await fetch(`http://127.0.0.1:${port}/v1/host.handoff`,{
    method:'POST',
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json',[HANDOFF_HEADER]:`${requesterPid}:${requesterToken}`},
    body:'{}',
    signal:AbortSignal.timeout(HANDOFF_TIMEOUT_MS),
  })
  const body=await response.json().catch(()=>null) as {ok?:boolean;data?:{host?:string}}|null
  if(!response.ok||body?.ok!==true||body.data?.host!=='fishopshost'){
    throw new Error('端口被其他服务占用')
  }
}

/** 有界等待监听端口释放；不终止占用端口的其他进程。 */
async function waitForPort(server:HostServer,timeoutMs:number):Promise<number|null>{
  const deadline=Date.now()+timeoutMs
  while(Date.now()<deadline){
    try{return await server.listen()}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EADDRINUSE')throw error}
    await new Promise(resolve=>setTimeout(resolve,50))
  }
  return null
}

/** 按账号和原因持久记录缺口；同一缺口未清除前只生成一次事件。 */
export function persistChatGap(db:HostDatabase,accountId:string,reason:'OUTBOX_CAPACITY'|'PAGE_GAP'):boolean {
  if(typeof accountId!=='string'||!accountId.trim()||accountId.length>128||!['OUTBOX_CAPACITY','PAGE_GAP'].includes(reason))throw new Error('缺口参数无效')
  const key=`chat-gap:${JSON.stringify([accountId,reason])}`
  db.db.exec('BEGIN IMMEDIATE')
  try{
    const inserted=db.db.prepare('INSERT OR IGNORE INTO state(key,value) VALUES(?,?)').run(key,JSON.stringify({reason})).changes!==0
    if(inserted)db.event('chat.gap',{reason},accountId)
    db.db.exec('COMMIT')
    return inserted
  }catch(error){db.db.exec('ROLLBACK');throw error}
}

/** 缺口身份和事件原子提交；迟到重投不重复发事件，失败不留下半条证据。 */
export function persistChatGapOccurrence(db:HostDatabase,ledger:ChatGapLedger,occurrence:GapOccurrence):boolean {
  db.db.exec('BEGIN IMMEDIATE')
  try{
    const result=ledger.ingest(occurrence)
    if(result.status==='inserted')db.event('chat.gap',{reason:occurrence.reason,occurrenceId:occurrence.occurrenceId,generation:result.generation,scope:result.lineScope},occurrence.accountId)
    db.db.exec('COMMIT')
    return result.status==='inserted'
  }catch(error){db.db.exec('ROLLBACK');throw error}
}

async function main(){
  const config=await loadConfig(), db=new HostDatabase(config.database)
  const gapLedger=new ChatGapLedger(db)
  await chmod(config.database,0o600)
  let server:HostServer|undefined
  let bridge:NativeBridge|undefined
  let scheduler:Scheduler|undefined
  let closing:Promise<void>|null=null
  let sawNative=false
  let handoffScheduled=false
  /** 旧实例收到接管后先释放监听端口；新实例能立即绑定，旧数据库与在途任务在后台收尾。 */
  function handoff():void {
    if(handoffScheduled)return
    handoffScheduled=true
    scheduler?.close();bridge?.close()
    if(server)void server.close()
    process.stdin.pause()
    setTimeout(()=>{try{db.close()}catch{}process.exit(0)},250)
  }
  function shutdown(force=false):void {if(closing)return;closing=(async()=>{const deadline=setTimeout(()=>process.exit(1),5000);scheduler?.close();bridge?.close()
    if(server)await Promise.race([server.close(),new Promise(resolve=>setTimeout(resolve,force?500:4500))])
    db.close();clearTimeout(deadline);process.exit(0)})()}
  bridge=new NativeBridge(process.stdin,process.stdout,(type,data)=>{
    // hello 也会以 account.changed 回调进入这里；记录本实例确实服务过 native 对端。
    sawNative=true
    if(type==='account.changed'){if(db.setAccount((data as any).account))server?.notifyAccountChanged(data)}
    else server?.publishEvent(type,data)
  },config.home===process.env.FISHOPS_HOME&&process.env.FISHOPS_BRIDGE_TIMEOUT_MS?Number(process.env.FISHOPS_BRIDGE_TIMEOUT_MS):30_000,()=>{
    // Chrome 可能已把新 hello 交给同进程的第二个 Port；等待旧 stdin 结束后仍走正常关闭。
    process.stdin.pause()
    void shutdown()
  },(accountId,message)=>{
    const result=db.ingestChatMessage(accountId,message)
    // 只重放已提交事件；不能调用会再次插入事件的 publishEvent。
    if(result.inserted)server?.notifyPersistedEvents()
    return result
  },(accountId,reason,occurrence)=>{
    if(occurrence){
      // 与旧缺口标记分开去重，旧标记不能吞掉新的发生代次。
      if(persistChatGapOccurrence(db,gapLedger,occurrence))server?.notifyPersistedEvents()
      return
    }
    if(persistChatGap(db,accountId,reason))server?.notifyPersistedEvents()
  })
  scheduler=new Scheduler({now:()=>Date.now(),setTimer:(callback,delay)=>setTimeout(callback,delay),clearTimer:handle=>clearTimeout(handle as ReturnType<typeof setTimeout>),load:accountId=>db.loadSchedule(accountId),save:(accountId,snapshot)=>db.saveSchedule(accountId,snapshot)})
  const readService=createReadService({
    db,
    accountId:()=>bridge?.account?.userId??null,
    now:()=>Date.now(),
    schedule:(input,execute,signal)=>scheduler!.run(input,execute,signal),
    execute:async(method,params,accountId)=>{
      // 每次在调度槽内重新定位唯一活动闲鱼页，不把 tab/document 作为长期状态保存。
      return bridge!.callPageStep({requestId:randomUUID(),method,params,accountId})
    },
  })
  const chatSyncService=createChatSyncService({
    db, accountId:()=>bridge?.account?.userId??null, now:()=>Date.now(),
    codec:createSyncCursorCodec(config.token),
    resolvePage:accountId=>bridge!.callResolvePage(accountId),
    executePage:(params,context)=>bridge!.callStep({requestId:randomUUID(),method:'chat.sync.page',params,context}),
    schedule:(input,execute,signal)=>scheduler!.run(input,execute,signal),
  })
  const chatWriteService=createChatWriteService({
    db, accountId:()=>bridge?.account?.userId??null,
    schedule:(input,execute,signal)=>scheduler!.run(input,execute,signal),
    executeSend:({sessionId,receiverId,text,accountId})=>bridge!.callPageStep({
      requestId:randomUUID(), method:'chat.send', params:{sessionId,receiverId,text}, accountId,
    }) as Promise<{messageId:string;sentAt:number}>,
  })
  const publishService=createPublishService({
    db, accountId:()=>bridge?.account?.userId??null, now:()=>Date.now(),
    schedule:(input,execute,signal)=>scheduler!.run(input,execute,signal),
    resolvePage:accountId=>bridge!.callResolvePage(accountId),
    // 发布单步尚未进入协议 step 白名单：这里只按固定账户与已定位页面透传，扩展侧执行器补齐后再收窄类型。
    executePage:(step:{method:string;params:unknown;context:{accountId:string;tabId:number;documentId:string}})=>bridge!.callStep({
      requestId:randomUUID(), method:step.method, params:step.params, context:step.context,
    } as Parameters<NativeBridge['callStep']>[0]),
  })
  server=new HostServer(config.port,config.token,bridge,db,readService,handoff,chatSyncService,chatWriteService,publishService)
  process.stdin.on('end',()=>{
    // 未握手直接 EOF 立即退出；已握手则给新 host 一个受控接管窗口，超时后仍退出。
    if(!sawNative){shutdown();return}
    setTimeout(shutdown,HANDOFF_EOF_GRACE_MS).unref()
  });process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown)
  const nativeReadyTimeout=config.home===process.env.FISHOPS_HOME&&process.env.FISHOPS_HANDOFF_NATIVE_READY_MS?
    Number(process.env.FISHOPS_HANDOFF_NATIVE_READY_MS):DEFAULT_NATIVE_READY_TIMEOUT_MS
  try{
    let port:number
    try{port=await server.listen()}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EADDRINUSE')throw error
      // 扩展重载可能留下旧 host。只有本进程已经收到新的 hello 才请求旧实例退出。
      if(!await waitForNativeReady(bridge,nativeReadyTimeout,()=>closing!==null))throw new Error('端口已被占用且没有新的 native 连接')
      // 旧实例通常会在 stdin 结束后自行释放端口；先做有界等待，减少接管和反复拉起。
      const released=await waitForPort(server,HANDOFF_PORT_WAIT_MS)
      if(released!==null){port=released}
      else{
        // Chrome 可能先拉起新 host，再让旧 stdin 收到 EOF；请求标记仅用于区分接管请求，不作为新握手证明。
        const pendingHandoff=crypto.randomUUID()
        try{await handoffFrom(config.port,config.token,process.pid,pendingHandoff)}
        catch(error){
          // 旧实例正常 EOF 后可能已自行退出；先确认端口是否已经释放，再决定失败。
          try{port=await server.listen()}catch{throw error}
          process.stderr.write(JSON.stringify({event:'listening',port})+'\n')
          return
        }
        const afterHandoff=await waitForPort(server,HANDOFF_TIMEOUT_MS)
        if(afterHandoff===null)throw new Error(`端口 ${config.port} 释放超时`)
        port=afterHandoff
      }
    }
    process.stderr.write(JSON.stringify({event:'listening',port})+'\n')
  }
  catch(error){process.stderr.write(`host 启动失败：${(error as Error).message}\n`);scheduler.close();bridge.close();process.stdin.pause();db.close();process.exit(1)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main().catch(()=>{process.stderr.write('host 启动失败：配置或初始化无效\n');process.stdin.pause();process.exit(1)})
