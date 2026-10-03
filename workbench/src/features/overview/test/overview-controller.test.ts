import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, EventTypes } from '@fishops/shared'
import type { BridgeApi } from '../../shared/bridge-api'
import { OverviewController, overviewTasks, taskCounts } from '../overview-controller'

class FakeApi implements BridgeApi {
  calls: Array<{ type: string; payload: unknown }> = []
  handlers = new Map<string, Set<(payload: never) => void>>()
  responders = new Map<string, () => unknown | Promise<unknown>>([
    [CommandTypes.PRODUCT_LIST, () => ({ total: 12, products: [] })],
    [CommandTypes.CHAT_LIST_CONVERSATIONS, () => ({ conversations: [{ unreadCount: 0 }, { unreadCount: 4 }, { unreadCount: 1 }] })],
    [CommandTypes.TASK_LIST, () => ({ tasks: [task('a', 'capture', 'running', 10), task('b', 'analysis', 'failed', 30)] })],
    [CommandTypes.PUBLISH_LIST, () => ({ total: 1, tasks: [task('c', 'publish', 'waiting_confirmation', 20)] })],
  ])
  async call(type: string, payload: unknown): Promise<never> {
    this.calls.push({ type, payload })
    return await this.responders.get(type)!() as never
  }
  on(type: string, handler: (payload: never) => void): () => void {
    const handlers = this.handlers.get(type) ?? new Set()
    handlers.add(handler); this.handlers.set(type, handlers)
    return () => { handlers.delete(handler) }
  }
  resubscribe(): void {}
  emit(type: string): void { for (const handler of this.handlers.get(type) ?? []) handler({} as never) }
}
function task(id: string, type: string, status: string, updatedAt: number) {
  return { id, type, status, updatedAt, createdAt: 1, progress: 0, payload: {} }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('概览读取全量真实数据，未读按会话统计，独立发布记录加入排序', async () => {
  const api = new FakeApi()
  const controller = new OverviewController(api)
  await controller.refresh()
  const state = controller.getState()
  assert.equal(state.products.value, 12)
  assert.equal(state.conversations.value, 2)
  assert.deepEqual(taskCounts(state), { running: 1, failed: 1 })
  assert.deepEqual(overviewTasks(state).map((item) => item.id), ['b', 'c', 'a'])
  assert.equal((api.calls.find((call) => call.type === CommandTypes.TASK_LIST)!.payload as { limit?: number }).limit, undefined)
  assert.equal((api.calls.find((call) => call.type === CommandTypes.PUBLISH_LIST)!.payload as { limit?: number }).limit, undefined)
  assert.equal(api.calls.length, 4)
  controller.dispose()
})

test('部分源首次失败不冒充零，后续刷新失败保留已成功数据与时间', async () => {
  const api = new FakeApi()
  api.responders.set(CommandTypes.PUBLISH_LIST, () => { throw new Error('未连接') })
  const controller = new OverviewController(api)
  await controller.refresh()
  assert.equal(taskCounts(controller.getState()), null)
  assert.equal(controller.getState().conversations.value, 2)
  const products = controller.getState().products
  api.responders.set(CommandTypes.PRODUCT_LIST, () => { throw new Error('读取失败') })
  await controller.refresh()
  assert.equal(controller.getState().products.value, 12)
  assert.equal(controller.getState().products.updatedAt, products.updatedAt)
  assert.ok(controller.getState().products.error)
  controller.dispose()
})

test('发布结果被截断时不统计全量任务', async () => {
  const api = new FakeApi()
  api.responders.set(CommandTypes.PUBLISH_LIST, () => ({ total: 20, tasks: [] }))
  const controller = new OverviewController(api)
  await controller.refresh()
  assert.equal(taskCounts(controller.getState()), null)
  assert.ok(controller.getState().publish.error)
  controller.dispose()
})

test('迟到请求不会覆盖新响应，卸载后在途响应不写状态', async () => {
  const api = new FakeApi()
  const old = deferred<unknown>()
  api.responders.set(CommandTypes.PRODUCT_LIST, () => old.promise)
  const controller = new OverviewController(api)
  const first = controller.refresh()
  api.responders.set(CommandTypes.PRODUCT_LIST, () => ({ total: 99, products: [] }))
  await controller.refresh()
  old.resolve({ total: 1, products: [] }); await first
  assert.equal(controller.getState().products.value, 99)
  const late = deferred<unknown>()
  api.responders.set(CommandTypes.PRODUCT_LIST, () => late.promise)
  const final = controller.refresh()
  controller.dispose()
  const snapshot = controller.getState()
  late.resolve({ total: 100, products: [] }); await final
  assert.equal(controller.getState(), snapshot)
})

test('密集事件合并刷新，dispose 释放订阅并取消待刷新定时器', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const api = new FakeApi()
  const controller = new OverviewController(api)
  controller.start()
  await controller.refresh()
  const count = api.calls.length
  api.emit(EventTypes.TASK_CHANGED)
  api.emit(EventTypes.CHAT_CONVERSATION_UPDATED)
  api.emit(EventTypes.PUBLISH_TASK_CHANGED)
  context.mock.timers.tick(299)
  assert.equal(api.calls.length, count)
  context.mock.timers.tick(1)
  assert.equal(api.calls.length, count + 4)
  api.emit(EventTypes.TASK_CHANGED)
  controller.dispose()
  context.mock.timers.tick(500)
  assert.equal(api.calls.length, count + 4)
  assert.equal([...api.handlers.values()].reduce((sum, handlers) => sum + handlers.size, 0), 0)
})

test('非扩展环境无请求且指标不可用', async () => {
  const controller = new OverviewController(null)
  controller.start(); await controller.refresh()
  assert.equal(controller.getState().availability, 'unavailable')
  assert.equal(controller.getState().products.value, null)
  assert.equal(taskCounts(controller.getState()), null)
  controller.dispose()
})
