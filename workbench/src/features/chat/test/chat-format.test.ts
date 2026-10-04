/**
 * chat-format 单测：HTTPS 校验、商品链接、关联商品/买家推导（不虚构数据）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildItemUrl,
  derivePeer,
  deriveItemContext,
  describeError,
  describeSyncError,
  formatShortTime,
  isoTime,
  messageAvatarUrl,
  messageDisplayText,
  peerAvatarUrl,
  safeHttpsUrl,
  socketStatusView,
} from '../chat-format'
import type { ChatMessage, Conversation } from '../types'

function conv(extra: Partial<Conversation> = {}): Conversation {
  return {
    sessionId: 's1',
    cid: 's1@goofish',
    peerUserName: '',
    lastMessage: '',
    lastMessageTime: 0,
    unreadCount: 0,
    sortIndex: 0,
    visible: true,
    ...extra,
  }
}

function msg(extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1',
    messageId: 'm1',
    sessionId: 's1',
    cid: 's1@goofish',
    senderId: '',
    senderName: '',
    receiverId: '',
    direction: 'in',
    kind: 'text',
    contentType: 1,
    content: '你好',
    createAt: 1,
    source: 'history',
    ...extra,
  }
}

test('safeHttpsUrl：只放行 https，拒绝 http / javascript / data / 带账号 / 非字符串', () => {
  assert.equal(safeHttpsUrl('https://img.alicdn.com/a.jpg'), 'https://img.alicdn.com/a.jpg')
  assert.equal(safeHttpsUrl('http://img.alicdn.com/a.jpg'), null)
  assert.equal(safeHttpsUrl('javascript:alert(1)'), null)
  assert.equal(safeHttpsUrl('data:text/html;base64,AAAA'), null)
  assert.equal(safeHttpsUrl('https://user:pw@evil.example/'), null)
  assert.equal(safeHttpsUrl('//evil.example/x'), null)
  assert.equal(safeHttpsUrl('not a url'), null)
  assert.equal(safeHttpsUrl(''), null)
  assert.equal(safeHttpsUrl(undefined), null)
  assert.equal(safeHttpsUrl(123), null)
})

test('buildItemUrl：合法 itemId 生成 https 链接，非法 itemId 不生成', () => {
  assert.equal(buildItemUrl('123456789'), 'https://www.goofish.com/item?id=123456789')
  assert.equal(buildItemUrl('a_b-1'), 'https://www.goofish.com/item?id=a_b-1')
  assert.equal(buildItemUrl('1&evil=1'), null)
  assert.equal(buildItemUrl('../../x'), null)
  assert.equal(buildItemUrl('<script>'), null)
  assert.equal(buildItemUrl(''), null)
  assert.equal(buildItemUrl('x'.repeat(65)), null)
  assert.equal(buildItemUrl(undefined), null)
})

test('deriveItemContext：没有 itemId 时返回 null，不虚构商品', () => {
  assert.equal(deriveItemContext(conv(), [msg()]), null)
  assert.equal(deriveItemContext(null, []), null)
})

test('deriveItemContext：只有 itemId 时仅返回 itemId 与链接，标题为 null', () => {
  const ctx = deriveItemContext(conv({ itemId: '9001' }), [msg()])
  assert.deepEqual(ctx, { itemId: '9001', itemTitle: null, url: 'https://www.goofish.com/item?id=9001' })
})

test('deriveItemContext：会话无 itemId 时取最新带 itemId 的消息，标题须与 itemId 匹配', () => {
  const ctx = deriveItemContext(conv(), [
    msg({ id: 'm1', itemId: '1', itemTitle: '旧商品' }),
    msg({ id: 'm2', itemId: '2', itemTitle: '新商品' }),
    msg({ id: 'm3' }),
  ])
  assert.equal(ctx?.itemId, '2')
  assert.equal(ctx?.itemTitle, '新商品')

  const mismatched = deriveItemContext(conv({ itemId: '3' }), [msg({ itemId: '1', itemTitle: '别的商品' })])
  assert.equal(mismatched?.itemTitle, null)
})

test('deriveItemContext：itemId 格式异常时仍显示 itemId 文本但 url 为 null', () => {
  const ctx = deriveItemContext(conv({ itemId: 'bad id!' }), [])
  assert.equal(ctx?.itemId, 'bad id!')
  assert.equal(ctx?.url, null)
})

test('derivePeer：优先会话信息，其次对方消息，都没有则为 null', () => {
  assert.deepEqual(derivePeer(conv({ peerUserName: '小明', peerUserId: '7' }), []), { name: '小明', userId: '7' })
  assert.deepEqual(
    derivePeer(null, [msg({ direction: 'out', senderName: '我' }), msg({ senderName: '买家A', senderId: '42' })]),
    { name: '买家A', userId: '42' },
  )
  assert.deepEqual(derivePeer(conv(), [msg({ direction: 'out', senderName: '我' })]), { name: null, userId: null })
})

test('messageDisplayText：正文为空时给出类型提示而不是空气泡', () => {
  assert.equal(messageDisplayText(msg({ content: '嗨' })), '嗨')
  assert.match(messageDisplayText(msg({ content: '  ', kind: 'voice' })), /语音/)
})

test('peerAvatarUrl：优先会话且仅放行 https，缺失时回退对方消息头像', () => {
  assert.equal(
    peerAvatarUrl(conv({ peerAvatarUrl: 'https://img.alicdn.com/a.jpg' }), []),
    'https://img.alicdn.com/a.jpg',
  )
  assert.equal(peerAvatarUrl(conv({ peerAvatarUrl: 'http://img.alicdn.com/a.jpg' }), []), null)
  assert.equal(peerAvatarUrl(conv({ peerAvatarUrl: 'https://user:pw@evil.example/a.png' }), []), null)
  // 会话无头像：取最近一条对方消息头像，忽略自己发出的消息
  assert.equal(
    peerAvatarUrl(conv(), [
      msg({ id: 'm1', senderAvatarUrl: 'https://img.alicdn.com/old.png' }),
      msg({ id: 'm2', direction: 'out', senderAvatarUrl: 'https://img.alicdn.com/mine.png' }),
      msg({ id: 'm3', senderAvatarUrl: 'https://img.alicdn.com/new.png' }),
    ]),
    'https://img.alicdn.com/new.png',
  )
  assert.equal(peerAvatarUrl(conv(), [msg({ senderAvatarUrl: 'javascript:alert(1)' })]), null)
})

test('messageAvatarUrl：仅返回通过校验的 https 地址', () => {
  assert.equal(messageAvatarUrl(msg({ senderAvatarUrl: 'https://img.alicdn.com/x.png' })), 'https://img.alicdn.com/x.png')
  assert.equal(messageAvatarUrl(msg({ senderAvatarUrl: 'http://img.alicdn.com/x.png' })), null)
  assert.equal(messageAvatarUrl(msg()), null)
})

test('时间格式化：无效 / 越界时间戳安全返回空值', () => {
  assert.equal(formatShortTime(0), '')
  assert.equal(formatShortTime(Number.NaN), '')
  assert.equal(formatShortTime(1e20), '')
  assert.equal(isoTime(1e20), undefined)
  assert.equal(isoTime(Number.POSITIVE_INFINITY), undefined)
  assert.equal(typeof isoTime(1700000000000), 'string')
})

test('错误文案与连接状态', () => {
  const error = Object.assign(new Error('boom'), { code: 'TIMEOUT' })
  assert.equal(describeError(error), 'TIMEOUT: boom')
  assert.equal(describeError(null), '未知错误')
  assert.equal(describeSyncError({ code: 'X', message: 'y' }), 'X: y')
  assert.equal(describeSyncError(undefined), '平台未返回失败原因')
  assert.equal(socketStatusView('open').tone, 'ok')
  assert.equal(socketStatusView(null).tone, 'neutral')
})
