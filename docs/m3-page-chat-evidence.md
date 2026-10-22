# M3 页面聊天只读取证与接入设计

日期：2026-10-18。证据类型：本工作区静态源码。状态：设计建议，尚未实施和平台验收。

## 1. 结论与范围

可以在 MAIN world 观察页面自行建立的聊天 WebSocket，并复用同一个 socket 请求会话列表和历史。不得由扩展创建 IM 连接、登录、注册连接或发送保活包。被动监听不发送任何 socket 数据；主动 `chat.sync` 会发送只读 LWP 查询，属于平台请求，必须逐页经过 host 调度。

本轮只新增本文。未调用浏览器、未发平台请求、未发送消息、未读取运行环境中的账号或凭据。源码中的字段名称仅用于说明边界，本文不含真实账号或 token。未重复 M2 生命周期复核。

重要限制：构造器包装只能观察安装之后由页面创建的连接，不能枚举浏览器中已经存在但未暴露引用的 WebSocket。安装过晚且没有可复用的已捕获引用时，必须报告聊天未观测/未就绪，不能通过新建连接、自动刷新页面或后台轮询补救。

## 2. 静态证据索引

以下引用为工作区相对路径及本次读取时的一基行号。它们证明旧实现的调用关系，不证明当前平台协议仍可用。

| 证据 | 文件与入口 | 事实与接入判断 |
| --- | --- | --- |
| E1 | `legacy/extension/src/chat/websocket.ts:129`，`wrap`；`:149`，`observe`；`:195`，`dispose` | wrapper 仅在页面调用构造器时委托原构造器创建一个 socket，再安装监听；同 socket 幂等观察。提取函数只接受字符串数据。可迁移纯监听逻辑，不能主动调用构造器。 |
| E2 | `legacy/shared/chat/protocol.ts:70`，`isTargetChatWebSocket` | 按 hostname 精确识别目标连接，不使用 substring；新实现还需校验 `wss:`、允许端口及拒绝 URL 用户信息，不能把旧判定当完整 URL 安全校验。 |
| E3 | `legacy/extension/src/chat/chat-host.ts:62`，`createChatHost` | 保存页面捕获的 socket；`:82` 先匹配查询响应，再上报未匹配帧；`:85` 限制原文长度。旧模块同时创建 markRead transport，不宜原样迁移。 |
| E4 | `legacy/extension/src/content/chat-main.ts:36`，`installChatHost` | 组合 monitor 与 transport，并通过 postMessage 上报；但 `:39` 创建 sendHost、`:63` 暴露 markRead、`:85` 安装发送 host。文件头“只读”描述不足以证明当前入口纯只读。禁止整体复用。 |
| E5 | `legacy/extension/src/chat/socket-transport.ts:60`，`validateAllowedLwpRequest`；`:151`，`send`；`:192`，`handleMessage` | 精确限制两条只读 LWP 路由、信封字段和参数；按 mid 关联查询响应；唯一 socket.send 位于 `:179`。可参考双端白名单和响应关联。 |
| E6 | `legacy/extension/src/chat/history.ts:184`、`:189`、`:215`、`:240` | 构造单页会话/历史请求并解析结果；`:258`、`:277` 是内部自动分页，不能直接作为新调度单步。 |
| E7 | `legacy/extension/src/chat/parser.ts:241`、`:724`、`:794` | 兼容 MessagePack/base64 JSON，处理 syncPushPackage 对象型和字符串型数据及历史模型；`:396` 汇聚消息模型。适合抽取为纯解析测试入口。 |
| E8 | `legacy/extension/src/chat/sync.ts:77`、`:185`、`:266`、`:302` | normalizeMessage、防重复摄入、历史同步、会话同步。历史检查账号代次和游标进展；会话同步还会调用资料 resolver，不能照搬。 |
| E9 | `legacy/shared/chat/protocol.ts:157`，`buildMessageKey` | 有平台消息 ID 时使用 ID；否则用会话、发送者、时间、正文拼接。不是账号范围键，也不是无碰撞证明，且键包含正文。只能作为迁移参考。 |
| E10 | `legacy/extension/src/chat/background-transport.ts:47`、`:100`、`:112` | background 校验后通过 executeScript 调用 MAIN transport；旧调用只固定 tabId，没有 documentId，不满足新契约。 |
| E11 | `legacy/extension/src/content/isolated-bridge.ts:42` | 校验 source/origin 和受限事件类型，再 runtime.sendMessage；不允许网页任意调用扩展高权限命令。仅同源校验仍不能阻止同页面脚本伪造事件。 |
| E12 | `apps/extension/src/page-entry.ts:1`；`apps/extension/src/page-client.ts:27`；`apps/extension/src/page-bootstrap.ts:94` | 当前 MAIN 入口注册页面 runtime；客户端固定 documentIds、调用前后核验并校验单步结果；bootstrap 在固定文档部署。它们提供调用方式，不提供现成聊天监听通道。 |

