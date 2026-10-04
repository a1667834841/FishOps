/**
 * PublishController 纯逻辑与生命周期单测（P8）。
 *
 * 覆盖：
 * 1. PRODUCT_LIST 读取真实商品候选，严格禁止自动偷选，加载后 selectedProduct 保持为 null；
 * 2. 显式选择商品与传空清除选择；
 * 3. 随机选择 1 条商品并更新选中预览；空商品库随机选择优雅报错不崩溃；
 * 4. 按钮状态防护：未选商品时禁止填表，抛出友好校验错误且不调用后台命令；
 * 5. 填表流程：依次调用 PUBLISH_CREATE 与 PUBLISH_FILL_FORM，状态停在 waiting_confirmation；
 * 6. 放弃发布：仅通过 PUBLISH_CANCEL 取消任务，控制器不持有任何平台提交命令；
 * 7. 真实 P8 命令支持：PUBLISH_GET 与 PUBLISH_CANCEL；
 * 8. 格式化与安全边界纯逻辑函数（formatPublishTaskStatus / formatConfirmationStatus / validateProductForPublish）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandTypes, EventTypes } from '@fishops/shared'
import type { Product, PublishTask } from '../../contracts'
import type { BridgeApi } from '../../shared/bridge-api'
import { PublishController } from '../publish-controller'
import {
  formatConfirmationStatus,
  formatPublishTaskStatus,
  formatRMB,
  shouldAutoCloseConfirmModal,
  validateProductForPublish,
} from '../publish-format'

function makeMockProduct(id = 'prod_1', title = '测试商品1', price = 100): Product {
  return {
    itemId: id,
    title,
    price: `¥${price.toFixed(2)}`,
    priceNumber: price,
    originalPrice: `¥${(price * 5).toFixed(2)}`,
    originalPriceNumber: price * 5,
    wantCnt: 10,
    publishTime: '2026-09-01',
    publishTimeMs: 1788200000000,
    captureTime: '2026-09-02',
    captureTimeMs: 1788286400000,
    sellerNick: '测试卖家',
    sellerCity: '杭州',
    freeShip: '是',
    tags: '数码',
    coverUrl: 'https://img.alicdn.com/c1.jpg',
    detailUrl: 'https://www.goofish.com/item?id=' + id,
    desc: '商品描述测试',
    images: ['https://img.alicdn.com/c1.jpg'],
  }
}

class MockBridgeApi implements BridgeApi {
  public sentCommands: Array<{ type: string; payload: unknown }> = []
  public productsToReturn: Product[] = [
    makeMockProduct('prod_1', '苹果 iPhone 15', 5000),
    makeMockProduct('prod_2', '富士相机 XT4', 8000),
    makeMockProduct('prod_3', '任天堂 Switch', 1500),
  ]
  public tasksToReturn: PublishTask[] = []
  public submitOutcomeToReturn: 'submitted' | 'unknown' = 'submitted'
  public submitErrorToThrow: any = null
  private eventHandlers: Record<string, Array<(payload: any) => void>> = {}

  async call(type: any, payload: any): Promise<any> {
    this.sentCommands.push({ type, payload })
    if (type === CommandTypes.PRODUCT_LIST) {
      return { products: this.productsToReturn, total: this.productsToReturn.length }
    }
    if (type === CommandTypes.PUBLISH_LIST) {
      return { tasks: this.tasksToReturn, total: this.tasksToReturn.length }
    }
    if (type === CommandTypes.PUBLISH_GET) {
      const p = payload as { id: string }
      const found = this.tasksToReturn.find((t) => t.id === p.id)
      if (found) return { task: found }
      return {
        task: {
          id: p.id,
          type: 'publish',
          status: 'waiting_confirmation',
          progress: 100,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          payload: { itemId: 'prod_1' },
          result: {
            item: {
              itemId: 'prod_1',
              sourceTitle: '苹果 iPhone 15',
              sourcePrice: 5000,
              sourceImages: [],
              title: '苹果 iPhone 15',
              desc: '描述',
              price: 5000,
              priceInCent: 500000,
              originalPrice: 25000,
              originalPriceInCent: 2500000,
              mainImage: 'https://img.alicdn.com/c1.jpg',
              detailImages: [],
              allImages: ['https://img.alicdn.com/c1.jpg'],
              confirmationStatus: 'waiting_review',
            },
            confirmationStatus: 'waiting_review',
            submitToken: 'token_mock_123',
          },
        },
      }
    }
    if (type === CommandTypes.PUBLISH_CREATE) {
      const p = payload as { itemId: string }
      const task: PublishTask = {
        id: 'task_mock_1',
        type: 'publish',
        status: 'pending',
        progress: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        payload: { itemId: p.itemId },
      }
      return { task }
    }
    if (type === CommandTypes.PUBLISH_FILL_FORM) {
      const p = payload as { id: string }
      const task: PublishTask = {
        id: p.id,
        type: 'publish',
        status: 'waiting_confirmation',
        progress: 100,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        payload: { itemId: 'prod_1' },
        result: {
          item: {
            itemId: 'prod_1',
            sourceTitle: '苹果 iPhone 15',
            sourcePrice: 5000,
            sourceImages: [],
            title: '苹果 iPhone 15',
            desc: '描述',
            price: 5000,
            priceInCent: 500000,
            originalPrice: 25000,
            originalPriceInCent: 2500000,
            mainImage: 'https://img.alicdn.com/c1.jpg',
            detailImages: [],
            allImages: ['https://img.alicdn.com/c1.jpg'],
            confirmationStatus: 'waiting_review',
          },
          confirmationStatus: 'waiting_review',
          formUrl: 'https://www.goofish.com/publish',
          submitToken: 'token_mock_123',
        },
      }
      return { task }
    }
    if (type === CommandTypes.PUBLISH_SUBMIT) {
      if (this.submitErrorToThrow) {
        throw this.submitErrorToThrow
      }
      const p = payload as { id: string; submitToken: string; confirm: boolean }
      const outcome = this.submitOutcomeToReturn
      const updatedTask: PublishTask = {
        id: p.id,
        type: 'publish',
        status: outcome === 'submitted' ? 'completed' : 'waiting_confirmation',
        progress: 100,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        payload: { itemId: 'prod_1' },
        meta: {
          submitAttempted: true,
        },
        result: {
          item: {
            itemId: 'prod_1',
            sourceTitle: '苹果 iPhone 15',
            sourcePrice: 5000,
            sourceImages: [],
            title: '苹果 iPhone 15',
            desc: '描述',
            price: 5000,
            priceInCent: 500000,
            originalPrice: 25000,
            originalPriceInCent: 2500000,
            mainImage: 'https://img.alicdn.com/c1.jpg',
            detailImages: [],
            allImages: ['https://img.alicdn.com/c1.jpg'],
            confirmationStatus: outcome === 'submitted' ? 'confirmed' : 'waiting_review',
          },
          confirmationStatus: outcome === 'submitted' ? 'confirmed' : 'waiting_review',
          submit: {
            state: outcome,
            attemptedAt: Date.now(),
          },
        },
      }
      return {
        id: p.id,
        outcome,
        deterministic: outcome === 'submitted',
        task: updatedTask,
        message: outcome === 'submitted' ? '商品发布已成功提交！' : '发布结果未知',
      }
    }
    if (type === CommandTypes.PUBLISH_CANCEL) {
      return { task: { id: payload.id, type: 'publish', status: 'cancelled' } }
    }
    return {}
  }

  on(type: any, handler: any): () => void {
    if (!this.eventHandlers[type]) this.eventHandlers[type] = []
    this.eventHandlers[type].push(handler)
    return () => {
      this.eventHandlers[type] = (this.eventHandlers[type] || []).filter((h) => h !== handler)
    }
  }

  emit(type: any, payload: any): void {
    const list = this.eventHandlers[type] || []
    for (const h of list) h(payload)
  }

  resubscribe(): void {}
}

test('PublishController: loadProducts 成功加载候选商品且绝不自动偷偷选中商品', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  controller.start()
  await new Promise((r) => setTimeout(r, 10))

  const s = controller.getState()
  assert.equal(s.products.items.length, 3)
  // 必须为 null，禁止暗中偷选第一项
  assert.equal(s.selectedProduct, null)

  // 发布候选源必须显式限定为当前账号已确认发布商品（my_published），绝不把竞品当作可发布候选
  const listCmd = api.sentCommands.find((c) => c.type === CommandTypes.PRODUCT_LIST)
  assert.deepEqual(listCmd?.payload, { limit: 100, source: 'my_published' })
})

test('PublishController: 显式选择商品与清空选择', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadProducts()
  assert.equal(controller.getState().selectedProduct, null)

  // 显式选择 prod_2
  controller.selectProduct('prod_2')
  assert.equal(controller.getState().selectedProduct?.itemId, 'prod_2')
  assert.equal(controller.getState().selectedProduct?.title, '富士相机 XT4')

  // 传入空字符串清除选择
  controller.selectProduct('')
  assert.equal(controller.getState().selectedProduct, null)
})

test('PublishController: 随机选择 1 条商品并更新选中预览', async () => {
  const api = new MockBridgeApi()
  // 固定随机因子为第 2 项（index: 1）
  const controller = new PublishController({ api, randomFn: () => 0.5 })

  await controller.loadProducts()
  const picked = await controller.selectRandomProduct()

  assert.ok(picked !== null)
  assert.equal(picked?.itemId, 'prod_2')
  const s = controller.getState()
  assert.equal(s.selectedProduct?.itemId, 'prod_2')
  assert.ok(s.action.successMessage?.includes('富士相机 XT4'))
})

test('PublishController: 空商品库随机选择优雅报错，不抛出异常', async () => {
  const api = new MockBridgeApi()
  api.productsToReturn = []
  const controller = new PublishController({ api })

  const picked = await controller.selectRandomProduct()
  assert.equal(picked, null)
  const s = controller.getState()
  assert.equal(s.action.phase, 'failed')
  assert.equal(s.action.error?.title, '商品库为空')
})

test('PublishController: 未选择商品时调用 createAndFillTask 阻止执行并提示错误，不发起任何命令', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadProducts()
  assert.equal(controller.getState().selectedProduct, null)

  const result = await controller.createAndFillTask()
  assert.equal(result, null)
  const s = controller.getState()
  assert.equal(s.action.phase, 'failed')
  assert.equal(s.action.error?.title, '请先选择商品')

  // 验证绝无调用 PUBLISH_CREATE 或 PUBLISH_FILL_FORM
  const hasCreate = api.sentCommands.some((c) => c.type === CommandTypes.PUBLISH_CREATE)
  const hasFill = api.sentCommands.some((c) => c.type === CommandTypes.PUBLISH_FILL_FORM)
  assert.equal(hasCreate, false)
  assert.equal(hasFill, false)
})

test('PublishController: 填表流程按序调用 PUBLISH_CREATE 与 PUBLISH_FILL_FORM，状态停在 waiting_confirmation', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadProducts()
  controller.selectProduct('prod_1')

  const filledTask = await controller.createAndFillTask()
  assert.ok(filledTask !== null)
  assert.equal(filledTask?.status, 'waiting_confirmation')
  assert.equal(filledTask?.result?.confirmationStatus, 'waiting_review')

  // 验证 API 依次发出了 PUBLISH_CREATE 与 PUBLISH_FILL_FORM
  const createCmd = api.sentCommands.find((c) => c.type === CommandTypes.PUBLISH_CREATE)
  const fillCmd = api.sentCommands.find((c) => c.type === CommandTypes.PUBLISH_FILL_FORM)

  assert.ok(createCmd, '必须发出 PUBLISH_CREATE')
  assert.ok(fillCmd, '必须发出 PUBLISH_FILL_FORM')
  assert.equal((createCmd?.payload as { itemId: string }).itemId, 'prod_1')

  // 验证当前任务与操作结果
  const s = controller.getState()
  assert.equal(s.currentTask?.id, 'task_mock_1')
  assert.equal(s.currentTask?.status, 'waiting_confirmation')
  assert.equal(s.action.phase, 'ok')
})

test('PublishController: 加载/选品/随机选品/刷新列表都不会自动创建或填充发布任务', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api, randomFn: () => 0 })

  // 页面挂载：仅加载候选商品与任务列表，随后显式选品 / 随机选品 / 刷新，均不得自动建任务
  controller.start()
  await new Promise((r) => setTimeout(r, 10))
  controller.selectProduct('prod_1')
  await controller.selectRandomProduct()
  await controller.loadTasks()
  await controller.loadProducts()

  const types = api.sentCommands.map((c) => c.type)
  assert.ok(!types.includes(CommandTypes.PUBLISH_CREATE), '不得自动发起 PUBLISH_CREATE')
  assert.ok(!types.includes(CommandTypes.PUBLISH_FILL_FORM), '不得自动发起 PUBLISH_FILL_FORM')
  assert.ok(!types.includes(CommandTypes.PUBLISH_CONFIRM_STATUS), '不得自动发起确认状态命令')
  // 最终发布必须由人工在官方页面手动点击，控制器不持有任何提交/执行类命令
  assert.ok(
    !types.some((t) => String(t).includes('SUBMIT') || String(t).includes('EXECUTE')),
    '控制器不得发出自动提交/执行发布的命令',
  )
})

test('PublishController: 真实支持 PUBLISH_GET 与 PUBLISH_CANCEL', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  // 测试 getTask
  const task = await controller.getTask('task_get_1')
  assert.ok(task)
  assert.equal(task?.id, 'task_get_1')
  const getCmd = api.sentCommands.find((c) => c.type === CommandTypes.PUBLISH_GET)
  assert.ok(getCmd)
  assert.equal((getCmd?.payload as { id: string }).id, 'task_get_1')

  // 测试 cancelTask
  await controller.cancelTask('task_get_1', '用户主动取消')
  const cancelCmd = api.sentCommands.find((c) => c.type === CommandTypes.PUBLISH_CANCEL)
  assert.ok(cancelCmd)
  assert.equal((cancelCmd?.payload as { id: string }).id, 'task_get_1')
})

test('纯逻辑安全与格式化测试：validateProductForPublish / formatPublishTaskStatus / formatConfirmationStatus', () => {
  // 1. 商品校验
  assert.equal(validateProductForPublish(null).valid, false)
  assert.equal(validateProductForPublish(undefined).valid, false)
  assert.equal(validateProductForPublish({ itemId: '' } as any).valid, false)
  assert.equal(validateProductForPublish({ itemId: 'id1', title: '' } as any).valid, false)
  assert.equal(validateProductForPublish({ itemId: 'id1', title: '有标题' } as any).valid, true)

  // 2. 任务状态映射
  const waitingView = formatPublishTaskStatus('waiting_confirmation')
  assert.equal(waitingView.label, '待发布')
  assert.equal(waitingView.tone, 'warn')

  const completedView = formatPublishTaskStatus('completed')
  assert.equal(completedView.label, '已发布')
  assert.equal(completedView.tone, 'ok')

  const runningView = formatPublishTaskStatus('running')
  assert.equal(runningView.label, '填表中')
  assert.equal(runningView.tone, 'accent')

  const failedView = formatPublishTaskStatus('failed')
  assert.equal(failedView.label, '填表失败')
  assert.equal(failedView.tone, 'error')

  // 3. 提交与确认状态映射
  assert.equal(formatConfirmationStatus('waiting_review').label, '待提交/准备发布')
  assert.equal(formatConfirmationStatus('waiting_review').tone, 'warn')
  assert.equal(formatConfirmationStatus('confirmed').label, '已提交')
  assert.equal(formatConfirmationStatus('confirmed').tone, 'ok')
  assert.equal(formatConfirmationStatus('rejected').label, '已放弃')
  assert.equal(formatConfirmationStatus('rejected').tone, 'neutral')

  // 4. 价格格式化
  assert.equal(formatRMB(100), '¥100.00')
  assert.equal(formatRMB('99.9'), '¥99.90')
  assert.equal(formatRMB(undefined), '¥0.00')
})

test('PublishController: submitPublish 携带 id, submitToken, confirm: true 成功提交并更新状态', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadProducts()
  controller.selectProduct('prod_1')
  const filledTask = await controller.createAndFillTask()
  assert.ok(filledTask)
  assert.equal(filledTask.status, 'waiting_confirmation')

  // 用户点击发布
  const res = await controller.submitPublish(filledTask.id)
  assert.ok(res)
  assert.equal(res?.outcome, 'submitted')

  // 验证发出的 PUBLISH_SUBMIT 负载
  const submitCmd = api.sentCommands.find((c) => c.type === CommandTypes.PUBLISH_SUBMIT)
  assert.ok(submitCmd, '必须发出 PUBLISH_SUBMIT 命令')
  assert.deepEqual(submitCmd.payload, {
    id: filledTask.id,
    submitToken: 'token_mock_123',
    confirm: true,
  })

  // 验证状态更新
  const s = controller.getState()
  assert.equal(s.submittingTaskId, null)
  assert.equal(s.submitOutcome?.outcome, 'submitted')
  assert.equal(s.action.phase, 'ok')
  assert.ok(s.action.successMessage?.includes('已提交'))
  assert.equal(s.currentTask?.status, 'completed')
})

test('PublishController: submitPublish 结果未知 (unknown) 展示结果未知，绝不自动重试且锁定状态', async () => {
  const api = new MockBridgeApi()
  api.submitOutcomeToReturn = 'unknown'
  const controller = new PublishController({ api })

  await controller.loadProducts()
  controller.selectProduct('prod_1')
  const filledTask = await controller.createAndFillTask()
  assert.ok(filledTask)

  const res = await controller.submitPublish(filledTask.id)
  assert.ok(res)
  assert.equal(res?.outcome, 'unknown')

  const s = controller.getState()
  assert.equal(s.submittingTaskId, null)
  assert.equal(s.submitOutcome?.outcome, 'unknown')
  assert.ok(s.action.successMessage?.includes('结果未知'))
  assert.ok(s.action.successMessage?.includes('绝不自动重试'))

  // 再次调用被锁拦截（因为已标记 submitAttempted / outcome === 'unknown'）
  const submitCmdCountBefore = api.sentCommands.filter((c) => c.type === CommandTypes.PUBLISH_SUBMIT).length
  const secondRes = await controller.submitPublish(filledTask.id)
  assert.equal(secondRes, null)
  const submitCmdCountAfter = api.sentCommands.filter((c) => c.type === CommandTypes.PUBLISH_SUBMIT).length
  assert.equal(submitCmdCountAfter, submitCmdCountBefore, '不得再次发出提交命令')
  assert.ok(controller.getState().action.error?.title.includes('已派发过提交'))
})

test('PublishController: submitPublish 防并发双击拦截', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadProducts()
  controller.selectProduct('prod_1')
  const filledTask = await controller.createAndFillTask()
  assert.ok(filledTask)

  // 模拟并发调用两次
  const p1 = controller.submitPublish(filledTask.id)
  const p2 = controller.submitPublish(filledTask.id)

  const [res1, res2] = await Promise.all([p1, p2])
  // 必定只有一个能发起成功，另一个被防双击直接拦截为 null
  const results = [res1, res2].filter(Boolean)
  assert.equal(results.length, 1)

  const submitCalls = api.sentCommands.filter((c) => c.type === CommandTypes.PUBLISH_SUBMIT)
  assert.equal(submitCalls.length, 1, '只能向后台发出一次 PUBLISH_SUBMIT')
})

test('PublishController: submitPublish 缺少有效 submitToken 时拦截报错，禁止猜或扫选择器', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  const taskWithoutToken: PublishTask = {
    id: 'task_no_token',
    type: 'publish',
    status: 'waiting_confirmation',
    progress: 100,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payload: { itemId: 'prod_1' },
    result: {
      item: {} as any,
      confirmationStatus: 'waiting_review',
      // submitToken 故意缺失
    },
  }
  controller.setCurrentTask(taskWithoutToken)

  const res = await controller.submitPublish('task_no_token')
  assert.equal(res, null)

  const s = controller.getState()
  assert.equal(s.action.phase, 'failed')
  assert.ok(s.action.error?.title.includes('令牌缺失'))

  // 绝未调用后台
  const hasSubmit = api.sentCommands.some((c) => c.type === CommandTypes.PUBLISH_SUBMIT)
  assert.equal(hasSubmit, false)
})

test('PublishController: submitPublish 仅允许 waiting_confirmation 任务提交', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  const pendingTask: PublishTask = {
    id: 'task_pending',
    type: 'publish',
    status: 'pending',
    progress: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payload: { itemId: 'prod_1' },
  }
  controller.setCurrentTask(pendingTask)

  const res = await controller.submitPublish('task_pending')
  assert.equal(res, null)
  assert.ok(controller.getState().action.error?.title.includes('不允许发布'))
})

test('PublishController: submitPublish 确定性错误（如未找到发布按钮）未加锁时提示修正后重试，修正后再次调用成功', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadProducts()
  controller.selectProduct('prod_1')
  const filledTask = await controller.createAndFillTask()
  assert.ok(filledTask)

  // 1. 模拟首次提交出现未找到按钮的确定性错误（后台未锁定）
  const buttonNotFoundErr = new Error('未找到发布按钮')
  ;(buttonNotFoundErr as any).businessCode = 'SUBMIT_BUTTON_NOT_FOUND'
  api.submitErrorToThrow = buttonNotFoundErr

  const failRes = await controller.submitPublish(filledTask.id)
  assert.equal(failRes, null)

  const failState = controller.getState()
  assert.equal(failState.action.phase, 'failed')
  assert.ok(failState.action.error?.hint.includes('未在发布页找到发布按钮'))
  // 按钮锁定已释放，允许修正后重试
  assert.equal(failState.submittingTaskId, null)

  // 2. 用户修正页面后，再次点击同一发布
  api.submitErrorToThrow = null
  api.submitOutcomeToReturn = 'submitted'
  const retryRes = await controller.submitPublish(filledTask.id)
  assert.ok(retryRes)
  assert.equal(retryRes?.outcome, 'submitted')
  assert.equal(controller.getState().action.phase, 'ok')
})

test('PublishController: submitPublish 命中不可重试错误（如已派发或令牌失效）严格尊重后台状态', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadProducts()
  controller.selectProduct('prod_1')
  const filledTask = await controller.createAndFillTask()
  assert.ok(filledTask)

  // 模拟后台返回 SUBMIT_DUPLICATE
  const dupErr = new Error('任务正在提交中或已派发')
  ;(dupErr as any).businessCode = 'SUBMIT_DUPLICATE'
  api.submitErrorToThrow = dupErr

  const res = await controller.submitPublish(filledTask.id)
  assert.equal(res, null)

  const s = controller.getState()
  assert.equal(s.action.phase, 'failed')
  assert.ok(s.action.error?.hint.includes('不可重复点击'))
})

test('PublishController: submitPublish 命中 SUBMIT_VERIFY_UNAVAILABLE（基线/读取能力缺失，派发前拒发）给出行动指引', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadProducts()
  controller.selectProduct('prod_1')
  const filledTask = await controller.createAndFillTask()
  assert.ok(filledTask)

  // 后台为保证“官方在售商品数严格 +1”的可信验据，在派发点击前直接拒绝
  const verifyErr = new Error('缺少官方商品库读取能力，无法核验是否真正发布，已拒绝提交')
  ;(verifyErr as any).businessCode = 'SUBMIT_VERIFY_UNAVAILABLE'
  api.submitErrorToThrow = verifyErr

  const res = await controller.submitPublish(filledTask.id)
  assert.equal(res, null)

  const s = controller.getState()
  assert.equal(s.action.phase, 'failed')
  assert.equal(s.action.error?.code, 'SUBMIT_VERIFY_UNAVAILABLE')
  assert.ok(
    s.action.error?.hint.includes('已在派发点击前拒绝提交'),
    'SUBMIT_VERIFY_UNAVAILABLE 必须给出“派发点击前拒绝提交”的行动指引',
  )
  assert.ok(s.action.error?.hint.includes('闲鱼已登录'), '指引需提示恢复登录 / 商品库读取能力')
})

test('PublishController: 真实后台事件序列：dispatching(in_progress) → clicked:false → rollback 权威快照清空 submitOutcome，catch 后 getTask 正常恢复按钮', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  controller.start()
  await new Promise((r) => setTimeout(r, 10))

  controller.selectProduct('prod_1')
  const filledTask = await controller.createAndFillTask()
  assert.ok(filledTask)
  assert.equal(filledTask.status, 'waiting_confirmation')

  // 1. 模拟提交时后台行为：
  //    首先持久化 dispatching 记录（submitAttempted=true, submit.state='in_progress'）并广播事件
  const dispatchingTask: PublishTask = {
    ...filledTask,
    meta: {
      submitAttempted: true,
    },
    result: {
      ...filledTask.result!,
      submit: {
        state: 'in_progress',
        attemptedAt: Date.now(),
      },
    },
  }

  // 2. 模拟后台因为未找到按钮（clicked: false）而回滚：
  //    清除 result.submit，复位 meta.submitAttempted=false，保留 submitToken
  const rollbackTask: PublishTask = {
    ...filledTask,
    meta: {
      submitAttempted: false,
    },
    result: {
      ...filledTask.result!,
      submit: undefined,
      submitToken: 'token_mock_123',
    },
  }

  // 在后台 tasks 中挂上 rollback 后的权威快照（供 catch 后的 getTask 读取）
  api.tasksToReturn = [rollbackTask]

  // 配置模拟后台：调用 PUBLISH_SUBMIT 时，先广播 dispatching 事件，然后抛出业务错误
  const buttonNotFoundErr = new Error('未在发布页找到发布按钮')
  ;(buttonNotFoundErr as any).code = 'INTERNAL'
  ;(buttonNotFoundErr as any).businessCode = 'SUBMIT_BUTTON_NOT_FOUND'

  // 自定义 call 处理 PUBLISH_SUBMIT
  const originalCall = api.call.bind(api)
  api.call = async (type: any, payload: any) => {
    if (type === CommandTypes.PUBLISH_SUBMIT) {
      // 真实后台时序：先广播 dispatching（前端 handleTaskUpdated 写入 submitOutcome=in_progress）
      api.emit(EventTypes.PUBLISH_TASK_CHANGED, { task: dispatchingTask })
      // 随后点击失败，后台回滚并抛错
      throw buttonNotFoundErr
    }
    return originalCall(type, payload)
  }

  // 执行提交
  const submitRes = await controller.submitPublish(filledTask.id)
  assert.equal(submitRes, null)

  // 等待 catch 块中的 getTask 执行完成
  await new Promise((r) => setTimeout(r, 20))

  const finalState = controller.getState()

  // 关键断言 1：submitOutcome 绝不能残留 in_progress，必须被 rollback 权威快照清空为 null
  assert.equal(
    finalState.submitOutcome,
    null,
    'rollback 权威快照必须清空 submitOutcome，绝不能残留 in_progress',
  )

  // 关键断言 2：submittingTaskId 必须复位为 null
  assert.equal(finalState.submittingTaskId, null)

  // 关键断言 3：错误提示必须命中 SUBMIT_BUTTON_NOT_FOUND 且 code 为业务错误码
  assert.ok(
    finalState.action.error?.hint.includes('未在发布页找到发布按钮'),
    '应当命中 SUBMIT_BUTTON_NOT_FOUND 的专属提示',
  )
  assert.equal(
    finalState.action.error?.code,
    'SUBMIT_BUTTON_NOT_FOUND',
    'ErrorView.code 应为业务错误码 SUBMIT_BUTTON_NOT_FOUND 而非 INTERNAL',
  )

  // 关键断言 4：当前任务快照必须回到 rollback 后的状态（允许再次点击发布）
  assert.equal(finalState.currentTask?.status, 'waiting_confirmation')
  assert.notEqual(finalState.currentTask?.meta?.submitAttempted, true)
  assert.equal(finalState.currentTask?.result?.submit, undefined)

  // 关键断言 5：按钮恢复后再次提交能够成功
  api.call = originalCall
  api.submitOutcomeToReturn = 'submitted'
  const retryRes = await controller.submitPublish(filledTask.id)
  assert.ok(retryRes)
  assert.equal(retryRes?.outcome, 'submitted')
  assert.equal(controller.getState().submitOutcome?.outcome, 'submitted')
})

test('PublishController: 未知 (unknown) 或已 click 权威快照绝对不得解锁', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  controller.start()
  await new Promise((r) => setTimeout(r, 10))

  controller.selectProduct('prod_1')
  const filledTask = await controller.createAndFillTask()
  assert.ok(filledTask)

  // 场景 A：后台已派发点击，状态为 unknown
  const unknownTask: PublishTask = {
    ...filledTask,
    meta: {
      submitAttempted: true,
    },
    result: {
      ...filledTask.result!,
      submit: {
        state: 'unknown',
        attemptedAt: Date.now(),
      },
      submitToken: undefined,
    },
  }

  // 触发权威快照更新
  api.emit(EventTypes.PUBLISH_TASK_CHANGED, { task: unknownTask })
  const sUnknown = controller.getState()
  assert.equal(sUnknown.submitOutcome?.outcome, 'unknown')

  // 再次调用 submitPublish 必须被锁定拦截，绝不能重试
  const blockedUnknown = await controller.submitPublish(filledTask.id)
  assert.equal(blockedUnknown, null)
  assert.ok(controller.getState().action.error?.title.includes('已派发过提交'))

  // 场景 B：后台标记已尝试提交（submitAttempted=true），即使 result.submit 字段缺失，也绝对不能解锁
  const attemptedTaskWithoutSubmit: PublishTask = {
    ...filledTask,
    meta: {
      submitAttempted: true,
    },
    result: {
      ...filledTask.result!,
      submit: undefined,
    },
  }
  api.emit(EventTypes.PUBLISH_TASK_CHANGED, { task: attemptedTaskWithoutSubmit })
  const blockedAttempted = await controller.submitPublish(filledTask.id)
  assert.equal(blockedAttempted, null)
  assert.ok(controller.getState().action.error?.title.includes('已派发过提交'))
})

test('PublishController: 后台广播 rollback 权威快照事件（result.submit 删除 + submitAttempted 复位 false）即清空遗留 in_progress，无需等待 getTask', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  controller.start()
  await new Promise((r) => setTimeout(r, 10))

  controller.selectProduct('prod_1')
  const filledTask = await controller.createAndFillTask()
  assert.ok(filledTask)
  assert.equal(filledTask.status, 'waiting_confirmation')

  // 真实序列 1：后台先落盘 dispatching 记录并广播（submit.state='in_progress'）
  const dispatchingTask: PublishTask = {
    ...filledTask,
    meta: { submitAttempted: true },
    result: {
      ...filledTask.result!,
      submit: { state: 'in_progress', attemptedAt: Date.now() },
    },
  }
  api.emit(EventTypes.PUBLISH_TASK_CHANGED, { task: dispatchingTask })
  assert.equal(
    controller.getState().submitOutcome?.outcome,
    'in_progress',
    'dispatching 广播后 submitOutcome 应进入 in_progress（UI 锁定）',
  )

  // 真实序列 2：注入侧确定性判为 clicked:false，后台回滚并发广播权威快照
  // （result.submit 删除、meta.submitAttempted 复位 false、保留 submitToken）
  const rollbackTask: PublishTask = {
    ...filledTask,
    meta: { submitAttempted: false },
    result: {
      ...filledTask.result!,
      submit: undefined,
      submitToken: 'token_mock_123',
    },
  }
  api.emit(EventTypes.PUBLISH_TASK_CHANGED, { task: rollbackTask })

  const s = controller.getState()
  // 主路径：仅凭事件即可清空 in_progress，不依赖后续 getTask
  assert.equal(s.submitOutcome, null, 'rollback 广播事件必须清空遗留的 in_progress')
  assert.equal(s.currentTask?.status, 'waiting_confirmation')
  assert.notEqual(s.currentTask?.meta?.submitAttempted, true)
  assert.equal(s.currentTask?.result?.submit, undefined)

  // 按钮恢复：可再次点击发布
  api.submitOutcomeToReturn = 'submitted'
  const retryRes = await controller.submitPublish(filledTask.id)
  assert.ok(retryRes)
  assert.equal(retryRes?.outcome, 'submitted')
})

test('PublishController: 非当前任务的陈旧 rollback 快照事件，绝不误清当前任务进行中的 submitOutcome', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  controller.start()
  await new Promise((r) => setTimeout(r, 10))

  controller.selectProduct('prod_1')
  const taskA = await controller.createAndFillTask()
  assert.ok(taskA)

  // 当前任务 taskA 进入 dispatching（in_progress）
  const dispatchingA: PublishTask = {
    ...taskA,
    meta: { submitAttempted: true },
    result: {
      ...taskA.result!,
      submit: { state: 'in_progress', attemptedAt: Date.now() },
    },
  }
  api.emit(EventTypes.PUBLISH_TASK_CHANGED, { task: dispatchingA })
  assert.equal(controller.getState().submitOutcome?.outcome, 'in_progress')

  // 另一条不相关任务的陈旧 rollback 快照到达：绝不能据此解锁 taskA
  const staleOtherTask: PublishTask = {
    ...taskA,
    id: 'publish_other_task',
    meta: { submitAttempted: false },
    result: {
      ...taskA.result!,
      submit: undefined,
    },
  }
  api.emit(EventTypes.PUBLISH_TASK_CHANGED, { task: staleOtherTask })

  const s = controller.getState()
  assert.equal(
    s.submitOutcome?.outcome,
    'in_progress',
    '非当前任务的 rollback 快照绝不能清空当前任务的 in_progress',
  )
  assert.equal(s.submitOutcome?.taskId, dispatchingA.id)
})

// ---------------- executeConfirmedPublish：唯一确认入口的串行链路与安全防线 ----------------

const PUBLISH_WRITE_TYPES = [
  CommandTypes.PUBLISH_CREATE,
  CommandTypes.PUBLISH_FILL_FORM,
  CommandTypes.PUBLISH_SUBMIT,
] as const

function publishWriteTypes(api: MockBridgeApi): string[] {
  return api.sentCommands
    .map((c) => c.type)
    .filter((t) => (PUBLISH_WRITE_TYPES as readonly string[]).includes(t))
}

/**
 * 构造一条 waiting_confirmation 任务，默认与 selectProduct('prod_1') 的冻结草稿完全匹配
 * （标题/描述/价格/原价/图片与 computeFinalPublishItem 结果一致），可按需覆盖某字段制造不一致。
 */
