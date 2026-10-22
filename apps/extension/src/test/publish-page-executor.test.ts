import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  executeMyItems,
  executePrepare,
  executeSubmit,
  runPublishMyItems,
  runPublishPrepare,
  runPublishSubmit,
  type MtopRequestFn,
  type MtopResponse,
  type PublishPageExecutorDeps,
  type PublishPreparedContext,
  type PublishPreparedStore,
} from '../publish-page-executor.ts'
import type {
  PublishMyItemsParams,
  PublishPrepareParams,
  PublishSubmitParams,
} from '../../../../packages/protocol/src/publish.ts'

const ACCOUNT_ID = 'account-a'
const NOW = 1_700_000_000_000
const PREPARE_TOKEN = 'prepare-token'

function draftFingerprint(params: PublishPrepareParams): string {
  return createHash('sha256')
    .update(JSON.stringify([ACCOUNT_ID, params.source.itemId, params.draft]))
    .digest('hex')
}

function prepareParams(): PublishPrepareParams {
  return {
    source: { itemId: 'item-1' },
    idempotencyKey: 'prepare-key',
    seller: { addressRef: 'poi-1' },
    confirm: { imageNoQr: true, addressConfirmed: true },
    draft: {
      title: '自用一年，无拆无修',
      description: '自用一年，无拆无修',
      price: { kind: 'fixed', amount: 199, unit: 'CNY' },
      images: [{ kind: 'uploaded', ref: 'uploaded-image-1' }],
      categoryRef: 'category-1',
      attributeRefs: ['attribute-1'],
      services: [{ ref: 'service-1' }],
    },
  }
}

function submitParams(params = prepareParams()): PublishSubmitParams {
  return {
    prepareToken: PREPARE_TOKEN,
    draftFingerprint: draftFingerprint(params),
    idempotencyKey: 'submit-key',
    confirm: { imageNoQr: true, addressConfirmed: true },
  }
}

function myItemsParams(limit = 20): PublishMyItemsParams {
  return { limit, maxWaitMs: 20_000 }
}

type Call = {
  api: string
  version: string
  data: Record<string, unknown>
  headers?: Record<string, string>
}

function createStore(initial?: PublishPreparedContext, key = PREPARE_TOKEN): {
  store: PublishPreparedStore
  values: Map<string, PublishPreparedContext>
} {
  const values = new Map<string, PublishPreparedContext>()
  if (initial) values.set(key, initial)
  return {
    values,
    store: {
      get: token => values.get(token) ?? null,
      set: (token, value) => { values.set(token, value) },
      delete: token => { values.delete(token) },
    },
  }
}

function deps(
  respond: (call: Call, index: number) => MtopResponse | Promise<MtopResponse>,
  accounts: Array<string | null> = [ACCOUNT_ID],
  store?: PublishPreparedStore,
): {
  deps: PublishPageExecutorDeps
  calls: Call[]
  mtopRequest: MtopRequestFn
} {
  const calls: Call[] = []
  let accountIndex = 0
  const mtopRequest: MtopRequestFn = async (api, version, data, headers) => {
    const call = { api, version, data: structuredClone(data), ...(headers ? { headers: structuredClone(headers) } : {}) }
    calls.push(call)
    return respond(call, calls.length - 1)
  }
  return {
    calls,
    mtopRequest,
    deps: {
      mtopRequest,
      readAccountId: () => accounts[Math.min(accountIndex++, accounts.length - 1)] ?? null,
      now: () => NOW,
      ...(store ? { preparedStore: store } : {}),
      createPrepareToken: () => PREPARE_TOKEN,
      uploadedImages: {
        'uploaded-image-1': {
          url: 'https://example.com/uploaded-1.jpg',
          widthSize: 800,
          heightSize: 600,
        },
      },
    },
  }
}

const CATEGORY_CARD = {
  cardType: '20401',
  cardData: {
    propertyId: '-10000',
    propertyName: '类目',
    supportWebPublish: true,
    valuesList: [{
      catId: 'category-1',
      channelCatId: 'category-1',
      catName: '键盘',
      valueId: 'category-1',
      valueName: '键盘',
      leafId: 'leaf-1',
      transportData: { categoryTransport: 'category-secret' },
      isClicked: '1',
    }],
  },
}

const ATTRIBUTE_CARD = {
  cardType: '20401',
  cardData: {
    propertyId: 'attribute-card-1',
    propertyName: '成色',
    supportWebPublish: true,
    valuesList: [{
      valueId: 'attribute-1',
      valueName: '九成新',
      transportData: { attributeTransport: 'attribute-secret' },
      isClicked: '1',
    }],
  },
}

