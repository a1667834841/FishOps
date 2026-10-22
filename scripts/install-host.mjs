#!/usr/bin/env node
/**
 * FishOps agent API native messaging host 安装／卸载脚本。
 *
 * 职责：
 * - 生成 agent 读取的 config.json（端口 + 随机 token）；私有目录 0700，配置 0600。
 * - 生成 launcher，用安装时 Node 可执行文件的绝对路径运行生产入口 apps/host/src/main.ts。
 * - 写入 Chrome native messaging host manifest，把扩展 key 推导出的 ID 写入 allowed_origins。
 * - native host 名默认 top.ggball.fishops，可由 options.hostName / FISHOPS_HOST_NAME 覆盖；
 *   自定义名同样贯穿注册、安装记录、归属校验与卸载，避免隔离部署互相覆盖。
 *
 * 安全边界（实施契约与测试方案要求）：
 * - 只支持 Node 24 基线，其他版本拒绝执行，避免用本机其他 Node 生成不可运行的 launcher。
 * - 重复安装保留已有 token 与数据库；遇到其他部署的注册文件停止，不覆盖。
 * - 同一 dataDir 不允许切换 host 名；不同 host 名可在同一 nativeDir 共存。
 * - 非法配置不被覆盖；卸载默认保留配置与数据。
 * - 本脚本不提供递归删除生产数据目录的能力；清理数据必须由用户手动确认后执行。
 */
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Chrome native messaging host 名，扩展与安装脚本必须一致。 */
export const HOST_NAME = 'top.ggball.fishops'
/** 覆盖 native host 名的首选环境变量名；options.hostName 优先于它。 */
export const HOST_NAME_ENV = 'FISHOPS_HOST_NAME'
/** 指定 native host 名的 CLI 选项名，与 options.hostName / FISHOPS_HOST_NAME 等价。 */
export const HOST_NAME_FLAG = '--host-name'
/** 与扩展构建脚本保持一致的 host 名长度上限。 */
export const HOST_NAME_MAX_LENGTH = 255
/** 本部署的 ownership 标记值，用于识别自己写入的注册文件与安装记录。 */
export const OWNER = 'fishops-agent-api'
/** 写进 native host manifest 的 ownership 字段名（Chrome 忽略未知字段）。 */
export const OWNER_FIELD = 'x-fishops-owner'
/** 默认监听端口，只绑定 127.0.0.1。 */
export const DEFAULT_PORT = 18790
/** 指定端口的 CLI 选项名，与 options.port / FISHOPS_PORT 等价。 */
export const PORT_FLAG = '--port'
/** 指定端口的首选环境变量名。 */
export const PORT_ENV = 'FISHOPS_PORT'
/** 实施契约固定的 Node 主版本。 */
export const SUPPORTED_NODE_MAJOR = 24
export const CONFIG_FILE = 'config.json'
export const LAUNCHER_FILE = 'host-launcher.sh'
export const INSTALL_RECORD_FILE = 'install.json'
export const DATABASE_FILE = 'fishops.db'
/** launcher 内容标记：卸载时用它确认文件确实由本脚本生成，而不是其他部署留下的同名文件。 */
export const LAUNCHER_MARKER = 'scripts/install-host.mjs 生成'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
/** 仓库根目录，用于解析默认的扩展产物与 host 入口。 */
export const REPO_ROOT = resolve(MODULE_DIR, '..')

/** 内置默认配置目录（macOS 应用支持目录），不读取 FISHOPS_HOME，用于与自定义目录区分。 */
export function builtinDefaultDataDir() {
  return join(homedir(), 'Library', 'Application Support', 'FishOps')
}

/** FISHOPS_HOME 优先；未设置时使用内置默认配置目录。 */
export function defaultDataDir(env = process.env) {
  const custom = env.FISHOPS_HOME
  return custom ? resolve(custom) : builtinDefaultDataDir()
}

/** native host manifest 目录：测试必须用 FISHOPS_NATIVE_MANIFEST_DIR 指向隔离目录。 */
export function defaultNativeManifestDir(env = process.env) {
  const custom = env.FISHOPS_NATIVE_MANIFEST_DIR
  return custom
    ? resolve(custom)
    : join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
}

