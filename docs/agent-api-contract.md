# Agent API 实施契约

> 日期：2026-10-17。状态：编码前基线，尚未实施或实测。
> 范围：M1 必须实现的公共契约，以及 M2～M5 不得破坏的扩展约束。

## 1. 文档与决策边界

- 本文是协议、生命周期、恢复与验收的唯一公共契约；设计文档说明架构，M1 plan 说明施工顺序，测试文档说明验证方式。冲突时先修正文档，不自行选择实现。
- 当前只在已有工作区与本地分支工作，不创建或更新 GitHub issue；本地 issue 文档作为任务记录。后续 PR 按项目工作流处理，只有合并才进入 done。
- 允许子代理。通用任务用 `group/auto-deepseek-v4-1-flash`，复杂恢复与定向复核用 `group/auto-gpt-6-luna`；当前不可用的 Claude 渠道不作为依赖。代理写入范围必须分离，主代理负责契约与集成。
- 保留已确认策略：只有请求节奏强制执行，平台风控信号只提示。不新增验证码绕过、自动登录或强制冷却门禁。安全停请求由 Agent 契约落实：收到 CAPTCHA、RISK_BLOCKED 或 LOGIN_REQUIRED 后停止平台调用，通知用户；不得以轮询探测恢复。
- 限速和建议额度不是平台保证的安全值。固定节奏、随机增量都不能证明不会被风控。

## 2. M1 范围与运行环境

M1 仅实现 `system.status`、`events.list`、`requests.list` 和 SSE，以及安装、卸载、构建和测试。三个方法均不访问闲鱼网络。搜索、聊天、发布、ensureReady、节奏调度和缓存属于后续阶段。

- 生产与 CI 基线统一为 Node 24 LTS 的同一具体补丁版本；编码开始时解析并固定到版本文件和 CI，`engines` 为 `>=24 <25`。编码前必须在该版本验证原生 TS 执行和 `node:sqlite`，不以本机 Node 26 通过代替。若依赖不可运行，先修订此基线，不静默更换数据库或运行时。
- Chrome 最低版本为 105（native port 保活所需基础能力）；实际验收记录具体版本。最低版本不等于已经完成兼容性测试。
- M1 仅支持 macOS、单个 Chrome profile、单个部署。默认端口 18790，仅监听 `127.0.0.1`。端口冲突明确退出，不扫描、抢占或杀其他进程。
- host 由 Chrome 启动，native stdin EOF 时退出。SW 停止、重载或浏览器关闭均可能导致 host 退出与 HTTP 连接失败。恢复后重新建连，SQLite 保留；不保证 HTTP 常驻。
- host 收到 EOF、SIGTERM 或 SIGINT 后停止接单、关闭 SSE、清理 pending 与计时器、关闭数据库，在 5 秒截止时间内退出。不把未完成写操作标为成功。

## 3. native 协议与就绪握手

帧格式为 4 字节小端无符号长度及 UTF-8 JSON。双向正文上限统一为 1 MiB，零长度、无效 UTF-8、非法 JSON、非法 Wire、超限或 EOF 半帧均记录脱敏错误并终止通道。stdout 只写协议帧。

沿用 req / res / event，另增加明确的控制帧：

```ts
type Hello = {
  kind: 'hello'
  protocolVersion: 1
  extensionVersion: string
  account: { userId: string; nick: string } | null
}
```

- 每次新 native Port 建立，扩展先读取 cookie，再发送 hello。读取失败则断开并退避，不能把读取异常伪装成退出登录。
- host 验证版本后才置为 ready；握手前 `system.status` 返回 EXTENSION_OFFLINE。版本不兼容关闭通道，不转发业务请求。
- hello 不是业务事件，不直接写 events。host 比较持久保存的最近账号：首次观察或账号确实变化才写 `account.changed`；重连账号未变不重复产生事件。
- 扩展账号读取、cookie 变化与 hello 串行化，防止旧快照覆盖新账号。每次连接使用独立代次，丢弃旧连接响应与回调。
- host 生成 UUID requestId；并发响应按 id 匹配。未知或迟到响应丢弃并记录计数，不重放请求。
- 断线退避为 1、2、4、8、16、30 秒，上限 30 秒；收到有效连接并完成 hello 后重置。不得产生重复 Port。宿主进程退出后由 Chrome 下次启动或明确扩展唤醒动作恢复，不承诺停止 SW 后定时器仍运行。

## 4. HTTP 与错误

