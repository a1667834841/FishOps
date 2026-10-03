# FishOps 运行时自动准备 + 发布填表 真实验证报告（ego-browser）

- 验证方式：ego-browser **TaskSpace 133**（名称 `FishOps runtime publish verification`，本轮新建的唯一空间）
- spaceId：**133**（全程同一空间，未选择 profile、未清 Cookie/cache；**未 finish**，见「权限弹窗 / handOff」）
- 扩展：ID `fmiehocngmplglipncecpiaakefglglc`（来源目录 `extension/dist`，本轮重新加载一次）
- 旧扩展：main「闲鱼数据采集助手」/ chat「闲鱼聊天监听助手」全程未启用、未卸载、未修改
- 约束遵守：未改代码；未清 Cookie/cache；未启用 auto / 规则；未写飞书；未读任何 secret / Key；未调用 AI
- 截图：**无**（`Page.captureScreenshot` 超时，未落盘；也避免官方页含账户信息）

---

## 汇总

| # | 步骤 | 结果 | 一句话 |
| --- | --- | --- | --- |
| 0 | 新建唯一空间 + Workbench PING | **PASS** | spaceId=133；顶栏 `扩展已连接 · 12 ms` |
| 1 | 聊天「你好」一次 + 运行时自动准备验证 | **FAIL（未送出）** | 运行时**复用**了已存在的 goofish **首页**（非 `/im`）；host 通，但 myId `unauthorized`、socket 未 open；且缓存被重载清空→无会话可点，**未发送** |
| 2 | 随机选 1 条 + 自动填表 + DOM 核对 | **FAIL** | 任务 `publish_f898761525964cee` 失败（`FORM_FIELD_CHANGED: 未返回结果`）；官方页字段/图片**全空** |
| 3 | 权限弹窗处理 | **handOff（未 finish）** | 打开官方发布页触发**位置权限弹窗**→ 按规则停止、不绕过 |
| — | AI 建议 | **NOT_RUN** | 未迁移、未运行、未读 secret |

---

## 前置：环境与准备（可复现）

1. `listTaskSpaces()`：**无 FishOps 活跃任务**（仅 space 7「MY market data tools probe」与 space 46，均与本任务无关）；旧空间 131 已 finish。→ 新建唯一空间 **133**。
2. 打开 `chrome-extension://fmiehocngmplglipncecpiaakefglglc/workbench.html`；空间内当时**仅有 p1**（无 goofish 页）。
3. 探测运行时代码版本：从 Workbench 页直接发 `RUNTIME_STATUS` → 返回 `UNKNOWN_COMMAND: 未知命令: RUNTIME_STATUS` → **说明当时运行的 SW 是旧代码（未含 P8 运行时）**。
4. 因此按授权**重新加载新扩展一次**（`chrome.runtime.reload()`，未重新加载 chrome://extensions 目录、未卸载/启用其它扩展）。重载后 `RUNTIME_STATUS` 正常返回 → 新构建已生效。
5. 副作用记录：重载**清空了该扩展自身的 `chrome.storage.session`**（聊天缓存 `16 会话 / 8 条消息` → `0`）。这是卸载/重载行为，非「清 Cookie/站点 storage」。

> 环境注记：浏览器全局**已存在**一个 `https://www.goofish.com/`（**首页，非 `/im`**）标签页（窗口 `241203714`，非本空间窗口 `241203750`）；**非本轮手动打开**。运行时会优先复用任何 goofish 标签页，这里复用的就是它。

---

## 步骤 1：聊天发送「你好」一次 + 运行时自动准备 — FAIL（未送出）

### 1.1 运行时自动准备（只准备，不发送）

从 Workbench 页直接调用 `CHAT_RUNTIME_PREPARE { purpose:'chat', force:true }`（耗时 ≈10s）：

```json
{ "ok": false, "tabId": 241203715, "tabCreated": false,
  "socketReady": false, "socketStatus": "connecting", "userIdReady": false,
  "error": { "category": "unauthorized", "message": "未登录或登录状态已失效，请先在 goofish.com 登录闲鱼账号" } }
```

随后 `RUNTIME_STATUS`：

```json
{ "tabOpen": true, "tabReady": true, "hostReady": false,
  "socketStatus": "connecting", "userIdReady": false,
  "lastError": { "category": "unauthorized", "message": "未登录或登录状态已失效..." } }
```

只读核对复用到的标签页（`tabId 241203715`）：

- URL = `https://www.goofish.com/`，title = `闲鱼 - 闲不住？上闲鱼！`（**首页，非 `/im`**）。
- 页面 MAIN world 存在 FishOps host：`__FISHOPS_PLATFORM_HOST__` / `__FISHOPS_CHAT_TRANSPORT__` / `__FISHOPS_CHAT_SEND__`。
- `PLATFORM_PING` → `{ pong:true, host:'main-world' }`（**host 通**）。
- `PLATFORM_CALL platform.authState` → `{ loggedIn:false, hasToken:false }`（该页 `document.cookie` 不含 `_m_h5_tk`）。

**判定**：