function makeWaitingTask(
  overrides: {
    id?: string
    itemId?: string
    source?: 'feishu' | 'my_published'
    recordId?: string
    targetTableId?: string
    title?: string
    desc?: string
    price?: number
    originalPrice?: number
    mainImage?: string
    detailImages?: string[]
    submitToken?: string
    submitAttempted?: boolean
  } = {},
): PublishTask {
  const itemId = overrides.itemId ?? 'prod_1'
  const title = overrides.title ?? '苹果 iPhone 15'
  const price = overrides.price ?? 5000
  const originalPrice = overrides.originalPrice ?? 25000
  const mainImage = overrides.mainImage ?? 'https://img.alicdn.com/c1.jpg'
  const detailImages = overrides.detailImages ?? []
  return {
    id: overrides.id ?? 'task_waiting_existing',
    type: 'publish',
    status: 'waiting_confirmation',
    progress: 100,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payload: {
      source: overrides.source ?? 'my_published',
      itemId,
      ...(overrides.recordId ? { recordId: overrides.recordId } : {}),
      ...(overrides.targetTableId ? { targetTableId: overrides.targetTableId } : {}),
    },
    ...(overrides.submitAttempted ? { meta: { submitAttempted: true } } : {}),
    result: {
      item: {
        itemId,
        sourceTitle: title,
        sourcePrice: price,
        sourceImages: [],
        title,
        desc: overrides.desc ?? '',
        price,
        priceInCent: Math.round(price * 100),
        originalPrice,
        originalPriceInCent: Math.round(originalPrice * 100),
        mainImage,
        detailImages,
        allImages: [mainImage, ...detailImages],
        confirmationStatus: 'waiting_review',
      },
      confirmationStatus: 'waiting_review',
      submitToken: overrides.submitToken ?? 'token_existing_123',
    },
  }
}

