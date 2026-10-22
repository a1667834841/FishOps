# 平台层（P3：平台层迁移）

本目录是 FishOps Workbench 的**平台层**，负责与闲鱼 MTOP 通信、登录态判断、标签页管理与限速。
它只做底层，**不碰业务**（采集 / 聊天 / 发布在各自模块里基于它构建）。

来源：旧 `FishOps`（main 分支）`xianyu-api.js`，以及 `chat` 分支 `inject/api/user-api.js`。

## 目录结构

```text
src/platform/
├── errors.ts                  # 统一错误分类（未登录 / token 过期 / 风控验证码 / 网络 / 业务）
├── rate-limit.ts              # 请求限速（默认 1500ms，串行）
├── protocol.ts                # MAIN world host ↔ background 的最小调用协议
├── runtime-host.ts            # host 核心：方法分派（无 DOM 依赖，可单测）
├── host-entry.ts              # host 挂载到页面 window（__FISHOPS_PLATFORM_HOST__ + message）
├── host-client.ts             # background 侧：chrome.scripting 调用适配 + tab 解析
├── xianyu/
│   ├── sign.ts                # md5 / token 解析 / 签名生成
│   ├── mtop-client.ts         # API 配置 / 参数构造 / transport / 响应解析
│   └── auth.ts                # 登录态 / token 存在性 / 当前用户 ID
└── __tests__/                 # 纯 Node 单元测试 + TS 解析 loader
```

`tab-manager.ts` 位于 `src/background/tab-manager.ts`（由写入范围指定）。

## 迁移映射（旧 → 新）

| 旧代码（`main:xianyu-api.js` / `chat:inject/api/user-api.js`） | 新位置 | 说明 |
|---|---|---|
| `md5()` | `xianyu/sign.ts` `md5()` | 逐字节 UTF-8，结果与旧实现一致（已对照 `node:crypto`） |
| `getToken()` / `getFullToken()` | `xianyu/sign.ts` `parseToken` / `getFullToken` / `extractToken` | 从 `_m_h5_tk` 取 `<token>_<ts>`，只用下划线前部分 |
| `generate()` | `xianyu/sign.ts` `generateSignature()` | 字段 `sign/t/appKey/token/data/signString` 保持不变 |
| `API_CONFIG` | `xianyu/mtop-client.ts` `MTOP_API_CONFIG` | search / detail / suggest，字段一致 |
| `request()` | `xianyu/mtop-client.ts` `buildMtopRequest()` + `createMtopClient().requestRaw()` | URL 参数顺序、请求头、`credentials: include` 一致 |
| `fetchSearchData()` | `buildSearchData()` + `client.search()` | 默认 `propValueStr.searchFilter = 'publishDays:14;'` |
| `fetchItemDetail()` | `client.fetchItemDetail()` / `requestRaw('detail', { itemId })` | |
| `fetchSuggestWords()` | `client.suggest()` + `extractSuggestWords()` | 取 `data.items[].suggest` 并过滤空 |
| `chat:user-api.js` `getCurrentUserId()` | `xianyu/auth.ts` `getCurrentUserId()` + `buildLoginUserRequest()` | `mtop.taobao.idlemessage.pc.loginuser.get`，GET 签名方式一致 |
| `inject.js` `autoCrawl` 的 1500ms 间隔 | `rate-limit.ts` `DEFAULT_MIN_INTERVAL_MS` | 默认 1500ms，可配置 |

### 与旧实现的有意差异（不是兼容性声明）

- **`md5` 的实现**：旧代码用 `unescape(encodeURIComponent(str))`，新代码用 `TextEncoder`。对合法 UTF-16
  字符串两者字节序列完全相同；仅当输入含**孤立代理项**时，旧代码会抛 `URIError`，新代码会替换为 `U+FFFD`。
  签名数据均为合法 JSON，不影响实际行为。已用固定向量 + `node:crypto` 对照验证。
- **空 token**：旧代码在调用方 `autoCrawl` 里检查 token；新 `createMtopClient` 默认在无 token 时直接抛
  `unauthorized`（可用 `requireToken: false` 关闭）。
- **MTOP 响应**：旧代码把完整响应经 `MessageBus` 广播；新代码只做 `ret` 校验与必要字段提取，
  **不记录完整响应**。

## 公开 API

```ts
// 签名
generateSignature(data, { token?, timestamp?, appKey? }): SignResult
md5(input: string): string
parseToken(v: string) / getFullToken(cookie) / extractToken(cookie)

// MTOP 客户端
createMtopClient({ transport, getToken?, rateLimiter?, requireToken? }): MtopClient
createFetchTransport(fetchImpl?): MtopTransport          // 默认 fetch 实现
buildMtopRequest(apiType, data, options) / buildSearchData(params)

// 登录态
createAuthService({ readCookie?, transport, now? }): AuthService

// 限速 / 错误
createRateLimiter({ minIntervalMs?, now?, sleep? }): RateLimiter
PlatformError / classifyMtopPayload / classifyThrownError / toPlatformError

// host
createRuntimeHost({ client, auth, now? }): RuntimeHost
installRuntimeHost(window, host, { selfWindow?, allowedOrigins? })
createPlatformHostClient({ executor, resolveTabId }): PlatformHostClient   // call / callRaw / ping
createChromeScriptExecutor(chrome.scripting) / tabResolverFromManager(tabManager)
```

## 与 P1 的接线（已完成）

运行链路已接线：Vite 构建出 `content/platform-main.js`（IIFE / MAIN world），manifest 以
`world: "MAIN"`、`run_at: "document_start"` 注入 goofish 页面；background 通过 P1 的 message-router
用 `PLATFORM_CALL` / `PLATFORM_PING` 命令调用该 host。以下为实际落点。

### 1) MAIN world host 入口 + 构建

