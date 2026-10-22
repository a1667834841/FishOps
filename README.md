# FishOps Agent API

面向询价 Agent 的本机 API。Chrome 扩展只负责执行，native host 提供 HTTP、SSE 与 SQLite 持久化。

## 当前范围

M1 代码已实现、本地回归通过，真实 Chrome 验收待完成。仅提供 `system.status`、`events.list`、`requests.list` 和事件订阅。不包含搜索、建聊、发送或发布；这些属于 M2～M5。旧工作台源码保存在 `legacy/`，不参与新构建。

## 环境与验证

- Node 版本以 `.node-version` 为准，生产、launcher 和 CI 使用同一 Node 24 LTS。
- 生产支持 macOS、Chrome 单个 profile；浏览器关闭时 HTTP 不可用。
- 私有配置位于 `~/Library/Application Support/FishOps/config.json`，包含端口和 Bearer token，不应分享或入库。

```sh
npm ci
npm run verify
npm run regression
```

`verify` 运行类型、单测和真实 host 进程集成测试；`regression` 额外构建并检查产物及临时安装。报告生成到 `.test-results/<run-id>/`。

已安装且属于当前 worktree 的真实 Chrome 部署可运行 `FISHOPS_LIVE_SMOKE=1 npm run test:browser-smoke`，验证认证、状态、SSE 续传与心跳。此命令不重载扩展、不改账号、不关闭浏览器。

`regression:e2e` / `regression:full` 调用真实只读冒烟，并单独记录生命周期验收。未显式启用或尚未完成隔离关闭/重开时，退出码 2，不能用只读冒烟或进程集成冒充全部通过。

## 安装与调用

先构建扩展，再运行安装脚本。安装会写本机 native host 注册；测试脚本只使用临时目录，不执行生产安装。

```sh
npm run build
npm run host:install
```

在 Chrome 扩展管理页加载 `apps/extension/dist`。浏览器通过 native messaging 启动 host，监听 `127.0.0.1:18790`。所有接口包括 SSE 都要求 `Authorization: Bearer <token>`，拒绝任何带 Origin 的请求。不要将 token 放入 URL 或日志。

- `POST /v1/system.status`，JSON `{}`：状态、账号、有无闲鱼 tab；M1 不访问平台网络。
- `POST /v1/events.list`，JSON `{ "afterSeq": "0", "limit": 100 }`：当前账号可见事件。
- `POST /v1/requests.list`，JSON `{ "afterId": "0", "limit": 100 }`：请求记录。
- `GET /v1/events`：SSE，使用 `Last-Event-ID` 续传，消费者按 seq 去重。

卸载使用 `npm run host:uninstall`，默认保留配置和数据库。重复安装保留 token；检测到其他部署时拒绝覆盖。

## 设计与边界

- [实施契约](docs/agent-api-contract.md)：公共协议、恢复、安全和验收基线。
- [M1 计划](docs/issues/extension-api-skeleton-plan.md)：当前施工范围。
- [测试方案](docs/agent-api-testing.md)：本地、进程集成与真实浏览器分层。
- [API 设计](docs/agent-api-design.md)：后续商品、聊天与发布能力。

M1 risk 为 `unobserved`，不代表平台健康。限速和随机间隔不能保证不会触发平台风控，不自动处理验证码。
