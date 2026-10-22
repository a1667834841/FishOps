import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { validateParams } from '../../../packages/protocol/src/index.ts'
import { HostDatabase } from './database.ts'
import { NativeBridge } from './bridge.ts'
import { createPublishService, type PublishStepRequest } from './publish-service.ts'
import { createPageRuntime } from '../../extension/src/page-runtime.ts'
import type { MtopResponse } from '../../extension/src/publish-page-executor.ts'
import { isStepWire } from '../../../packages/protocol/src/step.ts'

const ACCOUNT = '123456'
const DOCUMENT = 'cross-layer-document'
const NOW = 1_700_000_000_000
const DESCRIPTION = '离线发布测试商品，无拆无修'
const CONFIRM = { imageNoQr: true as const, addressConfirmed: true as const }
const SOURCE_URL = 'https://img.example.invalid/source.jpg'
const UPLOADED_URL = 'https://img.example.invalid/uploaded.jpg'
let sourceSequence = 100000
const input = () => ({
  // 默认存储属于同一个 MAIN world；各场景使用独立源商品，避免跨用例引用冲突。
  source: { itemId: String(++sourceSequence) },
  seller: { addressRef: 'poi-1' },
  confirm: CONFIRM,
  idempotencyKey: 'prepare-cross-layer',
  draft: { description: DESCRIPTION },
})

type Call = { api: string; data: Record<string, unknown> }
type FixtureOptions = {
  /**
   * 模拟 Chrome 的 executeScript 交付方式：args 以 JSON 文本注入 MAIN world
   * （`(<func>)(<json args>)`），因此页面执行器拿到的是 JSON 往返后的对象。
   */
  serializeStepFrame?: boolean
}

/** 只替换平台边界；指纹、prepared 存取、参数校验和结果归因均执行生产实现。 */
function fixture(t: { after(fn: () => void): void }, options: FixtureOptions = {}) {
  const params = input()
  const db = new HostDatabase(':memory:')
  const calls: Call[] = []
  const uploads: string[] = []
  const steps: PublishStepRequest[] = []
  let published = false
  let blockedApi: string | undefined
  let blockedRet = 'FAIL_SYS_USER_VALIDATE::需要验证'
  const ok = (data: Record<string, unknown>): MtopResponse => ({ ret: ['SUCCESS::调用成功'], data })
  const runtime = createPageRuntime({
    scope: {}, documentId: DOCUMENT,
    readAccountId: () => ACCOUNT,
    readCookie: () => { throw new Error('发布步骤不得读取签名 cookie') },
    fetch: async () => { throw new Error('禁止真实网络请求') },
    now: () => NOW,
    readTimeoutMs: 100,
    publish: {
      uploadImage: {
        upload: async source => {
          assert.deepEqual(source, { kind: 'url', url: SOURCE_URL })
          uploads.push(source.url)
          return { url: UPLOADED_URL, widthSize: 800, heightSize: 600 }
        },
      },
      mtopRequest: async (api, _version, data) => {
        calls.push({ api, data: structuredClone(data) })
        if (api === blockedApi) return { ret: [blockedRet], data: {} }
        switch (api) {
          case 'mtop.idle.pc.idleitem.prepublish.check': return ok({ limited: false })
          case 'mtop.idle.pc.idleitem.preget': return ok({})
          case 'mtop.taobao.idle.pc.detail': return ok({
            itemDO: { desc: '源商品描述', soldPrice: '199.00', imageInfos: [{ url: SOURCE_URL }], itemLabelExtList: [] },
            sellerDO: { sellerId: ACCOUNT },
          })
          case 'mtop.taobao.idleitem.badwords.prepubcheck': return ok({ forbidPublish: false })
          case 'mtop.taobao.idle.kgraph.property.recommend': return ok({ cardList: [{
            cardType: '20401', cardData: {
              propertyId: '-10000', propertyName: '类目', isBook: false, supportWebPublish: true,
              valuesList: [{ catId: '5001', channelCatId: '5001', catName: '数码配件',
                leafId: '0', tbCatId: '5001', isClicked: '1', transportData: { channelCateId: '5001' } }],
            },
          }] })
          case 'mtop.taobao.idle.local.poi.get': return ok({ selectedPoi: {
            prov: '浙江省', city: '杭州市', area: '西湖区', divisionId: '330106',
            poiName: '测试发货点', poiId: 'poi-1', latitude: 30.1, longitude: 120.2,
          } })
          case 'mtop.idle.item.publish.service.cards.list': return ok({ services: [{ code: 'AI_SALE' }] })
          case 'mtop.idle.web.xyh.item.list': {
            if (data.needGroupInfo === true) return ok({ itemGroupList: [
              { groupName: '已下架', groupId: 77 }, { groupName: '在售', groupId: 14645107 },
            ] })
            assert.equal(data.groupId, 14645107)
            assert.equal(data.groupName, '在售')
            assert.equal(data.pageSize, 20)
            assert.equal(data.needGroupInfo, false)
            const ids = data.pageNumber === 1 ? ['200001'] : published ? ['200002', '300001'] : ['200002']
            assert.ok(data.pageNumber === 1 || data.pageNumber === 2)
            return ok({ cardList: ids.map(id => ({ cardData: { id, title: `商品${id}` } })), nextPage: data.pageNumber === 1 })
          }
          case 'mtop.idle.pc.idleitem.publish':
            assert.equal(published, false, '平台发布不得重放')
            published = true
            return ok({ itemId: '300001' })
          default: throw new Error(`未声明的官方接口：${api}`)
        }
      },
    },
  })
  const service = createPublishService({
    db, accountId: () => ACCOUNT, now: () => NOW,
    schedule: async (_input, execute) => execute(),
    resolvePage: async () => ({ tabId: 7, documentId: DOCUMENT }),
    executePage: async step => {
      steps.push(structuredClone(step))
      const request = { kind: 'request-step', id: randomUUID(), requestId: randomUUID(), ...step }
      const delivered = options.serializeStepFrame ? JSON.parse(JSON.stringify(request)) : request
      assert.equal(isStepWire(delivered), true, '真实 Host 参数必须通过内部协议校验')
      const result = await runtime.execute(delivered)
      assert.equal(result.terminal, true)
      if (!result.ok) throw Object.assign(new Error(result.error.message), result.error)
      return result.data
    },
  })
  t.after(() => { runtime.dispose(); db.close() })
  return {
    db, service, runtime, calls, steps, uploads, params,
    block(api: string, ret: string) { blockedApi = api; blockedRet = ret },
  }
}

