# AI 询价 Agent 后台与执行能力现状调研

> 本文只记录事实与待确认决策。不包含已决定的实施方案。不改业务代码，不运行外部询价，不暴露任何密钥。
> 调研对象：`FishOps-Workbench`（后台/执行链路）与老项目 `FishOps`（仅作对照）。前端另有代理，本文不深入前端。

## 0. 调研范围与方法

- 目标流程：用户描述商品要求 → AI 关键词拆解 → 批量搜索 → 凑够符合硬性要求的 10 个商品才进入询价 → 批量询价 → 持续监控默认 30 分钟、最多 60 分钟 → 全部完成或截止后总结；会话本地保存；新增后台模块需独立简洁包。
- 方法：只读源代码与既有文档，按能力逐条定位到文件与行号。
- 状态口径：
  - **已实现**：有生产接线，且被实际调用。
  - **仅接口/占位**：定义了函数或类型，但生产路径未接线，或返回固定 `UNSUPPORTED`。
  - **缺失**：未找到对应实现。

### 0.1 实测状态（重要）

- 本次调研**未运行任何实测**：未构建、未加载扩展、未打开闲鱼页面、未调用任何真实接口。
- 本次调研**未触发真实询价**：未搜索商品、未建立会话、未发送任何消息。
- 文中的「已实现」指代码路径已接线，不代表端到端跑通。凡是关于运行时行为的描述，若未标注实测，均为源码推断。
- 涉及 Service Worker 生命周期的数值（例如「30 秒」）来自代码注释（`shared/task/task-machine.ts:171`），**不是本次实测结果**。

## 1. 结论摘要

| 目标环节 / 能力 | 状态 | 结论 |
|---|---|---|
| 商品搜索查询（关键词） | 已实现 | 单关键词、多页搜索。支持关键词、页号、每页条数、过滤串。 |
| 详情采集 | 已实现 | 按 `itemId` 拉详情，可选开关，串行、限速。 |
| 详情规格筛选 | 缺失 | 无按规格/参数筛选商品的能力；详情仅补齐图片/描述/城市等。 |
| AI 关键词拆解 | 缺失 | 无「把用户描述拆成搜索关键词」的 AI 调用或提示词。 |
| 批量搜索编排（多关键词） | 缺失 | 采集任务只接受单个 `keyword`；无多关键词拆分与合并编排。 |
| 「凑够 10 个符合硬性要求」判定 | 缺失 | 无数量阈值停止逻辑；过滤只作用于单页商品，命中即入库。 |
| 批量询价消息发送 | 部分实现 | 有单条、单会话的显式发送能力；无批量、多卖家、询价模板编排。 |
| 回复监控 | 部分实现 | 只读实时监控已接线；「实时消息→自动回复」逻辑已实现但未接线。 |
| AI 调用 | 已实现 | OpenAI 兼容单次补全（chat 回复 + 数据分析）。 |
| AI 工具循环 / function calling | 缺失 | 无 tool_calls / 多轮工具循环 / agent loop。 |
| 任务调度、超时、取消 | 部分实现 | 有状态机 + 取消/暂停/恢复 + LLM 超时取消；无任务级时间预算/截止时间。 |
| 30/60 分钟监控窗口 | 缺失 | 无按时间窗口持续监控的调度；MV3 SW 生命周期也不支持长驻。 |
| 全部完成/截止后总结 | 缺失 | 无询价结果汇总；仅有针对数据集的 LLM 分析总结。 |
| 会话本地保存 | 部分实现 | 聊天/任务多为 `chrome.storage.session`（浏览器关闭清空）；商品库落 IndexedDB。 |
| 人工查看 | 已实现（扩展内） | 命令 + Workbench 页面。无对外 HTTP API。 |
| 新搜索商品主动建聊 | 缺失 | 见 §3.10：发送要求已有 `sessionId`；无 `商品→sellerId→新 sessionId` 封装。 |
| 前端询价相关 UI | 缺失 | 见 §3.11：仅有聊天中心（会话/消息/手动发送/建议）与规则面板；无询价界面。 |

## 2. 子项目与规则确认

