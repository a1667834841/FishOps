# Agent API 设计（轻量版）

> 目标：插件只做一件事：给 agent 提供闲鱼的搜索、询价（聊天）、发布 API，并且尽量降低风控风险。
> 状态：设计草案，没有实施。本版替代之前的“页面确认 + 强制熔断 + 询价批次”方案。
> 相关文档：[风控现状与优化点](platform-risk-control.md)、[询价能力调研](ai-inquiry-agent-backend-recon.md)、[直发接口](direct-publish-api.md)。

> 公共协议与验收以 [实施契约](agent-api-contract.md) 为准；本文保留架构说明。

## 1. 已确认的决策（2026-10-17）

| 项 | 决策 |
|---|---|
| 使用方 | 只有 agent。不做工作台页面，也不做人工确认门禁 |
| 接入方式 | native messaging host 提供本地 HTTP + SSE |
| 数据保存 | 本地 SQLite，持久保存；不需要导出，需要支持查询，供 agent 中断后恢复 |
| 风控处理 | 插件降低请求频率，并**提示**风控信号；暂停、重试还是放弃，由 agent 判断 |
| 写操作确认 | 插件不拦截。需要用户确认时，由 agent 和用户确认（例如询价整批确认一次） |
| 预算数值 | 采用 §4.2 的建议值作为初始配置，实测后再调整 |
| 新建会话 | 先做只读取证，再实现 |

## 2. 架构

```text
agent ──HTTP + SSE（127.0.0.1）──► host（Node 进程）──stdio──► 扩展 SW ──► 闲鱼页面（MAIN world）
                                     │
                                     └── SQLite
```

只有两个部分：

| 部分 | 职责 |
|---|---|
| `apps/host` | Chrome 通过 `connectNative` 启动的 Node 进程。对 agent 提供 HTTP + SSE；请求节奏队列、缓存、风控信号统计；读写 SQLite |
| `apps/extension` | 执行器。SW 启动时连接 host，按方法名调用闲鱼页面中的平台 host 和聊天 host，再把结果返回；把聊天实时消息、滑块弹窗、账号变化作为事件推给 host |

目录：

```text
packages/protocol   方法表、事件、错误码（类型）
apps/host           stdio 协议、HTTP/SSE、SQLite、节奏队列、缓存
apps/extension      SW：connectNative、方法分发；content：平台 host、聊天 host
legacy/             现有代码，只作参考
```

要点：
- 扩展不处理业务规则，只执行。节奏、缓存、记录都在 host，方便在 Node 中测试，也方便持久化。
- 只要 native 连接存在，SW 就会保持存活（Chrome 文档说明，需要在本项目验证）。SW 被回收时，扩展在下次启动时重新连接。
- host 进程随浏览器启动和退出。浏览器关闭时 HTTP 不可用；SQLite 中的数据保留，浏览器再次打开后可以继续查询。如果以后需要在浏览器关闭时也能查询，再把 HTTP 和 SQLite 拆成独立常驻进程。
- 现有代码中可以复用的：`mtop-client`、`sign`、`errors`、`captcha-detector`、`websocket` 监听、`send-transport`、`history`、`parser`、`normalizer`、`my-items`、`direct-publish-api/page`。
- `refactor/extension-api-skeleton` 分支中可以参考的结构：`packages/protocol` 的方法表写法（`Api` 类型推导 `Params` / `Result`）、`core/server.ts` 的 `method → handler` 分发、`xianyu/page`（MAIN world host）与 `xianyu/sw`（SW 侧客户端）的分层、发布模块的幂等审计。**不参考**它的 IM 长连接和定时探测（见 §2.1）。

### 2.1 从 `refactor/extension-api-skeleton` 分支吸取的教训

该分支（worktree `task-api`，Issue #47）的代码结构可以参考，但它的运行方式风控风险高，本分支不沿用：

