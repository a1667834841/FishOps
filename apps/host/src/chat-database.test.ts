import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostDatabase } from './database.ts'

const message = (sourceId = 'm1', sessionId = 's1', sentAt = 100) => ({ sourceId, sessionId, senderId: 'sender', text: '你好', sentAt })

test('消息、会话和事件原子入库，重复来源不重复事件且账号隔离', () => {
  const db = new HostDatabase(':memory:')
  try {
    const first = db.ingestChatMessage('a', message(), 'job')
    assert.equal(first.inserted, true)
    assert.deepEqual(db.ingestChatMessage('a', message(), 'other'), { ...first, inserted: false })
    assert.equal(db.events({ types: ['chat.message'] }, 'a').items.length, 1)
    assert.equal(db.chatMessages('a', { tag: 'job' }).items[0].seq, first.eventSeq)
    assert.equal(db.chatMessages('b', { sessionId: 's1' }).items.length, 0)
    assert.equal(db.ingestChatMessage('b', message()).inserted, true)
    assert.equal(db.chatConversations('a', {}).items.length, 1)
    db.db.exec("CREATE TRIGGER fail_message BEFORE INSERT ON chat_messages WHEN NEW.source_id='broken' BEGIN SELECT RAISE(ABORT,'test'); END")
    const high = db.highWater()
    assert.throws(() => db.ingestChatMessage('a', message('broken', 's1', 999)))
    assert.equal(db.highWater(), high)
    assert.equal(db.chatConversations('a', {}).items[0].updatedAt, 100)
    db.db.exec("CREATE TRIGGER fail_chat BEFORE INSERT ON events WHEN NEW.type='chat.message' BEGIN SELECT RAISE(ABORT,'test'); END")
    assert.throws(() => db.ingestChatMessage('a', message('m2', 's2')))
    assert.equal(db.chatMessages('a', { sessionId: 's2' }).items.length, 0)
    assert.equal(db.chatConversations('a', {}).items.length, 1)
  } finally { db.close() }
})

test('超过安全整数的事件与会话游标保持十进制字符串', () => {
  const db = new HostDatabase(':memory:')
  try {
    db.db.exec("INSERT INTO events(seq,type,ts,data) VALUES(9007199254740993,'risk.signal',1,'{}')")
    const saved = db.ingestChatMessage('a', message())
    assert.equal(saved.eventSeq, '9007199254740994')
    assert.equal(db.chatMessages('a', { sessionId: 's1', afterSeq: '9007199254740993' }).nextAfterSeq, saved.eventSeq)
    db.db.exec('UPDATE chat_conversations SET row_id=9007199254740993')
    assert.equal(db.chatConversations('a', { afterId: '9007199254740992' }).nextAfterId, '9007199254740993')
  } finally { db.close() }
})

test('消息与会话稳定游标分页，会话更新不移动 row_id 或回退更新时间', () => {
  const db = new HostDatabase(':memory:')
  try {
    for (let i = 1; i <= 3; i++) db.ingestChatMessage('a', message(`m${i}`, `s${i}`, i * 100))
    const page = db.chatConversations('a', { limit: 1 })
    assert.equal(page.hasMore, true)
    db.ingestChatMessage('a', message('new', 's1', 400))
    db.ingestChatMessage('a', message('old', 's1', 1))
    assert.equal(db.chatConversations('a', {}).items[0].updatedAt, 400)
    const next = db.chatConversations('a', { afterId: page.nextAfterId, limit: 2 })
    assert.deepEqual(next.items.map(x => x.sessionId), ['s2', 's3'])
    assert.equal(next.hasMore, false)
    const messages = db.chatMessages('a', { sessionId: 's1', limit: 1 })
    assert.equal(messages.hasMore, true)
    assert.equal(db.chatMessages('a', { sessionId: 's1', afterSeq: messages.nextAfterSeq }).items.length, 2)
    assert.equal(typeof page.items[0].id, 'string')
  } finally { db.close() }
})

test('v2迁移和重启保留历史、缓存、调度与聊天记录', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-db-')), path = join(dir, 'db')
  try {
    let db = new HostDatabase(path)
    db.event('risk.signal', {}, 'a')
    db.request('r1', 'system.status'); db.finish('r1', 'succeeded')
    db.putReadCache('a', 'k', 'item.detail', {}, 100)
    db.db.prepare('INSERT INTO state VALUES(?,?)').run('schedule:a', '{}')
    db.db.exec('DROP TABLE chat_messages; DROP TABLE chat_conversations; PRAGMA user_version=2')
    db.close()
    db = new HostDatabase(path)
    assert.equal(db.db.prepare('PRAGMA user_version').get()?.user_version, 4)
    assert.equal(db.events({}, 'a').items.length, 1)
    assert.equal(db.requests({}).items.length, 1)
    assert.deepEqual(db.getReadCache('a', 'k', 'item.detail', 10, 101), {})
    assert.deepEqual(db.loadSchedule('a'), {})
    const saved = db.ingestChatMessage('a', { ...message(), itemId: 'item', peerUserId: 'peer' }, 'job')
    db.close(); db = new HostDatabase(path)
    assert.deepEqual(db.ingestChatMessage('a', message()), { ...saved, inserted: false })
    assert.equal(db.chatConversations('a', { itemId: 'item', tag: 'job', updatedAfter: 99 }).items.length, 1)
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('运行时严格拒绝匿名账号、伪造tag、未知字段及非法游标边界', () => {
  const db = new HostDatabase(':memory:')
  try {
    for (const account of [null, '', ' ', 1]) assert.throws(() => db.ingestChatMessage(account as any, message()))
    for (const value of [null, [], { ...message(), tag: 'fake' }, { ...message(), sourceId: '' }, { ...message(), sentAt: -1 }, { ...message(), text: 'x'.repeat(65537) }, { ...message(), itemId: null }]) {
      assert.throws(() => db.ingestChatMessage('a', value as any))
    }
    for (const q of [{}, { sessionId: 's', limit: 0 }, { sessionId: 's', limit: 501 }, { sessionId: 's', afterSeq: '01' }, { sessionId: 's', extra: true }]) assert.throws(() => db.chatMessages('a', q))
    for (const q of [{ limit: 1.1 }, { afterId: '-1' }, { updatedAfter: Infinity }, { extra: true }]) assert.throws(() => db.chatConversations('a', q))
    assert.throws(() => db.chatConversations(null as any, {}))
    assert.equal(db.highWater(), '0')
  } finally { db.close() }
})