- 仓库根 `extensions/`，含两个子项目：`FishOps`（旧版，无 `AGENTS.md`）与 `FishOps-Workbench`（新版，有 `AGENTS.md`）。
- `FishOps-Workbench` 现状远超其 `README.md` 宣称的「P1 骨架」：已含采集、聊天、发送、AI、分析、飞书、发布等模块。
- 架构：`workbench/`（Vue 3 + Vite）↔ `extension/`（MV3）通过 Command/Event 协议通信；协议类型与校验在 `shared/`。
- 扩展权限（`extension/public/manifest.json:6-15`）：`storage`、`scripting`、`tabs`、`cookies`；host 权限含 `goofish.com`、`h5api.m.goofish.com`、`open.feishu.cn`。

## 3. 逐能力事实记录

### 3.1 商品搜索查询

**状态：已实现（单关键词、多页）。**

- MTOP 搜索配置与接口（`extension/src/platform/xianyu/mtop-client.ts:33-56`）：
  - 搜索 `mtop.taobao.idlemtopsearch.pc.search`。
  - 详情 `mtop.taobao.idle.pc.detail`。
  - 搜索建议 `mtop.taobao.idlemtopsearch.pc.search.suggest`。
  - 我的在售 `mtop.idle.web.xyh.item.list`。
- 搜索请求体（`mtop-client.ts:168-184`）：字段 `pageNumber`、`keyword`、`rowsPerPage`（默认 30）、`propValueStr.searchFilter`（默认 `'publishDays:14;'`）、`searchReqFromPage`（默认 `'pcSearch'`）。
- 搜索方法（`mtop-client.ts:289-300`）：`client.search(params)`，支持采集专用限速参数。
- 搜索结果归一（`shared/capture/normalizer.ts:220-230`）：读取 `data.resultList`；单条归一在 `normalizer.ts:158-214`，缺失 `itemId` 直接丢弃。
- 采集任务创建命令 `CAPTURE_CREATE`（`shared/events/commands.ts:105`，负载类型 `shared/events/commands.ts:449`），负载校验 `shared/events/codec.ts:389-402`：`keyword`（必填，非空）、`startPage`、`pages`、`rowsPerPage`、`minIntervalMs`、`intervalJitterMs`、`fetchDetail`、`filter`。
- 采集执行循环（`extension/src/capture/controller.ts:525-586`）：单 `keyword`、从 `nextPage` 到 `endPage` 逐页搜索。
- 节流（`extension/src/capture/pacer.ts:37-66`）：首页立即，其后等待「基础间隔 + 随机增量」，降低风控识别。
- 运行时入口（`extension/src/background/capture-runtime.ts:181-199`）：`CAPTURE_CREATE` 后台异步执行，进度经 `TASK_CHANGED` 推送。

**限制与风险**

- 只接受单个 `keyword`；无多关键词拆分、无跨关键词去重合并（`codec.ts:389-402`、`controller.ts:525`）。
- 无「命中 N 个即停止」逻辑；循环按页码跑完 `pages` 才结束（`controller.ts:525`、`controller.ts:674-723`）。
- 平台可用性依赖已登录的 goofish 页面；不可用时返回结构化 `PLATFORM_ERROR`（`capture-runtime.ts:330-340`、`controller.ts:477-483`）。

### 3.2 详情采集与规格筛选

**状态：详情采集已实现；规格筛选缺失。**

- 详情方法（`mtop-client.ts:301-305`）`fetchItemDetail(itemId)`。
- 详情归一（`shared/capture/normalizer.ts:236-276`）：仅补齐 `browseCnt`、`collectCnt`、`wantCnt`、`category`、`desc`、`sellerCity`、`sellerId`、`sellerNick`、`uniqueName`、`images`。
- 详情采集为可选开关（`capture/controller.ts:588-608`），串行、独立 1500ms 限速（`controller.ts:501-505`）。
- 采集过滤条件（`shared/capture/filter.ts:14-29`）：`minWantCnt`、`minPrice`、`maxPrice`、`onlyFreeShip`。0 表示不限制。

**限制与风险**

- 没有「规格/参数」维度：归一化不解析规格项，也没有按规格筛选的入口。
- 过滤只在单页内逐条判断（`controller.ts:572-586`），不构成「硬性要求全集」的判定。

### 3.3 AI 关键词拆解

**状态：缺失。**

- 未找到「把用户描述拆成搜索关键词」的 AI 调用、提示词或命令。
- 现存 AI 提示词只有：客服回复（`extension/src/chat/ai-prompt.ts:27-37`）与数据分析（`shared/analysis/prompt-rule-store.ts` 预置规则）。
- 流量词 `suggest` 是平台建议词，不是 AI 拆解（`mtop-client.ts:306-315`，命令 `CAPTURE_SUGGEST_WORDS` 见 `commands.ts:115`）。

