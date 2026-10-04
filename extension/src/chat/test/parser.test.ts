/**
 * parser.ts 单元测试（纯 Node，虚构数据，不访问网络）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  classifyPayload,
  decodeChatData,
  decodeMessagePackBase64,
  extractAvatarUrl,
  parseHistoryMessageModel,
  parseWebSocketMessage,
} from '../parser'

const b64 = (text: string): string => Buffer.from(text, 'utf-8').toString('base64')

test('MessagePack 解码：简单 map', () => {
  // {"a": 1} => 0x81 0xa1 'a' 0x01
  const bytes = Buffer.from([0x81, 0xa1, 0x61, 0x01])
  assert.deepEqual(decodeMessagePackBase64(bytes.toString('base64')), { a: 1 })
})

test('decodeChatData：base64 JSON 文本', () => {
  const data = b64(JSON.stringify({ contentType: 1, text: { text: 'hi' } }))
  assert.deepEqual(decodeChatData(data), { contentType: 1, text: { text: 'hi' } })
})

test('decodeChatData：非法输入返回 null，不抛错', () => {
  assert.equal(decodeChatData('!!!'), null)
  assert.equal(decodeChatData(123), null)
})

test('实时文本消息解析', () => {
  const payload = {
    code: 200,
    body: {
      content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text: '你好' } })) } },
      extension: {
        senderUserId: '999',
        reminderTitle: '买家',
        reminderUrl: 'https://x?sid=123&itemId=456&peerUserId=999',
      },
      createAt: 1704067200000,
      messageId: 'm1',
    },
  }
  const res = parseWebSocketMessage(JSON.stringify(payload))
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.event.kind, 'message')
  assert.equal(res.event.messages.length, 1)
  const msg = res.event.messages[0]
  assert.equal(msg.content, '你好')
  assert.equal(msg.kind, 'text')
  assert.equal(msg.sessionId, '123')
  assert.equal(msg.itemId, '456')
  assert.equal(msg.messageId, 'm1')
  assert.equal(msg.source, 'realtime')
  assert.equal(msg.direction, 'in')
})

test('实时消息方向：发送者等于当前用户时为 out', () => {
  const payload = {
    body: {
      content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text: '我发的' } })) } },
      extension: { senderUserId: '999', reminderUrl: 'https://x?sid=123&peerUserId=999' },
      createAt: 1,
      messageId: 'm2',
    },
  }
  const res = parseWebSocketMessage(JSON.stringify(payload), { myUserId: '999' })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.event.messages[0].direction, 'out')
})

test('实时图片消息解析', () => {
  const imageJson = JSON.stringify({ contentType: 2, image: { pics: [{ url: 'https://img.example/1.jpg' }] } })
  const payload = {
    body: {
      content: { custom: { contentType: 2, data: b64(imageJson) } },
      extension: { senderUserId: '999', reminderUrl: 'https://x?sid=123' },
      createAt: 2,
      messageId: 'img1',
    },
  }
  const res = parseWebSocketMessage(JSON.stringify(payload))
  assert.equal(res.ok, true)
  if (!res.ok) return
  const msg = res.event.messages[0]
  assert.equal(msg.kind, 'image')
  assert.equal(msg.imageUrl, 'https://img.example/1.jpg')
})

test('syncPushPackage：对象型 + 字符串型混合', () => {
  const objectItem = {
    '1': { '10': { reminderContent: 'yo', reminderUrl: 'https://x?sid=888&itemId=1' }, '2': '999@goofish', '3': 'mid2', '5': 1700000000000 },
  }
  const stringItemB64 = b64(
    JSON.stringify({
      '1': {
        '10': { reminderContent: 'string-item', reminderUrl: 'https://x?sid=777' },
        '2': '999@goofish',
        '3': 'mid3',
        '5': 1700000000001,
      },
    }),
  )
  const payload = {
    code: 200,
    body: { syncPushPackage: { data: [{ data: objectItem }, { data: stringItemB64 }] } },
  }
  const res = parseWebSocketMessage(JSON.stringify(payload))
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.event.kind, 'sync')
  assert.equal(res.event.messages.length, 2)
  assert.deepEqual(
    res.event.messages.map((m) => m.sessionId).sort(),
    ['777', '888'],
  )
})

test('异常输入：非字符串 / 空 / 非 JSON', () => {
  const notString = parseWebSocketMessage(123)
  assert.equal(notString.ok, false)
  if (!notString.ok) assert.equal(notString.error.code, 'NOT_STRING')

  const empty = parseWebSocketMessage('   ')
  assert.equal(empty.ok, false)
  if (!empty.ok) assert.equal(empty.error.code, 'EMPTY_INPUT')

  const badJson = parseWebSocketMessage('{not json')
  assert.equal(badJson.ok, false)
  if (!badJson.ok) assert.equal(badJson.error.code, 'NOT_JSON')
})

test('心跳帧不静默为正常消息（标记 unknown）', () => {
  const res = parseWebSocketMessage(JSON.stringify({ code: 200 }))
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.event.kind, 'unknown')
  assert.equal(res.event.messages.length, 0)
  assert.ok((res.event.notes ?? []).length > 0)
})

test('解码失败的 sync 项：结构化提示，不抛错、不产生消息', () => {
  const payload = { code: 200, body: { syncPushPackage: { data: [{ data: '!!!not-base64!!!' }] } } }
  const res = parseWebSocketMessage(JSON.stringify(payload))
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.event.kind, 'sync')
  assert.equal(res.event.messages.length, 0)
  assert.ok((res.event.notes ?? []).some((n) => n.includes('DECODE_FAILED')))
})

test('classifyPayload：order / typing / system / message / unknown', () => {
  assert.equal(classifyPayload({ '3': { redReminder: '已发货' } }), 'order')
  assert.equal(classifyPayload({ '1': [{ '1': 'a@goofish' }] }), 'typing')
  assert.equal(classifyPayload({ '3': { systemNotice: { a: 1 } } }), 'system')
  assert.equal(classifyPayload({ '1': { '10': { reminderContent: 'hi' } } }), 'message')
  assert.equal(classifyPayload({}), 'unknown')
})

test('历史消息解析：文本与方向', () => {
  const model = {
    readStatus: 0,
    message: {
      messageId: 'h1',
      cid: '123@goofish',
      createAt: 1700000000000,
      content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text: '历史消息' } })) } },
      extension: { senderUserId: '999', reminderTitle: '买家', reminderUrl: 'https://x?itemId=456' },
    },
  }
  const incoming = parseHistoryMessageModel(model, { myUserId: '111' })
  assert.ok(incoming)
  assert.equal(incoming?.content, '历史消息')
  assert.equal(incoming?.direction, 'in')
  assert.equal(incoming?.source, 'history')
  assert.equal(incoming?.itemId, '456')

  const outgoing = parseHistoryMessageModel(model, { myUserId: '999' })
  assert.equal(outgoing?.direction, 'out')
})

test('历史消息解析：无内容返回 null', () => {
  const model = { message: { cid: '123@goofish', content: { custom: {} } } }
  assert.equal(parseHistoryMessageModel(model), null)
})

test('历史消息方向：发送者 UID 带 @goofish 后缀时按本体匹配当前用户（不误判为自己左侧）', () => {
  const model = {
    message: {
      messageId: 'h2',
      cid: '123@goofish',
      createAt: 1,
      content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text: '我发的' } })) } },
      extension: { senderUserId: '3004743608@goofish', reminderTitle: '我' },
    },
  }
  const mine = parseHistoryMessageModel(model, { myUserId: '3004743608' })
  assert.equal(mine?.senderId, '3004743608', '发送者 ID 应归一为去掉 @goofish 后缀的本体')
  assert.equal(mine?.direction, 'out')

  // 当前用户 ID 反向带后缀时也应正确判定。
  const alsoMine = parseHistoryMessageModel(model, { myUserId: '3004743608@goofish' })
  assert.equal(alsoMine?.direction, 'out')
})

test('实时消息方向：发送者 UID 带 @goofish 后缀时按本体匹配当前用户', () => {
  const payload = {
    body: {
      content: { custom: { contentType: 1, data: b64(JSON.stringify({ contentType: 1, text: { text: '我发的' } })) } },
      extension: { senderUserId: '3004743608@goofish', reminderUrl: 'https://x?sid=123&peerUserId=999' },
      createAt: 1,
      messageId: 'm3',
    },
  }
  const res = parseWebSocketMessage(JSON.stringify(payload), { myUserId: '3004743608' })
  assert.equal(res.ok, true)
  if (!res.ok) return
  assert.equal(res.event.messages[0].senderId, '3004743608')
  assert.equal(res.event.messages[0].direction, 'out')
})

test('头像字段：识别真实 logo 字段，且不把商品图当头像', () => {
  // 真实平台头像字段为 logo：mtop `idlemessage.pc.user.query` 的 data.userInfo.logo，
  // 以及 `idlemessage.pc.session.sync` 的 ownerInfo.logo / userInfo.logo。
  const avatar = 'https://img.alicdn.com/bao/uploaded/i2/O1CN01FdtcnZ1N8xK86vifa_!!0-mtopupload.jpg'
  assert.equal(extractAvatarUrl([{ logo: avatar }]), avatar)
  assert.equal(extractAvatarUrl([{ userInfo: { logo: avatar } }]), undefined) // 嵌套需由调用方展开

  // 商品封面 picUrl / 商品主图 itemMainPic 是商品图，绝不能当作头像。
  assert.equal(extractAvatarUrl([{ picUrl: 'https://img.alicdn.com/bao/uploaded/i3/x-0-fleamarket.jpg' }]), undefined)
  assert.equal(extractAvatarUrl([{ itemMainPic: 'https://img.alicdn.com/bao/uploaded/i3/x-0-xy_item.jpg' }]), undefined)
})
