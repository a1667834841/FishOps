# Agent API 自动测试流程

> 日期：2026-10-18。
> 状态：M1 本地测试、构建安装检查和真实 Chrome 只读冒烟已实现；M2 公共只读路由、真实 host 进程集成和页面执行竞态测试已覆盖，真实业务查询仍需在登录恢复后验收；完整浏览器生命周期及 M3～M5 业务测试未完成。实际结果见 [M1 实施记录](m1-implementation-report.md) 与 [M2 实施记录](m2-implementation-plan.md)。
> 分支：`feat/agent-api-host`。
> 工作区：`/Users/wuwenjing/orca/workspaces/FishOps-Workbench/agent-api`。

## 1. 目标与测试入口

日常修改用一条命令快速验证，不依赖真实账号或浏览器。构建与安装测试、真实 Chrome 验收分层运行。允许按项目代理规范使用子代理，不创建 GitHub issue。公共断言以 [实施契约](agent-api-contract.md) 为准。

| 命令 | 内容 | 目标耗时 | 浏览器 |
|---|---|---|---|
| `npm run verify` | 类型检查、单测、真实 host 进程集成测试 | 30 秒以内 | 不需要 |
| `npm run regression` | verify、构建、产物检查、临时安装与卸载测试 | 2 分钟以内 | 不需要 |
| `npm run regression:e2e` | 真实 Chrome → 扩展 → native host → HTTP/SSE；自动传递真实冒烟开关 | 环境准备后约 1 分钟 | 需要 |
| `npm run regression:full` | regression + regression:e2e | 按实际结果记录 | 需要 |

耗时是开发目标，实施后实测。依赖安装、首次加载扩展和人工登录不计入目标。不通过删减断言满足耗时。

使用规则：

- 日常代码修改后运行 `verify`。
- 构建、配置、安装脚本变化后运行 `regression`。
- native messaging、SW 生命周期、权限或账号读取变化后，补 `regression:e2e`。
- 新架构交付前运行 `regression:full`。浏览器不可用时标记待验收，不能以本地回归替代真实 Chrome 验收。
- 旧工作台已有同名命令不能证明新 Agent API 通过；实现时必须更新入口及报告来源。

## 2. 测试代码结构与命令职责

建议结构：

```text
packages/protocol/src/*.test.ts        协议与运行时校验
apps/host/src/*.test.ts                framing、bridge、db、HTTP/SSE
apps/extension/src/**/*.test.ts        分发、账号读取、本地重连
scripts/test/integration.test.mjs      真实 host 子进程 + 模拟 native 对端
scripts/test/install.test.mjs          临时目录安装、重复安装、卸载
scripts/test/artifacts.test.mjs        manifest、入口、扩展 ID、权限
scripts/test/browser-smoke.mjs         真实 Chrome 冒烟
scripts/verify.mjs                     编排、超时、报告、清理
```

| 命令 | 职责 |
|---|---|
| `typecheck` | 检查 protocol、host、extension，不扫描 legacy |
| `test:unit` | 用 `node --test` 运行单测 |
| `test:integration` | 启动真实 host，通过 stdio 帧和 HTTP 交互 |
| `test:install` | 临时目录安装与卸载 |
| `test:artifacts` | 检查刚构建的扩展与 host 产物 |
| `build` | 构建新架构产物，不修改真实浏览器配置 |
| `verify` | 组合类型检查、单测与进程集成测试，并生成报告 |

测试编排使用 Node；HTTP 使用内置 `fetch`，SQLite 使用 `node:sqlite`，不依赖额外的 `timeout`、`curl` 或 `sqlite3` CLI。

## 3. 快速验证用例

### 3.1 协议与 stdio

- 正确请求、成功响应、错误响应和事件可以往返编解码。
- 校验未知 kind、空 id、错误字段类型、非法 JSON；非法输入不触发 handler。
- 长度头拆分、正文逐段到达、多个帧粘连都能正确解析。
- 中文 UTF-8 按字节计长，不按字符数。
- 零长度、超限消息、半帧 EOF、无效 UTF-8 按协议明确处理，不能挂起或无限缓存。
- host → Chrome 消息不超过 Chrome 的 1 MiB 限制，反向输入也设置内存上限。
- stdout 只有协议帧；日志写 stderr，且经过脱敏。

### 3.2 HTTP 与请求分发

- 正确 Bearer token 才可调用；缺失或错误 token 返回 401；存在 Origin 返回 403。
- 非法 JSON、超大 body、错误 HTTP method、未知路由、错误参数有明确响应。
- 未知 API 返回 `NOT_FOUND`，随后合法请求仍成功。
- 扩展未就绪时返回 `EXTENSION_OFFLINE`；就绪后 `system.status` 返回实际状态与版本。
- 并发响应按 requestId 匹配，不串结果；未知或迟到响应不影响其他请求。
- M1 只读请求超时返回 `TIMEOUT`，不自动重试。
- 调用方在排队阶段断开返回 `CANCELLED/queue`，该请求之后不得执行；已经派发的只读请求不能因为客户端断开而提前释放页面锁。
- 未来写操作已经发出但没有收到结果时返回 `RESULT_UNKNOWN`，不能套用“超时可安全重试”。
- bridge 断开时清理 pending、计时器与监听器；重复关闭安全。
- 风控检测尚未实现时显式标记未观测，不能将空 usage 解释为平台已验证健康。M1 固定使用实施契约中的 unobserved 状态。

### 3.3 扩展逻辑

使用假的 Chrome API 和 fake timer：

- 覆盖有账号、无账号、cookie 缺失、解码失败、API 异常和多个闲鱼 tab。
- cookie 变化约 300ms 合并处理；相同账号不重复推送；登录、退出、切换账号分别测试。
- 初次连接、断开退避、连接恢复、重复启动不产生重复 Port。
- 验证 1s、2s、4s……上限 30s 的本地重连退避，以及关闭后的清理。
- 重连后重新报告当前账号，不依赖断线期间未送达的 cookie 事件。
- 测试替身一旦发现远端 fetch、XHR、自建 WebSocket 或登录探测，立即失败。

### 3.4 SQLite 与 SSE

- 临时数据库启用 WAL，迁移可重复；重开文件后事件和请求保留。
- seq 持续递增，重启不归零；limit、游标、types、tag 有边界测试。
- 事件落库后才推送；`Last-Event-ID=N` 仅补发 `seq>N`。
- 在“历史补发 → 实时订阅”的交界插入事件，验证不漏发、不重复。
- 过滤前后均使用全局 seq；优先使用 Last-Event-ID，没有该头时使用 after；非法游标报参数错误。
- SSE 心跳只发注释，不入库、不推进 seq、不产生闲鱼请求。
- 慢客户端有缓冲上限，超限断开，后续可用游标恢复；连接关闭后释放订阅和心跳。
- 请求摘要使用字段白名单。放入测试 token、cookie、消息正文、图片数据后，数据库与日志不能出现这些测试值；截断不能替代脱敏。
- 配置和数据库权限为 0600，私有目录为 0700，WAL/SHM 也受目录权限保护。
- host 接管必须验证同部署 token；新实例在本地完成 native hello 后才尝试接管。旧实例仍在线、接管重放或其他本地服务占用端口时，新实例明确失败，不能自动杀进程抢占。

## 4. 真实 host 进程集成测试

这层不需要 Chrome，但必须启动生产 host 入口，不能只测 Mock：

```text
测试脚本模拟扩展
    ↕ Native Messaging 二进制帧
真实 host 子进程
    ↕ HTTP / SSE
Node 测试客户端
    ↕
临时 SQLite
```

每个用例创建独立临时目录、随机 token，通过 `FISHOPS_HOME` 注入配置。端口使用测试专用分配方式，不争抢默认 18790，不扫描或终止其他进程。若通过配置开放端口 0，实际端口只通过明确的测试通道返回，不能向 stdout 插入非协议日志。

执行步骤：

