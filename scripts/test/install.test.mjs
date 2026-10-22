#!/usr/bin/env node
/**
 * scripts/install-host.mjs 的安装／卸载测试。
 *
 * 隔离要求（测试方案 §5）：每个用例都显式传入临时 FISHOPS_HOME 与临时
 * FISHOPS_NATIVE_MANIFEST_DIR，绝不触碰真实 Chrome 注册目录。
 * 用例覆盖：首次安装、重复安装、部署冲突、非法配置、Node 版本、含空格路径的
 * launcher、自定义 host 名隔离、卸载与外来文件保护。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, test } from 'node:test'

import {
  CONFIG_FILE,
  DEFAULT_PORT,
  HOST_NAME,
  HOST_NAME_ENV,
  HOST_NAME_MAX_LENGTH,
  INSTALL_RECORD_FILE,
  LAUNCHER_FILE,
  OWNER,
  OWNER_FIELD,
  PORT_ENV,
  extensionIdFromKey,
  install,
  resolveHostName,
  uninstall,
} from '../install-host.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const INSTALL_SCRIPT = join(REPO_ROOT, 'scripts', 'install-host.mjs')
const REAL_CHROME_DIR = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')

/** 测试固件：只包含安装脚本需要的字段，不依赖真实扩展构建产物。 */
const FIXTURE_KEY = Buffer.from('fishops-install-fixture-public-key-payload'.repeat(8)).toString('base64')
const FIXTURE_VERSION = '0.2.0'

/** 假 host 入口：打印 FISHOPS_HOME、配置端口与运行时 Node 版本，供 launcher 用例断言。 */
const FIXTURE_ENTRY_SOURCE = `import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const home = process.env.FISHOPS_HOME
const config = JSON.parse(readFileSync(join(String(home), 'config.json'), 'utf8'))
process.stdout.write(JSON.stringify({ home, port: config.port, cwd: process.cwd(), node: process.versions.node }) + '\\n')
`

function nodeVersionOf(bin) {
  const result = spawnSync(bin, ['-e', 'process.stdout.write(process.versions.node)'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

/** 按优先级挑选 Node 24：契约基线固定在 /tmp/fishops-node24 的解包目录。 */
function findNode24() {
  const candidates = [
    process.env.FISHOPS_TEST_NODE24,
    '/tmp/fishops-node24/node-v24.22.0-darwin-arm64/bin/node',
    process.versions.node.startsWith('24.') ? process.execPath : null,
  ]
  for (const bin of candidates) {
    if (!bin || !existsSync(bin)) continue
    const version = nodeVersionOf(bin)
    if (version?.startsWith('24.')) return { bin, version }
  }
  throw new Error('找不到 Node 24 可执行文件；请设置 FISHOPS_TEST_NODE24 指向 Node 24')
}

/** 找一个非 Node 24 的 node，用于验证版本拒绝逻辑；找不到时返回 null。 */
function findOtherNode() {
  const candidates = [
    process.env.FISHOPS_TEST_OTHER_NODE,
    process.versions.node.startsWith('24.') ? null : process.execPath,
    '/Users/wuwenjing/.local/bin/node',
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
  ]
  for (const bin of candidates) {
    if (!bin || !existsSync(bin)) continue
    const version = nodeVersionOf(bin)
    if (version && !version.startsWith('24.')) return { bin, version }
  }
  return null
}

const NODE24 = findNode24()
const OTHER_NODE = findOtherNode()

const tempRoots = new Set()

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true })
})

function fixtureManifest() {
  return {
    manifest_version: 3,
    name: 'FishOps 安装测试产物',
    version: FIXTURE_VERSION,
    key: FIXTURE_KEY,
    background: { service_worker: 'background.js' },
    permissions: ['nativeMessaging', 'cookies'],
  }
}

/** 创建隔离目录：路径含空格，用来验证 launcher 与参数传递对空格的兼容。 */
function createDirs() {
  const root = mkdtempSync(join(tmpdir(), 'fishops-install-'))
  tempRoots.add(root)
  const dirs = {
    root,
    dataDir: join(root, '配置 目录', 'FishOps'),
    nativeDir: join(root, 'native 注册 目录'),
    distDir: join(root, '扩展 产物'),
    entry: join(root, '入口 目录', 'host-entry.mjs'),
  }
  mkdirSync(dirs.distDir, { recursive: true })
  mkdirSync(dirname(dirs.entry), { recursive: true })
  writeFileSync(join(dirs.distDir, 'manifest.json'), `${JSON.stringify(fixtureManifest(), null, 2)}\n`)
  writeFileSync(dirs.entry, FIXTURE_ENTRY_SOURCE)
  return dirs
}