function prepareSuccess(call: Call): MtopResponse {
  if (call.api === 'mtop.idle.pc.idleitem.prepublish.check') {
    return { ret: ['SUCCESS::ok'], data: { limited: false } }
  }
  if (call.api === 'mtop.idle.pc.idleitem.preget') {
    return { ret: ['SUCCESS::ok'], data: {} }
  }
  if (call.api === 'mtop.taobao.idle.pc.detail') {
    return {
      ret: ['SUCCESS::ok'],
      data: {
        itemDO: {
          desc: '九成新机械键盘',
          soldPrice: '199',
          imageInfos: [{ url: 'https://example.com/source.jpg' }],
          itemLabelExtList: [{ propertyName: '品牌', valueName: '示例品牌' }],
        },
      },
    }
  }
  if (call.api === 'mtop.taobao.idleitem.badwords.prepubcheck') {
    return { ret: ['SUCCESS::ok'], data: { forbidPublish: false } }
  }
  if (call.api === 'mtop.taobao.idle.kgraph.property.recommend') {
    return { ret: ['SUCCESS::ok'], data: { cardList: [CATEGORY_CARD, ATTRIBUTE_CARD] } }
  }
  if (call.api === 'mtop.taobao.idle.local.poi.get') {
    return {
      ret: ['SUCCESS::ok'],
      data: {
        selectedPoi: {
          prov: '浙江省',
          city: '杭州市',
          area: '西湖区',
          divisionId: 'division-1',
          poiName: '示例站点',
          poiId: 'poi-1',
          gps: '30.1,120.2',
        },
      },
    }
  }
  if (call.api === 'mtop.idle.item.publish.service.cards.list') {
    return { ret: ['SUCCESS::ok'], data: { services: [{ code: 'service-1' }] } }
  }
  throw new Error(`未预期的接口：${call.api}`)
}

function preparedContext(params = prepareParams()): PublishPreparedContext {
  return {
    accountId: ACCOUNT_ID,
    sourceItemId: 'item-1',
    expiresAt: NOW + 60_000,
    prepareRef: 'prep.test',
    draftFingerprint: draftFingerprint(params),
    rawCards: [CATEGORY_CARD, ATTRIBUTE_CARD],
    core: {
      description: '自用一年，无拆无修',
      priceYuan: '199',
      specifications: [{ name: '品牌', value: '示例品牌' }],
      itemCatDTO: {
        catId: 'category-1',
        catName: '键盘',
        channelCatId: 'category-1',
        leafId: 'leaf-1',
        tbCatId: '',
      },
      itemLabelExtList: [
        { propertyId: '-10000', propertyName: '类目', text: '键盘' },
        { propertyId: 'attribute-card-1', propertyName: '成色', text: '九成新' },
      ],
      itemAddrDTO: {
        prov: '浙江省',
        city: '杭州市',
        area: '西湖区',
        divisionId: 'division-1',
        poiName: '示例站点',
        poiId: 'poi-1',
        gps: '30.1,120.2',
      },
      imageInfoDOList: [{
        extraInfo: { isH: 'false', isT: 'false', raw: 'false' },
        isQrCode: false,
        url: 'https://example.com/uploaded-1.jpg',
        heightSize: 600,
        widthSize: 800,
        major: true,
        type: 0,
        status: 'done',
      }],
      services: [{ serviceCode: 'service-1', enable: true }],
    },
  }
}

function submitSuccess(call: Call): MtopResponse {
  if (call.api === 'mtop.idle.pc.idleitem.prepublish.check') {
    return { ret: ['SUCCESS::ok'], data: { limited: false } }
  }
  if (call.api === 'mtop.taobao.idleitem.badwords.prepubcheck') {
    return { ret: ['SUCCESS::ok'], data: { forbidPublish: false } }
  }
  if (call.api === 'mtop.idle.item.publish.service.cards.list') {
    return { ret: ['SUCCESS::ok'], data: { services: [{ code: 'service-1' }] } }
  }
  if (call.api === 'mtop.idle.pc.idleitem.publish') {
    return { ret: ['SUCCESS::ok'], data: { itemId: 'published-item-1' } }
  }
  throw new Error(`未预期的接口：${call.api}`)
}

function writeCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.api === 'mtop.idle.pc.idleitem.publish')
}

