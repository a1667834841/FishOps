# Issue #4 会话历史分页：实现与验证报告

- worktree：`/Users/wuwenjing/codes/extensions/FishOps-issue-4`
- 分支：`feat/issue-4-chat-history-pagination`
- 基线：`ddee8aad971145f1923b4ed0282dbaf7c4140426`
- 范围：只在上述 worktree 内实现与验证；验证报告记录实现阶段状态；交付信息见关联 PR；未改动主工作树。
- 安全边界：所有浏览器验收只使用 `workbench/test/direct-runtime.html` + `workbench/test/runtime-mock.ts` 的内存 fixture。
  未发送真实聊天、未发布商品、未调用 AI、未读取任何真实会话正文。

## 1. 需求与验收

1. 打开会话只显示最近 10 条，并定位到最新消息。
2. 用户真实上滑（滚轮向上 / `ArrowUp` / `PageUp` / 触摸拖动 / 拖动滚动条）接近顶部时加载更早消息，**单段手势最多加载一页、单次调用最多新增 10 条**；程序性 layout 滚动与惯性事件残留都不触发分页或造成请求循环。
3. 反复加载直到本地缓存与平台历史都耗尽，显示「没有更多了」，之后不再请求。
4. 前插不重复、不跳动；平台游标未严格前进时按失败处理，不宣称耗尽。
5. 加载中与失败状态清晰；失败保留已有消息且不被后续刷新抹掉，只有显式重试才恢复。
6. 新消息到达时自动滚到底（包括正在翻阅历史时）；前插历史保持锚点。
7. 空缓存（窗口为空）也能取到平台最近一页；旧调用方的 `asc + limit` 读取语义与 `limit` / `pages` / `count` 校验契约保持不变。

## 2. 关键设计

### 2.1 协议层（`shared`）

| 变更 | 说明 |
| --- | --- |
| `MessageCursor` | `Pick<ChatMessage, 'createAt' \| 'messageId' \| 'id'>`，与扩展 store 的 `compareMessages` 全序一致，避免同 `createAt` 消息被跳过或重复 |
| `CHAT_GET_MESSAGES` 新增 `before?` | 向前分页的稳定边界（严格小于游标） |
| `CHAT_GET_MESSAGES` 结果新增 `hasMore?` | 可选字段，老调用方拿到 `{ messages }` 原形状 |
| `CHAT_SYNC_HISTORY` 新增 `cursor?` | 透传服务端历史游标 |
| `CHAT_SYNC_HISTORY` 结果新增 `nextCursor?` / `hasMore?` | 让调用方知道平台是否还有更早历史 |
| `codec.ts` | 新增 `isMessageCursor`；`before` 非法即拒（含空串 `id`、非有限 `createAt`）；`cursor` 为**严格正 safe integer**（`0` / 负数 / 小数 / 超界 / 非数字一律拒绝）；`limit` **沿用旧契约（只要求有限数字，可为 0 / 负数 / 小数）**，`pages` / `count` 沿用有限非负，均不因新增分页字段而收紧（原 1..200 的 `isOptionalPageSize` 与 `CHAT_PAGE_MAX` 已移除） |

设计选择：不改 `store.getMessages` 的 `asc + limit` 语义（`reply-runtime.ts:343/:416` 依赖它取最早 200 条），分页统一走新增的 `store.getMessagePage`。

### 2.2 扩展侧（`extension`）

- `store.ts`：新增 `getMessagePage(sessionId, { order, limit, before })`。`before` 时按完整排序过滤出更早的窗口；`hasMore = window.length > limit`；返回的仍是窗口内**最近** `limit` 条，保证连续翻页不重叠、不跳号。
- `bridge-adapter.ts`：`CHAT_GET_MESSAGES` 在 `asc` 且**无** `before` 时仍走 `store.getMessages`（从最早端取 `limit` 条，保持 `reply-runtime.ts:343/:416` 依赖的旧语义，结果仍是 `{ messages }` 原形状）；`desc` 首页与带 `before` 的向前翻页走 `getMessagePage`（窗口内最近 `limit` 条，返回 `hasMore`）。非法 `before` 返回 `INVALID_PAYLOAD`；`CHAT_SYNC_HISTORY` 透传 `cursor`。
- `sync.ts`：`syncHistory` 支持 `cursor` 起点并返回 `nextCursor` / `hasMore`；游标必须**严格向更早推进**（`next < (cursor ?? INITIAL_CURSOR)`），同值 / 反向 / 非法游标一律返回 `{ ok: false, error: { code: 'CURSOR_STALLED', … } }`，既不宣称耗尽也不死循环；失败结果不带游标。

