# 任务工作流

任务先读入口和阶段规范；恢复时核验证据。

| 阶段 | 状态 ID |
| --- | --- |
| [plan](workflow/plan.md) | `in-review` |
| [coding](workflow/coding.md) | `status-6` |
| [test](workflow/test.md) | `status-5` |
| [pr review](workflow/pr-review.md) | `status-7` |
| [done](workflow/done.md) | `completed` |

按顺序执行，每次进入阶段同步任务状态并读回：

```sh
orca worktree set --worktree path:<目录> --workspace-status <状态ID>
orca worktree show --worktree path:<目录>
```

状态配置改变时核对映射。同步失败报告；阻碍保留当前阶段。需求变化回 plan，修复回 coding 后重测。只有 PR 合并才算 done。
