# FishOps Workbench

FishOps Workbench 采用两层架构：

- **Workbench**：Vue 3 + Vite + TypeScript 的工作台界面（`workbench/`）。
- **Extension Runtime**：Manifest V3 浏览器扩展（`extension/`），负责与页面 / 闲鱼通信。
- 两层通过 **Command / Event** 协议通信，协议类型与校验由 `shared/` 共享。

> 当前进度：**P1（工程骨架 + Bridge）**。只实现通信骨架，不含采集 / 聊天 / 发布 / AI。

## 目录结构

```text
FishOps-Workbench/
├── package.json            # npm workspaces 根（workspaces: shared/extension/workbench）
├── tsconfig.base.json      # 共享 TS 编译选项
├── shared/
│   └── events/             # 协议类型 + 运行时校验/序列化（@fishops/shared）
│       ├── protocol.ts     # 信封：Command / Response / Event、requestId、错误码
│       ├── commands.ts     # 命令类型与负载/结果映射（PING/SUBSCRIBE/UNSUBSCRIBE/PUBLISH）
│       ├── events.ts       # 事件类型与负载映射
│       ├── codec.ts        # 工厂函数 + 运行时校验 + (反)序列化
│       └── index.ts
├── extension/
│   ├── package.json        # @fishops/extension
│   ├── vite.config.ts      # 多入口构建（按 ENTRY 切换）
│   ├── public/manifest.json
│   ├── bridge/             # Workbench 侧 runtime SDK（@fishops/bridge，经别名引用）
│   │   ├── transport.ts        # ChromeRuntimeTransport / PostMessageTransport
│   │   ├── runtime-client.ts   # RuntimeClient：call / ping / on / subscribe / publish
│   │   ├── postmessage-protocol.ts
│   │   └── errors.ts
│   └── src/
│       ├── background/     # service worker 入口 + 命令路由 + session 持久化
│       └── content/        # ISOLATED bridge + MAIN world bridge
├── scripts/
│   └── smoke.mjs           # Bridge 冒烟测试（mock chrome.*，加载构建产物）
└── workbench/
    ├── package.json        # @fishops/workbench
    ├── vite.config.ts
    ├── workbench.html      # Workbench 页面入口（文件名即产物名）
    └── src/
        ├── main.ts / App.vue / styles.css
        └── pages/BridgeDemo.vue   # PING 按钮 + 事件日志
```

## 通信链路

```text
扩展内页 Workbench (chrome-extension://<id>/workbench.html)
        │  Command → chrome.runtime.sendMessage ─────────┐
        │  Event   ← chrome.runtime.connect (Port)  ←────┤
        ▼                                                ▼
   RuntimeClient (@fishops/bridge)              background service worker
                                                         │
闲鱼页面 (MAIN world) ──postMessage──► ISOLATED bridge ──┘  (P3/P4 预留)
```

- **扩展内页**是 P1 的推荐载体：Workbench 直接使用 `chrome.runtime`，无需 content script，也避免 localhost 来源限制。
- **命令**（请求 / 响应）走 `chrome.runtime.sendMessage` + `requestId` 关联；
- **事件**（单向推送）走 `chrome.runtime.connect` 长连接 Port，按订阅精确投递。service worker 被回收时 Port 自动断开，页面下次监听会重连。
- **普通网页场景**（如 `localhost` 开发页）自动退化为 `postMessage` 传输层，经 `content/isolated-bridge.js` 转发。

## 命令 / 事件（P1）

| 类型 | 说明 |
|---|---|
| `PING` → `PONG` | 连通性探测，返回 `nonce` / `pingCount` / `workerStartedAt` / `serverTime` |
| `SUBSCRIBE` / `UNSUBSCRIBE` | 声明订阅的事件类型（页面侧通道使用） |
| `PUBLISH` | 发布事件，由 background 广播给订阅者 |
| 事件 `WORKER_STARTED` | service worker 启动 / 重启 |
| 事件 `PING_RECEIVED` | 收到 PING |
| 事件 `DEMO_TICK` | PING/PUBLISH demo |