### 2.3 Workbench 侧（`workbench`）

- `chat-center-controller.ts`
  - `MessagesState` 新增 `olderPhase: 'idle' | 'loading' | 'error'`、`olderError`、`hasMore`。
  - 打开会话固定请求 `{ order: 'desc', limit: 10 }`，展示前升序排序。
  - `loadOlder()` 单飞（`olderInFlight`）+ 会话代令牌（`sessionEpoch`）防旧响应污染。**单次调用最多新增 10 条**：每轮用「当前窗口最旧消息」作边界向本地取「剩余额度」；本地取尽仍凑不满 10 条时才按服务端游标同步一页，然后回到本地重新取（边界随之更新，同步写入的更早消息同轮即可读到）；凑满 10 条或本地仍有更早就停，平台同步最多 5 轮。新增额度取 `mergeMessages` 返回的**真实前插条数**（合并窗口长度差），不再按 `state.items.length - started` 计算：并发实时 append 会让旧算法虚增额度、提前停批，把实时新消息当成更早页。
  - `readSyncProgress(result, cursor)` 校验平台游标**严格前进**（`nextCursor < (cursor ?? CURSOR_UPPER_BOUND)`，与 `INITIAL_CURSOR` 对齐），否则置 `olderPhase='error'` 且不推进游标。
  - 会话级 `PagingBook` 记录 `serverCursor` / `serverHasMore` / `localExhausted`，只有**本地与平台都确认耗尽**才置 `hasMore = false`；本地耗尽不得宣称平台耗尽。
  - 空窗口例外：即使 `hasMore=false`（平台已确认无更早历史），空窗口仍允许一次无 `before` 的最近一页查询，避免本地缓存随后写入时被永久卡死。
  - `loadMessages` 刷新时只读最近一页并与已展开窗口合并（按 `id` 去重、稳定升序），绝不缩回 10 条或整体覆盖；同会话刷新保留 `olderPhase` / `olderError`（失败态不被刷新抹掉，因而不会触发自动重试）。
  - `dispose()` 清理分页簿与在途引用。
- `ChatCenterPage.vue`
  - 用户滚动**意图**（`markScrollIntent` / `hasScrollIntent` / `consumeScrollIntent` / `clearScrollIntent`）由 `@wheel`（`deltaY < 0`）、`@keydown`（`ArrowUp` / `PageUp`）、`@touchstart` + `@touchmove`、`@pointerdown`（含滚动条拖动）记录；每段手势序列（相邻手势事件间隔 < `SCROLL_GESTURE_GAP = 200ms`）最多**消费一次**，意图带 `SCROLL_INTENT_TTL = 1200ms` 过期，避免惯性滚动反复触顶把历史连续拉完。
  - `onThreadScroll` 仍只维护 `stickToBottom` 与首条可见消息锚点，但在**有意图且 `scrollTop <= 48`** 时消费一次并 `requestOlder()`：程序化 layout 滚动（吸底 / 锚点补偿前先 `clearScrollIntent()`）不带意图，不会自动拉取历史；同时覆盖「一次大幅 wheel 跨过阈值后停在顶部」与「短首屏无 scroll 事件」（touch / wheel 在顶部直接触发）两种场景。
  - `requestOlder({ manual })` 在 `olderPhase === 'error'` 且非手动时短路：失败后只能点 banner「重试」恢复，不自动重试。
  - `watch` 依赖改为 `[sessionId, tailId, headId]`：尾部变化 = 追加新消息，`appended || stickToBottom` 时直接滚到底（并发追加优先滚底）；头部变化 = 前插，用 `scrollTop += 新位置 - 旧位置` 把同一 `data-mid` 钉回原位。
  - 顶部阈值 `TOP_THRESHOLD = 48`；`.thread__banner` 三条互斥状态：`正在加载更早的消息…`（`role=status`）/ `加载更早的消息失败：…` + 「重试」按钮（`role=alert`）/ `没有更多了`（`role=status`）；消息项带 `:data-mid="message.id"` 供锚点定位。

