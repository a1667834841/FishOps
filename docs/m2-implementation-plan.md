# M2 实施与验收契约

日期：2026-10-18。状态：公共只读 API、生产 host 进程集成和真实 Chrome 只读链路已接通；真实商品查询仍需在登录恢复后小流量验收。

遵循 `agent-api-contract.md`。本阶段实现 `search.items`、`search.suggest`、`item.detail`，不发送聊天或发布商品。真实平台只做受控只读验证，不自动重试。

## 1. 调度模块先行

独立模块 `apps/host/src/scheduler.ts`。同一 host 的所有平台请求共用一个在途槽，账号和类别分别保存最近派发时间。这样账号切换也不会让旧在途请求与新请求并行。

- `run({ accountId, category, maxWaitMs?, minIntervalMs? }, execute)` 入队。`execute` 只授权一次平台网络请求；多步业务必须分别入队。
- category 为 search、detail、light、chatRead、chatOpen、chatSend、publish。默认最小间隔及随机上限分别为 1500/1500、1500/1000、1000/0、300/0、30000/60000、10000/10000、300000/0 毫秒。
- 账号总间隔 1000ms，分类和总间隔同时满足；客户端只能增大分类下限。随机数每个队列项只采样一次，范围必须为 [0,1)。
- 最大等待队列 100，不包括在途；默认 maxWaitMs=120000，上限 600000。参数非法、队列满返回 BAD_REQUEST；排队超时返回 TIMEOUT、phase=queue，不执行回调。
- 按已到期项入队顺序派发。长类别冷却不得阻塞其他类别。计时使用不回退的有效时间，系统时钟回拨不得缩短等待。
- 注入 `load(accountId)` 和同步 `save(accountId, snapshot)`，snapshot 含 lastStartedAt、按类别 lastStartedAt 及 pending 预留。派发前保存 pending，真实终结后覆盖真实开始时刻并清除预留；恢复发现 pending 时从恢复时刻保守等待完整类别间隔。旧快照缺少 pending 按 null 迁移，损坏快照失败关闭。异步 save 不受支持，避免保存延迟缩短真实间隔。SQLite 接线后再验证进程重启。
- 回调成功或失败都归还槽位；失败不重放，已派发尝试仍计间隔。`cancelAccount` 拒绝该账号尚未派发项为 ACCOUNT_CHANGED，不取消已发生平台请求，也不迁移到新账号。
- `close` 拒绝待派发项为 EXTENSION_OFFLINE 并清理计时器；不虚假宣称取消已发生请求。风险信号不新增 host 熔断。

## 2. 模块验收

使用注入时钟、计时器和持久化，禁止真实 sleep。覆盖首项、串行、跨类别总间隔、同类别冷却、长冷却不阻塞、随机边界、调用方不能缩短、队满、超时、回调失败归还、取消账号、关闭清理、保存失败禁止派发、重建恢复间隔、时间回拨。

调度单元测试通过不等于 M2 通过。后续必须补内部单步帧与运行时 schema、页面 documentId 绑定、响应归一化、账号缓存 DDL、API 集成和真实网络计数。每一步网络最多一次；超时或断线不重放。

## 3. 后续接线门槛

公共参数模块为 `packages/protocol/src/business.ts`。输入规则：keyword 去首尾空白后 1～200 字符；itemId 去首尾空白后 1～128 字符；page 为 1～10000 的整数、默认 1；rowsPerPage 为 1～30、默认 30。`filter` 当前只接受 `publishDays`（1～365 整数），默认空对象，不沿用 legacy 隐式十四天条件。`minPrice`、`maxPrice`、`freeShipping` 尚无经过验证的 MTOP 服务端映射，因此公共 schema 明确拒绝，不能校验通过后再由平台必然失败。maxAgeSec 为非负安全整数并截断到默认 TTL；suggest 不接受缓存参数。maxWaitMs 为 1～600000 整数；minIntervalMs 为 0～600000 整数，最终调度仍取强制下限较大值。tag 为 1～128 字符字符串，不改变其内容。所有方法拒绝额外字段。

