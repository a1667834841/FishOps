# 主动创建闲鱼商品会话（商品 → 会话）验证报告

- 日期：2026-10-05
- 范围：仅验证「如何主动创建闲鱼商品会话」，不实现 AI 询价业务代码。
- 前置：`docs/ai-inquiry-agent-backend-recon.md` 已确认现有发送器要求已有 `sessionId`，缺少「商品 → 新 sessionId」路径。
- 结论：**已定位并用真实浏览器观察该路径**。商品详情页「我想要 / 聊一聊」是导航链接，暴露 `sellerId`；IM 页据此调用 LWP `/r/SingleChatConversation/create` 创建会话并返回 `cid`（即 `sessionId`）。本次样本**建聊未观察到发送消息**，但**已在服务端创建了空会话**（改变服务端状态）。本次样本**重复 create 返回 500，原因未确认**；不要依赖重复 create 成功，建议先查后建。

> 本报告以只读协议调查为主，另真实创建了 1 个服务端空会话（该步改变服务端状态，非只读）。未发送任何询价 / 测试 / 打招呼消息，未下单、未改价，未采集或泄露 cookies/token。

---

## 0. 结论摘要

| 问题 | 结论 | 证据等级 |
|---|---|---|
| 「我想要」点击是否自动发送消息 | 本次样本**未观察到发送消息**；详情页是 `<a href>` 导航，IM 页仅创建会话 | 网页 JS（静态）+ 单样本观察 |
| 商品如何拿到 sellerId | 详情页「聊一聊」链接的 `peerUserId` | 单样本 DOM 观察 |
| 如何创建会话拿 sessionId | LWP `/r/SingleChatConversation/create`，返回 `body.singleChatConversation.cid` | 单样本真实观察 |
| 创建是否幂等 | **未确认**。本次样本重复 create 返回 500，**原因未确认**；不要依赖重复 create 成功 | 单样本真实观察 |
| 已有会话如何复用 | 会话列表 `/r/Conversation/listNewestPagination` 可反查 `itemId → cid` | 单样本真实观察 |
| 现有发送器可否直接接 | 可以（源码对照，未端到端验证）：`sessionId`（去 `@goofish`）+ `receiverId`(sellerId) + `myId` | 源码 + 协议对照 |
| 现有代码是否有建聊封装 | **无**，且现有 LWP 白名单未登记创建路由 | 源码 |

---

## 1. 证据等级与验证方法

- **源码推断**：阅读本项目 `extension/src/chat/*`、`shared/chat/protocol.ts`、`shared/types/reply.ts`。
- **网页 JS（静态）**：只读拉取闲鱼 PC 前端 bundle `p_im-index.js`（xy-site `0.0.176`）并检索关键字，未执行其业务写操作。
- **单样本真实观察**：用真实浏览器（已登录态）在 MAIN world 注入**只记录、并主动拦截任何 `MessageSend/sendByReceiverScope`** 的 WebSocket hook，全程观察 LWP 帧。观察期间**未发出任何消息帧**（`MessageSend` 计数 = 0，拦截计数 = 0）。注意：建聊本身会**创建服务端空会话**，不是纯只读。

验证范围限制：
- 仅使用 1 个浏览器 taskSpace（`spaceId=211`），全程复用同一页面。
- 仅对一个商品样本做「创建空会话」观察；未遍历多商品、未发送消息。**所有接口结论仅代表该单样本，未做普遍性验证。**
- 未做「发送询价消息」端到端验证（需用户另行授权，见 §8）。

---

## 2. 真实入口与链路

商品详情页（如 `https://www.goofish.com/item?id={itemId}&categoryId=...`）的「我想要」按钮实际渲染为：

```html
<a class="want--..." href="https://www.goofish.com/im?itemId={itemId}&peerUserId={sellerId}">聊一聊</a>
```

要点：

1. 该元素是 `<a href>` 链接，点击即浏览器导航到 IM 页，本身不发送消息。
2. `sellerId`（卖家用户 ID）**直接暴露在该链接的 `peerUserId` 参数**，无需额外接口。
3. 商品详情页**不建立聊天 WebSocket**；单样本观察其资源请求仅有 `mtop.taobao.idle.pc.detail`、`mtop.taobao.idlemessage.pc.loginuser.get` 等，无 `wss-goofish.dingtalk.com`。聊天长连接只在 IM 页建立（`wss://wss-goofish.dingtalk.com:443`）。

