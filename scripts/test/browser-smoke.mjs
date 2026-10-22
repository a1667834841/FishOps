/** 对已经由真实 Chrome 启动的部署做只读验收；不模拟 native 对端、不改账号。 */
import assert from 'node:assert/strict'
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { smokeDeploymentPaths, verifyExtensionBuild } from './deployment-paths.mjs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const root=resolve(import.meta.dirname,'../..')
if(process.env.FISHOPS_LIVE_SMOKE!=='1'){
 console.error('需要显式设置 FISHOPS_LIVE_SMOKE=1 才读取已安装部署；未执行真实 E2E。');process.exit(2)
}
const started=Date.now()
const dir=join(root,'.test-results',`chrome-live-${Date.now()}-${process.pid}`)
await mkdir(dir,{recursive:true,mode:0o700})
const reportPath=join(dir,'report.json')
const source={node:process.version,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()}
const { home, dist, hostEntry }=smokeDeploymentPaths(process.env,root)
let phase='deployment-source'
try{
 const config=JSON.parse(await readFile(join(home,'config.json'),'utf8'))
 assert.equal(process.versions.node,(await readFile(join(root,'.node-version'),'utf8')).trim())
 const record=JSON.parse(await readFile(join(home,'install.json'),'utf8'))
 assert.equal(record.hostEntry,hostEntry)
 const manifest=JSON.parse(await readFile(record.nativeManifestPath,'utf8'))
 assert.equal(manifest.name,record.hostName)
 const extension=JSON.parse(await readFile(join(dist,'manifest.json'),'utf8'))
 const hash=createHash('sha256').update(Buffer.from(extension.key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)))
 assert.deepEqual(manifest.allowed_origins,[`chrome-extension://${hash}/`]);assert.equal(record.extensionId,hash)
 assert.equal((await stat(join(home,'config.json'))).mode&0o777,0o600)
 const url=`http://127.0.0.1:${config.port}/v1/`
 const call=async(method,params={},headers={})=>{
  const res=await fetch(url+method,{method:'POST',headers:{authorization:`Bearer ${config.token}`,...headers},body:JSON.stringify(params),signal:AbortSignal.timeout(5000)})
  return {status:res.status,body:await res.json()}
 }
 phase='native-status'
 let status, extensionBuildId, lastError
 // 扩展重载后 native 接管和 SW hello 不是同一时刻完成；只等待身份稳定，不重试业务请求。
 for (let attempt = 0; attempt < 30; attempt++) {
  try {
   status=await call('system.status');assert.equal(status.status,200);assert.equal(status.body.ok,true)
   assert.equal(status.body.data.extensionVersion,extension.version);assert.equal(status.body.data.nativeConnected,true)
   phase='extension-build-identity'
   extensionBuildId=await verifyExtensionBuild(dist,status.body.data.extensionBuildId,record.hostName)
   lastError=undefined;break
  } catch (error) {
   lastError=error
   await new Promise(resolve => setTimeout(resolve, 1000))
  }
 }
 if (lastError) throw lastError
 phase='read-only-checks'
 assert.equal(status.body.meta.risk.level,'unobserved');assert.equal(status.body.data.chatReady,null)
 assert.equal((await call('system.status',{}, {authorization:'Bearer invalid'})).status,401)
 assert.equal((await call('system.status',{}, {origin:'null'})).status,403)
 assert.equal((await call('missing')).status,404)
 const events=await call('events.list');assert.equal(events.body.ok,true)
 const requests=await call('requests.list');assert.equal(requests.body.ok,true)
 let replay='not-covered'
 // 使用真实已落库事件验证续传；没有事件时明确未覆盖，不伪造账号变化。
 const sample=events.body.data.items.at(-1)
 if(sample){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000)
  try{
   const res=await fetch(url+'events?after=0',{headers:{authorization:`Bearer ${config.token}`,'Last-Event-ID':(BigInt(sample.seq)-1n).toString()},signal:controller.signal})
   assert.equal(res.status,200)
   const reader=res.body.getReader();let body=''
   while(!body.includes('\n\n')){const chunk=await reader.read();assert.equal(chunk.done,false);body+=new TextDecoder().decode(chunk.value)}
   assert.equal(/^id: (\d+)$/m.exec(body)?.[1],sample.seq)
   controller.abort();await reader.cancel().catch(()=>{});replay='passed'
  }finally{clearTimeout(timer)}
 }
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000)
 let heartbeat=false
 try{
  const res=await fetch(url+'events',{headers:{authorization:`Bearer ${config.token}`,'Last-Event-ID':events.body.data.nextAfterSeq},signal:controller.signal})
  assert.equal(res.status,200);assert.match(res.headers.get('content-type'),/text\/event-stream/)
  const reader=res.body.getReader();let body=''
  while(!heartbeat){const chunk=await reader.read();assert.equal(chunk.done,false);body+=new TextDecoder().decode(chunk.value);heartbeat=body.includes(': keepalive')}
  controller.abort();await reader.cancel().catch(()=>{})
 }finally{clearTimeout(timer)}
 const report={extensionBuildId,artifactHashScope:'运行中 SW 握手构建身份与磁盘清单一致；页面已加载产物与 Host 身份尚未证明',...source,durationMs:Date.now()-started,replay,status:'passed',scope:'已安装Chrome部署只读冒烟，不含浏览器重启与SW自然休眠',at:new Date().toISOString(),extensionId:hash,version:extension.version,accountPresent:status.body.data.account!==null,pagePresent:status.body.data.page.present,heartbeat,eventsCursor:events.body.data.nextAfterSeq,requestCount:requests.body.data.items.length,bundleHash:createHash('sha256').update(await readFile(join(dist,'background.js'))).digest('hex'),notCovered:['浏览器关闭重开','SW自然休眠','登录退出变化','一小时静默观察']}
 await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{mode:0o600})
 console.log(JSON.stringify({...report,reportPath}))
}catch{await writeFile(reportPath,JSON.stringify({...source,status:'failed',phase,durationMs:Date.now()-started,scope:'已安装Chrome只读冒烟',reason:'部署来源、连接、权限或断言失败；原始凭据与响应不记录'})+'\n',{mode:0o600});console.error('已安装Chrome冒烟失败；请检查部署归属、连接、权限和断言。未输出原始响应或凭据。');process.exitCode=1}
