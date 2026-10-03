import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installRuntimeHost, respondToPlatformCall } from '../host-entry'
import type { HostWindowLike, PlatformMessageEvent } from '../host-entry'
import { PLATFORM_CHANNEL, PlatformMethods } from '../protocol'
import type { PlatformCallRequest } from '../protocol'
import type { RuntimeHost } from '../runtime-host'

function makeHost(): RuntimeHost {
  return {
    async handle(method: string) {
      return { method }
    },
    async handleCall(request: PlatformCallRequest) {
      return {
        channel: PLATFORM_CHANNEL,
        kind: 'platform-result',
        method: request.method,
        callId: request.callId,
        ok: true,
        result: { method: request.method },
      }
    },
    async handleUnknown() {
      return null
    },
  } as unknown as RuntimeHost
}

function makeWindow() {
  const listeners: Array<(event: PlatformMessageEvent) => void> = []
  const posted: Array<{ message: unknown; origin?: string }> = []
  const win: HostWindowLike = {
    addEventListener(_type, listener) {
      listeners.push(listener)
    },
    removeEventListener(_type, listener) {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    },
    postMessage(message, targetOrigin) {
      posted.push({ message, origin: targetOrigin })
    },
  }
  return { win, listeners, posted }
}

const platformCall = {
  channel: PLATFORM_CHANNEL,
  kind: 'platform-call' as const,
  method: PlatformMethods.PING as never,
  params: {} as never,
  callId: 'call_1',
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('respondToPlatformCall：非平台消息返回 null，平台消息返回响应', async () => {
  const host = makeHost()
  assert.equal(await respondToPlatformCall(host, { kind: 'command' }), null)

  const response = await respondToPlatformCall(host, platformCall)
  assert.equal(response?.ok, true)
})

test('installRuntimeHost：挂载 host、监听 message 并回发响应', async () => {
  const { win, listeners, posted } = makeWindow()
  const host = makeHost()
  const installed = installRuntimeHost(win, host, { selfWindow: win })

  assert.equal(win.__FISHOPS_PLATFORM_HOST__, host)
  assert.equal(listeners.length, 1)

  listeners[0]!({ data: platformCall, source: win, origin: 'https://www.goofish.com' })
  await flush()

  assert.equal(posted.length, 1)
  assert.equal((posted[0]!.message as { ok: boolean }).ok, true)
  assert.equal(posted[0]!.origin, 'https://www.goofish.com')

  installed.dispose()
  assert.equal(win.__FISHOPS_PLATFORM_HOST__, undefined)
  assert.equal(listeners.length, 0)
})

test('installRuntimeHost：忽略 source 不匹配的消息', async () => {
  const { win, listeners, posted } = makeWindow()
  const installed = installRuntimeHost(win, makeHost(), { selfWindow: win })

  listeners[0]!({ data: platformCall, source: { other: true }, origin: 'https://www.goofish.com' })
  await flush()

  assert.equal(posted.length, 0)
  installed.dispose()
})

test('installRuntimeHost：allowedOrigins 不匹配时忽略', async () => {
  const { win, listeners, posted } = makeWindow()
  const installed = installRuntimeHost(win, makeHost(), {
    selfWindow: win,
    allowedOrigins: ['https://www.goofish.com'],
  })

  listeners[0]!({ data: platformCall, source: win, origin: 'https://evil.example' })
  await flush()

  assert.equal(posted.length, 0)
  installed.dispose()
})

test('installRuntimeHost：非平台消息不产生响应', async () => {
  const { win, listeners, posted } = makeWindow()
  const installed = installRuntimeHost(win, makeHost(), { selfWindow: win })

  listeners[0]!({ data: { kind: 'command', type: 'PING' }, source: win, origin: 'https://www.goofish.com' })
  await flush()

  assert.equal(posted.length, 0)
  installed.dispose()
})
