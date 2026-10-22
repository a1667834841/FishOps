import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostDatabase } from './database.ts'

test('v4迁移保留v3数据并重启保留attempting',()=>{
 const dir=mkdtempSync(join(tmpdir(),'write-db-')),path=join(dir,'db')
 try{let db=new HostDatabase(path);db.event('risk.signal',{});const op=db.reserveOperation('a','publish.prepare','k','fp');assert.equal(op.status,'attempting');db.close();db=new HostDatabase(path);assert.equal(db.db.prepare('PRAGMA user_version').get()?.user_version,4);assert.equal(db.events({}).items.length,1);assert.equal(db.getOperation('a','publish.prepare','k')?.status,'attempting');db.close()}finally{rmSync(dir,{recursive:true,force:true})}
})
test('重复同指纹返回已有记录，冲突抛幂等错误且账号隔离',()=>{const db=new HostDatabase(':memory:');try{const a=db.reserveOperation('a','publish.submit','key','same');assert.equal(db.reserveOperation('a','publish.submit','key','same').rowId,a.rowId);assert.throws(()=>db.reserveOperation('a','publish.submit','key','other'),{code:'IDEMPOTENCY_CONFLICT'});assert.equal(db.getOperation('b','publish.submit','key'),null);assert.equal(db.reserveOperation('b','publish.submit','key','other').accountId,'b')}finally{db.close()}})
test('完成操作保留结果和错误状态，未知或重复完成不自动重放',()=>{const db=new HostDatabase(':memory:');try{assert.throws(()=>db.finishOperation('a','x','k','failed'),{code:'NOT_FOUND'});db.reserveOperation('a','x','k','fp');const done=db.finishOperation('a','x','k','succeeded',{ok:true});assert.deepEqual(done.resultJson,{ok:true});assert.equal(db.finishOperation('a','x','k','failed','bad').status,'succeeded');assert.equal(db.getOperation('a','x','k')?.status,'succeeded');const failed=db.reserveOperation('a','y','k','fp');assert.equal(db.finishOperation('a','y','k','unknown',undefined,'TIMEOUT').status,'unknown');assert.equal(failed.status,'attempting')}finally{db.close()}})
test('严格拒绝非法账号、方法、幂等键、指纹和状态',()=>{const db=new HostDatabase(':memory:');try{for(const args of [['','m','k','f'],['a','','k','f'],['a','m','','f'],['a','m','k','']] as const)assert.throws(()=>db.reserveOperation(args[0],args[1],args[2],args[3]));assert.throws(()=>db.finishOperation('a','m','k','attempting' as any));assert.throws(()=>db.finishOperation('a','m','k','bad' as any));assert.throws(()=>db.getOperation('a','m',' '))}finally{db.close()}})

test('claim只允许一个调用者获得派发权',()=>{const db=new HostDatabase(':memory:');try{assert.equal(db.claimOperation('a','chat.send','k','fp').claimed,true);assert.equal(db.claimOperation('a','chat.send','k','fp').claimed,false);assert.equal(db.getOperation('a','chat.send','k')?.status,'dispatching')}finally{db.close()}})
