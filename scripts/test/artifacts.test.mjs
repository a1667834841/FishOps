#!/usr/bin/env node
/**
 * 扩展与 host 产物测试。
 *
 * 验证对象是刚构建的扩展产物（默认 apps/extension/dist），因此必须先构建：
 *   node apps/extension/scripts/build.mjs   # 或项目约定的构建命令
 *
 * 覆盖：manifest key 推导扩展 ID、最小权限、引用文件存在、源码不发起远端
 * fetch／XHR／WebSocket／登录探测、构建产物不混入私钥或旧工作台入口。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'

import { HOST_NAME, extensionIdFromKey } from '../install-host.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST_DIR = process.env.FISHOPS_EXTENSION_DIST ? resolve(process.env.FISHOPS_EXTENSION_DIST) : join(REPO_ROOT, 'apps', 'extension', 'dist')
const SRC_DIR = join(REPO_ROOT, 'apps', 'extension', 'src')
const SRC_MANIFEST_PATH = join(SRC_DIR, 'manifest.json')
const DIST_MANIFEST_PATH = join(DIST_DIR, 'manifest.json')
const DIST_BUILD_RECORD_PATH = join(DIST_DIR, 'build.json')
const EXTENSION_PACKAGE_PATH = join(REPO_ROOT, 'apps', 'extension', 'package.json')

/** 构建身份统一格式：随机 UUID 或 64 位小写 hex 之一。 */
const BUILD_ID_PATTERN = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64})$/
/** build.json 记录哈希的最终产物；build.json 自身不参与，避免自引用。 */
const HASHED_ARTIFACTS = ['background.js', 'page-main.js', 'chat-content.js', 'manifest.json']

/** 产物缺失属于必测项缺失：直接失败并给出构建指引，不能静默通过。 */
function requireBuildRecord() {
  if (!existsSync(DIST_BUILD_RECORD_PATH)) {
    throw new Error(`缺少构建记录 ${DIST_BUILD_RECORD_PATH}（环境阻碍）：请先构建扩展后再运行产物测试`)
  }
  return readJson(DIST_BUILD_RECORD_PATH)
}

/** 允许的权限白名单：M2 页面执行只增加固定文档核验与 MAIN 注入能力。 */
const ALLOWED_PERMISSIONS = ['nativeMessaging', 'cookies', 'tabs', 'scripting', 'webNavigation', 'storage']
/** 明确的危险权限：出现即视为越权，不因“可能有用”而放行。 */
const FORBIDDEN_PERMISSIONS = ['webRequest', 'declarativeNetRequest', 'debugger', 'management', 'proxy', 'downloads']
/** M1 只允许访问闲鱼域；任何通配或跨站 host 权限都判失败。 */
const ALLOWED_HOST_PATTERNS = [/^https:\/\/\*\.goofish\.com\/\*$/, /^https:\/\/goofish\.com\/\*$/]

/** 远端网络与登录探测模式：M1 扩展不得出现。 */
const NETWORK_PATTERNS = [
  { label: 'fetch', pattern: /\bfetch\s*\(/ },
  { label: 'XMLHttpRequest', pattern: /XMLHttpRequest/ },
  { label: 'WebSocket', pattern: /new\s+WebSocket\b|\bWebSocket\s*\(/ },
  { label: 'sendBeacon', pattern: /sendBeacon\s*\(/ },
  { label: 'loginuser.get 登录探测', pattern: /loginuser\.get/ },
  { label: 'login.token 主动取 token', pattern: /idlemessage\.pc\.login\.token/ },
]

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

/** 产物缺失属于必测项缺失：直接失败并给出构建指引，不能静默通过。 */
function requireDistManifest() {
  if (!existsSync(DIST_MANIFEST_PATH)) {
    throw new Error(`缺少扩展产物 ${DIST_MANIFEST_PATH}（环境阻碍）：请先构建扩展后再运行产物测试`)
  }
  return readJson(DIST_MANIFEST_PATH)
}

/** 去掉块注释与行注释，避免注释里的示例文字造成误报。 */
function stripComments(source) {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/\s\/\/.*$/, ''))
    .join('\n')
}

/** 收集目录下指定扩展名的文件（递归）。 */
function collectFiles(dir, extensions, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(target, extensions, out)
    else if (extensions.includes(extname(entry.name))) out.push(target)
  }
  return out
}