1. 启动 host，保持 stdin 打开；用条件等待实际就绪，不使用固定长 sleep。
2. 验证扩展未就绪时 `system.status` 返回 `EXTENSION_OFFLINE`。
3. 模拟对端就绪并响应真实 req 帧，验证 HTTP 返回值与 requestId。连接初始化或握手的格式须在协议中明确，不能只在测试中实现。
4. 建立 SSE，模拟对端发送事件，验证先落库再推送。
5. 断开 SSE，再写事件，带上次游标重连，验证准确补发。
6. 不回复一次只读请求，用可配置的短测试超时验证 TIMEOUT；不缩短生产默认超时。
7. 关闭 stdin，验证 host 在截止时间内退出、HTTP 不可用、数据库保留。
8. 重启 host，查询先前记录。M1 必须包含本地 `events.list`、`requests.list` 查询入口，不能仅用测试脚本直接读库冒充 agent 已可恢复。
9. 占用临时端口后启动第二个 host，验证其明确失败退出，原服务不受影响。
10. 检查 stdout 全部是有效帧，stderr 无测试密钥；关闭 SSE、子进程与文件句柄。

M2 补充用例已覆盖：三个公共只读方法经“定位唯一页 → 单步帧 → 终结结果”完整返回；页面定位失败时不发送业务步骤；排队断开不产生平台步骤；无新 native hello 的新实例明确失败；新实例已 hello 也不能踢掉在线旧实例；旧实例 EOF 后自然释放端口，新服务恢复可用。

页面运行时另需覆盖：读取等待超时只结束调用者等待，文档锁仍保持到真实正文终结；正文取消失败进入失败关闭，新步骤返回 `RESULT_UNKNOWN`；文档销毁时 `dispose()` 结束原等待，但仍不伪造成功或已完成平台请求。

EOF 表示 native 通道终止，host 应退出。不能要求 EOF 后继续返回 `EXTENSION_OFFLINE`；该错误在 host 存活但扩展未就绪时验证。

报告将本层标为“进程集成测试”，不能标为真实浏览器 E2E。

## 5. 构建与安装测试

必须显式指定临时 `FISHOPS_HOME` 和临时 native manifest 目录。缺少隔离路径时，安装测试拒绝执行。

- 首次安装生成 token、配置、launcher 和 native host manifest，token 不回显。
- manifest key、计算出的扩展 ID、allowed_origins 一致；只允许本扩展。
- launcher 使用 Node 绝对路径，含空格的路径仍可启动；从任意 cwd 启动仍读取正确配置。
- 重复安装保留 token 与数据库；非法配置不被静默覆盖。
- 遇到其他部署的注册文件停止，不覆盖。
- 卸载默认保留配置与数据；重复卸载安全，不删除其他文件或父目录。
- SW 入口和 manifest 引用文件存在，权限符合最小范围。
- manifest 版本、HTTP 版本和构建来源一致。
- 新产物不混入私钥、本地配置或旧工作台入口。

## 6. 真实 Chrome 自动冒烟

### 6.1 一次性准备

- 使用专用测试 profile 和独立扩展目录，不覆盖旧 `task-api` 或 `~/.fishops/agent-extension` 部署。
- 先检测自动化工具是否支持加载 unpacked 扩展；不支持时首次人工加载一次，后续自动重载。不能承诺任意浏览器环境都能零准备运行。
- native host 注册属于浏览器级资源，profile 独立不等于注册隔离。使用已确认的测试注册目录，检查归属、来源路径、扩展 ID 并加锁；无法隔离时停止，不覆盖。
- 记录 worktree、分支、commit、dirty、构建哈希、扩展 ID、浏览器版本、注册来源；只重载本次构建。
- 默认使用未登录测试 profile，验证 account 为 null。已有登录测试环境可检查账号读取，但报告只记录匹配结果，不输出账号或 cookie。
- 不自动登录、退出账号、删除 cookie、发送消息、建聊或发布商品。

### 6.2 自动执行

1. 构建、检查来源、部署到本分支独占测试目录；构建失败不更新测试副本。
2. 注册测试 native host，加载或重载扩展，等待 HTTP 就绪，并设总截止时间。
3. 调真实 `system.status`，核对版本、连接、账号是否存在和 tab 状态。
4. 验证认证失败、未知方法，再调用成功一次。
5. 检查 SSE 响应头、连接持续和注释心跳。有真实事件时验证游标重连；无事件则标记补发场景未覆盖，不注入伪造账号变化冒充真实验收。
6. 工具支持时停止 SW，再用明确的扩展唤醒动作启动，验证 native 连接恢复、版本及记录保留；不支持则报告未覆盖。
7. 关闭本次启动的专用浏览器，检查 host 退出；重开同一 profile，检查状态恢复与历史查询。不得关闭用户已有浏览器。
8. 结束 SSE、关闭本次空间、释放锁，恢复本次管理的注册状态。清理脚本不得直接删除原有注册。

SW 停止后 native host 可能退出，HTTP 可能连接失败，不能要求 host 始终在线。DevTools 附加 SW 可能改变生命周期，不能据此声称已验证自然休眠。M1 plan 已统一为允许 host 退出并验证重连恢复。

### 6.3 专项检查

- 真实登录/退出事件：有测试环境与对应操作授权时单独验收；默认回归不自动改变账号状态。
- 1 小时空闲观察作为可选专项，不放进快速验证。只检查插件主动请求，不把闲鱼官方网页自身心跳算成插件请求。
- M1 不注入访问闲鱼的 content script、不建 IM 连接。后续迁移业务模块时重新验证静默状态没有主动业务请求。

## 7. 编排、清理和结果

- 计时器边界使用 fake timer；进程与浏览器就绪使用条件轮询和截止时间。
- 每个用例设超时；失败仍生成报告并清理。只关闭本测试创建的进程、监听端口和文件。
- 用例不依赖执行顺序。共享浏览器或 native 注册的测试串行并加锁。
- 不自动重跑断言直到变绿；环境启动失败可有界重试并记录每次原因。
- 每次创建新报告，不复用上次通过结果：

```text
.test-results/<run-id>/report.json
.test-results/<run-id>/summary.md
```

报告记录来源、命令、层级、耗时、退出码、用例结果和清理结果。结果目录不提交。

| 退出码 | 含义 |
|---|---|
| 0 | 本次要求的检查全部通过 |
| 1 | 断言失败 |
| 2 | 环境阻碍，未完成验收 |

用例状态区分 passed、failed、blocked、not-covered。必测项缺失不能返回 0；可选专项未执行也要列出。失败日志脱敏，不保留含真实凭据的临时数据副本。清理失败必须报告。

## 8. CI 与后续覆盖

- CI 从干净依赖安装开始运行 `regression`；Node 版本与 engines 一致。
- CI 不使用登录账号、不读取本机凭据、不注册真实 host；只上传脱敏报告和构建产物。
- macOS launcher 和权限检查在 macOS CI 或本机完成，其他 OS 的缺失项明确记录。
- 本地通过与 CI 通过分别报告；没有实际 CI run 时写“CI 未执行”。
- M2：节奏 fake clock、内部每次请求计数、缓存与强刷、账号隔离、风控错误映射；真实搜索只做小流量专项，不自动重试风控。
- M3：真实页面被动收消息、入库与游标验证，不新建后台 IM 连接。
- M4：attempting/unknown 持久化、幂等冲突、重启不重放；真实建聊和发送须有明确授权。
- M5：prepare 内部多请求限速、切账号、未知提交不重放；真实发布按测试授权执行，不纳入默认回归。

## 9. 与现有规范的关系

- 沿用 [test](workflow/test.md)、[真实 E2E](workflow/test-e2e.md)、[测试授权](workflow/test-authorization.md)和[证据规范](workflow/test-evidence.md)的真实性与安全边界。
- [开发测试入口](development-testing.md) 已补齐，新架构验证使用本文分层流程。
- 旧 [Agent 测试环境](agent-testing.md)和旧 `agent:setup` 依赖工作台，不适用于新 native host 架构；实现时须同步适配相应流程。
- 浏览器能力或首次安装阻碍如实标记。模拟 native 对端的集成测试不能替代真实 Chrome 验收。

