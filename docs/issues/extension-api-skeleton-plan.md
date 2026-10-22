# Plan：native host + 执行扩展骨架（M1）

> 公共协议、生命周期和测试断言以 [实施契约](../agent-api-contract.md) 为准。本文仅描述 M1 实施；当前允许子代理，不创建 GitHub issue。

## 1. 分级

**D 级**：重大架构调整。涉及目录迁移（旧代码移入 `legacy/`）、构建与 CI 改变、新增本机进程与 native messaging 注册、本地 HTTP 服务的认证、SQLite 持久化。

已确认的决策（2026-10-17）：

- 只服务 agent，不做工作台页面，不做人工确认门禁。
- native host 提供本地 HTTP + SSE；SQLite 保存在本地，支持查询和恢复，不需要导出。
- 浏览器关闭时 HTTP 不可用，可以接受。
- 插件只强制请求节奏；其他风控信号只提示，由 agent 判断。
- 从 `main` 新建分支 `feat/agent-api-host`，worktree 为 `~/orca/workspaces/FishOps-Workbench/agent-api`。`refactor/extension-api-skeleton` 的代码结构只作参考（风控问题见 [Agent API 设计 §2.1](../agent-api-design.md)）。

## 2. 目标结构

```text
packages/protocol/
  src/wire.ts        # stdio 消息：req | res | event；ErrorCode
  src/api.ts         # Api 方法表、Events 事件表、Meta / RiskInfo
apps/host/
  src/main.ts        # 入口：读 config，打开 SQLite，启动 stdio 与 HTTP
  src/stdio.ts       # native messaging 帧：4 字节小端长度 + UTF-8 JSON
  src/http.ts        # /v1/<method>、/v1/events（SSE）、认证、拒绝 Origin
  src/bridge.ts      # 本地查询分发；其他 HTTP 请求转发给扩展，按 id 匹配响应，超时
  src/db.ts          # node:sqlite：events、requests、state 三张表与迁移
  src/config.ts      # ~/Library/Application Support/FishOps/config.json
apps/extension/
  public/manifest.json   # key、nativeMessaging、cookies
  src/main.ts            # 顶层同步注册监听；connectNative；断线重连
  src/dispatch.ts        # method → handler
  src/modules/system.ts  # system.status、account.changed
scripts/install-host.mjs # 生成 config 与 token，写入 Chrome native host manifest
legacy/                  # 现有 extension、workbench、shared 和依赖它们的 scripts
```

## 3. 协议

stdio 上的消息（host ⇄ 扩展）：

```ts
type Wire =
  | { kind: 'hello'; protocolVersion: 1; extensionVersion: string; account: { userId: string; nick: string } | null }
  | { kind: 'req'; id: string; method: string; params?: unknown }
  | { kind: 'res'; id: string; ok: true; data: unknown }
  | { kind: 'res'; id: string; ok: false; error: { code: ErrorCode; message: string } }
  | { kind: 'event'; type: string; data: unknown }
```

- `id` 由 host 生成；扩展只回 `res`，主动推送用 `event`。
- M1 账号事件保证重连后最终状态收敛，不保证断线期间全部转换。M3 的可靠事件确认机制见实施契约。
- `event` 的序号由 host 写入 SQLite 时分配（`events.seq`），扩展不维护序号。SW 重启不影响序号连续。
- Wire 外层和 hello 控制帧严格校验；方法参数按声明式 schema 严格校验未知字段与边界，不重复手写类型及 codec。

HTTP（agent ⇄ host）的响应格式和错误码见 [Agent API 设计 §3](../agent-api-design.md)。M1 中 `meta.risk` 返回 `{ level: 'unobserved', observedAt: null, signals: [], usage: {} }`，M2 再填充真实观测。hello 握手、协议版本与账号快照按实施契约实现。

## 4. 关键设计

