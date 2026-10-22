/** 将当前 worktree 的构建同步到固定测试目录，不将本地凭据放入产物。 */
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolveAgentConfigPath } from './agent-config-path.mjs'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const agentExtensionDir = join(homedir(), '.fishops', 'agent-extension')
const marker = '.fishops-agent-build.json'

/** 替换完整产物；锁防止多个 worktree 同时覆盖，旧目录必须由本脚本管理。 */
export async function syncBuild(source, target, metadata) {
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
  if (manifest.manifest_version !== 3) throw new Error('构建目录缺少有效 MV3 manifest')
  await readFile(join(source, 'workbench.html'))
  await mkdir(dirname(target), { recursive: true })
  const lock = `${target}.lock`
  await mkdir(lock).catch(() => { throw new Error('固定测试目录正在更新；请串行运行 agent:build') })
  const staging = `${target}.staging`
  const backup = `${target}.previous`
  try {
    let existing = false
    try {
      await readFile(join(target, marker))
      existing = true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      // 不覆盖用户手动放置、没有归属标记的目录。
      try {
        await readFile(join(target, 'manifest.json'))
        throw new Error('目标目录已有非脚本管理的插件，请先手动迁移')
      } catch (checkError) {
        if (checkError.code !== 'ENOENT') throw checkError
      }
    }
    await rm(staging, { recursive: true, force: true })
    await cp(source, staging, { recursive: true })
    // 静态全域名 host_permissions（http://*/*、https://*/*）已覆盖该 origin，此注入现为冗余，保留仅为在固定测试副本里显式记录 AI 域名并兼容既有测试。
    if (metadata.aiPermissionOrigin) {
      const copiedManifest = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8'))
      copiedManifest.host_permissions = [
        ...new Set([...(copiedManifest.host_permissions ?? []), `${metadata.aiPermissionOrigin}/*`]),
      ]
      await writeFile(join(staging, 'manifest.json'), JSON.stringify(copiedManifest, null, 2) + '\n')
    }
    await writeFile(join(staging, marker), JSON.stringify(metadata, null, 2) + '\n')
    await rm(backup, { recursive: true, force: true })
    if (existing) await rename(target, backup)
    try {
      await rename(staging, target)
    } catch (error) {
      if (existing) await rename(backup, target)
      throw error
    }
    await rm(backup, { recursive: true, force: true })
  } finally {
    await rm(staging, { recursive: true, force: true })
    await rm(lock, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = spawnSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'inherit' })
    if (result.error || result.status !== 0) throw new Error('构建失败，固定测试目录未更新')
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim()
    let config
    try {
      config = JSON.parse(await readFile(await resolveAgentConfigPath(projectRoot), 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('本地测试配置格式或路径错误')
    }
    let aiPermissionOrigin
    if (config?.ai) {
      const endpoint = new URL(config.ai.baseUrl || 'https://api.openai.com/v1')
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        throw new Error('AI 接口 URL 不合法')
      }
      aiPermissionOrigin = endpoint.origin
    }
    await syncBuild(join(projectRoot, 'extension/dist'), agentExtensionDir, {
      worktree: projectRoot, commit, builtAt: new Date().toISOString(),
      dirty: execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' }).length > 0,
      ...(aiPermissionOrigin ? { aiPermissionOrigin } : {}),
    })
    console.log(`固定测试目录已更新：${agentExtensionDir}`)
    console.log(`来源：${projectRoot}，提交：${commit.slice(0, 8)}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