/** 扩展构建产物目录，默认 apps/extension/dist。 */
export function defaultExtensionDistDir(env = process.env) {
  const custom = env.FISHOPS_EXTENSION_DIST
  return custom ? resolve(custom) : join(REPO_ROOT, 'apps', 'extension', 'dist')
}

/** host 生产入口，默认 apps/host/src/main.ts。 */
export function defaultHostEntry(env = process.env) {
  const custom = env.FISHOPS_HOST_ENTRY
  return custom ? resolve(custom) : join(REPO_ROOT, 'apps', 'host', 'src', 'main.ts')
}

/**
 * Chrome native messaging host 名校验。
 * 只允许小写字母、数字、下划线与单点分段，且长度不超过 255；该规则同时阻断路径穿越字符。
 */
export function isValidHostName(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= HOST_NAME_MAX_LENGTH &&
    /^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(value)
  )
}

/**
 * 解析本次安装／卸载应使用的 native host 名与来源。
 * 优先级：options.hostName > FISHOPS_HOST_NAME > HOST_NAME。
 * 非法名称直接抛错；此函数不产生文件系统副作用，调用方必须在任何写入前调用。
 */
export function resolveHostName({ options = {}, env = process.env } = {}) {
  let value
  let source
  if (Object.hasOwn(options, 'hostName') && options.hostName !== undefined) {
    value = options.hostName
    source = 'options'
  } else if (env?.[HOST_NAME_ENV] !== undefined) {
    value = env[HOST_NAME_ENV]
    source = 'env'
  } else {
    value = HOST_NAME
    source = 'default'
  }
  if (!isValidHostName(value)) {
    const reason =
      typeof value === 'string' && value.length > HOST_NAME_MAX_LENGTH
        ? `长度不得超过 ${HOST_NAME_MAX_LENGTH} 个字符`
        : '仅允许小写字母、数字、下划线和点，点不能开头、结尾或连续出现'
    throw new Error(`native host 名非法：${String(value)}；${reason}`)
  }
  return { hostName: value, source, specified: source !== 'default' }
}

/**
 * 由扩展 manifest 的 key 推导 Chrome 扩展 ID。
 * 算法：key 是 base64 的 DER 公钥，取其 SHA-256 前 16 字节，每个十六进制半字节映射为 a-p。
 */
export function extensionIdFromKey(key) {
  if (typeof key !== 'string' || key.length === 0) throw new Error('扩展 key 缺失或不是字符串')
  const der = Buffer.from(key, 'base64')
  if (der.length < 32) throw new Error('扩展 key 解码后长度不足，无法推导扩展 ID')
  const digest = createHash('sha256').update(der).digest().subarray(0, 16)
  return [...digest]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('')
    .replace(/[0-9a-f]/g, char => String.fromCharCode(97 + Number.parseInt(char, 16)))
}

/** 校验已存在的配置对象；返回错误说明，合法时返回 null。 */
export function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '配置必须是 JSON 对象'
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return 'port 必须是 1-65535 的整数'
  if (typeof value.token !== 'string' || value.token.length < 32) return 'token 必须是长度不少于 32 的字符串'
  if (!/^[A-Za-z0-9_-]+$/.test(value.token)) return 'token 只能包含 URL 安全字符'
  return null
}

/** 端口数值校验：只接受 1-65535 的严格整数，越界或非整数返回 false。 */
export function isPortNumber(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

/**
 * 解析端口入参：把 options.port 或环境变量归一化为数值。
 * 未提供返回 undefined；提供但非法（非整数、越界、空串、NaN）返回 null，由调用方拒绝。
 */
function normalizePortParam(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return isPortNumber(value) ? value : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') return null
    if (!/^\d+$/.test(text)) return null
    const num = Number(text)
    return isPortNumber(num) ? num : null
  }
  return null
}

