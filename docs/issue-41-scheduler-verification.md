# Issue #41 通用固定间隔调度：真实验收证据

## 基本信息

| 项目 | 值 |
| --- | --- |
| Issue | #41 `[Feature] 任务调度：增加通用定时机制与本地商品快照存储`（首期仅通用固定间隔调度） |
| worktree | `/Users/wuwenjing/orca/workspaces/FishOps-Workbench/issue-41` |
| 分支 | `a1667834841/issue-41` |
| Commit | `677f87408db3a51786464165ea56952153794a3c` |
| 代码状态 | dirty（未提交改动；本轮未新增代码改动，验证第一轮实现） |
| 验收时间 | 2026-10-07T13:23Z ~ 13:28Z |
| 浏览器空间 | 328（agent-owned，串行复用；验收结束时由回归脚本 `task.finish({ keep: [] })` 关闭） |

## 部署来源与资源版本

- 命令：`FISHOPS_REGRESSION_SPACE_ID=328 npm run agent:setup`，退出码 `0`，输出含 `SETUP_COMPLETED：插件已重载，配置与权限状态已验证。`
- 部署日志：`/tmp/fishops-41-setup.log`
- 固定目录 `~/.fishops/agent-extension/.fishops-agent-build.json`：
  `worktree=/Users/wuwenjing/orca/workspaces/FishOps-Workbench/issue-41`，`commit=677f87408db3a51786464165ea56952153794a3c`，`dirty=true`，`builtAt=2026-10-07T13:23:23.656Z`
- 部署前固定目录属于另一 worktree（`feature`，commit `6288eaa5`，16:31），已确认无冲突：无 `agent-extension.regression.lock`、无 `regression.mjs` / `ego-browser` / `agent:setup` 活动进程、无运行中浏览器回归。
- 真实 Chrome 中已加载实例：扩展 ID `lnkgjbkfdimiloglccfmeefcclfgifbo`，`state=ENABLED`，`version=0.1.0`，
  `chrome.runtime.getManifest().permissions = ["storage","scripting","tabs","cookies","alarms"]`。

## 检查命令与结果

| 命令 | 退出码 | 结果 | 日志 |
| --- | --- | --- | --- |
| `FISHOPS_REGRESSION_SPACE_ID=328 npm run agent:setup` | 0 | 部署成功，`SETUP_COMPLETED` | `/tmp/fishops-41-setup.log` |
| `FISHOPS_REGRESSION_SPACE_ID=328 npm run regression:full` | 0 | 全层通过（本地 7 步 + 真实 E2E 13 用例） | `/tmp/fishops-41-regression-full.log` |

`regression:full` 分步（报告 `.regression/2026-10-07T13-26-49-206Z-41702/report.json`，`ok=true`）：

- 本地：`test`、`typecheck`、`build`、`test:security`、`test:smoke`、`test:capture:smoke`、`test:sw-startup` 全部 passed。
- 真实 E2E：`preflight` 报告「真实回归空间：328；当前无运行中任务」，`agent:setup` 报告 `SETUP_COMPLETED`；
  用例 `bridge`、`tasks`、`chat-cache`、`publish-history`、`page-overview`、`page-collect`、`page-chat`、`page-products`、
  `page-publish`、`page-analytics`、`page-settings`、`connection-ai`、`connection-feishu` 全部 passed。

## 调度真实 Chrome 入口验证

在部署后的固定目录实例上，用扩展内页 `chrome-extension://lnkgjbkfdimiloglccfmeefcclfgifbo/workbench.html` 真实调用（只读，未写入或篡改 `chrome.storage.local`）：

