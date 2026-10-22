import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeChatSyncPage } from '../chat-sync-normalizer.ts'
import type { ChatSyncPageParams } from '../../../../packages/protocol/src/chat-sync.ts'
const cp: ChatSyncPageParams = { mode: 'conversations', anchor: '9007199254740991', limit: 20 }
const mp: ChatSyncPageParams = { mode: 'messages', sessionId: 'c', anchor: '9007199254740991', limit: 20 }
// 夹具形状依据 legacy history.ts 的 userConvs 和 parser.ts 的 message/content/custom。
const conv = () => ({ singleChatUserConversation: { cid: 'c@goofish', sortIndex: 100, modifyTime: 123 } })
const realConv = () => ({ type: 1, singleChatUserConversation: {
  visible: true, modifyTime: 123, redPoint: 0, joinTime: 0,
  singleChatConversation: { extension: {}, pairFirst: 'a', bizType: 1, msgReadStatusSetting: 0, createAt: 100, cid: 'c@goofish', pairSecond: 'p' },
  topRank: 0, muteNotification: false, user_extension: {},
} })
const model = () => ({ message: { messageId: 'm', cid: 'c@goofish', createAt: 123,
  extension: { senderUserId: 'p@goofish', reminderUrl: 'https://www.goofish.com/im?itemId=i&peerUserId=a' },
  content: { custom: { type: 1, summary: '你好' } } } })
const bad = (p: ChatSyncPageParams, body: unknown) => assert.throws(() => normalizeChatSyncPage(p, body, 'a'), { code: 'PAGE_NOT_READY' })
test('真实混合会话页的群聊计入未支持项，保留明确游标且不冒充单聊', () => {
  const group = { type: 2, groupChatUserConversation: {} }
  const r = normalizeChatSyncPage(cp, { userConvs: [realConv(), group], hasMore: 1, nextCursor: 90 }, 'a')
  assert.equal(r.mode, 'conversations')
  if (r.mode === 'conversations') assert.equal(r.conversations.length, 1)
  assert.equal(r.unsupportedCount, 1)
  assert.equal(r.nextAnchor, '90')
  const last = normalizeChatSyncPage(cp, { userConvs: [group], hasMore: 0, nextCursor: 0 }, 'a')
  assert.equal(last.unsupportedCount, 1)
  assert.equal(last.hasMore, false)
  bad(cp, { userConvs: [{ type: 2 }], hasMore: false })
  bad(cp, { userConvs: [{ type: 3 }], hasMore: false })
  bad(cp, { userConvs: [group], hasMore: true })
  bad(cp, { userConvs: [realConv(), group], hasMore: true })
})
test('无最后消息会话仍输出，时间和排序明确且输出白名单', () => {
  assert.deepEqual(normalizeChatSyncPage(cp, { userConvs: [conv()], hasMore: false, token: 'secret' }, 'a'), {
    mode: 'conversations', conversations: [{ sessionId: 'c', itemId: null, peerUserId: null, updatedAt: 123, sortIndex: '100' }], hasMore: false, nextAnchor: null, unsupportedCount: 0,
  })
})
test('历史平台ID、明确发送者时间及base64文本，peer排除自己', () => {
  const m = model()
  m.message.content.custom = { type: 1, summary: '摘要', ...{ data: btoa(JSON.stringify({ contentType: 1, text: { text: 'decoded' } })) } }
  const result = normalizeChatSyncPage(mp, { userMessageModels: [m], hasMore: false }, 'a')
  assert.equal(result.mode, 'messages')
  if (result.mode === 'messages') assert.deepEqual(result.messages, [{ sourceId: 'm', sessionId: 'c', senderId: 'p', text: 'decoded', sentAt: 123, itemId: 'i' }])
})
test('非文本计unsupported，坏ID时间结构及冲突ID整页失败', () => {
  const m = model(); m.message.content.custom.type = 2
  const r = normalizeChatSyncPage(mp, { userMessageModels: [m], nextCursor: 0 }, 'a')
  assert.equal(r.unsupportedCount, 1)
  for (const patch of [{ messageId: '' }, { messageId: Number.MAX_SAFE_INTEGER + 1 }, { createAt: -1 }, { cid: 'other@goofish' }, { content: {} }]) bad(mp, { userMessageModels: [{ message: { ...model().message, ...patch } }], hasMore: false })
  bad(mp, { userMessageModels: [model(), model()], hasMore: false })
  bad(cp, { userConvs: [{ singleChatUserConversation: { cid: 'c@goofish', sortIndex: 1 } }], hasMore: false })
})
test('分页不按条数猜结束，游标明确且严格推进', () => {
  bad(mp, { userMessageModels: [] })
  bad(mp, { userMessageModels: [], hasMore: true })
  bad(mp, { userMessageModels: [], nextCursor: '9007199254740991' })
  // 真实平台结束页仍回传最后时间作为 nextCursor；明确 hasMore=false 时以结束为准。
  assert.equal(normalizeChatSyncPage(cp, { userConvs: [], hasMore: false, nextCursor: 1 }, 'a').nextAnchor, null)
  assert.equal(normalizeChatSyncPage(cp, { userConvs: [conv()], hasMore: true }, 'a').nextAnchor, '100')
  assert.equal(normalizeChatSyncPage(mp, { userMessageModels: [], nextCursor: 5 }, 'a').hasMore, true)
})
test('条数、正文、body字节及畸形编码受限且错误脱敏', () => {
  bad(mp, { userMessageModels: Array(21).fill(model()), hasMore: false })
  bad(mp, { userMessageModels: [], hasMore: false, token: 'x'.repeat(524288) })
  bad(mp, '{secret')
  const m = model(); m.message.content.custom.summary = 'x'.repeat(20001)
  bad(mp, { userMessageModels: [m], hasMore: false })
  assert.throws(() => normalizeChatSyncPage(mp, { userMessageModels: [{ message: { ...model().message, content: { custom: { data: 'secret-invalid' } } } }], hasMore: false }, 'a'), e => !String(e).includes('secret'))
})
test('真实平台 hasMore=0 仍携带 nextCursor 时视为结束，fleamarket 链接可解析', () => {
  const m = model()
  m.message.extension.reminderUrl = 'fleamarket://message_chat?itemId=i&peerUserId=p'
  const r = normalizeChatSyncPage(mp, { userMessageModels: [m], hasMore: 0, nextCursor: 123 }, 'a')
  assert.equal(r.hasMore, false); assert.equal(r.nextAnchor, null)
  if (r.mode === 'messages') assert.equal(r.messages[0]!.itemId, 'i')
  // 未声明 hasMore 时，非零游标仍按分页证据处理，不能被静默丢弃。
  assert.equal(normalizeChatSyncPage(mp, { userMessageModels: [m], nextCursor: 100 }, 'a').hasMore, true)
})

