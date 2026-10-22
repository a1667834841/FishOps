import assert from 'node:assert/strict'
import test from 'node:test'
import type { CommandEnvelope, ResponseEnvelope } from '@fishops/shared'
import { createBridgeApi, type RuntimeClientLike } from '../bridge-api'
import { CommandError, toErrorView } from '../error-format'

test('bridge-api: 后台返回 businessCode 时，CommandError 保留 businessCode', async () => {
  const mockClient: RuntimeClientLike = {
    transport: {
      async call(_cmd: CommandEnvelope): Promise<ResponseEnvelope> {
        return {
          kind: 'response',
          protocol: 1,
          requestId: 'req_1',
          type: 'PUBLISH_SUBMIT',
          ok: false,
          error: {
            code: 'INTERNAL',
            message: '未在发布页找到发布按钮',
            businessCode: 'SUBMIT_BUTTON_NOT_FOUND',
          },
          respondedAt: Date.now(),
        }
      },
    },
    on: () => () => {},
    subscribe: () => {},
  }

  const bridge = createBridgeApi(mockClient, { events: [], timeoutMs: 1000 })

  await assert.rejects(
    async () => {
      await bridge.call('PUBLISH_SUBMIT' as any, { id: 'task_1' } as any)
    },
    (err: unknown) => {
      assert.ok(err instanceof CommandError)
      assert.equal(err.code, 'INTERNAL')
      assert.equal(err.businessCode, 'SUBMIT_BUTTON_NOT_FOUND')
      return true
    },
  )
})

test('CommandError 与 toErrorView: 正确安全显示 businessCode，且保留 category / retCode', () => {
  // 1. 保留 category 与 retCode（不影响其它调用）
  const platformErr = new CommandError('PLATFORM_ERROR', '平台验证码拦截', 'captcha', 'RET_FAIL_SYS_USER_VALIDATE')
  const platformView = toErrorView(platformErr)
  assert.equal(platformView.kind, 'captcha')
  assert.equal(platformView.code, 'captcha / RET_FAIL_SYS_USER_VALIDATE')

  // 2. 携带 businessCode 时，展示业务错误码
  const bizErr = new CommandError(
    'INTERNAL',
    '未在发布页找到发布按钮',
    undefined,
    undefined,
    'SUBMIT_BUTTON_NOT_FOUND',
  )
  assert.equal(bizErr.businessCode, 'SUBMIT_BUTTON_NOT_FOUND')
  const bizView = toErrorView(bizErr)
  assert.equal(bizView.code, 'SUBMIT_BUTTON_NOT_FOUND')
  assert.equal(bizView.kind, 'unknown')

  // 3. 无 businessCode 时回退到 code
  const plainErr = new CommandError('TIMEOUT', '请求超时')
  const plainView = toErrorView(plainErr)
  assert.equal(plainView.code, 'TIMEOUT')
})
