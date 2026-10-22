# M3 chat.sync 完整同步契约与设计证据

状态：分页公共响应字段已补齐并通过离线与真实只读行为验证；已增加账号隔离的 `chat.sync.status` 进度查询；缺口覆盖证书仍未完成。日期：2026-10-18。
本次只写文档，不发送真实请求，不操作真实账号，不递归派工。

## 1. 目标与现有证据

完整支持两个同步入口：不传 sessionId 时同步会话列表；传 sessionId 时同步该会话历史。会话列表必须独立入库，包括没有可解析最后消息的会话，不能用“只有消息入库才产生会话”替代会话同步。

| 实际文件 | 已核对内容 | 可复用与不可照搬部分 |
| --- | --- | --- |
| `legacy/extension/src/chat/history.ts` | `buildConversationListRequest`、`buildMessageHistoryRequest`、`parseConversationItem`、两类单页读取 | 保留只读请求结构；不复制 `listAllConversations` / `listAllMessages` 页面内循环及 sleep |
| `legacy/extension/src/chat/socket-transport.ts` | 两路由白名单、body 校验、pending(mid)、响应匹配、15 秒等待、dispose | 可复用只读 envelope 思路；原实现仅按 mid 匹配且超时删除 pending，不足以证明步骤真实终结 |
| `legacy/extension/src/chat/parser.ts` | `parseHistoryMessageModel` 从 message/cid/sender/content/createAt 提取数据，经过 `makeMessage` | 不复制缺来源 ID 时的合成键、缺时间回退 0、无内容直接过滤等有损行为 |
| `packages/protocol/src/chat.ts` | 当前 chat.sync 仅有 sessionId、等待和 tag 参数；消息严格 schema | 需要新增分页参数、会话输出 schema、同步结果；当前不是完整同步协议 |
| `packages/protocol/src/step.ts` | request-step 绑定账号、tabId、documentId，method 仅三个商品读方法 | 需要显式增加聊天单页步骤；不能把聊天伪装为商品方法或开放任意 LWP 路由 |
| `apps/extension/src/page-runtime.ts` | 单 fetch、真实终结、账号前后核验、poison 失败关闭 | 聊天应新增 socket 执行分支，不能复用 MTOP fetch 当作聊天 transport |
| `apps/extension/src/page-lock.ts` | 文档全局锁、连接重建复用、stepId 去重、dispose | 所有聊天页与商品步骤共用执行互斥；不能因 HTTP 超时重新建锁 |
| `apps/extension/src/chat-socket-monitor.ts` | 观察页面自行建立的目标 socket；回调含 socket；不 send、不主动建连 | 当前未导出已有 socket 读取接口；不能假设监视器已经提供同步 transport |
| `apps/extension/src/page-chat.ts` | 被动消息队列、账号绑定、peek/ack、syncRequired | 被动收集与主动显式单页同步分离；不能消费队列冒充历史或会话列表响应 |
| `apps/host/src/database.ts` | 消息事务去重、会话由消息更新、row_id 分页 | 需新增独立会话页 upsert，处理无消息会话与可空 lastEventSeq |
| `apps/host/src/main.ts` | persistChatGap 按账号和原因去重、state 与事件事务提交 | 当前无缺口覆盖范围、代次或恢复证书；现状不能自动安全清除缺口 |

旧接口是离线源码依据，不是当前平台协议的真实验收证据。实现必须用夹具验证，部署后另做明确授权的小流量只读验收。

## 2. 公共调用与分页

采用“一次公共 chat.sync 最多推进一个平台页”。Agent 显式再次调用才能继续，不在扩展或 host 后台自动翻页。完整能力同时包含会话页和历史页，不因单页限制删除任一功能。

建议严格输入：`{ sessionId?, cursor?, limit?, maxWaitMs?, minIntervalMs?, tag? }`。

