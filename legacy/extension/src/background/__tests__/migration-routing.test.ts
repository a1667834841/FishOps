/**
 * 迁移命令接线回归：命令/事件已登记、受信载荷校验严格、路由到 migration deps。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandTypes,
  createCommand,
  EventTypes,
  isLegacyConfigTransfer,
  isMigrateLegacyConfigPayload,
} from '@fishops/shared'
import { handleCommand } from '../message-router'

test('MIGRATE_LEGACY_CONFIG / CHAT_REPLY_SUGGESTION_GENERATED 已登记', () => {
  assert.equal(CommandTypes.MIGRATE_LEGACY_CONFIG, 'MIGRATE_LEGACY_CONFIG')
  assert.equal(EventTypes.CHAT_REPLY_SUGGESTION_GENERATED, 'CHAT_REPLY_SUGGESTION_GENERATED')
})

test('isMigrateLegacyConfigPayload：严格白名单 + overwrite 需 confirm', () => {
  assert.equal(isMigrateLegacyConfigPayload({}), true)
  assert.equal(isMigrateLegacyConfigPayload({ dryRun: true }), true)
  assert.equal(isMigrateLegacyConfigPayload({ legacy: { ai: { apiKey: 'x' } } }), true)
  assert.equal(isMigrateLegacyConfigPayload({ confirm: true, overwrite: true }), true)
  // overwrite=true 但未 confirm → 非法（需二次确认）。
  assert.equal(isMigrateLegacyConfigPayload({ overwrite: true }), false)
  // 非法类型 / 隐藏字段。
  assert.equal(isMigrateLegacyConfigPayload({ confirm: 'yes' }), false)
  assert.equal(isMigrateLegacyConfigPayload({ secret: 'x' }), false)
  assert.equal(isMigrateLegacyConfigPayload({ legacy: { evil: 1 } }), false)
  assert.equal(isMigrateLegacyConfigPayload(null), false)
})

test('isLegacyConfigTransfer：分区字段白名单', () => {
  assert.equal(isLegacyConfigTransfer({}), true)
  assert.equal(isLegacyConfigTransfer({ ai: { baseUrl: 'https://x/v1', timeoutMs: 1000 } }), true)
  assert.equal(isLegacyConfigTransfer({ feishu: { appId: 'a', appSecret: 'b' } }), true)
  assert.equal(isLegacyConfigTransfer({ global: { blacklist: ['u1'] } }), true)
  // 分区未知键 / 非法类型拒绝。
  assert.equal(isLegacyConfigTransfer({ ai: { apiKey: 'x', extra: 1 } }), false)
  assert.equal(isLegacyConfigTransfer({ feishu: { appId: 1 } }), false)
  assert.equal(isLegacyConfigTransfer({ global: { defaultCooldown: -1 } }), false)
})

test('message-router：MIGRATE_LEGACY_CONFIG 路由到 migration deps；未接线回 INTERNAL', async () => {
  const command = createCommand(CommandTypes.MIGRATE_LEGACY_CONFIG, { dryRun: true })
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
    migration: {
      handleCommand: async () => ({
        kind: 'response',
        protocol: 1,
        requestId: command.requestId,
        type: command.type,
        ok: true,
        result: { mode: 'preview' },
        respondedAt: 1,
      }),
    },
  } as never)
  assert.equal(routed.ok, true)
  assert.deepEqual(routed.result, { mode: 'preview' })

  const notWired = await handleCommand(command, { ...baseDeps } as never)
  assert.equal(notWired.ok, false)
  assert.equal(notWired.error?.code, 'INTERNAL')
})