链路：

```
商品详情页(/item?id=itemId)
  └─「聊一聊」<a href="/im?itemId=itemId&peerUserId=sellerId">
       └─ IM 页(/im)
            ├─ 建立 WebSocket wss-goofish.dingtalk.com
            └─ 读取 URL 参数 itemId / peerUserId
                 └─ LWP /r/SingleChatConversation/create
                      └─ 返回 singleChatConversation.cid → sessionId
```

---

## 3. 创建会话接口的真实参数与响应（单样本真实观察）

### 3.1 请求

- 路由（LWP，走页面已建立的聊天 WebSocket）：`/r/SingleChatConversation/create`
- 信封：`{ lwp: "/r/SingleChatConversation/create", headers: { mid }, body: [ {...} ] }`
- `body[0]` 真实字段（观察值，ID 已脱敏）：

```json
{
  "pairFirst":  "<较小 userId>@goofish",
  "pairSecond": "<较大 userId>@goofish",
  "bizType": "1",
  "extension": { "itemId": "1089306208893", "orderId": "", "source": "" },
  "ctx": { "appVersion": "1.0", "platform": "web" }
}
```

- `pairFirst` / `pairSecond` 是双方 `userId@goofish`（小者在前）。**该排序规则来自网页 JS 分析（`createItemImSession` 内对双方排序）与本次单样本观察，未做普遍实测。** 本次样本：`pairFirst=2***920@goofish`（卖家），`pairSecond=2***611@goofish`（本人）。
- `bizType` 来自页面 `createItemImSession` 的第 3 参；商品入口默认 `"1"`。

### 3.2 响应（新建成功）

```json
{
  "code": 200,
  "body": {
    "visible": 0,
    "joinTime": 1791153771901,
    "singleChatConversation": {
      "cid": "67***724@goofish",
      "pairFirst": "2***920@goofish",
      "pairSecond": "2***611@goofish",
      "bizType": "1",
      "createAt": 1791153771000,
      "extension": {
        "itemId": "1089306208893",
        "itemSellerId": "2***920",
        "extUserId": "2***611",
        "ownerUserId": "2***920",
        "itemTitle": "…",
        "squadId_2***920": "1089306208893",
        "squadName_2***611": "…"
      }
    }
  }
}
```

- `sessionId` = `cid` 去掉 `@goofish` 后缀（源码 `convertIdToUI` 即「去掉 `@<domain>`」）。
- 本次观察该响应**不含 `lastMessage` 字段** —— 据此判断本次建聊未发送消息；但会话已在**服务端创建**（改变服务端状态）。
- `extension.itemId` / `itemSellerId` / `extUserId` 可直接用于本地关联商品与买卖双方。

### 3.3 网页 JS 对应实现（静态分析）

bundle `p_im-index.js` 中：

- `createItemImSession(itemId, peerUserId, bizType, orderId, source)`
  → 归一 pair（双方 `userId@goofish`，升序）
  → `convService.createSingleConversation({ pairFirst, pairSecond, bizType, extension:{ itemId, orderId, source }, ctx })`
  → 返回 `convertIdToUI(cid)`。
- `createSingleConversation` → LWP `rO(...)`，成功判据 `response.code === 200`。
- **该函数内不含任何 `sendMessage` 调用。**

### 3.4 URL 参数

IM 页从 URL 读取：`itemId`、`peerUserId`、`createSessionType`、`enterSessionId`、`orderId`、`isLockList`。

- 商品详情页「聊一聊」链接只带 `itemId` + `peerUserId`（无 `createSessionType`），走默认 `bizType=1`。
- 另存在页面内 `window.postMessage({ type: "switchSessionInPage", itemId, peerUserId, ... })` 机制，效果同样是「创建/切换会话」。

---

## 4. 建聊是否自动发送消息

**本次样本结论：建聊未观察到发送消息；但建聊创建了服务端空会话。**

