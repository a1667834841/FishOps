import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createChatNotice } from '../chat-notice.ts'
test('页面通知合并突发，释放后不再通知', () => {
  const tasks: Array<() => void> = []; let count = 0
  const notice = createChatNotice(() => { count++ }, callback => tasks.push(callback))
  notice.signal(); notice.signal(); notice.signal()
  assert.equal(tasks.length, 1); tasks.shift()!(); assert.equal(count, 1)
  notice.signal(); notice.dispose(); tasks.shift()!(); notice.signal()
  assert.equal(count, 1); assert.equal(tasks.length, 0)
})
