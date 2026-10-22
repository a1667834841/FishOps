# 真实行为测试结果

## 2026-10-19 最新复验

- Node 已切换到项目要求的 `24.22.0`；`npm run regression` 全部本地阶段通过，报告：`.test-results/2026-10-19T00-39-22.054Z-77251-c499110d`。
- 最新构建并重载 Ego 扩展后，只读冒烟通过：构建身份、native 连接、鉴权拒绝、事件续传、SSE keepalive 均通过。报告：`.test-results/chrome-live-1792370613647-82139/report.json`。
- 真实聊天同步行为通过：首屏、续页、范围拒绝、提交重放、游标篡改拒绝、会话标签关联均通过。报告：`.test-results/chat-sync-behavior-1792370710978-84055/report.json`。
- 真实同步状态行为通过：非法任务、未知任务、首屏进度、已提交页进度和第二页进度均通过。报告：`.test-results/chat-sync-status-1792370712288-84075/report.json`。
- 完整浏览器关闭重开观察通过：在线 → `ECONNREFUSED` → 恢复在线；25 条历史事件完整保留，账号稳定。报告：`.test-results/chrome-lifecycle-1792370696893-83360/report.json`。
- 本轮未执行真实发布，未新增真实发送；自然休眠、一小时静默和登录账号切换仍未覆盖。

## 完整门禁自动化闭环

`regression:full` 现在支持两个显式授权开关，默认仍不读取或操作本机浏览器：

- `FISHOPS_BROWSER_RELOAD=1`：隔离构建/安装后，若只读冒烟因运行中 SW 构建身份过期失败，执行一次扩展详情页重载，再只重试只读冒烟；业务请求不重试。
- `FISHOPS_LIFECYCLE_TRIGGER`：基线在线后执行一次关闭/重开命令，随后由观察器验证离线、恢复、历史事件和账号稳定。未提供触发器时生命周期仍为 blocked。

本轮真实完整门禁通过，退出码 `0`，报告：`.test-results/2026-10-19T00-57-34.839Z-98803-db1aee3c/report.json`。其中运行中构建 `2643725f-30e2-44d9-8d1e-ade6337b2aeb` 与磁盘产物一致；生命周期观察 29 条基线事件全部保留、账号稳定。扩展重载不是业务重试，关闭/重开仅作用于 Ego Lite 主进程，不关闭 Google Chrome。

随后真实聊天同步行为再次通过：`.test-results/chat-sync-behavior-1792371556080-2125/report.json`。该证据不覆盖真实发布、自然休眠、一小时静默和登录账号切换。

本表关注 Agent 使用 API 后的可观察行为，不以单测数量替代业务验收。证据目录为 `.test-results/behavior-20261019/`；所有凭证、账号和消息正文均不进入本表。

| 场景 | 操作与预期 | 实际结果 | 证据文件 |
| --- | --- | --- | --- |
| 搜索到详情 | 搜索两页，再读第二页商品详情 | 各30项，第二页不同；详情ID一致。两页有1项重叠，不保证动态搜索无重复 | sync-replay-search.json |
| 已提交续页重放 | 消费续页后再提交同一凭证 | 成功且结果完全一致 | sync-replay-search.json |
| 会话列表去重 | 查询本地前100项 | sessionId 唯一，仅证明该范围 | sync-replay-search.json |
| 平台ID别名 | 规范ID与带域后缀ID分别同步 | 修复前后缀失败；修复后均收到11项并到末页 | session-suffix.json、session-suffix-after.json |
| 别名续页 | 规范ID首屏，别名续页 | 成功续读2项，范围一致 | alias-cursor-continuation.json |
| 凭证防篡改 | 修改凭证中间字符后提交 | BAD_REQUEST/queue | cursor-tamper.json |
| 范围拒绝不耗游标 | 错误页大小提交，再用正确页大小续读 | 错误拒绝，正确续读2项 | cursor-scope-preservation.json |
| native重启续读 | 签发凭证，重载扩展，等待host恢复后续读 | 原凭证成功；提交后再重放结果一致 | cursor-native-recovery.json |
| 文档变化停止 | 签发凭证，刷新业务页，提交旧凭证 | PAGE_NOT_READY/queue；新同步成功 | document-change.json |
| 同凭证并发 | 两个HTTP并发消费同一续页，终结后再重放 | 一个成功，一个RESULT_UNKNOWN；终结后重放与成功结果一致 | concurrent-cursor-corrected.json |

首次并发脚本曾错误地用失败响应比较重放结果，`concurrent-cursor.json` 不是有效的一致性判定；使用 corrected 报告。

## 已验证的其他行为