## 3. 修改文件

| 文件 | 变更 |
| --- | --- |
| `shared/types/chat.ts` | 新增 `MessageCursor` |
| `shared/events/commands.ts` | `before` / `cursor` / `hasMore` / `nextCursor` 字段（全部可选） |
| `shared/events/codec.ts` | `before` 严格校验（`isMessageCursor`）；`cursor` 严格正 safe integer；`limit` 沿用旧契约（只要求有限数字），`pages` / `count` 有限非负，移除 `isOptionalPageSize` 与 `CHAT_PAGE_MAX` |
| `extension/src/chat/store.ts` | `getMessagePage`、`MessagePageQueryOptions`、`MessagePageResult`、`compareMessages` 签名放宽（`getMessages` 旧语义不变） |
| `extension/src/chat/bridge-adapter.ts` | `asc` 无 `before` 保留 `getMessages`；`desc` 首页与 `before` 翻页走 `getMessagePage`；`cursor` 透传 |
| `extension/src/chat/sync.ts` | `syncHistory` 游标 / `nextCursor` / `hasMore`；`readHistoryProgress` 严格前进，未前进返回 `CURSOR_STALLED` |
| `extension/src/chat/test/store.test.ts` | +4 用例（分页窗口 / 连续翻页 / 同 `createAt` 边界 / 缺省 limit） |
| `extension/src/chat/test/sync.test.ts` | +4 用例（游标续翻 / 多页游标 / 无进展不死循环 / 失败不带游标） |
| `extension/src/chat/test/bridge-adapter.test.ts` | +4 用例（limit+hasMore / before 翻页与非法游标 / 兼容旧形状 / cursor 透传） |
| `extension/src/chat/test/pagination-protocol.test.ts` | 新建：codec 分页字段校验（`before` 严格、`cursor` 严格正 safe integer、`limit` 只要求有限数字、`pages` / `count` 旧契约） |
| `workbench/src/features/chat/types.ts` | `MessageCursor` 类型别名 |
| `workbench/src/features/chat/chat-center-controller.ts` | 分页状态、单飞、会话代、单次上限 10 的 `loadOlder`（新增额度按真实前插计数）、严格游标、空窗口例外、刷新合并与失败态保留 |
| `workbench/src/features/chat/test/chat-center-controller.test.ts` | 更新打开会话断言 + 分页用例（单次上限 / 空缓存 / 严格游标 / 失败态保留 / 并发实时 append 计数不虚增） |
| `workbench/src/features/chat/test/chat-center-pagination-page.test.ts` | 新建：页面源码断言（`onThreadScroll` 只在带意图到顶时消费一次、`wheel` / `keydown` / `touch` / `pointer` 记录意图、`tailId` / `headId` watch） |
| `workbench/src/pages/ChatCenterPage.vue` | 多手势意图（wheel / keydown / touch / pointer）驱动分页、每段手势只消费一次、`tailId` / `headId` 区分追加与前插、滚动锚点、分页 banner、失败仅手动重试 |
| `workbench/test/runtime-mock.ts` | 聊天安全 fixture（会话 / 本地 35 条 / 平台 20 条 / 实时注入 / 故障注入 / `clearLocal()`）与事件信封修复 |

## 4. 测试证据

### 4.1 先红后绿（回归先行）

本轮修正按「先写失败测试、再改实现」推进，红灯与绿灯各记录一次：

1. 红灯（补测试后、改实现前）
   - `npm run test --workspace @fishops/workbench` → **EXIT 1**，8 个失败：3 个页面源码断言（`chat-center-pagination-page.test.ts`）+ 5 个控制器用例（`单次 loadOlder 新增上限…`、`空缓存…`、`服务端游标只成功推进…`、`平台游标无进展或反向…`、`本地耗尽但平台仍有更早历史…`）。
     其中既有用例 `本地耗尽但平台仍有更早历史` 在旧实现下得到 15 条而不是 20 条，直接暴露「固定单次边界 + 递减 limit 读到重复条目」的缺陷。
   - `npm run test:chat --workspace @fishops/extension` → **EXIT 1**，6 个失败：`asc + limit 保持旧语义`、`limit 保持旧契约`、`pages/count 保持旧契约`、`syncHistory：初次游标不推进 / 游标反向 / 游标无进展时返回结构化错误`。
