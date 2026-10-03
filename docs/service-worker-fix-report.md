# Service Worker / Bridge 端口关闭修复报告

扩展 ID：`fmiehocngmplglipncecpiaakefglglc`（加载目录 `extension/dist`）

## 现象

- Workbench 页面（`chrome-extension://<id>/workbench.html`）可打开、导航与 UI 正常；
- chrome://extensions 一度显示 Service Worker「无效」；
- Bridge PING 报错：`INTERNAL: The message port closed before a response was received.`
- 重新构建、重新加载扩展后，刷新 Workbench 依旧端口关闭。

## 根因（真实 Chrome 证据，非推断）

`extension/src/background/sender-policy.ts` 的 `isExtensionPageSender` 把「是否携带 `sender.tab`」当作
「扩展内页 / content script」的判定依据：

```ts
// 旧实现（错误）
if (sender.tab !== undefined) return false   // 认为带 tab 就是 content script
```

但在真实 Chrome 中，**扩展内页在 tab 内打开时同样会带 `sender.tab`**（`tab.url` 即扩展页 URL）。

在 TaskSpace 100（真实 Chrome）里，从 workbench 页面向 background 发送消息，通过注入诊断 listener
读到的真实 `sender` 为：

```json
{
  "senderId": "fmiehocngmplglipncecpiaakefglglc",
  "url": "chrome-extension://fmiehocngmplglipncecpiaakefglglc/workbench.html",
  "origin": "chrome-extension://fmiehocngmplglipncecpiaakefglglc",
  "frameId": 0,
  "hasTab": true,
  "tab": { "id": 241203610, "active": true, "url": "chrome-extension://fmiehocngmplglipncecpiaakefglglc/workbench.html" }
}
```

因此：

- 普通命令：`chrome.runtime.onMessage` 命中 `if (!isExtensionPageSender(sender, chrome.runtime.id)) return false`
  → listener 返回 `false`、不调用 `sendResponse` → 页面侧 `chrome.runtime.lastError` 变成
  `The message port closed before a response was received.`；
- 事件长连接：`chrome.runtime.onConnect` 命中同一判定 → 被立即 `port.disconnect()`。

即：**Service Worker 实际已注册并运行**（chrome://extensions 无错误标记、有「检查视图：Service Worker」、
SW target 存在）。此前看到的「无效」是 Chrome 对空闲/未运行 SW 的 inactive 显示，并非注册失败；
真正的故障是来源校验把合法的扩展内页误判为 content script，导致命令无响应、端口被关闭。

## 修复

### 1. 修正来源判定（`extension/src/background/sender-policy.ts`）

改为依据**浏览器填写、无法伪造的** `url` / `origin` 前缀判断，移除错误的 tab 判定：

```ts
if (!sender) return false
if (sender.id !== extensionId) return false
if (typeof sender.url === 'string' && sender.url.startsWith(extensionPageUrlPrefix(extensionId))) {
  return true
}
return sender.origin === `chrome-extension://${extensionId}`
```

安全性说明：content script 的 `sender.url` / `sender.origin` 是宿主页面 URL（`https://www.goofish.com/...`），
由浏览器填写、页面无法伪造，因此 url/origin 前缀已足以区分「扩展内页」与「content script / 外部来源」。
`isTrustedChatContentSource`（`CHAT_SOCKET_EVENT` 专用）本来就用 goofish url 判定，行为不受影响、无需改动。

### 2. 启动初始化失败不静默（`extension/src/background/index.ts`）

顶层 `void bootstrap()` 改为 `void bootstrap().catch(...)` 并记录错误，便于在 SW 控制台诊断；
`onMessage` / `onConnect` 监听在 `bootstrap()` 之前注册，基础命令（如 PING）不受启动初始化异常影响。

### 3. 回归测试

- `scripts/smoke.mjs`：`EXTENSION_PAGE_SENDER` 还原真实结构（带 `tab` 与 `origin`），新增断言
  「带 tab 的扩展内页仍被接受」「仅带 origin 的扩展内页被接受」；
- `scripts/review-security.test.mjs`：`EXT_PAGE_SENDER` 同步为带 tab 的真实结构；把原先错误的
  「带 tab 即视为伪造并拒绝」用例替换为「扩展内页带 tab 仍被接受（防误判回归）」+「宿主页面 URL 来源被拒绝」；
- 新增 `scripts/service-worker-startup.mjs`（`npm run test:sw-startup`）：在最小 chrome mock 下启动
  `extension/dist/background.js`，断言监听器注册、带 tab 的扩展内页 PING 返回 PONG、长连接不被断开、
  content script 仍被拒绝、启动无 unhandledRejection。

## 验证（真实结果）

Node（`FishOps-Workbench` 根目录）：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | 0（shared / extension / workbench 全部通过） |
| `npm run build` | 0 |
| `npm run test:smoke` | 21 通过，0 失败 |
| `npm run test:security` | 35 通过，0 失败 |
| `npm run test:sw-startup` | 14 通过，0 失败 |
| `npm run test:chat`（P5/P6） | 144 通过，0 失败 |
| `npm run test:analysis`（P7） | 25 通过，0 失败 |
| `npm run test:capture`（P4） | 30 通过，0 失败 |
| `npm run test:capture:smoke` | 15 通过，0 失败 |

真实 Chrome（TaskSpace 100，重新构建后重新加载扩展，未卸载扩展、未改登录态）：

- `chrome.runtime.sendMessage(PING)` → `lastError: null`，响应 `ok:true`、`result.pong:true`、`nonce` 回显正确；
- `chrome.runtime.connect` 长连接未被断开，收到补发的 `WORKER_STARTED`；
- chrome://extensions 该扩展无错误标记。

## 未解决 / 注意事项

- chrome://extensions 对空闲 MV3 Service Worker 显示「无效 / inactive」属正常生命周期表现，不等于注册失败；
  判断是否真的启动失败应看是否有错误标记与「检查视图：Service Worker」。
- 长连接在 SW 被浏览器回收后会自动断开并由客户端重连（既有设计），本修复未改变该行为。