### 3.4 批量询价消息发送

**状态：部分实现（仅单条、单会话显式发送）。**

- 发送命令：`CHAT_SEND_MESSAGE`（`commands.ts:122`）、`CHAT_APPLY_REPLY`（`commands.ts:126`）。
- 发送器（`extension/src/chat/send-client.ts:88-142`）：`ChatMessageSender.sendText`，一次一条；发送前校验 `sessionId/receiverId/myId/content`；内容上限 2000（`shared/types/reply.ts:388-392`）。
- 发送 transport（`extension/src/chat/send-transport.ts:87-121`）：走页面已建立的聊天 WebSocket，路由 `/r/MessageSend/sendByReceiverScope`，超时 10s（`shared/types/reply.ts:382-386`）。
- 发送 host 已接线 MAIN world（`extension/src/content/chat-main.ts:16,39,85`）：`installChatSendHost(win, sendHost)`。
- background 组装（`extension/src/background/index.ts:735-776`）：`ChatMessageSender` + `AiChatService` + `ReplyRuntime`。
- 自动回复发送（`extension/src/background/reply-runtime.ts:275-328`）：`executeAuto`，仍为单会话、单条。
- 默认模式（`shared/types/reply.ts:95-105`）：`enabled=false`、`mode='suggest'`。默认不自动发送。

**限制与风险**

- 无批量编排：没有「一次对多个商品/多个卖家发送」的任务模型。
- 无询价模板/话术库；内容由规则或 AI 生成，一次一条。
- 全仓未出现「询价/议价/报价」业务文案（关键词检索仅命中无关词）。
- 真实发送依赖页面聊天 WebSocket 就绪；既有验证记录显示一次真实发送未送出（`docs/ego-runtime-publish-report.md:59-60` 邻近章节）。失败以结构化错误返回，不伪造成功（`reply-runtime.ts:307-320`）。
- **文档与代码不一致**：`extension/src/chat/README.md:160-163` 声称「MAIN world 发送 host 未接入」，但代码已接入（`chat-main.ts:16,39,85`）。该 README 段已过期。

### 3.5 回复监控

**状态：只读监控已接线；自动回复触发未接线。**

- MAIN world 只读监听（`extension/src/content/chat-main.ts:22,55`）：`installChatWebSocketMonitor`，只读、不 send。
- background 摄入（`extension/src/background/chat-runtime.ts:144-161`）：`ingestSocketEvent` 仅写入 `ChatStore` 并产出元数据事件。
- 摄入链路（`extension/src/background/index.ts:387-397` + `:370-379`）：`handleChatSocketEvent` → `enqueueChatIngest` → `chatRuntime.ingestSocketEvent`。
- 历史/会话同步：`extension/src/chat/sync.ts`、`extension/src/chat/history.ts`；路由器 `extension/src/background/chat-runtime.ts:28-40`。
- 自动回复入口（`extension/src/background/reply-runtime.ts:330-340`）：`handleIncomingMessage` 已实现（含 AI 暂停、规则判定、`executeAuto`）。
- **接线缺口**：关键词检索显示 `handleIncomingMessage` 只在 `reply-runtime.ts` 定义处与 `extension/src/chat/test/*` 中被调用，生产 `background/index.ts` 未把实时 ingest 接到它。与 `chat/README.md:162-163` 的「未接线」描述一致。

**限制与风险**

- 现状能「看」到新消息入库，但不会自动触发 AI/规则回复。
- 事件负载只含元数据，不含正文（`chat/README.md:57`）。

### 3.6 AI 调用与工具循环

**状态：AI 调用已实现；工具循环缺失。**

- 客服 AI（`extension/src/chat/ai-service.ts:137-223`）：`AiChatService.completeText`，OpenAI 兼容 `/chat/completions`；`max_tokens=500`、`stream=false`、`temperature=0.7`；超时/取消/非 2xx 均归一为结构化错误。
- 视觉占位（`ai-service.ts:229-231`）：`analyzeImage` 固定返回 `UNSUPPORTED`，不访问网络。
- 分析 AI（`extension/src/analysis/llm-transport.ts:71-219`）：`OpenAiCompatibleLlmTransport.complete`；默认 `max_tokens=2000`、`temperature=0.3`、超时 30000ms；支持 `AbortSignal`。
- 分析服务调用（`extension/src/analysis/analysis-service.ts:219-226`）：传入 `messages` + 配置 + `signal`。
- 请求体只包含 `model/messages/max_tokens/stream/temperature/enable_thinking`（`ai-service.ts:159-167`、`llm-transport.ts:95-108`）：**不含 `tools` / `tool_choice`**。
- 全仓检索 `tool_calls|function_call|tool_use|agentLoop`：无命中。

