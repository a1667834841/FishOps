# FishOps Workbench 实施计划

> 状态:草案 v1(2026-10-02)
> 目标:把现有 Chrome 插件 FishOps 升级为 **Workbench(独立工作台)+ Extension Runtime(浏览器运行时)** 两层架构,暂不引入独立后端。

## 0. 约定

- **新目录**:`extensions/FishOps-Workbench/`。旧 `FishOps/` 保持不动,只当参考实现(`main` 与 `chat` 两个分支),不在里面改代码。
- **结构**:`workbench/`(Vue 3 + Vite + TS)、`extension/`(MV3,Vite 打包)、`shared/`(类型、schema、事件),用 pnpm workspace 管理。
- **测试**:用 ego lite 加载扩展,打开 Workbench 页面,由用户提供闲鱼账号登录。
- **原则**:Workbench 不碰 Cookie、sign 和 MTOP。`platform/xianyu` 只做底层,业务模块不直接碰 WebSocket。

## 0.1 对现有代码的结论

1. **`main` 与 `chat` 两个分支已经分叉**(详见第 6 节)。`main` 有采集、详情下载、发布填充、飞书同步;`chat` 是"聊天监听助手",有聊天收发、自动回复、AI、闲管家集成、订单导出,但**把采集和发布相关文件删掉了**。新项目要从两边各取所需,不能只基于其中一个。
2. **自动回复在 `chat` 分支**,已实现:LWP 协议发送、关键词规则、AI 规则、AI 暂停、防重复。P6 不用从零抓包。
3. **MTOP 搜索和详情在 `main`**:`xianyu-api.js` 里有签名、`request`、`fetchItemDetail`、`fetchSuggestWords`,可直接迁移。
4. **飞书同步在 `main` 的 `background.js`**:`PRODUCT_SCHEMA`、字段自动建表、批量写入,可搬到 `DataSource`。

## 1. 技术架构

```text
┌────────────────────────────┐
│      FishOps Workbench     │
│ Vue 3 SPA                  │
│ 抓取 | 聊天 | 发布 | 分析   │
└────────────┬───────────────┘
             │ Command / Event
             ▼
┌────────────────────────────┐
│ Chrome Extension (MV3)     │
│ Background Task Manager    │
│   ┌────────┼─────────┐     │
│ Capture   Chat     Publish │
└───┬─────────┬─────────┬────┘
    ▼         ▼         ▼
  MTOP    WebSocket    DOM
    └─────────┬─────────┘
              ▼
            闲鱼
```

| 层 | 技术 |
|---|---|
| Workbench | Vue 3 + Vite + TypeScript |
| Extension | Manifest V3 + TS |
| 通信 | `window.postMessage` → Content Bridge → `chrome.runtime` |
| 本地数据 | IndexedDB(Dexie) |
| 插件配置 | chrome.storage |
| 闲鱼请求 | MAIN World 执行 |
| AI | OpenAI-compatible API(经 Background 调用,避免 CORS) |
| 外部数据 | 飞书 Bitable API |
| 实时状态 | Event + Task 状态机 |

### 目标目录

```text
FishOps-Workbench/
├── workbench/            # capture / chat / publish / analysis / settings
├── extension/
│   ├── background/       # task-manager / message-router / tab-manager
│   ├── capture/          # controller / search / detail / normalizer
│   ├── chat/             # websocket / parser / history / sender / reply-engine
│   ├── publish/          # controller / form-filler / image-uploader
│   ├── platform/xianyu/  # auth / sign / mtop-client
│   └── bridge/           # workbench-bridge
├── shared/               # schemas / events / types
└── docs/
```

## 2. 阶段总览

| 阶段 | 内容 | 产出 | 依赖 |
|---|---|---|---|
| P0 | 环境验证 | ego lite 能加载扩展并登录闲鱼 | 无 |
| P1 | 工程骨架 + Bridge | Workbench ↔ Extension 通信跑通 | P0 |
| P2 | Task 模型 + 任务中心 | 统一任务状态机和 UI | P1 |
| P3 | 平台层迁移 | `platform/xianyu`(auth、sign、mtop-client) | P1 |
| P4 | 数据采集 | 搜索和详情采集、IndexedDB、商品库 | P2、P3 |
| P5 | 聊天只读 | 会话列表、消息流、商品信息 | P3 |
| P6 | 聊天发送和 AI | 发送、规则引擎、AI 建议、三种模式 | P5 |
| P7 | 飞书和数据分析 | DataSource、PromptRule、AI 分析 | P4 |
| P8 | 发布中心 | 迁 UI 和 FormFiller,人工确认发布 | P4 |