2. 绿灯（改实现后）
   - `npm run test --workspace @fishops/workbench` → **EXIT 0**，tests 389 / pass 389 / fail 0（其中本轮定向 review 新增 1 个并发实时 append 用例）。
   - `npm run test:chat --workspace @fishops/extension` → **EXIT 0**，tests 306 / pass 306 / fail 0。

### 4.2 单元 / 集成（Node test）

| 场景 | 断言要点 |
| --- | --- |
| 打开会话只取最近 10 条 | 恰好 1 次 `CHAT_GET_MESSAGES`，payload 为 `{sessionId, order:'desc', limit:10}`，展示升序 10 条，`hasMore=true` |
| 连续向前每批 10 条 | 20 条（消息 6..25）→ 25 条（消息 1..25），无重复、顺序稳定 |
| 单次新增上限 10 条 | 本地不足时逐轮补同步，但每次 `loadOlder` 最多前插 10 条（一次同步即达上限），不把平台多页一次拉完 |
| 同一 `createAt` 不漏 | `groupSize=5` 分组下最终仍能取满 25 条（游标用三要素而非时间戳） |
| 重复触顶单飞 | 并发 3 次 `loadOlder` 只产生 1 次本地请求 |
| 本地耗尽但平台更早 | 触发 `CHAT_SYNC_HISTORY`（首跳不带 `cursor`），把更早消息并入后仍为 1 个窗口（15 → 20 条） |
| 游标严格前进 | 两跳 payload 依次为「无 `cursor`」与 `{cursor:7}`；同值 / 反向 / 非法游标 → `olderPhase='error'`，不宣称耗尽 |
| 空缓存无 `before` | 空窗口 `loadOlder` 仍发起「无 `before` 的最近一页」查询；平台确认耗尽后本地写入，再次 `loadOlder` 仍可补齐 |
| 刷新保留分页失败 | `olderPhase='error'` 在实时事件触发的刷新后保持，不自动重试；仅显式重试恢复 |
| 平台失败 | 保留已加载 15 条，`olderPhase='error'`，重试一次后恢复 |
| 切会话在途返回 | 旧响应不污染新会话（`sessionId` 仍为 `b`） |
| dispose | 在途返回后不再写入状态 |
| 实时刷新 | 只读最近 10 条但不缩回窗口，合并平台新消息后为 21 条 |
| 手动同步历史 | 不覆盖已展开的 20 条窗口 |
| **加载到底后刷新** | 刷新后 `hasMore` 保持 `false`，再次 `loadOlder` 不产生请求 |
| `asc + limit` 旧语义 | 无 `before` 时仍返回最早 10 条且形状为 `{ messages }`（`reply-runtime` 兼容）；`desc + limit` 取最近 10 条并返回 `hasMore` |
| **并发实时 append 不虚增额度** | `loadOlder` 期间实时消息追加到底部时，新增额度只算本次真实前插的更早页；断言窗口 = 原一页 + 一页更早 + 实时新消息（26 条）、首页仍为平台更早页（`平台1`），恢复 `items.length - started` 旧算法该用例失败（实际 6 条更早、期望 10） |

### 4.3 浏览器 DOM 验收（安全 fixture，ego-browser TaskSpace 254 / Page `p1`）

启动方式（必须在 `workbench/` 目录内，才能加载 `vite.config.ts` 的 alias）：

```bash
cd worktree/workbench && nohup npx vite --port 5199 --strictPort > /tmp/vite-dev.log 2>&1 &
# 打开 http://localhost:5199/test/direct-runtime.html
```

fixture 数据：本地缓存 `t001..t035`（`createAt = 100000 + 1000*i`）、平台更早历史 `p001..p020`（`createAt = 1000 + 10*i`）、
实时注入 `rNNN`。钩子挂在 `window.__FISHOPS_CHAT_FIXTURE__`：`failOlderRequests`、`olderDelayMs`、`getRequests`、`syncRequests`、`injectRealtime()`、`clearLocal()`。

