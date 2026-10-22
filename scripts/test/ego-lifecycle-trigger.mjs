#!/usr/bin/env node
/**
 * 显式授权后的 Ego Lite 关闭/重开触发器。
 *
 * 安全边界：
 * - 只有 FISHOPS_EGO_LIFECYCLE=1 才操作应用；这是门禁之外的第二道显式开关。
 * - 只匹配 Ego Lite 主进程，不关闭 Google Chrome 或其他浏览器。
 * - 不读取 token、cookie 或业务数据；FISHOPS_LIFECYCLE_HOME/PORT 仅用于确认调用来源。
 * - 先 TERM，等待主进程退出；超时失败退出，不升级 SIGKILL，避免强杀造成假恢复。
 *
 * 该脚本只负责关闭和重新打开应用；在线→离线→恢复及历史/账号校验由生命周期观察器完成。
 */
import { execFileSync } from 'node:child_process'
import { access } from 'node:fs/promises'

const APP_PATH = '/Applications/ego lite.app'
const MAIN_PATTERN = '/Applications/ego lite.app/Contents/MacOS/ego lite'
const WAIT_MS = 20_000

if (process.platform !== 'darwin') {
  console.error('Ego 生命周期触发器仅支持当前 macOS 验收环境。')
  process.exit(2)
}
if (process.env.FISHOPS_EGO_LIFECYCLE !== '1') {
  console.error('需要显式设置 FISHOPS_EGO_LIFECYCLE=1；未关闭或打开浏览器。')
  process.exit(2)
}
if (!process.env.FISHOPS_LIFECYCLE_HOME || !process.env.FISHOPS_LIFECYCLE_PORT) {
  console.error('缺少生命周期隔离上下文；未操作浏览器。')
  process.exit(2)
}

try {
  await access(APP_PATH)
} catch {
  console.error('未找到 Ego Lite 应用；未操作浏览器。')
  process.exit(2)
}

let output
try {
  output = execFileSync('pgrep', ['-f', MAIN_PATTERN], { encoding: 'utf8' })
} catch {
  console.error('未找到 Ego Lite 主进程；未操作浏览器。')
  process.exit(2)
}
const pids = output
  .split(/\s+/)
  .filter(Boolean)
  .map(Number)
  .filter(pid => Number.isSafeInteger(pid) && pid > 1)
if (pids.length !== 1) {
  console.error(`Ego Lite 主进程候选数量异常：${pids.length}；未操作浏览器。`)
  process.exit(2)
}

const pid = pids[0]
const alive = () => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
try {
  process.kill(pid, 'SIGTERM')
} catch {
  console.error('发送关闭请求失败；未重新打开浏览器。')
  process.exit(1)
}

const deadline = Date.now() + WAIT_MS
while (alive() && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 250))
}
if (alive()) {
  console.error('Ego Lite 未在等待窗口内退出；未强杀、未重新打开。')
  process.exit(1)
}

try {
  execFileSync('open', ['-a', APP_PATH], { stdio: 'ignore' })
} catch {
  console.error('重新打开 Ego Lite 失败。')
  process.exit(1)
}
console.log('Ego Lite 已关闭并重新打开。')