- 隔离扩展重新构建并在 Ego 中重载后，部署身份、SSE 历史续传和 keepalive 重新通过：`.test-results/chrome-live-1792343580810-40973/report.json`。
- 真实扩展停用/启用恢复重新通过：`.test-results/chrome-lifecycle-1792343642530-41321/report.json`；在线→connection refused→在线，15 条历史事件完整，账号保持一致。
- 同步公共响应字段补齐后，真实 API 续页行为再次通过：响应包含 `mode`、`sessionId`、`committedPages`、`completion` 和 `gapCleared`，并验证首屏/续页页数递增及已提交 cursor 重放。证据：`.test-results/chat-sync-behavior-1792343914172-45393/report.json`。
- `chat.sync.status` 真实部署行为通过：非法 `runId` 返回 `BAD_REQUEST`，未知任务返回 `NOT_FOUND`，均不触发平台请求。证据：`.test-results/chat-sync-status-1792344918304-63517/report.json`。
- `chat.sync.status` 完整真实行为通过：非法任务、未知任务、真实同步、已提交进度查询均通过，`committedPages` 与 `chat.sync` 一致。证据：`.test-results/chat-sync-status-1792344982682-64381/report.json`。

- 大分页到自然末页：`.test-results/chat-pagination-20261018/limit100-after-fix-complete.json`，900项、10页；群聊未消费，partial保持true。
- 单聊消息到末页：`.test-results/chat-pagination-20261018/message-sync-latest.json`，11项；非文本未消费，partial保持true。
- 扩展停用/启用恢复：`.test-results/chrome-lifecycle-1792340226428-88148/report.json`，历史事件完整、账号一致；不是完整浏览器重启。
- 鉴权与SSE：`.test-results/chrome-live-1792339786251-82459/report.json`，续传和心跳通过。

## 未通过或未覆盖

### 自动滑块单测门禁修复

- 原先 `solveSlider` 五项失败不是滑块实现失败，而是测试替身只提供了矩形字段，没有实现 `getBoundingClientRect()`，导致定位阶段抛错并被统一折叠为 `BAD_REQUEST`。
- 已修正测试替身，并让“自动通过后弹窗消失”场景真实模拟 DOM 状态变化；当前 `page-runtime.test.ts` 34/34 通过，全仓 `test:unit` 520/520 通过。
- 这只证明页面运行时编排和测试替身契约正确，不证明真实平台滑块一定可自动通过；真实平台仍以风控停止和人工验证为最终安全边界。

- 发布按用户要求暂停；历史写入证据不能替代最终部署验收。
- 不新增消息发送；未完成最新部署写入专项。
- 浏览器完全退出重开、自然休眠、真实登录切换未验收。
- 风控停止/人工恢复有受控测试，但未在真实平台人为触发挑战；不保证不会被风控，不提供自动绕过验证码的完成承诺。
- 历史记录中的“5项自动滑块失败”已由测试替身契约修复关闭；当前最新本地回归为 unit 520/520，通过未删除或跳过测试。真实平台滑块仍以安全停机和人工验证为边界。

后续只为明确未覆盖行为安排测试，不为增加数量重复已通过场景。

## 契约差异待关闭

行为验收同时发现 `docs/m3-sync-contract.md` 仍包含设计阶段而非现行响应的描述：

- 设计列出的 mode、sessionId、committedPages 不在当前公共成功响应中。
- `chat.sync.status` 已实现并完成真实 API 验证，证据见 `.test-results/chat-sync-status-1792344982682-64381/report.json`；失败 run 的完整进度恢复和缺口证书仍未完成。
- 现有成功响应的 partial 还包括未支持群聊/非文本的历史覆盖缺口，不只表示尚未到末页。

这些差异不能通过单方面删改设计要求当作已完成；后续需要核对原计划并决定补齐实现还是明确确认契约变更。当前以实际响应指导测试，以原要求保留交付缺口。

## 可重复执行入口

`scripts/test/chat-sync-behavior.mjs` 将首屏、错误范围拒绝、有效续页、已提交结果重放与凭证篡改拒绝串成真实 HTTP 行为流程。最多5次调用，每次10秒上限，未知结果立即停止，不自动重试。需两个显式开关；未开启退出2且不读取配置。

```sh
FISHOPS_LIVE_SMOKE=1 FISHOPS_CHAT_SYNC_BEHAVIOR=1 \
  FISHOPS_HOME="$PWD/.test-results/isolated-deploy-20261018/home" \
  node scripts/test/chat-sync-behavior.mjs
```

本次实际执行5步全部通过：`.test-results/chat-sync-behavior-1792341475109-8656/report.json`。语法检查及未授权门禁也已执行。报告仅含阶段、计数与判定，不保存凭证或业务正文。此入口不覆盖发布、发送及全部生命周期，不能代替整体完成验收。

