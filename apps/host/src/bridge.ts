import { isChatWire } from '../../../packages/protocol/src/chat-wire.ts'
import type { ChatMessage } from '../../../packages/protocol/src/chat.ts'
import type { GapOccurrence } from '../../../packages/protocol/src/chat-gap.ts'
import { randomUUID } from 'node:crypto'
import { isExtensionStatus, PROTOCOL_VERSION, type Account, type ExtensionStatus, type Wire } from '../../../packages/protocol/src/index.ts'
import { isPageWire, isResolvedPage, isStepWire, type PageWire, type ResolvedPage, type StepMethod, type StepParams, type StepWire } from '../../../packages/protocol/src/step.ts'
import { encodeFrame, FrameDecoder } from './framing.ts'
import type { HostWire } from './framing.ts'

type Pending = { resolve: (v: unknown)=>void; reject:(e:Error)=>void; timer:NodeJS.Timeout }
type StepPending = { id: string; accountId: string; resolve:(v:unknown)=>void; reject:(e:Error)=>void; accountChanged:boolean }
type PagePending = { id: string; accountId: string; resolve:(v:ResolvedPage)=>void; reject:(e:Error)=>void; timer:NodeJS.Timeout }
/** 同步提交聊天消息；只有事务提交后才返回事件序号。 */
export type ChatDeliveryHandler=(accountId:string,message:ChatMessage)=>{eventSeq:string;inserted:boolean}
export type ChatGapHandler=(accountId:string,reason:'OUTBOX_CAPACITY'|'PAGE_GAP',occurrence?:GapOccurrence)=>void
export class NativeBridge {
  #extensionBuildId: string | null = null
  #decoder = new FrameDecoder(); #pending = new Map<string,Pending>(); #stepPending:StepPending|null=null; #pagePending:PagePending|null=null; #ready=false; #closed=false
  #status: ExtensionStatus | null=null; #account:Account=null; #extensionVersion=''; #onEvent:(type:string,data:unknown)=>void
  private input:NodeJS.ReadableStream
  private output:NodeJS.WritableStream
  private timeout:number
  private onFatal:()=>void
  private onChatDelivery?:ChatDeliveryHandler
  private onChatGap?:ChatGapHandler
  private dataListener:(chunk:Buffer)=>void
  private endListener:()=>void
  private closeListener:()=>void
  private errorListener:()=>void
  constructor(input:NodeJS.ReadableStream, output:NodeJS.WritableStream, onEvent:(type:string,data:unknown)=>void, timeout=30_000,onFatal:()=>void=()=>{},onChatDelivery?:ChatDeliveryHandler,onChatGap?:ChatGapHandler) {
    this.input=input;this.output=output;this.timeout=timeout;this.#onEvent=onEvent
    this.onFatal=onFatal;this.onChatDelivery=onChatDelivery;this.onChatGap=onChatGap
    this.dataListener=(chunk)=>{try{for(const wire of this.#decoder.push(chunk))this.#receive(wire)}catch{this.#fail()}}
    this.endListener=()=>{try{this.#decoder.end()}catch{}this.#fail()}
    this.closeListener=()=>this.#fail()
    this.errorListener=()=>this.#fail()
    input.on('data',this.dataListener);input.once('end',this.endListener);input.once('close',this.closeListener);input.once('error',this.errorListener)
  }
  get ready(){return this.#ready} get account(){return this.#account}
  /** 标识仅属于当前已握手连接；旧扩展或连接断开均返回 null。 */
  get extensionBuildId(){return this.#ready ? this.#extensionBuildId : null}
  #receive(wire:HostWire) {
    // 粘连帧中前一帧失败关闭后，不得继续处理后续交付。
    if(this.#closed)return
    if(wire.kind==='chat-gap'){
      if(!this.#ready || this.#account?.userId!==wire.accountId || !this.onChatGap){this.#fail();return}
      try{
        const result:unknown=this.onChatGap(wire.accountId,wire.reason,wire.occurrence)
        // 缺口回调必须同步提交，不接受异步完成的伪持久化。
        if(result!==undefined)this.#fail()
      }catch{this.#fail()}
      return
    }
    if(wire.kind==='chat-ack'){this.#fail();return}
    if(wire.kind==='chat-delivery'){
      if(!this.#ready || this.#account?.userId!==wire.accountId || !this.onChatDelivery){this.#fail();return}
      try{
        const result=this.onChatDelivery(wire.accountId,wire.message)
        const ack={kind:'chat-ack' as const,accountId:wire.accountId,sourceId:wire.message.sourceId,eventSeq:result?.eventSeq}
        // 异步回调或非法提交结果不能成为落库证明。
        if(!result || typeof result.inserted!=='boolean' || !isChatWire(ack)){this.#fail();return}
        if(this.#closed || this.#account?.userId!==wire.accountId){this.#fail();return}
        this.output.write(encodeFrame(ack),error=>{if(error)this.#fail()})
      }catch{this.#fail()}
      return
    }
    if(wire.kind==='resolve-page'){this.#fail();return}
    if(wire.kind==='page-context') {
      if(!this.#ready)return
      const p=this.#pagePending
      if(!p || p.id!==wire.id)return
      this.#pagePending=null;clearTimeout(p.timer)
      if(this.#account?.userId!==p.accountId){p.reject(Object.assign(new Error('账号已变化'),{code:'ACCOUNT_CHANGED'}));return}
      if(wire.context===null){p.reject(Object.assign(new Error('页面执行上下文不可用'),{code:wire.reason??'PAGE_NOT_READY'}));return}
      if(!isResolvedPage(wire.context)){p.reject(Object.assign(new Error('页面定位结果无效'),{code:'INTERNAL'}));return}
      p.resolve(wire.context);return
    }
    if(wire.kind==='request-step'){this.#fail();return}
    if(wire.kind==='step-result') {
      if(!this.#ready)return
      const p=this.#stepPending
      if(!p || p.id!==wire.id || wire.terminal!==true)return
      this.#stepPending=null
      if(p.accountChanged || this.#account?.userId!==p.accountId){p.reject(Object.assign(new Error('账号已变化'),{code:'ACCOUNT_CHANGED'}));return}
      if(!wire.ok&&process.env.FISHOPS_DIAG)process.stderr.write(JSON.stringify({diag:'step-result',code:wire.error.code,phase:wire.error.phase})+'\n')
      // 同时挂 code/phase：调度器 toError 只认顶层 code，缺失时会兜底成 INTERNAL，吞掉 RISK_BLOCKED 等停止信号。
      if(!wire.ok){p.reject(Object.assign(new Error(wire.error.message),{code:wire.error.code,phase:wire.error.phase,apiError:wire.error}));return}
      p.resolve(wire.data);return
    }
    if(wire.kind==='hello') {
      if(this.#ready){this.#fail();return}
      if(wire.protocolVersion!==PROTOCOL_VERSION){ process.stderr.write('native 协议版本不兼容\n'); this.close(); return }
      this.#extensionBuildId=('extensionBuildId' in wire && typeof wire.extensionBuildId==='string') ? wire.extensionBuildId : null
      this.#ready=true; this.#extensionVersion=wire.extensionVersion; this.#account=wire.account
      this.#status=null;this.#onEvent('account.changed',{account:wire.account});return
    }
    if(!this.#ready){this.#fail();return}
    if(wire.kind==='req'){this.#fail();return}
    if(wire.kind==='event'){
      if(wire.type==='account.changed'){
        this.#account=wire.data.account
        if(this.#stepPending && this.#stepPending.accountId!==this.#account?.userId)this.#stepPending.accountChanged=true
      }
      this.#onEvent(wire.type,wire.data);return
    }
    if(wire.kind==='res') {
      const p=this.#pending.get(wire.id); if(!p)return; this.#pending.delete(wire.id); clearTimeout(p.timer)
      // 同时挂 code/phase：调度器 toError 只认顶层 code，缺失时会兜底成 INTERNAL，吞掉 RISK_BLOCKED 等停止信号。
      if(!wire.ok){p.reject(Object.assign(new Error(wire.error.message),{code:wire.error.code,phase:wire.error.phase,apiError:wire.error}));return}
      if(!isExtensionStatus(wire.data)){p.reject(Object.assign(new Error('扩展状态响应格式无效'),{code:'INTERNAL'}));return}
      this.#status=wire.data;p.resolve(wire.data)
    }
  }
  status(): ExtensionStatus { if(!this.#ready)throw Object.assign(new Error('扩展未连接'),{code:'EXTENSION_OFFLINE'});if(!this.#status)throw Object.assign(new Error('扩展状态尚未验证'),{code:'EXTENSION_OFFLINE'});return this.#status }
  call(method:string,params:unknown):Promise<unknown> {
    if(!this.#ready) return Promise.reject(Object.assign(new Error('扩展未连接'),{code:'EXTENSION_OFFLINE'}))
    const id=randomUUID(), frame:Wire={kind:'req',id,method,params}
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.#pending.delete(id);reject(Object.assign(new Error('扩展读取超时'),{code:'TIMEOUT'}))},this.timeout)
      this.#pending.set(id,{resolve,reject,timer})
      this.output.write(encodeFrame(frame),error=>{if(error){const p=this.#pending.get(id);if(p){clearTimeout(p.timer);this.#pending.delete(id);p.reject(error)}}})
    })
  }
  /** 发送一条 host 内部单步请求；Promise 仅在真实终结帧或通道关闭时结束。 */
  callStep(request:{requestId:string;method:StepMethod;params:StepParams;context:{accountId:string;tabId:number;documentId:string}}):Promise<unknown> {
    if(!this.#ready)return Promise.reject(Object.assign(new Error('扩展未连接'),{code:'EXTENSION_OFFLINE'}))
    if(this.#stepPending)return Promise.reject(Object.assign(new Error('已有单步请求在途'),{code:'BAD_REQUEST'}))
    if(this.#account?.userId!==request.context.accountId)return Promise.reject(Object.assign(new Error('账号已变化'),{code:'ACCOUNT_CHANGED'}))
    const frame:StepWire={kind:'request-step',id:randomUUID(),...request}
    if(!isStepWire(frame))return Promise.reject(Object.assign(new Error('单步请求格式无效'),{code:'BAD_REQUEST'}))
    return new Promise((resolve,reject)=>{
      const pending:StepPending={id:frame.id,accountId:request.context.accountId,resolve,reject,accountChanged:false}
      this.#stepPending=pending
      try {
        const encoded=encodeFrame(frame)
        this.output.write(encoded,error=>{if(error && this.#stepPending===pending)this.#fail()})
      } catch(error) {
        if(this.#stepPending===pending)this.#stepPending=null
        reject(error instanceof Error?error:new Error(String(error)))
      }
    })
  }
  /** 获取唯一固定执行页；仅做页面定位，平台请求由后续 callStep 发起。 */
  callResolvePage(accountId:string):Promise<ResolvedPage> {
    if(!this.#ready)return Promise.reject(Object.assign(new Error('扩展未连接'),{code:'EXTENSION_OFFLINE'}))
    if(this.#pagePending)return Promise.reject(Object.assign(new Error('已有页面定位请求在途'),{code:'BAD_REQUEST'}))
    if(this.#account?.userId!==accountId)return Promise.reject(Object.assign(new Error('账号已变化'),{code:'ACCOUNT_CHANGED'}))
    const frame:PageWire={kind:'resolve-page',id:randomUUID(),accountId}
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{
        if(this.#pagePending?.id!==frame.id)return
        this.#pagePending=null
        reject(Object.assign(new Error('页面定位超时'),{code:'TIMEOUT'}))
      },this.timeout)
      const pending:PagePending={id:frame.id,accountId,resolve,reject,timer}
      this.#pagePending=pending
      try {
        this.output.write(encodeFrame(frame),error=>{if(error && this.#pagePending===pending)this.#fail()})
      } catch(error) {
        if(this.#pagePending===pending){clearTimeout(timer);this.#pagePending=null}
        reject(error instanceof Error?error:new Error(String(error)))
      }
    })
  }
  /**
   * 先定位唯一执行页，再发起一次固定页单步；定位失败不发送步骤，不做自动重试。
   * 该组合方法只用于生产过程编排，不保存页面上下文。
   */
  async callPageStep(request:{requestId:string;method:StepMethod;params:StepParams;accountId:string}):Promise<unknown> {
    const page=await this.callResolvePage(request.accountId)
    return this.callStep({
      requestId:request.requestId,
      method:request.method,
      params:request.params,
      context:{accountId:request.accountId,...page},
    })
  }
  #fail(){if(this.#closed)return;this.close();this.onFatal()}
  close(){if(this.#closed)return;this.#closed=true;this.#ready=false;this.input.removeListener('data',this.dataListener);this.input.removeListener('end',this.endListener);this.input.removeListener('close',this.closeListener);this.input.removeListener('error',this.errorListener);for(const p of this.#pending.values()){clearTimeout(p.timer);p.reject(Object.assign(new Error('native 通道关闭'),{code:'EXTENSION_OFFLINE'}))}this.#pending.clear();if(this.#pagePending){clearTimeout(this.#pagePending.timer);this.#pagePending.reject(Object.assign(new Error('native 通道关闭'),{code:'EXTENSION_OFFLINE'}));this.#pagePending=null}if(this.#stepPending){this.#stepPending.reject(Object.assign(new Error('native 通道关闭'),{code:'EXTENSION_OFFLINE'}));this.#stepPending=null}}
}
