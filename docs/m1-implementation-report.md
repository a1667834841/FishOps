# M1 实施与验收记录

> 日期：2026-10-17。工作区：`/Users/wuwenjing/orca/workspaces/FishOps-Workbench/agent-api`。
> 分支：`feat/agent-api-host`，起点 `f04912c`。当前未提交，未合并，不属于 done。

## 范围

实现 native host、本地 HTTP/SSE、SQLite 历史、账号观察和最小执行扩展。搜索、聊天、发布没有迁移，不对真实账号执行业务请求。

## 分工

- 主线程：协议、根构建与 CI、旧目录归档、真实 host 子进程集成、文档和最终集成。
- GPT-6 Luna：host 的 framing、bridge、HTTP/SSE、数据库、清理和定向单测。
- DeepSeek：执行扩展、假 Chrome API 测试。
- DeepSeek：隔离安装、卸载与产物测试。

所有代理独立修改范围，无递归派工。原工作区未跟踪设计文档保留并继续更新。

## 环境

Node 24.22.0，下载官方 darwin-arm64 分发到临时路径，已执行原生 TS 与 SQLite 检查。CI 已配置同版本 Linux/macOS 检查，但没有实际 CI run。

Orca 未运行，阶段同步与读回失败，未通过启动应用规避。未修改已有 Chrome native host 注册。

## 验证边界

最终命令与结果在本轮完成验证后填写。真实 Chrome 验收需要安全隔离入口；若未完成必须标记 blocked，不以模拟 native 对端代替。

## 最终本地结果

- 使用 Node 24.22.0 执行 `npm ci`：通过；不扫描 legacy workspace。
- `npm run regression`：本地检查通过；报告 `.test-results/2026-10-17T11-06-27.962Z-82397/`。
- 最后调整账号未握手查询范围、配置异常与测试计时器后执行 `npm run regression:full`：本地六阶段通过，整体退出码 2，原因是 chrome-e2e=blocked。
- 最终报告 `.test-results/2026-10-17T11-07-08.821Z-83286/report.json`；单测 39、进程集成与编排 9、产物 8、隔离安装 12，合计 68 项通过。typecheck、build 通过。
- `git diff --check`：通过。真实 Chrome、账号 cookie 字段取证、SW 自然休眠、登录切换专项与一小时静默观察未覆盖；CI 未运行。

## 修复证据

初轮集成检查发现并修复：Node strip-only 不支持参数属性、SQLite BigInt API 使用错误、首次匿名观察缺失、账号快照跨账号泄露、SSE 多页推进、慢客户端背压、请求记录停留 running、端口冲突不退出、卸载外来 launcher 保护、扩展异步账号快照与旧握手竞态。没有通过删除断言或把 SIGKILL 当正常退出达成通过。

## 待验收

`regression:e2e` 当前为显式阻碍入口，还不是已完成的浏览器自动测试。需要专用 Chrome 环境、可证明不覆盖既有部署的 native 注册方案，以及真实加载/唤醒/重开验证后才能完成 M1。当前未安装到用户实际 Chrome，也未创建 PR，不进入 pr review/done。

## 实际 Chrome 安装与验收补充（2026-10-17 19:11）

用户确认安装后，通过 Computer Use 在现有 Chrome 155.0.8059.80 中加载本工作区 `apps/extension/dist`。这是用户授权的实际安装，不是隔离测试 profile；未关闭现有浏览器，未更改旧 FishOps 扩展或账号状态。

- 扩展 ID `pmlecohkjekeejfmpbfaoboghajchcjm`、版本 0.2.0，与 native allowed_origins 匹配。页面可见“扩展程序已加载完毕”。
- Node launcher 使用持久路径 `~/.local/share/fishops/runtimes/node-v24.22.0-darwin-arm64/bin/node`，不是 /tmp。
- 实际 HTTP system.status=200，nativeConnected=true；账号与闲鱼 tab 均存在，仅记录存在性，未保存账号明细或凭据。
- 错 token=401、Origin=403、未知方法=404；events.list 与 requests.list 成功，真实 SSE 心跳通过。
- 使用 Chrome 扩展管理页只重载本扩展，页面可见“已重新加载”；host PID 从 86858 变为 87606，之后状态查询成功，事件仍为一条、游标仍为 1，历史请求保留。
- 真实只读冒烟报告 `.test-results/chrome-live-1792235448028/report.json`，包含本次 bundle 哈希与脱敏检查结果。入口 `FISHOPS_LIVE_SMOKE=1 node scripts/test/browser-smoke.mjs` 可重复验证已安装真实链路，不自动安装、不更改账号、不重载扩展。

