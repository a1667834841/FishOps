import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { HostDatabase } from './database.ts'

test('缓存绑定账号与方法，TTL边界和时钟回拨不命中', () => {
  const db = new HostDatabase(':memory:')
  try {
    db.putReadCache('a', 'key', 'item.detail', { itemId: '1' }, 1000)
    assert.deepEqual(db.getReadCache('a', 'key', 'item.detail', 10, 10999), { itemId: '1' })
    assert.equal(db.getReadCache('b', 'key', 'item.detail', 10, 2000), null)
    assert.equal(db.getReadCache('a', 'key', 'search.items', 10, 2000), null)
    for (const [ttl, now] of [[0, 1000], [10, 11000], [10, 999]]) {
      assert.equal(db.getReadCache('a', 'key', 'item.detail', ttl, now), null)
    }
  } finally { db.close() }
})

test('缓存重复保存更新结果，账号之间不覆盖，非法数据不写入', () => {
  const db = new HostDatabase(':memory:')
  try {
    db.putReadCache('a', 'k', 'item.detail', { itemId: '1' }, 1000)
    db.putReadCache('b', 'k', 'item.detail', { itemId: '2' }, 1000)
    db.putReadCache('a', 'k', 'item.detail', { itemId: '3' }, 2000)
    assert.deepEqual(db.getReadCache('a', 'k', 'item.detail', 10, 2001), { itemId: '3' })
    assert.deepEqual(db.getReadCache('b', 'k', 'item.detail', 10, 2001), { itemId: '2' })
    assert.throws(() => db.putReadCache('', 'k', 'item.detail', {}, 0))
    assert.throws(() => db.putReadCache('a', 'k', 'item.detail', undefined, 0))
    assert.throws(() => db.getReadCache('a', 'k', 'item.detail', -1, 2001))
  } finally { db.close() }
})

test('v1升级保留事件与请求，重开仍可读取缓存，高版本拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fishops-cache-'))
  const path = join(dir, 'test.db')
  try {
    const old = new HostDatabase(path)
    old.event('account.changed', { account: null })
    old.request('r1', 'system.status'); old.finish('r1', 'succeeded')
    old.db.exec('DROP TABLE read_cache; PRAGMA user_version=1;'); old.close()
    const migrated = new HostDatabase(path)
    assert.equal(migrated.events({}).items.length, 1)
    assert.equal(migrated.requests({}).items[0]?.id, 'r1')
    migrated.putReadCache('a', 'k', 'item.detail', { itemId: '1' }, 1000)
    const snapshot = { lastStartedAt: 1000, categories: { search: 1000 }, pending: { category: 'search' as const, reservedAt: 1000 } }
    migrated.saveSchedule('a', snapshot)
    assert.equal(migrated.loadSchedule('b'), null)
    migrated.close()
    const reopened = new HostDatabase(path)
    assert.deepEqual(reopened.getReadCache('a', 'k', 'item.detail', 10, 1001), { itemId: '1' })
    assert.deepEqual(reopened.loadSchedule('a'), snapshot)
    reopened.close()
    const future = new DatabaseSync(path); future.exec('PRAGMA user_version=999'); future.close()
    assert.throws(() => new HostDatabase(path), /版本/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
