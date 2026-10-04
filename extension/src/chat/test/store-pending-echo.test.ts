/**
 * 本地确认回显（pendingEcho）修剪规则单测。
 *
 * 背景：平台发送响应不回服务端 messageId，历史 / 回声 messageId 为 `msg_xxx`，与发送 uuid 不同源，
 * 因此无法按 id 关联。方案：本地发送消息标记 `pendingEcho`（仅内存），当权威历史时间边界覆盖到它时剔除。
 *
 * 规则（仅 `authoritativeHistory: true` 的历史同步批次可作边界）：
 * 按会话取权威消息（非 pendingEcho）最大 createAt 为上界，仅剔除 `createAt <= 上界` 的回显；
 * 晚于上界的回显一律保留（历史尚未同步到的新消息不误删）。
 * 实时单条入站消息不参与：它可能与本地发送无关，不能当边界。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatMessage } from '../../../../shared/types/chat'
import { ChatStore, MemoryChatPersistence } from '../store'

function echo(patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: '',
    messageId: 'UUID-LOCAL',
    sessionId: 's1',
    cid: 's1@goofish',
    senderId: 'me',
    senderName: '',
    receiverId: 'peer',
    direction: 'out',
    kind: 'text',
    contentType: 1,
    content: '你好',
    createAt: 1500,
    source: 'history',
    pendingEcho: true,
    ...patch,
  }
}

function authoritative(patch: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: '',
    messageId: 'msg_server_1',
    sessionId: 's1',
    cid: 's1@goofish',
    senderId: 'me',
    senderName: '',
    receiverId: 'peer',
    direction: 'out',
    kind: 'text',
    contentType: 1,
    content: '你好',
    createAt: 2000,
    source: 'history',
    ...patch,
  }
}

test('权威历史边界覆盖回显：剔除回显，不产生重复', () => {
  const store = new ChatStore()
  store.upsertMessages([echo()])
  assert.equal(store.getMessages('s1').length, 1)
  assert.equal(store.getMessages('s1')[0].pendingEcho, true)

  store.upsertMessages([authoritative()], { authoritativeHistory: true })

  const messages = store.getMessages('s1')
  assert.equal(messages.length, 1, '权威历史与回显不应并存')
  assert.equal(messages[0].messageId, 'msg_server_1')
  assert.notEqual(messages[0].pendingEcho, true)
})

test('实时批次不作为边界：无关入站消息不误删尚未确认的本地回显', () => {
  const store = new ChatStore()
  store.upsertMessages([echo({ createAt: 2000 })])
  // 实时收到一条比回显更晚的、与发送无关的入站消息（非历史批次）。
  store.upsertMessages([authoritative({ messageId: 'msg_inbound_later', direction: 'in', createAt: 3000 })])

  const messages = store.getMessages('s1')
  assert.equal(messages.length, 2, '实时入站不得当作历史边界剔除回显')
  assert.ok(messages.some((m) => m.pendingEcho === true && m.messageId === 'UUID-LOCAL'))
  assert.ok(messages.some((m) => m.messageId === 'msg_inbound_later'))
})

test('同批实时与权威混合时，只有显式历史批次才剔除回显', () => {
  const store = new ChatStore()
  store.upsertMessages([echo({ createAt: 1500 })])
  // 默认（实时）写入更晚的权威消息：不剔除。
  store.upsertMessages([authoritative({ createAt: 2000 })])
  assert.equal(store.getMessages('s1').length, 2, '实时写入不剔除')

  // 显式历史批次：以时间上界剔除。
  store.upsertMessages([authoritative({ createAt: 2000 })], { authoritativeHistory: true })
  assert.equal(store.getMessages('s1').length, 1)
  assert.equal(store.getMessages('s1')[0].messageId, 'msg_server_1')
})

test('回显晚于历史边界：保留（未同步的新消息不误删）', () => {
  const store = new ChatStore()
  // 回显时间比历史最新消息更晚 → 历史尚未包含该消息。
  store.upsertMessages([echo({ createAt: 3000 })])
  store.upsertMessages([authoritative({ createAt: 2000 })], { authoritativeHistory: true })

  assert.equal(store.getMessages('s1').length, 2)
  assert.ok(store.getMessages('s1').some((m) => m.pendingEcho === true))
})

test('不同会话的权威历史不剔除其他会话回显', () => {
  const store = new ChatStore()
  store.upsertMessages([echo({ sessionId: 's1' })])
  store.upsertMessages([authoritative({ sessionId: 's2', cid: 's2@goofish' })], { authoritativeHistory: true })

  assert.equal(store.getMessages('s1').length, 1)
  assert.equal(store.getMessages('s1')[0].pendingEcho, true)
  assert.equal(store.getMessages('s2').length, 1)
})

test('仅权威消息可剔除回显：回显之间互不影响', () => {
  const store = new ChatStore()
  store.upsertMessages([echo({ messageId: 'UUID-A', createAt: 1000 })])
  store.upsertMessages([echo({ messageId: 'UUID-B', createAt: 2000 })])

  assert.equal(store.getMessages('s1').length, 2)
})

test('回显不持久化：flush 后持久层不含回显', async () => {
  const persistence = new MemoryChatPersistence()
  const store = new ChatStore(persistence)
  store.upsertMessages([echo()])
  await store.flush()

  assert.equal((await persistence.loadMessages()).length, 0)
  assert.equal(store.getMessages('s1').length, 1, '回显仍在内存可见')
})

test('权威消息正常持久化，回显剔除后持久层只保留权威版本', async () => {
  const persistence = new MemoryChatPersistence()
  const store = new ChatStore(persistence)
  store.upsertMessages([echo()])
  store.upsertMessages([authoritative()], { authoritativeHistory: true })
  await store.flush()

  const persisted = await persistence.loadMessages()
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0].messageId, 'msg_server_1')
})