入口现为 `npm run test:chat-sync-behavior`，运行时必须额外指定 `FISHOPS_EXTENSION_DIST` 指向待验收隔离扩展。脚本先比对运行中 SW 构建与磁盘产物，再执行5次业务调用；报告含构建ID、时间及身份范围，不宣称Host源码已由构建ID证明。

补强后真实执行通过：`.test-results/chat-sync-behavior-1792341550439-9771/report.json`，构建 `d4ff2bbb-3518-4e18-a643-9a77d4ce469f`。早期无身份报告仍只按早期范围使用。

## 新发现：会话页标签查询缺陷

真实调用 `chat.sync` 带唯一 tag 成功收到2项，随后同tag的 `chat.conversations` 返回0项。证据 `.test-results/behavior-20261019/tag-isolation.json`。代码仅按消息tag筛选会话，违反M3契约中会话页独立标签关联要求。此场景当前失败，已委派实现账号隔离关联及事务写入；必须修复后从公共API复验，不用受控测试替代。

## 消息重复同步去重

对同一已有会话执行两次独立历史同步，前后本地查询均成功、消息条数保持10；第二次同步 insertedCount=0，本地返回的事件seq序列完全一致。记录 `.test-results/behavior-20261019/message-resync-dedup.json`。这是该已有消息范围的真实去重证据，不说明未来所有平台消息类型均受支持。

### 标签缺陷修复后复验

子代理新增账号隔离的会话标签关联，在同步页事务内写入，查询兼容会话关联或历史消息标签，不创建假消息。部署后真实调用：同tag同步2项→同tag查询2项→其他tag查询0项，记录 `tag-isolation-after.json`。再次重载扩展使native host重启，仅查询同tag仍返回相同2个会话，记录 `tag-restart-persistence.json`。文件均位于 `.test-results/behavior-20261019/`。本场景从失败转为通过；真实环境未切换账号，账号隔离仅由受控回归支持。

### 标签续页范围

真实首屏limit2绑定tag A后，改tag B提交续页被BAD_REQUEST拒绝；随后tag A原凭证续读成功，按A查询4个会话，按B查询0。非法范围未污染关联、未消耗正确续页。证据 `.test-results/behavior-20261019/tag-cursor-scope.json`。

真实行为入口已加入唯一tag关联查询和不存在tag零结果校验；仍最多5次平台同步，额外两次仅访问本地库。若两页全是未支持类型而没有可关联会话，明确partial，不冒充标签行为覆盖。本次执行通过，关联4个会话，报告 `.test-results/chat-sync-behavior-1792342017425-17235/report.json`。

### 标签查询分页一致性

只读选取已有标签（从隔离库只读取得标签，不输出），公共API按limit1连读4页到末页，4个会话无重复，与同标签limit100查询的记录序列一致。报告 `.test-results/behavior-20261019/tag-query-pagination.json`。未新增平台同步；本次未比较无标签查询，不能据此宣称已完成该比较。首次读取config.database失败，因为磁盘配置不含该派生字段；改用已核验的隔离fishops.db后成功，未访问其他数据库。

## 本地会话全量可读性

通过公共API以limit100从首屏连读9页到末页，共895个会话；sessionId无重复、游标逐页推进、账号前后稳定。只读隔离SQLite当前账号COUNT为895，与API完整分页一致。记录 `.test-results/behavior-20261019/full-local-conversations.json`。此比较证明当前本地记录可完整读取，不等价于平台所有会话类型都被消费；此前900项平台响应包含未支持群聊，不能要求两者计数相等。

## 本地消息全量可读性

只读选择当前账号本地消息最多的会话，通过公共API以limit3连读4页到末页，共10条，与隔离库该会话COUNT一致。seq/sourceId均无重复、范围匹配、游标推进。证据 `.test-results/behavior-20261019/full-local-messages.json`。这是已有会话本地记录的完整读取，不是全部895个会话历史均已下载；本轮没有平台同步。

## 2026-10-19 授权写入与完整浏览器重启

用户明确恢复发送及关闭浏览器授权，真实发布继续暂停。

- 复用隔离部署历史成功发送的同一测试会话，发送一次“你好”；公共 `chat.send` 返回 HTTP 200 / ok。同一幂等键再次调用返回完全一致结果。证据：`.test-results/authorized-send-20261019-1792365429257/report.json`。没有换键补发；当前报告证明发送确认和同键返回一致，不单独证明平台历史中消息计数。
- 完整退出 Ego Lite，操作系统检查确认主浏览器进程已退出，再启动同一应用。独立观察器记录 baseline 在线 → ECONNREFUSED → 恢复在线，15 条基线事件全部保留，账号一致。证据：`.test-results/chrome-lifecycle-1792365462270-85800/report.json`。本次是真实浏览器进程退出重开，不是扩展停用启用；不证明自然休眠和账号切换。