| 该分支的做法 | 风险 | 本分支的做法 |
|---|---|---|
| SW 自己建立 IM 长连接（`xianyu/im/connection.ts`），连不上时每 30 秒重连，注册失败时强制重新取 token | 频繁调用 `mtop.taobao.idlemessage.pc.login.token`，实测在这个接口上触发了滑块（见该分支提交 `cb8ced6`） | **不自建 IM 连接**。只复用闲鱼网页自己的 WebSocket：读消息靠监听，发消息在页面已有连接上发送。页面没有聊天连接时返回 `PAGE_NOT_READY`，不自己补连 |
| `chrome.alarms` 每 30 秒唤醒并重连 | 后台持续产生请求，没有业务需要时也在请求 | **没有定时器产生闲鱼请求**。所有闲鱼请求都由 agent 的调用触发。扩展只重连 host（本地进程，不涉及闲鱼） |
| 账号状态周期探测（`modules/account.ts` 的 `setInterval`） | 定时调用 `loginuser.get` | 账号只从 cookie 读取（`chrome.cookies`，不发请求），cookie 变化时推送 `account.changed` |
| token 过期后自动换取并重试 | 自动重试会放大请求量 | 不自动重试。返回 `LOGIN_REQUIRED` 或原错误，由 agent 决定 |

总原则：**插件不主动访问闲鱼**。插件发出的闲鱼请求只来自 agent 的调用，并且经过节奏队列。闲鱼网页自身的心跳、同步不受插件控制。

## 3. HTTP 约定

- 地址：`http://127.0.0.1:<port>/v1/<method>`，方法都用 `POST`，body 是 JSON 参数；SSE 是 `GET /v1/events`。
- 认证：`Authorization: Bearer <token>`。安装脚本生成 token 和端口，写入 `~/Library/Application Support/FishOps/config.json`（权限 0600）。agent 从这个文件读取。
- 拒绝带 `Origin` 头的请求，作为防网页调用的辅助手段；不是所有请求都带 `Origin`，主要防护靠 token。
- 通用参数 `tag`（可选）：agent 自己的任务或对话 ID。会记录到请求、消息和事件中，之后按 `tag` 查询，用于恢复。

### 3.1 响应

```ts
type Response<T> =
  | { ok: true; data: T; meta: Meta }
  | { ok: false; error: { code: ErrorCode; message: string }; meta: Meta }

interface Meta {
  requestId: string
  fromCache?: boolean
  /** 请求排队等待节奏的时间，单位 ms。 */
  waitedMs?: number
  risk: RiskInfo
}

type ErrorCode =
  | 'BAD_REQUEST' | 'NOT_FOUND' | 'INTERNAL'
  | 'UNAUTHORIZED' | 'ORIGIN_FORBIDDEN' | 'METHOD_NOT_ALLOWED' | 'PAYLOAD_TOO_LARGE'
  | 'TIMEOUT'             // 按 error.phase 区分排队未执行与只读执行超时
  | 'IDEMPOTENCY_CONFLICT' | 'ACCOUNT_CHANGED'
  | 'RESULT_UNKNOWN'      // 写操作已发出，但没有收到结果；不要盲目重发，先查询
  | 'EXTENSION_OFFLINE'   // 扩展没有连接 host
  | 'PAGE_NOT_READY'      // 没有闲鱼页面，或聊天连接没有就绪
  | 'LOGIN_REQUIRED'      // 未登录或 token 过期
  | 'CANCELLED'           // 调用方在排队阶段断开，请求未派发
  | 'RISK_BLOCKED'        // 平台返回风控拦截（验证码、滑块等）
  | 'PLATFORM_REJECTED'   // 平台业务拒绝（参数、违禁词等）
```

### 3.2 风控提示

每个响应都带 `meta.risk`，同时通过 SSE 推送 `risk.signal` 事件。插件强制请求节奏，风控信号只提示，不额外熔断或绕过验证。

