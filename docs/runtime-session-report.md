# 闲鱼运行时自动准备（P8）报告

> 目标：解决真实发送测试时「没有已登录 goofish 页面 / 没有 WebSocket / 没有 myUserId」导致
> `CHAT_SEND_MESSAGE` 报「当前用户 ID 未就绪」的问题。**不含 Workbench UI**，只做 background /
> platform / chat 运行时接线与协议扩展。

## 1. 技术边界（务必知悉）

- **不是彻底隐藏 tab**：普通 Chrome 扩展无法真正隐藏标签页。本方案只用
  `chrome.tabs.create({ url, active: false })` 切到后台创建（不抢焦点），tab 仍会出现在标签栏。
  `active:false` 只代表「不抢焦点」，不代表「无感 / 不可见」。
- **不绕过登录 / 验证码 / 权限**：只复用浏览器已有的登录态；检测到页面跳转到登录页或
  风控 / 验证码页时**如实报错**（`unauthorized` / `captcha`），不尝试任何绕过手段。
- **不新增无关权限**：manifest 权限保持最小（`storage` / `scripting` / `tabs` +
  `host_permissions: https://www.goofish.com/*`），`/im` 已被现有 content_scripts `matches` 覆盖。
- **不读 / 不写 / 不记录 secret**：不新增 cookie / storage 读取，不迁移旧扩展配置，不打印用户 ID 值。
- **不自动发送**：运行时准备只发生在用户显式 `CHAT_SEND_MESSAGE` / `CHAT_APPLY_REPLY`
  命令（或显式 `CHAT_RUNTIME_PREPARE`）时；自动模式与实时消息**不触发准备、不触发发送**。
- **真实浏览器验证（可选）未执行**：见 §5。

## 2. 改动清单

### 2.1 新增模块

| 文件 | 作用 |
| --- | --- |
| `extension/src/background/runtime-session.ts` | 运行时会话：复用 / 后台创建 goofish tab、等待加载（`tabs.onUpdated` + bounded timeout）、等待 host 就绪、等待 socket open（best-effort）、并发去重、结构化失败分类 |
| `extension/src/background/my-user-id.ts` | myUserId 解析器：成功缓存 5 分钟 TTL、失败指数退避（5s→60s）、`force` 可重试、并发去重、`peek()` 只回布尔 |

### 2.2 接线改动（均在被允许的目录内）

- `extension/src/background/index.ts`
  - 新增 `getRuntimeSession()`（惰性组装，缺 `chrome.tabs` 子集时返回 null，绝不抛错）。
  - P3 平台调用、P5 只读同步、P6 发送的 `resolveTabId` 统一走运行时会话：优先复用已登录
    goofish tab，缺失时后台创建（`active:false`）并等待加载。
  - 处理 `CHAT_SOCKET_EVENT` 时同步记录 socket 状态（供准备流程等待 open）。
  - 新增 `RUNTIME_STATUS` / `CHAT_RUNTIME_PREPARE` 命令处理与 `RUNTIME_STATUS_CHANGED` 事件广播。
  - myUserId 由旧的「失败也缓存整个 SW 生命周期」改为 TTL / 退避解析器。
- `extension/src/background/message-router.ts`
  - 新增 `RuntimeRouterDeps` 与运行时命令路由。
- `extension/src/background/reply-runtime.ts`
  - `ReplyRuntimeDeps` 新增 `ensureReady`（显式发送前准备）与 `resolveMyUserId`（动态解析）。
  - `CHAT_SEND_MESSAGE` / `CHAT_APPLY_REPLY` 发送前先 `ensureReady`；失败回结构化
    `PLATFORM_ERROR`（带 `host-unavailable` / `unauthorized` / `captcha` 等 category）。
  - 自动回复路径（`executeAuto` / `handleIncomingMessage`）**不**调用 `ensureReady`。

### 2.3 协议扩展（`shared/events/**`）

- 命令：`RUNTIME_STATUS`（只读状态）、`CHAT_RUNTIME_PREPARE`（准备后台 tab + host + socket + 用户 ID）。
- 结果类型：`RuntimeStatusResult`、`ChatRuntimePrepareResult`、`RuntimeErrorInfo`。
- 事件：`RUNTIME_STATUS_CHANGED`（负载只含布尔与状态，不含用户 ID 值与聊天内容）。
- codec：`isChatRuntimePreparePayload` 严格校验（只允许 `purpose` / `force`，拒绝隐藏字段）。

### 2.4 测试脚本

- 新增 `test:background`（根与 `@fishops/extension`），以及 `extension/src/background/__tests__/`
  的 register / resolve-hook。

## 3. 关键设计

### 3.1 `ensureGoofishRuntimeTab({ purpose })`（`RuntimeSession.ensureTab`）