## 10. 编码前冻结的新增断言

- 按实施契约验证 hello 前后 ready、协议版本拒绝、账号读取异常与旧连接代次隔离。
- 区分 TIMEOUT/queue、TIMEOUT/read 与 RESULT_UNKNOWN/write；队列超时不得延迟执行。M1 只验证只读路径，写路径于 M4/M5 实现。
- 查询同毫秒分页、字符串序号、requests.list 不自增记录、账号可见范围与切账号 SSE 关闭。
- M1 risk 必须为 unobserved，chatReady 必须为 null；不能以本地成功清除平台风控。
- Node 24 LTS 与真实 Chrome 的最小链路分别出报告；本机其他 Node 版本不能替代。
- 后续故障注入覆盖：意图落库后派发前、平台成功后落库前、落库后响应前终止进程；并发同键异参、队列切账号、未知结果不得自动重放。
- 用例清单必须标明所属 M 阶段；M1 不以模拟业务写入冒充已实现幂等能力。

## 11. 实际安装的只读验收入口

用户已确认安装的现有 Chrome 部署可以通过 `FISHOPS_LIVE_SMOKE=1 npm run test:browser-smoke` 验证 HTTP 认证、版本、历史查询、真实已入库事件续传和 SSE 心跳。未显式启用时退出 2，离线测试必须清除此变量，不能误读真实账号。

此入口不启动或关闭浏览器、不更改注册、不重载扩展、不登录或改 cookie；只有来源记录匹配当前 worktree 才执行。没有真实历史事件时续传场景记录 not-covered，不注入假事件。成功与失败均写脱敏报告，不能复用旧通过结果。

统一 e2e/full 分别记录 chrome-live-smoke 与 chrome-lifecycle。只读冒烟通过不能让浏览器生命周期检查自动变绿；只有显式设置 `FISHOPS_LIFECYCLE_TRIGGER` 时，门禁才会执行真实关闭/重开观察。未设置触发器时完整验收仍退出 2，不能拿旧报告冒充本次通过。默认 CI 只执行离线 regression，不连接用户部署。

自动化闭环的显式开关：

- `FISHOPS_BROWSER_RELOAD=1`：允许自动执行一次扩展重载。它只解决隔离构建后运行中 SW 身份过期，不属于业务请求重试。
- `FISHOPS_LIFECYCLE_TRIGGER`：指定在基线采样后执行一次的关闭/重开命令。Ego 触发器还需要 `FISHOPS_EGO_LIFECYCLE=1`，只匹配 Ego Lite 主进程。

两个开关都必须由具备真实浏览器授权的验收入口显式启用。CI 和默认 regression 不设置它们。

## M4 当前状态

M4 已完成参数 schema、幂等指纹与 operations 持久层的离线验证。`chat.open` 和 `chat.send` 公共路由、页面写 transport、真实测试商品询价及结果未知恢复尚未完成；不得将 M3 只读回归结果解释为 M4 通过。

## 部署来源与当前阻碍（2026-10-18）

本机安装记录和 Chrome unpacked 路径均指向本工作区，但旧 Host 进程仍可能服务旧代码。
路径一致、扩展版本一致及磁盘 bundle 哈希均不能证明运行中产物一致。
在用户主浏览器中不得为验收直接关闭全部 Chrome，也不得反复 reload 扩展后假定 Host 已更新。

完整生命周期验收需要专用 profile、独立扩展副本、独立 native 注册名与数据目录/端口。
仅设置 FISHOPS_HOME 不会隔离 Chrome 默认 NativeMessagingHosts 的注册；必须同时隔离注册。
原有已登录 profile 不可复制 cookie、登录数据库或会话凭据到新 profile。
独立环境需要用户正常完成登录；未登录时只能验证连接与停止边界，不能通过业务验收。

当前真实只读冒烟 accountPresent=false；完整 E2E 仍待验收。

## 隔离验收实施补充（2026-10-18）

- 冒烟脚本通过 `FISHOPS_HOME`、`FISHOPS_EXTENSION_DIST`、`FISHOPS_HOST_ENTRY` 选择待验收部署；未指定时维持默认部署。显式路径不可因文件缺失而回退到主部署。
- 配置目录、扩展 manifest 与 bundle 必须来自同一组显式参数。磁盘哈希仍只证明磁盘内容，运行中构建身份需要单独握手核验。
- 独立浏览器 profile 不代表 native 注册已隔离。测试部署必须另行隔离 native 注册身份和端口，不得用复制登录凭据来建立测试账号状态。
- 安装端口与隔离护栏、扩展构建身份握手正在实施。在 Host 转发身份、磁盘清单核验与真实浏览器重启闭环通过前，不得将这些基础能力写成 E2E 已完成。

### 构建身份核验门禁

只读冒烟必须读取指定产物目录的 `build.json`，将其 `buildId` 与 `system.status.data.extensionBuildId` 比较，再检查 `background.js`、`page-main.js`、`chat-content.js`、`manifest.json` 的 SHA-256。旧 Host 未转发标识、旧扩展未上报标识、清单缺失或任一产物变化均失败，不回退为只检查版本号。此门禁不替代页面运行身份与 Host 进程身份验收。

### 隔离浏览器取证进展

2026-10-18 已建立唯一 Ego 任务空间 `FishOps Agent API E2E`（spaceId 28），保留 `p1` 继续验收。`chrome://version` 显示运行于 Ego Lite，而非主 Chrome；`chrome://extensions` 可见列表中没有新版 Agent API 扩展。闲鱼首页可见已有登录会话，但未确认其是否为授权测试账号，因此不执行发布或发送消息。任务空间不等同独立浏览器进程，不能关闭整个 Ego 来冒充安全生命周期验证。扩展隔离构建位于 `.test-results/isolated-deploy-20261018/extension`，使用 `top.ggball.fishops.e2e`；尚未安装或证明 native 可连接。

### 扩展加载工具限制

Ego space 28 的 `task.cdp('Extensions.loadUnpacked', ...)` 被域限制拒绝，`page.cdp` 对应命令不可用。`chrome://extensions` 的“加载未打包”会打开 macOS 原生目录面板，不产生 DOM filechooser 事件；已取消该面板，未安装扩展。原生界面安装浏览器扩展需要当次明确确认，不通过私有接口或其他通道规避该门禁。需要完成准备和最小安装说明后再请求确认。

### native 注册隔离参数

安装与卸载使用 `FISHOPS_HOST_NAME`（或 `options.hostName`）选择注册名，默认仍为 `top.ggball.fishops`。隔离扩展构建必须使用相同 `FISHOPS_HOST_NAME`，并设置独立 `FISHOPS_EXTENSION_DIST`、`FISHOPS_HOME` 和端口；native 注册目录需要明确指定到目标浏览器实际读取的位置。仅把注册文件写进临时目录不构成浏览器可连接证据。同一数据目录不可直接换名；不同数据目录、不同注册名可在同一注册目录共存。

定向安装测试 28 项通过，覆盖多注册共存、禁止同目录换名、名称校验、卸载保护及旧默认记录兼容。该结果不代表任何真实浏览器安装或生命周期 E2E 已执行。

### 2026-10-18 Ego 安装与桥接诊断