**限制与风险**

- 无 function calling / 工具循环，无法让模型自主调用搜索、详情、发送等工具。
- 无「多步任务」编排；AI 只做单次文本生成。

### 3.7 任务调度、超时与取消

**状态：部分实现。**

- 状态机（`shared/task/task-machine.ts:27-37`）：`pending/running/paused/completed/failed/cancelled`（另有 `waiting_confirmation`）。
- 终态与不可逆（`task-machine.ts:17-21`）；非法迁移抛错（`task-machine.ts:42-89`）。
- 任务管理（`shared/task/task-manager.ts`）：`create/start/pause/resume/requeue/cancel/complete/fail/updateProgress`（`task-manager.ts:151-336`）；重启恢复 `recoverOnStartup`（`task-manager.ts:347-363`）。
- SW 重启恢复策略（`task-machine.ts:168-233`）：`running → paused`（默认，保留断点）或 `running → failed`。
- 采集取消/暂停（`extension/src/capture/controller.ts:269-288`），运行中用 generation + runState 做竞态保护（`controller.ts:466-474`）。
- 分析任务取消中断 LLM（`extension/src/analysis/analysis-service.ts:158-159` 建 `AbortController`，`:271-278` `cancelTask`）。
- LLM 超时/取消（`llm-transport.ts:110-130`、`:197-211`）。
- 发送超时 10s（`send-transport.ts:105-121`）。

**限制与风险**

- 任务模型**无 deadline / 时间预算 / 定时触发字段**（`shared/types/task.ts:28-41`、`task-machine.ts:27-37`）。
- 无轮询式调度器；采集是单次循环跑完，不是「持续监控」。
- MV3 Service Worker 会被浏览器回收（30 秒无通信，见 `task-machine.ts:168-179` 注释）。长时（30/60 分钟）监控当前没有保活机制证据（未见 `chrome.alarms`、offscreen、常驻 tab 的接线）。

### 3.8 持久化

**状态：部分实现。**

- 任务存储抽象（`shared/task/task-store.ts`）：内存实现、`chrome.storage.session` 适配器、`chrome.storage.local` 适配器。
  - 默认 `createDefaultTaskStore` → `chrome.storage.session`（`task-store.ts:422-427`）。
  - 跨 reload 持久 `createPersistentTaskStore` → `chrome.storage.local`（`task-store.ts:439-444`）。
- 聊天持久化（`extension/src/chat/session-persistence.ts:60-100`）：`chrome.storage.session`；字段白名单；上限 `maxMessages=500`、`maxConversations=100`（`session-persistence.ts:24-29`）。
- 商品库（`extension/src/capture/indexed-db-repository.ts:22-26`）：IndexedDB `fishops-products`，含 `products`（keyPath `itemId`）与 `snapshots`。
- 运行时会话状态（`extension/src/background/session-store.ts:1-30`）：`chrome.storage.session` 极简封装。
- 回复配置/凭据：`chrome.storage.local`（`extension/src/chat/reply-config-chrome.ts`，见 `chat/README.md:111`、`:142-143`）。

**限制与风险**

- 聊天正文与多数任务存于 `storage.session`：**浏览器关闭即清空**，不落盘（`session-persistence.ts:6`、`task-store.ts:10-14`）。用户所说的「会话本地保存」若要求跨浏览器重启保留，则未满足；若仅指会话内保存，则已满足。此点需确认。
- 发布任务断点用 `storage.local` 保留（`task-store.ts:429-444`），与聊天/采集策略不同。

### 3.9 人工查看 / API

**状态：已实现（仅扩展内命令）；无对外 HTTP API。**

