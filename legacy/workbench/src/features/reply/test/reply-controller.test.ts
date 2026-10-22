import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandTypes, type CommandPayloadMap, type CommandResultMap, type CommandType } from '@fishops/shared'
import type { BridgeApi } from '../../shared/bridge-api'
import { ReplyController } from '../reply-controller'

function fixture(sendResult: Promise<unknown> = Promise.resolve({ ok: true })) {
  const calls: Array<{ type: CommandType; payload: unknown }> = []
  const api: BridgeApi = {
    async call<T extends CommandType>(type: T, payload: CommandPayloadMap[T]): Promise<CommandResultMap[T]> {
      calls.push({ type, payload })
      const result = type === CommandTypes.CHAT_GET_REPLY_SUGGESTION
        ? { ok: true, suggestion: { sessionId: 'session-1', content: '可以发货', messageId: 'message-1', ruleId: 'rule-1' } }
        : await sendResult
      return result as CommandResultMap[T]
    },
    on: () => () => {},
    resubscribe: () => {},
  }
  return { calls, controller: new ReplyController({ api }) }
}

test('选择会话和生成建议不会发送，显式点击即可采用建议', async () => {
  const { calls, controller } = fixture()
  controller.setSession('session-1')
  await controller.requestSuggestion()
  assert.deepEqual(calls.map(({ type }) => type), [CommandTypes.CHAT_GET_REPLY_SUGGESTION])
  assert.equal(await controller.applySuggestion('可以发货'), true)
  assert.equal(calls[1]?.type, CommandTypes.CHAT_APPLY_REPLY)
  controller.dispose()
})

test('手动发送无需开关，仍校验会话、买家和内容', async () => {
  const { calls, controller } = fixture()
  assert.equal(await controller.sendMessage('你好', 'buyer-1'), false)
  controller.setSession('session-1')
  assert.equal(await controller.sendMessage('你好', ' '), false)
  assert.equal(await controller.sendMessage(' ', 'buyer-1'), false)
  assert.equal(await controller.sendMessage('字'.repeat(2001), 'buyer-1'), false)
  assert.equal(calls.length, 0)
  assert.equal(await controller.sendMessage(' 你好 ', 'buyer-1'), true)
  assert.deepEqual(calls[0], {
    type: CommandTypes.CHAT_SEND_MESSAGE,
    payload: { sessionId: 'session-1', receiverId: 'buyer-1', content: '你好' },
  })
  controller.setSession('session-2')
  assert.equal(await controller.sendMessage('新会话', 'buyer-2'), true)
  controller.dispose()
})

test('发送中拒绝重复操作，切换会话后旧结果不覆盖新会话', async () => {
  let resolveSend!: (value: unknown) => void
  const pending = new Promise<unknown>((resolve) => { resolveSend = resolve })
  const { calls, controller } = fixture(pending)
  controller.setSession('session-1')
  const first = controller.sendMessage('你好', 'buyer-1')
  assert.equal(await controller.sendMessage('你好', 'buyer-1'), false)
  assert.equal(calls.length, 1)
  controller.setSession('session-2')
  resolveSend({ ok: true })
  assert.equal(await first, false)
  assert.equal(controller.getState().send.phase, 'idle')
  assert.equal(controller.getState().sessionId, 'session-2')
  controller.dispose()
})
