import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChromeChatStorage } from '../chat-storage.ts'

test('本地存储先限制访问，再读写；不使用sync', async () => {
  const calls: string[] = []
  const scope = globalThis as any, previous = scope.chrome
  scope.chrome = { storage: { local: {
    setAccessLevel: async (value: unknown) => { assert.deepEqual(value, { accessLevel: 'TRUSTED_CONTEXTS' }); calls.push('access') },
    get: async (key: string) => { calls.push('get'); return { [key]: 'saved' } },
    set: async (value: unknown) => { calls.push('set'); assert.ok(JSON.stringify(value).includes('fishops.chat.outbox.v1')) },
  } } }
  try {
    const storage = createChromeChatStorage()
    assert.equal(await storage.read(), 'saved')
    await storage.write({ version: 1, entries: [], gaps: [] })
    assert.deepEqual(calls, ['access', 'get', 'set'])
  } finally { scope.chrome = previous }
})

test('访问限制失败不读写消息，不回退为成功', async () => {
  const scope = globalThis as any, previous = scope.chrome
  scope.chrome = { storage: { local: { setAccessLevel: async () => { throw new Error('denied') }, get: async () => assert.fail('不应读取'), set: async () => assert.fail('不应写入') } } }
  try {
    const storage = createChromeChatStorage()
    await assert.rejects(storage.read(), /denied/)
    await assert.rejects(storage.write({ version: 1, entries: [], gaps: [] }), /denied/)
  } finally { scope.chrome = previous }
})