P5 到 P8 在 P4 之后基本可并行。建议顺序:**P4 → P7 → P5 → P6 → P8**,先让采集到分析的闭环跑通。

MVP 范围:P0–P7。P8 先只迁 UI 和填充逻辑,不重写底层。

## 3. 各阶段步骤

### P0:环境验证

- [ ] 确认 ego lite 能否加载 unpacked 扩展(`--load-extension` 或扩展管理页)。**不能则测试方案要改。**
- [ ] 确认 Workbench 载体:扩展内页 `chrome-extension://<id>/workbench.html`(推荐),或本地 `localhost` 页面(需 `externally_connectable` 或 content script)。
- [ ] 用户提供账号,在 ego lite 登录 `goofish.com`,确认登录态可保留。
- [ ] 旧 `FishOps` 扩展(`main` 分支)在 ego lite 跑一次搜索采集;`chat` 分支再加载一次,确认聊天监听正常,作为两条基线。

验收:两个分支的旧扩展在 ego lite 里各自功能正常。

### P1:骨架和 Bridge

- [ ] 初始化 monorepo;Workbench 用 Vite + Vue3 + TS,Extension 用 Vite 多入口(background、content、main-world)。
- [ ] 定义 `shared/events`:`Command`(请求/响应带 `requestId`)与 `Event`(单向推送)。
- [ ] 实现 `workbench-bridge`:`window.postMessage` → Content Bridge → `chrome.runtime` → Background → 回程;Workbench 侧封装 SDK,如 `runtime.call('PING')`。
- [ ] 做 `PING/PONG` 与事件订阅 demo。
- [ ] Background 是 MV3 service worker 会被回收,任务状态须持久化(`chrome.storage.session` 或 IndexedDB),不能只放内存。
- [ ] 若 Workbench 是 `localhost` 页,须限制 `origin`,防止其他网页向扩展发指令。

验收:Workbench 点按钮能收到 Extension 响应,service worker 重启后仍可用。

### P2:Task 模型

- [ ] `shared/types/task.ts`:

  ```ts
  interface Task {
    id: string
    type: 'capture' | 'publish' | 'analysis'
    status: 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
    progress: number
    createdAt: number
    updatedAt: number
    error?: string
  }
  ```

  另补 `payload`、`result`、`meta`。
- [ ] Background 实现 `TaskManager`:创建、暂停、恢复、取消,状态机合法转换校验。
- [ ] 任务持久化;service worker 重启后把 `running` 任务恢复为 `paused` 或 `failed`。
- [ ] Workbench 任务中心页与进度 Event 订阅。

验收:用假任务(sleep 循环)验证暂停、停止、刷新页面后进度不丢。

### P3:平台层迁移

- [ ] 迁 `sign.ts`(MD5、token 解析、签名)与 `mtop-client.ts`(`request`、API 配置)。来源:`main:xianyu-api.js`。
- [ ] 迁 `auth.ts`:读取 `_m_h5_tk`,检测登录;用户 ID 获取参考 `chat:inject/api/find-my-id.js`、`user-api.js`。
- [ ] MAIN world 注入:MTOP 请求须在 `goofish.com` 页面 MAIN world 执行。新增 `RuntimeHost`,由 Background 通过 `chrome.scripting.executeScript` 或 content 桥调用,不再沿用旧版"事件广播再拦截"。
- [ ] `tab-manager`:查找或创建闲鱼 tab,处理未登录、tab 被关闭。
- [ ] 请求限速(不低于 1.5 秒,可配置)与统一错误码(风控、token 过期、验证码)。

验收:Workbench 调 `platform.ping`,能在闲鱼页执行一次搜索并返回原始 JSON。

### P4:数据采集

