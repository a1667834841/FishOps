# 采集优化（后端）

> 范围：`shared/**`、`extension/src/capture/**`、`extension/src/background/capture-runtime.ts`、
> 采集搜索专用间隔所需的平台调用链，以及对应测试 / 文档（**不含 Workbench UI**）。
> 本文件记录对外契约、涉及文件、验证结果与风险。

## 1. 采集入参新增 `intervalJitterMs`

```ts
interface CapturePayload {
  keyword: string
  startPage?: number
  pages?: number
  rowsPerPage?: number
  // 搜索请求基础间隔（毫秒），默认 500。
  minIntervalMs?: number
  // 搜索请求随机增量上限（毫秒），默认 500；实际增量 ∈ [0, intervalJitterMs]。
  intervalJitterMs?: number
  filter?: CaptureFilter
  fetchDetail?: boolean
}
```

- 默认值：`DEFAULT_CAPTURE_INTERVAL_MS = 500`、`DEFAULT_CAPTURE_JITTER_MS = 500`。
- `isCaptureCreatePayload` 对 `minIntervalMs` / `intervalJitterMs` 做**非负有限数**校验，非法回 `INVALID_PAYLOAD`。
- 控制器 `resolveCaptureBaseIntervalMs` / `resolveCaptureJitterMs` 对越界值兜底回默认。

## 2. 搜索专用节流（取消固定 1500ms）

- **控制器侧**（`capture/pacer.ts`）：搜索按「基础间隔 + 均匀随机增量」节流，首页立即；
  每次在**处理结束后完整等待** `base + [0, jitter]`，**不扣除上一页处理耗时**。
- **真实平台链路**：采集搜索在底层传入**专用 `0` 间隔 / `0` 抖动**
  （`SearchParams.minIntervalMs=0/intervalJitterMs=0` → `runtime-host` → `mtop-client`）：
  底层为该请求建立「0 间隔」专用限速器，**绕开全局固定 1500ms**，
  且**不叠加任何随机等待 / 跨任务首请求等待**。采集节奏完全由控制器 pacer 统一负责（恰好等待一次）。
- **详情等非搜索请求**、以及**非采集搜索**（未携带专用间隔）沿用全局 1500ms（`MIN_CAPTURE_INTERVAL_MS`）。
- 随机源可注入（`random`），测试用固定随机源获得确定性；真实链路测试验证 platform 层不再二次 sleep。

## 3. 统一采集队列与「出队才 running」

- 控制器维护单一队列，**同一时间只执行一个任务**（`pump` / `execute`）。
- `start`（pending）/ `resume`（paused → **pending** 重新排队，保留首次 `startedAt`）**入队后立即返回**，
  只等待持久化；真正出队执行时才转为 `running`。
  - 为此扩展任务状态机：新增 `paused → pending` 合法迁移与 `TaskManager.requeue`。
- 暂停 / 取消 / 完成 / 失败后自动调度下一项。
- `requeuePending()`：SW 重启后按 `createdAt` **升序**重新入队 pending 任务；running 任务仍按既有策略转 paused。

## 4. 竞态、等待可中止与轮次隔离

- 每个 await（搜索、详情、账号读取、**入库**）之后都重新确认任务仍 `running`（`keepGoing`），
  否则丢弃本页结果、不推进断点；搜索失败分支在改写状态前也先确认，**绝不把 cancelled 改成 paused**。
- **失败统计及时持久化**：搜索 / 详情请求失败后立即 `flushFailures` 并写入断点，
  保证 `failed` / `paused` 任务的 `task.meta.capture.stats` 也能看到 `pageFailed` / `detailFailed` 计数。
- **等待可中止**：节流 / 详情限速等待期间暂停 / 取消会立即结束等待以释放执行槽，
  但**在途真实请求不被抢占**，请求仍严格串行（不并发 inflight）。
- 每轮 run 持有独立运行态 + 单调递增轮次号（`runs` / `generations`），旧轮次绝不覆盖新轮次 / 终态。

## 5. 详情图片与封面