- 公共参数、归一化商品字段及缺失字段语义先进入公共协议；未知参数拒绝，不静默忽略筛选条件。
- 内部每个 request-step 使用唯一 stepId，绑定账号、tabId、documentId；派发前后核验，不自动切 tab。
- 搜索缓存默认 900 秒、详情 1800 秒；TTL 取调用者 maxAgeSec 与默认值较小者，0 强制刷新。账号范围唯一键，规范化参数参与缓存键。
- MTOP 在已有闲鱼页面 MAIN world 执行，host 不持有 cookie、不直接访问平台；风险和登录失败仅提示 Agent 停止。
- 新增表通过显式版本迁移；必须保留 M1 事件与请求历史。未完成 schema、迁移和故障矩阵前不接入公共路由。

## 4. 内部单步与缓存迁移设计

以下为下一实现单元的强制约束，当前尚未写入 Wire，不表示已支持：

- host 发送 `{ kind: 'request-step', id, requestId, method, params, context: { accountId, tabId, documentId } }`。id 是唯一单步 UUID，requestId 是公共调用 ID；method 仅允许本阶段三个只读方法。params 仅含规范化业务参数，不含 tag、等待与缓存元信息。
- 扩展回复 `{ kind: 'step-result', id, terminal: true, ok: true, data }` 或 `{ kind: 'step-result', id, terminal: true, ok: false, error }`。terminal 表示平台步骤真实终结，不能在请求仍执行时用超时结果冒充终结。一帧最多 1 MiB。未知、重复或过期 id 不推进请求；代次不符的结果不得落缓存。
- 步骤由 host 获得调度槽位后创建；同一步仅一次平台 fetch。扩展核验账号及 documentId 后执行，返回前再核验。导航、tab 关闭、替换均报 PAGE_NOT_READY；账号变化报 ACCOUNT_CHANGED。任何错误不自动换页面重试。
- 超时后不能直接释放槽位再派发：旧页面请求可能仍在执行。必须收到该步终结确认，或确认执行上下文已销毁后才释放实际平台槽位；HTTP 超时仅结束调用者等待。这条需要独立跨进程竞态测试，不能由调度器 Promise 超时模拟证明。
- M2 数据库升级到 user_version=2：新增 `read_cache(account_id TEXT NOT NULL, cache_key TEXT NOT NULL, method TEXT NOT NULL, result TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(account_id, cache_key))`；在同一事务创建并更新版本。缓存键来自 `readCacheKey`，只落库不写日志。
- 命中条件为账号相同、方法相同、当前时间不早于 created_at 且年龄严格小于有效 TTL。时钟回拨或 maxAgeSec=0 不命中。读缓存不计平台用量、不清除风险信号；参数校验在查缓存之前。
- 缓存结果只包含归一化商品字段，不包含原始 MTOP 响应、cookie 或签名。商品缺失字段使用 null，不用 0 或空串假装已知；状态只接受明确平台值，否则 unknown。字段来源映射和成功 data schema 在归一化模块实施前补齐。

故障验收：同一账号不同参数不串缓存；不同账号同参数不串缓存；保存失败不假报成功；v1 升级后原事件与请求可查询；高版本数据库拒绝启动；账号切换或文档变化时不保存迟到结果；N 次步骤只产生 N 次平台尝试；旧请求终结前新步骤不发包。真实验证只在离线矩阵通过后做小流量查询。

## 5. 当前实施证据