1. 网页 JS（静态分析）：`createItemImSession` / `createSingleConversation` 内无 `sendMessage`；调用处仅 `postMessage` + 切换会话。
2. 单样本真实观察：进入 `/im?itemId=...&peerUserId=...` 后，WebSocket 发出的 LWP 依次为
   `/reg`、`/r/Conversation/listNewestPagination`、**`/r/SingleChatConversation/create`**、`/r/SyncStatus/*`、`/r/Conversation/listTop`、`/r/MessageManager/listUserMessages`、`/r/Conversation/getByCids`；
   观察窗口内 `MessageSend/sendByReceiverScope` 出现次数 = 0。
3. 本次观察该会话响应无 `lastMessage`。
4. 「主动阻止写消息」防护 hook 的拦截计数 = 0（观察窗口内没有写消息尝试）。

限定：以上均为**单个商品样本**的观察，**未证明**所有商品/场景都不发送消息。建聊**改变了服务端状态**（创建了空会话），**不是只读操作**；是否对卖家产生任何通知**未验证**，不作断言。

---

## 5. sellerId / sessionId / myId 获取与接入现有发送器

现有发送硬约束（`extension/src/chat/send-protocol.ts`）要求 `sessionId` / `receiverId` / `myId` / `content` 非空且均不含 `@` 后缀。

| 字段 | 来源 | 说明 |
|---|---|---|
| `sellerId` / `receiverId` | 商品详情页「聊一聊」链接 `peerUserId`（或已建会话 `extension.itemSellerId`） | 单样本观察可直接获取 |
| `sessionId` | `/r/SingleChatConversation/create` 返回 `cid`（去 `@goofish`），或已有会话列表反查 | 去掉后缀 |
| `myId` | `mtop.taobao.idlemessage.pc.loginuser.get`；或从 create 请求的 `pairFirst`/`pairSecond` 中排除 `sellerId` 得到 | 本人 userId |
| `content` | 业务侧生成 | 发送时再定 |

接入方式（不改现有发送器语义）：

1. 先获得 `sessionId`（建聊或反查）。
2. 调用现有 `ChatMessageSender.sendText({ sessionId, receiverId: sellerId, myId, content })`。
3. 发送 transport 仍走 `/r/MessageSend/sendByReceiverScope`（与网页 bundle 观测一致）。

代码层关键约束（源码推断）：

- `shared/chat/protocol.ts` 的 `LWP_ROUTES` 只登记了 `listNewestPagination` / `listUserMessages` / `clearRedPoint`，**未登记** `/r/SingleChatConversation/create`。
- `extension/src/chat/send-transport.ts` 的发送白名单**只允许** `/r/MessageSend/sendByReceiverScope`。
- 因此「建聊」需要**新增一条独立的只读/建聊 transport 路由白名单**，不能塞进发送 transport。
- 创建会话与发送一样依赖**页面已建立的聊天 WebSocket**（IM 页）。商品详情页无 socket，不能在详情页直接建聊；需在 goofish IM 页 MAIN world 执行（与现有 `chat-main.ts` 注入模式一致）。

---

## 6. 重复创建与已有会话处理（幂等性未确认）

### 6.1 本次样本重复 create 返回 500（原因未确认）

- 首次创建（本样本无既有会话）→ `code: 200`，返回新 `cid`。
- 同一 pair 再次创建 → `code: 500`，`body: { reason: "闲鱼走神了，您稍后再试～", code: "EXCEPTION", scope: "IMPaaSApp" }`。
- 间隔 45 秒后重试仍为 500。**本次样本无法区分**「重复创建冲突」「频控/限流」「登录态或服务异常」等原因，**原因未确认**，也未做普遍性验证。

因此：**不要依赖重复 create 成功**；建议先查已有会话，创建失败后再反查会话列表。

### 6.2 已有会话的反查路径（单样本真实观察）

重新加载无参 `/im` 后，`/r/Conversation/listNewestPagination` 响应中出现了该会话条目：

```
... "itemId":"1089306208893","itemSellerId":"2***920" ...
    "cid":"67***724@goofish","pairFirst":"2***920@goofish","pairSecond":"2***611@goofish" ...
```

即**可通过会话列表按 `itemId`（或 `pairFirst/pairSecond`）反查已有 `cid`**。本项目已有该路由的只读解析能力（`extension/src/chat/history.ts` 的 `reminderUrl` 解析），可作为幂等判定的基础。

### 6.3 建议策略：先查后建（推断，未实现）

