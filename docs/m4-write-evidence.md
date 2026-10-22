# M4 页面写操作证据与边界

## 结论

当前证据只足以支持“复用页面已有聊天 WebSocket，发送一条经过严格构造和校验的文本消息”这一窄范围设计。暂不足以实现稳定的会话创建、商品关联写入、发送结果的强一致确认，或任何自动重试策略。

M4 写操作必须满足以下硬约束：

- 仅复用页面已经建立的唯一 OPEN 聊天 socket，不创建新的 IM 连接。
- 账号、`tabId`、`documentId` 和 socket 观测代次必须一致。
- 写操作与页面文档锁绑定，单 step、单次 `send`，禁止并行和自动重试。
- 超时、close、error、账号变化或响应不完整时只能返回“结果未知/失败关闭”；不能声称消息未发送，也不能再次发送。
- 写入前必须通过风控闸；当前证据未证明可以自动绕过或降低平台风控，因此默认停止写操作。
- 测试只能使用 fake socket；不能真实发送消息或访问平台。

## 已确认的发送协议

### 路由和信封

`legacy/extension/src/chat/send-protocol.ts:4-11` 明确记录了发送协议：路由为 `/r/MessageSend/sendByReceiverScope`，外层 `contentType` 为 `101`，`custom.type` 为 `1`，文本内容放在 base64 JSON 中，`actualReceivers` 必须同时包含对方和自己。

`legacy/extension/src/chat/send-protocol.ts:23-35` 定义了发送输入和构造参数：`sessionId`、`receiverId`、`myId`、`content`，以及 `mid`、`uuid`。

`legacy/extension/src/chat/send-protocol.ts:70-72` 确认内层文本结构为：

```json
{"contentType":1,"text":{"text":"..."}}
```

该 JSON 经过 UTF-8 base64 编码。

`legacy/extension/src/chat/send-protocol.ts:110-133` 是当前最完整的信封构造证据。可确认的 body 结构包括：

- `uuid`；
- `cid`，由 session id 转为 `@goofish` 后缀；
- `conversationType: 1`；
- `content.contentType: 101`；
- `content.custom.type: 1` 和 base64 文本；
- `redPointPolicy: 0`；
- `extension.extJson: '{}'`；
- `ctx.appVersion: '1.0'`、`ctx.platform: 'web'`；
- `mtags: {}`；
- `msgReadStatusSetting: 1`；
- 第二个 body 元素的 `actualReceivers` 为对方和自己。

### 输入校验

`legacy/extension/src/chat/send-protocol.ts:75-103` 只允许非空的 `sessionId`、`receiverId`、`myId` 和文本内容；三个 ID 不得带 `@` 后缀；对方 ID 不能等于自己的 ID。该证据不足以证明 ID 与当前登录账号真实绑定，因此实现时必须再次把 `myId` 与当前账号核对，不能信任调用者传入的 `myId`。

`legacy/extension/src/chat/send-protocol.ts:163-216` 对最终 LWP 信封做第二次严格校验：

- 顶层只能有 `lwp`、`headers`、`body`；
- `headers` 只能有非空 `mid`；
- body 必须正好两个元素；
- 消息必须包含合法 `uuid`、`cid`、`conversationType`、外层 content、`custom`、web 平台上下文和扩展字段；
- `actualReceivers` 必须正好两个带 `@goofish` 的不同 ID。

此校验是必要条件，不代表平台一定接受请求，也不代表消息已经投递。

## Socket 复用证据

`legacy/extension/src/chat/send-transport.ts:4-13` 明确要求发送 transport 复用页面已建立的聊天 WebSocket，不直接访问 `window` 或全局 `WebSocket`，socket 由外部 `getSocket` 注入。

`legacy/extension/src/chat/send-transport.ts:41-49` 的依赖只有 `getSocket`、计时器和清理器，说明发送模块本身不应创建连接、刷新 token 或重连。

当前实现的页面观察边界位于 `apps/extension/src/chat-socket-monitor.ts:25-28` 和 `apps/extension/src/chat-socket-monitor.ts:64-79`：只包装页面自身的 WebSocket 构造器，委托页面主动创建，保留静态属性与 `instanceof` 行为；不主动 `new`、不调用 `send`，释放时不关闭 socket。`apps/extension/src/page-chat.ts:45-50` 只返回当前账号观测代次内唯一 OPEN socket；多个 OPEN socket 返回空，账号变化会清空观测集合（`apps/extension/src/page-chat.ts:37-49`）。

因此 M4 必须继续使用这个选择器，不能引入独立 socket、后台 socket 或第二套连接缓存。

## 发送 transport 证据

`legacy/extension/src/chat/send-transport.ts:63-87` 规定了 transport 的单请求接口和发送前校验流程。

`legacy/extension/src/chat/send-transport.ts:92-103` 证明：