- 运行时行为 = **自动复用**（`tabCreated:false`），**未抢焦点**（复用后台已存在页，未新建 tab）。
- 复用目标不是 `/im`，该页没有聊天 MTOP token → `myId` 取不到（`unauthorized`）、socket 不 open → 准备 **FAIL**。
- 结论：**在没有现成 `/im` 页时，运行时不会「创建 goofish/im」，而是复用了任意 goofish 页（这里是首页）并失败**。
- 注：**账号本身是登录的**（见步骤 2 的官方发布页正常渲染登录态）；此处失败是「复用了缺 token 的首页」，不是全站掉登录。

### 1.2 发送「你好」

- 重复风险排查：重载已清空 `chrome.storage.session`，本地缓存 `0 会话 / 0 条消息` → 缓存内**无**历史「你好」。上轮（空间 131）该消息被扩展拒绝、未发出（有据）。
- 但**没有任何会话可点**：`CHAT_SYNC_CONVERSATIONS` 返回**空响应**（响应体 `null`），Workbench 报
  `会话同步失败：INVALID_MESSAGE: 扩展返回的响应不是合法 ResponseEnvelope`，会话数仍为 `0`。
- 发送按钮处于禁用态（`选择会话后才能生成建议或发送`）→ **无法点击、未发送**。
- **未送出「你好」**；未做任何重复发送（因为根本发不出）。

**步骤 1 结论：FAIL。** 运行时自动准备未成功（复用错误页面 + myId/socket 不可用），且无会话导致授权的那一次发送**不可达**，未产生发送副作用、无重复风险。

---

## 步骤 2：随机选 1 条 + 自动填表 + 官方页 DOM 核对 — FAIL

### 2.1 选品（只记录存在性 / 图数 / 填充状态，无卖家个人信息）

- 商品库（IndexedDB）**未受重载影响**，仍 30 条真实商品。
- 发布中心 `🎲 随机选择 1 条商品` → 选中 `itemId = 1084360770298`（雨伞类，`最终售价 ¥14.70`，`划线原价 ¥73.50`，规则 `multiplier=1 / markup=0`，`来源原价 ¥14.70`）。
- 图片来源：仅封面图 1 张（无详情图）→ 预期上传 1 张主图、0 张详情图。

### 2.2 执行「开始自动填充发布表单」一次

- 点击 `🚀 开始自动填充发布表单` 一次（普通点击被一个 div 拦截；因按钮盒子异常宽 ≈2412px，改用 `force` 点击一次，未见二次触发）。
- 结果（`PUBLISH_LIST`）：

```json
{ "id": "publish_f898761525964cee", "type": "publish", "status": "failed",
  "progress": 85, "meta": { "step": "filling_form" },
  "error": "[PublishError:FORM_FIELD_CHANGED] 注入表单执行脚本未返回结果，发布页面可能已重定向或崩溃",
  "payload": { "itemId": "1084360770298", "rule": { "price": { "multiplier": 1, "markup": 0 } } } }
```

- 未进入 `waiting_confirmation`；**未点击官方最终发布按钮**；**未标记已发布 / confirmed**。

### 2.3 官方发布页真实 DOM 核对（只读）

扩展后台打开了发布页 `tabId 241203753`（`active:false`，**未抢焦点**），位于窗口 `241203714`：

- URL = `https://www.goofish.com/publish`，title = `发闲置_闲鱼`，`readyState=complete`（**未跳登录页**）。
- 表单**完整渲染且处于登录态**（宝贝图片 / 宝贝描述 / 价格 / 原价 / 发货设置 …）。
- 实际状态（read-only 注入读取）：
  - 宝贝描述：**空**（`contenteditable` 的 `textContent` 为空，仍是占位提示）；
  - 售价输入：**空**（`placeholder=0.00`，`value=""`）；
  - 原价输入：**空**；
  - 图片：**未上传**（仍显示「添加首图」）。

**判定**：价格 / 描述 / 图片**均未填入** → 按规则 **FAIL**。不是「表面成功」——状态本就是 failed，且做了真实 DOM 核对确认字段为空。

### 2.4 失败归因（已收集证据，供修复）

- `executeScript` 在该发布页**可正常返回结果**（同步/异步均返回）；
- 表单填充器的**全部选择器都命中**（`[class^="editor--"]`、`[contenteditable=true]`、`label[for="itemPriceDTO_priceInCent"]`、`priceWrap/placeholder` 两个价格框、`input[type=file]`、上传区）；
- 但注入的**填充函数没有返回结果**（`results[0].result === undefined`）→ 触发 `未返回结果`。
- 可能方向（**待主代理定位，未断言**）：填充函数内 ~1.8s 的注入窗口内页面发生（客户端）重渲染/重定向导致执行上下文丢失；或封面图为 **http**（`http://img.alicdn.com/...`）而发布页为 https，页内 `fetch` 受混合内容限制。

**步骤 2 结论：FAIL。** 真实 DOM 核对确认价格/描述/图片全未填入；严格守住人工边界（未提交、未确认）。

---

## 权限弹窗 / handOff（未 finish）