- 命令路由（`extension/src/background/message-router.ts`）：按命令前缀分派到各运行时。
- 商品查看：`PRODUCT_LIST`（`commands.ts:119`，本地商品库）、`PRODUCT_CATALOG_QUERY`（`commands.ts:236`，飞书 + 我的在售，`extension/src/background/product-catalog-runtime.ts`）、`FEISHU_PRODUCTS_PAGE`/`FEISHU_PRODUCT_GET`（`commands.ts:223,228`）。
- 任务查看：`TASK_LIST`（`commands.ts:117`）、`ANALYSIS_GET`/`ANALYSIS_RESULT_GET`（`commands.ts:189,193`）。
- 后台直接调用 API：`extension/src/background/direct-publish-api.ts`（发布用，`docs/direct-publish-api.md`），在扩展内由 `chrome.*` 调用，非 HTTP 服务。
- 全仓检索 `createServer|express(|listen(|http.Server|WebSocketServer`：无命中。

**限制与风险**

- 没有可供外部程序调用的 HTTP/WS API；「人工查看/API」当前等价于扩展内页 + Workbench 页面。
- 无「询价会话/记录」的独立查询模型。

### 3.10 新搜索商品主动建聊能力

**状态：缺失。** 目标流程要求「对搜索到的商品发起询价」，这需要 `商品 → 卖家 → 会话(sessionId) → 发送`。现状只能对**已存在会话**发送。

发送侧硬约束（`extension/src/chat/send-protocol.ts:79-104`）：

- `validateSendInput` 要求 `sessionId` / `receiverId` / `myId` / `content` 均非空；
- `sessionId` 空直接返回 `INVALID_INPUT`（`send-protocol.ts:85-87`）；
- `receiverId` 必须非空、等于 `myId` 会被拒（`send-protocol.ts:88-102`）；
- 构造请求时 `cid = toFullCid(sessionId)`，`actualReceivers` 需含双方（`send-protocol.ts:110-134`）。

`sessionId` 与 `receiverId` 的来源（均为「已有会话/已有消息」，不是主动建聊）：

- 会话 ID 来自 `cid` 拆分：`123@goofish → sessionId '123'`（`shared/chat/protocol.ts:106-110`、`:116-119`）。
- 实时消息的 `sessionId` 取自 `reminderUrl` 的 `sid`（`extension/src/chat/parser.ts:483-496`、`:559-573`、`:617-630`）。
- 会话列表的 `sessionId` / `peerUserId` / `itemId` 均从服务端返回的 `reminderUrl` 解析（`extension/src/chat/history.ts:121-136`）。
- 发送用的 `receiverId` 优先显式传入，否则取来源消息的 `senderId`（`extension/src/background/reply-runtime.ts:409-419`）。

是否存在 `商品(itemId) → 卖家(sellerId) → 新 sessionId` 封装：

- 未找到。全仓检索 `createSession|newSession|建聊|发起会话|openConversation|startConversation|getOrCreateSession|resolveSessionId`：生产代码**无命中**（仅命中发布模块测试里的 `createSession` 测试辅助与 `chat-runtime` 的 `createChatRuntime` 等无关同名词）。
- 聊天 LWP 只登记三条路由：`/r/Conversation/listNewestPagination`、`/r/MessageManager/listUserMessages`、`/r/Conversation/clearRedPoint`（`shared/chat/protocol.ts:21-28`）。**没有**「创建会话 / 发起聊天」路由。
- MTOP 只登记四个接口：search / detail / suggest / myOnSaleItems（`extension/src/platform/xianyu/mtop-client.ts:33-56`）。**没有**按 `itemId`/`sellerId` 建会话的接口。
- `peerUserId` 的两个来源都是既有会话：会话列表解析（`history.ts:121-136`）与 `session.sync`/`user.query` 补头像（`extension/src/chat/peer-profiles.ts:51-57,139-143`）。
- 商品归一化确实产出 `sellerId`（`shared/capture/normalizer.ts:192`），但**没有任何模块把 `sellerId` 转成 `sessionId`**。
- `extractUrlParam`（`shared/chat/protocol.ts:98-103`）只用于从既有会话数据里取 `sid/peerUserId/itemId`，不是建聊。

前端同样受限（`workbench/src/components/chat/ReplyComposer.vue:21-23,97-100,127`）：发送按钮要求 `receiverId` 非空；缺失时提示「缺少买家用户 ID，请先同步历史后再手动发送。」即**必须先有会话历史**才能发。

**结论**：新搜索到的商品没有可用的 `sessionId`，也无「按商品/卖家建聊」的封装。要支持「对搜索结果发起询价」，必须先补齐建聊能力（如何补齐属于待确认，不在本文决定）。

### 3.11 前端现状

