# 发布干净页 + 可复用诊断时间线（P8 增强）

> 目标：让「一次真实发布卡点」**可监控、可复用、可读**，并使用**干净发布页**避免脏状态污染。
> 范围：`shared/`、`extension/src/publish/`、`extension/src/background/` 及对应测试与文档；
> 不涉及 workbench UI、不 build、不提交、不回滚。

---

## 1. 干净发布页：每个新 fill task 专属 fresh tab

- `PublishRuntime.fillForm` 不再复用任何已存在的发布页；改为调用内部 `openFreshPublishTab`，
  对**当前任务**执行一次 `chrome.tabs.create({ url: publishUrl, active: false })`。
- 不复用其它任务 / 其它页面；**暂停后重试（`PUBLISH_RESUME` → `fillForm`）同样得到 fresh tab**。
- **绝不清除 / 关闭用户其它页面**（只新建，不删除）。
- 已在 `waiting_confirmation` 的任务再次 `PUBLISH_FILL_FORM` 依旧结构化拒绝（既有守卫不变），
  不会重填、不会破坏 submitToken / 人工确认状态。
- 干净发布页天然避免上一轮残留 toast / 表单状态污染本轮判定：注入侧只读取**当前可见**的官方提示
  （隐藏 / 已消失的旧 toast 不参与）。

> 历史（`docs/ego-real-publish-verify-round4.md`）曾定位到「`ensurePublishTab` 复用旧发布页继承脏状态」
> 为发布卡点根因之一。本改动正是对该根因的修复：填表路径改为 fresh tab。
> `ensurePublishTab` 作为历史通用工具保留，但**填表流程不再使用**。

---

## 2. 可复用诊断时间线（persist 在 `task.meta.diagnostics`）

### 2.1 安全结构

```ts
interface PublishDiagEntry {
  stage: PublishDiagStage      // 见下
  status: 'started' | 'ok' | 'failed' | 'unknown'
  startedAt: number            // epoch ms
  endedAt?: number
  latencyMs?: number
  code?: string                // 仅 ^[A-Z][A-Z0-9_]*$ 结构化枚举
  counters?: Record<string, number>   // 仅有限数值
  flags?: Record<string, boolean>     // 仅布尔
}

interface PublishDiagnostics {
  schema: 1
  timeline: PublishDiagEntry[]  // 最旧 → 最新
  dropped: number               // 超出上限被丢弃的旧条目数
  updatedAt: number
}
```

- **绝不写入** URL / query / token / cookie / 商品正文（标题 / 描述）/ 收货地址 / 图片原始链接等原文。
- `code` 经白名单（`^[A-Z][A-Z0-9_]{0,63}$`）过滤，URL / token / 中文原文一律被丢弃。
- 文本数组 `counters` / `flags` 均做类型与键数量过滤，避免被塞入任意长文。
- **长度有界**：上限 `PUBLISH_DIAG_TIMELINE_LIMIT = 64`，超出丢弃最旧记录并累加 `dropped`，
  反复重填 / 轮询也不会无限增长。

### 2.2 阶段（stage）

| stage | 含义 |
| --- | --- |
| `fresh_tab` | 为本次任务新建专属后台发布页标签（active:false） |
| `load` | 等待发布页加载完成 |
| `page_check` | 登录态 / 验证码等页面状态检查（fill 与 submit 各一次） |
| `fields` | 标题 / 描述 / 售价 / 原价 / 配送 / 所在地字段填充与回读 |
| `images` | 图片下载与上传回读（计数限定当前 upload 区） |
| `form_validation` | 表单整体校验与官方可见阻断 |
| `baseline` | 提交前官方「我的商品库」在售基线快照 |
| `submit_dispatch` | 最终发布按钮点击派发（仅用户显式确认链） |
| `official_verify` | 提交后官方在售商品数严格 +1 的轮询核验 |
| `result` | 本次任务最终结论（同一任务仅保留一条，位于末尾） |

### 2.3 注入脚本安全计时

- `injectFillPublishForm` 返回 `timings: { totalMs, fieldsMs, imagesMs, validationMs }`（仅数字）。
- `injectClickPublishSubmit` 返回 `timings: { totalMs }`。
- `DOMPublishFormFiller` 额外测量 `pageCheckMs`，汇总为 `FormFillResult.timings`；
  运行时据此还原 `page_check` / `fields` / `images` 阶段耗时（起止为按计时递推的近似值）。
- **诊断不依赖 console 日志**，全部落在 `task.meta.diagnostics`，可直接从任务详情读取。

