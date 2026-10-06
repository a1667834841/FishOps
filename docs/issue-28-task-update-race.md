# Issue #28：单任务并发更新验收

## 问题与范围

取消和进度更新各自读取 running 快照，再整体保存任务。存储的索引队列只能保护 save 内部写入，不能保护 TaskManager 的读取、校验和更新。旧进度快照因此覆盖取消状态与原因。

本次仅修复 TaskManager 的并发契约。基线为 `origin/main` 的 `103381ce1b06ce0b63e3aab691a03ceb517f364a`，工作目录为 `/Users/wuwenjing/orca/workspaces/FishOps-Workbench/issue-28-task-update-race-20261007`，分支为 `fix/issue-28-task-update-race`。

## 实现与验收目标

- 同一底层存储区域、前缀和任务 ID 共用 Promise 队列，串行执行完整读取、状态校验、保存及通知。
- 创建、启动、暂停、恢复、重新排队、取消、完成、失败、等待确认、进度及删除使用同一队列。
- 启动恢复扫描只提供候选 ID；进入任务队列后重读当前状态，跳过已经取消、完成或删除的任务。
- 取消先发生 → 后续进度更新拒绝 → 保留 cancelled、取消原因和终态时间。
- 进度先发生 → 后续取消读取最新断点 → 取消状态和进度元数据同时保留。
- 暂停后更新进度仍符合原契约；终态及等待确认状态拒绝进度更新。
- 不同任务、区域和前缀独立排队；失败不阻断后续操作，空闲任务队列及时清理。
- 增加 `test:task` 并接入 `npm test`，让 CI 执行共享任务回归。

## 失败回归与最终结果

修复前首批 13 个新增回归中 12 个失败，1 个独立执行用例通过。失败覆盖取消后被旧进度恢复、多实例竞态、暂停原因丢失、终态覆盖、元数据丢失及恢复覆盖取消。修复后增加恢复/重新排队和写入失败边界，最终新增 16 个回归全部通过。

以下命令均在本 worktree 执行，最终退出码均为 0：

| 命令 | 结果 |
| --- | --- |
| `node --test shared/task/*.test.ts` | 26/26，通过原有 10 项及新增 16 项 |
| `npm test` | task 26、background 155、platform 116、chat 317、capture 92、analysis 115、publish 282、workbench 400、agent 7；合计执行 1510 项，不作为去重测试数 |
| `npm run typecheck` | shared、extension、workbench 全部通过 |
| `npm run build` | 扩展与工作台实际产物生成成功，输出至 `extension/dist/` |
| `npm run test:security` | 41 通过，0 失败 |
| `npm run test:smoke` | 21 通过，0 失败 |
| `git diff --check` | 通过 |

本地日志位于 `/tmp/issue-28-before.log`、`/tmp/issue-28-task.log`、`/tmp/issue-28-final-tests.log`、`/tmp/issue-28-types.log`、`/tmp/issue-28-build.log`、`/tmp/issue-28-security.log` 和 `/tmp/issue-28-smoke.log`。日志不提交。最终测试脚本修改后重新执行 `npm test`；业务源码未再变更，复用类型检查及构建结果。CI 结果以 GitHub 实际执行为准。

## 验证边界与交付

依据[测试阶段规范](workflow/test.md)的局部逻辑路径，本次使用真实 TaskManager、MemoryTaskStore 和 AdapterTaskStore 做确定性模块验证；Chrome StorageArea 使用 Mock，不能称为真实浏览器 E2E。

没有 DOM、页面、扩展入口或存储结构变更，没有执行 `agent:setup` 或真实浏览器部署，没有真实采集、发布、发送、飞书写入或 LLM 请求，无页面效果截图要求。真实 Chrome 用户操作时序未验证。

队列仅协调同一 JavaScript realm 内的 TaskManager 更新，不提供跨 worker/realm 的全局事务，也不协调调用方绕过 TaskManager 直接写 TaskStore 的操作。自定义存储包装器若共享底层数据，需提供相同的 `updateCoordinationKey`；内置 AdapterTaskStore 已按区域和前缀提供该身份。未改变状态机合法转移规则或存储格式。

PR 创建后停止，等待人工 Review，不自动合并。
