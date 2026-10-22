# P7 数据源与智能分析引擎（Analysis Engine）

本模块实现了 FishOps Workbench P7 阶段的完整后台能力，负责统一管理多维数据源（本地商品库、飞书多维表格）、提示词规则持久化、数据脱敏聚合与抽样、OpenAI 兼容 LLM 调用以及结构化分析输出校验，统一接入 TaskManager 任务状态机驱动。

**本阶段按指令只实现后台逻辑与通信协议接线，不触碰任何 Workbench 前端 UI。**

---

## 1. 架构总览

```text
Workbench (Vue 3 前端，本轮不改 UI)
    │
    │  Command / Event (P1 Bridge)
    ▼
Background Message Router (MV3 Service Worker)
    │
    ├── DATA_SOURCE_* ────► LocalDataSource (P4 ProductRepository)
    │                  └──► FeishuDataSource (Bitable API / 批量 / Token缓存)
    │
    ├── PROMPT_RULE_* ────► PromptRuleStore (Memory / chrome.storage.local)
    │                  └──► PromptRuleValidator (变量提取 / 密钥拦截)
    │
    └── ANALYSIS_* ───────► AnalysisService
                               │
                               ├── 1. 数据查询与安全截断 (<= 500 条, <= 1000 字符)
                               ├── 2. 数据聚合 (均价 / 中位数 / 想要数 / 城市与标签)
                               ├── 3. 分层抽样 (头部 + 中部)
                               ├── 4. 字段白名单与隐私脱敏 (手机号 / 微信号 / 身份证)
                               ├── 5. 渲染 Prompt 模板并调用 LLM (超时 / 取消中断)
                               └── 6. 结构化 JSON 校验 ──► TaskManager (completed / failed)
```

---

## 2. 核心模块与文件清单

### 共享协议与领域模型 (`shared/`)
- `shared/types/dataset.ts`：规范数据集结构（`DatasetSchema`, `DatasetFieldSchema`, `DatasetRow`, `Dataset`）、过滤条件（`DatasetFilter`）与安全截断上限常量。
- `shared/types/analysis.ts`：规范提示词规则（`PromptRule`）、模型传输配置（`AnalysisModelConfig`）、分析输入荷载（`AnalysisPayload`）与结构化输出（`AnalysisResult`, `AnalysisStructuredOutput`）。
- `shared/data-source/data-source.ts`：定义 `DataSource` 统一抽象接口（`getSchema()`, `query()`）。
- `shared/data-source/local-data-source.ts`：`LocalDataSource` 实现，封装 `ProductRepository`，支持关键词、价格、想要数、时间、包邮联合过滤及字符长度截断。
- `shared/data-source/feishu-types.ts` 与 `feishu-data-source.ts`：`FeishuDataSource` 实现，迁移旧飞书多维表格逻辑，包含租户 Token 自动刷新（提前 5 分钟）、分页拉取、组合键去重、批量自动切片（<= 500 条）与结构化错误分类。
- `shared/analysis/prompt-rule-validator.ts`：Prompt 模板变量合法性校验，严格审查并拒绝包含 API Key、Secret、密码等明文凭据的规则。
- `shared/analysis/prompt-rule-store.ts`：`PromptRuleStore` 接口及内存/Storage 适配器，预置「高需求低竞争机会挖掘」与「定价策略与竞争区间分析」默认规则。
- `shared/analysis/dataset-processor.ts`：送模前数据处理流水线（字段白名单白名单过滤、手机号/微信号脱敏、指标统计聚合、分层抽样）。
- `shared/events/commands.ts`：新增 10 个 P7 协议命令类型、入参负载与回程结果。
- `shared/events/codec.ts`：新增所有 P7 命令负载的严格运行时类型校验（`isDataSource*`, `isPromptRule*`, `isAnalysis*`）。