- 纯参数及缓存键模块先写失败测试，再实现；7 项定向测试通过，覆盖非有限数值、字段边界、输入不变、账号隔离及筛选键差异。公共 METHODS 仍只有 M1 方法。
- 首轮参数实现后本地回归通过，报告 `.test-results/2026-10-17T12-04-06.470Z-30519-261e6128/report.json`；该报告不包含后来新增的调度实现，不能作为其验收。
- 调度实现期间的回归捕获未完成测试失败，报告 `.test-results/2026-10-17T12-11-12.840Z-36665-f38cba10/report.json`。定向复核要求原代理修复异步保存、账号取消、持久化加载失败与槽位恢复竞态；未修复并复测前不接入公共业务。
- Orca 未运行，plan/coding 阶段同步失败。未提交 PR，未进入 done。
- 调度首轮修复后，本地回归通过：`.test-results/2026-10-17T12-18-09.346Z-42207-ee362a1e/report.json`，71 项单测、30 项集成与编排、8 项产物、12 项安装，共 121 项。该绿灯仍不足以验收调度：复核发现连续两次异步 save 耗时会使记录时间早于真实执行；依赖异常被空 catch 吞掉也可能使队列悬挂。已交回原代理增加失败断言并修复，最终验收待重跑。
- 缓存层已新增 user_version=2 表及读写接口。先失败再实现的 3 项定向测试通过，覆盖账号/方法隔离、TTL 等号边界、回拨、强制刷新、重复保存、文件重开、v1 历史保留及高版本拒绝。尚未重载实际安装 host，不声称生产库已迁移；归一化商品输出校验仍是接入前置要求。
- 原代理调度修复最终采用 pending 预留方案，31 项定向测试通过。主线程新增 SQLite 同步快照适配，覆盖不同账号隔离及文件重开后预留保留。缓存、快照与调度均尚未接入真实平台执行，不代表已验证跨进程请求终结。
- 最终修改后 `npm run regression` 通过：80 项单测、30 项集成与编排、8 项产物、12 项安装，共 130 项，typecheck/build 通过；报告 `.test-results/2026-10-17T12-27-49.984Z-50788-a39e0e1f/report.json`。`git diff --check` 通过。测试阶段 Orca 同步仍失败，CI 和 M2 真实 E2E 未运行。
- 单步帧校验与依赖注入执行器已新增，尚未接入 native Wire 和真实页面。执行器在账号/文档前后核验，连接代次内按 stepId 去重；相同 id 异参拒绝，最大保留 10000 个步骤，满时拒绝而不淘汰重放保护。在途请求不设伪终结超时。实际 MAIN world 请求终结与文档销毁仍需接线验收。
- 商品纯归一化模块已由子代理实现：输出未知字段为 null，价格保留字符串，发布时间不使用当前时间，卖家 ID 不使用浏览者埋点，hasMore 未明确时为 null。主线程复核后补严格建议词结构校验与 main 对象验证；10 项定向测试通过。当前均为 legacy 结构 fixture，不当作真实平台新取证。
- 并行实现期间回归曾捕获归一化模块红测状态（模块文件未写入），报告 `.test-results/2026-10-17T12-31-07.117Z-54608-c1f747e0/report.json`。未忽略此失败；后续以最终全部写入后的回归为准。
- 本轮最终 `npm run regression` 通过：96 项单测、30 项集成与编排、8 项产物、12 项安装，共 146 项；typecheck/build 通过。报告 `.test-results/2026-10-17T12-34-05.329Z-58403-4588f987/report.json`，`git diff --check` 通过。真实页面执行、M2 公共路由及业务 E2E 仍未完成；未扩大 M1 capabilities。
- native 单步接线实施中：扩展端每连接创建执行器、仅接收 request-step、真实终结后回复，未知异常不能伪造 terminal；旧连接结果丢弃。新增 3 项假 Port 定向测试通过。host 端由 Luna 代理实现及定向修复；此记录不作为最终回归结果。
- native 单步 host/扩展接线本轮完成：host 每次只允许一个单步在途，不以 HTTP 超时释放；未知 id 不推进，账号变化等待真实终结后拒绝旧结果；非法方向与输出写失败关闭通道。编码失败清理 pending。页面执行器仍未配置到生产 main，公共方法仍仅 M1。
- 本轮最终本地回归通过：105 项单测、30 项集成与编排、8 项产物、12 项安装，共 155 项。typecheck/build 通过，报告 `.test-results/2026-10-17T12-40-08.446Z-64919-8cea7001/report.json`；`git diff --check` 通过。Orca 未运行，测试阶段同步失败。实际浏览器未重载、未发平台请求，CI 未运行。

## 6. 跨连接恢复前置门槛

native 通道断开不代表页面 fetch 已停止。连接重建时必须先与固定执行文档核对活动步骤，确认旧请求终结或文档已销毁，之后才允许新步骤。仅等待类别间隔或重新创建 SW 执行器不够。当前纯调度 pending 预留只保证时间间隔保守，不证明浏览器内无遗留请求；跨连接终结核验未实现前不得接通生产平台派发。HTTP 等待超时也不能清除页面执行锁。