test('prepare 按真实只读链路准备，不调用 publish', async () => {
  const harness = deps(prepareSuccess, [ACCOUNT_ID, ACCOUNT_ID])
  const store = createStore()

  const outcome = await executePrepare(prepareParams(), ACCOUNT_ID, {
    ...harness.deps,
    preparedStore: store.store,
  })

  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    // Host 只拿到脱敏摘要、候选和内部引用；原始上下文不能返回。
    assert.deepEqual(Object.keys(outcome.result).sort(), ['candidates', 'draft', 'prepareRef'])
    assert.match(outcome.result.prepareRef, /^prep\.[A-Za-z0-9._:-]+$/)
    assert.equal(JSON.stringify(outcome.result).includes('rawCards'), false)
  }
  assert.deepEqual(harness.calls.map(call => call.api), [
    'mtop.idle.pc.idleitem.prepublish.check',
    'mtop.idle.pc.idleitem.preget',
    'mtop.taobao.idle.pc.detail',
    'mtop.taobao.idleitem.badwords.prepubcheck',
    'mtop.taobao.idle.kgraph.property.recommend',
    'mtop.taobao.idle.local.poi.get',
    'mtop.idle.item.publish.service.cards.list',
  ])
  assert.equal(writeCalls(harness.calls).length, 0)
  const prepared = [...store.values.values()][0]
  assert.equal(prepared?.core.imageInfoDOList.length, 1)
  assert.equal(harness.calls.find(call => call.api === 'mtop.taobao.idle.kgraph.property.recommend')?.version, '2.0')
  assert.equal(
    harness.calls.find(call => call.api === 'mtop.taobao.idle.kgraph.property.recommend')?.data['publishScene'],
    'mainPublish',
  )
  assert.equal(
    harness.calls.find(call => call.api === 'mtop.taobao.idle.local.poi.get')?.headers?.['EagleEye-UserData'],
    'spm-cnt=a21ybx',
  )
})

test('prepare 的真实图片和推荐请求使用上传引用及 selectedPoi 形状', async () => {
  const harness = deps(prepareSuccess, [ACCOUNT_ID, ACCOUNT_ID])
  const outcome = await executePrepare(prepareParams(), ACCOUNT_ID, {
    ...harness.deps,
    preparedStore: createStore().store,
  })

  assert.equal(outcome.ok, true)
  const recommend = harness.calls.find(call => call.api === 'mtop.taobao.idle.kgraph.property.recommend')
  const images = recommend?.data['imageInfos'] as Array<Record<string, unknown>>
  assert.deepEqual(images[0], {
    extraInfo: { isH: 'false', isT: 'false', raw: 'false' },
    isQrCode: false,
    url: 'https://example.com/uploaded-1.jpg',
    heightSize: 600,
    widthSize: 800,
    major: true,
    type: 0,
    status: 'done',
  })
  const services = harness.calls.find(call => call.api === 'mtop.idle.item.publish.service.cards.list')
  const itemInfoJson = JSON.parse(String(services?.data['itemInfoJson'])) as Record<string, unknown>
  assert.deepEqual(itemInfoJson['itemAddrDTO'], {
    prov: '浙江省',
    city: '杭州市',
    area: '西湖区',
    divisionId: 'division-1',
    poiName: '示例站点',
    poiId: 'poi-1',
    gps: '30.1,120.2',
  })
  const cpvList = JSON.parse(String(services?.data['cpvList'])) as typeof CATEGORY_CARD[]
  expectCpvSelection(cpvList, 'category-1', 'attribute-1')
})

function cpvValue(cpvList: unknown[], propertyId: string, valueId: string): Record<string, unknown> {
  const card = cpvList.find((raw) => {
    const entry = raw as { cardData?: Record<string, unknown> }
    return entry.cardData?.['propertyId'] === propertyId
  }) as { cardData?: { valuesList?: Array<Record<string, unknown>> } } | undefined
  const value = card?.cardData?.valuesList?.find(item =>
    propertyId === '-10000'
      ? item['channelCatId'] === valueId || item['catId'] === valueId
      : item['valueId'] === valueId,
  )
  assert.ok(value, `缺少 ${propertyId}/${valueId} 候选`)
  return value
}

function expectCpvSelection(cpvList: unknown[], categoryId: string, attributeId: string): void {
  const category = cpvValue(cpvList, '-10000', categoryId)
  const attribute = cpvValue(cpvList, 'attribute-card-1', attributeId)
  assert.equal(category['isClicked'], '1')
  assert.equal(attribute['isClicked'], '1')
  assert.equal(attribute['isUserClick'], '1')
}

test('prepare 的违禁词响应缺 forbidPublish 时失败关闭', async () => {
  const harness = deps((call) => {
    if (call.api === 'mtop.taobao.idleitem.badwords.prepubcheck') {
      return { ret: ['SUCCESS::ok'], data: {} }
    }
    return prepareSuccess(call)
  }, [ACCOUNT_ID, ACCOUNT_ID])

  const outcome = await executePrepare(prepareParams(), ACCOUNT_ID, {
    ...harness.deps,
    preparedStore: createStore().store,
  })

  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.error.code, 'PLATFORM_REJECTED')
  assert.equal(harness.calls.some(call => call.api === 'mtop.taobao.idle.kgraph.property.recommend'), false)
  assert.equal(writeCalls(harness.calls).length, 0)
})