```ts
interface RiskInfo {
  /** ok：正常；caution：频率偏高；blocked：最近一次闲鱼请求被风控拦截，之后还没有成功的请求。 */
  level: 'unobserved' | 'ok' | 'caution' | 'blocked'
  observedAt: number | null
  signals: Array<{ code: RiskSignal; at: number; category?: RateCategory }>
  /** 各类请求最近 10 分钟、1 小时、当天的次数，以及建议上限。 */
  usage: Partial<Record<RateCategory, { last10m: number; lastHour: number; today: number; suggestHour: number; suggestDay: number }>>
}

type RiskSignal =
  | 'CAPTCHA'          // 接口返回 RGV587、FAIL_SYS_USER_VALIDATE、x5sec 等，或页面出现滑块
  | 'LOGIN_REQUIRED'
  | 'HIGH_FREQUENCY'   // 某类请求用量超过建议上限
  | 'SEND_FAILURES'    // 连续多次发送失败
```

agent 的建议处理方式（写在接口说明中，由 agent 自己决定）：

| 信号 | 建议 |
|---|---|
| `CAPTCHA` / `level=blocked` | 停止闲鱼请求，通知用户在浏览器中完成验证；之后用 `system.status` 确认恢复 |
| `HIGH_FREQUENCY` | 降低频率，或推迟到下一个小时、第二天 |
| `LOGIN_REQUIRED` | 通知用户重新登录 |

## 4. 降低风控的手段（插件内置）

插件只强制一件事：**请求节奏**。其他都是提示。

### 4.1 节奏队列

- 所有闲鱼请求按类别排队，串行执行。每两个请求之间等待“最小间隔 + 随机增量”。
- agent 可以用参数 `minIntervalMs` 把间隔调大，不能调小。
- 排队时间在 `meta.waitedMs` 中返回。HTTP 请求会一直等待，直到请求执行完成；排队超过 `maxWaitMs`（默认 120 秒，可以调大）时返回 `TIMEOUT`，请求没有执行。
- 一次 API 调用内部有多个闲鱼请求时（例如 `publish.prepare`），每个内部请求都按类别计入节奏和用量。

### 4.2 类别与建议值

| 类别 | 包含 | 最小间隔 | 建议上限（小时 / 天） |
|---|---|---|---|
| `search` | 搜索翻页 | 1500ms + [0, 1500ms] | 60 / 300 |
| `detail` | 商品详情 | 1500ms + [0, 1000ms] | 100 / 500 |
| `light` | 建议词、我的在售 | 1000ms | 60 / 300 |
| `chatRead` | 会话列表、历史消息 | 300ms | 120 / 1000 |
| `chatOpen` | 新建会话 | 30s + [0, 60s] | 10 / 30 |
| `chatSend` | 发送消息 | 10s + [0, 10s] | 30 / 150 |
| `publish` | 发布提交 | 5 分钟 | 3 / 10 |

间隔是强制值；上限只用于触发 `HIGH_FREQUENCY` 提示。数值写在配置文件中，没有实测。

### 4.3 其他手段

- **缓存**：搜索结果缓存 15 分钟，详情缓存 30 分钟，都存在 SQLite 中。agent 可以传 `maxAgeSec: 0` 强制刷新。
- **复用会话**：`chat.open` 对已经有会话的商品，直接返回已有 `sessionId`，不再发请求。
- **发送幂等**：`chat.send` 必须带 `idempotencyKey`。执行前先写入 `attempting`；重复调用时返回已有结果。结果未知（`attempting` 或 `unknown`）时返回 `RESULT_UNKNOWN`，不重新发送，agent 用 `chat.sync` 核对。
- **账号隔离**：缓存、会话、消息、幂等键都按当前账号 `userId` 区分，切换账号时不串数据。
- **只用实时消息**：新消息来自页面 WebSocket 推送，不轮询历史。只有 agent 主动调用 `chat.sync` 时才拉取历史。

## 5. 方法清单

### 5.1 系统

| 方法 | 用途 |
|---|---|
| `system.status` | 扩展是否连接、闲鱼页面和聊天连接是否就绪、当前账号 `{ userId, nick }`、插件版本、`RiskInfo` |
| `system.ensureReady` | 没有闲鱼页面时打开一个非激活 tab，等待平台 host 和聊天连接就绪 |

### 5.2 搜索

