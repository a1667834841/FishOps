import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { METHODS, unobservedRisk, validateParams, type ErrorCode, type PublishMethod } from '../../../packages/protocol/src/index.ts'
import type { ReadMethod } from '../../../packages/protocol/src/business.ts'
import { HostDatabase } from './database.ts'
import { NativeBridge } from './bridge.ts'
import { normalizeReadInput, type createReadService } from './read-service.ts'
import type { createChatWriteService } from './chat-write-service.ts'
import type { createPublishService } from './publish-service.ts'
import { ChatGapLedger } from './chat-gap-ledger.ts'

type Client={res:ServerResponse;account:string|null;last:string;filter:{types?:string[];tag?:string};busy:boolean;closed:boolean;blocked:boolean;buffered:number;pending:string[]}
type ReadService = ReturnType<typeof createReadService>
type ChatWriteService = ReturnType<typeof createChatWriteService>
type PublishService = ReturnType<typeof createPublishService>
const READ_METHODS: readonly ReadMethod[] = ['search.items','search.suggest','item.detail']
/** 发布写方法；myItems 是只读确认，不计入这里。 */
const PUBLISH_WRITE_METHODS: readonly PublishMethod[] = ['publish.prepare','publish.submit']
/** 公共错误到 HTTP 状态码的统一映射；未知错误必须落到 500，不能伪装成功。 */
const ERROR_STATUS: Partial<Record<ErrorCode,number>> = {
  BAD_REQUEST:400, NOT_FOUND:404, EXTENSION_OFFLINE:503, PAGE_NOT_READY:503, LOGIN_REQUIRED:503,
  TIMEOUT:504, RESULT_UNKNOWN:409, IDEMPOTENCY_CONFLICT:409, ACCOUNT_CHANGED:409,
  RISK_BLOCKED:409, PLATFORM_REJECTED:409, CANCELLED:499,
}
export const HANDOFF_HEADER = 'x-fishops-handoff'

/** 非法或关闭式配置回退到 30 分钟，避免 NaN/零值静默关闭熔断。 */
export function riskCooldownFromEnv(value: string | undefined): number {
  const duration = Number(value)
  return Number.isSafeInteger(duration) && duration > 0 ? duration : 30 * 60_000
}

