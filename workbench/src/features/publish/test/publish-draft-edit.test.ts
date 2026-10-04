/**
 * 发布草稿与内容编辑专项测试（P8）：
 *
 * 覆盖需求要点：
 * 1. 导航与草稿传递：PublishDraftStore 记录选中条目（飞书素材带 recordId/targetTableId，自营商品带真实 itemId）；
 * 2. 严禁自动发布：导航与选品只传递草稿，绝不调用 PUBLISH_CREATE、PUBLISH_FILL_FORM 或 PUBLISH_SUBMIT；
 * 3. 飞书素材保留 recordId 作为唯一 row identity，绝不冒充 my_published，绝无假 itemId；
 * 4. FEISHU_PRODUCT_GET：后台读取已保存飞书表素材，支持补全草稿字段；
 * 5. 编辑草稿：支持编辑标题、描述、售价、原价、图片 URL；
 * 6. 核心安全防线：编辑内容或切换素材时，旧 task 及其提交令牌立即失效（置为 null），避免提交错误旧内容；
 * 7. 保存编辑仅用于本次发布表单 override，绝不自动反向修改飞书表格；
 * 8. 自营商品同样支持编辑与 override 发布。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes } from '@fishops/shared'
import { CommandError } from '../../shared/error-format'
import type { PublishTask } from '../../contracts'
import type { BridgeApi } from '../../shared/bridge-api'
import { PublishController } from '../publish-controller'
import { PublishDraftStore, type PublishDraft } from '../publish-draft-store'
import { computeFinalPublishItem, containsUnicodeEmoji, stripUnicodeEmoji, validateProductForPublish } from '../publish-format'

class MockBridgeApi implements BridgeApi {
  public calls: Array<{ type: string; payload: unknown }> = []
  private responders = new Map<string, (payload: unknown) => unknown>()

  respond(type: string, handler: (payload: unknown) => unknown): void {
    this.responders.set(type, handler)
  }

  async call(type: string, payload: unknown): Promise<any> {
    this.calls.push({ type, payload })
    const handler = this.responders.get(type)
    if (handler) return handler(payload)
    return {}
  }

  on(): () => void {
    return () => {}
  }

  resubscribe(): void {}
  dispose(): void {}
}

function makeTask(id: string, status: PublishTask['status'] = 'waiting_confirmation'): PublishTask {
  return {
    id,
    type: 'publish',
    status,
    progress: 100,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payload: { itemId: 'item_test' },
    result: {
      submitToken: 'token_abc_123',
    },
  } as PublishTask
}

test('PublishDraftStore: 草稿存取、清空与订阅通知完整运作', () => {
  const store = new PublishDraftStore()
  assert.equal(store.getDraft(), null)

  const notifications: Array<PublishDraft | null> = []
  const unsubscribe = store.subscribe((draft) => {
    notifications.push(draft)
  })

  // 初始订阅时应收到 null
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0], null)

  // 存入飞书草稿
  const draft: PublishDraft = {
    source: 'feishu',
    recordId: 'rec_feishu_999',
    targetTableId: 'tbl_camera_list',
    title: '富士相机 XT-30',
    price: 4500,
    originalPrice: 6000,
    coverUrl: 'https://img.example.com/xt30.jpg',
  }
  store.setDraft(draft)

  const retrieved = store.getDraft()
  assert.equal(retrieved?.source, 'feishu')
  assert.equal(retrieved?.recordId, 'rec_feishu_999')
  assert.equal(retrieved?.targetTableId, 'tbl_camera_list')
  assert.equal(retrieved?.title, '富士相机 XT-30')
  assert.equal(retrieved?.itemId, undefined) // 飞书素材无假 itemId

  assert.equal(notifications.length, 2)
  assert.equal(notifications[1]?.recordId, 'rec_feishu_999')

  // 清空草稿
  store.clearDraft()
  assert.equal(store.getDraft(), null)
  assert.equal(notifications.length, 3)
  assert.equal(notifications[2], null)

  unsubscribe()
})

test('PublishDraftStore: 注销订阅后不再收到通知，避免切页累积旧回调放大重复加载', () => {
  const store = new PublishDraftStore()
  let firstCalls = 0
  let secondCalls = 0
  const unsubscribeFirst = store.subscribe(() => {
    firstCalls++
  })
  const unsubscribeSecond = store.subscribe(() => {
    secondCalls++
  })

  // 订阅时的 immediate 回调
  assert.equal(firstCalls, 1)
  assert.equal(secondCalls, 1)

  store.setDraft({ source: 'my_published', itemId: 'item_1', title: '商品一', price: 10 })
  assert.equal(firstCalls, 2)
  assert.equal(secondCalls, 2)

  // 注销第一个订阅者后，其回调不得再被调用
  unsubscribeFirst()
  store.setDraft({ source: 'my_published', itemId: 'item_2', title: '商品二', price: 20 })
  assert.equal(firstCalls, 2, '已注销的 listener 不得再收到通知')
  assert.equal(secondCalls, 3)

  store.clearDraft()
  assert.equal(secondCalls, 4)
  unsubscribeSecond()
})

test('PublishDraftStore: clearDraft 后重新载入同款草稿仍会通知，保证清空后可再次载入', () => {
  const store = new PublishDraftStore()
  const seen: Array<PublishDraft | null> = []
  const unsubscribe = store.subscribe((d) => {
    seen.push(d)
  })

  const draft: PublishDraft = { source: 'my_published', itemId: 'same_item', title: '同款商品', price: 10 }
  store.setDraft(draft)
  store.clearDraft()
  store.setDraft(draft)

  // immediate(null) + set + clear(null) + 再次 set
  assert.equal(seen.length, 4)
  assert.equal(seen[3]?.itemId, 'same_item')
  unsubscribe()
})

test('PublishController: 载入飞书草稿，绝不冒充 my_published，绝无假 itemId，立即使旧 task 失效', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  // 先人工模拟一个已有旧任务的状态
  controller.setCurrentTask(makeTask('old_task_001'))
  assert.equal(controller.getState().currentTask?.id, 'old_task_001')

  const feishuDraft: PublishDraft = {
    source: 'feishu',
    recordId: 'rec_feishu_123',
    targetTableId: 'tbl_goods',
    title: '中古镜头 50mm f1.4',
    desc: '成色极佳，镜片通透',
    price: 888,
    originalPrice: 1200,
    coverUrl: 'https://img.example.com/lens.jpg',
  }

  // 载入飞书草稿
  await controller.loadDraft(feishuDraft)

  const state = controller.getState()
  assert.equal(state.editingDraft?.source, 'feishu')
  assert.equal(state.editingDraft?.recordId, 'rec_feishu_123')
  assert.equal(state.editingDraft?.targetTableId, 'tbl_goods')
  assert.equal(state.editingDraft?.itemId, undefined) // 绝无假 itemId
  assert.equal(state.selectedProduct, null) // 绝不把飞书素材放到 selectedProduct 冒充 my_published

  // 核心安全防线：载入新草稿旧 task 必须立即清空！
  assert.equal(state.currentTask, null)
  assert.equal(state.submittingTaskId, null)
  assert.equal(state.submitOutcome, null)

  // 此时没有任何命令被自动调用（不自动创建任务、不自动填表、不自动发布）
  const publishCmds = api.calls.filter((c) =>
    c.type === CommandTypes.PUBLISH_CREATE ||
    c.type === CommandTypes.PUBLISH_FILL_FORM ||
    c.type === CommandTypes.PUBLISH_SUBMIT
  )
  assert.equal(publishCmds.length, 0)
})

test('PublishController: FEISHU_PRODUCT_GET 读取已保存飞书表素材，若后端返回则补全草稿', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.FEISHU_PRODUCT_GET, (payload: any) => {
    assert.equal(payload.recordId, 'rec_feishu_get_1')
    return {
      recordId: 'rec_feishu_get_1',
      targetTableId: 'tbl_my_table',
      fields: {},
      material: {
        itemId: '',
        title: '最新飞书表中的标题',
        desc: '最新描述',
        price: 1688,
        originalPrice: 2000,
        wantCnt: 10,
        coverUrl: 'https://img.example.com/new_cover.jpg',
        detailUrl: '',
        images: ['https://img.example.com/new_cover.jpg'],
      },
      missingFields: [],
      warnings: [],
    }
  })

  const controller = new PublishController({ api })
  await controller.loadDraft({
    source: 'feishu',
    recordId: 'rec_feishu_get_1',
    targetTableId: 'tbl_my_table',
    title: '初始占位标题',
    price: 1000,
  })

  // 验证调用了 FEISHU_PRODUCT_GET
  const getCall = api.calls.find((c) => c.type === CommandTypes.FEISHU_PRODUCT_GET)
  assert.ok(getCall)
  assert.equal((getCall.payload as any).recordId, 'rec_feishu_get_1')

  // 草稿字段被最新飞书数据更新
  const draft = controller.getState().editingDraft
  assert.equal(draft?.title, '最新飞书表中的标题')
  assert.equal(draft?.price, 1688)
  assert.equal(draft?.originalPrice, 2000)
  assert.equal(draft?.coverUrl, 'https://img.example.com/new_cover.jpg')
})

test('PublishController: 编辑标题、描述、售价、原价、图片等，旧 task 与提交令牌立即失效', async () => {
  const api = new MockBridgeApi()
  const controller = new PublishController({ api })

  await controller.loadDraft({
    source: 'feishu',
    recordId: 'rec_feishu_edit',
    title: '原始标题',
    price: 500,
  })

  // 人工赋予一个已填好的任务（具有 submitToken）
  controller.setCurrentTask(makeTask('task_ready_to_submit'))
  assert.equal(controller.getState().currentTask?.id, 'task_ready_to_submit')

  // 1. 用户编辑标题
  controller.updateDraftField({ title: '修改后的标题' })
  assert.equal(controller.getState().editingDraft?.title, '修改后的标题')
  assert.equal(controller.getState().editingDraft?.isDirty, true)
  // 核心安全校验：旧 task 必须立即作废！
  assert.equal(controller.getState().currentTask, null)
  assert.equal(controller.getState().submittingTaskId, null)

  // 再次赋予 task
  controller.setCurrentTask(makeTask('task_ready_again'))
  assert.equal(controller.getState().currentTask?.id, 'task_ready_again')

  // 2. 用户编辑售价
  controller.updateDraftField({ price: 699 })
  assert.equal(controller.getState().editingDraft?.price, 699)
  // 核心安全校验：旧 task 再次被清空！
  assert.equal(controller.getState().currentTask, null)

  // 再次赋予 task
  controller.setCurrentTask(makeTask('task_ready_third'))

  // 3. 用户编辑图片 URL 列表
  controller.updateDraftField({ imageUrls: ['https://img.example.com/p1.jpg', 'https://img.example.com/p2.jpg'] })
  assert.equal(controller.getState().editingDraft?.imageUrls.length, 2)
  // 核心安全校验：旧 task 再次被清空！
  assert.equal(controller.getState().currentTask, null)
})

test('PublishController: 填表流程按序调用 PUBLISH_CREATE（向 ds 契约对齐）与 PUBLISH_FILL_FORM，且保存编辑仅用于本次发布，不修改飞书多维表格', async () => {
  const api = new MockBridgeApi()

  let receivedCreatePayload: any = null
  api.respond(CommandTypes.PUBLISH_CREATE, (payload: any) => {
    receivedCreatePayload = payload
    return {
      task: {
        id: 'task_created_feishu_1',
        type: 'publish',
        status: 'pending',
        progress: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        payload,
      },
    }
  })

  api.respond(CommandTypes.PUBLISH_FILL_FORM, (payload: any) => {
    assert.equal(payload.id, 'task_created_feishu_1')
    return {
      task: {
        id: 'task_created_feishu_1',
        type: 'publish',
        status: 'waiting_confirmation',
        progress: 100,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        result: {
          submitToken: 'token_one_time_999',
        },
      },
    }
  })

  const controller = new PublishController({ api })

  await controller.loadDraft({
    source: 'feishu',
    recordId: 'rec_feishu_camera',
    targetTableId: 'tbl_cameras',
    title: '初始飞书标题',
    price: 3000,
    coverUrl: 'https://img.example.com/original.jpg',
  })

  // 用户在发布中心进行了编辑
  controller.updateDraftField({
    title: '【极品成色】微单相机 全套配件',
    desc: '个人闲置，箱说全',
    price: 3200,
    originalPrice: 4000,
    imageUrls: ['https://img.example.com/c1.jpg', 'https://img.example.com/c2.jpg'],
  })

  // 点击“开始自动填充发布表单”
  const filledTask = await controller.createAndFillTask()

  assert.ok(filledTask)
  assert.equal(filledTask.status, 'waiting_confirmation')
  assert.equal(controller.getState().currentTask?.id, 'task_created_feishu_1')

  // 验证向 PUBLISH_CREATE 发送的契约 payload 格式
  assert.ok(receivedCreatePayload)
  assert.equal(receivedCreatePayload.source, 'feishu')
  assert.equal(receivedCreatePayload.recordId, 'rec_feishu_camera')
  assert.equal(receivedCreatePayload.targetTableId, 'tbl_cameras')
  assert.equal(receivedCreatePayload.itemId, undefined) // 飞书素材绝无假 itemId
  // 验证编辑字段通过 override 传递
  assert.equal(receivedCreatePayload.override.title, '【极品成色】微单相机 全套配件')
  assert.equal(receivedCreatePayload.override.desc, '个人闲置，箱说全')
  assert.equal(receivedCreatePayload.override.price, 3200)
  assert.equal(receivedCreatePayload.override.originalPrice, 4000)
  assert.deepEqual(receivedCreatePayload.override.images, ['https://img.example.com/c1.jpg', 'https://img.example.com/c2.jpg'])

  // 验证保存编辑仅用于发布 override，绝不自动反向修改飞书表格（不调用 FEISHU_PRODUCT_WRITE 等写入命令）
  const feishuWriteCalls = api.calls.filter((c) =>
    c.type.includes('FEISHU_PRODUCT_WRITE') ||
    c.type.includes('FEISHU_WRITE')
  )
  assert.equal(feishuWriteCalls.length, 0)
})

test('PublishController: 自营商品 my_published 同样支持编辑与 override 发布', async () => {
  const api = new MockBridgeApi()
  let receivedPayload: any = null
  api.respond(CommandTypes.PUBLISH_CREATE, (payload: any) => {
    receivedPayload = payload
    return {
      task: {
        id: 'task_my_pub_1',
        type: 'publish',
        status: 'pending',
        progress: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }
  })
  api.respond(CommandTypes.PUBLISH_FILL_FORM, () => ({
    task: {
      id: 'task_my_pub_1',
      type: 'publish',
      status: 'waiting_confirmation',
      progress: 100,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      result: { submitToken: 'token_self_1' },
    },
  }))

  const controller = new PublishController({ api })

  // 载入自营商品草稿
  await controller.loadDraft({
    source: 'my_published',
    itemId: 'my_item_888',
    title: '我的自营商品原标题',
    price: 199,
  })

  // 编辑字段
  controller.updateDraftField({
    title: '【降价急出】我的自营商品新标题',
    price: 159,
  })

  await controller.createAndFillTask()

  assert.ok(receivedPayload)
  assert.equal(receivedPayload.source, 'my_published')
  assert.equal(receivedPayload.itemId, 'my_item_888')
  assert.equal(receivedPayload.override.title, '【降价急出】我的自营商品新标题')
  assert.equal(receivedPayload.override.price, 159)
})

test('validateProductForPublish: 支持飞书素材缺 itemId 但有 recordId，不被 validate itemId 拦截', () => {
  // 1. 飞书素材：无 itemId，但有合法的 recordId 与标题 -> 必须放行通过！
  const feishuMaterial = {
    recordId: 'rec_camera_001',
    itemId: '', // 飞书未录入 itemId，为空串
    title: '佳能数码相机',
  }
  const res1 = validateProductForPublish(feishuMaterial)
  assert.equal(res1.valid, true)
  assert.equal(res1.error, undefined)

  // 2. 自营商品：有 itemId 与标题 -> 放行
  const selfProduct = {
    itemId: 'item_self_123',
    title: '自营数码',
  }
  const res2 = validateProductForPublish(selfProduct)
  assert.equal(res2.valid, true)

  // 3. 既无 itemId 又无 recordId -> 拦截报错
  const invalidItem = {
    itemId: '',
    recordId: '',
    title: '无身份标识商品',
  }
  const res3 = validateProductForPublish(invalidItem)
  assert.equal(res3.valid, false)
  assert.ok(res3.error?.includes('缺少有效 ID'))
})

test('PublishController: FEISHU_PRODUCT_GET 载入 payload 必须带草稿 targetTableId 断言不漂移', async () => {
  const api = new MockBridgeApi()
  let capturedPayload: any = null
  api.respond(CommandTypes.FEISHU_PRODUCT_GET, (payload: any) => {
    capturedPayload = payload
    return {
      recordId: payload.recordId,
      targetTableId: payload.targetTableId,
      row: { recordId: payload.recordId },
      material: {
        itemId: '',
        title: '素材标题',
        desc: '素材描述',
        price: 99,
        originalPrice: 199,
        wantCnt: 5,
        coverUrl: 'https://img.example.com/c.jpg',
        detailUrl: '',
        images: ['https://img.example.com/c.jpg'],
      },
      missingFields: [],
      warnings: [],
    }
  })

  const controller = new PublishController({ api })
  await controller.loadDraft({
    source: 'feishu',
    recordId: 'rec_exact_table_check',
    targetTableId: 'tbl_anti_drift_assert',
    title: '待核对素材',
    price: 99,
  })

  // 载入必须带 targetTableId 断言不漂移
  assert.ok(capturedPayload)
  assert.equal(capturedPayload.recordId, 'rec_exact_table_check')
  assert.equal(capturedPayload.targetTableId, 'tbl_anti_drift_assert')
})

test('PublishController: draft guard / generation seq 保护：在途 create/fill 期间编辑或切素材，异步完成后不得恢复旧任务或旧令牌', async () => {
  const api = new MockBridgeApi()

  let resolveFill: (val: any) => void
  const fillPromise = new Promise((r) => {
    resolveFill = r
  })

  api.respond(CommandTypes.PUBLISH_CREATE, (payload: any) => ({
    task: {
      id: 'task_slow_filling',
      type: 'publish',
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      payload,
    },
  }))

  api.respond(CommandTypes.PUBLISH_FILL_FORM, () => fillPromise)

  const controller = new PublishController({ api })

  await controller.loadDraft({
    source: 'feishu',
    recordId: 'rec_first_item',
    title: '商品 A',
    price: 100,
  })

  // 1. 触发自动填表（此时 fill 处于挂起等待状态）
  const fillTaskPromise = controller.createAndFillTask()
  assert.equal(controller.getState().action.phase, 'running')

  // 2. 在填表在途期间，用户编辑了标题！代数发生漂移
  controller.updateDraftField({ title: '商品 A（用户在填表时紧急修改的新标题）' })
  assert.equal(controller.getState().currentTask, null) // 编辑立即使旧 task 失效

  // 3. 此时旧异步填表响应完成返回并携带了旧令牌
  resolveFill!({
    task: {
      id: 'task_slow_filling',
      type: 'publish',
      status: 'waiting_confirmation',
      progress: 100,
      result: { submitToken: 'old_stale_token_from_past' },
    },
  })

  const fillResult = await fillTaskPromise

  // Draft Guard 校验：旧任务被丢弃，绝不能恢复到 currentTask！
  assert.equal(fillResult, null)
  assert.equal(controller.getState().currentTask, null)
  assert.notEqual(controller.getState().currentTask?.result?.submitToken, 'old_stale_token_from_past')
})

test('PublishController: 执行 submit 期间严格禁止修改 draft', async () => {
  const api = new MockBridgeApi()
  let resolveSubmit: (val: any) => void
  const submitPromise = new Promise((r) => {
    resolveSubmit = r
  })

  api.respond(CommandTypes.PUBLISH_SUBMIT, () => submitPromise)

  const controller = new PublishController({ api })
  await controller.loadDraft({
    source: 'feishu',
    recordId: 'rec_submitting_prod',
    title: '正在提交中的商品',
    price: 88,
  })

  // 设置为 waiting_confirmation 并赋予合法令牌
  controller.setCurrentTask({
    id: 'task_to_submit_now',
    type: 'publish',
    status: 'waiting_confirmation',
    progress: 100,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payload: { itemId: 'rec_submitting_prod' },
    result: { submitToken: 'valid_token_123' },
  } as PublishTask)

  // 触发发布提交（处于异步提交中）
  const submitTaskPromise = controller.submitPublish('task_to_submit_now')
  assert.equal(controller.getState().submittingTaskId, 'task_to_submit_now')

  // 尝试在提交执行中修改草稿 -> 必须被严格拦截！
  controller.updateDraftField({ title: '试图在提交中篡改标题' })
  assert.equal(controller.getState().editingDraft?.title, '正在提交中的商品')

  // 提交完成
  resolveSubmit!({
    id: 'task_to_submit_now',
    outcome: 'submitted',
    deterministic: true,
    task: { id: 'task_to_submit_now', status: 'completed' },
    message: '发布成功',
  })

  await submitTaskPromise
  assert.equal(controller.getState().submittingTaskId, null)
})

test('PublishController: submitOutcome 仅 state === "submitted" 成功，in_progress 锁定不能重试，跨刷新保持不成功', async () => {
  const api = new MockBridgeApi()

  let currentServerTask: PublishTask = {
    id: 'task_in_progress_1',
    type: 'publish',
    status: 'waiting_confirmation',
    progress: 100,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    payload: { itemId: 'item_1' },
    meta: { submitAttempted: true },
    result: {
      submitToken: 'token_abc',
      submit: {
        state: 'in_progress',
        attemptedAt: Date.now(),
      },
    },
  } as unknown as PublishTask

  api.respond(CommandTypes.PUBLISH_GET, () => ({
    task: currentServerTask,
  }))

  const controller = new PublishController({ api })

  // 1. 初始化置入带有 in_progress submit 记录的任务
  controller.setCurrentTask(currentServerTask)
  // 手动触发一次从后台 getTask 跨刷新同步
  const refreshed = await controller.getTask('task_in_progress_1')
  assert.ok(refreshed)

  const state1 = controller.getState()
  // 必须是 in_progress，绝不能被误判为 submitted！
  assert.equal(state1.submitOutcome?.outcome, 'in_progress')
  assert.notEqual(state1.submitOutcome?.outcome, 'submitted')

  // 2. 再次尝试调用 submitPublish -> 必须因为已是 in_progress 派发中而被严格阻断锁定，不能重复提交！
  const blockedSubmit = await controller.submitPublish('task_in_progress_1')
  assert.equal(blockedSubmit, null)
  assert.equal(controller.getState().action.phase, 'failed')
  assert.ok(controller.getState().action.error?.title.includes('该任务已派发过提交'))

  // 3. 跨刷新（多次 loadTasks / getTask）：后台仍为 in_progress 时，跨刷新保持不成功
  await controller.getTask('task_in_progress_1')
  const state2 = controller.getState()
  assert.equal(state2.submitOutcome?.outcome, 'in_progress')
  assert.notEqual(state2.submitOutcome?.outcome, 'submitted')

  // 4. 直到后台状态明确更新为 submitted 时，刷新才变更为 submitted 成功
  currentServerTask = {
    ...currentServerTask,
    status: 'completed',
    result: {
      ...currentServerTask.result,
      submit: {
        state: 'submitted',
        attemptedAt: Date.now(),
      },
    },
  } as unknown as PublishTask
  await controller.getTask('task_in_progress_1')
  const state3 = controller.getState()
  assert.equal(state3.submitOutcome?.outcome, 'submitted')
})

test('computeFinalPublishItem: 封面与多图同步，不重复旧封面，首图正确', () => {
  // 1. 只有 coverUrl：首图为封面
  const item1 = computeFinalPublishItem({
    coverUrl: 'https://img.example.com/cover1.jpg',
  })
  assert.equal(item1.coverUrl, 'https://img.example.com/cover1.jpg')
  assert.deepEqual(item1.images, ['https://img.example.com/cover1.jpg'])

  // 2. 同时有 coverUrl 与 imageUrls：封面置于首图，去重且不重复保留旧封面
  const item2 = computeFinalPublishItem({
    coverUrl: 'https://img.example.com/new_cover.jpg',
    imageUrls: ['https://img.example.com/detail_1.jpg', 'https://img.example.com/new_cover.jpg'],
  })
  assert.equal(item2.coverUrl, 'https://img.example.com/new_cover.jpg')
  assert.deepEqual(item2.images, [
    'https://img.example.com/new_cover.jpg',
    'https://img.example.com/detail_1.jpg',
  ])

  // 3. 修改首图或只有多图列表：封面同步为 images[0]
  const item3 = computeFinalPublishItem({
    imageUrls: ['https://img.example.com/first.jpg', 'https://img.example.com/second.jpg'],
  })
  assert.equal(item3.coverUrl, 'https://img.example.com/first.jpg')
  assert.equal(item3.images[0], 'https://img.example.com/first.jpg')
})

test('computeFinalPublishItem: 标题与描述前后缀正确拼接并支持字数截断', () => {
  const item = computeFinalPublishItem(
    {
      title: '99新 苹果手机 iPhone 15 Pro Max',
      desc: '自用无拆修，电池健康 98%',
    },
    {
      titlePrefix: '【包邮秒发】',
      titleSuffix: ' [官方正品]',
      descPrefix: '【卖家说明】',
      descSuffix: ' 欢迎验机！',
    },
  )

  assert.equal(item.title, '【包邮秒发】99新 苹果手机 iPhone 15 Pro Max [官方正品]')
  assert.equal(item.desc, '【卖家说明】自用无拆修，电池健康 98% 欢迎验机！')

  // 标题 60 字截断
  const longItem = computeFinalPublishItem(
    { title: 'A'.repeat(80) },
    { titlePrefix: '前缀', titleSuffix: '后缀' },
  )
  assert.equal(longItem.title.length, 60)
  assert.ok(longItem.title.startsWith('前缀'))
})

test('computeFinalPublishItem: 编辑价作为基准乘 mult + markup，原价缺失回退*5且不得小于最终售价', () => {
  // 1. mult 与 markup 正常运算：编辑价 100 * 1.2 + 5 = 125.00
  const item1 = computeFinalPublishItem(
    { price: 100 },
    { priceMultiplier: 1.2, priceMarkup: 5 },
  )
  assert.equal(item1.price, 125)
  // 原价缺失：自动按最终售价 * 5 回退（125 * 5 = 625）
  assert.equal(item1.originalPrice, 625)

  // 2. 用户显式编辑了原价（有效且大于售价）
  const item2 = computeFinalPublishItem(
    { price: 100, originalPrice: 300 },
    { priceMultiplier: 1.0, priceMarkup: 0 },
  )
  assert.equal(item2.price, 100)
  assert.equal(item2.originalPrice, 300)

  // 3. 用户编辑的原价小于最终售价（例如特意填小了或者加价后超过原价）：最终原价不得小于售价
  const item3 = computeFinalPublishItem(
    { price: 100, originalPrice: 80 },
    { priceMultiplier: 1.5, priceMarkup: 0 },
  )
  assert.equal(item3.price, 150)
  // 80 小于售价 150，必须回退取不小于售价的值（即 150）
  assert.equal(item3.originalPrice, 150)
})

test('PublishController.createAndFillTask: override 只传最终计算值，所见即所发，不双加', async () => {
  const api = new MockBridgeApi()
  let capturedPayload: any = null

  api.respond(CommandTypes.PUBLISH_CREATE, (payload: any) => {
    capturedPayload = payload
    return {
      task: {
        id: 'task_unified_calc_1',
        type: 'publish',
        status: 'pending',
        progress: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        payload,
      },
    }
  })

  api.respond(CommandTypes.PUBLISH_FILL_FORM, () => ({
    task: {
      id: 'task_unified_calc_1',
      type: 'publish',
      status: 'waiting_confirmation',
      progress: 100,
      result: { submitToken: 'token_calc_ready' },
    },
  }))

  const controller = new PublishController({ api })

  await controller.loadDraft({
    source: 'my_published',
    itemId: 'item_calc_check',
    title: '富士相机',
    desc: '一手自用',
    price: 1000,
    coverUrl: 'https://img.example.com/cam.jpg',
  })

  // 设置规则：乘 1.1 加 50，并带前后缀
  controller.updateCustomRule({
    priceMultiplier: 1.1,
    priceMarkup: 50,
    titlePrefix: '【专柜】',
    titleSuffix: ' [自提]',
    descPrefix: '【详情】',
  })

  // 执行填表
  await controller.createAndFillTask()

  assert.ok(capturedPayload)
  // 最终售价：1000 * 1.1 + 50 = 1150
  assert.equal(capturedPayload.override.price, 1150)
  // 原价缺失：1150 * 5 = 5750
  assert.equal(capturedPayload.override.originalPrice, 5750)
  // 标题带前后缀：
  assert.equal(capturedPayload.override.title, '【专柜】富士相机 [自提]')
  // 描述带前缀：
  assert.equal(capturedPayload.override.desc, '【详情】一手自用')
  // 封面首图正确：
  assert.deepEqual(capturedPayload.override.images, ['https://img.example.com/cam.jpg'])
  // 关键验证：rule 传空对象，避免后端二次加价或二次追加前后缀（不双加）
  assert.deepEqual(capturedPayload.rule, {})
})

test('stripUnicodeEmoji / containsUnicodeEmoji: 清理 emoji 且保留中文、数字与标点', () => {
  assert.equal(containsUnicodeEmoji('全新 99新 iPhone 😀'), true)
  // 中文、数字与标点不会被误伤
  assert.equal(containsUnicodeEmoji('全新 99新 iPhone【包邮】！'), false)
  assert.equal(containsUnicodeEmoji(''), false)
  assert.equal(containsUnicodeEmoji(null), false)

  assert.equal(stripUnicodeEmoji('全新😀 99新🎉 iPhone【包邮】！'), '全新 99新 iPhone【包邮】！')
  // 国旗 / 肤色修饰 / ZWJ 组合序列均可清理
  assert.equal(stripUnicodeEmoji('a🇨🇳b👍🏽c👨👩👧d'), 'abcd')
  assert.equal(stripUnicodeEmoji(''), '')
  assert.equal(stripUnicodeEmoji(null), '')
})

test('computeFinalPublishItem: 标题与描述统一清理 emoji（preview = send），保留中文数字标点', () => {
  const item = computeFinalPublishItem({
    title: '全新😀iPhone 15【包邮】🎉',
    desc: '自用👍无拆修，电池 98%！',
  })
  assert.equal(item.title, '全新iPhone 15【包邮】')
  assert.equal(item.desc, '自用无拆修，电池 98%！')
})

test('PublishController.createAndFillTask: 含 emoji 的标题/描述在 override 中被清理（preview = send）', async () => {
  const api = new MockBridgeApi()
  let capturedPayload: any = null

  api.respond(CommandTypes.PUBLISH_CREATE, (payload: any) => {
    capturedPayload = payload
    return {
      task: {
        id: 'task_emoji_1',
        type: 'publish',
        status: 'pending',
        progress: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        payload,
      },
    }
  })
  api.respond(CommandTypes.PUBLISH_FILL_FORM, () => ({
    task: {
      id: 'task_emoji_1',
      type: 'publish',
      status: 'waiting_confirmation',
      progress: 100,
      result: { submitToken: 'token_emoji' },
    },
  }))

  const controller = new PublishController({ api })
  await controller.loadDraft({
    source: 'my_published',
    itemId: 'item_emoji',
    title: '全新😀iPhone 15',
    desc: '自用🎉无拆修',
    price: 1000,
    coverUrl: 'https://img.example.com/a.jpg',
  })

  await controller.createAndFillTask()

  assert.ok(capturedPayload)
  assert.equal(capturedPayload.override.title, '全新iPhone 15')
  assert.equal(capturedPayload.override.desc, '自用无拆修')
})

test('PublishController.executeConfirmedPublish: fill 阶段分类不支持 → 明确提示、绝不提交（no-submit-on-error）', async () => {
  const api = new MockBridgeApi()
  api.respond(CommandTypes.PUBLISH_CREATE, (payload: any) => ({
    task: {
      id: 'task_cat_1',
      type: 'publish',
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      payload,
    },
  }))
  api.respond(CommandTypes.PUBLISH_FILL_FORM, () => {
    throw new CommandError(
      'INTERNAL',
      '官方发布页当前阻断（页面提示）：当前分类不支持网页端发布',
      undefined,
      undefined,
      'PUBLISH_CATEGORY_UNSUPPORTED',
    )
  })

  const controller = new PublishController({ api })
  await controller.loadDraft({
    source: 'my_published',
    itemId: 'item_cat',
    title: '商品标题',
    desc: '商品描述',
    price: 100,
    coverUrl: 'https://img.example.com/a.jpg',
  })

  const res = await controller.executeConfirmedPublish()
  assert.equal(res, null)
  const action = controller.getState().action
  assert.equal(action.phase, 'failed')
  assert.ok(action.error?.hint.includes('分类不支持'))
  // no-submit-on-error：fill 阻断后绝不调用 PUBLISH_SUBMIT（不自动重试 / 绕过）
  assert.equal(api.calls.filter((c) => c.type === CommandTypes.PUBLISH_SUBMIT).length, 0)
})

test('最小定位红测试：商品源 images 正确进入 computeFinalPublishItem preview 与 controller 草稿编辑', () => {
  // 1. 商品对象仅有 images 字段（Product 规范，无 imageUrls 属性）
  const productWithImages = {
    itemId: 'item_multi_images',
    title: '多图测试商品',
    desc: '详细描述内容',
    price: '99.00',
    priceNumber: 99,
    coverUrl: 'https://img.example.com/cover.jpg',
    images: [
      'https://img.example.com/cover.jpg',
      'https://img.example.com/detail1.jpg',
      'https://img.example.com/detail2.jpg',
    ],
  }

  // computeFinalPublishItem 必须读出所有 images
  const preview = computeFinalPublishItem(productWithImages)
  assert.equal(preview.images.length, 3, '预览必须读出 Product.images 中的全部 3 张图')
  assert.deepEqual(preview.images, [
    'https://img.example.com/cover.jpg',
    'https://img.example.com/detail1.jpg',
    'https://img.example.com/detail2.jpg',
  ])

  // 2. controller 选中该商品并更新图片（模拟前端 onAddImage）
  const controller = new PublishController({ api: new MockBridgeApi() })
  controller.selectProduct('item_multi_images')
  ;(controller as any).patch({
    products: { phase: 'ready', items: [productWithImages], error: null },
    selectedProduct: productWithImages,
  })

  // 用户追加第 4 张图
  const newImg = 'https://img.example.com/detail3.jpg'
  controller.updateDraftField({
    imageUrls: [...preview.images, newImg],
  })

  const draft = controller.getState().editingDraft
  assert.equal(draft?.imageUrls.length, 4, '草稿必须保留原始 3 张图并追加第 4 张图')

  // 3. 删除首图必须同步 coverUrl，并且 computeFinalPublishItem 不得重新复活旧首图
  controller.updateDraftField({
    imageUrls: draft!.imageUrls.slice(1),
    coverUrl: draft!.imageUrls[1],
  })
  const updatedDraft = controller.getState().editingDraft!
  assert.equal(updatedDraft.coverUrl, 'https://img.example.com/detail1.jpg', 'coverUrl 必须同步为下一张')
  assert.equal(updatedDraft.imageUrls.length, 3)

  // 预览必须不含旧首图 cover.jpg
  const finalPreview = computeFinalPublishItem(updatedDraft)
  assert.equal(finalPreview.coverUrl, 'https://img.example.com/detail1.jpg')
  assert.ok(!finalPreview.images.includes('https://img.example.com/cover.jpg'), '旧首图绝不能在 preview 中复活')
})
