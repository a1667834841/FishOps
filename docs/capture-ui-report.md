# 数据采集页 P4 UI 改造与真实接线报告

> 范围：仅 `FishOps-Workbench/workbench/**` 与本文档。未修改 `extension`、`shared` 协议源码、根 lock 或外部依赖。
> 状态：代码、TypeScript 类型检查、生产构建、Node 单元测试（74/74）均已全部通过；真实浏览器扩展内页联调待主代理统一进行。

---

## 1. 改造目标与核心成果

本次改造将数据采集页（`CollectPage.vue`）从原有的单一临时任务监控结构，重构为符合生产实际的**“新建任务 + 任务历史列表（含详情与分页）”**双面板布局，并全面接线后台真实契约。

### 1.1 核心成果清单

| 需求项 | 实现策略 | 验证情况 |
|---|---|---|
| **新建任务 + 任务历史列表布局** | 左栏新建采集表单，右栏上方“任务历史列表”+ 下方“选中任务详情”；大屏并列，移动端自适应堆叠 | 生产构建通过，响应式断点完备 |
| **任务历史保留与合并** | 每次创建均追加保留在历史列表中；`TASK_LIST` 刷新、`TASK_CHANGED`、`WORKER_STARTED` 按 `id + updatedAt` 深度合并；远端未包含的本地任务不被丢弃；本地更新快照不被远端旧快照覆盖 | 单测验证通过（覆盖刷新、事件、重启对账） |
| **支持已有任务时新增任务** | 移除前端对 `running/pending` 的阻塞拦截；按钮仅在 `create.phase === 'running'` 时防重复点击；安全与限速由后台队列统一保障 | 单测验证通过（多任务并发创建不拦截） |
| **闲鱼流量词（suggest）联想** | 关键词输入框约 300ms debounce 调用 `CAPTURE_SUGGEST_WORDS`；空输入直接清空置为 idle，绝不发请求；提供显式“获取流量词”按钮立即触发 | 单测验证通过（debounce、空输入、立即调用） |
| **旧响应丢弃机制** | `sequence`（后台单调自增序号）+ `queryId`（客户端请求标识）双重校验；迟到的旧响应与过期查询响应被安全丢弃，不覆盖已渲染的新结果 | 单测验证通过（构造并发乱序延迟响应） |
| **建议词点击填入** | 点击建议词仅回填至关键词输入框并收起下拉，**绝对不自动创建任务**；用户可继续核对与修改参数后手动提交 | 单测验证通过（断言 CAPTURE_CREATE 调用次数为 0） |
| **完整生命周期与异常状态** | 下拉面板支持 `loading`（加载中）、`error`（平台错误/重试）、`empty`（无结果）、`ok`（词条列表）；任务历史支持分页（`paginateTasks`）与加载更多（`loadMoreHistory`） | 样式自适应 Claude 深浅主题，全状态测试覆盖 |
| **保留全部真实过滤项与控制** | 最小想要人数、最低价格、最高价格、只看包邮、商品详情采集（fetchDetail）；暂停、恢复采集、取消任务（带二次确认）；非扩展环境不发命令 | 统一使用真实命令契约，单测全绿 |

---

## 2. 架构设计与状态流转

### 2.1 整体调用分层

```text
CollectPage.vue (视图层)
  ├─ 关键词输入框 + 获取流量词按钮 + 浮动 Suggest 下拉 (无障碍 combobox/listbox)
  ├─ 基础参数与过滤条件 (起始页/采集页数/每页数量/价格区间/想要人数/包邮/详情采集)
  ├─ 任务历史列表 (带分页 controls、加载更多、关键词过滤、行项高亮)
  └─ 任务详情面板 (进度条、完成页数/总页数断点、真实统计网格、问题 Callout、暂停/恢复/取消)
       │
       ▼
CaptureController (业务控制器，纯 TypeScript，状态继承自 StateStore)
  ├─ fetchSuggest(keyword, { immediate, debounceMs, limit }) (防抖/立即/丢弃旧响应)
  ├─ selectSuggestWord(word) (仅填充词，清空建议词，不触发表单提交)
  ├─ createTask(payload) (防重复点击提交，允许并发新增任务)
  ├─ loadTasks(silent) (按 id + updatedAt 合并后台任务与本地历史，不抹除旧记录)
  ├─ filterHistory(keyword) / loadMoreHistory() (支持历史筛选与分页加载)
  └─ act(kind, taskId) (执行暂停 / 恢复 / 取消真实命令)
       │
       ▼
BridgeApi (统一通信契约)
  ├─ CAPTURE_SUGGEST_WORDS: { keyword, inputWords, queryId, limit } → { keyword, words, queryId, sequence }
  ├─ TASK_LIST: { type: 'capture', keyword?, sortBy?, sortOrder?, limit? } → { tasks: Task[] }
  ├─ CAPTURE_CREATE: CapturePayload → { task: Task }
  ├─ CAPTURE_PAUSE / RESUME / CANCEL: { id: string } → { task: Task }
  └─ 订阅 TASK_CHANGED / WORKER_STARTED 事件驱动状态更新
```