test('prepare 不接受缺少真实宽高的上传图片引用', async () => {
  const params = prepareParams()
  params.draft!.images = [{ kind: 'uploaded', ref: 'missing-size-image' }]
  const harness = deps(prepareSuccess, [ACCOUNT_ID, ACCOUNT_ID])

  const outcome = await executePrepare(params, ACCOUNT_ID, {
    ...harness.deps,
    preparedStore: createStore().store,
  })

  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.error.code, 'PLATFORM_REJECTED')
  assert.equal(harness.calls.some(call => call.api === 'mtop.taobao.idle.kgraph.property.recommend'), false)
  assert.equal(writeCalls(harness.calls).length, 0)
})

test('prepare 的 selectedPoi 坐标非法时失败关闭', async () => {
  const harness = deps((call) => {
    if (call.api === 'mtop.taobao.idle.local.poi.get') {
      return {
        ret: ['SUCCESS::ok'],
        data: {
          selectedPoi: {
            prov: '浙江省', city: '杭州市', area: '西湖区', divisionId: 'division-1',
            poiName: '示例站点', poiId: 'poi-1', gps: '91,120.2',
          },
        },
      }
    }
    return prepareSuccess(call)
  }, [ACCOUNT_ID, ACCOUNT_ID])

  const outcome = await executePrepare(prepareParams(), ACCOUNT_ID, {
    ...harness.deps,
    preparedStore: createStore().store,
  })

  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.error.code, 'PLATFORM_REJECTED')
  assert.equal(writeCalls(harness.calls).length, 0)
})

test('prepare 的 addressRef 与账号已选 selectedPoi 不一致时拒绝，不使用默认地址', async () => {
  const harness = deps(prepareSuccess, [ACCOUNT_ID, ACCOUNT_ID])
  const params = prepareParams()
  params.seller = { addressRef: 'poi-forged' }

  const outcome = await executePrepare(params, ACCOUNT_ID, {
    ...harness.deps,
    preparedStore: createStore().store,
  })

  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.match(outcome.error.message, /地址.*不一致/)
  assert.equal(harness.calls.some(call => call.api === 'mtop.idle.item.publish.service.cards.list'), false)
})

test('prepare 遇到发布资格受限时停止，后续只读接口和 publish 都不调用', async () => {
  const harness = deps((call) => {
    if (call.api === 'mtop.idle.pc.idleitem.prepublish.check') {
      return { ret: ['SUCCESS::ok'], data: { limited: true } }
    }
    return prepareSuccess(call)
  }, [ACCOUNT_ID, ACCOUNT_ID])

  const outcome = await executePrepare(prepareParams(), ACCOUNT_ID, {
    ...harness.deps,
    preparedStore: createStore().store,
  })

  assert.equal(outcome.ok, false)
  assert.deepEqual(harness.calls.map((call) => call.api), [
    'mtop.idle.pc.idleitem.prepublish.check',
  ])
  assert.equal(writeCalls(harness.calls).length, 0)
})

test('submit 成功后只发出一次写请求，且不自动重试', async () => {
  const params = submitParams()
  const store = createStore(preparedContext(), params.draftFingerprint)
  const harness = deps(submitSuccess, [ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID], store.store)

  const outcome = await executeSubmit(params, ACCOUNT_ID, harness.deps)

  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.deepEqual(outcome.result, {
    outcome: 'accepted',
    itemId: 'published-item-1',
  })
  assert.equal(writeCalls(harness.calls).length, 1)
  const write = writeCalls(harness.calls)[0]!
  assert.deepEqual(Object.keys(write.data).sort(), [
    'bizcode', 'freebies', 'imageInfoDOList', 'itemAddrDTO', 'itemCatDTO',
    'itemLabelExtList', 'itemPostFeeDTO', 'itemPriceDTO', 'itemTextDTO',
    'itemTypeStr', 'publishScene', 'quantity', 'simpleItem', 'sourceId',
    'uniqueCode', 'userRightsProtocols',
  ])
  assert.deepEqual(write.data['itemTextDTO'], {
    desc: '自用一年，无拆无修\n品牌：示例品牌',
    title: '自用一年，无拆无修\n品牌：示例品牌',
    titleDescSeparate: false,
  })
  assert.deepEqual(write.data['itemPriceDTO'], { priceInCent: '19900' })
  assert.equal(JSON.stringify(write.data).includes('prepareToken'), false)
  assert.equal(JSON.stringify(write.data).includes('draftFingerprint'), false)
  assert.equal(JSON.stringify(write.data).includes('idempotencyKey'), false)
})