- 已经用户确认，在 space 28 安装隔离扩展 `pmlecohkjekeejfmpbfaoboghajchcjm`；管理页为 `ENABLED`，未报告运行错误。安装截图为 `.test-results/isolated-deploy-20261018/installed.png`。
- 隔离产物与数据分别位于 `.test-results/isolated-deploy-20261018/extension`、`home`；构建标识为 `4c1bf6a1-f47d-4b1d-9c5e-fc4a65f1e1f9`，native host 名为 `top.ggball.fishops.e2e`，端口为 `28791`。
- 在 Ego 用户数据根目录注册后，扩展控制台仍报告 `Specified native messaging host not found.`。添加 Chromium 用户目录兼容注册后，重新加载扩展并再次诊断，仍报告相同错误。另添加 Ego `Default/NativeMessagingHosts` 兼容注册后，HTTP 仍未监听。兼容注册仅使用独立测试名，不覆盖既有注册；安装记录仍只跟踪原始注册目录，后续清理需要单独核对这两处兼容文件。
- 直接启动隔离 launcher 的进程级检查输出 `listening`、端口 `28791`，随后关闭测试进程的 stdin 并确认退出。该检查证明 launcher 可运行，不证明 Ego 能发现或启动它，也不能替代真实浏览器 E2E。
- `chrome://policy` 显示未设置政策。尚未确认 Ego native host 的实际搜索行为。不得把扩展启用或进程级检查计为桥接验收通过。
- 尚未执行真实发布或发送消息。完整 E2E 与生命周期验收仍未完成。Orca 未运行，阶段状态同步失败。

### 2026-10-18 Ego 桥接与首轮业务验证通过

后续在 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts` 添加同名独立测试注册，重新加载扩展后，`28791` 开始监听。Host PID `62993` 的父 PID 为 Ego 主进程 `68572`。这证明本次 Ego 安装实际通过 Google/Chrome 兼容注册发现并启动测试 Host；此前各路径失败结论仅描述当时尝试，不再是当前阻碍。未覆盖任何既有 Host 文件，但确实新增了主 Chrome 兼容目录中的独立测试注册；清理时须核对该文件，不能只依赖原安装记录。

严格真实部署冒烟通过，报告 `.test-results/chrome-live-1792292888683-63116/report.json`：运行中扩展构建标识匹配、鉴权拒绝、SSE 心跳及真实落库事件续传通过。该报告名称沿用 Chrome，运行宿主实际为 Ego。浏览器重开、SW 自然休眠及页面产物身份不在该证据范围。

首轮真实业务调用 `search.suggest`、`search.items`（机械键盘，单页 2 条）、`chat.conversations` 均返回 HTTP 200 且 `ok: true`。仅保存结构与状态摘要，不保存商品或聊天内容：`.test-results/isolated-deploy-20261018/read-business-summary.json`。返回风控状态为 `unobserved`，不等于平台保证无风控。尚未完成详情、同步分页、发布与发送及生命周期验证，完整 E2E 仍未通过。

### 2026-10-18 第二轮真实业务结果

- `search.items` 返回两条商品，使用返回的商品 ID 调用 `item.detail`，HTTP 200 且 `ok: true`，未记录商品内容。
- `publish.myItems {}` 返回 HTTP 400、`BAD_REQUEST`、`phase: read`；`chat.sync {limit: 2}` 返回 HTTP 500、`INTERNAL`、`phase: read`。这两项是待修复失败，不计作验收通过。同步后本地会话查询为空，不能据此断言账号没有会话。
- 脱敏结构摘要位于 `.test-results/isolated-deploy-20261018/read-business-round2.json`。发布查询失败已交由限定写集子代理排查，聊天同步另行诊断。禁止重试未知写操作；本轮均为只读操作。

聊天同步进一步诊断：从任务页可见的“消息”链接进入 `/im`（点击被页面遮挡后使用已观察到的同一链接导航），页面已安装聊天监视器，状态为 `queued: 0`、`syncRequired: true`、`disposed: false`。随后受限等待的 `chat.sync` 返回 HTTP 503、`PAGE_NOT_READY`、`phase: queue`。这只证明当前定位或队列未就绪，不证明历史为空，也不证明首次 500 已修复。未打印会话内容或任何登录凭据。

后续就绪检查：`system.status` 仍返回 HTTP 200、`page.present: true`、`chatReady: null`。消息页可见真实会话列表，因此“没有会话”假设已被排除。再次受限 `chat.sync` 在约 9ms 内以 `PAGE_NOT_READY`、`phase: queue` 拒绝，没有证明发生平台历史读取。当前页面选择器要求最后聚焦窗口唯一活动闲鱼页，或无活动候选时全局唯一闲鱼页；存在多个用户闲鱼页时不能随意挑选，也不能关闭用户页来绕过该约束。后续需在明确任务页激活后核对真实链路。

### 2026-10-18 页面唯一性解除后的复测

- 用户关闭另一个闲鱼页面后，Ego 仅剩一个 `www.goofish.com` 页面，页面绑定恢复。
- 发现真实 `publish.myItems` 失败原因：`mtop.idle.web.xyh.item.list` 的真实请求必须携带当前账号 `userId`；实现原先只发送分组、分页字段，平台返回 `FAIL_BIZ_BAD_REQUEST`。已在首屏探测和分页请求中补充 Host 已核验的 `accountId`，不从调用方接收账号字段。定向发布/跨层测试 37 项通过；重新构建并真实 Ego 复测返回 HTTP 200，得到 14 条在售商品、`hasMore:false`。
- 真实聊天同步仍未通过。页面聊天监视器状态为 `queued:0`、`syncRequired:false`、`disposed:false`，但直接调用聊天页面入口返回脱敏 `PAGE_NOT_READY`，表示当前页面没有唯一可用的闲鱼聊天 WebSocket；没有把空队列解释成历史为空，也未发送消息。
- 真实商品查询、商品详情、在售列表及聊天会话本地查询已分别有成功证据。聊天历史同步、发布 prepare/submit、消息发送及浏览器生命周期恢复仍未完成。

### 2026-10-18 聊天同步真实链路修复与验证

在 Ego space 28 / `p1`、隔离扩展 `top.ggball.fishops.e2e` 上定位并修复两个真实协议差异：

1. **线上 mid 格式**：闲鱼 LWP 只响应 `<数字><时间戳> <序号>` 格式的 `headers.mid`。读取 transport 原来把调用方 UUID 直接作为 mid 发出，平台会静默丢弃，最终导致 15 秒 `TIMEOUT`，Host 侧报 `INTERNAL`。现在 `chat-read-transport.ts` 按页面同款格式生成线上 mid，响应只按该线上 mid 精确匹配；调用方 mid 只用于实例内防重放。
2. **结束页游标**：消息历史在 `hasMore: 0` 时仍回传最后一条记录时间作为 `nextCursor`。归一化逻辑原来把它判为分页冲突。现在平台明确声明没有更多时丢弃游标；未声明 `hasMore` 时仍按游标判断，不放宽。

真实验证结果（只记录结构和计数，不记录聊天正文和凭据）：

- `chat.sync {limit:2}`：HTTP 200，`receivedCount: 2`，`hasMore: true`，签发 `nextCursor`。
- 使用 `nextCursor` 续页：HTTP 200，`receivedCount: 2`，`hasMore: true`。
- `chat.conversations`：返回 4 个本地会话。
- `chat.sync {sessionId, limit:5}`：HTTP 200，`receivedCount: 4`，`insertedCount: 3`，非文本卡片计入 unsupported，`completion: complete`。
- `chat.messages`：返回 3 条消息，字段为白名单字段。
- 自动化：单测 460 项、集成测试 40 项通过，`npm run typecheck` 通过。

仍未执行：`chat.send`、`publish.prepare → publish.submit`（需要明确授权测试账号、接收方、内容和素材），以及浏览器或 SW 生命周期恢复。

### 2026-10-18 扩展停用与恢复生命周期

`lifecycle-observer.mjs` 只读轮询隔离 Host。扩展通过 `chrome.management.setEnabled` 先停用再启用，不关闭用户 Ego 和页面。结果为 `passed`：baseline online，停用后 offline（`connection-refused`），启用后 recovery online，`historyVerified: true`，`accountStable: true`。报告位于 `.test-results/chrome-lifecycle-1792297880506-32344/report.json`。恢复后 `chat.sync` 正常返回。这个场景覆盖 SW 和 native host 进程终止后的恢复；整个浏览器关闭重开和 SW 自然休眠仍未覆盖。

### 2026-10-18 写操作验证与风控停机

- `chat.send`：修复后真实成功（`e2e-send-20261018-3`，`succeeded`），同键重放返回同一结果，未重复发送。根因有两个：真实成功响应带 `extension/createAt/content` 等多余字段，旧白名单把成功判成 `RESULT_UNKNOWN`；Host 没有读取 `apiError.code`，把真实错误码塌缩成 `INTERNAL`（chat-write-service 和 publish-service 已修复）。
- 副作用说明：修复前的失败尝试和诊断发送实际已送达，同一会话里多出了几条“你好”。旧代码把“已送达”误报成失败，这正是本次修复的问题。
- `publish.prepare`：执行到 `mtop.taobao.idle.pc.detail` 时接口持续 `TIMEOUT`。页面出现闲鱼滑块验证（`baxia-dialog`）。已停止所有平台请求，没有自动处理验证码，也没有执行 `publish.submit`。
- 新发现缺陷：页面已出现 baxia 验证时，Host 的 `risk.level` 仍为 `unobserved`，错误只表现为超时或 `INTERNAL`。需要把“接口超时 + baxia 弹窗”识别为 `RISK_BLOCKED` 并持久化风控信号。
- 风控识别已修复（尚待真实复测）：页面运行时在步骤失败或结果未知时，若页面可见 baxia/punish 验证，统一返回 `RISK_BLOCKED`（结果未知的步骤仍保持 poison，不会重放）；Host 的 `chat.sync`、`chat.send` 现在也记录 `risk.signal`，`chat.send` 不再把 `RISK_BLOCKED/LOGIN_REQUIRED` 改写成 `PLATFORM_REJECTED`。单测 464 项、集成测试 40 项通过。

### 2026-10-18 风控链路修正

- 新增 `debugger` 权限用于派发真实鼠标事件完成滑块拖动；风控仍保留检测、停机与熔断链路，自动滑块只减少人工介入，失败一律回落人工。
- 根因修复：bridge 只把扩展错误码放在 `apiError.code`，调度器 `toError` 读不到顶层 `code`，兜底为 `INTERNAL`，导致真实 `RISK_BLOCKED` 丢失、熔断与 `risk.signal` 不触发。现在 bridge 同时写顶层 `code/phase`。有回归测试。
- `chat.send`：无码或 `INTERNAL` 等不明错误记为 `unknown`，不再记 `failed`，防止换键重发造成重复消息。
- 发布：平台详情图片为 `http://img.alicdn.com/...`，仅对 alicdn 域名升级为 HTTPS，其他域名仍拒绝。
- 新增 `risk.status`、`risk.clear`。单测 469 项、集成 40 项通过。
- 真实环境：prepare 已能越过图片校验，在详情接口遇到 baxia 滑块后停止。真实 `RISK_BLOCKED` 透传尚待复测；等待人工完成滑块。

