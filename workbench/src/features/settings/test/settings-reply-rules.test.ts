/**
 * 设置页「回复策略」分区挂载回复规则编辑器的回归测试。
 *
 * 背景：规则 CRUD 从聊天中心迁到设置页，和既有全局策略表单同处「回复策略」分区。
 * 要求：
 * 1. 规则面板仅在「回复策略」分区按需渲染，并复用聊天中心的 ReplyController
 *    （与全局策略同一后台来源，规则保存只提交 rules，不覆盖全局策略）；
 * 2. 不复制 ReplyRulesPanel 的全局配置 UI，避免设置页出现两套全局表单；
 * 3. ReplyRulesPanel 新增 rulesOnly，且独立规则页不依赖旧的 globalDraft gate。
 *
 * 项目暂无组件测试环境，沿用 publish-layout.test.ts 的源码级断言模式。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const settingsSource = readFileSync(resolve(here, '../../../pages/SettingsPage.vue'), 'utf8')
const panelSource = readFileSync(resolve(here, '../../../components/chat/ReplyRulesPanel.vue'), 'utf8')

test('设置页「回复策略」分区挂载规则编辑器，并复用 ReplyController', () => {
  assert.ok(
    settingsSource.includes("import('../components/chat/ReplyRulesPanel.vue')"),
    '设置页必须懒加载 ReplyRulesPanel，避免其余分区开销',
  )
  assert.ok(settingsSource.includes('REPLY_EVENTS'), '设置页必须订阅 REPLY_EVENTS')
  assert.ok(settingsSource.includes('new ReplyController({ api })'), '设置页必须创建 ReplyController')
  assert.ok(/v-if="activeSection === 'reply'"/.test(settingsSource), '规则面板必须仅在「回复策略」分区渲染')
  assert.ok(settingsSource.includes('rules-only'), '必须以 rulesOnly 模式挂载规则面板，隐藏全局配置卡')
  assert.ok(settingsSource.includes(':reply="replyRulesState"'), '规则面板需绑定规则状态')
  assert.ok(settingsSource.includes(':controller="replyRulesController"'), '规则面板需绑定规则控制器')
  // 既有全局策略表单必须保留，规则面板只承载规则 CRUD
  assert.ok(settingsSource.includes('回复策略与安全控制'), '必须保留全局策略表单卡片')
})

test('设置页不重复渲染全局回复配置 UI（规则面板只承载规则 CRUD）', () => {
  // ReplyRulesPanel 的全局草稿 / 模式选项 / 校验 / 文案不得出现在设置页
  assert.ok(!settingsSource.includes('globalDraft'), '设置页不得引入 ReplyRulesPanel 的全局草稿')
  assert.ok(!settingsSource.includes('MODE_OPTIONS'), '设置页不得复制全局模式选项')
  assert.ok(!settingsSource.includes('buildGlobalPatch'), '设置页不得复制全局配置校验')
  assert.ok(!settingsSource.includes('以下均为后台当前真实配置'), '设置页不得复制全局配置卡文案')
})

test('ReplyRulesPanel 新增可选 rulesOnly，且独立规则页不依赖旧的 globalDraft gate', () => {
  assert.ok(/rulesOnly\?: boolean/.test(panelSource), '必须新增可选 rulesOnly 属性且默认兼容')
  assert.ok(
    !panelSource.includes('v-else-if="globalDraft && config.global"'),
    '必须移除旧的 globalDraft gate，避免独立规则页因全局草稿未同步而不显示',
  )
  assert.ok(
    /v-if="!rulesOnly"[\s\S]{0,240}?安全默认/.test(panelSource),
    'rulesOnly 时必须隐藏引擎级安全说明文案',
  )
  assert.ok(
    /PanelCard v-if="globalDraft && !rulesOnly" title="全局配置"/.test(panelSource),
    'rulesOnly 时必须隐藏全局配置卡',
  )
  // 规则 CRUD 能力完整保留
  assert.ok(panelSource.includes('新建关键词规则'), '必须保留新建关键词规则入口')
  assert.ok(panelSource.includes('新建 AI 规则'), '必须保留新建 AI 规则入口')
  assert.ok(panelSource.includes('保存规则'), '必须保留规则保存')
  assert.ok(panelSource.includes('setRuleEnabled'), '必须保留规则启停')
  assert.ok(panelSource.includes('deleteRule'), '必须保留规则删除')
})
