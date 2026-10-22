/**
 * send-protocol.ts 单测：mid/uuid 格式、base64 文本编码、发送信封构造与校验。
 * 纯 Node，不发送任何消息、不接触真实 socket。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SEND_LWP_ROUTE, OUTER_CONTENT_TYPE, TEXT_CONTENT_TYPE } from '../../../../shared/types/reply'
import { validateAllowedLwpRequest } from '../socket-transport'
import {
  buildSendMessageLwpRequest,
  decodeTextContent,
  encodeTextContent,
  generateSendMid,
  generateSendUuid,
  validateSendInput,
  validateSendLwpRequest,
} from '../send-protocol'

const baseParams = {
  sessionId: 's1',
  receiverId: 'peer1',
  myId: 'me1',
  content: '你好',
  mid: generateSendMid(1700000000000, 0.5),
  uuid: generateSendUuid(1700000000000, 0.25),
}

test('mid / uuid 格式与旧实现一致', () => {
  assert.match(generateSendMid(1700000000000, 0.5), /^\d{1,3}1700000000000 0$/)
  assert.equal(generateSendMid(1700000000000, 0), '01700000000000 0')
  assert.match(generateSendUuid(1700000000000, 0.25), /^-1700000000000\d{1,4}$/)
  assert.equal(generateSendUuid(1700000000000, 0), '-17000000000000')
})

test('文本内容按 contentType:1 + UTF-8 base64 编码，可往返', () => {
  const encoded = encodeTextContent('中文🙂 换行\n')
  // 外层应能 base64 解码并还原内层结构。
  const decodedJson = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as {
    contentType: number
    text: { text: string }
  }
  assert.equal(decodedJson.contentType, TEXT_CONTENT_TYPE)
  assert.equal(decodedJson.text.text, '中文🙂 换行\n')
  assert.equal(decodeTextContent(encoded), '中文🙂 换行\n')
})

test('发送信封结构：cid@goofish、外层 101、actualReceivers 包含双方', () => {
  const request = buildSendMessageLwpRequest(baseParams)
  assert.equal(request.lwp, SEND_LWP_ROUTE)
  const [message, receivers] = request.body as [Record<string, unknown>, Record<string, unknown>]
  assert.equal(message['cid'], 's1@goofish')
  assert.equal(message['uuid'], baseParams.uuid)
  assert.equal(message['conversationType'], 1)
  assert.deepEqual(message['ctx'], { appVersion: '1.0', platform: 'web' })
  const content = message['content'] as Record<string, unknown>
  assert.equal(content['contentType'], OUTER_CONTENT_TYPE)
  const custom = content['custom'] as Record<string, unknown>
  assert.equal(custom['type'], 1)
  assert.equal(decodeTextContent(custom['data'] as string), '你好')
  assert.deepEqual(receivers['actualReceivers'], ['peer1@goofish', 'me1@goofish'])
})

test('发送信封通过自身校验；非法结构被拒绝', () => {
  const request = buildSendMessageLwpRequest(baseParams)
  assert.equal(validateSendLwpRequest(request), null)

  // 路由非法
  assert.equal(validateSendLwpRequest({ ...request, lwp: '/r/Other' })?.code, 'ROUTE_NOT_ALLOWED')
  // 缺 mid
  assert.equal(validateSendLwpRequest({ ...request, headers: {} })?.code, 'INVALID_INPUT')
  // body 长度不为 2
  assert.equal(validateSendLwpRequest({ ...request, body: [request.body[0]] })?.code, 'INVALID_INPUT')
  // actualReceivers 缺一方
  const bad = JSON.parse(JSON.stringify(request)) as typeof request
  ;((bad.body[1] as Record<string, unknown>)['actualReceivers'] as unknown[]) = ['peer1@goofish']
  assert.equal(validateSendLwpRequest(bad)?.code, 'INVALID_INPUT')
  // 外层 contentType 非 101
  const bad2 = JSON.parse(JSON.stringify(request)) as typeof request
  ;(((bad2.body[0] as Record<string, unknown>)['content'] as Record<string, unknown>)['contentType'] as number) = 1
  assert.equal(validateSendLwpRequest(bad2)?.code, 'INVALID_INPUT')
})

test('P5 只读白名单不被放宽：发送路由对只读 transport 仍为非法', () => {
  const request = buildSendMessageLwpRequest(baseParams)
  const invalid = validateAllowedLwpRequest(request)
  assert.equal(invalid?.code, 'ROUTE_NOT_ALLOWED')
})

test('validateSendInput 校验 sessionId / receiverId / myId / content', () => {
  const ok = validateSendInput({ sessionId: 's1', receiverId: 'p1', myId: 'm1', content: 'hi' })
  assert.equal(ok, null)
  assert.equal(validateSendInput({ sessionId: '', receiverId: 'p1', myId: 'm1', content: 'hi' })?.code, 'INVALID_INPUT')
  assert.equal(validateSendInput({ sessionId: 's1', receiverId: 'p1', myId: 'm1', content: '   ' })?.code, 'INVALID_INPUT')
  assert.equal(validateSendInput({ sessionId: 's1@goofish', receiverId: 'p1', myId: 'm1', content: 'hi' })?.code, 'INVALID_INPUT')
  assert.equal(validateSendInput({ sessionId: 's1', receiverId: 'm1', myId: 'm1', content: 'hi' })?.code, 'INVALID_INPUT')
})
