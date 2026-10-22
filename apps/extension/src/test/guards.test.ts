import assert from 'node:assert/strict'
import { createPublicKey } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { isWire } from '../../../../packages/protocol/src/index.ts'
import { AccountTracker } from '../account.ts'
import { NativeBridge } from '../connection.ts'
import { createDispatcher } from '../dispatch.ts'
import { FakeEnv, installNetworkProbes, settle } from './fakes.ts'

const PACKAGE_DIR = resolve(import.meta.dirname, '../..')
const ALLOWED_PERMISSIONS = new Set(['nativeMessaging', 'cookies', 'tabs', 'scripting', 'webNavigation', 'storage'])
/** 源码与 manifest 都不允许出现的模式：远端请求 API、页面注入、旧工作台入口。 */
const FORBIDDEN_SOURCE_PATTERNS: Array<[string, RegExp]> = [
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['WebSocket', /WebSocket/],
  ['EventSource', /EventSource/],
  ['chrome.scripting', /chrome\.scripting/],
  ['executeScript', /executeScript/],
  ['insertCSS', /insertCSS/],
  ['legacy 入口', /legacy\//],
]

async function listSourceFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'test') continue
      files.push(...(await listSourceFiles(join(dir, entry.name))))
      continue
    }
    if (entry.name.endsWith('.ts')) files.push(join(dir, entry.name))
  }
  return files
}

describe('扩展安全边界', () => {
  it('运行期不发起任何远端请求', async () => {
    const probe = installNetworkProbes()
    try {
      const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' }, tabCount: 1 })
      const account = new AccountTracker(env)
      const bridge = new NativeBridge({ env, account, dispatch: createDispatcher({ env, account }) })
      bridge.start()
      await settle()
      env.ports[0]?.emitMessage({ kind: 'req', id: 'r1', method: 'system.status', params: {} })
      env.setCookie('unb', 'u2')
      env.emitCookieChange('unb')
      env.clock.advance(300)
      await settle()

      assert.equal(env.ports[0]?.responses().length, 1)
      assert.equal(env.ports[0]?.events().length, 1)
      probe.assertNone()
    } finally {
      probe.restore()
    }
  })

  it('源码不含远端请求、页面注入与旧工作台入口', async () => {
    const files = await listSourceFiles(join(PACKAGE_DIR, 'src'))
    assert.ok(files.length > 0)
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const [label, pattern] of FORBIDDEN_SOURCE_PATTERNS) {
        if (file === join(PACKAGE_DIR, 'src/chat-socket-monitor.ts') && label === 'WebSocket') {
          assert.ok(!/\bnew\s+(?:\w+\.)?WebSocket\s*\(/.test(source), '被动监听不得主动创建连接')
          assert.ok(!/\.send\s*\(/.test(source), '被动监听不得发送消息')
          assert.match(source, /new Proxy\(Original/, '只能包装页面原有构造器')
          continue
        }
        if (file === join(PACKAGE_DIR, 'src/chat-page-source.ts') && label === 'executeScript') {
          assert.match(source, /documentIds: \[bound\.documentId\]/, '聊天采集必须固定文档')
          assert.match(source, /world: 'MAIN'/)
          assert.ok(!/files:/.test(source), '聊天采集不得补注入页面文件')
          continue
        }
        if ([join(PACKAGE_DIR, 'src/page-client.ts'), join(PACKAGE_DIR, 'src/page-bootstrap.ts')].includes(file) && label === 'executeScript') {
          assert.match(source, /documentIds: \[expected\.documentId\]/, '页面调用必须固定文档')
          assert.match(source, /world: 'MAIN'/)
          continue
        }
        if (file === join(PACKAGE_DIR, 'src/chrome-scripting.ts') && label === 'chrome.scripting') continue
        if (file === join(PACKAGE_DIR, 'src/page-entry.ts') && label === 'fetch(') {
          assert.equal((source.match(/globalThis\.fetch\(/g) ?? []).length, 1, 'MAIN入口只有一个真实请求适配点')
          continue
        }
        if (file === join(PACKAGE_DIR, 'src/publish-image-uploader.ts') && label === 'fetch(') {
          assert.equal((source.match(/deps\.fetch\(/g) ?? []).length, 1, '图片上传只使用注入的页面 fetch')
          continue
        }
        if (file === join(PACKAGE_DIR, 'src/page-runtime.ts') && label === 'fetch(') {
          assert.equal((source.match(/deps\.fetch\(/g) ?? []).length, 1, '页面运行时仅一个注入式发包点')
          assert.ok(!/(?:globalThis|window)\.fetch/.test(source), '页面运行时不得绕过注入依赖')
          continue
        }
        const checked = source.replace(/(['"])X-Requested-With\1\s*:\s*(['"])XMLHttpRequest\2/g, '')
        assert.ok(!pattern.test(checked), `${file} 出现禁用模式：${label}`)
      }
    }
  })

  it('manifest 使用最小权限、固定 RSA 公钥且版本一致', async () => {
    const manifest = JSON.parse(await readFile(join(PACKAGE_DIR, 'src/manifest.json'), 'utf8'))
    const pkg = JSON.parse(await readFile(join(PACKAGE_DIR, 'package.json'), 'utf8'))

    assert.equal(manifest.manifest_version, 3)
    assert.equal(manifest.version, pkg.version)
    assert.equal(manifest.version, '0.2.0')
    assert.equal(manifest.background.service_worker, 'background.js')
    assert.deepEqual(
      [...manifest.permissions].sort(),
      [...ALLOWED_PERMISSIONS].sort(),
      '只声明已评审的 native、账号、固定文档执行与本地消息存储权限',
    )
    assert.deepEqual(manifest.host_permissions, ['https://*.goofish.com/*'], 'host 权限只能覆盖闲鱼域')
    for (const forbidden of ['web_accessible_resources', 'externally_connectable']) {
      assert.equal(manifest[forbidden], undefined, `不得声明 ${forbidden}`)
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
    }], '只允许向闲鱼主站主文档注入 MAIN 入口')
    const key = createPublicKey({
      key: Buffer.from(manifest.key, 'base64'),
      format: 'der',
      type: 'spki',
    })
    assert.equal(key.asymmetricKeyType, 'rsa')
  })

  it('扩展发出的每一条帧都通过协议严格校验', async () => {
    const env = new FakeEnv({ cookies: { unb: 'u1', tracknick: 'A' }, tabCount: 1 })
    const account = new AccountTracker(env)
    const bridge = new NativeBridge({ env, account, dispatch: createDispatcher({ env, account }) })
    bridge.start()
    await settle()

    const port = env.ports[0]
    assert.ok(port)
    port.emitMessage({ kind: 'req', id: 'r1', method: 'system.status', params: {} })
    port.emitMessage({ kind: 'req', id: 'r2', method: '不存在的方法', params: {} })
    env.setCookie('unb', 'u2')
    env.emitCookieChange('unb')
    env.clock.advance(300)
    await settle()

    assert.ok(port.outbound.length >= 4, 'hello + 两条 res + 一条 event')
    for (const message of port.outbound) {
      assert.ok(isWire(message), `非法帧：${JSON.stringify(message)}`)
    }
    // 反向确认 host 侧严格校验：多余字段的 hello 必须被拒绝。
    assert.equal(
      isWire({ kind: 'hello', protocolVersion: 1, extensionVersion: '0.2.0', account: null, extra: 1 }),
      false,
    )
  })
})