test('submit 使用 Host 回传指纹恢复权威上下文，不要求 Host token 命中页面存储', async () => {
  const params = submitParams()
  const store = createStore(preparedContext(), params.draftFingerprint)
  const harness = deps(submitSuccess, [ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID], store.store)
  const hostToken = 'host-issued-token-not-in-page-store'

  const outcome = await executeSubmit({ ...params, prepareToken: hostToken }, ACCOUNT_ID, harness.deps)

  assert.equal(outcome.ok, true)
  if (outcome.ok) assert.equal(outcome.result.itemId, 'published-item-1')
  assert.equal(writeCalls(harness.calls).length, 1)
})

test('submit 的指纹不一致时不发送写请求', async () => {
  const params = submitParams()
  const store = createStore(preparedContext(), params.draftFingerprint)
  const harness = deps(submitSuccess, [ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID], store.store)

  const outcome = await executeSubmit({ ...params, draftFingerprint: 'f'.repeat(64) }, ACCOUNT_ID, harness.deps)

  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.error.code, 'PLATFORM_REJECTED')
  assert.equal(writeCalls(harness.calls).length, 0)
})

test('submit 业务失败后不发出第二次写请求', async () => {
  const params = submitParams()
  const store = createStore(preparedContext(), params.draftFingerprint)
  const harness = deps((call) => {
    if (call.api === 'mtop.idle.pc.idleitem.publish') {
      return { ret: ['FAIL_BIZ_FORBIDDEN::发布被拒绝'] }
    }
    return submitSuccess(call)
  }, [ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID], store.store)

  const outcome = await executeSubmit(params, ACCOUNT_ID, harness.deps)

  assert.equal(outcome.ok, false)
  assert.equal(writeCalls(harness.calls).length, 1)
  if (!outcome.ok) {
    assert.equal(outcome.error.code, 'PLATFORM_REJECTED')
    assert.equal(outcome.error.retryable, false)
  }
})

test('submit 超时后返回 unknown，且不发出第二次写请求', async () => {
  const params = submitParams()
  const store = createStore(preparedContext(), params.draftFingerprint)
  const harness = deps((call) => {
    if (call.api === 'mtop.idle.pc.idleitem.publish') {
      return Promise.reject(new Error('request timeout'))
    }
    return submitSuccess(call)
  }, [ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID], store.store)

  const outcome = await executeSubmit(params, ACCOUNT_ID, harness.deps)

  assert.equal(outcome.ok, false)
  assert.equal(writeCalls(harness.calls).length, 1)
  if (!outcome.ok) {
    assert.equal(outcome.error.code, 'TIMEOUT')
    assert.equal(outcome.error.retryable, false)
  }
})

test('myItems 遵循 legacy 语义：发现「在售」分组、按 nextPage 读全并去重', async () => {
  const harness = deps((call) => {
    if (call.api !== 'mtop.idle.web.xyh.item.list') {
      throw new Error(`未预期的接口：${call.api}`)
    }
    if (call.data['needGroupInfo'] === true) {
      return {
        ret: ['SUCCESS::ok'],
        data: {
          itemGroupList: [
            { groupName: '综合', groupId: 14645106, itemNumber: 16 },
            { groupName: '在售', groupId: 14645107, itemNumber: 2 },
          ],
          cardList: [],
          nextPage: false,
        },
      }
    }
    if (call.data['pageNumber'] === 1) {
      return {
        ret: ['SUCCESS::ok'],
        data: {
          cardList: [
            { cardData: { id: 'on-sale-1', title: '在售商品一' } },
            { cardData: { id: 'duplicate', title: '重复项' } },
          ],
          nextPage: true,
        },
      }
    }
    return {
      ret: ['SUCCESS::ok'],
      data: {
        cardList: [
          { cardData: { id: 'duplicate', title: '重复项' } },
          { cardData: { id: 'on-sale-2', title: '在售商品二' } },
        ],
        nextPage: false,
      },
    }
  })

  const outcome = await executeMyItems(myItemsParams(), ACCOUNT_ID, harness.deps)

  assert.equal(
    outcome.ok,
    true,
    '当前 executeMyItems 未实现 legacy 的可变在售 groupId 发现与 nextPage 分页语义',
  )
  if (outcome.ok) {
    assert.deepEqual(outcome.result.items, [
      { itemId: 'on-sale-1', title: '在售商品一' },
      { itemId: 'duplicate', title: '重复项' },
      { itemId: 'on-sale-2', title: '在售商品二' },
    ])
    assert.equal(outcome.result.hasMore, false)
  }

  assert.equal(harness.calls.length, 3)
  const [probe, firstPage, secondPage] = harness.calls
  assert.equal(probe!.data['needGroupInfo'], true)
  assert.equal(probe!.data['defaultGroup'], true)
  assert.equal(firstPage!.data['needGroupInfo'], false)
  assert.equal(firstPage!.data['groupName'], '在售')
  assert.equal(firstPage!.data['groupId'], 14645107)
  assert.equal(firstPage!.data['pageNumber'], 1)
  assert.equal(secondPage!.data['pageNumber'], 2)
  assert.equal(secondPage!.data['pageSize'], 20)
})