- 为留存官方发布页，我以本空间新增页 `p2` 打开 `https://www.goofish.com/publish` 时，浏览器弹出**位置（location）权限提示**。
- 按用户规则「权限/登录/验证码弹窗 → handOff、停止、不绕过」：**脚本停止、未处理该提示、未 finish**。
- `listTaskSpaces()` 复核：space 133 `ownership = "agentDelegatedToUser"`，`recentTabTitles = ["发闲置_闲鱼", "发布中心 · FishOps Workbench"]`。
- 因此：**没有 finish**，空间与官方发布页（`发闲置_闲鱼`）保持在用户侧，供用户处理权限提示并人工检查。

---

## 只读查询 vs 真实业务副作用

| 类别 | 动作 | 说明 |
| --- | --- | --- |
| 只读连通性 | Workbench 自动 PING、`PING`、`RUNTIME_STATUS`、`PLATFORM_PING`、`PLATFORM_CALL platform.authState`、`CHAT_STATUS`、`CHAT_LIST_CONVERSATIONS`、`PUBLISH_LIST/GET` | 只读状态，无远端写 |
| 运行时准备（只准备，不发送） | `CHAT_RUNTIME_PREPARE` | 复用既有 goofish 页，**未发送任何消息** |
| 只读平台拉取（写本地） | `CHAT_SYNC_CONVERSATIONS`（通过 UI 点「同步会话」**一次**） | 只读 LWP；本次**未得到有效响应**，未写入任何会话 |
| 真实业务副作用（尝试，失败） | 发布「开始填表」一次 | 打开后台发布页并尝试填表；**失败**，未提交、未确认 |
| 真实业务副作用（成功） | **无** | 未发出任何聊天消息，未成功发布 |

---

## 未执行 / 未测试（保持未做）

- 聊天：**未发送「你好」**（无会话，不可达）；未 `生成建议`、未采用建议、未开自动回复。
- AI：未迁移/未运行/未读任何 secret。
- 发布：未进入 `waiting_confirmation`；**未点击官方最终发布按钮**、未标记 `confirmed`。
- 飞书：未读配置、未写入。
- 未改代码 / PLAN；未清 Cookie/cache；未动旧 main/chat 扩展。

---

## 发现的问题（供主代理派修，仅报告不改代码）

1. **运行时复用策略过宽**：`RuntimeSession.findReusableTab` 复用**任意** goofish 页（此处为首页 `https://www.goofish.com/`），而首页无聊天 MTOP token（无 `_m_h5_tk`）→ `myId` 取不到、socket 不 open，准备直接失败，且**不会去创建 `/im`**。建议：仅复用可聊天的 `/im`（或对非 `/im` 页导航/新建 `/im`）。
2. **`CHAT_SYNC_CONVERSATIONS` 无响应**：返回空响应体，客户端报 `INVALID_MESSAGE: 扩展返回的响应不是合法 ResponseEnvelope`；应返回结构化错误（如 `PLATFORM_ERROR`）。
3. **发布填表 `未返回结果`**：`executeScript` 可用、选择器全命中、页面登录态正常，但注入填充函数未返回结果 → `FORM_FIELD_CHANGED`。可能为注入窗口内页面重渲染/重定向，或 **http 封面图**的混合内容 `fetch`。
4. **`RUNTIME_STATUS.hostReady` 与探测结果不一致**：`PLATFORM_PING` 成功，但准备返回后 `RUNTIME_STATUS.hostReady=false`（疑似 `hostReady` 状态被重置）。
5. **发布按钮布局异常**：`开始自动填充发布表单` 按钮盒子宽 ≈2412px、超出视口，导致普通点击被拦截（需 `force`）。
6. **重载会清空 `chrome.storage.session`**：重载新扩展会丢失聊天本地缓存（本轮 16 会话/8 消息 → 0），后续验证需先重新同步会话。

---

## 复现步骤（最小）

1. 无现成 `/im`、但存在任意 goofish 页时，从 Workbench 发 `CHAT_RUNTIME_PREPARE {purpose:'chat',force:true}` → 观察 `tabCreated:false` + `unauthorized`。
2. `CHAT_SYNC_CONVERSATIONS` → 观察空响应 / `INVALID_MESSAGE`。
3. 发布中心 `随机选择 1 条` → `开始自动填充发布表单` → `PUBLISH_LIST` 观察 `failed` + `FORM_FIELD_CHANGED`；再只读核对 `/publish` 页字段是否为空。

---

## 结论

**整体 FAIL（且因权限弹窗未 finish）。**

- 步骤 0 PASS；步骤 1 **FAIL**（运行时复用错误页面 → `myId`/socket 不可用；无会话 → 授权发送**不可达、未送出**）；步骤 2 **FAIL**（填表失败，官方页价格/描述/图片全空）。
- 严守红线：未绕过登录/权限/验证码，未发送任何聊天消息，未点击最终发布，未调用 AI，未读 secret，未写飞书。
- 结束时因**位置权限弹窗**按规则 handOff、**未 finish**；space 133 交回用户，官方发布页 `发闲置_闲鱼` 与 Workbench 保留。
