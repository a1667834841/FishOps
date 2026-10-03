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
import { CommandTypes } from '@fishops/shared'
import type { Product, PublishTask } from '../../contracts'
import type { BridgeApi } from '../../shared/bridge-api'
import { PublishController } from '../publish-controller'
import {
  formatConfirmationStatus,
  formatPublishTaskStatus,
  formatRMB,
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

  on(): () => void {
    return () => {}
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
