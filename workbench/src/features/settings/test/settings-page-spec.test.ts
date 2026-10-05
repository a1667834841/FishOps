/**
 * 设置页 (SettingsPage.vue) Seline 视觉规范、分区完整性与安全防线的源码级回归测试。
 *
 * 遵循《项目开发与测试规范》：
 * 1. 结构与分区：外观、AI、飞书、回复策略、运行环境、账号与授权 6 大分区完整且可达；
 * 2. 交互与无障碍：支持键盘导航 (Enter / Space) 与可见焦点样式；
 * 3. 字段与安全：域名按需授权、HTTP 风险二次确认、API 密钥掩码切换、自动回复二次确认与暂停倒计时；
 * 4. 账号空态真实性：未实现保留明确空态，严禁示例 secret、假成功或新增虚构用量/余额；
 * 5. 加载错误与在途防护：加载错误清晰可见，取消确认不退化业务状态。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const settingsSource = readFileSync(resolve(here, '../../../pages/SettingsPage.vue'), 'utf8')

test('设置页 Seline 视觉规范：包含 6 大分区与导航键盘支持', () => {
  // 6 大分区 id 必须齐全
  const expectedSections = ['appearance', 'ai', 'feishu', 'reply', 'runtime', 'account']
  for (const id of expectedSections) {
    assert.ok(
      settingsSource.includes(`id: '${id}'`),
      `设置分区必须包含 ${id}`,
    )
  }

  // 必须具备 Seline 细线轻标题与黄色 pill 控件类名
  assert.ok(settingsSource.includes('view-header'), '必须包含 Seline view-header 页面轻标题区')
  assert.ok(settingsSource.includes('view-title'), '必须包含 view-title 标题')
  assert.ok(settingsSource.includes('view-sub'), '必须包含 view-sub 副标题')
  assert.ok(settingsSource.includes('pill'), '必须包含 pill 控件类')
  assert.ok(settingsSource.includes('pill--accent'), '必须包含黄色/高亮 pill 控件')

  // 导航需支持键盘导航 (Enter / Space) 与 focus-visible
  assert.ok(settingsSource.includes('onNavKeydown'), '导航必须处理键盘事件')
  assert.ok(settingsSource.includes("event.key === 'Enter'"), '导航必须响应 Enter 键')
  assert.ok(settingsSource.includes("event.key === ' '"), '导航必须响应 Space 键')
  assert.ok(settingsSource.includes(':focus-visible'), '导航与控件必须包含可见焦点样式')
})

test('AI 配置：域名按需授权、HTTP 风险二次确认与无示例 secret', () => {
  // 域名授权
  assert.ok(settingsSource.includes('ai-permission-card'), '必须包含域名按需授权卡片')
  assert.ok(settingsSource.includes('currentAiTargetOrigin'), '必须呈现目标安全 Origin')
  assert.ok(settingsSource.includes('onRequestAiPermission'), '必须绑定授权触发函数')

  // HTTP 明文传输风险提示与强制二次勾选
  assert.ok(settingsSource.includes('currentAiTargetIsHttp'), '必须判断是否为 HTTP 端点')
  assert.ok(settingsSource.includes('HTTP 会明文传输 API Key'), '必须明确提示 HTTP 明文传输风险')
  assert.ok(settingsSource.includes('aiHttpRiskAcknowledged'), '必须绑定 HTTP 风险显式确认字段')

  // 密钥隐藏与严禁示例 secret
  assert.ok(settingsSource.includes('showAiKey'), '必须支持 API Key 隐藏/显示切换')
  assert.ok(!settingsSource.includes('sk-demo'), '严禁包含 sk-demo 等示例假 secret')
  assert.ok(
    settingsSource.includes('••••••••（已在后台配置，留空保持原密钥）'),
    '已配置密钥必须以占位符掩码呈现，不回显明文',
  )

  // 真实测试与保存
  assert.ok(settingsSource.includes('onSaveAi'), '必须具备保存 AI 配置逻辑')
  assert.ok(settingsSource.includes('onTestAi'), '必须具备测试 AI 连接逻辑')
})

test('飞书配置：保持现有真实字段，密钥隐藏，无示例 secret', () => {
  assert.ok(settingsSource.includes('feishuForm.appId'), '必须绑定 appId')
  assert.ok(settingsSource.includes('feishuForm.appSecret'), '必须绑定 appSecret')
  assert.ok(settingsSource.includes('feishuForm.spreadsheetToken'), '必须绑定 spreadsheetToken')
  assert.ok(settingsSource.includes('feishuForm.productTableId'), '必须绑定 productTableId')
  assert.ok(settingsSource.includes('feishuForm.sellerTableId'), '必须绑定 sellerTableId')

  // 密钥隐藏切换
  assert.ok(settingsSource.includes('showAppSecret'), '必须支持 App Secret 显示隐藏切换')
  assert.ok(settingsSource.includes('showSpreadsheetToken'), '必须支持 Spreadsheet Token 显示隐藏切换')

  // 严禁示例假凭证
  assert.ok(!settingsSource.includes('demo-secret'), '严禁包含 demo-secret 等假凭证')
  assert.ok(!settingsSource.includes('demo-sheet-token'), '严禁包含 demo-sheet-token 等假凭证')

  // 保存与测试
  assert.ok(settingsSource.includes('onSaveFeishu'), '必须具备保存飞书配置逻辑')
  assert.ok(settingsSource.includes('onTestFeishu'), '必须具备测试飞书连接逻辑')
})

test('回复策略：开启自动回复二次确认、暂停倒计时与规则面板规范挂载', () => {
  // 必须保留全局回复策略卡片标题（满足既有回归测试）
  assert.ok(settingsSource.includes('回复策略与安全控制'), '卡片标题必须包含回复策略与安全控制')

  // 自动回复开启二次确认
  assert.ok(settingsSource.includes('pendingAutoConfirm'), '必须包含自动回复开启待确认状态')
  assert.ok(settingsSource.includes('onConfirmAutoSave'), '必须包含二次确认保存处理')
  assert.ok(settingsSource.includes('onCancelAutoSave'), '必须包含取消确认处理')
  assert.ok(settingsSource.includes('安全确认：您正在开启【AI 自动回复】模式'), '二次确认文案明确')

  // AI 暂停与倒计时
  assert.ok(settingsSource.includes('pauseCountdown'), '必须计算并呈现剩余倒计时')
  assert.ok(settingsSource.includes('onTogglePause'), '必须支持切换暂停状态')

  // 规则面板挂载（不写 ReplyRulesPanel，但必须以 rules-only 挂载）
  assert.ok(settingsSource.includes('rules-only'), 'ReplyRulesPanel 必须以 rules-only 模式挂载')
  assert.ok(
    /v-if="activeSection === 'reply'"/.test(settingsSource),
    'ReplyRulesPanel 仅在 reply 分区按需加载渲染',
  )
})

test('运行环境与账号授权：保留明确未实现空态，严禁假成功/虚构用量', () => {
  // 运行环境
  assert.ok(settingsSource.includes('bridgeLabels'), '必须展示真实 Bridge 状态')
  assert.ok(settingsSource.includes('status.rtt'), '必须展示真实 RTT 耗时')
  assert.ok(settingsSource.includes('emit(\'diagnostics\')'), '必须支持调用连接诊断')
  assert.ok(settingsSource.includes('controller.runCapabilityChecks()'), '必须支持重新检查能力')

  // 账号与授权明确空态
  assert.ok(settingsSource.includes('placeholder-wrap'), '必须包含未实现空态容器')
  assert.ok(settingsSource.includes('账号与授权功能暂未实现'), '空态标题必须明确说明暂未实现')
  assert.ok(
    settingsSource.includes('当前版本不包含账号体系、登录、会员、套餐与余额'),
    '必须明确说明不包含账号、余额与用量',
  )

  // 严禁假成功与新增虚构用量
  assert.ok(!settingsSource.includes('已成功授权'), '账号页面严禁虚构已成功授权')
  assert.ok(!settingsSource.includes('剩余点数'), '严禁新增剩余点数等虚构用量')
  assert.ok(!settingsSource.includes('剩余额度'), '严禁新增剩余额度等虚构用量')
})

test('错误回显与加载容错：关键错误均有对应 Callout 呈现', () => {
  assert.ok(settingsSource.includes('state.realtimeError'), '必须呈现全局实时通信异常')
  assert.ok(settingsSource.includes('state.reply.loadError'), '必须呈现回复策略加载失败错误')
  assert.ok(settingsSource.includes('state.reply.pauseError'), '必须呈现 AI 暂停控制错误')
  assert.ok(settingsSource.includes('state.ai.saveError'), '必须呈现 AI 保存错误')
  assert.ok(settingsSource.includes('state.feishu.saveError'), '必须呈现飞书保存错误')
})
