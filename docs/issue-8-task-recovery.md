# Issue #8：按任务类型隔离启动恢复

## 需求与根因

Issue：https://github.com/a1667834841/FishOps/issues/8

采集和分析默认使用同一 `chrome.storage.session` 及 `fishops` 前缀。原 `TaskManager.recoverOnStartup()` 只按 `running` 查询，两个运行时分别应用 `paused` 和 `failed` 策略，导致无关模块改写其他类型任务。初始化顺序不能解决此问题。

验收场景：模块初始化 → 仅所属类型的遗留运行中任务恢复 → 采集挂起并保留进度和断点、分析中止 → 其他类型和非运行中任务保持完整快照，不自动采集、不调用 LLM。

## 最小实现

- `shared/task/task-manager.ts` 新增 `StartupRecoveryOptions`，用可选 `type` 限定存储查询；不传类型保留既有全类型恢复接口行为。
- `extension/src/background/capture-runtime.ts` 显式传 `capture`，保留挂起原因、断点和 pending 调度行为。
- `extension/src/background/analysis-runtime.ts` 显式传 `analysis`，保留中止原因。
- 不改变任务状态机、存储结构、初始化顺序或已有数据，不包含 #6 的任务索引修复。

## 开发阶段回归

`extension/src/background/__tests__/task-recovery.test.ts` 使用真实 TaskManager、默认 Chrome Session adapter 和两个真实运行时，仅替换 Chrome 存储边界及采集平台。任务数据为合成数据，不是浏览器 E2E。

修复前执行 6 个用例：5 失败、1 兼容用例通过。实际观察到采集先初始化把分析置为 paused、分析先初始化把采集置为 failed，并行初始化亦失败，类型过滤被忽略而恢复了 3 类任务。修复后再增加采集单独初始化的完整分析快照保护断言，最终 7 个用例通过。

覆盖双向完整快照隔离、两种串行顺序、并行初始化、采集断点及进度、分析中止原因、publish 和非运行中任务保护、再次 init、空匹配、事件仅通知命中任务以及旧接口兼容性。

## 最终检查

工作目录：`/Users/wuwenjing/orca/workspaces/FishOps-Workbench/auto-issue-run-10-20261006T1340`

最终业务代码与测试版本的检查均退出 0：

| 命令 | 结果 |
| --- | --- |
| `npm test` | background 146、platform 116、chat 306、capture 92、analysis 115、publish 274、workbench 387、agent 7；合计执行 1443 项，非去重测试数 |
| `node --test shared/task/task.test.ts` | 7/7 通过；根 npm test 未包含此入口，因此单独执行 |
| `npm run typecheck` | 三个 workspace 通过 |
| `npm run agent:setup` | 内含完整 npm run build，扩展和工作台构建通过；退出 0 且含 SETUP_COMPLETED |
| `git diff --check` | 通过 |

日志保存在本机 `/tmp/fishops-8-test.log`、`/tmp/fishops-8-typecheck.log`、`/tmp/fishops-8-setup.log`；失败回归为 `/tmp/fishops-8-red.log`。CI 尚未执行，不用本地检查代替 CI 结果。

## 真实部署与验收边界

- 真实入口：`chrome-extension://lnkgjbkfdimiloglccfmeefcclfgifbo/workbench.html`，固定目录 `/Users/wuwenjing/.fishops/agent-extension`。
- 部署前从真实命令入口读取 `TASK_LIST` 成功，结果为空，运行中任务为 0。
- 在当前 worktree 执行 `npm run agent:setup`；来源为 main 基线 `17f9b52a` 加本次未提交实现，脚本确认插件重载、配置状态与权限状态，包含 `SETUP_COMPLETED`。后续仅补文档，未更改业务代码。
- 同一浏览器空间 302 被部署脚本结束并交回用户。后续观察返回 `ownership: 'user'`、`Error: page label not found: p1`，立即停止；未重新接管、重试或创建其他空间绕过。
- **真实重启后的采集断点与分析中止状态尚未验收**：没有现成运行中任务，部署后空间也已交回用户。未注入任务、未改写用户存储制造场景，未调用真实 LLM、采集、发布、发送或飞书写入。
- 本次不涉及页面视觉或交互修改，不附 Mock 效果图。

本 PR 保持 Draft，等待人工补充真实运行中任务的重启验收及 Review，不自动合并或关闭 Issue。
