/**
 * ai-prompt.ts / ai-service.ts 单测（Goal B）：
 * 多模态 messages 结构、无图纯文本、模板渲染、去重、诊断摘要、
 * provider thinking 适配、AI mock 成功 / 超时 / 非法响应。
 * 全部使用假 fetch，绝不访问真实 AI API；密钥均为虚构值。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatMessage } from '../../../../shared/types/chat'
import { DEFAULT_AI_PROVIDER_CONFIG, type AiProviderConfig, type AiChatMessage } from '../../../../shared/types/reply'
import { buildReplyMessages, renderUserPromptTemplate } from '../ai-prompt'
import { AiChatService, resolveProviderParams, type AiFetchInitLike, type AiHttpResponseLike } from '../ai-service'

function message(patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'k1',
    messageId: 'm1',
    sessionId: 's1',
    cid: 's1@goofish',
    senderId: 'buyer',
    senderName: '买家',
    receiverId: 'me',
    direction: 'in',
    kind: 'text',
    contentType: 1,
    content: '你好',
    createAt: 1000,
    source: 'realtime',
    ...patch,
  }
}

function provider(patch: Partial<AiProviderConfig> = {}): AiProviderConfig {
  return { ...DEFAULT_AI_PROVIDER_CONFIG, apiKey: 'sk-test', baseUrl: 'https://api.example.com/v1', ...patch }
}

function okResponse(payload: unknown): AiHttpResponseLike {
  return { ok: true, status: 200, json: async () => payload }
}

test('多模态：图片消息生成 OpenAI 兼容 parts', () => {
  const built = buildReplyMessages({
    history: [message({ content: '还有别的颜色吗', createAt: 1, direction: 'in' })],
    current: {
      messageId: 'm-cur',
      sessionId: 's1',
      senderId: 'buyer',
      receiverId: 'me',
      direction: 'in',
      content: '[图片]',
      kind: 'image',
      contentType: 2,
      imageUrl: 'https://img.example.com/a.png',
      createAt: 2,
    },
  })
  assert.equal(built.messages[0].role, 'system')
  const current = built.messages[built.messages.length - 1]
  assert.equal(current.role, 'user')
  assert.ok(Array.isArray(current.content))
  const parts = current.content as Array<{ type: string }>
  assert.equal(parts[0].type, 'text')
  assert.equal(parts[1].type, 'image_url')
  assert.equal(built.contextSummary.imageCount, 1)
  assert.equal(built.contextSummary.historyCount, 1)
})

test('无图：退化为纯文本字符串 content', () => {
  const built = buildReplyMessages({
    history: [message({ content: '在吗', createAt: 1 })],
    current: {
      messageId: 'm-cur',
      sessionId: 's1',
      senderId: 'buyer',
      receiverId: 'me',
      direction: 'in',
      content: '这个多少钱',
      createAt: 2,
    },
  })
  const current = built.messages[built.messages.length - 1]
  assert.equal(typeof current.content, 'string')
  assert.equal(current.content, '这个多少钱')
  assert.equal(built.contextSummary.imageCount, 0)
  // 最后一条历史与当前消息重复时不再追加。
  const dup = buildReplyMessages({
    history: [message({ content: '这个多少钱', createAt: 1 })],
    current: {
      messageId: 'm-cur',
      sessionId: 's1',
      senderId: 'buyer',
      receiverId: 'me',
      direction: 'in',
      content: '这个多少钱',
      createAt: 2,
    },
  })
  assert.equal(dup.messages.length, 2)
})

test('模板渲染：结构化上下文变量 + 脱敏', () => {
  const built = buildReplyMessages({
    history: [message({ content: '你好', createAt: 1, direction: 'out' })],
    current: {
      messageId: 'm-cur',
      sessionId: 's1',
      senderId: 'buyer',
      receiverId: 'me',
      direction: 'in',
      senderName: '张三',
      content: '我的电话 13812345678',
      createAt: 2,
    },
    itemDetail: { title: '二手相机', price: 1999, city: '杭州' },
    userPromptTemplate: '买家：{{senderName}}\n历史 {{historyCount}} 条\n{{history}}\n最新：{{content}}\n{{itemInfo}}',
  })
  const current = built.messages[built.messages.length - 1]
  assert.equal(typeof current.content, 'string')
  const text = current.content as string
  assert.ok(text.includes('买家：张三'))
  assert.ok(text.includes('历史 1 条'))
  assert.ok(text.includes('138****5678'))
  assert.ok(text.includes('二手相机'))
  assert.ok(built.contextSummary.hasItem)

  assert.equal(renderUserPromptTemplate('{{unknown}}|{{content}}', { content: 'ok' }), '|ok')
})

test('provider 适配：thinking / 采样参数按供应方区分', () => {
  assert.equal(resolveProviderParams('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen-max').enableThinking, false)
  assert.equal(resolveProviderParams('https://api.example.com/v1', 'qwen3-max').enableThinking, false)
  assert.equal(resolveProviderParams('https://api.deepseek.com/v1', 'deepseek-reasoner').supportsTemperature, false)
  assert.equal(resolveProviderParams('https://api.deepseek.com/v1', 'deepseek-chat').supportsTemperature, true)
  assert.equal(resolveProviderParams('https://api.openai.com/v1', 'gpt-4o-mini').provider, 'openai')
  assert.equal(resolveProviderParams('https://custom.example.com/v1', 'm').provider, 'custom')
})

test('ai-service：多模态 parts 原样进入请求体', async () => {
  let body: Record<string, unknown> | null = null
  const service = new AiChatService({
    loadProvider: async () => provider(),
    fetchImpl: async (_url, init: AiFetchInitLike) => {
      body = JSON.parse(init.body) as Record<string, unknown>
      return okResponse({ choices: [{ message: { content: '看到了' } }] })
    },
  })
  const messages: AiChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'text', text: '[图片]' }, { type: 'image_url', image_url: { url: 'https://img.example.com/a.png' } }] },
  ]
  const result = await service.completeText(messages)
  assert.equal(result.ok, true)
  const sent = (body?.['messages'] as unknown) as Array<{ content: unknown }>
  assert.ok(Array.isArray(sent[1].content))
  // 非思考模型默认发送 temperature。
  assert.equal(body?.['temperature'], 0.7)
})

test('ai-service：DeepSeek reasoner 不发送 temperature', async () => {
  let body: Record<string, unknown> | null = null
  const service = new AiChatService({
    loadProvider: async () => provider({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner' }),
    fetchImpl: async (_url, init: AiFetchInitLike) => {
      body = JSON.parse(init.body) as Record<string, unknown>
      return okResponse({ choices: [{ message: { content: 'ok' } }] })
    },
  })
  await service.completeText([{ role: 'user', content: 'hi' }])
  assert.equal(body?.['temperature'], undefined)
  assert.equal(body?.['enable_thinking'], undefined)
})

test('ai-service：非法响应 / 超时结构化', async () => {
  const invalid = new AiChatService({
    loadProvider: async () => provider(),
    fetchImpl: async () => okResponse({ choices: [] }),
  })
  const invalidResult = await invalid.completeText([{ role: 'user', content: 'hi' }])
  assert.equal(invalidResult.ok, false)
  if (!invalidResult.ok) assert.equal(invalidResult.error.code, 'INVALID_RESPONSE')

  const timedOut = new AiChatService({
    loadProvider: async () => provider({ timeoutMs: 10 }),
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
  const timeoutResult = await timedOut.completeText([{ role: 'user', content: 'hi' }])
  assert.equal(timeoutResult.ok, false)
  if (!timeoutResult.ok) assert.equal(timeoutResult.error.code, 'TIMEOUT')
})