test('PublishController.executeConfirmedPublish: 确认后严格串行 CREATE→FILL→SUBMIT 并成功提交', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadProducts()
  controller.selectProduct('prod_1')

  const res = await controller.executeConfirmedPublish()

  assert.ok(res)
  assert.equal(res?.outcome, 'submitted')
  assert.deepEqual(
    publishWriteTypes(api),
    [CommandTypes.PUBLISH_CREATE, CommandTypes.PUBLISH_FILL_FORM, CommandTypes.PUBLISH_SUBMIT],
    '必须严格按 CREATE → FILL_FORM → SUBMIT 串行执行',
  )

  const submitCmd = api.sentCommands.find((c) => c.type === CommandTypes.PUBLISH_SUBMIT)
  const submitPayload = submitCmd?.payload as { id: string; submitToken: string; confirm: boolean }
  assert.equal(submitPayload.confirm, true, '必须携带 confirm: true 字面量')
  assert.ok(submitPayload.submitToken, '必须携带后台下发的一次性 submitToken')

  const s = controller.getState()
  assert.equal(s.submitOutcome?.outcome, 'submitted')
  assert.equal(s.action.phase, 'ok')
  assert.equal(s.submittingTaskId, null, '完成后必须释放提交锁')
})

test('PublishController.executeConfirmedPublish: 两次确认仅执行一链，绝不重复创建/填充/提交', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadProducts()
  controller.selectProduct('prod_1')

  // 模拟用户双击：并发两次确认
  const [r1, r2] = await Promise.all([
    controller.executeConfirmedPublish(),
    controller.executeConfirmedPublish(),
  ])

  const types = publishWriteTypes(api)
  assert.equal(types.filter((t) => t === CommandTypes.PUBLISH_CREATE).length, 1, '只允许创建一次任务')
  assert.equal(types.filter((t) => t === CommandTypes.PUBLISH_FILL_FORM).length, 1, '只允许填充一次表单')
  assert.equal(types.filter((t) => t === CommandTypes.PUBLISH_SUBMIT).length, 1, '只允许提交一次')

  const outcomes = [r1?.outcome, r2?.outcome]
  assert.equal(outcomes.filter((o) => o === 'submitted').length, 1, '仅一链成功，另一次被并发锁拦截')
  assert.equal(outcomes.filter((o) => o === undefined).length, 1)
})