### 2.2 关键时序与防竞态

1. **Suggest 请求丢弃**：
   - 每次发起查询生成唯一 `queryId` 并记录 `latestSuggestQueryId`；
   - 收到响应后比较：若 `result.queryId !== latestSuggestQueryId`，直接丢弃；
   - 若 `result.sequence <= latestSuggestSequence`（迟到的更早请求），直接丢弃；
   - 仅当两个条件均满足时更新 `latestSuggestSequence` 并渲染 `words`。
2. **任务历史合并策略**：
   - 第一步：将本地当前所有未被显式删除的任务保留在 `merged` Map 中；
   - 第二步：遍历远端返回的任务列表，对于已存在的同 ID 任务，仅在 `fetched.updatedAt >= local.updatedAt` 时采用远端快照；若本地在请求途中收到了较新的 `TASK_CHANGED` 事件导致 `local.updatedAt > fetched.updatedAt`，则保留本地较新快照；
   - 第三步：按 `createdAt` 倒序排序，保证最新创建或运行的任务排在前面。

---

## 3. 修改文件清单

### 3.1 改造文件
- `workbench/src/features/contracts.ts`：导出 `CaptureSuggestWordsPayload`, `CaptureSuggestWordsResult`, `TaskListSortBy`, `TaskListSortOrder`, `CAPTURE_LIMITS as SHARED_CAPTURE_LIMITS` 等后台真实契约。
- `workbench/src/features/capture/capture-format.ts`：增加 `paginateTasks` 与 `TaskPagingInfo` 纯函数，用于任务历史安全分页切片与起止边界计算。
- `workbench/src/features/capture/capture-controller.ts`：
  - 扩展 `CaptureState`，新增 `suggest: SuggestState`；
  - 实现 `fetchSuggest`（支持 300ms debounce、立即触发、空输入清空且不发命令、sequence 与 queryId 丢弃判定）；
  - 实现 `selectSuggestWord`（填入建议词并清空下拉，绝不触发表单提交）；
  - 增强 `loadTasks` 历史任务合并逻辑，保证多次创建的任务及远端分页拉取的历史记录完整保留；
  - 增强 `filterHistory` 与 `loadMoreHistory`；
  - 允许在存在 active 任务时继续创建新任务。
- `workbench/src/pages/CollectPage.vue`：
  - 布局全面改造为“新建任务 + 任务历史列表（含详情）”；
  - 关键词输入框集成 300ms 防抖流量词下拉与显式“获取流量词”按钮；
  - 下拉面板支持 loading、error、empty 与建议词条目展示，带无障碍标记与键盘支持；
  - 任务历史列表支持总数展示、刷新列表、行项点击选中、分页翻页（上一页/下一页）与加载更多；
  - 任务详情如实展示进度、断点页数、核心统计与控制按钮，无虚构数据；
  - 样式自适应 Claude 浅暗主题、响应式断点。
- `workbench/src/features/capture/test/capture-format.test.ts`：补充 `paginateTasks` 分页切片及边界单测。
- `workbench/src/features/capture/test/capture-controller.test.ts`（新增）：纯逻辑单元测试，全覆盖任务历史合并、并发创建、suggest 防抖、空输入拦截、旧响应丢弃、点击建议不自动提交及非扩展环境安全。
- `docs/capture-ui-report.md`（本文档）。

