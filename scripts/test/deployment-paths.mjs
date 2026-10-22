import { homedir } from 'node:os'
import { resolve, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

/** 冒烟读取显式部署目录；未指定时保留生产默认值，不从安装记录跳转到其他部署。 */
export function smokeDeploymentPaths(env = process.env, root = resolve(import.meta.dirname, '../..')) {
  return {
    home: env.FISHOPS_HOME ? resolve(env.FISHOPS_HOME) : join(homedir(), 'Library/Application Support/FishOps'),
    dist: env.FISHOPS_EXTENSION_DIST ? resolve(env.FISHOPS_EXTENSION_DIST) : join(root, 'apps/extension/dist'),
    hostEntry: env.FISHOPS_HOST_ENTRY ? resolve(env.FISHOPS_HOST_ENTRY) : join(root, 'apps/host/src/main.ts'),
  }
}

/** 严格比对运行中 SW 握手和最终磁盘产物；不将 buildId 当成内容哈希。 */
export async function verifyExtensionBuild(dist, runningBuildId, expectedHostName) {
  const build = JSON.parse(await readFile(join(dist, 'build.json'), 'utf8'))
  if (expectedHostName !== undefined && build.hostName !== expectedHostName) {
    throw new Error('扩展构建与 native 注册名不匹配')
  }
  if (typeof runningBuildId !== 'string' || !runningBuildId || build.buildId !== runningBuildId) {
    throw new Error('运行中扩展构建身份不匹配')
  }
  for (const file of ['background.js', 'page-main.js', 'chat-content.js', 'manifest.json']) {
    const hash = createHash('sha256').update(await readFile(join(dist, file))).digest('hex')
    if (build.sha256?.[file] !== hash) throw new Error('磁盘扩展产物校验失败')
  }
  return build.buildId
}