- [ ] `capture/search.ts`:分页搜索,支持关键词、页数、价格区间、想要人数、包邮等过滤。
- [ ] `capture/detail.ts`:详情采集(浏览量、想要数、卖家信息)。
- [ ] `capture/normalizer.ts`:迁移旧版 `PRODUCT_SCHEMA` 与 `processListData`,统一为标准 `Product`。
- [ ] `CaptureController` 接入 TaskManager,支持暂停、取消、断点续采。
- [ ] IndexedDB 存商品库,按 `itemId` 去重,保留历史快照(P7 需要"想要人数增长")。
- [ ] Workbench:采集表单、进度条(已获取/有效/失败)、商品表格、CSV 导出。

验收:ego lite 采集"iPhone 17"3 页,表格数据与旧扩展一致,中途暂停恢复正常。

### P5:聊天只读

复用 `chat` 分支现成实现(见第 6 节),按 TS 重构拆分。

- [ ] WebSocket 拦截:迁 `chat:inject/websocket/websocket-data-source.js`,拆为 `websocket.ts`。
- [ ] 消息解析:迁 `chat:inject/chat-parser.js`(688 行,含 MessagePack、消息类型判断),拆为 `parser.ts`。
- [ ] 历史与会话:迁 `chat:inject/api/chat-history.js`(`/r/Conversation/listNewestPagination`、`/r/MessageManager/listUserMessages`)和 `chat-sync.js`,实现为 `history.ts`。
- [ ] 标准 `ChatMessage`、`Conversation`,存入 `ChatStore`(IndexedDB),沿用 `chat` 分支的消息去重逻辑。
- [ ] Workbench 三栏布局:会话列表、聊天内容、商品信息。
- [ ] WebSocket 仅在闲鱼页面打开时存在,需保证常驻闲鱼 tab,UI 提示连接状态。

验收:用另一账号或手机给测试号发消息,Workbench 实时显示;重载后历史不丢。

### P6:聊天发送和 AI

- [ ] `sender.ts`:迁 `chat:inject/api/chat-sender.js`(LWP `/r/MessageSend/sendByReceiverScope`,`actualReceivers` 必须包含双方 ID)。**注意:文档写 `contentType: 101`,代码实际用 `contentType: 1`,以代码和抓包为准,P6 开始时用 ego lite 实测一次。**
- [ ] `reply-engine.ts`:迁 `chat:inject/handlers/auto-reply-processor.js`(735 行)的规则引擎:
  - 关键词规则(正则、冷却、延迟、商品绑定)
  - AI 规则(prompt、历史条数、商品详情拼接)
  - `shouldProcess` 检查链:总开关、AI 暂停、自己发送、黑名单、已处理、冷却
  - AI 暂停:检测到本账号在非 Web 端发送消息时暂停 10 分钟
- [ ] AI 调用:迁 `chat:background/ai-service.js`(`callChatCompletion`、`callVisionAI` 多模态图片分析),保持放在 Background。
- [ ] 三种模式:人工回复、AI 建议(采用或修改)、AI 自动回复。**原实现只有"自动回复","AI 建议"是新增。**
- [ ] 自动回复保护:频率限制、每会话最大条数、关键词转人工、全局一键关闭。
- [ ] 设置页:API Base、Key、模型、Prompt。Key 存 `chrome.storage.local`,不入 IndexedDB 和日志。
- [ ] 原实现的 AI Key 放在规则对象里,迁移时改成全局配置,规则只引用。

验收:买家问"最低多少",Workbench 给出建议,点"采用"后买家端收到;切换为自动模式后能按规则自动回复。

### P7:飞书和分析

- [ ] `DataSource` 接口 + `LocalDataSource`、`FeishuDataSource`(迁 `main:background.js` 飞书代码)。

  ```ts
  interface DataSource {
    query(params): Promise<Dataset>
    getSchema(): Promise<Schema>
  }
  ```
- [ ] `Dataset`、`Filter`、`PromptRule`(可保存)、LLM 调用、结构化输出(JSON schema 校验)。
- [ ] 分析任务走 Task 模型。
- [ ] Workbench:数据源选择、Prompt 编辑、结果表格与 AI 结论。
- [ ] 数据量大时先聚合或抽样再送 LLM,避免超 token。

验收:对 P4 数据运行"高需求低竞争"规则,得到结构化结果。

### P8:发布中心