文档锁模块 `page-lock.ts` 已实现纯逻辑：挂到文档全局的不可覆盖属性，重注入复用原锁；活动步骤未终结时拒绝不同步骤，同步骤返回原 Promise；失败也保留去重，容量满拒绝新项而不淘汰。该锁不是授权或安全隔离机制（MAIN world 由页面共享），仍须 SW 端校验参数、账号和 Chrome documentId。当前尚未注入真实页面，不声称跨连接恢复已验收。

## 7. 页面执行前纯模块结果

- 新增文档锁 3 项单测，验证活动步骤不被重新注入清除、失败保留去重、异参冲突与容量拒绝。锁对象冻结，文档全局属性不可覆盖。
- DeepSeek 子代理新增纯签名和 MTOP 请求构造，13 项测试通过；只支持三个只读端点，无实际 fetch，不携带独立 token 或签名原串返回。
- 已知筛选缺口：publishDays 有 legacy 服务端格式依据；价格和包邮仅有客户端处理依据，当前构造器明确拒绝，未静默忽略。公共筛选完整支持仍未实现，不能以拒绝替代最终功能验收。
- 请求仅设置 accept/content-type，由浏览器自然设置 Origin/Referer，不照抄旧实现中脚本不能设置的头。平台错误固定文案分类，不输出原始 ret；不自动重试。
- 最后源码修改后的本地回归由子代理执行并经主线程读回：`.test-results/2026-10-17T12-48-34.016Z-73401-a7a84274/report.json`，121 项单测、30 项集成与编排、8 项产物、12 项安装，共 171 项通过，typecheck/build 通过。`git diff --check` 通过。未改变扩展权限、未重载实际浏览器、未发平台请求，CI 未运行。

## 8. 固定执行页定位协议

host 不能把用户当前 tab 当作执行页，也不能长期保存 tab/document。新增内部帧：

- `{ kind: 'resolve-page', id, accountId }` 只请求固定页面上下文，不发平台 HTTP。
- `{ kind: 'page-context', id, context: { tabId, documentId } | null, reason? }` 只返回执行定位字段。失败原因仅允许 `PAGE_NOT_READY`、`LOGIN_REQUIRED`、`ACCOUNT_CHANGED`，不携带 URL、cookie 或原始异常。
- 扩展先查询最后聚焦窗口中活动的 `https://www.goofish.com/*` 页。DevTools 等独立窗口会改变最后聚焦窗口，因此该查询为 0 个时再查询全部窗口；两阶段的候选都必须全局恰好 1 个且带合法 tabId，多个候选仍返回 `PAGE_NOT_READY`，不按顺序或激活状态猜选。候选还会用 `webNavigation.getFrame` 回读主文档，核验 `documentId`、主站 HTTPS URL，并在前后复核账号。
- host 在同一在途槽内按 id 匹配定位响应，有超时并在断线时拒绝等待；旧 id、重复在途、账号变化都不生成上下文。
- 生产只读执行先定位、再调用一次固定页单步；定位失败不发送步骤，不自动重试平台请求。

测试覆盖 0/多 tab、无 id、frame 缺失、非法 documentId、非主站 URL、账号变化、定位超时、断线、旧 id、重复定位，以及“先定位后只调用一次 callStep”。本地全量回归：`.test-results/2026-10-17T13-42-23.500Z-35427-bb801ce7/report.json`，typecheck、180 项单测、集成、构建、产物和安装测试全部通过；`git diff --check` 通过。

真实 Chrome 仍需验收：重新加载扩展 bundle 后确认 MAIN 注入、活动闲鱼页唯一性、固定 documentId、账号切换和自然休眠恢复；真实平台查询 E2E 与 CI 尚未运行。本记录不声称已完成公共 API 的真实商品验收。

## 8. Chrome 上下文适配实施

`page-context.ts` 提供固定 tab 的账号与 Chrome 主文档 documentId 绑定，读取前后核验账号；导航或 tab 关闭不自动换页。仅接受 `https://www.goofish.com` 主站，无自定义端口或用户信息。生产适配将调用 `chrome.webNavigation.getFrame`，因此最终安装需要新增 webNavigation 权限；当前未修改 manifest、未调用适配器。新增 2 项注入式定向测试通过。该测试不证明真实 Chrome 权限和文档销毁行为，必须在权限接线后补真实验收。