- **扩展不主动访问闲鱼**：M1 中 `system.status` 只读 `chrome.cookies` 和 `chrome.tabs`，不发闲鱼请求。没有定时器，没有 IM 连接。
- **账号**：从 goofish 域 cookie 读取 `{ userId, nick }`。字段在真实浏览器中确认，只记录脱敏结果。`chrome.cookies.onChanged` 加 debounce（约 300ms），账号真的变化时才推送 `account.changed`。
- **闲鱼页面就绪状态**：`chrome.tabs.query` 查 goofish 标签页。M1 只报告“有没有页面”；平台 host 和聊天连接的就绪状态在 M2 / M3 补充。
- **扩展连接 host**：SW 顶层调用 `chrome.runtime.connectNative('top.ggball.fishops')`。`onDisconnect` 后按 1s → 上限 30s 退避重连。`runtime.onStartup` 和 `onInstalled` 都会唤醒 SW。重连只涉及本地进程。
- **host 生命周期**：由 Chrome 启动；stdin 关闭时退出（关闭 HTTP 和 SQLite）。扩展没有连接时，HTTP 请求返回 `EXTENSION_OFFLINE`。
- **转发超时**：默认 30 秒，超时返回 `TIMEOUT`。扩展未就绪时请求返回 `EXTENSION_OFFLINE`；native 通道 EOF 时 host 退出，HTTP 可连接失败。
- **HTTP 安全**：只监听 `127.0.0.1`；`Authorization: Bearer <token>`，用 `timingSafeEqual` 比较；有 `Origin` 头时返回 403。端口被占用时 host 写 stderr 并退出，不自动换端口。
- **SSE**：`GET /v1/events?types=&tag=`；先按 `Last-Event-ID`（或查询参数 `after`）从 `events` 表补发，再推送新事件；每 15 秒发一次注释行保持连接。
- **SQLite**：`node:sqlite` 的 `DatabaseSync`，WAL 模式，文件权限 0600。启动时按 `user_version` 执行迁移。`requests` 表的 `params` 只存方法级白名单摘要（截断不替代脱敏）。
- **扩展 ID**：manifest 中加 `key` 固定 ID。私钥不入库，只提交公钥 `key`。安装脚本把这个 ID 写入 host manifest 的 `allowed_origins`。
- **host 启动方式**：Chrome 启动 native host 时 `PATH` 很少。安装脚本生成一个启动脚本，用受支持 Node 24 的绝对路径运行 `apps/host/src/main.ts`；host manifest 的 `path` 指向这个启动脚本。
- **Node 版本**：统一 Node 24 LTS 基线，engines 与 CI 按实施契约设置。编码前验证原生 TS 和 node:sqlite；本机其他版本测试不替代。

## 5. 实施步骤

1. 设计文档（`docs/agent-api-design.md`、`docs/platform-risk-control.md`、本 plan 和 issue 文档）放在本分支中，随代码一起提交。
2. 用 `git mv` 把 `extension/`、`workbench/`、`shared/` 和依赖它们的 `scripts/` 移入 `legacy/`。根 `package.json` 的 workspaces 改为 `packages/*`、`apps/*`。CI 只构建和测试新目录。
3. 实现 `packages/protocol`。
4. 实现 `apps/host`：stdio、db、http、bridge、hello 就绪握手，以及本地 events.list / requests.list。用内存 SQLite 和假的 stdin / stdout 编写单测。
5. 实现 `apps/extension`：main、dispatch、system 模块。用假的 `chrome.runtime.connectNative` 和 `chrome.cookies` 编写单测。
6. 实现 `scripts/install-host.mjs` 和卸载选项。
7. 构建扩展，加载 unpacked 扩展，运行安装脚本，从真实入口（`curl`）验证。
8. 更新 README 与 `docs/technical-principles.md`；`legacy/README.md` 说明用途和删除计划。

## 6. 验收计划

格式：动作 → 状态 → 可见结果 → 副作用。

