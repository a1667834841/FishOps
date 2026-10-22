import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPublishPreparedStore, type PublishSessionStorageArea } from '../publish-prepared-storage.ts'
import type { PublishPreparedContext } from '../publish-page-executor.ts'

const ACCOUNT = 'account-a'
const NOW = 1_700_000_000_000

function storage(): PublishSessionStorageArea & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>()
  return {
    values,
    async get(key) {
      return values.has(key) ? { [key]: structuredClone(values.get(key)) } : {}
    },
    async set(value) {
      for (const [key, item] of Object.entries(value)) values.set(key, structuredClone(item))
    },
    async remove(key) {
      values.delete(key)
    },
  }
}

function context(overrides: Partial<PublishPreparedContext> = {}): PublishPreparedContext {
  return {
    accountId: ACCOUNT,
    sourceItemId: 'item-1',
    expiresAt: NOW + 60_000,
    prepareRef: 'prep.one',
    draftFingerprint: 'f'.repeat(64),
    rawCards: [{ cardData: { propertyId: '-10000' } }],
    core: {
      description: '描述',
      priceYuan: '199',
      specifications: [],
      itemCatDTO: { catId: 'c' },
      itemLabelExtList: [],
      itemAddrDTO: { prov: 'p' },
      imageInfoDOList: [{ url: 'https://img.example.com/1.jpg' }],
      services: [],
    },
    ...overrides,
  }
}

test('按账号分区保存与读取，不跨账号返回', async () => {
  const area = storage()
  let account = ACCOUNT
  const store = createPublishPreparedStore({ storage: area, accountId: () => account, now: () => NOW })
  await store.set('token-a', context())
  assert.equal((await store.get('token-a'))?.prepareRef, 'prep.one')

  account = 'account-b'
  assert.equal(await store.get('token-a'), null)
  await assert.rejects(Promise.resolve().then(() => store.set('token-a', context())), /账号不匹配/)
})

test('过期条目在读取时删除，并在读取时 fail-closed 拒绝损坏结构', async () => {
  const area = storage()
  const store = createPublishPreparedStore({ storage: area, accountId: () => ACCOUNT, now: () => NOW })
  await store.set('token-a', context({ expiresAt: NOW - 1 }))
  assert.equal(await store.get('token-a'), null)

  const key = `fishops.publish.prepared.v1:${ACCOUNT}`
  area.values.set(key, { 'token-x': { accountId: ACCOUNT, unexpected: true } })
  await assert.rejects(Promise.resolve().then(() => store.get('token-x')), /未知字段|结构无效/)
})

test('容量有界：仅保留最新的条目，旧条目被清理', async () => {
  const area = storage()
  let now = NOW
  const store = createPublishPreparedStore({
    storage: area,
    accountId: () => ACCOUNT,
    now: () => now,
    maxEntries: 2,
  })
  await store.set('a', context({ prepareRef: 'prep.a' }))
  now += 1
  await store.set('b', context({ prepareRef: 'prep.b' }))
  now += 1
  await store.set('c', context({ prepareRef: 'prep.c' }))

  assert.equal(await store.get('a'), null)
  assert.equal((await store.get('b'))?.prepareRef, 'prep.b')
  assert.equal((await store.get('c'))?.prepareRef, 'prep.c')
})

test('损坏值、未知字段和超长 token 不写入或返回', async () => {
  const area = storage()
  const store = createPublishPreparedStore({ storage: area, accountId: () => ACCOUNT, now: () => NOW })
  assert.equal(await store.get('x'.repeat(257)), null)
  await assert.rejects(Promise.resolve().then(() => store.set('', context())), /存储键无效/)
  assert.equal(area.values.size, 0)
})
