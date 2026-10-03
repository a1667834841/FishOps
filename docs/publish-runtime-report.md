# FishOps Workbench P8 发布中心后台与前端实现报告

> 日期：2026-10-03  
> 状态：P8 后台运行时与 Workbench 前端界面已完全就绪（测试全部绿灯通过）  
> 核心原则：**坚决不执行真实发布提交，严格保持人工确认边界（Human-in-the-Loop）**。

---

## 1. 架构总览与核心设计

本轮迭代根据 review 指示，进一步巩固了发布中心后台安全防线，并新增了 Workbench 发布前端界面：

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        FishOps Workbench (Vue 3)                       │
│                                                                        │
│   [PublishPage.vue]                                                    │
│    ├── 流程引导：选择商品 ➔ 规则计算 ➔ 表单填充 ➔ 人工确认发布       │
│    ├── 商品选择：PRODUCT_LIST 候选源、显式下拉选择、🎲 随机选择1条     │
│    ├── 实时预览：最终标题、售价、5倍划线原价、描述修饰、图片展示       │
│    ├── 开始填表：PUBLISH_CREATE + PUBLISH_FILL_FORM（后台静默执行）    │
│    └── 人工核对台：waiting_confirmation 停住，🔗打开官方页，手动标记完成 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Command / Event (P1 Bridge)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│             Extension MV3 Background (PublishRuntime)                  │
│                                                                        │
│   [PublishRuntime] 协调 TaskManager、PublishController、FormFiller    │
│    ├── 商品加载：严格从 ProductRepository 显式根据 itemId 读取真实商品 │
│    ├── 规则计算：倍率 multiplier、浮动 markup、5倍划线原价、HTTPS检查   │
│    ├── 静默标签：打开/复用 goofish.com/publish，active: false 优先     │
│    ├── 表单填充：DOMPublishFormFiller 注入页面上下文，等待上传就绪     │
│    ├── 安全停机：表单填完直接进入 waiting_confirmation，绝不提交发布   │
│    ├── Inflight 保护：图片下载或填充中途被取消/暂停时，绝不被完成覆盖 │
│    └── 重启恢复隔离：仅恢复 publish 任务为 paused，不影响 capture/analysis│
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 关键安全与技术细节核实

### 2.1 真实 DOM 执行器与 Service Worker 隔离
- **`chrome.scripting.executeScript` 序列化约束**：
  注入页面执行的 `func` 在序列化时会被转为字符串在目标标签页上下文运行，**不能引用任何闭包外部变量或模块**。
  在 `DOMPublishFormFiller` 中，所有入参均通过序列化安全的 `args`（`title`、`desc`、`price`、`originalPrice`、`imageUrls`）传入；函数内部所有辅助工具（如 `delay`）均自包含在函数体内。
- **Service Worker (SW) 零 DOM 访问**：
  MV3 SW 环境没有 `document`、`window`、`File` 或 `DataTransfer`。
  所有图片二进制文件生成、`new DataTransfer()` 构造与 `input.files` 设置均在被注入的闲鱼页面上下文内执行；SW 仅负责指挥与接收状态摘要。
- **等待页面就绪与上传完成**：
  注入函数内部**不再使用过短的固定延时**，而是通过轮询 `waitFor(...)` 等待标题/描述/售价/文件 input 等关键控件出现，以对抗闲鱼发布页的异步重渲染；图片设置进 `DataTransfer` 后等待页面组件渲染完成，并在**填充后重新读取每个字段的值与期望值比对（read-back 回读校验）**，只有全部通过才判定该字段填充成功。