| 观测项 | 真实读数 | 结论 |
| --- | --- | --- |
| `chrome.runtime.sendMessage SCHEDULE_LIST {}` | `ok=true`，`result=[]` | 扩展内页只读入口可用，初始无计划 |
| `chrome.runtime.sendMessage SCHEDULE_EXECUTOR_LIST {}` | `ok=true`，`result=[]` | 本期无业务执行器（已确认边界） |
| `SCHEDULE_LIST` 带额外字段 | `ok=false`，`code=INVALID_PAYLOAD` | 负载校验在真实 Chrome 生效 |
| `chrome.alarms.getAll()` | `[{ name: 'fishops.scheduler.tick', periodInMinutes: 1 }]` | 唤醒器名称与 1 分钟周期真实存在 |
| `chrome.alarms.get('fishops.scheduler.tick')` | `periodInMinutes=1`，`persistAcrossSessions=true`，`scheduledTime=1791379524488.597` | 周期 alarm 已由 MV3 后台创建 |
| `chrome.runtime.getContexts({ contextTypes: ['BACKGROUND'] })` | `["BACKGROUND"]` | MV3 后台 Service Worker context 存在 |
| `PING.workerStartedAt`（第一次） | `1791379404487`（now `1791379476902`） | SW 实例 A |
| 释放保活（导航离开扩展页）后等待约 100 s | — | SW 空闲终止窗口 |
| `PING.workerStartedAt`（第二次） | `1791379584562`（now `1791379597050`） | SW 实例变化（+180 s），后台被回收后由 alarm 唤醒重启 |
| `chrome.alarms.get(...).scheduledTime`（第二次） | `1791379644488.597`（较首次 +120000 ms） | 周期 alarm 期间真实触发了 2 次 |

结论：通用调度的**真实入口可验证部分已通过** —— 唤醒器名称、1 分钟周期、MV3 后台启动/被回收后由 alarm 唤醒重启、
以及扩展内页只读调度命令。采用的观测面等效于真实自动化入口，未使用 fixture 或存储注入。

## 尚未覆盖（明确记录，不视为通过）

1. **真实的一次计划执行**：本期执行器注册表为空，`SCHEDULE_SAVE` 因「执行器未注册」失败，`tick` 无计划可跑，
   因此无法在真实环境观测「到点产生一次 `running`/执行记录」。未通过新增执行器或篡改 `chrome.storage.local`
   伪造业务 E2E。该路径仅由 `extension/src/background/__tests__/scheduler.test.ts` 与 `scheduler-runtime.test.ts` 单测覆盖。
2. **真实 `chrome.alarms` 触发时 tick 的可观测副作用**：无计划时 `tick` 为 no-op，链路上无可见记录。
   已用 alarm `scheduledTime` 推进与 SW `workerStartedAt` 变化间接证明唤醒发生。
3. **Workbench 调度 UI**：本期不提供页面入口，无 UI 验收项（E2E 页面基线不包含调度）。

## 副作用

- 固定目录 `~/.fishops/agent-extension` 被覆盖为本 worktree 构建（原为 `feature` worktree 构建）。
- `agent:setup` 导入本地 AI / 飞书配置（`AI=true，飞书=true，AI 域名权限=true`），未回显凭据。
- E2E 的 `connection-ai`、`connection-feishu` 各发起一次真实只读探测（AI 一次固定提示词请求；飞书只读结构探测）。
- 未发送真实消息、未删除数据、未操作生产账号；未创建或提交发布任务。
- 浏览器空间 328 已由 `task.finish({ keep: [] })` 关闭（`~/.ego-browser/state/space-328.json` 已移除）。
  注意：`~/.fishops/agent-ego-state.json` 仍为 `{"spaceId":328,"finished":false}`；该文件由部署脚本写入、
  未随 `task.finish()` 回写，属既有部署脚本行为，本轮未手工修改。

## 证据路径

- 部署日志：`/tmp/fishops-41-setup.log`
- 完整回归日志：`/tmp/fishops-41-regression-full.log`
- 回归报告：`.regression/2026-10-07T13-26-49-206Z-41702/report.json`
- 本地层单测/静态检查日志：`.regression/2026-10-07T13-26-49-206Z-41702/*.log`
- 功能说明与执行器接入：[调度文档](scheduler.md)
