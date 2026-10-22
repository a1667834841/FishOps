import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HostDatabase } from './database.ts'
const params = { mode: 'messages' as const, sessionId: 's', anchor: '9007199254740991', limit: 20 }
const msg = (sourceId: string) => ({ sourceId, sessionId: 's', senderId: 'p', text: '测试', sentAt: 1 })
const result = { mode: 'messages' as const, messages: [msg('1'), msg('2')], hasMore: false, nextAnchor: null, unsupportedCount: 0 }
test('同步消息页原子提交、页重放和账号隔离', () => {
  const db = new HostDatabase(':memory:')
  try {
    assert.deepEqual(db.commitChatSyncPage('a', 'r', 'p', params, result), { insertedCount: 2, updatedCount: 0, duplicate: false })
    assert.deepEqual(db.commitChatSyncPage('a', 'r', 'p', params, result), { insertedCount: 2, updatedCount: 0, duplicate: true })
    assert.throws(() => db.commitChatSyncPage('a', 'r', 'p', params, { ...result, messages: [msg('changed')] }))
    assert.equal(db.events({ types: ['chat.message'] }, 'a').items.length, 2)
    assert.equal(db.chatMessages('b', { sessionId: 's' }).items.length, 0)
  } finally { db.close() }
})
test('页中途写失败回滚消息、事件、会话及页进度', () => {
  const db = new HostDatabase(':memory:')
  try {
    db.db.exec("CREATE TRIGGER fail_page BEFORE INSERT ON chat_messages WHEN NEW.source_id='2' BEGIN SELECT RAISE(ABORT,'test'); END")
    assert.throws(() => db.commitChatSyncPage('a', 'r', 'p', params, result))
    assert.equal(db.chatMessages('a', { sessionId: 's' }).items.length, 0)
    assert.equal(db.chatConversations('a', {}).items.length, 0)
    assert.equal(db.events({ types: ['chat.message'] }, 'a').items.length, 0)
    db.db.exec('DROP TRIGGER fail_page')
    assert.equal(db.commitChatSyncPage('a', 'r', 'p', params, result).duplicate, false)
  } finally { db.close() }
})
test('没有最后消息的会话独立入库，不伪造消息事件', () => {
  const db = new HostDatabase(':memory:')
  try {
    const conversations = { mode: 'conversations' as const, conversations: [{ sessionId: 'empty', peerUserId: null, itemId: null, updatedAt: 5, sortIndex: '5' }], hasMore: false, nextAnchor: null, unsupportedCount: 0 }
    db.commitChatSyncPage('a', 'r', 'p', { mode: 'conversations', anchor: '99', limit: 20 }, conversations)
    assert.equal(db.chatConversations('a', {}).items[0].sessionId, 'empty')
    assert.equal(db.events({ types: ['chat.message'] }, 'a').items.length, 0)
  } finally { db.close() }
})

test('外层事务可将页数据和公共进度一起回滚', () => {
  const db = new HostDatabase(':memory:')
  try {
    db.db.exec('BEGIN IMMEDIATE')
    db.commitChatSyncPage('a', 'r', 'p', params, result)
    db.db.prepare('INSERT INTO state(key,value) VALUES(?,?)').run('public-progress', '{}')
    db.db.exec('ROLLBACK')
    assert.equal(db.chatMessages('a', { sessionId: 's' }).items.length, 0)
    assert.equal(db.db.prepare("SELECT 1 FROM state WHERE key='public-progress'").get(), undefined)
    assert.equal(db.commitChatSyncPage('a', 'r', 'p', params, result).duplicate, false)
  } finally { db.close() }
})

const emptyConversations = { mode: 'conversations' as const, conversations: [{ sessionId: 'empty', peerUserId: null, itemId: null, updatedAt: 5, sortIndex: '5' }], hasMore: false, nextAnchor: null, unsupportedCount: 0 }
const emptyPage = { mode: 'conversations' as const, anchor: '99', limit: 20 }
const tagRowCount = (db: HostDatabase, accountId: string, sessionId: string, tag: string) =>
  Number((db.db.prepare('SELECT COUNT(*) AS n FROM chat_conversation_tags WHERE account_id=? AND session_id=? AND tag=?').get(accountId, sessionId, tag) as { n: number | bigint }).n)