test('PublishController.executeConfirmedPublish: 后台 fill.ok 为 false / 非 waiting_confirmation 时立即中断，绝不 SUBMIT', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })
  const baseCall = api.call.bind(api)
  api.call = async (type: any, payload: any) => {
    if (type === CommandTypes.PUBLISH_FILL_FORM) {
      api.sentCommands.push({ type, payload })
      return {
        ok: false,
        error: '表单填充遇到安全验证码',
        task: {
          id: (payload as { id: string }).id,
          type: 'publish',
          status: 'failed',
          progress: 100,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          payload: { itemId: 'prod_1' },
        },
      }
    }
    return baseCall(type, payload)
  }

  await controller.loadProducts()
  controller.selectProduct('prod_1')

  const res = await controller.executeConfirmedPublish()

  assert.equal(res, null, '填表未就绪时确认链路必须中断并返回 null')
  assert.equal(
    api.sentCommands.filter((c) => c.type === CommandTypes.PUBLISH_SUBMIT).length,
    0,
    'fill 失败时绝不允许调用 PUBLISH_SUBMIT',
  )
  assert.equal(controller.getState().action.phase, 'failed')
})

test('PublishController.executeConfirmedPublish: 结果 unknown 锁定且绝不自动重试', async () => {
  const api = new MockBridgeApi()
  api.submitOutcomeToReturn = 'unknown'
  const controller = new PublishController({ api })

  await controller.loadProducts()
  controller.selectProduct('prod_1')

  const res1 = await controller.executeConfirmedPublish()
  assert.ok(res1)
  assert.equal(res1?.outcome, 'unknown')
  assert.equal(controller.getState().submitOutcome?.outcome, 'unknown')

  // 再次确认必须被锁定拦截，且不产生第二次 SUBMIT
  const submitBefore = api.sentCommands.filter((c) => c.type === CommandTypes.PUBLISH_SUBMIT).length
  const res2 = await controller.executeConfirmedPublish()
  assert.equal(res2, null)
  assert.equal(
    api.sentCommands.filter((c) => c.type === CommandTypes.PUBLISH_SUBMIT).length,
    submitBefore,
    'unknown 后绝不自动或重复提交',
  )
})

