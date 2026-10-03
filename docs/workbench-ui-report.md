# Workbench 后台能力 UI 交付报告

本轮承接 FishOps Workbench 工作台的 P4/P5/P6/P7 后台能力 UI，覆盖数据采集、商品库、聊天中心、分析、设置五个页面。
所有数据均来自扩展后台的真实命令与事件，无假进度、无假商品、无假分析结果。

写入范围严格限定在 `extensions/FishOps-Workbench/workbench/**` 与本文档；
未改动 `extension/**`、`shared/**`、根 `package.json` 或旧 FishOps / PLAN 文档，未安装依赖、未建分支、未提交。

---

## 1. 变更文件

### 1.1 本轮直接修改

| 文件 | 变更 |
| --- | --- |
| `workbench/src/features/analysis/analysis-controller.ts` | 修复 `ANALYSIS_CREATE` 的 `queryParams` 类型：`DatasetFilter` 按字面量展开为 `DatasetFilter & Record<string, unknown>`，消除 TS2322。 |
| `workbench/src/features/reply/reply-controller.ts` | 修复规则整表校验：`rules.find((rule): boolean => !isReplyRule(rule))`，避免 `!isReplyRule` 被推断为类型守卫后把结果收窄成 `never`（TS2339）。 |
| `workbench/src/pages/SettingsPage.vue` | 接入 `CapabilityController`：新增「后台模块状态」卡片（点击「立即检查」才发只读命令，逐项展示命令来源与真实结果）；新增「AI 与飞书配置」卡片，明确「配置入口待接入」，不提供任何密钥输入。 |
| `workbench/package.json` | `test` 脚本由只跑 `chat/test` 扩展为 `src/features/*/test/*.test.ts`，纳入新增纯逻辑单测。 |

### 1.2 本轮新增测试

| 文件 | 覆盖 |
| --- | --- |
| `workbench/src/features/capture/test/capture-format.test.ts` | 采集表单校验、负载组装、任务展示推导（缺断点/统计返回 `null`，不臆造数字）、失败/暂停原因归类。 |
| `workbench/src/features/products/test/products-format.test.ts` | 可信 HTTPS 链接、itemId 兜底、分页回退、CSV 只导出传入行与防公式注入。 |
| `workbench/src/features/analysis/test/analysis-format.test.ts` | 过滤器校验、抽样上限、结果严格解析、失败文案、PromptRule 组装并拒绝疑似密钥。 |
| `workbench/src/features/reply/test/reply-form.test.ts` | 规则草稿校验（含 AI 提示词密钥拦截）、全局配置差异补丁、自动回复二次确认判定、建议/发送失败文案。 |

### 1.3 审查确认（本轮未改，已存在且正确）

`App.vue`、`AppSidebar/Topbar`、`CollectPage.vue`、`ProductsPage.vue`、`ChatCenterPage.vue`、`AnalyticsPage.vue`、
`components/chat/*`、`features/{capture,products,analysis,reply,chat,settings}/*`、`features/shared/*`、`composables/useBridgeController.ts` 等。
本轮逐文件核对了命令契约、竞态与释放保护、空/错/loading 状态与安全边界。

---

## 2. 每页真实命令

