/**
 * 发布页布局与契约回归测试。
 *
 * 背景：
 * 1. 真实扩展环境中曾观测到按钮盒子异常宽（≈2412px）、发布页横向溢出视口；
 * 2. 架构升级为「两阶段直接发布」：不再让主发布按钮调用旧 CREATE/FILL/SUBMIT，
 *    改为打开两阶段可编辑弹窗 DirectPublishModal，先跑预检准备（带地址与二维码确认），
 *    人工核对编辑类目属性/图片/规格后才执行最终提交；
 * 3. 锁定以下不变量：
 *    - 页面与预览容器可收缩，表格在受限宽度内横向滚动；
 *    - 按钮只包裹可见文案，绝不被拉伸到整行宽度；
 *    - 主发布按钮打开两阶段发布弹窗，成功必须返回真实 itemId；
 *    - unknown 结果永久锁定该草稿，杜绝绕 key 重试；
 *    - 取消仅关弹窗不发布；
 *    - 不存在挂载/暗中自动发布逻辑。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pageSource = readFileSync(resolve(here, '../../../pages/PublishPage.vue'), 'utf8')
const modalSource = readFileSync(resolve(here, '../DirectPublishModal.vue'), 'utf8')

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

test('单一发布主按钮接入两阶段直接发布弹窗，不再调用旧CREATE/FILL/SUBMIT流', () => {
  // 旧 4 步核对台已隐藏
  assert.ok(!pageSource.includes('aria-labelledby="stages-title"'), '不得再渲染“发布流程”4步核对台')
  assert.ok(!pageSource.includes('class="stages"'), '不得再渲染 stages 步骤列表')

  // 不再有独立“开始自动填充发布表单”与旧 onSubmitPublish 入口
  assert.ok(!pageSource.includes('开始自动填充发布表单'), '不得再有独立填表按钮')
  assert.ok(!pageSource.includes('createAndFillTask'), '页面不得直接调用 createAndFillTask')
  assert.ok(!pageSource.includes('onSubmitPublish'), '不得再有旧的独立提交入口')
  assert.ok(!pageSource.includes('controller.executeConfirmedPublish()'), '不再让主发布按钮调用旧CREATE/FILL/SUBMIT')

  // 唯一入口：主按钮打开两阶段发布弹窗 DirectPublishModal
  assert.ok(pageSource.includes('@click="onOpenPublishModal"'), '主按钮必须打开发布弹窗')
  assert.ok(pageSource.includes('<DirectPublishModal'), '页面必须接入两阶段直接发布组件 DirectPublishModal')
  assert.ok(pageSource.includes(':source-product="directPublishSource"'), '弹窗需绑定真实草稿数据源')
  assert.ok(pageSource.includes(':controller="directController"'), '弹窗需绑定两阶段直接发布控制器')

  // 核对入口在发布期间或结果锁定时禁用
  assert.ok(/:disabled="isPublishing \|\| isDirectDraftLocked"/.test(pageSource), '编辑区需在发布期间禁用')

  // 必须具有防双击与无障碍属性
  assert.ok(pageSource.includes(':aria-busy="isPublishing"'), '发布中需具备 aria-busy 无障碍状态')

  // 素材只从商品库进入，发布中心不再保留旧素材专区。
  assert.ok(!pageSource.includes('选择发布素材'))
  assert.ok(!pageSource.includes('重新选择素材'))
  assert.ok(!pageSource.includes('随机选择 1 条商品'))

  // 所有按钮必须是 type="button"，避免意外的隐式表单提交
  const buttons = pageSource.match(/<button[\s\S]*?>/g) ?? []
  assert.ok(buttons.length > 0, '发布页应包含按钮')
  for (const button of buttons) {
    assert.ok(button.includes('type="button"'), `按钮需显式声明 type="button"：${button.slice(0, 60)}`)
  }
})

test('打开确认弹窗与取消均为纯前端状态切换，不调用任何写命令，且不存在挂载/自动提交发布逻辑', () => {
  const openFn = pageSource.match(/function onOpenPublishModal\(\)[\s\S]*?\n\}/)
  const closeFn = pageSource.match(/function onClosePublishModal\(\)[\s\S]*?\n\}/)
  assert.ok(openFn, '未找到 onOpenPublishModal')
  assert.ok(closeFn, '未找到 onClosePublishModal')
  assert.ok(!openFn![0].includes('controller.'), '打开弹窗不得调用任何 controller 写命令')
  assert.ok(!closeFn![0].includes('controller.'), '取消弹窗不得调用任何 controller 写命令')

  // 前端绝不得提供自动发布、挂载自动调用或页面加载触发（含链路入口）
  assert.ok(
    !/onMounted[\s\S]*?(submitPublish|onSubmitPublish|executeConfirmedPublish|onConfirmPublish)/.test(pageSource),
    '严禁在 onMounted 中自动调用发布提交',
  )
  assert.ok(
    !/watch[\s\S]*?(submitPublish|onSubmitPublish|executeConfirmedPublish|onConfirmPublish)/.test(pageSource),
    '严禁在 watch 监听中自动调用发布提交',
  )
  assert.ok(
    !/autoPublish|autoSubmit/.test(pageSource),
    '发布页不得包含全自动或暗中提交发布的逻辑',
  )
})

test('页面结果显示真实 direct result，成功必须有真实 itemId，unknown 锁定禁止重试', () => {
  // 页面结果优先展示 direct result
  assert.ok(pageSource.includes('directPhase === \'published\' && directItemId'), '成功判定必须满足 directPhase===published 且必须有真实 directItemId')
  assert.ok(pageSource.includes('新增商品 ID：'), '成功需展示官方真实返回的新增 itemId')

  // unknown 锁定展示
  assert.ok(pageSource.includes('directPhase === \'unknown\' || isDirectDraftLocked'), '需包含 unknown 或草稿锁定的警示判定')
  assert.ok(pageSource.includes('发布结果未知，已锁定禁止重试'), '需明确警示发布结果未知已锁定禁止重试')

  // 主按钮在 unknown 锁定时禁用
  assert.ok(pageSource.includes('isDirectDraftLocked'), '主按钮在锁定状态下必须受控禁用')
})

test('描述模式下UI删除指定字段：取消主页面与弹窗独立标题输入、划线原价、主图URL输入及标题前后缀规则', () => {
  // 1. 主页面 PublishPage.vue 移除指定输入字段
  assert.ok(!pageSource.includes('id="edit-title"'), '主页面必须移除独立标题输入框 #edit-title')
  assert.ok(!pageSource.includes('id="edit-orig-price"'), '主页面必须移除划线原价输入框 #edit-orig-price')
  assert.ok(!pageSource.includes('id="edit-cover-url"'), '主页面必须移除主图URL输入框 #edit-cover-url')
  assert.ok(!pageSource.includes('customRule.titlePrefix'), '主页面必须移除规则标题前缀输入')
  assert.ok(!pageSource.includes('customRule.titleSuffix'), '主页面必须移除规则标题后缀输入')
  assert.ok(!pageSource.includes('record-id-badge'), '主页面飞书 Record badge 必须只删除展示')
  assert.ok(!pageSource.includes('class="price-orig"'), '主页面最终参数预览必须移除划线原价展示')

  // 2. DirectPublishModal 移除独立标题输入
  assert.ok(!modalSource.includes('id="draft-title"'), '审核弹窗必须移除独立标题输入框 #draft-title')
})

test('emoji提醒改为小图标悬浮Tooltip（默认不展示长文本）且文字描述不再提“标题/描述”', () => {
  // 1. 不再以长条展示默认长文本
  assert.ok(!pageSource.includes('class="emoji-cleanup-tip"'), '不得再以默认展开的长条形式展示 emoji 提示')
  assert.ok(pageSource.includes('class="emoji-tooltip-trigger"'), '必须使用 emoji-tooltip-trigger 小图标包裹')
  assert.ok(pageSource.includes('class="emoji-tooltip-text"'), '必须使用 emoji-tooltip-text 悬浮气泡')

  // 2. 样式中默认隐藏，hover 或 focus 时展现
  const css = styleBlock(pageSource)
  const rule = ruleBlock(css, '.emoji-tooltip-text')
  assert.ok(rule.includes('display:none'), '.emoji-tooltip-text 默认必须隐藏')
  assert.ok(css.includes(':hover .emoji-tooltip-text') || css.includes(':hover.emoji-tooltip-text'), 'hover 时显示 tooltip')

  // 3. 文案不再写“标题 / 描述”
  assert.ok(!pageSource.includes('标题 / 描述中的表情符号'), '文案不再写“标题 / 描述”，仅为描述')
  assert.ok(pageSource.includes('描述中的表情符号（emoji）已在发布前自动清理'), '文案应明确为描述清理')
})

test('发布成功弹窗与页面结果均展示可点击的真实商品链接', () => {
  // 1. 主页面包含真实链接
  assert.ok(pageSource.includes('https://www.goofish.com/item?id='), '主页面成功区域必须包含闲鱼商品链接')
  assert.ok(pageSource.includes('encodeURIComponent(directItemId)'), '商品链接必须使用 encodeURIComponent 处理 itemId')
  assert.ok(pageSource.includes('target="_blank"'), '商品链接必须使用 target="_blank"')
  assert.ok(pageSource.includes('rel="noopener noreferrer"'), '商品链接必须包含 rel="noopener noreferrer"')

  // 2. 弹窗包含真实链接
  assert.ok(modalSource.includes('https://www.goofish.com/item?id='), '弹窗成功区域必须包含闲鱼商品链接')
  assert.ok(modalSource.includes('encodeURIComponent(publishedItemId'), '弹窗链接必须使用 encodeURIComponent 处理 itemId')
  assert.ok(modalSource.includes('target="_blank"'), '弹窗链接必须使用 target="_blank"')
  assert.ok(modalSource.includes('rel="noopener noreferrer"'), '弹窗链接必须包含 rel="noopener noreferrer"')
})

test('两阶段弹窗业务拒绝不切页或锁定：保留在原编辑弹窗，仅展示 error Callout，无“令牌可能失效”旧文案', () => {
  // 1. submit_rejected 状态必须保留在 review-phase-box 中（绝不跳到 unknown 或关闭）
  assert.ok(
    modalSource.includes("phase === 'reviewed' || phase === 'submitting' || phase === 'submit_rejected'"),
    'submit_rejected 必须保持在原审核/编辑弹窗 review-phase-box 内',
  )

  // 2. 存在 Callout 展示错误信息
  assert.ok(
    modalSource.includes("v-if=\"phase === 'submit_rejected' && errorMessage\""),
    'submit_rejected 状态需具有错误提示容器',
  )
  assert.ok(
    modalSource.includes('<Callout tone="error" :title="`提交失败：${errorMessage}`">'),
    'submit_rejected 错误需以 Callout 组件醒目呈现',
  )

  // 3. 不切页：只有在真实 unknown 且锁定态才进入 unknown-box
  assert.ok(
    modalSource.includes("phase === 'unknown'"),
    'unknown 状态独立分支处理',
  )

  // 4. 彻底移除旧统一尾文案
  assert.ok(
    !modalSource.includes('若平台准备令牌已失效'),
    'DirectPublishModal 严禁包含“若平台准备令牌已失效”旧统一尾文案',
  )
})


test('流水时间单行，操作跳转商品地址，缺少链接时禁用查看', () => {
  assert.ok(ruleBlock(styleBlock(pageSource), '.col-time').includes('white-space:nowrap'))
  const history = pageSource.split('id="publish-task-tbody"')[1]!.split('</tbody>')[0]!
  assert.ok(!history.includes('<small'))
  assert.ok(!history.includes('<code'))
  assert.ok(!history.includes('onFocusTask'))
  assert.ok(history.includes(':href="row.itemUrl"'))
  assert.ok(history.includes('disabled'))
  assert.ok(history.includes('缺少有效商品链接'))
})