test('平台超额页不能截断后沿用整页游标，避免静默漏同步', () => {
  const rows = [conv(), conv()]
  rows[1].singleChatUserConversation.cid = 'd@goofish'
  rows[1].singleChatUserConversation.sortIndex = 90
  bad({ ...cp, limit: 1 }, { userConvs: rows, hasMore: true, nextCursor: 80 })
  const models = [model(), model()]
  models[1].message.messageId = 'm2'
  bad({ ...mp, limit: 1 }, { userMessageModels: models, hasMore: false, nextCursor: 0 })
})

test('分页别名按归一化布尔值比较，真实冲突和非法值仍拒绝', () => {
  for (const [hasMore, hasNextPage] of [[1, true], [true, 1], [0, false], [false, 0]]) {
    const r = normalizeChatSyncPage(cp, { userConvs: [], hasMore, hasNextPage, nextCursor: 10 }, 'a')
    assert.equal(r.hasMore, Boolean(hasMore))
  }
  for (const [hasMore, hasNextPage] of [[1, false], [0, true], [false, '0'], [true, 2]]) {
    bad(cp, { userConvs: [], hasMore, hasNextPage, nextCursor: 10 })
  }
})

test('会话实体位于嵌套 singleChatConversation 时使用其 cid，并接受平台数字分页值', () => {
  const r = normalizeChatSyncPage(cp, {
    nextCursor: 1792313804319, userConvs: [realConv()], hasMore: 1,
  }, 'a')
  assert.equal(r.mode, 'conversations')
  if (r.mode === 'conversations') {
    assert.equal(r.conversations[0]!.sessionId, 'c')
    assert.equal(r.conversations[0]!.updatedAt, 123)
    assert.equal(r.hasMore, true)
    assert.equal(r.nextAnchor, '1792313804319')
  }
})