页面运行时 `page-runtime.ts` 已由子代理实现并完成定向修正：每步最多一次注入式 fetch，正文读取完毕后才终结，非 2xx 同样等待正文；超限取消失败则文档锁永久保持占用，须重载文档恢复。poison 下同 id 重投仍保持原 Promise 未终结，不能伪造 terminal；不同未派发 id 明确失败。重复成功结果回放前重新核验账号，防止返回旧账号数据。

守卫显式区分未接入 SW 的页面运行时：仅 `page-runtime.ts` 允许一个 `deps.fetch` 注入点，并禁止 globalThis/window fetch；其他源码和 SW 构建产物继续禁止远端请求。没有通过别名隐藏调用，也未把页面运行时引入生产 main。12 项页面运行时测试和 3 项上下文测试通过。

最终本地回归 `.test-results/2026-10-17T13-03-16.484Z-87692-c2087a16/report.json` 全部通过（136 项单测、30 项集成与编排、8 项产物、12 项安装，共 186 项），typecheck/build 通过。此前守卫红测已显式修复；真实页面注入、权限接线、公共路由与 M2 业务 E2E 仍未完成，CI 未运行。

## 9. MAIN 产物与调用适配

独立入口 `page-entry.ts` 构建为 `page-main.js`（IIFE），不混入 SW。加载只注册初始化函数，不读取 cookie、不发网络；SW 核验 Chrome documentId 后调用初始化，同一文档重复初始化复用原 runtime，代次不符拒绝覆盖。新增 VM 产物测试验证加载/初始化零网络与重复加载保持实例；这是产物测试，不是真实 Chrome 注入。

源码守卫对 page-entry 单个 globalThis.fetch 适配点及 page-client 固定 documentIds 的 MAIN 调用作显式例外；SW 构建产物仍禁止远端请求。manifest 仍未注入 MAIN 文件，生产 main 尚未配置页面调用；真实权限变更和安装另行验收，不通过修改守卫冒充已完成部署。

Luna 子代理新增固定文档页面调用适配，5 项定向测试通过：调用前后核验上下文，严格校验 documentId、活动步骤状态及终结帧；相同 id 异参不复用在途结果。主线程最终回归通过，报告 `.test-results/2026-10-17T13-11-18.052Z-95321-797c805e/report.json`：141 项单测、30 项集成与编排、9 项产物、12 项安装，共 192 项。typecheck/build、`git diff --check` 通过。代理提示的大量既有 rename/untracked 属此前 M1 迁移与新架构文件，主线程已持续跟踪，不回滚这些已有工作；未观察到本轮新增的未知外部修改。

## 10. 部署与业务编排模块

- DeepSeek 子代理新增 `page-bootstrap.ts`，6 项定向测试覆盖固定文档的文件加载与自包含初始化、注入结果 documentId 校验、账号变化、在途步骤拒绝和异常脱敏。不自行重载、换 tab 或清锁。模块尚未连接生产入口。
- 主线程新增 `read-service.ts`，串联参数规范化、账号缓存、调度和单次执行；缓存命中不占调度，建议词不缓存，账号在排队或执行期间变化均拒绝，不保存旧账号结果，输出校验不通过不缓存。3 项注入式测试通过。生产输出 schema 尚需实现后才接路由。
- 最终本地回归 `.test-results/2026-10-17T13-18-00.412Z-2434-efabfd04/report.json` 通过：150 项单测、30 项集成与编排、9 项产物、12 项安装，共 201 项，typecheck/build 通过。尚未改变实际浏览器权限、未发平台请求，M2 公共路由和真实业务 E2E 未完成。

## 11. 扩展生产入口与 MAIN 注入接线