当前 `apps/extension/src/manifest.json` 在主站 `document_start` 注入 MAIN 文件，但该入口只注册初始化函数，没有安装聊天 monitor，也没有 ISOLATED 消息转发脚本。`apps/extension/src/connection.ts` 的业务步骤与 native 连接可作为扩展点，不能把现有账号事件帧当作已经支持聊天事件、outbox 或落库 ACK。

## 3. 可行的被动监听链路

### 3.1 旧链路与新链路

旧链路为：页面构造 socket → monitor.observe → chat-host.handleSocketMessage → CHAT_SOCKET_EVENT → window.postMessage → isolated-bridge → background。它具有参考价值，但没有满足新契约的来源事件持久化和 host ACK 语义。

建议的新链路为：

1. MAIN 在 document_start 安装幂等纯监听器。只观察目标 socket，不改写 send、不消费或阻止页面自己的 message 事件，不发送 ACK、已读或保活包。
2. 查询响应按本次查询 mid 与固定 socket 代次匹配；其他候选帧在有界解析后只提取允许的消息字段。不要把任意原始 LWP 帧和连接 URL 上传到 host。
3. 通过新增的窄 ISOLATED 事件桥上报消息批次和粗粒度连接状态。SW 必须核验 Chrome sender 的扩展身份、主 frame、精确主站 URL、tabId/documentId 及绑定范围；网页提供的这些字段不能作为权威依据。
4. SW 将校验后的事件写入有界持久 outbox，再通过 native 发送。来源 ID 在首次入队时固定，重投沿用同一 ID，不每次生成新 ID。
5. host 在事务中按账号与来源 ID 去重，写 messages 和事件关联，提交成功后才 ACK。扩展收到匹配 ACK 才删除 outbox 项。消息查询和 SSE 只能读取已落库数据。

上述为拟议链路，不是现成能力。必须先定义聊天事件、批量大小、ACK、gap 标记与 schema 迁移，之后才允许实现或增加 capabilities。

### 3.2 观察范围和身份限制

- 只覆盖已观察文档上的连接；缺页、晚注入、非字符串帧、解析失败、超限和 outbox 满都可能形成缺口。应标记缺口，不能宣传全链路无损。
- 多个目标 socket 可能并存。不能沿用“最后收到帧的 socket 就是当前 socket”的规则跨连接关联响应；查询固定一个 OPEN socket 和代次，不自动切换重发。
- 缺少可信绑定范围时，不把消息归入任意当前账号。账号切换后的旧文档事件不能重新贴上新账号标签；不靠昵称或正文推断归属。
- MAIN 与网页共享环境。source/origin、随机通道标记和不可覆盖全局属性都不是抵抗同页面脚本的认证机制。页面数据按不可信输入处理；不把页面上报作为写操作授权或发送成功证明。
- 被动消息不增加 API 主动查询用量；页面自身流量不受 host 调度控制，不能宣称限制了整个页面的请求速度。

## 4. 主动 chat.sync 调用链

### 4.1 单页调用

拟议链路：公共 `chat.sync` → host 参数校验与绑定范围 → `chatRead` 调度槽 → 聊天专用内部步骤 → SW 固定文档核验 → MAIN 已捕获且 OPEN 的 socket → 严格只读 LWP transport → 同 socket/代次/mid 响应 → 纯解析与输出 schema → host 事务保存消息和分页进度 → 公共结果。