test('myItems 在售分组缺失时返回空，结构异常和 nextPage 非布尔时失败', async () => {
  const noGroup = deps(() => ({
    ret: ['SUCCESS::ok'],
    data: { itemGroupList: [{ groupName: '综合', groupId: 1 }], cardList: [], nextPage: false },
  }), [ACCOUNT_ID, ACCOUNT_ID])
  const empty = await executeMyItems(myItemsParams(), ACCOUNT_ID, noGroup.deps)
  assert.equal(empty.ok, true)
  if (empty.ok) assert.deepEqual(empty.result.items, [])

  const missingGroups = deps(() => ({ ret: ['SUCCESS::ok'], data: { cardList: [] } }))
  const missing = await executeMyItems(myItemsParams(), ACCOUNT_ID, missingGroups.deps)
  assert.equal(missing.ok, false)

  const badNext = deps(call => call.data['needGroupInfo'] === true
    ? {
      ret: ['SUCCESS::ok'],
      data: { itemGroupList: [{ groupName: '在售', groupId: 7 }], cardList: [], nextPage: false },
    }
    : { ret: ['SUCCESS::ok'], data: { cardList: [], nextPage: 'yes' } }, [ACCOUNT_ID, ACCOUNT_ID])
  const invalidNext = await executeMyItems(myItemsParams(), ACCOUNT_ID, badNext.deps)
  assert.equal(invalidNext.ok, false)
  if (!invalidNext.ok) assert.equal(invalidNext.error.code, 'RESULT_UNKNOWN')

  const missingCards = deps(call => call.data['needGroupInfo'] === true
    ? {
      ret: ['SUCCESS::ok'],
      data: { itemGroupList: [{ groupName: '在售', groupId: 7 }], cardList: [], nextPage: false },
    }
    : { ret: ['SUCCESS::ok'], data: { nextPage: false } }, [ACCOUNT_ID, ACCOUNT_ID])
  const noCards = await executeMyItems(myItemsParams(), ACCOUNT_ID, missingCards.deps)
  assert.equal(noCards.ok, false)
  if (!noCards.ok) assert.equal(noCards.error.code, 'RESULT_UNKNOWN')
})

test('myItems 达到安全页数仍 nextPage 时返回受控游标而不是静默截断', async () => {
  let pageCalls = 0
  const harness = deps(call => {
    if (call.data['needGroupInfo'] === true) {
      return {
        ret: ['SUCCESS::ok'],
        data: { itemGroupList: [{ groupName: '在售', groupId: 9 }], cardList: [], nextPage: false },
      }
    }
    pageCalls += 1
    return {
      ret: ['SUCCESS::ok'],
      data: { cardList: [{ cardData: { id: `item-${pageCalls}` } }], nextPage: true },
    }
  })

  const outcome = await executeMyItems(myItemsParams(), ACCOUNT_ID, harness.deps)

  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    assert.equal(outcome.result.items.length, 20)
    assert.equal(outcome.result.hasMore, true)
    assert.equal(typeof outcome.result.nextPage, 'string')
  }
  assert.equal(pageCalls, 20)
})

test('myItems 单步结果只返回 Host 内部字段，不携带公共 total', async () => {
  const harness = deps((call) => {
    if (call.data['needGroupInfo'] === true) {
      return {
        ret: ['SUCCESS::ok'],
        data: { itemGroupList: [{ groupName: '在售', groupId: 3 }], cardList: [], nextPage: false },
      }
    }
    return { ret: ['SUCCESS::ok'], data: { cardList: [], nextPage: false } }
  })

  const outcome = await executeMyItems(myItemsParams(), ACCOUNT_ID, harness.deps)

  assert.equal(outcome.ok, true)
  if (outcome.ok) {
    assert.deepEqual(Object.keys(outcome.result).sort(), ['hasMore', 'items'])
    assert.deepEqual(outcome.result, { items: [], hasMore: false })
  }
})

