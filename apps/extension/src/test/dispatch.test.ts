import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ExtensionStatus } from '../../../../packages/protocol/src/index.ts'
import { AccountTracker } from '../account.ts'
import { createDispatcher } from '../dispatch.ts'
import { ApiError } from '../errors.ts'
import { FakeEnv } from './fakes.ts'

describe('createDispatcher', () => {
  it('system.status 返回扩展状态，chatReady 固定为 null', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' }, tabCount: 2 })
    const dispatch = createDispatcher({ env, account: new AccountTracker(env) })

    const status = (await dispatch('system.status', {})) as ExtensionStatus
    assert.equal(status.extensionVersion, '0.2.0')
    assert.deepEqual(status.account, { userId: 'u1', nick: 'A' })
    assert.deepEqual(status.page, { present: true })
    assert.equal(status.chatReady, null)
  })

  it('没有闲鱼页面时 present 为 false', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' } })
    const dispatch = createDispatcher({ env, account: new AccountTracker(env) })

    const status = (await dispatch('system.status', {})) as ExtensionStatus
    assert.deepEqual(status.page, { present: false })
  })

  it('未知方法与 host 本地方法都返回 NOT_FOUND', async () => {
    const env = new FakeEnv()
    const dispatch = createDispatcher({ env, account: new AccountTracker(env) })

    for (const method of ['search.items', 'events.list', 'requests.list']) {
      await assert.rejects(
        () => dispatch(method, {}),
        (error: unknown) => {
          assert.ok(error instanceof ApiError)
          assert.equal(error.code, 'NOT_FOUND')
          return true
        },
      )
    }
  })

  it('参数含未知字段返回 BAD_REQUEST，params 缺省按空对象处理', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' } })
    const dispatch = createDispatcher({ env, account: new AccountTracker(env) })

    await assert.rejects(
      () => dispatch('system.status', { unexpected: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.code, 'BAD_REQUEST')
        return true
      },
    )
    assert.ok(await dispatch('system.status', undefined))
  })

  it('tabs 查询失败返回 INTERNAL 常量消息', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' }, tabsError: true })
    const dispatch = createDispatcher({ env, account: new AccountTracker(env) })

    await assert.rejects(
      () => dispatch('system.status', {}),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.code, 'INTERNAL')
        assert.equal(error.message, '标签页查询失败')
        return true
      },
    )
  })

  it('非 ApiError 归一化为常量中文消息，不泄漏内部细节', () => {
    const normalized = ApiError.from(new Error('cookie unb=secret 读取失败'))
    assert.equal(normalized.code, 'INTERNAL')
    assert.equal(normalized.message, '扩展内部错误')
  })
})
