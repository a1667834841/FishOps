# 技术原理

本文说明 FishOps Workbench 的架构、通信链路、平台调用、构建与排查方式。功能与免责说明见根目录 [README](../README.md)。项目已从早期的 Bridge 骨架扩展到采集、聊天、发布与分析等业务模块，本文以当前代码为准。

## 1. 两层架构

- **Workbench（工作台）**：Vue 3 + Vite + TypeScript 单页应用，运行在 `chrome-extension://<id>/workbench.html`，负责界面与用户操作。
- **Extension Runtime（扩展运行时）**：Manifest V3 扩展，含 background service worker 与 content scripts，负责命令路由、状态持久化和与闲鱼页面通信。
- **Platform（平台层）**：注入闲鱼页面 MAIN world 的 host，封装 MTOP 请求、登录态判断与限速。采集、聊天、发布、分析均构建在平台层之上。
- **shared**：跨层共享的协议类型与运行时校验（`@fishops/shared`），是两层之间的唯一契约来源。

工作台不直接访问闲鱼：所有闲鱼侧请求都经 background → 平台 host 完成。token / cookie 只在 MAIN world 平台层内部使用，不进入响应或日志。

## 2. 目录结构

```text
FishOps-Workbench/
├── package.json                 # npm workspaces 根（shared / extension / workbench）
├── tsconfig.base.json           # 共享 TS 编译选项
├── shared/                      # @fishops/shared：协议、类型、纯逻辑
│   ├── events/                  # 信封、命令/事件定义、校验与序列化、trace
│   ├── types/                   # capture / chat / publish / analysis 等业务类型
│   ├── capture/  chat/  publish/  analysis/  data-source/  reply/  task/
├── extension/                   # @fishops/extension：MV3 运行时
│   ├── bridge/                  # Workbench 侧 runtime SDK（@fishops/bridge）
│   ├── public/manifest.json     # 权限与 content_scripts 声明
│   └── src/
│       ├── background/          # service worker：命令路由 + 各业务 runtime
│       ├── content/             # ISOLATED / MAIN world 入口
│       ├── platform/            # MTOP 客户端、签名、限速、错误分类、host
│       ├── capture/  chat/  publish/  analysis/  data-source/
├── workbench/                   # @fishops/workbench：Vue 3 工作台
│   └── src/                     # App.vue + pages/ + features/ + components/
├── scripts/                     # 冒烟与安全校验脚本
└── docs/                        # 本目录及阶段性报告
```

## 3. 通信链路

```text
扩展内页 Workbench (chrome-extension://<id>/workbench.html)
        │  Command → chrome.runtime.sendMessage ─────────┐
        │  Event   ← chrome.runtime.connect (Port)  ←────┤
        ▼                                                ▼
   RuntimeClient (@fishops/bridge)              background service worker
                                                         │
闲鱼页面 (MAIN world) ──postMessage──► ISOLATED bridge ──┘
```

- **命令**（请求 / 响应）走 `chrome.runtime.sendMessage`，用 `requestId` 关联。响应统一为 `ResponseEnvelope`，失败携带协议错误码。
- **事件**（单向推送）走 `chrome.runtime.connect` 长连接 Port，按订阅精确投递。service worker 被回收时 Port 自动断开，页面下次监听会重连。
- **普通网页场景**（如 `localhost` 开发页）自动退化为 `postMessage` 传输层，经 `content/isolated-bridge.js` 转发。
- background 对来源做校验：事件长连接与业务命令只接受扩展内页来源；`CHAT_SOCKET_EVENT` 只接受受信任的 goofish content script 来源。

### 平台调用（MAIN world）

MTOP 请求需要页面 cookie 与 `_m_h5_tk` 签名，而 MV3 service worker 无法读取页面 `document.cookie`，因此：

1. manifest 以 `world: "MAIN"`、`run_at: "document_start"` 注入 `content/platform-main.js`，把 host 挂到 `window.__FISHOPS_PLATFORM_HOST__`。
2. background 通过 `chrome.scripting.executeScript({ world: 'MAIN' })` 调用 `PLATFORM_CALL` / `PLATFORM_PING`，`method` 必须在白名单内（`platform.ping` / `search` / `detail` / `suggest` / `authState` / `currentUserId` / `publishedItems`）。
3. 平台层统一限速、签名与错误分类，失败归一为 `PLATFORM_ERROR` + `category`（如 `unauthorized` / `captcha` / `network` / `api`）。