export class HostServer {
  server; clients=new Set<Client>(); stopped=false
  private port:number;private token:string;private bridge:NativeBridge;private db:HostDatabase;private readService?:ReadService;private chatSyncService?:{call(raw:unknown,signal?:AbortSignal):Promise<unknown>}
  private onHandoff?:()=>void
  private chatWriteService?: ChatWriteService
  private publishService?: PublishService
  /** 接管请求只处理一次，避免并发启动互相踢端口。 */
  private handoffUsed=false
  /**
   * 风控熔断：账号收到 RISK_BLOCKED 后，冷却期内拒绝一切会触达平台的方法，
   * 避免 Agent 在验证码未处理时继续请求加重风控。
   * 冷却状态持久化在 SQLite state：Host 重启后仍然生效，只有到期或人工清除才解除。
   */
  readonly riskCooldownMs=riskCooldownFromEnv(process.env.FISHOPS_RISK_COOLDOWN_MS)
  /** 人工完成验证后可调用以提前解除熔断（运维入口，非 Agent 自动调用）。 */
  clearRisk(accountId?:string){this.db.clearRiskCooldown(accountId)}
  /** 读取账号冷却到期时间；无账号（未登录）时不熔断，过期条目由数据库层顺手清理。 */
  #riskUntil(accountId:string|null):number{return accountId?this.db.riskCooldownUntil(accountId,Date.now()):0}
  constructor(port:number,token:string,bridge:NativeBridge,db:HostDatabase,readService?:ReadService,onHandoff?:()=>void,chatSyncService?:{call(raw:unknown,signal?:AbortSignal):Promise<unknown>},chatWriteService?:ChatWriteService,publishService?:PublishService) {
    this.port=port;this.token=token;this.bridge=bridge;this.db=db;this.readService=readService;this.onHandoff=onHandoff;this.chatSyncService=chatSyncService;this.chatWriteService=chatWriteService;this.publishService=publishService
    this.server=createServer((req,res)=>void this.#handle(req,res))
  }
  listen():Promise<number>{return new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,'127.0.0.1',()=>{this.server.removeListener('error',reject);resolve((this.server.address() as any).port)})})}
  #send(res:ServerResponse,status:number,requestId:string,error?:{code:string;message:string;phase?:string;retryable?:boolean},data?:unknown){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(error?{ok:false,error,meta:{requestId,risk:unobservedRisk()}}:{ok:true,data,meta:{requestId,risk:unobservedRisk()}}))}
  /**
   * 平台风控与登录失效是关键停止信号。
   *
   * accountId 必须由调用方按请求开始时的账号快照传入：在途切换账号后，迟到的结果仍记到
   * 发起请求的账号，既不误熔断新账号，也不把旧账号的事件发给新账号的订阅者。
   * 这类结果必须先落库再通知 SSE；成功、缓存命中或本地错误都不能清除该状态。
   * 事件只保存固定分类，不写平台正文、cookie 或请求参数。
   */
  #recordReadRisk(code: string, accountId: string | null): void {
    if (code !== 'RISK_BLOCKED' && code !== 'LOGIN_REQUIRED') return
    if (code === 'RISK_BLOCKED' && accountId) this.db.setRiskCooldown(accountId, Date.now() + this.riskCooldownMs)
    this.publishEvent('risk.signal', {
      level: code === 'RISK_BLOCKED' ? 'blocked' : 'caution',
      signal: code === 'RISK_BLOCKED' ? 'CAPTCHA' : 'LOGIN_REQUIRED',
    }, accountId)
  }
  #auth(req:IncomingMessage,res:ServerResponse,id:string):boolean {
    if(req.headers.origin!==undefined){this.#send(res,403,id,{code:'ORIGIN_FORBIDDEN',message:'不接受跨域请求'});return false}
    const got=/^Bearer (.+)$/.exec(String(req.headers.authorization??''))?.[1]??'',a=Buffer.from(got),b=Buffer.from(this.token)
    if(a.length!==b.length||!timingSafeEqual(a,b)){this.#send(res,401,id,{code:'UNAUTHORIZED',message:'认证失败'});return false} return true
  }
  async #body(req:IncomingMessage):Promise<unknown>{let size=0,chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>65536)throw Object.assign(new Error(),{code:'PAYLOAD_TOO_LARGE'});chunks.push(Buffer.from(chunk))}let v:unknown;try{v=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Object.assign(new Error(),{code:'BAD_REQUEST'})}if(!v||typeof v!=='object'||Array.isArray(v))throw Object.assign(new Error(),{code:'BAD_REQUEST'});return v}
  async #handle(req:IncomingMessage,res:ServerResponse){const id=randomUUID();if(!this.#auth(req,res,id))return
    if(req.method==='GET'&&req.url?.startsWith('/v1/events')){this.#sse(req,res,id);return}
    if(req.method!=='POST'){this.#send(res,405,id,{code:'METHOD_NOT_ALLOWED',message:'仅允许 POST'});return}
    if(req.url==='/v1/host.handoff'){
      let body:unknown
      try{body=await this.#body(req)}catch(e){const code=(e as any).code??'BAD_REQUEST';this.#send(res,code==='PAYLOAD_TOO_LARGE'?413:400,id,{code,message:'请求参数无效'});return}
      const requester=req.headers[HANDOFF_HEADER]
      if(!body||Object.keys(body as object).length||typeof requester!=='string'||
        !/^[1-9]\d*:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requester)){
        this.#send(res,400,id,{code:'BAD_REQUEST',message:'请求参数无效'});return
      }
      // 接管需要部署 token；请求标记本身不证明调用者是新 host。旧 native 在线时不得抢端口，
      // 否则新实例会误把仍在服务的旧实例踢掉，形成反复拉起。
      if(this.bridge.ready||this.handoffUsed){
        this.#send(res,409,id,{code:'RESULT_UNKNOWN',message:'旧实例仍连接 native 或已处理过接管'})
        return
      }
      this.handoffUsed=true
      // 先确认可安全退出再响应；`finish`/`close` 可能都触发，因此只执行一次。
      let handedOff=false
      const handoff=()=>{
        if(handedOff)return
        handedOff=true
        try{this.onHandoff?.()}catch{}
      }
      this.#send(res,200,id,undefined,{
        host:'fishopshost',
        pid:process.pid,
        nativeConnected:this.bridge.ready,
      })
      res.once('finish',handoff)
      res.once('close',handoff)
      return
    }
    // 方法名允许大写（例如 publish.myItems）；是否注册仍由 METHODS 白名单决定。
    const match=/^\/v1\/([A-Za-z.]+)$/.exec(req.url??'');if(!match){this.#send(res,404,id,{code:'NOT_FOUND',message:'未知路由'});return}
    const method=match[1];if(!METHODS.includes(method as any)){this.#send(res,404,id,{code:'NOT_FOUND',message:'未知方法'});return}
    let params:Record<string,unknown>;try{params=validateParams(method,await this.#body(req))}catch(e){const code=(e as any).code??(e as Error).message;this.#send(res,code==='NOT_FOUND'?404:code==='PAYLOAD_TOO_LARGE'?413:400,id,{code,message:code==='NOT_FOUND'?'未知方法':'请求参数无效'});return}
    const tag=typeof params.tag==='string'?params.tag:null
    // 请求开始时的账号快照：风控记账与 requests 审计都归属发起请求的账号，
    // 在途切换账号时不把 A 的结果记到 B，也不会误熔断 B。
    const requestAccount=this.bridge.account?.userId??null
    if(method==='events.list'||method==='requests.list'){
      try{const data=method==='events.list'?this.db.events(params as any,requestAccount):this.db.requests(params as any,requestAccount);if(method==='events.list'){this.db.request(id,method,tag,requestAccount);this.db.finish(id,'succeeded')}this.#send(res,200,id,undefined,data)}catch{this.#send(res,400,id,{code:'BAD_REQUEST',message:'游标无效'})}return
    }
    // 风控熔断查询/人工解除：只操作本地持久状态，不触达平台，因此放在熔断拦截之前。
    if(method==='risk.status'||method==='risk.clear'){
      const acct=requestAccount
      if(!acct){this.#send(res,503,id,{code:this.bridge.ready?'LOGIN_REQUIRED':'EXTENSION_OFFLINE',message:'需要当前已登录账号'});return}
      this.db.request(id,method,tag,acct)
      if(method==='risk.clear')this.clearRisk(acct)
      const until=this.#riskUntil(acct)
      this.db.finish(id,'succeeded')
      this.#send(res,200,id,undefined,{accountId:acct,blocked:until>Date.now(),blockedUntil:until>Date.now()?until:null})
      return
    }
    const platform=method==='chat.sync'||method==='chat.send'||method.startsWith('publish.')||READ_METHODS.includes(method as ReadMethod)
    if(platform&&requestAccount&&this.#riskUntil(requestAccount)>Date.now()){
      // 熔断拦截的请求不派发平台，但必须写入 requests 审计，让用户能解释“为什么没有发出”。
      this.db.request(id,method,tag,requestAccount)
      this.db.finish(id,'failed','RISK_BLOCKED')
      this.#send(res,409,id,{code:'RISK_BLOCKED',message:'账号处于风控冷却期，需人工完成验证后再试',phase:'queue',retryable:false});return
    }
    if(method==='chat.sync.status'){
      const runId=String(params.runId)
      const rows=this.db.db.prepare("SELECT value FROM state WHERE key LIKE 'chat.sync.service:%'").all() as Array<{value:string}>
      type SyncStatusRow = { accountId?: string | null; runId?: string; status?: string; result?: { runId?: string; committedPages?: number }; committedPages?: number }
      const matches=rows.map(row=>{try{return JSON.parse(row.value) as SyncStatusRow}catch{return null}})
        .filter((row): row is SyncStatusRow => row !== null && row.accountId === requestAccount && (row.runId ?? row.result?.runId) === runId)
      if(matches.length===0){this.#send(res,404,id,{code:'NOT_FOUND',message:'同步任务不存在'});return}
      // 下一页预留继承已提交页数；同进度优先在途/未知状态，避免首屏结果掩盖后续失败。
      const priority:Record<string,number>={reserved:1,committed:2,queued:3,attempting:4,unknown:5}
      const pages=(row:SyncStatusRow)=>Number.isSafeInteger(row.committedPages)?row.committedPages!:Number.isSafeInteger(row.result?.committedPages)?row.result!.committedPages!:0
      matches.sort((left,right)=>pages(right)-pages(left)||(priority[right.status??'']??0)-(priority[left.status??'']??0))
      const state=matches[0]!
      try {
      // 只读缺口可见性：合并新 ledger 与旧 state 标记两套来源，供调用方判断历史是否可能不完整。
      // 这里绝不清除任何缺口；clear 需要统一代次与覆盖证书后才能提供。
      const legacy=(this.db.db.prepare("SELECT key FROM state WHERE key LIKE 'chat-gap:%'").all() as Array<{key:string}>)
        .map(row=>{try{return JSON.parse(row.key.slice('chat-gap:'.length)) as unknown}catch{return null}})
        .filter((v):v is [string,string]=>Array.isArray(v)&&v[0]===requestAccount&&typeof v[1]==='string').map(v=>v[1]).sort()
      const ledger=requestAccount?new ChatGapLedger(this.db).snapshot(requestAccount).lines:[]
      const gaps={open:legacy.length>0||ledger.length>0,legacyReasons:legacy,ledger,cleared:false}
      this.#send(res,200,id,undefined,{runId,status:state.status,result:state.result ?? null,gaps})
      } catch {
        // 账本损坏不能伪装成没有缺口，也不能让异步请求异常终止 Host。
        this.#send(res,500,id,{code:'INTERNAL',message:'缺口状态读取失败'})
      }
      return
    }
    if(method==='chat.sync'){
      if(!this.chatSyncService){this.#send(res,503,id,{code:'PAGE_NOT_READY',message:'聊天同步尚未配置'});return}
      const controller=new AbortController();const onClose=()=>{if(!res.writableEnded)controller.abort()};res.once('close',onClose)
      try{const data=await this.chatSyncService.call(params,controller.signal);this.#send(res,200,id,undefined,data)}catch(e){const code=(e as any).code??'INTERNAL';this.#recordReadRisk(code,requestAccount);this.#send(res,code==='CANCELLED'?499:code==='RESULT_UNKNOWN'?409:code==='RISK_BLOCKED'?409:code==='LOGIN_REQUIRED'?503:code==='PAGE_NOT_READY'?503:code==='BAD_REQUEST'?400:500,id,{code,message:'聊天同步未完成',phase:(e as any).phase??'read',retryable:false})}finally{res.removeListener('close',onClose)}
      return
    }
    if(method==='chat.send'){
      if(!this.chatWriteService){this.#send(res,503,id,{code:'PAGE_NOT_READY',message:'聊天发送尚未配置'});return}
      const controller=new AbortController();const onClose=()=>{if(!res.writableEnded)controller.abort()};res.once('close',onClose)
      this.db.request(id,method,tag,requestAccount)
      try{
        const data=await this.chatWriteService.send(params,controller.signal)
        this.db.finish(id,'succeeded');this.#send(res,200,id,undefined,data)
      }catch(e){
        const code=(e as any).code??'INTERNAL';this.db.finish(id,'failed',code)
        // 聊天发送触发风控/登录失效时同样必须广播停止信号。
        this.#recordReadRisk(code,requestAccount)
        if(!res.destroyed)this.#send(res,ERROR_STATUS[code as ErrorCode]??500,id,{code,message:'聊天发送未完成',phase:(e as any).phase??'write',retryable:false})
      }finally{res.removeListener('close',onClose)}
      return
    }
    if(method==='chat.messages'||method==='chat.conversations'){
      const accountId=requestAccount
      if(!this.bridge.ready||!accountId){this.#send(res,503,id,{code:this.bridge.ready?'LOGIN_REQUIRED':'EXTENSION_OFFLINE',message:'聊天查询需要当前已登录账号'});return}
      this.db.request(id,method,tag,accountId)
      try{
        const data=method==='chat.messages'?this.db.chatMessages(accountId,params):this.db.chatConversations(accountId,params)
        this.db.finish(id,'succeeded');this.#send(res,200,id,undefined,data)
      }catch{
        this.db.finish(id,'failed','INTERNAL');this.#send(res,500,id,{code:'INTERNAL',message:'聊天记录读取失败'})
      }
      return
    }
    if(method==='publish.prepare'||method==='publish.submit'||method==='publish.myItems'){
      if(!this.publishService){this.#send(res,503,id,{code:'PAGE_NOT_READY',message:'发布编排尚未配置'});return}
      const write=PUBLISH_WRITE_METHODS.includes(method as PublishMethod)
      const controller=new AbortController()
      const onClose=()=>{if(!res.writableEnded)controller.abort()}
      res.once('close',onClose)
      // 写方法先落请求记录再派发：进程在平台包发送期间崩溃时历史仍然可解释。
      this.db.request(id,method,tag,requestAccount)
      try{
        const data=method==='publish.prepare'?await this.publishService.prepare(params,controller.signal)
          :method==='publish.submit'?await this.publishService.submit(params,controller.signal)
          :await this.publishService.myItems(params,controller.signal)
        this.db.finish(id,'succeeded');this.#send(res,200,id,undefined,data)
      }catch(e){
        const code=(e as any).code??'INTERNAL';this.db.finish(id,'failed',code)
        // 发布链路同样必须广播风控/登录停止信号；只映射 HTTP 会让 Agent 继续动作。
        this.#recordReadRisk(code,requestAccount)
        // 发布错误一律不可自动重试：未知结果必须由人工确认后才能新发动作。
        if(!res.destroyed)this.#send(res,ERROR_STATUS[code as ErrorCode]??500,id,{code,message:write?'发布操作未完成':'发布查询未完成',phase:(e as any).phase??(write?'write':'read'),retryable:false})
      }finally{res.removeListener('close',onClose)}
      return
    }
    if(READ_METHODS.includes(method as ReadMethod)){
      let readParams:Record<string,unknown>
      try{readParams=normalizeReadInput(method as ReadMethod,params)}catch(e){const code=(e as any).code??'BAD_REQUEST';this.#send(res,code==='NOT_FOUND'?404:400,id,{code,message:'请求参数无效'});return}
      const controller=new AbortController()
      const onClose=()=>{if(!res.writableEnded)controller.abort()}
      res.once('close',onClose)
      this.db.request(id,method,tag,requestAccount)
      try{
        if(!this.readService)throw Object.assign(new Error('只读业务服务尚未配置'),{code:'PAGE_NOT_READY',phase:'read',retryable:false})
        const result=await this.readService.call(method as ReadMethod,readParams,controller.signal)
        this.db.finish(id,'succeeded')
        this.#send(res,200,id,undefined,result.data)
      }catch(e){
        const code=(e as any).code??'INTERNAL'
        this.db.finish(id,'failed',code)
        this.#recordReadRisk(code,requestAccount)
        if(!res.destroyed)this.#send(res,ERROR_STATUS[code as ErrorCode]??500,id,{code,message:(e as Error).message||'只读业务失败',phase:(e as any).phase??'read',retryable:(e as any).retryable??false})
      }
      finally{res.removeListener('close',onClose)}
      return
    }
    this.db.request(id,method,tag,requestAccount)
    try{const ext=await this.bridge.call(method,params) as any;this.db.finish(id,'succeeded');const data={protocolVersion:1,hostVersion:'0.2.0',extensionVersion:ext.extensionVersion,extensionBuildId:this.bridge.extensionBuildId,nativeConnected:true,capabilities:[...METHODS],account:ext.account,page:ext.page,chatReady:null};this.#send(res,200,id,undefined,data)}catch(e){const err=(e as any).apiError,code=err?.code??(e as any).code??'INTERNAL';this.db.finish(id,'failed',code);const status=ERROR_STATUS[code as ErrorCode]??500;this.#send(res,status,id,{code,message:code==='TIMEOUT'?'扩展响应超时':err?.message??'扩展请求失败',phase:err?.phase??'read',retryable:err?.retryable??false})}
  }
  #sse(req:IncomingMessage,res:ServerResponse,id:string){
    let u:URL;try{u=new URL(req.url??'','http://127.0.0.1')}catch{this.#send(res,400,id,{code:'BAD_REQUEST',message:'参数无效'});return}
    if(u.pathname!='/v1/events'){this.#send(res,404,id,{code:'NOT_FOUND',message:'未知路由'});return}
    const allowed=new Set(['afterSeq','after','types','tag']);if([...u.searchParams.keys()].some(k=>!allowed.has(k))||[...allowed].some(k=>u.searchParams.getAll(k).length>1)||u.searchParams.has('afterSeq')&&u.searchParams.has('after')){this.#send(res,400,id,{code:'BAD_REQUEST',message:'查询参数无效'});return}
    const cursor=req.headers['last-event-id']!==undefined?req.headers['last-event-id']:u.searchParams.get('afterSeq')??u.searchParams.get('after')??'0'
    let types:string[]|undefined;const raw=u.searchParams.get('types');if(raw!==null)types=raw.split(',')
    const tag=u.searchParams.get('tag')??undefined
    try{validateParams('events.list',{afterSeq:cursor,types,tag})}catch{this.#send(res,400,id,{code:'BAD_REQUEST',message:'过滤或游标参数无效'});return}
    if(typeof cursor!=='string'){this.#send(res,400,id,{code:'BAD_REQUEST',message:'游标无效'});return}
    if(tag!==undefined&&(tag.length<1||tag.length>128)){this.#send(res,400,id,{code:'BAD_REQUEST',message:'tag 无效'});return}
    const client:Client={res,account:this.bridge.account?.userId??null,last:cursor,filter:{types,tag},busy:false,closed:false,blocked:false,buffered:0,pending:[]}
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache','connection':'keep-alive'});res.flushHeaders?.();this.clients.add(client)
    const end=()=>{client.closed=true;clearInterval(heartbeat);this.clients.delete(client);if(!res.writableEnded)res.end()}
    const heartbeat=setInterval(()=>{if(client.closed)return;this.#write(client,': keepalive\n\n')},15000);req.on('close',end);res.on('close',end);res.on('drain',()=>{client.blocked=false;this.#drain(client)});void this.#replay(client)
  }
  #write(c:Client,frame:string):boolean{if(c.closed)return false;const bytes=Buffer.byteLength(frame);if(c.buffered+c.res.writableLength+bytes>1024*1024){c.closed=true;c.pending.length=0;c.buffered=0;c.res.end();this.clients.delete(c);return false}c.buffered+=bytes;c.pending.push(frame);this.#drain(c);return !c.closed}
  #drain(c:Client){if(c.blocked||c.closed)return;while(c.pending.length){const frame=c.pending.shift()!;c.buffered-=Buffer.byteLength(frame);if(!c.res.write(frame)){c.blocked=true;break}}}
  async #replay(c:Client){if(c.closed||c.busy)return;c.busy=true;try{const high=this.db.highWater();while(!c.closed){const page=this.db.events({afterSeq:c.last,types:c.filter.types,tag:c.filter.tag,limit:100},c.account);if(!page.items.length)break;let advanced=false;for(const item of page.items){if(BigInt(item.seq)>BigInt(high))break;if(!this.#write(c,`id: ${item.seq}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`))return;c.last=item.seq;advanced=true}if(!page.hasMore||!advanced)break} }finally{c.busy=false}}
  /** 广播并持久化事件；accountId 缺省时归属数据库当前账号，显式传入用于按请求开始账号记账。 */
  publishEvent(type:string,data:unknown,accountId?:string|null){const seq=accountId===undefined?this.db.event(type,data):this.db.event(type,data,accountId);for(const c of this.clients){if(type==='account.changed'){const next=(data as any)?.account?.userId??null;if(next!==c.account){const safe={seq,type,ts:Date.now(),tag:null,data};this.#write(c,`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(safe)}\n\n`);c.closed=true;c.res.end();this.clients.delete(c)}}else void this.#replay(c)}return seq}
  /** 通知客户端读取已提交事件；调用者必须先完成事务，不能再次写入同一事件。 */
  notifyPersistedEvents():void {for(const client of this.clients)void this.#replay(client)}
  notifyAccountChanged(data:unknown){const event=this.db.latestAccountEvent();if(!event)return;for(const c of this.clients){const next=(data as any)?.account?.userId??null;if(next!==c.account){try{this.#write(c,`id: ${event.seq}\nevent: account.changed\ndata: ${JSON.stringify(event)}\n\n`)}finally{c.closed=true;c.res.end();this.clients.delete(c)}}}}
  async close(){this.stopped=true;for(const c of this.clients)c.res.end();this.clients.clear();this.server.closeAllConnections();await new Promise<void>(r=>this.server.close(()=>r()))}
}
