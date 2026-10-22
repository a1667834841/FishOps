import { test } from 'node:test'
import assert from 'node:assert/strict'
import { METHODS, isWire, validateParams, isCursor, isAccount, unobservedRisk } from './index.ts'
test('握手与账号严格校验，未知版本和额外字段拒绝', () => {
  assert.ok(isWire({kind:'hello',protocolVersion:1,extensionVersion:'0.2.0',account:null}))
  assert.equal(isWire({kind:'hello',protocolVersion:2,extensionVersion:'0.2.0',account:null}),false)
  assert.equal(isAccount({userId:'x',nick:'n',token:'secret'}),false)
  assert.equal(isWire({kind:'req',id:'',method:'system.status'}),false)
  assert.equal(isWire({kind:'res',id:'a',ok:false,error:{code:'arbitrary',message:'x'}}),false)
})
test('hello 可选构建身份只接受 UUID 或 64 位小写 hex', async () => {
  const { isExtensionBuildId } = await import('./index.ts')
  const base = { kind: 'hello', protocolVersion: 1, extensionVersion: '0.2.0', account: null } as const
  assert.ok(isExtensionBuildId('fa0dbb11-0c0d-46b9-b6c1-7e5de5113ee3'))
  assert.ok(isExtensionBuildId('a'.repeat(64)))
  for (const bad of [
    'fa0dbb11-0c0d-46b9-b6c1-7e5de5113ee', // 少一位
    'FA0DBB11-0C0D-46B9-B6C1-7E5DE5113EE3', // 大写不是统一格式
    'a'.repeat(63),
    'a'.repeat(65),
    'content-hash-of-build',
    '',
    123,
    null,
  ]) assert.equal(isExtensionBuildId(bad), false, `非法构建身份被接受：${String(bad)}`)

  // 合法时可附带，非法或缺失时分别拒绝 / 仍接受。
  assert.ok(isWire({ ...base, extensionBuildId: 'fa0dbb11-0c0d-46b9-b6c1-7e5de5113ee3' }))
  assert.ok(isWire(base), '省略构建身份仍应通过（未构建的测试环境）')
  assert.equal(isWire({ ...base, extensionBuildId: 'not-a-build-id' }), false)
  assert.equal(isWire({ ...base, extensionBuildId: 42 }), false)
})
test('方法参数拒绝未知字段，游标无损支持64位', () => {
  assert.ok(isCursor('9223372036854775807'))
  for (const v of ['9223372036854775808','01','-1','1.2',1]) assert.equal(isCursor(v),false)
  assert.deepEqual(validateParams('events.list',{afterSeq:'9007199254740993',limit:500}),{afterSeq:'9007199254740993',limit:500})
  for (const v of [null,[],{token:'secret'},{limit:501},{types:['unknown']}]) assert.throws(()=>validateParams('events.list',v))
  assert.throws(()=>validateParams('requests.list',{fromTs:20,toTs:10}))
  assert.throws(()=>validateParams('missing',{}),/NOT_FOUND/)
  assert.equal(unobservedRisk().level,'unobserved')
})
test('只读状态不得把未知页面或账号字段当作已验证状态', async () => {
  const {isExtensionStatus}=await import('./index.ts')
  assert.ok(isExtensionStatus({extensionVersion:'0.2.0',account:null,page:{present:false},chatReady:null}))
  assert.equal(isExtensionStatus({extensionVersion:'0.2.0',account:null,page:{present:'yes'},chatReady:true}),false)
})
test('参数边界：空tag、非整数limit、时间范围和大游标',()=>{
  for(const params of [{tag:''},{tag:'x'.repeat(129)},{limit:1.1},{limit:0},{afterSeq:'1e3'},{types:Array(21).fill('account.changed')}])assert.throws(()=>validateParams('events.list',params))
  for(const params of [{fromTs:-1},{toTs:Infinity},{fromTs:1,toTs:1}])assert.throws(()=>validateParams('requests.list',params))
  assert.deepEqual(validateParams('system.status',{tag:'任务'}),{tag:'任务'})
})
test('M2 只读方法已注册且仍拒绝未知字段',()=>{
  for(const method of ['search.items','search.suggest','item.detail'])assert.equal(METHODS.includes(method as any),true)
  assert.deepEqual(validateParams('search.items',{keyword:'手机',page:2,rowsPerPage:10,filter:{publishDays:7},maxAgeSec:0}),{keyword:'手机',page:2,rowsPerPage:10,filter:{publishDays:7},maxAgeSec:0})
  assert.deepEqual(validateParams('search.suggest',{keyword:'手机'}),{keyword:'手机'})
  assert.deepEqual(validateParams('item.detail',{itemId:'1'}),{itemId:'1'})
  for(const [method,params] of [['search.items',{keyword:'手机',token:'secret'}],['search.suggest',{keyword:'手机',page:1}],['item.detail',{itemId:'1',keyword:'手机'}]] as const)assert.throws(()=>validateParams(method,params))
})

test('chat.sync.status 只接受 UUID runId',()=>{
  assert.deepEqual(validateParams('chat.sync.status',{runId:'00000000-0000-0000-0000-000000000000'}),{runId:'00000000-0000-0000-0000-000000000000'})
  for(const value of [{runId:'bad'},{runId:''},{runId:'00000000-0000-0000-0000-000000000000',extra:true}])assert.throws(()=>validateParams('chat.sync.status',value),/BAD_REQUEST/)
})

test('风控解除严格校验人工声明、标签及额外字段', () => {
  assert.deepEqual(validateParams('risk.clear', { manualVerified: true, tag: 'manual-review' }), { manualVerified: true, tag: 'manual-review' })
  for (const input of [{}, { manualVerified: false }, { manualVerified: true, accountId: 'other' }, { manualVerified: true, tag: 1 }, { manualVerified: true, tag: '' }, { manualVerified: true, tag: 'x'.repeat(129) }]) {
    assert.throws(() => validateParams('risk.clear', input))
  }
  assert.deepEqual(validateParams('risk.status', {}), {})
  assert.throws(() => validateParams('risk.status', { accountId: 'other' }))
})