**状态：有聊天中心与规则界面；无询价相关界面。**

- 页面清单（`workbench/src/pages/`）：`ChatCenterPage.vue`、`CollectPage.vue`、`ProductsPage.vue`、`AnalyticsPage.vue`、`PublishPage.vue`、`SettingsPage.vue`、`OverviewPage.vue`、`BridgeDemo.vue`。
- 聊天中心（`workbench/src/pages/ChatCenterPage.vue`）：左栏会话列表、右栏消息线程、买家与商品上下文条、底部 `ReplyComposer`；脚本区 `L1-182`，模板 `L184-454`。
- 回复输入（`workbench/src/components/chat/ReplyComposer.vue:9-16`）：设计为「手动发送为唯一入口；回复建议只生成并回填输入框，绝不发送」。手动发送入口 `:97-100`；建议按钮 `:121-124`。
- 规则界面：`workbench/src/components/chat/ReplyRulesPanel.vue`（存在；因前端另有代理，本文不深入其细节）。
- 聊天中心订阅的 bridge 事件（`workbench/src/features/chat/chat-center-controller.ts:35-41`）：`WORKER_STARTED`、`CHAT_MESSAGE_INGESTED`、`CHAT_CONVERSATION_UPDATED`、`CHAT_SYNC_COMPLETED`、`CHAT_SOCKET_STATUS`。即只读监控类事件；不含 `CHAT_MESSAGE_SENT` / `CHAT_AUTO_REPLY_TRIGGERED` / `CHAT_REPLY_SUGGESTION_GENERATED`（这些事件在 `shared/events/events.ts:34,36,45` 有定义，发送/建议相关订阅由 `features/reply` 侧处理）。
- 事件全量定义见 `shared/events/events.ts:15-52`。所有事件负载均声明不含正文/凭据。
- features 目录（`workbench/src/features/`）：`analysis`、`capture`、`chat`、`overview`、`products`、`publish`、`reply`、`settings`、`shared`。其中 `chat` 仅含 `app-chat-bootstrap-controller.ts`、`chat-center-controller.ts`、`chat-format.ts`、`types.ts`。

**未找到**任何「询价 / 批量询价 / 多商品选择 / 硬性要求筛选交给 AI」的页面或组件（全仓「询价」检索 0 命中）。

## 4. 目标流程逐环节对照

| 步骤 | 现有支撑 | 状态 | 缺口 |
|---|---|---|---|
| 用户描述商品要求 | 无专用输入/存储 | 缺失 | 无「需求描述」领域模型 |
| AI 关键词拆解 | 无 | 缺失 | 无拆解提示词/调用 |
| 批量搜索 | `CAPTURE_CREATE`（单关键词多页） | 部分 | 无多关键词编排 |
| 凑够 10 个硬性要求商品 | 单页过滤 `filter.ts:14-29` | 缺失 | 无阈值停止、无硬性要求全集判定 |
| 批量询价 | `CHAT_SEND_MESSAGE`（单条） | 部分 | 无批量、无询价模板 |
| 持续监控 30/60 分钟 | 状态机 + 只读监控 | 缺失 | 无时间窗口调度、SW 不支持长驻 |
| 完成/截止总结 | 无询价汇总 | 缺失 | 无结果汇总模型 |
| 会话本地保存 | session + IndexedDB | 部分 | 正文不跨浏览器重启；无询价会话模型 |
| 独立简洁包 | `shared/`、`extension/src/*` 子模块 | 部分 | 尚无询价模块目录 |

## 5. 真实 API 清单（代码中确认存在）

- 闲鱼 MTOP（`mtop-client.ts:33-56`）：
  - `mtop.taobao.idlemtopsearch.pc.search`
  - `mtop.taobao.idle.pc.detail`
  - `mtop.taobao.idlemtopsearch.pc.search.suggest`
  - `mtop.idle.web.xyh.item.list`
- 闲鱼聊天 LWP（`chat/README.md:53-54`、`send-transport.ts`）：
  - 只读：`/r/Conversation/listNewestPagination`、`/r/MessageManager/listUserMessages`
  - 发送：`/r/MessageSend/sendByReceiverScope`
