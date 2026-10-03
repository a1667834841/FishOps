/**
 * 旧扩展配置安全迁移单测（受信载荷模型）：
 * - 跨 extension ID 不读 storage；来源是受信白名单载荷；
 * - dry-run 预览只返回存在性 / 派生 provider，绝不回显 apiKey / appSecret / baseUrl / model；
 * - confirm 写入专用键；规则一律 enabled=false，全局 enabled=false、mode=suggest；
 * - 已有新配置默认不覆盖，overwrite=true 才覆盖；
 * - 规则的 aiApiKey 被净化剥离；
 * - 迁移命令契约（预览需载荷、确认可复用内存来源、overwrite 需 confirm）。
 * 全部使用虚构数据；不读取真实 storage、不访问网络、不输出真实密钥。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CommandTypes,
  createCommand,
  isLegacyConfigTransfer,
  isMigrateLegacyConfigPayload,
} from '@fishops/shared'
import {
  DEFAULT_AI_BASE_URL,
  DEFAULT_REPLY_GLOBAL_CONFIG,
  type KeywordReplyRule,
} from '../../../../shared/types/reply'
import type { LegacyConfigTransfer } from '../../../../shared/types/legacy-migration'
import { MemoryReplyConfigStore } from '../../chat/reply-config'
import { MemoryFeishuConfigStore } from '../../data-source/feishu-config-store'
import { PayloadLegacyConfigSource } from '../../data-source/legacy-config-source'
import { LegacyConfigMigration, describeProvider } from '../../data-source/legacy-config-migration'
import { createMigrationRuntime } from '../../background/migration-runtime'

const LEGACY_AI_KEY = 'sk-legacy-secret-value'
const LEGACY_FEISHU_SECRET = 'app-secret-value'

function dirtyAiRule(): unknown {
  return { id: 'r1', type: 'ai', name: 'AI客服', enabled: true, priority: 1, prompt: '你是客服', aiApiKey: 'sk-rule-secret' }
}

function keywordRule(): KeywordReplyRule {
  return { id: 'r2', type: 'keyword', name: '价格', enabled: true, priority: 2, pattern: '多少钱', reply: '可以谈' }
}

function transfer(patch: Partial<LegacyConfigTransfer> = {}): LegacyConfigTransfer {
  return {
    ai: { apiKey: LEGACY_AI_KEY, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', timeoutMs: 20000 },
    rules: [dirtyAiRule(), keywordRule()],
    global: { enabled: true, defaultCooldown: 30000, defaultDelay: 1000, blacklist: ['u1'] },
    feishu: { appId: 'cli_app_id', appSecret: LEGACY_FEISHU_SECRET, spreadsheetToken: 'bascn_x', productTableId: 'tbl_p', sellerTableId: 'tbl_s' },
    ...patch,
  }
}

function make(replySeed?: ConstructorParameters<typeof MemoryReplyConfigStore>[0]) {
  const replyConfigStore = new MemoryReplyConfigStore(replySeed ?? {})
  const feishuConfigStore = new MemoryFeishuConfigStore()
  const migration = new LegacyConfigMigration({ replyConfigStore, feishuConfigStore })
  return { migration, replyConfigStore, feishuConfigStore }
}

test('preview：只返回存在性 / 派生 provider，不回显任何配置值', async () => {
  const { migration } = make()
  const source = new PayloadLegacyConfigSource(
    transfer({ ai: { apiKey: LEGACY_AI_KEY, baseUrl: 'https://api.deepseek.com/v1?access_token=leaky', model: 'deepseek-chat' } }),
  )
  const preview = await migration.preview(source)
  const json = JSON.stringify(preview)
  assert.ok(!json.includes(LEGACY_AI_KEY))
  assert.ok(!json.includes(LEGACY_FEISHU_SECRET))
  assert.ok(!json.includes('leaky'))
  assert.ok(!json.includes('deepseek-chat'))
  assert.ok(!json.includes('api.deepseek.com'))

  assert.equal(preview.aiProvider.exists, true)
  assert.equal(preview.aiProvider.hasApiKey, true)
  assert.equal(preview.aiProvider.provider, 'deepseek')
  assert.equal(preview.feishuConfig.hasAppSecret, true)
  assert.equal(preview.rules.count, 2)
  assert.deepEqual(preview.globalConfig.fields.includes('blacklist'), true)
  assert.deepEqual(preview.existing, {
    aiProvider: false,
    feishuConfig: false,
    rules: false,
    globalConfig: false,
  })
})

test('migrate：写入专用键、强制安全默认、凭据不回显', async () => {
  const { migration, replyConfigStore, feishuConfigStore } = make()
  const result = await migration.migrate(new PayloadLegacyConfigSource(transfer()), { overwrite: false })

  assert.equal(result.ok, true)
  assert.ok(result.applied.some((a) => a.target === 'aiProvider' && a.configured === true && a.provider === 'deepseek'))
  assert.ok(result.applied.some((a) => a.target === 'rules' && a.count === 2))
  assert.ok(result.applied.some((a) => a.target === 'feishuConfig' && a.configured === true))

  // 结果绝不含明文值 / URL。
  const resultJson = JSON.stringify(result)
  assert.ok(!resultJson.includes(LEGACY_AI_KEY))
  assert.ok(!resultJson.includes(LEGACY_FEISHU_SECRET))
  assert.ok(!resultJson.includes('sk-rule-secret'))
  assert.ok(!resultJson.includes('api.deepseek.com'))

  // 凭据落到专用存储。
  assert.equal((await replyConfigStore.loadAiProvider()).apiKey, LEGACY_AI_KEY)
  assert.equal((await feishuConfigStore.load())?.appSecret, LEGACY_FEISHU_SECRET)

  // 安全默认：规则一律禁用 + 净化（无 aiApiKey）。
  const rules = await replyConfigStore.loadRules()
  assert.equal(rules.length, 2)
  assert.ok(rules.every((rule) => rule.enabled === false))
  assert.ok(rules.every((rule) => !('aiApiKey' in rule)))

  // 安全默认：全局关闭 + 建议模式，仅迁移非敏感调优字段。
  const global = await replyConfigStore.loadGlobalConfig()
  assert.equal(global.enabled, false)
  assert.equal(global.mode, 'suggest')
  assert.equal(global.defaultCooldown, 30000)
  assert.equal(global.defaultDelay, 1000)
  assert.deepEqual(global.blacklist, ['u1'])
})

test('不覆盖已有新配置：默认跳过 existing-config', async () => {
  const { migration, replyConfigStore, feishuConfigStore } = make({
    global: { ...DEFAULT_REPLY_GLOBAL_CONFIG, enabled: true },
    rules: [keywordRule()],
    aiProvider: { apiKey: 'existing-key', baseUrl: DEFAULT_AI_BASE_URL, model: 'm', timeoutMs: 1000 },
  })
  await feishuConfigStore.save(transfer().feishu as never)

  const result = await migration.migrate(new PayloadLegacyConfigSource(transfer()), { overwrite: false })
  assert.equal(result.ok, true)
  for (const target of ['aiProvider', 'feishuConfig', 'rules', 'globalConfig']) {
    assert.ok(result.skipped.some((s) => s.target === target && s.reason === 'existing-config'))
  }
  assert.equal((await replyConfigStore.loadAiProvider()).apiKey, 'existing-key')
})

test('overwrite=true：显式覆盖已有配置（仍强制安全默认）', async () => {
  const { migration, replyConfigStore } = make({
    aiProvider: { apiKey: 'existing-key', baseUrl: DEFAULT_AI_BASE_URL, model: 'm', timeoutMs: 1000 },
  })
  const result = await migration.migrate(new PayloadLegacyConfigSource(transfer()), { overwrite: true })
  assert.ok(result.applied.some((a) => a.target === 'aiProvider'))
  assert.equal((await replyConfigStore.loadAiProvider()).apiKey, LEGACY_AI_KEY)
  const global = await replyConfigStore.loadGlobalConfig()
  assert.equal(global.enabled, false)
  assert.equal(global.mode, 'suggest')
})

test('飞书配置不完整：结构化跳过 invalid-source', async () => {
  const { migration, feishuConfigStore } = make()
  const result = await migration.migrate(
    new PayloadLegacyConfigSource(transfer({ feishu: { appId: 'cli', appSecret: 's', spreadsheetToken: 'b', productTableId: '' } })),
    { overwrite: false },
  )
  assert.ok(result.skipped.some((s) => s.target === 'feishuConfig' && s.reason === 'invalid-source'))
  assert.equal(await feishuConfigStore.hasConfig(), false)
})

test('空载荷：全部 missing-source，不写入任何目标', async () => {
  const { migration, replyConfigStore } = make()
  const result = await migration.migrate(new PayloadLegacyConfigSource({}), { overwrite: false })
  assert.equal(result.ok, true)
  assert.deepEqual(result.applied, [])
  assert.equal(result.skipped.filter((s) => s.reason === 'missing-source').length, 4)
  assert.equal((await replyConfigStore.loadAiProvider()).apiKey, '')
})

test('PayloadLegacyConfigSource：规则净化剥离 aiApiKey', async () => {
  const source = new PayloadLegacyConfigSource(transfer())
  const rules = await source.readRules()
  assert.equal(rules?.rules.length, 2)
  assert.ok(rules?.rules.every((rule) => !('aiApiKey' in rule)))
})

test('迁移命令契约：预览需载荷；确认复用内存来源；overwrite 需 confirm', async () => {
  const { migration } = make()
  const runtime = createMigrationRuntime({ migration })

  // 预览必须携带 legacy。
  const noPayload = await runtime.handleCommand(createCommand(CommandTypes.MIGRATE_LEGACY_CONFIG, { dryRun: true }))
  assert.equal(noPayload.ok, false)
  assert.equal(noPayload.error?.code, 'INVALID_PAYLOAD')

  // 预览携带 legacy → mode preview，无 result。
  const previewResponse = await runtime.handleCommand(
    createCommand(CommandTypes.MIGRATE_LEGACY_CONFIG, { legacy: transfer() }),
  )
  assert.equal(previewResponse.ok, true)
  const previewResult = previewResponse.result as { mode: string; preview?: unknown; result?: unknown }
  assert.equal(previewResult.mode, 'preview')
  assert.ok(previewResult.preview)
  assert.equal(previewResult.result, undefined)

  // 确认复用内存来源（不重复携带 legacy）。
  const applied = await runtime.handleCommand(createCommand(CommandTypes.MIGRATE_LEGACY_CONFIG, { confirm: true }))
  assert.equal(applied.ok, true)
  const appliedResult = applied.result as { mode: string; result?: { applied: unknown[] } }
  assert.equal(appliedResult.mode, 'applied')
  assert.ok(Array.isArray(appliedResult.result?.applied))

  // 迁移后内存来源已清空 → 再次确认失败。
  const again = await runtime.handleCommand(createCommand(CommandTypes.MIGRATE_LEGACY_CONFIG, { confirm: true }))
  assert.equal(again.ok, false)
  assert.equal(again.error?.code, 'INVALID_PAYLOAD')

  // overwrite 必须同时 confirm（协议层拒绝）。
  const badOverwrite = await runtime.handleCommand(
    createCommand(CommandTypes.MIGRATE_LEGACY_CONFIG, { overwrite: true } as never),
  )
  assert.equal(badOverwrite.ok, false)
  assert.equal(badOverwrite.error?.code, 'INVALID_PAYLOAD')
})

test('校验：受信载荷严格白名单', () => {
  assert.equal(isMigrateLegacyConfigPayload({}), true)
  assert.equal(isMigrateLegacyConfigPayload({ legacy: { ai: { apiKey: 'x' } } }), true)
  assert.equal(isMigrateLegacyConfigPayload({ legacy: {} }), true)
  // 未知顶层键 / 分区未知键一律拒绝。
  assert.equal(isMigrateLegacyConfigPayload({ legacy: { evil: 1 } }), false)
  assert.equal(isMigrateLegacyConfigPayload({ legacy: { ai: { token: 'x' } } }), false)
  assert.equal(isMigrateLegacyConfigPayload({ secret: 'x' }), false)
  // rules 必须是数组。
  assert.equal(isMigrateLegacyConfigPayload({ legacy: { rules: 'nope' } }), false)
  assert.equal(isLegacyConfigTransfer({ rules: [{}], global: { enabled: true } }), true)
  assert.equal(isLegacyConfigTransfer({ global: { enabled: 'yes' } }), false)
  assert.equal(isLegacyConfigTransfer(null), false)
})

test('辅助：describeProvider', () => {
  assert.equal(describeProvider('https://dashscope.aliyuncs.com/compatible-mode/v1'), 'dashscope')
  assert.equal(describeProvider('https://api.deepseek.com/v1'), 'deepseek')
  assert.equal(describeProvider('https://api.openai.com/v1'), 'openai')
})