| 方法 | 类别 | 参数 | 返回 |
|---|---|---|---|
| `search.items` | `search` | `keyword`、`page`（默认 1）、`rowsPerPage`（≤30）、`filter.publishDays`、`maxAgeSec` | `{ items: ItemSummary[], hasMore }` |
| `search.suggest` | `light` | `keyword` | `string[]` |
| `item.detail` | `detail` | `itemId`、`maxAgeSec` | `ItemDetail` |

- 一次调用只搜一页。翻几页、搜哪些关键词、什么时候停，都由 agent 决定。
- `filter` 当前只支持 `publishDays`（1～365 的整数）。价格范围与包邮筛选尚未取得可验证的服务端映射，公共 schema 明确拒绝这些字段，不能假装已支持。
- `ItemSummary`：`itemId`、`title`、`price`、`image`、`sellerId`、`sellerNick`、`city`、`wantCnt`、`publishedAt`、`url`。
- `ItemDetail`：`ItemSummary` 加上 `description`、`images`、`status`（在售 / 已售）、`browseCnt`、`collectCnt`。

### 5.3 询价（聊天）

| 方法 | 类别 | 参数 | 返回 |
|---|---|---|---|
| `chat.open` | `chatOpen` | `itemId`、`idempotencyKey` | `{ sessionId, peerUserId, created }` |
| `chat.send` | `chatSend` | `sessionId`、`text`（≤2000 字）、`idempotencyKey`、`tag` | `{ messageId, sentAt }` |
| `chat.conversations` | 本地 | `tag`、`itemId`、`updatedAfter`、`limit` | 会话列表（读 SQLite） |
| `chat.messages` | 本地 | `sessionId` 或 `tag`、`afterSeq`、`limit` | 消息列表（读 SQLite） |
| `chat.sync` | `chatRead` | `sessionId`（可选；不传时同步会话列表） | 新增条数 |

- `chat.open`：`main` 中没有这个能力。询价分支已经取证过一次（单样本，见该分支 `docs/active-conversation-verification.md` §3）：路由 `/r/SingleChatConversation/create`，`pairFirst` / `pairSecond` 是双方 `userId@goofish` 升序排列，成功时返回 `singleChatConversation.cid`；重复 create 曾返回 500，所以要先查已有会话再新建。M4 在**页面已有的聊天连接**上发这个请求，并用自己控制的测试商品复核一次，按 [测试授权](workflow/test-authorization.md) 执行。
- 一次询价 = agent 对每个商品调用 `chat.open` + `chat.send`。批次、截止时间、总结都由 agent 管理；插件按 §4.2 的节奏执行发送。
- 实时消息（收到和发出）都写入 SQLite，并推送 `chat.message` 事件。

### 5.4 发布

在现有直发两阶段接口上包装（见 [direct-publish-api.md](direct-publish-api.md) §11）。

| 方法 | 类别 | 参数 | 返回 |
|---|---|---|---|
| `publish.prepare` | `detail` | `source`（`{ itemId, imageIndexes? }` 或 `{ product: { description, price, images, specifications? } }`）、`idempotencyKey`、`tag` | `{ prepareId, draft, propertyCards, warnings }`；失败时返回 `failureStage`、`missingFields` |
| `publish.submit` | `publish` | `prepareId`、`draft`（可修改白名单字段）、`confirm: true` | `{ status: 'published' \| 'rejected' \| 'unknown', itemId? }` |
| `publish.get` | 本地 | `prepareId` 或 `idempotencyKey` | 记录和结果 |
| `myItems.list` | `light` | `page` | 当前账号的在售商品 |

- 保留现有规则：类目和属性只能从 `propertyCards` 中选；`unknown` 结果不要自动重试，先用 `myItems.list` 核对。
- `prepareToken` 保存在插件内，agent 只使用 `prepareId`。

### 5.5 恢复与查询

| 方法 | 用途 |
|---|---|
| `GET /v1/events` | SSE。支持 `Last-Event-ID` 断点续传；可按 `tag`、`types` 过滤 |
| `events.list` | 按 `afterSeq`、`tag`、`types` 分页查询历史事件 |
| `requests.list` | 按 `tag`、时间范围查询请求记录：方法、参数摘要、结果、风控信号 |