- 飞书 Bitable（`shared/data-source/feishu-data-source.ts`）：
  - `/open-apis/auth/v3/tenant_access_token/internal`（`:76`）
  - `/open-apis/bitable/v1/apps/{app}/tables/{table}/fields`（`:127`、`:475`）
  - `/open-apis/bitable/v1/apps/{app}/tables/{table}/records`（`:173`、`:560`）
  - `/open-apis/bitable/v1/apps/{app}/tables/{table}/records/search`（`:277`）
  - `/open-apis/bitable/v1/apps/{app}/tables/{table}/records/batch_create`（`:695`）
- OpenAI 兼容：
  - chat 回复 `${baseUrl}/chat/completions`（`ai-service.ts:176`）
  - 数据分析 `${baseUrl}/chat/completions`（`llm-transport.ts:92`）

## 6. 限制与风险汇总

1. **无 Agent 编排**：没有多步任务、工具循环、状态持久化到「询价流程」层面的机制。
2. **长时监控与 MV3 生命周期冲突**：Service Worker 会被回收（`task-machine.ts:168-179`），30/60 分钟监控无保活实现证据。
3. **发送是单条显式动作**：默认 `suggest`、`enabled=false`；批量询价需新增编排层。
4. **自动回复未接线**：`handleIncomingMessage` 有实现无生产调用（`reply-runtime.ts:330-340`）。
5. **无规格筛选**：详情归一不含规格维度（`normalizer.ts:236-276`）。
6. **持久化语义分歧**：聊天/任务默认 session（关闭即清空），与「会话本地保存」的期望需对齐。
7. **文档过期**：`chat/README.md:160-163` 与实际发送 host 接线不一致。
8. **数据分析强制飞书**：`analysis-service.ts:119-140`、`:164-170` 拒绝非 `feishu` 数据源；若询价筛选想复用分析链路会被拒。
9. **无对外 API**：无 HTTP 服务，外部集成只能走扩展内命令。
10. **无主动建聊**：没有 `商品→sellerId→新 sessionId` 封装，无法对搜索结果直接发起询价（详见 §3.10）。
11. **缺少 30/60 分钟长时完成保障**：现有采集是单次循环，状态机无 deadline；下文按三种关闭场景分别陈述，均不含实测。

### 6.1 生命周期与长时保障（严格区分三种关闭；未实测）

- **关闭 Workbench 页**：不能断言「任务必死」。background Service Worker 与 Workbench 页是不同上下文；关闭页面后，SW 仍可能被其它事件唤醒（例如 goofish content script 上报的聊天 socket 事件、命令消息）。但代码中没有为「关闭 Workbench 后继续跑完长时任务」做专门保活；关闭页面后也无 UI 触发。是否能跑完，取决于 SW 是否仍存活，本文无实测结论。
- **关闭闲鱼聊天页**：当前实时消息采集**依赖该页面**。只读监听安装在 goofish 页面 MAIN world（`extension/src/content/chat-main.ts:22,55`，`extension/src/chat/websocket.ts`），关闭该页即没有 socket 事件来源。发送同样依赖页面已建立的聊天 WebSocket（`extension/src/chat/send-transport.ts:100-103`：无可用 socket 时返回 `NO_SOCKET`）。
- **退出浏览器**：不能执行。SW 停止；`chrome.storage.session` 按官方语义在浏览器重启时清空（`extension/src/chat/session-persistence.ts:6`、`extension/src/background/session-store.ts:1-7`），未落盘的任务/聊天状态不保留。
- **恢复策略**：SW 重启后，遗留 `running` 任务按策略转为 `paused`（采集，保留断点）或 `failed`（非幂等发布），**不自动续跑**（`shared/task/task-machine.ts:199-233`、`shared/task/task-manager.ts:347-363`、`extension/src/background/capture-runtime.ts:137-150`）。
- **结论**：无论哪种关闭场景，当前都**缺少「30 分钟默认 / 60 分钟上限、到点无论如何都收尾总结」的长时完成保障**。代码注释描述了 MV3 SW 会被回收（`shared/task/task-machine.ts:168-179`，其中提及「30 秒无通信」），但**本文未实测该数值，不能把它当作已确认的固定休眠时间**。

## 7. 待确认决策

