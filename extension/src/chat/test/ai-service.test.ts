/**
 * ai-service.ts 单测：成功 / 非 2xx / 非法响应 / 超时 / 网络异常 / 未配置 key / 未启用视觉。
 * 全部使用假 fetch，绝不访问真实 AI API。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_AI_PROVIDER_CONFIG, type AiProviderConfig } from '../../../../shared/types/reply'
import { AiChatService, extractContent, type AiFetchInitLike, type AiHttpResponseLike } from '../ai-service'

const messages = [{ role: 'user', content: 'hi' } as const]

function provider(patch: Partial<AiProviderConfig> = {}): AiProviderConfig {
  return { ...DEFAULT_AI_PROVIDER_CONFIG, apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', ...patch }
}

function okResponse(payload: unknown): AiHttpResponseLike {
  return { ok: true, status: 200, json: async () => payload }
}

test('未配置 key → NO_API_KEY，且不发起请求', async () => {
  let called = false
  const service = new AiChatService({
    loadProvider: async () => provider({ apiKey: '' }),
    fetchImpl: async () => {
      called = true
      return okResponse({})
    },
  })
  const result = await service.completeText(messages)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'NO_API_KEY')
  assert.equal(called, false)
})

test('成功：返回 trim 后内容与模型', async () => {
  let capturedBody: Record<string, unknown> | null = null
  let capturedUrl = ''
  const service = new AiChatService({
    loadProvider: async () => provider(),
    fetchImpl: async (url, init: AiFetchInitLike) => {
      capturedUrl = url
      capturedBody = JSON.parse(init.body) as Record<string, unknown>
      return okResponse({ model: 'gpt-x', choices: [{ message: { content: '  你好  ' } }], usage: { total: 1 } })
    },
  })
  const result = await service.completeText(messages)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.content, '你好')
    assert.equal(result.model, 'gpt-x')
  }
  assert.equal(capturedUrl, 'https://api.example.com/v1/chat/completions')
  assert.equal(capturedBody?.['stream'], false)
})

test('思考模型：请求体关闭 enable_thinking', async () => {
  let body: Record<string, unknown> | null = null
  const service = new AiChatService({
    loadProvider: async () => provider({ model: 'qwen3-max' }),
    fetchImpl: async (_url, init: AiFetchInitLike) => {
      body = JSON.parse(init.body) as Record<string, unknown>
      return okResponse({ choices: [{ message: { content: 'ok' } }] })
    },
  })
  await service.completeText(messages)
  assert.equal(body?.['enable_thinking'], false)
})

test('非 2xx → HTTP_ERROR 并带状态码', async () => {
  const service = new AiChatService({
    loadProvider: async () => provider(),
    fetchImpl: async () => ({ ok: false, status: 401, statusText: 'Unauthorized', json: async () => ({ error: { message: 'bad key' } }) }),
  })
  const result = await service.completeText(messages)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'HTTP_ERROR')
    assert.equal(result.error.status, 401)
  }
})

test('非法响应（无 choices）→ INVALID_RESPONSE', async () => {
  const service = new AiChatService({
    loadProvider: async () => provider(),
    fetchImpl: async () => okResponse({ choices: [] }),
  })
  const result = await service.completeText(messages)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'INVALID_RESPONSE')
})

test('超时（abort）→ TIMEOUT', async () => {
  const service = new AiChatService({
    loadProvider: async () => provider({ timeoutMs: 10 }),
    // 计时器立即触发 abort；假 fetch 感知 signal 后抛 AbortError。
    setTimer: (fn) => {
      fn()
      return 0 as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: () => {},
    fetchImpl: async (_url, init: AiFetchInitLike) => {
      if ((init.signal as AbortSignal).aborted) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        throw error
      }
      return okResponse({ choices: [{ message: { content: 'ok' } }] })
    },
  })
  const result = await service.completeText(messages)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'TIMEOUT')
})

test('网络异常 → NETWORK', async () => {
  const service = new AiChatService({
    loadProvider: async () => provider(),
    fetchImpl: async () => {
      throw new Error('boom')
    },
  })
  const result = await service.completeText(messages)
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'NETWORK')
})

test('空 messages → INVALID_REQUEST', async () => {
  const service = new AiChatService({ loadProvider: async () => provider() })
  const result = await service.completeText([])
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'INVALID_REQUEST')
})

test('视觉接口保留但不调用网络，返回 UNSUPPORTED', async () => {
  let called = false
  const service = new AiChatService({
    loadProvider: async () => provider(),
    fetchImpl: async () => {
      called = true
      return okResponse({})
    },
  })
  const result = await service.analyzeImage({ imageUrl: 'https://img.example.com/a.png' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'UNSUPPORTED')
  assert.equal(called, false)
})

test('extractContent 边界', () => {
  assert.equal(extractContent({ choices: [{ message: { content: ' x ' } }] }), 'x')
  assert.equal(extractContent({ choices: [{ message: { content: '   ' } }] }), null)
  assert.equal(extractContent({}), null)
})
