# 通用固定间隔调度（Issue #41 首期）

本期只交付**通用调度层**：计划定义、执行记录、代码注册的业务执行器、固定间隔唤醒。
不含采集 / 自有商品历史快照，也不含快照保留与清理规则。执行器注册表当前为空，因此
`SCHEDULE_SAVE` 在本期一定会因「执行器未注册」失败；这是预期限制，不是缺陷。

## 数据与真源

- 真源为 `chrome.storage.local` 的键 `fishops.scheduler.v1`，值为 `SchedulerState`
  （`shared/types/scheduler.ts`）：`{ version: 1, schedules, runs }`。
- 计划与执行记录作为**同一整包原子提交**：只有写入成功后才推进下次执行时间并启动业务，
  不会出现「时间已推进但执行记录丢失」或「存储失败却记为成功」。
- 存储内容非法（`version` 不符、字段类型错误、计划 ID 重复、执行状态非法）时**拒绝加载并报错**，
  不静默清空；需要先备份并修复数据。

## 入口

- background 顶层调用 `startSchedulerAlarm(chrome.alarms, scheduler)`
  （`extension/src/background/scheduler-runtime.ts`）：**同步**注册 `onAlarm` 监听（保证 MV3 被
  alarm 唤醒时不丢事件），再异步确保存在周期 1 分钟的 alarm（名称 `fishops.scheduler.tick`）并做一次启动恢复。
- `extension/public/manifest.json` 增加 `alarms` 权限。
- 命令只接受扩展内页来源，类型登记在 `shared/events/commands.ts`：

  | 命令 | 负载 | 结果 |
  | --- | --- | --- |
  | `SCHEDULE_LIST` | `{}` | `Schedule[]` |
  | `SCHEDULE_SAVE` | `ScheduleInput` | `Schedule` |
  | `SCHEDULE_SET_ENABLED` | `{ id, enabled }` | `Schedule` |
  | `SCHEDULE_RUN_LIST` | `{ scheduleId }` | `ScheduleRun[]`（按触发时间倒序） |
  | `SCHEDULE_EXECUTOR_LIST` | `{}` | 已注册执行器类型 `string[]` |

## 执行策略

- **固定间隔**：整数分钟，范围 1～525600。保存、启用或修改计划时从当前时刻重新计时
  （`nextRunAt = now + interval`），不补跑旧计划。
- **每分钟唤醒**：到期且未在运行的计划生成一条 `running` 记录；提交成功后才执行。
- **错过跳过**：唤醒时已超过 1 分钟容差的时点记一条 `skipped`（`reason: 'missed'`），
  `missedCount` 为本次合并跳过的时点数，随后按间隔推进。
- **禁止重叠**：同一计划上一条仍为 `running` 时不并发，记 `skipped`（`reason: 'overlap'`）。
  不同计划互不影响，可并行执行。
- **停机恢复**：启动恢复读取时，所有 `running` 记录标记为 `interrupted`
  （`reason: 'worker-restarted'`），已过期时点标记为 `skipped`；不按历史记录重放业务副作用。
- **业务失败**：执行记录标记 `failed`（`reason: 'executor-failed'`），业务异常内容不写入记录。

## 接入业务执行器

```ts
const executors = {
  capture: {
    validate: (config) => isCaptureConfig(config),
    // run.id 可作业务幂等键；resolve 表示业务已结束，而非仅加入队列。
    execute: async (config, run) => { await runCaptureOnce(config, run.id) },
  },
}
```

1. 实现 `ScheduleExecutor`：`validate(config): boolean` 校验业务配置，`execute(config, run)` 在业务真正结束时 resolve。
2. 把执行器登记到 `extension/src/background/index.ts` 的 `executors` 注册表（**仅代码可注册**，
   客户端不能传入函数或任意命令）。
3. 计划的 `taskType` 必须与注册表键一致，否则保存被拒。
4. `config` 必须是可 JSON 序列化数据（拒绝函数、`undefined`、`symbol`、`bigint`、非有限数），
   序列化后不得超过 64 KiB。

## 错误与安全

- 负载形状或字段错误返回 `INVALID_PAYLOAD`；计划无效、执行器未注册、存储失败返回 `INTERNAL`（固定文案）。
- 错误响应不回传业务配置、执行器异常内容或凭据。
- alarm 触发失败与初始化失败只记录 `[FishOps:Scheduler]` 日志，不产生未处理拒绝，也不影响后台其他能力。
- `alarm` 不作为配置真源：浏览器重启后仍从 `chrome.storage.local` 恢复计划与执行记录。

## 当前限制

- 执行器注册表为空，`SCHEDULE_SAVE` 因「执行器未注册」失败；`SCHEDULE_EXECUTOR_LIST` 返回 `[]`。
- 无 Workbench 页面入口（本期不加 UI）。
- 不含采集 / 自有商品历史快照与保留、清理规则；执行记录无容量上限与清理策略。

## 测试

- `extension/src/background/__tests__/scheduler.test.ts`：保存与重复唤醒、重启恢复、错过跳过、
  容差边界、重叠、多计划独立执行、执行记录排序、无效输入、存储格式非法、持久化失败不冒充成功。
- `extension/src/background/__tests__/scheduler-runtime.test.ts`：命令适配与错误码、启动注册、
  alarm 重建、alarms API 失败与无未处理拒绝。
- `scripts/smoke.mjs`、`scripts/service-worker-startup.mjs`、`scripts/review-security.test.mjs`：
  真实入口来源校验、alarm 注册与启动期无未处理拒绝。
- 真实 Chrome 部署与调度入口读数：[Issue #41 真实验收证据](issue-41-scheduler-verification.md)。
