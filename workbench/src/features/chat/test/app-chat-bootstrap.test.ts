/**
 * 应用级聊天运行时准备与自动同步单测。
 *
 * 覆盖：
 * 1. 启动准备：一次性调用 CHAT_RUNTIME_PREPARE；
 * 2. 成功后同步：准备成功后自动调用 CHAT_SYNC_CONVERSATIONS，并通知会话页；
 * 3. 失败状态流转：统一状态展示覆盖连接中、已连接、连接失败、闲鱼未登录、需要验证码；
 * 4. 并发锁：避免重复挂载/热更新重复创建与重复同步；
 * 5. 聊天页不再渲染顶部红框与手动同步说明/失败详情，显式刷新平台最近记录。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CommandTypes } from '@fishops/shared'
import { useBridgeStatus } from '../../../composables/useBridgeStatus'
import type { CommandPayloadMap, CommandResultMap } from '@fishops/shared'
import {
  AppChatBootstrapController,
  type BootstrapCommandType,
  type ChatBootstrapApi,
} from '../app-chat-bootstrap-controller'

class FakeBootstrapApi implements ChatBootstrapApi {
  readonly calls: Array<{ type: BootstrapCommandType; payload: unknown }> = []
  private readonly responders = new Map<BootstrapCommandType, (payload: unknown) => unknown | Promise<unknown>>()

  respond<T extends BootstrapCommandType>(type: T, responder: (payload: CommandPayloadMap[T]) => unknown | Promise<unknown>): void {
    this.responders.set(type, responder as (payload: unknown) => unknown | Promise<unknown>)
  }

  async call<T extends BootstrapCommandType>(type: T, payload: CommandPayloadMap[T]): Promise<CommandResultMap[T]> {
    this.calls.push({ type, payload })
    const responder = this.responders.get(type)
    if (!responder) throw new Error(`未配置 ${type} 的响应`)
    return (await responder(payload)) as CommandResultMap[T]
  }

  count(type: BootstrapCommandType): number {
    return this.calls.filter((c) => c.type === type).length
  }
}

// ---------------- 单元测试 ----------------

test('启动准备：应用级启动时调用 CHAT_RUNTIME_PREPARE，且状态展示为连接中', async () => {
  const api = new FakeBootstrapApi()
  let resolvePrepare!: (value: unknown) => void
  const preparePromise = new Promise((res) => {
    resolvePrepare = res
  })
  api.respond(CommandTypes.CHAT_RUNTIME_PREPARE, () => preparePromise)

  const controller = new AppChatBootstrapController({ api, inExtension: true })
  const { status } = useBridgeStatus()

  // 发起启动
  const bootstrapPromise = controller.bootstrap()

  // 处于 preparing 阶段，统一状态为 checking（连接中）
  assert.equal(controller.getState().phase, 'preparing')
  assert.equal(status.value.state, 'checking')
  assert.equal(api.count(CommandTypes.CHAT_RUNTIME_PREPARE), 1)
  assert.deepEqual(api.calls[0], {
    type: CommandTypes.CHAT_RUNTIME_PREPARE,
    payload: { purpose: 'chat' },
  })

  // 释放 promise 完成流程
  resolvePrepare({ ok: true })
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => ({ ok: true, added: 5, updated: 0 }))
  await bootstrapPromise
  controller.dispose()
})

test('成功后同步：CHAT_RUNTIME_PREPARE 成功后自动调用 CHAT_SYNC_CONVERSATIONS，并接入已连接状态', async () => {
  const api = new FakeBootstrapApi()
  api.respond(CommandTypes.CHAT_RUNTIME_PREPARE, () => ({
    ok: true,
    tabId: 101,
    tabCreated: false,
    platformReady: true,
    socketReady: true,
    userIdReady: true,
  }))
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => ({
    ok: true,
    added: 8,
    updated: 2,
  }))

  const controller = new AppChatBootstrapController({ api, inExtension: true })
  const { status } = useBridgeStatus()

  let syncNotified = false
  controller.onSyncCompleted(() => {
    syncNotified = true
  })

  await controller.bootstrap()

  // 验证调用顺序与次数
  assert.equal(api.count(CommandTypes.CHAT_RUNTIME_PREPARE), 1)
  assert.equal(api.count(CommandTypes.CHAT_SYNC_CONVERSATIONS), 1)
  assert.equal(api.calls[0].type, CommandTypes.CHAT_RUNTIME_PREPARE)
  assert.equal(api.calls[1].type, CommandTypes.CHAT_SYNC_CONVERSATIONS)

  // 验证状态变为 ready 且全局状态展示为 online（已连接）
  assert.equal(controller.getState().phase, 'ready')
  assert.equal(status.value.state, 'online')
  assert.equal(syncNotified, true, '必须触发自动同步完成回调以通知会话页')

  controller.dispose()
})

test('延迟挂载：同步完成后才注册的聊天页监听器立即触发缓存对账', async () => {
  const api = new FakeBootstrapApi()
  api.respond(CommandTypes.CHAT_RUNTIME_PREPARE, () => ({ ok: true }))
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => ({ ok: true, added: 1, updated: 0 }))

  const controller = new AppChatBootstrapController({ api, inExtension: true })
  await controller.bootstrap()

  let refreshCount = 0
  const unsubscribe = controller.onSyncCompleted(() => {
    refreshCount += 1
  })
  assert.equal(refreshCount, 1, '同步早于聊天页挂载时也必须触发一次本地缓存刷新')

  unsubscribe()
  controller.dispose()
})

test('会话同步失败：不标记完成，保留可见错误并允许后续重试成功', async () => {
  const api = new FakeBootstrapApi()
  api.respond(CommandTypes.CHAT_RUNTIME_PREPARE, () => ({ ok: true }))
  let syncAttempts = 0
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => {
    syncAttempts += 1
    return syncAttempts === 1
      ? { ok: false, error: { code: 'NO_SOCKET', message: '聊天 WebSocket 尚未建立' } }
      : { ok: true, added: 15, updated: 0 }
  })

  const controller = new AppChatBootstrapController({ api, inExtension: true })
  await controller.bootstrap()

  assert.equal(controller.getState().phase, 'error')
  assert.match(controller.getState().error ?? '', /WebSocket 尚未建立/)
  assert.equal(controller.isExecuted(), false)

  await controller.bootstrap(true)
  assert.equal(controller.getState().phase, 'ready')
  assert.equal(controller.isExecuted(), true)
  assert.equal(syncAttempts, 2)
  controller.dispose()
})

test('失败状态：闲鱼未登录（unauthorized）时接入统一状态，且绝不调用 CHAT_SYNC_CONVERSATIONS', async () => {
  const api = new FakeBootstrapApi()
  api.respond(CommandTypes.CHAT_RUNTIME_PREPARE, () => ({
    ok: false,
    tabId: null,
    tabCreated: false,
    platformReady: false,
    socketReady: false,
    userIdReady: false,
    error: {
      category: 'unauthorized',
      message: '闲鱼账号未登录，请先登录',
    },
  }))
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => {
    assert.fail('准备失败时不应调用 CHAT_SYNC_CONVERSATIONS')
  })

  const controller = new AppChatBootstrapController({ api, inExtension: true })
  const { status } = useBridgeStatus()

  await controller.bootstrap()

  assert.equal(controller.getState().phase, 'unauthorized')
  assert.equal(status.value.state, 'unauthorized')
  assert.ok(status.value.message?.includes('未登录'))
  assert.equal(api.count(CommandTypes.CHAT_SYNC_CONVERSATIONS), 0)

  controller.dispose()
})

test('失败状态：闲鱼需要验证码（captcha）时接入统一状态，且绝不调用 CHAT_SYNC_CONVERSATIONS', async () => {
  const api = new FakeBootstrapApi()
  api.respond(CommandTypes.CHAT_RUNTIME_PREPARE, () => ({
    ok: false,
    tabId: 102,
    tabCreated: false,
    platformReady: false,
    socketReady: false,
    userIdReady: false,
    error: {
      category: 'captcha',
      message: '触发闲鱼滑块验证码拦截',
    },
  }))
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => {
    assert.fail('准备失败时不应调用 CHAT_SYNC_CONVERSATIONS')
  })

  const controller = new AppChatBootstrapController({ api, inExtension: true })
  const { status } = useBridgeStatus()

  await controller.bootstrap()

  assert.equal(controller.getState().phase, 'captcha')
  assert.equal(status.value.state, 'captcha')
  assert.ok(status.value.message?.includes('验证码'))
  assert.equal(api.count(CommandTypes.CHAT_SYNC_CONVERSATIONS), 0)

  controller.dispose()
})

test('失败状态：连接失败（网络或未知异常）时接入 error 状态，且不发起会话同步', async () => {
  const api = new FakeBootstrapApi()
  api.respond(CommandTypes.CHAT_RUNTIME_PREPARE, () => {
    throw new Error('网络请求超时，无法连接 background')
  })
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => {
    assert.fail('准备抛错时不应调用 CHAT_SYNC_CONVERSATIONS')
  })

  const controller = new AppChatBootstrapController({ api, inExtension: true })
  const { status } = useBridgeStatus()

  await controller.bootstrap()

  assert.equal(controller.getState().phase, 'error')
  assert.equal(status.value.state, 'error')
  assert.ok(status.value.message?.includes('网络请求超时'))
  assert.equal(api.count(CommandTypes.CHAT_SYNC_CONVERSATIONS), 0)

  controller.dispose()
})

test('并发锁：多次并发调用 bootstrap() 时只发起一次准备与同步，复用同一 Promise', async () => {
  const api = new FakeBootstrapApi()
  let resolvePrepare!: (value: unknown) => void
  const prepareDeferred = new Promise((res) => {
    resolvePrepare = res
  })
  api.respond(CommandTypes.CHAT_RUNTIME_PREPARE, () => prepareDeferred)
  api.respond(CommandTypes.CHAT_SYNC_CONVERSATIONS, () => ({ ok: true, added: 1, updated: 0 }))

  const controller = new AppChatBootstrapController({ api, inExtension: true })

  // 模拟并发调用（如两个组件同时挂载或热更新触发）
  const call1 = controller.bootstrap()
  const call2 = controller.bootstrap()
  const call3 = controller.bootstrap()

  assert.equal(controller.isInFlight(), true, '并发锁应处于激活中')
  assert.equal(api.count(CommandTypes.CHAT_RUNTIME_PREPARE), 1, '并发调用只能触发 1 次命令')

  resolvePrepare({ ok: true })
  await Promise.all([call1, call2, call3])

  assert.equal(api.count(CommandTypes.CHAT_RUNTIME_PREPARE), 1)
  assert.equal(api.count(CommandTypes.CHAT_SYNC_CONVERSATIONS), 1)
  assert.equal(controller.isExecuted(), true)

  // 完成后再调用直接跳过
  await controller.bootstrap()
  assert.equal(api.count(CommandTypes.CHAT_RUNTIME_PREPARE), 1)
  assert.equal(api.count(CommandTypes.CHAT_SYNC_CONVERSATIONS), 1)

  controller.dispose()
})

test('非扩展环境：不发送任何命令，状态保持为 unavailable', async () => {
  const api = new FakeBootstrapApi()
  const controller = new AppChatBootstrapController({ api, inExtension: false })
  const { status } = useBridgeStatus()

  await controller.bootstrap()

  assert.equal(api.calls.length, 0, '非扩展环境严禁发起任何命令')
  assert.equal(status.value.state, 'unavailable')

  controller.dispose()
})

test('页面结构回归：ChatCenterPage 顶部不再渲染红框说明与手动同步失败详情，刷新显式同步平台最近记录', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const pagePath = resolve(here, '../../../pages/ChatCenterPage.vue')
  const pageSource = readFileSync(pagePath, 'utf8')

  // 1. 删除顶部红框说明区域（details 与说明文本）
  assert.ok(!pageSource.includes('同步与发送说明'), '顶部不得再渲染“同步与发送说明”')
  assert.ok(!pageSource.includes('banner__text'), '不得再渲染 banner__text 说明区域')
  assert.ok(!pageSource.includes('读取是只读的'), '不得再渲染只读说明长段落')

  // 2. 删除手动同步会话按钮与说明/失败详情
  assert.ok(!pageSource.includes('controller.syncConversations()'), '顶部不得再有手动同步会话按钮')
  assert.ok(!pageSource.includes('同步会话中…'), '顶部不得再有手动同步中状态文案')
  assert.ok(!pageSource.includes('读取聊天状态失败：'), '顶部不得再渲染红色失败详情块')

  // 3. 显式刷新平台最近记录；事件和发送完成仍走控制器内部本地缓存 refresh()
  assert.ok(pageSource.includes('title="同步最近平台记录"'), '按钮必须说明会同步平台最近记录')
  assert.ok(pageSource.includes('controller.syncRecent()'), '点击必须调用 controller.syncRecent()')
  assert.ok(pageSource.includes('controller.refresh()'), '内部事件仍保留只读本地缓存刷新')

  // 4. 接入自动同步完成监听
  assert.ok(pageSource.includes('getAppBootstrapController'), '必须接入应用级启动控制器')
  assert.ok(pageSource.includes('onSyncCompleted'), '必须监听自动同步完成并刷新最新本地缓存')
})