### 浏览器重启后的发送持久幂等

- 重启后使用 `behavior-send-20261019-authorized-1` 重放，公共 API 返回原发送结果，验证成功状态在 native host 进程重建后仍持久存在。
- 同键修改正文，返回 `IDEMPOTENCY_CONFLICT`，未另行创建发送操作。
- 再同步原测试会话历史成功。历史中有一条当前账号发出的相同正文消息，平台时间比发送确认时间晚 53 毫秒，支持实际送达的时间与正文关联。
- 但历史 `sourceId` 与发送返回的 `messageId` 不一致，不能声称已通过 ID 强关联或严格的一次送达证明。原始判定保留 `not-proven`，不改成绿色。报告：`.test-results/send-restart-behavior-1792365529458/report.json`。

### 可重复的成功发送重放入口

新增 `scripts/test/send-replay-behavior.mjs`：只读当前账号已成功操作记录后，验证同键重放、异参冲突拒绝与唯一操作记录。未提供显式开关、隔离目录、已有成功键时停止，不创建新发送键。真实执行三项通过，证据 `.test-results/send-replay-1792365669252-90211/report.json`。

```sh
FISHOPS_LIVE_SMOKE=1 \
FISHOPS_HOME="$PWD/.test-results/isolated-deploy-20261018/home" \
FISHOPS_REPLAY_KEY=behavior-send-20261019-authorized-1 \
node scripts/test/send-replay-behavior.mjs
```

此入口验证 Host 持久幂等，不单独证明平台消息数、账号切换或跨设备送达。

### 平台消息 ID 修复与部署验证

2026-10-19：新发送返回经过校验的响应 `body.messageId`，本地 uuid 仅校验相关性。旧持久幂等结果不迁移，不为取得平台 ID 换键重发旧消息。

- 本地完整回归通过：`.test-results/2026-10-18T23-23-25.926Z-92918-ba3ce5e1/report.json`。
- 隔离构建 `7001062b-b25c-43c7-818e-9894ad910b40` 重载后真实只读冒烟通过：`.test-results/chrome-live-1792365844007-94150/report.json`。该构建身份仅证明 SW，不单独证明已有页面已替换 MAIN 产物。
- 升级后旧发送键重放、异参拒绝、唯一操作记录再次通过：`.test-results/send-replay-1792365866499-94515/report.json`。
- 新平台 ID 与真实历史的对照仍待新发送专项验证，不能用本地测试或旧键重放代替。

### 重放工具失败关闭的真实部署验证

以未知幂等键运行重放工具返回 1；关闭显式开关并指定不存在的配置目录返回 2。执行前后隔离库中 `chat.send` 的 operations、requests 记录数均未变化，证明这两个拒绝路径未调用发送 API、未创建操作。证据：`.test-results/send-replay-safety-1792365966448/report.json`。本次没有发送或发布。

新发送平台 ID 专项暂未执行：Ego 退出请求返回“用户已取消”，未强杀浏览器，不将该次尝试计为重启通过，也不绕过取消继续重载业务页面。此前成功的完整浏览器重启证据仍按原版本范围保留。

### 2026-10-19 当前运行部署的行为复验

本轮使用现有隔离部署和真实公共 API，不调用发布接口，不创建新的发送操作。

- 成功发送键重放、同键异参冲突、唯一操作记录三项通过。证据：`.test-results/send-replay-1792367377841-19207/report.json`。这里只证明持久幂等，不证明平台侧消息数量。
- 聊天同步首屏、续页、游标参数范围拒绝、已提交页重放、防篡改、会话标签关联均通过；标签查询得到 4 个会话。证据：`.test-results/chat-sync-behavior-1792367377888-19208/report.json`。
- 同步任务状态查询通过：非法 runId 拒绝、未知任务处理、真实任务创建及已提交页状态一致；该任务只提交 1 页，状态为 `more`，不能记为全量同步完成。证据：`.test-results/chat-sync-status-1792367379060-19206/report.json`。
- 本轮未重复退出浏览器，未新增发送；新平台消息 ID 对照、缺口恢复闭环、自然休眠和账号切换仍待验收。真实发布继续暂停。
- Orca 未运行，无法同步测试阶段状态；没有进入 done。

### 缺口事件链路的本地行为验证（非真实浏览器 E2E）

