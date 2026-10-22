import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type HostConfig = { port: number; token: string; home: string; database: string }
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<HostConfig> {
  const home = env.FISHOPS_HOME || join(homedir(), 'Library', 'Application Support', 'FishOps')
  await mkdir(home, { recursive: true, mode: 0o700 }); await chmod(home, 0o700)
  const path = join(home, 'config.json')
  let config: { port: number; token: string }
  try { config = JSON.parse(await readFile(path, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('配置文件无效')
    config = { port: 18790, token: crypto.randomUUID() + crypto.randomUUID() }
    await writeFile(path, JSON.stringify(config), { mode: 0o600, flag: 'wx' })
  }
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535 || typeof config.token !== 'string' || config.token.length < 32) throw new Error('配置文件无效')
  await chmod(path, 0o600)
  return { ...config, home, database: join(home, 'fishops.db') }
}
