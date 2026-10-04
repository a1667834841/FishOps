/**
 * 手动配置命令（AI / 飞书）回归：
 * - 命令已登记、负载校验严格；
 * - 手动输入可保存、PATCH 合并正确；
 * - 响应 / 错误绝不回显任何明文凭据；
 * - 路由到 config deps，未接线回 INTERNAL。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  CommandTypes,
  createCommand,
  isAiConfigSetPayload,
  isAiConfigTestPayload,
  isFeishuConfigSetPayload,
  type AiConfigStatus,
  type AiConfigTestResult,
  type FeishuConfigStatus,
} from '@fishops/shared'
import { createConfigRuntime } from '../config-runtime'
import { handleCommand } from '../message-router'
import { MemoryReplyConfigStore } from '../../chat/reply-config'
import { MemoryFeishuConfigStore } from '../../data-source/feishu-config-store'
import { AiChatService } from '../../chat/ai-service'

/** 测试用 AI 探测桩：默认回固定成功结果（不访问网络）。 */
const okAi: Pick<AiChatService, 'completeText'> = {
  completeText: async () => ({ ok: true, content: 'OK', model: 'stub-model' }),
}

function setup(ai: Pick<AiChatService, 'completeText'> = okAi) {
  const replyConfigStore = new MemoryReplyConfigStore()
  const feishuConfigStore = new MemoryFeishuConfigStore()
  return {
    replyConfigStore,
    feishuConfigStore,
    runtime: createConfigRuntime({ replyConfigStore, feishuConfigStore, ai }),
  }
}

test('AI_CONFIG_* / FEISHU_CONFIG_* 命令已登记', () => {
  assert.equal(CommandTypes.AI_CONFIG_SET, 'AI_CONFIG_SET')
  assert.equal(CommandTypes.AI_CONFIG_STATUS, 'AI_CONFIG_STATUS')
  assert.equal(CommandTypes.AI_CONFIG_TEST, 'AI_CONFIG_TEST')
  assert.equal(CommandTypes.FEISHU_CONFIG_SET, 'FEISHU_CONFIG_SET')
  assert.equal(CommandTypes.FEISHU_CONFIG_STATUS, 'FEISHU_CONFIG_STATUS')
})

test('isAiConfigSetPayload：字段白名单 + 类型 / 长度 + 安全 URL 校验', () => {
  assert.equal(isAiConfigSetPayload({ apiKey: 'sk-1' }), true)
  assert.equal(isAiConfigSetPayload({ baseUrl: 'https://x/v1', model: 'm', timeoutMs: 1000 }), true)
  // 允许 HTTP / HTTPS；禁止带用户名/密码认证信息、查询参数、片段或非标准/空域名
  assert.equal(isAiConfigSetPayload({ baseUrl: 'http://insecure.com/v1' }), true)
  assert.equal(isAiConfigSetPayload({ baseUrl: 'http://127.0.0.1:8080/v1' }), true)
  assert.equal(isAiConfigSetPayload({ baseUrl: 'https://user:pass@api.openai.com/v1' }), false)
  assert.equal(isAiConfigSetPayload({ baseUrl: 'https://api.openai.com/v1?key=secret' }), false)
  assert.equal(isAiConfigSetPayload({ baseUrl: 'https://api.openai.com/v1#frag' }), false)
  assert.equal(isAiConfigSetPayload({ baseUrl: 'ftp://api.openai.com/v1' }), false)
  assert.equal(isAiConfigSetPayload({ baseUrl: 'http://example..com/v1' }), false)
  // 空对象 / 隐藏字段拒绝。
  assert.equal(isAiConfigSetPayload({}), false)
  assert.equal(isAiConfigSetPayload({ apiKey: 'x', evil: 1 }), false)
  // 类型 / 边界。
  assert.equal(isAiConfigSetPayload({ timeoutMs: 0 }), false)
  assert.equal(isAiConfigSetPayload({ timeoutMs: 1.5 }), false)
  assert.equal(isAiConfigSetPayload({ timeoutMs: 999_999_999 }), false)
  assert.equal(isAiConfigSetPayload({ apiKey: 1 }), false)
  assert.equal(isAiConfigSetPayload(null), false)
})