1. 先从本地会话 store / `listNewestPagination` 按 `itemId + sellerId` 查已有会话。
2. 命中 → 复用其 `sessionId`，**不调用 create**。
3. 未命中 → 调用 `/r/SingleChatConversation/create` 拿新 `sessionId`，并落库关联 `itemId`。
4. **创建失败时的兜底**：再次走会话列表反查；不要假设 create 可安全重试。

---

## 7. 失败原因与风险

| 现象 | 原因 | 处理方向 |
|---|---|---|
| create 返回 500 `EXCEPTION`「闲鱼走神了」 | **原因未确认**（重复冲突/频控/登录或服务异常均有可能） | 不要依赖重复 create 成功；先查后建，创建失败再反查 |
| create 无 socket / 失败 | 不在 IM 页或聊天 WebSocket 未建立 | 在 IM 页 MAIN world 执行；等待 socket ready |
| 无 `myId` | 未登录 | 需登录态（`idlemessage.pc.loginuser.get`） |
| 参数被拒（推断） | `pairFirst/pairSecond` 未升序、缺 `@goofish`、`bizType` 非法 | 按 §3.1 归一 |
| 发送被拒 | 现有 `validateSendInput` 要求 ID 不含 `@` | 建聊结果去掉 `@goofish` 再传发送器 |

风险提示：

- 建聊**会真实创建服务端会话**（改变服务端状态，**非只读**）；本次样本未观察到发送消息。是否对卖家产生任何通知**未验证**，不作断言。
- 500 的错误归因未确认；不要依赖重复 create 成功。
- 频控/限流未知：本样本未观察到限流，但未验证批量建聊上限（待确认）。
- 会话/任务持久化在 `storage.session`，浏览器关闭即清空（见既有 recon §3.8），建聊结果与商品关联需另行落盘策略。

---

## 8. 后续最小验证步骤（**需用户授权**）

以下动作会对外产生消息，属「AI 询价」范畴，**本次未执行**：

1. 授权后，用本报告 §3 方式获取 `sessionId`。
2. 调用现有 `ChatMessageSender.sendText`，发送**一条**测试询价内容（或用户指定内容）。
3. 校验 `/r/MessageSend/sendByReceiverScope` 返回成功、且会话出现该消息。
4. 验证行为（幂等待确认）：对同一商品再次进入 IM 页，观察是复用 `sessionId` 还是再次返回 500。

在上述授权前，建议先实现「商品(itemId) → sellerId → (查询已有会话 or create) → sessionId」的**独立建聊模块**（查询只读 + 受控 create），再接发送器。

---

## 9. 证据索引

- 现有约束：`extension/src/chat/send-protocol.ts:79-104,110-134`、`extension/src/chat/send-transport.ts:87-121`、`shared/chat/protocol.ts:21-28,98-119`、`shared/types/reply.ts`
- 既有 recon：`docs/ai-inquiry-agent-backend-recon.md` §3.4、§3.10、§5
- 网页 bundle（只读拉取）：`https://g.alicdn.com/idle-pc/xy-site/0.0.176/js/p_im-index.js`
  - `createItemImSession` → `convService.createSingleConversation`
  - LWP 路由集合：`/r/SingleChatConversation/create`、`/r/MessageSend/sendByReceiverScope`、`/r/Conversation/listNewestPagination` 等
  - `convertIdToUI`：去掉 `@<domain>` 后缀
- 真实入口（单样本观察）：商品详情页「聊一聊」`<a href="https://www.goofish.com/im?itemId=...&peerUserId=...">`
- 单样本真实观察：进入带参 IM 页 → 观察窗口内 LWP 发帧不含 `MessageSend`；`/r/SingleChatConversation/create` 返回 200 + `cid`；再次 create 返回 500 `EXCEPTION`（原因未确认）；无参 IM 页会话列表反查到该 `cid`

---

## 10. 本次浏览器 space 信息

- `spaceId = 211`（space 名称：goofish 商品建聊路径只读探查；名称沿用创建时的字面，但本次也创建了 1 个服务端空会话）
- 全程单 space 复用，未新开 space；未发送消息、未泄露凭据。
- 本步**创建了 1 个服务端空会话**（改变服务端状态，非只读）。
- 按任务约定：本次验证成功，已按 ego-browser 成功流程结束该 space。

---

## 11. 追加：真实发送「一条消息」端到端验证（2026-10-05，经用户明确授权）