- 仅接受 `POST /v1/<method>` 的 JSON 对象，以及 `GET /v1/events`。请求体上限 64 KiB；拒绝数组、null、未知参数和不合法参数。HTTP body 不读取到内存上限之外。
- 所有路由包括 SSE 都验证 Bearer token；缺失或错误返回 401；存在 Origin 头（含 null 或空值）返回 403。token 使用恒定时间比较；不启用 CORS，不在 URL 接受 token。
- HTTP 状态：成功 200；BAD_REQUEST 400；NOT_FOUND 404；方法不允许 405；body 超限 413；EXTENSION_OFFLINE / PAGE_NOT_READY / LOGIN_REQUIRED 503；TIMEOUT 504；RESULT_UNKNOWN、IDEMPOTENCY_CONFLICT、ACCOUNT_CHANGED、RISK_BLOCKED、PLATFORM_REJECTED 409；CANCELLED 499；INTERNAL 500。SSE 建连前错误为同样的 JSON envelope。
- envelope 沿用设计的 ok/data/error/meta，认证与路由失败也返回 requestId。`error` 可选增加 `phase: 'queue' | 'read' | 'write'` 与 `retryable: boolean`，不返回堆栈或平台原始响应。
- TIMEOUT/queue 只表示尚未执行；必须从队列移除，之后绝不执行。TIMEOUT/read 表示只读请求发出后未收到结果，不自动重试。写入一旦发出但结果不明，统一 RESULT_UNKNOWN/write、retryable=false。
- CANCELLED/queue 表示调用方在排队阶段断开，请求未派发；已派发请求不因调用方断开而提前释放文档锁或调度槽。HTTP 客户端断开时取消尚未派发请求；已派发只读响应可丢弃，未来写入仍须完成结果落库。
- M1 bridge 只读默认超时 30 秒；测试通过显式隔离配置缩短。页面只读执行默认等待 60 秒，超时返回 TIMEOUT/read，但底层请求继续占用文档锁，必须等真实终结或文档销毁后才允许下一步。
- M1 未知方法不进入扩展。`system.status` 必须经过真实 bridge 响应，返回版本、账号、`page: { present: boolean }`、`chatReady: null`；null 表示未观测，不把有 tab 等同于平台 host 或聊天已就绪。
- `meta.risk` 使用 `level: 'unobserved' | 'ok' | 'caution' | 'blocked'`，增加 `observedAt: number | null`；usage 使用 Partial<Record<RateCategory, Usage>>。M1 固定 unobserved/null/空 signals/空 usage，不代表平台健康。本地成功、缓存命中不能清除平台风控信号。

## 5. 本地查询、事件与账号隔离

- 所有业务标识符为字符串，时间为 UTC Unix 毫秒。序号为十进制字符串，对 SQLite INTEGER 无损转换，禁止用 JS Number 承接大序号。
- M1 数据表：`events`、`requests`、`state`。state 保存最近账号观察与 schema 状态；不得保存 cookie/token。后续账号数据显式加 account_id；匿名状态只能查匿名系统记录，不能默认为所有账号。
- 每条请求在接受后记录 running，完成后更新 succeeded/failed；崩溃留下的 running 在启动时标 interrupted。认证、非法 body 不持久化请求正文，只记录脱敏计数。
- `requests.list` 查询自身不入 requests，防止观察改变历史和用量；events.list、system.status 入库但 category=null，不计平台用量。查询结果不包含当前未完成调用的虚假成功结果。
- `events.list` 参数：afterSeq（默认 "0"）、types（至多 20 个已知事件类型）、tag（1～128 字符）、limit（默认 100，1～500）。返回 `{ items, nextAfterSeq, hasMore }`。
- `requests.list` 参数：afterId（默认 "0"）、tag、fromTs（含）、toTs（不含）、limit（默认 100，1～500）。按 SQLite 内部递增行号分页；afterId 是返回的十进制游标，不是 UUID。返回 `{ items, nextAfterId, hasMore }`；不得只用时间戳分页导致同毫秒漏项。
- 两种查询仅返回当前已观察账号的数据和匿名系统记录。退出后不暴露上一账号记录；事件中旧账号仅表达退出或切换，不携带旧聊天正文。后续 messages、sends、publishes、缓存均采用 account_id 范围唯一约束。
- SSE 参数复用 events.list 的 types/tag/afterSeq；兼容既有 after 查询名，但两者同时出现报 BAD_REQUEST。Last-Event-ID 优先，头存在但非法不能回退。连接开始时固定账号范围，切换账号推送一次 account.changed 后主动关闭；客户端重新获取状态并订阅，禁止连接静默变更数据范围。
- 事件先落库后推送，id 使用全局 seq。回放与实时交接以数据库高水位连接，保证边界无漏项；一个连接内不重复。跨断线允许重投，消费者必须按 seq 去重。过滤不能重编号。
- 每 15 秒注释心跳；单客户端待写缓冲上限 1 MiB，超限关闭，由游标恢复。回放按页读取并遵守同一缓冲上限，不能将全部历史一次性装入内存。M1 不裁剪历史；后续保留策略必须显式定义游标失效错误，不能静默丢记录。
- 参数摘要采用方法级白名单；不保存文本正文、cookie、token、图片数据或原始错误响应。数据库允许后续保存业务消息正文，但日志和 requests 摘要不允许。
- 私有目录 0700、配置与数据库 0600；WAL/SHM 受私有目录保护。SSE 查询不接受任意账号参数。
- 扩展重载可能留下旧 host。新实例完成 hello 后先有界等待旧实例自然释放端口；旧实例 native 仍在线时必须拒绝接管。仅旧实例 native 已离线时，才允许同部署 token 请求让出端口；接管请求只接受一次，旧实例响应后优雅退出，不能抢占其他本地服务。