test('isFeishuConfigSetPayload：字段白名单 + 类型', () => {
  assert.equal(isFeishuConfigSetPayload({ appId: 'a' }), true)
  assert.equal(
    isFeishuConfigSetPayload({
      appId: 'a',
      appSecret: 'b',
      spreadsheetToken: 'c',
      productTableId: 'd',
      sellerTableId: 'e',
    }),
    true,
  )
  assert.equal(isFeishuConfigSetPayload({}), false)
  assert.equal(isFeishuConfigSetPayload({ appId: 'a', extra: 1 }), false)
  assert.equal(isFeishuConfigSetPayload({ appId: 1 }), false)
  assert.equal(isFeishuConfigSetPayload(null), false)
})

test('AI_CONFIG_SET：手动保存且响应不含明文密钥 / URL', async () => {
  const s = setup()
  const secret = 'sk-super-secret-value'
  const res = await s.runtime.handleCommand(
    createCommand(CommandTypes.AI_CONFIG_SET, {
      apiKey: secret,
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      timeoutMs: 15000,
    }),
  )
  assert.equal(res.ok, true)
  const status = res.result as AiConfigStatus
  assert.equal(status.configured, true)
  assert.equal(status.provider, 'deepseek')
  assert.equal(status.model, 'deepseek-chat')
  assert.equal(status.timeoutMs, 15000)
  // 仅回显安全的 Origin 供前端按需授权，不回显完整 baseURL 路径与密钥
  assert.equal(status.permissionOrigin, 'https://api.deepseek.com')

  // 响应序列化不得包含明文密钥，且不得包含完整 baseURL 路径（如 /v1）。
  const json = JSON.stringify(res)
  assert.equal(json.includes(secret), false)
  assert.equal(json.includes('/v1'), false)

  // 凭据确实落库到专用键。
  assert.equal((await s.replyConfigStore.loadAiProvider()).apiKey, secret)
})

test('AI_CONFIG_SET：接受 HTTP 端点并回显保留 scheme 的 permissionOrigin', async () => {
  const s = setup()
  const res = await s.runtime.handleCommand(
    createCommand(CommandTypes.AI_CONFIG_SET, {
      apiKey: 'sk-http-secret',
      baseUrl: 'http://192.168.1.10:8080/v1',
      model: 'local-model',
    }),
  )
  assert.equal(res.ok, true)
  const status = res.result as AiConfigStatus
  assert.equal(status.permissionOrigin, 'http://192.168.1.10:8080')
  assert.equal(JSON.stringify(res).includes('sk-http-secret'), false)
  assert.equal(JSON.stringify(res).includes('/v1'), false)

  // 状态读取也保留 HTTP scheme
  const statusRes = await s.runtime.handleCommand(createCommand(CommandTypes.AI_CONFIG_STATUS, {}))
  assert.equal((statusRes.result as AiConfigStatus).permissionOrigin, 'http://192.168.1.10:8080')
})

test('AI_CONFIG_STATUS：只回非敏感状态；空串清除密钥', async () => {
  const s = setup()
  await s.runtime.handleCommand(createCommand(CommandTypes.AI_CONFIG_SET, { apiKey: 'sk-1' }))
  const res = await s.runtime.handleCommand(createCommand(CommandTypes.AI_CONFIG_STATUS, {}))
  assert.equal(res.ok, true)
  const status = res.result as AiConfigStatus
  assert.equal(status.configured, true)
  assert.equal(JSON.stringify(res).includes('sk-1'), false)
  // 状态返回安全的默认或当前 permissionOrigin（不含 path / key）
  assert.equal(typeof status.permissionOrigin, 'string')
  assert.equal(status.permissionOrigin?.startsWith('https://'), true)
  assert.equal(status.permissionOrigin?.includes('/v1'), false)

  const cleared = await s.runtime.handleCommand(createCommand(CommandTypes.AI_CONFIG_SET, { apiKey: '' }))
  assert.equal((cleared.result as AiConfigStatus).configured, false)
  assert.equal((await s.replyConfigStore.loadAiProvider()).apiKey, '')
})