### 2.4 记录时机与持久化

- **fill**：在既有 `updateProgress(15/40/65/85)` 与 `waitForConfirmation` 落点携带 `diagnostics`；
  失败前先 `updateProgress` 落盘诊断再 `tasks.fail`（failed 为终态后无法再写 meta）。
- **submit**：借既有 `pause → updateProgress → waitForConfirmation` 合法往返写入；
  派发点击的 dispatching 记录会带上（含 `submit_dispatch: started`），因此 SW 在点击后、
  结果落盘前重启也能看到「已请求派发、尚未确认」。
- 诊断写入为**尽力而为**：写入失败绝不阻断发布安全路径。

---

## 3. 读取：PUBLISH_GET 内 `diag`（无需新路由）

`PUBLISH_GET` 结果新增可选字段 `diag?: PublishDiagnostics`，直接取自 `task.meta.diagnostics`：

```ts
interface PublishGetResult {
  task: PublishTask
  diag?: PublishDiagnostics
}
```

UI 无需新增命令路由即可渲染时间线。所有类型（`PublishDiagnostics` / `PublishDiagEntry` /
`PublishDiagStage` / `PublishDiagStatus`）由 `@fishops/shared` 导出，供 workbench 直接引用。

---

## 4. 最终点击的安全不变式（未放宽）

- **先 baseline 成功才 click**：`baseline` 阶段失败（缺读取能力 / 无权限 / 未登录 / 网络失败）
  在派发点击前直接拒绝，绝不「先发后 unknown」。
- **dispatch 落盘锁不动**：点击前先持久化 `meta.submitAttempted = true` 与 `in_progress` 记录，
  保证 SW 重启后拒绝二次提交。
- **绝不第二 click / retry**：并发 `inFlightSubmits` + `submitAttempted` + 一次性令牌三重防线；
  unknown 结果保持锁定。
- **旧 toast 不污染**：fresh tab + 仅读取当前可见提示。
- **图片计数限定当前 upload 区且不放宽假成功**：注入侧回读确认数量必须与请求数量一致，
  任一张失败即不标记成功。
- **不自动改变分类 / location**：命中「分类不支持网页端发布」等官方阻断时只记录结构化 `code`
  （`PUBLISH_CATEGORY_UNSUPPORTED` / `FORM_VALIDATION_FAILED`），绝不切换分类、绝不自动选地区，
  也绝不把页面 toast 原文写进时间线。

---

## 5. 测试覆盖

- `extension/src/publish/test/diagnostics.test.ts`
  - 长度有界（`dropped` 累加）；`code` 白名单过滤 URL / token；`counters` / `flags` 类型过滤；
    meta 续接与非法输入兜底；snapshot 深拷贝隔离；`result` 去重。
- `extension/src/publish/test/publish-runtime.test.ts`（新增）
  - 每个新 fill task 专属 fresh tab，绝不复用预置页面且不清除用户其它页面；
  - fill 成功写入阶段齐全的时间线、脱敏（无标题 / 图片链接 / token）、`PUBLISH_GET` 返回 `diag`；
  - fill 失败保留失败阶段（`images failed` / `form_validation failed` / `result failed`）且脱敏；
  - submit 成功记录 `official_verify` 严格 +1 与 `result ok`；
  - submit 未知锁定、`result unknown`，重复提交不再点击且不把已锁定结论改写成 failed。
- `extension/src/publish/test/injected-scripts.test.ts`（新增）
  - 注入填充 / 提交返回安全 `timings`（仅数字，无页面原文）。

运行：

```bash
npm run test:publish --workspace @fishops/extension
npm run test:background --workspace @fishops/extension
npm run typecheck --workspace @fishops/shared
npm run typecheck --workspace @fishops/extension
```

---

## 6. 涉及文件

| 文件 | 变更 |
| --- | --- |
| `shared/types/publish.ts` | 新增诊断时间线类型与 `PublishTaskMeta.diagnostics` |
| `shared/events/commands.ts` | `PublishGetResult.diag` |
| `extension/src/publish/diagnostics.ts` | 新增：安全、有界的时间线记录器 |
| `extension/src/publish/injected-scripts.ts` | 注入填充 / 提交返回安全 `timings` |
| `extension/src/publish/form-filler.ts` | 汇总 `FormFillResult` / `FormSubmitResult` 计时 |
| `extension/src/background/publish-runtime.ts` | fresh tab、时间线记录与持久化、`PUBLISH_GET.diag` |
| `extension/src/publish/test/*` | 新增 / 扩展测试 |