| # | 动作 | 状态 | 可见结果 | 副作用 |
|---|---|---|---|---|
| 1 | 运行安装脚本，加载扩展 | 首次安装 | `config.json` 生成，权限 0600；host 进程启动 | 写入 native host manifest；不访问闲鱼 |
| 2 | `curl system.status` | 已登录闲鱼 | 返回版本（与 manifest 一致）、账号、有无闲鱼页面 | `requests` 表新增一行，不含 cookie |
| 3 | 同上 | 未登录 | 账号为 `null`，`ok: true` | 无报错 |
| 4 | 不带 token / 错误 token / 带 `Origin` | — | 401 / 401 / 403 | 不转发给扩展 |
| 5 | 订阅 SSE，在闲鱼退出再登录 | SSE 已连接 | 依次收到两次 `account.changed` | 每次变化只推送一次，写入 `events` 表 |
| 6 | 断开 SSE，触发一次账号变化，再带 `Last-Event-ID` 重连 | — | 收到断开期间的事件 | 不重复推送已收到的事件 |
| 7 | 停止 SW，再明确唤醒 | 已连接 | 允许 host 退出及 HTTP 断开；重新 hello 后恢复 | SQLite 历史保留 |
| 8 | 调用不存在的方法 | 已连接 | `NOT_FOUND` | 连接保持 |
| 9 | 关闭浏览器 | — | host 进程退出；HTTP 不可用 | SQLite 文件保留；重新打开浏览器后可以查询之前的事件 |
| 10 | 在 1 小时内只保持连接，不调用方法 | — | — | 扩展没有发出任何闲鱼请求（DevTools Network 中没有 goofish 请求） |
| 11 | 运行卸载脚本 | — | native host manifest 被删除 | 配置和数据文件是否删除，由参数决定 |

必要检查：`typecheck`、单测、`build`、CI。真实浏览器验证按 `docs/workflow/test.md` 和 `docs/workflow/test-e2e.md` 执行，证据脱敏。

## 7. 风险与恢复

- **旧功能暂不可用**：新骨架合并后，旧功能只在 `legacy/` 中保留源码。需要旧版本时，从 `f04912c` 构建。
- **`key` 改变扩展 ID**：旧扩展数据新 ID 读不到。本项目改为只服务 agent，旧数据不迁移。
- **SW 保活不确定**：如果 native 连接不能保持 SW 存活，重连逻辑仍然保证功能正确，只是会出现短暂的 `EXTENSION_OFFLINE`。
- **多个 Chrome profile**：每个 profile 都会启动一个 host，第二个 host 端口冲突会退出。M1 只支持一个 profile，写入文档。
- **Node 内置 TS 和 `node:sqlite` 的稳定性**：如果出现问题，回退为 `tsc` 编译后运行，SQLite 的替代方案先评审并同步契约，不在实施中静默改用 `better-sqlite3`。

## 8. 不在本次范围内

- 搜索、聊天、发布等业务方法（M2～M5）；M1 不执行平台请求。
- 节奏队列、缓存、风控信号统计（M2）。
- launchd 常驻、浏览器关闭时可查询。

## 9. 已确认（2026-10-17）

- 只在本地分支 `feat/agent-api-host` 开发，不新建也不更新 GitHub issue。
- HTTP 默认端口 `18790`（避开旧分支使用的 `18787`）。

## 10. 实施前验收补充

- 按实施契约实现 state、账号观察与匿名记录可见范围、字符串序号、稳定查询游标。
- 必测 hello 前未就绪、cookie 异常不伪装退出、重连快照与旧回调隔离。
- 本地 events.list / requests.list 在进程重启后可查询；SSE 切账号关闭，慢客户端有上限。
- 不直接移除旧能力作为可靠性证明：先记录旧构建来源，迁移后新 CI 只认新产物，legacy 不混入新构建。
- 代理可承担独立扩展模块或安装测试；公共契约由主代理维护，集成前复核范围与检查结果。

## 11. 实施状态

2026-10-17：M1 代码与本地验证已落地，见 [实施记录](../m1-implementation-report.md)。真实 Chrome 验收未完成，完整回归退出码 2；不能视为 M1 交付完成。搜索、聊天、发布仍属于后续阶段。