test('PublishController.executeConfirmedPublish: 兼容旧已有 waiting_confirmation + 合法 submitToken 任务，直接复用令牌提交', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadProducts()
  controller.selectProduct('prod_1')

  // 模拟此前已存在、与该草稿完全匹配且尚未尝试提交的 waiting 任务（未编辑草稿，isDirty=false）
  const existingWaitingTask = makeWaitingTask()
  controller.setCurrentTask(existingWaitingTask)

  const res = await controller.executeConfirmedPublish()
  assert.ok(res)
  assert.equal(res?.outcome, 'submitted')

  const types = publishWriteTypes(api)
  assert.equal(types.filter((t) => t === CommandTypes.PUBLISH_CREATE).length, 0, '复用 waiting 任务不得重新创建')
  assert.equal(types.filter((t) => t === CommandTypes.PUBLISH_FILL_FORM).length, 0, '复用 waiting 任务不得重新填充')

  const submitCmd = api.sentCommands.find((c) => c.type === CommandTypes.PUBLISH_SUBMIT)
  assert.equal((submitCmd?.payload as { id: string }).id, 'task_waiting_existing')
})

test('PublishController.executeConfirmedPublish: 确认链路执行期间冻结草稿，编辑/切素材均被拒绝且不污染提交内容', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })
  const baseCall = api.call.bind(api)

  // 挂起 PUBLISH_CREATE，制造“链路执行中”的稳定窗口
  let releaseCreate: () => void = () => {}
  api.call = async (type: any, payload: any) => {
    if (type === CommandTypes.PUBLISH_CREATE) {
      api.sentCommands.push({ type, payload })
      await new Promise<void>((resolve) => {
        releaseCreate = resolve
      })
      return {
        task: {
          id: 'task_frozen_1',
          type: 'publish',
          status: 'pending',
          progress: 0,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          payload: { itemId: 'prod_1' },
        },
      }
    }
    return baseCall(type, payload)
  }

  await controller.loadProducts()
  controller.selectProduct('prod_1')
  const frozenTitle = controller.getState().editingDraft?.title

  const chain = controller.executeConfirmedPublish()

  // 此刻链路已开始（isPublishingChain = true），尝试编辑与切素材
  controller.updateDraftField({ title: '被篡改的标题' })
  controller.updateCustomRule({ priceMarkup: 999 })
  controller.selectProduct('prod_2')

  const during = controller.getState()
  assert.equal(during.editingDraft?.title, frozenTitle, '确认链路执行期间标题必须冻结不可改')
  assert.equal(during.editingDraft?.itemId, 'prod_1', '确认链路执行期间不得切换素材')
  assert.equal(during.customRule.priceMarkup, 0, '确认链路执行期间不得修改规则')

  releaseCreate()

  const res = await chain
  assert.ok(res)
  assert.equal(res?.outcome, 'submitted', '冻结后草稿代数未漂移，链路应正常完成')

  // 提交内容必须仍来自冻结时的原始草稿，而非被拒绝的篡改值
  const createCmd = api.sentCommands.find((c) => c.type === CommandTypes.PUBLISH_CREATE)
  const override = (createCmd?.payload as { override?: { title?: string } }).override
  assert.equal(override?.title, frozenTitle)
})

