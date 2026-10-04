/**
 * 生产接线回归：`ChatRuntime.setMyUserId` 的动态传播与缓存重新归一。
 *
 * 背景（截图缺陷）：runtime 单例在创建时把 myUserId 冻结注入 history/sync/adapter。
 * 首次创建时若尚未就绪（无 goofish tab / 未登录），myUserId 为 undefined；此后即便
 * `CHAT_RUNTIME_PREPARE` 解析出真实 ID，历史与缓存仍全被当作 `in`（自己也在左侧），
 * 会话 peer 回退到 `in` 消息后甚至显示自己。
 *
 * 本文件锁定：后置获得可靠用户 ID 后，已缓存消息方向被重新归一（仅 in → out 纠正，
 * 绝不把已确认的 out 降级为 in），且保留本地已发送回显（pendingEcho）与头像。
 *
 * 全程无 chrome / 无网络。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatMessage } from '../../../../shared/types/chat'
import { createChatRuntime } from '../../background/chat-runtime'

/** 构造一条标准消息（默认 in / history，可覆盖）。 */
function message(patch: Partial<ChatMessage> & { messageId: string; sessionId: string }): ChatMessage {
  return {
    id: patch.messageId,
    cid: `${patch.sessionId}@goofish`,
    senderId: '',
    senderName: '',
    receiverId: '',
    direction: 'in',
    kind: 'text',
    contentType: 1,
    content: 'x',
    createAt: 1,
    source: 'history',
    ...patch,
  }
}

test('setMyUserId：后置获得当前用户 ID 后，重新归一已缓存历史方向（in → out）', async () => {
  const runtime = createChatRuntime({})
  await runtime.init()
  const store = runtime.getStore()
  store.upsertMessages([
    message({ messageId: 'h-me', sessionId: 'peer1', senderId: 'me@goofish', content: '我发的', createAt: 1000 }),
    message({ messageId: 'h-peer', sessionId: 'peer1', senderId: 'peer@goofish', content: '对方发的', createAt: 2000 }),
  ])
  // 构造时无 myUserId：方向未知，全部按 in（诚实，不猜）。
  assert.equal(
    store.getMessages('peer1').every((m) => m.direction === 'in'),
    true,
  )

  runtime.setMyUserId('me')

  const messages = store.getMessages('peer1')
  assert.equal(messages.find((m) => m.messageId === 'h-me')?.direction, 'out', '自己发出的历史消息应纠正为 out')
  assert.equal(messages.find((m) => m.messageId === 'h-peer')?.direction, 'in', '对方消息保持 in')
  // out 消息接收者回填为会话对方。
  assert.equal(messages.find((m) => m.messageId === 'h-me')?.receiverId, 'peer1')
})

test('setMyUserId：保留本地已发送回显（pendingEcho）与消息头像', async () => {
  const runtime = createChatRuntime({})
  await runtime.init()
  const store = runtime.getStore()
  store.upsertMessages([
    message({
      messageId: 'echo',
      sessionId: 'peer1',
      senderId: 'me',
      direction: 'out',
      receiverId: 'peer1',
      content: '你好',
      createAt: 3000,
      pendingEcho: true,
      senderAvatarUrl: 'https://img.alicdn.com/echo.jpg',
    }),
    message({
      messageId: 'h',
      sessionId: 'peer1',
      senderId: 'me@goofish',
      direction: 'in',
      content: '历史里我发的',
      createAt: 1000,
      senderAvatarUrl: 'https://img.alicdn.com/h.jpg',
    }),
  ])

  runtime.setMyUserId('me')

  const echo = store.getMessages('peer1').find((m) => m.messageId === 'echo')
  assert.equal(echo?.pendingEcho, true, '本地回显不得被丢弃')
  assert.equal(echo?.direction, 'out', '已确认 out 不得降级为 in')
  assert.equal(echo?.receiverId, 'peer1')

  const history = store.getMessages('peer1').find((m) => m.messageId === 'h')
  assert.equal(history?.direction, 'out')
  assert.equal(history?.senderAvatarUrl, 'https://img.alicdn.com/h.jpg', '重新归一不得丢失头像')
})

test('setMyUserId：ID 未知（空串）时不纠正，绝不猜方向', async () => {
  const runtime = createChatRuntime({})
  await runtime.init()
  const store = runtime.getStore()
  store.upsertMessages([message({ messageId: 'h', sessionId: 'peer1', senderId: 'me', createAt: 1000 })])

  runtime.setMyUserId('')
  assert.equal(store.getMessages('peer1')[0].direction, 'in')
})

test('setMyUserId：相同 ID 重复调用幂等，不产生变化', async () => {
  const runtime = createChatRuntime({ myUserId: 'me' })
  await runtime.init()
  const store = runtime.getStore()
  store.upsertMessages([message({ messageId: 'h', sessionId: 'peer1', senderId: 'me@goofish', createAt: 1000 })])

  runtime.setMyUserId('me')
  const first = store.getMessages('peer1')[0].direction
  runtime.setMyUserId('me')
  assert.equal(first, 'out')
  assert.equal(store.getMessages('peer1')[0].direction, 'out')
})

test('setMyUserId：账号变化时旧 out（sender=旧 self）降级为 in', async () => {
  const runtime = createChatRuntime({ myUserId: 'oldAccount' })
  await runtime.init()
  const store = runtime.getStore()
  store.upsertMessages([
    message({ messageId: 'h', sessionId: 'peer1', senderId: 'oldAccount', direction: 'out', receiverId: 'peer1', createAt: 1000 }),
    message({ messageId: 'p', sessionId: 'peer1', senderId: 'peer', createAt: 2000 }),
  ])

  // 切换到新账号：旧 out 的发送者是旧 self，依据新可靠 self 应降级为 in。
  runtime.setMyUserId('newAccount')

  const messages = store.getMessages('peer1')
  assert.equal(messages.find((m) => m.messageId === 'h')?.direction, 'in', '旧账号的 out 应降级为 in')
  assert.equal(messages.find((m) => m.messageId === 'p')?.direction, 'in', '对方消息保持 in')
})

test('setMyUserId：pendingEcho 不冻结——仅当其发送者明确匹配 self 时才保持 out', async () => {
  const runtime = createChatRuntime({ myUserId: 'oldAccount' })
  await runtime.init()
  const store = runtime.getStore()
  store.upsertMessages([
    message({ messageId: 'echo-mine', sessionId: 'peer1', senderId: 'newAccount', direction: 'out', receiverId: 'peer1', pendingEcho: true, createAt: 3000 }),
    message({ messageId: 'echo-old', sessionId: 'peer1', senderId: 'oldAccount', direction: 'out', receiverId: 'peer1', pendingEcho: true, createAt: 1000 }),
    message({ messageId: 'echo-unknown', sessionId: 'peer1', senderId: '', direction: 'out', receiverId: 'peer1', pendingEcho: true, createAt: 2000 }),
  ])

  runtime.setMyUserId('newAccount')

  const messages = store.getMessages('peer1')
  assert.equal(messages.find((m) => m.messageId === 'echo-mine')?.direction, 'out', '发送者明确匹配新 self 的回显保持 out')
  assert.equal(messages.find((m) => m.messageId === 'echo-old')?.direction, 'in', '属于旧账号的回显降级为 in（不冻结）')
  assert.equal(messages.find((m) => m.messageId === 'echo-unknown')?.direction, 'out', '发送者未知时不猜，保持原方向')
})
