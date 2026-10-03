/**
 * 发布提交（PUBLISH_SUBMIT）· 命令登记 / 负载校验 / 路由 回归。
 *
 * 验证：
 * 1. 命令已在 CommandTypes 登记；
 * 2. 负载严格键白名单：必须 id + 非空 submitToken + confirm 字面 true；
 * 3. 路由到 publish deps；未接线回 INTERNAL。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, createCommand, isPublishSubmitPayload } from '@fishops/shared'
import { handleCommand } from '../message-router'

test('发布提交命令已登记', () => {
  assert.equal(CommandTypes.PUBLISH_SUBMIT, 'PUBLISH_SUBMIT')
})

test('isPublishSubmitPayload：必须 id + submitToken + confirm:true（严格键白名单）', () => {
  assert.equal(isPublishSubmitPayload({ id: 't1', submitToken: 'tok', confirm: true }), true)
  // 缺 confirm / confirm 非字面 true
  assert.equal(isPublishSubmitPayload({ id: 't1', submitToken: 'tok' }), false)
  assert.equal(isPublishSubmitPayload({ id: 't1', submitToken: 'tok', confirm: false }), false)
  assert.equal(isPublishSubmitPayload({ id: 't1', submitToken: 'tok', confirm: 'true' }), false)
  // id / token 为空
  assert.equal(isPublishSubmitPayload({ id: '', submitToken: 'tok', confirm: true }), false)
  assert.equal(isPublishSubmitPayload({ id: 't1', submitToken: '   ', confirm: true }), false)
  // 严格键白名单：不接受任意额外字段
  assert.equal(
    isPublishSubmitPayload({ id: 't1', submitToken: 'tok', confirm: true, itemId: 'evil' }),
    false,
  )
  assert.equal(isPublishSubmitPayload(null), false)
})

test('message-router：PUBLISH_SUBMIT 路由到 publish deps；未接线回 INTERNAL', async () => {
  const command = createCommand(CommandTypes.PUBLISH_SUBMIT, {
    id: 't1',
    submitToken: 'tok',
    confirm: true,
  })
  const baseDeps = {
    now: () => 1,
    workerStartedAt: 1,
    incrementPingCount: async () => 1,
    broadcast: () => 0,
    subscribe: (e: string[]) => e,
    unsubscribe: (e: string[]) => e,
  }

  const routed = await handleCommand(command, {
    ...baseDeps,
    publish: {
      handleCommand: async () => ({
        kind: 'response',
        protocol: 1,
        requestId: command.requestId,
        type: command.type,
        ok: true,
        result: { id: 't1', outcome: 'submitted', deterministic: true },
        respondedAt: 1,
      }),
    },
  } as never)
  assert.equal(routed.ok, true)
  assert.equal((routed.result as { outcome: string }).outcome, 'submitted')

  const notWired = await handleCommand(command, { ...baseDeps } as never)
  assert.equal(notWired.ok, false)
  assert.equal(notWired.error?.code, 'INTERNAL')
})
