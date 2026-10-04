/**
 * 聊天中心移除回复规则视图的回归测试。
 *
 * 背景：回复规则的 CRUD 已迁到设置页「回复策略」分区，聊天中心只保留会话与消息，
 * 因此必须移除规则 tab、`view` 视图状态与 `ReplyRulesPanel` 渲染，同时保留用于
 * 生成建议与手动发送的 `ReplyController`。项目暂无组件测试环境（无 @vue/test-utils），
 * 沿用 publish-layout.test.ts 的源码级断言模式锁定这些不变量。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pageSource = readFileSync(resolve(here, '../../../pages/ChatCenterPage.vue'), 'utf8')

/** 取出 `<style scoped>` 块内容。 */
function styleBlock(sfc: string): string {
  const match = sfc.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  return match ? match[1] : ''
}

test('聊天中心不再提供回复规则视图：移除 ReplyRulesPanel、tabs 状态与样式', () => {
  assert.ok(!pageSource.includes('ReplyRulesPanel'), '不得再引入或渲染 ReplyRulesPanel')
  assert.ok(!pageSource.includes("ref<'chat' | 'rules'>"), '不得再保留 view 视图状态')
  assert.ok(!pageSource.includes("view === 'rules'"), '不得再有规则视图切换逻辑')
  assert.ok(!pageSource.includes("view === 'chat'"), '不得再有会话视图切换逻辑')
  assert.ok(!pageSource.includes('会话与回复'), '不得再渲染“会话与回复”标签')
  assert.ok(!pageSource.includes('回复规则'), '不得再渲染“回复规则”标签')
  assert.ok(!pageSource.includes('class="views"'), '不得再渲染视图切换容器')
  assert.ok(!pageSource.includes('aria-label="聊天中心视图"'), '不得再保留视图切换无障碍标签')

  const css = styleBlock(pageSource)
  assert.ok(css.length > 0, '未解析到 ChatCenterPage.vue 的样式块')
  assert.ok(!css.includes('.views'), '必须删除视图切换栏样式 .views')
})

test('聊天中心保留回复建议与手动发送能力', () => {
  assert.ok(pageSource.includes("import ReplyComposer from '../components/chat/ReplyComposer.vue'"), '必须保留 ReplyComposer')
  assert.ok(pageSource.includes("from '../features/reply/reply-controller'"), '必须保留 ReplyController 引用')
  assert.ok(pageSource.includes('REPLY_EVENTS'), '必须保留 REPLY_EVENTS')
  assert.ok(pageSource.includes('new ReplyController({ api })'), '必须保留 ReplyController 构造')
  assert.ok(pageSource.includes('replyController.setSession(id)'), '选择会话必须绑定回复控制器')
  assert.ok(pageSource.includes('<ReplyComposer'), '模板必须渲染 ReplyComposer 用于建议与手动发送')
})

test('聊天中心把释放的标签栏空间让给消息区', () => {
  const css = styleBlock(pageSource)
  const chat = css.match(/\.chat\s*\{([^}]*)\}/)
  assert.ok(chat, '未找到 .chat 样式块')
  const body = chat![1].replace(/\s+/g, '')
  assert.ok(!body.includes('220px'), '.chat 高度不再保留含标签栏的 220px 偏移')
  assert.ok(body.includes('180px'), '.chat 高度需减去标签栏及其间距占位，把空间让给消息')
})