test('PublishController.executeConfirmedPublish: 聚焦历史任务但素材不同时，绝不复用其令牌，改为创建新任务提交当前草稿', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadProducts()
  controller.selectProduct('prod_1') // 当前草稿目标：prod_1
  // 历史任务属于另一素材 prod_2（即使 waiting + 合法 token 也绝不复用）
  controller.setCurrentTask(
    makeWaitingTask({ id: 'task_hist_prod2', itemId: 'prod_2', title: '富士相机 XT4', price: 8000, originalPrice: 40000 }),
  )

  const res = await controller.executeConfirmedPublish()
  assert.ok(res)
  assert.equal(res?.outcome, 'submitted')

  const types = publishWriteTypes(api)
  assert.equal(types.filter((t) => t === CommandTypes.PUBLISH_CREATE).length, 1, '不同素材必须创建新任务')
  assert.equal(types.filter((t) => t === CommandTypes.PUBLISH_FILL_FORM).length, 1, '不同素材必须重新填充')

  const submitCmd = api.sentCommands.find((c) => c.type === CommandTypes.PUBLISH_SUBMIT)
  const submitId = (submitCmd?.payload as { id: string }).id
  assert.notEqual(submitId, 'task_hist_prod2', '绝不能提交历史任务的一次性令牌')
  assert.equal(submitId, 'task_mock_1', '必须提交本次新建任务')
})