| 场景 | 用户动作 | 状态变化 | 可见界面 | 副作用 |
| --- | --- | --- | --- | --- |
| 打开会话定位最新 | 点击唯一会话 | 1 次 `{order:'desc', limit:10}` | 10 条 `t026..t035`、`scrollTop=363.5=scrollHeight-clientHeight`（底部）、banner 空 | 无 `CHAT_SYNC_HISTORY` |
| 程序性 layout 不触发分页 | 脚本设 `scrollTop = 0` 后等待 0.8s | 请求数保持 1 | 仍 10 条 | 0 次新请求（修复前此处会自动拉取） |
| 真实上滑每次 +10 | 鼠标置于消息区后 `wheel(0,-600)` | 每次新增 1 次 `{order:'desc', limit:10, before:'<当前最旧>'}` | 20 → 30 → 40 → 50 条 | 单次增量恒为 10 |
| 前插锚点不跳动 | 同会话前插一次 | 锚点消息位置不变 | 同一 `data-mid` 相对容器顶部偏移 0px | 无 |
| 加载中可见 | 设 `olderDelayMs=800` 后上滑 | `olderPhase='loading'` | 先「正在加载更早的消息…」→ banner 空、消息 +10 | 无 |
| 本地不足补同步 | 继续上滑（本地只余 5 条） | `{count:10}` → 再 `{cursor:10,count:10}` | 请求序列见下 | 平台两页同步后才耗尽 |
| 反复翻页到耗尽 | 连续上滑 | 每次新增 ≤10（本地读 limit 按剩余额度 10 / 10 / 10 / 5、10 / 5 / 10） | 55 条 `p001..t035`、`unique=55`、banner「没有更多了」 | `syncRequests=[{count:10},{cursor:10,count:10}]` |
| 耗尽后不再请求 | 再上滑 4 次 | 请求数保持 8 | banner 仍「没有更多了」 | 0 次新请求 |
| 短首屏（无溢出）真实上滑 | 消息区高度设为 900px（`overflow=0`）后上滑 | 请求 1 → 3 | 10 → 30 条 | 无溢出时真实手势仍可分页；程序滚动不触发 |
| 本地缓存被清空后补全 | `clearLocal()` 后刷新（窗口保留 10 条）再上滑 | 第 1 次 `before:t026` 取到 0 条 → `{count:10}` → 再查 `before:t026` | 20 条 `p011..p020 + t026..t035` | 单次仍 ≤10 |
| 失败不自动重试 | `failOlderRequests=1` 后上滑 | 1 次 `before` 请求失败 | banner「加载更早的消息失败：TEST_OLDER_FAIL: 本地模拟向前分页失败 + 重试」、仍 10 条 | 注入实时消息刷新后请求数仍 1（**不自动重试**），消息 11 条 |
| 手动重试恢复 | 清除故障后点 banner「重试」 | 请求 1→2 | 21 条、banner 空 | 只有显式点击才恢复 |
| 历史视图实时 append 滚底 | 上滑到顶（`atBottom=false`、`scrollTop=526/1048`）后注入实时消息 | 刷新合并 `r001` | 21 条、`scrollTop=1117=maxScroll`、`atBottom=true` | 尾部追加优先滚底，不被历史浏览位置截停 |

关键请求序列（耗尽场景，`getRequests` 原文）：

```json
[{"order":"desc","limit":10},{"order":"desc","limit":10,"before":"t026"},
 {"order":"desc","limit":10,"before":"t016"},{"order":"desc","limit":10,"before":"t006"},
 {"order":"desc","limit":5,"before":"t001"},{"order":"desc","limit":10,"before":"p016"},
 {"order":"desc","limit":5,"before":"p011"},{"order":"desc","limit":10,"before":"p006"}]
```

每轮新增量恒为 10（末轮补 5 条本地 + 5 条平台后耗尽），没有一次超过 10 条。

空缓存（`items` 为空）时的「无 `before` 最近一页」路径在浏览器里**不可达**：窗口为空时页面渲染 `.thread__empty` 空态（引导「同步历史」），不渲染 `#message-stream`，因此没有可上滑的区域；
该路径由控制器单测（`空缓存：窗口为空时 loadOlder 仍取最近一页`）锁定，浏览器侧验证的是等价可达路径（本地缓存被清空后的自动补全）。
空态本身已有可操作的「同步历史」按钮入口，本轮不额外改空态。

