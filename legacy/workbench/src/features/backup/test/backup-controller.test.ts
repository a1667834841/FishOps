import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes } from '@fishops/shared'
import type { BridgeApi } from '../../shared/bridge-api'
import { BackupController } from '../backup-controller'

const saved = { fileName: 'backup.json', phase: 'saved', savedAt: 10, error: null }
function api(responder: (type: string) => unknown | Promise<unknown>): BridgeApi {
  return { async call(type) { return await responder(type) as never }, on() { return () => {} }, resubscribe() {} }
}
function deferred() {
  let resolve!: (v: unknown) => void
  const promise = new Promise(resolveFn => { resolve = resolveFn })
  return { promise, resolve }
}

test('轮询在卸载后取消；在途响应不更新已卸载状态', async context => {
  context.mock.timers.enable({ apis: ['setInterval'] })
  let calls = 0
  const late = deferred()
  const controller = new BackupController(api(() => { calls++; return late.promise }))
  controller.start()
  assert.equal(calls, 1)
  context.mock.timers.tick(5000)
  assert.equal(calls, 2)
  controller.dispose()
  const state = controller.getState()
  late.resolve(saved)
  await Promise.resolve(); await Promise.resolve()
  context.mock.timers.tick(10000)
  assert.equal(calls, 2)
  assert.equal(controller.getState(), state)
})

test('文件写入失败可重试，忙碌期间不重复派发', async () => {
  let failed = true
  let saves = 0
  const controller = new BackupController(api(type => {
    if (type === CommandTypes.DATA_BACKUP_SAVE) { saves++; if (failed) throw new Error('无法写入文件') }
    return saved
  }))
  await controller.save()
  assert.equal(controller.getState().error, '无法写入文件')
  failed = false
  await Promise.all([controller.save(), controller.save()])
  assert.equal(saves, 2)
  assert.equal(controller.getState().status?.phase, 'saved')
  assert.equal(controller.getState().error, null)
  controller.dispose()
})

test('旧轮询迟到不覆盖保存后的新状态', async () => {
  const old = deferred()
  let reads = 0
  const controller = new BackupController(api(type => type === CommandTypes.DATA_BACKUP_STATUS && ++reads === 1 ? old.promise : saved))
  const first = controller.refresh()
  await controller.save()
  old.resolve({ ...saved, phase: 'error', error: '旧状态' })
  await first
  assert.equal(controller.getState().status?.phase, 'saved')
  controller.dispose()
})
