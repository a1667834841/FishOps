/**
 * 发布页布局回归测试（P8）。
 *
 * 背景：真实扩展环境中曾观测到「🚀 开始自动填充发布表单」按钮盒子异常宽（≈2412px）、
 * 发布页整体横向溢出视口，导致普通点击被拦截（见 docs/ego-runtime-publish-report.md 问题 5）。
 *
 * 根因：发布页作为 `.content` 网格项未显式设置 `min-width: 0`，其内部“发布任务历史”表格的
 * min-content 会把整页撑宽；`overflow-x: auto` 的表格容器也因此无法生效。
 *
 * 本测试不依赖 DOM 运行时（workbench 单测为纯 Node），改为直接校验 `PublishPage.vue` 的
 * 样式与模板契约，锁定以下不变量：
 * 1. 页面与预览容器可收缩，表格在受限宽度内横向滚动；
 * 2. 按钮只包裹可见文案，绝不被拉伸到整行宽度；
 * 3. 随机选品、开始填表、一键发布等入口齐全，且不存在自动提交发布逻辑。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pageSource = readFileSync(resolve(here, '../../../pages/PublishPage.vue'), 'utf8')

/** 取出 `<style scoped>` 块内容。 */
function styleBlock(sfc: string): string {
  const match = sfc.match(/<style[^>]*>([\s\S]*?)<\/style>/)
  return match ? match[1] : ''
}

/** 取出某个选择器对应的声明块（精确匹配“选择器 {”），并去除空白便于断言。 */
function ruleBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  return match ? match[1].replace(/\s+/g, '') : ''
}

test('发布页根容器与预览容器显式允许收缩，避免任务表格 min-content 撑宽整页', () => {
  const css = styleBlock(pageSource)
  assert.ok(css.length > 0, '未解析到 PublishPage.vue 的样式块')

  const page = ruleBlock(css, '.publish-page')
  assert.ok(page.includes('min-width:0'), '.publish-page 必须设置 min-width: 0，避免作为网格项被内容撑宽')
  assert.ok(page.includes('width:100%'), '.publish-page 应占满可用宽度')

  const grid = ruleBlock(css, '.publish-grid')
  assert.ok(grid.includes('min-width:0'), '.publish-grid 必须设置 min-width: 0')
})

test('发布任务表格在受限宽度下内部横向滚动，而不是撑宽页面', () => {
  const css = styleBlock(pageSource)
  const wrap = ruleBlock(css, '.task-table-wrapper')
  assert.ok(wrap.includes('overflow-x:auto'), '.task-table-wrapper 必须 overflow-x: auto')
  assert.ok(wrap.includes('max-width:100%'), '.task-table-wrapper 必须 max-width: 100%')
})

test('按钮只包裹可见文案，绝不被拉伸到整行宽度', () => {
  const css = styleBlock(pageSource)
  const btn = ruleBlock(css, '.btn')
  assert.ok(btn.includes('width:fit-content'), '.btn 必须 width: fit-content，点击区域只包裹文案')
  assert.ok(btn.includes('max-width:100%'), '.btn 必须 max-width: 100%')
  assert.ok(!/(^|;)width:100%(;|$)/.test(btn), '.btn 不得设置为整行宽度')

  // 填表按钮栏不得因 flex 默认 stretch 把主按钮撑满整行
  const bar = ruleBlock(css, '.submit-action-bar')
  assert.ok(bar.includes('align-items:flex-start'), '.submit-action-bar 必须 align-items: flex-start')

  const row = ruleBlock(css, '.submit-action-row')
  assert.ok(row.includes('align-items:center'), '.submit-action-row 必须 align-items: center')
})

test('保留随机选品、开始填表、手动点击发布、放弃发布等明确入口，且不存在挂载/自动提交发布逻辑', () => {
  assert.ok(pageSource.includes('随机选择 1 条商品'), '缺少“随机选择 1 条商品”入口')
  assert.ok(pageSource.includes('开始自动填充发布表单'), '缺少“开始自动填充发布表单”入口')
  assert.ok(pageSource.includes('发布'), '缺少明确用户点击的“发布”按钮')
  assert.ok(pageSource.includes('放弃本次发布'), '缺少放弃发布入口')
  assert.ok(pageSource.includes('onSubmitPublish'), '点击应绑定单次发布提交方法')

  // 必须具有防双击与无障碍属性
  assert.ok(pageSource.includes('isSubmitDisabled'), '发布按钮必须具有防双击与状态锁定判定')
  assert.ok(pageSource.includes(':aria-busy="isSubmitting"'), '发布中需具备 aria-busy 无障碍状态')

  // 所有按钮必须是 type="button"，避免意外的隐式表单提交
  const buttons = pageSource.match(/<button[\s\S]*?>/g) ?? []
  assert.ok(buttons.length > 0, '发布页应包含按钮')
  for (const button of buttons) {
    assert.ok(button.includes('type="button"'), `按钮需显式声明 type="button"：${button.slice(0, 60)}`)
  }

  // 前端绝不得提供自动发布、挂载自动调用或页面加载触发
  assert.ok(
    !/onMounted[\s\S]*?(submitPublish|onSubmitPublish)/.test(pageSource),
    '严禁在 onMounted 中自动调用发布提交',
  )
  assert.ok(
    !/watch[\s\S]*?(submitPublish|onSubmitPublish)/.test(pageSource),
    '严禁在 watch 监听中自动调用发布提交',
  )
  assert.ok(
    !/autoPublish|autoSubmit/.test(pageSource),
    '发布页不得包含全自动或暗中提交发布的逻辑',
  )
})