test('submit 前账号漂移时不发出写请求', async () => {
  const params = submitParams()
  const store = createStore(preparedContext(), params.draftFingerprint)
  const harness = deps(submitSuccess, [ACCOUNT_ID, 'account-b'], store.store)

  const outcome = await executeSubmit(params, ACCOUNT_ID, harness.deps)

  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.error.code, 'ACCOUNT_CHANGED')
  assert.equal(writeCalls(harness.calls).length, 0)
})

test('submit 成功后账号漂移时不返回成功结果', async () => {
  const params = submitParams()
  const store = createStore(preparedContext(), params.draftFingerprint)
  const harness = deps(submitSuccess, [ACCOUNT_ID, ACCOUNT_ID, 'account-b'], store.store)

  const outcome = await executeSubmit(params, ACCOUNT_ID, harness.deps)

  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.error.code, 'ACCOUNT_CHANGED')
  assert.ok(!JSON.stringify(outcome).includes('published-item-1'))
  assert.equal(writeCalls(harness.calls).length, 1)
})

test('submit 在只读预检期间账号漂移时不发出写请求', async () => {
  const params = submitParams()
  const store = createStore(preparedContext(), params.draftFingerprint)
  let current: string | null = ACCOUNT_ID
  const harness = deps((call) => {
    if (call.api === 'mtop.idle.pc.idleitem.prepublish.check') {
      current = 'account-b'
      return { ret: ['SUCCESS::ok'], data: { limited: false } }
    }
    return submitSuccess(call)
  }, [ACCOUNT_ID], store.store)
  harness.deps.readAccountId = () => current

  const outcome = await executeSubmit(params, ACCOUNT_ID, harness.deps)

  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.error.code, 'ACCOUNT_CHANGED')
  assert.equal(writeCalls(harness.calls).length, 0)
})

test('Host prepare 单步参数不带公共幂等键也可进入页面准备', async () => {
  const harness = deps(prepareSuccess, [ACCOUNT_ID, ACCOUNT_ID])
  const params = {
    source: { itemId: 'item-1' },
    seller: { addressRef: 'poi-1' },
    confirm: { imageNoQr: true, addressConfirmed: true },
    draft: prepareParams().draft,
  }

  const outcome = await runPublishPrepare(params, ACCOUNT_ID, {
    ...harness.deps,
    preparedStore: createStore().store,
  })

  assert.equal(outcome.ok, true)
  assert.equal(writeCalls(harness.calls).length, 0)
})

test('Host submit 单步参数不带公共幂等键也可进入页面提交', async () => {
  const params = submitParams()
  const store = createStore(preparedContext(), params.draftFingerprint)
  const harness = deps(submitSuccess, [ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID, ACCOUNT_ID], store.store)
  const stepParams = {
    prepareToken: params.prepareToken,
    draftFingerprint: params.draftFingerprint,
    source: { itemId: 'item-1' },
    draft: prepareParams().draft,
    candidates: {
      categoryRefs: ['category-1'],
      attributeRefs: ['attribute-1'],
      serviceRefs: ['service-1'],
    },
    confirm: { imageNoQr: true, addressConfirmed: true },
  }

  const outcome = await runPublishSubmit(stepParams, ACCOUNT_ID, harness.deps)

  assert.equal(outcome.ok, true)
  assert.equal(writeCalls(harness.calls).length, 1)
})

test('prepare 显式规格覆盖会进入预检与最终提交，不回退源商品规格', async () => {
  const params = prepareParams()
  params.draft = {
    ...params.draft,
    specs: [{ key: '成色', value: '九五新' }, { key: '配件', value: '含原装线' }],
  }
  const harness = deps(prepareSuccess, [ACCOUNT_ID, ACCOUNT_ID])
  const store = createStore()

  const prepared = await executePrepare(params, ACCOUNT_ID, {
    ...harness.deps,
    preparedStore: store.store,
  })

  assert.equal(prepared.ok, true)
  const badwords = harness.calls.find(call => call.api === 'mtop.taobao.idleitem.badwords.prepubcheck')
  assert.match(String(badwords?.data['title']), /成色：九五新/)
  assert.match(String(badwords?.data['title']), /配件：含原装线/)
  assert.doesNotMatch(String(badwords?.data['title']), /示例品牌/)
  const context = [...store.values.values()][0]
  assert.deepEqual(context?.core.specifications, [
    { name: '成色', value: '九五新' },
    { name: '配件', value: '含原装线' },
  ])
})