- 发送前必须通过独立的发送路由白名单；
- 重复 pending `mid` 被拒绝；
- 无 OPEN socket 返回 `NO_SOCKET`；
- 只读路由不能借发送 transport 放行。

`legacy/extension/src/chat/send-transport.ts:105-120` 证明 pending 应在 `send` 前登记，socket 只调用一次 `send`；发送异常清理 pending 并返回 `SEND_FAILED`。新实现还必须记录“是否已经调用 send”，因为发送异常可能发生在平台已收到数据之后，不能据此安全重试。

`legacy/extension/src/chat/send-transport.ts:123-137` 证明响应按 `headers.mid` 关联，未命中的帧交给实时消息链路。新实现必须进一步绑定 socket 身份、账号和文档代次，不能只按 mid 全局匹配。

`legacy/extension/src/chat/send-transport.ts:141-148` 证明 dispose 会拒绝 pending，但不会关闭页面 socket。M4 还必须在 dispose、close、error、账号变化和超时后阻止后续发送。

发送 transport 的旧实现使用 10 秒超时（`legacy/extension/src/chat/send-transport.ts:105-110`）。该时长只能作为历史证据，不能直接视为当前产品契约；需要在 M4 契约中固定并测试，且超时必须标记结果未知，不得释放写操作的幂等/失败关闭状态。

## 响应和结果语义

`legacy/extension/src/chat/test/send-transport.test.ts:30-46` 只证明成功响应按 mid 命中并完成 pending；它没有证明 `code` 的成功集合、body schema 或服务端业务确认语义。

`legacy/extension/src/chat/send-client.ts:115-141` 将 `isLwpSuccess(response.code)` 视为成功，并以本地生成的 `uuid` 作为 `messageId`，以当前时间作为 `sentAt`。这只能说明旧客户端的本地返回约定，不能证明平台已经持久化消息。尤其是 `send-client.ts:129-132` 会把服务端错误 detail 返回给上层，M4 不应直接照搬，必须固定脱敏错误分类，禁止泄漏平台原文。

已确认的安全语义：

- `code` 成功只能表示服务端响应符合旧客户端成功判定；
- 缺少 `headers.mid`、mid 不匹配、route 不匹配、坏 JSON、坏 body 或连接中断都不能当作成功；
- 超时后结果是未知，不是“发送失败”；
- `send` 抛异常也不能自动重试，因为平台可能已经收到数据；
- 未收到响应不能生成新的 uuid、mid 再发一条。

## 发送结果 messageId 语义与兼容边界

`apps/extension/src/chat-write-transport.ts` 在响应通过校验后，返回响应体中的平台 `messageId`，不再返回本地 `uuid`：

- 平台 `messageId` 必须是非空、长度不超过 128 且不含空白字符的字符串；不满足即按 `RESULT_UNKNOWN` 失败关闭。
- 本地 `uuid` 只用于响应相关性校验：响应体若携带 `uuid`，必须与本次请求一致；它不再作为结果对外返回。
- `sentAt` 仍是本地发送时刻，只表示本地登记时间，不证明平台持久化时间。
- `body` 缺失、`messageId` 非法或 `uuid` 不符时都 poison，不重试、不生成新的 uuid/mid；失败关闭语义不变。

兼容边界：

- 新发送一律返回平台 `messageId`，可与历史消息的 `sourceId` 关联；返回本地 uuid 的旧行为已移除。
- 旧持久幂等结果不迁移：host 侧 `chat.send` 幂等记录（`apps/host/src/chat-write-service.ts` 中以 `succeeded` 落库的 `resultJson`）若已存有历史本地 `uuid`，重复使用同一幂等键仍原样返回该历史结果，不会回填平台 ID。
- 新旧结果不可直接按 ID 互相校验。不得为了获取平台 ID 而换键重发旧消息；旧消息只能通过已有历史证据核对。仅新的、独立授权的业务发送使用新键并返回平台 ID。

## 幂等、账号和文档锁

`legacy/extension/src/chat/send-transport.ts:95-98` 只覆盖 pending 期间的重复 mid，不能覆盖 transport 重建后的重复发送。M4 必须把 step id、请求指纹、mid、uuid 和文档代次纳入文档级去重记录。

当前文档锁实现位于 `apps/extension/src/page-lock.ts:9-39`：同一 `stepId` 且指纹相同会复用原 Promise，参数冲突会拒绝，并发步骤会被拒绝；锁挂在文档 scope 上，跨 runtime 重建仍存在（`apps/extension/src/page-lock.ts:43-54`）。写操作必须使用同一锁，不能为发送另建可绕过的锁。

当前页面 runtime 已将只读步骤接入文档锁，但 M4 写操作还不能直接复用只读分支。需要单独的写方法白名单、写 payload 构造器和写结果分类；不能把写入参数当作任意 `unknown` 透传到 socket。

账号隔离要求：