- `normalizeDetailPatch` 的 `images` **全量规范化去重保序**（协议相对地址规整、去重、保留首次出现顺序）。
- 合并到商品用 `mergeProductImages`：已有在前、追加去重；**共享 upsert 合并（`mergeProductForUpsert`）
  同样保护已有图片集合**，不完整的新采集不会覆盖已有完整集合（内存 / IndexedDB 共用该实现）。
- 封面：列表**无封面**时用详情首图回填（避免有图无封面）；**已有封面绝不被详情覆盖**。
- 详情失败独立计数 `detailFailed`，并计入 `failed`；单条失败不致命、不影响列表商品入库。

## 6. 跨轮次统计与 result / meta

- `CaptureCheckpoint.storedIds`：持久化已成功入库的 itemId，恢复续采时重建去重集合，
  **避免已入库条目重复计数 `stored`**；兼容缺少该字段的旧断点（按空集合处理）。
- `CaptureStats` 新增 `pageFailed` / `detailFailed`（跨轮次累加）、`stored`；`failed = pageFailed + detailFailed`。
- `CaptureResult` 提供 `stored`（成功入库有效去重数量）、`detailFailed`、`startedAt` / `endedAt`。
- `Task.startedAt` 在任务真正进入 running（出队执行）时写入，重新排队不清除。

## 7. 涉及文件

| 文件 | 变更 |
|---|---|
| `shared/types/capture.ts` | `intervalJitterMs`；默认间隔常量；`storedIds`；`stored/detailFailed/pageFailed`；result 时间戳 |
| `shared/events/codec.ts` | `intervalJitterMs` 非负有限数校验 |
| `shared/capture/normalizer.ts` | 详情图片去重保序；`mergeProductImages` |
| `shared/capture/product-repository.ts` | upsert 合并保护已有图片集合（内存 / IndexedDB 共用） |
| `shared/task/task-machine.ts` | 新增 `paused → pending` 合法迁移 |
| `shared/task/task-manager.ts` | 新增 `requeue`（paused → pending，保留 startedAt） |
| `extension/src/capture/pacer.ts` | 处理结束后完整等待（不扣处理耗时） |
| `extension/src/capture/controller.ts` | 队列 / 出队才 running / 可中止等待 / 轮次与 await 后守卫 / 跨轮次去重与统计 / 搜索间隔透传 |
| `extension/src/platform/rate-limit.ts` | 限速器支持随机增量（默认行为不变） |
| `extension/src/platform/protocol.ts` | `SearchParams` 增加搜索专用间隔字段 |
| `extension/src/platform/runtime-host.ts` | SEARCH 透传专用间隔（限速覆盖） |
| `extension/src/platform/xianyu/mtop-client.ts` | 按配置缓存的搜索专用限速器 |
| `extension/src/background/capture-runtime.ts` | 透传 `intervalJitterMs` / `random`；重启后 `requeuePending` |
| `extension/src/background/index.ts` | `capturePlatform.search` 透传专用间隔 |
| `extension/src/capture/test/*`、`extension/src/platform/__tests__/*` | 专项 / 平台接线用例 |

## 8. 验证（真实执行结果）

- `npm run typecheck`：shared / extension / workbench **全绿**。
- `npm run test:capture`：**83 / 83 通过**。
- `npm run test:capture:smoke`：**25 / 25 通过**。
- 平台测试 `node --import ./src/platform/__tests__/register.mjs --test src/platform/__tests__/*.test.ts`：**114 / 114 通过**
  （含「采集搜索 0/0 不产生 sleep」与「controller + 真实链路端到端仅等待一次」）。
- `npm run test:analysis`：**95 / 95 通过**；`npm run test:publish`：**270 / 270 通过**。

## 9. 风险与后续

- **搜索与详情限速相互独立**：详情首条不再紧随搜索等待 1500ms；如需「搜索→详情」也强制间隔，
  可在控制器记录统一最近请求时间。
- **`generations` / `storedIds` 增长**：均随任务生命周期增长；任务量极大时可考虑清理 / 上限策略。
- **队列语义**：pending 任务在等待队列中保持 pending，出队执行才转 running，`startedAt` 反映真实执行起点。