/** 阻断误用真实目录：两个隔离路径必须都在临时目录内，且不在真实 Chrome 注册目录下。 */
function assertIsolated(dirs) {
  const tempRoot = resolve(tmpdir())
  for (const target of [dirs.dataDir, dirs.nativeDir]) {
    const resolved = resolve(target)
    assert.ok(resolved.startsWith(tempRoot + sep), `隔离路径必须在临时目录内：${resolved}`)
  }
  assert.ok(!resolve(dirs.nativeDir).startsWith(REAL_CHROME_DIR + sep), '禁止触碰真实 Chrome 注册目录')
  assert.ok(!resolve(dirs.dataDir).startsWith(join(homedir(), 'Library', 'Application Support', 'FishOps') + sep))
}

function runCli(args, dirs, extraEnv = {}, nodeBin = NODE24.bin) {
  assertIsolated(dirs)
  const env = {
    ...process.env,
    FISHOPS_HOME: dirs.dataDir,
    FISHOPS_NATIVE_MANIFEST_DIR: dirs.nativeDir,
    FISHOPS_EXTENSION_DIST: dirs.distDir,
    FISHOPS_HOST_ENTRY: dirs.entry,
    ...extraEnv,
  }
  // 显式传 undefined 表示“删除该变量”，用于回落到脚本默认路径。
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key]
  }
  return spawnSync(nodeBin, [INSTALL_SCRIPT, ...args], { encoding: 'utf8', cwd: dirs.root, env })
}

function readConfig(dirs) {
  const configPath = join(dirs.dataDir, CONFIG_FILE)
  return { configPath, config: JSON.parse(readFileSync(configPath, 'utf8')) }
}

function fileMode(target) {
  return statSync(target).mode & 0o777
}

function manifestPathFor(dirs, hostName = HOST_NAME) {
  return join(dirs.nativeDir, `${hostName}.json`)
}

function readManifest(dirs, hostName = HOST_NAME) {
  const manifestPath = manifestPathFor(dirs, hostName)
  return { manifestPath, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) }
}

/** 断言被拒绝的调用没有任何副作用：不创建配置目录，也不写 native 注册文件。 */
function assertNoSideEffects(dirs, hostName = HOST_NAME) {
  assert.ok(!existsSync(dirs.dataDir), `被拒绝时不得创建配置目录：${dirs.dataDir}`)
  assert.ok(!existsSync(dirs.nativeDir), `被拒绝时不得创建 native 目录：${dirs.nativeDir}`)
  const manifestPath = manifestPathFor(dirs, hostName)
  assert.ok(!existsSync(manifestPath), `被拒绝时不得写入 native 注册文件：${manifestPath}`)
}