两条旧协议依据为：

| 读取目标 | LWP 路由 | body 形状 |
| --- | --- | --- |
| 一页会话 | `/r/Conversation/listNewestPagination` | `[maxSortIndex, pageSize]` |
| 一页历史 | `/r/MessageManager/listUserMessages` | `[cid, false, anchor, count, false]` |

这里的 socket.send 仅发送查询信封，不发送聊天内容。“只读”指业务语义，不等于零网络；本轮没有执行上述调用。

每个内部步骤只发送一个查询。旧 history.listAllMessages/listAllConversations 和 sync.syncHistory/syncConversations 的循环不能放在扩展大 handler 中；分页由 host 分步编排。两页就必须两次调度授权，不能用 sleep(300) 代替账号总间隔。旧资料 resolver 的 session.sync/user.query/商品封面补查默认不接入；以后需要时，每个请求另行定义 schema、授权和调度。

### 4.2 失败与数据语义

- 无捕获 socket、非 OPEN 或上下文不符：明确 PAGE_NOT_READY；已有可靠未登录观察才使用 LOGIN_REQUIRED。不得创建连接或尝试登录。
- 查询失败、风控或超时不自动重试，不自动换 tab/socket。只读业务错误使用固定中文文案，不能像旧实现那样仅截断原始异常后返回。
- 旧 transport 在 15 秒超时后移除 pending，但这不证明服务端查询终结。不能原样用该 Promise 的 reject 释放新契约的单步锁。设计必须区分调用者等待超时与底层步骤终结，迟到结果只做终结核对；无法确定终结时保持占用，或在明确观察到固定 socket 关闭后结束该读取步骤，不能重发。
- 分页游标需要声明精确类型；旧安全整数游标只在相同范围下可参考，超出安全整数范围必须拒绝或采用已验证的无损表示。游标不前进、缺失或响应结构不符时不能假报耗尽。
- history.ts 在字段缺失时可回退空列表，并用条数推断 hasMore；新输出需要区分“明确空列表”和“结构不识别”。不能把解析失败项静默过滤后称完整同步。
- normalizeMessage 把缺失时间变成 0、缺失文本变成空串，是旧展示模型语义，不应直接变成公共事实。新 schema 应保留未知语义；无法明确方向时标未知，不沿用旧“未知方向按 in”的展示回退。
- 平台消息 ID 与来源事件 ID 分层去重：前者用于历史和实时交叠，后者用于 outbox 重投。无平台 ID 时需定义规范化复合指纹及碰撞处理，不能用相同文本证明同一消息。指纹必须带账号范围，不在日志输出正文拼接键。
- 消息、去重记录和同步进度同事务提交；部分页失败应返回已提交进度与明确的不完整状态，不把未提交页的游标交给调用者继续。本文不决定完整公共 API 字段，实施前需同步主契约。

## 5. 安全边界与实施门槛

1. 不迁移 send-host、read-transport、markRead、chat.open、聊天发送、订单和支付能力。只迁移纯解析、被动监听和两条查询白名单。
2. SW 和 MAIN 双重校验路由、信封、会话标识、页大小及游标；host 不允许公共调用者提交任意 LWP 路由或原始 payload。绑定上下文由扩展核验，不接受网页自报为凭据。
3. 凭据留在现有页面环境；不得为查询提取、传输或保存连接认证材料。正文仅进入受账号隔离保护的业务存储和获授权响应，不进入 requests 摘要、诊断日志或错误信息。
4. 原始帧、解码后对象、MessagePack 深度和集合数量、单批消息、native 帧及 outbox 条数/字节数都必须有明确上限。旧字符串长度限制不等于 UTF-8 字节上限，单帧仍须满足 1 MiB 协议限制。
5. outbox 满或解析不可恢复时写持久缺口标记，提示 Agent 显式 chat.sync；不静默丢弃、不无限增长、不后台自动补拉。持久化失败不得 ACK。
6. 所有风险信号只按主契约提示 Agent 停止；不加入验证码绕过、隐形探活、强制熔断或安全额度保证。

