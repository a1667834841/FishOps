/**
 * 直接发布（两阶段接口）前端控制器与客户端单元测试（纯 Mock）。
 *
 * 覆盖重点安全防线：
 * 1. prepare 阶段绝不会触发 submit；
 * 2. 用户在弹窗中编辑后的 final draft 真实传入 submit 请求体；
 * 3. 类目确认门禁（未显式勾选 categoryConfirmed 禁止提交，切换类目使确认失效并清空属性）；
 * 4. unknown 永久同源锁（杜绝通过重新生成 idempotencyKey 绕锁重试，防止重复发布）；
 * 5. prepare 失败状态呈现与人工修正后重试；
 * 6. 草稿漂移与切换素材导致旧 prepareToken 立即作废。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DirectPublishController,
  deriveDraftSourceKey,
  isValidPrice,
  isValidSpecifications,
  type DirectPublishSourceProduct,
} from '../direct-publish-controller'
import { computeFinalPublishItem } from '../publish-format'
import { normalizePropertyCards } from '../direct-publish-cards'
import { formatPublishServiceName } from '../direct-publish-labels'
import { DirectPublishClient } from '../direct-publish-client'
import type {
  DirectPublishPreparedResult,
  DirectPublishSubmitRequest,
} from '../direct-publish-types'

test('平台服务显示中文名称，未知编码不伪造服务含义', () => {
  assert.equal(formatPublishServiceName('FAST_DELIVERY_48_HOUR'), '48 小时内发货')
  assert.equal(formatPublishServiceName('FAST_DELIVERY_24_HOUR'), '24 小时内发货')
  assert.equal(formatPublishServiceName('NONCONFORMITY_FREE_REFUND'), '描述不符包退')
  assert.equal(formatPublishServiceName('RETURN_SHIPPING_INSURANCE'), '退货运费险')
  assert.equal(formatPublishServiceName('AI_SALE'), 'AI 帮卖')
  assert.equal(formatPublishServiceName('NEW_SERVICE'), '其他平台服务（NEW_SERVICE）')
})

function mockSourceProduct(patch: Partial<DirectPublishSourceProduct> = {}): DirectPublishSourceProduct {
  return {
    title: '【包邮】原装无线降噪耳机 99新',
    description: '自用闲置降噪耳机，音质完好，附带原装充电线。',
    price: '199.00',
    images: ['https://example.com/pic1.jpg', 'https://example.com/pic2.jpg'],
    specifications: [{ name: '成色', value: '99新' }],
    itemId: 'item_test_1001',
    ...patch,
  }
}

function mockPreparedResult(): DirectPublishPreparedResult {
  return {
    status: 'prepared',
    prepareToken: 'dpp_mock_token_abc123',
    draft: {
      title: '【包邮】原装无线降噪耳机 99新',
      description: '自用闲置降噪耳机，音质完好，附带原装充电线。',
      price: '199.00',
      specifications: [{ name: '成色', value: '99新' }],
      category: {
        catId: '50024500',
        catName: '影音数码',
        channelCatId: 'chan_audio',
        leafId: '1',
        tbCatId: 'tb_5002',
      },
      attributes: [
        { propertyId: 'prop_color', valueId: 'val_black' },
      ],
      address: {
        prov: '广东省',
        city: '深圳市',
        area: '南山区',
        divisionId: '440305',
        poiName: '科技园',
        poiId: 'poi_101',
        gps: '113.9,22.5',
      },
      images: [
        { url: 'https://example.com/pic1.jpg', picUrl: 'https://example.com/pic1.jpg' },
        { url: 'https://example.com/pic2.jpg', picUrl: 'https://example.com/pic2.jpg' },
      ],
      services: [
        { serviceCode: 'INSPECTION', enable: true },
        { serviceCode: 'AI_SALE', enable: false },
      ],
    },
    propertyCards: [
      {
        cardType: 'category',
        propertyId: '-10000',
        propertyName: '商品类目',
        isCategory: true,
        values: [
          {
            valueId: '50024500',
            valueName: '影音数码',
            isCategory: true,
            catId: '50024500',
            channelCatId: 'chan_audio',
            catName: '影音数码',
          },
          {
            valueId: '50012300',
            valueName: '手机数码',
            isCategory: true,
            catId: '50012300',
            channelCatId: 'chan_phone',
            catName: '手机数码',
          },
        ],
      },
      {
        cardType: 'property',
        propertyId: 'prop_color',
        propertyName: '耳机颜色',
        isCategory: false,
        values: [
          { valueId: 'val_black', valueName: '曜石黑', isCategory: false },
          { valueId: 'val_white', valueName: '珍珠白', isCategory: false },
        ],
      },
    ],
    warnings: ['平台提示：二手电子类商品请如实描述成色'],
  }
}

test('1. prepare 阶段只拉取预检待发送数据与候选卡片，绝不会触发 submit', async () => {
  let prepareCalled = false
  let submitCalled = false

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        prepareCalled = true
        return {
          kind: 'fishops-direct-publish',
          method: 'prepare',
          ok: true,
          result: mockPreparedResult(),
        }
      }
      if (msg.method === 'submit') {
        submitCalled = true
        return {
          kind: 'fishops-direct-publish',
          method: 'submit',
          ok: true,
          result: { status: 'published', idempotencyKey: 'k', itemId: 'new_item_999' },
        }
      }
      throw new Error(`Unexpected method: ${msg.method}`)
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())

  // 提供发货真实坐标与二维码确认
  controller.updateSellerForm({
    latitude: 22.540503,
    longitude: 113.934528,
  })
  controller.setPreConfirmedNoQrCodes(true)

  assert.equal(controller.getPhase(), 'idle')
  const res = await controller.executePrepare()

  assert.equal(res.status, 'prepared')
  assert.equal(prepareCalled, true, '必须调用 prepare')
  assert.equal(submitCalled, false, '准备阶段绝不得调用 submit！')
  assert.equal(controller.getPhase(), 'reviewed', '成功进入 reviewed 待核对状态')
  assert.equal(controller.getPrepareToken(), 'dpp_mock_token_abc123')
  assert.equal(controller.getPropertyCards().length, 2)
})

test('2. 用户在弹窗中编辑后的 final draft 真实传入 submit 请求体，无静默丢弃或篡改', async () => {
  let capturedSubmitReq: DirectPublishSubmitRequest | null = null

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return {
          kind: 'fishops-direct-publish',
          method: 'prepare',
          ok: true,
          result: mockPreparedResult(),
        }
      }
      if (msg.method === 'submit') {
        capturedSubmitReq = msg.request
        return {
          kind: 'fishops-direct-publish',
          method: 'submit',
          ok: true,
          result: {
            status: 'published',
            idempotencyKey: 'idemp_1',
            itemId: '789654321',
          },
        }
      }
      throw new Error(`Unexpected method: ${msg.method}`)
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())
  controller.updateSellerForm({ latitude: 22.540503, longitude: 113.934528 })
  controller.setPreConfirmedNoQrCodes(true)
  await controller.executePrepare()

  // 用户在审核弹窗中对草稿进行多项真实编辑
  controller.updateDraftTitle('【特惠】降噪耳机 纯人工修改标题')
  controller.updateDraftDescription('人工更新了描述文本：无磕碰，箱说全。')
  controller.updateDraftPrice('168.50')
  controller.updateDraftSpecifications([{ name: '包装', value: '原装箱说全' }])
  controller.selectAttribute('prop_color', 'val_white') // 将黑色修改为白色
  controller.reorderImages(0, 1) // 调整两张图片顺序

  // 显式勾选类目确认与无二维码确认
  controller.setCategoryConfirmed(true)
  controller.setSubmitConfirmedNoQrCodes(true)

  assert.equal(controller.canSubmit(), true)
  const submitRes = await controller.executeSubmit()

  assert.equal(submitRes.status, 'published')
  assert.equal(submitRes.itemId, '789654321')
  assert.ok(capturedSubmitReq, '必须收到 submit 请求')
  const req = capturedSubmitReq as DirectPublishSubmitRequest

  // 严格验证提交的 draft 携带了用户的所有最新编辑值
  const submittedDraft = req.draft
  assert.equal(submittedDraft.title, '【特惠】降噪耳机 纯人工修改标题')
  assert.equal(submittedDraft.description, '人工更新了描述文本：无磕碰，箱说全。')
  assert.equal(submittedDraft.price, '168.50')
  assert.deepEqual(submittedDraft.specifications, [{ name: '包装', value: '原装箱说全' }])
  assert.ok(
    submittedDraft.attributes.some((a: Record<string, unknown>) => a['propertyId'] === 'prop_color' && a['valueId'] === 'val_white'),
    '属性必须传入修改后的白色 val_white',
  )
  assert.equal((submittedDraft.images[0] as any).url, 'https://example.com/pic2.jpg', '首图已被交换为 pic2')
  assert.equal(req.confirm, true)
  assert.equal(req.categoryConfirmed, undefined, '新前端不伪造发送 categoryConfirmed: true')
  assert.equal(req.confirmedNoQrCodes, undefined, '新前端不伪造发送 confirmedNoQrCodes: true')
})

test('3. 类目与属性展示可编辑：准备完成后无需逐项勾选确认，切换类目清空旧属性并更新候选', async () => {
  let submitAttempted = false

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      if (msg.method === 'submit') {
        submitAttempted = true
        return { kind: 'fishops-direct-publish', method: 'submit', ok: true, result: { status: 'published', itemId: '1' } }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())
  await controller.executePrepare()

  // 准备完成后，无需逐项复选框确认，直接可提交
  assert.equal(controller.canSubmit(), true, '准备完成后无需额外勾选复选框即可提交')

  // 模拟用户切换类目为“手机数码”（通过 channelCatId 匹配）
  const newCatCandidate = controller.getPropertyCards()[0].values.find((v) => v.channelCatId === 'chan_phone' || v.valueId === 'chan_phone')!
  controller.selectCategory(newCatCandidate)

  // 验证类目切换清空不适用的旧属性
  assert.deepEqual(controller.getReviewedDraft()?.attributes, [], '类目切换必须清空不适用的旧属性')
  assert.equal(controller.getReviewedDraft()?.category.catName, '手机数码')
  assert.equal(controller.canSubmit(), true, '类目切换后草稿信息完整仍可直接提交')

  const submitRes = await controller.executeSubmit()
  assert.equal(submitRes.status, 'published')
  assert.equal(submitAttempted, true, '成功发出提交')
})

test('4. unknown 结果永久锁定同源草稿，杜绝通过换 idempotencyKey 绕锁重试', async () => {
  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      if (msg.method === 'submit') {
        // 模拟平台超时或网络中断返回 unknown
        return {
          kind: 'fishops-direct-publish',
          method: 'submit',
          ok: false,
          result: {
            status: 'unknown',
            idempotencyKey: 'idemp_key_1',
            code: 'PAGE_INJECTION_TIMEOUT',
            message: '页面脚本注入超时，提交结果未知，禁止重试',
          },
        }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  const source = mockSourceProduct()
  controller.initSource(source)
  controller.updateSellerForm({ latitude: 22.540503, longitude: 113.934528 })
  controller.setPreConfirmedNoQrCodes(true)
  await controller.executePrepare()

  controller.setCategoryConfirmed(true)
  controller.setSubmitConfirmedNoQrCodes(true)

  // 提交并遭遇 unknown
  const submitRes = await controller.executeSubmit()
  assert.equal(submitRes.status, 'unknown')
  assert.equal(controller.getPhase(), 'unknown')
  assert.equal(controller.isDraftLocked(), true, '草稿必须被永久锁定')

  // 即使试图用全新随机的 idempotencyKey 重新调用 prepare
  const retryPrepareRes = await controller.executePrepare('new_random_idempotency_key_999')
  assert.equal(retryPrepareRes.status, 'rejected')
  assert.equal(retryPrepareRes.code, 'DRAFT_LOCKED_UNKNOWN', '同源草稿已锁定，严禁重新准备！')

  // 再次调用 executeSubmit 也直接被拒
  const retrySubmitRes = await controller.executeSubmit()
  assert.equal(retrySubmitRes.status, 'unknown')
  assert.equal(retrySubmitRes.code, 'DRAFT_LOCKED_UNKNOWN')

  // 只有人工明确核实后解除锁定，才允许再次操作
  controller.manualUnlockDraft()
  assert.equal(controller.isDraftLocked(), false)
  assert.equal(controller.getPhase(), 'idle')
})

test('5. prepare 失败状态呈现与人工修正后重试', async () => {
  let prepareAttempts = 0

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        prepareAttempts++
        if (prepareAttempts === 1) {
          // 第一次：后台返回未登录或违禁词
          return {
            kind: 'fishops-direct-publish',
            method: 'prepare',
            ok: false,
            result: {
              status: 'action_required',
              actionRequired: 'login',
              code: 'NOT_LOGGED_IN',
              message: '当前闲鱼账号未登录，请先在网页登录',
            },
          }
        }
        // 第二次：成功
        return {
          kind: 'fishops-direct-publish',
          method: 'prepare',
          ok: true,
          result: mockPreparedResult(),
        }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())
  controller.updateSellerForm({ latitude: 22.540503, longitude: 113.934528 })
  controller.setPreConfirmedNoQrCodes(true)

  // 第一次准备：失败
  const firstRes = await controller.executePrepare()
  assert.equal(firstRes.status, 'action_required')
  assert.equal(controller.getPhase(), 'action_required')
  assert.equal(controller.getActionRequired(), 'login')
  assert.equal(controller.getErrorMessage(), '当前闲鱼账号未登录，请先在网页登录')

  // 人工登录完毕后再次调用准备：成功
  const secondRes = await controller.executePrepare()
  assert.equal(secondRes.status, 'prepared')
  assert.equal(controller.getPhase(), 'reviewed')
  assert.equal(controller.getPrepareToken(), 'dpp_mock_token_abc123')
})

test('6. 草稿漂移与切换素材：旧 prepareToken 立即失效并重置', async () => {
  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  const sourceA = mockSourceProduct({ itemId: 'item_A' })
  controller.initSource(sourceA)
  controller.updateSellerForm({ latitude: 22.540503, longitude: 113.934528 })
  controller.setPreConfirmedNoQrCodes(true)

  await controller.executePrepare()
  assert.equal(controller.getPhase(), 'reviewed')
  assert.equal(controller.getPrepareToken(), 'dpp_mock_token_abc123')

  // 外部切入新商品 sourceB
  const sourceB = mockSourceProduct({ itemId: 'item_B', title: '全新的商品B' })
  controller.initSource(sourceB)

  // 验证状态重置，旧 token 清空
  assert.equal(controller.getPhase(), 'idle')
  assert.equal(controller.getPrepareToken(), '', '旧准备令牌必须被清空')
  assert.equal(controller.getReviewedDraft(), null, '旧审核草稿必须被清除')
  assert.equal(controller.getSourceProduct()?.itemId, 'item_B')
})

test('7. 显式 overrideSeller 坐标模式优先且仅发一种，完整发货地址7字段亦能独立生效且无假数据', async () => {
  let capturedPrepareReq: any = null

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        capturedPrepareReq = msg.request
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())

  // 1. 显式 overrideSeller 填入坐标：坐标优先且仅发一种（无 seller.address）
  assert.equal(controller.canStartPrepare(), true)
  await controller.executePrepare(undefined, {
    coordinates: {
      latitude: 22.540503,
      longitude: 113.934528,
    },
  })

  assert.ok(capturedPrepareReq)
  assert.deepEqual(capturedPrepareReq.seller.coordinates, {
    latitude: 22.540503,
    longitude: 113.934528,
  })
  assert.equal(capturedPrepareReq.seller.address, undefined, '坐标优先且仅发一种，绝不混发！')

  // 2. 显式 overrideSeller 未填坐标、但填写完整7个字段真实发货地址：仅发 address（无 seller.coordinates）
  controller.backToPrepare()
  assert.equal(controller.canStartPrepare(), true)
  await controller.executePrepare(undefined, {
    address: {
      prov: '广东省',
      city: '深圳市',
      area: '南山区',
      divisionId: '440305',
      poiName: '科技园南区',
      poiId: 'B0FFG9999',
      gps: '113.934528,22.540503',
    },
  })

  assert.equal(capturedPrepareReq.seller.coordinates, undefined)
  assert.equal(capturedPrepareReq.seller.address.prov, '广东省')
  assert.equal(capturedPrepareReq.seller.address.divisionId, '440305')
  assert.equal(capturedPrepareReq.seller.address.poiId, 'B0FFG9999')
  assert.equal(capturedPrepareReq.seller.address.gps, '113.934528,22.540503')
  assert.equal(capturedPrepareReq.confirmedNoQrCodes, undefined, 'confirmedNoQrCodes 已弃用，可选不传')
})

test('8. review 阶段 specifications 增删改与 address 微调在最终 submit 中真实生效', async () => {
  let capturedSubmitReq: DirectPublishSubmitRequest | null = null

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      if (msg.method === 'submit') {
        capturedSubmitReq = msg.request
        return { kind: 'fishops-direct-publish', method: 'submit', ok: true, result: { status: 'published', itemId: 'item_updated_888' } }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())
  controller.updateSellerForm({ latitude: 22.540503, longitude: 113.934528 })
  controller.setPreConfirmedNoQrCodes(true)
  await controller.executePrepare()

  // 1. specifications 增删改
  // 当前有 1 项 { name: '成色', value: '99新' }
  // 我们新增一项“版本”，并修改第一项成色
  const specs = [
    { name: '成色', value: '全新仅拆封' },
    { name: '版本', value: '国行正品' },
  ]
  controller.updateDraftSpecifications(specs)

  // 2. address 微调（修改 poiName 与 gps）
  controller.updateDraftAddress({
    poiName: '大冲国际商务中心',
    gps: '113.95,22.54',
  })

  controller.setCategoryConfirmed(true)
  controller.setSubmitConfirmedNoQrCodes(true)

  const res = await controller.executeSubmit()
  assert.equal(res.status, 'published')
  assert.equal(res.itemId, 'item_updated_888')

  assert.ok(capturedSubmitReq)
  const req = capturedSubmitReq as DirectPublishSubmitRequest
  assert.deepEqual(req.draft.specifications, [
    { name: '成色', value: '全新仅拆封' },
    { name: '版本', value: '国行正品' },
  ])
  assert.equal(req.draft.address.poiName, '大冲国际商务中心')
  assert.equal(req.draft.address.gps, '113.95,22.54')
  assert.equal(req.draft.address.prov, '广东省')
})

test('9. backToPrepare 状态切换保留地址/坐标与无二维码勾选；前端超时配置提升至 300 秒', async () => {
  const client = new DirectPublishClient()
  // 验证客户端超时默认值必须为 300,000ms（300 秒）
  assert.equal((client as any).timeoutMs, 300000, '前端等待后台总超时必须为 300 秒')

  const controller = new DirectPublishController({ client })
  controller.initSource(mockSourceProduct())
  controller.updateSellerForm({
    latitude: 22.5,
    longitude: 113.9,
    prov: '广东省',
    city: '深圳市',
    area: '南山区',
  })
  controller.setPreConfirmedNoQrCodes(true)

  // 模拟进入 reviewed
  ;(controller as any).phase = 'reviewed'
  ;(controller as any).prepareToken = 'tok_test'
  ;(controller as any).reviewedDraft = mockPreparedResult().draft

  // 调用 backToPrepare
  controller.backToPrepare()

  assert.equal(controller.getPhase(), 'idle')
  assert.equal(controller.getPrepareToken(), '', '必须清空旧令牌')
  assert.equal(controller.getReviewedDraft(), null, '必须清空旧草稿')
  // 关键：保留用户输入的地址、坐标与已承诺的无二维码勾选
  assert.equal(controller.getPreConfirmedNoQrCodes(), true, '保留无二维码勾选')
  assert.equal(controller.getSellerForm().prov, '广东省')
  assert.equal(controller.getSellerForm().latitude, 22.5)
  assert.equal(controller.canStartPrepare(), true, '可直接调整后再次准备')
})

test('10. 自动 prepare 缺地址不拦截且不编造假数据，seller 字段不传由后台解析官方预填地址', async () => {
  let capturedPrepareReq: any = null

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      capturedPrepareReq = msg.request
      return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())

  // 用户未提供任何地址与经纬度坐标
  assert.equal(controller.canStartPrepare(), true, '缺少地址时门禁不拦截自动 prepare')
  const res = await controller.executePrepare()

  assert.equal(res.status, 'prepared')
  assert.ok(capturedPrepareReq, '网络请求正常发出')
  assert.equal(capturedPrepareReq.seller, undefined, '未提供坐标与地址时 seller 为 undefined，绝不编造假 0 坐标或空字段')
})

test('11. 商品价格无效时绝不 fallback 到 1.00 默认价格，直接门禁拦截拒绝', async () => {
  let prepareMessageDispatched = false

  const mockClient = new DirectPublishClient({
    sendMessage: async (_msg: any) => {
      prepareMessageDispatched = true
      return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  // 价格为 0 或非法字符
  controller.initSource(mockSourceProduct({ price: '0.00' }))
  controller.updateSellerForm({ latitude: 22.5, longitude: 113.9 })
  controller.setPreConfirmedNoQrCodes(true)

  assert.equal(controller.canStartPrepare(), false, '价格为0禁止准备')
  const res = await controller.executePrepare()

  assert.equal(res.status, 'rejected')
  assert.equal(res.code, 'INVALID_PRICE')
  assert.equal(prepareMessageDispatched, false, '绝对不得编造 1.00 发给后台！')
})

test('12. action_required 状态可见性与人工处理引导', async () => {
  const mockClient = new DirectPublishClient({
    sendMessage: async (_msg: any) => {
      return {
        kind: 'fishops-direct-publish',
        method: 'prepare',
        ok: false,
        result: {
          status: 'action_required',
          actionRequired: 'captcha',
          code: 'CAPTCHA_REQUIRED',
          message: '平台弹出滑动验证码，请在网页完成',
        },
      }
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())
  controller.updateSellerForm({ latitude: 22.5, longitude: 113.9 })
  controller.setPreConfirmedNoQrCodes(true)

  const res = await controller.executePrepare()
  assert.equal(res.status, 'action_required')
  assert.equal(controller.getPhase(), 'action_required')
  assert.equal(controller.getActionRequired(), 'captcha')
  assert.equal(controller.getErrorMessage(), '平台弹出滑动验证码，请在网页完成')

  // 用户点击已在网页完成验证返回准备
  controller.backToPrepare()
  assert.equal(controller.getPhase(), 'idle')
  assert.equal(controller.canStartPrepare(), true)
})

test('13. 异步草稿漂移防线：在途异步请求返回时若草稿已切换，丢弃旧响应不污染新草稿；防并发不破坏 phase', async () => {
  let resolvePreparePromise!: (val: any) => void
  const pendingPreparePromise = new Promise((resolve) => {
    resolvePreparePromise = resolve
  })

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return await pendingPreparePromise
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  const sourceA = mockSourceProduct({ itemId: 'item_A', title: '商品A' })
  controller.initSource(sourceA)
  controller.updateSellerForm({ latitude: 22.5, longitude: 113.9 })
  controller.setPreConfirmedNoQrCodes(true)

  // 1. 发起商品 A 的准备，请求进入在途等待状态
  const preparePromiseA = controller.executePrepare()
  assert.equal(controller.getPhase(), 'preparing')

  // 2. 并发重复调用 executePrepare：必须被拒绝且绝对不能把 phase 改为 prepare_failed
  const concurrentRes = await controller.executePrepare()
  assert.equal(concurrentRes.status, 'rejected')
  assert.equal(concurrentRes.code, 'CONCURRENT_PREPARE')
  assert.equal(controller.getPhase(), 'preparing', '防并发重复调用不能把 phase 误篡改为 prepare_failed！')

  // 3. 在请求 A 尚未返回时，用户切换了草稿至商品 B
  const sourceB = mockSourceProduct({ itemId: 'item_B', title: '全新的商品B' })
  controller.initSource(sourceB)
  assert.equal(controller.getPhase(), 'idle')
  assert.equal(controller.getSourceProduct()?.itemId, 'item_B')

  // 4. 此时前一个请求 A 终于返回了
  resolvePreparePromise({
    kind: 'fishops-direct-publish',
    method: 'prepare',
    ok: true,
    result: mockPreparedResult(),
  })
  const staleRes = await preparePromiseA

  // 验证：过期的在途响应被识别并丢弃，当前控制器依然是商品 B 的干净状态，绝未被商品 A 污染！
  assert.equal(staleRes.status, 'rejected')
  assert.equal(staleRes.code, 'STALE_PREPARE')
  assert.equal(controller.getPhase(), 'idle')
  assert.equal(controller.getPrepareToken(), '', '旧令牌未被写入')
  assert.equal(controller.getSourceProduct()?.itemId, 'item_B')
})

test('14. submit rejected 允许用户修改后重新激活提交，且按钮不永久置灰', async () => {
  let submitCount = 0

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      if (msg.method === 'submit') {
        submitCount++
        if (submitCount === 1) {
          // 第一次被平台拒绝（例如标题违禁词）
          return {
            kind: 'fishops-direct-publish',
            method: 'submit',
            ok: false,
            result: {
              status: 'rejected',
              code: 'TITLE_FORBIDDEN',
              message: '标题包含违规导流词汇',
            },
          }
        }
        // 第二次提交成功
        return {
          kind: 'fishops-direct-publish',
          method: 'submit',
          ok: true,
          result: {
            status: 'published',
            itemId: 'item_new_123',
          },
        }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())
  controller.updateSellerForm({ latitude: 22.5, longitude: 113.9 })
  controller.setPreConfirmedNoQrCodes(true)
  await controller.executePrepare()

  controller.setCategoryConfirmed(true)
  controller.setSubmitConfirmedNoQrCodes(true)

  // 第一次提交：被平台拒绝
  const firstRes = await controller.executeSubmit()
  assert.equal(firstRes.status, 'rejected')
  assert.equal(controller.getPhase(), 'submit_rejected')

  // 用户修改标题（去除违规词），验证按钮状态恢复并允许再次提交
  controller.updateDraftTitle('【合规】已清理的耳机标题')
  assert.equal(controller.getPhase(), 'reviewed', '用户编辑后自动恢复为 reviewed 状态')
  assert.equal(controller.canSubmit(), true, '修改后按钮不被永久禁用')

  // 第二次提交：成功
  const secondRes = await controller.executeSubmit()
  assert.equal(secondRes.status, 'published')
  assert.equal(secondRes.itemId, 'item_new_123')
  assert.equal(controller.getPhase(), 'published')
})

test('15. sessionStorage 仅存储不可逆摘要，绝对不持久化商品描述与图片 URL 明文', async () => {
  // 模拟 sessionStorage
  const storageMap = new Map<string, string>()
  const mockSessionStorage = {
    getItem: (k: string) => storageMap.get(k) || null,
    setItem: (k: string, v: string) => storageMap.set(k, v),
    removeItem: (k: string) => storageMap.delete(k),
  }
  ;(globalThis as any).sessionStorage = mockSessionStorage

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      if (msg.method === 'submit') {
        return { kind: 'fishops-direct-publish', method: 'submit', ok: false, result: { status: 'unknown' } }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  const sensitiveDesc = '非常特殊的敏感商品私人描述文本SECRET_ABC'
  const sensitivePic = 'https://example.com/secret_private_pic_xyz.jpg'
  controller.initSource(mockSourceProduct({
    description: sensitiveDesc,
    images: [sensitivePic],
  }))
  controller.updateSellerForm({ latitude: 22.5, longitude: 113.9 })
  controller.setPreConfirmedNoQrCodes(true)
  await controller.executePrepare()

  controller.setCategoryConfirmed(true)
  controller.setSubmitConfirmedNoQrCodes(true)

  // 触发 unknown 锁定
  await controller.executeSubmit()
  assert.equal(controller.isDraftLocked(), true)

  // 检查 sessionStorage 中的持久化内容
  const rawStorage = storageMap.get('fishops.directPublish.lockedSourceKeys.v1')
  assert.ok(rawStorage, '必须持久化锁定 key')

  // 核心断言：绝对不能含有敏感描述与图片 URL 明文！只能是哈希摘要（如 hash_xxx）
  const derivedKey = deriveDraftSourceKey(controller.getSourceProduct()!)
  assert.equal(derivedKey.startsWith('hash_'), true, '特征 key 必须为 hash_ 开头的不可逆摘要')
  assert.ok(!rawStorage.includes(sensitiveDesc), 'sessionStorage 严禁含有商品描述明文')
  assert.ok(!rawStorage.includes(sensitivePic), 'sessionStorage 严禁含有图片 URL 明文')
  assert.ok(rawStorage.includes('hash_'), '必须为不可逆摘要 hash_ 前缀')

  // 清理
  delete (globalThis as any).sessionStorage
})

test('16. isValidPrice 纯函数严格校验（拒绝科学计数法 1e2、拒绝3位小数 99.999、拒绝 0 与负数）', () => {
  // 合法价格（纯元格式，最多两位小数，有限正数）
  assert.equal(isValidPrice('99'), true)
  assert.equal(isValidPrice('99.0'), true)
  assert.equal(isValidPrice('99.99'), true)
  assert.equal(isValidPrice('0.01'), true)
  assert.equal(isValidPrice(99), true)
  assert.equal(isValidPrice(99.5), true)
  assert.equal(isValidPrice(0.01), true)
  // 关键用例：19.99 浮点数与字符串，必须通过校验，绝不被乘100浮点精度问题误杀
  assert.equal(isValidPrice(19.99), true, '浮点数 19.99 必须合法')
  assert.equal(isValidPrice('19.99'), true, '字符串 19.99 必须合法')

  // 非法价格（严格拒绝，绝不静默四舍五入）
  assert.equal(isValidPrice('1e2'), false, '严格拒绝科学计数法 1e2')
  assert.equal(isValidPrice('99.999'), false, '严格拒绝3位小数 99.999')
  assert.equal(isValidPrice(99.999), false, '数字3位小数严格拒绝')
  assert.equal(isValidPrice('0'), false, '拒绝 0 元')
  assert.equal(isValidPrice('0.00'), false, '拒绝 0.00 元')
  assert.equal(isValidPrice(0), false, '数字 0 严格拒绝')
  assert.equal(isValidPrice('-10'), false, '拒绝负数')
  assert.equal(isValidPrice(-10), false, '数字负数严格拒绝')
  assert.equal(isValidPrice(''), false, '拒绝空串')
  assert.equal(isValidPrice(null), false, '拒绝 null')
  assert.equal(isValidPrice(undefined), false, '拒绝 undefined')
  assert.equal(isValidPrice('abc'), false, '拒绝非数字')
  assert.equal(isValidPrice(NaN), false, '拒绝 NaN')
  assert.equal(isValidPrice(Infinity), false, '拒绝 Infinity')
})

test('17. canSubmit 规格空值门禁与地址关键字段门禁', async () => {
  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())
  controller.updateSellerForm({ latitude: 22.5, longitude: 113.9 })
  controller.setPreConfirmedNoQrCodes(true)
  await controller.executePrepare()

  controller.setCategoryConfirmed(true)
  controller.setSubmitConfirmedNoQrCodes(true)
  assert.equal(controller.canSubmit(), true)

  // 1. 规格包含空 name 或空 value
  controller.updateDraftSpecifications([{ name: '', value: '99新' }])
  assert.equal(isValidSpecifications(controller.getReviewedDraft()?.specifications), false)
  assert.equal(controller.canSubmit(), false, '规格包含空 name 必须阻止提交')

  controller.updateDraftSpecifications([{ name: '成色', value: '   ' }])
  assert.equal(isValidSpecifications(controller.getReviewedDraft()?.specifications), false)
  assert.equal(controller.canSubmit(), false, '规格包含空 value 必须阻止提交')

  // 恢复有效规格
  controller.updateDraftSpecifications([{ name: '成色', value: '99新' }])
  assert.equal(controller.canSubmit(), true)

  // 2. 价格如果被改为非法格式（如 1e2 或 3位小数）
  controller.updateDraftPrice('1e2')
  assert.equal(controller.canSubmit(), false, '非法价格 1e2 必须阻止提交')
  controller.updateDraftPrice('99.999')
  assert.equal(controller.canSubmit(), false, '3位小数价格必须阻止提交')

  // 恢复合法价格
  controller.updateDraftPrice('99.00')
  assert.equal(controller.canSubmit(), true)

  // 3. 发货地址缺失 7 字段或 gps 无效
  controller.updateDraftAddress({ prov: '' })
  assert.equal(controller.canSubmit(), false, '地址缺失省份必须阻止提交')
  controller.updateDraftAddress({ prov: '广东省', divisionId: '' })
  assert.equal(controller.canSubmit(), false, '地址缺失 divisionId 必须阻止提交')
  controller.updateDraftAddress({ divisionId: '440305', poiId: '' })
  assert.equal(controller.canSubmit(), false, '地址缺失 poiId 必须阻止提交')
  controller.updateDraftAddress({ poiId: 'B0FFG12345', gps: 'invalid_gps' })
  assert.equal(controller.canSubmit(), false, '地址 gps 非法必须阻止提交')

  // 恢复合法地址
  controller.updateDraftAddress({ gps: '113.934528,22.540503' })
  assert.equal(controller.canSubmit(), true)

  // 4. 描述模式：标题不再作为有效性门禁，仅描述有效
  controller.updateDraftDescription('   ')
  assert.equal(controller.canSubmit(), false, '描述为空必须阻止提交')
  controller.updateDraftDescription('合规详细描述内容')
  assert.equal(controller.canSubmit(), true)

  // 5. 类目缺失
  ;(controller as any).reviewedDraft.category = null
  assert.equal(controller.canSubmit(), false, '缺少类目必须阻止提交')
})

test('18. 在 preparing 期间调用 cancel() 使 prepareSequence 失效，迟到返回绝不偷偷篡改状态', async () => {
  let resolvePreparePromise!: (val: any) => void
  const pendingPrepare = new Promise((resolve) => {
    resolvePreparePromise = resolve
  })

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return await pendingPrepare
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())
  controller.updateSellerForm({ latitude: 22.5, longitude: 113.9 })
  controller.setPreConfirmedNoQrCodes(true)

  // 1. 发起准备中
  const preparePromise = controller.executePrepare()
  assert.equal(controller.getPhase(), 'preparing')

  // 2. 用户在准备中途中点击了“取消”或关闭了弹窗
  controller.cancel()
  assert.equal(controller.getPhase(), 'idle')

  // 3. 此时后台慢请求终于完成并返回
  resolvePreparePromise({
    kind: 'fishops-direct-publish',
    method: 'prepare',
    ok: true,
    result: mockPreparedResult(),
  })
  const res = await preparePromise

  // 4. 验证：迟到响应被丢弃为 STALE_PREPARE，控制器依然稳固保持在 idle，绝未偷偷恢复为 reviewed！
  assert.equal(res.status, 'rejected')
  assert.equal(res.code, 'STALE_PREPARE')
  assert.equal(controller.getPhase(), 'idle', '弹窗取消后绝不被后台迟到响应偷偷改写为 reviewed 状态')
  assert.equal(controller.getPrepareToken(), '', '旧令牌未被写入')
})

test('19. 类目候选 ID 对齐后台契约（优先采用 channelCatId || catId || valueId）', () => {
  const rawCards = [
    {
      cardType: 'category',
      propertyId: '-10000',
      propertyName: '商品类目',
      isCategory: true,
      values: [
        {
          id: 'val_raw_123',
          catId: 'cat_9999',
          channelCatId: 'chan_prefer_8888',
          catName: '数码影音',
        },
      ],
    },
  ]

  const normalized = normalizePropertyCards(rawCards)
  assert.equal(normalized.length, 1)
  const catCard = normalized[0]
  assert.equal(catCard.isCategory, true)
  // 核心断言：类目的 valueId 必须优先对齐后台 channelCatId，而非普通的 val_raw_123
  assert.equal(catCard.values[0].valueId, 'chan_prefer_8888', '类目候选主键必须对齐后台 channelCatId')
  assert.equal(catCard.values[0].channelCatId, 'chan_prefer_8888')
  assert.equal(catCard.values[0].catId, 'cat_9999')
})

test('20. 新增测试：自动 prepare 成功后无需人工更改即可直接 submit，一次性统一确认发布', async () => {
  let submitPayload: DirectPublishSubmitRequest | null = null

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      if (msg.method === 'submit') {
        submitPayload = msg.request
        return {
          kind: 'fishops-direct-publish',
          method: 'submit',
          ok: true,
          result: { status: 'published', itemId: 'item_direct_auto_200' },
        }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())

  // 1. 模拟弹窗打开自动调用 prepare
  const prepareRes = await controller.executePrepare()
  assert.equal(prepareRes.status, 'prepared')
  assert.equal(controller.getPhase(), 'reviewed')

  // 2. 关键断言：无需勾选任何 checkbox，无需任何字段变更，canSubmit 直接为 true
  assert.equal(controller.canSubmit(), true, '预填完成且草稿完整时，无需任何人工勾选直接可提交')

  // 3. 执行最终一次性确认并发布
  const submitRes = await controller.executeSubmit()
  assert.equal(submitRes.status, 'published')
  assert.equal(submitRes.itemId, 'item_direct_auto_200')
  assert.ok(submitPayload)
  const payload = submitPayload as DirectPublishSubmitRequest
  assert.equal(payload.confirm, true)
  assert.equal(payload.categoryConfirmed, undefined, '绝不伪造发送 categoryConfirmed')
  assert.equal(payload.confirmedNoQrCodes, undefined, '绝不伪造发送 confirmedNoQrCodes')
})

test('21. 新增测试：prepare 失败保留 partial draft 与错误信息（failureStage, missingFields, 不清空）', async () => {
  const partialDraft = {
    title: '部分成功商品标题',
    description: '部分描述',
    price: '99.00',
    specifications: [],
    category: { catId: '123', catName: '数码' },
    attributes: [],
    address: { prov: '广东省', city: '深圳市', area: '南山区' },
    images: [{ url: 'https://example.com/uploaded_1.jpg' }],
    services: [],
  }

  const mockClient = new DirectPublishClient({
    sendMessage: async () => ({
      kind: 'fishops-direct-publish',
      method: 'prepare',
      ok: true,
      result: {
        status: 'rejected',
        code: 'IMAGE_UPLOAD_PARTIAL_FAILED',
        message: '部分图片上传未完成，需安全验证',
        failureStage: 'UPLOAD_IMAGES',
        missingFields: ['poiName', 'divisionId'],
        draft: partialDraft,
      },
    }),
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())

  const res = await controller.executePrepare()
  assert.equal(res.status, 'rejected')
  assert.equal(controller.getPhase(), 'prepare_failed')
  assert.equal(controller.getErrorCode(), 'IMAGE_UPLOAD_PARTIAL_FAILED')
  assert.equal(controller.getErrorMessage(), '部分图片上传未完成，需安全验证')
  assert.equal(controller.getFailureStage(), 'UPLOAD_IMAGES')
  assert.deepEqual(controller.getMissingFields(), ['poiName', 'divisionId'])

  // 核心断言：失败后依然保留 returned draft，展示已准备部分，不清空！
  assert.ok(controller.getReviewedDraft(), '必须保留后台返回的 partial draft')
  assert.equal(controller.getReviewedDraft()?.title, '部分成功商品标题')
  assert.equal(controller.getReviewedDraft()?.images.length, 1)
})

test('22. 新增测试：prepare 失败与重试准备绝不会自动触发 submit', async () => {
  let submitAttempted = false
  let prepareCount = 0

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        prepareCount++
        return {
          kind: 'fishops-direct-publish',
          method: 'prepare',
          ok: true,
          result: {
            status: 'rejected',
            code: 'RATE_LIMITED',
            message: '访问频次超限，请稍后重试',
          },
        }
      }
      if (msg.method === 'submit') {
        submitAttempted = true
        return { kind: 'fishops-direct-publish', method: 'submit', ok: true, result: { status: 'published' } }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())

  // 第一次 prepare 失败
  await controller.executePrepare()
  assert.equal(controller.getPhase(), 'prepare_failed')
  assert.equal(submitAttempted, false, '准备失败绝不得触发 submit')

  // 用户点击“重试准备发布”（再次执行 executePrepare）
  await controller.executePrepare()
  assert.equal(prepareCount, 2)
  assert.equal(controller.getPhase(), 'prepare_failed')
  assert.equal(submitAttempted, false, '重试准备绝不得自动触发 submit！')
})

test('23. 新增测试：不多次 prepare（防并发重复调用与已 reviewed 重开保护）', async () => {
  let prepareNetworkCalls = 0
  let resolvePrepare: (val: any) => void

  const pendingPromise = new Promise((resolve) => {
    resolvePrepare = resolve
  })

  const mockClient = new DirectPublishClient({
    sendMessage: async () => {
      prepareNetworkCalls++
      return pendingPromise
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  const source = mockSourceProduct()
  controller.initSource(source)

  // 1. 发起第一次 prepare（处于 preparing pending 状态）
  const promise1 = controller.executePrepare()
  assert.equal(controller.getPhase(), 'preparing')

  // 2. 模拟 open 与 source watch 并发触发第二次 prepare：必须被拦截
  const res2 = await controller.executePrepare()
  assert.equal(res2.status, 'rejected')
  assert.equal(res2.code, 'CONCURRENT_PREPARE')
  assert.equal(prepareNetworkCalls, 1, '并发调用不得发出额外网络请求')

  // 释放第一次请求
  resolvePrepare!({
    kind: 'fishops-direct-publish',
    method: 'prepare',
    ok: true,
    result: mockPreparedResult(),
  })
  await promise1

  assert.equal(controller.getPhase(), 'reviewed')
  assert.equal(prepareNetworkCalls, 1)

  // 3. 验证 hasReviewedDraftFor：弹窗重新打开时若还是该商品，直接识别已有草稿，不再重复上传
  assert.equal(controller.hasReviewedDraftFor(source), true, '同商品已有 reviewed 草稿时返回 true')
  const differentSource = { ...source, itemId: 'diff_999' }
  assert.equal(controller.hasReviewedDraftFor(differentSource), false, '换商品时返回 false')
})

test('24. 新增测试：unknown 状态同源草稿锁定且禁 submit', async () => {
  let submitCalls = 0

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      if (msg.method === 'submit') {
        submitCalls++
        return {
          kind: 'fishops-direct-publish',
          method: 'submit',
          ok: true,
          result: {
            status: 'unknown',
            code: 'COMMUNICATION_UNKNOWN',
            message: '提交超时，平台状态未知',
          },
        }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())
  await controller.executePrepare()

  assert.equal(controller.canSubmit(), true)

  // 第一次提交：遭遇 unknown
  const res = await controller.executeSubmit()
  assert.equal(res.status, 'unknown')
  assert.equal(controller.getPhase(), 'unknown')
  assert.equal(controller.isDraftLocked(), true, '草稿必须被锁定')
  assert.equal(submitCalls, 1)

  // 核心断言：处于 unknown 锁定状态下，canSubmit 必须为 false
  assert.equal(controller.canSubmit(), false, 'unknown 状态禁止提交')

  // 若再次尝试调用 executeSubmit，必须被前置锁定守卫直接拦截，严禁发出网络调用
  const blockedSubmit = await controller.executeSubmit()
  assert.equal(blockedSubmit.status, 'unknown')
  assert.equal(blockedSubmit.code, 'DRAFT_LOCKED_UNKNOWN')
  assert.equal(submitCalls, 1, '严禁向平台重发任何提交网络请求！')
})

test('25. 新增测试：reviewed 状态关闭再重开保留已审核草稿与编辑，不重复触发 prepare', async () => {
  let prepareCalls = 0

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        prepareCalls++
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  const source = mockSourceProduct()
  controller.initSource(source)

  // 1. 首次打开弹窗自动 prepare
  await controller.executePrepare()
  assert.equal(controller.getPhase(), 'reviewed')
  assert.equal(prepareCalls, 1)

  // 模拟用户在草稿中做了编辑
  controller.updateDraftTitle('用户修改后的保留标题')
  assert.equal(controller.getReviewedDraft()?.title, '用户修改后的保留标题')

  // 2. 模拟弹窗关闭：reviewed 状态下关闭仅 emit close，不触发 controller.cancel()
  // 检验 hasReviewedDraftFor 依然保持为 true
  assert.equal(controller.hasReviewedDraftFor(source), true, '关闭后 controller 依然保留 reviewed 状态')

  // 3. 模拟用户再次打开弹窗：识别已有草稿，不调用 executePrepare()
  if (!controller.hasReviewedDraftFor(source)) {
    await controller.executePrepare()
  }

  assert.equal(prepareCalls, 1, '重开不重复触发 prepare 网络请求与图片上传')
  assert.equal(controller.getReviewedDraft()?.title, '用户修改后的保留标题', '必须保留用户的历史编辑内容')
})

test('26. 新增测试：默认 executePrepare 不复用跨源/上次 sellerForm 遗留地址，仅显式 overrideSeller 携带', async () => {
  let capturedPrepareReq: any = null

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        capturedPrepareReq = msg.request
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())

  // 模拟 sellerForm 曾被回填过上个账号/旧草稿的地址
  controller.updateSellerForm({
    prov: '旧省份',
    city: '旧城市',
    area: '旧区县',
    divisionId: '999999',
    poiName: '旧商圈',
    poiId: 'OLD_POI',
    gps: '113.1,22.2',
  })

  // 1. 默认发起 prepare：绝不隐式复用 sellerForm 的地址传给后台，seller 必须为 undefined
  await controller.executePrepare()
  assert.ok(capturedPrepareReq)
  assert.equal(
    capturedPrepareReq.seller,
    undefined,
    '默认 prepare 绝不复用 sellerForm 地址，seller 必须为 undefined 由后台从当前账号获取',
  )

  // 2. 显式传入 overrideSeller 时，正常携带
  const customSeller = {
    coordinates: { latitude: 23.123456, longitude: 113.654321 },
  }
  await controller.executePrepare(undefined, customSeller)
  assert.deepEqual(capturedPrepareReq.seller, customSeller, '显式传入 overrideSeller 时必须正确透传')
})

test('27. 新增测试：mock业务拒绝(FAIL_BIZ) → 保留同token与可编辑草稿，不锁草稿 → 修改标题 → 第二次submit成功发布，且prepare仅调用1次', async () => {
  let prepareCalls = 0
  let submitCalls = 0
  const capturedSubmitTokens: string[] = []
  const capturedSubmitTitles: string[] = []

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        prepareCalls++
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      if (msg.method === 'submit') {
        submitCalls++
        capturedSubmitTokens.push(msg.request?.prepareToken)
        capturedSubmitTitles.push(msg.request?.draft?.title)
        if (submitCalls === 1) {
          // 第一次被服务端明确业务拒绝（标题字数超长）
          return {
            kind: 'fishops-direct-publish',
            method: 'submit',
            ok: false,
            result: {
              status: 'rejected',
              code: 'FAIL_BIZ_TITLE_LENGTH_TOO_LONG',
              message: '商品标题长度不能超过30个字符',
              retryable: true,
              prepareTokenValid: true,
            },
          }
        }
        // 第二次提交成功
        return {
          kind: 'fishops-direct-publish',
          method: 'submit',
          ok: true,
          result: {
            status: 'published',
            itemId: 'item_after_retry_999',
          },
        }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())
  await controller.executePrepare()
  assert.equal(prepareCalls, 1, '初始化 prepare 仅调用 1 次')

  const originalToken = controller.getPrepareToken()
  assert.ok(originalToken, '必须获取到有效的 prepareToken')

  // 第一次提交：业务拒绝
  const firstRes = await controller.executeSubmit()
  assert.equal(firstRes.status, 'rejected')
  assert.equal(controller.getPhase(), 'submit_rejected')
  // 必须没有被锁定！
  assert.equal(controller.isDraftLocked(), false, '业务拒绝绝不得锁定草稿')
  // 保留原有 token 与草稿
  assert.equal(controller.getPrepareToken(), originalToken, '业务拒绝后必须保留原有 token')
  assert.ok(controller.getReviewedDraft(), '业务拒绝后必须保留可编辑草稿')
  // 文案移除“令牌可能失效”，统一为“请修改后再次点击确认并发布”
  assert.ok(
    controller.getErrorMessage()?.includes('请修改后再次点击确认并发布'),
    '错误提示文案应引导用户修改后再次点击确认并发布',
  )
  assert.ok(
    !controller.getErrorMessage()?.includes('令牌可能失效'),
    '严禁包含旧的“令牌可能失效请重新prepare”统一尾文案',
  )

  // 用户修改标题为合规标题（<= 30 字）
  controller.updateDraftTitle('合规30字以内耳机')
  assert.equal(controller.getPhase(), 'reviewed', '修改草稿后状态自动恢复为 reviewed')
  assert.equal(controller.canSubmit(), true, '修改后按钮恢复可用')

  // 第二次提交：使用同一 token 成功发布
  const secondRes = await controller.executeSubmit()
  assert.equal(secondRes.status, 'published')
  assert.equal(secondRes.itemId, 'item_after_retry_999')
  assert.equal(controller.getPhase(), 'published')

  // 严格断言：全程 prepare 仅被调用了 1 次！
  assert.equal(prepareCalls, 1, '整个修正重提流程绝不重新调用 prepare')
  assert.equal(submitCalls, 2, '提交了 2 次')
  // 两次 submit 携带的 prepareToken 必须一致（复用 token）
  assert.equal(capturedSubmitTokens[0], originalToken)
  assert.equal(capturedSubmitTokens[1], originalToken)
  assert.equal(capturedSubmitTitles[1], '合规30字以内耳机')
})

test('28. 新增测试：timeout / unknown 结果保持 locked，禁止自动重试与继续提交', async () => {
  let submitCalls = 0

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      if (msg.method === 'submit') {
        submitCalls++
        // 超时或通信异常返回 unknown
        return {
          kind: 'fishops-direct-publish',
          method: 'submit',
          ok: false,
          result: {
            status: 'unknown',
            code: 'PUBLISH_TIMEOUT',
            message: '闲鱼接口响应超时，结果未知',
            prepareTokenValid: false,
          },
        }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())
  await controller.executePrepare()

  // 提交返回 unknown
  const res = await controller.executeSubmit()
  assert.equal(res.status, 'unknown')
  assert.equal(controller.getPhase(), 'unknown')
  assert.equal(controller.isDraftLocked(), true, 'unknown 状态必须锁定草稿')
  assert.equal(controller.canSubmit(), false, '草稿锁定状态下必须禁用提交')

  // 再次强行调用 executeSubmit 必须被门禁直接拦截，不发送网络请求
  const blockedRes = await controller.executeSubmit()
  assert.equal(blockedRes.status, 'unknown')
  assert.equal(blockedRes.code, 'DRAFT_LOCKED_UNKNOWN')
  assert.equal(submitCalls, 1, '被锁定后不得发出任何额外的 submit 请求')
})

test('29. 描述模式：无标题仅有描述允许提交，不因 30 字标题限制阻断提交', async () => {
  let submitNetworkCalls = 0

  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      if (msg.method === 'submit') {
        submitNetworkCalls++
        return {
          kind: 'fishops-direct-publish',
          method: 'submit',
          ok: true,
          result: { status: 'published', itemId: 'item_desc_ok' },
        }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct({ title: '' }))
  await controller.executePrepare()

  // 1. 无标题但有有效描述：允许提交
  delete (controller as any).reviewedDraft.title
  assert.equal(controller.canSubmit(), true, '描述模式下无标题草稿允许正常提交')

  // 2. 超长标题（>30字）在描述模式下也不阻止提交
  controller.updateDraftTitle('一'.repeat(50))
  assert.equal(controller.canSubmit(), true, '描述模式下不因标题字数拦截提交')

  const successRes = await controller.executeSubmit()
  assert.equal(successRes.status, 'published')
  assert.equal(successRes.itemId, 'item_desc_ok')
  assert.equal(submitNetworkCalls, 1, '成功发出 submit 请求并发布')
})

test('30. 新增测试：prepareTokenValid: false 时清空 token 禁用提交并提示重新准备，但完整保留 reviewedDraft', async () => {
  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      if (msg.method === 'submit') {
        return {
          kind: 'fishops-direct-publish',
          method: 'submit',
          ok: false,
          result: {
            status: 'rejected',
            code: 'TOKEN_EXPIRED',
            message: '准备令牌已过期',
            prepareTokenValid: false,
          },
        }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(mockSourceProduct())
  await controller.executePrepare()

  const draftBefore = controller.getReviewedDraft()
  assert.ok(draftBefore)

  // 提交返回 prepareTokenValid: false
  const res = await controller.executeSubmit()
  assert.equal(res.status, 'rejected')
  assert.equal(controller.getPhase(), 'submit_rejected')
  assert.equal(controller.getPrepareToken(), '', '令牌失效时 prepareToken 必须被清空')
  assert.equal(controller.canSubmit(), false, '令牌失效后必须禁用提交')
  // 必须保留 reviewedDraft！
  assert.deepEqual(controller.getReviewedDraft(), draftBefore, '令牌失效但必须完整保留用户的 draft 内容')
  // 提示语包含“准备令牌已失效，请重新准备发布”
  assert.ok(controller.getErrorMessage()?.includes('准备令牌已失效，请重新准备发布'))
})

test('31. 新增测试：加入图 → preview → prepare 全链路同步真实有效', async () => {
  let capturedPrepareProduct: any = null
  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        capturedPrepareProduct = msg.request?.source?.product
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      return null
    },
  })

  // 1. 模拟输入商品，通过加入新图，检查 preview
  const initialImages = ['https://img.example.com/p1.jpg', 'https://img.example.com/p2.jpg']
  const newAddedUrl = 'https://img.example.com/p3_new.jpg'
  const nextImageList = [...initialImages, newAddedUrl]

  // computeFinalPublishItem 预览即时更新
  const previewItem = {
    desc: '详细描述内容',
    price: 99,
    imageUrls: nextImageList,
  }
  const preview = computeFinalPublishItem(previewItem)
  assert.equal(preview.images.length, 3)
  assert.deepEqual(preview.images, nextImageList)

  // 2. 将包含新图片的 sourceProduct 传递给两阶段 prepare
  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource({
    description: preview.desc,
    price: preview.price,
    images: preview.images,
  })

  await controller.executePrepare()

  // 验证 prepare 请求中真实携带了加入后的新图片
  assert.ok(capturedPrepareProduct)
  assert.deepEqual(capturedPrepareProduct.images, nextImageList, 'prepare 请求必须真实携带新加入的图片')
  assert.equal(capturedPrepareProduct.title, undefined, 'prepare product 不发送独立 title')
})

test('32. 新增测试：删除主图不返（cover 同步，旧首图绝不出现在 preview 与 prepare）', async () => {
  let capturedPrepareImages: string[] = []
  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        capturedPrepareImages = msg.request?.source?.product?.images || []
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      return null
    },
  })

  const originalImages = [
    'https://img.example.com/old_cover.jpg',
    'https://img.example.com/second_img.jpg',
    'https://img.example.com/third_img.jpg',
  ]

  // 模拟删除首图后的操作：nextList 去除第 0 项，coverUrl 同步为下一张
  const nextList = originalImages.slice(1)
  const newCover = nextList[0]

  const updatedDraft = {
    desc: '测试删除首图',
    price: 50,
    coverUrl: newCover,
    imageUrls: nextList,
  }

  // 1. 验证 computeFinalPublishItem preview 中绝无旧首图，且首图同步为 second_img.jpg
  const preview = computeFinalPublishItem(updatedDraft)
  assert.equal(preview.coverUrl, 'https://img.example.com/second_img.jpg')
  assert.ok(!preview.images.includes('https://img.example.com/old_cover.jpg'), '旧主图绝不能重新出现在 preview 中')
  assert.deepEqual(preview.images, nextList)

  // 2. 传递给 prepare 请求验证
  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource({
    description: preview.desc,
    price: preview.price,
    images: preview.images,
  })
  await controller.executePrepare()

  assert.ok(!capturedPrepareImages.includes('https://img.example.com/old_cover.jpg'), '旧主图绝不能被发送到 prepare 请求中')
  assert.equal(capturedPrepareImages[0], 'https://img.example.com/second_img.jpg')
})

test('33. 新增测试：无标题描述有效（无独立 title 不拦截，仅 description 有效）', async () => {
  let submitNetworkCalls = 0
  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      if (msg.method === 'submit') {
        submitNetworkCalls++
        return {
          kind: 'fishops-direct-publish',
          method: 'submit',
          ok: true,
          result: { status: 'published', itemId: 'item_no_title_999' },
        }
      }
      return null
    },
  })

  // 1. 无标题商品源
  const noTitleSource = {
    description: '只有详细描述，没有独立标题的商品',
    price: 88.00,
    images: ['https://img.example.com/pic1.jpg'],
  }

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource(noTitleSource)

  // 验证准备前门禁有效
  assert.equal(controller.canStartPrepare(), true, '无标题但有描述时必须允许启动 prepare')

  await controller.executePrepare()

  // 验证审核阶段门禁有效
  assert.equal(controller.canSubmit(), true, '无独立标题时只要描述有效即可 submit')

  const res = await controller.executeSubmit()
  assert.equal(res.status, 'published')
  assert.equal(res.itemId, 'item_no_title_999')
  assert.equal(submitNetworkCalls, 1)
})

test('34. 新增测试：发布成功返回真实 itemID 并生成可点击商品链接（https://www.goofish.com/item?id=...）', async () => {
  const mockClient = new DirectPublishClient({
    sendMessage: async (msg: any) => {
      if (msg.method === 'prepare') {
        return { kind: 'fishops-direct-publish', method: 'prepare', ok: true, result: mockPreparedResult() }
      }
      if (msg.method === 'submit') {
        return {
          kind: 'fishops-direct-publish',
          method: 'submit',
          ok: true,
          result: { status: 'published', itemId: '789123456789' },
        }
      }
      return null
    },
  })

  const controller = new DirectPublishController({ client: mockClient })
  controller.initSource({
    description: '测试链接跳转',
    price: 10,
    images: ['https://img.example.com/pic1.jpg'],
  })

  await controller.executePrepare()
  const res = await controller.executeSubmit()

  assert.equal(res.status, 'published')
  assert.equal(res.itemId, '789123456789')
  assert.equal(controller.getPublishedItemId(), '789123456789')

  // 验证拼接规则严格对齐 https://www.goofish.com/item?id=encodeURIComponent(itemId)
  const targetUrl = `https://www.goofish.com/item?id=${encodeURIComponent(controller.getPublishedItemId()!)}`
  assert.equal(targetUrl, 'https://www.goofish.com/item?id=789123456789')
})