仍未覆盖浏览器完全退出/重开、SW 自然休眠、账号登录切换和一小时静默观察。现有 `regression:full` 继续明确标记完整生命周期 E2E 为 blocked；不能把此次实际安装只读冒烟升级为全部自动化验收通过。此前“未安装”记录仅对应当时状态，以本补充为准。

## 测试实现继续补充（2026-10-17）

- 真实 Chrome 只读冒烟增加实际已落库事件的 Last-Event-ID 优先与补发验证；未注入账号事件，未更改登录状态。
- 新增生产 host 子进程的 SSE 游标优先级与已读项不重放回归；定向 6 项通过。
- 真实只读冒烟再次通过：`.test-results/chrome-live-1792237585073-10119/report.json`。包含 commit、dirty、Node、耗时、重放与心跳结果；哈希仅指磁盘产物，不声称运行中扩展已上报相同哈希。
- 安装状态不因本次测试改变。报告区分只读连通与完整生命周期，后者仍待隔离浏览器环境验证。

### 本轮统一回归结果

- `npm run regression`：通过，报告 `.test-results/2026-10-17T11-48-41.134Z-13405-56fe5f90/`。
- `FISHOPS_LIVE_SMOKE=1 npm run regression:full`：本地六阶段与 chrome-live-smoke 全部通过；chrome-lifecycle=blocked，整体退出码 2。报告 `.test-results/2026-10-17T11-48-51.661Z-15189-2e19fbad/`。
- 39 项单测、15 项进程集成与编排、8 项产物、12 项隔离安装，共 74 项通过；真实 Chrome 只读冒烟另计。
- 新增崩溃恢复测试：仅终止本测试自己创建的 host，重启后未完成请求标记 interrupted，requests.list 不污染历史；未终止真实安装的 host。
- 编排测试注入假 runner，不递归启动整个 e2e；即便父命令显式启用真实冒烟，离线测试也清除此开关，避免读取生产凭据。

## 真实 SW 停止与工具栏恢复（2026-10-17 19:53）

- 在 `chrome://serviceworker-internals/` 按扩展 ID 精确定位本扩展，点击其 Stop。页面显示 STOPPED、renderer process ID 为 0；本地 18790 端口无监听，HTTP 连接失败。没有点击 Unregister，没有关闭用户浏览器。
- 点击本扩展工具栏按钮后，页面显示 RUNNING，renderer process ID 变为 19971。执行真实只读冒烟通过：`.test-results/chrome-live-1792238006971-20067/report.json`，nativeConnected=true、事件游标仍为 1、真实事件重放与 SSE 心跳通过。
- 这证明本次强制停止后的手动唤醒链路恢复；不证明自然休眠自动恢复，也不证明浏览器完全关闭重开。UI 动作由 Computer Use 执行，不是回归脚本自动驱动。
- 本地回归再次通过：`.test-results/2026-10-17T11-53-42.204Z-20317-eb728a28/report.json`。Orca 未运行，测试阶段状态同步及读回失败；未进入 done。
- M2 只读调查已完成，尚未编码。必须先细化方法 schema、内部单请求授权、缓存 DDL 和故障矩阵。风控处理仍遵循已确认契约：只强制请求节奏，风险信号提示 Agent 停止，不新增 host 强制熔断。

### 可复验生命周期观察入口

- DeepSeek 子代理新增只读观察器及 15 项离线测试；主线程接入 `test:integration` 与 `test:lifecycle-observe`，复核后补充拒绝 HTTP 重定向和严格事件游标校验。
- 实际执行观察器，再由 Computer Use 停止本扩展并点击工具栏唤醒：baseline 在线、连接拒绝、恢复在线三个阶段全部观察到；耗时约 33.5 秒，账号未变化，baseline 事件保留。报告 `.test-results/chrome-lifecycle-1792238326443-24363/report.json`。
- 该报告只证明观察到恢复及事件游标保留，不能证明业务消息无损或浏览器整体重开。观察器不驱动 UI，未接入 `regression:full` 自动放行；完整生命周期仍为 blocked。
- 最终修改后 `npm run regression` 通过：39 项单测、30 项集成与编排、8 项产物、12 项安装，共 89 项通过；typecheck 和 build 通过。报告 `.test-results/2026-10-17T11-59-06.695Z-25095-8d01e0ec/report.json`；`git diff --check` 通过，CI 未运行。