- dispatch 前确认 `request.context.accountId` 等于页面当前账号；
- 构造 payload 时 `myId` 必须来自当前账号，不能由调用者覆盖；
- send 前再次确认账号、documentId 和唯一 socket；
- 响应前后再次确认账号和 socket 身份；
- 任一检查失败都不能发送或返回成功。

## 风控边界

`legacy/extension/src/chat/README.md:135-145` 规定发送只有显式命令进入，发送路由与只读路由独立，测试不触网且事件不带正文。

但是现有证据没有给出可验证的“风控检查通过”协议，也没有证明可以在发送前可靠判断平台是否要求验证码、二次验证、账号冻结或频率限制。`legacy/extension/src/chat/send-client.ts:129-132` 只按响应 code/message 做旧式分类，不能作为规避风控的依据。

因此 M4 实现必须：

- 在风控状态未知、账号状态未知、socket 代次不明确时停止发送；
- 不自动刷新 token、不自动切换账号、不自动重连；
- 不通过改变 user-agent、headers、时间间隔或隐藏请求规避风控；
- 对明确的风险/登录/平台拒绝返回固定脱敏错误；
- 将未知响应保留为 `RESULT_UNKNOWN` 或等价失败关闭状态，不自动重试。

## `chat-open` / `create` 证据核对

本仓库当前没有找到可引用的 `legacy/extension/src/chat-open.ts`、`legacy/extension/src/chat/create.ts` 或同名的会话创建实现。当前 legacy 聊天目录的写入证据集中在 `send-protocol.ts`、`send-transport.ts`、`send-client.ts` 和 `send-host.ts`。

`legacy/extension/src/chat/send-host.ts:36-49` 只创建发送 host 并注入 `getSocket`；`send-host.ts:51-67` 只暴露一个发送入口，内部仍由 transport 复验 payload。它没有证明如何新建会话、如何通过商品 ID 创建会话、如何处理不存在会话、如何确认服务端会话持久化。

因此以下能力当前明确不能实现或不能宣称完成：

- “chat-open” 或“create conversation”的路由、body 和响应 schema；
- 商品询价场景中的商品 ID 到会话 ID 的服务端绑定；
- 对方账号、自己账号、会话状态和权限的完整服务端校验；
- 写入后消息在双方设备和历史接口中的最终一致性；
- 发送超时后的安全补偿或查询确认；
- 风控通过、验证码处理、账号解冻或频率策略；
- 任何自动重试、自动重连或重复发送保证。

在没有真实脱敏 fixture、协议抓包证据和离线 fake-socket 契约前，不应实现这些缺失部分，也不应以旧的 `clearRedPoint` 或只读路由替代会话创建。`legacy/shared/chat/protocol.ts:20-28` 只列出会话列表、消息历史和清除红点路由；该文件没有提供会话创建路由。

## 推荐的 M4 最小契约（待批准）

在补齐证据前，只建议实现一个受限的“发送已知会话文本”操作：

1. 输入是已确认的 `sessionId`、当前页面账号和文本；`receiverId` 必须来自已验证会话资料，不能由普通调用者任意指定。
2. 在文档锁内执行；同 step 同指纹复用，冲突拒绝，并发拒绝。
3. 选择当前账号代次内唯一 OPEN socket；没有唯一 socket 直接 `PAGE_NOT_READY`，不发送、不 poison。
4. 使用固定 `/r/MessageSend/sendByReceiverScope`，只构造本模块 payload；禁止透传 envelope。
5. pending 先登记，随后只调用一次 `send`。
6. 成功响应必须来自同 socket、匹配 mid、结构严格合法，并通过固定错误分类。
7. 任何 timeout、close、error、账号/文档代次变化或 send 状态不明，都进入结果未知和失败关闭；不重试、不释放可重发状态。
8. 不实现会话创建、商品询价建联、图片/富文本、撤回、编辑或批量发送，直到有独立证据和测试契约。

## 测试入口和禁止事项

现有离线测试证据：

- `legacy/extension/src/chat/test/send-protocol.test.ts`：发送输入、base64 和信封校验；
- `legacy/extension/src/chat/test/send-transport.test.ts:30-111`：mid、超时、无 socket、路由拒绝、重复 mid 和 dispose；
- 当前页面 socket 观察测试位于 `apps/extension/src/test/chat-socket-monitor.test.ts`，页面队列与 socket 选择测试位于 `apps/extension/src/test/page-chat.test.ts`。

M4 新测试必须覆盖：唯一 socket、多个 socket、账号切换、文档锁并发、同 step 去重、同 mid/uuid 冲突、pending 先登记、同步响应、send 只调用一次、响应 socket 身份、超时未知、close/error、send 抛异常、dispose、风险/登录固定分类、平台 `messageId` 与本地 `uuid` 不同的取值、非法平台 ID 边界，以及失败后绝不重试。

本轮只修改 `apps/extension/src/chat-write-transport.ts`、其定向测试和本证据文档；不发送真实消息，不创建真实连接，不调用平台 API，不读取或输出账号/token，不递归派工。
