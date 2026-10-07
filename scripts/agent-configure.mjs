/** 在 ego 的真实扩展页面导入本地配置；凭据只经 stdin/内存传递，不输出到日志。 */
import { mkdir, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { agentExtensionDir, projectRoot } from './agent-build.mjs'
import { inspectAgentOutput } from './agent-output.mjs'
import { reloadUnpacked, uninstallExtension } from './agent-reload.mjs'
import { resolveAgentConfigPath } from './agent-config-path.mjs'

try {
  const args = process.argv.slice(2)
  const operation = args.length === 1 && args[0] === '--uninstall' ? 'uninstall' : 'configure'
  if (operation === 'configure' && args.length && (args.length !== 2 || args[0] !== '--config')) {
    throw new Error('用法：npm run agent:configure -- --config /绝对路径/agent-config.json.local；或 npm run agent:uninstall')
  }
  const spaceId = operation === 'configure' && process.env.FISHOPS_REGRESSION_SPACE_ID ? Number(process.env.FISHOPS_REGRESSION_SPACE_ID) : undefined
  if (spaceId !== undefined && (!Number.isSafeInteger(spaceId) || spaceId <= 0)) throw new Error('测试空间 ID 非法')
  const configPath = operation === 'uninstall' ? null : args.length ? resolve(args[1]) : await resolveAgentConfigPath(projectRoot)
  let config
  try { config = configPath ? JSON.parse(await readFile(configPath, 'utf8')) : {} } catch {
    throw new Error('本地配置无法读取或 JSON 格式错误；请检查文件，不要把密钥贴到日志中')
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('配置必须是 JSON 对象')
  if (config.reply && (config.reply.enabled !== false || config.reply.mode !== 'suggest')) {
    throw new Error('Agent 测试配置必须使用 enabled=false、mode=suggest，避免真实自动发送')
  }
  // 不回显子进程原始错误，防止运行时错误夹带 evaluate 的配置参数。
  const script = await readFile(join(projectRoot, 'scripts/agent-ego.mjs'), 'utf8')
  await mkdir(dirname(agentExtensionDir), { recursive: true })
  const result = spawnSync('ego-browser', ['nodejs'], {
    // ego 运行时不继承 CLI 环境变量，仅把非敏感文件路径写入脚本参数。
    input: `const agentInput = ${JSON.stringify({ operation, configPath, spaceId, target: agentExtensionDir, statePath: join(dirname(agentExtensionDir), 'agent-ego-state.json') })};\nconst reloadUnpacked = ${reloadUnpacked.toString()};\nconst uninstallExtension = ${uninstallExtension.toString()};\n${script}`,
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 60000,
  })
  // ego CLI 的脚本输出可能出现在 stderr；两路只提取本脚本明确标记的非敏感结果。
  const output = inspectAgentOutput(result.stdout, result.stderr, result.status)
  for (const line of output.lines) console.log(line)
  if (output.stopped) throw new Error('ego 已结束或交回测试空间，浏览器命令暂停；本次尚未完成，不能自动绕过停止信号')
  if (output.installRequired) {
    throw new Error('固定目录插件尚未加载；请先在 ego lite 的扩展管理页手动加载上方目录，然后重新运行 npm run agent:configure')
  }
  if (result.error || !output.completed) {
    throw new Error('ego 配置未完成；请检查浏览器是否运行及上方提示')
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