test('PublishController.executeConfirmedPublish: 同素材但历史任务最终内容与当前草稿不一致时，绝不复用其令牌', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadProducts()
  controller.selectProduct('prod_1')
  // 同 itemId=prod_1，但最终标题与当前草稿不同（内容不一致）
  controller.setCurrentTask(makeWaitingTask({ id: 'task_hist_stale', title: '旧的过时标题' }))

  const res = await controller.executeConfirmedPublish()
  assert.ok(res)
  assert.equal(res?.outcome, 'submitted')

  const types = publishWriteTypes(api)
  assert.equal(types.filter((t) => t === CommandTypes.PUBLISH_CREATE).length, 1, '内容不一致必须重建任务')
  assert.equal(types.filter((t) => t === CommandTypes.PUBLISH_FILL_FORM).length, 1, '内容不一致必须重新填充')
  const submitCmd = api.sentCommands.find((c) => c.type === CommandTypes.PUBLISH_SUBMIT)
  assert.notEqual((submitCmd?.payload as { id: string }).id, 'task_hist_stale')
})

test('PublishController.executeConfirmedPublish: createPayload 按 source 构造 typed 字段，绝不含 undefined 可选键', async () => {
  // 飞书：无真实商品 ID 时不得出现 itemId 键，且不得出现 undefined 值
  const feishuApi = new MockBridgeApi()
  const feishuController = new PublishController({ api: feishuApi })
  await feishuController.loadDraft({
    source: 'feishu',
    recordId: 'rec_1',
    targetTableId: 'tbl_1',
    title: '飞书相机',
    price: 2000,
  })
  await feishuController.executeConfirmedPublish()

  const feishuCreate = feishuApi.sentCommands.find((c) => c.type === CommandTypes.PUBLISH_CREATE)
  const feishuPayload = (feishuCreate?.payload ?? {}) as Record<string, unknown>
  assert.equal(feishuPayload.source, 'feishu')
  assert.equal(feishuPayload.recordId, 'rec_1')
  assert.equal(feishuPayload.targetTableId, 'tbl_1')
  assert.ok(!('itemId' in feishuPayload), '飞书无真实商品 ID 时不得写入 itemId 键')
  assert.deepEqual(
    Object.entries(feishuPayload).filter(([, v]) => v === undefined).map(([k]) => k),
    [],
    '飞书 createPayload 不得含 undefined 值',
  )

  // 自营：不得出现 recordId / targetTableId 键
  const localApi = new MockBridgeApi()
  const localController = new PublishController({ api: localApi })
  await localController.loadProducts()
  localController.selectProduct('prod_1')
  await localController.executeConfirmedPublish()

  const localCreate = localApi.sentCommands.find((c) => c.type === CommandTypes.PUBLISH_CREATE)
  const localPayload = (localCreate?.payload ?? {}) as Record<string, unknown>
  assert.equal(localPayload.source, 'my_published')
  assert.equal(localPayload.itemId, 'prod_1')
  assert.ok(!('recordId' in localPayload), '自营不得写入 recordId 键')
  assert.ok(!('targetTableId' in localPayload), '自营不得写入 targetTableId 键')
  for (const obj of [localPayload, localPayload.override as Record<string, unknown>]) {
    assert.deepEqual(
      Object.entries(obj).filter(([, v]) => v === undefined).map(([k]) => k),
      [],
      '自营 createPayload / override 不得含 undefined 值',
    )
  }
})