#### 4.3.1 定向 review 后复验（consume-once / 计数 / 契约）

同一 fixture 与 TaskSpace，在最终代码状态下逐项重验：

| 场景 | 用户动作 | 状态变化 | 可见界面 | 副作用 |
| --- | --- | --- | --- | --- |
| 一次大幅 wheel 抵顶只拉一页 | 会话已吸底（`scrollTop=364`），鼠标置于消息区后单次 `wheel(0,-3000)` | 恰好 1 次 `{order:'desc',limit:10,before:'t026'}` | 10 → 20 条（`t016..t035`） | 修复前同一动作连发 6 次请求、拉到 50 条 |
| 短首屏仍可分页 | viewport 放大至 1500px 高使 `scrollHeight=1056=clientHeight`（无可滚动距离）后单次 `wheel(0,-400)` | 1 次 `before` 请求 | 10 → 20 条 | 无溢出时真实手势仍可分页 |
| 触摸上滑 | `Input.synthesizeScrollGesture`（`gestureSourceType:'touch'`）在消息区上滑 400px；DOM 探针记录 `touchstart=1 / touchmove=4` | 1 次 `before` 请求 | 10 → 20 条 | 真实触摸手势（非 DOM 构造事件）已到达页面 |
| 滚动条拖动 | 合成本地 `pointerdown`（进入 `@pointerdown`）+ 受控设 `scrollTop=0` 并派发 `scroll`；CDP 合成鼠标拖动 native 滚动条不生效，此处为 **DOM 受控 input 模拟（已注明）** | 1 次 `before` 请求 | 10 → 20 条 | 拖动路径（指针按下 + scroll 到顶）可触发分页 |
| 失败不自动重试 | `failOlderRequests=1` 后单次上滑，等待 3.5s，再点「重试」 | 失败 1 次请求；等待后仍为 1 次；点击后 1 → 2 次 | `role=alert` banner「加载更早的消息失败：TEST_OLDER_FAIL…」+ 「重试」（仍 10 条）；点后 banner 空、20 条 | 失败态 banner 改变容器高度也不产生自动重试或请求循环 |

## 5. 过程中发现并修复的缺陷

1. **失败后无限自动重试（页面）**
   修复前：`failOlderRequests=99` + 滚到顶部，2 秒内产生 **95 次** `CHAT_GET_MESSAGES`；banner 在「加载中」与「失败」之间反复切换，`scrollTop` 在 `31 ↔ 39` 抖动。
   根因：两态 banner 高度不同 → 滚动容器高度变化 → 触发新的 `scroll` → `onThreadScroll` 再次 `requestOlder`（只按 `olderPhase !== 'loading'` 短路）。
   修复：`onThreadScroll` 增加 `!stickToBottom` 条件；`requestOlder({ manual })` 在 `olderPhase === 'error'` 且非手动时直接返回，失败后只能由 banner「重试」按钮恢复。
   修复后：同场景 2 秒内仅 1 次请求，banner 与 `scrollTop` 稳定。

2. **加载到底后刷新会重新开启 `hasMore`（控制器）**
   刷新只读最近 10 条，本地库仍比这一页多，`page.hasMore` 会再次为真，导致「没有更多了」消失并多出一次空请求。
   修复：`PagingBook.localExhausted` 记录「向前查询已取尽」，刷新时 `hasMore = (page.hasMore && !localExhausted) || serverHasMore`。

3. **测试夹具事件未送达（harness）**
   `runtime-mock.ts` 的 `emit` 构造的信封缺少 `kind:'event'` / `eventId` 且用 `timestamp` 而非 `emittedAt`，被 `isEventEnvelope` 静默丢弃；
   订阅列表原本是全局单例，多个客户端会互相覆盖。修复为合法 `EventEnvelope`（`protocol: PROTOCOL_VERSION`）并按 Port 隔离订阅，与 background 精确投递一致。

4. **单次 `loadOlder` 会一次拉完平台（A）**
   修复前：`before` 固定在调用开始时的最旧消息，逐轮用递减的 `remaining` 再查本地，读到重复条目；本地报 `hasMore=false` 时反而继续同步，最终一次调用可能并入平台多页（实测 30 → 55 条）。
   修复：每轮刷新边界、按「剩余额度」取本地、凑满 10 条即停、平台同步最多 5 轮。浏览器实测每次新增恒为 10（末轮 5+5 后耗尽）。