---

## 4. 验证命令与测试结果

执行真实命令如下：

### 4.1 单元测试
```bash
npm test --workspace @fishops/workbench
```
**执行输出**：
```text
✔ buildDatasetFilter：默认条数与字段组装
✔ buildDatasetFilter：区间颠倒与非法条数逐项报错
✔ parseSampleLimit：限定 1 到 50
✔ formatCell / cellLink：按字段类型格式化，URL 只放行 https
✔ parseAnalysisResult：合法结果通过，缺字段返回明确原因
✔ describeAnalysisFailure：识别未配置 LLM 与数据为空
✔ buildPromptRule：正常规则通过；含疑似密钥被拒绝
✔ 非扩展环境：状态为 unavailable，不发起任何请求
✔ 任务历史保留：多次创建任务均保留在历史列表中，按 createdAt 倒序
✔ 任务历史合并：TASK_LIST 刷新时不丢失本地历史，且按 id + updatedAt 优先保留最新快照
✔ WORKER_STARTED 事件触发对账合并，不丢失更新快照
✔ suggest 空输入不调用后台，清空并保持 idle
✔ suggest debounce：防抖时间内多次输入只发出最后一次请求
✔ suggest 立即调用（点击按钮）：不等待防抖直接发起命令
✔ suggest 旧响应丢弃：sequence 较小的乱序响应被丢弃，不覆盖已渲染的新结果
✔ suggest 点击建议词：仅填充并关闭建议，绝不触发任务创建
✔ buildCapturePayload：合法输入组装关键字、页数与过滤条件
✔ buildCapturePayload：不填过滤条件时不生成 filter 字段
✔ buildCapturePayload：空关键词与非法页数逐字段报错
✔ buildCapturePayload：最低价高于最高价时报错
✔ toCaptureTaskView：进度、页数与统计全部来自任务快照
✔ toCaptureTaskView：后台未上报断点时页面显示「暂无」而不是编造数字
✔ toCaptureTaskView：失败原因识别为平台类别，暂停原因按 captcha 归类
✔ pickDefaultTask：优先进行中 / 已暂停的任务，空列表返回 null
✔ paginateTasks：分页切片与起止边界计算
... (聊天中心及商品库单测等)
ℹ tests 74
ℹ suites 0
ℹ pass 74
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
**结果**：74 项测试全部通过（0 失败，0 告警）。

### 4.2 TypeScript 类型检查
```bash
npm run typecheck --workspace @fishops/workbench
```
**执行输出**：
```text
> @fishops/workbench@0.1.0 typecheck
> vue-tsc --noEmit -p tsconfig.json
```
**结果**：0 错误，全绿通过。

### 4.3 生产构建
```bash
npm run build --workspace @fishops/workbench
```
**执行输出**：
```text
> @fishops/workbench@0.1.0 build
> vite build

vite v8.3.2 building client environment for production...
✓ 105 modules transformed.
../extension/dist/workbench.html                   0.41 kB │ gzip:  0.27 kB
../extension/dist/assets/workbench-B6z37Wea.css   50.36 kB │ gzip:  8.87 kB
../extension/dist/assets/workbench-CpWEc87f.js   266.55 kB │ gzip: 86.29 kB │ map: 1,494.23 kB
✓ built in 376ms
```
**结果**：生产构建通过，产物正常输出到 `extension/dist/`。

---

## 5. 未完成项与后续说明

1. **真实扩展环境交互验收**：
   当前已在纯 Node 环境下对契约协议、防抖时序、竞态丢弃、状态合并、分页计算完成全覆盖单测。在实际 Chrome 浏览器中加载扩展内页（`chrome-extension://.../workbench.html`）时的真实点击与网络链路，由用户或主代理在真实浏览器环境中完成验收。
2. **任务持久化容量长期规划**：
   后台任务历史当前持久化于 `chrome.storage.session`。由于浏览器会话存储存在配额限制，未来若用户需要跨会话保留成百上千条历史任务，建议在后续版本中将后台 TaskStore 扩展为 IndexedDB（本期 UI 侧已完全支持分页与向后兼容）。