`src/content/platform-main.ts` 组装并挂载 host（`MtopClient` + `AuthService` + `RuntimeHost`）：

```ts
const transport = createFetchTransport()
const client = createMtopClient({
  transport,
  rateLimiter: createRateLimiter({ minIntervalMs: DEFAULT_MIN_INTERVAL_MS }),
})
const auth = createAuthService({ transport })
const host = createRuntimeHost({ client, auth })
installRuntimeHost(window as unknown as HostWindowLike, host, {
  selfWindow: window,
  allowedOrigins: [location.origin],
})
```

- `vite.config.ts` 新增 `content-platform` 入口，输出 `content/platform-main.js`（format `iife`）；
- `extension/package.json` 的 `build` 串联 `build:content-platform`；
- `public/manifest.json` 的 `content_scripts` 新增一条 `world: "MAIN"`、
  `matches: ["https://*.goofish.com/*"]`、`run_at: "document_start"`。

### 2) background 组装

`src/background/index.ts` 用懒加载的 `getPlatformRouterDeps()` 组装，避免在 Node smoke 的
chrome mock（无 `scripting`）下顶层报错：

```ts
const tabManager = createTabManager({ tabs })
tabs.onRemoved?.addListener((tabId) => tabManager.handleTabRemoved(tabId))
const client = createPlatformHostClient({
  executor: createChromeScriptExecutor(scripting),
  resolveTabId: tabResolverFromManager(tabManager),
})
```

环境缺少 `chrome.scripting` / `chrome.tabs` 时返回 null，由路由统一回结构化错误。

### 3) message-router 注册平台命令

`shared/events` 新增 `PLATFORM_CALL`（`{ method, params }`）与 `PLATFORM_PING`（空负载），
`message-router.ts` 校验负载后调用平台调用器；`method` 必须在 `PlatformMethods` 白名单内。

- 成功：`createResponse` 原样返回平台结果；
- 失败：统一转成 `ProtocolError.code = 'PLATFORM_ERROR'`，并带 `category`（与本文档的错误类别同构）
  与可选 `retCode`；负载非法 / 未知方法仍走 `INVALID_PAYLOAD`。

### 4) manifest / 权限

- `permissions`: `storage`、`scripting`、`tabs`；
- `host_permissions`: `https://*.goofish.com/*`；
- `scripting` 用于 `executeScript({ world: 'MAIN' })`，`tabs` 用于查询 / 复用 / 创建闲鱼 tab。

### 5) 与 P1 Bridge 的边界

- 命令与响应仍用 P1 的 `CommandEnvelope` / `ResponseEnvelope`，并复用 background 的
  `sender.id === chrome.runtime.id` 来源校验，不另开一条未接入的通道；
- MAIN world ↔ ISOLATED 之间仍用独立的 `channel: 'fishops-platform'` 信封（见 `protocol.ts`），
  不影响 P1 的页面消息；
- token / cookie 只在 MAIN world 平台层内部使用，不进入任何响应或日志。

### 6) 结构化错误

背景层把平台失败归一为 `PLATFORM_ERROR` + 类别，Workbench 可据此决定行为：

| category | 触发场景 |
|---|---|
| `host-unavailable` | 页面未安装 host、tab 不存在 / 已关闭、`chrome.scripting` 不可用 |
| `unauthorized` | 无 token 或服务端要求登录 |
| `token-expired` | `_m_h5_tk` 失效 / 为空 |
| `captcha` | 风控 / 验证码拦截，需人工处理 |
| `network` | fetch 失败 / 超时 |
| `api` | MTOP 业务错误 |
| `unknown` | 其他错误 |

## 测试

纯 Node 运行（使用 Node 内置类型剥离 + 一个解析无扩展名的 loader，无第三方依赖）：

```bash
cd extension
node --import ./src/platform/__tests__/register.mjs --test src/platform/__tests__/
```

要求 Node ≥ 23（默认启用 TS 类型剥离）或 Node ≥ 22.15（此时用 `registerHooks` 需要
`--experimental-strip-types`）。仓库实测环境为 Node v26.8.1。

覆盖：md5/签名/token 解析、MTOP 参数构造与响应解析、错误分类、限速、auth、tab-manager（mock）、
runtime-host、host-entry（mock window）、host-client（mock chrome.scripting）、平台命令路由
（`platform-routing.test.ts`：信封复用、方法白名单、结构化错误、PING 回归）。

`register.mjs` 额外支持把 `@fishops/shared` 解析到 monorepo 的 `shared/events`，
因此可对依赖共享协议的模块（如 `background/message-router`）直接跑 Node 单测。

## 安全约定

- 不硬编码账号、Cookie、token 或 API key（`appKey` 为闲鱼公开固定值 `34839810`，非密钥）。
- **不记录 token / cookie / 完整响应**；需要日志时用 `redactSecret()`。
- token 只在平台层内部流转（`AuthService.getToken()` 供签名用），不通过 Bridge 暴露给 Workbench。

## 未完成项 / 风险

- 运行链路已接线（见上文）；真实闲鱼请求、聊天发送、AI 调用均未在本阶段接入。
- `fetchTransport` 未做超时与重试（旧实现也没有）；后续可按需在 transport 层加 `AbortController`。
- 风控分类基于已知 ret 码与特征串（`FAIL_SYS_USER_VALIDATE`、`RGV587`、`_tmd_` 等），
  实际线上如出现新码需补充 `errors.ts` 的规则表。
- `loginuser.get` 的 `spm_*` / `log_id` 沿用了旧代码的固定值（非敏感），如需更新应集中在此处。
- 响应只做 `ret` 校验与词列表提取；商品字段归一化（`Product`）属于 P4。
- `__tests__/register.mjs` 是测试专用 loader，不参与构建。