test('无消息会话按会话页 tag 可查询，且不依赖消息标签', () => {
  const db = new HostDatabase(':memory:')
  try {
    assert.deepEqual(db.commitChatSyncPage('a', 'r', 'p', emptyPage, emptyConversations, 'list-1'), { insertedCount: 1, updatedCount: 0, duplicate: false })
    assert.deepEqual(db.chatConversations('a', { tag: 'list-1' }).items.map(x => x.sessionId), ['empty'])
    assert.equal(db.chatConversations('a', { tag: 'other' }).items.length, 0)
    // 无消息会话不得靠伪造 chat.message 事件实现可查询。
    assert.equal(db.events({ types: ['chat.message'] }, 'a').items.length, 0)
  } finally { db.close() }
})

test('会话页 tag 关联按账号隔离', () => {
  const db = new HostDatabase(':memory:')
  try {
    db.commitChatSyncPage('a', 'r', 'p', emptyPage, emptyConversations, 'list-1')
    assert.equal(db.chatConversations('a', { tag: 'list-1' }).items.length, 1)
    assert.equal(db.chatConversations('b', { tag: 'list-1' }).items.length, 0)
    assert.equal(tagRowCount(db, 'b', 'empty', 'list-1'), 0)
  } finally { db.close() }
})

test('重复会话页重放不重复写 tag 关联', () => {
  const db = new HostDatabase(':memory:')
  try {
    db.commitChatSyncPage('a', 'r', 'p', emptyPage, emptyConversations, 'list-1')
    assert.equal(db.commitChatSyncPage('a', 'r', 'p', emptyPage, emptyConversations, 'list-1').duplicate, true)
    assert.equal(tagRowCount(db, 'a', 'empty', 'list-1'), 1)
    assert.equal(db.chatConversations('a', { tag: 'list-1' }).items.length, 1)
  } finally { db.close() }
})

test('已存在会话可追加会话页 tag，历史消息标签仍可查询', () => {
  const db = new HostDatabase(':memory:')
  try {
    db.commitChatSyncPage('a', 'r1', 'p1', params, result, 'job')
    const conversations = { mode: 'conversations' as const, conversations: [{ sessionId: 's', peerUserId: null, itemId: null, updatedAt: 5, sortIndex: '5' }], hasMore: false, nextAnchor: null, unsupportedCount: 0 }
    assert.deepEqual(db.commitChatSyncPage('a', 'r2', 'p2', { mode: 'conversations', anchor: '99', limit: 20 }, conversations, 'list-2'), { insertedCount: 0, updatedCount: 1, duplicate: false })
    assert.equal(db.chatConversations('a', { tag: 'job' }).items.length, 1)
    assert.equal(db.chatConversations('a', { tag: 'list-2' }).items.length, 1)
    assert.equal(db.events({ types: ['chat.message'] }, 'a').items.length, 2)
    // 消息去重语义不变：同一消息重复投递不因为新 tag 再写一条事件或换标签。
    assert.equal(db.ingestChatMessage('a', msg('1'), 'other').inserted, false)
    assert.equal(db.chatMessages('a', { sessionId: 's', tag: 'other' }).items.length, 0)
  } finally { db.close() }
})

test('会话页 tag 关联写入失败时整页回滚', () => {
  const db = new HostDatabase(':memory:')
  try {
    db.db.exec("CREATE TRIGGER fail_tag BEFORE INSERT ON chat_conversation_tags BEGIN SELECT RAISE(ABORT,'test'); END")
    assert.throws(() => db.commitChatSyncPage('a', 'r', 'p', emptyPage, emptyConversations, 'list-1'))
    assert.equal(db.chatConversations('a', {}).items.length, 0)
    assert.equal(db.chatConversations('a', { tag: 'list-1' }).items.length, 0)
    assert.equal(db.db.prepare("SELECT 1 FROM state WHERE key LIKE 'chat.sync.page:%'").get(), undefined)
    db.db.exec('DROP TRIGGER fail_tag')
    assert.deepEqual(db.commitChatSyncPage('a', 'r', 'p', emptyPage, emptyConversations, 'list-1'), { insertedCount: 1, updatedCount: 0, duplicate: false })
  } finally { db.close() }
})