聊天另有独立入口：`content/chat-main.js` 只读监听目标聊天 WebSocket，把原始事件经既有 postMessage 通道以 `CHAT_SOCKET_EVENT` 上报；消息发送走注入 MAIN world 的独立 sender，不改变页面自身行为。

## 4. 命令与事件概览

命令按业务分组（完整定义见 `shared/events/commands.ts`）：

| 分组 | 代表命令 |
|---|---|
| 基础 / 平台 | `PING`、`SUBSCRIBE`、`UNSUBSCRIBE`、`PUBLISH`、`PLATFORM_CALL`、`PLATFORM_PING` |
| 采集与任务 | `CAPTURE_CREATE` / `PAUSE` / `RESUME` / `CANCEL` / `GET` / `SUGGEST_WORDS`、`TASK_LIST`、`PRODUCT_LIST` |
| 聊天 | `CHAT_STATUS`、`CHAT_LIST_CONVERSATIONS`、`CHAT_GET_MESSAGES`、`CHAT_SYNC_HISTORY`、`CHAT_SYNC_CONVERSATIONS`、`CHAT_MARK_READ` |
| 发送与 AI | `CHAT_SEND_MESSAGE`、`CHAT_GET_REPLY_SUGGESTION`、`CHAT_APPLY_REPLY`、`CHAT_RULES_GET` / `SET`、`CHAT_AI_PAUSE_SET` |
| 发布 | `PUBLISH_CREATE` / `LIST` / `GET` / `FILL_FORM` / `PAUSE` / `RESUME` / `CANCEL` / `CONFIRM_STATUS` / `SUBMIT` |
| 分析 | `DATA_SOURCE_LIST` / `SCHEMA` / `QUERY`、`PROMPT_RULE_LIST` / `UPSERT` / `DELETE`、`ANALYSIS_CREATE` / `GET` / `CANCEL` / `RESULT_GET` |
| 配置 | `AI_CONFIG_*`、`FEISHU_CONFIG_*`、`MIGRATE_LEGACY_CONFIG`、`RUNTIME_STATUS`、`CHAT_RUNTIME_PREPARE` |

事件（`shared/events/events.ts`）仅含元数据，**不含聊天正文**，例如 `WORKER_STARTED`、`TASK_CHANGED`、`PUBLISH_TASK_CHANGED`、`CHAT_MESSAGE_INGESTED`、`CHAT_REPLY_SUGGESTION_GENERATED`、`RUNTIME_STATUS_CHANGED`。

### 状态与安全约定

- 关键状态写入 `chrome.storage.session`，service worker 被回收后仍可恢复；被回收后重启只广播 `firstStart=false`，不自动续跑任务。
- 发布采用两阶段：填表到 `waiting_confirmation` 即停，最终提交只由用户点击一次 `PUBLISH_SUBMIT` 触发，需一次性令牌，成功判据以官方「我的商品库」在售数严格 +1 为证据；数量未变或超时一律标记 `unknown` 并锁定。
- 直接接口发布通道维护专用非激活 tab，按 `accountScope::idempotencyKey` 做幂等审计，绝不接管用户已打开的 tab。

## 5. 安装与构建

```bash
# 在 FishOps-Workbench/ 目录下
npm install

# 类型检查（shared / extension / workbench）
npm run typecheck

# 构建扩展 + Workbench，产物输出到 extension/dist/
npm run build

# Bridge 冒烟测试（mock chrome.*，加载构建产物；需先 npm run build）
npm run test:smoke

# 仅开发 Workbench（localhost 开发页，Bridge 走 postMessage 通道）
npm run dev:workbench
```

## 6. 权限与注入范围

`extension/public/manifest.json`：

- `permissions`：`storage`、`scripting`、`tabs`、`cookies`。
- `host_permissions`：`https://www.goofish.com/*`、`https://h5api.m.goofish.com/*`（商品库只读核验）、`https://open.feishu.cn/*`（飞书数据源）。
- `optional_host_permissions`：`http://*/*`、`https://*/*`（用户按需授予 AI 服务来源等）。
- `content_scripts` 仅在 `https://www.goofish.com/*`、`run_at: document_start` 注入四条：`content/isolated-bridge.js`、`content/main-world-bridge.js`、`content/platform-main.js`、`content/chat-main.js`。
- 工作台入口由 `action` 打开；manifest **不含** `chrome_url_overrides.newtab`，不会替换新标签页。

