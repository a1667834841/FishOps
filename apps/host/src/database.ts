import { createHash } from 'node:crypto'
import { validateResult, type ChatSyncPageParams, type ChatSyncPageResult } from '../../../packages/protocol/src/chat-sync.ts'
import { DatabaseSync } from 'node:sqlite'
import { isCursor, type Account } from '../../../packages/protocol/src/index.ts'
import type { SchedulerSnapshot } from './scheduler.ts'
import { isChatMessage, normalizeChatParams, type ChatMessage } from '../../../packages/protocol/src/chat.ts'

type EventFilter={types?:string[];tag?:string}
type ChatMessagesQuery={sessionId?:string;tag?:string;afterSeq?:string;limit?:number}
type ChatConversationsQuery={tag?:string;itemId?:string;updatedAfter?:number;afterId?:string;limit?:number}
type OperationStatus='attempting'|'dispatching'|'succeeded'|'failed'|'unknown'
export type OperationRecord={rowId:string;accountId:string;method:string;idempotencyKey:string;fingerprint:string;status:OperationStatus;requestJson:unknown|null;resultJson:unknown|null;errorCode:string|null;createdAt:number;updatedAt:number;created:boolean}
const chatError=()=>Object.assign(new Error('聊天存储参数无效'),{code:'BAD_REQUEST'})
function chatString(value:unknown,max=128):value is string{return typeof value==='string'&&!!value.trim()&&value.length<=max}
function chatAccount(value:unknown):asserts value is string{if(!chatString(value))throw Object.assign(new Error('需要登录账号'),{code:'LOGIN_REQUIRED'})}
export class HostDatabase {
  db:DatabaseSync
  constructor(path:string){
    this.db=new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    const version=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version
    if(version>4){this.db.close();throw new Error('数据库版本高于当前 host')}
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,ts INTEGER NOT NULL,account_id TEXT,tag TEXT,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(row_id INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,method TEXT NOT NULL,ts INTEGER NOT NULL,duration_ms INTEGER,status TEXT NOT NULL,error_code TEXT,category TEXT,account_id TEXT,tag TEXT,summary TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS read_cache(account_id TEXT NOT NULL,cache_key TEXT NOT NULL,method TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(account_id,cache_key));
      CREATE TABLE IF NOT EXISTS chat_conversations(row_id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,session_id TEXT NOT NULL,item_id TEXT,peer_user_id TEXT,updated_at INTEGER NOT NULL,last_event_seq INTEGER NOT NULL,UNIQUE(account_id,session_id));
      CREATE TABLE IF NOT EXISTS chat_conversation_tags(account_id TEXT NOT NULL,session_id TEXT NOT NULL,tag TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(account_id,session_id,tag));
      CREATE TABLE IF NOT EXISTS chat_messages(account_id TEXT NOT NULL,source_id TEXT NOT NULL,session_id TEXT NOT NULL,event_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),tag TEXT,data TEXT NOT NULL,PRIMARY KEY(account_id,source_id));
      CREATE INDEX IF NOT EXISTS chat_messages_session ON chat_messages(account_id,session_id,event_seq);
      CREATE INDEX IF NOT EXISTS chat_messages_tag ON chat_messages(account_id,tag,event_seq);
      CREATE TABLE IF NOT EXISTS operations(row_id INTEGER PRIMARY KEY AUTOINCREMENT,account_id TEXT NOT NULL,method TEXT NOT NULL,idempotency_key TEXT NOT NULL,fingerprint TEXT NOT NULL,status TEXT NOT NULL,request_json TEXT,result_json TEXT,error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(account_id,method,idempotency_key));
      CREATE INDEX IF NOT EXISTS operations_account_row ON operations(account_id,row_id);
      PRAGMA user_version=4; COMMIT;`)
    this.db.exec("UPDATE requests SET status='interrupted' WHERE status='running'")
    const eventStatement=this.db.prepare('SELECT seq FROM events LIMIT 0');eventStatement.setReadBigInts(true)
    const requestStatement=this.db.prepare('SELECT row_id FROM requests LIMIT 0');requestStatement.setReadBigInts(true)
  }
  #account():string|null{
    const row=this.db.prepare("SELECT value FROM state WHERE key='account_id'").get() as {value:string}|undefined
    return row?.value||null
  }
  hasObservedAccount():boolean{return this.db.prepare("SELECT 1 FROM state WHERE key='account_observed'").get()!==undefined}
  setAccount(account:Account):boolean{
    const value=account?.userId??null
    if(this.hasObservedAccount()&&value===this.#account())return false
    // 首次 null 与退出账号都写成账户范围之外的匿名系统事件，正文只保留当前快照。
    this.db.exec('BEGIN IMMEDIATE')
    try{
      this.db.prepare("INSERT INTO state(key,value) VALUES('account_observed','1') ON CONFLICT(key) DO UPDATE SET value='1'").run()
      this.db.prepare("INSERT INTO state(key,value) VALUES('account_id',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value??'')
      // 不持久化昵称等账号快照；账号事件只需表达当前账号 ID。
      this.db.prepare("INSERT INTO state(key,value) VALUES('account_snapshot',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(value??'')
      this.event('account.changed',{account},value,null)
      this.db.exec('COMMIT')
    }catch(error){this.db.exec('ROLLBACK');throw error}
    return true
  }
  event(type:string,data:unknown,accountId=this.#account(),tag:string|null=null):string{
    const statement=this.db.prepare('INSERT INTO events(type,ts,account_id,tag,data) VALUES(?,?,?,?,?)');statement.setReadBigInts(true)
    const result=statement.run(type,Date.now(),accountId,tag,JSON.stringify(data))
    return BigInt(result.lastInsertRowid).toString()
  }
  /**
   * 写入请求审计；accountId 默认取当前账号，调用方可传入请求开始时的账号快照，
   * 避免在途切换账号后把旧账号的请求记到新账号名下。
   */
  request(id:string,method:string,tag:string|null=null,accountId:string|null=this.#account()):void{
    this.db.prepare('INSERT INTO requests(id,method,ts,duration_ms,status,error_code,category,account_id,tag,summary) VALUES(?,?,?,NULL,\'running\',NULL,NULL,?,?,\'{}\')').run(id,method,Date.now(),accountId,tag)
  }
  finish(id:string,status:'succeeded'|'failed'|'interrupted',errorCode:string|null=null):void{
    this.db.prepare("UPDATE requests SET status=?,error_code=?,duration_ms=MAX(0,?-ts) WHERE id=?").run(status,errorCode,Date.now(),id)
  }
  events(q:{afterSeq?:string;types?:string[];tag?:string;limit?:number},account=this.#account()){
    const after=q.afterSeq??'0',limit=q.limit??100;if(!isCursor(after))throw new Error('BAD_REQUEST')
    const c=['seq > ?','(account_id IS ? OR account_id IS NULL)'],a:(string|number|null)[]=[after,account]
    if(q.types?.length){c.push(`type IN (${q.types.map(()=>'?').join(',')})`);a.push(...q.types)}if(q.tag){c.push('tag=?');a.push(q.tag)}a.push(limit+1)
    const statement=this.db.prepare(`SELECT seq,type,ts,tag,data FROM events WHERE ${c.join(' AND ')} ORDER BY seq LIMIT ?`);statement.setReadBigInts(true)
    const rows=statement.all(...a) as any[]
    const hasMore=rows.length>limit,items=rows.slice(0,limit).map(r=>({seq:BigInt(r.seq).toString(),type:r.type,ts:Number(r.ts),tag:r.tag,data:JSON.parse(r.data)}))
    return{items,nextAfterSeq:items.at(-1)?.seq??after,hasMore}
  }
  requests(q:{afterId?:string;tag?:string;fromTs?:number;toTs?:number;limit?:number},account=this.#account()){
    const after=q.afterId??'0',limit=q.limit??100;if(!isCursor(after))throw new Error('BAD_REQUEST')
    const c=['row_id > ?','(account_id IS ? OR account_id IS NULL)'],a:(string|number|null)[]=[after,account]
    if(q.tag){c.push('tag=?');a.push(q.tag)}if(q.fromTs!==undefined){c.push('ts>=?');a.push(q.fromTs)}if(q.toTs!==undefined){c.push('ts<?');a.push(q.toTs)}a.push(limit+1)
    const statement=this.db.prepare(`SELECT row_id,id,method,ts,duration_ms,status,error_code,category,tag,summary FROM requests WHERE ${c.join(' AND ')} ORDER BY row_id LIMIT ?`);statement.setReadBigInts(true)
    const rows=statement.all(...a) as any[]
    const hasMore=rows.length>limit,selected=rows.slice(0,limit),items=selected.map(r=>({id:r.id,method:r.method,ts:Number(r.ts),durationMs:r.duration_ms===null?null:Number(r.duration_ms),status:r.status,errorCode:r.error_code,category:r.category,tag:r.tag,summary:JSON.parse(r.summary)}))
    return{items,nextAfterId:selected.length?BigInt(selected.at(-1).row_id).toString():after,hasMore}
  }
  /**
   * 读取账号风控冷却到期时间；已过期条目就地清除并返回 0。
   * 冷却状态存在 SQLite state 中，Host 重启后仍然生效，不依赖进程内存。
   */
  riskCooldownUntil(accountId:string,now:number):number {
    if(!chatString(accountId)||!Number.isSafeInteger(now)||now<0)throw new Error('账号或时间无效')
    const key=`risk:until:${accountId}`
    const row=this.db.prepare('SELECT value FROM state WHERE key=?').get(key) as {value:string}|undefined
    if(!row)return 0
    const until=Number(row.value)
    // 损坏或已过期的冷却不能继续阻断请求，必须同时从 state 删除。
    if(!Number.isSafeInteger(until)||until<=now){this.db.prepare('DELETE FROM state WHERE key=?').run(key);return 0}
    return until
  }
  /** 写入风控冷却；同一事务内清理全部已过期冷却，避免 state 随账号历史无限增长。 */
  setRiskCooldown(accountId:string,until:number):void {
    if(!chatString(accountId)||!Number.isSafeInteger(until)||until<=0)throw new Error('账号或冷却时间无效')
    const own=!this.db.isTransaction
    if(own)this.db.exec('BEGIN IMMEDIATE')
    try{
      this.db.prepare("DELETE FROM state WHERE key LIKE 'risk:until:%' AND CAST(value AS INTEGER)<=?").run(Date.now())
      this.db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`risk:until:${accountId}`,String(until))
      if(own)this.db.exec('COMMIT')
    }catch(error){if(own)this.db.exec('ROLLBACK');throw error}
  }
  /** 清除账号风控冷却；不传账号时清除全部，供人工完成平台验证后恢复。 */
  clearRiskCooldown(accountId?:string):void {
    if(accountId===undefined){this.db.prepare("DELETE FROM state WHERE key LIKE 'risk:until:%'").run();return}
    if(!chatString(accountId))throw new Error('账号无效')
    this.db.prepare('DELETE FROM state WHERE key=?').run(`risk:until:${accountId}`)
  }
  highWater():string{const statement=this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events');statement.setReadBigInts(true);return BigInt((statement.get() as {n:number|bigint}).n).toString()}
  latestAccountEvent(){const statement=this.db.prepare("SELECT seq,type,ts,tag,data FROM events WHERE type='account.changed' ORDER BY seq DESC LIMIT 1");statement.setReadBigInts(true);const r=statement.get() as any;if(!r)return null;return{seq:BigInt(r.seq).toString(),type:r.type,ts:Number(r.ts),tag:r.tag,data:JSON.parse(r.data)}}
  /** 保存规范化只读结果；调用者必须先校验商品输出，不保存平台原始响应或凭据。 */
  putReadCache(accountId:string,key:string,method:'search.items'|'item.detail',result:unknown,createdAt:number):void {
    this.#cacheInput(accountId,key,method,createdAt)
    const json=JSON.stringify(result)
    if(json===undefined||json.length>1024*1024)throw new Error('缓存结果无效或超限')
    this.db.prepare('INSERT INTO read_cache(account_id,cache_key,method,result,created_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id,cache_key) DO UPDATE SET method=excluded.method,result=excluded.result,created_at=excluded.created_at').run(accountId,key,method,json,createdAt)
  }
  /** 只读取当前账号及方法的未过期缓存；刷新和时钟回拨均视为未命中。 */
  getReadCache(accountId:string,key:string,method:'search.items'|'item.detail',maxAgeSec:number,now:number):unknown|null {
    this.#cacheInput(accountId,key,method,now)
    if(!Number.isSafeInteger(maxAgeSec)||maxAgeSec<0)throw new Error('缓存有效期无效')
    if(maxAgeSec===0)return null
    const row=this.db.prepare('SELECT result,created_at FROM read_cache WHERE account_id=? AND cache_key=? AND method=?').get(accountId,key,method) as {result:string;created_at:number}|undefined
    if(!row||now<row.created_at||now-row.created_at>=Math.min(maxAgeSec,method==='search.items'?900:1800)*1000)return null
    return JSON.parse(row.result)
  }
  #cacheInput(accountId:string,key:string,method:string,time:number):void {
    if(typeof accountId!=='string'||!accountId.trim()||typeof key!=='string'||!key||!['search.items','item.detail'].includes(method)||!Number.isSafeInteger(time)||time<0)throw new Error('缓存参数无效')
  }
  /** 读取账号调度快照；结构由调度器严格校验，损坏内容不当作空历史。 */
  loadSchedule(accountId:string):SchedulerSnapshot|null {
    if(typeof accountId!=='string'||!accountId.trim())throw new Error('账号无效')
    const row=this.db.prepare('SELECT value FROM state WHERE key=?').get(`schedule:${accountId}`) as {value:string}|undefined
    return row?JSON.parse(row.value) as SchedulerSnapshot:null
  }
  /** 同步持久化派发预留或终结快照；写失败必须在网络派发前向上传递。 */
  saveSchedule(accountId:string,snapshot:SchedulerSnapshot):void {
    if(typeof accountId!=='string'||!accountId.trim())throw new Error('账号无效')
    this.db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`schedule:${accountId}`,JSON.stringify(snapshot))
  }
  /** 预留统一写操作；attempting 在重启后保持原状，绝不自动重放。 */
  reserveOperation(accountId:string,method:string,idempotencyKey:string,fingerprint:string):OperationRecord {
    this.#operationInput(accountId,method,idempotencyKey,fingerprint)
    const now=Date.now()
    const own=!this.db.isTransaction
    if(own)this.db.exec('BEGIN IMMEDIATE')
    try{
      const row=this.db.prepare('SELECT * FROM operations WHERE account_id=? AND method=? AND idempotency_key=?').get(accountId,method,idempotencyKey) as any
      if(row){
        const current=this.#operationRow(row)
        if(current.fingerprint!==fingerprint)throw Object.assign(new Error('幂等键参数冲突'),{code:'IDEMPOTENCY_CONFLICT'})
        if(own)this.db.exec('COMMIT')
        return {...current,created:false}
      }
      this.db.prepare('INSERT INTO operations(account_id,method,idempotency_key,fingerprint,status,request_json,result_json,error_code,created_at,updated_at) VALUES(?,?,?,?,?,NULL,NULL,NULL,?,?)').run(accountId,method,idempotencyKey,fingerprint,'attempting',now,now)
      const created=this.db.prepare('SELECT * FROM operations WHERE account_id=? AND method=? AND idempotency_key=?').get(accountId,method,idempotencyKey) as any
      if(own)this.db.exec('COMMIT')
      return {...this.#operationRow(created),created:true}
    }catch(error){if(own)this.db.exec('ROLLBACK');throw error}
  }
  /** 原子取得唯一发送权；只有新建记录的调用者可以派发，旧 attempting/unknown 不重放。 */
  claimOperation(accountId:string,method:string,idempotencyKey:string,fingerprint:string):{record:OperationRecord;claimed:boolean}{
    this.#operationInput(accountId,method,idempotencyKey,fingerprint)
    const own=!this.db.isTransaction
    if(own)this.db.exec('BEGIN IMMEDIATE')
    try{
      const row=this.db.prepare('SELECT * FROM operations WHERE account_id=? AND method=? AND idempotency_key=?').get(accountId,method,idempotencyKey) as any
      if(row){
        const record=this.#operationRow(row)
        if(record.fingerprint!==fingerprint)throw Object.assign(new Error('幂等键参数冲突'),{code:'IDEMPOTENCY_CONFLICT'})
        // 明确失败且未发包的操作允许持同 key 重试；重新取得派发权并覆盖旧错误。
        if(record.status==='failed'){
          this.db.prepare("UPDATE operations SET status='dispatching',result_json=NULL,error_code=NULL,updated_at=? WHERE account_id=? AND method=? AND idempotency_key=?").run(Date.now(),accountId,method,idempotencyKey)
          const retaken=this.db.prepare('SELECT * FROM operations WHERE account_id=? AND method=? AND idempotency_key=?').get(accountId,method,idempotencyKey) as any
          if(own)this.db.exec('COMMIT')
          return {record:this.#operationRow(retaken),claimed:true}
        }
        if(own)this.db.exec('COMMIT')
        return {record,claimed:false}
      }
      const now=Date.now()
      this.db.prepare("INSERT INTO operations(account_id,method,idempotency_key,fingerprint,status,request_json,result_json,error_code,created_at,updated_at) VALUES(?,?,?,?,?,NULL,NULL,NULL,?,?)").run(accountId,method,idempotencyKey,fingerprint,'dispatching',now,now)
      const created=this.db.prepare('SELECT * FROM operations WHERE account_id=? AND method=? AND idempotency_key=?').get(accountId,method,idempotencyKey) as any
      if(own)this.db.exec('COMMIT')
      return {record:{...this.#operationRow(created),created:true},claimed:true}
    }catch(error){if(own&&this.db.isTransaction)this.db.exec('ROLLBACK');throw error}
  }
  /** 读取账号范围内的写操作，不把其他账号同名幂等键暴露给调用者。 */
  getOperation(accountId:string,method:string,idempotencyKey:string):OperationRecord|null {
    this.#operationInput(accountId,method,idempotencyKey)
    const row=this.db.prepare('SELECT * FROM operations WHERE account_id=? AND method=? AND idempotency_key=?').get(accountId,method,idempotencyKey) as any
    return row?this.#operationRow(row):null
  }
  /** 结束一次写操作；attempting 只允许转为明确终态，重复完成必须保持同一结果。 */
  finishOperation(accountId:string,method:string,idempotencyKey:string,status:OperationStatus,result?:unknown,errorCode?:string|null):OperationRecord {
    this.#operationInput(accountId,method,idempotencyKey)
    if(!['dispatching','succeeded','failed','unknown'].includes(status))throw new Error('写操作状态无效')
    if(errorCode!==undefined&&errorCode!==null&&!this.#operationText(errorCode))throw new Error('错误码无效')
    const resultJson=result===undefined?null:JSON.stringify(result)
    if(resultJson!==null&&Buffer.byteLength(resultJson,'utf8')>1024*1024)throw new Error('写操作结果超限')
    const own=!this.db.isTransaction
    if(own)this.db.exec('BEGIN IMMEDIATE')
    try{
      const row=this.db.prepare('SELECT * FROM operations WHERE account_id=? AND method=? AND idempotency_key=?').get(accountId,method,idempotencyKey) as any
      if(!row)throw Object.assign(new Error('写操作不存在'),{code:'NOT_FOUND'})
      const current=this.#operationRow(row)
      if(current.status!=='attempting'&&current.status!=='dispatching'){
        if(own)this.db.exec('COMMIT')
        return current
      }
      this.db.prepare('UPDATE operations SET status=?,result_json=?,error_code=?,updated_at=? WHERE account_id=? AND method=? AND idempotency_key=?').run(status,resultJson,errorCode??null,Date.now(),accountId,method,idempotencyKey)
      const updated=this.db.prepare('SELECT * FROM operations WHERE account_id=? AND method=? AND idempotency_key=?').get(accountId,method,idempotencyKey) as any
      if(own)this.db.exec('COMMIT')
      return this.#operationRow(updated)
    }catch(error){if(own)this.db.exec('ROLLBACK');throw error}
  }
  #operationText(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=256&&value.trim()===value}
  #operationInput(accountId:string,method:string,key:string,fingerprint?:string):void{
    if(!this.#operationText(accountId)||!this.#operationText(method)||!this.#operationText(key)||(fingerprint!==undefined&&!this.#operationText(fingerprint)))throw new Error('写操作参数无效')
  }
  #operationRow(row:any):OperationRecord{
    const status=row.status as OperationStatus
    if(!['attempting','dispatching','succeeded','failed','unknown'].includes(status)||typeof row.account_id!=='string'||typeof row.method!=='string'||typeof row.idempotency_key!=='string'||typeof row.fingerprint!=='string')throw new Error('写操作记录损坏')
    return {rowId:BigInt(row.row_id).toString(),accountId:row.account_id,method:row.method,idempotencyKey:row.idempotency_key,fingerprint:row.fingerprint,status,requestJson:row.request_json===null?null:JSON.parse(row.request_json),resultJson:row.result_json===null?null:JSON.parse(row.result_json),errorCode:row.error_code===null?null:row.error_code,createdAt:Number(row.created_at),updatedAt:Number(row.updated_at),created:false}
  }
  /** 消息、会话和事件原子提交；tag 仅来自 host 参数，消息本身禁止携带 tag。 */
  ingestChatMessage(accountId:string,message:unknown,tag?:string):{eventSeq:string;inserted:boolean}{
    chatAccount(accountId)
    if(!isChatMessage(message))throw chatError()
    if(tag!==undefined&&!chatString(tag))throw chatError()
    // 拷贝白名单，避免调用方对象或额外页面字段进入持久层。
    const m:ChatMessage={sourceId:message.sourceId as string,sessionId:message.sessionId as string,senderId:message.senderId as string,text:message.text,sentAt:message.sentAt as number,
      ...(message.itemId===undefined?{}:{itemId:message.itemId as string}),...(message.peerUserId===undefined?{}:{peerUserId:message.peerUserId as string})}
    const ownsTransaction=!this.db.isTransaction
    if(ownsTransaction)this.db.exec('BEGIN IMMEDIATE')
    try{
      const old=this.db.prepare('SELECT CAST(event_seq AS TEXT) AS seq FROM chat_messages WHERE account_id=? AND source_id=?').get(accountId,m.sourceId) as {seq:string}|undefined
      if(old){if(ownsTransaction)this.db.exec('COMMIT');return{eventSeq:old.seq,inserted:false}}
      const eventSeq=this.event('chat.message',m,accountId,tag??null)
      this.db.prepare('INSERT INTO chat_messages(account_id,source_id,session_id,event_seq,tag,data) VALUES(?,?,?,?,?,?)').run(accountId,m.sourceId,m.sessionId,eventSeq,tag??null,JSON.stringify(m))
      // 乱序旧消息不得回退会话时间或覆盖较新的关联信息；row_id 始终不变。
      this.db.prepare(`INSERT INTO chat_conversations(account_id,session_id,item_id,peer_user_id,updated_at,last_event_seq) VALUES(?,?,?,?,?,?)
        ON CONFLICT(account_id,session_id) DO UPDATE SET
        item_id=CASE WHEN excluded.updated_at>=updated_at THEN COALESCE(excluded.item_id,item_id) ELSE item_id END,
        peer_user_id=CASE WHEN excluded.updated_at>=updated_at THEN COALESCE(excluded.peer_user_id,peer_user_id) ELSE peer_user_id END,
        updated_at=MAX(updated_at,excluded.updated_at),last_event_seq=excluded.last_event_seq`).run(accountId,m.sessionId,m.itemId??null,m.peerUserId??null,m.sentAt,eventSeq)
      if(ownsTransaction)this.db.exec('COMMIT');return{eventSeq,inserted:true}
    }catch(error){if(ownsTransaction)this.db.exec('ROLLBACK');throw error}
  }
  /** 单页数据和进度原子提交；已提交页重放不新增事件，不自动再次访问平台。 */
  commitChatSyncPage(accountId:string,runId:string,pageId:string,params:ChatSyncPageParams,result:ChatSyncPageResult,tag?:string):{insertedCount:number;updatedCount:number;duplicate:boolean}{
    chatAccount(accountId)
    if(!chatString(runId)||!chatString(pageId)||!validateResult(params,result)||(tag!==undefined&&!chatString(tag)))throw chatError()
    const key=`chat.sync.page:${JSON.stringify([accountId,runId,pageId])}`
    const fingerprint=createHash('sha256').update(JSON.stringify({params,result,tag:tag??null})).digest('hex')
    const ownsTransaction=!this.db.isTransaction
    if(ownsTransaction)this.db.exec('BEGIN IMMEDIATE')
    try{
      const old=this.db.prepare('SELECT value FROM state WHERE key=?').get(key) as {value:string}|undefined
      if(old){const previous=JSON.parse(old.value);if(previous.fingerprint!==fingerprint)throw chatError();if(ownsTransaction)this.db.exec('COMMIT');return{insertedCount:previous.insertedCount,updatedCount:previous.updatedCount,duplicate:true}}
      let insertedCount=0,updatedCount=0
      if(result.mode==='messages'){
        for(const message of result.messages)if(this.ingestChatMessage(accountId,message,tag).inserted)insertedCount++
      }else{
        for(const conversation of result.conversations){
          const oldConversation=this.db.prepare('SELECT 1 FROM chat_conversations WHERE account_id=? AND session_id=?').get(accountId,conversation.sessionId)
          this.db.prepare(`INSERT INTO chat_conversations(account_id,session_id,item_id,peer_user_id,updated_at,last_event_seq) VALUES(?,?,?,?,?,0)
            ON CONFLICT(account_id,session_id) DO UPDATE SET
            item_id=CASE WHEN excluded.updated_at>=updated_at THEN COALESCE(excluded.item_id,item_id) ELSE item_id END,
            peer_user_id=CASE WHEN excluded.updated_at>=updated_at THEN COALESCE(excluded.peer_user_id,peer_user_id) ELSE peer_user_id END,
            updated_at=MAX(updated_at,excluded.updated_at)`).run(accountId,conversation.sessionId,conversation.itemId,conversation.peerUserId,conversation.updatedAt)
          // 会话页 tag 必须独立关联：无消息会话也要能按 tag 查询，不能依赖消息标签或伪造消息。
          // ON CONFLICT DO NOTHING 让同一会话重复出现同一 tag 时不新增行，重复页仍由页进度指纹先行拦截。
          if(tag!==undefined)this.db.prepare('INSERT INTO chat_conversation_tags(account_id,session_id,tag,created_at) VALUES(?,?,?,?) ON CONFLICT(account_id,session_id,tag) DO NOTHING').run(accountId,conversation.sessionId,tag,Date.now())
          if(oldConversation)updatedCount++;else insertedCount++
        }
      }
      const counts={insertedCount,updatedCount}
      this.db.prepare('INSERT INTO state(key,value) VALUES(?,?)').run(key,JSON.stringify({...counts,fingerprint}))
      if(ownsTransaction)this.db.exec('COMMIT');return{...counts,duplicate:false}
    }catch(error){if(ownsTransaction)this.db.exec('ROLLBACK');throw error}
  }
  /** 按事件游标读取账号消息；至少指定会话或 host 标签，seq 与 SSE 事件一致。 */
  chatMessages(accountId:string,q:ChatMessagesQuery){
    chatAccount(accountId);q=normalizeChatParams('chat.messages',q)
    if(q.sessionId===undefined&&q.tag===undefined)throw chatError()
    const after=q.afterSeq??'0',limit=q.limit??100,c=['account_id=?','event_seq>?'],a:(string|number)[]=[accountId,after]
    if(q.sessionId!==undefined){c.push('session_id=?');a.push(q.sessionId)}
    if(q.tag!==undefined){c.push('tag=?');a.push(q.tag)}
    const statement=this.db.prepare(`SELECT event_seq,tag,data FROM chat_messages WHERE ${c.join(' AND ')} ORDER BY event_seq LIMIT ?`);statement.setReadBigInts(true)
    const rows=statement.all(...a,limit+1) as {event_seq:bigint;tag:string|null;data:string}[]
    const items=rows.slice(0,limit).map(r=>({...JSON.parse(r.data) as ChatMessage,seq:r.event_seq.toString(),tag:r.tag}))
    return{items,nextAfterSeq:items.at(-1)?.seq??after,hasMore:rows.length>limit}
  }
  /** 按不变的本地 row_id 分页；tag 命中会话页独立关联或该会话任意已存消息标签，两者都不依赖最后消息。 */
  chatConversations(accountId:string,q:ChatConversationsQuery){
    chatAccount(accountId);q=normalizeChatParams('chat.conversations',q)
    const after=q.afterId??'0',limit=q.limit??100,c=['c.account_id=?','c.row_id>?'],a:(string|number)[]=[accountId,after]
    if(q.tag!==undefined){c.push('(EXISTS(SELECT 1 FROM chat_conversation_tags t WHERE t.account_id=c.account_id AND t.session_id=c.session_id AND t.tag=?) OR EXISTS(SELECT 1 FROM chat_messages m WHERE m.account_id=c.account_id AND m.session_id=c.session_id AND m.tag=?))');a.push(q.tag,q.tag)}
    if(q.itemId!==undefined){c.push('c.item_id=?');a.push(q.itemId)}
    if(q.updatedAfter!==undefined){c.push('c.updated_at>?');a.push(q.updatedAfter)}
    const statement=this.db.prepare(`SELECT c.* FROM chat_conversations c WHERE ${c.join(' AND ')} ORDER BY c.row_id LIMIT ?`);statement.setReadBigInts(true)
    const rows=statement.all(...a,limit+1) as any[]
    const items=rows.slice(0,limit).map(r=>({id:String(r.row_id),sessionId:r.session_id as string,itemId:r.item_id as string|null,peerUserId:r.peer_user_id as string|null,updatedAt:Number(r.updated_at),lastEventSeq:String(r.last_event_seq)}))
    return{items,nextAfterId:items.at(-1)?.id??after,hasMore:rows.length>limit}
  }
  close(){this.db.close()}
}