- sessionId 缺省表示会话列表；存在表示该会话历史。limit 默认 20，范围 1..100；与本地查询 limit 1..500 区分。
- cursor 是 host 签发的有界不透明续页凭证，不是 SQLite afterId/afterSeq。内部绑定账号、模式、会话、页大小、tag、固定文档/连接代次、平台 anchor、同步 runId 和过期时间；校验完整性，跨账号、变更模式或过期拒绝，不静默从第一页重来。账号和平台原始内容不以明文放进公共 cursor。
- 首次省略 cursor；首次平台 anchor 使用旧协议 `9007199254740991`。平台数值 anchor 必须为非负安全整数，跨内部协议用十进制字符串表达，校验后才转换为 Number。
- 公共成功 data：`{ runId, mode, sessionId, committedPages, receivedCount, insertedCount, updatedCount, hasMore, nextCursor, completion, partial, gapCleared }`。sessionId 在会话模式为 null；计数为非负安全整数。当前实现已返回 `mode`、`sessionId`、`committedPages`；`gapCleared` 仍固定为 false。
- `completion` 为 `more | complete`，只有平台明确末页并且该页持久提交才 complete。`hasMore=true` 必须带推进且不重复的 nextCursor；末页 nextCursor=null。缺游标、循环游标、不能判定末页不得伪装 complete。
- `partial=true` 表示本 run 尚未完成，已提交进度保留；第一页完整结束且无后续页可为 false。每页大小/帧大小受限，超限返回失败，不能静默截掉条目。
- chat.messages / chat.conversations 继续仅访问本地库，分别返回事件 seq / 不可变 row_id 游标。它们不是平台分页，也不触发同步。
- `chat.sync.status` 接受 `{ runId }`，只返回当前账号的已持久化同步状态和最后一次成功结果；未知 run 返回 `NOT_FOUND`，不触发平台请求。
- run 进度和下一凭证只在页事务提交后推进。失败保留先前已提交页，返回固定错误与可查询的 runId/进度；公共错误承载方式需同步扩展公共响应 schema，不把失败包装成 ok=true。客户端丢失响应后先查询本地进度，不自动重发平台页。

## 3. 内部单页 step 与每页调度

建议内部 method=`chat.sync.page`，严格参数为判别联合：

```ts
{ mode: 'conversations', anchor: string, limit: number }
{ mode: 'messages', sessionId: string, anchor: string, limit: number }
```

沿用 request-step 的唯一 id、公共 requestId 和固定 `{accountId, tabId, documentId}`；runId、tag、等待策略和公共 cursor 只在 host 管理，不信任页面提供。成功只返回归一化该页数据及严格分页事实，不回传原始 LWP 帧或凭据。

每次公共调用：参数/续页验证 → 获取一次 chatRead 调度槽 → 定位并核验固定执行文档 → 核验已有 socket → 单步只 send 一次 → 匹配响应与归一化 → 再核验账号和 documentId → host 事务提交该页 → 通知已提交事件 → 返回进度。后续页重新获取 chatRead 槽，遵守账号总间隔与分类间隔；不得在同一槽内循环发多页或用页面 sleep 替代 host 调度。

第一页固定文档，续页不得自动换 tab/document 或换 socket。已失效时结束该 run，Agent 可显式发起新 run，不自动恢复平台请求。stepId 同参重投只复用原结果，不再 send；异参冲突拒绝。重建客户端不能清除文档级步骤锁。

## 4. 会话列表归一化与独立存储

依据 `history.ts::parseConversationItem`，建立独立会话 schema：

| 字段 | 来源/规则 |
| --- | --- |
| sessionId | 优先 singleChatUserConversation.cid，兼容 lastMessage.message.cid；按固定 @goofish 后缀拆分，缺失拒绝该页 |
| itemId、peerUserId | 仅提取已知 reminderUrl 参数或已验证明确字段；排除当前账号自身；无依据为 null |
| updatedAt | 明确 modifyTime，或明确 lastMessage.message.createAt；缺失为 null，不取收到时间或 0 |
| platformSortIndex | userConv.sortIndex / item.sortIndex；仅合法安全整数；不能与业务时间混为一谈 |
| lastMessageText、lastMessageAt | 可验证最后消息的摘要和时间，未知为 null；无消息会话仍保存 |
| unreadCount、visible | 明确 redPoint 非负整数、visible 布尔，否则 null；不发送标已读 |
| peerNick、peerAvatar | 只有明确证明归属对方才保存，否则 null，不能把最后发送者的本人信息当对方 |

按 `(account_id,session_id)` 独立 upsert，首次分配 row_id 后不变；字段未知不覆盖已有明确值，较旧快照不覆盖较新信息。消息落库也沿用相同会话身份。lastEventSeq 对无消息会话必须允许 null，不得创建假 chat.message 或假 sourceId 填充。会话页 tag 由 host 写关联表或等价独立关联，不能仅靠消息 tag 过滤，否则无消息会话不可查询。