5. **空缓存永远加载不出最近一页（B）**
   修复前：`loadOlderFromLocal` 在 `before` 为 `undefined` 时直接返回 `false`，且 `loadOlder` 在 `hasMore=false` 时提前返回，空窗口即使平台有数据也无法补齐。
   修复：空窗口例外 + 无 `before` 的最近一页查询。

6. **刷新会抹掉分页失败态（C）**
   修复前：`loadMessages` 成功分支无条件重置 `olderPhase='idle'` / `olderError=null`，一次实时事件就能让失败态消失并触发自动重试。
   修复：同会话刷新保留 `olderPhase` / `olderError`；浏览器实测失败后注入实时消息，请求数不变、banner 仍为失败态，直到点「重试」。

7. **程序性滚动会驱动分页、历史浏览时新消息不滚底（D）**
   修复前：`onThreadScroll` 直接调用 `requestOlder`，短首屏（无溢出）刚打开就会连续拉取；`watch` 只看 `sessionId` 与长度，无法区分追加与前插，历史浏览中新消息到达时不回到底部。
   修复：`onThreadScroll` 只维护吸底与锚点，分页改由 `@wheel`（`deltaY < 0` 且到顶）与 `@keydown`（`ArrowUp` / `PageUp`）触发；`watch` 用 `tailId` / `headId` 区分追加（优先滚底）与前插（锚点补偿）。

8. **平台游标未严格前进被当成耗尽（E）**
   修复前：`nextCursor !== cursor` 把同值 / 反向游标当成终点，`hasMore=false` 静默宣称「没有更多了」，可能丢掉更早历史。
   修复：`sync.ts` 的 `readHistoryProgress` 与控制器 `readSyncProgress(result, cursor)` 均要求 `next < (cursor ?? 初始游标)`，否则返回 `CURSOR_STALLED` 结构化错误并进入 `olderPhase='error'`。

9. **旧 `asc + limit` 语义被改、协议校验被无谓收紧（F）**
   修复前：`CHAT_GET_MESSAGES` 无条件走 `getMessagePage`，使「从最早端取 N 条」变成「最近 N 条」，`reply-runtime.ts:343/:416` 会拿到错误窗口；同时把 `limit` / `pages` / `count` 从旧契约收紧为 1..200。
   修复：`asc` 且无 `before` 仍走 `getMessages`（形状 `{ messages }` 不变）；`desc` 首页与 `before` 翻页走 `getMessagePage`；codec 校验回旧契约，仅 `before` / `cursor` 严格。

10. **一次大幅 / 惯性滚动会把历史连续拉完（页面）**
    修复前：意图只有 400ms 绝对时间窗口，同一惯性序列内的每个 wheel / scroll 事件都会重复置位；实测单次 `wheel(0,-3000)` 触发 6 次 `CHAT_GET_MESSAGES`、从 10 条拉到 50 条。
    修复：意图改为「每段手势序列（事件间隔 < `SCROLL_GESTURE_GAP = 200ms`）最多消费一次」（`consumeScrollIntent`），程序化滚动只清待消费意图、保留手势序列记忆，避免惯性事件被误判为新手势。
    修复后：同一动作恰好 1 次请求、+10 条，继续等待不再新增。

11. **`loadOlder` 新增额度被并发实时 append 虚增（控制器）**
    修复前：`added = state.items.length - started`，刷新合并进来的实时新消息也会计入「更早页额度」，导致提前停批、少前插（实测同一场景只拿到 6 条更早页而非 10 条）。
    修复：`mergeMessages` 返回真实前插条数，`loadOlder` 按 `added += page.added` 累加，每批仍 ≤ 10 条。

12. **分页字段校验契约被误收紧 / 需收紧（协议）**
    修复前：`limit` 被改成 `isOptionalPositiveNumber`（引入非负限制，破坏旧调用方传负数的行为）；`cursor` 只要求非负有限数字，`0` 被当成合法游标。
    修复：`limit` 恢复内联 `Number.isFinite` 校验（可为 0 / 负数 / 小数）；`cursor` 收紧为 `Number.isSafeInteger && > 0`；协议测试同步（`limit:-10` → `true`，`cursor:0` → `false`）。