/** 从环境变量读取显式端口：仅识别 FISHOPS_PORT；未设置返回 undefined。 */
function portFromEnv(env = process.env) {
  const raw = env?.[PORT_ENV]
  return normalizePortParam(raw)
}

/**
 * 解析本次安装应使用的端口与来源。
 * 优先级：options.port > FISHOPS_PORT> 未指定（port 为 undefined，由调用方回落到旧配置或默认端口）。
 * 显式指定但非法时抛错；此函数不产生任何文件系统副作用，宿主需在任何写入前调用。
 */
export function resolvePort({ options = {}, env = process.env } = {}) {
  const explicit = Object.hasOwn(options, 'port') ? normalizePortParam(options.port) : undefined
  if (explicit === null) {
    throw new Error(`指定的端口非法：${String(options.port)}；端口必须是 1-65535 的整数`)
  }
  if (explicit !== undefined) return { port: explicit, source: 'options', specified: true }
  const fromEnv = portFromEnv(env)
  if (fromEnv === null) {
    throw new Error(`环境变量 ${PORT_ENV} 非法：${String(env?.[PORT_ENV])}；端口必须是 1-65535 的整数`)
  }
  if (fromEnv !== undefined) return { port: fromEnv, source: 'env', specified: true }
  return { port: undefined, source: 'default', specified: false }
}

/**
 * 隔离护栏：使用非默认 dataDir 却未显式指定 native manifest 目录时拒绝。
 * 避免自定义 FISHOPS_HOME（例如隔离测试目录）时误写真实 Chrome 的 NativeMessagingHosts 注册。
 */
export function assertNativeDirIsolation({ dataDir, nativeExplicit }) {
  // 与内置默认目录比较，而不是与 defaultDataDir 比较：后者会读取 FISHOPS_HOME，
  // 会把自定义目录误判为默认目录而放过护栏。
  if (resolve(dataDir) === builtinDefaultDataDir()) return
  if (nativeExplicit) return
  throw new Error(
    `使用了自定义配置目录 ${dataDir}，但未显式指定 native manifest 目录；` +
      `为避免误写主 Chrome 注册目录，请设置 FISHOPS_NATIVE_MANIFEST_DIR（或 options.nativeDir）后重试`,
  )
}

/** 生成高强度 token：32 字节随机数的 URL 安全 base64。 */
export function generateToken() {
  return randomBytes(32).toString('base64url')
}

/** Node 版本检查：安装与卸载都只接受契约固定的 Node 24。 */
export function assertSupportedNode(version = process.versions.node, execPath = process.execPath) {
  const major = Number.parseInt(String(version).split('.')[0], 10)
  if (major !== SUPPORTED_NODE_MAJOR) {
    throw new Error(
      `需要 Node ${SUPPORTED_NODE_MAJOR}.x（当前 ${version}，${execPath}）；实施契约固定 Node 24 基线，请用 Node 24 运行本脚本`,
    )
  }
}

/** POSIX 单引号转义，保证 launcher 中的路径含空格或单引号也能正确执行。 */
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/** launcher 源码：固定安装时的 Node 绝对路径，并注入 FISHOPS_HOME，保证从任意 cwd 读取正确配置。 */
export function launcherSource({ nodeBin, hostEntry, dataDir }) {
  return [
    '#!/bin/sh',
    `# FishOps agent API native host launcher（由 ${LAUNCHER_MARKER}，请勿手工编辑）`,
    `FISHOPS_HOME=${shellQuote(dataDir)}`,
    'export FISHOPS_HOME',
    `exec ${shellQuote(nodeBin)} ${shellQuote(hostEntry)}`,
    '',
  ].join('\n')
}

/** 判断文件是否为本脚本生成的 launcher：内容标记 + 指向当前配置目录。 */
function looksLikeOurLauncher(filePath, dataDir) {
  if (!existsSync(filePath)) return false
  try {
    const text = readFileSync(filePath, 'utf8')
    return text.startsWith('#!/bin/sh') && text.includes(LAUNCHER_MARKER) && text.includes(`FISHOPS_HOME=${shellQuote(dataDir)}`)
  } catch {
    return false
  }
}

