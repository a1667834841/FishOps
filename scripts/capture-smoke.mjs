/**
 * 采集闭环 smoke 脚本（无真实网络）。
 *
 * 自注册 Node resolve 钩子后动态加载 TS 场景，运行：
 * create → progress → pause → resume → cancel、去重 / 过滤 / 入库、
 * 平台不可用的初始化错误、启动恢复不自动续跑。
 *
 * 用法：`node scripts/capture-smoke.mjs`（或 `npm run test:capture:smoke`）。
 */
import { registerHooks } from 'node:module'
import { resolve } from '../extension/src/capture/test/resolve-hook.mjs'

registerHooks({ resolve })

const { runCaptureSmoke } = await import('../extension/src/capture/test/smoke-scenario.ts')

runCaptureSmoke()
  .then((ok) => {
    process.exit(ok ? 0 : 1)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