test('跨层离线 prepare→submit 使用真实 Host 指纹、上传结果和官方分页确认，重放不重复发布', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const prepared = await f.service.prepare(f.params)
  assert.equal(prepared.draft.description, DESCRIPTION)
  assert.equal(prepared.draft.title, DESCRIPTION)
  assert.match(prepared.draftFingerprint, /^[a-f0-9]{64}$/)
  assert.deepEqual(f.uploads, [SOURCE_URL])
  assert.equal(f.calls.filter(call => call.api === 'mtop.idle.pc.idleitem.publish').length, 0)
  const countAfterPrepare = f.calls.length
  assert.deepEqual(await f.service.prepare(f.params), prepared)
  assert.equal(f.calls.length, countAfterPrepare)
  const submit = { prepareToken: prepared.prepareToken, draftFingerprint: prepared.draftFingerprint,
    idempotencyKey: 'submit-cross-layer', confirm: CONFIRM }
  const result = await f.service.submit(submit)
  assert.equal(result.state, 'published')
  assert.equal(result.itemId, '300001')
  const writes = f.calls.filter(call => call.api === 'mtop.idle.pc.idleitem.publish')
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0].data.itemTextDTO, {
    desc: prepared.draft.description, title: prepared.draft.title, titleDescSeparate: false,
  })
  const images = writes[0].data.imageInfoDOList as Array<{ url: string; widthSize: number; heightSize: number }>
  assert.equal(images.length, prepared.draft.imageCount)
  assert.equal(images[0].url, UPLOADED_URL)
  assert.equal(images[0].widthSize, 800)
  assert.equal(images[0].heightSize, 600)
  assert.equal(JSON.stringify(writes[0].data).includes(SOURCE_URL), false)
  const submitStep = f.steps.find(step => step.method === 'publish.submit')!
  assert.equal((submitStep.params as { draftFingerprint: string }).draftFingerprint, prepared.draftFingerprint)
  const pages = f.calls.filter(call => call.api === 'mtop.idle.web.xyh.item.list')
  assert.deepEqual(pages.map(call => call.data.needGroupInfo ? 'group' : call.data.pageNumber), ['group', 1, 2, 'group', 1, 2])
  const callsAfterSubmit = f.calls.length
  assert.deepEqual(await f.service.submit(submit), result)
  assert.equal(f.calls.length, callsAfterSubmit)
  assert.equal(f.db.getOperation(ACCOUNT, 'publish.submit', submit.idempotencyKey)?.status, 'succeeded')
})