容量溢出已生成稳定事件及正文摘要索引，重建和重投保持身份；扩展重连发送同一 occurrence。native 协议校验内外账号及原因一致，Host 生产回调调用 `persistChatGapOccurrence`，在同一 SQLite 事务中写入账本和事件。

`apps/host/src/chat-pipeline.test.ts` 新增行为验证：真实 native 编解码帧进入生产落库函数，两次连接重投只保留一个缺口事件；不同账号不可读取。另注入事件提交失败，确认账本同步回滚，恢复后重投代次仍为 1。该验证使用内存 SQLite 和流，不是平台或浏览器 E2E，不证明页面缺口身份、覆盖证书或清除闭环。

接入链路后的本地回归报告：`.test-results/2026-10-18T23-53-44.694Z-23794-0255c296`。随后提取生产事务函数并新增上述两项用例，定向 3 项通过；全量回归尚需在最终实现后重跑。真实发布仍暂停。

### 缺口元数据失败路径

进一步补充 outbox 行为：损坏的丢失摘要必须拒绝加载；512 条缺口元数据上限耗尽时拒绝新丢失，不驱逐原队列、不覆盖既有证据；已记录丢失仍可跨重建重投。模拟持久写失败后内存不推进，恢复写入后代次正常。

其中摘要损坏用例先观察到未拒绝，再增加 64 位十六进制 SHA-256 格式校验后通过。定向 outbox 14 项、类型检查及构建通过。这是本地失败路径验证，不能替代真实浏览器恢复验收。

### 页面缺口身份接入（待真实浏览器验收）

页面现在提供当前账号最近一次 `PAGE_GAP` 的稳定身份及来源代次；重复读取不推进，新错误推进。匿名缺口不归属到下一个登录账号。缺口范围目前为 unknown，不能凭单会话同步清除。多个尚未采集的同账号缺口合并为最近 unknown 事件，不宣称逐条保存页面错误历史。

固定文档来源适配器校验缺口账号及原因，经 collector 和 `reportChatGap` 写入持久 outbox；持久失败不 ACK 页面消息，下一轮重传原身份。旧页面没有新方法时保留旧布尔标记路径。

页面、collector、来源与连接定向 34 项通过，新增持久失败/重投用例通过。尚未实现可信覆盖与清除确认，不能将此接入视为 gapCleared 完成。

### 最新隔离扩展部署后的真实复验

隔离构建 `4870ce9c-dd36-4c3d-8a67-5874d3a6076a` 已通过 Ego 扩展详情页的重载按钮加载，native 注册仍指向本工作区 `apps/host/src/main.ts`。没有关闭浏览器、没有刷新用户业务页、没有新增发送和发布。

第一次紧接重载运行，冒烟在 native-status 失败、同步在 deployment-identity 失败（0 个同步请求）。保留失败报告，不计为业务通过。随后独立读取 status，确认 HTTP 200、nativeConnected、page.present 和新 buildId 均符合；只在此恢复证据出现后重新验收。

- 真实鉴权/来源拒绝、事件 SSE 续传和心跳、安装及 SW 产物身份检查通过：`.test-results/chrome-live-1792367956231-30362/report.json`。
- 真实同步首屏/续页/范围拒绝/已提交页重放/防篡改/标签关联通过：`.test-results/chat-sync-behavior-1792367971363-30361/report.json`。
- 同步任务状态专项通过：`.test-results/chat-sync-status-1792367939964-30111/report.json`。

这些证据证明最新 SW 部署可运行和现有真实业务同步可用，不证明已打开页面的 MAIN 产物更新，也没有人为制造真实缺口。因此新缺口身份的真实页面采集与恢复清除仍待验收；不得将 SW 重载替代完整浏览器重启或自然休眠。

### 新 MAIN 页面真实运行与缺口落库

在任务自有 `p1` 从扩展详情导航到闲鱼 IM，没有接管或刷新用户其他标签。新文档 `__fishopsPageChatV1__.gapOccurrences` 为 function，证明新页面接口实际加载。初始队列为空、无缺口；页面继续运行后观察到已有 socket、syncRequired=true。未伪造 WebSocket 帧、未发新消息、未发布。

只读隔离 SQLite 观察到 1 条 PAGE_GAP，Host generation=1、source_generation=1、范围 unknown。脱敏报告：`.test-results/page-gap-live-1792368168383/report.json`。该证据证明真实页面到持久账本链路已跑通，不证明缺口产生根因或清除。随后真实同步行为复验通过：`.test-results/chat-sync-behavior-1792368133916-34191/report.json`；它不能证明必定选中新建页面。