// ---------------- 确认弹窗关闭策略：仅 submitted 自动关闭，failure / unknown 保持打开 ----------------

test('shouldAutoCloseConfirmModal: 仅 submitted 自动关闭；failure(null) / unknown 一律保持弹窗打开', async () => {
  // 纯函数边界：null / undefined 绝不关闭（链路中断或异常后必须保持弹窗）
  assert.equal(shouldAutoCloseConfirmModal(null), false)
  assert.equal(shouldAutoCloseConfirmModal(undefined), false)
  assert.equal(shouldAutoCloseConfirmModal({ outcome: 'unknown' }), false)
  assert.equal(shouldAutoCloseConfirmModal({ outcome: 'submitted' }), true)

  // failure：填表未就绪，确认链路中断返回 null → 弹窗必须保持打开
  const failApi = new MockBridgeApi()
  const failController = new PublishController({ api: failApi })
  const baseCall = failApi.call.bind(failApi)
  failApi.call = async (type: any, payload: any) => {
    if (type === CommandTypes.PUBLISH_FILL_FORM) {
      failApi.sentCommands.push({ type, payload })
      return {
        ok: false,
        error: '表单填充遇到安全验证码',
        task: {
          id: (payload as { id: string }).id,
          type: 'publish',
          status: 'failed',
          progress: 100,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          payload: { itemId: 'prod_1' },
        },
      }
    }
    return baseCall(type, payload)
  }
  await failController.loadProducts()
  failController.selectProduct('prod_1')
  const failRes = await failController.executeConfirmedPublish()
  assert.equal(failRes, null, 'fill 失败时确认链路必须返回 null')
  assert.equal(shouldAutoCloseConfirmModal(failRes), false, '业务失败绝不得自动关闭弹窗伪装成功')

  // unknown：已派发点击但结果未知 → 弹窗必须保持打开且锁定
  const unknownApi = new MockBridgeApi()
  unknownApi.submitOutcomeToReturn = 'unknown'
  const unknownController = new PublishController({ api: unknownApi })
  await unknownController.loadProducts()
  unknownController.selectProduct('prod_1')
  const unknownRes = await unknownController.executeConfirmedPublish()
  assert.equal(unknownRes?.outcome, 'unknown')
  assert.equal(shouldAutoCloseConfirmModal(unknownRes), false, 'unknown（结果未知）绝不得自动关闭弹窗伪装成功')

  // submitted：仅成功允许自动关闭弹窗
  const okApi = new MockBridgeApi()
  const okController = new PublishController({ api: okApi })
  await okController.loadProducts()
  okController.selectProduct('prod_1')
  const okRes = await okController.executeConfirmedPublish()
  assert.equal(okRes?.outcome, 'submitted')
  assert.equal(shouldAutoCloseConfirmModal(okRes), true, '仅 submitted 允许自动关闭弹窗')
})
