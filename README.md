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