- **注入脚本纯性与结构化错误**：所有注入函数集中在 `extension/src/publish/injected-scripts.ts`，函数体完全自包含（仅引用参数与页面全局 `document`/`window`/`fetch`/`File`/`DataTransfer` 等），只通过可序列化的 `args` 传参；对 `executeScript` 返回**空数组**、`result` 为 **undefined/null**、以及 **host 侧 reject** 均转为结构化 `SCRIPT_INJECTION_FAILED` 错误。
- **图片逐张处理与失败定位**：图片先校验**仅允许 HTTPS**，再逐张 `fetch` → `Blob` → `File` → `DataTransfer`，失败会记录**图片序号**（从 1 开始）写入 `imagesFailed`；只要存在任一张失败或未写入上传控件，`mainImageUploaded` 就为 `false`，绝不把未上传成功的图片标记成功。
- **严格进入 waiting_confirmation**：仅当**标题、描述、售价、划线原价、图片全部填充且回读校验通过**时，`PublishRuntime.fillForm` 才调用 `waitForConfirmation`；任何一项未通过都会置为 `failed`（`FORM_FIELD_CHANGED`），绝不假成功。

### 2.2 Inflight 取消与暂停保护
- 在 `PublishRuntime.fillForm` 流程中设置了多级中止检查点（图片下载前、下载后、标签页就绪后、表单填充后）；
- 若用户在填表过程中触发了 `PUBLISH_CANCEL` 或 `PUBLISH_PAUSE`，异步返回时识别任务已处于 `cancelled` 或 `paused`，**绝不覆盖为 completed 或 failed**。

### 2.3 任务恢复隔离（仅限 publish 类型）
- Service Worker 唤醒时的孤儿任务恢复逻辑严格收窄为：
  `tasks.list({ type: 'publish', status: 'running' })`；
  **仅对 publish 类型的任务挂起为 paused，绝不触碰和影响 capture / analysis 等共用存储的任务状态**。
- `waiting_confirmation` 状态任务在重启恢复后**保持原样**，绝不自动续跑，更不会默默点击发布。

### 2.4 去除 Background 模糊类型转换
- 定义了专属状态类型 `PublishTaskStatus = TaskStatus | 'waiting_confirmation'`；
- 封装了强类型转换函数 `toPublishTask`，移除粗暴的 `as any`，用明确结构维护 `payload`、`result` 和 `status`。

---

## 3. 商品字段真实性调研（关于 imageUrl 与 desc）

针对主代理提出的 **“Product 只有 imageUrl / description 是否真实”** 问题，经深入查阅旧扩展 `FishOps`（`main` 分支）与新模型定义：

1. **旧版 `FishOps` 实现现状**：
   - 旧版仅在商品详情页注入的 `item-download.js` 中保存下载记录时写入 `imageUrl`（取 `imageInfos[0].url`）和 `desc`（取 `itemData.description`）；
   - 但在搜索列表页采集时，闲鱼 MTOP 接口不返回详情大段长文本和全部详情图，仅返回标题、售价和封面图（`coverUrl`）。
2. **新版 `Product` 领域模型结构**：
   - `coverUrl` 为必填基础字段，详情补充字段为可选：`desc?: string`、`images?: string[]`。
   - 意味着：若用户从商品库选择的是仅跑过列表采集、未跑过详情采集的商品，确实可能出现 `desc` 为空或只有单张封面图的情况。
3. **P8 发布规则引擎的自适应兜底**：
   - **描述兜底**：`rawDesc = (product.desc || product.title || '').trim()`。若商品缺少详情描述，自动回退使用标题作为描述初始文本，绝不导致空报错；
   - **图片兜底**：`candidateUrls = [product.coverUrl, ...(product.images || [])]`。只要有 `coverUrl`，即可作为合法主图上传发布；
   - **缺字段校验**：若商品既无 `coverUrl` 又无 `images`，则明确抛出 `IMAGE_DOWNLOAD_FAILED` 结构化错误，阻止半吊子任务进行。

---

## 4. Workbench 发布前端界面 (`workbench/src/pages/PublishPage.vue`)

新增前端界面完整实现且符合设计规范（黄黑与 Neutral 工业质感、无任何外部无端依赖）：
1. **流程步骤视图**：
   清晰指示当前所处阶段：`选择商品` ➔ `规则计算` ➔ `表单填充` ➔ `人工确认发布`。