function readJsonFile(filePath) {
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`无法读取 ${filePath}：${error.code ?? error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`无法解析 JSON：${filePath}`)
  }
}

/** 读取扩展产物 manifest，校验 MV3、版本与固定 key，并推导扩展 ID。 */
export function readExtensionManifest(distDir) {
  const manifestPath = join(distDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`未找到扩展产物 ${manifestPath}；请先构建扩展`)
  }
  const manifest = readJsonFile(manifestPath)
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`扩展 manifest 必须是 JSON 对象：${manifestPath}`)
  }
  if (manifest.manifest_version !== 3) throw new Error(`扩展 manifest 必须是 MV3：${manifestPath}`)
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    throw new Error(`扩展 manifest 版本非法：${String(manifest.version)}`)
  }
  const extensionId = extensionIdFromKey(manifest.key)
  return { manifestPath, version: manifest.version, key: manifest.key, extensionId }
}

function ensureOwnedPrivateDir(dir) {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`路径不是目录：${dir}`)
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  chmodSync(dir, 0o700)
}

function ensureDirectory(dir) {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`路径不是目录：${dir}`)
    return
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

function writePrivateFile(filePath, content, mode = 0o600) {
  writeFileSync(filePath, content, { mode })
  chmodSync(filePath, mode)
}

function isInside(parentDir, candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  const parent = resolve(parentDir)
  const target = resolve(candidate)
  return target !== parent && target.startsWith(parent + sep)
}

/**
 * 由 host 名生成 native manifest 路径。
 * host 名已按 Chrome 规则校验；这里再做一次相对路径检查，避免任何拼接异常写出 nativeDir。
 */
function nativeManifestPathFor(nativeDir, hostName) {
  const base = resolve(nativeDir)
  const target = resolve(base, `${hostName}.json`)
  const rel = relative(base, target)
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`native host 名导致路径越界：${String(hostName)}`)
  }
  return target
}

/** 读取安装记录中的 host 名；旧记录缺少该字段时按历史默认名兼容。 */
function recordHostNameOf(record) {
  return typeof record?.hostName === 'string' && record.hostName.length > 0 ? record.hostName : HOST_NAME
}

/**
 * 冲突检查：其他部署的注册文件、悬空的安装记录、同 host 名指向其他 launcher 都停止安装。
 * 归属判定不只看 owner/path，还比对配置目录、host 入口与扩展 ID，避免其他 worktree 复用同一
 * FISHOPS_HOME 时把本部署覆盖掉。
 */
function assertNoForeignDeployment({
  dataDir,
  nativeDir,
  hostName,
  nativeManifestPath,
  launcherPath,
  recordPath,
  hostEntry,
  extensionId,
}) {
  let record = null
  if (existsSync(recordPath)) {
    record = readJsonFile(recordPath)
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.owner !== OWNER) {
      throw new Error(`已存在不属于本部署的安装记录：${recordPath}；停止安装以保护现有部署`)
    }
    if (record.dataDir !== dataDir) {
      throw new Error(`安装记录的配置目录 ${String(record.dataDir)} 与本次 ${dataDir} 不一致；停止安装`)
    }
    const recordHostName = recordHostNameOf(record)
    if (recordHostName !== hostName) {
      throw new Error(
        `配置目录 ${dataDir} 已绑定 native host 名 ${recordHostName}，不能切换为 ${hostName}；` +
          '请使用独立的 FISHOPS_HOME，或先卸载旧部署',
      )
    }
    if (record.nativeManifestPath && resolve(String(record.nativeManifestPath)) !== nativeManifestPath) {
      throw new Error(
        `安装记录指向 ${String(record.nativeManifestPath)}，与本次目标 ${nativeManifestPath} 不一致；请先卸载旧部署`,
      )
    }
    if (record.hostEntry !== hostEntry) {
      throw new Error(
        `配置目录已被其他部署占用（安装记录 host 入口 ${String(record.hostEntry)}，本次 ${hostEntry}）；` +
          '请为当前 worktree 使用独立的 FISHOPS_HOME，或先卸载旧部署',
      )
    }
    if (record.extensionId && record.extensionId !== extensionId) {
      throw new Error(
        `安装记录的扩展 ID ${String(record.extensionId)} 与本次产物 ${extensionId} 不一致；停止安装，请先卸载旧部署`,
      )
    }
  }

  // 安装记录可能被手工删除；此时仍按 launcher 归属识别同一 dataDir 的换名安装。
  // 只检查带本部署标记且指向同一 launcher 的 manifest，因此不同 dataDir 的同目录部署仍可共存。
  let nativeEntries = []
  try {
    nativeEntries = existsSync(nativeDir) ? readdirSync(nativeDir) : []
  } catch {
    nativeEntries = []
  }
  for (const entry of nativeEntries) {
    if (!entry.endsWith('.json')) continue
    const candidatePath = resolve(nativeDir, entry)
    if (candidatePath === nativeManifestPath) continue
    let candidate
    try {
      candidate = readJsonFile(candidatePath)
    } catch {
      continue
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    if (candidate[OWNER_FIELD] !== OWNER || typeof candidate.path !== 'string') continue
    if (resolve(candidate.path) !== resolve(launcherPath)) continue
    throw new Error(
      `配置目录 ${dataDir} 的 launcher 已被 native host 名 ${String(candidate.name)} 注册（${candidatePath}），` +
        `不能切换为 ${hostName}；请先卸载旧部署`,
    )
  }

  if (!existsSync(nativeManifestPath)) return
  const existing = readJsonFile(nativeManifestPath)
  if (!existing || typeof existing !== 'object' || Array.isArray(existing) || existing[OWNER_FIELD] !== OWNER) {
    throw new Error(`已存在其他部署的注册文件 ${nativeManifestPath}（缺少本部署标记）；停止安装，不覆盖`)
  }
  if (existing.name !== hostName) {
    throw new Error(`注册文件 host 名不是 ${hostName}：${nativeManifestPath}；停止安装，不覆盖`)
  }
  if (!record) {
    throw new Error(
      `已存在带本部署标记但没有安装记录的注册文件：${nativeManifestPath}；` +
        '无法确认来源，本次不覆盖（确认后可手动删除该文件或恢复安装记录）',
    )
  }
  if (existing.path !== launcherPath) {
    throw new Error(
      `同一 host 名已指向其他 launcher（${String(existing.path)}）；请先卸载该部署，本次不覆盖`,
    )
  }
}

/**
 * 安装：生成配置、launcher、native host manifest 与安装记录。
 * 返回结果对象供调用方（CLI／测试）断言；结果不含 token，token 只写入配置文件。
 */
export function install(options = {}) {
  const env = options.env ?? process.env
  assertSupportedNode(options.nodeVersion ?? process.versions.node, options.nodeBin ?? process.execPath)

  // host 名、端口与隔离护栏先于一切文件系统写入校验：非法输入不产生任何文件或目录副作用。
  const requestedHost = resolveHostName({ options, env })
  const hostName = requestedHost.hostName
  const requestedPort = resolvePort({ options, env })
  const dataDir = options.dataDir ? resolve(options.dataDir) : defaultDataDir(env)
  const nativeExplicit = Boolean(options.nativeDir) || Boolean(env.FISHOPS_NATIVE_MANIFEST_DIR)
  assertNativeDirIsolation({ dataDir, nativeExplicit })
  const nativeDir = options.nativeDir ? resolve(options.nativeDir) : defaultNativeManifestDir(env)
  const distDir = options.distDir ? resolve(options.distDir) : defaultExtensionDistDir(env)
  const hostEntry = options.hostEntry ? resolve(options.hostEntry) : defaultHostEntry(env)
  const nodeBin = options.nodeBin ?? process.execPath

  const extension = readExtensionManifest(distDir)
  if (!existsSync(hostEntry)) throw new Error(`未找到 host 生产入口 ${hostEntry}；请先实现或构建 host`)

  const configPath = join(dataDir, CONFIG_FILE)
  const launcherPath = join(dataDir, LAUNCHER_FILE)
  const recordPath = join(dataDir, INSTALL_RECORD_FILE)
  const nativeManifestPath = nativeManifestPathFor(nativeDir, hostName)

  // 先校验已有配置：非法时直接停止，绝不覆盖。
  let port = requestedPort.port ?? DEFAULT_PORT
  let token = generateToken()
  let createdConfig = true
  if (existsSync(configPath)) {
    const existing = readJsonFile(configPath)
    const problem = validateConfig(existing)
    if (problem) {
      // 只报告校验结论，不回显原有内容，避免把 token 写进日志。
      throw new Error(`现有配置不合法（${problem}）：${configPath}；为避免覆盖，停止安装`)
    }
    // 指定端口与既有配置不一致时拒绝：不悄改正在运行的部署端口。
    if (requestedPort.specified && existing.port !== requestedPort.port) {
      throw new Error(
        `指定端口 ${requestedPort.port}（来源 ${requestedPort.source}）与现有配置端口 ${existing.port} 不一致：` +
          `${configPath}；为避免影响正在运行的部署，停止安装（如需改端口请先卸载或手动修改配置）`,
      )
    }
    port = existing.port
    token = existing.token
    createdConfig = false
  }

  // 冲突检查先于目录创建：被拒绝时不产生任何文件或目录副作用。
  assertNoForeignDeployment({
    dataDir,
    nativeDir,
    hostName,
    nativeManifestPath,
    launcherPath,
    recordPath,
    hostEntry,
    extensionId: extension.extensionId,
  })
  ensureOwnedPrivateDir(dataDir)
  ensureDirectory(nativeDir)

  if (createdConfig) {
    writePrivateFile(configPath, `${JSON.stringify({ port, token }, null, 2)}\n`)
  } else {
    // 保留原内容，只收敛权限，保证 0600。
    chmodSync(configPath, 0o600)
  }
  writePrivateFile(launcherPath, launcherSource({ nodeBin, hostEntry, dataDir }), 0o700)

  const nativeManifest = {
    name: hostName,
    description: 'FishOps Workbench agent API native host',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extension.extensionId}/`],
    [OWNER_FIELD]: OWNER,
  }
  writePrivateFile(nativeManifestPath, `${JSON.stringify(nativeManifest, null, 2)}\n`)

  const record = {
    owner: OWNER,
    hostName,
    installedAt: new Date().toISOString(),
    dataDir,
    configPath,
    launcherPath,
    nativeManifestPath,
    hostEntry,
    nodeBin,
    extensionId: extension.extensionId,
    extensionVersion: extension.version,
  }
  writePrivateFile(recordPath, `${JSON.stringify(record, null, 2)}\n`)

  return {
    hostName,
    dataDir,
    nativeDir,
    configPath,
    launcherPath,
    nativeManifestPath,
    recordPath,
    port,
    portSource: requestedPort.source,
    portSpecified: requestedPort.specified,
    createdConfig,
    extensionId: extension.extensionId,
    extensionVersion: extension.version,
    hostEntry,
    nodeBin,
  }
}