describe('install-host', () => {
  test('首次安装生成配置、launcher 与 native manifest，且不回显 token', () => {
    const dirs = createDirs()
    const result = runCli([], dirs)
    assert.equal(result.status, 0, result.stderr)

    const { configPath, config } = readConfig(dirs)
    assert.equal(config.port, DEFAULT_PORT)
    assert.equal(typeof config.token, 'string')
    assert.ok(config.token.length >= 32, 'token 必须是高强度随机串')
    assert.equal(fileMode(dirs.dataDir), 0o700, '私有目录必须是 0700')
    assert.equal(fileMode(configPath), 0o600, '配置文件必须是 0600')

    const launcherPath = join(dirs.dataDir, LAUNCHER_FILE)
    const launcher = readFileSync(launcherPath, 'utf8')
    assert.ok(launcher.startsWith('#!/bin/sh'))
    assert.ok(launcher.includes(NODE24.bin), 'launcher 必须使用安装时 Node 的绝对路径')
    assert.ok(launcher.includes(dirs.entry), 'launcher 必须指向生产入口')
    assert.equal(fileMode(launcherPath), 0o700)

    const { manifestPath, manifest } = readManifest(dirs)
    assert.equal(manifest.name, HOST_NAME)
    assert.equal(manifest.type, 'stdio')
    assert.equal(manifest.path, launcherPath)
    assert.equal(manifest[OWNER_FIELD], OWNER)
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionIdFromKey(FIXTURE_KEY)}/`])
    assert.equal(fileMode(manifestPath), 0o600)

    const record = JSON.parse(readFileSync(join(dirs.dataDir, INSTALL_RECORD_FILE), 'utf8'))
    assert.equal(record.owner, OWNER)
    assert.equal(record.hostName, HOST_NAME)
    assert.equal(record.hostEntry, dirs.entry)
    assert.equal(record.dataDir, dirs.dataDir)

    // 秘密只落在 0600 配置文件里，命令行输出不得回显。
    assert.ok(!result.stdout.includes(config.token), 'stdout 不得输出 token')
    assert.ok(!result.stderr.includes(config.token), 'stderr 不得输出 token')
  })

  test('host 名解析：options > FISHOPS_HOST_NAME > 默认值，并严格拒绝非法名', () => {
    assert.deepEqual(resolveHostName({ options: {}, env: {} }), {
      hostName: HOST_NAME,
      source: 'default',
      specified: false,
    })
    assert.deepEqual(resolveHostName({ options: {}, env: { [HOST_NAME_ENV]: 'top.ggball.fishops.env' } }), {
      hostName: 'top.ggball.fishops.env',
      source: 'env',
      specified: true,
    })
    assert.equal(
      resolveHostName({
        options: { hostName: 'top.ggball.fishops.opt' },
        env: { [HOST_NAME_ENV]: 'top.ggball.fishops.env' },
      }).hostName,
      'top.ggball.fishops.opt',
    )
    assert.equal(
      resolveHostName({
        options: { hostName: 'top.ggball.fishops.opt' },
        env: { [HOST_NAME_ENV]: 'Bad.Name' },
      }).hostName,
      'top.ggball.fishops.opt',
      '合法 options.hostName 不应被非法环境变量影响',
    )
    assert.equal(
      resolveHostName({
        options: { hostName: undefined },
        env: { [HOST_NAME_ENV]: 'top.ggball.fishops.env' },
      }).hostName,
      'top.ggball.fishops.env',
      'options.hostName 未提供时必须回落到环境变量',
    )

    for (const valid of ['a', 'foo', 'foo132', 'foo.bar', 'a._.c', 'a0_b.c']) {
      assert.equal(resolveHostName({ options: { hostName: valid }, env: {} }).hostName, valid)
    }

    const invalid = [
      '',
      'A.b',
      'a..b',
      '.a',
      'b.',
      'a-b',
      'a/b',
      '../evil',
      'a b',
      'a\\b',
      'a'.repeat(HOST_NAME_MAX_LENGTH + 1),
    ]
    for (const value of invalid) {
      assert.throws(
        () => resolveHostName({ options: { hostName: value }, env: {} }),
        /host 名/,
        `非法 host 名必须被拒绝：${JSON.stringify(value)}`,
      )
    }
    assert.throws(() => resolveHostName({ options: { hostName: null }, env: {} }), /host 名/)
    assert.throws(() => resolveHostName({ options: {}, env: { [HOST_NAME_ENV]: 'Bad.Name' } }), /host 名/)
  })

  test('FISHOPS_HOST_NAME 指定自定义 native host 名', () => {
    const dirs = createDirs()
    const hostName = 'top.ggball.fishops.isolated'
    const result = runCli([], dirs, { [HOST_NAME_ENV]: hostName })
    assert.equal(result.status, 0, result.stderr)

    const { manifestPath, manifest } = readManifest(dirs, hostName)
    assert.equal(manifest.name, hostName)
    const record = JSON.parse(readFileSync(join(dirs.dataDir, INSTALL_RECORD_FILE), 'utf8'))
    assert.equal(record.hostName, hostName)
    assert.equal(record.nativeManifestPath, manifestPath)
    assert.ok(result.stdout.includes(hostName), '安装输出必须回显生效的 host 名')
    assert.ok(!existsSync(manifestPathFor(dirs, HOST_NAME)), '不得写入默认 host 名注册文件')
  })

  test('--host-name 参数优先于 FISHOPS_HOST_NAME', () => {
    const dirs = createDirs()
    const hostName = 'top.ggball.fishops.cli'
    const result = runCli(['--host-name', hostName], dirs, { [HOST_NAME_ENV]: 'top.ggball.fishops.env' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readManifest(dirs, hostName).manifest.name, hostName)
    assert.ok(!existsSync(manifestPathFor(dirs, 'top.ggball.fishops.env')))
  })

  test('重复安装保留 token 与数据库文件', () => {
    const dirs = createDirs()
    assert.equal(runCli([], dirs).status, 0)

    const { configPath, config } = readConfig(dirs)
    const configBefore = readFileSync(configPath, 'utf8')
    const dbPath = join(dirs.dataDir, 'fishops.db')
    writeFileSync(dbPath, 'fixture-db')

    const second = runCli([], dirs)
    assert.equal(second.status, 0, second.stderr)
    assert.equal(readFileSync(configPath, 'utf8'), configBefore, '重复安装不得重写配置')
    assert.equal(readConfig(dirs).config.token, config.token, '重复安装必须保留 token')
    assert.equal(readFileSync(dbPath, 'utf8'), 'fixture-db', '重复安装不得删除数据库')
  })

  test('其他部署的注册文件冲突时拒绝安装且不覆盖', () => {
    const dirs = createDirs()
    mkdirSync(dirs.nativeDir, { recursive: true, mode: 0o700 })
    const manifestPath = join(dirs.nativeDir, `${HOST_NAME}.json`)
    const foreign = {
      name: HOST_NAME,
      description: '其他部署',
      path: '/usr/local/bin/other-host',
      type: 'stdio',
      allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],
    }
    writeFileSync(manifestPath, `${JSON.stringify(foreign, null, 2)}\n`)
    const before = readFileSync(manifestPath, 'utf8')

    const result = runCli([], dirs)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /其他部署/)
    assert.equal(readFileSync(manifestPath, 'utf8'), before, '不得覆盖外来注册文件')
    assert.ok(!existsSync(join(dirs.dataDir, CONFIG_FILE)), '被拒绝时不得产生配置')
  })

  test('同一 host 名指向其他 launcher 的部署被拒绝', () => {
    const first = createDirs()
    assert.equal(runCli([], first).status, 0)
    const { manifestPath, manifest } = readManifest(first)
    const before = readFileSync(manifestPath, 'utf8')

    const second = { ...createDirs(), nativeDir: first.nativeDir }
    const result = runCli([], second)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /其他 launcher|其他部署|不覆盖/)
    assert.equal(readFileSync(manifestPath, 'utf8'), before)
    assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).path, manifest.path)
    assert.ok(!existsSync(join(second.dataDir, CONFIG_FILE)))
  })

  test('同一配置目录被其他 worktree 的入口复用时拒绝安装', () => {
    const dirs = createDirs()
    assert.equal(runCli([], dirs).status, 0)
    const { manifestPath } = readManifest(dirs)
    const before = readFileSync(manifestPath, 'utf8')

    const otherEntry = join(dirs.root, '其他 worktree 入口.mjs')
    writeFileSync(otherEntry, FIXTURE_ENTRY_SOURCE)
    const result = runCli([], dirs, { FISHOPS_HOST_ENTRY: otherEntry })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /其他部署|worktree|host 入口/)
    assert.equal(readFileSync(manifestPath, 'utf8'), before, '不得覆盖其他 worktree 的部署')
  })

  test('不同 host 名可共用 nativeDir，卸载只删除对应注册', () => {
    const first = createDirs()
    const alpha = 'top.ggball.fishops.alpha'
    const beta = 'top.ggball.fishops.beta'
    assert.equal(runCli([], first, { [HOST_NAME_ENV]: alpha }).status, 0)

    const second = { ...createDirs(), nativeDir: first.nativeDir }
    assert.equal(runCli([], second, { [HOST_NAME_ENV]: beta }).status, 0)

    const alphaManifest = readManifest(first, alpha)
    const betaManifest = readManifest(second, beta)
    assert.equal(alphaManifest.manifest.name, alpha)
    assert.equal(betaManifest.manifest.name, beta)

    // 默认 host 名卸载不得误删自定义名部署。
    const defaultUninstall = runCli(['--uninstall'], first)
    assert.equal(defaultUninstall.status, 0, defaultUninstall.stderr)
    assert.ok(existsSync(alphaManifest.manifestPath), '默认名卸载不得删除自定义部署')
    assert.ok(existsSync(join(first.dataDir, INSTALL_RECORD_FILE)), '默认名卸载不得删除自定义安装记录')

    // 指定 alpha 卸载只删除 alpha 的注册、launcher 与记录。
    const alphaUninstall = runCli(['--uninstall'], first, { [HOST_NAME_ENV]: alpha })
    assert.equal(alphaUninstall.status, 0, alphaUninstall.stderr)
    assert.ok(!existsSync(alphaManifest.manifestPath), '必须删除 alpha 注册文件')
    assert.ok(existsSync(betaManifest.manifestPath), '不得删除 beta 注册文件')
    assert.ok(existsSync(join(second.dataDir, INSTALL_RECORD_FILE)), '不得删除 beta 安装记录')
    assert.ok(existsSync(join(second.dataDir, LAUNCHER_FILE)), '不得删除 beta launcher')

    const betaUninstall = runCli(['--uninstall'], second, { [HOST_NAME_ENV]: beta })
    assert.equal(betaUninstall.status, 0, betaUninstall.stderr)
    assert.ok(!existsSync(betaManifest.manifestPath), '必须删除 beta 注册文件')
  })

  test('同一 dataDir 切换 host 名被拒绝且零副作用', () => {
    const dirs = createDirs()
    const alpha = 'top.ggball.fishops.alpha'
    const beta = 'top.ggball.fishops.beta'
    assert.equal(runCli([], dirs, { [HOST_NAME_ENV]: alpha }).status, 0)

    const alphaManifest = readManifest(dirs, alpha)
    const configPath = join(dirs.dataDir, CONFIG_FILE)
    const recordPath = join(dirs.dataDir, INSTALL_RECORD_FILE)
    const manifestBefore = readFileSync(alphaManifest.manifestPath, 'utf8')
    const configBefore = readFileSync(configPath, 'utf8')
    const recordBefore = readFileSync(recordPath, 'utf8')

    const result = runCli([], dirs, { [HOST_NAME_ENV]: beta })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /host 名|不一致|切换/)
    assert.equal(readFileSync(alphaManifest.manifestPath, 'utf8'), manifestBefore, '不得改写原 host 注册')
    assert.equal(readFileSync(configPath, 'utf8'), configBefore, '不得改写配置')
    assert.equal(readFileSync(recordPath, 'utf8'), recordBefore, '不得改写安装记录')
    assert.ok(!existsSync(manifestPathFor(dirs, beta)), '不得写入新 host 名注册文件')
  })

  test('安装记录缺失时仍拒绝同 dataDir 切换 host 名', () => {
    const dirs = createDirs()
    const alpha = 'top.ggball.fishops.alpha'
    const beta = 'top.ggball.fishops.beta'
    assert.equal(runCli([], dirs, { [HOST_NAME_ENV]: alpha }).status, 0)
    rmSync(join(dirs.dataDir, INSTALL_RECORD_FILE))

    const alphaManifest = readManifest(dirs, alpha)
    const manifestBefore = readFileSync(alphaManifest.manifestPath, 'utf8')
    const result = runCli([], dirs, { [HOST_NAME_ENV]: beta })

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /host 名|不一致|切换|launcher/)
    assert.equal(readFileSync(alphaManifest.manifestPath, 'utf8'), manifestBefore, '不得改写原 host 注册')
    assert.ok(!existsSync(manifestPathFor(dirs, beta)), '不得写入新 host 名注册文件')
  })

  test('非法配置不被覆盖且不回显内容', () => {
    const badConfigs = [
      '{ 这不是 JSON',
      JSON.stringify({ port: 'abc', token: 123 }),
      JSON.stringify({ port: 70000, token: 'x'.repeat(64) }),
      JSON.stringify({ port: 'fake-token-secret-value-0123456789', token: 'short' }),
    ]
    for (const bad of badConfigs) {
      const dirs = createDirs()
      mkdirSync(dirs.dataDir, { recursive: true, mode: 0o700 })
      const configPath = join(dirs.dataDir, CONFIG_FILE)
      writeFileSync(configPath, bad, { mode: 0o600 })

      const result = runCli([], dirs)
      assert.notEqual(result.status, 0, `非法配置必须被拒绝：${bad}`)
      assert.equal(readFileSync(configPath, 'utf8'), bad, '非法配置不得被覆盖')
      const output = `${result.stdout}${result.stderr}`
      assert.ok(!output.includes('fake-token-secret-value-0123456789'), '失败输出不得回显配置内容')
      assert.ok(!output.includes(bad), '失败输出不得回显原始配置')
    }
  })

  test('非 Node 24 运行安装脚本被拒绝且不产生文件', (t) => {
    if (!OTHER_NODE) {
      t.diagnostic('本机找不到非 Node 24 的 node，跳过版本拒绝用例')
      return
    }
    const dirs = createDirs()
    const result = runCli([], dirs, {}, OTHER_NODE.bin)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Node 24/)
    assert.ok(!existsSync(dirs.dataDir), '版本不满足时不得创建配置目录')
  })

  test('用真实 host 入口与真实扩展产物完成安装（隔离目录）', (t) => {
    const realEntry = join(REPO_ROOT, 'apps', 'host', 'src', 'main.ts')
    const realDistManifest = join(REPO_ROOT, 'apps', 'extension', 'dist', 'manifest.json')
    if (!existsSync(realEntry) || !existsSync(realDistManifest)) {
      t.diagnostic('真实 host 入口或扩展产物尚未生成，跳过该用例')
      return
    }

    const dirs = createDirs()
    const result = runCli([], dirs, { FISHOPS_EXTENSION_DIST: undefined, FISHOPS_HOST_ENTRY: undefined })
    assert.equal(result.status, 0, result.stderr)

    const launcher = readFileSync(join(dirs.dataDir, LAUNCHER_FILE), 'utf8')
    assert.ok(launcher.includes(realEntry), '默认 launcher 必须指向生产入口 apps/host/src/main.ts')
    assert.ok(launcher.includes(NODE24.bin))

    const { manifest } = readManifest(dirs)
    const realKey = JSON.parse(readFileSync(realDistManifest, 'utf8')).key
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionIdFromKey(realKey)}/`])
  })

  test('launcher 在含空格路径下可从任意 cwd 启动', () => {
    const dirs = createDirs()
    assert.equal(runCli([], dirs).status, 0)
    const launcherPath = join(dirs.dataDir, LAUNCHER_FILE)

    // 只给 PATH，不传 FISHOPS_HOME：验证 launcher 自身注入配置目录。
    const run = spawnSync(launcherPath, [], {
      encoding: 'utf8',
      cwd: '/',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    })
    assert.equal(run.status, 0, run.stderr)
    const payload = JSON.parse(run.stdout.trim())
    assert.equal(payload.home, dirs.dataDir)
    assert.equal(payload.port, DEFAULT_PORT)
    assert.ok(payload.node.startsWith('24.'), `launcher 必须用 Node 24 运行，实际 ${payload.node}`)
  })

  test('FISHOPS_PORT 指定端口时新配置使用该端口', () => {
    const dirs = createDirs()
    const result = runCli([], dirs, { [PORT_ENV]: '19123' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readConfig(dirs).config.port, 19123)
  })

  test('通用 PORT 环境变量不影响 native Host 安装端口', () => {
    const dirs = createDirs()
    const result = runCli([], dirs, { PORT: '19999' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readConfig(dirs).config.port, DEFAULT_PORT)
  })

  test('--port 参数优先于 FISHOPS_PORT', () => {
    const dirs = createDirs()
    const result = runCli(['--port', '19222'], dirs, { [PORT_ENV]: '19123' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readConfig(dirs).config.port, 19222)
  })

  test('未指定端口时保留既有配置端口', () => {
    const dirs = createDirs()
    mkdirSync(dirs.dataDir, { recursive: true, mode: 0o700 })
    const configPath = join(dirs.dataDir, CONFIG_FILE)
    writeFileSync(configPath, `${JSON.stringify({ port: 19001, token: 't'.repeat(48) }, null, 2)}\n`, { mode: 0o600 })
    const before = readFileSync(configPath, 'utf8')

    const result = runCli([], dirs)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(configPath, 'utf8'), before, '未指定端口时不得重写配置')
    assert.equal(readConfig(dirs).config.port, 19001)
  })

  test('指定端口与既有配置不同必须拒绝且零副作用', () => {
    const dirs = createDirs()
    assert.equal(runCli([], dirs).status, 0)
    const { configPath, config } = readConfig(dirs)
    const configBefore = readFileSync(configPath, 'utf8')

    const conflicted = runCli([], dirs, { [PORT_ENV]: String(config.port + 1) })
    assert.notEqual(conflicted.status, 0)
    assert.match(conflicted.stderr, /不一致|端口/)
    assert.equal(readFileSync(configPath, 'utf8'), configBefore, '端口冲突不得改写既有配置')

    const cliConflicted = runCli(['--port', String(config.port + 2)], dirs)
    assert.notEqual(cliConflicted.status, 0)
    assert.equal(readFileSync(configPath, 'utf8'), configBefore, 'CLI 端口冲突不得改写既有配置')

    // 与既有端口一致时视为幂等，允许重复安装。
    const same = runCli([], dirs, { [PORT_ENV]: String(config.port) })
    assert.equal(same.status, 0, same.stderr)
    assert.equal(readConfig(dirs).config.token, config.token, '端口一致时必须保留 token')
  })

  test('非法端口在任何写入前拒绝且零副作用', () => {
    const cases = [
      { name: '--port 0', args: ['--port', '0'] },
      { name: '--port 65536', args: ['--port', '65536'] },
      { name: '--port 不是整数', args: ['--port', '1.5'] },
      { name: '--port 非数字', args: ['--port', 'abc'] },
      { name: '--port 缺少值', args: ['--port'] },
      { name: '--port= 空值', args: ['--port='] },
      { name: 'FISHOPS_PORT=0', args: [], extraEnv: { [PORT_ENV]: '0' } },
      { name: 'FISHOPS_PORT=70000', args: [], extraEnv: { [PORT_ENV]: '70000' } },
      { name: 'FISHOPS_PORT 非数字', args: [], extraEnv: { [PORT_ENV]: 'not-a-port' } },
      { name: 'FISHOPS_PORT 空串', args: [], extraEnv: { [PORT_ENV]: '' } },
    ]
    for (const item of cases) {
      const dirs = createDirs()
      const result = runCli(item.args, dirs, item.extraEnv ?? {})
      assert.notEqual(result.status, 0, `非法端口必须被拒绝：${item.name}`)
      assert.match(result.stderr, /端口/, `失败信息需说明端口非法：${item.name}`)
      assertNoSideEffects(dirs)
    }
  })

  test('非法 native host 名在任何写入前拒绝且零副作用', () => {
    const cases = [
      { name: '大写', value: 'Top.Name' },
      { name: '连续点', value: 'a..b' },
      { name: '前导点', value: '.a' },
      { name: '尾随点', value: 'b.' },
      { name: '横线', value: 'a-b' },
      { name: '路径分隔符', value: 'a/b' },
      { name: '反斜杠', value: 'a\\b' },
      { name: '上级路径', value: '../evil' },
      { name: '空格', value: 'a b' },
      { name: '空串', value: '' },
      { name: '超长', value: 'a'.repeat(HOST_NAME_MAX_LENGTH + 1) },
    ]
    for (const item of cases) {
      const dirs = createDirs()
      const result = runCli([], dirs, { [HOST_NAME_ENV]: item.value })
      assert.notEqual(result.status, 0, `非法 host 名必须被拒绝：${item.name}`)
      assert.match(result.stderr, /host 名/, `失败信息需说明 host 名非法：${item.name}`)
      assertNoSideEffects(dirs)
      assert.ok(!existsSync(join(dirs.root, 'evil.json')), '不得通过 host 名写出 nativeDir')
    }

    // options.hostName 与 env 走同一校验入口；直接调用也必须零写入。
    const direct = createDirs()
    assert.throws(
      () =>
        install({
          hostName: '../evil',
          dataDir: direct.dataDir,
          nativeDir: direct.nativeDir,
          distDir: direct.distDir,
          hostEntry: direct.entry,
          env: {},
        }),
      /host 名/,
    )
    assertNoSideEffects(direct)
  })

  test('options.hostName 优先于 FISHOPS_HOST_NAME，并贯穿安装与卸载', () => {
    const dirs = createDirs()
    const hostName = 'top.ggball.fishops.api'
    const result = install({
      hostName,
      dataDir: dirs.dataDir,
      nativeDir: dirs.nativeDir,
      distDir: dirs.distDir,
      hostEntry: dirs.entry,
      env: { [HOST_NAME_ENV]: 'top.ggball.fishops.env' },
    })
    assert.equal(result.hostName, hostName)
    assert.equal(readManifest(dirs, hostName).manifest.name, hostName)
    assert.ok(!existsSync(manifestPathFor(dirs, 'top.ggball.fishops.env')))

    const removed = uninstall({ hostName, dataDir: dirs.dataDir, nativeDir: dirs.nativeDir, env: {} })
    assert.equal(removed.hostName, hostName)
    assert.ok(!existsSync(manifestPathFor(dirs, hostName)))
    assert.ok(!existsSync(join(dirs.dataDir, INSTALL_RECORD_FILE)))
  })

  test('非默认 dataDir 未显式指定 nativeDir 时拒绝安装且零副作用', () => {
    // 用临时 HOME 沙箱，保证“默认 Chrome 目录”也落在临时目录内，绝不触碰真实 Chrome 注册。
    const dirs = createDirs()
    dirs.home = join(dirs.root, 'fake home')
    mkdirSync(dirs.home, { recursive: true })
    const defaultChromeDir = join(
      dirs.home,
      'Library',
      'Application Support',
      'Google',
      'Chrome',
      'NativeMessagingHosts',
    )
    const defaultManifestPath = join(defaultChromeDir, `${HOST_NAME}.json`)

    // HOME 指向沙箱、FISHOPS_HOME 为另一处自定义目录：默认 dataDir 是沙箱 home，与自定义 dataDir 不同，
    // 因此未显式指定 native manifest 目录时必须被护栏拒绝。
    const result = runCli([], dirs, { FISHOPS_NATIVE_MANIFEST_DIR: undefined, HOME: dirs.home })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /FISHOPS_NATIVE_MANIFEST_DIR|native manifest/)
    assert.ok(!existsSync(dirs.dataDir), `护栏拒绝时不得创建配置目录：${dirs.dataDir}`)
    assert.ok(!existsSync(defaultManifestPath), '护栏拒绝时不得写默认 native 注册目录')
  })

  test('旧安装记录缺少 hostName 与 nativeManifestPath 时仍按默认 host 名兼容', () => {
    const dirs = createDirs()
    assert.equal(runCli([], dirs).status, 0)

    const recordPath = join(dirs.dataDir, INSTALL_RECORD_FILE)
    const legacyRecord = JSON.parse(readFileSync(recordPath, 'utf8'))
    delete legacyRecord.hostName
    delete legacyRecord.nativeManifestPath
    writeFileSync(recordPath, `${JSON.stringify(legacyRecord, null, 2)}\n`, { mode: 0o600 })

    // 旧记录缺少新字段时，默认重复安装必须继续可用，并补回 hostName。
    const reinstall = runCli([], dirs)
    assert.equal(reinstall.status, 0, reinstall.stderr)
    assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).hostName, HOST_NAME)

    // 再次模拟旧记录，默认卸载仍必须删除本部署的注册、launcher 与记录。
    const legacyAgain = JSON.parse(readFileSync(recordPath, 'utf8'))
    delete legacyAgain.hostName
    delete legacyAgain.nativeManifestPath
    writeFileSync(recordPath, `${JSON.stringify(legacyAgain, null, 2)}\n`, { mode: 0o600 })

    const removed = runCli(['--uninstall'], dirs)
    assert.equal(removed.status, 0, removed.stderr)
    assert.ok(!existsSync(manifestPathFor(dirs, HOST_NAME)), '必须删除默认 host 注册文件')
    assert.ok(!existsSync(join(dirs.dataDir, LAUNCHER_FILE)), '必须删除本部署 launcher')
    assert.ok(!existsSync(recordPath), '必须删除本部署安装记录')
  })

  test('卸载删除本部署注册并保留数据，重复卸载安全', () => {
    const dirs = createDirs()
    assert.equal(runCli([], dirs).status, 0)

    const { configPath, config } = readConfig(dirs)
    const configBefore = readFileSync(configPath, 'utf8')
    const dbPath = join(dirs.dataDir, 'fishops.db')
    const unrelatedPath = join(dirs.dataDir, 'unrelated.txt')
    writeFileSync(dbPath, 'fixture-db')
    writeFileSync(unrelatedPath, 'unrelated')

    const first = runCli(['--uninstall'], dirs)
    assert.equal(first.status, 0, first.stderr)
    assert.ok(!existsSync(join(dirs.nativeDir, `${HOST_NAME}.json`)), '必须删除本部署的注册文件')
    assert.ok(!existsSync(join(dirs.dataDir, LAUNCHER_FILE)), '必须删除本部署的 launcher')
    assert.ok(!existsSync(join(dirs.dataDir, INSTALL_RECORD_FILE)), '必须删除本部署的安装记录')
    assert.equal(readFileSync(configPath, 'utf8'), configBefore, '默认必须保留配置')
    assert.equal(readFileSync(dbPath, 'utf8'), 'fixture-db', '默认必须保留数据库')
    assert.equal(readFileSync(unrelatedPath, 'utf8'), 'unrelated', '不得删除无关文件')
    assert.ok(existsSync(dirs.dataDir), '不得删除配置目录')
    assert.ok(!first.stdout.includes(config.token))

    const second = runCli(['--uninstall'], dirs)
    assert.equal(second.status, 0, second.stderr)
    assert.equal(readFileSync(configPath, 'utf8'), configBefore)
  })

  test('卸载保留不属于本部署的 launcher 与注册文件', () => {
    const dirs = createDirs()
    mkdirSync(dirs.dataDir, { recursive: true, mode: 0o700 })
    mkdirSync(dirs.nativeDir, { recursive: true, mode: 0o700 })

    const foreignLauncherPath = join(dirs.dataDir, LAUNCHER_FILE)
    writeFileSync(foreignLauncherPath, '#!/bin/sh\nexec /usr/bin/true\n', { mode: 0o700 })
    const manifestPath = join(dirs.nativeDir, `${HOST_NAME}.json`)
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          name: HOST_NAME,
          description: '外来部署',
          path: foreignLauncherPath,
          type: 'stdio',
          allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],
        },
        null,
        2,
      )}\n`,
    )

    const result = runCli(['--uninstall'], dirs)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(existsSync(foreignLauncherPath), '不得删除无法确认归属的 launcher')
    assert.ok(existsSync(manifestPath), '不得删除外来注册文件')
  })

  test('重复卸载保留卸载后出现的外来 launcher', () => {
    const dirs = createDirs()
    assert.equal(runCli([], dirs).status, 0)
    assert.equal(runCli(['--uninstall'], dirs).status, 0)

    const foreignLauncherPath = join(dirs.dataDir, LAUNCHER_FILE)
    writeFileSync(foreignLauncherPath, '#!/bin/sh\nexec /usr/bin/false\n', { mode: 0o700 })

    const second = runCli(['--uninstall'], dirs)
    assert.equal(second.status, 0, second.stderr)
    assert.ok(existsSync(foreignLauncherPath), '第二次卸载不得删除外来同名 launcher')
  })
})