test('prepare 请求期间账号漂移时不返回候选结果', async () => {
  const accounts = [ACCOUNT_ID, 'account-b']
  const harness = deps(prepareSuccess, accounts)

  const outcome = await executePrepare(prepareParams(), ACCOUNT_ID, {
    ...harness.deps,
    preparedStore: createStore().store,
  })

  assert.equal(outcome.ok, false)
  if (!outcome.ok) assert.equal(outcome.error.code, 'ACCOUNT_CHANGED')
})

test('参数非法时不发 MTOP 请求', async () => {
  const harness = deps(() => ({ ret: ['SUCCESS::ok'] }))

  const prepareOutcome = await runPublishPrepare(
    { ...prepareParams(), confirm: { imageNoQr: true, addressConfirmed: false } },
    ACCOUNT_ID,
    harness.deps,
  )
  const submitOutcome = await runPublishSubmit(
    { ...submitParams(), itemId: 'client-forged-item' },
    ACCOUNT_ID,
    harness.deps,
  )
  const myItemsOutcome = await runPublishMyItems(
    { ...myItemsParams(), page: 2 },
    ACCOUNT_ID,
    harness.deps,
  )

  assert.equal(prepareOutcome.ok, false)
  assert.equal(submitOutcome.ok, false)
  assert.equal(myItemsOutcome.ok, false)
  assert.equal(harness.calls.length, 0)
})

test('真实源字段接受数字售价、数字坐标及协议相对图片，违禁词先于上传', async () => {
  const params = prepareParams()
  delete params.draft!.images
  const order: string[] = []
  const harness = deps(call => {
    order.push(call.api)
    const response = prepareSuccess(call)
    if (call.api === 'mtop.taobao.idle.pc.detail') {
      const data = response.data as any
      data.itemDO.soldPrice = 199
      data.itemDO.imageInfos = [{ url: '//img.example.com/source.jpg' }]
    }
    if (call.api === 'mtop.taobao.idle.local.poi.get') {
      const poi = (response.data as any).selectedPoi
      delete poi.gps
      poi.latitude = 30.1
      poi.longitude = 120.2
    }
    return response
  })
  const result = await executePrepare(params, ACCOUNT_ID, {
    ...harness.deps, preparedStore: createStore().store,
    uploadImage: { upload: async source => {
      order.push('upload')
      assert.equal(source.url, 'https://img.example.com/source.jpg')
      return { url: 'https://img.example.com/uploaded.jpg', widthSize: 10, heightSize: 20 }
    } },
  })
  assert.equal(result.ok, true)
  assert.ok(order.indexOf('mtop.taobao.idleitem.badwords.prepubcheck') < order.indexOf('upload'))
})

test('阿里 CDN 的 http 图片升级为 https 上传，其它域名的 http 图片拒绝', async () => {
  for (const [src, expected] of [['http://img.alicdn.com/a.jpg', 'https://img.alicdn.com/a.jpg'], ['http://img.example.com/a.jpg', null]] as const) {
    const params = prepareParams()
    delete params.draft!.images
    const uploads: string[] = []
    const harness = deps(call => {
      const response = prepareSuccess(call)
      if (call.api === 'mtop.taobao.idle.pc.detail') (response.data as any).itemDO.imageInfos = [{ url: src }]
      return response
    })
    const result = await executePrepare(params, ACCOUNT_ID, {
      ...harness.deps, preparedStore: createStore().store,
      uploadImage: { upload: async source => { uploads.push(source.url); return { url: 'https://img.alicdn.com/up.jpg', widthSize: 10, heightSize: 20 } } },
    })
    if (expected) { assert.equal(result.ok, true); assert.deepEqual(uploads, [expected]) }
    else { assert.equal(result.ok, false); assert.equal(uploads.length, 0) }
  }
})

test('不支持的独立标题必须拒绝，不能展示标题后静默提交另一正文', async () => {
  const params = prepareParams()
  params.draft!.title = '与正文不同的独立标题'
  const harness = deps(prepareSuccess)
  const result = await executePrepare(params, ACCOUNT_ID, { ...harness.deps, preparedStore: createStore().store })
  assert.equal(result.ok, false)
  assert.equal(harness.calls.some(call => call.api === 'mtop.taobao.idleitem.badwords.prepubcheck'), false)
  assert.equal(writeCalls(harness.calls).length, 0)
})

test('在售商品卡缺少 id 不能被跳过后伪装成完整空基线', async () => {
  const harness = deps(call => ({ ret: ['SUCCESS::ok'], data: call.data['needGroupInfo']
    ? { itemGroupList: [{ groupName: '在售', groupId: 123 }] }
    : { cardList: [{ cardData: { title: '缺失ID商品' } }], nextPage: false } }))
  const result = await executeMyItems(myItemsParams(), ACCOUNT_ID, harness.deps)
  assert.equal(result.ok, false)
})
