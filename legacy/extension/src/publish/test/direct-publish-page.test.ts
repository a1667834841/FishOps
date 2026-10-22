/**
 * 直接接口发布页面脚本（MAIN world）关键校验的 vm 级单测。
 *
 * 在隔离的 vm 上下文里运行真实 `injectDirectPublishInPage`（stub 掉官方 SDK / 上传），验证：
 * - 类目卡校验：`supportWebPublish:false` 与 `isBook:true` 阻断；`supportWebPublish` 缺省默认支持；
 * - 提交前 service cards 复查：已开启但复查后不可用 → `SERVICE_UNAVAILABLE`（不 publish）；
 *   **不自动追加**复查新出现但用户未确认的服务；保留用户确认的开关（不静默改变）。
 *
 * **不打真实网络、不创建真实 tab、不实际发布。**
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { injectDirectPublishInPage } from '../../background/direct-publish-page'

interface MtopCall {
  api: string
  data: Record<string, unknown>
}

interface PageRunResult {
  // 页面脚本返回的可序列化对象（结构由页面契约决定）
  result: {
    status?: string
    code?: string
    [key: string]: unknown
  }
  calls: MtopCall[]
}

class FakeXhr {
  status = 200
  responseText = ''
  timeout = 0
  withCredentials = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  open(): void {}
  setRequestHeader(): void {}
  send(): void {
    this.responseText = JSON.stringify({
      success: true,
      object: { url: 'https://upload.example.com/1.jpg', width: 100, height: 100 },
    })
    if (this.onload) this.onload()
  }
}

class FakeFormData {
  append(): void {}
}

const SELLER_ADDRESS = {
  prov: '浙江省',
  city: '杭州市',
  area: '西湖区',
  divisionId: '330106',
  poiName: '测试发货点',
  poiId: 'poi-1',
  gps: '30.10,120.20',
}

const CATEGORY_CARD = (extra: Record<string, unknown>) => ({
  cardType: '20401',
  cardData: {
    propertyId: '-10000',
    propertyName: '分类',
    isBook: false,
    valuesList: [
      {
        valueId: 'c1',
        catId: 'c1',
        channelCatId: 'c1',
        catName: '手机',
        isClicked: '1',
        transportData: { channelCateId: 'c1' },
      },
    ],
    ...extra,
  },
})

async function runPage(request: unknown, mtop: (call: MtopCall) => unknown): Promise<PageRunResult> {
  const calls: MtopCall[] = []
  const mtopRequest = async (options: { api: string; data?: Record<string, unknown> }) => {
    const call: MtopCall = { api: options.api, data: (options.data ?? {}) as Record<string, unknown> }
    calls.push(call)
    return mtop(call)
  }
  const windowObj: Record<string, unknown> = {
    location: { hostname: 'www.goofish.com' },
    document: { cookie: 'unb=user-1' },
    g_config: { syncUser: { userId: 'user-1' } },
    lib: { mtop: { request: mtopRequest } },
    crypto,
    URL,
    TextEncoder,
    setTimeout,
    clearTimeout,
    AbortController,
    Blob,
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    fetch: async () => ({ ok: true, status: 200, blob: async () => ({ size: 10, type: 'image/jpeg' }) }),
    XMLHttpRequest: FakeXhr,
    FormData: FakeFormData,
  }
  const context = vm.createContext({ window: windowObj, console: { info() {}, warn() {} }, ...windowObj })
  const result = (await vm.runInContext(
    `(${injectDirectPublishInPage.toString()})(${JSON.stringify(request)})`,
    context,
  )) as PageRunResult['result']
  return { result, calls }
}

function prepareDispatcher(cardList: unknown[], services: unknown[] = []) {
  return (call: MtopCall): unknown => {
    switch (call.api) {
      case 'mtop.idle.pc.idleitem.prepublish.check':
        return { ret: ['SUCCESS::ok'], data: {} }
      case 'mtop.idle.pc.idleitem.preget':
        return { ret: ['SUCCESS::ok'], data: {} }
      case 'mtop.taobao.idleitem.badwords.prepubcheck':
        return { ret: ['SUCCESS::ok'], data: { forbidPublish: false } }
      case 'mtop.taobao.idle.kgraph.property.recommend':
        return { ret: ['SUCCESS::ok'], data: { cardList } }
      case 'mtop.idle.item.publish.service.cards.list':
        return { ret: ['SUCCESS::ok'], data: { services } }
      default:
        return { ret: ['FAIL_SYS_UNKNOWN::未 mock 的接口 ' + call.api] }
    }
  }
}

function makePrepareRequest() {
  return {
    op: 'prepare',
    sourceProduct: {
      description: '手写商品描述',
      price: '10',
      images: ['https://img.example.com/a.jpg'],
      specifications: [],
    },
    sellerAddress: { ...SELLER_ADDRESS },
    confirmedNoQrCodes: true,
  }
}

// ==================== 图片上传 ====================

test('页面 uploadImage：接受 data URL 并走真实上传逻辑', async () => {
  const { result } = await runPage({ op: 'uploadImage', dataUrl: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }, () => ({ ret: ['SUCCESS::ok'] }))
  assert.equal(result.status, 'uploaded', JSON.stringify(result))
  assert.equal((result.image as { url: string }).url, 'https://upload.example.com/1.jpg')
})

test('页面 uploadImage：拒绝 blob URL', async () => {
  const { result } = await runPage({ op: 'uploadImage', dataUrl: 'blob:https://example.com/nope' }, () => ({ ret: ['SUCCESS::ok'] }))
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'DATA_URL_REQUIRED')
})

// ==================== 类目卡校验 ====================

test('页面 prepare：类目卡 supportWebPublish=false → UNSUPPORTED_CATEGORY 阻断', async () => {
  const { result } = await runPage(
    makePrepareRequest(),
    prepareDispatcher([CATEGORY_CARD({ supportWebPublish: false })]),
  )
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'UNSUPPORTED_CATEGORY')
})

test('页面 prepare：图书类目 isBook=true → UNSUPPORTED_CATEGORY 阻断', async () => {
  const { result } = await runPage(
    makePrepareRequest(),
    prepareDispatcher([CATEGORY_CARD({ supportWebPublish: true, isBook: true })]),
  )
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'UNSUPPORTED_CATEGORY')
})

test('页面 prepare：supportWebPublish 缺省默认为支持（不误阻断，最终 prepared）', async () => {
  const { result } = await runPage(makePrepareRequest(), prepareDispatcher([CATEGORY_CARD({})]))
  assert.equal(result.status, 'prepared')
})

test('页面 prepare：请求携带已有 category/attributes 时保留已有值（不被推荐 clicked 覆盖）', async () => {
  const cardList = [
    {
      cardType: '20401',
      cardData: {
        propertyId: '-10000',
        propertyName: '分类',
        isBook: false,
        supportWebPublish: true,
        valuesList: [
          { valueId: 'c1', catId: 'c1', channelCatId: 'c1', catName: '手机', isClicked: '1', transportData: { channelCateId: 'c1' } },
          { valueId: 'c2', catId: 'c2', channelCatId: 'c2', catName: '电脑', isClicked: '0', transportData: { channelCateId: 'c2' } },
        ],
      },
    },
    {
      cardType: '20401',
      cardData: {
        propertyId: 'p2',
        propertyName: '品牌',
        isBook: false,
        supportWebPublish: true,
        valuesList: [
          { valueId: 'v1', valueName: 'UR', isClicked: '1', transportData: { brandId: 'v1' } },
          { valueId: 'v2', valueName: 'ZARA', isClicked: '0', transportData: { brandId: 'v2' } },
        ],
      },
    },
  ]
  const request = {
    ...makePrepareRequest(),
    category: { catId: 'c2', catName: '电脑', channelCatId: 'c2' },
    attributes: [{ propertyId: 'p2', valueId: 'v2', valueName: 'ZARA' }],
  }
  const { result } = await runPage(request, prepareDispatcher(cardList))
  assert.equal(result.status, 'prepared')
  const draft = result.draft as {
    category: { catId: string }
    attributes: Array<{ propertyId: string; valueId?: string; valueName?: string }>
  }
  assert.equal(draft.category.catId, 'c2')
  const brand = draft.attributes.find((item) => item.propertyId === 'p2')
  assert.equal(brand?.valueId, 'v2')
  assert.equal(brand?.valueName, 'ZARA')
})

// ==================== 提交前 service cards 复查 ====================

function submitRequest(services: Array<{ serviceCode: string; enable: boolean }>) {
  return {
    op: 'submit',
    submitCore: {
      title: '标题',
      description: '描述',
      priceYuan: '10',
      specifications: [],
      itemCatDTO: { catId: 'c1', catName: '手机', channelCatId: 'c1', leafId: '0', tbCatId: '' },
      itemLabelExtList: [],
      itemAddrDTO: { ...SELLER_ADDRESS },
      imageInfoDOList: [
        { url: 'https://upload.example.com/1.jpg', widthSize: 100, heightSize: 100, major: true, status: 'done', type: 0, isQrCode: false, extraInfo: {} },
      ],
      services,
    },
    rawCards: [],
  }
}

function submitDispatcher(availableServices: Array<{ code: string }>) {
  return (call: MtopCall): unknown => {
    switch (call.api) {
      case 'mtop.idle.pc.idleitem.prepublish.check':
        return { ret: ['SUCCESS::ok'], data: {} }
      case 'mtop.taobao.idleitem.badwords.prepubcheck':
        return { ret: ['SUCCESS::ok'], data: { forbidPublish: false } }
      case 'mtop.idle.item.publish.service.cards.list':
        return { ret: ['SUCCESS::ok'], data: { services: availableServices } }
      case 'mtop.idle.pc.idleitem.publish':
        return { ret: ['SUCCESS::ok'], data: { itemId: '1087000000009' } }
      default:
        return { ret: ['FAIL_SYS_UNKNOWN::未 mock 的接口 ' + call.api] }
    }
  }
}

test('页面 submit：已开启服务复查后不可用 → SERVICE_UNAVAILABLE，不 publish', async () => {
  const { result, calls } = await runPage(
    submitRequest([{ serviceCode: 'SERVICE_A', enable: true }]),
    submitDispatcher([]),
  )
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'SERVICE_UNAVAILABLE')
  assert.equal(calls.filter((call) => call.api === 'mtop.idle.pc.idleitem.publish').length, 0)
})

test('页面 submit：不自动追加复查新出现但用户未确认的服务（只提交已确认项）', async () => {
  const { result, calls } = await runPage(
    submitRequest([{ serviceCode: 'SERVICE_A', enable: true }]),
    submitDispatcher([{ code: 'SERVICE_A' }, { code: 'SERVICE_B' }]),
  )
  assert.equal(result.status, 'published')
  const publish = calls.find((call) => call.api === 'mtop.idle.pc.idleitem.publish')
  assert.equal(
    JSON.stringify(publish?.data['userRightsProtocols']),
    JSON.stringify([{ serviceCode: 'SERVICE_A', enable: true }]),
  )
})

test('页面 submit：保留用户确认的开关（未开启项不被删除 / 不被改写）', async () => {
  const { result, calls } = await runPage(
    submitRequest([
      { serviceCode: 'SERVICE_A', enable: false },
      { serviceCode: 'SERVICE_B', enable: true },
    ]),
    submitDispatcher([{ code: 'SERVICE_B' }]),
  )
  assert.equal(result.status, 'published')
  const publish = calls.find((call) => call.api === 'mtop.idle.pc.idleitem.publish')
  assert.equal(
    JSON.stringify(publish?.data['userRightsProtocols']),
    JSON.stringify([
      { serviceCode: 'SERVICE_A', enable: false },
      { serviceCode: 'SERVICE_B', enable: true },
    ]),
  )
})

test('页面 submit：无独立标题 + 长描述（>30 字）→ 描述模式 payload（titleDescSeparate=false，title/desc 同为最终描述），违禁词同 fulltext', async () => {
  // 描述 >30 字：旧独立标题模式会触发 30 字限制；本测试确认描述模式不再阻断。
  const longDesc = '这是一段明显超过三十个字符的商品描述文本，用于验证描述模式不会被旧的三十字标题限制阻断'
  assert.ok(longDesc.length > 30)

  const request = {
    op: 'submit',
    // 故意不提供 submitCore.title（描述模式无独立标题，title 可选）。
    submitCore: {
      description: longDesc,
      priceYuan: '10',
      specifications: [{ name: '尺码', value: 'M' }],
      itemCatDTO: { catId: 'c1', catName: '手机', channelCatId: 'c1', leafId: '0', tbCatId: '' },
      itemLabelExtList: [],
      itemAddrDTO: { ...SELLER_ADDRESS },
      imageInfoDOList: [
        { url: 'https://upload.example.com/1.jpg', widthSize: 100, heightSize: 100, major: true, status: 'done', type: 0, isQrCode: false, extraInfo: {} },
      ],
      services: [{ serviceCode: 'SERVICE_A', enable: false }],
    },
    rawCards: [],
  }
  const { result, calls } = await runPage(request, submitDispatcher([{ code: 'SERVICE_A' }]))
  assert.equal(result.status, 'published', JSON.stringify(result))

  const finalDesc = longDesc + '\n尺码：M'

  // 违禁词复检仅使用最终描述（无 core.title 附加）。
  const badwords = calls.find((call) => call.api === 'mtop.taobao.idleitem.badwords.prepubcheck')
  assert.equal(badwords?.data['title'], finalDesc)

  // service cards 中间 DTO 与最终 publish payload **一致**：均为描述模式。
  const cards = calls.find((call) => call.api === 'mtop.idle.item.publish.service.cards.list')
  const itemInfoJson = JSON.parse(String(cards?.data['itemInfoJson'])) as { itemTextDTO: Record<string, unknown> }
  assert.equal(
    JSON.stringify(itemInfoJson.itemTextDTO),
    JSON.stringify({ desc: finalDesc, title: finalDesc, titleDescSeparate: false }),
  )

  const publish = calls.find((call) => call.api === 'mtop.idle.pc.idleitem.publish')
  assert.equal(
    JSON.stringify(publish?.data['itemTextDTO']),
    JSON.stringify({ desc: finalDesc, title: finalDesc, titleDescSeparate: false }),
  )
})

// ==================== 两阶段：preget 异常 / 自动地址 / 无 QR / partial draft ====================

function reviewDispatcher(overrides: Record<string, unknown> = {}) {
  return (call: MtopCall): unknown => {
    if (call.api in overrides) return overrides[call.api]
    switch (call.api) {
      case 'mtop.idle.pc.idleitem.prepublish.check':
        return { ret: ['SUCCESS::ok'], data: {} }
      case 'mtop.idle.pc.idleitem.preget':
        return { ret: ['SUCCESS::ok'], data: {} }
      case 'mtop.taobao.idleitem.badwords.prepubcheck':
        return { ret: ['SUCCESS::ok'], data: { forbidPublish: false } }
      case 'mtop.taobao.idle.kgraph.property.recommend':
        return { ret: ['SUCCESS::ok'], data: { cardList: [CATEGORY_CARD({})] } }
      case 'mtop.taobao.idle.local.poi.get':
        return {
          ret: ['SUCCESS::ok'],
          data: {
            selectedPoi: {
              prov: '广东省',
              city: '深圳市',
              area: '南山区',
              divisionId: '440305',
              poi: '默认点',
              poiId: 'poi-default',
              latitude: 22.5,
              longitude: 113.9,
            },
          },
        }
      case 'mtop.idle.item.publish.service.cards.list':
        return { ret: ['SUCCESS::ok'], data: { services: [] } }
      default:
        return { ret: ['FAIL_SYS_UNKNOWN::未 mock 的接口 ' + call.api] }
    }
  }
}

function productRequest(extra: Record<string, unknown> = {}) {
  return {
    op: 'prepare',
    reviewMode: true,
    sourceProduct: {
      description: '手写商品描述',
      price: '10',
      images: ['https://img.example.com/a.jpg'],
      specifications: [],
    },
    ...extra,
  }
}

test('页面 prepare：preget 异常不被吞掉（作为 warning 保留，继续准备）', async () => {
  const { result } = await runPage(
    makePrepareRequest(),
    reviewDispatcher({ 'mtop.idle.pc.idleitem.preget': { ret: ['FAIL_SYS_ILLEGAL_ACCESS::preget 异常'] } }),
  )
  assert.equal(result.status, 'prepared')
  const warnings = result.warnings as string[]
  assert.ok(Array.isArray(warnings) && warnings.some((w) => w.includes('preget 异常')))
})

test('页面 prepare：reviewMode 下不要求 confirmedNoQrCodes，图片仍自动上传', async () => {
  const { result, calls } = await runPage(productRequest({ confirmedNoQrCodes: false }), reviewDispatcher())
  assert.equal(result.status, 'prepared', JSON.stringify(result))
  const recommend = calls.find((call) => call.api === 'mtop.taobao.idle.kgraph.property.recommend')
  const imageInfos = recommend?.data['imageInfos'] as unknown[] | undefined
  assert.ok(Array.isArray(imageInfos) && imageInfos.length === 1)
})

test('页面 prepare：reviewMode 未提供 seller 时自动取账号默认 POI（地址来源非卖家）', async () => {
  const { result, calls } = await runPage(
    productRequest(),
    reviewDispatcher({
      'mtop.taobao.idle.local.poi.get': {
        ret: ['SUCCESS::ok'],
        data: {
          selectedPoi: {
            prov: '广东省',
            city: '深圳市',
            area: '南山区',
            divisionId: '440305',
            poi: '官方默认点',
            poiId: 'official-poi-9',
            latitude: 22.53,
            longitude: 113.93,
          },
        },
      },
    }),
  )
  assert.equal(result.status, 'prepared', JSON.stringify(result))
  const draft = result.draft as { address: Record<string, string> }
  assert.equal(draft.address.poiId, 'official-poi-9')
  assert.equal(draft.address.poiName, '官方默认点')
  assert.equal(draft.address.gps, '22.53,113.93')
  // poi.get 以空参调用（只读取账号默认候选，不依赖前端坐标 / 卖家地址）
  const poiCall = calls.find((call) => call.api === 'mtop.taobao.idle.local.poi.get')
  assert.ok(poiCall)
  assert.equal(JSON.stringify(poiCall?.data), '{}')
})

test('页面 prepare：poi.get 只有 commonAddresses 无 selectedPoi → DEFAULT_ADDRESS_NOT_SELECTED（不偷用常用地址）', async () => {
  const { result } = await runPage(
    productRequest(),
    reviewDispatcher({
      'mtop.taobao.idle.local.poi.get': {
        ret: ['SUCCESS::ok'],
        data: {
          commonAddresses: [
            { prov: '广东省', city: '深圳市', area: '南山区', divisionId: '440305', poi: '常用地址', poiId: 'common-1', latitude: 22.5, longitude: 113.9 },
          ],
        },
      },
    }),
  )
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'DEFAULT_ADDRESS_NOT_SELECTED')
  assert.equal(result.failureStage, 'address')
  const draft = result.draft as { address?: Record<string, string>; images?: unknown[] }
  // partial draft 保留已上传商品图；不偷用 commonAddresses 作为账号已选地址。
  assert.ok(Array.isArray(draft.images) && draft.images.length === 1)
  assert.notEqual(draft.address?.poiId, 'common-1')
})

test('页面 prepare：seller.address 缺字段 → ADDRESS_INCOMPLETE，partial.address 保留已解析字段便于原因', async () => {
  const request = { ...makePrepareRequest(), sellerAddress: { prov: '浙江省', city: '杭州市' } }
  const { result } = await runPage(request, reviewDispatcher())
  assert.equal(result.status, 'rejected')
  assert.equal(result.code, 'ADDRESS_INCOMPLETE')
  const draft = result.draft as { address?: Record<string, string> }
  assert.equal(draft.address?.prov, '浙江省')
  assert.equal(draft.address?.city, '杭州市')
})

test('页面 prepare：后段失败返回 partial draft + failureStage（不返回空白技术表单）', async () => {
  const { result } = await runPage(
    productRequest(),
    reviewDispatcher({ 'mtop.idle.item.publish.service.cards.list': { ret: ['FAIL_SYS_SERVICE_DOWN::服务卡接口异常'] } }),
  )
  assert.notEqual(result.status, 'prepared')
  assert.equal(result.failureStage, 'services')
  const draft = result.draft as { description?: string; images?: unknown[] }
  assert.equal(draft.description, '手写商品描述')
  assert.ok(Array.isArray(draft.images) && draft.images.length === 1)
})