function scanForNetworkCalls(dir, extensions, excludeDirs = []) {
  const findings = []
  const targets = collectFiles(dir, extensions).filter(
    file => !excludeDirs.some(excluded => file.startsWith(resolve(excluded) + sep)),
  )
  for (const file of targets) {
    const source = stripComments(readFileSync(file, 'utf8'))
    for (const { label, pattern } of NETWORK_PATTERNS) {
      if (file === join(SRC_DIR, 'page-entry.ts') && /fetch/.test(label)) {
        // MAIN 入口是唯一的原生网络适配点；业务模块不得自行访问全局 fetch。
        assert.equal((source.match(/globalThis\.fetch\(/g) ?? []).length, 1)
        continue
      }
      if (file === join(DIST_DIR, 'page-main.js') && /fetch/.test(label)) {
        assert.ok(source.includes('__fishopsInitPageRuntimeV1__'))
        continue
      }
      if (file === join(SRC_DIR, 'page-runtime.ts') && /fetch/.test(label)) {
        assert.equal((source.match(/deps\.fetch\(/g) ?? []).length, 1, '页面运行时仅一个注入式发包点')
        assert.ok(!/(?:globalThis|window)\.fetch/.test(source), '不得绕过注入依赖')
        continue
      }
      if (file === join(SRC_DIR, 'publish-image-uploader.ts') && /fetch/.test(label)) {
        assert.equal((source.match(/deps\.fetch\(/g) ?? []).length, 1, '图片上传只使用注入的页面 fetch')
        continue
      }
      // 官方上传协议要求该固定请求头；字符串不是 XHR 构造或网络调用。
      const checked = source.replace(/(['"])X-Requested-With\1\s*:\s*(['"])XMLHttpRequest\2/g, '')
      if (pattern.test(checked)) findings.push(`${file}：出现 ${label}`)
    }
  }
  return findings
}

/** manifest 引用的相对文件必须真实存在于 dist。 */
function collectManifestReferences(manifest) {
  const references = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0) references.push(value)
  }
  push(manifest.background?.service_worker)
  push(manifest.action?.default_popup)
  push(manifest.options_ui?.page)
  for (const icon of Object.values(manifest.icons ?? {})) push(icon)
  for (const icon of Object.values(manifest.action?.default_icon ?? {})) push(icon)
  for (const script of manifest.content_scripts ?? []) {
    for (const js of script.js ?? []) push(js)
    for (const css of script.css ?? []) push(css)
  }
  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const resource of entry.resources ?? []) {
      if (!resource.includes('*')) push(resource)
    }
  }
  return references
}

describe('extension artifacts', () => {
  test('产物 manifest 是 MV3 0.2.0 且带固定 key', () => {
    const manifest = requireDistManifest()
    assert.equal(manifest.manifest_version, 3)
    assert.equal(manifest.version, '0.2.0', '产物版本必须是 0.2.0')
    assert.equal(typeof manifest.name, 'string')
    assert.ok(manifest.name.length > 0)
    assert.equal(typeof manifest.key, 'string')
    assert.ok(manifest.key.length > 0, '必须提交固定公钥 key')
  })

  test('key 推导的扩展 ID 稳定且为 32 位 a-p', () => {
    const manifest = requireDistManifest()
    const id = extensionIdFromKey(manifest.key)
    assert.match(id, /^[a-p]{32}$/)
    assert.equal(id, extensionIdFromKey(manifest.key), '同一 key 必须推导出同一 ID')
  })

  test('build.json 记录随机 UUID 构建身份与最终产物 SHA-256（不含自引用）', () => {
    const record = requireBuildRecord()
    assert.match(record.buildId, BUILD_ID_PATTERN, `构建身份必须是统一格式：${record.buildId}`)
    assert.match(record.buildId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      '构建身份必须是随机 UUID，而不是伪装成内容哈希的 64 位 hex')

    assert.deepEqual(
      Object.keys(record.sha256 ?? {}).sort(),
      [...HASHED_ARTIFACTS].sort(),
      `build.json 必须且只能记录 ${HASHED_ARTIFACTS.join('、')} 的哈希`,
    )
    for (const name of HASHED_ARTIFACTS) {
      const digest = record.sha256[name]
      assert.match(digest, /^[0-9a-f]{64}$/, `${name} 的哈希必须是 64 位小写 hex`)
      const actual = createHash('sha256').update(readFileSync(join(DIST_DIR, name))).digest('hex')
      assert.equal(digest, actual, `${name} 的 SHA-256 必须与最终产物一致`)
      assert.notEqual(record.buildId, digest, '构建身份不得等于任一产物内容哈希')
    }
  })

  test('SW 产物内嵌的构建身份与 build.json 一致，供 hello 上报真实值', () => {
    const record = requireBuildRecord()
    const background = readFileSync(join(DIST_DIR, 'background.js'), 'utf8')
    assert.ok(
      background.includes(record.buildId),
      'background.js 必须内嵌 build.json 中的构建身份，否则 hello 无法上报真实值',
    )
  })

  test('产物与源码 manifest 的 key、版本一致', () => {
    const manifest = requireDistManifest()
    const pkg = readJson(EXTENSION_PACKAGE_PATH)
    assert.equal(manifest.version, pkg.version, 'manifest 版本必须与包版本一致')
    if (existsSync(SRC_MANIFEST_PATH)) {
      const source = readJson(SRC_MANIFEST_PATH)
      assert.equal(manifest.key, source.key, '产物 key 必须与源码 manifest 相同')
      assert.equal(manifest.version, source.version, '产物版本必须与源码 manifest 相同')
    }
  })

  test('权限最小化：只允许已评审能力，且页面注入固定到闲鱼主站', () => {
    const manifest = requireDistManifest()
    const permissions = manifest.permissions ?? []
    for (const permission of permissions) {
      assert.ok(ALLOWED_PERMISSIONS.includes(permission), `出现未评审的权限：${permission}`)
    }
    for (const forbidden of FORBIDDEN_PERMISSIONS) {
      assert.ok(!permissions.includes(forbidden), `禁止声明危险权限：${forbidden}`)
    }
    assert.ok(permissions.includes('nativeMessaging'), '必须声明 nativeMessaging')
    assert.ok(permissions.includes('cookies'), '必须声明 cookies')

    assert.ok(!manifest.optional_permissions || manifest.optional_permissions.length === 0, 'M1 不使用可选权限')
    const hostPermissions = manifest.host_permissions ?? []
    for (const pattern of hostPermissions) {
      assert.ok(/^https:\/\//.test(pattern), `host 权限必须使用 https：${pattern}`)
      assert.ok(!pattern.includes('<all_urls>') && !pattern.startsWith('*://'), `禁止通配 host 权限：${pattern}`)
      assert.ok(ALLOWED_HOST_PATTERNS.some(allowed => allowed.test(pattern)), `host 权限必须限定在闲鱼域：${pattern}`)
    }
    assert.deepEqual(manifest.content_scripts, [{
      matches: ['https://www.goofish.com/*'],
      js: ['page-main.js'],
      run_at: 'document_start',
      world: 'MAIN',
    }, {
      matches: ['https://www.goofish.com/*'],
      js: ['chat-content.js'],
      run_at: 'document_start',
      world: 'ISOLATED',
    }], '只允许向闲鱼主站注入 MAIN 入口')
    assert.ok(
      !manifest.externally_connectable,
      'M1 不开放 externally_connectable（外部页面可直连扩展会扩大攻击面）',
    )
  })

  test('manifest 引用的文件都存在于产物目录', () => {
    const manifest = requireDistManifest()
    const references = collectManifestReferences(manifest)
    assert.ok(references.length > 0, 'manifest 至少要引用 service worker 入口')
    for (const reference of references) {
      const target = join(DIST_DIR, reference.replace(/^\//, ''))
      assert.ok(existsSync(target), `manifest 引用不存在：${reference}`)
      assert.ok(statSync(target).isFile(), `manifest 引用不是文件：${reference}`)
    }
    const worker = manifest.background?.service_worker
    assert.equal(typeof worker, 'string', '必须声明 background.service_worker')
  })

  test('扩展源码不发起 fetch／XHR／WebSocket 或登录探测', () => {
    // 排除 src/test：测试替身本身要定义“发现远端调用就抛错”的假实现。
    const findings = scanForNetworkCalls(SRC_DIR, ['.ts', '.js', '.mjs'], [join(SRC_DIR, 'test')])
    assert.deepEqual(findings, [], `源码出现远端网络调用：\n${findings.join('\n')}`)

    // 契约要求测试替身一旦发现远端 fetch／XHR／WebSocket 就立即失败。
    const fakesPath = join(SRC_DIR, 'test', 'fakes.ts')
    if (existsSync(fakesPath)) {
      const fakes = readFileSync(fakesPath, 'utf8')
      assert.match(fakes, /installNetworkProbes/, '测试替身必须提供远端请求探针')
      assert.match(fakes, /扩展不得发起远端请求/, '探针必须对远端调用直接失败')
    }
  })

  test('构建产物不发起远端网络调用，并连接正确的 native host', () => {
    const findings = scanForNetworkCalls(DIST_DIR, ['.js', '.mjs'])
    assert.deepEqual(findings, [], `产物出现远端网络调用：\n${findings.join('\n')}`)

    const sources = collectFiles(DIST_DIR, ['.js', '.mjs']).map(file => readFileSync(file, 'utf8'))
    assert.ok(
      sources.some(source => source.includes(HOST_NAME)),
      `产物必须包含 native host 名 ${HOST_NAME}`,
    )
  })

  test('产物不混入私钥、本地配置或旧工作台入口', () => {
    const files = collectFiles(DIST_DIR, ['.pem', '.key', '.p12', '.local', '.json', '.js', '.mjs', '.html'])
    for (const file of files) {
      const name = file.split('/').pop() ?? ''
      assert.ok(!/\.(pem|key|p12|local)$/.test(name), `产物不得包含私钥或本地配置：${file}`)
    }
    for (const file of collectFiles(DIST_DIR, ['.js', '.mjs', '.html'])) {
      const source = readFileSync(file, 'utf8')
      assert.ok(!source.includes('legacy/'), `产物不得引用旧工作台代码：${file}`)
    }
  })
})