2. **商品选择与随机挑选**：
   - 显式下拉列表：从 `PRODUCT_LIST` 加载的商品库中挑选指定条目；
   - **“🎲 随机选择 1 条商品” 按钮**：一键随机抽取并加载预览。
3. **商品预览与规则微调卡片**：
   - 实时预览封面图、原标题、最终售价、5 倍划线原价展示；
   - 可视化微调售价倍数（`priceMultiplier`）、浮动加价（`priceMarkup`）、标题前后缀与描述前后缀。
4. **开始填表动作**：
   - 点击“🚀 开始自动填充发布表单”，后台按序发起 `PUBLISH_CREATE` 与 `PUBLISH_FILL_FORM`；
   - 执行中展示动态 Loading 与进度条。
5. **人工确认核对台（严格的人工安全防线）**：
   - 表单填充完成后停留在 `waiting_confirmation` 状态；
   - **“🔗 打开闲鱼官方发布页核对”**：点击在新标签页打开 `https://www.goofish.com/publish`，供操作员核验；
   - **“✅ 我已在页面手动发布完成”**：操作员在官方页面点击发布后，回到工作台标记 `confirmed`（调用 `PUBLISH_CONFIRM_STATUS`）；
   - **“❌ 放弃本次发布”**：记录人工放弃。
   - **坚决不提供任何自动化点击发布的按钮**。

---

## 5. 验证与测试结果汇总

所有相关单测、集成测试、安全检查与构建命令均在本地验证通过：

### 5.1 类型检查 (`npm run typecheck`)
- `@fishops/shared`：通过（0 errors）；
- `@fishops/extension`：publish 相关 **0 errors**（`src/chat/test` 存在一个与本次改动无关的既有未使用导入告警，未纳入本次修改范围）。
- `@fishops/workbench`：通过（0 errors）。

### 5.2 单元与业务测试
- **`npm run test:publish`（发布专用测试）**：
  - 执行 45 个测试用例，**45 通过，0 失败**；
  - 覆盖：
    - `PublishController` 规则计算、商品不存在拦截、mock 下载器、图片失败序号、非 HTTPS 拒绝、submit 显式禁用；
    - `DOMPublishFormFiller` 验证码/未登录/控件丢失结构化分类，`executeScript` 空数组 / undefined / host 异常结构化 `SCRIPT_INJECTION_FAILED`，字段与图片严格 `ok` 判定；
    - 注入脚本纯性（`node:vm` 隔离上下文序列化执行）、字段回读校验、图片顺序与失败序号、绝不点击发布按钮；
    - `PublishRuntime` 生命周期流转、active: false 优先、字段未全部通过即 `failed`、waiting_confirmation 停机、SW 重启隔离保护、Inflight 取消/暂停保护、无任何自动提交路径。
- **`npm test --workspace @fishops/workbench`（工作台测试）**：
  - 执行 78 个测试用例，**78 通过，0 失败**；
  - 包含 `PublishController` 的全部前端行为（商品加载、随机抽取、填表命令派发、人工状态标记）。

### 5.3 冒烟与安全测试
- **`npm run test:smoke`**：**21 通过，0 失败**（验证 Background 实例启动、重启恢复、消息隔离）。
- **`npm run test:security`**：**35 通过，0 失败**（验证权限收窄、命令来源策略与权限隔离）。

### 5.4 完整工程打包 (`npm run build`)
- `extension/dist/background.js`、`dist/content/*.js` 打包成功；
- `workbench/dist/workbench.html` 及静态资产打包成功。

---

## 6. 后续联动说明

当前未直接操作 `ego` 浏览器。后续若需执行**“随机商品填表并验证”**的端到端真实测试，可由浏览器自动化子代理加载当前打包出的插件（`extension/dist`），打开 Workbench 页面触发“随机选择 1 条商品并填充”，并在后台标签页核验闲鱼发布页表单是否已正确填入各字段且停在待发布状态。
