/** 只返回可公开的脚本状态；ego 的停止信号优先于进程退出码和旧完成标记。 */
export function inspectAgentOutput(stdout = '', stderr = '', status = 0) {
  const output = `${stdout}\n${stderr}`
  const stopped = output.includes('user has taken control')
  const lines = output.split('\n').filter(line => line.startsWith('FISHOPS:'))
  const installRequired = lines.some(line => line.includes('INSTALL_REQUIRED'))
  return {
    lines: lines.map(line => line.slice(8)),
    stopped,
    installRequired,
    completed: status === 0 && !stopped && lines.some(line => line.startsWith('FISHOPS: SETUP_COMPLETED：')),
  }
}
