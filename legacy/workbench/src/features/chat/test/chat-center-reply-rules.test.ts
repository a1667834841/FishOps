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

test('Socket 状态使用标题旁紧凑小点，不单占一行且不带 pulse 动画', () => {
  assert.ok(pageSource.includes('id="socket-status-dot"'), '会话卡片头部必须渲染 id="socket-status-dot"')
  assert.ok(pageSource.includes('class="status-dot-compact"'), '必须使用 status-dot-compact 紧凑小点类')
  assert.ok(pageSource.includes(':title='), '必须配置 title 提供可访问语义')
  assert.ok(pageSource.includes(':aria-label='), '必须配置 aria-label 提供屏幕阅读器支持')

  const css = styleBlock(pageSource)
  assert.ok(!css.includes('pulse'), '禁止使用 pulse 装饰动画')
  assert.ok(css.includes('.status-dot-compact'), '必须包含 status-dot-compact 紧凑小点样式')
})

test('聊天中心忠实 Seline 暖纸白卡细线轻字重黄色，不包含 HTML 假数据与平均响应', () => {
  assert.ok(!pageSource.includes('摄影小陈'), '严禁复制 HTML 原型中写死的买家假数据')
  assert.ok(!pageSource.includes('Sony A7M4'), '严禁复制 HTML 原型中写死的商品假数据')
  assert.ok(!pageSource.includes('平均响应'), '严禁展示或造假平均响应时长')

  const composerSource = readFileSync(resolve(here, '../../../components/chat/ReplyComposer.vue'), 'utf8')
  assert.ok(composerSource.includes('reply-suggest-btn'), '回复区必须包含 Seline 风格建议按钮')
  assert.ok(composerSource.includes('suggestion-filled-badge'), '回复区必须包含建议已填入标记')
  assert.ok(composerSource.includes('textareaRef.value?.focus()'), '回填建议必须自动聚焦输入框')
  assert.ok(composerSource.includes("manualText.value = ''"), '切换会话与发送成功必须清理草稿')
})