## 6. 自动化测试入口与验收

本轮仅做内容检查，未运行应用测试。以下是现存可参考的离线入口，不表示这些 legacy 测试已经在当前 Node/目录迁移后通过：

- `legacy/extension/src/chat/test/websocket.test.ts`：假构造器、目标筛选、监听及释放。
- `legacy/extension/src/chat/test/socket-transport.test.ts`：只读白名单、mid 匹配、重复 mid、无 socket、假计时器超时和 dispose；其中也含标已读测试，迁移时只选只读案例。
- `legacy/extension/src/chat/test/history.test.ts`：请求 body、分页、会话与历史模型。
- `legacy/extension/src/chat/test/parser.test.ts`：MessagePack/base64、实时文本/图片、混合 syncPushPackage、畸形输入。
- `legacy/extension/src/chat/test/sync.test.ts`：跨页去重、严格游标进展、账号变化丢弃旧响应；资料 resolver 案例不应自动扩大 M3 请求范围。
- `apps/extension/src/test/page-client.test.ts`、`page-bootstrap.test.ts`：注入式 scripting 与自包含 MAIN 函数，可扩展为聊天固定文档调用测试。
- legacy 的测试注册入口为 `legacy/extension/src/chat/test/register.mjs`；新迁移测试应进入当前 `npm run test:unit`，不能因根目录不扫描 legacy 就声称已覆盖聊天。

拟议自动验收矩阵：

| 动作 | 状态与可见结果 | 副作用断言 |
| --- | --- | --- |
| 安装 monitor，再由假页面创建目标连接 | 捕获一个 socket；重复安装不重复监听 | 扩展主动构造次数为 0；被动路径 send 次数为 0 |
| monitor 安装前已存在未暴露连接 | 未观测/PAGE_NOT_READY | 不枚举秘密、不刷新、不新建连接 |
| 目标帧、非目标帧、二进制帧、超限及深嵌套帧 | 仅合法消息归一；缺口可见 | 无原始帧/凭据进入日志，无页面事件被阻断 |
| 请求一页会话或历史 | 固定 socket/文档、合法 mid 响应被解析 | 一个授权仅一次 send；markRead/发送路由为零 |
| 两页同步与混合实时推送 | 每页独立槽位；历史/实时交叠去重 | 两页恰好两次查询，无资料补查 |
| 超时后迟到响应、错误 mid 或不同 socket 响应 | 调用者超时但锁不早释放；只匹配原步骤 | 无重试、无换 socket 重放 |
| 同一来源事件重复投递、ACK 丢失再投 | host 只提交一次；ACK 后删除 outbox | 无重复消息事件，无未落库 ACK |
| outbox 满、host 写失败、批次过大 | 持久缺口/明确失败；同步状态不假完整 | 有界内存磁盘，不泄露正文，不推进未提交游标 |
| 绑定范围变化或旧文档延迟上报 | 旧事件拒绝或保留原范围，不能转属当前范围 | 无跨账号数据读取或落库 |
| 释放监听器与查询 transport | 监听、pending、定时器清理 | 不关闭页面自己的 socket，不恢复覆盖他人 wrapper |

假页面与合成消息可验证上述逻辑，不能证明真实 LWP 仍适配。真实平台兼容性验证另行授权，本轮不执行。

## 7. 交付状态

证据 E1～E12 → 判断：存在可复用的页面连接观察、单页 LWP 读取与纯解析基础，但旧组合入口混有写能力，现有新 MAIN 桥尚无聊天事件持久交付 → 实施路径：先敲定 schema/DDL/outbox/ACK/分页失败契约，再按纯解析、纯监听、单页查询、host 持久化顺序离线实现，最后独立验收平台兼容性。

Orca 未运行，plan/coding/test 阶段状态同步失败；未启动 Orca，不伪造状态。本轮属于纯文档 A 路径，不运行 typecheck、构建或浏览器，不提交 PR，不进入 done。