test('FEISHU_CONFIG_SET：完整保存 + PATCH 合并，响应不回显明文', async () => {
  const s = setup()
  const secret = 'feishu-app-secret'
  const res = await s.runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_CONFIG_SET, {
      appId: 'cli_x',
      appSecret: secret,
      spreadsheetToken: 'tbl_token',
      productTableId: 'tbl_p',
    }),
  )
  assert.equal(res.ok, true)
  const status = res.result as FeishuConfigStatus
  assert.equal(status.configured, true)
  assert.equal(status.hasAppSecret, true)
  assert.equal(status.hasSpreadsheetToken, true)
  const json = JSON.stringify(res)
  assert.equal(json.includes(secret), false)
  assert.equal(json.includes('tbl_token'), false)

  // PATCH：仅更新 productTableId，其余保持。
  const patched = await s.runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_CONFIG_SET, { productTableId: 'tbl_p2' }),
  )
  assert.equal(patched.ok, true)
  const stored = await s.feishuConfigStore.load()
  assert.equal(stored?.productTableId, 'tbl_p2')
  assert.equal(stored?.appSecret, secret)
})

test('FEISHU_CONFIG_SET：合并后不完整时拒绝写入，且错误不回显', async () => {
  const s = setup()
  const res = await s.runtime.handleCommand(createCommand(CommandTypes.FEISHU_CONFIG_SET, { appId: 'cli_x' }))
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  assert.equal(JSON.stringify(res.error).includes('cli_x'), false)
  assert.equal(await s.feishuConfigStore.hasConfig(), false)
})

test('FEISHU_CONFIG_SET：每日分表配置不要求预先提供商品表 ID', async () => {
  const s = setup()
  const response = await s.runtime.handleCommand(createCommand(CommandTypes.FEISHU_CONFIG_SET, { appId: 'app', appSecret: 'secret', spreadsheetToken: 'base' }))
  assert.equal(response.ok, true)
  assert.equal((await s.feishuConfigStore.load())?.productTableId, '')
  assert.equal((response.result as FeishuConfigStatus).hasProductTableId, false)
})

test('FEISHU_CONFIG_STATUS：未配置时只回 false 存在性', async () => {
  const s = setup()
  const res = await s.runtime.handleCommand(createCommand(CommandTypes.FEISHU_CONFIG_STATUS, {}))
  assert.equal(res.ok, true)
  const status = res.result as FeishuConfigStatus
  assert.equal(status.configured, false)
  assert.equal(status.hasAppId, false)
  assert.equal(status.hasAppSecret, false)
})

// ---- AI_CONFIG_TEST：连通性自测（安全、防并发、结构化失败） ----

test('isAiConfigTestPayload：只接受空对象', () => {
  assert.equal(isAiConfigTestPayload({}), true)
  assert.equal(isAiConfigTestPayload({ timeoutMs: 1 }), false)
  assert.equal(isAiConfigTestPayload({ probe: true }), false)
  assert.equal(isAiConfigTestPayload(null), false)
  assert.equal(isAiConfigTestPayload('x'), false)
})

test('AI_CONFIG_TEST：成功只回测量指标，绝不回传正文 / key / 完整 URL', async () => {
  const s = setup()
  await s.replyConfigStore.saveAiProvider({
    apiKey: 'sk-secret-test',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    timeoutMs: 5000,
  })
  const res = await s.runtime.handleCommand(createCommand(CommandTypes.AI_CONFIG_TEST, {}))
  assert.equal(res.ok, true)
  const result = res.result as AiConfigTestResult
  assert.equal(result.ok, true)
  assert.equal(result.provider, 'deepseek')
  assert.equal(result.model, 'stub-model')
  assert.equal(typeof result.latencyMs, 'number')
  assert.equal(result.hasContent, true)
  assert.equal(result.responseChars, 2)
  const json = JSON.stringify(res)
  assert.equal(json.includes('sk-secret-test'), false)
  assert.equal(json.includes('api.deepseek.com'), false)
  assert.equal(json.includes('"OK"'), false)
})