- 生产入口 `apps/extension/src/main.ts` 通过 `createBridge` 组合 `createChromePageContext`、`createPageBootstrap`、`createPageClient` 与 `createPlatformExecutor`。每条 native 连接创建独立单步执行器；页面上下文每次绑定都读取同一个 `AccountTracker`。
- `bridge-factory.ts` 只负责依赖组合，`chrome-scripting.ts` 是唯一 `chrome.scripting` 适配点；main 顶层仍只同步创建 bridge、注册唤醒监听并启动连接，不读取页面或发平台请求。
- manifest 实际路径为 `apps/extension/src/manifest.json`，新增 `scripting` 与 `webNavigation` 权限，并固定注入 `https://www.goofish.com/*` 的 `page-main.js`（`document_start`、MAIN world）。构建守卫同时确认 SW 产物不包含 `createPageRuntime`。
- 新增生产组合测试验证固定 tab/documentId、页面入口部署与 `AccountTracker` 账号读取；扩展 typecheck、92 项单测、构建及 9 项产物测试通过。全量回归被 host 侧当前未完成改动阻断：`apps/host/src/read-service.ts` 存在类型错误，公共只读路由测试还期望默认 `filter: {}`。该失败不在本单元允许修改范围内，未改动 host 文件。
- 报告目录：`.test-results/2026-10-17T13-34-52.093Z-23594-6270db66`。未启动或关闭真实浏览器、未发平台请求；真实 Chrome 注入、M2 公共路由和业务 E2E 仍未验收。

## 12. 公共只读路由接入证据（2026-10-17）

- `packages/protocol/src/index.ts` 的 `METHODS` 已注册 `search.items`、`search.suggest`、`item.detail`；协议测试确认新增方法拒绝未知字段，M1 方法行为不变。
- `apps/host/src/server.ts` 将三个只读方法路由到 `read-service`，`system.status` 仍真实经过 native bridge；未知方法、认证、Origin 和参数错误保持原语义。业务参数值在请求记账前校验；只读错误统一映射为 `LOGIN_REQUIRED/PAGE_NOT_READY`→503、`ACCOUNT_CHANGED`→409、`INTERNAL`→500。
- `apps/host/src/main.ts` 接入 SQLite 调度快照、`Scheduler` 与 `createReadService`。当前扩展 `system.status` 仍只返回 `page.present`，没有可执行 `tabId/documentId`，因此生产默认执行器明确返回 `PAGE_NOT_READY`，不伪造页面成功，也不发起平台请求。
- `apps/host/src/read-service.ts` 只向单步执行器传递调用者显式给出的业务字段，默认分页、空筛选和调度元信息不伪装成用户输入。
- 路由级测试覆盖认证、Origin、未知方法、非法参数不入 history、三个只读方法走服务且不转给 bridge、capabilities 包含新方法，以及 `LOGIN_REQUIRED`、`PAGE_NOT_READY`、`ACCOUNT_CHANGED`、`INTERNAL` 状态映射。
- 第 11 节记录的 host 侧类型错误与默认 `filter: {}` 阻断已由本节修复；最终本地回归通过：167 项单测、30 项集成与编排、9 项产物、12 项安装；typecheck/build 通过，报告 `.test-results/2026-10-17T13-36-25.630Z-27480-dfa1b93c/report.json`。该报告对应当前最终源码。
- 未完成：扩展端未提供可执行 tab/document 的状态契约，生产真实只读查询尚未 E2E；未重载真实浏览器、未发平台请求、未运行 CI。

## 13. 真实 Chrome 接线与阻塞（2026-10-17）