## 6. 后续业务不可破坏的约束

- 同一账号共用调度器，平台请求最大在途数为 1；类别间隔与账号总间隔同时满足。总间隔初值 1000ms，分类间隔沿用设计表，调用者只能调大。每个内部网络请求均经过 host 授权的调度槽位；扩展不得在一个大 handler 内自行连续发包。
- M2 实现前确定内部 request-step 协议与失败清理，并补真实网络计数测试；不能以一次 prepare 一个槽位替代内部逐请求限速。
- 最近派发时间和用量持久化；重启不清零，跨类别不能绕过。最大等待队列 100，超限返回 BAD_REQUEST 且不派发；每项默认 maxWaitMs=120000，上限 600000。长类别间隔可能导致超时，调用方可增大等待或稍后重试。
- 风控统计按真实平台尝试计数，本地查询和缓存命中不计。当前固定配置没有安全额度保证。
- 写操作绑定入队账号，执行前核验；账号变化返回 ACCOUNT_CHANGED，不迁移到新账号执行。账号切换使旧 prepare 失效。
- chat.open、chat.send、publish.prepare 使用账号范围幂等键；publish.submit 由账号+prepareId 唯一约束保证一次提交。同键同规范化参数返回已有状态；同键异参返回 IDEMPOTENCY_CONFLICT。请求散列包含操作、账号、目标与业务参数，不包含 tag、等待参数等元信息。
- 意图落库后才允许派发；attempting/unknown 不自动重放。进程恢复把未确认 attempting 转 unknown；平台成功后响应丢失仍可查询。聊天历史匹配只能提供核对证据，不能仅凭相同文本证明某次发送成功。
- 同一会话可关联多个 tag，使用关联表，不用单列覆盖。实时消息先按账号+平台消息 ID 去重落库，再关联任务并推送；无稳定 ID 时定义复合去重键并单独测试。
- “对话管理”当前范围只含列表、历史、同步、建聊、发送。不包含删除、归档、标已读、订单和支付。
- 业务网络失败、风控或 token 过期不自动重试；只重连本地 native host。不建立自有 IM 长连接。

## 7. M1 必测与交付门槛

| 场景 | 动作 → 状态 → 可见结果 → 副作用 |
| --- | --- |
| 握手 | host 已启动但无 hello → 调状态 → EXTENSION_OFFLINE；hello 后调用 → 实际扩展响应 → 无平台网络 |
| 账号读取异常 | cookie API 抛错 → 不发布假退出 → 断线退避 → 旧账号不被 null 覆盖 |
| 恢复 | 停止 SW/关闭专用浏览器 → HTTP 可断开 → 明确唤醒/重开后恢复 → 历史可查询 |
| 账号切换 | SSE 订阅中切换 → account.changed 后连接关闭 → 新订阅只见新范围 → 不泄露旧消息 |
| 查询 | 同毫秒写多条记录后分页 → 每项恰好查到 → 重启继续查询 → 不重置游标 |
| SSE 边界 | 回放期间插入事件 → 按 seq 连续交接 → 无漏项，客户端可去重 → 心跳不入库 |
| 安全 | 错 token、Origin、超限/非法帧 → 明确失败 → 不调用 handler → 日志数据库无秘密 |
| 清理 | EOF/信号/慢客户端 → 限时结束 → pending 与资源释放 → 数据保留 |