整页先严格校验，再在单事务中保存会话、关联、同步进度和必要的会话变更事件。建议使用独立 `chat.conversation` 事件及白名单更新，不借用 chat.message。事务失败不推进 cursor，不通知 SSE；成功使用 notifyPersistedEvents，不再次插入事件。字段扩展需要显式新版本迁移，不能悄悄改变已有 v3 表。

## 5. 历史消息归一化

旧 `listUserMessages` body 为 `[fullCid,false,anchor,count,false]`。响应模型位于 userMessageModels，下一 anchor 来自 nextCursor。只把这两处作为已知结构依据；缺数组不能按空列表成功。

- sourceId 必须来自稳定平台 message.messageId，不能复用 legacy makeMessage 的合成键；数字超精度、空 ID、冲突 ID 拒绝。
- sessionId 来自 message.cid，必须与请求会话一致；senderId 来自 extension.senderUserId 或 sender.uid，按明确后缀规则归一化。
- text 从受限 custom.data/base64 JSON 已验证文本路径或明确 summary 提取；sentAt 来自明确 createAt，须为非负安全整数。缺字段不得用现在时间或默认 0 补齐。
- itemId/peerUserId 仅已知字段映射；不将 sessionId 当作 peerUserId，不持久原始 payload、图片 base64 或 token。
- 当前 ChatMessage 仅为文本 schema。图片、系统或其他非文本模型不得静默过滤后报告完整覆盖：可识别模型记为 unsupported 进度并保持 partial/缺口，或先扩展显式内容 schema 再完整入库。缺必需 ID/结构损坏则整页失败，不丢弃后继续。
- 归一化结果必须通过 isChatMessage 的 20000 字符、64KiB JSON 限制；历史与实时使用同一来源 ID 语义，按账号去重。相同 ID 异正文要明确冲突，不把覆盖当新消息。
- 页进度按原始模型分页事实推进，不按过滤后的文本数量推断 hasMore。旧源码的“长度达到 count 且 nextCursor>0”仅是待验证兼容规则；无明确结束证据时保持未知/partial，不能据此清除缺口。

## 6. 页面已有 socket 的只读 transport

只允许 `/r/Conversation/listNewestPagination` 的 `[anchor,limit]` 和 `/r/MessageManager/listUserMessages` 的 `[fullCid,false,anchor,limit,false]`。transport 自行构造只含 lwp、headers.mid、body 的 envelope，拒绝任意调用者路由或额外字段；不发聊天、标已读、注册、心跳、token 刷新或新连接。

被动监视器需提供文档内部的受限 socket 选择器：只接受已观察到的精确目标域、OPEN 状态且账号/文档代次一致的唯一 socket；零个或多个候选都 PAGE_NOT_READY。不能从其他窗口查找替代连接，不能为“恢复”主动 new WebSocket。document_start 安装前已存在但未捕获的连接也不能冒充已知。

发送前先登记 `(documentId,socket identity,accountId,stepId,mid,expectedRoute)`，再 send 一次，避免同步响应抢跑。响应必须来自同一 socket、同一代次并命中 mid；若携带 route，还须匹配 route。mid 唯一且不可复用；未知、重复、迟到或旧代次 mid 不推进步骤，不吞掉页面自己的消息。响应 code/body 必须严格校验；同步响应只送对应解析器，不当作实时 chat-delivery 整帧投递。监听使用 addEventListener，不覆盖页面 onmessage，不关闭页面拥有的 socket。

页面端 socket 对象、pending Map、原始帧和 mid 不跨 MAIN world 返回；SW 只取得归一化单页终结结果。跨 world 调用与现有 page-client 一样固定 Chrome documentIds，并前后核验返回 documentId。包装器重注入必须复用文档状态，不能重置 pending 或锁。

## 7. 取消与故障语义