独立复核指出全局 syncRequired 可能在账号切换后生成错误账号旧标记。已新增 `requiresSync(expectedAccountId)` 并由来源优先使用；保留粗粒度 status 仅供诊断。页面和来源 21 项检查通过、类型检查通过；这项修复尚未部署，不能套用上述旧构建证据。复核的元数据耗尽退化、旧标记双源、代次确认和覆盖范围问题仍需继续处理。

### 同步状态接口多页进度修正

代码审计发现 `chat.sync.status` 原先取首条 state，末页已完成时仍可能返回首屏 more；此外用结果 JSON 子串查找 runId，会误认无关字段。本轮先用真实本地 HTTP 请求观察到 more≠complete 的失败，再改为精确匹配顶层或旧结果 runId，并按 committedPages 取最新状态，同进度优先 unknown/attempting/queued，避免已提交页掩盖后续失败。

公共 HTTP 用例验证末页状态、同进度 unknown 优先以及无关结果字段不能认领其他 runId，已通过。类型检查和构建通过。此为本地 API 行为回归，不是最新 Host 进程已重建后的真实部署证据。

### 最新状态修复真实验收

隔离构建 `f4b21f32-f62e-418d-98c7-243f01274e36` 已通过 Ego 扩展详情页重载。status 确认新身份、native 和业务页可用后执行：

- 真实同步状态入口新增第二页检查，实际提交 2 页后查询返回 committedPages=2，通过。证据：`.test-results/chat-sync-status-1792368366052-38285/report.json`。该报告明确证明修复已在实际 Host 路径生效，不是只查首屏。
- 旧成功发送键重放、异参冲突拒绝、唯一操作记录通过：`.test-results/send-replay-1792368388154-38564/report.json`。未创建新发送键，不证明平台消息数量。
- 真实部署鉴权/来源拒绝、SSE 续传和心跳通过：`.test-results/chrome-live-1792368380836-38452/report.json`。
- 任务自有 p1 再导航 IM，新页面 gapOccurrences 和 requiresSync 均为 function，初始队列为空且无缺口；证明账号级缺口查询接口已实际加载，不证明真实账号切换测试通过。

本轮没有发布，没有新增发送。缺口清除仍未实现，新发送平台消息 ID 对照、生命周期专项和完整验收门禁仍未关闭。

### 真实缺口分类诊断

新增页面只读 `gapDiagnostics()`，只记录固定原因计数，不保存账号、消息、来源 ID 或原始帧。页面定向 17 项、类型检查和隔离构建通过。隔离构建 `28eee50e-a9b7-494c-a48a-f59da256410d` 重载后，任务自有 p1 新页面实际存在诊断方法，初始计数为空。

页面自然运行后观察到 `PARSE_INVALID_MESSAGE=1`、队列为空、socket 存在、syncRequired=true。证据：`.test-results/page-gap-diagnostics-1792368473563/report.json`。这把下一步定位收敛到消息结构解析路径，不是队列容量或来源冲突；尚不知道具体结构差异，不能据此忽略此错误或清除缺口。没有新增发送或发布。

### 解析失败阶段收敛

解析器增加仅固定阶段名的可选诊断回调；诊断异常不改变原有解析结果，不保存输入。24 项解析器/页面定向检查、类型检查通过。隔离构建 `5470f575-6509-481e-8870-d7d458c863e7` 部署后，自有新 IM 页面自然出现 `DETAIL_MESSAGE_SHAPE=1` 与 `PARSE_INVALID_MESSAGE=1`，socket 存在、队列为空。说明失败发生在消息基本结构（data、字段1或字段10）检查，而非正文类型、URL或最终消息字段校验。

随后把该检查细分为 MESSAGE_SHAPE / MESSAGE_ROOT / MESSAGE_INFO，合成用例验证失败结果不变且诊断回调异常不外溢，8 项通过。细分版尚未部署；当前没有足够证据把缺字段项当控制消息忽略，仍保留缺口。

### 消息根结构的真实验证

细分版隔离构建 `e0633ef6-8bc7-4583-a042-2ae47b76319d` 新页面观察到 DETAIL_MESSAGE_ROOT=1，说明解码 data 是对象，但字段1不是消息对象。证据：`.test-results/parser-stage-live-1792368597480/report.json`。

对照 legacy 分类增加固定候选阶段（systemNotice、redReminder、字段1数组），不改变解析结论。8 项解析器检查、类型检查、隔离构建通过。构建 `789c7206-9b0d-40a3-aa85-f38307c2c904` 新页面仍观察到 DETAIL_MESSAGE_ROOT_UNKNOWN=1；不是上述已知候选。不能直接沿用 legacy 忽略规则，缺口继续保留。没有新增发送或发布。

### 白名单结构证据