## 安装与构建

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
# 打开 http://localhost:5173/workbench.html
npm run dev:workbench
```

## 构建产物

所有产物统一输出到 **`extension/dist/`**，该目录即为可加载的未打包扩展：

```text
extension/dist/
├── manifest.json
├── background.js                 # service worker（type: module）
├── content/isolated-bridge.js    # ISOLATED world
├── content/main-world-bridge.js  # MAIN world
├── workbench.html                # Workbench 页面
└── assets/*.js, *.css            # Workbench 资源
```

## 自动化验证

`npm run test:smoke` 会加载真实的 `extension/dist/background.js`，用最小 mock 模拟 `chrome.*`，覆盖：

- PING → PONG（requestId 关联、nonce 回显、pingCount 递增）
- 命令路由与负载校验（未知命令、非法负载、外部来源拒绝）
- 长连接 Port 的事件订阅与广播（`WORKER_STARTED` / `PING_RECEIVED`）
- 模拟 service worker 被回收后重启：`firstStart=false` 且 `pingCount` 从 `chrome.storage.session` 恢复

## Trace 排查

Trace 默认关闭。它记录命令边界，不修改协议，也不改变原有超时、权限校验和业务错误处理。

在需要排查的上下文打开 DevTools Console：

- Workbench：扩展内页的 Console，记录 `client`。覆盖 `RuntimeClient.call` 和业务 `createBridgeApi` 两个入口。
- background：`chrome://extensions/` → 扩展的 Service Worker → Console，记录 `background`。
- content：闲鱼页面 Console 的执行上下文切换到本扩展的 ISOLATED content script，记录 `content`。

每个上下文单独开启，再复现问题：

```js
FishOpsTrace.enable()
FishOpsTrace.isEnabled()
FishOpsTrace.read()
// Chrome DevTools 的 copy 可将 JSON 复制到剪贴板。
copy(FishOpsTrace.exportJson())
FishOpsTrace.disable()
FishOpsTrace.clear()
```

同一命令的 `traceId` 等于已有 `requestId`。在两端导出的 JSON 中按 `traceId` 对齐，检查 `start` → `success` / `error` / `timeout` / `rejected`，结束记录含 `durationMs`。也可筛选：

```js
FishOpsTrace.read().filter(record => record.traceId === 'req_替换为实际ID')
```

安全与使用边界：

- 只记录时间、上下文、阶段、关联 ID、已知命令类型、耗时和允许的协议错误码；不记录 payload、result、原始异常文本、URL、密钥或聊天正文。非法关联 ID 记为 `untracked`。
- 每个上下文最多保留 500 条，超出时删除最旧记录。`disable()` 停止新记录但保留已有缓冲；`clear()` 清空缓冲但不改变开关。
- 开关和缓冲仅在内存中。页面刷新、扩展重载或 Service Worker 回收后重置，需重新开启；没有外部遥测或持久化日志。
- Workbench 扩展内页直接与 background 通信，不经过 content。content 仅记录现有允许转发的 `CHAT_SOCKET_EVENT`，不会扩大页面权限，也不会放行 localhost Workbench 的业务命令。
- 仅覆盖 Command 请求/响应边界。采集、分析等已返回任务 ID 的后台长任务、事件订阅及独立发布 API 不在本机制的完整关联范围内；独立发布 API 保留原有诊断日志。
- 客户端超时只表示停止等待，不表示 background 操作已取消；后者仍可能记录成功。
- 本机制不替换已有模块日志。分享控制台的完整输出前，仍需检查其中是否含敏感信息；建议只导出 `FishOpsTrace.exportJson()`。

验证命令：`npm run typecheck`、`npm run test:background`、`npm run build`、`npm run test:smoke`。

## 加载与验证（ego lite / Chrome）

1. `npm run build`
2. 在 `chrome://extensions/` 打开开发者模式 → 「加载已解压的扩展程序」→ 选择 `extension/dist`
3. 扩展 ID 记为 `<id>`，打开 `chrome-extension://<id>/workbench.html`（或点扩展图标，或新标签页）
4. 页面显示 `Bridge 连通性` 卡片 → 点「发送 PING」→ 应看到 PONG、往返时延与 `pingCount`
5. 切换页面（`chrome://extensions/` 里点 service worker 的「终止」）后再次 PING：`pingCount` 继续累加，说明状态持久化在 `chrome.storage.session`，未放内存

## 说明与边界（P1）

- 不实现采集、聊天、发布、AI；`content/*` 仅为后续阶段搭好可选链路。
- 不碰 Cookie / sign / MTOP；Workbench 不直接访问闲鱼。
- 任务状态未放入内存（PING 计数在 `chrome.storage.session`）；P2 的 Task 模型将在此基础上扩展。
- `manifest.json` 使用 `chrome_url_overrides.newtab` 声明 Workbench 入口，因此新标签页会被替换为 Workbench（测试用 ego lite 时注意）。