M1 全部必测包含离线单测、真实生产 host 进程集成、临时安装与产物检查，以及真实 Chrome 最小冒烟。登录切换、自然休眠和一小时静默观察属于独立专项，未执行必须标注，不冒充通过。M2～M5 另补业务故障矩阵和受控真实验收，不以 M1 通过代表业务完成。

## 8. 复核补充：交付语义与后续细化门槛

- M1 的账号事件采用持久最近快照比较，保证重新连接后最终账号状态收敛，不保证断线期间每次登录/退出转换都被保留；SSE 续传只保证已经落入 host 数据库的事件不丢。不得宣传全链路无损。
- M3 在实现聊天前增加来源事件 ID、持久 outbox 与 host 落库 ACK；重复事件按账号和来源 ID 去重。outbox 设字节及条数上限，满时标记同步缺口并提示 Agent 主动 chat.sync，不能静默丢弃或无限增长。页面未打开或插件未观察到的消息只能通过历史同步补齐。
- M1 system.status 的 data 固定为 `{ protocolVersion: 1, hostVersion: string, extensionVersion: string, nativeConnected: true, capabilities: string[], account: { userId: string, nick: string } | null, page: { present: boolean }, chatReady: null }`。capabilities 只列已实施方法；meta.risk 不在 data 重复。未知/离线返回错误 envelope，不伪造成功结构。版本不兼容发生在握手阶段，host stderr 记录原因，不继续业务转发。
- 本地错误补充映射：UNAUTHORIZED→401、ORIGIN_FORBIDDEN→403、METHOD_NOT_ALLOWED→405、PAYLOAD_TOO_LARGE→413；这些代码纳入 protocol 的 ErrorCode。平台错误沿用第 4 节的非 200 映射，不混用两套 HTTP 语义。
- M2 调度按请求开始时间计算间隔，同时限制在途数；已到期项按入队顺序派发，未到期的长冷却项不阻塞其他类别。10 分钟和小时使用滚动窗口，today 按 Asia/Shanghai 日历日计算。时钟回拨不得缩短冷却。
- 缓存键包含账号、方法及规范化业务参数（包含页码、每页数、筛选条件），不包含 tag、maxAgeSec 或等待参数。仅缓存完整成功结果；有效缓存年龄取调用方 maxAgeSec 与默认 TTL 的较小值，0 强刷。发布成功失效对应详情及我的商品缓存。
- M2 平台执行上下文绑定固定 tabId 和文档代次，导航、关闭或替换导致 PAGE_NOT_READY；不自动换 tab 重放。执行前再次核验账号。M1 仅报告是否存在 tab，不需要打开或绑定执行 tab。
- M4 使用统一 operations 表记录账号、方法、幂等键、规范化参数指纹、状态及结果；sends/publishes 可保存业务明细但不能各自重复决定幂等状态。默认不清理操作记录；未来清理必须保证过期 key 不被当成新请求重复执行。submit 的最终 draft 指纹在第一次尝试时锁定，同 prepareId 修改 draft 再次提交返回 IDEMPOTENCY_CONFLICT。
- M2/M3/M4/M5 各阶段开始前必须补齐对应方法的声明式 schema、DDL 迁移与故障测试矩阵，再进入编码；这属于计划内细化，不声称本次已经验证平台协议或完成全部阶段详细设计。

## 9. M2 实施入口

[M2 实施与验收契约](m2-implementation-plan.md) 记录参数边界、单请求调度、内部单步与缓存迁移要求。当前纯参数模块已实现，调度模块正在实施；商品公共路由、页面执行和真实商品 E2E 尚未接通。M1 capabilities 不提前列出 M2 方法。细化文档不得改变本文已确认的风险提示、逐请求限速和不自动重放策略。

## 9. M1 编码基线记录

- 2026-10-17：固定 Node 24.22.0（`.node-version`）；已用对应 darwin-arm64 官方分发验证原生 TS 与内存 SQLite。构建、进程集成和安装检查继续使用该版本。
- 旧工作台源码、package 信息和技术原理保存在 legacy；新工作区和 CI 不扫描旧模块。

## 10. M3 持久消息存储权限补充

M3 为消息 outbox 增加扩展 `storage` 权限。仅使用 `chrome.storage.local`，设为 `TRUSTED_CONTEXTS`，不使用 `storage.sync`。消息先持久化再发送 native `chat-delivery`；host 核对当前账号、提交消息与事件事务后才发送 `chat-ack`。仅有消息 schema 或存储适配器不代表聊天生产能力已经注册或完成 E2E。

## 运行中扩展构建身份