- [ ] 迁 `main:publish-helper.js`(图片下载、`DataTransfer` 上传、表单填充),封装为 `FormFiller`、`ImageUploader`。
- [ ] 发布规则:价格系数(原版固定为原价 × 5 填原价,改为可配置)、文案规则、图片规则。
- [ ] `PublishController`:打开发布页、填充、等待人工确认,**不自动点击发布**。
- [ ] Workbench:待发布列表、规则、任务状态。

验收:选 2 个商品依次填充完成,状态显示"等待确认"。

## 4. ego lite 测试策略

- 每阶段结束后在 ego lite 走一遍验收流程,截图并读 console 日志。
- 登录由用户提供账号;账号密码不写入代码或文档,登录态靠浏览器 profile 保留。
- 闲鱼可能触发滑块或验证码(见 `FishOps/验证码请求.md`),需用户人工处理。
- 测试用小量数据(1 到 3 页),避免触发风控。
- P5、P6 需要第二个账号(或手机)模拟买家。

## 5. 主要风险

| 风险 | 影响 | 对策 |
|---|---|---|
| ego lite 不支持加载扩展 | 测试方案要改 | P0 最先验证 |
| 两个分支分叉,功能来源分散 | 迁移遗漏 | 第 6 节清单逐项对照;不直接 merge,按模块迁移 |
| 聊天发送协议变化 | P6 失败 | 复用已抓包实现;实测;备选 DOM 模拟输入 |
| 风控、验证码 | 采集中断 | 限速、识别错误码并暂停任务 |
| service worker 被回收 | 任务丢失 | 状态持久化与恢复策略 |
| 闲鱼接口或签名变化 | 采集失败 | 平台层隔离,统一错误码 |
| 账号安全(自动回复、批量) | 封号 | 默认只做建议,自动模式手动开启并限速 |
| AI Key 泄露 | 安全 | 只存 `chrome.storage.local`,不进日志、不进 Workbench 的持久化数据 |

## 待确认问题

1. Workbench 载体:扩展内页(推荐,部署简单、无跨域)还是 `localhost`?
2. 是否有第二个账号模拟买家(P5、P6 需要)?
3. 旧 `FishOps` 保留还是废弃,是否迁移旧 localStorage 下载记录?
4. 闲管家集成(`chat:background/xiangguanjia-service.js`,1258 行)和订单导出是否纳入 Workbench?目前不在计划范围内(见 6.4)。

## 6. `chat` 分支现状调研

调研方式:只读 git 命令(`git show chat:<path>`、`git diff --stat`),未切换分支。

### 6.1 分支关系

- 分支:`main`、`dev`、`chat`,另有 `origin/chat`。
- `chat` 比 `origin/chat` 多 2 个本地提交:`导出订单列表`、`测试`。
- `chat` 相对 `main`:67 个文件变化,+17298 / −6509。
- **`chat` 删除了 `main` 的**:`background.js`(飞书同步)、`inject.js`、`xianyu-api.js`(MTOP 签名)、`item-download.js/css`、`publish-helper.js`、旧 `popup`、旧 `options`。
- **`chat` 新增了**:聊天、自动回复、AI、闲管家、订单导出、测试脚本、`docs/api/` 文档。

结论:采集和发布只能从 `main` 取,聊天和 AI 只能从 `chat` 取,两边不能直接合并。

### 6.2 文件与可复用点

| 能力 | `chat` 分支文件 | 迁移到 | 备注 |
|---|---|---|---|
| WebSocket 拦截 | `inject/websocket/websocket-data-source.js`(113 行) | P5 `websocket.ts` | 通过 `XianyuSenderSetup.setTargetWebSocket` 把连接交给发送器 |
| 消息解析 | `inject/chat-parser.js`(688 行) | P5 `parser.ts` | 含 MessagePack 解码、消息类型(chat / order / system) |
| 会话与历史 | `inject/api/chat-history.js`(760 行) | P5 `history.ts` | 分页游标为 `9007199254740991`,请求间隔建议 300ms |
| 同步 | `inject/api/chat-sync.js`(300 行) | P5 `ChatStore` | 有去重、顺序、会话加载测试 |
| 当前用户 ID | `inject/api/find-my-id.js`、`user-api.js` | P3 `auth.ts` | 发送要用 `myId` |
| 商品 API | `inject/api/goods-api.js`、`goods-list-api.js` | P3 / P4 | 自动回复拼商品详情用 |
| 消息发送 | `inject/api/chat-sender.js`(319 行) | P6 `sender.ts` | LWP 协议,见 6.3 |
| 事件总线 | `inject/events/event-bus.js`、`message-bridge.js` | P1 `Bridge` | 可参考,不必照搬 |
| 自动回复引擎 | `inject/handlers/auto-reply-processor.js`(735 行) | P6 `reply-engine.ts` | 见 6.3 |
| AI 服务 | `background/ai-service.js`(259 行) | P6 | `callChatCompletion`、`callVisionAI`(多模态) |
| 配置与存储 | `background/index.js`(794 行)、`shared/config.js` | P1 / P6 | 规则存储与 `GET_AUTO_REPLY_RULES` |
| 打印处理 | `inject/handlers/print-processor.js` | 不迁 | 偏调试 |