test('AI_CONFIG_TEST：HTTP 失败保留安全 errorCode / status，不泄露 body / key', async () => {
  const failAi: Pick<AiChatService, 'completeText'> = {
    completeText: async () => ({
      ok: false,
      error: { code: 'HTTP_ERROR', message: 'boom sk-leak-456 body-secret', status: 401 },
    }),
  }
  const s = setup(failAi)
  await s.replyConfigStore.saveAiProvider({
    apiKey: 'sk-secret-test',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    timeoutMs: 5000,
  })
  const res = await s.runtime.handleCommand(createCommand(CommandTypes.AI_CONFIG_TEST, {}))
  assert.equal(res.ok, true)
  const result = res.result as AiConfigTestResult
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'HTTP_ERROR')
  assert.equal(result.error.status, 401)
  assert.equal(result.error.message, 'AI 接口返回错误状态')
  const json = JSON.stringify(res)
  assert.equal(json.includes('sk-leak-456'), false)
  assert.equal(json.includes('body-secret'), false)
  assert.equal(json.includes('boom'), false)
})

test('AI_CONFIG_TEST：真实文本接口调用使用固定探测 prompt，不带聊天 / 商品上下文', async () => {
  const calls: Array<{ url: string; body: string }> = []
  const ai = new AiChatService({
    loadProvider: async () => ({
      apiKey: 'sk-real',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      timeoutMs: 5000,
    }),
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body })
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK' } }], model: 'deepseek-chat' }) }
    },
  })
  const runtime = createConfigRuntime({
    replyConfigStore: new MemoryReplyConfigStore(),
    feishuConfigStore: new MemoryFeishuConfigStore(),
    ai,
  })
  const res = await runtime.handleCommand(createCommand(CommandTypes.AI_CONFIG_TEST, {}))
  assert.equal((res.result as AiConfigTestResult).ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions')
  const body = JSON.parse(calls[0].body) as { messages: Array<{ role: string; content: string }>; stream: boolean }
  assert.equal(body.stream, false)
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[1].role, 'user')
  for (const forbidden of ['sessionId', 'itemId', 'itemTitle', 'image_url', 'history']) {
    assert.equal(calls[0].body.includes(forbidden), false)
  }
})

test('AI_CONFIG_TEST：并发测试被拒绝（不排队、不并发打接口）', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let callCount = 0
  const busyAi: Pick<AiChatService, 'completeText'> = {
    completeText: async () => {
      callCount += 1
      await gate
      return { ok: true, content: 'OK', model: 'm' }
    },
  }
  const s = setup(busyAi)
  const first = s.runtime.handleCommand(createCommand(CommandTypes.AI_CONFIG_TEST, {}))
  // 让第一个请求推进到 completeText 并置位并发锁。
  await new Promise((resolve) => setTimeout(resolve, 0))
  const secondRes = await s.runtime.handleCommand(createCommand(CommandTypes.AI_CONFIG_TEST, {}))
  const second = secondRes.result as AiConfigTestResult
  assert.equal(second.ok, false)
  assert.equal(second.error.code, 'TEST_IN_PROGRESS')
  release()
  await first
  assert.equal(callCount, 1)
})

test('AI_CONFIG_TEST：负载非空对象时拒绝，且不触发接口调用', async () => {
  const s = setup()
  const res = await s.runtime.handleCommand(createCommand(CommandTypes.AI_CONFIG_TEST, { timeoutMs: 1 } as never))
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
})

test('AI_CONFIG_TEST：未配置密钥时结构化失败，不访问网络', async () => {
  let calls = 0
  const ai = new AiChatService({
    loadProvider: async () => ({
      apiKey: '',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      timeoutMs: 5000,
    }),
    fetchImpl: async () => {
      calls += 1
      return { ok: true, status: 200, json: async () => ({}) }
    },
  })
  const runtime = createConfigRuntime({
    replyConfigStore: new MemoryReplyConfigStore(),
    feishuConfigStore: new MemoryFeishuConfigStore(),
    ai,
  })
  const res = await runtime.handleCommand(createCommand(CommandTypes.AI_CONFIG_TEST, {}))
  const result = res.result as AiConfigTestResult
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'NO_API_KEY')
  assert.equal(calls, 0)
})