/**
 * 卸载：只删除能证明属于本部署的 native host manifest、launcher 与安装记录。
 * 删除 launcher 必须同时满足「安装记录归属本部署」和「内容确由本脚本生成」；
 * 默认保留配置与数据库；不删除父目录，也不删除其他文件。重复执行安全。
 */
export function uninstall(options = {}) {
  const env = options.env ?? process.env
  assertSupportedNode(options.nodeVersion ?? process.versions.node, options.nodeBin ?? process.execPath)

  const requestedHost = resolveHostName({ options, env })
  const hostName = requestedHost.hostName
  const dataDir = options.dataDir ? resolve(options.dataDir) : defaultDataDir(env)
  const nativeDir = options.nativeDir ? resolve(options.nativeDir) : defaultNativeManifestDir(env)
  const nativeManifestPath = nativeManifestPathFor(nativeDir, hostName)
  const recordPath = join(dataDir, INSTALL_RECORD_FILE)
  const removed = []
  const kept = []
  const notes = []

  let record = null
  if (existsSync(recordPath)) {
    const parsed = readJsonFile(recordPath)
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      parsed.owner === OWNER &&
      parsed.dataDir === dataDir
    ) {
      const recordHostName = recordHostNameOf(parsed)
      const recordPathMatches =
        !parsed.nativeManifestPath || resolve(String(parsed.nativeManifestPath)) === nativeManifestPath
      if (recordHostName === hostName && recordPathMatches) {
        record = parsed
      } else {
        kept.push(`${recordPath}（安装记录 host 名或注册路径与本次 ${hostName} 不一致，保留）`)
      }
    } else {
      kept.push(`${recordPath}（不属于本部署，保留）`)
    }
  }

  // 只有安装记录存在、launcher 路径在私有目录内、且内容确由本脚本生成时，才认为可删除。
  const ownedLauncherPath =
    record && isInside(dataDir, record.launcherPath) && looksLikeOurLauncher(record.launcherPath, dataDir)
      ? resolve(record.launcherPath)
      : null

  if (existsSync(nativeManifestPath)) {
    const manifest = readJsonFile(nativeManifestPath)
    const ours =
      manifest &&
      typeof manifest === 'object' &&
      !Array.isArray(manifest) &&
      manifest[OWNER_FIELD] === OWNER &&
      manifest.name === hostName
    if (!ours) {
      kept.push(`${nativeManifestPath}（不属于本部署，保留）`)
    } else if (!record) {
      kept.push(`${nativeManifestPath}（缺少本部署安装记录，保留以免误删其他部署）`)
    } else if (!ownedLauncherPath || manifest.path !== ownedLauncherPath) {
      kept.push(`${nativeManifestPath}（launcher 来源无法确认，保留）`)
    } else {
      rmSync(nativeManifestPath)
      removed.push(nativeManifestPath)
    }
  }

  if (ownedLauncherPath && existsSync(ownedLauncherPath)) {
    rmSync(ownedLauncherPath)
    removed.push(ownedLauncherPath)
  } else if (existsSync(join(dataDir, LAUNCHER_FILE))) {
    // 存在同名 launcher，但无法证明由本部署生成：保留，不删除外来文件。
    kept.push(`${join(dataDir, LAUNCHER_FILE)}（无法确认属于本部署，保留）`)
  }

  if (existsSync(recordPath) && record) {
    rmSync(recordPath)
    removed.push(recordPath)
  }

  for (const name of [CONFIG_FILE, DATABASE_FILE, `${DATABASE_FILE}-wal`, `${DATABASE_FILE}-shm`]) {
    const target = join(dataDir, name)
    if (existsSync(target)) kept.push(target)
  }
  if (removed.length === 0) notes.push('未发现本部署的注册文件，可能已经卸载')

  return { hostName, dataDir, nativeDir, removed, kept, notes }
}