- 在用户 Chrome 155.0.8059.80 中加载当前工作区 `apps/extension/dist`（扩展 ID `pmlecohkjekeejfmpbfaoboghajchcjm`，版本 0.2.0），确认详情页来源为本工作区、已启用，ID 与 native `allowed_origins` 一致；未修改其他扩展。
- 旧 host 进程未加载新路由，`search.suggest` 返回 404。停止该本项目 host 后仅重载本扩展，新 host 启动并通过真实只读冒烟：认证、版本、历史查询、真实事件补发、SSE 心跳均通过。
- `system.status` 真实返回新增只读 capabilities，`search.suggest` 参数错误正确返回 `BAD_REQUEST`。当前闲鱼页面显示登录入口，`system.status.account=null`；使用正确 `keyword` 发起一次查询返回 `LOGIN_REQUIRED`，未触达平台业务请求，不自动重试，也不代用户登录。
- 修正 `LOGIN_REQUIRED` 等只读错误为可诊断的固定提示，同时保持 `retryable=false`；新增定向测试。
- 页面 MAIN 产物的 VM 集成测试现在从构建后的 `page-main.js` 执行 `search.suggest`，验证固定 `documentId`、单次 POST、`credentials=include`、响应归一化和 cookie/token 不泄露。该测试不访问网络，不替代真实平台查询。
- host 将 `RISK_BLOCKED` 与 `LOGIN_REQUIRED` 发布为持久化 `risk.signal`，分别记录为 `CAPTCHA/blocked` 与 `LOGIN_REQUIRED/caution`；普通 `PAGE_NOT_READY` 不生成平台风控信号。事件先落库，SSE 按既有逻辑补发。
- 修复 `regression:e2e` 未向真实冒烟传递 `FISHOPS_LIVE_SMOKE=1` 的编排缺口，并新增回归断言。`npm run regression:e2e` 的实际检测顺序为 typecheck、单测、集成、真实 Chrome 只读冒烟；只读冒烟通过，`chrome-lifecycle` 仍为 blocked，整体退出码 2。
- 当前验证证据：最终 `npm run regression` 报告 `.test-results/2026-10-17T13-50-22.747Z-46647-a5eb425f/report.json`，182 项单测、30 项集成与编排、10 项产物、12 项安装，共 234 项通过，typecheck/build 通过；真实只读冒烟报告 `.test-results/chrome-live-1792244974329-45873/report.json`；只读 E2E 编排报告 `.test-results/2026-10-17T13-49-31.180Z-45269-2fa2652d/report.json`。
- 未完成：登录恢复后的真实商品搜索/详情小流量查询、价格与包邮筛选服务端映射、账号切换、浏览器关闭重开与自然休眠、M3～M5；CI 未运行。

## 14. 取消、超时与接管收尾（2026-10-18）

- 调度器与只读服务支持调用方取消排队项，新增 `CANCELLED/queue`，HTTP 状态 499。排队项取消后绝不派发；已开始请求仍占单槽，不能因客户端断开而并发第二个平台请求。
- `server.ts` 在 HTTP 响应关闭时终止尚未派发的等待；已进入页面执行后只丢弃返回，不伪造平台请求已终结。
- 页面运行时新增 60 秒默认读取等待上限：超时返回 `TIMEOUT/read`，但文档锁保留到真实正文读取终结；正文取消失败进入失败关闭，后续新步骤报 `RESULT_UNKNOWN`，同 id 重投不伪造终结。文档销毁通过 `dispose()` 结束原等待。
- 扩展重载时新增 host 接管：新实例必须完成 hello，并先等待 3 秒让端口自然释放；旧实例 native 在线时拒绝接管。仅离线旧实例接受同部署 token 接管，且只处理一次；接受后 250ms 内退出并释放端口。无新 hello 时新实例明确失败，不杀其他进程。
- 生产 host 集成测试新增三个 M2 只读方法完整链路、定位失败不派发、排队断开不派发、旧实例拒绝/允许接管，以及页面运行时 `dispose`/失败关闭场景。定向测试已通过；完整回归与真实只读查询结果见交付前最终报告。
- 尚未收窄接管凭据的所有权证明：nonce 目前只校验格式，未与旧实例保存值关联；最终 review 需决定是否继续增强。不得据此声称可抵御同 token 的恶意本地进程。

## 15. 生命周期补充验证（2026-10-18）

- 修正交接集成测试：先监听旧进程退出再发送 EOF，避免遗漏退出事件造成挂起。
- 增加在线旧实例拒绝接管断言；新实例即使已发送 hello，也不得踢掉在线旧实例。
- 页面定位仅在最后聚焦窗口没有候选时回退全窗口，仍要求唯一闲鱼页。非法候选结构按 `PAGE_NOT_READY` 关闭。
- 生产入口向调度器传递取消信号。测试等待窗口从 1 秒改为 4 秒，覆盖账号最小间隔，不降低生产限速。
- 真实部署连续 30 次 `system.status` 采样全部在线，监听 PID 未变化；采样不发送闲鱼业务请求，不保存账号或 token。
- 此结果仅证明采样窗口内稳定，不能证明重启根因已完全消除，也不能替代浏览器关闭、恢复及历史完整性的专项验收。
- Orca 状态同步受阻：应用未运行，CLI 无法读取 runtime metadata。未标记 done，未提交 PR。
- 最终离线回归 `npm run regression` 全部通过：typecheck、单元测试、集成测试、构建、产物检查、安装测试。报告：`.test-results/2026-10-17T17-35-46.653Z-12841-22e3c4ea/report.json`。