| 动作 | 状态及可见结果 | 平台副作用/恢复 |
| --- | --- | --- |
| 排队取消或排队超时 | 未派发，取消/queue TIMEOUT，无页进度 | 零 send，不重试 |
| 已 send 后 HTTP 取消/超时 | 调用者停止等待，run 保留在途事实 | 不释放锁、不再 send；匹配响应终结后才可释放，取消的页不推进公共 run |
| LWP 15 秒等待到期 | TIMEOUT，步骤状态未知，缺口保持 | 保留 pending 墓碑/poison 与文档互斥；不能照搬 legacy 删除 pending 后马上发下一页 |
| 迟到匹配响应 | 核验后结束旧步骤；失败/已取消 run 不擅自续页 | 不重试；是否落该页须由持久 run 状态决定，默认不推进已终止 run |
| socket close、文档确认销毁 | 旧 transport 不再可能回调，新代次不得接旧响应 | 确认上下文销毁后允许结束旧等待；结束 run，不自动换页/重连 |
| 导航但销毁尚未确认 | PAGE_NOT_READY，保留未知步骤状态 | 不假终结，不释放在途后立即重发 |
| 账号切换 | ACCOUNT_CHANGED，禁止旧结果转记新账号 | 停止后续页；旧在途只等待终结或上下文销毁 |
| 平台拒绝、风控、登录失效 | 固定分类错误、partial 进度和缺口可见 | 不重试、不自动登录、不更换 token |
| 落库失败 | 不推进进度、不发提交 ACK/通知 | 页面成功不等于 host 成功；不得自动重放平台查询 |

禁止把“本地 Promise reject/移除监听器”当作服务端已终结。socket 超时与 MTOP fetch 终结不是相同事实；应沿用 page-runtime 的保守 poison 思路，不复用它的 fetch 终结判断。

## 8. partial 进度与缺口恢复证明

持久 run 至少记录账号、模式/会话、固定文档和 socket 代次、初始缺口 generation、已提交页数、下一 anchor、覆盖范围、unsupported 数量、最后错误、状态。日志只记固定分类，不输出账号、正文或原始帧。

缺口记录需从当前“账号＋原因存在标记”升级为可比较 generation/范围。同原因的新丢失必须推进 generation，即使事件通知继续合并，否则同步开始后又发生的新缺口会被误清。host 与扩展 outbox、页面 syncRequired 都需要覆盖凭证与比较后清除协议；单独删除 host state 不算修复。

清除条件必须同时满足：

1. 明确同步覆盖缺口的所有会话和时间/来源范围。仅完成会话列表不等于恢复消息；单个 session 历史仅能恢复有证据属于该 session 的缺口。
2. 对账号全局、范围未知的 OUTBOX_CAPACITY/PAGE_GAP，先完整枚举会话，再显式分页覆盖所有相关会话历史。若平台保留窗口、删除会话或未知类型造成覆盖无法证明，继续保留缺口，不宣称无损。
3. 所有覆盖页已持久提交，分页到可靠末页，unsupported=0，无未决步骤、无丢弃或超限条目。实时增量需与同步边界重叠去重，不能在列表变化时声称固定快照全量一致。
4. 同步起始 generation 与清除时一致；host/outbox/页面均确认没有更新缺口。使用比较后清除，异步清除失败保持缺口；新 generation 不受旧完成消息影响。
5. 在事务中保存覆盖证书、run 完成状态和恢复事件后再通知 SSE。扩展和页面接受证书后才清对应 generation；任一端无法确认则 gapCleared=false，不能让成功查询顺便清标记。

因此 `completion=complete` 只说明本 run 的指定分页范围完整，`gapCleared=true` 才说明缺口覆盖已获证。第一页成功、空页、outbox 清空、ACK 全到达、重新登录或重新加载页面均不能单独清除缺口。

## 9. 后续实施与验收门槛

依次实现公共分页/单页协议与夹具、会话独立迁移/upsert、文档范围 socket transport、host 每页调度及持久 run、partial 与覆盖证书、取消/超时恢复、公共路由和完整离线回归。最后做受控真实页面只读验收，不缩减为只有历史接口。

必须覆盖：无消息会话仍可本地分页查询；两个模式各 N 页只产生 N 次 send；逐页重取调度槽；错误/循环 anchor 不截断成功；同 socket mid 匹配、跨 socket 相同 mid 拒绝；重复 step 不重发；历史/实时来源去重；不支持消息保持 partial；第 k 页失败保留前 k-1 页；host 重启不自动发送；超时未终结不释放锁；导航、取消、账号变化无重试；旧 generation 完成不得清新缺口；全局缺口不能被单会话同步误清。

本文件为设计证据，仅核对源码与文档。未执行代码测试或真实平台请求；Orca 未运行，阶段同步失败，未进入 done。
