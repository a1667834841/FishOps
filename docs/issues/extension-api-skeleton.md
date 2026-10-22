# [Task] 架构：重构为 native host + 执行扩展，先打通 agent 的状态查询链路

> 协议和验收以 [实施契约](../agent-api-contract.md) 为准；新架构尚未实施。

## 问题概述

项目改为只给 agent 提供 API（设计见 [Agent API 设计](../agent-api-design.md)）。现有架构以扩展内页工作台为中心，通信层与协议层耦合重，不适合对外提供 API。本任务搭建新骨架：native host 对 agent 提供本地 HTTP + SSE，扩展只做执行；先打通 `system.status` 请求和 `account.changed` 推送。这是设计文档中的 M1。

## 环境信息

- 版本：分支 `feat/agent-api-host`，基于 `main` @ `f04912c`，扩展 0.1.0（下文源码行号按 `06dd5e2` 核查）
- 运行环境（OS / 浏览器）：macOS，Chrome（需支持 `connectNative` 保持 SW 存活，最低版本待确认）
- 相关配置：host HTTP 端口与 token 写入 `~/Library/Application Support/FishOps/config.json`；端口默认值 18790
- 数据内容 / 规模：只写 `events`、`requests`、`state` 三张表；不读写业务数据
- 复现频率：不适用：本次为架构任务

## 复现步骤

不适用：本次为架构任务，实施步骤如下。

1. 新建分支，把现有 `extension/`、`workbench/`、`shared/` 和依赖它们的 `scripts/` 移入 `legacy/`，只作参考，不参与构建与 CI。
2. 新建 `packages/protocol`：stdio 消息（`req` / `res` / `event`）、方法表、事件表、错误码、`Meta` / `RiskInfo` 类型。
3. 新建 `apps/host`：stdio 帧编解码、HTTP + SSE、token 认证、SQLite（`events`、`requests`）、向扩展转发请求。
4. 新建 `apps/extension`：manifest 固定 `key`；SW 顶层 `connectNative`、断线重连、方法分发；`system` 模块（版本、账号、闲鱼页面就绪状态、`account.changed`）。
5. 新建安装脚本：生成 token 和端口配置；写入 Chrome native host manifest，`allowed_origins` 只列本扩展 ID。
6. 更新 CI、README 与技术原理文档。

## 实际结果

- 页面端运行在 `chrome-extension://<id>/workbench.html`，构建产物与扩展合并输出（`workbench/vite.config.ts`）。
- 通信有三条链路：`chrome.runtime.sendMessage`、`chrome.runtime.connect` Port、`postMessage` 备用链路；另有 `direct-publish-api` 独立监听器。
- 协议层 `shared/events/commands.ts`（1204 行）与 `codec.ts`（1244 行）为每个命令手写常量、类型和校验函数。
- `extension/src/background/index.ts` 有 1455 行，集中了 20 多个懒加载 runtime 单例、接线与消息分支。
- 没有对外 API：全仓没有 HTTP 服务（见 [询价能力调研](../ai-inquiry-agent-backend-recon.md) §3.9）。

## 预期结果

- agent 用 `curl` 调用 `POST http://127.0.0.1:<port>/v1/system.status`（带 token）→ 返回扩展连接状态、插件版本、当前账号、闲鱼页面就绪状态和 `meta.risk`。
- agent 订阅 `GET /v1/events`（SSE）→ 闲鱼登录或退出时收到 `account.changed`；断线后用 `Last-Event-ID` 续传，不丢事件。
- 新增一个方法只改 2 处：方法表加一行，扩展或 host 中加一个 handler。
- 扩展不包含业务规则，只执行；请求记录、事件持久化都在 host。
- HTTP 只监听 `127.0.0.1`，拒绝没有 token 或带 `Origin` 头的请求。

## 证据与排查状态

- 证据：本次对话中对源码的核查（行数由 `wc -l` 统计；入口见 `extension/src/background/index.ts:1447`、`extension/bridge/transport.ts`）。本机 `node:sqlite` 可以加载（导出 `DatabaseSync`），Node 路径为 `~/.local/bin/node`。
- 已证实：扩展已声明 `cookies` 权限，`published-items-reader.ts:138` 已使用 `cookies.get`。
- 排查状态：方案已与用户确认（2026-10-17）：只服务 agent；native host 提供 HTTP + SSE；SQLite 本地保存；浏览器关闭时 HTTP 不可用可以接受。
- 推测（待验证）：
  - native 连接存在时 SW 不会被回收。
  - 浏览器启动时 `runtime.onStartup` 能唤醒 SW 并建立 native 连接。
  - 只用 goofish cookie（如 `unb` / `tracknick`）就能读取当前账号，不需要打开闲鱼 tab。

## 影响范围

- 已知：构建脚本、CI、目录结构全部改变；扩展 ID 因 `key` 改变，旧扩展数据（`chrome.storage`、IndexedDB）新扩展读不到；旧功能在迁移前不可用。
- 待排查：
  - Chrome 启动 native host 时 `PATH` 很少，host manifest 的 `path` 需要指向一个用 Node 绝对路径启动的脚本。
  - 多个 Chrome profile 同时运行时，会启动多个 host，HTTP 端口冲突。
  - native messaging 从 host 发往扩展的单条消息上限是 1 MB，后续发布图片需要分片或由扩展自己获取。
  - `legacy/` 中旧测试与 `scripts/` 回归脚本的处理方式。

## 验收标准

- [ ] 运行安装脚本后加载扩展 → host 启动，`config.json` 生成，权限 0600。
- [ ] `curl` 调用 `system.status`：已登录闲鱼 → 返回版本（与 manifest 一致）和账号；未登录 → 账号为 `null`，不报错。
- [ ] 不带 token、token 错误、带 `Origin` 头 → 返回 401 / 403。
- [ ] 订阅 SSE 后在闲鱼退出再登录 → 依次收到两次 `account.changed`，每次变化只推送一次。
- [ ] SSE 断开后带 `Last-Event-ID` 重连 → 补齐断开期间的事件。
- [ ] 在 `chrome://serviceworker-internals` 停止 SW → 扩展重新连接 host；期间允许 host 退出及 HTTP 连接失败，明确唤醒并完成 hello 后恢复。
- [ ] 调用不存在的方法 → 返回 `{ code: 'NOT_FOUND' }`，连接不中断。
- [ ] 每次请求写入 `requests` 表，每个事件写入 `events` 表；表中不含 cookie 和 token。
- [ ] host 的 stdio 编解码、HTTP 认证、SSE 续传、转发超时，以及扩展的分发和重连，都有单元测试。
- [ ] typecheck、单测、构建、CI 通过；`legacy/` 不参与构建。

## 契约补充验收（2026-10-17）

- [ ] hello 前拒绝转发、版本不符拒绝连接、账号读取异常不发出假退出。
- [ ] M1 实现 events.list / requests.list，进程重启后真实 HTTP 查询历史。
- [ ] risk=unobserved、chatReady=null，不能返回未经观测的健康状态。
- [ ] 账号切换不泄露旧账号数据，SSE 通知后关闭；序号与分页游标无损。
- [ ] Node 24 LTS、CI、安装 launcher 使用同一受支持基线。