## 7. 构建产物

所有产物统一输出到 **`extension/dist/`**，该目录即为可加载的未打包扩展：

```text
extension/dist/
├── manifest.json
├── background.js                 # service worker（type: module）
├── content/isolated-bridge.js    # ISOLATED world
├── content/main-world-bridge.js  # MAIN world
├── content/platform-main.js      # MAIN world 平台 host
├── content/chat-main.js          # MAIN world 聊天只读入口
├── workbench.html                # Workbench 页面
└── assets/*.js, *.css            # Workbench 资源
```

扩展各入口由 `ENTRY` 变量分次构建（`extension/vite.config.ts`），content script 输出 IIFE，background 输出 ESM。

## 8. 加载与验证

1. `npm run build`
2. 在 `chrome://extensions/` 打开开发者模式 → 「加载已解压的扩展程序」→ 选择 `extension/dist`
3. 打开 `chrome-extension://<id>/workbench.html`（或点扩展图标）
4. 工作台右下角诊断抽屉中发送 `PING`，应看到 PONG、往返时延与 `pingCount`
5. 在 `chrome://extensions/` 里终止 service worker 后再次 `PING`：`pingCount` 继续累加，说明状态持久化在 `chrome.storage.session`

## 9. 自动化验证

纯 Node 运行（使用 Node 内置类型剥离 + 测试专用 loader，无第三方测试框架）：

| 命令 | 覆盖范围 |
|---|---|
| `npm run test:smoke` | 加载真实 `extension/dist/background.js`，mock `chrome.*`，覆盖 PING→PONG、命令路由、Port 订阅广播、service worker 重启恢复 |
| `npm run test:background` | background 路由与运行时单测 |
| `npm run test:chat` | 聊天只读层、发送与 AI 相关单测 |
| `npm run test:capture` / `test:capture:smoke` | 采集模块单测与冒烟 |
| `npm run test:analysis` | 数据分析模块单测 |
| `npm run test:publish` | 发布模块单测 |
| `npm run test:security` | 安全校验（来源校验、注入范围、manifest 权限等） |
| `npm run test:sw-startup` | service worker 启动流程 |

## 10. Trace 排查

Trace 默认关闭。它只记录命令边界元数据，不修改协议，也不改变原有超时、权限校验和业务错误处理。

在需要排查的上下文打开 DevTools Console：

- Workbench：扩展内页 Console，记录 `client`。
- background：`chrome://extensions/` → 扩展的 Service Worker → Console，记录 `background`。
- content：闲鱼页面 Console 的执行上下文切到本扩展的 ISOLATED content script，记录 `content`。

```js
FishOpsTrace.enable()
FishOpsTrace.isEnabled()
FishOpsTrace.read()
// Chrome DevTools 的 copy 可将 JSON 复制到剪贴板。
copy(FishOpsTrace.exportJson())
FishOpsTrace.disable()
FishOpsTrace.clear()
```

同一命令的 `traceId` 等于已有 `requestId`，可按它对齐两端记录，检查 `start` → `success` / `error` / `timeout` / `rejected` 及 `durationMs`：

```js
FishOpsTrace.read().filter(record => record.traceId === 'req_替换为实际ID')
```

安全与使用边界：

- 只记录时间、上下文、阶段、关联 ID、已知命令类型、耗时和允许的协议错误码；不记录 payload、result、原始异常文本、URL、密钥或聊天正文。非法关联 ID 记为 `untracked`。
- 每个上下文最多保留 500 条（可配置上限），超出时删除最旧记录。`disable()` 停止新记录但保留缓冲；`clear()` 清空缓冲但不改变开关。
- 开关和缓冲仅在内存中。页面刷新、扩展重载或 service worker 回收后重置，需重新开启；没有外部遥测或持久化日志。
- 只覆盖 Command 请求 / 响应边界。采集、分析等返回任务 ID 的后台长任务、事件订阅及独立发布通道不在完整关联范围内。
- 客户端超时只表示停止等待，不表示 background 操作已取消。
- 分享控制台输出前仍需检查是否含敏感信息；建议只导出 `FishOpsTrace.exportJson()`。

验证命令：`npm run typecheck`、`npm run test:background`、`npm run test:chat`、`npm run test:capture`、`npm run test:analysis`、`npm run test:publish`、`npm run build`、`npm run test:smoke`。