### 2026-10-18 后续复核

- 冷却配置非法值（空串、NaN、Infinity、零、负数、小数、非安全整数）回退到默认 30 分钟，避免静默关闭熔断。修复后单元测试 470 项通过，typecheck 通过。
- 发布诊断日志去掉异常 message/name，仅保留方法、错误码、是否派发与时间；不能用截断原始异常代替脱敏。定向发布服务测试 20 项通过。
- 独立代理确认账号切换与熔断持久化存在缺陷，已委派修复和回归，未验收前不视为完成。
- 不主动制造平台风控。滑块类验证由自动链路处理，非滑块类（短信、扫码、人脸）仍需人工完成；本地模拟覆盖风控错误传递、熔断、恢复与滑块拖动结果分类。

- 聊天分页复核：平台超额页原先截断到 limit 后沿用整页 nextCursor，会跳过未处理记录。现在明确拒绝超额页（PAGE_NOT_READY），不生成猜测游标、不伪装同步成功。定向归一化测试 7 项通过。此行为属于失败关闭，不表示超额页兼容性已完成；后续需取得平台游标排序契约才能无损分页。

- 交付入口检查：安装测试 28 项通过。第一次产物检查识别出默认 dist 仍残留旧 debugger 权限（源码已移除，但此前只更新了隔离部署产物）。执行 npm run build 重建默认 dist 后，产物/MAIN bundle 检查 12 项通过；新构建 c9f7fd53-5cca-4365-98aa-88b3d0050f45 无 debugger 权限（该结论对应当时约束，2026-10-18 自动滑块改造后重新引入 debugger，见「自动滑块验证」章节）。此结果不证明浏览器已加载此默认构建。

### 风控持久化与账号隔离验收

- 独立代理完成修复，主代理检查了 server/database 与新增回归：风控归请求开始时的账号，迟到结果不会误熔断切换后的账号，事件也按原账号隔离。
- 冷却状态写入 SQLite，重开数据库仍保留；到期读取和新风控写入时清理过期记录。
- 被熔断拦截的请求写 requests 审计，不派发平台。
- risk.clear 与在途结果采用保守语义：人工解除后若收到新的迟到 RISK_BLOCKED，将重新熔断，不丢弃停止信号。
- 代理定向 Host 测试 18 项、Host 全部测试 141 项通过；主代理正在执行全仓回归。未操作真实账号。

- 主代理合并后全仓回归：typecheck 通过，单元测试 474/474、集成测试 40/40 全通过（含聊天超额页拒绝回归）。此结果仍非真实发布 E2E 证据。

- 发送取消边界：executeSend 已开始后抛 CANCELLED/PAGE_NOT_READY 不再允许同键重派；结果记 unknown。风控/登录仍透传停止码。新增定向用例后发送服务 8 项通过，typecheck 通过。

- 本次统一回归报告：`.test-results/2026-10-18T11-10-03.586Z-58471-6d86c538`，全部本地阶段通过。先前一轮发现 PLATFORM_REJECTED 被过度归类为 unknown，修复后重新全量验证。
- 真实隔离部署只读冒烟：`.test-results/chrome-live-1792321890086-60393/report.json` 通过，覆盖运行 SW 与隔离磁盘构建身份一致、鉴权、SSE 心跳与事件续传；运行构建仍为 ef21fe1a，不是最新默认 dist。该结果不证明最新源码已部署、发布业务完成或浏览器生命周期完成。
- 当前 Ego 任务空间 33 的 p2 经 DOM 检查仍显示平台验证码。已调用 task.handOff() 正式交给用户，等待人工完成；未经确认不夺回控制，不继续平台调用。

- 待清理项：工作区存在未跟踪的自动滑块链路（`page-runtime.ts` 的 `trySolveSlider`、`slider-plan.ts` 等），按用户选择本轮未改动。当前生产接线未注入 `solveSlider`，实际行为仍是检测到验证即停机；不得把它当作已验收的风控能力。
- 新增默认风控检测测试：只把可见的 baxia / punish / captcha / nocaptcha 视为验证，不可见元素不误判；无验证时保留真实 TIMEOUT 分类。typecheck 通过。

### 2026-10-18 其他功能真实回归