### 6.3 发送与自动回复要点

**LWP 协议**(`wss://wss-goofish.dingtalk.com/`):

- 请求:`{ lwp, headers: { mid }, body: [...] }`;响应 `code` 为 200 或 0 表示成功。
- `mid` 格式:`{0-999随机数}{时间戳} 0`;`uuid` 格式:`-{时间戳}{0-9999随机数}`。
- 发送路由 `/r/MessageSend/sendByReceiverScope`:
  - `cid` 为 `{sessionId}@goofish`,`conversationType: 1`。
  - 消息体为 JSON 序列化后 UTF-8 base64,文本为 `{ contentType: 1, text: { text } }`。
  - 外层 `content.contentType` 为 101,`custom.type` 为 1,`custom.data` 为 base64。
  - 第二个参数 `{ actualReceivers: [对方@goofish, 自己@goofish] }`,**必须包含双方**。
- 消息超时 10 秒;`docs/api/image-message-format.md` 有图片消息格式。

**自动回复**:

- 规则两类:`keyword`(正则 `i` 标志)和 `ai`(prompt、`maxHistoryMessages`、模型、超时)。
- 通用字段:`priority`、`cooldown`(默认 60s)、`delay`(默认 1s)、`itemIds`(商品绑定)。
- 全局配置:`enabled`、`defaultCooldown`、`defaultDelay`、`blacklist`。
- 防重:`processedMessageIds` Set 做消息级防重;`recentReplySessions` 做会话级冷却。
- AI 暂停:`platform !== 'web' && direction === 'out'` 时暂停 10 分钟,避免和手机端人工回复冲突。
- 跨 World:处理器在 MAIN world,经 `postMessage` 与 Background 通信(`GET_AUTO_REPLY_RULES`、`AI_CHAT_COMPLETION`、`REPORT_NON_WEB_MESSAGE`)。新架构里改为 Command / Event,不再直接 `postMessage`。

**已知问题与注意点**:

- 文档写 `contentType: 101`,代码注释和实现用 1,需实测。
- 规则对象里直接放 `aiApiKey`,迁移时抽到全局配置。
- 代码里 `window.XianyuSender`、`window.AutoReplyProcessor` 等全局变量较多,迁移时改为模块导出。
- `sendMessage` 里有大量调试日志(含 `🔍 Promise 构造函数已执行`),迁移时精简。

### 6.4 范围外功能(暂不纳入)

- **闲管家集成**:`background/xiangguanjia-service.js`(1258 行)、`docs/api/xiangguanjia-api.md`。
- **订单导出**:`test/test-order-export-utils.js`、`test-pending-orders-export.js`。
- **多模态图片分析**:`callVisionAI` 已在 `ai-service.js`,P6 可选接入。

以上若要纳入,建议在 P6 之后作为 P9 独立评估。

### 6.5 可参考的现成文档(`chat` 分支)

- `docs/api/websocket-api.md`:LWP 协议、会话、历史、发送、消息类型。
- `docs/api/auto-reply-api.md`:规则格式、处理流程、AI 暂停。
- `docs/api/data-structures.md`、`image-message-format.md`、`xianyu-internal-api.md`。
- `AI_PAUSE_FEATURE.md`、`project.md`。
- 另有 4 份中文指南(聊天实现、快速启动、问题排查、功能任务列表),文件名为中文。