export function usage() {
  return [
    '用法：node scripts/install-host.mjs [--port <1-65535>] [--host-name <name>] [--uninstall]',
    '',
    '选项：',
    '  --port <n>                   指定监听端口（1-65535 的整数）；与既有配置不一致时拒绝安装',
    `  --host-name <name>           指定 native host 名（默认 ${HOST_NAME}；仅小写字母、数字、下划线和点）`,
    '',
    '环境变量：',
    '  FISHOPS_HOME                 配置与数据目录（默认 ~/Library/Application Support/FishOps）',
    '  FISHOPS_NATIVE_MANIFEST_DIR  native host manifest 目录（默认 Chrome 的 NativeMessagingHosts）',
    '  FISHOPS_PORT                 指定监听端口（1-65535 的整数，等价于 --port；优先于默认端口）',
    `  FISHOPS_HOST_NAME            native host 名（默认 ${HOST_NAME}；options.hostName 优先于它）`,
    '  FISHOPS_EXTENSION_DIST       扩展构建产物目录（默认 apps/extension/dist）',
    '  FISHOPS_HOST_ENTRY           host 生产入口（默认 apps/host/src/main.ts）',
    '',
    '使用非默认 FISHOPS_HOME 时必须同时指定 FISHOPS_NATIVE_MANIFEST_DIR，避免误写主 Chrome 注册目录。',
    '卸载只删除本部署的 native host manifest、launcher 与安装记录；配置与数据库默认保留。',
    '本脚本不提供递归删除数据目录的能力；清理数据请手动确认后执行。',
  ].join('\n')
}