1. 「会话本地保存」指会话内保存，还是必须跨浏览器重启落盘？若是后者，聊天正文的 `storage.session` 策略需调整（未决定如何调整）。
2. 30/60 分钟监控在 MV3 下的承载方式（轮询/alarms/常驻 tab）尚未决定。
3. 「批量询价」的粒度与并发上限、是否复用现有单条发送器，尚未决定。
4. 「符合硬性要求」的判定字段与阈值来源（用户输入 vs AI 解析 vs 平台字段）尚未确定。
5. 询价流程是否需要独立于现有 chat 会话的持久化模型，尚未决定。
6. 新增后台模块的「独立简洁包」边界与命名，尚未确定。
7. 是否允许 AI 关键词拆解直接复用现有 OpenAI 兼容调用（无工具循环），尚未决定。
8. 「主动建聊」如何补：是否需要新增 `商品(itemId) → 卖家(sellerId) → 新 sessionId` 的封装，以及其协议/接口来源，尚未决定（现状见 §3.10）。
9. 长时监控在三种关闭场景下的期望行为（是否要求关闭 Workbench / 闲鱼页后仍继续），尚未决定（现状见 §6.1）。

## 8. 证据索引（关键文件:行号）

- 搜索/详情/建议 API：`extension/src/platform/xianyu/mtop-client.ts:33-56,168-184,289-315`
- 结果与详情归一：`shared/capture/normalizer.ts:158-214,220-230,236-276`
- 采集过滤：`shared/capture/filter.ts:14-29`
- 采集循环与详情：`extension/src/capture/controller.ts:465-735`（循环 `:525-586`、详情 `:588-608`）
- 节流：`extension/src/capture/pacer.ts:37-66`
- 采集运行时常量/命令：`shared/events/commands.ts:105-119`、`shared/events/codec.ts:389-402`、`extension/src/background/capture-runtime.ts:181-199`
- AI 回复：`extension/src/chat/ai-service.ts:137-223,229-231`、`extension/src/chat/ai-prompt.ts:27-37`
- AI 分析：`extension/src/analysis/llm-transport.ts:71-219`、`extension/src/analysis/analysis-service.ts:119-140,158-159,219-226,271-278`
- 发送：`extension/src/chat/send-client.ts:88-142`、`extension/src/chat/send-transport.ts:87-121,155-157`、`extension/src/content/chat-main.ts:16,39,85`
- 回复监控与未接线：`extension/src/background/chat-runtime.ts:144-161`、`extension/src/background/index.ts:370-397`、`extension/src/background/reply-runtime.ts:275-340`
- 回复模式与常量：`shared/types/reply.ts:11-15,95-105,214-229,382-392`
- 任务状态机与管理：`shared/task/task-machine.ts:27-37,168-233`、`shared/task/task-manager.ts:151-363`、`shared/types/task.ts:28-41`
- 持久化：`shared/task/task-store.ts:422-444`、`extension/src/chat/session-persistence.ts:24-100`、`extension/src/capture/indexed-db-repository.ts:22-26`、`extension/src/background/session-store.ts:1-30`
- 飞书数据源：`shared/data-source/feishu-data-source.ts:30,76,127,173,258,277,475,560,695`
- 商品目录/发布 API：`extension/src/background/product-catalog-runtime.ts`、`extension/src/background/direct-publish-api.ts`、`docs/direct-publish-api.md`
- 扩展权限：`extension/public/manifest.json:6-15`
- 过期文档：`extension/src/chat/README.md:157-163`
- 旧项目对照（单关键词爬取/流量词）：`extensions/FishOps/inject.js:248-362`、`extensions/FishOps/popup.js:425-435`
- 建聊约束与来源：`extension/src/chat/send-protocol.ts:79-104,110-134`、`shared/chat/protocol.ts:21-28,98-103,106-119`、`extension/src/chat/parser.ts:483-496,559-573,617-630`、`extension/src/chat/history.ts:121-136`、`extension/src/background/reply-runtime.ts:409-419`、`extension/src/chat/peer-profiles.ts:51-57,139-143`、`shared/capture/normalizer.ts:192`
- 前端现状：`workbench/src/pages/ChatCenterPage.vue:1-182,184-454`、`workbench/src/components/chat/ReplyComposer.vue:9-16,21-23,97-100,127`、`workbench/src/features/chat/chat-center-controller.ts:35-41`、`shared/events/events.ts:15-52`
- 生命周期与恢复：`shared/task/task-machine.ts:168-179,199-233`、`shared/task/task-manager.ts:347-363`、`extension/src/background/capture-runtime.ts:137-150`、`extension/src/chat/send-transport.ts:100-103`、`extension/src/content/chat-main.ts:22,55`、`extension/src/chat/session-persistence.ts:6`、`extension/src/background/session-store.ts:1-7`