事件类型：`chat.message`、`chat.socket`（连接状态）、`risk.signal`、`account.changed`、`publish.result`。

agent 中断后的恢复步骤：

```text
1. system.status                         → 检查连接和风控状态
2. requests.list { tag }                 → 查看自己已经做过的操作
3. chat.conversations { tag }            → 查看询价会话
4. events.list { tag, afterSeq }         → 补齐中断期间的消息和信号
5. 重新订阅 SSE（带 Last-Event-ID）
6. 中断时没有确认结果的发送 → 用同一个 idempotencyKey 重新调用 chat.send：
   已成功则返回原结果；结果未知则返回 RESULT_UNKNOWN，先 chat.sync 核对，不会重复发送
```

## 6. SQLite

文件：`~/Library/Application Support/FishOps/fishops.db`，WAL 模式，权限 0600。使用 Node 内置的 `node:sqlite`（统一 Node 24 LTS 基线见实施契约；编码前验证），不引入原生依赖。

| 表 | 主要字段 | 用途 |
|---|---|---|
| `events` | `seq`（自增）、`ts`、`type`、`tag`、`data` | SSE 和恢复 |
| `requests` | `id`、`ts`、`method`、`category`、`tag`、`params`（摘要）、`status`、`error_code`、`risk_signal`、`waited_ms`、`duration_ms` | 用量统计、风控信号、恢复 |
| `items` | `item_id`、`summary`、`detail`、`updated_at` | 商品查询和详情缓存 |
| `search_cache` | `key`、`result`、`ts` | 搜索缓存 |
| `conversations` | `session_id`、`item_id`、`peer_user_id`、`tag`、`updated_at` | 会话查询 |
| `messages` | `id`、`seq`、`session_id`、`direction`、`text`、`ts`、`tag` | 消息查询 |
| `sends` | `idempotency_key`、`session_id`、`status`、`message_id`、`ts` | 发送幂等 |
| `publishes` | `idempotency_key`、`prepare_id`、`status`、`item_id`、`draft`、`ts` | 发布记录 |

- 本表是逻辑字段摘要，不是可直接执行的 DDL。账号字段、唯一约束、会话多 tag 关联、查询游标及 state 表以实施契约为准。
- 不保存 cookie 和 token。
- 消息正文保存在本地，供 agent 查询。不写入日志。

## 7. 实施顺序

| 步骤 | 内容 | 完成标志 |
|---|---|---|
| M1 | host + 扩展连通；`system.status`；SQLite `events` / `requests` / `state`；HTTP 认证；SSE；`events.list` / `requests.list` | agent 用 curl 拿到状态，SW 重启后自动重连 |
| M2 | `search.items`、`search.suggest`、`item.detail`；节奏队列、缓存、风控信号 | 连续调用时间隔符合配置；风控码返回 `RISK_BLOCKED` 和信号 |
| M3 | 聊天读：实时消息入库、`chat.conversations`、`chat.messages`、`chat.sync` | 收到消息后能查到，能在 SSE 中收到 |
| M4 | `chat.open` 取证和实现；`chat.send` 幂等 | 对自己的测试商品完成一次询价，重复调用不重复发送 |
| M5 | `publish.*`、`myItems.list` | 受控测试账号完成一次发布 |

每一步按 [工作流](workflow.md) 验收；当前阶段以本地任务文档记录，不创建或更新 GitHub issue。PR 合并后才算 done。

## 8. 其他已确认事项（2026-10-17）

1. **浏览器关闭时 HTTP 不可用**：接受。数据保存在 SQLite，浏览器再次打开后可以继续查询。
2. **原骨架任务**：[extension-api-skeleton](issues/extension-api-skeleton.md) 已按本设计改写为 M1。
3. **分支**：从 `main` 新建 `feat/agent-api-host`，不在 `refactor/extension-api-skeleton` 上继续开发。
