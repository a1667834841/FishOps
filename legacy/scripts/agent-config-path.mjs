import { readFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** 当前 worktree 未配置时，复用主工作区的本地文件路径，不复制凭据。 */
export async function resolveAgentConfigPath(root) {
  const local = join(root, 'agent-config.json.local')
  try { await readFile(local); return local } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' })
  const main = list.split('\n').find(line => line.startsWith('worktree '))
  if (!main) throw new Error('无法确定主工作区配置路径')
  return join(main.slice(9), 'agent-config.json.local')
}