## 6. 验证命令与退出码

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run typecheck`（根：shared → extension → workbench） | 0 | 无错误 |
| `npm run test:background --workspace @fishops/extension` | 0 | tests 139 / pass 139 / fail 0 |
| `npm run test:chat --workspace @fishops/extension` | 0 | tests 306 / pass 306 / fail 0（本轮 +3） |
| `npm run test --workspace @fishops/workbench` | 0 | tests 389 / pass 389 / fail 0（本轮 +1 并发实时 append 用例） |
| `npm run build` | 0 | 真实构建成功（extension + workbench，`ChatCenterPage-DCWazmSH.js` 46.78 kB） |
| `npm run test:smoke`（构建产物后） | 0 | 21 通过，0 失败 |
| `npm run test:security` | 0 | 40 通过，0 失败 |
| `git diff --check` | 0 | 无空白/冲突残留 |

本轮原始日志（文档定稿后按最终代码状态整体重跑一次，退出码均为 0）：`/tmp/final-typecheck.log`、`/tmp/final-wb.log`、`/tmp/final-chat.log`、`/tmp/final-bg.log`、`/tmp/final-build.log`、`/tmp/final-smoke.log`、`/tmp/final-security.log`；
定向 review 修正后的最终重跑：`/tmp/f2-typecheck.log`（EXIT 0）、`/tmp/f2-chat.log`（306 pass）、`/tmp/f2-wb.log`（389 pass）、`/tmp/f2-bg.log`（139 pass）、`/tmp/f2-build.log`（EXIT 0）、`/tmp/f2-smoke.log`（21 通过）、`/tmp/f2-security.log`（40 通过）；
先红后绿日志：`/tmp/wb-test-1.log`（EXIT 1，8 个失败）、`/tmp/ext-test-chat-1.log`（EXIT 1，6 个失败）。

## 7. 产物与刷新方式

- `npm run build` 输出到 `extension/dist/`（本轮：`background.js` 约 828 KB、`assets/`、`content/`、`manifest.json` 等）。
- 浏览器验收刷新方式：改动 `workbench/src/**` 时 Vite HMR 自动生效；改动 `workbench/test/runtime-mock.ts` 需整页 reload（`page.goto(...)`）。
- 重新跑浏览器验收：按 4.3 的启动命令起 Vite，再用 ego-browser 打开 `http://localhost:5199/test/direct-runtime.html`。

## 8. 验收边界（真实 vs mock）

- 本轮**实际验证**：协议校验、扩展 store / sync / bridge、workbench 控制器、页面滚动与锚点行为、分页与失败状态、
  真实构建产物、smoke 与 security 检查。
- 本轮**未验证（按任务约束刻意不做）**：真实闲鱼平台的 `LWP` 分页响应、真实账号的会话正文、发布与 AI 调用。
  平台侧「是否真的还有更早历史」只用安全 fixture 模拟（`hasMore` / `nextCursor` 语义已按真实 `history.ts` 的返回形状对齐）。
- 因此「平台历史耗尽」的判定逻辑在 fixture 中成立；对真实平台的最终确认需在允许真实账号的环境按同一动作顺序复跑。

## 9. 遗留

- 空窗口（`items` 为空）时页面渲染 `.thread__empty` 空态、不渲染 `#message-stream`，因此「无 `before` 取最近一页」在 UI 上不可达（只由控制器单测覆盖）。若希望用户能直接触发，需要在空态额外提供「加载最近消息」入口——本轮未做，因空态已引导「同步历史」。
- `workbench/tsconfig.json` 的 `include` 不含 `test/`，`runtime-mock.ts` 只经过 Vite 转译、不参与 `vue-tsc` 类型检查。本轮保持其类型干净，但如需强约束需另行调整 tsconfig。
- 浏览器验收的 TaskSpace 254 在定向 review 复验结束时已 `task.finish({ keep: [] })` 关闭；本轮启动的 Vite 开发服务器（PID 33128 / 33149，端口 5199）已停止（只停明确 PID）。后续如需复跑按 4.3 命令重新启动。
- 未提交、未推送、未创建 PR（按任务要求）。