| 页面 | 命令（全部经 `BridgeApi.call`） | 事件订阅 |
| --- | --- | --- |
| 数据采集 | `CAPTURE_CREATE`、`CAPTURE_PAUSE`、`CAPTURE_RESUME`、`CAPTURE_CANCEL`、`TASK_LIST` | `TASK_CHANGED`、`WORKER_STARTED` |
| 商品库 | `PRODUCT_LIST`（keyword/order/limit/offset） | `TASK_CHANGED`、`WORKER_STARTED` |
| 聊天中心（P5 只读） | `CHAT_STATUS`、`CHAT_LIST_CONVERSATIONS`、`CHAT_GET_MESSAGES`、`CHAT_SYNC_CONVERSATIONS`、`CHAT_SYNC_HISTORY` | `CHAT_MESSAGE_INGESTED`、`CHAT_CONVERSATION_UPDATED`、`CHAT_SYNC_COMPLETED`、`CHAT_SOCKET_STATUS`、`CHAT_RULES_UPDATED`、`CHAT_AI_PAUSE_CHANGED`、`WORKER_STARTED` |
| 聊天中心（P6 安全区） | `CHAT_RULES_GET`、`CHAT_RULES_SET`、`CHAT_GET_REPLY_SUGGESTION`、`CHAT_APPLY_REPLY`、`CHAT_SEND_MESSAGE`（仅用户点击） | — |
| 分析 | `DATA_SOURCE_LIST`、`DATA_SOURCE_SCHEMA`、`DATA_SOURCE_QUERY`、`PROMPT_RULE_LIST`、`PROMPT_RULE_UPSERT`、`PROMPT_RULE_DELETE`、`ANALYSIS_CREATE`、`ANALYSIS_GET`、`ANALYSIS_CANCEL`、`ANALYSIS_RESULT_GET`、`TASK_LIST` | `TASK_CHANGED`、`WORKER_STARTED` |
| 设置 | `PING`、`PLATFORM_PING`、`CHAT_STATUS`、`CHAT_AUTO_REPLY_STATUS`、`TASK_LIST`、`PRODUCT_LIST`、`DATA_SOURCE_LIST`、`PROMPT_RULE_LIST`（均为只读，且仅点击「立即检查」时触发） | — |

---

## 3. 刻意禁用项（安全边界）

- **不自动发送、不自动回复**：工作台不调用任何自动回复 handler；自动模式仅通过 `CHAT_RULES_SET` 保存配置，且默认 `enabled=false`、`mode=suggest`；切到 `auto` 必须二次确认勾选后才保存。
- **发送需显式操作**：手动发送输入先「启用发送」解锁，切换会话重新锁定；`CHAT_SEND_MESSAGE` / `CHAT_APPLY_REPLY` 只在按钮点击时调用，带长度校验与 loading。
- **无轮询**：全仓 `workbench/src` 无 `setInterval`，进度只来自 `TASK_CHANGED` 事件与手动刷新。
- **非扩展环境不发命令**：`useBridgeController` 在非扩展内页令 `api=null` 且不创建 `RuntimeClient`，所有页面只展示「未连接扩展」空状态。
- **不泄露密钥**：不展示、不存储 API Key / token / AppSecret；全仓 `workbench/src` 无 `localStorage` / `sessionStorage` 写入；错误文案经 `redactSecrets` 脱敏；设置页 AI/飞书配置仅显示「配置入口待接入」。PromptRule 提交前用后台同一份 `validateNoSecrets` 拦截疑似密钥。
- **CSV 只导出当前已查询行**：不补页、不请求后台，且对 `= + - @` 前缀做公式注入转义。
- **概览页演示数据**：`overview.ts` 的指标/任务/活动均带「演示数据 / 示例」标签，并注明「数值仅用于预览布局」；发布页保持占位，不伪造发布队列。

---

## 4. 验证（真实执行）

在 `extensions/FishOps-Workbench` 下执行：

| 命令 | 结果 |
| --- | --- |
| `npm test --workspace @fishops/workbench` | **64 passed / 0 failed**（原 35 项 + 新增 29 项），约 0.9s |
| `npm run typecheck --workspace @fishops/workbench` | 通过，无错误 |
| `npm run build --workspace @fishops/workbench` | 成功，`104 modules transformed`，产物输出到 `extension/dist/`（构建产物，非源码改动） |

`extension/dist` 已可由主代理在 ego lite 中加载新扩展验证；本轮未操作浏览器。

---

## 5. 未完成项 / 后续

- **发布中心（P8）**：`PublishPage.vue` 仍为占位（流程说明 + 空队列），未接入发布命令（需后台 P8 契约）。
- **设置页占位**：账号授权、数据导出/清理、AI 与飞书密钥配置入口均标注为「待接入」，待后台提供安全专用命令后再实现。
- **聊天自动模式**：仅保存配置，未做端到端自动回复联调（按安全要求默认关闭）。
- 其余页面已按 A–E 需求完成；如需补充「发送输入框默认 disabled」的更强约束或对 controller 增加竞态集成测试，可在后续迭代追加。