function main(argv, env) {
  const args = argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }
  // 解析参数：只接受 --uninstall、--port 与 --host-name（含 = 写法），其余参数一律拒绝。
  let uninstallMode = false
  let portArg
  let portArgSeen = false
  let hostArg
  let hostArgSeen = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--uninstall') {
      uninstallMode = true
    } else if (arg === PORT_FLAG) {
      if (portArgSeen) throw new Error('重复指定 --port；使用 --help 查看用法')
      portArg = args[index + 1]
      if (portArg === undefined || portArg.startsWith('-')) {
        throw new Error('--port 缺少端口值；端口必须是 1-65535 的整数')
      }
      index += 1
      portArgSeen = true
    } else if (arg.startsWith(`${PORT_FLAG}=`)) {
      if (portArgSeen) throw new Error('重复指定 --port；使用 --help 查看用法')
      portArg = arg.slice(PORT_FLAG.length + 1)
      if (portArg === '') throw new Error('--port 缺少端口值；端口必须是 1-65535 的整数')
      portArgSeen = true
    } else if (arg === HOST_NAME_FLAG) {
      if (hostArgSeen) throw new Error('重复指定 --host-name；使用 --help 查看用法')
      hostArg = args[index + 1]
      if (hostArg === undefined || hostArg.startsWith('-')) {
        throw new Error('--host-name 缺少 host 名；仅允许小写字母、数字、下划线和点')
      }
      index += 1
      hostArgSeen = true
    } else if (arg.startsWith(`${HOST_NAME_FLAG}=`)) {
      if (hostArgSeen) throw new Error('重复指定 --host-name；使用 --help 查看用法')
      hostArg = arg.slice(HOST_NAME_FLAG.length + 1)
      if (hostArg === '') throw new Error('--host-name 缺少 host 名；仅允许小写字母、数字、下划线和点')
      hostArgSeen = true
    } else {
      throw new Error(`未知参数 ${arg}；使用 --help 查看用法`)
    }
  }

  const options = { env }
  if (hostArgSeen && hostArg !== undefined) options.hostName = hostArg

  if (uninstallMode) {
    const result = uninstall(options)
    console.log(`已卸载 native host ${result.hostName}`)
    for (const item of result.removed) console.log(`  已删除: ${item}`)
    for (const item of result.kept) console.log(`  已保留: ${item}`)
    for (const item of result.notes) console.log(`  ${item}`)
    console.log('  数据目录未删除；如需清理请手动确认后删除')
    return 0
  }

  // 显式端口优先于 FISHOPS_PORT：CLI 参数作为 options.port 传入。
  const installOptions = { ...options }
  if (portArgSeen && portArg !== undefined) installOptions.port = portArg
  const result = install(installOptions)
  console.log(`已安装 native host ${result.hostName}`)
  console.log(`  扩展 ID: ${result.extensionId}（扩展版本 ${result.extensionVersion}）`)
  console.log(`  配置目录: ${result.dataDir}（0700）`)
  console.log(`  配置文件: ${result.configPath}（${result.createdConfig ? '已生成' : '已保留原有 token'}）`)
  console.log(`  launcher: ${result.launcherPath}（0700）`)
  console.log(`  native manifest: ${result.nativeManifestPath}`)
  console.log(`  host 入口: ${result.hostEntry}`)
  console.log(`  Node: ${result.nodeBin}（v${process.versions.node}）`)
  console.log(`  端口: ${result.port}（127.0.0.1）`)
  return 0
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    process.exitCode = main(process.argv, process.env)
  } catch (error) {
    const mode = process.argv.includes('--uninstall') ? '卸载' : '安装'
    console.error(`${mode}失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
