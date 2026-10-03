/**
 * reply-context.ts 单测：上下文顺序 / 截断 / 商品字段白名单 / HTTPS 图片过滤去重限数量 /
 * 脱敏 / 无图退化纯文本。全部使用虚构数据，不访问真实网络、不包含真实密钥。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatMessage } from '../../../../shared/types/chat'
import { REPLY_CONTEXT_LIMITS, type ReplyIncomingMessage } from '../../../../shared/types/reply'
import {
  buildReplyContext,
  extractImageUrls,
  isAllowedImageUrl,
  maskSensitiveText,
  sanitizeContextContent,
} from '../reply-context'

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

function incoming(patch: Partial<ReplyIncomingMessage> = {}): ReplyIncomingMessage {
  return {
    messageId: 'm-cur',
    sessionId: 's1',
    senderId: 'buyer',
    receiverId: 'me',
    direction: 'in',
    content: '这个多少钱',
    createAt: 2000,
    senderName: '买家',
    ...patch,
  }
}

test('上下文：历史按 createAt 升序，当前消息在最后', () => {
  const ctx = buildReplyContext({
    history: [
      message({ id: 'k3', messageId: 'm3', content: '第三条', createAt: 3000 }),
      message({ id: 'k1', messageId: 'm1', content: '第一条', createAt: 1000 }),
      message({ id: 'k2', messageId: 'm2', content: '第二条', createAt: 2000, direction: 'out' }),
    ],
    current: incoming(),
  })
  assert.deepEqual(
    ctx.history.map((t) => t.content),
    ['第一条', '第二条', '第三条'],
  )
  assert.deepEqual(
    ctx.history.map((t) => t.role),
    ['user', 'assistant', 'user'],
  )
  assert.equal(ctx.current.content, '这个多少钱')
  assert.equal(ctx.current.role, 'user')
  assert.equal(ctx.summary.historyCount, 3)
  assert.equal(ctx.summary.hasItem, false)
})

test('上下文：历史条数上限触发截断', () => {
  const history = Array.from({ length: 5 }, (_, i) =>
    message({ id: `k${i}`, messageId: `m${i}`, content: `第${i}条`, createAt: i + 1 }),
  )
  const ctx = buildReplyContext({ history, current: incoming(), maxHistoryMessages: 2 })
  assert.equal(ctx.history.length, 2)
  assert.deepEqual(
    ctx.history.map((t) => t.content),
    ['第3条', '第4条'],
  )
  assert.equal(ctx.summary.truncated, true)
})

test('上下文：单条正文超过长度上限被截断', () => {
  const long = 'x'.repeat(REPLY_CONTEXT_LIMITS.maxContentLength + 50)
  const ctx = buildReplyContext({
    history: [message({ content: long, createAt: 1 })],
    current: incoming(),
  })
  assert.equal(ctx.history[0].content.length, REPLY_CONTEXT_LIMITS.maxContentLength)
  assert.equal(ctx.summary.truncated, true)
})

test('上下文：商品字段白名单，额外字段被丢弃、描述截断', () => {
  const ctx = buildReplyContext({
    history: [message({ createAt: 1 })],
    current: incoming(),
    item: {
      itemId: 'item-1',
      title: '二手相机',
      price: 1999,
      description: 'y'.repeat(REPLY_CONTEXT_LIMITS.maxItemDescriptionLength + 20),
      city: '杭州',
      // @ts-expect-error 白名单外字段不应进入上下文
      secretField: 'should-not-pass',
    },
  })
  assert.ok(ctx.item)
  assert.equal(ctx.item?.itemId, 'item-1')
  assert.equal(ctx.item?.title, '二手相机')
  assert.equal(ctx.item?.price, 1999)
  assert.equal(ctx.item?.city, '杭州')
  assert.equal(ctx.item?.description?.length, REPLY_CONTEXT_LIMITS.maxItemDescriptionLength)
  assert.ok(!('secretField' in (ctx.item ?? {})))
  assert.equal(ctx.summary.hasItem, true)
})

test('图片：只允许 HTTPS、去重、限长度、限数量', () => {
  const https = 'https://img.example.com/a.png'
  const urls = extractImageUrls(
    message({
      kind: 'image',
      contentType: 2,
      imageUrl: https,
      content: `${https} http://insecure.example.com/b.png https://img.example.com/a.png https://img.example.com/c-${'z'.repeat(3000)}.png`,
    }),
  )
  assert.deepEqual(urls, [https])
  assert.equal(isAllowedImageUrl('http://x/y.png'), false)
  assert.equal(isAllowedImageUrl('https://x/y.png'), true)
  assert.equal(isAllowedImageUrl(`https://x/${'a'.repeat(3000)}.png`), false)

  // 去重：imageUrl 与 content 为同一 URL 时只保留一条。
  const deduped = extractImageUrls(message({ kind: 'image', contentType: 2, imageUrl: https, content: https }))
  assert.deepEqual(deduped, [https])
})

test('图片：历史消息内嵌 JSON 结构可提取，且总量不超过上限', () => {
  const fromJson = message({
    contentType: 2,
    kind: 'image',
    content: JSON.stringify({ image: { pics: [{ url: 'https://img.example.com/history.png' }] } }),
    createAt: 1,
  })
  const ctx = buildReplyContext({
    history: [fromJson],
    current: incoming({ kind: 'image', contentType: 2, imageUrl: 'https://img.example.com/current.png', content: '[图片]' }),
  })
  assert.deepEqual(ctx.current.imageUrls, ['https://img.example.com/current.png'])
  assert.deepEqual(ctx.history[0].imageUrls, ['https://img.example.com/history.png'])
  assert.equal(ctx.summary.imageCount, 2)

  // 超过 maxImages 时总量封顶（当前优先）。
  const many = Array.from({ length: REPLY_CONTEXT_LIMITS.maxImages + 2 }, (_, i) => `https://img.example.com/${i}.png`)
  const limited = extractImageUrls(
    message({ kind: 'image', contentType: 2, content: JSON.stringify({ pics: many.map((url) => ({ url })) }) }),
  )
  assert.equal(limited.length, REPLY_CONTEXT_LIMITS.maxImages)
})

test('图片：总量超过上限时标记截断（当前消息优先）', () => {
  const history = Array.from({ length: 4 }, (_, i) =>
    message({
      id: `k${i}`,
      messageId: `m${i}`,
      kind: 'image',
      contentType: 2,
      content: '[图片]',
      imageUrl: `https://img.example.com/${i}.png`,
      createAt: i + 1,
    }),
  )
  const ctx = buildReplyContext({
    history,
    current: incoming({ kind: 'image', contentType: 2, imageUrl: 'https://img.example.com/cur.png', content: '[图片]' }),
  })
  assert.equal(ctx.summary.imageCount, REPLY_CONTEXT_LIMITS.maxImages)
  assert.equal(ctx.summary.truncated, true)
  assert.deepEqual(ctx.current.imageUrls, ['https://img.example.com/cur.png'])
})

test('图片：includeImages=false 时不携带任何图片，退化为纯文本', () => {
  const ctx = buildReplyContext({
    history: [message({ createAt: 1 })],
    current: incoming({ kind: 'image', contentType: 2, imageUrl: 'https://img.example.com/a.png', content: '[图片]' }),
    includeImages: false,
  })
  assert.deepEqual(ctx.current.imageUrls, [])
  assert.equal(ctx.summary.imageCount, 0)
  assert.equal(ctx.current.content, '[图片]')
})

test('脱敏：凭据特征与手机号中段被打码', () => {
  assert.equal(maskSensitiveText('token=abcdef123456'), 'token=[REDACTED]')
  assert.ok(maskSensitiveText('Authorization: Bearer abcdefghijklmnop').includes('[REDACTED]'))
  assert.ok(maskSensitiveText('key sk-abcdef123456').includes('[REDACTED_KEY]'))
  assert.equal(maskSensitiveText('联系 13812345678'), '联系 138****5678')

  const { text } = sanitizeContextContent('我的 apiKey: sk-live-abcdef123456 请查收')
  assert.ok(!text.includes('sk-live-abcdef123456'))
  assert.ok(text.includes('[REDACTED'))
})