> 本节在上述只读 / 建聊调查基础上，**经用户明确授权**执行一次真实「发送一条文本」验证。全程只发送 1 条消息，未再发第二条、未追问、未议价、未购买、未付款、未泄露个人信息；未修改任何业务代码、未提交。

### 11.1 结果摘要（三层验证）

| 验证层次 | 结果 | 证据 |
|---|---|---|
| UI 气泡出现 | **通过** | 发送后会话出现该文本气泡；刷新后仍显示 |
| 服务端发送响应成功 + messageId | **通过** | `/r/MessageSend/sendByReceiverScope` 返回 `code:200` + `messageId` |
| 重新读取会话历史包含该消息 | **通过** | 无参 `/im` 刷新后服务端 `listNewestPagination` 该会话 `lastMessage` = 本条消息 |

### 11.2 本次样本

- 商品标题：`正版二手 组织行为学精要（原书第12版） [美]斯蒂芬P.罗`（普通二手教材；在售、非自有）
- 公开链接：`https://www.goofish.com/item?id=1052162325286`
- 卖家（itemSellerId / receiverId）：`2207952385***`（脱敏）
- 会话来源：**新建**（先只读查询会话列表未命中该 seller/item，遂调用 create）
- `sessionId`（cid）：`67792752***@goofish`（脱敏）
- 本人 `myId`：`2214221898***`（脱敏）
- 发送精确文本：`你好，请问这个商品还在吗？`（仅 1 条）
- 时间：服务端 `createAt = 1791154620173`（epoch ms）

### 11.3 请求 / 响应观察（LWP over WebSocket，已脱敏）

创建会话 `/r/SingleChatConversation/create`：

- 请求：`pairFirst=2207952385***@goofish`（卖家）、`pairSecond=2214221898***@goofish`（本人）、`bizType=1`、`extension.itemId=1052162325286`
- 响应：`code:200`，`singleChatConversation.cid=67792752***@goofish` → `sessionId`
- 说明：本次为**新建**（首次 create 即 200），**未出现重复 create**（与 §6.1 的重复 500 样本不同，本样本未触发）。

发送消息 `/r/MessageSend/sendByReceiverScope`：

- 请求：`cid=67792752***@goofish`、`content.contentType=101`、`content.custom.data`（base64 解码 = `{"contentType":1,"text":{"text":"你好，请问这个商品还在吗？"}}`）、`actualReceivers=[卖家, 本人]`
- 响应：`code:200`、`messageId=433060057***.PNM`、`uuid=-17911546200***`、`unreadCount=1`、`msgStatus=1`

### 11.4 历史（服务端）验证

无参 `/im` 刷新后，服务端 `/r/Conversation/listNewestPagination` 返回该会话条目 `lastMessage`：

- `content.custom.summary` = `你好，请问这个商品还在吗？`
- `messageId` = `433060057***.PNM`（与发送响应一致）
- `sender.uid` = `2214221898***@goofish`（本人）
- `createAt` = `1791154620173`（与发送响应一致）
- `cid` = `67792752***@goofish`

即**服务端历史确含本条消息**，非仅本地气泡。

### 11.5 「仅发送一次」证据

- 观察窗口内 `/r/MessageSend/sendByReceiverScope` **发送帧计数 = 1**（`sendCount=1`）。
- 发送后输入框清空（`textarea.value=""`）。
- 结果明确，未做任何重发 / 追问。

### 11.6 未做 / 不作断言

- **未**断言对方已收到 / 已读或会回复；仅确认「我方发送成功 + 服务端已持久化该消息」。
- 未下单、未付款、未改价；未向卖家发送任何测试 / 机器人 / 交易说明。
- 未采集或泄露 cookies / token / 无关聊天。

### 11.7 本次浏览器 space

- `spaceId = 215`（本次唯一新建 space，全程复用，未新开）。
- 已按 ego-browser 成功流程 `finish({ keep: [] })` 结束，未保留页面。
- 截图（本地，未入库）：`/tmp/goofish-send-verify.png`。

### 11.8 与 §8 的关系

本节完成 §8「后续最小验证步骤」第 1–3 步（授权后发送 1 条 + 校验响应 + 会话出现该消息）。第 4 步（再次进入观察复用 / 500）本次未单独执行；本次 create 首次即成功，未复现重复 create。
