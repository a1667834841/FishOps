/**
 * AI 端点安全 Origin 解析工具测试。
 *
 * 规范与断言：
 * 1. 任意包含用户名/密码认证信息或查询参数的 URL 严格禁止并给出中文提示；
 * 2. 仅提取安全 origin 及 pattern，绝不包含 key、路径、query、userinfo；
 * 3. 允许 HTTP/HTTPS 协议端点并保留 scheme；
 * 4. resolveTargetAiOrigin 解析逻辑：输入框优先，其次已保存 origin，未配置时回退默认端点；
 *    已配置但 origin 缺失时严禁回退默认端点，明确报错。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractSafeAiOrigin,
  resolveTargetAiOrigin,
} from '../ai-origin-helper'

test('extractSafeAiOrigin：正常 HTTPS 接口提取安全 Origin 与 Pattern', () => {
  const r1 = extractSafeAiOrigin('https://api.openai.com/v1')
  assert.equal(r1.ok, true)
  assert.equal(r1.origin, 'https://api.openai.com')
  assert.equal(r1.pattern, 'https://api.openai.com/*')

  // 即使不带协议前缀，默认按 HTTPS 解析
  const r2 = extractSafeAiOrigin('api.deepseek.com/chat/completions')
  assert.equal(r2.ok, true)
  assert.equal(r2.origin, 'https://api.deepseek.com')
  assert.equal(r2.pattern, 'https://api.deepseek.com/*')

  // 自定义端口支持
  const r3 = extractSafeAiOrigin('https://custom.ai.net:8443/v1')
  assert.equal(r3.ok, true)
  assert.equal(r3.origin, 'https://custom.ai.net:8443')
  assert.equal(r3.pattern, 'https://custom.ai.net:8443/*')
})

test('extractSafeAiOrigin：禁止包含用户名/密码等认证信息（提示禁止）', () => {
  const res = extractSafeAiOrigin('https://user:password@api.openai.com/v1')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /禁止包含用户名或密码/)
  assert.equal(res.origin, undefined)
  assert.equal(res.pattern, undefined)
})

test('extractSafeAiOrigin：禁止包含查询参数（提示禁止）', () => {
  const res = extractSafeAiOrigin('https://api.openai.com/v1?api_key=secret-token')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /禁止包含查询参数/)
  assert.equal(res.origin, undefined)
  assert.equal(res.pattern, undefined)
})

test('extractSafeAiOrigin：允许 HTTP/HTTPS 并保留 scheme', () => {
  const httpRes = extractSafeAiOrigin('http://api.openai.com/v1')
  assert.equal(httpRes.ok, true)
  assert.equal(httpRes.origin, 'http://api.openai.com')
  assert.equal(httpRes.pattern, 'http://api.openai.com/*')

  // HTTP + 自定义端口 + 本地地址
  const localRes = extractSafeAiOrigin('http://127.0.0.1:8080/v1')
  assert.equal(localRes.ok, true)
  assert.equal(localRes.origin, 'http://127.0.0.1:8080')
  assert.equal(localRes.pattern, 'http://127.0.0.1:8080/*')

  // HTTPS 仍正常且 scheme 不被改写
  const httpsRes = extractSafeAiOrigin('https://api.deepseek.com/v1')
  assert.equal(httpsRes.ok, true)
  assert.equal(httpsRes.origin, 'https://api.deepseek.com')
  assert.equal(httpsRes.pattern, 'https://api.deepseek.com/*')
})

test('extractSafeAiOrigin：禁止片段标识（fragment）', () => {
  const res = extractSafeAiOrigin('https://api.openai.com/v1#secret')
  assert.equal(res.ok, false)
  assert.match(res.error ?? '', /禁止包含片段标识/)
  assert.equal(res.origin, undefined)
  assert.equal(res.pattern, undefined)
})

test('extractSafeAiOrigin：拒绝空 host 与非标准 host', () => {
  // 空 host / 缺失 host（URL 解析失败）
  assert.equal(extractSafeAiOrigin('http://').ok, false)
  assert.equal(extractSafeAiOrigin('https://').ok, false)
  assert.equal(extractSafeAiOrigin('http://:8080/').ok, false)
  // 非标准 host（空标签 / 首尾非字母数字）
  assert.equal(extractSafeAiOrigin('http://-bad-.example.com/v1').ok, false)
  assert.equal(extractSafeAiOrigin('http://example..com/v1').ok, false)
  assert.equal(extractSafeAiOrigin('http://.example.com/v1').ok, false)
  // IPv6 字面量属标准 host，允许保留
  assert.equal(extractSafeAiOrigin('http://[::1]:8080/v1').ok, true)
  // 非 HTTP/HTTPS 协议仍拒绝
  assert.equal(extractSafeAiOrigin('ftp://api.openai.com/v1').ok, false)
})

test('extractSafeAiOrigin：空字符串与非法输入拦截', () => {
  assert.equal(extractSafeAiOrigin('').ok, false)
  assert.equal(extractSafeAiOrigin('   ').ok, false)
  assert.equal(extractSafeAiOrigin('not a valid url :::').ok, false)
})

test('resolveTargetAiOrigin：输入框优先，其次 saved permissionOrigin，未配置才 fallback', () => {
  // 1. 输入框非空时优先采纳输入框
  const t1 = resolveTargetAiOrigin({
    configured: true,
    inputUrl: 'https://input.ai.com/v1',
    permissionOrigin: 'https://saved.ai.com',
    defaultUrl: 'https://api.openai.com/v1',
  })
  assert.equal(t1.ok, true)
  assert.equal(t1.origin, 'https://input.ai.com')
  assert.equal(t1.pattern, 'https://input.ai.com/*')

  // 2. 已配置且输入框留空：采纳已保存的 permissionOrigin
  const t2 = resolveTargetAiOrigin({
    configured: true,
    inputUrl: '',
    permissionOrigin: 'https://saved.ai.com',
    defaultUrl: 'https://api.openai.com/v1',
  })
  assert.equal(t2.ok, true)
  assert.equal(t2.origin, 'https://saved.ai.com')
  assert.equal(t2.pattern, 'https://saved.ai.com/*')

  // 3. 仅未配置（configured === false）时，才允许回退默认 OpenAI 端点
  const t3 = resolveTargetAiOrigin({
    configured: false,
    inputUrl: '',
    permissionOrigin: null,
    defaultUrl: 'https://api.openai.com/v1',
  })
  assert.equal(t3.ok, true)
  assert.equal(t3.origin, 'https://api.openai.com')
  assert.equal(t3.pattern, 'https://api.openai.com/*')

  // 4. 输入框含有非法 query 时直接拦截报错
  const t4 = resolveTargetAiOrigin({
    configured: false,
    inputUrl: 'https://input.ai.com/v1?token=123',
    permissionOrigin: 'https://saved.ai.com',
    defaultUrl: 'https://api.openai.com/v1',
  })
  assert.equal(t4.ok, false)
  assert.match(t4.error ?? '', /禁止包含查询参数/)
})

test('resolveTargetAiOrigin：已 configured 但 permissionOrigin 缺失时严禁回退默认端点，必须阻止请求', () => {
  // 模拟场景：已配置过 AI 凭据（configured = true），但底层存储端点无效，extractSafeAiOrigin 拒绝后 permissionOrigin 为 null/undefined
  const res = resolveTargetAiOrigin({
    configured: true,
    inputUrl: '',
    permissionOrigin: null,
    defaultUrl: 'https://api.openai.com/v1',
  })

  // 必须返回失败，绝不可回退到 OpenAI
  assert.equal(res.ok, false)
  assert.equal(res.origin, undefined)
  assert.equal(res.pattern, undefined)
  assert.match(res.error ?? '', /现有端点无效，请用户填写合规的 HTTP\/HTTPS 地址并保存/)

  // 确保绝对不泄露任何存储中的完整 URL 或密钥
  assert.equal(JSON.stringify(res).includes('http://'), false)
  assert.equal(JSON.stringify(res).includes('sk-'), false)

  // 若在此状态下用户在输入框补全了合法的 HTTPS 地址，应能够正常解析
  const fixed = resolveTargetAiOrigin({
    configured: true,
    inputUrl: 'https://new-secure-host.com/v1',
    permissionOrigin: null,
    defaultUrl: 'https://api.openai.com/v1',
  })
  assert.equal(fixed.ok, true)
  assert.equal(fixed.origin, 'https://new-secure-host.com')
})

test('resolveTargetAiOrigin：已配置 HTTP 端点时按当前 origin 请求，绝不回退默认域名', () => {
  // 已配置且后台返回 HTTP permissionOrigin（保留 scheme）
  const res = resolveTargetAiOrigin({
    configured: true,
    inputUrl: '',
    permissionOrigin: 'http://192.168.1.10:8080',
    defaultUrl: 'https://api.openai.com/v1',
  })
  assert.equal(res.ok, true)
  assert.equal(res.origin, 'http://192.168.1.10:8080')
  assert.equal(res.pattern, 'http://192.168.1.10:8080/*')
  assert.equal(JSON.stringify(res).includes('api.openai.com'), false)

  // 用户输入框填写 HTTP 地址同样按输入解析
  const inputRes = resolveTargetAiOrigin({
    configured: false,
    inputUrl: 'http://my-ai.local/v1',
    permissionOrigin: null,
    defaultUrl: 'https://api.openai.com/v1',
  })
  assert.equal(inputRes.ok, true)
  assert.equal(inputRes.origin, 'http://my-ai.local')
  assert.equal(inputRes.pattern, 'http://my-ai.local/*')
})