- 本轮恢复核验：暂停所有发布真实操作，不再发送测试消息。`typecheck` 通过；聊天 normalizer、transport、Host 同步定向测试 34/34 通过；集成测试 40/40 通过；全仓单测 496/501 通过，仍为已有的 5 项 solveSlider 用例失败，未跳过或修改这些测试。
- 后续本地修复：新增失败回归证明正常多页同步在末页仍返回 `partial:true`。修正下一页预留，仅继承历史 unsupported 缺口，不继承临时 hasMore。同步服务 10/10 通过，覆盖正常末页 `partial:false`、有 unsupported 的末页 `partial:true`，两者均不清除全局缺口。
- 分页别名边界修复：新增失败用例证明 `hasMore:1` 与 `hasNextPage:true` 被原始值比较误拒绝。两个字段现分别严格归一化，再比较语义；真实冲突、字符串与其他数值仍拒绝。该问题仅有本地证据，尚不能归因到真实第二页。修改后聊天定向 36/36、typecheck、构建、产物测试 12/12 通过；新产物未部署到浏览器，真实续页仍待验收。
- 真实会话响应形状采集：`/r/Conversation/listNewestPagination` 返回 `body { nextCursor:number, userConvs:[...], hasMore:1 }`；会话记录顶层只有 `singleChatUserConversation/type`，`cid` 位于 `singleChatUserConversation.singleChatConversation.cid`，首条记录可以没有 `lastMessage`。据此新增夹具，修正嵌套 cid 与 `createAt` 回退、数字分页归一化。
- 真实续页复测：最新隔离构建首屏可成功 10 条，第二页仍稳定 `PAGE_NOT_READY`。页面内检查同一浏览器窗口、同一 socket 和聊天观察对象仍存在，但执行 runtime 与文档锁均不存在；请求没有进入 `chat.sync.page` 执行分支，页面侧也没有 matcher 或 transport 诊断。已临时采集并清理诊断，最终源码无诊断残留，类型检查与构建通过，聊天定向 50/50 通过。根因缩窄为固定执行文档的部署/跨调用上下文集成问题，尚未修复，不能宣称真实续页 E2E 通过。
- 扩展错误页复核纠正上述判断：错误栈明确显示请求已进入 `chat.sync.page → queryPage → transport.query`，失败为聊天只读传输层的 `PAGE_NOT_READY`（`poisoned`），不是未部署 runtime。页面无诊断并不能证明未进入执行链。最终续页失败仍可能是页面重载后的 socket/观察实例代次变化；已新增“首屏后连接替换不污染新连接”的回归，当前实现保持失败关闭且不向新连接重发。真实根因仍需在新的页面实例上用干净构建定位，未宣称修复。
- 真实现象进一步校对：同一 URL 页面会自行重载，重载后旧执行 runtime 消失但新聊天观察入口重新注入。请求失败来自旧聊天读取 transport 的 `poisoned` 状态；当前设计在连接替换后不把旧实例迁移到新连接，避免请求重放到未知代次。干净构建复测仍为 `PAGE_NOT_READY`。定向回归 51/51 通过，诊断源码已清除；后续需要让读取实例与页面文档代次显式绑定，在页面重载后返回可重新开始的安全语义，而不是复用旧实例。
- 生命周期修复：聊天只读 transport 现区分三种情形。1）请求已派出后断线/超时/账号变化仍永久失败关闭，绝不重放；2）没有在途请求时旧连接断开只解绑，后续新请求可以绑定当前唯一 OPEN 连接；3）平台明确返回错误或结构非法时结束本次请求并解绑，不永久毒化页面。新增空闲连接替换、多个 OPEN 未派发失败、在途断线、页面自行重载等回归。
- 修复后聊天定向 52/52、页面聊天 15/15 通过，typecheck 与隔离构建通过。真实 `/im` 首屏复测仍为 `PAGE_NOT_READY`，扩展错误页仍显示 chat transport poisoned，说明还需区分真实平台响应分类与该已驻留页面实例；未将此本地修复宣称为真实 E2E 通过。
- 修复后执行 `npm run regression:full`：typecheck、integration、build、artifacts、install 通过；unit 仍有已有的 5 项滑块用例失败，真实冒烟被统一门禁阻止。报告：`.test-results/2026-10-18T14-04-16.949Z-83883-9d284e0f`。未将本地构建视为已部署或真实 E2E 通过。
- 当前浏览器证据变化：`listTaskSpaces()` 返回空列表，原空间 33 不存在；隔离 API 的 `system.status` 返回 `nativeConnected:true`、`page.present:false`。本次 `chat.sync` 返回 `PAGE_NOT_READY`、`phase:queue`，不能用于判断原会话续页缺陷是否修复。未新建空间或操作用户其他标签页。真实 E2E 待恢复业务页面后继续。
- 无业务页面时的真实本地 HTTP 验证：`chat.conversations` 使用 `afterId` 连读两页，各 2 条且无重叠，首屏 hasMore=true；`chat.messages` 使用 `afterSeq` 连读两页，各 2 条且无重叠。缺失会话/标签、limit=0、负游标均返回 BAD_REQUEST。仅证明当前运行部署的本地查询，不证明最新源码已部署或平台历史同步成功；未输出消息正文与账号信息。

- 发布暂停，按要求只测非发布功能。账号有发布触发的熔断时，`chat.sync` 被 409 `RISK_BLOCKED`/`queue` 拦截且未派发平台；人工 `risk.clear` 后恢复。
- 在 `https://www.goofish.com/im` 时聊天 socket 才就绪；首页 `chat.sync` 返回 `PAGE_NOT_READY` 属于页面/连接未就绪，不是接口故障。
- 会话同步首屏真实成功：`limit:10` 收到 10 条，写入 6 条、更新 4 条，`hasMore:true`。
- 续页稳定失败为 `PAGE_NOT_READY`。页面内诊断确认：不是 socket 丢失、不是参数错误，而是第二页响应的“结构或分页证据无效”（normalizer/validateResult 拒绝）。当前保持失败关闭，不生成猜测游标、不把部分结果标为完整。根因需拿到真实第二页响应形状后修复。
- 消息同步在 `/im` 可成功执行（首次空页 hasMore=true，下一空页正常结束）；说明 transport 主链路可用。
- 修复 `chat-sync-service` 的下一页预留 `partial` 继承：现在包含本页 `hasMore`/`unsupportedCount`，新增回归后定向测试 9 项通过。

- 2026-10-18 全仓单元回归当前为 5 项失败，全部在未跟踪的自动滑块链路（`page-runtime.test.ts` 的 solveSlider 用例）；按用户选择 2 未修该链路，因此不能宣称 unit 全绿。聊天 transport 定向 18 项、chat-sync-service 定向 9 项、集成 40 项通过。

### 后续核验：明确拒绝的终结语义

- 新增 `PLATFORM_REJECTED` 到“聊天平台明确停止”的回归输入；修复前断言失败：明确拒绝没有终结，文档锁持续占用。
- 页面运行时现接受传输层的明确拒绝，返回固定脱敏文案并释放锁；超时、账号变化及未知结果仍保持失败关闭，不重放在途请求。
- 修复后聊天运行时定向 9 项通过，`npm run typecheck` 通过。这仅证明此生命周期缺陷已修复，不证明真实 `chat.sync` 的当前失败由此引起。
- 当前真实同步仍返回 `PAGE_NOT_READY/read`。此前“不是 socket 丢失”“续页归一化是唯一根因”的结论证据不足：浏览器存在多个业务页面，尚未将观察页与实际执行文档可靠对齐。不得将旧扩展错误计数当作本次请求的诊断证据。
- Orca 状态同步失败：本机 Orca 未运行。发布及消息发送继续暂停；本次未执行外部写操作。

### 后续真实分页证据

- 通过目标扩展自身的 `chrome.tabs` 与 `chrome.scripting` 对齐实际业务页：Chrome documentId 与 runtime documentId 一致，socket 为 OPEN，文档锁空闲。只读诊断不输出账号、消息或凭据。
- 旧文档上的同步失败时，被观察 socket 的发送计数为 0。刷新该业务页后，同样 `limit:3` 首屏成功，收到并更新 3 条。此现象说明旧实例状态影响执行，但不足以确定内部失效位置；未更改生产逻辑绕过该失败。
- 随后两轮分页均为第 0、1、2 页成功，各 3 条，第 3 页 `PAGE_NOT_READY/read`。分页尚未到达末页，不能标记完整同步通过。
- 本轮脱敏记录：`.test-results/chat-pagination-20261018/report.json`。此记录对应刷新后现有部署，不代表新改动已部署。

### 混合会话页修复与真实复测

