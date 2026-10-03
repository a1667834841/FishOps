# P4 后端改造：任务历史列表 + 闲鱼流量词（suggest）

> 范围：仅 extension / shared 的后台闭环（**不含 Workbench UI**）。
> 旧 `FishOps` 仓库只读，未修改。本文件记录对外契约、涉及文件、验证结果与风险。

## 1. 任务历史列表（`TASK_LIST`）

### 目标
采集任务每次创建都持久化 **Task 快照 + capture checkpoint / result / stats**；任务进入
completed / paused / failed / cancelled 等状态后仍可查询，不再只保留最近的内存任务。

### 持久化
- `TaskManager` 通过 `createDefaultTaskStore()` 选择存储：
  扩展环境使用 `AdapterTaskStore(ChromeStorageSessionAdapter)`（即 **chrome.storage.session**），
  非扩展环境（Node 单测）回退 `MemoryTaskStore`。
- 存储实现为可替换设计：`TaskManagerOptions.store` / `TaskStore` / `KeyValueStorageAdapter`
  均可注入，测试用 `MemoryStorageAdapter` 模拟 session。
- 每次状态流转（created / start / pause / resume / cancel / complete / fail / updateProgress）
  都会 `store.save`，因此终态任务与断点、统计、result 一并落盘。

### 命令契约
```ts
// shared/events/commands.ts
interface TaskListPayload {
  type?: TaskType          // capture | publish | analysis
  status?: TaskStatus      // pending | running | paused | completed | failed | cancelled
  keyword?: string         // 模糊匹配采集任务 payload.keyword（大小写不敏感）
  sortBy?: 'createdAt' | 'updatedAt'   // 默认 createdAt
  sortOrder?: 'asc' | 'desc'           // 默认 desc
  limit?: number           // 正整数；在排序后截断
}
interface TaskListResult { tasks: Task[] }
```
`isTaskListPayload` 对 `type / status / keyword / sortBy / sortOrder / limit` 做严格校验，
非法值回 `INVALID_PAYLOAD`。

### 长度约束（`CAPTURE_LIMITS`，见 `shared/types/capture.ts`）
任务载荷 / 结果 / 错误写入 `chrome.storage.session`，有容量上限，故在采集层统一裁剪：
- `captureKeywordMaxLength = 120`：`CAPTURE_CREATE` 关键词 trim + 截断（controller.create）；
- `taskErrorMaxLength = 500`：失败 / 需人工暂停的 error / pauseReason 截断；
- **核心统计（`CaptureStats`）与 result 数值永不裁剪。**

## 2. 流量词（`CAPTURE_SUGGEST_WORDS`）

### 命令契约
```ts
interface CaptureSuggestWordsPayload {
  keyword: string    // 已确定的关键词（显式命令下发，非逐键自动请求）
  queryId?: string   // 客户端查询标识，原样回显（超长按 suggestQueryIdMaxLength 截断）
  limit?: number     // 期望条数（受 suggestMaxWords 约束）
}
interface CaptureSuggestWordsResult {
  keyword: string    // 实际查询词（trim + 截断）
  words: string[]     // 去重、限长、限条数后
  queryId?: string
  sequence: number   // 后台单调递增序号（按请求到达顺序分配）
}
```

### 行为
- 经 P3 `platform.suggest`（MAIN world → mtop-client `suggest`）查询，**不搜索商品、不创建采集任务**。
- **空输入不调用平台**：`keyword.trim() === ''` 直接回 `INVALID_PAYLOAD`，平台零请求。
- **平台不可用** → 结构化 `PLATFORM_ERROR(category=host-unavailable)`。
- 平台错误按 `PlatformError.category` 归一为 `PLATFORM_ERROR`（含 captcha / unauthorized /
  token-expired / network / api …）；未知异常回 `INTERNAL`。
- 结果归一化 `normalizeSuggestWords`：丢弃非字符串 / 空白，**大小写不敏感去重**（保留首次出现），
  单条按 `suggestWordMaxLength = 80` 截断，总条数受 `min(limit, suggestMaxWords = 20)` 约束。

### queryId / sequence：UI 丢弃旧结果
`sequence` 在 `await` 之前**同步按请求到达顺序**分配。并发请求即使乱序返回，序号仍反映发起顺序：
UI 只需忽略序号小于“当前已渲染序号”或 queryId 与最新查询不匹配的响应，即可避免旧结果覆盖新结果。
后台**只接受显式命令**，不因键盘输入自动请求。

## 3. 涉及文件
| 文件 | 变更 |
|---|---|
| `shared/types/capture.ts` | 新增 suggest payload/result 类型；沿用 `CAPTURE_LIMITS` / `limitText` / `TaskListSort*` |
| `shared/events/commands.ts` | 扩展 `TaskListPayload`；`CAPTURE_SUGGEST_WORDS` 纳入负载 / 结果映射 |
| `shared/events/codec.ts` | `isTaskListPayload` 扩展；新增 `isCaptureSuggestWordsPayload` |
| `extension/src/capture/controller.ts` | `CapturePlatform.suggest`；`controller.suggest`；`normalizeSuggestWords`；关键词 / 错误长度限制 |
| `extension/src/background/capture-runtime.ts` | 接线 `CAPTURE_SUGGEST_WORDS`；`TASK_LIST` 排序 / 关键词过滤；sequence |
| `extension/src/background/message-router.ts` | `CAPTURE_ROUTED_COMMANDS` 增加新命令 |
| `extension/src/background/index.ts` | `capturePlatform.suggest` 适配 P3 |
| `extension/src/capture/test/*` | MockPlatform.suggest；`task-history.test.ts`；`suggest.test.ts`；smoke 扩展 |

## 4. 验证（真实执行结果）
- `npm run typecheck`：shared / extension / workbench 全绿（**修复了改造前遗留的
  `createCommand` 泛型索引错误与未使用导入**）。
- `npm run test:capture`：**42 / 42 通过**（含新增 4 个历史用例、8 个 suggest 用例）。
- `npm run test:capture:smoke`：**23 / 23 通过**。
- `npm run build:extension` + `npm run test:security`：**35 / 35 通过**。
- 全程使用 mock / 内存存储，无真实网络。

## 5. 风险与后续
- **chrome.storage.session 容量**：session 存储有配额，任务历史无上限累积可能触顶。当前以
  字段级截断缓解；如需长期保留，建议后续改为 IndexedDB 或加重建 / 清理策略（超出本任务范围）。
- **排序精度**：`createdAt` 为毫秒；同毫秒内多任务依赖稳定排序，顺序可能不确定（测试已用
  间隔规避）。UI 展示可接受。
- **`status` 仍为单值过滤**：`TaskFilter` 支持数组，但命令负载暂只暴露单值；如需多状态，
  后续可扩展为数组（向后兼容）。
- **suggest 限速**：当前 suggest 不复用采集限速器（每次显式命令一次）。若 UI 触发频繁，建议
  在 UI 侧做防抖（本任务明确不在后台因键盘自动请求）。
