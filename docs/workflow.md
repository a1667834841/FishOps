# 任务工作流

实施默认交付 PR；先读阶段规范，恢复核验证据。

| 阶段 | 状态 ID |
| --- | --- |
| [plan](workflow/plan.md) | `in-review` |
| [coding](workflow/coding.md) | `status-6` |
| [test](workflow/test.md) | `status-5` |
| [pr review](workflow/pr-review.md) | `status-7` |
| [done](workflow/done.md) | `completed` |

同步状态并读回：

```sh
orca worktree set --worktree path:<目录> --workspace-status <状态ID>
orca worktree show --worktree path:<目录>
```

核对映射，报告同步失败。实现阻碍保留阶段；验收阻碍按 test 交付 Draft PR。需求变化回 plan，修复回 coding 重测。PR 合并才算 done。