### Extension Background 运行时 (`extension/src/`)
- `extension/src/analysis/llm-transport.ts`：OpenAI 兼容协议客户端，支持超时控制、AbortSignal 取消中断、千问思考模型关闭（`enable_thinking: false`）与错误结构化分类。
- `extension/src/analysis/analysis-service.ts`：分析任务执行器，串联数据源、聚合脱敏、提示词渲染、LLM 传输与结构化 JSON 校验，支持中途主动取消任务中断请求。
- `extension/src/background/analysis-runtime.ts`：P7 Background 运行时，组装 TaskManager、数据源与规则仓储，响应 Workbench 命令并广播 `TASK_CHANGED` 任务变更事件。
- `extension/src/background/message-router.ts`：扩展路由分派，接入 `ANALYSIS_ROUTED_COMMANDS`。
- `extension/src/background/index.ts`：Service Worker 启动接线与恢复挂死任务。

---

## 3. P7 命令 API 列表

| 命令名称 | 作用 | 请求负载示例 | 响应结果示例 |
|---|---|---|---|
| `DATA_SOURCE_LIST` | 列出可用数据源 | `{}` | `{ dataSources: [{ type: "local", name: "本地商品库" }] }` |
| `DATA_SOURCE_SCHEMA` | 获取指定数据源字段结构 | `{ type: "local" }` | `{ schema: { name, fields: [...] } }` |
| `DATA_SOURCE_QUERY` | 按条件检索数据源生成 Dataset | `{ type: "local", filter: { keyword: "iPhone", minPrice: 2000 } }` | `{ dataset: { rows, total, schema, ... } }` |
| `PROMPT_RULE_LIST` | 列出所有分析规则 | `{}` | `{ rules: PromptRule[] }` |
| `PROMPT_RULE_UPSERT` | 保存或修改分析规则 | `{ rule: PromptRule }` | `{ rule: PromptRule }` |
| `PROMPT_RULE_DELETE` | 删除分析规则 | `{ id: "rule_id" }` | `{ success: true }` |
| `ANALYSIS_CREATE` | 创建并异步启动分析任务 | `{ ruleId: "rule_1", dataSourceType: "local", sampleLimit: 20 }` | `{ task: Task }` (status: 'pending') |
| `ANALYSIS_GET` | 查询分析任务状态与进度 | `{ id: "task_id" }` | `{ task: Task }` |
| `ANALYSIS_CANCEL` | 主动取消分析任务（中断调用） | `{ id: "task_id", reason: "用户取消" }` | `{ task: Task }` (status: 'cancelled') |
| `ANALYSIS_RESULT_GET`| 读取已完成分析的结构化输出 | `{ id: "task_id" }` | `{ result: AnalysisResult }` |

---

## 4. 安全防护与隐私保护策略

1. **凭据隔离**：AI API Key 与飞书 AppSecret 仅在 Background 配置与请求层访问，严禁保存在 PromptRule 中，严禁透传给 Workbench 或写入日志。
2. **送模字段白名单**：仅允许 `itemId`, `title`, `priceNumber`, `originalPriceNumber`, `wantCnt`, `sellerCity`, `freeShip`, `tags`, `publishTime` 等必要信息，彻底剔除卖家隐私、商品描述长文本、图片链接等冗余与敏感信息。
3. **文本脱敏**：商品标题、标签中的手机号脱敏为 `138****0000`，过滤掩码微信号与身份证号。
4. **防御超 Token 与 OOM**：单字段限制 1000 字符以内，查询最多返回 500 行，送模样本抽样限制在 20~50 行以内，先由程序聚合统计均价/中位数等摘要指标。
5. **LLM 结构化输出安全网**：严格解析并剥离 Markdown 代码块，校验 `summary`, `keyFindings`, `priceAnalysis`, `opportunities`, `risks` 等字段；若模型返回非 JSON 文本或缺少核心结构，任务明确标记为 `failed` 状态，绝不吞错假成功。
