import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { smokeDeploymentPaths, verifyExtensionBuild } from './deployment-paths.mjs'
const root=resolve(import.meta.dirname,'../..')
test('隔离构建使用独立目录与注册名，不改写默认产物，非法名不创建目录',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'fishops-isolated-build-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 const defaultBundle=join(root,'apps/extension/dist/background.js')
 const readDefault=()=>readFile(defaultBundle).catch(error=>{if(error.code==='ENOENT')return null;throw error})
 const before=await readDefault()
 const dist=join(dir,'extension')
 const env={...process.env,FISHOPS_EXTENSION_DIST:dist,FISHOPS_HOST_NAME:'top.ggball.fishops.e2e'}
 const built=spawnSync(process.execPath,['apps/extension/scripts/build.mjs'],{cwd:root,env,encoding:'utf8',timeout:15000})
 assert.equal(built.status,0,built.stderr)
 const build=JSON.parse(await readFile(join(dist,'build.json'),'utf8'))
 assert.equal(build.hostName,'top.ggball.fishops.e2e')
 assert.equal(await verifyExtensionBuild(dist,build.buildId,'top.ggball.fishops.e2e'),build.buildId)
 await assert.rejects(verifyExtensionBuild(dist,build.buildId,'top.ggball.fishops'),/注册名/)
 assert.match(await readFile(join(dist,'background.js'),'utf8'),/top\.ggball\.fishops\.e2e/)
 assert.deepEqual(await readDefault(),before)
 const invalidDist=join(dir,'invalid')
 const invalid=spawnSync(process.execPath,['apps/extension/scripts/build.mjs'],{cwd:root,env:{...env,FISHOPS_EXTENSION_DIST:invalidDist,FISHOPS_HOST_NAME:'../foreign'},encoding:'utf8',timeout:15000})
 assert.notEqual(invalid.status,0)
 await assert.rejects(readFile(join(invalidDist,'background.js')),{code:'ENOENT'})
})
test('运行身份验证拒绝旧连接、缺失清单和产物篡改',async t=>{
 const dist=await mkdtemp(join(tmpdir(),'fishops-build-proof-'))
 t.after(()=>rm(dist,{recursive:true,force:true}))
 await assert.rejects(verifyExtensionBuild(dist,'running-build'))
 const sha256={}
 for(const name of ['background.js','page-main.js','chat-content.js','manifest.json']){
  await writeFile(join(dist,name),name)
  sha256[name]=createHash('sha256').update(name).digest('hex')
 }
 await writeFile(join(dist,'build.json'),JSON.stringify({buildId:'running-build',sha256}))
 await assert.rejects(verifyExtensionBuild(dist,null),/身份/)
 await assert.rejects(verifyExtensionBuild(dist,'old-build'),/身份/)
 assert.equal(await verifyExtensionBuild(dist,'running-build'),'running-build')
 await writeFile(join(dist,'page-main.js'),'changed')
 await assert.rejects(verifyExtensionBuild(dist,'running-build'),/产物/)
})
test('冒烟显式选择隔离部署，不回退到主部署路径',()=>{
 const paths=smokeDeploymentPaths({FISHOPS_HOME:'isolated/home',FISHOPS_EXTENSION_DIST:'isolated/dist',FISHOPS_HOST_ENTRY:'isolated/main.ts'},root)
 assert.deepEqual(paths,{home:resolve('isolated/home'),dist:resolve('isolated/dist'),hostEntry:resolve('isolated/main.ts')})
 assert.deepEqual(smokeDeploymentPaths({},root),{home:join(homedir(),'Library/Application Support/FishOps'),dist:join(root,'apps/extension/dist'),hostEntry:join(root,'apps/host/src/main.ts')})
})
test('验证运行时与CI版本文件一致',async()=>{
 const expected=(await readFile(join(root,'.node-version'),'utf8')).trim()
 assert.equal(process.versions.node,expected)
 const workflow=await readFile(join(root,'.github/workflows/ci.yml'),'utf8')
 assert.match(workflow,/node-version-file: .node-version/)
 assert.ok(!workflow.includes('workbench.html'))
})