- native `hello` 可选携带 `extensionBuildId`，用于标识一次扩展构建。旧扩展省略时不推断身份。
- `system.status.data.extensionBuildId` 返回当前 native 握手的构建标识；旧扩展为 `null`。该值不从扩展状态响应或安装记录推导。
- 构建标识不是版本号，也不是内容哈希。构建清单单独记录最终产物 SHA-256；冒烟需要同时验证握手标识和清单中的各产物哈希。
- 这项证据只对应运行中 Service Worker。不能据此证明已有标签页加载了相同 MAIN world 代码，也不能证明 Host 进程来源。

## 风控熔断与人工交接（2026-10-18）

- 任一平台方法返回 `RISK_BLOCKED` 后，Host 对当前账号开启熔断，默认 30 分钟（`FISHOPS_RISK_COOLDOWN_MS` 可调）。
- 熔断期间，触达平台的方法（`search.*`、`item.detail`、`chat.sync`、`chat.send`、`publish.*`）直接返回 409 `RISK_BLOCKED`，`phase` 为 `queue`，不派发请求。
- 本地读取（`chat.messages`、`chat.conversations`、`events.list`、`requests.list`、`system.status`）不受影响。
- `risk.status {}`：返回 `{ accountId, blocked, blockedUntil }`。
- `risk.clear { manualVerified: true }`：人工在浏览器完成平台验证后调用，解除熔断。缺少 `manualVerified: true` 返回 400。Agent 不得在未经人工确认时调用。
- 熔断状态按账号存入 SQLite，Host 重启后继续生效，到期读取或人工解除时清理。
- 系统支持自动完成平台滑块验证（2026-10-18 起，见「自动滑块验证」章节）。自动方案失败或超限时不重试、不伪造成功，一律回落到人工验证。
- 写操作在 `write` 阶段遇到风控时，操作记录为 `unknown`。调用方必须先用 `chat.messages`（先 `chat.sync`）或 `publish.myItems` 核对，不得换键重发。

## 自动滑块验证（2026-10-18）

本章替代 2026-10-18 早前「不自动完成平台验证码」的约束。自动滑块只处理平台已弹出的滑块类验证，不触碰登录、不替换账号凭据、不改变请求节奏策略。

### 能力边界

- 只对已检测到的滑块验证弹窗执行一次拖动；同一平台步骤内最多一次尝试，不循环重试。
- 只处理滑块类（baxia / nc 系）验证。短信、扫码、人脸等非滑块类型一律不自动处理，直接回落到人工验证。
- 不读取、不外传验证码图片内容、`ncSessionID`、`_n1_token` 等风控内部字段；只报告结果状态。
- 不因为自动验证成功就清除熔断或伪造 `risk.level`；熔断状态仍按前述章节由 `risk.signal` 与人工解除驱动。
- 自动验证的输入是页面真实 DOM 与真实鼠标事件，不伪造 `navigator.webdriver`、不改页面指纹、不注入平台脚本。

### 执行链路

- 检测沿用既有 DOM 判定：`.baxia-dialog`、`iframe[src*="punish"]`、`#nocaptcha` 等；命中后步骤失败改判 `RISK_BLOCKED` 的既有行为不变。
- 拖动由页面 MAIN world 内完成：取滑块手柄与轨道矩形，计算目标位移，按人类节奏派发 `mousedown` → 多次 `mousemove` → `mouseup`。
- 位移来源只允许页面 DOM 可观测的缺口位置或滑块最大行程；不使用逆向得到的固定像素值。
- 拖动结束后轮询验证弹窗是否消失；消失即视为通过，未消失视为失败。

### 结果分类

| 结果 | 步骤错误码 | 后续行为 |
|---|---|---|
| 拖动后弹窗消失 | 原业务错误继续透传 | 调用方按既有语义重试（新幂等语义），不自动重放原步骤 |
| 拖动后弹窗仍在 | `RISK_BLOCKED` | 熔断并交人工，与既有行为一致 |
| 未找到滑块或非滑块类型 | `RISK_BLOCKED` | 熔断并交人工，不猜测、不重试 |
| 拖动执行异常 | `RISK_BLOCKED` | 熔断并交人工，异常详情不外传 |

### 不做

- 不做纯协议验证：逆向 token 与浏览器 TLS / IP / 指纹强绑定，脱离浏览器无法复用。
- 不做多账号批量验证、不做验证码代打、不关闭或隐藏平台弹窗绕过检测。
- 不把自动验证成功率写进承诺；自动方案只是减少人工介入频率，不改变风控本质。