test('message-router：配置命令路由到 config deps；未接线回 INTERNAL', async () => {
  const command = createCommand(CommandTypes.AI_CONFIG_STATUS, {})
  const baseDeps = {
    now: () => 1,
    workerStartedAt: 1,
    incrementPingCount: async () => 1,
    broadcast: () => 0,
    subscribe: (e: string[]) => e,
    unsubscribe: (e: string[]) => e,
  }
  const routed = await handleCommand(command, {
    ...baseDeps,
    config: {
      handleCommand: async () => ({
        kind: 'response',
        protocol: 1,
        requestId: command.requestId,
        type: command.type,
        ok: true,
        result: { configured: false, provider: 'custom', model: 'm', timeoutMs: 1 },
        respondedAt: 1,
      }),
    },
  } as never)
  assert.equal(routed.ok, true)
  assert.equal((routed.result as AiConfigStatus).provider, 'custom')

  const notWired = await handleCommand(command, { ...baseDeps } as never)
  assert.equal(notWired.ok, false)
  assert.equal(notWired.error?.code, 'INTERNAL')
})

// ---- 拒绝 / 失败路径安全：不得回显凭据或原始异常文本 ----

test('AI_CONFIG_SET：非法负载拒绝，错误不回显传入值', async () => {
  const s = setup()
  const res = await s.runtime.handleCommand(
    createCommand(CommandTypes.AI_CONFIG_SET, { apiKey: 'sk-secret-value', timeoutMs: -1 } as never),
  )
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INVALID_PAYLOAD')
  assert.equal(JSON.stringify(res).includes('sk-secret-value'), false)
})

test('AI_CONFIG_SET：存储抛错时错误文案固定，不泄露异常 / 凭据', async () => {
  const replyConfigStore = new MemoryReplyConfigStore()
  replyConfigStore.saveAiProvider = async () => {
    throw new Error('boom sk-leak-123')
  }
  const runtime = createConfigRuntime({ replyConfigStore, feishuConfigStore: new MemoryFeishuConfigStore(), ai: okAi })
  const res = await runtime.handleCommand(createCommand(CommandTypes.AI_CONFIG_SET, { apiKey: 'sk-leak-123' }))
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INTERNAL')
  assert.equal(res.error?.message, '保存 AI 配置失败')
  const json = JSON.stringify(res)
  assert.equal(json.includes('sk-leak-123'), false)
  assert.equal(json.includes('boom'), false)
})

test('FEISHU_CONFIG_SET：存储抛错时错误文案固定，不泄露异常 / 凭据', async () => {
  const feishuConfigStore = new MemoryFeishuConfigStore()
  feishuConfigStore.save = async () => {
    throw new Error('boom feishu-secret-leak')
  }
  const runtime = createConfigRuntime({ replyConfigStore: new MemoryReplyConfigStore(), feishuConfigStore, ai: okAi })
  const res = await runtime.handleCommand(
    createCommand(CommandTypes.FEISHU_CONFIG_SET, {
      appId: 'cli_x',
      appSecret: 'feishu-secret-leak',
      spreadsheetToken: 'tok',
      productTableId: 'tbl',
    }),
  )
  assert.equal(res.ok, false)
  assert.equal(res.error?.code, 'INTERNAL')
  assert.equal(res.error?.message, '保存飞书配置失败')
  const json = JSON.stringify(res)
  assert.equal(json.includes('feishu-secret-leak'), false)
  assert.equal(json.includes('boom'), false)
})

test('index.ts 配置后台路径不回显原异常（刷新 / 初始化失败）', () => {
  const src = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
  // 刷新失败的 console.warn 不得附带原始异常对象（仅针对本轮新增配置路径）。
  assert.equal(src.includes("保存 AI 配置后刷新 P6 运行时失败', error"), false)
  assert.equal(src.includes("保存飞书配置后刷新 P7 飞书数据源失败', error"), false)
  // 配置层初始化失败的响应文案不得附带原始异常文本。
  assert.equal(src.includes('配置写入层初始化失败: ${messageOf(error)}'), false)
})