新增仅预设数字字段1/2/3/4/5/6/10的存在性及类型诊断，不输出字段值或未知键名。解析器定向9项（含脱敏断言）、类型检查与隔离构建通过。构建 `6ac09148-f360-4617-b765-be06c10be222` 自有新页面再次出现未知结构，七个预设字段均 absent，不能适配为旧数字键消息。

证据：`.test-results/parser-shape-live-1792368733833/report.json`。这尚不能证明对象为空，也不能排除命名字段的新业务结构；没有足够依据忽略。后续应对白名单命名字段做类型特征确认，而不是记录原始聊天帧或凭空猜测映射。真实发布仍暂停。

### 命名结构诊断结果

隔离构建 `8f63ffb5-8836-4dd0-afc8-7c0456a9fc82` 新页面自然复现：解码对象非空，但预设 message/messageId/cid/content/extension/type/data/sync/syncPushPackage/headers/body/redReminder/systemNotice 全部缺失。报告 `.test-results/parser-named-shape-1792368816736/report.json` 仅包含类型与存在性，不含字段值或未知键名。

解析器9项、类型检查与构建通过。该证据否定“空对象”和这些已知命名格式，并不证明该对象是控制通知；继续保留失败与缺口。多轮分类仍未获得映射依据，不能把新增诊断数量当成功能完成。后续需更直接的有界结构观察（只读类型树、严禁业务值），同时继续解决恢复协调器等已知实现缺口，不重复把同一未知解析结果当通过。

### 监视器拒绝帧不再静默

发现 socket monitor 在解析前静默跳过非字符串或超过256KiB的目标帧，页面因此不知道未消费数据。本轮新增固定 `onDropped` 原因回调；页面绑定当前账号后建立缺口并唤醒采集，不向解析器、日志或诊断传递原内容。不创建连接、不调用 send、不改变页面自身接收行为。

监视器和页面24项检查通过，覆盖拒绝原因、页面缺口代次、dispose后不回调、无send。类型检查及构建通过。该变化尚未部署，不能声称真实环境已遇到此类帧或恢复成功；既有未知对象解析问题仍未解决。

### 排障计数器有界化

未知结构组合可以生成许多不同诊断键，因此页面 gapDiagnostics 改为最多64类（63个原分类加DIAGNOSTIC_OVERFLOW），已有分类继续累计，溢出统一计数，不保存新增键。使用200种结构组合验证上限与既有PARSE_INVALID_MESSAGE计数不丢。页面19项、类型检查和构建通过；尚未部署。此为长期稳定性约束，不代表未知结构已修复或完整E2E完成。

### 完整门禁部署隔离修正

`regression:full` 暴露了门禁在未提供 `FISHOPS_HOME`/`FISHOPS_EXTENSION_DIST` 时会尝试使用默认运行部署；现已改为明确 blocked，不读取默认安装。指定隔离部署时，编排会先构建并安装同一隔离产物，再执行冒烟；相关编排测试已同步更新。

新增未配置隔离目录的失败关闭用例，报告测试与编排测试通过；随后本地 `regression` 全部通过，报告 `.test-results/2026-10-19T00-21-22.834Z-55326-5bb45fef`。真实 full 仍必须使用显式隔离目录，且生命周期仍是独立 blocked 条件。

### 重载等待后的隔离真实验收

隔离构建 `9ddd9a39-e68c-4358-955a-697ff08d1c4b` 重载后等待 native 接管稳定，再执行真实只读入口，避免把重载时序窗口误判为业务失败。

- browser smoke 通过：`.test-results/chrome-live-1792369917914-69841/report.json`。
- 聊天同步续页、防篡改、提交重放和标签关联通过：`.test-results/chat-sync-behavior-1792369960211-70361/report.json`。
- 同步状态第二页进度通过：`.test-results/chat-sync-status-1792369961390-70359/report.json`，`committedPages=2`。

这些证据只覆盖最新 SW 与 Host 的真实只读行为；完整门禁自动等待尚未实现，MAIN 页面缺口未知结构、浏览器关闭重开、自然休眠、账号切换和安全清除仍未完成。没有新增发送或发布。

### 真实冒烟重载时序修正

`browser-smoke` 现在在扩展重载后只对 `system.status` 和构建身份做最多30秒有界等待；每次尝试不触发发送、发布、搜索或同步业务请求。构建身份稳定后才执行一次只读门禁。

新增等待逻辑通过编排测试、脚本语法检查，并在当前隔离部署中实际通过：`.test-results/chrome-live-1792370020709-71512/report.json`。随后本地 `regression` 通过：`.test-results/2026-10-19T00-34-12.318Z-72053-d5769aee`。这解决了重载接管窗口，不等于生命周期 E2E 完成。

