# Issue #35：采集任务类型隔离验证

## 任务与版本

- Issue：[采集控制命令未校验任务类型](https://github.com/a1667834841/FishOps/issues/35)。
- 认领：[本轮认领留言](https://github.com/a1667834841/FishOps/issues/35#issuecomment-6028590763)。筛选及提交前均确认没有其他认领留言、负责人或重复 PR。
- Worktree：`/Users/wuwenjing/orca/workspaces/FishOps-Workbench/auto-issue-pr-run-22-20261007T0100`，复用 Orca 创建的独立工作区。
- 分支：`fix/issue-35-capture-task-type`。
- 基线：最新 `origin/main`，`2aa4b99a2cc37b3fdbf0f97e5fc6bd2b223f0bc8`。
- 实现 Commit：`4080318008f6744e1b6f01b4e5e5c55e0e52b47a`；后续证据提交仅新增本文档，交付提交见 PR 的 Commits。
- 实际运行环境：macOS，Node `v26.8.1`，npm `11.19.0`。
- 执行终端：`term_2284f940-3661-4e0f-b47a-f50a49619040`。通过当前 worktree 的唯一终端、任务标题及输出核对身份，`terminal switch` 返回 `navigated: true`。本轮未关闭终端或清除会话。

## 根因、范围与实施

`requireTask` 只检查任务存在，没有验证 `type`。采集控制器与分析模块共用任务存储，错误 ID 可进入状态操作；`resume` 还会把分析任务重新入队，采集执行覆盖其结果。

本次按 B 类局部逻辑处理：调用契约明确，校验可在真实控制器和运行时的隔离单测中完成。不改页面、初始化流程、共享协议、持久化结构或正常任务流转。它不是存储迁移或新增真实写入能力。现行测试规范为 `docs/workflow/test.md` 和 `docs/regression-testing.md`；用户提及的旧文件 `docs/development-testing.md` 在本基线不存在。

修复在公共控制入口拒绝非 capture 任务，协议返回 `INVALID_PAYLOAD` 和明确类型错误。入队校验传入任务，出队重新读取并复验类型。保留正常采集队列的串行调度。

## 验收动作与结果

| 动作 | 状态与可见结果 | 副作用 |
| --- | --- | --- |
| 分析任务处于 pending / running / paused，调用三种采集控制命令，各重复两次 | 每次返回类型错误；全任务快照（结果、进度、元数据及时间戳）保持一致 | 无任务变更事件，无搜索、详情、商品入库或同步 |
| 对 analysis / publish 任务直接调用 start / resume / pause / cancel | 三种状态均拒绝，重复调用仍拒绝，快照保持不变 | 无状态改写、采集调用或同步 |
| 第一项采集阻塞，将第二项排队任务替换为合成分析快照，再放行 | 出队时跳过分析快照，第三项正常采集完成 | 分析快照及原结果不变；搜索仅执行第一、第三项 |
| 正常采集创建、暂停、恢复、取消、重启恢复、串行队列与在途竞态 | 已有定向回归全部通过 | 保持既有状态流转与清理行为 |

以上使用真实 TaskManager、CaptureController、createCaptureRuntime、内存存储及仓库 MockPlatform。同步回调记录调用，未访问真实平台或飞书，不将这些结果描述为浏览器 E2E。局部逻辑按 B 类不要求浏览器专项验收。

## 检查记录

所有命令均在上述 worktree 执行。实现验证时 HEAD 为基线且工作区有源码及测试修改，交付源码与被验证内容一致。完整日志保留在本地忽略目录。

| 检查与命令 | 退出码 | 结论 | 本地记录 |
| --- | --- | --- | --- |
| `npm ci` | 0 | 安装成功 | `.regression/issue-35/npm-ci.log` |
| 原实现运行新增回归，测试名过滤 `跨类型\|出队前\|采集控制命令拒绝` | 1 | 修正夹具后仍复现类型隔离失败；队列覆盖合成分析结果 | `.regression/issue-35/before-corrected.log` |
| `node --import ./extension/src/capture/test/register.mjs --test extension/src/capture/test/controller.test.ts extension/src/capture/test/capture-runtime.test.ts` | 0 | 84 条通过，0 失败 | `.regression/issue-35/targeted-corrected.log` |
| `npm run regression` | 0 | 全部本地交付检查通过 | `.regression/2026-10-07T01-02-40-280Z-71923/report.json` |
| `git diff --check` | 0 | 无空白错误 | 本轮终端记录 |

`npm run regression` 内各项均退出 0：

| 检查 | 退出码 | 结论 | 本地完整日志 |
| --- | --- | --- | --- |
| `test` | 0 | 通过 | `.regression/2026-10-07T01-02-40-280Z-71923/test.log` |
| `typecheck` | 0 | 通过 | `.regression/2026-10-07T01-02-40-280Z-71923/typecheck.log` |
| `build` | 0 | 通过 | `.regression/2026-10-07T01-02-40-280Z-71923/build.log` |
| `test:security` | 0 | 通过 | `.regression/2026-10-07T01-02-40-280Z-71923/test-security.log` |
| `test:smoke` | 0 | 通过 | `.regression/2026-10-07T01-02-40-280Z-71923/test-smoke.log` |
| `test:capture:smoke` | 0 | 通过 | `.regression/2026-10-07T01-02-40-280Z-71923/test-capture-smoke.log` |
| `test:sw-startup` | 0 | 通过 | `.regression/2026-10-07T01-02-40-280Z-71923/test-sw-startup.log` |

首次测试夹具错误地对 pending 任务调用 updateProgress，该方法只允许 running / paused。调整夹具后，在原实现重新运行失败回归，再恢复修复实现运行定向测试并通过。未做无方案调整的重复重试。首次日志保留为 `before.log` 与 `targeted.log`，最终判断以修正后的记录为准。未发生网络重试或 Git 冲突。

自查覆盖控制器入口、协议错误映射、队列调度及测试隔离；没有无关重构、密钥或本地配置进入提交。CI 状态以 PR 检查为准，本报告只证明本地通过。

总结结论：Issue #35 的跨类型控制与错误采集调度已修复，必要本地验收通过；提交 PR 后等待人工 Review，不自动 Merge。