for (const [code, ret] of [
  ['RISK_BLOCKED', 'FAIL_SYS_USER_VALIDATE::需要验证'],
  ['LOGIN_REQUIRED', 'FAIL_SYS_SESSION_EXPIRED::登录失效'],
] as const) {
  for (const phase of ['prepare', 'submit', 'myItems'] as const) {
    test(`跨层官方 ${code} 从 ${phase} runtime 传到 service，停止且不重放`, { timeout: 5000 }, async t => {
      const f = fixture(t)
      const prepared = phase === 'submit' ? await f.service.prepare(f.params) : null
      f.block(phase === 'myItems' ? 'mtop.idle.web.xyh.item.list' : 'mtop.idle.pc.idleitem.prepublish.check', ret)
      const submit = prepared ? { prepareToken: prepared.prepareToken, draftFingerprint: prepared.draftFingerprint,
        idempotencyKey: 'submit-risk', confirm: CONFIRM } : null
      const invoke = () => phase === 'prepare' ? f.service.prepare(f.params)
        : phase === 'submit' ? f.service.submit(submit!) : f.service.myItems({})
      await assert.rejects(invoke(), { code, retryable: false })
      assert.equal(f.runtime.status().activeStepId, null)
      assert.equal(f.calls.filter(call => call.api === 'mtop.idle.pc.idleitem.publish').length, 0)
      if (phase !== 'myItems') {
        assert.equal(f.db.getOperation(ACCOUNT, `publish.${phase}`, phase === 'prepare' ? f.params.idempotencyKey : submit!.idempotencyKey)?.status, 'unknown')
        const count = f.calls.length
        await assert.rejects(invoke(), { code: 'RESULT_UNKNOWN' })
        assert.equal(f.calls.length, count)
      }
    })
  }
}

test('跨层公共参数：publish.myItems 经 validateParams→编排层双重规范化后仍返回完整基线', { timeout: 5000 }, async t => {
  const f = fixture(t)
  // 真实公共入口的两次校验：服务端 validateParams 补默认值，编排层再规范化一次。
  // 二次规范化若拒绝自己的输出，公共 publish.myItems 会在进入页面执行器之前失败。
  const params = validateParams('publish.myItems', {})
  assert.deepEqual(params, { limit: 100, maxWaitMs: 120000 })
  const result = await f.service.myItems(params)
  assert.deepEqual(result.items.map(item => item.itemId), ['200001', '200002'])
  assert.equal(result.total, 2)
  assert.equal(result.hasMore, false)
  const pages = f.calls.filter(call => call.api === 'mtop.idle.web.xyh.item.list')
  assert.deepEqual(pages.map(call => call.data.needGroupInfo ? 'group' : call.data.pageNumber), ['group', 1, 2])
  assert.ok(pages.every(call => call.data.pageSize === 20))
  // 页面执行器在单步内完成该账号的少量分页，Host 只派发公共参数；
  // 只有页面读满单步安全页数时才追加内部游标，公共 API 始终不接受原始游标。
  const steps = f.steps.filter(step => step.method === 'publish.myItems')
  assert.equal(steps.length, 1)
  assert.deepEqual(steps[0].params, { limit: 100 })
  assert.equal('nextPage' in (steps[0].params as Record<string, unknown>), false)
})

test('跨层公共路由：publish.myItems 空参数返回 200，而不是 400 BAD_REQUEST', { timeout: 5000 }, async t => {
  const f = fixture(t)
  const { HostServer } = await import('./server.ts')
  const token = 'z'.repeat(32)
  const input = new PassThrough()
  const output = new PassThrough()
  // 发布编排完全由 publishService 承担；bridge 只用于构造 HostServer，不参与本用例。
  const bridge = new NativeBridge(input, output, () => {}, 1000)
  const server = new HostServer(0, token, bridge, f.db, undefined, undefined, undefined, undefined, f.service)
  t.after(async () => { await server.close(); bridge.close(); input.destroy(); output.destroy() })
  const port = await server.listen()
  const response = await fetch(`http://127.0.0.1:${port}/v1/publish.myItems`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{}',
  })
  const body = await response.json() as { ok: boolean; data?: { items: Array<{ itemId: string }>; total: number; hasMore: boolean } }
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.deepEqual(body.data?.items.map(item => item.itemId), ['200001', '200002'])
  assert.equal(body.data?.hasMore, false)
})

test('跨 realm 交付：步骤帧经 executeScript JSON 序列化后页面执行器仍返回基线', { timeout: 5000 }, async t => {
  const f = fixture(t, { serializeStepFrame: true })
  const params = validateParams('publish.myItems', { limit: 20 })
  const result = await f.service.myItems(params)
  assert.deepEqual(result.items.map(item => item.itemId), ['200001', '200002'])
  assert.equal(result.hasMore, false)
})