- 在实际执行文档被动观察匹配响应，仅提取字段名和类型：失败页为两条 `type:1` 单聊加一条 `type:2/groupChatUserConversation` 群聊，平台响应 200，且提供 nextCursor。旧 normalizer 把群聊当作缺失单聊结构，导致整页拒绝。
- 新增混合页、纯群聊结束页及畸形/未知类型测试，先证实旧实现失败。现将已识别群聊计入 unsupportedCount，不写入单聊表；缺少明确游标时不从混合页单聊排序值猜测游标。
- normalizer 与同步服务 20 项通过，typecheck 通过，隔离扩展构建并 reload，业务页刷新。构建 ID：`de8aede5-ad75-43ce-bf77-fc2556b1a453`。
- 真实复测 limit=3 连续 16 页成功，越过原第四页失败位置；limit=20 连续 20 页成功，共返回 400 项。测试设有页数上限，尚未到达自然末页，不宣称全量同步完成。群聊覆盖缺口继续报告 partial=true。
- 脱敏记录：`.test-results/chat-pagination-20261018/after-group-fix.json` 与 `.test-results/chat-pagination-20261018/limit20-completion.json`；后者文件名不代表已到达末页，应以记录的 completion=more 为准。

### 监听清理复核与分页上限边界

- 独立子代理复核发现监听器注册中途失败时已注册的 message listener 泄漏。现于清空绑定前撤销监听，回归覆盖旧连接消息不能终结新连接请求。主代理复跑 transport/page-chat 35 项通过。
- 较大页请求 `limit:100` 未能证明成功，最终返回 `RESULT_UNKNOWN/read`；该有界运行已终止，未自动重试。记录：`.test-results/chat-pagination-20261018/limit100-bounded.json`。不能根据 limit=20 成功推断全部合法分页大小可用；也不能将 unknown 当作平台没有历史。
- 并行全仓运行曾捕获子代理红绿过程中的中间态，报告 `.test-results/2026-10-18T15-49-42.153Z-60385-fc76788a` 中 listener 用例失败不代表最终代码；最终代码已另行复测，并启动新全仓回归。自动滑块原有五项失败仍未解决。
- 最终代码全仓回归报告：`.test-results/2026-10-18T15-51-51.299Z-63084-a5171238`。typecheck、integration、build、artifacts、install 通过；unit 仍失败，须以报告列出的自动滑块用例为未关闭缺口。未跳过测试以制造通过。

### 在途 dispose 分类修复

- 真实 limit=100 失败后检查：页面 poison=true、文档锁仍指向原步骤，符合未知结果不得重放的约束。未因观察超时重启同一请求。
- 独立 review 的剩余问题已建立失败回归：transport 在 pending 时 dispose 原返回 PAGE_NOT_READY，Host 会将其视作未派发预留。现改为 RESULT_UNKNOWN；空闲 dispose 仍为 PAGE_NOT_READY，重复 dispose 不覆盖原终态。
- 修复前 dispose 分类断言失败，修复后 transport/page-chat/chat-sync-service 45 项通过，typecheck 与扩展构建通过。本次只构建默认产物，未将其视为已部署；真实浏览器仍使用先前隔离部署。
- 补充 dispose 后续行为断言：空闲销毁零发送；在途销毁后再次调用保持 RESULT_UNKNOWN 且总发送次数仍为 1。transport 21 项通过。
- dispose 修改后的全仓回归：`.test-results/2026-10-18T15-55-35.399Z-67097-68ad50b0`；typecheck、integration、build、artifacts、install 均通过，unit 仍为既有滑块链路失败。后补的 dispose 行为断言已单独运行，不把先前全仓运行当作覆盖新增断言。

### 最新隔离部署只读验收

- `FISHOPS_LIVE_SMOKE=1` 指向隔离 home、extension、host entry 后运行 browser-smoke，通过构建身份、鉴权、来源校验、未知方法、事件读取、SSE 历史续传与心跳。报告：`.test-results/chrome-live-1792339041631-69468/report.json`，运行构建仍为 `de8aede5-ad75-43ce-bf77-fc2556b1a453`，不代表后续 dispose 修复已部署。
- 本地会话分页两页各 2 项且无重叠；缺少消息范围、limit=0、负 afterId、同步 limit=101 均返回 BAD_REQUEST。报告：`.test-results/local-chat-contract-20261018/report.json`。
- 本轮未触碰 poison 中的页面请求，未发平台历史查询、消息或发布操作。浏览器重启、SW 自然休眠、登录切换及静默观察仍未覆盖。

### 可重复的本地聊天契约入口

新增 `scripts/test/local-chat-contract.mjs`，将本地分页无重叠与四项非法参数断言固化。运行需要显式 `FISHOPS_LIVE_SMOKE=1`，部署使用 `FISHOPS_HOME` 选择；未显式开启时退出码 2，读取配置前停止。日志与报告不包含令牌、会话 ID 或消息正文。数据不足两页时报告 partial 并退出 2，不冒充分页已覆盖。

```sh
FISHOPS_LIVE_SMOKE=1 FISHOPS_HOME="$PWD/.test-results/isolated-deploy-20261018/home" \
  node scripts/test/local-chat-contract.mjs
```

本次真实执行通过，报告 `.test-results/local-chat-contract-1792339166572-71414/report.json`；授权门禁另行验证退出码 2。此入口只覆盖本地 HTTP 契约，不替代平台历史同步和写操作 E2E。

### 本地契约入口自身的回归

- 新增 `local-chat-contract.test.mjs` 并纳入 `npm run test:integration`：未显式开启时不读取配置；非法配置返回固定失败，stdout/stderr/report 均不含测试凭据。测试按子进程 PID 选择自身产物，避免并行误认其他运行报告，并清理自身失败报告。
- 两项定向测试通过。新增 npm 入口为 `npm run test:local-chat-contract`，仍需要显式真实验收开关；未将其默认加入会读取用户部署的离线测试。
- 脚本自身增加受控 HTTP 分支测试：不足两页必须 partial/退出 2，成功两页才 passed/退出 0；四项脚本测试通过。受控服务仅验证验收脚本，不能当成真实业务通过。
- 分页断言补充布尔 hasMore、页大小、非空续页、ID 必填及页内去重，防止空续页或缺失 ID 被误报为“无重叠通过”。补强后重新运行真实本地契约入口通过，报告 `.test-results/local-chat-contract-1792339411638-75993/report.json`。

### limit=100 超时根因取证

- 在最新隔离构建 `8c3db727-b96d-40f4-b356-dae0223d8f3f` 的新业务文档上，仅执行一次 limit=100。被动观察精确 mid 匹配响应：sent=1、code=200、rows=100、UTF-8 信封 307391 字节。诊断仅取大小/状态/字段名，随后清理监听与临时变量。
- 根因：主动读取 transport 误用被动推送的 256KiB 帧限制，忽略真实成功响应，继而触发超时 poison。并非平台没有返回，也不能通过缩小公共 limit 掩盖。
- 新增 300KiB 响应回归，旧实现 TIMEOUT 失败；读取信封改为 512KiB 正文加 16KiB 信封预算，normalizer 正文限制保持不变，被动推送边界不变。transport/normalizer 32 项通过。此新修复尚未部署真实复测。

### 大分页修复后真实到达末页