## 2026-10-19 缺口 FIFO 修复后复验

- 修复：页面连续缺口改为每账号有界 FIFO（上限 `MAX_PAGE_GAP_OCCURRENCES=32`），不再只保留最后一条；collector 与 page source 按原顺序上报全部记录。
- 本地：unit 569/569、integration 48/48、typecheck、build 通过。
- 真实 Ego：`regression:full` 全部通过，报告 `.test-results/2026-10-19T01-05-44.810Z-9701-53c080c7`（含扩展重载、只读冒烟、同步状态、关闭/重开）。
- 未执行：真实发布、新增真实发送。gap 清除仍保持 `gapCleared:false`。

## 2026-10-19 空闲恢复行为验证（自然休眠近似）

- 方法：`regression:full` 结束后 10 分钟内不发任何请求（超过 MV3 SW 约 30 秒空闲回收窗口），然后不重载扩展、不操作浏览器，直接跑只读冒烟和真实业务读取。
- 结果：冒烟通过 `.test-results/chrome-live-1792372759326-20472/report.json`（native 在线、构建身份一致、事件续传通过）；`search.items`（蓝牙耳机）返回 30 条，`chat.conversations` 返回 2 条，风控级别 `unobserved`。
- 注意：第一次冒烟失败的原因是测试命令漏了 `FISHOPS_EXTENSION_DIST`，脚本拿默认产物核对构建身份，不是产品故障。
- 边界：没有通过 CDP 直接确认 SW 在空闲期间已被回收，所以只能算“空闲恢复通过”，不能算 SW 回收已证明。一小时静默观察和账号切换仍未验证。

## 2026-10-19 静默观察证据纠正

- 先前临时 launchd 观察任务发生自动重启，且每次启动覆盖日志，不能证明连续一小时静默通过。
- 中断恢复后已执行 `launchctl remove top.ggball.fishops.quiet1h`，停止重复任务及其后续平台查询。
- 日志中的 `t=10min` 等记录缺少 SW 状态，不能认定 RUNNING 或 STOPPED。
- 一小时静默与自然休眠仍标记为未验证。此前 10 分钟后只读调用通过的独立证据不变。

## 2026-10-19 再次真实稳定性测试：未通过

- 部署身份、native 在线、SSE 心跳及事件续传通过：`.test-results/chrome-live-1792410600438-42990/report.json`。
- 聊天同步首屏失败：`.test-results/chat-sync-behavior-1792410615765-43286/report.json`，对应任务持久状态为 `unknown`。未重放此未知任务。
- 打开同任务空间的真实聊天页面后，新同步仍失败：`.test-results/chat-sync-behavior-1792410877519-47120/report.json`。
- 进一步只读查询确认 `risk.status.blocked=true`；已停止平台请求，未调用 `risk.clear`。本轮不能认定业务稳定运行。
- 脱敏状态证据：`.test-results/live-stability-20261019/report.json`。真实发布、真实新发送及后续发送重放均未执行。
- 页面能正常展示不等于平台接口风控已解除；下一步须核查最初风控信号，并在账号恢复后重新完成业务链路验证。

## 2026-10-19 23:40 风控恢复单次探测

- 本地只读取证：19:50 聊天同步触发 `risk.signal`（CAPTCHA）；19:54 后续调用被本地熔断拦截。现有事件不能细分平台响应与页面挑战检测来源。
- 探测前 `risk.status.blocked=false`，本地冷却自然到期；未调用 `risk.clear`。
- 只执行一次 `chat.sync(limit=1)`：HTTP 409、`RISK_BLOCKED`、`phase=read`，81ms。证据 `.test-results/recovery-probe-20261019/report.json`。
- 说明问题不是仅等待本地冷却即可解决。停止平台请求，不能认定已恢复。不新增发送、不发布、不自动处理验证码。

## 2026-10-20 00:11 非发布全功能复测：风控复现，未完成

- 基础真实冒烟通过：`.test-results/chrome-live-1792426289412-50868/report.json`，构建身份、心跳、事件续传通过。
- 聊天同步首屏再次失败：`.test-results/chat-sync-behavior-1792426304790-51082/report.json`；随后确认本地 `blocked=true`。上次刷新后成功约 15 分钟即复现，不能认定长期稳定。
- 停止平台请求；搜索、联想、详情、后续同步及发送重放未执行，不能列为本轮通过。
- 本地真实数据的会话、消息、事件、请求审计读取均成功（每项返回 2 条且有续页），风险状态查询成功。报告 `.test-results/non-publish-20261020/report.json`。
- 未调用任何 `publish.*`，未新增消息、未清除本地熔断。
