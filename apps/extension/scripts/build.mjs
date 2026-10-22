/** 构建 MV3 扩展：esbuild 打包 SW 入口，复制 manifest，并校验产物安全边界。 */
import { build } from 'esbuild'
import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 最小权限白名单：新增权限必须同步更新契约与测试。 */
const ALLOWED_PERMISSIONS = new Set(['nativeMessaging', 'cookies', 'tabs', 'scripting', 'webNavigation', 'storage'])
/** 产物中不允许出现的模式：远端请求、私钥与旧工作台入口。 */
const FORBIDDEN_OUTPUT = [
  ['私钥', /PRIVATE KEY/],
  ['远端请求 fetch', /\bfetch\s*\(/],
  ['远端请求 XMLHttpRequest', /XMLHttpRequest/],
  ['远端请求 WebSocket', /new\s+WebSocket/],
  ['远端请求 EventSource', /EventSource/],
  ['旧工作台入口', /legacy\//],
]

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcDir = join(packageDir, 'src')
const outDir = process.env.FISHOPS_EXTENSION_DIST ? resolve(process.env.FISHOPS_EXTENSION_DIST) : join(packageDir, 'dist')

// 本次构建身份：随机 UUID，只标识“这一次构建”，不代表产物内容（不是内容哈希）。
const buildId = randomUUID()
const hostName = process.env.FISHOPS_HOST_NAME ?? 'top.ggball.fishops'
if (hostName.length > 255 || !/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(hostName)) throw new Error('native host 名无效')
const buildDefine = { __FISHOPS_EXTENSION_BUILD_ID__: JSON.stringify(buildId), __FISHOPS_NATIVE_HOST_NAME__: JSON.stringify(hostName) }

const manifest = JSON.parse(await readFile(join(srcDir, 'manifest.json'), 'utf8'))
const pkg = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))

verifyManifest(manifest, pkg)

await mkdir(outDir, { recursive: true })
const result = await build({
  entryPoints: [join(srcDir, 'main.ts')],
  outfile: join(outDir, 'background.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome105'],
  legalComments: 'none',
  logLevel: 'warning',
  define: buildDefine,
})
await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

// MAIN 产物独立构建，不引入 SW；manifest 只向闲鱼主站主文档注入该文件。
await build({
  entryPoints: [join(srcDir, 'page-entry.ts')], outfile: join(outDir, 'page-main.js'),
  bundle: true, format: 'iife', platform: 'browser', target: ['chrome105'],
  legalComments: 'none', logLevel: 'warning',
})

await build({
  entryPoints: [join(srcDir, 'chat-content.ts')], outfile: join(outDir, 'chat-content.js'),
  bundle: true, format: 'iife', platform: 'browser', target: ['chrome105'],
  legalComments: 'none', logLevel: 'warning',
})

const bundle = await readFile(join(outDir, 'background.js'), 'utf8')
const leaks = FORBIDDEN_OUTPUT.filter(([, pattern]) => pattern.test(bundle)).map(([label]) => label)
if (leaks.length > 0) throw new Error(`产物违反安全边界：${leaks.join('、')}`)
// SW 必须调用页面入口做初始化，但不能把入口实现（createPageRuntime）打进 background。
if (bundle.includes('createPageRuntime')) {
  throw new Error('SW 产物不得混入 MAIN world 页面运行时')
}
// 构建身份必须真实进入 SW：缺失说明 define 未接线，hello 无法上报真实构建值。
if (!bundle.includes(buildId)) {
  throw new Error('SW 产物未包含本次构建身份，define 注入失败')
}

// 记录本次构建身份与最终产物 SHA-256；build.json 自身不参与哈希，避免自引用。
const hashedFiles = ['background.js', 'page-main.js', 'chat-content.js', 'manifest.json']
const sha256 = {}
for (const name of hashedFiles) {
  sha256[name] = createHash('sha256').update(await readFile(join(outDir, name))).digest('hex')
}
await writeFile(join(outDir, 'build.json'), `${JSON.stringify({ buildId, hostName, sha256 }, null, 2)}\n`)

const extensionId = extensionIdOf(manifest.key)
console.log(`构建完成：dist/background.js（${result.outputFiles?.[0]?.contents.length ?? bundle.length} 字节）`)
console.log(`构建身份：${buildId}`)
console.log(`扩展 ID：${extensionId}`)
console.log(`权限：${manifest.permissions.join(', ')}；host_permissions：${manifest.host_permissions.join(', ')}`)

function verifyManifest(value, pkgValue) {
  if (value.manifest_version !== 3) throw new Error('manifest_version 必须为 3')
  if (value.version !== pkgValue.version) {
    throw new Error(`manifest 版本 ${value.version} 与 package.json 版本 ${pkgValue.version} 不一致`)
  }
  if (value.background?.service_worker !== 'background.js') throw new Error('service_worker 必须为 background.js')
  if (value.minimum_chrome_version !== '105') throw new Error('minimum_chrome_version 必须为 105')
  for (const permission of value.permissions ?? []) {
    if (!ALLOWED_PERMISSIONS.has(permission)) throw new Error(`超出最小权限白名单：${permission}`)
  }
  for (const forbidden of ['web_accessible_resources', 'externally_connectable']) {
    if (value[forbidden]) throw new Error(`扩展不得声明 ${forbidden}`)
  }
  const expected = [
    { matches: ['https://www.goofish.com/*'], js: ['page-main.js'], run_at: 'document_start', world: 'MAIN' },
    { matches: ['https://www.goofish.com/*'], js: ['chat-content.js'], run_at: 'document_start', world: 'ISOLATED' },
  ]
  if (JSON.stringify(value.content_scripts) !== JSON.stringify(expected)) {
    throw new Error('content_scripts 只能注入已评审的主站 MAIN 与隔离通知入口')
  }
  if (!value.key) throw new Error('manifest 缺少固定公钥 key')
  const der = Buffer.from(value.key, 'base64')
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' })
  if (key.asymmetricKeyType !== 'rsa') throw new Error('manifest key 必须是 RSA 公钥')
}

/** Chrome 扩展 ID：公钥 DER 的 SHA-256 前 16 字节，按 a–p 映射。 */
function extensionIdOf(keyBase64) {
  const digest = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest().subarray(0, 16)
  return [...digest].map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 15))).join('')
}