- 隔离部署构建 `d4ff2bbb-3518-4e18-a643-9a77d4ce469f`，reload 扩展并刷新业务文档后，limit=100 真实分页 10 页全部成功：前 9 页各 100 项，末页 0 项且 hasMore=false/completion=complete，共返回 900 项。
- 列表存在未消费群聊，末页 partial=true/gapCleared=false 是真实覆盖缺口，不宣称支持所有会话类型。记录 `.test-results/chat-pagination-20261018/limit100-after-fix-complete.json`。
- 同一部署选取本地已有单聊执行消息同步，返回 receivedCount=11、hasMore=false/completion=complete、partial=true；非文本消息未消费，缺口保留。记录 `.test-results/chat-pagination-20261018/message-sync-latest.json`。未输出会话 ID/正文，未发送消息或发布。
- 临时运行脚本覆盖了原 limit100-bounded.json；原失败仍有前述文字和诊断证据，不把此路径作为原失败不可变报告。新成功记录使用独立 after-fix 文件。
- 大响应修复补充上限回归：超过读取信封预算的帧不能终结请求，无关 mid 的大帧不能匹配；UTF-8 多字节响应按字节而非字符串长度限制，超时后保持失败关闭且发送次数仍为 1。transport/normalizer 合计 34 项通过。
- 最新全仓报告 `.test-results/2026-10-18T16-07-21.530Z-79469-8b62ff9f`：unit 511 项中 506 通过、5 项滑块链路失败；其余门禁通过。新增两项边界测试已单独复跑，不将旧报告计数冒充最终测试总数。

### 最新部署扩展重载恢复

- 仅 reload 隔离测试扩展，未关闭用户浏览器。轮询先观察到 HTTP 不可用，下一轮恢复 nativeConnected=true，构建身份保持 `d4ff2bbb-3518-4e18-a643-9a77d4ce469f`，账号存在；恢复后本地会话查询成功返回 2 项。
- 恢复后两次状态读取账号一致；未采集重载前账号作本次比较，因此不据此宣称跨重载账号稳定性已证明。记录 `.test-results/chat-pagination-20261018/reload-recovery.json`。
- 此场景仅覆盖扩展重载与 native host 连接恢复；不能替代完整浏览器关闭重开、SW 自然休眠或登录切换。

### 最新构建商品链路复验

- 在运行构建 `d4ff2bbb-3518-4e18-a643-9a77d4ce469f` 上执行真实搜索，返回 30 项；读取首项详情成功，详情 itemId 与搜索项一致。只输出字段名、计数及一致性，不输出卖家、商品正文或原始响应。
- 搜索 hasMore 为 null，不能据此宣称平台搜索分页到末页已覆盖。脱敏记录 `.test-results/chat-pagination-20261018/latest-search-detail.json`。未发布、未联系卖家。

### 最新本地消息分页复验

- 从已有会话选择有足够本地消息的范围，只读两页各 2 条，seq 无重叠。每条 sessionId 与请求范围一致，字段均落在 sourceId/sessionId/senderId/text/sentAt/itemId/peerUserId/seq/tag 白名单。
- 不打印消息正文、会话 ID 或账号；报告 `.test-results/chat-pagination-20261018/local-message-pagination-latest.json` 仅含计数与字段名。本轮未调用平台同步或外部写接口。
- 最新验收总览见 `docs/e2e-current-audit.md`，按要求列明版本、证据与未覆盖范围，纠正旧记录中容易被误读为完成的阶段性结论。

### 最新部署在线／离线／恢复观察

- 真实生命周期观察器运行期间，仅停用并启用隔离测试扩展，未关闭用户浏览器。baseline online → connection-refused offline → recovery online 全部观察到。
- 报告 `.test-results/chrome-lifecycle-1792340226428-88148/report.json`：status=passed、historyVerified=true、accountStable=true，前后事件数均 15。只证明扩展停用启用导致的 native 生命周期，不证明浏览器退出重开或自然休眠。
- 自动验证码绕过链路不继续完善，五项相关失败保持显式未关闭，不删除或改断言制造绿灯。后续可验证风控停止和人工验证恢复，不将绕过平台验证作为交付承诺。

### 安全恢复定向复核

- Host 风控停止与恢复定向 7 项全部通过：风险信号透传、冷却期零平台触达、manualVerified 确认门禁、非法冷却配置拒绝、SQLite 冷却持久化/过期清理、迟到风险按原请求账号归属。
- 这是注入依赖的自动测试，不是真实平台触发验证；未人为制造账号风控，也未自动清除真实账号状态。日志 `.test-results/risk-directed-20261019/tests.log`。

### 最新代码全仓检查

- 最终边界断言加入后的全仓报告：`.test-results/2026-10-18T16-19-19.418Z-91226-9c372f6f`。类型、集成、构建、产物、安装检查通过；单元门禁仍失败，完整 E2E 不能通过。
- `git diff --check` 通过；生产源码未发现本轮临时 `__fishopsDiag` 变量残留。Orca 仍未运行，状态无法同步。独立聊天同步 review 已派发，尚未返回结论。
- 补直接恢复行为断言：平台明确拒绝后清理定时器与连接绑定，下一独立 mid 正常成功；与未知超时永久停用形成对照。transport 定向 25 项通过。本次仅新增测试，不改变生产构建或真实部署。

### 行为优先：续页重放、搜索翻页及平台 cid

- 真实 API 续页提交后再次提交同一凭证：两次均成功且公共结果完全一致；本地前 100 条会话 sessionId 唯一。这证明已提交结果重放行为，不仅是单测断言。
- 搜索 page1/page2 均返回 30 项、顺序与集合不同，重叠 1 项；第二页详情 ID 一致。动态搜索重复项记录为现象，不无证据认定分页失效。记录 `.test-results/behavior-20261019/sync-replay-search.json`。
- 独立 review 的后缀问题经公共 API 复现：同一会话无后缀成功，带 @goofish 返回 PAGE_NOT_READY。现于公共参数入口归一化后缀，游标范围和页面请求都使用规范 ID；其他域及空白明确拒绝。重启隔离 native 连接后真实复测两种输入均收到 11 项并到末页。前后记录 `session-suffix.json`、`session-suffix-after.json` 位于同一行为目录。
- 其余 review 建议中，超信封预算继续失败关闭、混合群聊缺明确游标继续拒绝；没有证据允许从不同排序域猜游标，不为可用性放弃安全约束。协议/服务定向14项及typecheck通过，仅用于支撑该行为修复。
- 后缀修复后的真实续页验证：首屏使用规范 sessionId，续页改用同一 ID 的 @goofish 别名仍成功收到 2 项，证明公共游标范围按规范 ID 绑定。记录 `.test-results/behavior-20261019/alias-cursor-continuation.json`。
- 对真实签发 cursor 的中间字符做篡改后提交，API 返回 BAD_REQUEST/queue，未被当作有效续页。记录 `.test-results/behavior-20261019/cursor-tamper.json`；报告未保存原始凭证。
- 真实行为验证游标范围与预留保留：limit=2 首屏签发凭证后，用 limit=3 提交被 BAD_REQUEST 拒绝；随后原凭证以 limit=2 成功收到 2 项。非法范围提交没有错误消耗有效续页。记录 `.test-results/behavior-20261019/cursor-scope-preservation.json`。
- 跨 native 重启的真实行为验证：首屏签发 limit=2 续页凭证后 reload 测试扩展，等待 nativeConnected 恢复；不刷新业务页面，用原凭证续读成功收到 2 项，随后重放同凭证结果完全一致。记录 `.test-results/behavior-20261019/cursor-native-recovery.json`。临时凭证以0600存储且测试后删除，未输出凭证。
- 文档变化真实行为：旧文档获取续页后刷新业务页，旧凭证被 PAGE_NOT_READY/queue 拒绝；随后不带旧凭证开启新同步，成功收到 2 项。证明不会静默迁移旧游标到新文档，且新文档仍可重新开始。报告 `.test-results/behavior-20261019/document-change.json`。临时凭证0600保存并已删除。
- 同凭证真实并发：两个 HTTP 调用一个成功，一个在途返回 RESULT_UNKNOWN；终结后重放原凭证成功且与成功调用完全一致，本地查询仍可用。符合当前持久预留互斥策略，不能宣称两个并发调用共享等待结果，也不以此直接证明平台发送次数（本轮未抓包）。记录 `.test-results/behavior-20261019/concurrent-cursor-corrected.json`。
- 首次脚本将重放结果与第一个失败响应比较，得到 replayMatches=false，此比较无效；原报告已附解释，正式结论使用 corrected 报告，不将脚本错误当成产品缺陷。