1. 优先复用：校验缓存 tab 是否存活且为 goofish → 查询全部 tab 过滤 `goofish.com`（优先 active）。
2. 复用 tab 非 `complete` 时才等待加载；缺失则 `tabs.create({ url: 'https://www.goofish.com/im', active: false })`。
3. 等待加载：`tabs.onUpdated` 监听 + bounded timeout（默认 15s）；监听器在结束时移除，
   **复用已就绪 tab 时不注册监听器**（避免重复注册）。
4. 失败结构化：tab 关闭 / 超时 → `host-unavailable`；跳转登录页 → `unauthorized`；跳转验证码 / 风控页 → `captcha`。
5. **并发去重**：同一时刻只允许一次 tab 查找 / 创建在飞行，多个并发调用共享结果（不重复建 tab、不无限重试）。

### 3.2 `ensureChatRuntimeReady`（发送前 / `CHAT_RUNTIME_PREPARE`）

顺序：`ensureTab` → 等待 host 就绪（`platform.ping`，有限重试）→ 等待 socket open（best-effort，
bounded）→ 获取 myUserId（TTL / 退避）。

- host 未就绪 → `host-unavailable`；
- myUserId 失败 → 透传平台错误类别（`unauthorized` / `captcha` / …），提示 UI「请确认已登录 / 处理验证码」；
- socket 在窗口内未 open 时**不致命**（`socketReady=false` 但仍返回就绪），由实际发送路径做最终判定，
  避免把可发送场景误判为失败。

### 3.3 myUserId 缓存策略修正

- 成功：缓存 5 分钟（TTL 内命中不重复请求）。
- 失败：只缓存短退避窗口（指数 5s→60s），窗口内非强制调用不重复请求。
- 显式发送 / 准备（`force:true`）：忽略退避重试，但**每次调用只发一次请求**，无内部循环。
- `peek()` 只暴露布尔与状态，**绝不输出用户 ID 值**。

## 4. 测试

全部离线（mock `chrome.tabs`，不创建真实 tab、不发真实消息）：

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查 | `npm run typecheck` | 通过（shared / extension / workbench） |
| 构建 | `npm run build` | 通过 |
| Bridge 冒烟 | `npm run test:smoke` | 21 通过 |
| 安全回归 | `npm run test:security` | 35 通过 |
| 聊天 | `npm run test:chat` | 150 通过（含新增 6 条 P8 发送前准备用例） |
| 采集 | `npm run test:capture` | 42 通过 |
| 分析 | `npm run test:analysis` | 25 通过 |
| 运行时（新增） | `npm run test:background` | 22 通过 |

`test:background` 覆盖：

- tab：已有 tab 复用（不创建）、无 tab 后台创建一次（断言 `active:false`）、并发去重、
  tab 关闭 / 加载超时、跳转登录页 / 验证码页分类、`create` 抛错不冒泡、`resolveTabId` 只复用不创建。
- myUserId：成功 TTL、失败退避（窗口内不重试 + `force` 可重试）、指数退避与成功重置、
  并发去重、空值不缓存。
- 发送前准备：`CHAT_SEND_MESSAGE` / `CHAT_APPLY_REPLY` 调用 `ensureReady` 一次并发送一次；
  `ensureReady` / `resolveMyUserId` 失败回结构化 `PLATFORM_ERROR` 且不发送；
  **自动模式与实时消息不触发 `ensureReady`**。
- 安全回归：新增命令/事件已登记、`CHAT_RUNTIME_PREPARE` 负载拒绝隐藏字段、`RUNTIME_STATUS` 只接受空对象。

## 5. 真实浏览器验证（可选，未执行）

任务允许「复用用户已有 TaskSpace，只验证打开 / 复用后台 tab 与状态，不发送消息」。本任务
定位为「主代理只 review」，且真实打开 goofish tab 属于对用户浏览器的真实副作用，
因此**未执行**真实浏览器验证，以避免在未确认用户环境的情况下替用户制造副作用。
如需人工验证，可在扩展加载后从扩展页发一条 `CHAT_RUNTIME_PREPARE`（`purpose: 'chat'`），
观察是否复用已有 goofish tab 或后台新建，并读取 `RUNTIME_STATUS`（不会发送任何消息）。

## 6. 未解决项 / 后续建议

1. **Workbench UI 未接入**（本任务明确不做）：可在后续为 `RUNTIME_STATUS` / `CHAT_RUNTIME_PREPARE`
   增加状态徽标与「准备闲鱼运行时」按钮，并订阅 `RUNTIME_STATUS_CHANGED`。
2. **socket open 为 best-effort**：若页面长时间不建立聊天 WebSocket，仍会返回就绪（`socketReady=false`），
   最终由发送返回 `NO_SOCKET`。后续可考虑更强的前置阻断或用户提示。
3. **未登录 / 验证码检测依赖 URL 特征 + 平台错误类别**：URL 特征为启发式；更精确的判定仍以
   平台 `currentUserId` 的返回类别为准。
4. **tab 仍可见**：受浏览器能力限制，后台 tab 无法真正隐藏，用户会在标签栏看到 goofish 页面。
