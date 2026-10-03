/**
 * SettingsController 单测：
 * 覆盖专用命令 AI_CONFIG_SET / AI_CONFIG_STATUS / FEISHU_CONFIG_SET / FEISHU_CONFIG_STATUS，
 * 严禁调用 MIGRATE_LEGACY_CONFIG；
 * 覆盖 baseUrl 留空保留端点、sellerTableId 留空防清除、飞书连接真实测试、
 * 回复策略安全闸二次确认、AI 暂停控制及各类错误状态（loadError/pauseError/saveError）。
 * 纯 Node 运行，绝不依赖浏览器、Vue 或真实扩展。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommandTypes, type EventPayloadMap, type EventType } from '@fishops/shared'
import {
  DEFAULT_REPLY_GLOBAL_CONFIG,
  type AiConfigSetPayload,
  type AiConfigStatus,
  type FeishuConfigSetPayload,
  type FeishuConfigStatus,
} from '../../contracts'
import type { BridgeApi } from '../../shared/bridge-api'
import {
  inferAiProvider,
  SettingsController,
  AI_CONFIG_TEST_COMMAND,
  formatAiTestError,
} from '../settings-controller'

class MockBridgeApi implements BridgeApi {
  readonly calls: Array<{ type: string; payload: unknown }> = []
  readonly handlers = new Map<string, Set<(payload: unknown) => void>>()
  private readonly responders = new Map<string, (payload: unknown) => unknown>()

  respond(type: string, handler: (payload: unknown) => unknown): void {
    this.responders.set(type, handler)
  }

  async call(type: string, payload: unknown): Promise<any> {
    this.calls.push({ type, payload })
    const handler = this.responders.get(type)
    if (!handler) {
      throw new Error(`未配置 mock 响应: ${type}`)
    }
    return handler(payload)
  }

  on<T extends EventType>(type: T, handler: (payload: EventPayloadMap[T]) => void): () => void {
    const set = this.handlers.get(type) ?? new Set()
    set.add(handler as (payload: unknown) => void)
    this.handlers.set(type, set)
    return () => set.delete(handler as (payload: unknown) => void)
  }

  resubscribe(): void {}

  emit(type: string, payload: unknown): void {
    const set = this.handlers.get(type)
    if (set) {
      for (const h of set) h(payload)
    }
  }
}

function makeApi(): MockBridgeApi {
  const api = new MockBridgeApi()

  api.respond(CommandTypes.AI_CONFIG_STATUS, () => ({
    configured: false,
    provider: 'OpenAI 兼容',
    model: 'gpt-4o-mini',
    timeoutMs: 30000,
  } satisfies AiConfigStatus))

  api.respond(CommandTypes.FEISHU_CONFIG_STATUS, () => ({
    configured: false,
    hasAppId: false,
    hasAppSecret: false,
    hasSpreadsheetToken: false,
    hasProductTableId: false,
    hasSellerTableId: false,
  } satisfies FeishuConfigStatus))

  api.respond(CommandTypes.CHAT_RULES_GET, () => ({
    global: {
      enabled: false,
      mode: 'suggest',
      defaultCooldown: 60000,
      defaultDelay: 1000,
      blacklist: [],
      handoffKeywords: ['转人工'],
      maxAutoRepliesPerSession: 5,
      autoReplyWindowMs: 600000,
      aiPauseDurationMs: 600000,
      maxContentLength: 2000,
    },
    rules: [],
  }))

  api.respond(CommandTypes.CHAT_AUTO_REPLY_STATUS, () => ({
    configLoaded: true,
    enabled: false,
    mode: 'suggest',
    rulesCount: 0,
    processedCount: 0,
    aiPaused: false,
    aiPausedUntil: 0,
    aiPauseReason: null,
    aiConfigured: false,
  }))

  return api
}

test('inferAiProvider：由 baseUrl 识别常见提供商', () => {
  assert.equal(inferAiProvider('https://api.deepseek.com/v1'), 'DeepSeek')
  assert.equal(inferAiProvider('https://dashscope.aliyuncs.com/compatible-mode/v1'), '通义千问 (DashScope)')
  assert.equal(inferAiProvider('https://api.openai.com/v1'), 'OpenAI')
  assert.equal(inferAiProvider('https://my-custom-proxy.internal/v1'), 'my-custom-proxy.internal')
  assert.equal(inferAiProvider(''), 'OpenAI 兼容')
})

test('非扩展环境：availability 为 unavailable，不调用 api', () => {
  const ctrl = new SettingsController({ api: null })
  assert.equal(ctrl.getState().availability, 'unavailable')
  ctrl.start()
  assert.equal(ctrl.getState().ai.configured, false)
})

test('AI 配置：首次保存未填写 API Key 报错拦截，且绝不调用 MIGRATE_LEGACY_CONFIG', async () => {
  const api = makeApi()
  const ctrl = new SettingsController({ api })
  ctrl.start()

  const ok = await ctrl.saveAiConfig({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '   ',
    model: 'deepseek-chat',
    timeoutMs: 30000,
  })

  assert.equal(ok, false)
  assert.equal(ctrl.getState().ai.savePhase, 'failed')
  assert.equal(ctrl.getState().ai.saveError, '请填写 API Key')
  assert.equal(api.calls.filter((c) => c.type === CommandTypes.AI_CONFIG_SET).length, 0)
  assert.equal(api.calls.filter((c) => c.type === CommandTypes.MIGRATE_LEGACY_CONFIG).length, 0)
})

test('AI 配置：调用专用命令 AI_CONFIG_SET，状态更新且 state 绝不含明文 key', async () => {
  const api = makeApi()
  api.respond(CommandTypes.AI_CONFIG_SET, (payload: any) => {
    const p = payload as AiConfigSetPayload
    assert.equal(p.apiKey, 'sk-test-secret-123')
    assert.equal(p.baseUrl, 'https://api.deepseek.com/v1')
    assert.equal(p.model, 'deepseek-chat')
    assert.equal(p.timeoutMs, 30000)
    return {
      configured: true,
      provider: 'DeepSeek',
      model: 'deepseek-chat',
      timeoutMs: 30000,
    } satisfies AiConfigStatus
  })

  const ctrl = new SettingsController({ api })
  ctrl.start()

  const ok = await ctrl.saveAiConfig({
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'sk-test-secret-123',
    model: 'deepseek-chat',
    timeoutMs: 30000,
  })

  assert.equal(ok, true)
  const state = ctrl.getState()
  assert.equal(state.ai.savePhase, 'ok')
  assert.equal(state.ai.configured, true)
  assert.equal(state.ai.provider, 'DeepSeek')
  assert.equal(state.ai.model, 'deepseek-chat')
  assert.equal(state.ai.timeoutMs, 30000)

  // 严禁调用 MIGRATE_LEGACY_CONFIG
  assert.equal(api.calls.filter((c) => c.type === CommandTypes.MIGRATE_LEGACY_CONFIG).length, 0)

  // 安全检查：state 序列化字符串中绝不能包含明文 key
  assert.ok(!JSON.stringify(state).includes('sk-test-secret-123'))
})

test('AI 配置：PATCH 语义，baseUrl 留空时不发送 baseUrl 字段，保留后台现有端点', async () => {
  const api = makeApi()
  let receivedPayload: AiConfigSetPayload | undefined
  api.respond(CommandTypes.AI_CONFIG_SET, (payload: any) => {
    receivedPayload = payload as AiConfigSetPayload
    return {
      configured: true,
      provider: 'DeepSeek',
      model: 'deepseek-reasoner',
      timeoutMs: 60000,
    } satisfies AiConfigStatus
  })

  const ctrl = new SettingsController({ api })
  ctrl.start()

  // 先模拟已配置状态
  api.respond(CommandTypes.AI_CONFIG_STATUS, () => ({
    configured: true,
    provider: 'DeepSeek',
    model: 'deepseek-chat',
    timeoutMs: 30000,
  }))
  await ctrl.loadAiStatus()

  // 用户修改模型和超时，留空 baseUrl 与 apiKey
  const ok = await ctrl.saveAiConfig({
    baseUrl: '',
    model: 'deepseek-reasoner',
    timeoutMs: 60000,
  })

  assert.equal(ok, true)
  assert.equal(receivedPayload?.apiKey, undefined)
  assert.equal(receivedPayload?.baseUrl, undefined, 'baseUrl 留空时不应传递该字段，以保留后台已有端点')
  assert.equal(receivedPayload?.model, 'deepseek-reasoner')
  assert.equal(receivedPayload?.timeoutMs, 60000)
  assert.equal(ctrl.getState().ai.model, 'deepseek-reasoner')
})

test('AI 配置：URL 包含认证信息或查询参数时拦截并提示禁止', async () => {
  const api = makeApi()
  const ctrl = new SettingsController({ api })
  ctrl.start()

  // 1. 尝试传入带密码认证信息的 URL
  const r1 = await ctrl.saveAiConfig({
    apiKey: 'sk-123',
    baseUrl: 'https://user:pass@api.openai.com/v1',
  })
  assert.equal(r1, false)
  assert.equal(ctrl.getState().ai.savePhase, 'failed')
  assert.match(ctrl.getState().ai.saveError ?? '', /禁止包含用户名或密码/)

  // 2. 尝试传入带查询参数的 URL
  const r2 = await ctrl.saveAiConfig({
    apiKey: 'sk-123',
    baseUrl: 'https://api.openai.com/v1?token=secret',
  })
  assert.equal(r2, false)
  assert.equal(ctrl.getState().ai.savePhase, 'failed')
  assert.match(ctrl.getState().ai.saveError ?? '', /禁止包含查询参数/)

  // 3. 尝试传入带片段标识的 URL
  const r2b = await ctrl.saveAiConfig({
    apiKey: 'sk-123',
    baseUrl: 'https://api.openai.com/v1#frag',
  })
  assert.equal(r2b, false)
  assert.equal(ctrl.getState().ai.savePhase, 'failed')
  assert.match(ctrl.getState().ai.saveError ?? '', /禁止包含片段标识/)

  // 4. 正常 HTTPS URL 成功保存并同步 permissionOrigin
  api.respond(CommandTypes.AI_CONFIG_SET, () => ({
    configured: true,
    provider: 'OpenAI',
    model: 'gpt-4o-mini',
    timeoutMs: 30000,
    permissionOrigin: 'https://api.openai.com',
  }))
  const r3 = await ctrl.saveAiConfig({
    apiKey: 'sk-123',
    baseUrl: 'https://api.openai.com/v1',
  })
  assert.equal(r3, true)
  assert.equal(ctrl.getState().ai.permissionOrigin, 'https://api.openai.com')
})

test('AI 配置：HTTP 端点允许保存并同步保留 scheme 的 permissionOrigin', async () => {
  const api = makeApi()
  let receivedPayload: AiConfigSetPayload | undefined
  api.respond(CommandTypes.AI_CONFIG_SET, (payload: any) => {
    receivedPayload = payload as AiConfigSetPayload
    return {
      configured: true,
      provider: '192.168.1.10:8080',
      model: 'local-model',
      timeoutMs: 30000,
      permissionOrigin: 'http://192.168.1.10:8080',
    } satisfies AiConfigStatus
  })

  const ctrl = new SettingsController({ api })
  ctrl.start()

  const ok = await ctrl.saveAiConfig({
    apiKey: 'sk-http-secret',
    baseUrl: 'http://192.168.1.10:8080/v1',
  })

  assert.equal(ok, true)
  assert.equal(receivedPayload?.baseUrl, 'http://192.168.1.10:8080/v1')
  assert.equal(ctrl.getState().ai.permissionOrigin, 'http://192.168.1.10:8080')
  // state 绝不包含明文 key
  assert.equal(JSON.stringify(ctrl.getState()).includes('sk-http-secret'), false)
})

test('同步 status：loadAiStatus 确实同步 permissionOrigin 与 configured 到 state', async () => {
  const api = makeApi()
  const ctrl = new SettingsController({ api })
  ctrl.start()

  // 1. 模拟正常 HTTPS 端点配置载入
  api.respond(CommandTypes.AI_CONFIG_STATUS, () => ({
    configured: true,
    provider: 'DeepSeek',
    model: 'deepseek-chat',
    timeoutMs: 30000,
    permissionOrigin: 'https://api.deepseek.com',
  }))
  await ctrl.loadAiStatus()
  assert.equal(ctrl.getState().ai.configured, true)
  assert.equal(ctrl.getState().ai.permissionOrigin, 'https://api.deepseek.com')

  // 2. 模拟旧版存储了无效端点（extractSafeAiOrigin 拒绝后 permissionOrigin 缺失）
  api.respond(CommandTypes.AI_CONFIG_STATUS, () => ({
    configured: true,
    provider: 'Custom HTTP Provider',
    model: 'custom-model',
    timeoutMs: 30000,
    // permissionOrigin 缺失
  }))
  await ctrl.loadAiStatus()
  assert.equal(ctrl.getState().ai.configured, true)
  assert.equal(ctrl.getState().ai.permissionOrigin, null, '无效端点下 permissionOrigin 必须确实同步更新为 null')

  // 3. 模拟后台返回 HTTP 端点（保留 scheme），必须原样同步供设置页提示明文风险
  api.respond(CommandTypes.AI_CONFIG_STATUS, () => ({
    configured: true,
    provider: '192.168.1.10:8080',
    model: 'local-model',
    timeoutMs: 30000,
    permissionOrigin: 'http://192.168.1.10:8080',
  }))
  await ctrl.loadAiStatus()
  assert.equal(ctrl.getState().ai.permissionOrigin, 'http://192.168.1.10:8080')
})

test('飞书配置：首次配置必填字段校验，且严禁调用 MIGRATE_LEGACY_CONFIG', async () => {
  const api = makeApi()
  const ctrl = new SettingsController({ api })
  ctrl.start()

  const ok = await ctrl.saveFeishuConfig({
    appId: '',
    appSecret: 'sec',
    spreadsheetToken: 'token',
    productTableId: 'tbl1',
  })

  assert.equal(ok, false)
  assert.equal(ctrl.getState().feishu.savePhase, 'failed')
  assert.ok(ctrl.getState().feishu.saveError?.includes('请完整填写'))
  assert.equal(api.calls.filter((c) => c.type === CommandTypes.MIGRATE_LEGACY_CONFIG).length, 0)
})

test('飞书配置：sellerTableId 留空时不发送 sellerTableId 字段，防止清除已有配置', async () => {
  const api = makeApi()
  let receivedPayload: FeishuConfigSetPayload | undefined
  api.respond(CommandTypes.FEISHU_CONFIG_SET, (payload: any) => {
    receivedPayload = payload as FeishuConfigSetPayload
    return {
      configured: true,
      hasAppId: true,
      hasAppSecret: true,
      hasSpreadsheetToken: true,
      hasProductTableId: true,
      hasSellerTableId: true,
    } satisfies FeishuConfigStatus
  })

  const ctrl = new SettingsController({ api })
  ctrl.start()

  // 模拟已配置状态
  api.respond(CommandTypes.FEISHU_CONFIG_STATUS, () => ({
    configured: true,
    hasAppId: true,
    hasAppSecret: true,
    hasSpreadsheetToken: true,
    hasProductTableId: true,
    hasSellerTableId: true,
  }))
  await ctrl.loadFeishuStatus()

  // 保存时 sellerTableId 为未填/空串
  const saved = await ctrl.saveFeishuConfig({
    productTableId: 'tbl_new_prod',
    sellerTableId: '',
  })

  assert.equal(saved, true)
  assert.equal(receivedPayload?.sellerTableId, undefined, 'sellerTableId 未输入时不应传，防止清除后台已有值')
  assert.equal('sellerTableId' in (receivedPayload ?? {}), false)
})

test('飞书配置：调用专用命令 FEISHU_CONFIG_SET 与 FEISHU_CONFIG_STATUS 并真实测试连接', async () => {
  const api = makeApi()
  api.respond(CommandTypes.FEISHU_CONFIG_SET, (payload: any) => {
    const p = payload as FeishuConfigSetPayload
    assert.equal(p.appId, 'cli_123')
    assert.equal(p.appSecret, 'secret_456')
    assert.equal(p.spreadsheetToken, 'sht_789')
    assert.equal(p.productTableId, 'tbl_products')
    return {
      configured: true,
      hasAppId: true,
      hasAppSecret: true,
      hasSpreadsheetToken: true,
      hasProductTableId: true,
      hasSellerTableId: false,
    } satisfies FeishuConfigStatus
  })

  api.respond(CommandTypes.DATA_SOURCE_SCHEMA, () => ({
    schema: {
      name: '飞书商品表',
      fields: [{ id: 'f1', name: '标题', type: 'text' }, { id: 'f2', name: '价格', type: 'number' }],
    },
  }))

  const ctrl = new SettingsController({ api })
  ctrl.start()

  const saved = await ctrl.saveFeishuConfig({
    appId: 'cli_123',
    appSecret: 'secret_456',
    spreadsheetToken: 'sht_789',
    productTableId: 'tbl_products',
  })
  assert.equal(saved, true)
  assert.equal(ctrl.getState().feishu.savePhase, 'ok')
  assert.equal(ctrl.getState().feishu.configured, true)
  assert.equal(ctrl.getState().feishu.hasAppId, true)
  assert.equal(ctrl.getState().feishu.hasAppSecret, true)

  // 严禁调用旧迁移命令
  assert.equal(api.calls.filter((c) => c.type === CommandTypes.MIGRATE_LEGACY_CONFIG).length, 0)

  // 安全检查：state 绝不含明文 secret
  assert.ok(!JSON.stringify(ctrl.getState()).includes('secret_456'))
  assert.ok(!JSON.stringify(ctrl.getState()).includes('sht_789'))

  // 测试飞书连接真实读取多维表格
  const tested = await ctrl.testFeishuConnection()
  assert.equal(tested, true)
  assert.equal(ctrl.getState().feishu.testPhase, 'ok')
  assert.ok(ctrl.getState().feishu.testSuccess?.includes('共 2 个字段'))
})

test('回复策略：开启 auto 模式未确认时拦截，确认后保存', async () => {
  const api = makeApi()
  api.respond(CommandTypes.CHAT_RULES_SET, (payload: any) => ({
    global: {
      ...DEFAULT_REPLY_GLOBAL_CONFIG,
      ...payload.global,
    },
    rules: [],
  }))

  const ctrl = new SettingsController({ api })
  ctrl.start()
  await ctrl.loadReplyConfig()

  // 未确认开启 auto
  const outcome1 = await ctrl.saveReplyStrategy({ mode: 'auto', enabled: true }, false)
  assert.equal(outcome1.ok, false)
  assert.equal(outcome1.needsAutoConfirm, true)

  // 确认开启 auto
  const outcome2 = await ctrl.saveReplyStrategy({ mode: 'auto', enabled: true }, true)
  assert.equal(outcome2.ok, true)
  assert.equal(ctrl.getState().reply.global?.mode, 'auto')
})

test('AI 暂停与恢复控制及错误反馈', async () => {
  const api = makeApi()
  let isPaused = false
  api.respond(CommandTypes.CHAT_AI_PAUSE_SET, (payload: any) => {
    isPaused = payload.paused
    return {
      paused: isPaused,
      pausedUntil: isPaused ? Date.now() + 600000 : 0,
      reason: isPaused ? 'manual' : null,
    }
  })
  api.respond(CommandTypes.CHAT_AUTO_REPLY_STATUS, () => ({
    configLoaded: true,
    enabled: true,
    mode: 'suggest',
    rulesCount: 0,
    processedCount: 0,
    aiPaused: isPaused,
    aiPausedUntil: isPaused ? Date.now() + 600000 : 0,
    aiPauseReason: isPaused ? 'manual' : null,
    aiConfigured: true,
  }))

  const ctrl = new SettingsController({ api })
  ctrl.start()

  // 暂停
  const paused = await ctrl.setAiPause(true, 600000)
  assert.equal(paused, true)
  assert.equal(ctrl.getState().reply.status?.aiPaused, true)

  // 恢复
  const resumed = await ctrl.setAiPause(false)
  assert.equal(resumed, true)
  assert.equal(ctrl.getState().reply.status?.aiPaused, false)

  // 暂停报错时记录 pauseError 供 UI 展示
  api.respond(CommandTypes.CHAT_AI_PAUSE_SET, () => {
    throw new Error('网络异常无法暂停')
  })
  const failedPause = await ctrl.setAiPause(true)
  assert.equal(failedPause, false)
  assert.equal(ctrl.getState().reply.pausePhase, 'failed')
  assert.ok(ctrl.getState().reply.pauseError?.includes('网络异常无法暂停'))
})

test('回复策略加载失败时：正确捕获 loadError 供 UI 展示', async () => {
  const api = makeApi()
  api.respond(CommandTypes.CHAT_RULES_GET, () => {
    throw new Error('读取规则失败')
  })

  const ctrl = new SettingsController({ api })
  await ctrl.loadReplyConfig()

  assert.equal(ctrl.getState().reply.loadPhase, 'error')
  assert.ok(ctrl.getState().reply.loadError?.includes('读取规则失败'))
})

test('AI 接口测试：未保存配置或未配置时拦截，提示先保存', async () => {
  const api = makeApi()
  const ctrl = new SettingsController({ api })
  ctrl.start()

  // 1. 后台未配置时调用
  assert.equal(ctrl.getState().ai.configured, false)
  const ok1 = await ctrl.testAiConnection()
  assert.equal(ok1, false)
  assert.equal(ctrl.getState().ai.testPhase, 'failed')
  assert.ok(ctrl.getState().ai.testError?.includes('未检测到已保存的 AI 配置'))
  assert.equal(ctrl.getState().ai.testErrorView?.code, 'CONFIG_MISSING')
  // 严禁发起后台调用
  assert.equal(api.calls.filter((c) => c.type === AI_CONFIG_TEST_COMMAND).length, 0)

  // 模拟保存配置成功
  api.respond(CommandTypes.AI_CONFIG_SET, () => ({
    configured: true,
    provider: 'OpenAI 兼容',
    model: 'gpt-4o-mini',
    timeoutMs: 30000,
    permissionOrigin: 'https://api.openai.com',
  } satisfies AiConfigStatus))
  await ctrl.saveAiConfig({ apiKey: 'sk-test-valid' })
  assert.equal(ctrl.getState().ai.configured, true)

  // 2. 表单有未保存改动（isDirty: true）时调用
  const ok2 = await ctrl.testAiConnection({ isDirty: true })
  assert.equal(ok2, false)
  assert.equal(ctrl.getState().ai.testPhase, 'failed')
  assert.ok(ctrl.getState().ai.testError?.includes('检测到未保存的配置修改'))
  assert.equal(ctrl.getState().ai.testErrorView?.code, 'UNSAVED_CHANGES')
  // 依然严禁发起后台调用
  assert.equal(api.calls.filter((c) => c.type === AI_CONFIG_TEST_COMMAND).length, 0)
})

test('AI 接口测试：测试按钮不绕过授权，未授权时拦截并提示', async () => {
  const api = makeApi()
  api.respond(CommandTypes.AI_CONFIG_SET, () => ({
    configured: true,
    provider: 'OpenAI 兼容',
    model: 'gpt-4o-mini',
    timeoutMs: 30000,
    permissionOrigin: 'https://api.openai.com',
  } satisfies AiConfigStatus))

  const ctrl = new SettingsController({ api })
  ctrl.start()
  await ctrl.saveAiConfig({ apiKey: 'sk-test-valid' })

  // originGranted 为 false 时拦截
  const ok = await ctrl.testAiConnection({
    originGranted: false,
    origin: 'https://api.openai.com',
  })
  assert.equal(ok, false)
  assert.equal(ctrl.getState().ai.testPhase, 'failed')
  assert.ok(ctrl.getState().ai.testError?.includes('尚未获得授权'))
  assert.equal(ctrl.getState().ai.testErrorView?.code, 'AI_PERMISSION_REQUIRED')
  assert.ok(ctrl.getState().ai.testErrorView?.hint.includes('授权当前AI接口域名'))
  assert.equal(api.calls.filter((c) => c.type === AI_CONFIG_TEST_COMMAND).length, 0)
})

test('AI 接口测试：调用 AI_CONFIG_TEST 空 payload 真实探测，展示模型/耗时/字符数且不泄露明文', async () => {
  const api = makeApi()
  api.respond(CommandTypes.AI_CONFIG_SET, () => ({
    configured: true,
    provider: 'OpenAI 兼容',
    model: 'gpt-4o-mini',
    timeoutMs: 30000,
    permissionOrigin: 'https://api.openai.com',
  } satisfies AiConfigStatus))

  const promptSecret = 'secret_probe_text_xyz'
  const keySecret = 'sk-sensitive-key-123456789'
  const urlSecret = 'https://api.openai.com/v1/chat/completions?auth=sensitive'
  const responseBody = 'This is the raw model response body content.'

  // 后台模拟返回测试结果
  api.respond(AI_CONFIG_TEST_COMMAND, (payload: any) => {
    // 验证空 payload 契约
    assert.deepEqual(payload, {})
    return {
      ok: true,
      model: 'deepseek-chat',
      durationMs: 350,
      charactersCount: 42,
      // 故意带上探测文本与响应体模拟后台可能字段
      probePrompt: promptSecret,
      content: responseBody,
    }
  })

  const ctrl = new SettingsController({ api })
  ctrl.start()
  await ctrl.saveAiConfig({ apiKey: keySecret })

  const ok = await ctrl.testAiConnection()
  assert.equal(ok, true)
  assert.equal(ctrl.getState().ai.testPhase, 'ok')
  const successText = ctrl.getState().ai.testSuccess ?? ''

  // 必须展示模型、耗时、字符数
  assert.ok(successText.includes('deepseek-chat'))
  assert.ok(successText.includes('350ms'))
  assert.ok(successText.includes('42'))

  // 绝对不展示探测文本、API key、完整 URL 或响应 body 明文
  assert.equal(successText.includes(promptSecret), false)
  assert.equal(successText.includes(keySecret), false)
  assert.equal(successText.includes(urlSecret), false)
  assert.equal(successText.includes(responseBody), false)
  assert.equal(JSON.stringify(ctrl.getState()).includes(promptSecret), false)
  assert.equal(JSON.stringify(ctrl.getState()).includes(keySecret), false)
  assert.equal(JSON.stringify(ctrl.getState()).includes(responseBody), false)
})

test('AI 接口测试：按钮 loading 防重复调用', async () => {
  const api = makeApi()
  api.respond(CommandTypes.AI_CONFIG_SET, () => ({
    configured: true,
    provider: 'OpenAI 兼容',
    model: 'gpt-4o-mini',
    timeoutMs: 30000,
    permissionOrigin: 'https://api.openai.com',
  } satisfies AiConfigStatus))

  let resolveCall: (val: any) => void
  api.respond(AI_CONFIG_TEST_COMMAND, () => new Promise((resolve) => {
    resolveCall = resolve
  }))

  const ctrl = new SettingsController({ api })
  ctrl.start()
  await ctrl.saveAiConfig({ apiKey: 'sk-test' })

  // 第一次触发
  const p1 = ctrl.testAiConnection()
  assert.equal(ctrl.getState().ai.testPhase, 'running')

  // 第二次并发触发被拦截
  const p2 = await ctrl.testAiConnection()
  assert.equal(p2, false)
  assert.equal(api.calls.filter((c) => c.type === AI_CONFIG_TEST_COMMAND).length, 1)

  // 完成第一次调用
  resolveCall!({ ok: true, model: 'gpt-4o-mini', durationMs: 120, characterCount: 15 })
  const res1 = await p1
  assert.equal(res1, true)
  assert.equal(ctrl.getState().ai.testPhase, 'ok')
})

test('AI 接口测试：失败显示可行动结构化错误与权限/HTTP 提示，敏感信息脱敏', async () => {
  // 1. 权限错误
  const viewPerm = formatAiTestError(new Error('Failed to fetch: net::ERR_NAME_NOT_RESOLVED'), {
    origin: 'https://api.deepseek.com',
  })
  assert.equal(viewPerm.code, 'AI_PERMISSION_REQUIRED')
  assert.ok(viewPerm.hint.includes('授权当前AI接口域名'))
  assert.ok(viewPerm.hint.includes('https://api.deepseek.com'))

  // 2. HTTP 端点错误
  const viewHttp = formatAiTestError(new Error('connect ECONNREFUSED 127.0.0.1:8080'), {
    isHttp: true,
  })
  assert.equal(viewHttp.code, 'HTTP_ENDPOINT_ERROR')
  assert.ok(viewHttp.hint.includes('HTTP 端点'))
  assert.ok(viewHttp.hint.includes('明文传输风险'))

  // 3. 401 认证错误
  const viewAuth = formatAiTestError(new Error('Request failed with status 401: Incorrect API key provided'))
  assert.equal(viewAuth.code, 'AUTH_FAILED')
  assert.ok(viewAuth.hint.includes('API Key 无效'))

  // 4. 超时错误
  const viewTimeout = formatAiTestError(new Error('Request timed out after 30000ms'))
  assert.equal(viewTimeout.code, 'TIMEOUT')
  assert.ok(viewTimeout.hint.includes('超时上限'))

  // 5. 脱敏测试：不泄露 sk- 密钥与完整 URL 中的 path/query
  const leakErr = new Error('401 at https://api.openai.com/v1/chat/completions?secret=my_secret sk-1234567890abcdef')
  const viewLeak = formatAiTestError(leakErr)
  assert.equal(viewLeak.detail.includes('sk-1234567890abcdef'), false)
  assert.equal(viewLeak.detail.includes('v1/chat/completions'), false)
  assert.equal(viewLeak.detail.includes('my_secret'), false)
  assert.ok(viewLeak.detail.includes('https://api.openai.com'))
})

test('AI 接口测试：clearAlerts 清理测试状态', async () => {
  const api = makeApi()
  api.respond(CommandTypes.AI_CONFIG_SET, () => ({
    configured: true,
    provider: 'OpenAI 兼容',
    model: 'gpt-4o-mini',
    timeoutMs: 30000,
    permissionOrigin: 'https://api.openai.com',
  } satisfies AiConfigStatus))
  api.respond(AI_CONFIG_TEST_COMMAND, () => ({
    ok: true,
    model: 'gpt-4o-mini',
    durationMs: 100,
    characterCount: 10,
  }))

  const ctrl = new SettingsController({ api })
  ctrl.start()
  await ctrl.saveAiConfig({ apiKey: 'sk-test' })
  await ctrl.testAiConnection()

  assert.equal(ctrl.getState().ai.testPhase, 'ok')
  assert.ok(ctrl.getState().ai.testSuccess)

  ctrl.clearAlerts()
  assert.equal(ctrl.getState().ai.testSuccess, null)
  assert.equal(ctrl.getState().ai.testError, null)
  assert.equal(ctrl.getState().ai.testErrorView, null)
})

test('AI 接口测试：后台返回业务失败 (ok: false) 绝不显示成功，转换为 ErrorView', async () => {
  const api = makeApi()
  api.respond(CommandTypes.AI_CONFIG_SET, () => ({
    configured: true,
    provider: 'OpenAI 兼容',
    model: 'gpt-4o-mini',
    timeoutMs: 30000,
    permissionOrigin: 'https://api.openai.com',
  } satisfies AiConfigStatus))

  const ctrl = new SettingsController({ api })
  ctrl.start()
  await ctrl.saveAiConfig({ apiKey: 'sk-test' })

  // 1. HTTP_ERROR (500)
  api.respond(AI_CONFIG_TEST_COMMAND, () => ({
    ok: false,
    error: {
      code: 'HTTP_ERROR',
      message: 'Server error 500 from provider at https://api.openai.com/v1/chat/completions',
      status: 500,
    },
  }))
  const ok1 = await ctrl.testAiConnection()
  assert.equal(ok1, false)
  assert.equal(ctrl.getState().ai.testPhase, 'failed')
  assert.equal(ctrl.getState().ai.testSuccess, null)
  assert.equal(ctrl.getState().ai.testErrorView?.code, 'UPSTREAM_ERROR')
  assert.ok(ctrl.getState().ai.testErrorView?.hint.includes('5xx 异常'))

  // 2. NETWORK 错误
  api.respond(AI_CONFIG_TEST_COMMAND, () => ({
    ok: false,
    error: {
      code: 'NETWORK',
      message: 'Failed to fetch',
    },
  }))
  const ok2 = await ctrl.testAiConnection()
  assert.equal(ok2, false)
  assert.equal(ctrl.getState().ai.testPhase, 'failed')
  assert.equal(ctrl.getState().ai.testSuccess, null)
  assert.equal(ctrl.getState().ai.testErrorView?.code, 'NETWORK')
  assert.ok(ctrl.getState().ai.testErrorView?.title.includes('网络连接失败'))

  // 3. TIMEOUT 错误
  api.respond(AI_CONFIG_TEST_COMMAND, () => ({
    ok: false,
    error: {
      code: 'TIMEOUT',
      message: 'Request timed out after 30000ms',
    },
  }))
  const ok3 = await ctrl.testAiConnection()
  assert.equal(ok3, false)
  assert.equal(ctrl.getState().ai.testPhase, 'failed')
  assert.equal(ctrl.getState().ai.testSuccess, null)
  assert.equal(ctrl.getState().ai.testErrorView?.code, 'TIMEOUT')
  assert.ok(ctrl.getState().ai.testErrorView?.title.includes('超时'))

  // 4. 泄露防护：包含响应 body 或 key 时绝不泄露
  const leakBody = 'SENSITIVE_RESPONSE_BODY_CONTENT_12345'
  const leakSecretKey = 'sk-leaked-key-abcdef123456'
  api.respond(AI_CONFIG_TEST_COMMAND, () => ({
    ok: false,
    error: {
      code: 'HTTP_ERROR',
      message: `Failed auth with key ${leakSecretKey}`,
      status: 401,
    },
    // 后台可能不小心带上 body 字段
    body: leakBody,
  }))
  const ok4 = await ctrl.testAiConnection()
  assert.equal(ok4, false)
  assert.equal(ctrl.getState().ai.testPhase, 'failed')
  assert.equal(ctrl.getState().ai.testSuccess, null)
  assert.equal(ctrl.getState().ai.testErrorView?.code, 'AUTH_FAILED')
  const serialized = JSON.stringify(ctrl.getState().ai)
  assert.equal(serialized.includes(leakBody), false)
  assert.equal(serialized.includes(leakSecretKey), false)
})

test('AI 接口测试：后台返回非法结构时按失败处理，绝不判定为成功', async () => {
  const api = makeApi()
  api.respond(CommandTypes.AI_CONFIG_SET, () => ({
    configured: true,
    provider: 'OpenAI 兼容',
    model: 'gpt-4o-mini',
    timeoutMs: 30000,
    permissionOrigin: 'https://api.openai.com',
  } satisfies AiConfigStatus))

  const ctrl = new SettingsController({ api })
  ctrl.start()
  await ctrl.saveAiConfig({ apiKey: 'sk-test' })

  // 1. 返回 null
  api.respond(AI_CONFIG_TEST_COMMAND, () => null)
  const ok1 = await ctrl.testAiConnection()
  assert.equal(ok1, false)
  assert.equal(ctrl.getState().ai.testPhase, 'failed')
  assert.equal(ctrl.getState().ai.testSuccess, null)
  assert.equal(ctrl.getState().ai.testErrorView?.code, 'MALFORMED_RESPONSE')

  // 2. 返回非布尔 ok
  api.respond(AI_CONFIG_TEST_COMMAND, () => ({ ok: 'truthy', model: 'gpt-4' }))
  const ok2 = await ctrl.testAiConnection()
  assert.equal(ok2, false)
  assert.equal(ctrl.getState().ai.testPhase, 'failed')
  assert.equal(ctrl.getState().ai.testSuccess, null)
  assert.equal(ctrl.getState().ai.testErrorView?.code, 'MALFORMED_RESPONSE')

  // 3. 返回缺少 ok 字段的对象
  api.respond(AI_CONFIG_TEST_COMMAND, () => ({ model: 'gpt-4' }))
  const ok3 = await ctrl.testAiConnection()
  assert.equal(ok3, false)
  assert.equal(ctrl.getState().ai.testPhase, 'failed')
  assert.equal(ctrl.getState().ai.testSuccess, null)
  assert.equal(ctrl.getState().ai.testErrorView?.code, 'MALFORMED_RESPONSE')
})
